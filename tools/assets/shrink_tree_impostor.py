"""Resize tree impostor normal/AO atlases for the shipped download budget.

The colour impostor atlas remains at the browser bake's full resolution. This helper downsamples the
normal/AO atlas with the colour alpha as coverage weights, then re-normalizes vectors before the
shared WebP encoder writes the result losslessly.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

FRAMES = 8


def resize_normal_atlas(normal: Image.Image, color: Image.Image, frame: int) -> Image.Image:
    src_normal = np.asarray(normal.convert("RGBA"), dtype=np.uint8)
    src_alpha = np.asarray(color.convert("RGBA"), dtype=np.uint8)[..., 3].astype(np.float64) / 255.0
    height, width, _ = src_normal.shape
    target_width = frame * FRAMES
    if width % target_width != 0 or height % frame != 0:
        raise ValueError("Tree normal resize must evenly divide the source atlas")
    sx = width // target_width
    sy = height // frame
    normals = src_normal[..., :3].astype(np.float64) / 255.0 * 2.0 - 1.0
    ao = src_normal[..., 3].astype(np.float64) / 255.0
    out = np.zeros((frame, target_width, 4), dtype=np.uint8)
    for y in range(frame):
        for x in range(target_width):
            ys = slice(y * sy, (y + 1) * sy)
            xs = slice(x * sx, (x + 1) * sx)
            weight = src_alpha[ys, xs]
            total = float(weight.sum())
            if total <= 1e-6:
                out[y, x] = [128, 255, 128, 255]
                continue
            vector = (normals[ys, xs] * weight[..., None]).sum(axis=(0, 1)) / total
            length = float(np.linalg.norm(vector))
            if length <= 1e-6:
                vector = np.array([0.0, 1.0, 0.0])
            else:
                vector /= length
            out[y, x, :3] = np.round((vector * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)
            out[y, x, 3] = round(float((ao[ys, xs] * weight).sum() / total) * 255)
    return Image.fromarray(out, "RGBA")


def shrink(path: Path, color_path: Path, frame: int) -> None:
    with Image.open(path) as normal, Image.open(color_path) as color:
        normal.load()
        color.load()
        resize_normal_atlas(normal, color, frame).save(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("frame", type=int)
    parser.add_argument("--color", type=Path, required=True)
    args = parser.parse_args()
    shrink(args.path, args.color, args.frame)


if __name__ == "__main__":
    main()
