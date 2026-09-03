import time

import numpy as np
import onnx
import torch
from onnx import TensorProto, helper, numpy_helper

from paths import DECODER_ONNX, DECODER_FP8_ONNX, CALIBRATION_FILE

MIN_ELEMENTS = 1 << 20
FP8_MAX = 448.0
FP8_OPSET = 21


def initializer_map(graph):
    return {tensor.name: tensor for tensor in graph.initializer}


def producer_map(graph):
    producers = {}
    for node in graph.node:
        for output in node.output:
            producers[output] = node
    return producers


def resolve_weight(name, initializers, producers):
    tensor = initializers.get(name)
    if tensor is not None:
        return numpy_helper.to_array(tensor), name, None
    node = producers.get(name)
    if node is not None and node.op_type == "Transpose":
        source = initializers.get(node.input[0])
        if source is not None:
            perm = None
            for attribute in node.attribute:
                if attribute.name == "perm":
                    perm = list(attribute.ints)
            array = numpy_helper.to_array(source)
            array = array.transpose(perm) if perm else array.T
            return array, node.input[0], node
    return None, None, None


def fp8_tensor(values: np.ndarray, name: str):
    packed = torch.from_numpy(values).to(torch.float8_e4m3fn)
    raw = packed.view(torch.uint8).numpy().tobytes()
    return helper.make_tensor(name, TensorProto.FLOAT8E4M3FN, list(values.shape), raw, raw=True)


def fp8_zero(name: str):
    return helper.make_tensor(name, TensorProto.FLOAT8E4M3FN, [], b"\x00", raw=True)


def load_calibration():
    if not CALIBRATION_FILE.exists():
        raise SystemExit(f"Expected {CALIBRATION_FILE}; run `yarn calibrate` first")
    data = np.load(str(CALIBRATION_FILE), allow_pickle=False)
    names = [str(name) for name in data["names"]]
    return dict(zip(names, data["per_tensor"]))


def topological_sort(graph, nodes):
    available = {tensor.name for tensor in graph.initializer}
    for value in graph.input:
        available.add(value.name)
    consumers = {}
    pending_count = []
    ready = []
    for index, node in enumerate(nodes):
        missing = 0
        for name in node.input:
            if name == "" or name in available:
                continue
            missing += 1
            consumers.setdefault(name, []).append(index)
        pending_count.append(missing)
        if missing == 0:
            ready.append(index)
    ordered = []
    while ready:
        index = ready.pop()
        node = nodes[index]
        ordered.append(node)
        for name in node.output:
            if name in available:
                continue
            available.add(name)
            for waiter in consumers.pop(name, []):
                pending_count[waiter] -= 1
                if pending_count[waiter] == 0:
                    ready.append(waiter)
    if len(ordered) != len(nodes):
        raise SystemExit(f"Expected all {len(nodes)} nodes to sort topologically, only {len(ordered)} did")
    return ordered


def main() -> None:
    source, target = DECODER_ONNX, DECODER_FP8_ONNX
    target.parent.mkdir(parents=True, exist_ok=True)
    activation_amax = load_calibration()
    print(f"[fp8] loaded {len(activation_amax)} activation ranges")

    started_at = time.time()
    print(f"[fp8] loading {source}")
    model = onnx.load(str(source), load_external_data=True)
    graph = model.graph
    initializers = initializer_map(graph)
    producers = producer_map(graph)

    quantized = 0
    missing = []
    original_bytes = 0
    new_nodes = []
    drop_nodes = set()
    added_initializers = []
    removed_initializers = set()

    for node in graph.node:
        if node.op_type != "MatMul":
            continue
        weight, tensor_name, transpose_node = resolve_weight(node.input[1], initializers, producers)
        if weight is None or weight.ndim != 2:
            continue
        if weight.size < MIN_ELEMENTS:
            continue
        amax = activation_amax.get(tensor_name)
        if amax is None or not np.isfinite(amax) or amax <= 0:
            missing.append(tensor_name)
            continue

        weight = weight.astype(np.float32)
        original_bytes += weight.size * 4
        weight_scale = float(np.abs(weight).max()) / FP8_MAX
        if weight_scale <= 0:
            weight_scale = 1.0
        scaled = np.clip(weight / weight_scale, -FP8_MAX, FP8_MAX)

        base = f"{tensor_name}_fp8"
        weight_tensor = fp8_tensor(scaled, f"{base}_w")
        weight_scale_tensor = numpy_helper.from_array(np.float32(weight_scale), f"{base}_wscale")
        weight_zero = fp8_zero(f"{base}_wzero")
        act_scale = numpy_helper.from_array(np.float32(amax / FP8_MAX), f"{base}_ascale")
        act_zero = fp8_zero(f"{base}_azero")
        added_initializers.extend([weight_tensor, weight_scale_tensor, weight_zero, act_scale, act_zero])

        new_nodes.append(helper.make_node(
            "QuantizeLinear",
            inputs=[node.input[0], act_scale.name, act_zero.name],
            outputs=[f"{base}_xq"],
            name=f"{base}_quant",
        ))
        new_nodes.append(helper.make_node(
            "DequantizeLinear",
            inputs=[f"{base}_xq", act_scale.name, act_zero.name],
            outputs=[f"{base}_xdq"],
            name=f"{base}_xdequant",
        ))
        new_nodes.append(helper.make_node(
            "DequantizeLinear",
            inputs=[weight_tensor.name, weight_scale_tensor.name, weight_zero.name],
            outputs=[f"{base}_wdq"],
            name=f"{base}_wdequant",
        ))
        node.input[0] = f"{base}_xdq"
        node.input[1] = f"{base}_wdq"
        removed_initializers.add(tensor_name)
        if transpose_node is not None:
            drop_nodes.add(id(transpose_node))
        quantized += 1

    if missing:
        raise SystemExit(f"Expected a calibrated range for every large MatMul, {len(missing)} missing, e.g. {missing[:3]}")
    if not quantized:
        raise SystemExit("Expected to quantize at least one MatMul, found none")

    kept = [node for node in graph.node if id(node) not in drop_nodes]
    still_used = set()
    for node in kept:
        still_used.update(node.input)
    remaining = [t for t in graph.initializer if t.name not in removed_initializers or t.name in still_used]

    del graph.initializer[:]
    graph.initializer.extend(remaining + added_initializers)
    ordered = topological_sort(graph, new_nodes + kept)
    del graph.node[:]
    graph.node.extend(ordered)

    del model.opset_import[:]
    model.opset_import.extend([helper.make_opsetid("", FP8_OPSET)])
    model.ir_version = 10

    data_file = f"{target.stem}.onnx_data"
    existing = target.parent / data_file
    if existing.exists():
        existing.unlink()
    onnx.save_model(
        model,
        str(target),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=data_file,
        size_threshold=0,
        convert_attribute=False,
    )
    total = target.stat().st_size + (target.parent / data_file).stat().st_size
    print(f"[fp8] quantized {quantized} MatMuls to fp8 e4m3, weights and activations, no exclusions")
    print(f"[fp8] weights {original_bytes / 2 ** 30:.2f} GiB fp32 -> {original_bytes / 4 / 2 ** 30:.2f} GiB fp8")
    print(f"[fp8] wrote {target.name} + {data_file}: {total / 2 ** 30:.2f} GiB in {(time.time() - started_at) / 60:.1f} min")


if __name__ == "__main__":
    main()
