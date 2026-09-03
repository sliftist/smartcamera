from pathlib import Path

import onnx


def consolidate_external_data(model_path: Path) -> None:
    directory = model_path.parent
    model = onnx.load(str(model_path), load_external_data=True)
    data_file = f"{model_path.stem}.onnx_data"
    keep = {model_path.name, data_file}
    keep_suffixes = {".pt", ".log", ".json", ".onnx", ".onnx_data"}
    stale = [
        f for f in directory.iterdir()
        if f.is_file() and f.name not in keep and f.suffix not in keep_suffixes
    ]
    existing = directory / data_file
    if existing.exists():
        existing.unlink()
    onnx.save_model(
        model,
        str(model_path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=data_file,
        size_threshold=0,
        convert_attribute=False,
    )
    removed = 0
    for path in stale:
        try:
            path.unlink()
            removed += 1
        except OSError as error:
            print(f"[onnx] could not remove {path.name}: {error}")
    total = model_path.stat().st_size + (directory / data_file).stat().st_size
    print(f"[onnx] {model_path.name} + {data_file}: {total / 2 ** 30:.2f} GiB, dropped {removed} loose tensor files")
