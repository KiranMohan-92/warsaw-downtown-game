"""Fit a wreck's collision boxes to its shipped mesh, measured the way the gate measures them
(wreck_rays.py: outside-in axis rays, a box at every visible surface, no box where a ray passes
freely). Pure numpy.

    python tools/assets/wreck_fit.py tank_wreck|heli_wreck [--max 40] [--write]

1. Voxelize the mesh's depth hull in the prop frame (H = 5 cm): a voxel is in the hull when, along
   each axis, it lies between the first mesh hits from both sides. Every surface a test ray sees
   is on the hull's boundary, and every voxel outside it is space some axis ray passes through.
2. Allowed = the hull grown by ALLOW_GROW (a box may stand that far proud of the skin; the gate's
   reverse tolerance is 15 cm), minus any gameplay-free volume (the enterable helicopter cabin).
   Required = the hull voxels each test direction sees first (above the ground skip), plus any
   gameplay surfaces (the cabin floor).
3. Greedy: in each frame (the wreck's part rotations), boxes grown from seeds to maximal within
   the allowed set; the box covering the most still-uncovered required voxels is taken, until the
   budget or the coverage target is reached.

--write stores the result in vehicle_configs/wreck_collision.json, the source vehicle_spec /
heli_collision read; then regenerate props.ts (`--props`) and run test_wreck_rays.py.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

import heli_collision as hc
import wreck_rays as wr
from raw_models import MODELS

HERE = Path(__file__).resolve().parent
OUT = HERE / 'vehicle_configs/wreck_collision.json'
H = 0.05
ALLOW_GROW = 0  # voxels: a box may not overhang the hull (grazing rays would meet only the box)

# Per wreck: the part frames boxes are fitted in (three.js Euler XYZ degrees, prop frame), and for
# the helicopter the enterable cabin (cabin frame: an interior kept free of boxes, a floor kept).
SPECS = {
    'tank_wreck': {
        'frames': {'hull': (0, 0, 0), 'turret': (6, 22, 4), 'barrel': (0, 18.81, 7.64)},
    },
    'heli_wreck': {
        'frames': {'cabin': (0, 0, 3), 'tail': (-2.4, -14.811, -9.312), 'blade': (33.619, 16.697, -7.449)},
        # Cabin frame (prop frame turned 3° about Z): interior air, and the floor's walking surface.
        'interior': ((-2.8, 0.2, -1.08), (2.55, 2.4, 1.08)),
        'floor': ((-2.8, 0.1, -1.1), (2.55, 0.2, 1.1)),
    },
}


def rot(deg):
    return hc.three_xyz(deg)


class Grid:
    """The prop-frame voxel grid over the mesh bounds (+ margin)."""

    def __init__(self, tris, margin=0.3):
        v = tris.reshape(-1, 3)
        self.lo = v.min(axis=0) - margin
        self.n = np.ceil((v.max(axis=0) + margin - self.lo) / H).astype(int)

    def centres(self, axis):
        return self.lo[axis] + (np.arange(self.n[axis]) + 0.5) * H

    def index(self, p):
        return np.floor((p - self.lo) / H).astype(int)


def depth_hull(tris, g):
    """Hull voxels + the first-hit voxels per test direction (wr.DIRS)."""
    hull = np.ones(tuple(g.n), dtype=bool)
    reps = []
    for axis in range(3):
        a0, a1 = [k for k in range(3) if k != axis]
        us, vs = g.centres(a0), g.centres(a1)
        uv = np.array([(u, v) for u in us for v in vs])
        lo_s, hi_s = g.lo[axis] - 1.0, g.lo[axis] + g.n[axis] * H + 1.0
        tp = wr.first_mesh_hit(tris, axis, 1.0, uv, lo_s)    # from the − side
        tn = wr.first_mesh_hit(tris, axis, -1.0, uv, hi_s)   # from the + side
        front = lo_s + tp
        back = hi_s - tn
        pos = g.centres(axis)
        fr = front.reshape(len(us), len(vs))
        bk = back.reshape(len(us), len(vs))
        # inside[a0, a1, axis]: front − H/2 ≤ pos ≤ back + H/2 (no hit: front = inf → empty)
        ins = (pos[None, None, :] >= fr[:, :, None] - H / 2) & (pos[None, None, :] <= bk[:, :, None] + H / 2)
        hull &= np.moveaxis(ins, [0, 1, 2], [a0, a1, axis])
        # First-hit voxels for the test directions along this axis.
        for name, (ax, sign) in wr.DIRS.items():
            if ax != axis:
                continue
            surf = fr if sign > 0 else bk
            k = np.floor((surf - g.lo[axis]) / H).astype(float)
            ok = np.isfinite(surf)
            ii, jj = np.nonzero(ok)
            kk = np.clip(k[ok].astype(int), 0, g.n[axis] - 1)
            idx = [None, None, None]
            idx[a0], idx[a1], idx[axis] = ii, jj, kk
            deeper = list(idx)
            deeper[axis] = np.clip(kk + (1 if sign > 0 else -1), 0, g.n[axis] - 1)
            reps.append((tuple(idx), tuple(deeper)))
    # A required voxel per seen surface: one voxel (5 cm) in along the ray where the hull is that
    # thick (a box meeting the ray there is within the gate's 10 cm), else the surface voxel.
    first = np.zeros(tuple(g.n), dtype=bool)
    for surf, deep in reps:
        use = hull[deep]
        first[tuple(np.where(use, d, sv) for d, sv in zip(deep, surf))] = True
    return hull, first


def dilate(m, r):
    out = m.copy()
    for _ in range(r):
        o = out.copy()
        for ax in range(3):
            o |= np.roll(out, 1, ax) | np.roll(out, -1, ax)
        out = o
    return out


def sat(a):
    s = np.zeros(tuple(np.array(a.shape) + 1), dtype=np.int64)
    s[1:, 1:, 1:] = a.astype(np.int64).cumsum(0).cumsum(1).cumsum(2)
    return s


def box_sum(s, lo, hi):
    """Sum over cells lo..hi-1 (inclusive lo, exclusive hi) from a summed-area table."""
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    return (s[x1, y1, z1] - s[x0, y1, z1] - s[x1, y0, z1] - s[x1, y1, z0]
            + s[x0, y0, z1] + s[x0, y1, z0] + s[x1, y0, z0] - s[x0, y0, z0])


class Frame:
    """A local grid in one part frame: valid cells (centre in the allowed set) and the required
    voxels' cells."""

    def __init__(self, name, deg, g, allowed, req_pts):
        self.name, self.deg = name, deg
        self.R = rot(deg)
        # Local bounds of the allowed region's corners.
        idx = np.argwhere(allowed)
        pts = g.lo + (idx + 0.5) * H
        loc = pts @ self.R
        self.lo = loc.min(axis=0) - 1.5 * H
        self.n = np.ceil((loc.max(axis=0) + H - self.lo) / H).astype(int)
        cx, cy, cz = (self.lo[a] + (np.arange(self.n[a]) + 0.5) * H for a in range(3))
        X, Y, Z = np.meshgrid(cx, cy, cz, indexing='ij')
        world = np.stack([X, Y, Z], -1) @ self.R.T
        gi = g.index(world)
        inb = np.all((gi >= 0) & (gi < g.n), axis=-1)
        gi = np.clip(gi, 0, g.n - 1)
        valid = inb & allowed[gi[..., 0], gi[..., 1], gi[..., 2]]
        self.bad = sat(~valid)
        self.valid = valid
        self.req_cells = self.cell(req_pts)

    def cell(self, pts):
        c = np.floor((pts @ self.R - self.lo) / H).astype(int)
        ok = np.all((c >= 0) & (c < self.n), axis=1)
        return np.where(ok[:, None], c, -1)

    def grow(self, seed, need, order):
        """Maximal valid box from a seed cell, faces pushed out in `order` until none moves."""
        lo = np.array(seed)
        hi = lo + 1
        moved = True
        while moved:
            moved = False
            for face in order:
                ax, side = divmod(face, 2)
                # Largest step on this face that stays valid (binary search, monotone).
                lim = (lo[ax]) if side == 0 else (self.n[ax] - hi[ax])
                step, a, b = 0, 1, lim
                while a <= b:
                    m = (a + b) // 2
                    l2, h2 = lo.copy(), hi.copy()
                    if side == 0:
                        l2[ax] -= m
                    else:
                        h2[ax] += m
                    if box_sum(self.bad, l2, h2) == 0:
                        step, a = m, m + 1
                    else:
                        b = m - 1
                if step:
                    if side == 0:
                        lo[ax] -= step
                    else:
                        hi[ax] += step
                    moved = True
        return lo, hi, box_sum(need, lo, hi)

    def to_box(self, lo, hi):
        c_loc = self.lo + (lo + hi) / 2 * H
        s = (hi - lo) * H
        return {'c': [round(float(v), 4) + 0.0 for v in self.R @ c_loc], 's': [round(float(v), 4) for v in s],
                'rot': [float(v) for v in self.deg]}


