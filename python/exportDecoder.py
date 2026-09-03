import time
import traceback

import torch
from transformers import AutoModelForImageTextToText

from paths import QWEN_DIR, DECODER_ONNX
from quietlog import redirect_fds
from onnxio import consolidate_external_data
from decoderExport import UnifiedDecoder, kv_names, build_mask

OPSET = 17
PARITY_SEQ = 48
PARITY_TOLERANCE = 2e-2
TRACE_SEQ = 8
TRACE_PAST = 6
DEEPSTACK_LAYERS = 3


def make_cos_sin(text_model, seq: int, offset: int = 0):
    position_ids = torch.arange(offset, offset + seq).view(1, 1, -1).expand(3, 1, -1)
    reference = torch.zeros(1, seq, text_model.config.hidden_size, dtype=torch.float32)
    return text_model.rotary_emb(reference, position_ids)


def empty_past(layers: int, config, length: int):
    past = []
    for _ in range(layers):
        for _ in range(2):
            past.append(torch.zeros(length, config.num_key_value_heads, config.head_dim, dtype=torch.float32))
    return past


def main() -> None:
    print(f"[decoder] loading {QWEN_DIR} in float32")
    model = AutoModelForImageTextToText.from_pretrained(
        str(QWEN_DIR),
        dtype=torch.float32,
        device_map="cpu",
        attn_implementation="sdpa",
    )
    model.eval()
    text_model = model.model.language_model
    config = text_model.config
    layers = config.num_hidden_layers
    hidden = config.hidden_size
    print(f"[decoder] {layers} layers, hidden {hidden}, kv heads {config.num_key_value_heads}")

    decoder = UnifiedDecoder(text_model, model.lm_head).eval()

    torch.manual_seed(0)
    embeds = torch.randn(1, PARITY_SEQ, hidden) * 0.02
    cos, sin = make_cos_sin(text_model, PARITY_SEQ)
    deepstack = [torch.randn(1, PARITY_SEQ, hidden) * 0.01 for _ in range(DEEPSTACK_LAYERS)]
    visual_mask = torch.zeros(1, PARITY_SEQ, dtype=torch.bool)
    visual_mask[:, 4:20] = True
    masked_deepstack = [tensor[visual_mask] for tensor in deepstack]
    padded_deepstack = []
    for tensor in deepstack:
        padded = torch.zeros_like(tensor)
        padded[visual_mask] = tensor[visual_mask]
        padded_deepstack.append(padded)

    with torch.no_grad():
        reference = text_model(
            inputs_embeds=embeds,
            position_ids=torch.arange(PARITY_SEQ).view(1, 1, -1).expand(3, 1, -1),
            use_cache=False,
            visual_pos_masks=visual_mask,
            deepstack_visual_embeds=masked_deepstack,
        )
        reference_logits = model.lm_head(reference.last_hidden_state[:, -1:, :]).float().squeeze(1)
        prefill_mask = build_mask(PARITY_SEQ, 0, embeds.device)
        ours = decoder(
            embeds, cos, sin, prefill_mask, *padded_deepstack, *empty_past(layers, config, 0)
        )

    delta = (ours[0] - reference_logits).abs().max().item()
    scale = reference_logits.abs().max().item()
    print(f"[decoder] prefill parity: max abs delta {delta:.3e} against logit magnitude {scale:.3e}")
    if delta > PARITY_TOLERANCE * max(scale, 1.0):
        raise SystemExit(f"Expected the unified graph to match the reference, it differs by {delta:.3e}")

    past = list(ours[1:])
    next_embed = torch.randn(1, 1, hidden) * 0.02
    next_cos, next_sin = make_cos_sin(text_model, 1, offset=PARITY_SEQ)
    zero_step = [torch.zeros(1, 1, hidden) for _ in range(DEEPSTACK_LAYERS)]
    with torch.no_grad():
        step = decoder(
            next_embed,
            next_cos,
            next_sin,
            build_mask(1, PARITY_SEQ, embeds.device),
            *zero_step,
            *past,
        )
        full_embeds = torch.cat([embeds, next_embed], dim=1)
        full_cos, full_sin = make_cos_sin(text_model, PARITY_SEQ + 1)
        full_padded = [torch.cat([t, torch.zeros(1, 1, hidden)], dim=1) for t in padded_deepstack]
        full = decoder(
            full_embeds,
            full_cos,
            full_sin,
            build_mask(PARITY_SEQ + 1, 0, embeds.device),
            *full_padded,
            *empty_past(layers, config, 0),
        )
    decode_delta = (step[0] - full[0]).abs().max().item()
    decode_scale = full[0].abs().max().item()
    print(f"[decoder] decode parity: max abs delta {decode_delta:.3e} against logit magnitude {decode_scale:.3e}")
    if decode_delta > PARITY_TOLERANCE * max(decode_scale, 1.0):
        raise SystemExit(f"Expected a cached decode step to match a full prefill, it differs by {decode_delta:.3e}")

    past_names = kv_names(layers, "past")
    new_names = kv_names(layers, "new")
    input_names = ["inputs_embeds", "cos", "sin", "mask", "deepstack0", "deepstack1", "deepstack2", *past_names]
    output_names = ["logits", *new_names]

    dynamic_axes = {}
    for name in ["inputs_embeds", "cos", "sin", "deepstack0", "deepstack1", "deepstack2"]:
        dynamic_axes[name] = {1: "seq"}
    dynamic_axes["mask"] = {2: "seq", 3: "total"}
    for name in past_names:
        dynamic_axes[name] = {0: "past"}
    for name in new_names:
        dynamic_axes[name] = {0: "seq"}

    trace_embeds = torch.randn(1, TRACE_SEQ, hidden) * 0.02
    trace_cos, trace_sin = make_cos_sin(text_model, TRACE_SEQ, offset=TRACE_PAST)
    trace_deepstack = [torch.zeros(1, TRACE_SEQ, hidden) for _ in range(DEEPSTACK_LAYERS)]
    trace_past = empty_past(layers, config, TRACE_PAST)
    trace_mask = build_mask(TRACE_SEQ, TRACE_PAST, embeds.device)

    DECODER_ONNX.parent.mkdir(parents=True, exist_ok=True)
    log_path = DECODER_ONNX.parent / "exportDecoder.log"
    started_at = time.time()
    print(f"[decoder] exporting to {DECODER_ONNX.name}")
    with redirect_fds(log_path):
        try:
            with torch.no_grad():
                torch.onnx.export(
                    decoder,
                    (trace_embeds, trace_cos, trace_sin, trace_mask, *trace_deepstack, *trace_past),
                    str(DECODER_ONNX),
                    input_names=input_names,
                    output_names=output_names,
                    dynamic_axes=dynamic_axes,
                    opset_version=OPSET,
                    dynamo=False,
                    do_constant_folding=False,
                )
            failure = None
        except Exception as error:
            failure = "".join(traceback.format_exception_only(type(error), error))
    if failure:
        print(f"[decoder] export failed, full torch log at {log_path}")
        print(failure[:4000])
        raise SystemExit(1)
    print(f"[decoder] exported in {(time.time() - started_at) / 60:.1f} min")
    consolidate_external_data(DECODER_ONNX)


if __name__ == "__main__":
    main()
