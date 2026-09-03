import time
from pathlib import Path

import tensorrt as trt

WORKSPACE_BYTES = 4 * 2 ** 30


class BuildProgress(trt.IProgressMonitor):
    def __init__(self, label: str):
        super().__init__()
        self.label = label
        self.started_at = time.time()
        self.last_report = 0.0
        self.phases = {}

    def phase_start(self, phase_name, parent_phase, num_steps):
        self.phases[phase_name] = [0, num_steps]
        self.report(phase_name)

    def phase_finish(self, phase_name):
        self.phases.pop(phase_name, None)

    def step_complete(self, phase_name, step):
        entry = self.phases.get(phase_name)
        if entry:
            entry[0] = step
        self.report(phase_name)
        return True

    def report(self, phase_name):
        now = time.time()
        if now - self.last_report < 15.0:
            return
        self.last_report = now
        entry = self.phases.get(phase_name)
        if not entry:
            return
        step, total = entry
        elapsed = now - self.started_at
        print(f"[{self.label}] {elapsed:6.0f}s {phase_name}: {step}/{total}", flush=True)


def build_engine(
    onnx_path: Path,
    engine_path: Path,
    label: str,
    fp16: bool = True,
    bf16: bool = False,
    int8: bool = False,
    fp8: bool = False,
    profiles=None,
    builder_optimization_level: int = 3,
    force_fp32_hints=(),
) -> None:
    logger = trt.Logger(trt.Logger.WARNING)
    trt.init_libnvinfer_plugins(logger, "")
    builder = trt.Builder(logger)
    network = builder.create_network(0)
    parser = trt.OnnxParser(network, logger)

    print(f"[{label}] parsing {onnx_path.name}")
    started_at = time.time()
    if not parser.parse_from_file(str(onnx_path)):
        for index in range(parser.num_errors):
            print(f"[{label}] parser error {index}: {parser.get_error(index)}")
        raise SystemExit(f"Expected {onnx_path} to parse as ONNX")
    print(f"[{label}] parsed in {time.time() - started_at:.0f}s, {network.num_layers} layers")
    for index in range(network.num_inputs):
        tensor = network.get_input(index)
        print(f"[{label}]   input {tensor.name}: {tensor.shape} {tensor.dtype}")
    for index in range(network.num_outputs):
        tensor = network.get_output(index)
        print(f"[{label}]   output {tensor.name}: {tensor.shape} {tensor.dtype}")

    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, WORKSPACE_BYTES)
    config.builder_optimization_level = builder_optimization_level
    if fp16:
        config.set_flag(trt.BuilderFlag.FP16)
    if bf16:
        config.set_flag(trt.BuilderFlag.BF16)
    if int8:
        config.set_flag(trt.BuilderFlag.INT8)
    if fp8:
        config.set_flag(trt.BuilderFlag.FP8)
    for shapes in profiles or []:
        profile = builder.create_optimization_profile()
        for name, (minimum, optimum, maximum) in shapes.items():
            profile.set_shape(name, minimum, optimum, maximum)
        config.add_optimization_profile(profile)

    if force_fp32_hints:
        config.set_flag(trt.BuilderFlag.PREFER_PRECISION_CONSTRAINTS)
        overflow_prone = {
            trt.LayerType.REDUCE,
            trt.LayerType.ELEMENTWISE,
            trt.LayerType.UNARY,
            trt.LayerType.NORMALIZATION,
        }
        forced = 0
        for index in range(network.num_layers):
            layer = network.get_layer(index)
            name = layer.name.lower()
            if not any(hint in name for hint in force_fp32_hints):
                continue
            if layer.type not in overflow_prone:
                continue
            layer.precision = trt.float32
            for output in range(layer.num_outputs):
                layer.set_output_type(output, trt.float32)
            forced += 1
        print(f"[{label}] pinned {forced} normalization layers to fp32")
        if not forced:
            raise SystemExit(f"Expected to pin normalization layers to fp32 for {label}, matched none")

    config.progress_monitor = BuildProgress(label)
    flags = [name for name, on in [("fp16", fp16), ("bf16", bf16), ("int8", int8), ("fp8", fp8)] if on]
    print(f"[{label}] building with {', '.join(flags) or 'fp32'}, optimization level {builder_optimization_level}")
    started_at = time.time()
    serialized = builder.build_serialized_network(network, config)
    if serialized is None:
        raise SystemExit(f"Expected TensorRT to build {engine_path.name}, it returned nothing")
    engine_path.parent.mkdir(parents=True, exist_ok=True)
    with open(engine_path, "wb") as handle:
        handle.write(serialized)
    elapsed = time.time() - started_at
    print(f"[{label}] built {engine_path.name}: {serialized.nbytes / 2 ** 20:.0f} MiB in {elapsed / 60:.1f} min")
