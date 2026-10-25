"""Build the first-person gun models (Higgsfield/Tripo, Kiran-approved) into gun space.

    python tools/assets/build_viewguns.py [--preview DIR] [--only a,b]
    python tools/assets/build_viewguns.py --parts [--only a,b]   # re-split the shipped meshes

Reads tools/assets/raw/higgsfield/gun_<id>.glb (WD_RAW overrides tools/assets/raw) and writes
packages/client/public/models/guns/:

- <id>.gltf + .bin  the mesh in the viewmodel's gun space: bore along -Z, +Y up, metres at the
                    weapon's real length, simplified to a budget; origin at the bounding-box
                    centre (the client places it by its measured anchors). One node per piece:
                    the body (named <id>) first, then the moving parts cut out of it by
                    measured regions (PARTS: magazine, bolt, pump, cell, vent cover) for the
                    reload/handling animations, with hidden fillers so nothing reads hollow.
- <id>_{albedo,normal,arm}.webp  1024 px textures (the gun is the closest object on screen),
                    WebP as faithful as the old JPEG (tools/assets/webp.py).
- guns.json         per gun: triangles, bbox min/max, and per part its anchors (pivot, axis),
                    triangles and bbox.

With --preview, also writes side-view silhouettes with a 1 cm grid (to measure the anchors:
bore line, sight centre, grips) into DIR. Deterministic; logged in ASSETS.md.
"""

import argparse
import os
import sys
import json
import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

import decimate
from webp import save_webp
from build_heroes import accessor, gltf, image, read_glb
from build_models import json_text

ROOT = Path(__file__).resolve().parents[2]
RAW = Path(os.environ.get('WD_RAW', ROOT / 'tools/assets/raw')) / 'higgsfield'
OUT = ROOT / 'packages/client/public/models/guns'


@dataclass(frozen=True)
class GunSpec:
    length: float
    """Real overall length (m) along the bore."""
    target: int
    """Triangle budget."""
    flip: bool = False
    """Turn 180° about Y (muzzle to -Z) when the principal axis points the other way."""
    roll: float = 0.0
    """Rotation about the bore (degrees) so the sight is up."""
    pitch: float = 0.0
    """Rotation about X (degrees, before the flip) levelling a model generated tilted."""
    cut: tuple[float, float, float] | None = None
    """Drop triangles below y = cut[0] with z in [cut[1], cut[2]] (final gun space, metres): e.g.
    a deployed bipod the generation added."""


GUNS: dict[str, GunSpec] = {
    # Generated muzzle-high by ~8° and facing +Z. (The knife scan came out diagonal: the knife
    # stays procedural.)
    'rifle': GunSpec(0.84, 14000, flip=True, pitch=7.8),
    'pistol': GunSpec(0.19, 9000, flip=True),
    'coil': GunSpec(1.02, 14000),
    'iskra': GunSpec(0.62, 12000),
    'shotgun': GunSpec(0.98, 12000),
    # Generated muzzle toward +Z, bipod deployed: flip it and cut the legs off.
    'marksman': GunSpec(1.1, 14000, flip=True, cut=(-0.075, -0.45, -0.22)),
    'arc': GunSpec(0.85, 14000),
}


@dataclass(frozen=True)
class PartSpec:
    """A moving part cut out of a scan (magazine, bolt, pump, cell, vent cover) for the reload and
    handling animations (client render/fpAnims.ts). Everything in the built mesh's own coordinates
    (bounding-box centred, before SCAN_FITS.offset), measured from side views, top views and
    cross-sections of the mesh (tools/_gunparts probes; see the comments per gun)."""

    box: tuple[float, float, float, float, float, float]
    """Triangles whose centroid lies in (x0, x1, y0, y1, z0, z1) belong to the part…"""
    outer: float = 0.0
    """…and, if > 0, only those with |x| ≥ outer (levers on both sides of a receiver)."""
    pivot: tuple[float, float, float] = (0.0, 0.0, 0.0)
    """Anchor: the magazine's feed-lip centre at the well mouth, a lever's grab point, a cover's
    hinge. The client moves the part relative to it (and the hand holds it there)."""
    axis: tuple[float, float, float] = (0.0, -1.0, 0.0)
    """Travel direction: out of the well for a magazine/cell, rearward for bolts and pumps; for a
    hinged cover, the hinge line."""
    ext: tuple[float, float, float] | None = None
    """(half width x, half depth, length): the part's hidden continuation into the gun (feed lips,
    the pistol magazine inside the grip), a box from the pivot back along -axis. The scan only has
    the outside, so without it a pulled magazine is an open shell."""
    cap: bool = False
    """Dark plug across the well mouth in the body (seen once the part is out)."""
    tubes: tuple[tuple[float, float, float, float, float], ...] = ()
    """Body fillers revealed when the part slides: octagonal prisms along z (x, y, r, z0, z1),
    e.g. the shotgun's magazine tube and barrel under the pump, the pistol barrel under the slide."""


