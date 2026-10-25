"""Build the seax-style combat knife (original design; Blender + system Python).

    blender -b --python tools/assets/build_knife.py -- model    # hi + low meshes, UVs, bakes
    python tools/assets/build_knife.py tex                      # heal sources, compose the maps
    python tools/assets/build_knife.py package                  # glTF + WebP -> models/knife
    blender -b --python tools/assets/build_knife.py -- render   # beauty renders for review

A single-edged broken-back blade (21 cm) of pattern-welded steel with an etched knotwork band
along the spine, a plain hardened edge with a polished micro-bevel, an aged bronze guard and
pommel cap, and a dark leather wrap bound with brass wire (helix in the wrap's step + two wire
collars). Ornament only: no text, runes, symbols or emblems.

Knife space (= the glTF's own space): grip origin at the centre of the fist, blade along -Z, edge
down (-Y), spine up (+Y), flats facing +-X. Metres. Anchors (glTF nodes, also in knife.json):
`knife_grip` (origin), `knife_tip`, `knife_edge` (a point on the edge toward the guard: the
trail ribbon runs tip -> edge), `knife_guard`, `knife_pommel`.

The geometry is analytic (this file's pure functions, shared by both stages and the tests): the
low-poly game mesh and the hi-poly bake source come from the same profile functions at different
resolutions; the hi-poly adds the fillets, the leather wrap's overlapping strap steps, the brass
wire (helix + collar coils), the guard grooves and the pommel's peened tang. Low-poly UVs are laid
out explicitly (blade flats planar along the blade, spine strip, revolve strips + planar caps) on
one 2048 atlas at ~9 px/mm. Bakes (Cycles, CPU): tangent normal + AO from the hi-poly, and the
low-poly's own object-space position + part/zone id, which the `tex` stage reads to compose
albedo / roughness / metallic / normal detail per texel from the healed sources.

Intermediates (.blend, bakes, 2k maps) go to WD_KNIFE_BUILD (default tools/assets/build/knife,
git-ignored); sources are read from WD_KNIFE_SRC (the four Codex image_generation PNGs: Kiran's
account, 2026-10-01; prompts in KNIFE_PROMPTS below).
"""

# Annotations stay unevaluated (Blender-only types).
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

try:
    import bpy
    import bmesh
except ImportError:  # tex stage / tests (system Python)
    bpy = None

ROOT = Path(__file__).resolve().parents[2]
BUILD = Path(os.environ.get('WD_KNIFE_BUILD', ROOT / 'tools/assets/build/knife'))
SRC = Path(os.environ.get('WD_KNIFE_SRC', BUILD / 'src'))
OUT = ROOT / 'packages/client/public/models/knife'
REVIEW = Path(os.environ.get('WD_KNIFE_REVIEW', BUILD / 'review'))

KNIFE_PROMPTS = {
    'damascus_steel_albedo': 'polished pattern-welded Damascus steel blade surface, flowing wavy '
    'folded-steel grain in light and dark grey layers, subtle satin polish, fine use scratches',
    'knotwork_etch_mask': 'a single horizontal band of early-medieval interlaced knotwork ornament '
    '(Celtic or Norse style interlace, no animals, no letters, no runes, no symbols), pure black '
    'lines on a pure white background, crisp, high contrast, centered, the band filling the image '
    'width',
    'leather_grip_albedo': 'dark brown oiled leather tightly wrapped around a knife grip, seen '
    'flat, diagonal wrap seams, worn and darkened by hands, fine grain',
    'bronze_patina_albedo': 'aged cast bronze with green-brown patina in the recesses and polished '
    'warm bronze on worn high points, fine pitting',
}

TEX = 2048
"""Bake / compose resolution (shipped at 1024, Low tier 512)."""
D = 9000.0
"""Atlas texel density at TEX (px per metre)."""

# ---------------------------------------------------------------------------------------------
# Dimensions (knife space, metres)

GUARD_FRONT = -0.066
GUARD_BACK = -0.055
BLADE_LEN = 0.210
"""Guard face to tip."""
BREAK_S = 0.158
"""Where the spine breaks (distance from the guard face)."""
TIP_Y = -0.006
SPINE_BREAK = 0.0200
"""Spine height at the break (the blade's deepest point)."""
CLIP_DEG = math.degrees(math.atan((SPINE_BREAK - TIP_Y) / (BLADE_LEN - BREAK_S)))
"""Seax clip: the spine's drop from the break to the tip (deg)."""
TANG_S = -0.006
"""The blade mesh starts this far inside the guard (hides the joint)."""
LEATHER_Z = (-0.0490, 0.0440)
COLLAR_G = (-0.0558, -0.0486)
COLLAR_P = (0.0436, 0.0508)
POMMEL_Z0 = 0.0500
WRAP_PITCH = 0.0110
"""Axial advance of the leather strap per turn (= the strap's axial width)."""
WRAP_T = 0.0007
"""Leather strap thickness (relief of the overlapping wrap)."""
WIRE_R = 0.00048
COIL_R = 0.00062
COLLAR_LIFT = 0.0009


def clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def smoothstep(e0: float, e1: float, x: float) -> float:
    t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smin(a: float, b: float, k: float) -> float:
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k / 4


def z_of(s: float) -> float:
    return GUARD_FRONT - s


def s_of(z: float) -> float:
    return GUARD_FRONT - z


def spine_y(s: float) -> float:
    """Spine height: rises to the break, then a straight seax clip (~27 deg) down to the tip."""
    s = max(s, 0.0)
    rise = 0.0125 + (SPINE_BREAK - 0.0125) * s / BREAK_S
    clip = SPINE_BREAK + (s - BREAK_S) * (TIP_Y - SPINE_BREAK) / (BLADE_LEN - BREAK_S)
    return smin(rise, clip, 0.0008)


def edge_y(s: float) -> float:
    """Edge line: a slight belly, sweeping up into the tip over the last 7.5 cm."""
    s = max(s, 0.0)
    if s <= 0.135:
        return -0.0125 - 0.0015 * s / 0.135
    u = (s - 0.135) / (BLADE_LEN - 0.135)
    return -0.0140 + (TIP_Y + 0.0140) * u**2.0


def thickness(s: float) -> float:
    """Spine thickness (distal taper)."""
    s = max(s, 0.0)
    if s <= BREAK_S:
        return 0.0056 - 0.0022 * s / BREAK_S
    return lerp(0.0034, 0.0009, (s - BREAK_S) / (BLADE_LEN - BREAK_S))


def bevel_frac(s: float) -> float:
    """Height of the grind line above the edge, as a fraction of the blade height."""
    return lerp(0.08, 0.44, smoothstep(0.003, 0.014, s))


def blade_section(s: float) -> list[tuple[float, float]]:
    """Low-poly cross-section (x, y), loop: apex, shoulder R, grind R, spine R, spine L, grind L,
    shoulder L. Flats near-parallel, Scandi grind to a 0.6 mm polished micro-bevel."""
    sp, ed, t = spine_y(s), edge_y(s), thickness(s)
    h = sp - ed
    ramp = smoothstep(0.003, 0.014, s)
    y_bv = ed + bevel_frac(s) * h
    hw_bv = 0.46 * t
    h_sh = min(0.0006, 0.25 * h)
    hw_sh = lerp(0.40 * t, 0.00022, ramp)
    return [
        (0.0, ed),
        (hw_sh, ed + h_sh),
        (hw_bv, y_bv),
        (t / 2, sp),
        (-t / 2, sp),
        (-hw_bv, y_bv),
        (-hw_sh, ed + h_sh),
    ]


BLADE_ZONES = (13, 12, 11, 14, 11, 12, 13)
"""Zone of the face after each section vertex: 11 flat, 12 grind, 13 micro-bevel, 14 spine."""
BLADE_SIDE = (1, 1, 1, 0, -1, -1, -1)

LOW_S = [
    TANG_S, 0.0, 0.004, 0.009, 0.015, 0.025, 0.04, 0.06, 0.08, 0.10, 0.12, 0.135, 0.146,
    0.152, 0.1555, 0.158, 0.1605, 0.164, 0.170, 0.177, 0.184, 0.190, 0.195, 0.199, 0.2025,
    0.2055, 0.2078,
]
"""Low-poly blade sections (s), dense at the break and toward the tip; then the tip vertex."""

ANCHORS = {
    'knife_grip': (0.0, 0.0, 0.0),
    'knife_tip': (0.0, TIP_Y, z_of(BLADE_LEN)),
    'knife_edge': (0.0, edge_y(0.09), z_of(0.09)),
    'knife_guard': (0.0, 0.0, GUARD_FRONT),
}

# ---------------------------------------------------------------------------------------------
# Revolve shapes (superellipse rings)


def grip_ab(z: float) -> tuple[float, float]:
    """Grip half-width (x) and half-height (y): an oval, slightly swelled behind the middle."""
    u = (z - LEATHER_Z[0]) / (LEATHER_Z[1] - LEATHER_Z[0])
    bump = math.sin(math.pi * clamp01(u)) ** 1.5 * (0.6 + 0.4 * u)
    return 0.0094 + 0.0011 * bump, 0.0113 + 0.0012 * bump


