"""Trailer colour grade: a CoD Mobile-style look (clean, punchy, golden light, cool shadows).

    python tools/trailer/grade.py cube <out.cube>          # 65^3 3D LUT for ffmpeg lut3d
    python tools/trailer/grade.py gif <in.gif> <out.gif>   # grade a GIF frame by frame (exact)

The grade is one per-pixel function (`grade`), so the LUT, the GIF and stills all get the same
look. Worked in OKLab/OKLCh (perceptual hue and chroma), from the trailer's measured problems
(dusk shots: hue 20-50 deg, chroma ~0.1, red channel clipped in 25-37 % of pixels, shadows a
saturated red-brown):

- warm cast: red/salmon/pink hues are pulled halfway toward gold (OK hue 62), high chroma is
  tamed, and warm shadows are desaturated hardest, so dusk reads as golden sunlight, not salmon;
- vibrance elsewhere: low-chroma colours gain most, blues/cyans and greens a little extra;
- tone: normalised sigmoid contrast, brighter mids (gamma 0.92), a shadow lift that keeps pure
  black (letterbox bars) black, and a shoulder with slope 1 at the knee that lands white on 0.98;
  near-white highlights lose chroma (clipped orange reads clean);
- split tone: cool teal shadows, warm-gold highlights only where there is colour already, so
  neutral whites (title cards, flashes) stay white;
- gamut: chroma is scaled down per colour until it fits sRGB (no hue shift from clipping).

Video (the source is full-range BT.601, `yuvj420p`; keep it so, or the levels shift):

    VF='scale=in_range=full:out_range=full:in_color_matrix=bt601:out_color_matrix=bt601,format=gbrp,
        lut3d=grade.cube:interp=tetrahedral,
        scale=in_range=full:out_range=full:in_color_matrix=bt601:out_color_matrix=bt601,format=yuvj420p,
        unsharp=5:5:0.55:5:5:0'
    ffmpeg -i in.mp4 -vf "$VF" -c:v libx264 -preset slow -crf 16 -color_range pc -colorspace bt470bg \\
        -c:a copy -movflags +faststart out.mp4

Poster: `ffmpeg -i in.jpg -vf "format=gbrp,lut3d=grade.cube:interp=tetrahedral,unsharp=5:5:0.4:5:5:0"
-q:v 2 out.jpg`. An identity LUT through the same video chain round-trips at ~47 dB PSNR.
"""

import sys

import numpy as np

# fmt: off
P = dict(
    warm_pull=0.5, warm_target=62.0,      # pull red/salmon/pink hues toward gold (OK hue, deg)
    warm_tame=0.24, warm_shadow_tame=0.32,  # chroma cut on saturated warm colours / warm shadows
    vib=0.42, blue_boost=0.28, green_boost=0.22,
    contrast_k=3.6, gamma=0.92, lift=0.26,  # sigmoid steepness, mid brightness, shadow lift
    knee=0.6, white=0.982, hi_desat=0.5,  # shoulder start, where 1.0 lands, highlight desaturation
    cool=(-0.009, -0.015), warm=(0.004, 0.016),  # split-tone offsets in OKLab (a, b)
)
# fmt: on

# --- sRGB <-> OKLab (Björn Ottosson)
M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
               [0.2119034982, 0.6806995451, 0.1073969566],
               [0.0883024619, 0.2817188376, 0.6299787005]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
               [1.9779984951, -2.4285922050, 0.4505937099],
               [0.0259040371, 0.7827717662, -0.8086757660]])
M1i, M2i = np.linalg.inv(M1), np.linalg.inv(M2)


