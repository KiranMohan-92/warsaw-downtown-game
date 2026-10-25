"""Pose the Rocketbox soldier's arms onto each first-person gun (Blender, headless).

    blender -b --python tools/assets/build_fparms.py -- [--render DIR] [--only rifle,pistol]
    python tools/assets/build_fparms.py        # package (Blender's Python has no Pillow)
    python tools/assets/build_fparms.py --manifest-only   # rewrite arms.json (pivots) only

Reads the Military_Male_01 avatar (Microsoft Rocketbox, MIT) from tools/assets/raw/rocketbox and
the built guns (packages/client/public/models/guns/*.gltf), and writes
packages/client/public/models/arms/:

- <gun>.gltf + .bin  both arms posed on that gun's grips, cut above the elbow, in the gun's space
                     (the viewmodel adds it to the gun group). The pose is baked; the client
                     skins it at load around the exported pivots for reloads/inspects.
- arms_{albedo,normal}.webp the body atlas cropped to the arms' UV island (shared by every pose).
- arms.json          per pose: triangles, and `bones` = the posed shoulder/elbow/wrist/knuckle
                     pivots per side (gun space) for the runtime IK (client render/fpRig.ts).

Posing is analytic (no Blender IK solver, deterministic): the eye sits at the gun's ADS eye point,
each shoulder → elbow → wrist chain is a two-bone IK toward a wrist target with an elbow pole, the
hand is turned so its anatomical frame (wrist → middle knuckle `d`, pinky → index `l`) matches the
grip, then the fingers and thumb curl about the knuckle line. With --render, writes a view from the
eye and a side view (workbench, gun included) per pose for checking.
"""

# Annotations stay unevaluated: the Blender-only types (Vector, Matrix) don't exist when the pure
# helpers are imported by the offline tests (Python < 3.14 evaluates annotations eagerly).
from __future__ import annotations

import json
import math
import os
import struct
import sys
from pathlib import Path

try:
    import bpy
    from mathutils import Matrix, Vector
except ImportError:  # packaging stage (system Python)
    bpy = None

sys.path.insert(0, str(Path(__file__).resolve().parent))  # Blender doesn't add the script dir
from raw_models import raw_model  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = Path(os.environ.get('WD_RAW', ROOT / 'tools/assets/raw'))
"""Git-ignored raw inputs; WD_RAW points a worktree at the main checkout's (read only)."""
RB = RAW / 'rocketbox/Assets/Avatars/Professions/Military_Male_01'
GUNS = ROOT / 'packages/client/public/models/guns'
OUT = ROOT / 'packages/client/public/models/arms'
BUILD = ROOT / 'tools/assets/build/fparms'
NL = '\n'

VM_SCALE = 0.85
"""Viewmodel group scale (client render/viewmodel.ts): gun-space eye = ADS offset / scale."""