PARTS: dict[str, dict[str, PartSpec]] = {
    # Side view: the magazine hangs below the well mouth (y 0.0) at z -0.08..-0.02, slanting
    # forward to z -0.105 at the floor plate (y -0.18); the z -0.05 cross-section shows it as its
    # own shell (x ±0.013). Charging handle: the T latch at the rear of the upper (top view: wings to
    # x ±0.025 at z 0.115–0.13; side view y 0.105–0.13).
    'rifle': {
        'mag': PartSpec((-0.03, 0.03, -0.2, 0.0, -0.125, -0.005), pivot=(0.0, 0.0, -0.047),
                        axis=(0.0, -0.986, -0.165), ext=(0.012, 0.03, 0.03), cap=True),
        'bolt': PartSpec((-0.035, 0.035, 0.103, 0.14, 0.11, 0.146), pivot=(0.0, 0.118, 0.13),
                         axis=(0.0, 0.0, 1.0)),
    },
    # Slide: everything above the slide/frame line (y 0.036 at the muzzle rising to 0.042 at the
    # rear, side view); the barrel (bore y 0.056 in mesh space) is only a filler under it. Magazine:
    # the scan shows only the floor plate below the grip (y < -0.061, z 0.04–0.095); the body inside
    # the grip is the extension box along the grip's rake.
    'pistol': {
        'slide': PartSpec((-0.03, 0.03, 0.041, 0.1, -0.1, 0.1), pivot=(0.0, 0.07, 0.07),
                          axis=(0.0, 0.0, 1.0), tubes=((0.0, 0.056, 0.0065, -0.094, -0.03),)),
        'mag': PartSpec((-0.03, 0.03, -0.09, -0.0605, 0.035, 0.1), pivot=(0.0, -0.062, 0.066),
                        axis=(0.0, -0.985, 0.17), ext=(0.0105, 0.016, 0.075), cap=True),
    },
    # Power cell: the box under the receiver ahead of the trigger (z -0.105..0.035), below the
    # neck at y -0.028 (z -0.04 cross-section: neck x ±0.02, cell x ±0.035 down to y -0.107).
    'coil': {
        'cell': PartSpec((-0.05, 0.05, -0.12, -0.028, -0.11, 0.04), pivot=(0.0, -0.028, -0.035),
                         axis=(0.0, -1.0, 0.0), ext=(0.018, 0.06, 0.02), cap=True),
    },
    # Magazine: below the short well (y 0.005) at z -0.2..-0.02, raked back (top z -0.075, floor
    # plate z -0.125 at y -0.155); z -0.08 cross-section x ±0.015. Cocking levers: both sides at
    # z 0.045–0.075, y 0.065–0.09, out to x ±0.06 (top view and the z 0.06 cross-section).
    'iskra': {
        'mag': PartSpec((-0.03, 0.03, -0.2, 0.004, -0.2, -0.02), pivot=(0.0, 0.004, -0.075),
                        axis=(0.0, -0.949, -0.316), ext=(0.013, 0.03, 0.03), cap=True),
        'bolt': PartSpec((-0.07, 0.07, 0.062, 0.095, 0.04, 0.08), outer=0.03,
                         pivot=(0.0, 0.078, 0.06), axis=(0.0, 0.0, 1.0)),
    },
    # Pump: the forend under the barrel, z -0.215..-0.045, y < 0.064 (z -0.15/-0.08 sections: barrel
    # circle on top, forend x ±0.03 y 0.018–0.066). Revealed when racked: the magazine tube (the
    # z -0.35 section: r 0.0135 at y 0.044) and the barrel's underside (r 0.021 at y 0.078).
    'shotgun': {
        'pump': PartSpec((-0.05, 0.05, 0.0, 0.064, -0.215, -0.045), pivot=(0.0, 0.03, -0.13),
                         axis=(0.0, 0.0, 1.0),
                         tubes=((0.0, 0.044, 0.0135, -0.225, -0.035), (0.0, 0.078, 0.02, -0.225, -0.035))),
    },
    # Magazine: straight down below the well step (y -0.008) at z -0.01..0.08 (z 0.04 section:
    # x ±0.02). Bolt levers: the diamond wings at z 0.2–0.23, y 0.03–0.05, out to x ±0.05.
    'marksman': {
        'mag': PartSpec((-0.03, 0.03, -0.15, -0.008, -0.02, 0.09), pivot=(0.0, -0.008, 0.035),
                        axis=(0.0, -1.0, 0.0), ext=(0.017, 0.038, 0.03), cap=True),
        'bolt': PartSpec((-0.07, 0.07, 0.025, 0.056, 0.195, 0.24), outer=0.028,
                         pivot=(0.0, 0.04, 0.215), axis=(0.0, 0.0, 1.0)),
    },
    # Heat-vent cover: the right-hand handguard panel (z -0.22..-0.07, y 0.06–0.125, x > 0.025 on
    # the z -0.12 section), hinged along its top edge; it swings out to vent on an overheat.
    'arc': {
        'vent': PartSpec((0.025, 0.07, 0.06, 0.125, -0.22, -0.07), pivot=(0.036, 0.125, -0.145),
                         axis=(0.0, 0.0, 1.0),
                         tubes=((0.012, 0.092, 0.024, -0.215, -0.075),)),
    },
}