def s2l(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(x, 0, None)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def lin2ok(c):
    return np.cbrt(c @ M1.T) @ M2.T


def ok2lin(o):
    return ((o @ M2i.T) ** 3) @ M1i.T


def ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def hue_window(h, lo, full_lo, full_hi, hi):
    """1 for hues in [full_lo, full_hi], smooth to 0 at lo / hi (degrees, wraps at 360)."""
    d = lambda v: (v - lo) % 360  # noqa: E731
    x = d(h)
    return ss(0, d(full_lo), x) * (1 - ss(d(full_hi), d(hi), x))


def grade(x, p=P):
    """Grade Nx3 sRGB values in [0, 1]; returns Nx3 sRGB."""
    o = lin2ok(s2l(np.clip(x, 0, 1)))
    L, a, b = o[:, 0], o[:, 1], o[:, 2]
    C = np.hypot(a, b)
    h = np.degrees(np.arctan2(b, a)) % 360

    # warm cast: pull toward gold, tame chroma (warm shadows hardest)
    ww = hue_window(h, 328, 355, 48, 80)
    hu = np.where(h > 180, h - 360, h)  # unwrap so pinks (330..360) sit below red
    h = h + p["warm_pull"] * ww * ss(0.02, 0.08, C) * (p["warm_target"] - hu)
    shadow = 1 - ss(0.25, 0.62, L)
    C = C * (1 - p["warm_tame"] * ww * ss(0.03, 0.13, C))
    C = C * (1 - p["warm_shadow_tame"] * ww * shadow * ss(0.01, 0.06, C))

    # vibrance elsewhere; richer blues/cyans, livelier greens
    blue = hue_window(h, 170, 200, 270, 295)
    green = hue_window(h, 95, 115, 160, 185)
    C = C * (1 + (1 - ww) * p["vib"] * (1 - ss(0.0, 0.16, C)) * ss(0.004, 0.02, C)
             + p["blue_boost"] * blue * ss(0.01, 0.04, C) + p["green_boost"] * green)

    # tone: normalised sigmoid, brighter mids, shadow lift (black stays black), shoulder
    k = p["contrast_k"]
    sig = lambda v: 1 / (1 + np.exp(-k * (v - 0.52)))  # noqa: E731
    Lc = (sig(L) - sig(0)) / (sig(1) - sig(0))
    Lc = np.power(np.clip(Lc, 0, 1), p["gamma"])
    Lc = Lc + p["lift"] * Lc * (1 - Lc) ** 3 * ss(0.0, 0.05, L)
    # slope 1 at the knee and 1.0 -> white: c approximately solves c / tanh(c) = (1 - kn) / (W - kn)
    W, kn = p["white"], p["knee"]
    r = (1 - kn) / (W - kn)
    c = np.sqrt(3 * (r - 1)) * (1 + 0.1 * (r - 1))
    Lc = np.where(Lc > kn, kn + (W - kn) * np.tanh(c * (Lc - kn) / (1 - kn)) / np.tanh(c), Lc)
    C = C * (1 - p["hi_desat"] * ss(0.82, 1.0, L))

    # split tone: cool shadows, warm highlights where there is colour; pure black/white neutral
    sw = (1 - ss(0.08, 0.5, Lc)) * ss(0.0, 0.08, Lc)
    hw = ss(0.55, 0.9, Lc) * (1 - ss(0.93, 0.99, Lc)) * ss(0.012, 0.05, C)
    a2 = C * np.cos(np.radians(h)) + p["cool"][0] * sw + p["warm"][0] * hw
    b2 = C * np.sin(np.radians(h)) + p["cool"][1] * sw + p["warm"][1] * hw

    # gamut: largest chroma scale (binary search) that fits sRGB
    rgb = lambda s: ok2lin(np.stack([Lc, a2 * s, b2 * s], 1))  # noqa: E731
    inside = lambda v: ((v >= -1e-4) & (v <= 1 + 1e-4)).all(1)  # noqa: E731
    lo, hi = np.zeros_like(Lc), np.ones_like(Lc)
    for _ in range(14):
        m = (lo + hi) / 2
        good = inside(rgb(m))
        lo, hi = np.where(good, m, lo), np.where(good, hi, m)
    s = np.where(inside(rgb(np.ones_like(Lc))), 1.0, lo)
    return l2s(np.clip(rgb(s), 0, 1))


def write_cube(path, n=65):
    r = np.linspace(0, 1, n)
    B, G, R = np.meshgrid(r, r, r, indexing="ij")
    y = grade(np.stack([R.ravel(), G.ravel(), B.ravel()], 1))  # .cube order: red fastest
    with open(path, "w") as f:
        f.write('TITLE "Warsaw Downtown trailer grade"\nLUT_3D_SIZE %d\n' % n)
        f.writelines("%.6f %.6f %.6f\n" % tuple(v) for v in y)


def grade_gif(src, dst):
    """Grade every frame and write it back with its own exact palette (no re-dither: same framing,
    same timing; a graded frame never has more colours than the source frame)."""
    from PIL import Image, ImageSequence

    frames, durations = [], []
    for f in ImageSequence.Iterator(Image.open(src)):
        durations.append(f.info.get("duration", 80))
        rgb = np.asarray(f.convert("RGB")).reshape(-1, 3)
        colours, inv = np.unique(rgb, axis=0, return_inverse=True)
        graded = (grade(colours / 255.0) * 255 + 0.5).astype(np.uint8)
        pal, idx = np.unique(graded[inv.ravel()], axis=0, return_inverse=True)
        frame = Image.fromarray(idx.reshape(f.size[1], f.size[0]).astype(np.uint8), "P")
        full = np.zeros((256, 3), np.uint8)
        full[: len(pal)] = pal
        frame.putpalette(full.ravel().tolist())
        frames.append(frame)
    frames[0].save(dst, save_all=True, append_images=frames[1:], duration=durations, loop=0,
                   optimize=False, disposal=1)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "cube" and len(sys.argv) == 3:
        write_cube(sys.argv[2])
    elif cmd == "gif" and len(sys.argv) == 4:
        grade_gif(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__.split("\n\n")[1])