def ring_point(phi: float, ax: float, by: float, n: float = 2.0, cy: float = 0.0, lobe=0.0):
    """Superellipse point; lobe > 0 swells it at top/bottom/sides (quatrefoil guard)."""
    c, s = math.cos(phi), math.sin(phi)
    e = 2.0 / n
    f = 1.0 + lobe * math.cos(4 * phi)
    return (f * ax * math.copysign(abs(c) ** e, c), cy + f * by * math.copysign(abs(s) ** e, s))


def ring_normal(phi: float, ax: float, by: float, n: float = 2.0, lobe=0.0):
    """Outward 2D normal of the superellipse at parameter phi (numeric)."""
    h = 1e-4
    x0, y0 = ring_point(phi - h, ax, by, n, 0.0, lobe)
    x1, y1 = ring_point(phi + h, ax, by, n, 0.0, lobe)
    tx, ty = x1 - x0, y1 - y0
    ln = math.hypot(tx, ty) or 1.0
    return ty / ln, -tx / ln


def perimeter(ax: float, by: float, n: float = 2.0, k: int = 720, lobe=0.0) -> float:
    pts = [ring_point(2 * math.pi * i / k, ax, by, n, 0.0, lobe) for i in range(k + 1)]
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(k))


GUARD = {'ax': 0.0122, 'by': 0.0190, 'cy': -0.002, 'n': 2.2, 'lobe': 0.075}


def guard_profile(hi: bool) -> list[tuple[float, float]]:
    """(z, scale) of the guard rim, front (blade side) to back."""
    if not hi:
        return [
            (GUARD_FRONT, 0.90),
            (GUARD_FRONT + 0.0011, 1.0),
            (0.5 * (GUARD_FRONT + GUARD_BACK), 1.03),
            (GUARD_BACK - 0.0011, 1.0),
            (GUARD_BACK, 0.92),
        ]
    out = []
    n = 72
    for i in range(n + 1):
        z = lerp(GUARD_FRONT, GUARD_BACK, i / n)
        u = (z - GUARD_FRONT) / (GUARD_BACK - GUARD_FRONT)
        k = 1.0 + 0.03 * math.sin(math.pi * u)
        # Rounded chamfers at both faces.
        for zf, k0 in ((GUARD_FRONT, 0.90), (GUARD_BACK, 0.92)):
            d = abs(z - zf) / 0.0012
            if d < 1:
                k = lerp(k0, k, math.sqrt(1 - (1 - d) ** 2))
        # Two incised grooves around the rim.
        for zg in (GUARD_FRONT + 0.0034, GUARD_BACK - 0.0034):
            k -= 0.022 * math.exp(-(((z - zg) / 0.00028) ** 2))
        out.append((z, k))
    return out


POMMEL_LOW = [
    (COLLAR_P[1] - 0.0002, 1.07),
    (POMMEL_Z0 + 0.0006, 1.13),
    (POMMEL_Z0 + 0.0052, 1.13),
    (POMMEL_Z0 + 0.0062, 1.19),
    (POMMEL_Z0 + 0.0080, 1.18),
    (POMMEL_Z0 + 0.0105, 1.10),
    (POMMEL_Z0 + 0.0130, 0.95),
    (POMMEL_Z0 + 0.0152, 0.72),
    (POMMEL_Z0 + 0.0166, 0.45),
    (POMMEL_Z0 + 0.0174, 0.20),
]
"""(z, scale of the grip-end oval) of the pommel cap: ferrule collar, bead, dome."""
NUB_R = 0.0026
NUB_LOW = [(POMMEL_Z0 + 0.0170, 1.0), (POMMEL_Z0 + 0.0190, 1.0), (POMMEL_Z0 + 0.0198, 0.85)]
"""Peened tang (z, scale of NUB_R), capped."""
ANCHORS['knife_pommel'] = (0.0, 0.0, NUB_LOW[-1][0])
POMMEL_AB = (grip_ab(LEATHER_Z[1])[0] + 0.0003, grip_ab(LEATHER_Z[1])[1] + 0.0003)


def catmull(points: list[tuple[float, float]], per: int) -> list[tuple[float, float]]:
    """Dense Catmull-Rom resampling of a profile (keeps the end points)."""
    out = []
    p = [points[0], *points, points[-1]]
    for i in range(1, len(p) - 2):
        for j in range(per):
            t = j / per
            out.append(
                tuple(
                    0.5
                    * (
                        2 * p[i][k]
                        + (-p[i - 1][k] + p[i + 1][k]) * t
                        + (2 * p[i - 1][k] - 5 * p[i][k] + 4 * p[i + 1][k] - p[i + 2][k]) * t * t
                        + (-p[i - 1][k] + 3 * p[i][k] - 3 * p[i + 1][k] + p[i + 2][k]) * t**3
                    )
                    for k in range(2)
                )
            )
    out.append(points[-1])
    return out


# ---------------------------------------------------------------------------------------------
# Mesh assembly


class Mesh:
    """Triangles/quads in knife space; low-poly faces carry pixel UVs (per corner) and a part id."""

    def __init__(self) -> None:
        self.v: list[tuple[float, float, float]] = []
        self.f: list[tuple[int, ...]] = []
        self.uv: list[tuple[tuple[float, float], ...] | None] = []
        self.part: list[int] = []
        self.sharp: set[tuple[int, int]] = set()

    def add_v(self, p) -> int:
        self.v.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.v) - 1

    def add_f(self, idx, uv=None, part=0) -> None:
        self.f.append(tuple(idx))
        self.uv.append(tuple(uv) if uv else None)
        self.part.append(part)

    def triangles(self) -> int:
        return sum(len(f) - 2 for f in self.f)

    def extend(self, other: Mesh) -> None:
        o = len(self.v)
        self.v += other.v
        self.f += [tuple(i + o for i in f) for f in other.f]
        self.uv += other.uv
        self.part += other.part
        self.sharp |= {(a + o, b + o) for a, b in other.sharp}


# Atlas layout (pixels at TEX, Blender convention: v up from the bottom).
UV = {
    'blade_r': (40, 24),
    'blade_l': (40, 350),
    'spine': (40, 710),
    'grip': (40, 752),
    'collar_g': (740, 752),
    'collar_p': (740, 850),
    'guard_rim': (740, 950),
    'guard_front': (870, 1290),
    'guard_back': (1120, 1290),
    'pommel': (1270, 1100),
    'pommel_cap': (1400, 1400),
    'nub': (1600, 1250),
    'nub_cap': (1700, 1350),
}


def blade_uv(x: float, y: float, z: float, side: int) -> tuple[float, float]:
    u = UV['blade_r'][0] + (z_of(TANG_S) - z) * D
    if side == 0:
        return (u, UV['spine'][1] + x * D)
    v0 = UV['blade_r'][1] if side > 0 else UV['blade_l'][1]
    return (u, v0 + (y + 0.0140) * D)


def build_blade(hi: bool) -> Mesh:
    m = Mesh()
    if hi:
        ss = [TANG_S + i * 0.0004 for i in range(int((BLADE_LEN - 0.0004 - TANG_S) / 0.0004) + 1)]
    else:
        ss = LOW_S
    rings = []
    for s in ss:
        sec = blade_section(s)
        if hi:
            sec = fillet_loop(sec, hi_fillets(s))
        z = z_of(s)
        rings.append([m.add_v((x, y, z)) for x, y in sec])
    tip = m.add_v(ANCHORS['knife_tip'])
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for j in range(n):
            k = (j + 1) % n
            quad = (a[j], b[j], b[k], a[k])
            if hi:
                m.add_f(quad)
                continue
            side = BLADE_SIDE[j]
            uv = [blade_uv(*m.v[i], side) for i in quad]
            m.add_f(quad, uv, BLADE_ZONES[j])
    last = rings[-1]
    for j in range(n):
        k = (j + 1) % n
        tri = (last[j], tip, last[k])
        if hi:
            m.add_f(tri)
        else:
            m.add_f(tri, [blade_uv(*m.v[i], BLADE_SIDE[j]) for i in tri], BLADE_ZONES[j])
    if not hi:
        # Every longitudinal crease is a hard edge (flats, grind line, micro-bevel, spine).
        for a, b in zip(rings, rings[1:]):
            for j in range(n):
                m.sharp.add((a[j], b[j]))
        for j in range(n):
            m.sharp.add((last[j], tip))
    return m


def hi_fillets(s: float) -> list[float]:
    t = thickness(s)
    return [0.00004, 0.00008, 0.0002, min(0.00045, 0.3 * t), min(0.00045, 0.3 * t), 0.0002, 0.00008]