# Per gun: the scan offset (client SCAN_FITS.offset), ADS eye (sightY, adsZ) and hand targets in
# gun space (x right, y up, -z forward). Hands: wrist target `w`, finger direction `d`
# (wrist → knuckles), lateral `l` (pinky → index), elbow pole, finger + thumb curl (degrees).
POSES: dict = {
    'rifle': {
        'offset': (0, -0.078, -0.015),
        'eye': (0.112, 0.30),
        'yaw': 12,
        'R': {
            'w': (0.03, -0.1, 0.19),
            'd': (-0.25, -0.3, -0.92),
            'l': (0, 0.94, -0.34),
            'pole': (1, -1, 0.3),
            'curl': (70, 80, 45),
            'thumb': (25, 35, 25),
        },
        # C-clamp: palm on the handguard's left side, fingers under it, thumb along the top.
        'L': {
            'w': (-0.05, 0.015, -0.225),
            'd': (0.15, -0.35, -0.92),
            'l': (0, 0.93, -0.35),
            # Elbow low: the forearm rises from below and leaves the glove in view at the hip.
            'pole': (-0.35, -1.5, 0.3),
            'curl': (40, 55, 35),
            'thumb': (0, 5, 0),
        },
    },
    'coil': {
        'offset': (0, -0.088, -0.07),
        'eye': (0.087, 0.36),
        'yaw': 12,
        'R': {
            'w': (0.03, -0.1, 0.2),
            'd': (-0.25, -0.3, -0.92),
            'l': (0, 0.94, -0.34),
            'pole': (1, -1, 0.3),
            'curl': (70, 80, 45),
            'thumb': (25, 35, 25),
        },
        'L': {
            # Out of reach at the coil section: hold just ahead of the magwell (long-rifle hold).
            'w': (-0.055, 0.0, -0.17),
            'd': (0.15, -0.35, -0.92),
            'l': (0, 0.93, -0.35),
            'pole': (-0.35, -1.5, 0.3),
            'curl': (40, 55, 35),
            'thumb': (0, 5, 0),
        },
    },
    'iskra': {
        'offset': (0, -0.083, -0.01),
        'eye': (0.072, 0.3),
        'yaw': 12,
        'R': {
            'w': (0.03, -0.08, 0.17),
            'd': (-0.25, -0.3, -0.92),
            'l': (0, 0.94, -0.34),
            'pole': (1, -1, 0.3),
            'curl': (70, 80, 45),
            'thumb': (25, 35, 25),
        },
        # C-clamp on the magwell: palm on its left side, fingers round the front.
        'L': {
            'w': (-0.045, -0.115, -0.1),
            'd': (0.2, -0.05, -0.98),
            'l': (0, 1, -0.05),
            'pole': (-0.5, -1.5, 0.3),
            'curl': (60, 70, 45),
            'thumb': (0, 5, 0),
        },
    },
    'marksman': {
        'offset': (0, 0, 0),
        'eye': (0.17, 0.36),
        'yaw': 12,
        'R': {
            'w': (0.03, -0.035, 0.29),
            'd': (-0.25, -0.3, -0.92),
            'l': (0, 0.94, -0.34),
            'pole': (1, -1, 0.3),
            'curl': (70, 80, 45),
            'thumb': (25, 35, 25),
        },
        'L': {
            'w': (-0.055, 0.045, -0.17),
            'd': (0.15, -0.35, -0.92),
            'l': (0, 0.93, -0.35),
            'pole': (-0.35, -1.5, 0.3),
            'curl': (40, 55, 35),
            'thumb': (0, 5, 0),
        },
    },
    'arc': {
        'offset': (0, 0, 0),
        'eye': (0.192, 0.3),
        'yaw': 12,
        'R': {
            'w': (0.03, -0.025, 0.33),
            'd': (-0.25, -0.3, -0.92),
            'l': (0, 0.94, -0.34),
            'pole': (1, -1, 0.3),
            'curl': (70, 80, 45),
            'thumb': (25, 35, 25),
        },
        'L': {
            'w': (-0.07, 0.09, -0.17),
            'd': (0.15, -0.35, -0.92),
            'l': (0, 0.93, -0.35),
            'pole': (-0.35, -1.5, 0.3),
            'curl': (40, 55, 35),
            'thumb': (0, 5, 0),
        },
    },
    # Pump shotgun: firing hand on the pistol grip, support hand C-clamped on the pump.
    'shotgun': {
        'offset': (0, 0, 0),
        'eye': (0.105, 0.45),
        'yaw': 12,
        'R': {
            'w': (0.03, 0.0, 0.3),
            'd': (-0.25, -0.3, -0.92),
            'l': (0, 0.94, -0.34),
            'pole': (1, -1, 0.3),
            'curl': (70, 80, 45),
            'thumb': (25, 35, 25),
        },
        'L': {
            'w': (-0.05, 0.05, -0.19),
            'd': (0.15, -0.35, -0.92),
            'l': (0, 0.93, -0.35),
            'pole': (-0.35, -1.5, 0.3),
            'curl': (45, 60, 40),
            'thumb': (0, 5, 0),
        },
    },
    # Two hands, thumbs forward: support palm over the firing hand's fingers.
    'pistol': {
        'offset': (0, -0.021, -0.025),
        'eye': (0.042, 0.44),
        'yaw': 0,
        'R': {
            'w': (0.02, -0.045, 0.095),
            'd': (-0.2, -0.3, -0.93),
            'l': (0, 0.95, -0.31),
            'pole': (1, -1, 0.3),
            'curl': (75, 85, 50),
            'thumb': (15, 20, 10),
        },
        'L': {
            'w': (-0.03, -0.06, 0.08),
            'd': (0.3, -0.3, -0.9),
            'l': (0, 0.95, -0.31),
            'pole': (-0.6, -1.2, 0.2),
            'curl': (70, 80, 50),
            'thumb': (0, 5, 0),
        },
    },
    # Seax knife (client viewmodel KNIFE_IDLE): gun space = the knife group at rest, the handle
    # at KNIFE_MODEL_AT. Specs are in camera space (`cam` on a side), converted with the knife's
    # held pose. Right: forward hammer grip (pinky -> index along the blade, fist neutral, the
    # forearm rising from the lower right). Left: a fist raised in a guard at the lower left.
    'knife': {
        'offset': (0.0, -0.005, 0.025),
        'cam': {'p': (0.13, -0.14, -0.285), 'r': (0.35, 0.25, -0.35)},
        'R': {
            'cam': True,
            'grip': True,
            'f': (-0.35, 0.45, -0.82),
            'pole': (1, -1, 0.3),
            'curl': (78, 88, 55),
            'thumb': (30, 40, 30),
        },
        'L': {
            'cam': True,
            'w': (-0.17, -0.16, -0.27),
            'd': (0.15, 0.8, -0.6),
            'l': (-0.2, 0.35, 0.9),
            'pole': (-1, -1, 0.3),
            'curl': (105, 110, 80),
            'thumb': (35, 45, 30),
        },
    },
}
KNIFE_GLTF = ROOT / 'packages/client/public/models/knife/knife.gltf'
KNIFE_GRIP_REACH = 0.062
"""Wrist -> grip centre along the hand's wrist -> knuckle line (measured on the pistol pose)."""


def euler_xyz(r) -> Matrix:
    """three.js Euler 'XYZ' (matrix = Rx Ry Rz)."""
    return Matrix.Rotation(r[0], 3, 'X') @ Matrix.Rotation(r[1], 3, 'Y') @ Matrix.Rotation(r[2], 3, 'Z')


def cam_side(spec: dict, side: dict) -> dict:
    """A side's spec in camera space -> gun space (the knife's held pose); `grip` derives the
    wrist and hand frame from the knife handle: l along the blade, d = the forearm direction
    without its along-blade part, wrist KNIFE_GRIP_REACH behind the grip along d."""
    Rq = euler_xyz(spec['cam']['r'])
    Ri = Rq.inverted()
    pc = Vector(spec['cam']['p'])
    to_g = lambda p: Ri @ (Vector(p) - pc) / VM_SCALE  # noqa: E731
    out = {k: v for k, v in side.items() if k not in ('cam', 'grip', 'f', 'w', 'd', 'l', 'pole')}
    out['pole'] = tuple(Ri @ Vector(side['pole']))
    if side.get('grip'):
        l = Vector((0, 0, -1))
        f = (Ri @ Vector(side['f'])).normalized()
        d = (f - l * f.dot(l)).normalized()
        w = Vector(spec['offset']) - d * KNIFE_GRIP_REACH
        out.update(w=tuple(w), d=tuple(d), l=tuple(l))
    else:
        out.update(w=tuple(to_g(side['w'])), d=tuple(Ri @ Vector(side['d'])),
                   l=tuple(Ri @ Vector(side['l'])))
    return out


