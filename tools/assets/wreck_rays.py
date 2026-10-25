"""Does a wreck's collision cover what it draws? A grid of axis-aligned rays, cast from outside the
shipped model toward it (±X, ±Z and straight down), each compared at its first mesh hit: the ray
must have met a collision box no later than `tol` past that hit, else a bullet would pass through
visible metal. Pure numpy over the shipped mesh (decoded by raw_models.py).

    python tools/assets/wreck_rays.py [tank_wreck|heli_wreck]   # misses, clustered

The wreck heroes draw their first mesh's geometry as is in the prop's local frame
(render/heroModels.ts `heroGeometry`, the anchor at the prop's origin), so that is the frame the
boxes (props.ts at the origin, rot 0) are compared in.
"""

import json
import sys
from pathlib import Path

import numpy as np

import heli_collision as hc
from raw_models import MODELS, raw_model

HERE = Path(__file__).resolve().parent

DIRS = {'+x': (0, 1.0), '-x': (0, -1.0), '+z': (2, 1.0), '-z': (2, -1.0), 'down': (1, -1.0)}


def mesh_triangles(path: Path) -> np.ndarray:
    """(n, 3, 3) triangles of the model's first mesh, as the client draws it."""
    path = raw_model(path)
    doc = json.loads(path.read_text(encoding='utf-8'))
    blob = (path.parent / doc['buffers'][0]['uri']).read_bytes()

    def acc(i, comps):
        a = doc['accessors'][i]
        v = doc['bufferViews'][a['bufferView']]
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        dt = np.dtype({5126: '<f4', 5125: '<u4', 5123: '<u2'}[a['componentType']])
        stride = v.get('byteStride', dt.itemsize * comps)
        return np.ndarray((a['count'], comps), dtype=dt, buffer=blob, offset=off,
                          strides=(stride, dt.itemsize)).copy()

    tris = []
    for prim in doc['meshes'][0]['primitives']:
        pos = acc(prim['attributes']['POSITION'], 3).astype(np.float64)
        idx = acc(prim['indices'], 1).reshape(-1).astype(np.int64)
        tris.append(pos[idx.reshape(-1, 3)])
    return np.concatenate(tris)


def box_inverse(b):
    """World → unit-cube (±0.5) matrix of a map box {c, s, rot}."""
    return np.linalg.inv(hc.box_matrix(b['c'], b['s'], b.get('rot')))


def first_box_hit(o, d, inv_boxes):
    """Smallest entry distance of rays (o, d: (n, 3)) into any box (slab test in box space)."""
    best = np.full(len(o), np.inf)
    oh = np.c_[o, np.ones(len(o))]
    for inv in inv_boxes:
        lo = oh @ inv.T
        ld = d @ inv[:3, :3].T
        # Per axis the slab interval [near, far]. A ray parallel to a slab (zero direction
        # component) is inside it for all t or for none: (−inf, inf) or a miss. The miss must be
        # decided here, before the intervals combine — min/max of (inf, −inf) would turn it into
        # (−inf, inf) and the slab would be ignored (Codex: false hits on every axis-aligned ray).
        par = ld == 0
        inside = (lo[:, :3] >= -0.5) & (lo[:, :3] <= 0.5)
        safe = np.where(par, 1.0, ld)
        t1 = (-0.5 - lo[:, :3]) / safe
        t2 = (0.5 - lo[:, :3]) / safe
        near = np.where(par, -np.inf, np.minimum(t1, t2))
        far = np.where(par, np.inf, np.maximum(t1, t2))
        tn = near.max(axis=1)
        tf = far.min(axis=1)
        hit = (tn <= tf) & (tf >= 0) & ~(par & ~inside).any(axis=1)
        best = np.where(hit, np.minimum(best, np.maximum(tn, 0)), best)
    return best


