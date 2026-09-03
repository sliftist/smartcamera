import json

from paths import QWEN_DIR


def main() -> None:
    config = json.loads((QWEN_DIR / "config.json").read_text(encoding="utf-8"))
    print(json.dumps(config, indent=2))

    import torch
    from transformers import AutoConfig, AutoModelForImageTextToText

    loaded = AutoConfig.from_pretrained(str(QWEN_DIR))
    print(f"[inspect] config class {type(loaded).__name__}")

    model = AutoModelForImageTextToText.from_pretrained(
        str(QWEN_DIR),
        dtype=torch.bfloat16,
        device_map="cpu",
    )
    print(f"[inspect] model class {type(model).__name__}")
    for name, module in model.named_children():
        parameters = sum(p.numel() for p in module.parameters())
        print(f"[inspect]   {name}: {type(module).__name__}, {parameters / 1e9:.3f} B params")
    for name, module in model.model.named_children():
        parameters = sum(p.numel() for p in module.parameters())
        print(f"[inspect]     model.{name}: {type(module).__name__}, {parameters / 1e9:.3f} B params")

    visual = model.model.visual
    print(f"[inspect] visual: {type(visual).__name__}")
    for name, module in visual.named_children():
        parameters = sum(p.numel() for p in module.parameters())
        print(f"[inspect]     visual.{name}: {type(module).__name__}, {parameters / 1e9:.3f} B params")
    print(f"[inspect] visual.forward signature: {visual.forward.__doc__}")
    import inspect as inspect_module
    print(f"[inspect] visual.forward args: {inspect_module.signature(visual.forward)}")
    print(f"[inspect] language_model.forward args: {inspect_module.signature(model.model.language_model.forward)}")
    print(f"[inspect] deepstack layers: {getattr(visual, 'deepstack_visual_indexes', None)}")


if __name__ == "__main__":
    main()
