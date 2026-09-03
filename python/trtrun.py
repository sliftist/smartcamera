from pathlib import Path

import torch
import tensorrt as trt

TRT_TO_TORCH = {
    trt.DataType.FLOAT: torch.float32,
    trt.DataType.HALF: torch.float16,
    trt.DataType.BF16: torch.bfloat16,
    trt.DataType.INT8: torch.int8,
    trt.DataType.INT32: torch.int32,
    trt.DataType.INT64: torch.int64,
    trt.DataType.BOOL: torch.bool,
}


class TrtEngine:
    def __init__(self, engine_path: Path, device: str = "cuda"):
        self.logger = trt.Logger(trt.Logger.ERROR)
        trt.init_libnvinfer_plugins(self.logger, "")
        runtime = trt.Runtime(self.logger)
        with open(engine_path, "rb") as handle:
            self.engine = runtime.deserialize_cuda_engine(handle.read())
        if self.engine is None:
            raise SystemExit(f"Expected {engine_path} to deserialize as a TensorRT engine")
        self.device = device
        self.label = engine_path.stem
        profiles = max(1, self.engine.num_optimization_profiles)

        needed = 0
        for profile in range(profiles):
            needed = max(needed, self.engine.get_device_memory_size_for_profile_v2(profile))
        self.device_memory = torch.empty(needed, dtype=torch.uint8, device=device)
        print(
            f"[trt] {self.label}: {profiles} profile(s) sharing one "
            f"{needed / 2 ** 20:.0f} MiB scratch buffer"
        )

        self.contexts = []
        for profile in range(profiles):
            context = self.engine.create_execution_context(
                trt.ExecutionContextAllocationStrategy.USER_MANAGED
            )
            context.set_device_memory(self.device_memory.data_ptr(), needed)
            if profiles > 1:
                context.set_optimization_profile_async(profile, torch.cuda.current_stream().cuda_stream)
                torch.cuda.current_stream().synchronize()
            self.contexts.append(context)
        self.context = self.contexts[0]
        self.scratch = torch.zeros(1, dtype=torch.float32, device=device)
        self.input_names = []
        self.output_names = []
        for index in range(self.engine.num_io_tensors):
            name = self.engine.get_tensor_name(index)
            if self.engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT:
                self.input_names.append(name)
            else:
                self.output_names.append(name)

    def dtype_of(self, name: str) -> torch.dtype:
        trt_dtype = self.engine.get_tensor_dtype(name)
        torch_dtype = TRT_TO_TORCH.get(trt_dtype)
        if torch_dtype is None:
            raise SystemExit(f"Expected a known dtype for {name}, got {trt_dtype}")
        return torch_dtype

    def run(self, inputs: dict, outputs: dict | None = None, profile: int = 0) -> dict:
        context = self.contexts[profile]
        for name in self.input_names:
            tensor = inputs.get(name)
            if tensor is None:
                raise SystemExit(f"Expected an input named {name}, got {sorted(inputs)}")
            tensor = tensor.contiguous()
            inputs[name] = tensor
            context.set_input_shape(name, tuple(tensor.shape))
            address = tensor.data_ptr() or self.scratch.data_ptr()
            context.set_tensor_address(name, address)

        allocated = dict(outputs or {})
        for name in self.output_names:
            shape = tuple(context.get_tensor_shape(name))
            tensor = allocated.get(name)
            if tensor is None or tuple(tensor.shape) != shape:
                tensor = torch.empty(shape, dtype=self.dtype_of(name), device=self.device)
                allocated[name] = tensor
            context.set_tensor_address(name, tensor.data_ptr())

        stream = torch.cuda.current_stream()
        if not context.execute_async_v3(stream.cuda_stream):
            raise SystemExit("Expected TensorRT execution to be enqueued, it failed")
        return allocated
