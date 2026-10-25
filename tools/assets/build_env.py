"""Build web-ready image-based-lighting maps from the raw Poly Haven (CC0) HDRIs.

    python tools/assets/build_env.py [--raw DIR]

Reads tools/assets/raw/polyhaven/hdri/<id>_2k.hdr (Radiance RGBE, equirectangular) and writes
packages/client/public/env/<id>.hdr (512 x 256 RGBE, run-length encoded) plus manifest.json.
Pure Python + Pillow (no numpy): the RGBE reader/writer is below.

Per map:
1. Box-downsample to 512 x 256. The client's PMREM cube size is width / 4 = 128, which must match
   the procedural sky bake (sky.ts ENV_CUBE_SIZE) or swapping maps would recompile every program.
2. Remove the sun. The game lights the sun with its own shadowed DirectionalLight, and the HDRI's
   sun sits at a different elevation than the preset's (only the azimuth is matched: tilting an
   equirect tilts its horizon), so any sun left in the IBL is a second light and a second
   highlight in glossy metal, glass and wet ground. Within SUN_RADIUS of the detected sun, every
   pixel brighter than the surrounding sky is inpainted with a smooth (harmonic) fill of the sky
   around it (`remove_sun`). Elsewhere radiance above SUN_CLAMP x the upper hemisphere's median is
   scaled down to that (bright clouds and sunlit facades survive: they make the IBL directional).
3. Rotate about the vertical axis so the HDRI's sun sits at the weather preset's sun azimuth
   (weather.ts): shadows, sky glow and reflections agree.
4. Normalise so the cosine-weighted mean luminance of the upper hemisphere is 1.0. The client
   scales it to the procedural sky's brightness (environment.ts), keeping the preset tuning.

Deterministic; safe to re-run. Every output is logged in ASSETS.md.
"""

import argparse
import json
import math
import re
import statistics
from array import array
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'tools/assets/raw/polyhaven'
OUT = ROOT / 'packages/client/public/env'
WIDTH, HEIGHT = 512, 256
SUN_CLAMP = 8.0
# Sun removal (degrees): pixels within SUN_RADIUS of the detected sun and brighter than the
# surrounding sky (median luminance of the ring SUN_RADIUS..SUN_RING) are inpainted.
SUN_RADIUS = 20.0
SUN_RING = 35.0
# Neighbours darker than this x the ring level are not sky (buildings): the fill ignores them.
SKY_FLOOR = 0.5

# Poly Haven HDRI -> weather presets using it; the first preset's sun azimuth (degrees, 0 = north
# = -Z, clockwise; see weather.ts sunDirection) is where the HDRI's sun is rotated to.
# Assigned by what the images show (not the fetch-time labels): palermo_square is a clear blue
# midday sky (sun ~37 deg), dresden_square a bright hazy overcast with the sun glowing through,
# potsdamer_platz a flat grey sky. None of the fetched HDRIs is a dusk sky, so dusk keeps the
# procedural bake; hansaplatz (night) is not built: there is no night preset yet.
ENVS: dict[str, dict] = {
    # Sunny lights from the same pure sky the player sees (a city-square HDRI's dark building
    # horizon left shaded walls black); its empty lower half becomes a warm paving bounce.
    'kloofendal_48d_partly_cloudy_puresky': {
        'presets': ['sunny'],
        'azimuth': 215.0,
        'file': 'hdris/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
        'ground': (0.2, 0.185, 0.16),
    },
    'palermo_square': {'presets': [], 'azimuth': 215.0},
    'dresden_square': {'presets': ['overcast'], 'azimuth': 200.0},
    'potsdamer_platz': {'presets': ['rain'], 'azimuth': 190.0},
}
SOURCE_URL = 'https://polyhaven.com/a/{}'

Channels = tuple[list[float], list[float], list[float]]