def first_mesh_hit(tris, axis, sign, uv, start):
    """First hit along an axis-aligned ray per (u, v) grid point: triangles binned by their
    projected bounds, then an exact 2D barycentric test and the depth along the axis."""
    a0, a1 = [k for k in range(3) if k != axis]
    p = tris[:, :, [a0, a1]]
    lo, hi = p.min(axis=1), p.max(axis=1)
    cell = 0.25
    bins: dict[tuple[int, int], list[int]] = {}
    for i, (l, h) in enumerate(zip(np.floor(lo / cell).astype(int), np.floor(hi / cell).astype(int))):
        for bu in range(l[0], h[0] + 1):
            for bv in range(l[1], h[1] + 1):
                bins.setdefault((bu, bv), []).append(i)
    out = np.full(len(uv), np.inf)
    for r, (u, v) in enumerate(uv):
        cand = bins.get((int(np.floor(u / cell)), int(np.floor(v / cell))))
        if not cand:
            continue
        t = tris[cand]
        q = p[cand]
        e1, e2 = q[:, 1] - q[:, 0], q[:, 2] - q[:, 0]
        w = np.array([u, v]) - q[:, 0]
        den = e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]
        ok = np.abs(den) > 1e-12
        safe = np.where(ok, den, 1.0)  # degenerate (edge-on) triangles: never a hit
        b1 = (w[:, 0] * e2[:, 1] - w[:, 1] * e2[:, 0]) / safe
        b2 = (e1[:, 0] * w[:, 1] - e1[:, 1] * w[:, 0]) / safe
        ok &= (b1 >= 0) & (b2 >= 0) & (b1 + b2 <= 1)
        if not ok.any():
            continue
        depth = t[ok, 0, axis] + b1[ok] * (t[ok, 1, axis] - t[ok, 0, axis]) + b2[ok] * (t[ok, 2, axis] - t[ok, 0, axis])
        out[r] = ((depth - start) * sign).min()
    return out


# Gate parameters (test_wreck_rays.py): a 10 cm grid; a box must meet each ray no later than TOL
# past its first mesh hit (forward), and the mesh no later than RTOL past each first box hit
# (reverse: no invisible metal). Hits below GROUND are skipped (debris on the ground, the part of
# a wreck sunk into it: the ground stops those shots anyway).
SPACING, TOL, RTOL, GROUND = 0.1, 0.1, 0.15, 0.25


def ray_grid(tris, spacing=SPACING):
    """Every grid ray from outside the mesh's bounds toward it, all five directions:
    (dir names, origins (n, 3), directions (n, 3), first mesh hit distance (n,), inf = none)."""
    mn, mx = tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0)
    names, os_, ds, tms = [], [], [], []
    for name, (axis, sign) in DIRS.items():
        a0, a1 = [k for k in range(3) if k != axis]
        us = np.arange(mn[a0] + spacing / 2, mx[a0], spacing)
        vs = np.arange(mn[a1] + spacing / 2, mx[a1], spacing)
        uv = np.array([(u, v) for u in us for v in vs])
        start = (mn[axis] - 1.0) if sign > 0 else (mx[axis] + 1.0)
        o = np.zeros((len(uv), 3))
        o[:, a0], o[:, a1], o[:, axis] = uv[:, 0], uv[:, 1], start
        d = np.zeros((len(uv), 3))
        d[:, axis] = sign
        names += [name] * len(uv)
        os_.append(o)
        ds.append(d)
        tms.append(first_mesh_hit(tris, axis, sign, uv, start))
    return names, np.concatenate(os_), np.concatenate(ds), np.concatenate(tms)


def evaluate(o, d, tm, tb, skip=None):
    """Forward misses and reverse violations of box hits `tb` against mesh hits `tm`.
    `skip(points) -> mask` drops mesh hits that need no box (e.g. inside an enterable cabin)."""
    def y(t):
        return o[:, 1] + d[:, 1] * np.where(np.isfinite(t), t, 0.0)
    mesh = np.isfinite(tm) & (y(tm) >= GROUND)
    if skip is not None:
        mesh &= ~skip(o + d * np.where(np.isfinite(tm), tm, 0.0)[:, None])
    box = np.isfinite(tb) & (y(tb) >= GROUND)
    fwd = mesh & ~(tb <= tm + TOL)
    rev = box & ~(tm <= tb + RTOL)
    return {'mesh': int(mesh.sum()), 'box': int(box.sum()), 'fwd': fwd, 'rev': rev}


def rapier_hits(kind, o, d, *, box_only=False):
    """First hit distance of each ray against the wreck in Rapier
    (wreck_rays_rapier.ts through the server's tsx), inf where nothing is hit."""
    import subprocess
    import tempfile
    rays = np.c_[o, d].round(6).tolist()
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(rays, f)
    root = HERE.parents[1]
    tsx = root / 'packages/server/node_modules/tsx/dist/cli.mjs'
    try:
        mode = f'box-{kind}' if box_only else kind
        res = subprocess.run(['node', str(tsx), str(HERE / 'wreck_rays_rapier.ts'), mode, f.name],
                             cwd=root, capture_output=True, text=True, check=True)
    finally:
        Path(f.name).unlink()
    hits = json.loads(res.stdout)['hits']
    return np.array([np.inf if h is None else h for h in hits], dtype=float)


def rapier_box_hits(kind, o, d):
    """Direct Rapier cuboids for the shipped movement boxes; checks the Python slab gate."""
    return rapier_hits(kind, o, d, box_only=True)


