import time

import torch

from paths import VISION_ENGINE
from trtrun import TrtEngine

WARMUP_RUNS = 5
TIMED_RUNS = 30


def main() -> None:
    engine = TrtEngine(VISION_ENGINE)
    print(f"[bench] inputs {engine.input_names}, outputs {engine.output_names}")

    inputs = {}
    for name in engine.input_names:
        shape = tuple(engine.engine.get_tensor_shape(name))
        inputs[name] = torch.randn(shape, dtype=engine.dtype_of(name), device="cuda")
        print(f"[bench]   {name}: {shape}")

    outputs = engine.run(inputs)
    for _ in range(WARMUP_RUNS):
        outputs = engine.run(inputs, outputs)
    torch.cuda.synchronize()

    started_at = time.perf_counter()
    for _ in range(TIMED_RUNS):
        outputs = engine.run(inputs, outputs)
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started_at

    per_run_ms = elapsed / TIMED_RUNS * 1000
    tokens = outputs["image_embeds"].shape[0]
    print(f"[bench] vision encoder: {per_run_ms:.1f} ms per image, {tokens} llm tokens out")
    print(f"[bench] {1000 / per_run_ms:.1f} images/s, peak vram {torch.cuda.max_memory_allocated() / 2 ** 30:.2f} GiB")


if __name__ == "__main__":
    main()