def _dark_uv(verts: list, albedo: Image.Image | None) -> tuple[float, float]:
    """UV of a dark texel under the given vertices (15th luminance percentile), so generated
    fillers read as shadowed metal in the gun's own texture (same material, no new program)."""
    if albedo is None or not verts:
        return (verts[0][6], verts[0][7]) if verts else (0.0, 0.0)
    W, H = albedo.size
    px = albedo.convert('L').load()
    lum = sorted(
        (px[min(W - 1, max(0, int(v[6] * W))), min(H - 1, max(0, int(v[7] * H)))], i)
        for i, v in enumerate(verts)
    )
    v = verts[lum[len(lum) * 15 // 100][1]]
    return (v[6], v[7])


def _box(center, ax_u, ax_v, ax_w, hu, hv, w0, w1, uv) -> tuple[list, list]:
    """Closed box: centre + half extents along u/v, from w0 to w1 along w (unit axes)."""
    verts, tris = [], []
    add = lambda a, b: [c + d for c, d in zip(a, b)]  # noqa: E731
    sc = lambda a, k: [c * k for c in a]  # noqa: E731
    corner = lambda su, sv, w: add(add(add(center, sc(ax_u, su * hu)), sc(ax_v, sv * hv)), sc(ax_w, w))  # noqa: E731
    faces = [  # (normal, 4 corners CCW seen from outside)
        (ax_w, [(-1, -1, w1), (1, -1, w1), (1, 1, w1), (-1, 1, w1)]),
        (sc(ax_w, -1), [(-1, 1, w0), (1, 1, w0), (1, -1, w0), (-1, -1, w0)]),
        (ax_u, [(1, -1, w0), (1, 1, w0), (1, 1, w1), (1, -1, w1)]),
        (sc(ax_u, -1), [(-1, -1, w1), (-1, 1, w1), (-1, 1, w0), (-1, -1, w0)]),
        (ax_v, [(-1, 1, w1), (1, 1, w1), (1, 1, w0), (-1, 1, w0)]),
        (sc(ax_v, -1), [(-1, -1, w0), (1, -1, w0), (1, -1, w1), (-1, -1, w1)]),
    ]
    for n, quad in faces:
        base = len(verts)
        for su, sv, w in quad:
            verts.append((*corner(su, sv, w), *n, *uv))
        tris += _facing([(base, base + 1, base + 2), (base, base + 2, base + 3)], verts, n)
    return verts, tris


def _facing(tris, verts, n) -> list:
    """Wind each triangle so its geometric normal agrees with n (front faces outward)."""
    out = []
    for a, b, c in tris:
        pa, pb, pc = (verts[i][:3] for i in (a, b, c))
        e1 = [pb[k] - pa[k] for k in range(3)]
        e2 = [pc[k] - pa[k] for k in range(3)]
        cr = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
        out.append((a, b, c) if sum(cr[k] * n[k] for k in range(3)) >= 0 else (a, c, b))
    return out


def _tube(x, y, r, z0, z1, uv) -> tuple[list, list]:
    """Octagonal prism along z with end caps (flat-shaded sides would facet: smooth normals)."""
    verts, tris = [], []
    k = 8
    for i in range(k):
        a0, a1 = 2 * math.pi * i / k, 2 * math.pi * (i + 1) / k
        base = len(verts)
        for a, z in ((a0, z0), (a1, z0), (a1, z1), (a0, z1)):
            n = (math.cos(a), math.sin(a), 0.0)
            verts.append((x + r * n[0], y + r * n[1], z, *n, *uv))
        mid = (math.cos((a0 + a1) / 2), math.sin((a0 + a1) / 2), 0.0)
        tris += _facing([(base, base + 1, base + 2), (base, base + 2, base + 3)], verts, mid)
    for z, nz in ((z0, -1.0), (z1, 1.0)):
        base = len(verts)
        verts.append((x, y, z, 0.0, 0.0, nz, *uv))
        for i in range(k):
            a = 2 * math.pi * i / k
            verts.append((x + r * math.cos(a), y + r * math.sin(a), z, 0.0, 0.0, nz, *uv))
        tris += _facing([(base, base + 1 + i, base + 1 + (i + 1) % k) for i in range(k)], verts, (0, 0, nz))
    return verts, tris


def _frame(axis) -> tuple[list, list, list]:
    """(u, v, w): w = -axis (into the gun), u ⟂ w in the x/z plane where possible, v = w × u."""
    w = [-c for c in axis]
    nw = math.sqrt(sum(c * c for c in w))
    w = [c / nw for c in w]
    u = [1.0, 0.0, 0.0]
    d = sum(u[k] * w[k] for k in range(3))
    u = [u[k] - w[k] * d for k in range(3)]
    nu = math.sqrt(sum(c * c for c in u))
    u = [c / nu for c in u]
    v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]]
    return u, v, w


