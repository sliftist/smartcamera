# Running the eye on an AMD card

The TensorRT path in `python/` is nvidia only. On the Linux box with the Radeon RX 9060 XT the same
Qwen3-VL-8B runs through llama.cpp on ROCm instead, behind the same interface, so `eye2.ts` does not
know which one it is talking to. Pick with `SMARTCAMERA_BACKEND=llama` (the default) or `tensorrt`.

## Host setup

The card is Navi 44, `gfx1200`. Ubuntu 24.04's stock 6.8 kernel cannot drive it at all: `amdgpu`
fails to probe with `error -22` and the display falls back to `simple-framebuffer`. Fixing that is a
kernel upgrade and a reboot, not a driver install.

    apt install linux-generic-hwe-24.04     # 7.0.x, which knows RDNA4
    reboot

The `gc_12_0_1` firmware Navi 44 needs is already in Ubuntu's `linux-firmware`. After the reboot
`/dev/dri/renderD128` exists and `amdgpu` is bound.

ROCm 7.2.4 from AMD's own repository, because Ubuntu's `rocminfo` is 5.7 and far too old:

    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/rocm/apt/7.2.4 noble main" \
        > /etc/apt/sources.list.d/rocm.list
    apt install rocm-hip-sdk rocminfo rocm-smi-lib

`amdgpu-dkms` is deliberately not installed; the 7.0 kernel already carries the driver.

## Building llama.cpp

    HIPCXX="$(hipconfig -l)/clang" HIP_PATH="$(hipconfig -R)" \
        cmake -S . -B build -G Ninja -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1200 \
              -DGGML_HIP_ROCWMMA_FATTN=ON -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j12

GGML_HIP_ROCWMMA_FATTN is worth the flag. It builds attention against rocWMMA, which uses the matrix
cores this card actually has, and it is measured below at about 120ms a frame. The headers ship with
ROCm, so there is nothing else to install.

## Weights

`models/Qwen3-VL-8B-Instruct-Q8_0.gguf` and `models/mmproj-F16.gguf` from
`unsloth/Qwen3-VL-8B-Instruct-GGUF`. Q8 weights and the vision tower together sit near 10 GiB of the
card's 15.9 GiB.

## What the numbers say

Measured with `yarn bench:quant`, on four real frames from the camera, cold meaning a frame whose
pixels the model has not seen, which is every frame in live use.

Q8 beats Q4 on the cost that actually dominates. A frame is one prefill and a handful of output
tokens, and prefill is compute bound, where Q8's plain 8 bit integers beat Q4's unpacking. Q4 only
wins on sustained generation, which this workload barely does.

| model  | cold frame at 1280x704 | generation |
| ------ | ---------------------- | ---------- |
| Q8_0   | 996 ms                 | 35 tok/s   |
| Q4_K_M | 1039 ms                | 54 tok/s   |

Image size is the real lever, because Qwen3-VL charges tokens by area. Q8, cold:

| size      | image tokens | frame  |
| --------- | ------------ | ------ |
| 1920x1080 | 2060         | 3235ms |
| 1280x704  | 878          | 996ms  |
| 896x504   | 468          | 447ms  |
| 640x360   | 240          | 242ms  |

1280x704 is the default, and `SMARTCAMERA_IMAGE_WIDTH` and `SMARTCAMERA_IMAGE_HEIGHT` change it.
Every size above answered "is there a person" and "how many people" identically on the frames tested,
but those frames all held one large, close, unambiguous person, so they do not say anything about a
figure at the far end of a driveway. Re-run the sweep on frames that are actually hard before
trusting a smaller size.

Encoding the image is most of a frame's cost. llama.cpp does not report it separately, but an 878
token image prefills at about 900 tok/s where the same length of plain text runs at about 2200 tok/s,
which puts the vision encoder near 570 ms of a 970 ms frame. Anything that makes frames cheaper has
to come from the encoder or from handing it fewer pixels.

## Where a frame's time goes

Measured with everything else off the card, on the frame eye2 actually sends (1252x704), asking the
nine default questions. `yarn tune` reproduces it.

| stage | Q8_0 | what it is |
| --- | --- | --- |
| vision | 555 ms | the ViT encoding the image into about 880 tokens |
| prefill | 439 ms | reading those tokens plus the questions |
| generate | 529 ms | writing 19 tokens of answer |
| total | 1523 ms | |

Three roughly equal thirds, which is why there is no single thing to fix.

The card is not being wasted: 100% busy, 3.1 GHz, 202 W under this load. Whatever is left has to come
from better kernels or less work, not from unlocking the hardware.

What was tried and did not help: flash attention forced on rather than auto, and prompt batch sizes
from 512 up to 4096. All within noise, because prefill is not where the bottleneck is.

What did help:

| change | total | note |
| --- | --- | --- |
| baseline | 1647 ms | |
| rocWMMA attention | 1523 ms | mostly vision, 655 to 555 |
| rocWMMA + Q4_K_M | 1416 ms | generate 529 to 347, prefill 439 to 495 |

Q4 is not adopted: it trades answer quality for 107 ms, and Q8 is within noise of lossless while Q4
is not. The build flag is adopted, since it costs nothing.

There is no fp8 to try. GGUF has no 8-bit float weight type at all; the only 8-bit type is Q8_0, and
the 4-bit floats MXFP4 and NVFP4 are the only float quantizations there are. Q8_0 would beat an fp8
of the same size anyway, having 8 mantissa bits with a per-block scale against e4m3's three.

The remaining lever is a smaller model. Qwen3-VL exists at 4B and 2B, and both would cut generate and
prefill close to proportionally while leaving vision alone, since the vision tower is the same size.
That is a quality decision rather than a tuning one.
