import shutil

from paths import DECODER_FP8_ONNX, DECODER_ENGINE, ENGINE_DIR, MAX_CACHE_TOKENS
from trtbuild import build_engine
from decoderExport import kv_names

LAYERS = 36
KV_HEADS = 8
HEAD_DIM = 128
HIDDEN = 4096
OPT_PREFILL_TOKENS = 960
MIN_PREFILL_TOKENS = 8
OPT_PAST_TOKENS = 960


def shapes_for(seq, past):
    minimum_seq, optimum_seq, maximum_seq = seq
    minimum_past, optimum_past, maximum_past = past
    shapes = {}
    for name in ["inputs_embeds", "deepstack0", "deepstack1", "deepstack2"]:
        shapes[name] = (
            (1, minimum_seq, HIDDEN),
            (1, optimum_seq, HIDDEN),
            (1, maximum_seq, HIDDEN),
        )
    for name in ["cos", "sin"]:
        shapes[name] = (
            (1, minimum_seq, HEAD_DIM),
            (1, optimum_seq, HEAD_DIM),
            (1, maximum_seq, HEAD_DIM),
        )
    shapes["mask"] = (
        (1, 1, minimum_seq, minimum_past + minimum_seq),
        (1, 1, optimum_seq, optimum_past + optimum_seq),
        (1, 1, maximum_seq, maximum_past + maximum_seq),
    )
    for name in kv_names(LAYERS, "past"):
        shapes[name] = (
            (minimum_past, KV_HEADS, HEAD_DIM),
            (optimum_past, KV_HEADS, HEAD_DIM),
            (maximum_past, KV_HEADS, HEAD_DIM),
        )
    return shapes


def main() -> None:
    ENGINE_DIR.mkdir(parents=True, exist_ok=True)
    if DECODER_ENGINE.exists():
        backup = DECODER_ENGINE.with_suffix(".previous.plan")
        print(f"[decoder] keeping the current engine as {backup.name}")
        shutil.copy2(DECODER_ENGINE, backup)

    prefill = shapes_for(
        seq=(MIN_PREFILL_TOKENS, OPT_PREFILL_TOKENS, MAX_CACHE_TOKENS),
        past=(0, 0, 0),
    )
    decode = shapes_for(
        seq=(1, 1, 1),
        past=(1, OPT_PAST_TOKENS, MAX_CACHE_TOKENS - 1),
    )
    build_engine(
        DECODER_FP8_ONNX,
        DECODER_ENGINE,
        label="decoder",
        fp16=False,
        bf16=True,
        int8=False,
        fp8=True,
        profiles=[prefill, decode],
    )


if __name__ == "__main__":
    main()
