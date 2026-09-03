from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_ROOT = REPO_ROOT / "models"
HF_TOKEN_PATH = Path.home() / "facehuggingtoken.txt"

QWEN_REPO = "Qwen/Qwen3-VL-8B-Instruct"
QWEN_DIR = MODELS_ROOT / "qwen3vl-8b-instruct"
ONNX_DIR = MODELS_ROOT / "qwen3vl-onnx"
ENGINE_DIR = MODELS_ROOT / "qwen3vl-trt"

IMAGE_HEIGHT = 704
IMAGE_WIDTH = 1280
MAX_CACHE_TOKENS = 2048

VISION_ONNX = ONNX_DIR / "vision" / "vision.onnx"
VISION_POSITIONS = ONNX_DIR / "vision" / "positions.pt"
CALIBRATION_FILE = MODELS_ROOT / "calibration.npz"

DECODER_ONNX = ONNX_DIR / "decoder" / "decoder.onnx"
DECODER_INT8_ONNX = ONNX_DIR / "decoder-int8" / "decoder.onnx"
DECODER_FP8_ONNX = ONNX_DIR / "decoder-fp8" / "decoder.onnx"

VISION_ENGINE = ENGINE_DIR / "vision.plan"
DECODER_ENGINE = ENGINE_DIR / "decoder.plan"

PROFILE_PREFILL = 0
PROFILE_DECODE = 1


def hf_token() -> str | None:
    try:
        token = HF_TOKEN_PATH.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    return token or None
