"""Build browser-ready surface textures from the raw Poly Haven (CC0) sets.

    python tools/assets/build_textures.py [--raw DIR] [--stats-only]

Reads tools/assets/raw/polyhaven/textures/<set>/ and writes packages/client/public/tex/<surface>_*.webp
(tools/assets/webp.py, each at the lowest quality as faithful as the JPEG q82 these sets
shipped as before 2026-09-29):

- albedo      sRGB colour with the set's ambient occlusion multiplied in (AO_STRENGTH), so the
              shader needs no aoMap (an extra define would recompile every map program), then
              matched to the surface's palette colour (materials.ts SURFACES) in float, before the
              8-bit encode: see `match_palette`.
- normal      OpenGL-convention tangent normal (what three.js expects).
- rough       roughness in G (three.js reads roughness from G), R/B white.

Sets bigger than LOW_SIZE also get a <surface>_<map>_512.webp copy for the Low quality tier (Low
must not cost more GPU memory or texture bandwidth than the 512 px procedural maps it replaces).

Then writes packages/client/src/render/surfaceTextureStats.gen.ts: the linear-light mean and 95th
percentile of every albedo, and each set's size. The client derives one luminance gain per surface
from them (surfaceTextures.ts `paletteGain`); since the textures already carry the palette's hue and
brightness, that gain stays near 1 and only absorbs later palette brightness tweaks.
`--stats-only` just refreshes that file from the committed textures (no raw files needed).

Deterministic; safe to re-run. Every output is logged in ASSETS.md.
"""

import argparse
import re
from pathlib import Path

from PIL import Image, ImageMath

from webp import save_webp

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'tools/assets/raw/polyhaven/textures'
OUT = ROOT / 'packages/client/public/tex'
STATS = ROOT / 'packages/client/src/render/surfaceTextureStats.gen.ts'
MATERIALS = ROOT / 'packages/client/src/render/materials.ts'

# Game surface -> (Poly Haven set, output size px)
SURFACES = {
    'asphalt': ('asphalt_02', 1024),
    'sidewalk': ('square_concrete_pavers', 1024),
    'paving': ('granite_tile_04', 1024),
    'concrete': ('concrete_wall_008', 1024),
    'plaster': ('grey_plaster_02', 1024),
    'wood': ('wood_planks', 512),
    'metal': ('metal_plate', 512),
    'container': ('worn_corrugated_iron', 512),
    'grass': ('leafy_grass', 512),
    # Office towers: ambientCG's ribbon-window curtain wall, 8 storeys (26.4 m) per tile.
    'glass': ('acg:Facade006', 1024),
}
ACG_RAW = ROOT / 'tools/assets/raw/ambientcg'
# Poly Haven map kind -> ambientCG file suffix ('ao' absent: no occlusion to fold in).
ACG_KIND = {'diffuse': 'Color', 'nor_gl': 'NormalGL', 'rough': 'Roughness'}
LOW_SIZE = 512
AO_STRENGTH = 0.6
# WebP quality is matched per image to this JPEG quality's PSNR (the pre-WebP encode).
MATCH_JPEG = 82

# ---- palette match (the taste knobs) -----------------------------------------------------------
# Rec. 709 luminance weights (linear light), as in the client's paletteGain.
LUMA = (0.2126, 0.7152, 0.0722)
# Brightest albedo allowed at the scan's 95th percentile (mirrors paletteGain's `ceiling`).
CEILING = 0.9
# How much of the scan's own local colour variation (moss, rust, stains, leaf litter) survives the
# re-tint, as an exponent on each texel's chromaticity relative to the scan's mean: 0 = a grey scan
# tinted to the palette hue, 1 = the full variation (and the full per-channel noise of a strongly
# tinted scan's faint channel, the old per-channel gain). The mean hue is always the palette's.
CHROMA_KEEP = 0.5


def find(raw: Path, set_id: str, kind: str) -> Path | None:
    if set_id.startswith('acg:'):
        acg = set_id[4:]
        if kind not in ACG_KIND:
            return None
        path = ACG_RAW / acg / f'{acg}_2K-JPG_{ACG_KIND[kind]}.jpg'
        if not path.exists():
            raise SystemExit(f'missing {path}')
        return path
    hits = sorted((raw / set_id).glob(f'{set_id}_{kind}_*.jpg'))
    if not hits:
        raise SystemExit(f'missing {kind} map for {set_id} (run fetch_polyhaven.py)')
    return hits[0]


def srgb_to_linear(v: int) -> float:
    c = v / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(x: float) -> float:
    x = min(max(x, 0.0), 1.0)
    return x * 12.92 if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055


_LINEAR = [srgb_to_linear(v) for v in range(256)]
# 16-bit linear code -> 8-bit sRGB code (the encode is exact to well under one sRGB step).
_ENCODE16 = [round(linear_to_srgb(i / 65535) * 255) for i in range(65536)]

