import sys
import time
from pathlib import Path

import torch
from PIL import Image

from paths import REPO_ROOT
from runtime import Qwen3VLTensorRT

DEFAULT_FRAME_GLOB = "output/*/2026-08-22/2026-08-22_08-*.jpg"
QUESTIONS = [
    "Is there a person in this image? Answer yes or no.",
    "Is there a car in this image? Answer yes or no.",
    "Is there a dog in this image? Answer yes or no.",
    "Is there a bicycle in this image? Answer yes or no.",
    "Is it daytime in this image? Answer yes or no.",
]
MAX_NEW_TOKENS = 8
WARMUP_ROUNDS = 3
TIMED_ROUNDS = 3


def pick_frame() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    matches = sorted(REPO_ROOT.glob(DEFAULT_FRAME_GLOB))
    if not matches:
        raise SystemExit(f"Expected a camera frame matching {DEFAULT_FRAME_GLOB}, found none")
    return matches[len(matches) // 2]


def main() -> None:
    frame = pick_frame()
    image = Image.open(frame)
    print(f"[answer] frame {frame.name}, {image.size[0]}x{image.size[1]}")

    model = Qwen3VLTensorRT()
    print(f"[answer] {model.image_tokens} image tokens per frame")

    print(f"[answer] warming up ({WARMUP_ROUNDS} rounds) so the gpu reaches boost clocks")
    for _ in range(WARMUP_ROUNDS):
        for question in QUESTIONS:
            model.generate(image, question, max_new_tokens=MAX_NEW_TOKENS)
    torch.cuda.synchronize()
    torch.cuda.empty_cache()

    total_prefill_tokens = 0
    total_decode_tokens = 0
    total_vision_ms = 0.0
    total_prefill_ms = 0.0
    total_decode_ms = 0.0
    rounds = [question for _ in range(TIMED_ROUNDS) for question in QUESTIONS]

    for index, question in enumerate(rounds):
        torch.cuda.synchronize()
        started = time.perf_counter()
        image_embeds, deepstack = model.encode_image(image)
        torch.cuda.synchronize()
        vision_ms = (time.perf_counter() - started) * 1000

        input_ids = model.build_prompt(question)
        started = time.perf_counter()
        logits, length, delta = model.run_prefill(input_ids, image_embeds, deepstack)
        torch.cuda.synchronize()
        prefill_ms = (time.perf_counter() - started) * 1000

        stop_ids = {model.tokenizer.eos_token_id, model.config.text_config.eos_token_id}
        produced = []
        token = int(logits.view(-1).argmax().item())
        started = time.perf_counter()
        for step in range(MAX_NEW_TOKENS):
            if token in stop_ids:
                break
            produced.append(token)
            logits = model.run_decode(token, length + step + delta, length + step)
            token = int(logits.view(-1).argmax().item())
        torch.cuda.synchronize()
        decode_ms = (time.perf_counter() - started) * 1000

        answer = model.tokenizer.decode(produced, skip_special_tokens=True).strip()
        steps = max(len(produced), 1)
        if index < len(QUESTIONS):
            print(
                f"[answer] {question[:44]:44s} -> {answer[:24]:24s}"
                f" vision {vision_ms:6.1f} ms | prefill {length:4d} tok {prefill_ms:6.1f} ms"
                f" ({length / prefill_ms * 1000:7.0f} tok/s) | decode {steps} tok {decode_ms:6.1f} ms"
                f" ({steps / decode_ms * 1000:5.1f} tok/s)"
            )
        total_prefill_tokens += length
        total_decode_tokens += steps
        total_vision_ms += vision_ms
        total_prefill_ms += prefill_ms
        total_decode_ms += decode_ms

    queries = len(rounds)
    wall_ms = total_vision_ms + total_prefill_ms + total_decode_ms
    print()
    print(f"[answer] {queries} questions on one frame")
    print(f"[answer] vision   {total_vision_ms / queries:7.1f} ms per query")
    print(f"[answer] prefill  {total_prefill_ms / queries:7.1f} ms per query, {total_prefill_tokens / total_prefill_ms * 1000:.0f} input tok/s")
    print(f"[answer] decode   {total_decode_ms / queries:7.1f} ms per query, {total_decode_tokens / total_decode_ms * 1000:.1f} output tok/s")
    print(f"[answer] end to end {wall_ms / queries:.1f} ms per query, {queries / wall_ms * 1000:.2f} queries/s")
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    print(f"[answer] peak torch vram {torch.cuda.max_memory_allocated() / 2 ** 30:.2f} GiB")
    print(
        f"[answer] gpu memory in use {(total_bytes - free_bytes) / 2 ** 30:.2f} GiB"
        f" of {total_bytes / 2 ** 30:.2f} GiB"
    )


if __name__ == "__main__":
    main()