def fillet_loop(pts: list[tuple[float, float]], radii: list[float], k: int = 5):
    """Round each corner of a closed 2D polygon with an arc of k points."""
    out = []
    n = len(pts)
    for i in range(n):
        p, a, b = pts[i], pts[i - 1], pts[(i + 1) % n]
        ua = (a[0] - p[0], a[1] - p[1])
        ub = (b[0] - p[0], b[1] - p[1])
        la, lb = math.hypot(*ua), math.hypot(*ub)
        if la < 1e-9 or lb < 1e-9:
            out += [p] * k  # same count on every ring
            continue
        ua = (ua[0] / la, ua[1] / la)
        ub = (ub[0] / lb, ub[1] / lb)
        cosang = max(-1.0, min(1.0, ua[0] * ub[0] + ua[1] * ub[1]))
        half = max(math.acos(cosang) / 2, 1e-3)
        d = max(min(radii[i] / math.tan(half), 0.45 * la, 0.45 * lb), 1e-7)
        p0 = (p[0] + ua[0] * d, p[1] + ua[1] * d)
        p1 = (p[0] + ub[0] * d, p[1] + ub[1] * d)
        # Quadratic Bezier through the corner (close to an arc, stays inside the corner).
        for j in range(k):
            t = j / (k - 1)
            out.append(
                tuple(
                    (1 - t) ** 2 * p0[c] + 2 * (1 - t) * t * p[c] + t * t * p1[c] for c in range(2)
                )
            )
    return out


def revolve(
    profile: list[tuple[float, float]],
    shape,
    segs: int,
    part: int = 0,
    uv: tuple[str, str | None] | None = None,
    cap: str | None = None,
    disp=None,
) -> Mesh:
    """Rings of a superellipse along z. profile = [(z, scale)]; shape(z, scale) -> (ax, by, n, cy).
    uv = (strip island, cap island or None): bands steeper than 50 deg go planar to the cap
    island. cap = 'start' / 'end' / 'both': fan to the centre. disp(phi, z) -> radial offset."""
    m = Mesh()
    rings = []
    params = []
    for z, k in profile:
        sh = shape(z, k)
        ax, by, n, cy = sh[:4]
        lobe = sh[4] if len(sh) > 4 else 0.0
        params.append((ax, by, n, cy, lobe))
        ring = []
        for i in range(segs):
            phi = -math.pi / 2 + 2 * math.pi * i / segs
            x, y = ring_point(phi, ax, by, n, cy, lobe)
            if disp:
                nx, ny = ring_normal(phi, ax, by, n, lobe)
                d = disp(phi, z)
                x, y = x + nx * d, y + ny * d
            ring.append(m.add_v((x, y, z)))
        rings.append(ring)
    if uv:
        strip, capi = uv[0], uv[1]
        cref = max(perimeter(ax, by, n, lobe=lb) for ax, by, n, _, lb in params)
        cum = [0.0]
        steep = []
        for (z0, k0), (z1, k1), p0, p1 in zip(profile, profile[1:], params, params[1:]):
            dr = abs(max(p1[0], p1[1]) - max(p0[0], p0[1]))
            dz = abs(z1 - z0)
            st = capi is not None and dr > 1.2 * dz
            steep.append(st)
            cum.append(cum[-1] + (0 if st else math.hypot(dr, dz)))
    for b in range(len(rings) - 1):
        r0, r1 = rings[b], rings[b + 1]
        for i in range(segs):
            j = (i + 1) % segs
            quad = (r0[i], r0[j], r1[j], r1[i])
            if not uv:
                m.add_f(quad)
                continue
            if steep[b]:
                # Nearer end's cap island (the guard's back chamfer maps beside its back face).
                cu, cv = UV[uv[1] if b < (len(rings) - 1) / 2 or len(uv) < 3 else uv[2]]
                cyb = params[b][3]
                fuv = [(cu + m.v[q][0] * D, cv + (m.v[q][1] - cyb) * D) for q in quad]
            else:
                u0, v0 = UV[strip]
                us = [u0 + (i / segs) * cref * D, u0 + ((i + 1) / segs) * cref * D]
                fuv = [
                    (us[0], v0 + cum[b] * D),
                    (us[1], v0 + cum[b] * D),
                    (us[1], v0 + cum[b + 1] * D),
                    (us[0], v0 + cum[b + 1] * D),
                ]
            m.add_f(quad, fuv, part)
    ends = []
    if cap in ('start', 'both'):
        ends.append((0, True))
    if cap in ('end', 'both'):
        ends.append((len(rings) - 1, False))
    for ri, rev in ends:
        z = profile[ri][0]
        cy = params[ri][3]
        c = m.add_v((0.0, cy, z))
        ring = rings[ri]
        for i in range(segs):
            j = (i + 1) % segs
            tri = (c, ring[j], ring[i]) if rev else (c, ring[i], ring[j])
            if uv:
                capn = uv[1] if rev or len(uv) < 3 else uv[2]
                cu, cv = UV[capn]
                fuv = [(cu + m.v[q][0] * D, cv + (m.v[q][1] - cy) * D) for q in tri]
                m.add_f(tri, fuv, part)
            else:
                m.add_f(tri)
    return m


def oval_shape(ab):
    return lambda z, k: (ab[0] * k, ab[1] * k, 2.0, 0.0)


def grip_shape(lift: float = 0.0):
    def f(z, k):
        a, b = grip_ab(min(max(z, LEATHER_Z[0]), LEATHER_Z[1]))
        return a + lift * k, b + lift * k, 2.0, 0.0

    return f


def guard_shape(z, k):
    return GUARD['ax'] * k, GUARD['by'] * k, GUARD['n'], GUARD['cy'], GUARD['lobe']


def wrap_frac(phi: float, z: float) -> float:
    """Position across the leather strap (0 at the step where the wire lies, rising to 1)."""
    return ((z - LEATHER_Z[0]) / WRAP_PITCH - (phi + math.pi / 2) / (2 * math.pi)) % 1.0


def leather_height(phi: float, z: float) -> float:
    """Overlapping-wrap relief: each turn rides up over the previous one, then drops at its edge."""
    if not (LEATHER_Z[0] - 0.0005 < z < LEATHER_Z[1] + 0.0005):
        return 0.0
    f = wrap_frac(phi, z)
    rise = 0.25 + 0.75 * smoothstep(0.0, 0.9, f)
    drop = smoothstep(1.0, 0.94, f)  # rounded strap edge
    edge = min(1.0, (z - LEATHER_Z[0]) / 0.0006, (LEATHER_Z[1] - z) / 0.0006)
    return WRAP_T * rise * drop * max(edge, 0.0)


def low_mesh() -> Mesh:
    m = build_blade(False)
    leather = [(lerp(LEATHER_Z[0] - 0.0004, LEATHER_Z[1] + 0.0004, i / 6), 1.0) for i in range(7)]
    m.extend(revolve(leather, grip_shape(WRAP_T * 0.55), 24, 20, ('grip', None)))
    for name, (z0, z1) in (('collar_g', COLLAR_G), ('collar_p', COLLAR_P)):
        prof = [(z0, 0.2), (z0 + 0.0006, 1.0), (z1 - 0.0006, 1.0), (z1, 0.2)]
        m.extend(revolve(prof, grip_shape(COLLAR_LIFT), 24, 30, (name, None)))
    m.extend(
        revolve(
            guard_profile(False), guard_shape, 28, 40, ('guard_rim', 'guard_front', 'guard_back'),
            cap='both',
        )
    )
    m.extend(revolve(POMMEL_LOW, oval_shape(POMMEL_AB), 24, 50, ('pommel', 'pommel_cap')))
    m.extend(
        revolve(
            NUB_LOW, lambda z, k: (NUB_R * k, NUB_R * k, 2.0, 0.0), 12, 50, ('nub', 'nub_cap'),
            cap='end',
        )
    )
    return m


def tube(path: list[tuple[float, float, float]], normals, radius: float, sides: int) -> Mesh:
    """Sweep a circle along a path; normals = the frame's 'out' direction per point."""
    m = Mesh()
    rings = []
    for i, p in enumerate(path):
        a = path[max(i - 1, 0)]
        b = path[min(i + 1, len(path) - 1)]
        t = [b[k] - a[k] for k in range(3)]
        lt = math.sqrt(sum(c * c for c in t)) or 1.0
        t = [c / lt for c in t]
        o = normals[i]
        dot = sum(o[k] * t[k] for k in range(3))
        o = [o[k] - dot * t[k] for k in range(3)]
        lo = math.sqrt(sum(c * c for c in o)) or 1.0
        o = [c / lo for c in o]
        w = [t[1] * o[2] - t[2] * o[1], t[2] * o[0] - t[0] * o[2], t[0] * o[1] - t[1] * o[0]]
        ring = []
        for j in range(sides):
            ang = 2 * math.pi * j / sides
            c, s = math.cos(ang), math.sin(ang)
            ring.append(m.add_v([p[k] + radius * (c * o[k] + s * w[k]) for k in range(3)]))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(sides):
            k = (j + 1) % sides
            m.add_f((r0[j], r0[k], r1[k], r1[j]))
    return m


def helix(z0: float, z1: float, pitch: float, lift, steps_per_turn: int):
    """Points + outward normals of a helix on the grip oval, z = z0 + pitch * turns."""
    turns = (z1 - z0) / pitch
    n = int(turns * steps_per_turn) + 1
    pts, nrm = [], []
    for i in range(n):
        tt = turns * i / (n - 1)
        phi = -math.pi / 2 + 2 * math.pi * tt
        z = z0 + pitch * tt
        a, b = grip_ab(min(max(z, LEATHER_Z[0]), LEATHER_Z[1]))
        nx, ny = ring_normal(phi, a, b)
        x, y = ring_point(phi, a, b)
        d = lift(phi, z)
        pts.append((x + nx * d, y + ny * d, z))
        nrm.append((nx, ny, 0.0))
    return pts, nrm