# ---- RGBE -------------------------------------------------------------------------------------
def float_to_rgbe(r: float, g: float, b: float) -> tuple[int, int, int, int]:
    """Ward's shared-exponent encoding (floor mantissas, as Radiance does)."""
    v = max(r, g, b)
    if v < 1e-32:
        return 0, 0, 0, 0
    m, e = math.frexp(v)  # v = m * 2^e, m in [0.5, 1)
    scale = m * 256.0 / v
    if e + 128 > 255:
        return 255, 255, 255, 255
    return (
        min(255, int(r * scale)),
        min(255, int(g * scale)),
        min(255, int(b * scale)),
        e + 128,
    )


_SCALE = [0.0] + [math.ldexp(1.0, e - 136) for e in range(1, 256)]


def rgbe_to_float(r: int, g: int, b: int, e: int) -> tuple[float, float, float]:
    """Radiance's decode: (mantissa + 0.5) * 2^(e - 136)."""
    if e == 0:
        return 0.0, 0.0, 0.0
    s = _SCALE[e]
    return (r + 0.5) * s, (g + 0.5) * s, (b + 0.5) * s


def rle_encode(data: bytes) -> bytes:
    """One channel of a new-style RLE scanline: runs (>= 4 equal bytes, <= 127) and literals."""
    out = bytearray()
    n = len(data)
    i = 0
    while i < n:
        # Find the next run of >= 4 equal bytes starting at or after i.
        run_start, run_len = n, 0
        j = i
        while j < n:
            k = j + 1
            while k < n and k - j < 127 and data[k] == data[j]:
                k += 1
            if k - j >= 4:
                run_start, run_len = j, k - j
                break
            j += 1
        while i < run_start:  # literals up to the run
            cnt = min(128, run_start - i)
            out.append(cnt)
            out += data[i : i + cnt]
            i += cnt
        if run_len:
            out.append(128 + run_len)
            out.append(data[run_start])
            i = run_start + run_len
    return bytes(out)


def rle_decode(buf: bytes, pos: int, width: int) -> tuple[bytes, int]:
    """Decode one RLE channel of `width` bytes starting at `pos`; returns (bytes, new pos)."""
    out = bytearray()
    while len(out) < width:
        count = buf[pos]
        pos += 1
        if count > 128:
            out += bytes([buf[pos]]) * (count - 128)
            pos += 1
        else:
            if count == 0:
                raise ValueError('bad RLE literal length 0')
            out += buf[pos : pos + count]
            pos += count
    if len(out) != width:
        raise ValueError('RLE overrun')
    return bytes(out), pos


def read_hdr(path: Path) -> tuple[int, int, Channels]:
    """Read a Radiance .hdr file into linear float R, G, B lists."""
    return decode_hdr(path.read_bytes(), path.name)


def decode_hdr(buf: bytes, name: str = 'hdr') -> tuple[int, int, Channels]:
    """Decode Radiance RGBE bytes (-Y H +X W, RLE or flat) into linear float R, G, B lists."""
    pos = 0
    width = height = 0
    fmt_ok = False
    while True:
        end = buf.index(b'\n', pos)
        line = buf[pos:end].decode('ascii', 'replace').strip()
        pos = end + 1
        if line.startswith('FORMAT='):
            if line != 'FORMAT=32-bit_rle_rgbe':
                raise ValueError(f'{name}: unsupported {line}')
            fmt_ok = True
        parts = line.split()
        if len(parts) == 4 and parts[0] == '-Y' and parts[2] == '+X':
            height, width = int(parts[1]), int(parts[3])
            break
    if not fmt_ok or not width:
        raise ValueError(f'{name}: not an RGBE file')
    rs: list[float] = []
    gs: list[float] = []
    bs: list[float] = []
    for _ in range(height):
        if 8 <= width < 0x8000 and buf[pos] == 2 and buf[pos + 1] == 2 and not buf[pos + 2] & 0x80:
            if (buf[pos + 2] << 8 | buf[pos + 3]) != width:
                raise ValueError(f'{name}: scanline width mismatch')
            pos += 4
            chans = []
            for _c in range(4):
                ch, pos = rle_decode(buf, pos, width)
                chans.append(ch)
            r8, g8, b8, e8 = chans
        else:
            flat = buf[pos : pos + 4 * width]
            pos += 4 * width
            r8, g8, b8, e8 = flat[0::4], flat[1::4], flat[2::4], flat[3::4]
        for x in range(width):
            r, g, b = rgbe_to_float(r8[x], g8[x], b8[x], e8[x])
            rs.append(r)
            gs.append(g)
            bs.append(b)
    return width, height, (rs, gs, bs)