def args() -> tuple[Path | None, list[str]]:
    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    render = Path(argv[argv.index('--render') + 1]) if '--render' in argv else None
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else list(POSES)
    return render, only


def gun_to_body(p) -> Vector:
    """Gun space (x right, y up, -z forward) → Blender body frame (-x right, z up, -y forward)."""
    return Vector((-p[0], p[2], p[1]))


def body_to_gun(p) -> tuple[float, float, float]:
    return (-p[0], p[2], p[1])


class Rig:
    def __init__(self, fbx: Path | None = None) -> None:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=str(fbx or RB / 'Export/Military_Male_01.fbx'))
        self.arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
        self.mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
        self.W = self.arm.matrix_world
        head = self.head('Bip01 Head')
        # Eye: above and in front of the head bone (the model faces -Y).
        self.eye = head + Vector((0, -0.095, 0.075))

    def pb(self, name: str):
        return self.arm.pose.bones[name]

    def head(self, name: str) -> Vector:
        return (self.W @ self.pb(name).matrix).to_translation()

    def rotate(self, name: str, R: Matrix, about: Vector) -> None:
        """Rotate a bone (world rotation R about a world point); children follow."""
        pb = self.pb(name)
        Wc = self.W @ pb.matrix
        Wn = Matrix.Translation(about) @ R.to_4x4() @ Matrix.Translation(-about) @ Wc
        pb.matrix = self.W.inverted() @ Wn
        bpy.context.view_layer.update()

    def reset(self) -> None:
        for pb in self.arm.pose.bones:
            pb.matrix_basis = Matrix()
        bpy.context.view_layer.update()


def frame(d: Vector, l: Vector) -> Matrix:
    d = d.normalized()
    l = (l - d * l.dot(d)).normalized()
    return Matrix((d, l, d.cross(l))).transposed()


def pose_arm(rig: Rig, side: str, spec: dict, to_world) -> None:
    S, E, Wr = (rig.head(f'Bip01 {side} {b}') for b in ('UpperArm', 'Forearm', 'Hand'))
    L1, L2 = (E - S).length, (Wr - E).length
    T = to_world(spec['w'], point=True)
    dist = min((T - S).length, (L1 + L2) * 0.999)
    fwd = (T - S).normalized()
    T = S + fwd * dist
    a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(L1 * L1 - a * a, 0))
    pole = to_world(spec['pole'])
    pole = (pole - fwd * pole.dot(fwd)).normalized()
    elbow = S + fwd * a + pole * h
    rig.rotate(f'Bip01 {side} UpperArm', (E - S).rotation_difference(elbow - S).to_matrix(), S)
    E, Wr = rig.head(f'Bip01 {side} Forearm'), rig.head(f'Bip01 {side} Hand')
    rig.rotate(f'Bip01 {side} Forearm', (Wr - E).rotation_difference(T - E).to_matrix(), E)
    # Hand: anatomical frame onto the grip frame.
    Wr = rig.head(f'Bip01 {side} Hand')
    d0 = rig.head(f'Bip01 {side} Finger2') - Wr
    l0 = rig.head(f'Bip01 {side} Finger1') - rig.head(f'Bip01 {side} Finger4')
    R = frame(to_world(spec['d']), to_world(spec['l'])) @ frame(d0, l0).inverted()
    rig.rotate(f'Bip01 {side} Hand', R, Wr)
    # Curl: fingers about the knuckle line toward the palm; thumb about the finger direction.
    Wr = rig.head(f'Bip01 {side} Hand')
    d = (rig.head(f'Bip01 {side} Finger2') - Wr).normalized()
    l = (rig.head(f'Bip01 {side} Finger1') - rig.head(f'Bip01 {side} Finger4')).normalized()
    palm = l.cross(d) if side == 'R' else d.cross(l)
    for f in range(5):
        chain = [f'Bip01 {side} Finger{f}', f'Bip01 {side} Finger{f}1', f'Bip01 {side} Finger{f}2']
        angles = spec['thumb'] if f == 0 else spec['curl']
        axis = d if f == 0 else l
        for bone, deg in zip(chain, angles):
            p = rig.head(bone)
            child = chain[chain.index(bone) + 1] if bone != chain[-1] else None
            tip = rig.head(child) if child else p + (p - rig.head(chain[-2]))
            # Pick the sense that moves the segment toward the palm.
            best = None
            for s in (1, -1):
                R = Matrix.Rotation(math.radians(deg * s), 3, axis)
                moved = p + R @ (tip - p)
                score = (moved - tip).dot(palm)
                if best is None or score > best[0]:
                    best = (score, R)
            rig.rotate(bone, best[1], p)


def fist_centre(rig: Rig, side: str) -> Vector:
    """Centre of the channel a closed fist leaves: the mean of the four fingers' joint heads and
    tips (knuckle, middle, end joints, tip) — the loop the handle passes through."""
    pts = []
    for f in range(1, 5):
        chain = [rig.head(f'Bip01 {side} Finger{f}{k}') for k in ('', '1', '2')]
        pts += chain + [chain[2] + (chain[2] - chain[1]) * 0.8]
    return sum(pts, Vector()) / len(pts)


ARM_BONES = ('UpperArm', 'Forearm', 'Hand', 'Finger')