def hi_mesh() -> Mesh:
    m = build_blade(True)
    zs = [lerp(COLLAR_G[0], COLLAR_P[1], i / 420) for i in range(421)]
    m.extend(revolve([(z, 1.0) for z in zs], grip_shape(), 160, disp=leather_height))
    # Brass wire in the wrap's step (one continuous helix along the strap edge).
    pts, nrm = helix(
        LEATHER_Z[0] + 0.0004, LEATHER_Z[1] - 0.0004, WRAP_PITCH,
        lambda phi, z: WRAP_T * 0.3 + WIRE_R * 0.75, 180,
    )
    m.extend(tube(pts, nrm, WIRE_R, 10))
    # Collars: tight coils of heavier wire.
    for z0, z1 in (COLLAR_G, COLLAR_P):
        pts, nrm = helix(z0 + COIL_R, z1 - COIL_R, 2 * COIL_R, lambda p, z: COIL_R * 0.95, 96)
        m.extend(tube(pts, nrm, COIL_R, 10))
    m.extend(revolve(guard_profile(True), guard_shape, 192, cap='both'))
    m.extend(revolve(catmull(POMMEL_LOW, 8), oval_shape(POMMEL_AB), 160))
    nub = [(POMMEL_Z0 + 0.0168, 1.02), (POMMEL_Z0 + 0.0188, 1.05), (POMMEL_Z0 + 0.0195, 0.92),
           (POMMEL_Z0 + 0.0199, 0.6), (POMMEL_Z0 + 0.0200, 0.2)]
    m.extend(revolve(catmull(nub, 6), lambda z, k: (NUB_R * k, NUB_R * k, 2.0, 0.0), 48,
                     cap='end'))
    return m


PART_NAMES = {
    11: 'blade flat', 12: 'blade grind', 13: 'micro-bevel', 14: 'spine', 20: 'leather wrap',
    30: 'wire collar', 40: 'guard', 50: 'pommel',
}

# ---------------------------------------------------------------------------------------------
# tex stage (system Python: numpy + Pillow + scipy)


def _np():
    import numpy as np

    return np


def _gauss(a, sigma, wrap=True):
    from scipy import ndimage

    return ndimage.gaussian_filter(a, sigma, mode='wrap' if wrap else 'nearest')


def _sample(img, u, v, order=1):
    """Bilinear wrap sampling of img (H, W[, C]) at pixel coords u (col), v (row)."""
    from scipy import ndimage

    np = _np()
    if img.ndim == 2:
        return ndimage.map_coordinates(img, [v, u], order=order, mode='grid-wrap')
    return np.stack(
        [ndimage.map_coordinates(img[..., c], [v, u], order=order, mode='grid-wrap')
         for c in range(img.shape[2])],
        -1,
    )


def _load(name):
    from PIL import Image

    np = _np()
    path = SRC / f'{name}.png'
    if not path.exists():
        raise SystemExit(f'missing source {path}')
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255.0


def _srgb_to_lin(c):
    np = _np()
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _lin_to_srgb(c):
    np = _np()
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def make_tileable(img, overlap: int):
    """Heal the wrap seams: cross-fade the last `overlap` px of each axis over the first ones,
    then crop them off (variance-preserving blend so the seam band doesn't go soft)."""
    np = _np()
    out = img.astype(np.float32)
    for axis in (1, 0):
        n = out.shape[axis]
        a = np.take(out, range(0, overlap), axis=axis)
        b = np.take(out, range(n - overlap, n), axis=axis)
        t = np.linspace(0, 1, overlap, dtype=np.float32)
        shape = [1] * out.ndim
        shape[axis] = overlap
        t = t.reshape(shape)
        w = t * t * (3 - 2 * t)
        mean = out.mean(axis=(0, 1), keepdims=True)
        blend = (b - mean) * (1 - w) + (a - mean) * w
        # keep the contrast: a linear blend of two uncorrelated textures loses ~1/sqrt(2)
        gain = 1 / np.sqrt((1 - w) ** 2 + w**2)
        blend = mean + blend * gain
        body = np.take(out, range(overlap, n - overlap), axis=axis)
        out = np.concatenate([blend, body], axis=axis)
    return out


def delight(img, sigma: float):
    """Divide out the low-frequency lighting (luminance only, keeps hue)."""
    np = _np()
    lum = img.mean(-1)
    low = _gauss(lum, sigma)
    return np.clip(img * (lum.mean() / np.maximum(low, 1e-3))[..., None], 0, 1)


def heal_sources():
    """Healed, de-lit, tileable source tiles + their derived data. Returns a dict of arrays."""
    np = _np()
    out = {}
    # Damascus: de-light, heal, normalise the grain to 0..1.
    dam = delight(_load('damascus_steel_albedo'), 90)
    dam = make_tileable(dam, 96)
    g = dam.mean(-1)
    lo, hi = np.percentile(g, [2, 98])
    out['damascus'] = np.clip((g - lo) / (hi - lo), 0, 1)
    out['damascus_rgb'] = dam
    # Knotwork: crop the band rows, threshold, one horizontal period (421 px measured by
    # self-difference), seam cross-faded over 12 px.
    k = 1 - _load('knotwork_etch_mask').mean(-1)
    rows = np.where((k > 0.5).any(1))[0]
    band = k[rows.min() : rows.max() + 1]
    w = band.shape[1]
    best = min(range(380, 470), key=lambda p: np.abs(band[:, : w - p] - band[:, p:]).mean())
    start = (w - best) // 2
    tile = band[:, start : start + best].copy()
    nxt = band[:, start + best : start + best + 12]
    if nxt.shape[1] == 12:
        t = np.linspace(0, 1, 12)[None]
        tile[:, :12] = band[:, start : start + 12] * t + nxt * (1 - t)
    out['knot'] = np.clip((tile - 0.15) / 0.7, 0, 1)
    out['knot_period'] = best
    # Leather: rotate so the 45 deg seams run horizontally, find each seam, de-light per band.
    from PIL import Image

    lea = _load('leather_grip_albedo')
    im = Image.fromarray((lea * 255).astype(np.uint8)).rotate(-45, resample=Image.BICUBIC)
    r = np.asarray(im, dtype=np.float32) / 255
    c = r.shape[0] // 2
    half = int(r.shape[0] / (2 * math.sqrt(2))) - 8
    r = r[c - half : c + half, c - half : c + half]
    prof = _gauss(r.mean(-1).mean(1), 1.5, wrap=False)
    if prof.argmin() is None:
        raise SystemExit('leather: no seams')
    # seams = local minima at least 80 px apart
    seams = []
    for i in np.argsort(prof):
        if all(abs(i - s) > 80 for s in seams):
            seams.append(int(i))
        if len(seams) >= 12:
            break
    seams = sorted(s for s in seams if prof[s] < prof.mean() - 0.5 * prof.std())
    gaps = np.diff(seams)
    if len(seams) < 4 or gaps.max() > 1.6 * np.median(gaps):
        raise SystemExit(f'leather: irregular seams {seams}')
    bands = []
    for a, b in zip(seams, seams[1:]):
        seg = r[a:b]
        # de-light across the strap (the source's raised-edge shading) but keep 25 % of it
        rowm = seg.mean(1, keepdims=True)
        seg = seg / np.maximum(rowm, 1e-3) * (0.75 * seg.mean((0, 1), keepdims=True) + 0.25 * rowm)
        bands.append(seg)
    out['leather_bands'] = bands
    out['leather'] = r
    # Bronze: de-light, heal; the green patina layer and a warm-metal detail layer.
    br = make_tileable(delight(_load('bronze_patina_albedo'), 60), 80)
    out['bronze'] = br
    lum = br.mean(-1)
    out['bronze_detail'] = lum / lum.mean()
    green = br[..., 1] - 0.5 * (br[..., 0] + br[..., 2])
    out['bronze_green'] = np.clip((green - np.percentile(green, 30)) / (np.ptp(green) * 0.5), 0, 1)
    return out


def _interp_table(fn, lo, hi, n=4096):
    np = _np()
    xs = np.linspace(lo, hi, n)
    return xs, np.array([fn(x) for x in xs])


def _noise(seed, size=512, sigma=1.0):
    np = _np()
    rng = np.random.default_rng(seed)
    n = _gauss(rng.standard_normal((size, size)).astype(np.float32), sigma)
    return (n - n.mean()) / (n.std() + 1e-6)


