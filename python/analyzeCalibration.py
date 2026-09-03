import numpy as np

from paths import CALIBRATION_FILE

KINDS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj", "lm_head"]


def kind_of(name: str) -> str:
    for kind in KINDS:
        if kind in name:
            return kind
    return "other"


def main() -> None:
    data = np.load(str(CALIBRATION_FILE), allow_pickle=False)
    names = [str(name) for name in data["names"]]
    per_tensor = dict(zip(names, data["per_tensor"]))

    print(f"{'kind':10s} {'n':>3s} {'amax median':>12s} {'amax worst':>11s} {'outlier median':>15s} {'outlier worst':>14s}")
    for kind in KINDS:
        selected = [name for name in names if kind_of(name) == kind]
        if not selected:
            continue
        amaxes = []
        ratios = []
        for name in selected:
            channels = data[f"channel::{name}"]
            amax = float(per_tensor[name])
            typical = float(np.percentile(channels, 99.0))
            amaxes.append(amax)
            ratios.append(amax / max(typical, 1e-6))
        print(
            f"{kind:10s} {len(selected):3d} {np.median(amaxes):12.1f} {max(amaxes):11.1f}"
            f" {np.median(ratios):15.1f} {max(ratios):14.1f}"
        )

    print()
    print("outlier ratio = per-tensor amax / 99th-percentile of per-channel maxima")
    print("a ratio near 1 quantizes cleanly; a large ratio means a few channels dominate the scale")

    worst = sorted(names, key=lambda n: per_tensor[n], reverse=True)[:10]
    print()
    for name in worst:
        channels = data[f"channel::{name}"]
        amax = float(per_tensor[name])
        step = amax / 127.0
        below = float((channels < step).mean() * 100)
        print(f"  {name:52s} amax {amax:8.1f} step {step:7.3f} channels under one step {below:5.1f}%")


if __name__ == "__main__":
    main()
