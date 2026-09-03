import sys

import numpy as np
import torch
import tensorrt as trt


def main() -> None:
    print(f"[trt] python {sys.version.split()[0]}")
    print(f"[trt] torch {torch.__version__}, cuda {torch.version.cuda}")
    print(f"[trt] torch arch list {torch.cuda.get_arch_list()}")
    if not torch.cuda.is_available():
        raise SystemExit("Expected torch to see a CUDA device, it sees none")
    capability = torch.cuda.get_device_capability(0)
    properties = torch.cuda.get_device_properties(0)
    print(f"[trt] device 0: {properties.name}, sm_{capability[0]}{capability[1]}, {properties.total_memory / 2 ** 30:.1f} GiB")
    print(f"[trt] tensorrt {trt.__version__}")

    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    print(f"[trt] platform has fast fp16 {builder.platform_has_fast_fp16}, fast int8 {builder.platform_has_fast_int8}")

    config = builder.create_builder_config()
    for precision in ["FP16", "INT8", "FP8", "BF16"]:
        flag = getattr(trt.BuilderFlag, precision, None)
        if flag is None:
            print(f"[trt] {precision}: not in this TensorRT")
            continue
        config.set_flag(flag)
        print(f"[trt] {precision}: settable")
        config.clear_flag(flag)

    network = builder.create_network(0)
    size = 512
    a = network.add_input("a", trt.float16, (size, size))
    weights = trt.Weights(np.eye(size, dtype=np.float16))
    layer = network.add_constant((size, size), weights)
    matmul = network.add_matrix_multiply(a, trt.MatrixOperation.NONE, layer.get_output(0), trt.MatrixOperation.NONE)
    matmul.get_output(0).name = "b"
    network.mark_output(matmul.get_output(0))

    config = builder.create_builder_config()
    config.set_flag(trt.BuilderFlag.FP16)
    serialized = builder.build_serialized_network(network, config)
    if serialized is None:
        raise SystemExit("Expected TensorRT to build a trivial fp16 matmul engine, it returned nothing")
    print(f"[trt] built a trivial {size}x{size} fp16 engine: {serialized.nbytes / 1024:.1f} KiB")

    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(serialized)
    print(f"[trt] deserialized, {engine.num_io_tensors} io tensors")
    print("[trt] ok")


if __name__ == "__main__":
    main()