Bands = tuple[Image.Image, Image.Image, Image.Image]  # linear-light float ('F') R, G, B


def to_linear(img: Image.Image) -> Bands:
    r, g, b = (band.point(_LINEAR, 'F') for band in img.convert('RGB').split())
    return r, g, b


def to_srgb(bands: Bands) -> Image.Image:
    """Linear float bands -> 8-bit sRGB RGB image (clipped to [0, 1])."""
    out = []
    for band in bands:
        q = ImageMath.lambda_eval(
            lambda a: a['int'](a['min'](a['max'](a['x'], 0.0), 1.0) * 65535.0 + 0.5), x=band
        )
        out.append(q.point(_ENCODE16, 'L'))
    return Image.merge('RGB', out)


def band_mean(band: Image.Image) -> float:
    return band.resize((1, 1), Image.BOX).getpixel((0, 0))


def luminance(rgb) -> float:
    return sum(w * c for w, c in zip(LUMA, rgb))


def hex_to_linear(hex_colour: str) -> tuple[float, float, float]:
    h = hex_colour.lstrip('#')
    r, g, b = (_LINEAR[int(h[i : i + 2], 16)] for i in (0, 2, 4))
    return r, g, b


def read_palette(src: str) -> dict[str, str]:
    """Surface id -> palette colour ('#rrggbb') from materials.ts's SURFACES table."""
    block = src[src.index('const SURFACES') :]
    pairs = re.findall(r"^  (\w+): \{\n(?:    //.*\n)*    color: '(#[0-9a-fA-F]{6})'", block, re.M)
    return dict(pairs)


def retint(bands: Bands, target: tuple[float, float, float], keep: float = CHROMA_KEEP) -> Bands:
    """Give the scan the target's hue without stretching its faint channels.

    Each texel keeps its own luminance L and gets the target hue, times its chromaticity relative
    to the scan's mean hue raised to `keep`:  out = L * (t / L(t)) * ((c / L) / (m / L(m)))^keep.
    Detail comes from the luminance (well exposed in every scan), so a dark, strongly tinted scan
    does not stretch its faint channel's quantisation and chroma noise by the full per-channel
    ratio (up to 25x for metal_plate's blue); with keep < 1 that noise is compressed too.
    """
    m = [band_mean(b) for b in bands]
    lm, lt = max(luminance(m), 1e-6), max(luminance(target), 1e-6)
    r, g, b = bands
    lum = ImageMath.lambda_eval(
        lambda a: a['max'](a['r'] * LUMA[0] + a['g'] * LUMA[1] + a['b'] * LUMA[2], 1e-6),
        r=r,
        g=g,
        b=b,
    )
    out = []
    for c, band in enumerate(bands):
        ht, hm = target[c] / lt, max(m[c] / lm, 1e-6)
        out.append(
            ImageMath.lambda_eval(
                lambda a, ht=ht, hm=hm: a['L'] * ht * (a['c'] / (a['L'] * hm)) ** keep,
                L=lum,
                c=band,
            )
        )
    return out[0], out[1], out[2]


def palette_gains(stats: tuple[list[float], list[float]], target: tuple[float, float, float]) -> list[float]:
    """Per-channel gains that put the mean on `target`, scaled down together if the 95th
    percentile would pass CEILING. Applied after `retint`, so they are all close to one number."""
    mean, p95 = stats
    g = [target[c] / max(mean[c], 1e-6) for c in range(3)]
    peak = max(p95[c] * g[c] for c in range(3))
    k = CEILING / peak if peak > CEILING else 1.0
    return [x * k for x in g]


def exposure_gain(stats: tuple[list[float], list[float]], target_lum: float) -> float:
    """One luminance gain onto the target, scaled down if the 95th percentile would pass CEILING
    (what the client's paletteGain computes from the generated stats)."""
    mean, p95 = stats
    g = target_lum / max(luminance(mean), 1e-6)
    peak = max(p95) * g
    return CEILING / max(p95) if peak > CEILING else g


def match_palette(img: Image.Image, target: tuple[float, float, float]) -> Image.Image:
    """Re-tint (`retint`), then expose onto the palette colour, in float before the 8-bit encode,
    so the texture carries the palette's hue and brightness at full code range."""
    tinted = retint(to_linear(img), target)
    gains = palette_gains(linear_stats(to_srgb(tinted)), target)
    return to_srgb(
        tuple(ImageMath.lambda_eval(lambda a, k=k: a['x'] * k, x=b) for b, k in zip(tinted, gains))
    )


def downsize(img: Image.Image, size: int) -> Image.Image:
    """Resize an sRGB colour image in linear light: averaging encoded values darkens contrasty
    textures (asphalt's Low copy came out 4 % darker than the full set it shares stats with)."""
    bands = tuple(b.resize((size, size), Image.LANCZOS) for b in to_linear(img))
    return to_srgb(bands)