def write_hdr(path: Path, width: int, height: int, ch: Channels, comment: str = '') -> None:
    path.write_bytes(encode_hdr(width, height, ch, comment))


def encode_hdr(width: int, height: int, ch: Channels, comment: str = '') -> bytes:
    """Radiance RGBE bytes with new-style run-length-encoded scanlines (what three's HDRLoader reads)."""
    rs, gs, bs = ch
    out = bytearray(b'#?RADIANCE\n')
    if comment:
        out += f'# {comment}\n'.encode('ascii')
    out += f'FORMAT=32-bit_rle_rgbe\n\n-Y {height} +X {width}\n'.encode('ascii')
    for y in range(height):
        r8, g8, b8, e8 = bytearray(), bytearray(), bytearray(), bytearray()
        for x in range(y * width, (y + 1) * width):
            r, g, b, e = float_to_rgbe(rs[x], gs[x], bs[x])
            r8.append(r)
            g8.append(g)
            b8.append(b)
            e8.append(e)
        out += bytes([2, 2, width >> 8, width & 255])
        for c in (r8, g8, b8, e8):
            out += rle_encode(bytes(c))
    return bytes(out)


# ---- image ops (row 0 = top = zenith; column u = x / W; three.js equirect convention) -----------
def luminance(r: float, g: float, b: float) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def downsample(width: int, height: int, ch: Channels, w: int, h: int) -> Channels:
    """Area (box) filter per channel via Pillow float images: radiance is averaged, not picked."""
    out = []
    for c in ch:
        im = Image.frombytes('F', (width, height), array('f', c).tobytes())
        out.append(list(array('f', im.resize((w, h), Image.BOX).tobytes())))
    return out[0], out[1], out[2]


def elevation_of_row(y: int, h: int) -> float:
    """Elevation (radians) of the centre of row y."""
    return (0.5 - (y + 0.5) / h) * math.pi


