import time

from huggingface_hub import snapshot_download

from paths import QWEN_REPO, QWEN_DIR, MODELS_ROOT, hf_token

ALLOW_PATTERNS = ["*.json", "*.safetensors", "*.txt", "*.py"]


def main() -> None:
    MODELS_ROOT.mkdir(parents=True, exist_ok=True)
    started_at = time.time()
    print(f"[download] {QWEN_REPO} -> {QWEN_DIR}")
    path = snapshot_download(
        repo_id=QWEN_REPO,
        local_dir=str(QWEN_DIR),
        allow_patterns=ALLOW_PATTERNS,
        token=hf_token(),
        max_workers=8,
    )
    total = sum(f.stat().st_size for f in QWEN_DIR.rglob("*") if f.is_file())
    print(f"[download] {path}: {total / 2 ** 30:.2f} GiB in {time.time() - started_at:.0f}s")


if __name__ == "__main__":
    main()