def cut_arms(rig: Rig, to_gun) -> tuple[list, list, tuple]:
    """Posed arm triangles (body material) in gun space: verts, tris, UV bounds."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = rig.mesh.evaluated_get(dg)
    me = ev.to_mesh()
    src = rig.mesh.data
    groups = {g.index: g.name for g in rig.mesh.vertex_groups}
    body = next(i for i, m in enumerate(src.materials) if m.name == 'sm002_body')
    elbows = {s: rig.head(f'Bip01 {s} Forearm') for s in 'LR'}
    keep = set()
    for v in src.vertices:
        w_arm = w_upper = 0.0
        side = None
        for g in v.groups:
            n = groups[g.group]
            if any(f' {b}' in n for b in ARM_BONES) and (' L ' in n or ' R ' in n):
                w_arm += g.weight
                side = 'L' if ' L ' in n else 'R'
                if 'UpperArm' in n:
                    w_upper += g.weight
        if w_arm < 0.5 or side is None:
            continue
        pos = rig.mesh.matrix_world @ me.vertices[v.index].co
        if w_upper > 0.5 and (pos - elbows[side]).length > 0.17:
            continue
        keep.add(v.index)
    uv = me.uv_layers.active.data
    hand_bones = {i for i, n in groups.items() if ' Hand' in n or ' Finger' in n}
    in_hand = set()
    for v in src.vertices:
        if sum(g.weight for g in v.groups if g.group in hand_bones) > 0.5:
            in_hand.add(v.index)
    verts, tris, index = [], [], {}
    glove_uv = []
    lo, hi = [1.0, 1.0], [0.0, 0.0]
    me.calc_loop_triangles()
    nm = rig.mesh.matrix_world.to_3x3()
    for t in me.loop_triangles:
        if t.material_index != body or not all(i in keep for i in t.vertices):
            continue
        tri = []
        for li, vi in zip(t.loops, t.vertices):
            u, w = uv[li].uv
            key = (vi, round(u, 5), round(w, 5))
            if key not in index:
                p = to_gun(rig.mesh.matrix_world @ me.vertices[vi].co, point=True)
                n = to_gun((nm @ me.corner_normals[li].vector).normalized())
                index[key] = len(verts)
                verts.append((*p, *n, u, 1 - w))
                lo = [min(lo[0], u), min(lo[1], 1 - w)]
                hi = [max(hi[0], u), max(hi[1], 1 - w)]
            tri.append(index[key])
        tris.append(tuple(tri))
        if any(i in in_hand for i in t.vertices):
            glove_uv.append([verts[k][6:8] for k in tri])
    ev.to_mesh_clear()
    return verts, tris, (lo, hi), glove_uv


FOREARM_GUARD = {'t': (0.22, 0.86), 'out': (0.35, 0), 'half': 70, 'lift': 0.012, 'cols': 14, 'rows': 8,
                 'thick': 0.006}
"""The third-person soldiers' forearm plate (build_soldiers.add_gear → limb_shell reads it), shared
so the player's own arms wear the same armour: span along forearm → hand (fraction of the bone),
`out` = (back, up) with the lateral sign per side, arc half-angle (degrees), lift off the sleeve
(m), grid size, plate thickness (m)."""

FP_GUARD = {**FOREARM_GUARD, 't': (0.2, 0.72), 'face': 0.8}
"""First-person overrides: the plate stops short of the wrist (at 0.86 it hid the support glove
at the hip), and `face` turns it about the forearm from the soldiers' outer side toward the eye
by that fraction (on the outer side it sits edge-on to the camera and barely shows)."""


class GuardFit:
    """Rest-pose data for fitting the forearm plates: the body surface (ray targets), each
    forearm's rest bone heads and rest world matrix. Captured once, with the rig at rest."""

    def __init__(self, rig: Rig) -> None:
        import bmesh  # noqa: PLC0415
        from mathutils.bvhtree import BVHTree  # noqa: PLC0415

        dg = bpy.context.evaluated_depsgraph_get()
        ev = rig.mesh.evaluated_get(dg)
        body = bmesh.new()
        body.from_mesh(ev.to_mesh())
        body.transform(rig.mesh.matrix_world)
        ev.to_mesh_clear()
        self.tree = BVHTree.FromBMesh(body)
        body.free()
        self.bones = {
            s: (rig.head(f'Bip01 {s} Forearm'), rig.head(f'Bip01 {s} Hand'),
                (rig.W @ rig.pb(f'Bip01 {s} Forearm').matrix).copy())
            for s in 'LR'
        }


def guard_out(fit: GuardFit, rig: Rig, side: str) -> Vector:
    """Rest-space plate direction: the soldiers' `out`, turned `face` of the way about the forearm
    toward where the eye sees the posed forearm from."""
    g = FP_GUARD
    a, b, rest = fit.bones[side]
    axis = (b - a).normalized()
    M = (rig.W @ rig.pb(f'Bip01 {side} Forearm').matrix) @ rest.inverted()
    mid = M @ (a + (b - a) * sum(g['t']) / 2)
    view = M.to_3x3().normalized().inverted() @ (rig.eye - mid)
    base = Vector((1 if side == 'L' else -1, *g['out']))
    base, view = ((v - axis * v.dot(axis)).normalized() for v in (base, view))
    angle = base.angle(view) * g['face']
    if base.cross(view).dot(axis) < 0:
        angle = -angle
    return Matrix.Rotation(angle, 3, axis) @ base