def in_part(spec: PartSpec, c) -> bool:
    x0, x1, y0, y1, z0, z1 = spec.box
    return (x0 <= c[0] <= x1 and y0 <= c[1] <= y1 and z0 <= c[2] <= z1
            and (spec.outer <= 0 or abs(c[0]) >= spec.outer))


def split_parts(gid: str, verts: list, tris: list, albedo: Image.Image | None = None) -> list:
    """[(name, verts, tris)]: the body first (named after the gun, with its fillers), then each part
    (with its extension). Every scan triangle lands in exactly one of them."""
    specs = PARTS.get(gid, {})
    groups: dict[str, list] = {gid: []}
    for name in specs:
        groups[name] = []
    for t in tris:
        c = [sum(verts[i][k] for i in t) / 3 for k in range(3)]
        owner = next((n for n, s in specs.items() if in_part(s, c)), gid)
        groups[owner].append(t)
    out = []
    for name, ts in groups.items():
        remap: dict[int, int] = {}
        pv = []
        pt = []
        for t in ts:
            for i in t:
                if i not in remap:
                    remap[i] = len(pv)
                    pv.append(verts[i])
            pt.append(tuple(remap[i] for i in t))
        out.append([name, pv, pt])
    body = out[0]
    for (name, pv, pt), spec in zip(out[1:], specs.values()):
        if not pt:
            raise SystemExit(f'{gid}.{name}: no triangles in {spec.box}')
        uv = _dark_uv(pv, albedo)
        u, v, w = _frame(spec.axis)
        if spec.ext:
            hu, hv, length = spec.ext
            ev, et = _box(list(spec.pivot), u, v, w, hu, hv, -0.002, length, uv)
            n = len(pv)
            pv += ev
            pt += [tuple(i + n for i in t) for t in et]
        extra_v, extra_t = [], []
        if spec.cap and spec.ext:
            hu, hv, _ = spec.ext
            # A thin dark plate just inside the mouth (hidden by the seated part's extension).
            ev, et = _box(list(spec.pivot), u, v, w, hu + 0.002, hv + 0.002, 0.004, 0.007, uv)
            extra_v.append(ev)
            extra_t.append(et)
        for tube in spec.tubes:
            ev, et = _tube(*tube, uv)
            extra_v.append(ev)
            extra_t.append(et)
        for ev, et in zip(extra_v, extra_t):
            n = len(body[1])
            body[1] += ev
            body[2] += [tuple(i + n for i in t) for t in et]
    return [tuple(p) for p in out]


