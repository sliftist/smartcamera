import shutil
import sys

from paths import DECODER_ENGINE, ENGINE_DIR


def variant_path(name: str):
    return ENGINE_DIR / f"decoder.{name}.plan"


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] not in ("save", "use", "list"):
        raise SystemExit("Usage: useEngine.py <save|use> <name>")
    action, name = sys.argv[1], sys.argv[2]
    target = variant_path(name)
    if action == "save":
        if not DECODER_ENGINE.exists():
            raise SystemExit(f"Expected {DECODER_ENGINE} to exist")
        shutil.copy2(DECODER_ENGINE, target)
        print(f"[engine] saved the active engine as {target.name} ({target.stat().st_size / 2 ** 20:.0f} MiB)")
    else:
        if not target.exists():
            available = sorted(p.name for p in ENGINE_DIR.glob("decoder.*.plan"))
            raise SystemExit(f"Expected {target.name}; available: {available}")
        shutil.copy2(target, DECODER_ENGINE)
        print(f"[engine] activated {target.name} ({target.stat().st_size / 2 ** 20:.0f} MiB)")


if __name__ == "__main__":
    main()