def _scratches(s, y, side):
    """Use-wear: fine random scratches (mostly across the blade, a few along it) drawn in
    blade space (s, y) per side; returns 0..1 per texel."""
    from PIL import Image, ImageDraw

    np = _np()
    ppm = 12000
    w, h = int(0.22 * ppm), int(0.04 * ppm)
    out = []
    for seed in (31, 32):
        rng = np.random.default_rng(seed)
        im = Image.new('L', (w, h))
        d = ImageDraw.Draw(im)
        for _ in range(900):
            x0, y0 = rng.uniform(0, w), rng.uniform(0, h)
            ang = rng.normal(math.pi / 2, 0.5) if rng.random() < 0.7 else rng.normal(0, 0.15)
            ln = rng.uniform(0.002, 0.012) * ppm
            # denser near the guard (handling) and the edge
            if rng.random() > 0.35 + 0.65 * (1 - x0 / w):
                continue
            d.line([(x0, y0), (x0 + math.cos(ang) * ln, y0 + math.sin(ang) * ln)],
                   fill=int(rng.uniform(60, 200)), width=1)
        out.append(_gauss(np.asarray(im, np.float32) / 255, 0.6))
    u = s * ppm
    v = (y + 0.016) * ppm
    return np.where(side > 0, _sample(out[0], u, v), _sample(out[1], u, v))


