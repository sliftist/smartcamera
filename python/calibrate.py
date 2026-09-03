import time

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from transformers import AutoModelForImageTextToText

from paths import QWEN_DIR, REPO_ROOT, CALIBRATION_FILE
from runtime import Qwen3VLTensorRT
from decoderExport import UnifiedDecoder, build_mask

FRAME_GLOB = "output/*/2026-08-22/*.jpg"
FRAME_COUNT = 6
QUESTIONS = [
    "Is there a person in this image? Answer yes or no.",
    "Describe this image in one short sentence.",
]
DECODE_STEPS = 3


class Recorder:
    def __init__(self):
        self.per_tensor = {}
        self.per_channel = {}

    def observe(self, name: str, activation: torch.Tensor):
        flat = activation.detach().reshape(-1, activation.shape[-1]).abs().float()
        tensor_max = float(flat.max().item())
        channel_max = flat.max(dim=0).values.cpu().numpy()
        previous = self.per_tensor.get(name, 0.0)
        self.per_tensor[name] = max(previous, tensor_max)
        if name in self.per_channel:
            self.per_channel[name] = np.maximum(self.per_channel[name], channel_max)
        else:
            self.per_channel[name] = channel_max


def attach(decoder: nn.Module, recorder: Recorder):
    handles = []
    for name, module in decoder.named_modules():
        if not isinstance(module, nn.Linear):
            continue
        key = f"{name}.weight"

        def hook(_module, inputs, _output, key=key):
            recorder.observe(key, inputs[0])

        handles.append(module.register_forward_hook(hook))
    return handles


def frames():
    matches = sorted(REPO_ROOT.glob(FRAME_GLOB))
    if not matches:
        raise SystemExit(f"Expected camera frames matching {FRAME_GLOB}, found none")
    step = max(1, len(matches) // FRAME_COUNT)
    return [matches[index * step] for index in range(FRAME_COUNT) if index * step < len(matches)]


def main() -> None:
    runtime = Qwen3VLTensorRT(load_decoder=False)
    print(f"[calib] loading {QWEN_DIR} in float32 on cpu")
    model = AutoModelForImageTextToText.from_pretrained(
        str(QWEN_DIR),
        dtype=torch.float32,
        device_map="cpu",
        attn_implementation="sdpa",
    ).eval()
    decoder = UnifiedDecoder(model.model.language_model, model.lm_head).eval()
    config = model.model.language_model.config
    layers = config.num_hidden_layers

    recorder = Recorder()
    handles = attach(decoder, recorder)

    samples = [(frame, question) for frame in frames() for question in QUESTIONS]
    print(f"[calib] {len(samples)} samples, {DECODE_STEPS} decode steps each")
    started_at = time.time()

    for index, (frame, question) in enumerate(samples):
        image = Image.open(frame).convert("RGB")
        image_embeds, deepstack = runtime.encode_image(image)
        input_ids = runtime.build_prompt(question)
        embeds, cos, sin, padded, sequence, delta = runtime.prefill_inputs(input_ids, image_embeds, deepstack)

        embeds = embeds.cpu()
        cos = cos.cpu()
        sin = sin.cpu()
        padded = [tensor.cpu() for tensor in padded]
        empty = torch.zeros(0, config.num_key_value_heads, config.head_dim)
        past = [empty for _ in range(layers * 2)]

        with torch.no_grad():
            outputs = decoder(embeds, cos, sin, build_mask(sequence, 0, "cpu"), *padded, *past)
        logits = outputs[0]
        past = list(outputs[1:])
        token = int(logits.view(-1).argmax().item())

        zero_step = [torch.zeros(1, 1, config.hidden_size) for _ in range(3)]
        for step in range(DECODE_STEPS):
            position = sequence + step + delta
            step_embed = runtime.embed[token].view(1, 1, -1).float().cpu()
            step_cos, step_sin = runtime.rope(torch.full((3, 1, 1), position, dtype=torch.long))
            with torch.no_grad():
                outputs = decoder(
                    step_embed,
                    step_cos.cpu(),
                    step_sin.cpu(),
                    build_mask(1, sequence + step, "cpu"),
                    *zero_step,
                    *past,
                )
            fresh = list(outputs[1:])
            past = [torch.cat([past[i], fresh[i]], dim=0) for i in range(len(past))]
            token = int(outputs[0].view(-1).argmax().item())

        elapsed = time.time() - started_at
        print(f"[calib] {index + 1}/{len(samples)} {frame.name} {sequence} tokens, {elapsed / (index + 1):.0f}s each")

    for handle in handles:
        handle.remove()

    names = sorted(recorder.per_tensor)
    print(f"[calib] recorded {len(names)} linear inputs")
    ranked = sorted(names, key=lambda n: recorder.per_tensor[n], reverse=True)
    for name in ranked[:8]:
        print(f"[calib]   largest {name}: amax {recorder.per_tensor[name]:.1f}")

    CALIBRATION_FILE.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        str(CALIBRATION_FILE),
        names=np.array(names),
        per_tensor=np.array([recorder.per_tensor[name] for name in names], dtype=np.float32),
        **{f"channel::{name}": recorder.per_channel[name] for name in names},
    )
    print(f"[calib] wrote {CALIBRATION_FILE}")


if __name__ == "__main__":
    main()