def in_cabin(pts, lohi):
    loc = pts @ rot((0, 0, 3))
    lo, hi = np.array(lohi[0]), np.array(lohi[1])
    return np.all((loc >= lo) & (loc <= hi), axis=1)


def fit(mid, budget=40, target=0.995, seeds=80, rng=np.random.default_rng(7), log=print):
    spec = SPECS[mid]
    tris = wr.mesh_triangles(MODELS / f'vehicles/{mid}.gltf')
    g = Grid(tris)
    hull, first = depth_hull(tris, g)
    allowed = dilate(hull, ALLOW_GROW)
    idx = np.argwhere(first)
    pts = g.lo + (idx + 0.5) * H
    req = pts[:, 1] >= wr.GROUND
    if 'interior' in spec:
        # Grid cells whose centre is inside the cabin's interior air: never a box.
        ai = np.argwhere(allowed)
        apts = g.lo + (ai + 0.5) * H
        inside = in_cabin(apts, spec['interior'])
        allowed[tuple(ai[inside].T)] = False
        req &= ~in_cabin(pts, spec['interior'])
    req_pts = pts[req]
    if 'floor' in spec:
        lo, hi = (np.array(v) for v in spec['floor'])
        xs = np.arange(lo[0] + H / 2, hi[0], H)
        zs = np.arange(lo[2] + H / 2, hi[2], H)
        fl = np.array([(x, hi[1] - H / 2, z) for x in xs for z in zs]) @ rot((0, 0, 3)).T
        req_pts = np.concatenate([req_pts, fl])
        # The floor slab itself must be allowed.
        fi = g.index(fl)
        allowed[tuple(np.clip(fi, 0, g.n - 1).T)] = True
    log(f'{mid}: grid {tuple(g.n)}, hull {hull.sum()}, allowed {allowed.sum()}, required {len(req_pts)}')
    frames = [Frame(n, d, g, allowed, req_pts) for n, d in spec['frames'].items()]
    covered = np.zeros(len(req_pts), dtype=bool)
    boxes = []
    orders = [(0, 1, 2, 3, 4, 5), (4, 5, 0, 1, 2, 3), (2, 3, 4, 5, 0, 1), (2, 3, 0, 1, 4, 5), (0, 1, 4, 5, 2, 3)]
    while len(boxes) < budget and covered.mean() < target:
        best = None
        for f in frames:
            need = np.zeros(tuple(f.n), dtype=np.int64)
            c = f.req_cells[~covered]
            c = c[c[:, 0] >= 0]
            if not len(c):
                continue
            np.add.at(need, (c[:, 0], c[:, 1], c[:, 2]), 1)
            ns = sat(need)
            cand = c[f.valid[c[:, 0], c[:, 1], c[:, 2]]]
            if not len(cand):
                continue
            pick = cand[rng.choice(len(cand), min(seeds, len(cand)), replace=False)]
            for sd in pick:
                for order in orders:
                    lo, hi, gain = f.grow(sd, ns, order)
                    if best is None or gain > best[0]:
                        best = (gain, f, lo, hi)
        if best is None or best[0] == 0:
            break
        gain, f, lo, hi = best
        b = f.to_box(lo, hi)
        boxes.append({**b, 'frame': f.name})
        rc = f.req_cells
        covered |= np.all((rc >= lo) & (rc < hi), axis=1)
        log(f'  box {len(boxes):2d} [{f.name}] +{gain} -> {100 * covered.mean():.2f} % of required, s={b["s"]}')
    return boxes


