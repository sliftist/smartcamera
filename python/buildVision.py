from paths import VISION_ONNX, VISION_ENGINE, ENGINE_DIR
from trtbuild import build_engine


def main() -> None:
    ENGINE_DIR.mkdir(parents=True, exist_ok=True)
    build_engine(VISION_ONNX, VISION_ENGINE, label="vision", fp16=True)


if __name__ == "__main__":
    main()
