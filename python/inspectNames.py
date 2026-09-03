import onnx

from paths import DECODER_INT8_ONNX

NORM_HINTS = ("layernorm", "q_norm", "k_norm", "/norm/", "norm/")
SHOW = 24


def main() -> None:
    model = onnx.load(str(DECODER_INT8_ONNX), load_external_data=False)
    nodes = list(model.graph.node)
    print(f"[names] {len(nodes)} nodes")

    named = [node for node in nodes if node.name]
    print(f"[names] {len(named)} have names")
    for node in nodes[:6]:
        print(f"[names]   sample: {node.op_type:20s} {node.name}")

    matches = [node for node in nodes if any(hint in node.name.lower() for hint in NORM_HINTS)]
    print(f"[names] {len(matches)} match norm hints")
    kinds = {}
    for node in matches:
        kinds[node.op_type] = kinds.get(node.op_type, 0) + 1
    print(f"[names] matched op types: {kinds}")
    for node in matches[:SHOW]:
        print(f"[names]   {node.op_type:20s} {node.name}")


if __name__ == "__main__":
    main()
