"""Loading-screen stills: graded frames of the game's own trailer footage -> public/loading/*.webp.

    python tools/assets/build_loading_stills.py [--footage DIR] [--preview DIR]

Sources are our own in-game captures (warsaw-trailer/footage3: the Trailer 2 shoot, golden hour,
rendered by the game itself on the T2000; HUD-free shots only). Each still is one clean frame (no HUD, no text, no name tags),
graded toward the trailer master's look (brighter, contrasty, warm highlights, deep blacks), scaled
to 1600 x 900 (portrait files: 608 x 1080 cuts, PORTRAITS) and written as lossy WebP sized to the budget (first still <= 200 KB, all <= 1 MB;
`loading/stills.test.ts` checks the shipped files). Needs ffmpeg on PATH. Logged in ASSETS.md.
Grain and vignette are CSS overlays (index.html), not baked: baked grain would cost bytes.
"""

import argparse
import io
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

import webp

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'packages/client/public/loading'
FOOTAGE = Path.home() / 'myprojects/warsaw-trailer/footage3'
SIZE = (1600, 900)
# (output name, source clip, time s, per-still exposure). Order = rotation order; the first is the
# static index.html background. Must match STILLS in packages/client/src/loading/stills.ts.
STILLS = [
    ('palace_golden', 'W_descent_golden', 5.6, 1.0),
    ('jet_launch_golden', 'J_jet_orbit_launch', 1.3, 1.0),
    ('jet_market_golden', 'J_jet_container_hop', 1.2, 1.0),
    ('truck_colonnade_golden', 'K_truck_colonnade_dolly', 2.2, 1.0),
    ('market_trucks_golden', 'K_truck_drone_follow', 2.75, 1.0),
    ('colonnade_fight_golden', 'F_colonnade_crossfire_slomo', 3.0, 1.0),
    ('crown_golden', 'UP_crown_after', 2.75, 1.0),
    ('skyline_golden', 'W_pullback_finale', 4.0, 1.0),
]
# Portrait files for stills whose subject fills the frame (phones see ~a quarter of the width):
# (output name, source clip, time s, exposure, crop centre as a fraction of the width). Cut at
# full source height, 608 x 1080 (9:16). Must match `portraitId` in stills.ts.
PORTRAITS = [
    ('jet_launch_golden_portrait', 'J_jet_orbit_launch', 1.3, 1.0, 0.49),
]
PORTRAIT_SIZE = (608, 1080)
PORTRAIT_BUDGET = 80_000
FIRST_BUDGET = 190_000
EACH_BUDGET = 112_000
QUALITIES = range(88, 49, -3)


def frame(footage: Path, clip: str, t: float) -> Image.Image:
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(t), '-i', str(footage / f'{clip}.mp4'),
           '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']
    return Image.open(io.BytesIO(subprocess.run(cmd, check=True, capture_output=True).stdout)).convert('RGB')


def grade(im: Image.Image, exposure: float) -> Image.Image:
    """Trailer-like grade: lift, S-curve, warm highlights / cool shadows, deeper blacks."""
    x = np.asarray(im, np.float64) / 255.0
    x = np.clip(x * exposure, 0, 1)
    # Black point + S-curve (smoothstep blend keeps mids, pushes ends).
    x = np.clip((x - 0.025) / 0.975, 0, 1)
    s = x * x * (3 - 2 * x)
    x = x * 0.45 + s * 0.55
    lum = (x * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    # Split tone: highlights toward amber, shadows toward teal (as in the trailer master).
    hi = np.clip((lum - 0.45) / 0.55, 0, 1)
    lo = np.clip((0.35 - lum) / 0.35, 0, 1)
    x = x + hi * np.array([0.05, 0.015, -0.035]) + lo * np.array([-0.015, 0.005, 0.02])
    # A touch more saturation.
    lum = (x * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    x = lum + (x - lum) * 1.12
    return Image.fromarray((np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')


def encode_within(im: Image.Image, budget: int) -> tuple[bytes, int]:
    for q in QUALITIES:
        data = webp.encode(im, q)
        if len(data) <= budget:
            return data, q
    raise SystemExit(f'cannot fit {budget} bytes')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--footage', type=Path, default=FOOTAGE)
    ap.add_argument('--preview', type=Path, help='also write graded PNGs here (not shipped)')
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for i, (name, clip, t, exposure) in enumerate(STILLS):
        im = grade(frame(a.footage, clip, t), exposure).resize(SIZE, Image.LANCZOS)
        data, q = encode_within(im, FIRST_BUDGET if i == 0 else EACH_BUDGET)
        (OUT / f'{name}.webp').write_bytes(data)
        if a.preview:
            a.preview.mkdir(parents=True, exist_ok=True)
            im.save(a.preview / f'{name}.png')
        total += len(data)
        print(f'{name:20s} {clip}@{t}s q{q} {len(data) / 1000:.0f} KB')
    for name, clip, t, exposure, cx in PORTRAITS:
        im = grade(frame(a.footage, clip, t), exposure)
        w, h = PORTRAIT_SIZE
        left = min(max(0, round(im.width * cx - w / 2)), im.width - w)
        im = im.crop((left, 0, left + w, h))
        data, q = encode_within(im, PORTRAIT_BUDGET)
        (OUT / f'{name}.webp').write_bytes(data)
        if a.preview:
            im.save(a.preview / f'{name}.png')
        total += len(data)
        print(f'{name:20s} {clip}@{t}s q{q} {len(data) / 1000:.0f} KB (portrait)')
    print(f'total {total / 1000:.0f} KB')


if __name__ == '__main__':
    sys.exit(main())