def gltf_parts(gid: str, parts: list) -> tuple[dict, bytes]:
    """One glTF, one mesh + node per part (body first), each with its own accessors."""
    doc, blob = None, b''
    for k, (name, verts, tris) in enumerate(parts):
        d, b = gltf(name, verts, tris)
        if doc is None:
            doc = {**d, 'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': []}
        base_view = len(doc['bufferViews'])
        base_acc = len(doc['accessors'])
        for view in d['bufferViews']:
            doc['bufferViews'].append({**view, 'byteOffset': view['byteOffset'] + len(blob)})
        for acc in d['accessors']:
            doc['accessors'].append({**acc, 'bufferView': acc['bufferView'] + base_view})
        prim = d['meshes'][0]['primitives'][0]
        doc['meshes'].append({'name': name, 'primitives': [{
            'attributes': {a: i + base_acc for a, i in prim['attributes'].items()},
            'indices': prim['indices'] + base_acc}]})
        doc['nodes'].append({'mesh': k, 'name': name})
        blob += b + b'\0' * (-len(b) % 4)
    doc['scenes'] = [{'nodes': list(range(len(parts)))}]
    doc['buffers'] = [{'uri': f'{gid}.bin', 'byteLength': len(blob)}]
    return doc, blob


def part_manifest(gid: str, parts: list) -> dict:
    """Per part: anchors (pivot, axis) and the measured bbox/triangles of what was cut."""
    out = {}
    for (name, verts, tris), spec in zip(parts[1:], PARTS.get(gid, {}).values()):
        out[name] = {
            'pivot': [round(c, 4) for c in spec.pivot],
            'axis': [round(c, 4) for c in spec.axis],
            'triangles': len(tris),
            'min': [round(min(v[i] for v in verts), 4) for i in range(3)],
            'max': [round(max(v[i] for v in verts), 4) for i in range(3)],
        }
    return out


def principal_frame(pos):
    """Unit axes: the longest horizontal extent → Z (bore), the rest keep their sense."""
    xs = [p[0] for p in pos]
    ys = [p[1] for p in pos]
    zs = [p[2] for p in pos]
    ext = [max(v) - min(v) for v in (xs, ys, zs)]
    return ext.index(max(ext)), ext