def rapier_world_hits(kind, o, d):
    """Gameplay PhysicsWorld hits: wreck boxes for movement, visible ray mesh for shots/LOS."""
    return rapier_hits(kind, o, d, box_only=False)


def ray_misses(tris, boxes, spacing=SPACING, tol=TOL, ground=GROUND):
    """Forward misses only, as (rays hitting the mesh, [(dir, point)]) — kept for quick looks."""
    names, o, d, tm = ray_grid(tris, spacing)
    tb = first_box_hit(o, d, [box_inverse(b) for b in boxes])
    r = evaluate(o, d, tm, tb)
    return r['mesh'], [(names[k], o[k] + d[k] * tm[k]) for k in np.nonzero(r['fwd'])[0]]


RAY_MESH = HERE.parents[1] / 'packages/shared/src/maps/wreckGeometry.gen.json'


def ray_mesh(mid):
    """The wreck's shipped ray mesh (build_wreck_collision.py) as (n, 3, 3) triangles, decoded the
    way the game decodes it."""
    from build_wreck_collision import decode
    pos, idx = decode(json.loads(RAY_MESH.read_text(encoding='utf-8'))['models'][mid])
    return pos[idx]


def mesh_hits(tris, names, o):
    """First hit of every grid ray (from ray_grid) against a triangle set."""
    out = np.full(len(o), np.inf)
    names = np.array(names)
    for name, (axis, sign) in DIRS.items():
        k = names == name
        if not k.any():
            continue
        a0, a1 = [j for j in range(3) if j != axis]
        out[k] = first_mesh_hit(tris, axis, sign, o[k][:, [a0, a1]], o[k][0, axis])
    return out


def tank_boxes():
    from vehicle_spec import WRECK_BOXES
    return list(WRECK_BOXES['tank'].values())


def heli_boxes():
    cfg = json.loads(hc.CFG.read_text(encoding='utf-8'))
    return list(hc.boxes(cfg).values())


WRECKS = {'tank_wreck': tank_boxes, 'heli_wreck': heli_boxes}
SKIPS: dict = {}


def collision_boxes(kind):
    """The shipped collision of a wreck ('heli' | 'tank' | its model id) as {c, s, rot} dicts in
    props.ts order — the one source for the ray test and the render overlay (render_vehicles.py)."""
    return WRECKS[{'heli': 'heli_wreck', 'tank': 'tank_wreck'}.get(kind, kind)]()


def clusters(misses, cell=0.5):
    """Misses grouped by direction and a coarse cell, largest first: (dir, centre, count)."""
    groups: dict[tuple, list] = {}
    for name, p in misses:
        groups.setdefault((name, *np.floor(p / cell).astype(int)), []).append(p)
    out = [(k[0], np.mean(v, axis=0), len(v)) for k, v in groups.items()]
    return sorted(out, key=lambda g: -g[2])


def report(mid):
    tris = mesh_triangles(MODELS / f'vehicles/{mid}.gltf')
    names, o, d, tm = ray_grid(tris)
    boxes = WRECKS[mid]()
    py = first_box_hit(o, d, [box_inverse(b) for b in boxes])
    ra = rapier_box_hits(mid.split('_')[0], o, d)
    agree = int((np.isfinite(py) != np.isfinite(ra)).sum() + (np.abs(np.where(np.isfinite(py) & np.isfinite(ra), py, 0) - np.where(np.isfinite(py) & np.isfinite(ra), ra, 0)) > 0.01).sum())
    out = {}
    for src, tb in (('python', py), ('rapier', ra)):
        r = evaluate(o, d, tm, tb, SKIPS.get(mid))
        out[src] = r
        print(f"{mid} [{src}] {len(boxes)} boxes: forward {r['fwd'].sum()} / {r['mesh']} "
              f"({100 * r['fwd'].sum() / max(r['mesh'], 1):.2f} %), reverse {r['rev'].sum()} / {r['box']} "
              f"({100 * r['rev'].sum() / max(r['box'], 1):.2f} %)")
    print(f'{mid}: python vs rapier disagree on {agree} / {len(o)} rays')
    r = out['rapier']
    for label, mask, t in (('forward', r['fwd'], tm), ('reverse', r['rev'], ra)):
        pts = [(names[k], o[k] + d[k] * t[k]) for k in np.nonzero(mask)[0]]
        for name, c, n in clusters(pts)[:12]:
            print(f'  {label} {name:5s} {n:4d} near ({c[0]:+.2f}, {c[1]:+.2f}, {c[2]:+.2f})')
    return out, agree


def main():
    for mid in sys.argv[1:] or list(WRECKS):
        report(mid)


if __name__ == '__main__':
    main()
