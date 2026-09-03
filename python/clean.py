import shutil

from paths import ONNX_DIR, DECODER_ONNX, DECODER_INT8_ONNX, VISION_ONNX, REPO_ROOT

KEEP = {VISION_ONNX.parent.name, DECODER_ONNX.parent.name, DECODER_INT8_ONNX.parent.name}
STALE_SOURCES = ["scripts/dockerGpu.ts", "src/docker.ts"]


def main() -> None:
    for relative in STALE_SOURCES:
        path = REPO_ROOT / relative
        if path.exists():
            path.unlink()
            print(f"[clean] removed {relative}")

    if not ONNX_DIR.exists():
        print(f"[clean] {ONNX_DIR} does not exist, nothing to do")
        return
    freed = 0
    for entry in sorted(ONNX_DIR.iterdir()):
        if not entry.is_dir() or entry.name in KEEP:
            continue
        size = sum(f.stat().st_size for f in entry.rglob("*") if f.is_file())
        shutil.rmtree(entry)
        freed += size
        print(f"[clean] removed {entry.name}: {size / 2 ** 30:.2f} GiB")
    print(f"[clean] freed {freed / 2 ** 30:.2f} GiB, kept {sorted(KEEP)}")


if __name__ == "__main__":
    main()