def build(preview: Path | None) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # --only rebuilds merge into the existing manifest (the other guns stay listed).
    old = OUT / 'guns.json'
    manifest: dict = json.loads(old.read_text()) if old.exists() else {'guns': {}}
    only = set(sys.argv[sys.argv.index('--only') + 1].split(',')) if '--only' in sys.argv else None
    for gid, spec in GUNS.items():
        if only and gid not in only:
            continue
        doc, blob = read_glb(RAW / f'gun_{gid}.glb')
        prim = doc['meshes'][0]['primitives'][0]
        pos = accessor(doc, blob, prim['attributes']['POSITION'])
        nor = accessor(doc, blob, prim['attributes']['NORMAL'])
        uvs = accessor(doc, blob, prim['attributes']['TEXCOORD_0'])
        idx = [i[0] for i in accessor(doc, blob, prim['indices'])]
        axis, ext = principal_frame(pos)
        # Permute so the longest axis becomes Z and Y stays up when possible.
        if axis == 0:  # X long: (x, y, z) -> (z, y, -x)... bore along X becomes -Z/+Z
            perm = lambda v: (-v[2], v[1], v[0])  # noqa: E731
        elif axis == 1:  # Y long (generated lying on its side): rotate about X
            perm = lambda v: (v[0], -v[2], v[1])  # noqa: E731
        else:
            perm = lambda v: v  # noqa: E731
        pos = [perm(p) for p in pos]
        nor = [perm(n) for n in nor]
        if spec.pitch:
            c, s = math.cos(math.radians(spec.pitch)), math.sin(math.radians(spec.pitch))
            pos = [(p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c) for p in pos]
            nor = [(n[0], n[1] * c - n[2] * s, n[1] * s + n[2] * c) for n in nor]
        if spec.flip:
            pos = [(-p[0], p[1], -p[2]) for p in pos]
            nor = [(-n[0], n[1], -n[2]) for n in nor]
        if spec.roll:
            c, s = math.cos(math.radians(spec.roll)), math.sin(math.radians(spec.roll))
            pos = [(p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]) for p in pos]
            nor = [(n[0] * c - n[1] * s, n[0] * s + n[1] * c, n[2]) for n in nor]
        zlen = max(p[2] for p in pos) - min(p[2] for p in pos)
        k = spec.length / zlen
        lo = [min(p[i] for p in pos) for i in range(3)]
        hi = [max(p[i] for p in pos) for i in range(3)]
        c = [(lo[i] + hi[i]) / 2 for i in range(3)]
        verts = [
            ((p[0] - c[0]) * k, (p[1] - c[1]) * k, (p[2] - c[2]) * k, n[0], n[1], n[2], t[0], t[1])
            for p, n, t in zip(pos, nor, uvs)
        ]
        tris = [tuple(idx[i : i + 3]) for i in range(0, len(idx), 3)]
        if spec.cut:
            y_max, z0, z1 = spec.cut
            def below(t):
                cy = sum(verts[i][1] for i in t) / 3
                cz = sum(verts[i][2] for i in t) / 3
                return cy < y_max and z0 <= cz <= z1
            tris = [t for t in tris if not below(t)]
        before = len(tris)
        verts, tris = decimate.simplify(verts, tris, spec.target)
        mat = doc['materials'][prim.get('material', 0)]
        pbr = mat['pbrMetallicRoughness']
        tex = lambda info: doc['textures'][info['index']]['source']  # noqa: E731
        albedo = image(doc, blob, tex(pbr['baseColorTexture'])).convert('RGB')
        write_parts(gid, verts, tris, albedo, manifest)
        for name, img in (
            ('albedo', image(doc, blob, tex(pbr['baseColorTexture'])).convert('RGB')),
            ('arm', image(doc, blob, tex(pbr['metallicRoughnessTexture'])).convert('RGB')),
            ('normal', image(doc, blob, tex(mat['normalTexture'])).convert('RGB')),
        ):
            save_webp(
                img.resize((1024, 1024), Image.Resampling.LANCZOS),
                OUT / f'{gid}_{name}.webp',
                'color' if name == 'albedo' else 'data',
                match_jpeg=90 if name == 'normal' else 86,
            )
        blo, bhi = manifest['guns'][gid]['min'], manifest['guns'][gid]['max']
        print(f'{gid:7s} {before:6d} -> {len(tris):5d} tris  min {blo}  max {bhi}')
        if preview:
            side(verts, tris, preview / f'gun_{gid}_side.png', blo, bhi)
    (OUT / 'guns.json').write_text(json_text(manifest) + '\n', encoding='utf-8', newline='\n')


def write_parts(gid: str, verts: list, tris: list, albedo: Image.Image | None, manifest: dict) -> None:
    """Split the scan into body + moving parts and write <gid>.gltf/.bin + its manifest entry."""
    parts = split_parts(gid, verts, tris, albedo)
    gdoc, gblob = gltf_parts(gid, parts)
    (OUT / f'{gid}.bin').write_bytes(gblob)
    (OUT / f'{gid}.gltf').write_text(json_text(gdoc) + '\n', encoding='utf-8', newline='\n')
    entry = {
        'triangles': len(tris),
        # Hidden continuations/fillers the split generates (magazine feed lips, tubes, plugs).
        'generatedTriangles': sum(len(p[2]) for p in parts) - len(tris),
        # The scan's bounds (fillers and extensions stay inside them).
        'min': [round(min(v[i] for v in verts), 4) for i in range(3)],
        'max': [round(max(v[i] for v in verts), 4) for i in range(3)],
    }
    if len(parts) > 1:
        entry['parts'] = part_manifest(gid, parts)
    manifest['guns'][gid] = entry


