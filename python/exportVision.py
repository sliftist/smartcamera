import time
import traceback

import torch
from transformers import AutoModelForImageTextToText

from paths import QWEN_DIR, VISION_ONNX, VISION_POSITIONS, IMAGE_HEIGHT, IMAGE_WIDTH
from quietlog import redirect_fds
from onnxio import consolidate_external_data
from visionExport import VisionTower, host_position_inputs, grid_for, patch_count

OPSET = 17
PARITY_TOLERANCE = 1e-3


def main() -> None:
    VISION_ONNX.parent.mkdir(parents=True, exist_ok=True)
    print(f"[vision] loading {QWEN_DIR}")
    model = AutoModelForImageTextToText.from_pretrained(
        str(QWEN_DIR),
        dtype=torch.float32,
        device_map="cpu",
        attn_implementation="sdpa",
    )
    visual = model.model.visual.eval()
    config = visual.config

    grid_thw = grid_for(IMAGE_HEIGHT, IMAGE_WIDTH, config.patch_size)
    patches = patch_count(grid_thw)
    merged_tokens = patches // (config.spatial_merge_size ** 2)
    print(f"[vision] {IMAGE_WIDTH}x{IMAGE_HEIGHT} -> grid {grid_thw.tolist()}, {patches} patches, {merged_tokens} llm tokens")

    pos_embeds, cos, sin = host_position_inputs(visual, grid_thw)
    torch.save({"pos_embeds": pos_embeds, "cos": cos, "sin": sin, "grid_thw": grid_thw}, str(VISION_POSITIONS))
    print(f"[vision] saved position tables to {VISION_POSITIONS.name}")
    channel_dim = config.in_channels * config.temporal_patch_size * config.patch_size * config.patch_size
    torch.manual_seed(0)
    example_patches = torch.randn(patches, channel_dim, dtype=torch.float32)
    print(f"[vision] patches {tuple(example_patches.shape)}, pos_embeds {tuple(pos_embeds.shape)}, cos {tuple(cos.shape)}")

    tower = VisionTower(visual).eval()
    with torch.no_grad():
        outputs = tower(example_patches, pos_embeds, cos, sin)
        reference, reference_deepstack = visual(example_patches, grid_thw)
    print(f"[vision] eager outputs: {[tuple(o.shape) for o in outputs]}")
    for name, ours, theirs in zip(
        ["image_embeds", "deepstack0", "deepstack1", "deepstack2"],
        outputs,
        [reference, *reference_deepstack],
    ):
        delta = (ours - theirs).abs().max().item()
        scale = theirs.abs().max().item()
        print(f"[vision] parity {name}: max abs delta {delta:.3e} against magnitude {scale:.3e}")
        if delta > PARITY_TOLERANCE * max(scale, 1.0):
            raise SystemExit(f"Expected the exported tower to match visual() for {name}, it differs by {delta:.3e}")

    started_at = time.time()
    print(f"[vision] exporting to {VISION_ONNX}")
    log_path = VISION_ONNX.parent / "exportVision.log"
    with redirect_fds(log_path):
        try:
            with torch.no_grad():
                torch.onnx.export(
                    tower,
                    (example_patches, pos_embeds, cos, sin),
                    str(VISION_ONNX),
                    input_names=["patches", "pos_embeds", "cos", "sin"],
                    output_names=["image_embeds", "deepstack0", "deepstack1", "deepstack2"],
                    opset_version=OPSET,
                    dynamo=False,
                    do_constant_folding=True,
                )
            failure = None
        except Exception as error:
            failure = "".join(traceback.format_exception_only(type(error), error))
    if failure:
        print(f"[vision] export failed, full torch log at {log_path}")
        print(failure[:4000])
        raise SystemExit(1)
    print(f"[vision] exported in {time.time() - started_at:.0f}s")
    consolidate_external_data(VISION_ONNX)


if __name__ == "__main__":
    main()