def compose(src):
    """Per-texel material from the bakes: albedo (sRGB), ORM, tangent normal (all TEX x TEX)."""
    np = _np()
    from scipy import ndimage

    ld = lambda n: np.load(BUILD / f'{n}.npy').astype(np.float32)  # noqa: E731
    pos_b, part_i, nrm, ao_i = ld('bake_pos'), ld('bake_part'), ld('bake_normal'), ld('bake_ao')
    part = np.rint(part_i[..., 0]).astype(np.int32)
    valid = part > 0
    X, Y, Z = pos_b[..., 0], pos_b[..., 2], -pos_b[..., 1]  # Blender -> knife space
    ao = np.clip(ao_i[..., 0], 0, 1)
    nb = nrm[..., :3] * 2 - 1
    H, W = part.shape
    vv, uu = np.mgrid[0:H, 0:W].astype(np.float32)

    alb = np.zeros((H, W, 3), np.float32)  # linear
    rough = np.full((H, W), 0.5, np.float32)
    metal = np.zeros((H, W), np.float32)
    height = np.zeros((H, W), np.float32)  # metres, for the normal detail

    # Curvature from the baked normal (convex > 0), only within a part.
    def dmask(a, axis):
        f = np.roll(a, -1, axis)
        b = np.roll(a, 1, axis)
        same = (np.roll(part, -1, axis) == part) & (np.roll(part, 1, axis) == part)
        return np.where(same, (f - b) * 0.5, 0)

    curv = dmask(nb[..., 0], 1) + dmask(nb[..., 1], 0)
    curv = ndimage.gaussian_filter(curv, 1.5) * 8

    # --- blade --------------------------------------------------------------------------
    blade = valid & (part >= 11) & (part <= 14)
    s = GUARD_FRONT - Z
    st, spv = _interp_table(spine_y, TANG_S, BLADE_LEN)
    sp = np.interp(s, st, spv)
    ed = np.interp(s, *_interp_table(edge_y, TANG_S, BLADE_LEN))
    side = np.sign(X)
    K = src['damascus'].shape[1] / 0.14  # one tile per 14 cm: grain reads at arm's length
    du = s * K
    dv = (Y + 0.1 * side + 0.004 * np.sin(s * 60)) * K  # left/right sides see different grain
    pd = _sample(src['damascus'], du, dv)
    scr = _noise(7, 512, 0.6)
    brush = _sample(scr, s * 300, Y * 60000)  # lengthwise grinding marks
    cross = _sample(scr, s * 50000 + 37, X * 300 + 91)
    fine = _sample(_noise(11, 512, 0.8), uu * 0.9, vv * 0.9)
    flat = blade & (part == 11)
    grind = blade & (part == 12)
    micro = blade & (part == 13)
    spine = blade & (part == 14)
    # Etched pattern-welding: blue-black layers with bright lines (contrast pushed so it reads
    # at first-person distance); the welded-on edge steel stays plain and lighter.
    pd2 = np.clip((pd - 0.15) / 0.75, 0, 1) ** 2.2
    a = np.where(flat, pd2, 0)
    a = np.where(grind, 0.80 + 0.08 * pd + 0.02 * brush, a)
    a = np.where(micro, 1.2 + 0.02 * brush, a)
    a = np.where(spine, 0.25 + 0.5 * pd2, a)
    r_ = np.where(flat, 0.54 - 0.30 * pd2 + 0.02 * fine, 0)
    r_ = np.where(grind, 0.21 + 0.035 * np.abs(brush), r_)
    r_ = np.where(micro, 0.09 + 0.01 * np.abs(brush), r_)
    r_ = np.where(spine, 0.36 + 0.04 * np.abs(cross), r_)
    height = np.where(flat | spine, -(1 - pd) * 0.000005, height)
    height = np.where(grind, brush * 0.0000015, height)

    # Etched knotwork band along the spine: from 9 mm off the guard to just before the break.
    s0, s1 = 0.009, BREAK_S - 0.007
    d = sp - Y
    d0, hb = 0.0017, 0.0060
    knot = src['knot']
    kh, kw = knot.shape
    tile_len = hb * kw / kh
    reps = max(1, round((s1 - s0) / tile_len))
    tile_len = (s1 - s0) / reps
    a_ = s - s0
    tb = (d - d0) / hb
    # rounded-end cartouche (SDF), plus a thin etched rim line around it
    cx = np.clip(a_, hb / 2, (s1 - s0) - hb / 2)
    sdf = np.hypot(a_ - cx, (d - (d0 + hb / 2))) - hb / 2
    sdf = np.where((a_ > hb / 2) & (a_ < (s1 - s0) - hb / 2), np.abs(d - (d0 + hb / 2)) - hb / 2, sdf)
    inside = flat & (sdf < 0)
    strand = _sample(knot, a_ / tile_len * kw, np.clip(tb, 0, 1) * (kh - 1), order=1)
    strand = np.where(inside, strand, 0)
    texel = 1 / D
    aa = lambda x: np.clip(0.5 - x / texel, 0, 1)  # noqa: E731  (1-texel antialiased edge)
    field = aa(sdf) * (1 - strand)
    rim = flat * np.clip(1 - np.abs(sdf - 0.00045) / 0.00014, 0, 1)
    etched = np.clip(field + rim, 0, 1) * flat
    a = a * (1 - 0.7 * etched)
    r_ = r_ + (0.74 - r_) * etched
    a = np.where(inside, a + (0.75 - a) * 0.6 * strand * (1 - etched), a)  # strands burnished
    r_ = np.where(inside, r_ - 0.12 * strand, r_)
    height = height - etched * 0.00003
    # Use and grime: darker, rougher toward the guard; faint oxidation spots near the ricasso.
    near = np.clip(1 - s / 0.025, 0, 1) * blade
    spots = np.clip(_sample(_noise(21, 512, 3.0), uu * 0.5, vv * 0.5) - 1.1, 0, 1)
    grime = np.clip((1 - ao) * 1.4 + near * 0.35 + spots * near * 0.4, 0, 1) * blade
    dull = np.clip(1 - s / 0.07, 0, 1) * blade  # handling dulls the steel toward the guard
    wear = _scratches(s, Y, side) * blade
    a = a * (1 - 0.55 * grime) * (1 - 0.22 * dull)
    r_ = r_ + (0.8 - r_) * grime * 0.7 + 0.16 * dull + 0.12 * wear
    a = a + (0.62 - a) * 0.35 * wear
    dark = np.array([0.028, 0.034, 0.045], np.float32)
    bright = np.array([0.60, 0.61, 0.625], np.float32)
    tint = dark + (bright - dark) * np.clip(a, 0, 1.3)[..., None]
    tint[..., 0] += 0.03 * grime  # rust-brown in the grime
    alb = np.where(blade[..., None], tint, alb)
    rough = np.where(blade, r_, rough)
    metal = np.where(blade, 1.0, metal)

    # --- leather wrap + its wire ---------------------------------------------------------
    lea = valid & (part == 20)
    zt, ga = _interp_table(lambda z: grip_ab(z)[0], LEATHER_Z[0], LEATHER_Z[1], 512)
    _, gb = _interp_table(lambda z: grip_ab(z)[1], LEATHER_Z[0], LEATHER_Z[1], 512)
    A = np.interp(Z, zt, ga)
    B = np.interp(Z, zt, gb)
    phi = np.arctan2(Y / B, X / A)
    turn_f = (Z - LEATHER_Z[0]) / WRAP_PITCH - (phi + math.pi / 2) / (2 * math.pi)
    f = np.mod(turn_f, 1.0)
    kturn = np.floor(turn_f).astype(np.int64)
    bands = src['leather_bands']
    circ = perimeter(grip_ab(0.0)[0], grip_ab(0.0)[1])
    along = np.mod((phi + math.pi / 2) / (2 * math.pi), 1.0) * circ
    la = np.zeros((H, W, 3), np.float32)
    for j, bd in enumerate(bands):
        sel = lea & (np.mod(kturn, len(bands)) == j)
        if not sel.any():
            continue
        h_, w_ = bd.shape[:2]
        ds = h_ / (WRAP_PITCH * 0.988)  # px per metre across the strap
        u = 20 + along[sel] * ds + 37 * j
        v = f[sel] * (h_ - 1)
        la[sel] = _sample(bd, np.minimum(u, w_ - 2), v)
    la = _srgb_to_lin(la)
    lum = la.mean(-1)
    hand = np.exp(-(((Z - 0.004) / 0.03) ** 2))  # palm-worn middle: darker, oilier
    la = la * (1.2 - 0.1 * hand)[..., None]
    # shadow in the step under the overlap + AO
    stepdark = np.clip(1 - f / 0.12, 0, 1) * 0.5
    la = la * ((1 - stepdark) * (0.7 + 0.3 * ao))[..., None]
    lr = 0.66 - 0.18 * hand - 0.6 * (lum - lum[lea].mean() if lea.any() else 0)
    lh = (lum - _gauss(np.where(lea, lum, 0), 3, False)) * 0.00005
    wire_g = np.mod((Z - (LEATHER_Z[0] + 0.0004)) / WRAP_PITCH - (phi + math.pi / 2) / (2 * math.pi), 1)
    wd = np.minimum(wire_g, 1 - wire_g) * WRAP_PITCH * 0.988
    wire = lea & (wd < WIRE_R * 1.05)
    brass = _srgb_to_lin(np.array([0.74, 0.58, 0.36], np.float32))
    wt = np.clip(wd / WIRE_R, 0, 1)  # 0 at the wire's crown
    wcol = brass[None, None] * (0.95 - 0.35 * wt**2)[..., None] * (0.5 + 0.5 * ao)[..., None]
    alb = np.where(lea[..., None], np.where(wire[..., None], wcol, la), alb)
    rough = np.where(lea, np.where(wire, 0.28 + 0.2 * wt, np.clip(lr, 0.35, 0.85)), rough)
    metal = np.where(lea, np.where(wire, 1.0, 0.0), metal)
    height = np.where(lea & ~wire, lh, height)

    # --- collars: brass coils ------------------------------------------------------------
    col = valid & (part == 30)
    tarn = np.clip((0.8 - ao) * 2, 0, 1)
    ccol = brass[None, None] * (0.85 + 0.15 * fine[..., None] * 0.3)
    ccol = ccol * (1 - 0.6 * tarn)[..., None] + np.array([0.02, 0.03, 0.015]) * tarn[..., None]
    alb = np.where(col[..., None], ccol, alb)
    rough = np.where(col, 0.27 + 0.35 * tarn, rough)
    metal = np.where(col, 1 - 0.5 * tarn, metal)

    # --- bronze guard + pommel -----------------------------------------------------------
    brz = valid & ((part == 40) | (part == 50))
    bsrc = src['bronze']
    sc = bsrc.shape[1] / 1100.0  # source px per atlas px (~12 cm per tile)
    bs = _srgb_to_lin(_sample(bsrc, uu * sc, vv * sc))
    det = _sample(src['bronze_detail'], uu * sc, vv * sc)
    grn = _sample(src['bronze_green'], uu * sc, vv * sc)
    cav = np.clip((0.92 - ao) * 3.0 + np.clip(-curv, 0, 1) * 1.5, 0, 1)
    # Patina where dirt and polish never reach: the guard's two grooves, its chamfer roots,
    # the pommel's bead step and the ring round the peened nub.
    rad = np.hypot(X, Y)
    grooves = np.zeros_like(cav)
    for zg in (GUARD_FRONT + 0.0034, GUARD_BACK - 0.0034):
        grooves = np.maximum(grooves, np.exp(-(((Z - zg) / 0.0006) ** 2)) * (part == 40))
    nub = np.exp(-(((rad - NUB_R * 1.25) / 0.0011) ** 2)) * (Z > NUB_LOW[0][0] - 0.003)
    bead = np.exp(-(((Z - (POMMEL_Z0 + 0.0057)) / 0.0008) ** 2))
    struct = np.clip(grooves + (nub + bead) * (part == 50), 0, 1)
    patina = np.clip(
        cav * (0.6 + 0.7 * grn) + struct * (0.7 + 0.5 * grn) + np.clip(grn - 0.55, 0, 1) * 0.7,
        0, 1,
    )
    # Warm polish only on real high points (rims, the dome crown), never on flat faces.
    worn = np.clip(curv * 1.4 - 0.25 + 0.1 * (det - 1) * 4, 0, 1) * (1 - patina)
    aged = _srgb_to_lin(np.array([0.33, 0.27, 0.16], np.float32))[None, None] * (
        det[..., None] ** 1.8
    )  # brown-olive aged bronze
    polished = _srgb_to_lin(np.array([0.72, 0.55, 0.36], np.float32))[None, None] * (
        0.9 + 0.1 * det[..., None]
    )
    verd = _srgb_to_lin(np.array([0.26, 0.33, 0.24], np.float32))[None, None]
    bcol = aged * (1 - worn[..., None]) + polished * worn[..., None]
    pcol = bs * 0.6 + verd * 0.4
    bcol = bcol * (1 - patina[..., None]) + pcol * patina[..., None]
    bcol = bcol * (0.55 + 0.45 * ao)[..., None]
    alb = np.where(brz[..., None], bcol, alb)
    rough = np.where(brz, 0.48 - 0.22 * worn + 0.38 * patina, rough)
    metal = np.where(brz, 1 - 0.92 * patina, metal)
    height = np.where(brz, (det - 1) * 0.00002 + patina * 0.00001, height)

    # --- normal: baked + detail ----------------------------------------------------------
    hgt = np.where(valid, height, 0).astype(np.float32)
    gx = dmask(hgt, 1) / texel
    gy = dmask(hgt, 0) / texel
    n = np.stack([nb[..., 0] - gx, nb[..., 1] - gy, nb[..., 2]], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-8

    maps = {
        'albedo': _lin_to_srgb(alb),
        'orm': np.stack([ao, np.clip(rough, 0.05, 1), np.clip(metal, 0, 1)], -1),
        'normal': n * 0.5 + 0.5,
    }
    # Dilate every map into the empty texels (nearest island texel) so mips never bleed black.
    _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
    for k_ in maps:
        maps[k_] = maps[k_][iy, ix]
    return maps, valid


def save_png(arr, path: Path, size: int | None = None) -> None:
    """Blender-convention array (row 0 = v 0, bottom) -> top-down PNG."""
    from PIL import Image

    np = _np()
    im = Image.fromarray((np.clip(arr[::-1], 0, 1) * 255 + 0.5).astype(np.uint8))
    if size and size != im.size[0]:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(path)


def downsample_normal(arr, size: int):
    """Average then renormalise (not a colour resize)."""
    np = _np()
    f = arr.shape[0] // size
    v = arr * 2 - 1
    v = v.reshape(size, f, size, f, 3).mean((1, 3))
    v /= np.linalg.norm(v, axis=-1, keepdims=True) + 1e-8
    return v * 0.5 + 0.5


def swatch_sheet(src, maps, path: Path, valid=None) -> None:
    from PIL import Image, ImageDraw

    np = _np()
    cell = 360
    tiles = []

    def tile2(a):
        a = np.concatenate([a, a], 0)
        return np.concatenate([a, a], 1)

    def pil(a):
        if a.ndim == 2:
            a = np.repeat(a[..., None], 3, -1)
        return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).resize((cell, cell))

    m = valid[..., None] if valid is not None else 1
    shown = {k_: maps[k_] * m + 0.07 * (1 - m) for k_ in maps}
    knot = np.tile(src['knot'], (1, 3))
    kn = np.ones((knot.shape[1], knot.shape[1]))
    off = (kn.shape[0] - knot.shape[0]) // 2
    kn[off : off + knot.shape[0]] = 1 - knot
    tiles = [
        ('damascus: de-lit + healed (2x2 tiling)', pil(tile2(src['damascus_rgb']))),
        ('knotwork: one period, 3x', pil(kn)),
        ('leather: rotated, seams found', pil(src['leather'])),
        ('bronze: de-lit + healed (2x2)', pil(tile2(src['bronze']))),
        ('bronze green (patina) mask', pil(tile2(src['bronze_green']))),
        ('baked albedo (atlas, 2k)', pil(shown['albedo'][::-1])),
        ('baked roughness (ORM G)', pil(shown['orm'][::-1][..., 1])),
        ('baked normal', pil(shown['normal'][::-1])),
    ]
    sheet = Image.new('RGB', (cell * 4, (cell + 22) * 2), (18, 18, 20))
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(tiles):
        x, y = (i % 4) * cell, (i // 4) * (cell + 22)
        sheet.paste(im, (x, y + 22))
        d.text((x + 6, y + 5), name, fill=(235, 225, 160))
    sheet.save(path, quality=92)


SHIP = 1024
LOW = 512
MAPS = (('albedo', 'albedo'), ('normal', 'normal'), ('arm', 'orm'))
"""Shipped name -> tex-stage map (arm = glTF metallicRoughness + AO: R ao, G rough, B metal)."""


def manifest() -> dict:
    lo = low_mesh()
    return {
        'source': 'tools/assets/build_knife.py (own Blender work; Codex image_generation texture '
        'sources, Kiran, 2026-10-01)',
        'triangles': lo.triangles(),
        'anchors': {k: [round(c, 5) for c in v] for k, v in ANCHORS.items()},
        'bladeLength': BLADE_LEN,
        'clipDeg': round(CLIP_DEG, 1),
        'texture': SHIP,
        'textureLow': LOW,
    }


def stage_package() -> None:
    """Shipped files in packages/client/public/models/knife (then meshopt-packed)."""
    import shutil
    import subprocess

    from PIL import Image

    from webp import save_webp

    ex = BUILD / 'export'
    doc = json.loads((ex / 'knife.gltf').read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    src_bin = ex / doc['buffers'][0]['uri']
    doc['buffers'][0]['uri'] = 'knife.bin'
    doc['asset']['generator'] = 'warsaw-downtown tools/assets/build_knife.py'
    names = {n.get('name') for n in doc['nodes']}
    missing = {'knife', *ANCHORS} - names
    if missing:
        raise SystemExit(f'export lacks nodes {missing}')
    shutil.copyfile(src_bin, OUT / 'knife.bin')
    (OUT / 'knife.gltf').write_text(json.dumps(doc, separators=(',', ':')))
    md = BUILD / 'maps'
    for name, src in MAPS:
        for suffix in ('', '_low'):
            im = Image.open(md / f'knife_{src}{suffix}.png').convert('RGB')
            save_webp(
                im,
                OUT / f'knife_{name}{suffix}.webp',
                'color' if name == 'albedo' else 'data',
                match_jpeg=90 if name == 'normal' else 85,
                subsampling=0 if name == 'normal' else 2,
            )
    from build_models import json_text

    (OUT / 'knife.json').write_text(json_text(manifest()) + '\n', encoding='utf-8', newline='\n')
    subprocess.run(['node', str(ROOT / 'tools/assets/meshopt_pack.mjs'), str(OUT / 'knife.gltf')],
                   check=True)
    print('knife: packaged', sorted(p.name for p in OUT.iterdir()), flush=True)


def stage_tex() -> None:
    np = _np()
    src = heal_sources()
    maps, valid = compose(src)
    md = BUILD / 'maps'
    md.mkdir(parents=True, exist_ok=True)
    for name, arr in maps.items():
        save_png(arr, md / f'knife_{name}_2k.png')
        if name == 'normal':
            save_png(downsample_normal(arr, 1024), md / f'knife_{name}.png')
            save_png(downsample_normal(arr, 512), md / f'knife_{name}_low.png')
        else:
            save_png(arr, md / f'knife_{name}.png', 1024)
            save_png(arr, md / f'knife_{name}_low.png', 512)
    REVIEW.mkdir(parents=True, exist_ok=True)
    swatch_sheet(src, maps, REVIEW / '06_texture_sources_swatch.jpg', valid)
    print('knife: tex stage done; coverage', round(float(valid.mean()), 3), 'knot period',
          src['knot_period'], 'leather bands', len(src['leather_bands']))


# ---------------------------------------------------------------------------------------------
# Blender stages


def k2b(p):
    """Knife space (glTF, y up) -> Blender (z up)."""
    return (p[0], -p[2], p[1])


def blender_object(name: str, m: Mesh, low: bool):
    bm = bmesh.new()
    verts = [bm.verts.new(k2b(p)) for p in m.v]
    bm.verts.index_update()
    uvl = bm.loops.layers.uv.new('UVMap') if low else None
    part = bm.faces.layers.float.new('part') if low else None
    for f, uv, pid in zip(m.f, m.uv, m.part):
        try:
            face = bm.faces.new([verts[i] for i in f])
        except ValueError:
            continue  # degenerate / duplicate (none expected on the low mesh)
        face.smooth = True
        if low:
            face[part] = pid
            for loop, (u, v) in zip(face.loops, uv):
                loop[uvl].uv = (u / TEX, v / TEX)
    bm.edges.ensure_lookup_table()
    bm.normal_update()
    if low:
        for e in bm.edges:
            a, b = e.verts[0].index, e.verts[1].index
            if (a, b) in m.sharp or (b, a) in m.sharp:
                e.smooth = False
            elif len(e.link_faces) == 2:
                n0, n1 = e.link_faces[0].normal, e.link_faces[1].normal
                if n0.angle(n1, 0) > math.radians(40):
                    e.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def save_np(img, path: Path) -> None:
    import numpy as np

    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    np.save(path, a.reshape(img.size[1], img.size[0], 4).astype(np.float16))


def bake_image(name: str, float_buf: bool):
    img = bpy.data.images.new(name, TEX, TEX, alpha=True, float_buffer=float_buf)
    img.generated_color = (0, 0, 0, 0)
    img.colorspace_settings.name = 'Non-Color'
    return img


def export_gltf(low) -> None:
    """The game mesh + anchor empties (knife space; no materials, no tangents: the client's
    normal map uses derivative tangents, like the gun scans, so no new program)."""
    ex = BUILD / 'export'
    ex.mkdir(parents=True, exist_ok=True)
    low.name = low.data.name = 'knife'
    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    for name in ANCHORS:
        bpy.data.objects[name].select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ex / 'knife.gltf'),
        export_format='GLTF_SEPARATE',
        use_selection=True,
        export_materials='NONE',
        export_tangents=False,
        export_yup=True,
        export_apply=False,
        export_animations=False,
    )
    low.name = low.data.name = 'knife_low'


