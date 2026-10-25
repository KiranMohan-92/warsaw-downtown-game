"""Generate the Palace portico pilot stone maps as WebP.

The texture is authored procedurally for this project. The math stays deterministic and small
enough for asset tests to inspect without launching Blender, and all outputs go through the shared
Pillow/libwebp encoder.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageFilter
from webp import save_webp

PILOT_NAME = "palace_column"
REPO_ROOT = Path(__file__).resolve().parents[2]


def _hash2(x: int, y: int, seed: int) -> float:
    h = (x * 374761393 + y * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _smooth(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def _vnoise(x: float, y: float, period: int, seed: int) -> float:
    xi = math.floor(x)
    yi = math.floor(y)
    xf = x - xi
    yf = y - yi
    x0 = xi % period
    y0 = yi % period
    x1 = (xi + 1) % period
    y1 = (yi + 1) % period
    a = _hash2(x0, y0, seed)
    b = _hash2(x1, y0, seed)
    c = _hash2(x0, y1, seed)
    d = _hash2(x1, y1, seed)
    u = _smooth(xf)
    v = _smooth(yf)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


def _fbm(u: float, v: float, base: int, octaves: int, seed: int) -> float:
    total = 0.0
    amp = 0.5
    norm = 0.0
    freq = base
    for octave in range(octaves):
        total += amp * _vnoise(u * freq, v * freq, freq, seed + octave * 19)
        norm += amp
        amp *= 0.5
        freq *= 2
    return total / norm


def _stone_profile(u: float, v: float) -> tuple[float, float, float, float]:
    """Return height, albedo multiplier, roughness and reddish mineral tint."""
    row = math.floor(v * 5.0)
    block = u * 3.0 + (0.5 if row % 2 else 0.0)
    col = math.floor(block)
    edge_u = abs((block % 1.0) - 0.5) * 2.0
    edge_v = abs((v * 5.0 % 1.0) - 0.5) * 2.0
    joint = max(edge_u, edge_v)
    grain = 0.5 * _fbm(u, v, 42, 3, 910) + 0.5 * _fbm(u, v, 122, 2, 911)
    broad = _fbm(u + col * 0.037, v + row * 0.041, 7, 3, 912)
    pore = 1.0 if _hash2(math.floor(u * 280), math.floor(v * 280), 913) > 0.985 else 0.0
    edge = max(0.0, min(1.0, (joint - 0.78) / 0.22))
    height = 0.62 + 0.17 * broad + 0.12 * grain - 0.09 * edge - 0.23 * pore
    if joint > 0.972:
        height = 0.22 + 0.08 * grain
    mineral = max(0.0, _fbm(u, v, 18, 3, 914) - 0.58)
    water_run = max(0.0, 0.17 - abs(((u * 5.0 + row * 0.29) % 1.0) - 0.5))
    face_stain = max(0.0, _fbm(u + row * 0.07, v + col * 0.09, 11, 3, 915) - 0.55)
    tint = 0.9 + 0.28 * broad - 0.64 * water_run - 0.32 * pore - 0.26 * face_stain
    if joint > 0.972:
        tint *= 0.58
    rough = max(0.72, min(1.0, 0.9 + 0.12 * edge + 0.11 * pore - 0.12 * grain))
    return max(0.0, min(1.0, height)), max(0.55, min(1.18, tint)), rough, mineral


def column_uv(world_x: float, world_y: float, world_z: float, normal: tuple[float, float, float]) -> tuple[float, float]:
    """World-space triplanar projection used by the column geometry and tests."""
    nx, _ny, nz = normal
    u = world_z if abs(nx) > abs(nz) else world_x
    return u / 1.35 % 1.0, world_y / 2.2 % 1.0


def texture_bytes(size: int) -> dict[str, bytearray]:
    heights = [0.0] * (size * size)
    tint = [0.0] * (size * size)
    rough = [0.0] * (size * size)
    mineral = [0.0] * (size * size)
    for y in range(size):
        for x in range(size):
            i = y * size + x
            heights[i], tint[i], rough[i], mineral[i] = _stone_profile(x / size, y / size)

    def at(ix: int, iy: int) -> float:
        return heights[(iy % size) * size + (ix % size)]

    albedo = bytearray(size * size * 4)
    normal = bytearray(size * size * 4)
    roughness = bytearray(size * size * 4)
    base = (228, 214, 187)
    for y in range(size):
        for x in range(size):
            i = y * size + x
            h = heights[i]
            k = tint[i] * (0.86 + 0.18 * h)
            red = 1.0 + mineral[i] * 0.18
            green = 1.0 - mineral[i] * 0.04
            blue = 1.0 - mineral[i] * 0.14
            albedo[i * 4 + 0] = round(min(255, base[0] * k * red))
            albedo[i * 4 + 1] = round(min(255, base[1] * k * green))
            albedo[i * 4 + 2] = round(min(255, base[2] * k * blue))
            albedo[i * 4 + 3] = 255
            dx = (at(x + 1, y) - at(x - 1, y)) * 11.0
            dy = (at(x, y + 1) - at(x, y - 1)) * 11.0
            length = math.sqrt(dx * dx + dy * dy + 1.0)
            normal[i * 4 + 0] = round(((-dx / length) * 0.5 + 0.5) * 255)
            normal[i * 4 + 1] = round(((dy / length) * 0.5 + 0.5) * 255)
            normal[i * 4 + 2] = round(((1.0 / length) * 0.5 + 0.5) * 255)
            normal[i * 4 + 3] = 255
            roughness[i * 4 + 0] = 255
            roughness[i * 4 + 1] = round(rough[i] * 255)
            roughness[i * 4 + 2] = 255
            roughness[i * 4 + 3] = 255
    return {"albedo": albedo, "normal": normal, "roughness": roughness}


def _save_image(name: str, pixels: Iterable[int], size: int, out_dir: Path) -> Path:
    image = Image.frombytes("RGBA", (size, size), bytes(pixels))
    image = image.filter(ImageFilter.GaussianBlur(1.0))
    kind = "color" if name.endswith("_albedo") else "data"
    match_jpeg = 85 if kind == "color" else None
    return save_webp(image, out_dir / f"{name}.webp", kind, match_jpeg=match_jpeg)


def _manifest_path(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.name


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("tools/assets/build/palace-pilot"))
    parser.add_argument("--size", type=int, default=256)
    args = parser.parse_args(argv)
    if args.size < 64 or args.size > 1024 or args.size & (args.size - 1):
        raise SystemExit("--size must be a power of two between 64 and 1024")

    started = time.perf_counter()
    args.out = args.out if args.out.is_absolute() else REPO_ROOT / args.out
    args.out.mkdir(parents=True, exist_ok=True)
    texels = texture_bytes(args.size)
    written = {}
    for suffix, pixels in texels.items():
        path = _save_image(f"{PILOT_NAME}_{suffix}", pixels, args.size, args.out)
        written[suffix] = {
            "path": _manifest_path(path),
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
    manifest = {
        "name": PILOT_NAME,
        "kind": "procedural-authoring-pilot",
        "size": args.size,
        "projection": "world x/z by dominant horizontal normal, y vertical",
        "provenance": "authored procedural sandstone; no third-party source images",
        "filter": "gaussian 1 px before WebP encode",
        "seconds": round(time.perf_counter() - started, 3),
        "outputs": written,
    }
    (args.out / f"{PILOT_NAME}.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    raise SystemExit(main(args))
