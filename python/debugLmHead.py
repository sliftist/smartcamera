import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import AutoModelForImageTextToText

from paths import QWEN_DIR, REPO_ROOT, CALIBRATION_FILE
from runtime import Qwen3VLTensorRT
from decoderExport import UnifiedDecoder, build_mask

DEFAULT_FRAME_GLOB = "output/*/2026-08-22/2026-08-22_08-*.jpg"
QUESTION = "Is there a person in this image? Answer yes or no."
INT8_MAX = 127.0


def main() -> None:
    data = np.load(str(CALIBRATION_FILE), allow_pickle=False)
    names = [str(name) for name in data["names"]]
    per_tensor = dict(zip(names, data["per_tensor"]))
    amax = float(per_tensor["lm_head.weight"])
    step = amax / INT8_MAX
    channels = data["channel::lm_head.weight"]
    print(f"[lmhead] calibrated amax {amax:.3f}, int8 step {step:.4f}")
    print(f"[lmhead] per-channel max: p50 {np.percentile(channels, 50):.3f} p99 {np.percentile(channels, 99):.3f} max {channels.max():.3f}")
    print(f"[lmhead] channels whose calibration max is under one step: {(channels < step).mean() * 100:.1f}%")

    frame = Path(sys.argv[1]) if len(sys.argv) > 1 else sorted(REPO_ROOT.glob(DEFAULT_FRAME_GLOB))[0]
    image = Image.open(frame).convert("RGB")
    runtime = Qwen3VLTensorRT(load_decoder=False)
    image_embeds, deepstack = runtime.encode_image(image)
    input_ids = runtime.build_prompt(QUESTION)
    embeds, cos, sin, padded, sequence, delta = runtime.prefill_inputs(input_ids, image_embeds, deepstack)

    print(f"[lmhead] loading the reference decoder on cpu")
    model = AutoModelForImageTextToText.from_pretrained(
        str(QWEN_DIR), dtype=torch.float32, device_map="cpu", attn_implementation="sdpa",
    ).eval()
    config = model.model.language_model.config
    decoder = UnifiedDecoder(model.model.language_model, model.lm_head).eval()

    captured = {}

    def hook(_module, inputs, _output):
        captured["x"] = inputs[0].detach().clone()

    def norm_hook(_module, inputs, _output):
        captured["pre_norm"] = inputs[0].detach().clone()

    handle = model.lm_head.register_forward_hook(hook)
    norm_handle = model.model.language_model.norm.register_forward_hook(norm_hook)
    empty = torch.zeros(0, config.num_key_value_heads, config.head_dim)
    with torch.no_grad():
        decoder(
            embeds.cpu(), cos.cpu(), sin.cpu(), build_mask(sequence, 0, "cpu"),
            *[t.cpu() for t in padded],
            *[empty for _ in range(config.num_hidden_layers * 2)],
        )
    handle.remove()
    norm_handle.remove()

    pre_norm = captured["pre_norm"].reshape(-1).float()
    squared = pre_norm.pow(2)
    print(f"[lmhead] pre-norm hidden: absmax {pre_norm.abs().max():.2f} rms {squared.mean().sqrt():.2f}")
    print(f"[lmhead] largest x^2 is {squared.max():.1f}; fp16 overflows above 65504")
    print(f"[lmhead] values whose square overflows fp16 (|x| > 256): {int((pre_norm.abs() > 256).sum().item())}")

    activation = captured["x"].reshape(-1).float()
    print(f"[lmhead] real activation: absmax {activation.abs().max():.4f} rms {activation.pow(2).mean().sqrt():.4f}")
    print(f"[lmhead] real activation percentiles of |x|: p50 {activation.abs().median():.4f} p99 {torch.quantile(activation.abs(), 0.99):.4f}")

    quantized = torch.clamp(torch.round(activation / step), -127, 127)
    zeroed = float((quantized == 0).float().mean() * 100)
    print(f"[lmhead] after int8 at that step: {zeroed:.1f}% of the 4096 values become exactly 0")
    print(f"[lmhead] surviving nonzero levels: {int((quantized != 0).sum().item())} of {quantized.numel()}")


if __name__ == "__main__":
    main()
