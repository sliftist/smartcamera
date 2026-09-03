import sys
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor

from paths import QWEN_DIR, REPO_ROOT, IMAGE_HEIGHT, IMAGE_WIDTH
from runtime import Qwen3VLTensorRT

DEFAULT_FRAME_GLOB = "output/*/2026-08-22/2026-08-22_08-*.jpg"
QUESTIONS = [
    "Is there a person in this image? Answer yes or no.",
    "Is there a car in this image? Answer yes or no.",
    "Describe this image in one short sentence.",
]
MAX_NEW_TOKENS = 24


def pick_frame() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    matches = sorted(REPO_ROOT.glob(DEFAULT_FRAME_GLOB))
    if not matches:
        raise SystemExit(f"Expected a camera frame matching {DEFAULT_FRAME_GLOB}, found none")
    return matches[len(matches) // 2]


def main() -> None:
    frame = pick_frame()
    image = Image.open(frame).convert("RGB")
    print(f"[check] frame {frame.name}")

    model = Qwen3VLTensorRT()
    ours = {}
    for question in QUESTIONS:
        ours[question] = model.generate(image, question, max_new_tokens=MAX_NEW_TOKENS).strip()
        print(f"[check] trt int8 | {question[:46]:46s} -> {ours[question]}")
    del model
    torch.cuda.empty_cache()

    print("[check] loading the reference model on cpu, this is slow")
    reference = AutoModelForImageTextToText.from_pretrained(
        str(QWEN_DIR),
        dtype=torch.float32,
        device_map="cpu",
        attn_implementation="sdpa",
    ).eval()
    processor = AutoProcessor.from_pretrained(str(QWEN_DIR))
    resized = image.resize((IMAGE_WIDTH, IMAGE_HEIGHT), Image.BICUBIC)

    matches = 0
    for question in QUESTIONS:
        messages = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": question}]}]
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=[text], images=[resized], return_tensors="pt", do_resize=False)
        started = time.time()
        with torch.no_grad():
            generated = reference.generate(**inputs, max_new_tokens=MAX_NEW_TOKENS, do_sample=False)
        trimmed = generated[0][inputs["input_ids"].shape[1]:]
        answer = processor.tokenizer.decode(trimmed, skip_special_tokens=True).strip()
        same = answer == ours[question]
        matches += 1 if same else 0
        print(f"[check] reference | {question[:46]:46s} -> {answer}  ({time.time() - started:.0f}s, {'match' if same else 'DIFFERS'})")

    print(f"[check] {matches}/{len(QUESTIONS)} answers identical between int8 TensorRT and fp32 reference")


if __name__ == "__main__":
    main()
