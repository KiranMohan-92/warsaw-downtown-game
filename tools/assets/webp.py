"""WebP texture encoding shared by every asset builder (Pillow's libwebp; no extra tools).

    python tools/assets/webp.py <color|data|lossless|auto> <image> ...   # transcode next to the source

Every shipped texture is WebP (browsers decode it natively; three.js loads it like a JPEG). Kinds:

- color     albedo / emissive / sky: lossy, COLOR_QUALITY.
- data      normal, ORM/ARM, roughness: lossy, DATA_QUALITY (vectors and material parameters;
            the higher quality keeps normal-map angle error and banding down).
- lossless  exact pixels (tree impostor normals: their alpha-0 texels are flat, so lossless is
            also the smallest there).

A builder that encodes from lossless intermediates passes `match_jpeg=<the JPEG quality it used
to write>` instead: the quality is then the lowest one (>= MIN_QUALITY) whose PSNR against the
intermediate is at least that JPEG's, so a rebuild is never less faithful than the JPEG it
replaced, only smaller (surface textures: -15..-60 % at equal PSNR). Fixed qualities are for
transcoding already-lossy JPEGs, where there is no clean source to match against.

Images with alpha keep it bit-exact (alpha_quality 100 = libwebp's lossless alpha plane) and keep
the colour under fully transparent texels (`exact`), so alpha-tested leaves and the tree impostors'
coverage-preserving alpha mips (render/treeModels.ts) see the same coverage as the source PNG.
Lightmaps are 8-bit data and stay PNG (tools/bake); HDRIs stay .hdr.
"""

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

COLOR_QUALITY = 85
DATA_QUALITY = 92
MIN_QUALITY = 60
MAX_QUALITY = 95
KINDS = ('color', 'data', 'lossless')
# method 6 = libwebp's slowest, smallest encode (deterministic for a given libwebp version).
METHOD = 6


def _has_alpha(im: Image.Image) -> bool:
    return im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info)


def encode(im: Image.Image, quality: int | None) -> bytes:
    """WebP bytes: lossy at `quality`, or lossless when `quality` is None."""
    im = im.convert('RGBA' if _has_alpha(im) else 'RGB')
    opts: dict = {'method': METHOD, 'exact': True, 'alpha_quality': 100}
    if quality is None:
        opts.update(lossless=True, quality=100)
    else:
        opts['quality'] = quality
    buf = io.BytesIO()
    im.save(buf, 'WEBP', **opts)
    return buf.getvalue()


def psnr(a: Image.Image, b: Image.Image) -> float:
    """PSNR (dB) of the RGB channels; inf when identical."""
    d = np.asarray(a.convert('RGB'), np.float64) - np.asarray(b.convert('RGB'), np.float64)
    mse = float(np.mean(d * d))
    return float('inf') if mse == 0 else 10 * np.log10(255 ** 2 / mse)


def matched_quality(im: Image.Image, jpeg_quality: int, subsampling: int = 2) -> int:
    """Lowest WebP quality in [MIN_QUALITY, MAX_QUALITY] at least as faithful (PSNR) as a JPEG at
    `jpeg_quality` (`subsampling` as Pillow: 0 = 4:4:4, 2 = 4:2:0); MAX_QUALITY if none is."""
    buf = io.BytesIO()
    im.convert('RGB').save(buf, 'JPEG', quality=jpeg_quality, subsampling=subsampling)
    target = psnr(im, Image.open(io.BytesIO(buf.getvalue())))
    lo, hi = MIN_QUALITY, MAX_QUALITY
    while lo < hi:
        mid = (lo + hi) // 2
        if psnr(im, Image.open(io.BytesIO(encode(im, mid)))) >= target:
            hi = mid
        else:
            lo = mid + 1
    return lo


def save_webp(
    im: Image.Image,
    path: Path | str,
    kind: str = 'color',
    *,
    match_jpeg: int | None = None,
    subsampling: int = 2,
) -> Path:
    """Write `im` as WebP at `path` (suffix forced to .webp); returns the path written."""
    if kind not in KINDS:
        raise ValueError(f'unknown WebP kind {kind!r} (expected one of {KINDS})')
    path = Path(path).with_suffix('.webp')
    if kind == 'lossless':
        quality = None
    elif match_jpeg is not None:
        quality = matched_quality(im, match_jpeg, subsampling)
    else:
        quality = COLOR_QUALITY if kind == 'color' else DATA_QUALITY
    path.write_bytes(encode(im, quality))
    return path


def kind_for(name: str) -> str:
    """The kind a shipped texture's file name implies (normal / arm / orm / rough → data)."""
    stem = Path(name).stem
    if stem.endswith('_impostor_n'):
        return 'lossless'
    if any(tag in stem for tag in ('normal', '_arm', '_orm', '_rough')):
        return 'data'
    return 'color'


def transcode(src: Path, kind: str) -> tuple[Path, int | None]:
    """Re-encode an already-shipped JPEG/PNG as WebP next to it. When the kind's quality would come
    out bigger than the source, the quality steps down (at most TRANSCODE_STEP below it) until it
    fits; if even that is bigger (a tiny or very compressed source, or lossless), the file is still
    written but a warning names it, so the caller can keep the source instead. Returns (path,
    quality; None = lossless)."""
    with Image.open(src) as im:
        im.load()
    if kind == 'lossless':
        quality = None
        data = encode(im, None)
    else:
        top = COLOR_QUALITY if kind == 'color' else DATA_QUALITY
        limit = src.stat().st_size
        for quality in range(top, top - TRANSCODE_STEP - 1, -1):
            data = encode(im, quality)
            if len(data) <= limit:
                break
    out = src.with_suffix('.webp')
    out.write_bytes(data)
    if len(data) > src.stat().st_size:
        print(
            f'warning: {out.name} ({len(data)} B) is bigger than its source {src.name} '
            f'({src.stat().st_size} B) even at quality {quality}',
            file=sys.stderr,
        )
    return out, quality


# How far below the kind's quality a transcode may go to stay no bigger than its source.
TRANSCODE_STEP = 7


def main(argv: list[str]) -> None:
    if len(argv) < 2 or argv[0] not in KINDS + ('auto',):
        raise SystemExit(__doc__)
    for src in map(Path, argv[1:]):
        out, q = transcode(src, kind_for(src.name) if argv[0] == 'auto' else argv[0])
        print(f'{src} ({src.stat().st_size / 1024:.0f} KiB) -> {out.name} q{q or "LL"} ({out.stat().st_size / 1024:.0f} KiB)')


if __name__ == '__main__':
    main(sys.argv[1:])