def forearm_guard(fit: GuardFit, side: str, out: Vector) -> list:
    """One forearm plate ray-fitted over the rest-pose sleeve exactly like the soldiers' limb_shell
    (grid of rays around the bone, `lift` off the hit, smoothed, solidified), as triangles of
    (world position, world normal, plate uv) at rest — uv in the plate's own 0..1 square, image
    convention (v 0 = the wrist end, where the soldiers' texture puts it too)."""
    import bmesh  # noqa: PLC0415

    g = FP_GUARD
    a, b, _ = fit.bones[side]
    axis = (b - a).normalized()
    length = (b - a).length
    out = (out - axis * out.dot(axis)).normalized()
    lat = axis.cross(out)
    cols, rows = g['cols'], g['rows']
    t0, t1 = g['t']
    grid = []
    for r in range(rows + 1):
        ctr = a + axis * length * (t0 + (t1 - t0) * r / rows)
        row = []
        for k in range(cols + 1):
            th = math.radians(-g['half'] + 2 * g['half'] * k / cols)
            d = out * math.cos(th) + lat * math.sin(th)
            hit = fit.tree.ray_cast(ctr + d * 0.3, -d, 0.3)[0]
            row.append((hit if hit is not None else ctr + d * 0.07) + d * g['lift'])
        grid.append(row)
    for _ in range(2):  # the soldiers' smoothing: rows, then columns
        grid = [grid[0]] + [
            [(grid[r - 1][k] + grid[r][k] * 2 + grid[r + 1][k]) / 4 for k in range(cols + 1)]
            for r in range(1, rows)
        ] + [grid[-1]]
        grid = [
            [row[0]] + [(row[k - 1] + row[k] * 2 + row[k + 1]) / 4 for k in range(1, cols)] + [row[-1]]
            for row in grid
        ]
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.verify()
    vs = [[bm.verts.new(p) for p in row] for row in grid]
    for r in range(rows):
        for k in range(cols):
            f = bm.faces.new([vs[r][k], vs[r][k + 1], vs[r + 1][k + 1], vs[r + 1][k]])
            for loop, (rr, kk) in zip(f.loops, ((r, k), (r, k + 1), (r + 1, k + 1), (r + 1, k))):
                loop[uvl].uv = (kk / cols, 1 - rr / rows)
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=g['thick'])
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))  # closed solid: outward
    gm = bpy.data.meshes.new(f'guard_{side}')
    bm.to_mesh(gm)
    bm.free()
    gm.set_sharp_from_angle(angle=math.radians(40))  # hard rim, smooth shell
    gm.calc_loop_triangles()
    uv = gm.uv_layers.active.data
    tris = [
        [(tuple(gm.vertices[vi].co), tuple(gm.corner_normals[li].vector), tuple(uv[li].uv))
         for li, vi in zip(t.loops, t.vertices)]
        for t in gm.loop_triangles
    ]
    bpy.data.meshes.remove(gm)
    return tris


def posed_guards(fit: GuardFit, rig: Rig, to_gun) -> tuple[list, list]:
    """Both forearm plates, fitted for this pose and carried rigidly by the posed forearm bones
    (like the soldiers' gear, weighted 1.0 to the forearm), in gun space: verts, tris."""
    verts, tris, index = [], [], {}
    for side in 'LR':
        M = (rig.W @ rig.pb(f'Bip01 {side} Forearm').matrix) @ fit.bones[side][2].inverted()
        R = M.to_3x3().normalized()
        for tri in forearm_guard(fit, side, guard_out(fit, rig, side)):
            out = []
            for p, n, (u, v) in tri:
                key = (side, p, n, u, v)
                if key not in index:
                    index[key] = len(verts)
                    verts.append((*to_gun(M @ Vector(p), point=True),
                                  *to_gun((R @ Vector(n)).normalized()), round(u, 5), round(v, 5)))
                out.append(index[key])
            tris.append(tuple(out))
    return verts, tris


def read_gun(gid: str) -> tuple[list, list]:
    # The shipped gun itself when freshly exported, else its up-to-date decoded copy (packed).
    path = raw_model(KNIFE_GLTF if gid == 'knife' else GUNS / f'{gid}.gltf')
    g = json.loads(path.read_text())
    b = (path.parent / g['buffers'][0]['uri']).read_bytes()

    def acc(i):
        a = g['accessors'][i]
        v = g['bufferViews'][a['bufferView']]
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]
        fmt = {5126: 'f', 5125: 'I', 5123: 'H'}[a['componentType']]
        stride = v.get('byteStride', struct.calcsize(fmt) * n)
        return [struct.unpack_from(f'<{n}{fmt}', b, off + k * stride) for k in range(a['count'])]

    prim = g['meshes'][0]['primitives'][0]
    return acc(prim['attributes']['POSITION']), [i[0] for i in acc(prim['indices'])]


