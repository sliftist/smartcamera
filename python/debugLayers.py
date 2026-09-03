import sys
from pathlib import Path

import torch
from PIL import Image

from paths import REPO_ROOT, PROFILE_PREFILL
from runtime import Qwen3VLTensorRT
from decoderExport import build_mask

DEFAULT_FRAME_GLOB = "output/*/2026-08-22/2026-08-22_08-*.jpg"
QUESTION = "Is there a person in this image? Answer yes or no."


def main() -> None:
    frame = Path(sys.argv[1]) if len(sys.argv) > 1 else sorted(REPO_ROOT.glob(DEFAULT_FRAME_GLOB))[0]
    image = Image.open(frame).convert("RGB")
    runtime = Qwen3VLTensorRT()

    image_embeds, deepstack = runtime.encode_image(image)
    input_ids = runtime.build_prompt(QUESTION)
    embeds, cos, sin, padded, sequence, delta = runtime.prefill_inputs(input_ids, image_embeds, deepstack)

    inputs = {
        "inputs_embeds": embeds,
        "cos": cos,
        "sin": sin,
        "mask": build_mask(sequence, 0, runtime.device),
        "deepstack0": padded[0],
        "deepstack1": padded[1],
        "deepstack2": padded[2],
    }
    for index in range(runtime.layers):
        inputs[f"past_key_{index}"] = runtime.empty_past
        inputs[f"past_value_{index}"] = runtime.empty_past
    outputs = runtime.decoder.run(inputs, profile=PROFILE_PREFILL)
    torch.cuda.synchronize()

    print(f"[layers] prefill of {sequence} tokens, per-layer key/value magnitudes")
    for index in range(runtime.layers):
        key = outputs[f"new_key_{index}"].float()
        value = outputs[f"new_value_{index}"].float()
        print(
            f"[layers] {index:2d} key absmax {key.abs().max():9.4f} rms {key.pow(2).mean().sqrt():9.4f}"
            f" | value absmax {value.abs().max():9.4f} rms {value.pow(2).mean().sqrt():9.4f}"
        )
    logits = outputs["logits"].float()
    print(f"[layers] logits absmax {logits.abs().max():.6f}")


if __name__ == "__main__":
    main()
