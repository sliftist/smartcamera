import time
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from paths import DECODER_ONNX, DECODER_INT8_ONNX, CALIBRATION_FILE

MIN_ELEMENTS = 1 << 20
INT8_MAX = 127.0
SPIKY_CHANNEL_FRACTION = 0.01
NEVER_QUANTIZE = {"lm_head.weight"}


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


def load_calibration():
    if not CALIBRATION_FILE.exists():
        raise SystemExit(f"Expected {CALIBRATION_FILE}; run `yarn calibrate` first")
    data = np.load(str(CALIBRATION_FILE), allow_pickle=False)
    names = [str(name) for name in data["names"]]
    per_tensor = dict(zip(names, data["per_tensor"]))
    spiky = {}
    for name in names:
        channels = data[f"channel::{name}"]
        step = float(per_tensor[name]) / INT8_MAX
        spiky[name] = float((channels < step).mean())
    return per_tensor, spiky


def main() -> None:
    source, target = DECODER_ONNX, DECODER_INT8_ONNX
    target.parent.mkdir(parents=True, exist_ok=True)
    activation_amax, spiky = load_calibration()
    print(f"[int8] loaded {len(activation_amax)} activation ranges")

    started_at = time.time()
    print(f"[int8] loading {source}")
    model = onnx.load(str(source), load_external_data=True)
    graph = model.graph
    initializers = initializer_map(graph)
    producers = producer_map(graph)

    quantized = 0
    missing = []
    kept_fp16 = []
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
        if tensor_name in NEVER_QUANTIZE or spiky[tensor_name] > SPIKY_CHANNEL_FRACTION:
            kept_fp16.append((tensor_name, spiky[tensor_name], weight.size))
            half = numpy_helper.from_array(weight.astype(np.float16), f"{tensor_name}_fp16")
            added_initializers.append(half)
            new_nodes.append(helper.make_node(
                "Cast",
                inputs=[half.name],
                outputs=[f"{tensor_name}_fp16_up"],
                name=f"{tensor_name}_fp16_cast",
                to=TensorProto.FLOAT,
            ))
            node.input[1] = f"{tensor_name}_fp16_up"
            removed_initializers.add(tensor_name)
            if transpose_node is not None:
                drop_nodes.add(id(transpose_node))
            continue

        weight = weight.astype(np.float32)
        original_bytes += weight.size * 4
        scale = np.abs(weight).max(axis=0) / INT8_MAX
        scale[scale == 0] = 1.0
        packed = np.clip(np.rint(weight / scale), -127, 127).astype(np.int8)

        base = f"{tensor_name}_q"
        weight_tensor = numpy_helper.from_array(packed, f"{base}_w")
        scale_tensor = numpy_helper.from_array(scale.astype(np.float32), f"{base}_wscale")
        act_scale = numpy_helper.from_array(np.float32(amax / INT8_MAX), f"{base}_ascale")
        act_zero = numpy_helper.from_array(np.array(0, dtype=np.int8), f"{base}_azero")
        added_initializers.extend([weight_tensor, scale_tensor, act_scale, act_zero])

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
            inputs=[weight_tensor.name, scale_tensor.name],
            outputs=[f"{base}_wdq"],
            name=f"{base}_wdequant",
            axis=1,
        ))
        node.input[0] = f"{base}_xdq"
        node.input[1] = f"{base}_wdq"
        removed_initializers.add(tensor_name)
        if transpose_node is not None:
            drop_nodes.add(id(transpose_node))
        quantized += 1

    if missing:
        raise SystemExit(f"Expected a calibrated range for every large MatMul, {len(missing)} are missing, e.g. {missing[:3]}")
    if not quantized:
        raise SystemExit("Expected to quantize at least one MatMul weight, found none")

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
    print(f"[int8] quantized {quantized} MatMuls (weights per-channel, activations per-tensor)")
    if kept_fp16:
        fp16_params = sum(size for _, _, size in kept_fp16)
        print(f"[int8] left {len(kept_fp16)} spiky MatMuls in fp16 ({fp16_params * 2 / 2 ** 30:.2f} GiB):")
        for name, fraction, _ in sorted(kept_fp16, key=lambda entry: entry[1], reverse=True)[:12]:
            print(f"[int8]   {name:52s} {fraction * 100:5.1f}% of channels under one step")
    print(f"[int8] weights {original_bytes / 2 ** 30:.2f} GiB fp32 -> {original_bytes / 4 / 2 ** 30:.2f} GiB int8")
    print(f"[int8] wrote {target.name} + {data_file}: {total / 2 ** 30:.2f} GiB in {(time.time() - started_at) / 60:.1f} min")


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


if __name__ == "__main__":
    main()