def render(rig: Rig, gid: str, spec: dict, to_world, cut, out: Path, view=None) -> None:
    pos, idx = read_gun(gid)
    off = spec['offset']
    me = bpy.data.meshes.new(f'gun_{gid}')
    me.from_pydata(
        [to_world((p[0] + off[0], p[1] + off[1], p[2] + off[2]), point=True) for p in pos],
        [],
        [tuple(idx[i : i + 3]) for i in range(0, len(idx), 3)],
    )
    gun = bpy.data.objects.new(f'gun_{gid}', me)
    bpy.context.scene.collection.objects.link(gun)
    gun.color = (0.18, 0.19, 0.2, 1)
    # The cut arms as the game draws them (the eye view sits inside the head).
    verts, tris, guard = cut
    am = bpy.data.meshes.new('arms_cut')
    am.from_pydata([to_world(v[:3], point=True) for v in verts], [], tris)
    arms = bpy.data.objects.new('arms_cut', am)
    bpy.context.scene.collection.objects.link(arms)
    arms.color = (0.45, 0.47, 0.36, 1)
    gm = bpy.data.meshes.new('guards')
    gm.from_pydata([to_world(v[:3], point=True) for v in guard[0]], [], guard[1])
    guards = bpy.data.objects.new('guards', gm)
    bpy.context.scene.collection.objects.link(guards)
    guards.color = (0.2, 0.55, 0.62, 1)  # stands out from the sleeve in the check renders
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'OBJECT'
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    fwd, up = view if view else (to_world((0, 0, -1)), to_world((0, 1, 0)))
    for name, at, look, lens in (
        ('eye', rig.eye, fwd, 16.0),
        ('side', to_world((0.9, 0.0, 0.05), point=True), to_world((-1, 0, 0)), 30.0),
        ('left', to_world((-0.5, 0.0, -0.18), point=True), to_world((1, 0, 0)), 30.0),
    ):
        rig.mesh.hide_render = name != 'side'
        arms.hide_render = guards.hide_render = name == 'side'
        cam.location = at
        # Camera looks down its -Z with +Y up: build from (right, up, back).
        right = look.cross(up).normalized()
        cam.rotation_euler = Matrix((right, up, -look)).transposed().to_euler()
        cam.data.lens = lens
        cam.data.clip_start = 0.01
        sc.render.filepath = str(out / f'arms_{gid}_{name}.png')
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(gun)
    bpy.data.objects.remove(arms)
    bpy.data.objects.remove(guards)
    bpy.data.objects.remove(cam)
    rig.mesh.hide_render = False


BONE_HEADS = (('shoulder', 'UpperArm'), ('elbow', 'Forearm'), ('wrist', 'Hand'), ('knuckle', 'Finger2'))
"""Posed joint pivots exported per pose (gun space) for the client's runtime arm IK
(render/fpRig.ts): the mesh is skinned at load from these (no weights shipped)."""


def pose_all() -> None:
    """Blender stage: pose each gun's arms, write BUILD/<gun>.json (+ renders)."""
    render_dir, only = args()
    BUILD.mkdir(parents=True, exist_ok=True)
    rig = Rig()
    rig.reset()
    fit = GuardFit(rig)
    for gid in only:
        spec = POSES[gid]
        rig.reset()
        view = None
        if 'cam' in spec:
            # Held pose in camera space: gun space turned by the pose's rotation, eye at the
            # camera origin (offsets real-size, like the guns' adsZ / VM_SCALE).
            Rq = euler_xyz(spec['cam']['r'])
            eye_g = Rq.inverted() @ -Vector(spec['cam']['p']) / VM_SCALE
            rot = Rq
        else:
            sight_y, ads_z = spec['eye']
            eye_g = Vector((0, sight_y, ads_z / VM_SCALE))
            rot = Matrix.Identity(3)
        yaw = Matrix.Rotation(math.radians(spec.get('yaw', 0)), 3, 'Z')

        def to_world(p, point=False, eye_g=eye_g, yaw=yaw, rot=rot):
            v = yaw @ gun_to_body(rot @ (Vector(p) - eye_g if point else Vector(p)))
            return rig.eye + v if point else v

        def to_gun(p, point=False, eye_g=eye_g, yaw=yaw, rot=rot):
            v = yaw.inverted() @ (p - rig.eye if point else p)
            g = rot.inverted() @ Vector(body_to_gun(v))
            return tuple(round(c, 5) for c in (g + eye_g if point else g))

        if 'cam' in spec:
            Ri = rot.inverted()
            view = (to_world(Ri @ Vector((0, 0, -1))), to_world(Ri @ Vector((0, 1, 0))))
        sds = {side: cam_side(spec, spec[side]) if spec[side].get('cam') else spec[side] for side in 'RL'}
        for side in 'RL':
            pose_arm(rig, side, sds[side], to_world)
        if spec['R'].get('grip'):
            # Seat the handle in the fist: move the wrist until the curled fingers' loop centre
            # sits on the grip (a few fixed-point passes; each re-poses from rest).
            grip = to_world(spec['offset'], point=True)
            for _ in range(4):
                centre = fist_centre(rig, 'R')
                miss = grip - centre
                w = Vector(sds['R']['w']) + Vector(to_gun(miss))
                sds['R'] = {**sds['R'], 'w': tuple(w)}
                rig.reset()
                for side in 'RL':
                    pose_arm(rig, side, sds[side], to_world)
            print(f'{gid}: fist centre {1000 * (grip - fist_centre(rig, "R")).length:.1f} mm off the grip')
        verts, tris, uv, glove = cut_arms(rig, to_gun)
        g_verts, g_tris = posed_guards(fit, rig, to_gun)
        bones = {
            side: {k: to_gun(rig.head(f'Bip01 {side} {b}'), point=True) for k, b in BONE_HEADS}
            for side in 'LR'
        }
        (BUILD / f'{gid}.json').write_text(json.dumps({
            'verts': verts, 'tris': tris, 'uv': uv, 'glove': glove,
            'guard': {'verts': g_verts, 'tris': g_tris}, 'bones': bones,
        }))
        if render_dir:
            render_dir.mkdir(parents=True, exist_ok=True)
            render(rig, gid, spec, to_world, (verts, tris, (g_verts, g_tris)), render_dir, view)
        print(f'{gid}: {len(verts)} verts, {len(tris)} tris; guards {len(g_verts)} verts, {len(g_tris)} tris')


SLEEVE = ((0.1, (22, 24, 24)), (0.3, (44, 48, 45)), (0.55, (80, 86, 78)))
"""Near-future combat suit (Kiran: futuristic): graphite with an olive cast. The ACU's digital
blocks are blurred away (folds, pockets and seams survive through luminance), plus a hex weave."""
GLOVE = ((0.1, (26, 25, 23)), (0.5, (70, 66, 60)))
"""Dark charcoal gloves (stitching and panels survive through luminance)."""