def write(mid, boxes):
    data = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
    data[mid] = [{k: b[k] for k in ('frame', 'c', 's', 'rot')} for b in boxes]
    OUT.write_text(json.dumps(data, indent=1) + '\n', encoding='utf-8', newline='\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wreck', choices=list(SPECS))
    ap.add_argument('--max', type=int, default=40)
    ap.add_argument('--target', type=float, default=0.995)
    ap.add_argument('--seeds', type=int, default=80)
    ap.add_argument('--write', action='store_true')
    a = ap.parse_args()
    boxes = fit(a.wreck, a.max, a.target, a.seeds)
    tris = wr.mesh_triangles(MODELS / f'vehicles/{a.wreck}.gltf')
    names, o, d, tm = wr.ray_grid(tris)
    tb = wr.first_box_hit(o, d, [wr.box_inverse(b) for b in boxes])
    r = wr.evaluate(o, d, tm, tb, wr.SKIPS.get(a.wreck))
    print(f"{a.wreck}: {len(boxes)} boxes, forward {r['fwd'].sum()} / {r['mesh']} "
          f"({100 * r['fwd'].sum() / r['mesh']:.2f} %), reverse {r['rev'].sum()} / {r['box']} "
          f"({100 * r['rev'].sum() / max(r['box'], 1):.2f} %)")
    if a.write:
        write(a.wreck, boxes)
        print('wrote', OUT)


if __name__ == '__main__':
    sys.exit(main())
