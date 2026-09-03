import sys
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoModelForImageTextToText

from paths import QWEN_DIR, REPO_ROOT
from runtime import Qwen3VLTensorRT
from decoderExport import UnifiedDecoder, build_mask

DEFAULT_FRAME_GLOB = "output/*/2026-08-22/2026-08-22_08-*.jpg"
QUESTION = "Is there a person in this image? Answer yes or no."
TOP_K = 5


def describe(name: str, tensor: torch.Tensor, tokenizer) -> None:
    flat = tensor.reshape(-1).float()
    finite = torch.isfinite(flat)
    print(
        f"[debug] {name}: shape {tuple(tensor.shape)} min {flat[finite].min():.4f} max {flat[finite].max():.4f}"
        f" mean {flat[finite].mean():.4f} std {flat[finite].std():.4f} nonfinite {(~finite).sum().item()}"
    )
    values, indices = flat.topk(TOP_K)
    tokens = [tokenizer.decode([int(index)]) for index in indices]
    print(f"[debug] {name}: top{TOP_K} {[f'{t!r}={v:.3f}' for t, v in zip(tokens, values.tolist())]}")


def main() -> None:
    frame = Path(sys.argv[1]) if len(sys.argv) > 1 else sorted(REPO_ROOT.glob(DEFAULT_FRAME_GLOB))[0]
    image = Image.open(frame).convert("RGB")
    print(f"[debug] frame {frame.name}")

    runtime = Qwen3VLTensorRT()
    image_embeds, deepstack = runtime.encode_image(image)
    print(f"[debug] image_embeds: min {image_embeds.min():.3f} max {image_embeds.max():.3f} mean {image_embeds.mean():.3f}")
    input_ids = runtime.build_prompt(QUESTION)
    logits, length, delta = runtime.run_prefill(input_ids, image_embeds, deepstack)
    print(f"[debug] prompt {length} tokens, rope delta {delta}")
    describe("trt int8 logits", logits, runtime.tokenizer)

    embeds, cos, sin, padded, sequence, delta2 = runtime.prefill_inputs(input_ids, image_embeds, deepstack)
    print(f"[debug] inputs_embeds: min {embeds.min():.3f} max {embeds.max():.3f} mean {embeds.mean():.3f}")

    del runtime.decoder
    runtime.decoder = None
    torch.cuda.empty_cache()

    print(f"[debug] loading the reference decoder on cpu in float32")
    model = AutoModelForImageTextToText.from_pretrained(
        str(QWEN_DIR),
        dtype=torch.float32,
        device_map="cpu",
        attn_implementation="sdpa",
    ).eval()
    config = model.model.language_model.config
    decoder = UnifiedDecoder(model.model.language_model, model.lm_head).eval()
    empty = torch.zeros(0, config.num_key_value_heads, config.head_dim)
    with torch.no_grad():
        outputs = decoder(
            embeds.cpu(),
            cos.cpu(),
            sin.cpu(),
            build_mask(sequence, 0, "cpu"),
            *[tensor.cpu() for tensor in padded],
            *[empty for _ in range(config.num_hidden_layers * 2)],
        )
    describe("cpu fp32 logits", outputs[0], runtime.tokenizer)


if __name__ == "__main__":
    main()
