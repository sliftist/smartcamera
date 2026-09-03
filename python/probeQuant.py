import time
from pathlib import Path

import numpy as np
import onnx
import tensorrt as trt
import torch
from onnx import TensorProto, helper, numpy_helper

from paths import MODELS_ROOT
from trtrun import TrtEngine

SIZE = 4096
BATCH = 1024
OPSET = 21
PROBE_DIR = MODELS_ROOT / "quant-probe"
WARMUP = 5
RUNS = 50


def build_graph(mode: str, path: Path) -> None:
    rng = np.random.default_rng(0)
    weight = (rng.standard_normal((SIZE, SIZE)) * 0.02).astype(np.float32)

    nodes = []
    initializers = []
    x = helper.make_tensor_value_info("x", TensorProto.FLOAT, [BATCH, SIZE])
    y = helper.make_tensor_value_info("y", TensorProto.FLOAT, [BATCH, SIZE])

    if mode == "fp16":
        initializers.append(numpy_helper.from_array(weight, "w"))
        nodes.append(helper.make_node("MatMul", ["x", "w"], ["y"], name="gemm"))
    else:
        if mode.startswith("int8"):
            amax = 127.0
            if mode == "int8pc":
                columns = np.abs(weight).max(axis=0) / amax
                packed = np.clip(np.rint(weight / columns), -127, 127).astype(np.int8)
                weight_scale = columns.astype(np.float32)
            else:
                weight_scale = np.float32(np.abs(weight).max() / amax)
                packed = np.clip(np.rint(weight / weight_scale), -127, 127).astype(np.int8)
            zero = numpy_helper.from_array(np.array(0, dtype=np.int8), "w_zero")
            act_zero = numpy_helper.from_array(np.array(0, dtype=np.int8), "x_zero")
        else:
            quant_dtype = TensorProto.FLOAT8E4M3FN
            amax = 448.0
            weight_scale = np.float32(np.abs(weight).max() / amax)
            scaled = torch.from_numpy(weight / weight_scale).to(torch.float8_e4m3fn)
            packed = scaled
            zero = helper.make_tensor("w_zero", TensorProto.FLOAT8E4M3FN, [], [0])
            act_zero = helper.make_tensor("x_zero", TensorProto.FLOAT8E4M3FN, [], [0])

        if mode.startswith("int8"):
            weight_tensor = numpy_helper.from_array(packed, "w_q")
        else:
            weight_tensor = helper.make_tensor(
                "w_q", TensorProto.FLOAT8E4M3FN, [SIZE, SIZE],
                packed.view(torch.uint8).numpy().tobytes(), raw=True,
            )
        initializers.append(weight_tensor)
        initializers.append(numpy_helper.from_array(weight_scale, "w_scale"))
        initializers.append(numpy_helper.from_array(np.float32(3.0 / amax), "x_scale"))
        initializers.append(zero)
        initializers.append(act_zero)

        nodes.append(helper.make_node("QuantizeLinear", ["x", "x_scale", "x_zero"], ["x_q"], name="x_quant"))
        nodes.append(helper.make_node("DequantizeLinear", ["x_q", "x_scale", "x_zero"], ["x_dq"], name="x_dequant"))
        if mode == "int8pc":
            dequant = helper.make_node("DequantizeLinear", ["w_q", "w_scale"], ["w_dq"], name="w_dequant", axis=1)
        else:
            dequant = helper.make_node("DequantizeLinear", ["w_q", "w_scale", "w_zero"], ["w_dq"], name="w_dequant")
        nodes.append(dequant)
        nodes.append(helper.make_node("MatMul", ["x_dq", "w_dq"], ["y"], name="gemm"))

    graph = helper.make_graph(nodes, f"probe_{mode}", [x], [y], initializer=initializers)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", OPSET)])
    model.ir_version = 10
    path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(model, str(path))


def build_engine(mode: str, onnx_path: Path, engine_path: Path) -> int:
    logger = trt.Logger(trt.Logger.ERROR)
    builder = trt.Builder(logger)
    network = builder.create_network(0)
    parser = trt.OnnxParser(network, logger)
    if not parser.parse_from_file(str(onnx_path)):
        for index in range(parser.num_errors):
            print(f"[quant] {mode} parser error: {parser.get_error(index)}")
        return 0
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 2 * 2 ** 30)
    config.set_flag(trt.BuilderFlag.FP16)
    if mode.startswith("int8"):
        config.set_flag(trt.BuilderFlag.INT8)
    if mode == "fp8":
        config.set_flag(trt.BuilderFlag.FP8)
    serialized = builder.build_serialized_network(network, config)
    if serialized is None:
        print(f"[quant] {mode}: build returned nothing")
        return 0
    engine_path.write_bytes(bytes(serialized))
    return serialized.nbytes


def main() -> None:
    print(f"[quant] probing a single {BATCH}x{SIZE} @ {SIZE}x{SIZE} GEMM, weights are {SIZE * SIZE * 4 / 2 ** 20:.0f} MiB in fp32")
    for mode in ["fp16", "int8", "int8pc", "fp8"]:
        onnx_path = PROBE_DIR / f"{mode}.onnx"
        engine_path = PROBE_DIR / f"{mode}.plan"
        build_graph(mode, onnx_path)
        size = build_engine(mode, onnx_path, engine_path)
        if not size:
            print(f"[quant] {mode}: FAILED")
            continue
        engine = TrtEngine(engine_path)
        inputs = {"x": torch.randn(BATCH, SIZE, device="cuda")}
        outputs = engine.run(inputs)
        for _ in range(WARMUP):
            outputs = engine.run(inputs, outputs)
        torch.cuda.synchronize()
        started = time.perf_counter()
        for _ in range(RUNS):
            outputs = engine.run(inputs, outputs)
        torch.cuda.synchronize()
        elapsed = (time.perf_counter() - started) / RUNS
        flops = 2 * BATCH * SIZE * SIZE
        print(
            f"[quant] {mode:5s}: engine {size / 2 ** 20:7.1f} MiB, {elapsed * 1000:6.3f} ms, "
            f"{flops / elapsed / 1e12:6.1f} TFLOP/s"
        )


if __name__ == "__main__":
    main()