def de_camo(im):
    """Luminance with the ACU pattern divided out: the camo is a few flat colours with the fold
    shading multiplied on top, so cluster by colour (k-means) and divide each pixel's luminance by
    its colour's base. Returns float luminance (mid-grey fabric + folds, pockets, seams)."""
    import numpy as np  # noqa: PLC0415

    rgb = np.asarray(im.convert('RGB'), np.float32)
    H, W = rgb.shape[:2]
    lum = rgb.mean(axis=2)
    # Chroma (brightness-free colour) separates the camo colours from their shading.
    chroma = rgb / np.maximum(lum[..., None], 1)
    feat = np.concatenate([chroma * 60, lum[..., None] * 0.15], axis=2).reshape(-1, 4)
    rng = np.random.default_rng(3)
    sample = feat[rng.choice(len(feat), 20000, replace=False)]
    centers = sample[rng.choice(len(sample), 5, replace=False)]
    for _ in range(12):
        lab = np.argmin(((sample[:, None] - centers[None]) ** 2).sum(-1), axis=1)
        centers = np.array([sample[lab == k].mean(0) if (lab == k).any() else centers[k] for k in range(5)])
    labels = np.empty(len(feat), np.int32)
    for i in range(0, len(feat), 1 << 18):
        labels[i : i + (1 << 18)] = np.argmin(((feat[i : i + (1 << 18), None] - centers[None]) ** 2).sum(-1), axis=1)
    labels = labels.reshape(H, W)
    base = np.array([np.median(lum[labels == k]) if (labels == k).any() else 128 for k in range(5)])
    shade = np.clip(lum / np.maximum(base[labels], 8), 0.35, 1.6)
    out = 104 * shade
    out[lum < 10] = lum[lum < 10]  # atlas background stays black
    # Soften the speckle along colour-cluster borders (folds are broader than 3 px).
    from scipy.ndimage import gaussian_filter  # noqa: PLC0415

    return gaussian_filter(out, 1.1)


def recolour(im, glove_uv):
    """Remap the ACU atlas by luminance: sleeves to SLEEVE, glove UV islands to GLOVE."""
    from PIL import Image, ImageDraw  # noqa: PLC0415

    W, H = im.size
    mask = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(mask)
    for tri in glove_uv:
        draw.polygon([(u * W, v * H) for u, v in tri], fill=255)
    mask = mask.filter(__import__('PIL.ImageFilter', fromlist=['x']).MaxFilter(5))
    from PIL import ImageFilter  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    raw = im.convert('L')
    a = de_camo(im)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    k = 2 * np.pi / (W / 220)  # hex weave cell ≈ 1/220 of the atlas
    hexp = np.cos(k * xx) + np.cos(k * (xx / 2 + yy * 0.866)) + np.cos(k * (xx / 2 - yy * 0.866))
    a *= 1 - 0.07 * (hexp < -1.0)
    lum_suit = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    lum = raw

    def lut(stops):
        out = []
        for c in range(3):
            for i in range(256):
                x = i / 255
                lo_s = max((s for s in stops if s[0] <= x), default=stops[0], key=lambda s: s[0])
                hi_s = min((s for s in stops if s[0] >= x), default=stops[-1], key=lambda s: s[0])
                t = 0 if hi_s[0] == lo_s[0] else (x - lo_s[0]) / (hi_s[0] - lo_s[0])
                out.append(round(lo_s[1][c] + (hi_s[1][c] - lo_s[1][c]) * t))
        return out

    def paint(stops, src):
        rgb = Image.merge('RGB', (src, src, src))
        return rgb.point(lut(stops))

    return Image.composite(paint(GLOVE, lum), paint(SLEEVE, lum_suit), mask)


PLATE_PAD = 4
"""Pixels of edge-replicated border around the forearm plate in the arms atlas (mip bleed)."""
SLEEVE_ROUGH = 0.85
"""Fabric roughness (the arms material's old constant) for the roughness map (G, like glTF ORM);
the plate keeps the soldiers' gear values (satin shell 0.38, light strip 0.2)."""


def plate_textures(gear_size: int = 2048) -> dict:
    """The soldiers' forearm-plate texture (build_soldiers.gear_atlas, its ARMOR region: satin
    graphite, chamfered rim, panel line, cyan edge light near the wrist end), cropped out of the
    gear atlas as albedo / normal / emissive / roughness arrays (uint8, H × W × 3)."""
    import numpy as np  # noqa: PLC0415

    from build_soldiers import gear_atlas  # noqa: PLC0415

    alb, nrm, orm, emis = gear_atlas(gear_size)
    h, q = gear_size // 2, gear_size // 4
    box = (0, 3 * q, h, gear_size)  # image x 0..h, y 3q..size (the ARMOR_UV region)
    return {k: np.asarray(im.crop(box).convert('RGB')) for k, im in
            (('albedo', alb), ('normal', nrm), ('emissive', emis), ('rough', orm))}