def upper_mean_luminance(w: int, h: int, ch: Channels) -> float:
    """Cosine-weighted mean luminance of the upper hemisphere: irradiance on an up-facing surface
    divided by pi (a uniform sky of radiance L gives L)."""
    rs, gs, bs = ch
    total = 0.0
    d_phi = math.pi / h
    d_lam = 2 * math.pi / w
    for y in range(h // 2):
        el = elevation_of_row(y, h)
        wgt = math.sin(el) * math.cos(el) * d_phi * d_lam
        row = 0.0
        for x in range(y * w, (y + 1) * w):
            row += luminance(rs[x], gs[x], bs[x])
        total += row * wgt
    return total / math.pi


def azimuth_of_column(x: float, w: int) -> float:
    """Game azimuth (deg, 0 = north/-Z, clockwise) of column x. three.js equirectUv puts direction
    d at u = atan2(d.z, d.x) / 2pi + 0.5; the game's sun (sin az, _, -cos az) lands at
    u = az / 360 + 0.25."""
    u = (x + 0.5) / w
    return ((u - 0.25) * 360.0) % 360.0


def find_sun(w: int, h: int, ch: Channels) -> tuple[int, int]:
    """(x, y) of the brightest upper-hemisphere pixel."""
    rs, gs, bs = ch
    best, bx, by = -1.0, 0, 0
    for y in range(h // 2):
        for x in range(w):
            i = y * w + x
            lum = luminance(rs[i], gs[i], bs[i])
            if lum > best:
                best, bx, by = lum, x, y
    return bx, by


def clamp_sun(w: int, h: int, ch: Channels, factor: float = SUN_CLAMP) -> tuple[Channels, float]:
    """Scale down radiance brighter than factor x the upper hemisphere's median luminance."""
    rs, gs, bs = ch
    upper = [luminance(rs[i], gs[i], bs[i]) for i in range(w * (h // 2))]
    limit = factor * statistics.median(upper)
    out_r, out_g, out_b = list(rs), list(gs), list(bs)
    for i in range(w * h):
        lum = luminance(rs[i], gs[i], bs[i])
        if lum > limit:
            k = limit / lum
            out_r[i] *= k
            out_g[i] *= k
            out_b[i] *= k
    return (out_r, out_g, out_b), limit


def direction(x: float, y: float, w: int, h: int) -> tuple[float, float, float]:
    """Unit direction of pixel (x, y) (any fixed longitude origin: only angles between pixels
    are used)."""
    el = elevation_of_row(y, h)
    lon = (x + 0.5) / w * 2 * math.pi
    return math.cos(el) * math.cos(lon), math.sin(el), math.cos(el) * math.sin(lon)


def angle_deg(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))))


def remove_sun(w: int, h: int, ch: Channels, sun: tuple[int, int], iters: int = 400) -> tuple[Channels, float]:
    """Inpaint the sun: every pixel within SUN_RADIUS of `sun` brighter than the surrounding sky
    (median luminance of the ring out to SUN_RING) is replaced by a smooth (harmonic) fill of its
    unmasked neighbours: the sky, clouds and rooftops around it. No pixel of the fill is brighter
    than the brightest of those, so the sun direction is no longer a peak. Returns the level."""
    rs, gs, bs = ch
    sd = direction(sun[0], sun[1], w, h)
    ang = [angle_deg(direction(x, y, w, h), sd) for y in range(h) for x in range(w)]
    ring = [i for i in range(w * (h // 2)) if SUN_RADIUS <= ang[i] < SUN_RING]
    if not ring:
        return ch, 0.0
    level = statistics.median(luminance(rs[i], gs[i], bs[i]) for i in ring)
    mask = [i for i in range(w * h) if ang[i] < SUN_RADIUS and luminance(rs[i], gs[i], bs[i]) > level]
    out = [list(rs), list(gs), list(bs)]
    if not mask:
        return (out[0], out[1], out[2]), level
    masked = set(mask)
    for c in out:  # start from the ring level, then relax (Jacobi) towards the harmonic fill
        for i in mask:
            c[i] = level * c[i] / max(luminance(rs[i], gs[i], bs[i]), 1e-12)
    # Fill from the sky only: a dark neighbour (a rooftop, a tower) is an insulating edge (the
    # pixel stands in for it), so buildings do not bleed a dark smudge into the sky.
    def sky(j: int) -> bool:
        return j in masked or luminance(rs[j], gs[j], bs[j]) >= SKY_FLOOR * level

    nbrs = []
    for i in mask:
        x, y = i % w, i // w
        around = (
            y * w + (x - 1) % w,
            y * w + (x + 1) % w,
            max(y - 1, 0) * w + x,
            min(y + 1, h - 1) * w + x,
        )
        nbrs.append(tuple(j if sky(j) else i for j in around))
    for _ in range(iters):
        for c in out:
            new = [(c[a] + c[b] + c[d] + c[e]) * 0.25 for a, b, d, e in nbrs]
            for i, v in zip(mask, new):
                c[i] = v
    return (out[0], out[1], out[2]), level


def rotate(w: int, h: int, ch: Channels, shift: int) -> Channels:
    """Shift columns right by `shift` (increases azimuth by shift * 360 / w degrees)."""
    shift %= w
    out = []
    for c in ch:
        rot: list[float] = []
        for y in range(h):
            row = c[y * w : (y + 1) * w]
            rot += row[w - shift :] + row[: w - shift]
        out.append(rot)
    return out[0], out[1], out[2]


def scale(ch: Channels, k: float) -> Channels:
    return [v * k for v in ch[0]], [v * k for v in ch[1]], [v * k for v in ch[2]]


def process(width: int, height: int, ch: Channels, target_azimuth: float) -> tuple[Channels, dict]:
    small = downsample(width, height, ch, WIDTH, HEIGHT)
    sx, sy = find_sun(WIDTH, HEIGHT, small)
    src_az = azimuth_of_column(sx, WIDTH)
    sun_el = math.degrees(elevation_of_row(sy, HEIGHT))
    inpainted, level = remove_sun(WIDTH, HEIGHT, small, (sx, sy))
    clamped, limit = clamp_sun(WIDTH, HEIGHT, inpainted)
    shift = round((target_azimuth - src_az) / 360.0 * WIDTH)
    rotated = rotate(WIDTH, HEIGHT, clamped, shift)
    mean = upper_mean_luminance(WIDTH, HEIGHT, rotated)
    out = scale(rotated, 1.0 / mean)
    info = {
        'sourceSunAzimuth': round(src_az, 1),
        'sunAzimuth': round(azimuth_of_column((sx + shift) % WIDTH, WIDTH), 1),
        'sunElevation': round(sun_el, 1),
        'sunClampRelative': round(limit / mean, 3),
        'sunRegionRelative': round(level / mean, 3),
        'sourceUpperMean': round(mean, 5),
    }
    return out, info


def manifest_text(entries: dict[str, dict]) -> str:
    """JSON laid out the way prettier formats it (format:check covers public/)."""
    text = json.dumps(entries, indent=2)
    # prettier keeps short arrays on one line
    text = re.sub(
        r'\[\s+("[^"]*"(?:,\s+"[^"]*")*)\s+\]',
        lambda m: '[' + re.sub(r',\s+', ', ', m.group(1)) + ']',
        text,
    )
    return text + '\n'


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--raw', type=Path, default=RAW, help='raw Poly Haven folder')
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}
    for env_id, cfg in ENVS.items():
        if not cfg['presets']:
            continue  # kept for reference, lights no preset
        src = args.raw / cfg.get('file', f'hdri/{env_id}_2k.hdr')
        if not src.exists():
            raise SystemExit(f'missing {src} (run fetch_polyhaven.py)')
        w, h, ch = read_hdr(src)
        if 'ground' in cfg:
            # Lower hemisphere: a flat warm bounce at the sky's own lower-half brightness.
            lower = range((h // 2) * w, h * w)
            mean = sum(luminance(ch[0][i], ch[1][i], ch[2][i]) for i in lower) / len(lower)
            g = cfg['ground']
            k = mean / luminance(*g)
            for i in lower:
                ch[0][i], ch[1][i], ch[2][i] = g[0] * k, g[1] * k, g[2] * k
        out, info = process(w, h, ch, cfg['azimuth'])
        dst = OUT / f'{env_id}.hdr'
        write_hdr(dst, WIDTH, HEIGHT, out, f'{env_id} (Poly Haven, CC0) via tools/assets/build_env.py')
        manifest[env_id] = {
            'file': dst.name,
            'source': SOURCE_URL.format(env_id),
            'license': 'CC0 1.0',
            'width': WIDTH,
            'height': HEIGHT,
            'presets': cfg['presets'],
            **info,
        }
        print(f'{env_id:16s} {dst.stat().st_size / 1e3:6.0f} kB  sun {info["sourceSunAzimuth"]:5.1f}'
              f' -> {info["sunAzimuth"]:5.1f} deg, el {info["sunElevation"]:4.1f}')
    # LF endings (prettier's format:check covers public/; Windows would write CRLF).
    (OUT / 'manifest.json').write_text(manifest_text(manifest), encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
