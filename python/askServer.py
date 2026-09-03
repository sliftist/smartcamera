import contextlib
import json
import sys
import traceback

from PIL import Image

from runtime import Qwen3VLTensorRT

DEFAULT_MAX_NEW_TOKENS = 48


def main() -> None:
    with contextlib.redirect_stdout(sys.stderr):
        model = Qwen3VLTensorRT()
    print(json.dumps({"ready": True, "imageTokens": model.image_tokens}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            width = int(request["width"])
            height = int(request["height"])
            with open(request["file"], "rb") as handle:
                raw = handle.read()
            expected = width * height * 3
            if len(raw) != expected:
                raise ValueError(f"Expected {expected} bytes for {width}x{height} rgb, got {len(raw)}")
            image = Image.frombytes("RGB", (width, height), raw)
            with contextlib.redirect_stdout(sys.stderr):
                answer, timings = model.generate_timed(
                    image,
                    request["prompt"],
                    max_new_tokens=int(request.get("maxNewTokens", DEFAULT_MAX_NEW_TOKENS)),
                )
            print(json.dumps({"answer": answer, **timings}), flush=True)
        except Exception as error:
            print(json.dumps({"error": "".join(traceback.format_exception_only(type(error), error)).strip()}), flush=True)


if __name__ == "__main__":
    main()
