#!/usr/bin/env python3
"""Local hole-filler used by dsh-media-image's `kind: command` provider.

Contract (same as the plugin's other backends):
  --image IN.png --mask MASK.png --out OUT.png
  MASK: white (>=128) = pixels to invent, black = keep.
  On success prints one JSON object to stdout; on failure prints JSON with ok=false
  and exits non-zero.

This is a *diffusion* fill (Telea-like iterative relaxation), not a neural model.
It is good at removing small objects, text and blemishes on smooth or textured
backgrounds; it cannot invent new subjects. Do not describe its output as AI
inpainting.
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image


def load(image_path, mask_path):
    image = Image.open(image_path).convert("RGB")
    mask = Image.open(mask_path).convert("L")
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.NEAREST)
    return image, mask


def relax(fill, hole, iterations, tolerance):
    """Jacobi relaxation: every hole pixel becomes the mean of its 4 neighbours."""
    height, width = hole.shape
    for step in range(iterations):
        up = np.roll(fill, 1, axis=0)
        down = np.roll(fill, -1, axis=0)
        left = np.roll(fill, 1, axis=1)
        right = np.roll(fill, -1, axis=1)
        # 边界外不参与（roll 会绕回另一侧），把它们当作自身值。
        up[0, :] = fill[0, :]
        down[-1, :] = fill[-1, :]
        left[:, 0] = fill[:, 0]
        right[:, -1] = fill[:, -1]
        average = (up + down + left + right) / 4.0
        delta = np.abs(average[hole] - fill[hole]).mean() if hole.any() else 0.0
        fill[hole] = average[hole]
        if delta <= tolerance:
            return step + 1
    return iterations


def feather_blend(original, filled, hole, radius):
    """在洞的外侧做一圈过渡，避免补丁边缘出现硬线。"""
    if radius <= 0:
        return filled
    mask = hole.astype(np.float32)
    # 反复取 3x3 最大值，得到向外扩张的环带。
    for _ in range(radius):
        grown = mask.copy()
        grown[1:, :] = np.maximum(grown[1:, :], mask[:-1, :])
        grown[:-1, :] = np.maximum(grown[:-1, :], mask[1:, :])
        grown[:, 1:] = np.maximum(grown[:, 1:], mask[:, :-1])
        grown[:, :-1] = np.maximum(grown[:, :-1], mask[:, 1:])
        mask = grown
    band = (mask > 0) & (~hole)
    if not band.any():
        return filled
    alpha = np.clip(mask, 0.0, 1.0)[..., None]
    blended = original * (1.0 - alpha) + filled * alpha
    out = filled.copy()
    out[band] = blended[band]
    return out


def inpaint(image_path, mask_path, out_path, iterations=600, tolerance=0.02, feather=2):
    image, mask = load(image_path, mask_path)
    pixels = np.asarray(image, dtype=np.float32)
    hole = np.asarray(mask, dtype=np.uint8) > 127
    if not hole.any():
        raise SystemExit(json.dumps({"ok": False, "error": "mask has no white pixels: nothing to fill"}))
    if hole.all():
        raise SystemExit(json.dumps({"ok": False, "error": "mask covers the whole picture: nothing to keep"}))

    known = ~hole
    fill = pixels.copy()
    # 初值取已知区域均值，比全 0 收敛快，也不会在洞里留下黑色底。
    fill[hole] = pixels[known].mean(axis=0)

    steps = relax(fill, hole, iterations, tolerance)
    fill = feather_blend(pixels, fill, hole, feather)
    # 洞外像素逐字节保持原样。
    fill[known] = pixels[known]

    out = np.clip(np.rint(fill), 0, 255).astype(np.uint8)
    Image.fromarray(out, "RGB").save(out_path, format="PNG")

    height, width = hole.shape
    ys, xs = np.nonzero(hole)
    return {
        "ok": True,
        "out": out_path,
        "width": int(width),
        "height": int(height),
        "filledPixels": int(hole.sum()),
        "ratio": round(float(hole.sum()) / float(width * height), 4),
        "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
        "iterations": int(steps),
        "engine": "diffusion-telea-like",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Diffusion hole filler for dsh-media-image")
    parser.add_argument("--image", required=True)
    parser.add_argument("--mask", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--iterations", type=int, default=600)
    parser.add_argument("--tolerance", type=float, default=0.02)
    parser.add_argument("--feather", type=int, default=2)
    args = parser.parse_args(argv)
    try:
        result = inpaint(args.image, args.mask, args.out, args.iterations, args.tolerance, args.feather)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - 一律转成 JSON，方便调用方解析
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