def stage_model() -> None:
    import time

    BUILD.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    lo_m, hi_m = low_mesh(), hi_mesh()
    print(f'knife: low {lo_m.triangles()} tris, hi {hi_m.triangles()} tris', flush=True)
    low = blender_object('knife_low', lo_m, True)
    hi = blender_object('knife_hi', hi_m, False)
    for name, p in ANCHORS.items():
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.01
        e.location = k2b(p)
        sc.collection.objects.link(e)
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.world = bpy.data.worlds.new('w')
    sc.world.light_settings.distance = 0.012  # AO reach: local occlusion only

    mat = bpy.data.materials.new('bake')
    mat.use_nodes = True
    low.data.materials.append(mat)
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != 'OUTPUT_MATERIAL':
            nt.nodes.remove(n)
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    tex = nt.nodes.new('ShaderNodeTexImage')
    nt.nodes.active = tex
    emit = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(emit.outputs[0], out.inputs[0])

    bk = sc.render.bake

    def bake(kind: str, img, **kw):
        tex.image = img
        bpy.ops.object.select_all(action='DESELECT')
        low.select_set(True)
        sel = kw.pop('selected', False)
        if sel:
            hi.select_set(True)
        bpy.context.view_layer.objects.active = low
        t0 = time.time()
        bk.use_selected_to_active = sel
        bk.margin = kw.pop('margin', 0)
        bk.margin_type = 'EXTEND'
        bk.use_clear = True
        if sel:
            bk.cage_extrusion = 0.0015
            bk.max_ray_distance = 0.004
        bpy.ops.object.bake(type=kind, **kw)
        print(f'knife: baked {img.name} in {time.time() - t0:.0f} s', flush=True)
        save_np(img, BUILD / f'{img.name}.npy')

    # Object-space position + part id of the low-poly itself (data for the tex stage).
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    # Blender -> knife space happens in numpy; bake raw Blender coordinates.
    nt.links.new(geo.outputs['Position'], emit.inputs['Color'])
    sc.cycles.samples = 1
    bake('EMIT', bake_image('bake_pos', True))
    attr = nt.nodes.new('ShaderNodeAttribute')
    attr.attribute_name = 'part'
    comb = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(attr.outputs['Fac'], comb.inputs['X'])
    nt.links.new(geo.outputs['Normal'], emit.inputs['Color'])
    bake('EMIT', bake_image('bake_nrm_obj', True))
    nt.links.new(comb.outputs[0], emit.inputs['Color'])
    bake('EMIT', bake_image('bake_part', True))
    sc.cycles.samples = 8
    bake('NORMAL', bake_image('bake_normal', True), selected=True, margin=16,
         normal_space='TANGENT')
    sc.cycles.samples = 96
    bake('AO', bake_image('bake_ao', True), selected=True, margin=16)
    hi.hide_render = True
    export_gltf(low)
    bpy.ops.wm.save_as_mainfile(filepath=str(BUILD / 'knife.blend'))
    stats = {'lowTriangles': lo_m.triangles(), 'hiTriangles': hi_m.triangles()}
    (BUILD / 'model.json').write_text(json.dumps(stats, indent=2))
    print('knife: model stage done', stats, flush=True)


def _look(cam, target, roll=0.0):
    from mathutils import Vector

    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.rotation_euler.rotate_axis('Z', roll)