def build(raw: Path, surface: str, set_id: str, size: int, target: tuple[float, float, float]) -> list[Path]:
    def load(kind: str, mode: str) -> Image.Image:
        path = find(raw, set_id, kind)
        if path is None:  # no such map in this set (ambientCG has no separate AO): neutral
            return Image.new(mode, (size, size), 255)
        return Image.open(path).convert(mode).resize((size, size), Image.LANCZOS)

    albedo = to_linear(load('diffuse', 'RGB'))
    # AO multiplied in linear light; ^2.2 keeps the darkening of the old sRGB-space multiply.
    ao = load('ao', 'L').point([(1 - (1 - v / 255) * AO_STRENGTH) ** 2.2 for v in range(256)], 'F')
    albedo = tuple(ImageMath.lambda_eval(lambda a: a['x'] * a['ao'], x=b, ao=ao) for b in albedo)
    albedo_img = match_palette(to_srgb(albedo), target)
    normal = load('nor_gl', 'RGB')
    rough_l = load('rough', 'L')
    white = Image.new('L', (size, size), 255)
    rough = Image.merge('RGB', (white, rough_l, white))

    outs = []
    for name, img in (('albedo', albedo_img), ('normal', normal), ('rough', rough)):
        variants = [('', img)]
        if size > LOW_SIZE:
            small = downsize(img, LOW_SIZE) if name == 'albedo' else img.resize((LOW_SIZE, LOW_SIZE), Image.LANCZOS)
            variants.append((f'_{LOW_SIZE}', small))
        for suffix, im in variants:
            outs.append(save_webp(im, OUT / f'{surface}_{name}{suffix}.webp', 'color' if name == 'albedo' else 'data', match_jpeg=MATCH_JPEG))
    return outs


def linear_stats(img: Image.Image, pct: float = 0.95) -> tuple[list[float], list[float]]:
    """Per-channel linear-light mean and `pct` percentile of an sRGB image (exact, via histogram)."""
    hist = img.convert('RGB').histogram()
    means, highs = [], []
    for c in range(3):
        h = hist[c * 256 : (c + 1) * 256]
        n = sum(h)
        means.append(sum(cnt * _LINEAR[v] for v, cnt in enumerate(h)) / n)
        acc, target = 0, pct * n
        for v, cnt in enumerate(h):
            acc += cnt
            if acc >= target:
                highs.append(_LINEAR[v])
                break
    return means, highs


def stats_source(stats: dict[str, tuple[list[float], list[float]]], sizes: dict[str, int]) -> str:
    fmt = lambda xs: '[' + ', '.join(repr(round(x, 4)) for x in xs) + ']'  # noqa: E731
    lines = [
        '// Generated by tools/assets/build_textures.py - do not edit by hand.',
        '/** Linear-light albedo statistics of public/tex/<surface>_albedo.webp (per channel). */',
        'export const ALBEDO_STATS = {',
    ]
    for surface, (mean, p95) in stats.items():
        lines.append(f'  {surface}: {{ mean: {fmt(mean)}, p95: {fmt(p95)} }},')
    lines.append('} as const satisfies Record<string, { mean: readonly number[]; p95: readonly number[] }>;')
    lines.append('')
    lines.append(f'/** Low-tier texture size (px): sets above it also ship <surface>_<map>_{LOW_SIZE}.webp. */')
    lines.append(f'export const LOW_TEXTURE_SIZE = {LOW_SIZE};')
    lines.append('')
    lines.append('/** Size (px, square) of each full-resolution set. */')
    lines.append('export const TEXTURE_SIZE: Record<keyof typeof ALBEDO_STATS, number> = {')
    for surface, size in sizes.items():
        lines.append(f'  {surface}: {size},')
    lines.append('};')
    return '\n'.join(lines) + '\n'


def write_stats() -> None:
    stats = {s: linear_stats(Image.open(OUT / f'{s}_albedo.webp')) for s in SURFACES}
    sizes = {s: size for s, (_, size) in SURFACES.items()}
    STATS.write_text(stats_source(stats, sizes), encoding='utf-8', newline='\n')
    print(f'stats -> {STATS.relative_to(ROOT)}')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--raw', type=Path, default=RAW, help='raw Poly Haven textures folder')
    ap.add_argument('--stats-only', action='store_true', help='only refresh the albedo stats')
    args = ap.parse_args()
    if not args.stats_only:
        palette = read_palette(MATERIALS.read_text(encoding='utf-8'))
        OUT.mkdir(parents=True, exist_ok=True)
        total = 0
        for surface, (set_id, size) in SURFACES.items():
            for p in build(args.raw, surface, set_id, size, hex_to_linear(palette[surface])):
                total += p.stat().st_size
            print(f'{surface:10s} <- {set_id} @ {size}px, tinted to {palette[surface]}')
        print(f'total {total / 1e6:.2f} MB in {OUT.relative_to(ROOT)}')
    write_stats()


if __name__ == '__main__':
    main()