SPLIT_SRC = ROOT / 'tools/assets/build/viewguns'
"""--parts keeps each gun's unsplit shipped mesh here (git-ignored) so the split can be re-run."""


def parts_only() -> None:
    """Re-split the shipped (decimated) meshes without the raw scans: the first run stashes each
    unsplit mesh in SPLIT_SRC, later runs start from that copy. Textures stay untouched."""
    from raw_models import raw_model  # noqa: PLC0415

    SPLIT_SRC.mkdir(parents=True, exist_ok=True)
    manifest: dict = json.loads((OUT / 'guns.json').read_text())
    only = set(sys.argv[sys.argv.index('--only') + 1].split(',')) if '--only' in sys.argv else None
    for gid in GUNS:
        if only and gid not in only:
            continue
        src = SPLIT_SRC / f'{gid}.json'
        if not src.exists():
            path = raw_model(OUT / f'{gid}.gltf')
            doc = json.loads(path.read_text())
            if len(doc['meshes']) != 1:
                raise SystemExit(f'{gid}: already split and no stashed source; rebuild from the raw scan')
            b = (path.parent / doc['buffers'][0]['uri']).read_bytes()
            prim = doc['meshes'][0]['primitives'][0]
            pos = accessor(doc, b, prim['attributes']['POSITION'])
            nor = accessor(doc, b, prim['attributes']['NORMAL'])
            uvs = accessor(doc, b, prim['attributes']['TEXCOORD_0'])
            idx = [i[0] for i in accessor(doc, b, prim['indices'])]
            src.write_text(json.dumps({
                'verts': [(*p, *n, *t) for p, n, t in zip(pos, nor, uvs)],
                'tris': [idx[i : i + 3] for i in range(0, len(idx), 3)]}))
        data = json.loads(src.read_text())
        verts = [tuple(v) for v in data['verts']]
        tris = [tuple(t) for t in data['tris']]
        albedo = Image.open(OUT / f'{gid}_albedo.webp').convert('RGB')
        write_parts(gid, verts, tris, albedo, manifest)
        print(gid, {k: v['triangles'] for k, v in manifest['guns'][gid].get('parts', {}).items()})
    (OUT / 'guns.json').write_text(json_text(manifest) + '\n', encoding='utf-8', newline='\n')


def side(verts, tris, path: Path, lo, hi) -> None:
    """Silhouette seen from +X (Z right-to-left = muzzle on the left), 1 cm grid, 5 px/mm... ."""
    ppm = 1400 / max(hi[2] - lo[2], 0.2)
    W = int((hi[2] - lo[2]) * ppm) + 40
    H = int((hi[1] - lo[1]) * ppm) + 40
    im = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(im)
    X = lambda z: 20 + (z - lo[2]) * ppm  # noqa: E731
    Y = lambda y: H - 20 - (y - lo[1]) * ppm  # noqa: E731
    for t in tris:
        pts = [(X(verts[i][2]), Y(verts[i][1])) for i in t]
        d.polygon(pts, fill=(90, 90, 90))
    step = 0.01
    z = math.floor(lo[2] / step) * step
    while z <= hi[2]:
        major = abs(round(z / 0.05) * 0.05 - z) < 1e-6
        d.line([(X(z), 0), (X(z), H)], fill=(255, 0, 0) if major else (255, 200, 200))
        if major:
            d.text((X(z) + 2, 2), f'{z:+.2f}', fill=(200, 0, 0))
        z += step
    y = math.floor(lo[1] / step) * step
    while y <= hi[1]:
        major = abs(round(y / 0.05) * 0.05 - y) < 1e-6
        d.line([(0, Y(y)), (W, Y(y))], fill=(0, 0, 255) if major else (200, 200, 255))
        if major:
            d.text((2, Y(y) - 12), f'{y:+.2f}', fill=(0, 0, 200))
        y += step
    im.save(path)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', type=Path)
    ap.add_argument('--only')
    ap.add_argument('--parts', action='store_true', help='re-split the shipped meshes only')
    a = ap.parse_args()
    if a.parts:
        parts_only()
    else:
        build(a.preview)
