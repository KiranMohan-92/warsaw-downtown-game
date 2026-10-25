"""Prepare the Codex-generated vehicle texture sources for the Blender bake (system Python).

    python tools/assets/vehicle_texprep.py SRC_DIR OUT_DIR [--size 1024] [--sheet sheet.jpg]

For each `<name>_albedo.png` in SRC_DIR (raw, git-ignored, ~1254 px):
- resize to `--size`;
- de-light: divide out the very-low-frequency luminance (baked gradients / vignetting), keeping
  the mean, so the albedo carries no lighting;
- heal the seams: blend with a half-offset copy under a smooth window (the copy's wrap edges are
  the original's continuous centre), with a variance correction so the blend band keeps its
  contrast; the result tiles (opposite-edge difference ≈ an ordinary neighbour difference);
- write OUT_DIR/<name>.png (healed albedo) and OUT_DIR/<name>_height.png (high-passed luminance,
  the bump source); roughness/metalness are derived per material in vehicle_mats.py.
Prints the seam metric per source. Deterministic. Nothing here ships: the bake does.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def lum(a: np.ndarray) -> np.ndarray:
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def blur(x: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur of a 2D float array, wrap-around (tileable)."""
    n = x.shape[0]
    f = np.fft.fftfreq(n)
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (f[:, None] ** 2 + f[None, :] ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(x) * g))


def delight(a: np.ndarray, strength=0.8) -> np.ndarray:
    n = a.shape[0]
    L = lum(a)
    low = blur(L, n / 6)
    gain = (L.mean() / np.maximum(low, 1e-3)) ** strength
    return np.clip(a * gain[..., None], 0, 1)


def heal(a: np.ndarray) -> np.ndarray:
    """Best of a few offset choices: a structured source (panel lines) can put a line right on
    the copy's new edge; the offset whose edges match best wins."""
    n = a.shape[0]
    best = None
    for oy, ox in ((n // 2, n // 2), (n // 2 + n // 9, n // 2 - n // 7), (n // 3, n // 2 + n // 5), (2 * n // 5, 3 * n // 5)):
        out = _heal(a, oy, ox)
        e, i = seam_metric(out)
        if best is None or e / i < best[0]:
            best = (e / i, out)
    return best[1]


def _heal(a: np.ndarray, oy: int, ox: int) -> np.ndarray:
    n = a.shape[0]
    s = np.roll(a, (oy, ox), (0, 1))
    t = np.linspace(0, 1, n)
    # 1 in the middle, 0 at the edges; wide flat centre, 22 % blend bands.
    ramp = np.clip(np.minimum(t, 1 - t) / 0.22, 0, 1)
    ramp = ramp * ramp * (3 - 2 * ramp)
    w = np.minimum(ramp[:, None], ramp[None, :])[..., None]
    mean = a.reshape(-1, 3).mean(0)
    out = w * a + (1 - w) * s
    k = 1 / np.sqrt(w * w + (1 - w) ** 2)
    return np.clip(mean + (out - mean) * k, 0, 1)


def seam_metric(a: np.ndarray) -> tuple[float, float]:
    """Mean |RGB| difference across the wrap edges vs between ordinary neighbours (0–255)."""
    edge = (np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0] - a[-1]).mean()) / 2
    inner = (np.abs(np.diff(a, axis=1)).mean() + np.abs(np.diff(a, axis=0)).mean()) / 2
    return float(edge * 255), float(inner * 255)


def height(a: np.ndarray) -> np.ndarray:
    L = lum(a)
    hp = L - blur(L, a.shape[0] / 48)
    hp = (hp - hp.mean()) / (hp.std() * 4 + 1e-6) + 0.5
    return np.clip(hp, 0, 1)


def prep(src: Path, out: Path, size: int, delit=True) -> dict:
    img = Image.open(src).convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
    a = np.asarray(img, dtype=np.float64) / 255
    before = seam_metric(a)
    if delit:
        a = delight(a)
    a = heal(a)
    after = seam_metric(a)
    name = src.name.replace('_albedo.png', '')
    Image.fromarray((a * 255 + 0.5).astype(np.uint8)).save(out / f'{name}.png')
    Image.fromarray((height(a) * 255 + 0.5).astype(np.uint8)).save(out / f'{name}_height.png')
    return {'name': name, 'seam_before': round(before[0], 2), 'seam_after': round(after[0], 2),
            'neighbour': round(after[1], 2), 'mean_rgb': [round(float(v) * 255, 1) for v in a.reshape(-1, 3).mean(0)]}


def sheet(out: Path, names: list[str], path: Path) -> None:
    """Swatch sheet: each healed source tiled 2×2 (seams would show as a cross), labelled."""
    from PIL import ImageDraw
    cell = 384
    cols = 4
    rows = (len(names) + cols - 1) // cols
    sh = Image.new('RGB', (cols * cell, rows * (cell + 24)), (24, 24, 24))
    d = ImageDraw.Draw(sh)
    for i, n in enumerate(names):
        t = Image.open(out / f'{n}.png').resize((cell // 2, cell // 2), Image.Resampling.LANCZOS)
        x, y = (i % cols) * cell, (i // cols) * (cell + 24)
        for dx in (0, 1):
            for dy in (0, 1):
                sh.paste(t, (x + dx * cell // 2, y + dy * cell // 2))
        d.text((x + 6, y + cell + 5), f'{n} (2x2 tiled)', fill=(230, 230, 230))
    sh.save(path, quality=88)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('src', type=Path)
    ap.add_argument('out', type=Path)
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--sheet', type=Path)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    rows = []
    for src in sorted(a.src.glob('*_albedo.png')):
        r = prep(src, a.out, a.size)
        rows.append(r)
        print(json.dumps(r))
    if a.sheet and rows:
        sheet(a.out, [r['name'] for r in rows], a.sheet)


if __name__ == '__main__':
    main()