def arms_atlas(sleeve: dict, plate: dict, pad: int = PLATE_PAD) -> tuple[dict, dict]:
    """Stack the cropped sleeve atlas (albedo / normal, H × W × 3) over a strip holding the plate
    (edge-padded by `pad`). Returns the images (albedo, normal, emissive, rough; emissive and
    rough cover the same UV square) and the layout: `sleeve_v` = the sleeve's share of the
    height, `plate` = (u0, v0, u1, v1) of the plate in atlas UVs (image convention, v down)."""
    import numpy as np  # noqa: PLC0415

    H, W = sleeve['albedo'].shape[:2]
    ph, pw = plate['albedo'].shape[:2]
    if pw + 2 * pad > W:
        raise ValueError('plate wider than the arms atlas')
    total = H + ph + 2 * pad
    fill = {'albedo': (0, 0, 0), 'normal': (128, 128, 255), 'emissive': (0, 0, 0),
            'rough': (255, round(SLEEVE_ROUGH * 255), 0)}
    out = {}
    for k, colour in fill.items():
        im = np.empty((total, W, 3), np.uint8)
        im[:] = colour
        if k in sleeve:
            im[:H] = sleeve[k]
        padded = np.pad(plate[k], ((pad, pad), (pad, pad), (0, 0)), mode='edge')
        im[H:, : pw + 2 * pad] = padded
        out[k] = im
    layout = {
        'sleeve_v': H / total,
        'plate': (pad / W, (H + pad) / total, (pad + pw) / W, (H + pad + ph) / total),
    }
    return out, layout


def remap(verts: list, lo: list, hi: list, layout: dict, plate: bool) -> list:
    """Vertices' UVs into the stacked arms atlas: sleeve UVs from the body atlas' crop box
    (lo..hi), plate UVs from the plate's own 0..1 square."""
    out = []
    for v in verts:
        if plate:
            u0, v0, u1, v1 = layout['plate']
            uv = (u0 + v[6] * (u1 - u0), v0 + v[7] * (v1 - v0))
        else:
            uv = ((v[6] - lo[0]) / (hi[0] - lo[0]), (v[7] - lo[1]) / (hi[1] - lo[1]) * layout['sleeve_v'])
        out.append((*v[:6], *uv))
    return out


def bone_pivots(bones: dict) -> dict:
    """Posed pivots per side, mm-rounded (arms.json counts toward the 1 MB arms budget): [shoulder,
    elbow, wrist, middle knuckle], each [x, y, z] in gun space."""
    return {side: [[round(c, 3) for c in bones[side][k]] for k, _ in BONE_HEADS] for side in 'LR'}


def package() -> None:
    """System-Python stage: glTF per pose (sleeves + forearm plates, one primitive) + the shared
    atlas: the body atlas cropped to the arms' UV island over a strip with the plate texture."""
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_heroes import gltf  # noqa: PLC0415
    from build_models import json_text  # noqa: PLC0415
    from webp import save_webp  # noqa: PLC0415

    OUT.mkdir(parents=True, exist_ok=True)
    built = {p.stem: json.loads(p.read_text()) for p in sorted(BUILD.glob('*.json'))}
    missing = [g for g, b in built.items() if 'guard' not in b or 'bones' not in b]
    if missing:
        raise SystemExit(f'{missing}: stale Blender output (no forearm guards / bones); re-run the Blender stage')
    if '--manifest-only' in sys.argv:  # pivots only: meshes and atlas stay as shipped
        manifest = {'poses': {gid: {
            'triangles': len(b['tris']) + len(b['guard']['tris']),
            'guardTriangles': len(b['guard']['tris']), 'bones': bone_pivots(b['bones'])}
            for gid, b in built.items()}}
        (OUT / 'arms.json').write_text(json_text(manifest) + NL, encoding='utf-8', newline=NL)
        return
    pad = 0.01
    lo = [max(0.0, min(b['uv'][0][i] for b in built.values()) - pad) for i in range(2)]
    hi = [min(1.0, max(b['uv'][1][i] for b in built.values()) + pad) for i in range(2)]
    sleeve = {}
    for name, src in (('albedo', 'sm002_body_color_acu.tga'), ('normal', 'sm002_body_normal.tga')):
        im = Image.open(RB / 'Textures' / src).convert('RGB')
        W, H = im.size
        if name == 'albedo':
            glove = [t for b in built.values() for t in b['glove']]
            im = recolour(im, glove)
        box = (int(lo[0] * W), int(lo[1] * H), math.ceil(hi[0] * W), math.ceil(hi[1] * H))
        # Full source density: the hands are the closest surface on screen.
        sleeve[name] = np.asarray(im.crop(box))
        print(name, im.size, '-> crop', box)
    images, layout = arms_atlas(sleeve, plate_textures())
    for name, a in images.items():
        im = Image.fromarray(a)
        if name in ('emissive', 'rough'):  # flat but for the plate: half resolution is plenty
            im = im.resize((im.width // 2, im.height // 2), Image.Resampling.BOX)
        # WebP at least as faithful to the source as the q88 JPEG it replaced (webp.py).
        kind = 'color' if name in ('albedo', 'emissive') else 'data'
        save_webp(im, OUT / f'arms_{name}.webp', kind, match_jpeg=88)
        print(name, '->', im.size)
    manifest: dict = {'poses': {}}
    for gid, b in built.items():
        verts = remap(b['verts'], lo, hi, layout, plate=False)
        n = len(verts)
        verts += remap(b['guard']['verts'], lo, hi, layout, plate=True)
        tris = [tuple(t) for t in b['tris']] + [tuple(i + n for i in t) for t in b['guard']['tris']]
        doc, blob = gltf(gid, verts, tris)
        (OUT / f'{gid}.bin').write_bytes(blob)
        (OUT / f'{gid}.gltf').write_text(json_text(doc) + NL, encoding='utf-8', newline=NL)
        manifest['poses'][gid] = {'triangles': len(tris), 'guardTriangles': len(b['guard']['tris']),
                                  'bones': bone_pivots(b['bones'])}
        print(f'{gid}: {len(tris)} tris ({len(b["guard"]["tris"])} forearm plates)')
    (OUT / 'arms.json').write_text(json_text(manifest) + NL, encoding='utf-8', newline=NL)


if __name__ == '__main__':
    if bpy:
        pose_all()
    else:
        package()
