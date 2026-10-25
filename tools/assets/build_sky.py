"""Build the visible sky backdrop from a CC0 "pure sky" HDRI (Poly Haven).

    python tools/assets/build_sky.py [--raw DIR]

Reads tools/assets/raw/polyhaven/hdris/kloofendal_48d_partly_cloudy_puresky_4k.hdr and writes
packages/client/public/env/:

- sky_sunny.webp (4096 × 1024) and sky_sunny_low.webp (2048 × 512): the upper hemisphere
  (elevation 0°..90°, equirectangular), sun removed (the game draws its own sun disc and casts
  shadows from the real-time light), rotated so the sun sits at the sunny preset's azimuth,
  normalised to mean luminance 1 and stored gamma-encoded: v = (L / SKY_RANGE)^(1/2.2) per
  channel (the client decodes it linearly and applies the preset's sky gain). WebP at the
  lowest quality as faithful as the JPEG q90 / q88 it replaced (tools/assets/webp.py).
- sky.json: source, range, the sun's elevation/azimuth after rotation (the preset's sun
  direction must match, so light and sky agree).

Deterministic; logged in ASSETS.md.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

import build_env
from webp import save_webp

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'tools/assets/raw/polyhaven/hdris'
OUT = ROOT / 'packages/client/public/env'
SOURCE = 'kloofendal_48d_partly_cloudy_puresky'
SUN_AZIMUTH = 215.0  # weather.ts sunny.sunAzimuth
SKY_RANGE = 4.0
SUN_RADIUS_DEG = 4.0


def load(path: Path) -> np.ndarray:
    w, h, ch = build_env.read_hdr(path)
    return np.stack([np.asarray(c, dtype=np.float32).reshape(h, w) for c in ch], axis=-1)


def build(raw: Path) -> None:
    img = load(raw / f'{SOURCE}_4k.hdr')
    h, w, _ = img.shape
    lum = img @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    upper = lum[: h // 2]
    sy, sx = np.unravel_index(int(np.argmax(upper)), upper.shape)
    sun_elev = 90.0 - (sy + 0.5) / h * 180.0
    sun_az = (sx + 0.5) / w * 360.0
    # Remove the sun: replace a disc around it with the ring just outside (smooth falloff).
    yy, xx = np.mgrid[0:h, 0:w]
    elev = np.radians(90.0 - (yy + 0.5) / h * 180.0)
    az = np.radians((xx + 0.5) / w * 360.0)
    se, sa = np.radians(sun_elev), np.radians(sun_az)
    cosd = np.sin(elev) * np.sin(se) + np.cos(elev) * np.cos(se) * np.cos(az - sa)
    dist = np.degrees(np.arccos(np.clip(cosd, -1, 1)))
    ring = (dist > SUN_RADIUS_DEG) & (dist < SUN_RADIUS_DEG * 1.8)
    fill = np.median(img[ring], axis=0)
    t = np.clip((dist - SUN_RADIUS_DEG * 0.6) / (SUN_RADIUS_DEG * 0.4), 0, 1)[..., None]
    img = np.where(dist[..., None] < SUN_RADIUS_DEG, img * t + fill * (1 - t), img)
    img = np.minimum(img, SKY_RANGE * 2)
    # Rotate so the sun sits at the preset azimuth (columns wrap).
    shift = int(round((SUN_AZIMUTH - sun_az) / 360.0 * w))
    img = np.roll(img, shift, axis=1)
    sky = img[: h // 2]
    mean = float((sky @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)).mean())
    sky = sky / mean
    OUT.mkdir(parents=True, exist_ok=True)
    enc = np.clip(sky / SKY_RANGE, 0, 1) ** (1 / 2.2)
    im = Image.fromarray((enc * 255 + 0.5).astype(np.uint8), 'RGB')
    save_webp(im.resize((4096, 1024), Image.Resampling.LANCZOS), OUT / 'sky_sunny.webp', match_jpeg=90)
    save_webp(im.resize((2048, 512), Image.Resampling.LANCZOS), OUT / 'sky_sunny_low.webp', match_jpeg=88)
    meta = {
        'sunny': {
            'file': 'sky_sunny.webp',
            'source': build_env.SOURCE_URL.format(SOURCE),
            'license': 'CC0 1.0',
            'range': SKY_RANGE,
            'gamma': 2.2,
            'sunElevation': round(sun_elev, 1),
            'sunAzimuth': SUN_AZIMUTH,
            'sourceSunAzimuth': round(sun_az, 1),
            'sourceUpperMean': round(mean, 5),
        }
    }
    (OUT / 'sky.json').write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(meta))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', type=Path, default=RAW)
    build(ap.parse_args().raw)