def _knife_material(maps: Path, res: str = ''):
    mat = bpy.data.materials.new('knife')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']

    def img(name, color):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(str(maps / f'knife_{name}{res}.png'))
        n.image.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
        return n

    alb, orm, nrm = img('albedo', True), img('orm', False), img('normal', False)
    nt.links.new(alb.outputs[0], bsdf.inputs['Base Color'])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs[0], sep.inputs[0])
    nt.links.new(sep.outputs[1], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs[2], bsdf.inputs['Metallic'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.uv_map = 'UVMap'
    nt.links.new(nrm.outputs[0], nm.inputs['Color'])
    nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
    return mat


def _studio(sc, hdr: Path, strength: float = 0.8):
    w = bpy.data.worlds.new('studio')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes['Background']
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(str(hdr))
    nt.links.new(env.outputs[0], bg.inputs[0])
    bg.inputs[1].default_value = strength
    # Camera rays see a dark backdrop; reflections and light see the city HDRI.
    lp = nt.nodes.new('ShaderNodeLightPath')
    dark = nt.nodes.new('ShaderNodeBackground')
    dark.inputs[0].default_value = (0.012, 0.012, 0.014, 1)
    mix = nt.nodes.new('ShaderNodeMixShader')
    out = nt.nodes['World Output']
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs[0])
    nt.links.new(bg.outputs[0], mix.inputs[1])
    nt.links.new(dark.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])


def _area(name, loc, target, size, power, color=(1, 0.97, 0.93), sy=None):
    li = bpy.data.lights.new(name, 'AREA')
    li.shape = 'RECTANGLE'
    li.size = size
    li.size_y = sy or size
    li.energy = power
    li.color = color
    ob = bpy.data.objects.new(name, li)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    _look(ob, target)
    return ob


def _load_arms(knife_ob):
    """The pistol pose's right arm (Rocketbox, MIT; unpacked by meshopt_pack.mjs --unpack) with
    the knife's grip fitted through the fist channel."""
    import numpy as np
    from mathutils import Matrix, Vector

    gl = Path(os.environ.get('WD_KNIFE_ARMS', BUILD / 'unpacked/arms/pistol.gltf'))
    if not gl.exists():
        print('knife: no unpacked arms, skipping the hand shot', flush=True)
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(gl))
    arms = next(o for o in bpy.data.objects if o not in before and o.type == 'MESH')
    # Keep the right arm only (connected pieces whose centre is at +x).
    bm = bmesh.new()
    bm.from_mesh(arms.data)
    bm.verts.ensure_lookup_table()
    seen, drop = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, comp = [v], []
        seen.add(v.index)
        while stack:
            a = stack.pop()
            comp.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        if sum(p.co.x for p in comp) / len(comp) < 0:
            drop += comp
    bmesh.ops.delete(bm, geom=drop, context='VERTS')
    bm.to_mesh(arms.data)
    bm.free()
    am = bpy.data.materials.new('arms')
    am.use_nodes = True
    nt = am.node_tree
    bsdf = nt.nodes['Principled BSDF']
    adir = ROOT / 'packages/client/public/models/arms'
    for fn, sock, color in (
        ('arms_albedo', 'Base Color', True),
        ('arms_rough', 'Roughness', False),
        ('arms_normal', None, False),
    ):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(str(adir / f'{fn}.webp'))
        n.image.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
        if sock == 'Roughness':
            sp = nt.nodes.new('ShaderNodeSeparateColor')
            nt.links.new(n.outputs[0], sp.inputs[0])
            nt.links.new(sp.outputs[1], bsdf.inputs['Roughness'])
        elif sock:
            nt.links.new(n.outputs[0], bsdf.inputs[sock])
        else:
            nm = nt.nodes.new('ShaderNodeNormalMap')
            nt.links.new(n.outputs[0], nm.inputs['Color'])
            nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
    arms.data.materials.clear()
    arms.data.materials.append(am)
    # Fist channel: centre of the curled fingers of the pistol pose (measured on a side view of
    # the pose with models/guns/pistol.gltf at its SCAN_FITS offset), along the pose's grip axis
    # l (pinky -> index).
    import numpy as np

    bp = np.array(k2b((0.0, -0.088, 0.034)))
    lv = np.array(k2b((0, 0.95, -0.31)))
    lv /= np.linalg.norm(lv)
    kz = -lv  # knife +Z (pommel) points down/back out of the fist
    fwd = np.array(k2b((0, 0, -1)))
    ky = -(fwd - (fwd @ lv) * lv)
    ky /= np.linalg.norm(ky)  # edge faces forward
    kx = np.cross(ky, kz)
    # The object's mesh is already in Blender coords of knife space: map knife axes (as Blender
    # vectors) onto the hand frame.
    Mk = Matrix((Vector(k2b((1, 0, 0))), Vector(k2b((0, 1, 0))), Vector(k2b((0, 0, 1))))).transposed()
    Mh = Matrix((Vector(kx), Vector(ky), Vector(kz))).transposed()
    knife_ob.matrix_world = Matrix.Translation(Vector(bp)) @ (Mh @ Mk.inverted()).to_4x4()
    return arms


def stage_render() -> None:
    import time

    from mathutils import Vector

    bpy.ops.wm.open_mainfile(filepath=str(BUILD / 'knife.blend'))
    sc = bpy.context.scene
    bpy.data.objects.remove(bpy.data.objects['knife_hi'])
    knife = bpy.data.objects['knife_low']
    knife.data.materials.clear()
    knife.data.materials.append(_knife_material(BUILD / 'maps', os.environ.get('WD_KNIFE_RES', '')))
    for o in bpy.data.objects:
        if o.type == 'EMPTY':
            o.parent = knife
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = int(os.environ.get('WD_KNIFE_SAMPLES', 128))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = 92
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    _studio(sc, ROOT / 'packages/client/public/env/dresden_square.hdr', 0.35)
    bpy.ops.mesh.primitive_plane_add(size=3, location=(0, 0.1, -0.05))
    floor = bpy.context.active_object
    fm = bpy.data.materials.new('floor')
    fm.use_nodes = True
    fb = fm.node_tree.nodes['Principled BSDF']
    fb.inputs['Base Color'].default_value = (0.025, 0.025, 0.028, 1)
    fb.inputs['Roughness'].default_value = 0.55
    floor.data.materials.append(fm)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    c = (0, 0.1, 0)
    key = _area('key', (0.25, -0.1, 0.45), c, 0.5, 5, sy=0.25)
    rim = _area('rim', (-0.35, 0.35, 0.2), c, 0.6, 5, (0.85, 0.9, 1.0), sy=0.06)
    strip = _area('strip', (0.3, 0.12, 0.12), c, 0.6, 2.5, sy=0.05)
    REVIEW.mkdir(parents=True, exist_ok=True)
    only = os.environ.get('WD_KNIFE_SHOTS')

    def wanted(name):
        return not only or name.split('_', 1)[0] in only.split(',')

    def shot(name, loc, target, lens=50, fstop=None, ortho=None, roll=0.0):
        if not wanted(name):
            return
        cam.location = loc
        _look(cam, target, roll)
        cam.data.type = 'ORTHO' if ortho else 'PERSP'
        if ortho:
            cam.data.ortho_scale = ortho
        cam.data.lens = lens
        cam.data.clip_start = 0.005
        cam.data.dof.use_dof = fstop is not None
        if fstop:
            cam.data.dof.aperture_fstop = fstop
            cam.data.dof.focus_distance = math.dist(loc, target)
        sc.render.filepath = str(REVIEW / f'{name}.jpg')
        t0 = time.time()
        bpy.ops.render.render(write_still=True)
        print(f'knife: rendered {name} in {time.time() - t0:.0f} s', flush=True)

    # Blender frame: blade toward +Y, spine +Z, flats +-X; knife centre ~ (0, 0.1, 0).
    shot('01_hero_three_quarter', (0.36, -0.12, 0.2), (0, 0.095, -0.004), lens=62, roll=-0.35)
    shot('02_side_profile', (0.8, 0.103, 0.0), (0, 0.103, 0.0), ortho=0.385)
    shot('03_closeup_etch_damascus', (0.075, 0.105, 0.045), (0.003, 0.15, 0.009), lens=100,
         fstop=16)
    shot('04_closeup_grip_pommel', (0.13, -0.16, 0.08), (0.0, -0.04, 0.0), lens=85, fstop=11)
    if wanted('05_'):
        arms = _load_arms(knife)
        if arms:
            floor.hide_render = True
            g = knife.matrix_world @ Vector((0, 0, 0))
            tip = knife.matrix_world @ Vector(k2b(ANCHORS['knife_tip']))
            mid = g * 0.75 + tip * 0.25
            for li, off in ((key, (0.3, -0.3, 0.4)), (rim, (-0.35, 0.3, 0.25)),
                            (strip, (0.35, 0.1, 0.1))):
                li.location = mid + Vector(off)
                _look(li, mid)
            shot('05_gloved_hand', tuple(mid + Vector((0.40, -0.42, 0.16))), tuple(mid), lens=50)
    print('knife: render stage done', flush=True)


def main_blender(argv: list[str]) -> None:
    stage = argv[0] if argv else 'model'
    if stage == 'model':
        stage_model()
    elif stage == 'render':
        stage_render()
    else:
        raise SystemExit(f'unknown stage {stage}')


if bpy is None and __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    stage = sys.argv[1:2]
    if stage == ['tex']:
        stage_tex()
    elif stage == ['package']:
        stage_package()
    else:
        raise SystemExit(__doc__)

if bpy is not None and __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main_blender(sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else [])
