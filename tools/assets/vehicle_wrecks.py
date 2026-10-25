"""Helicopter and tank wrecks for the Market (render-only; generic types, no insignia). Blender only.

Both are authored in the props' local frame (shared maps/props.ts `helicopterWreck` /
`tankWreck` placed at the origin with rot 0: +X along the length, +Y up; nose/front toward −X)
and hug the collision boxes of the time (vehicle_spec.WRECK_BOXES / PHASE1_HELI_BOXES). The
helicopter's cabin is one rigid shell pitched 5° nose-down (vehicle_spec.HELI_SHELL, its own
frame), so the model is a coherent fuselage around it. Phase 1 only: the shipped wrecks are the
re-baked CC BY models, the helicopter's collision now heli_collision.py.
"""

import math
import random

from mathutils import Euler, Matrix, Vector

import vehicle_bpy as vb
from vehicle_spec import HELI_DROP, HELI_PITCH, HELI_SHELL, PHASE1_HELI_BOXES, WRECK_BOXES



def bmat(b) -> Matrix:
    m = Matrix.Translation(Vector(b['c']))
    if b.get('rot'):
        m = m @ Euler([math.radians(a) for a in b['rot']], 'XYZ').to_matrix().to_4x4()
    return m


def put(obj, frame: Matrix):
    """Move an object authored in game space into a game-space frame."""
    obj.matrix_world = vb.C @ frame @ vb.C.inverted() @ obj.matrix_world
    return obj


def boxes(kind):
    return dict(PHASE1_HELI_BOXES if kind == 'heli' else WRECK_BOXES[kind])


# ------------------------------------------------------------------------------- helicopter

HELI_F = Matrix.Translation((0.0, HELI_DROP, 0.0)) @ Matrix.Rotation(math.radians(HELI_PITCH), 4, 'Z')
"""The shell frame: authored axis-aligned, pitched nose-down about the origin (shared props.ts)."""


def heli_parts(M, hi: bool):
    """A coherent crashed utility helicopter around the reworked collision (vehicle_spec.HELI_SHELL,
    shell frame F: x along the cabin, nose −X; floor top 0.25, roof 2.5–2.6, sides z ±1.25)."""
    S = HELI_SHELL
    B = boxes('heli')
    parts, cutters = [], []
    P = parts.append
    rnd = random.Random(11)
    hull, inner, metal, glass_c = M['hull'], M['inner'], M['metal'], M['crazed']
    seg = 3 if hi else 1
    bv = 0.02 if hi else 0.012

    def F(o):
        return put(o, HELI_F)

    def dent(o, amt, cuts_hi=3, cuts_lo=1):
        vb.displace_noise(o, amt if hi else amt * 0.6, 0.7)
        vb.subdivide(o, cuts_hi if hi else cuts_lo)
        return o

    def cut(o, cutter):
        cutter.hide_render = True
        cutter.hide_viewport = True
        m = o.modifiers.new(f'cut_{cutter.name}', 'BOOLEAN')
        m.object = cutter
        m.operation = 'DIFFERENCE'
        m.solver = 'EXACT'
        o.modifiers.move(len(o.modifiers) - 1, 0)
        cutters.append(cutter)

    floor_top = S['floor']['c'][1] + S['floor']['s'][1] / 2
    roof_bot = S['roof']['c'][1] - S['roof']['s'][1] / 2
    roof_top = S['roof']['c'][1] + S['roof']['s'][1] / 2
    W = S['floor']['s'][2] / 2  # 1.25

    # --- lower fuselage / belly: the floor slab, bottom edges rounded, skin seams.
    fb = S['floor']
    belly = vb.prism('belly', [(-W, fb['c'][1] - 0.3 + 0.22), (-W + 0.22, fb['c'][1] - 0.3), (W - 0.22, fb['c'][1] - 0.3),
                               (W, fb['c'][1] - 0.3 + 0.22), (W, floor_top), (-W, floor_top)],
                     fb['s'][0], hull, axis='x', c=(fb['c'][0], 0, 0), bev=bv, segs=seg)
    P(F(dent(belly, 0.03)))
    P(F(vb.box('floor_deck', (0, floor_top + 0.01, 0), (7.8, 0.02, 2.3), inner)))
    # --- cabin side walls (collision walls), cut for windows; the door gaps are the box gaps.
    win_cuts = {'wall_l1': [(-1.6, 0.7)], 'wall_l2': [(0.0, 0.8)], 'wall_r1': [(-0.6, 0.8), (0.6, 0.8)], 'wall_r2': [(0.0, 0.6)]}
    for key in ('wall_l1', 'wall_l2', 'wall_r1', 'wall_r2'):
        b = S[key]
        c = b['c']
        sgn = 1 if c[2] > 0 else -1
        # Skin = the wall's outer 6 cm (collision is 0.1 thick at z ±1.15 … 1.25).
        o = vb.box(key, (c[0], c[1], sgn * (W - 0.03)), (b['s'][0], b['s'][1], 0.06), hull, bev=bv, segs=seg)
        for k, (dx, w) in enumerate(win_cuts[key]):
            wc = vb.box(f'wcut_{key}_{k}', (c[0] + dx, 1.85, sgn * W), (w, 0.55, 0.3), None)
            cut(o, wc)
            P(F(vb.box(f'win_{key}_{k}', (c[0] + dx, 1.85, sgn * (W - 0.05)), (w + 0.02, 0.57, 0.02), glass_c)))
        P(F(dent(o, 0.03, 3, 1)))
        # Inner lining (the collision's inner half) + frames.
        P(F(vb.box(f'{key}_in', (c[0], c[1], sgn * (W - 0.085)), (b['s'][0] - 0.02, b['s'][1] - 0.05, 0.03), inner)))
        for j in range(int(b['s'][0] / 0.55) + 1):
            x = c[0] - b['s'][0] / 2 + 0.1 + j * 0.55
            if x > c[0] + b['s'][0] / 2 - 0.05:
                break
            P(F(vb.box(f'frame_{key}_{j}', (x, (floor_top + roof_bot) / 2, sgn * (W - 0.11)), (0.05, roof_bot - floor_top, 0.04), metal)))
    # Door jambs + sill/header at each opening.
    for key, end in (('wall_l1', 1), ('wall_l2', -1), ('wall_r1', 1), ('wall_r2', -1)):
        b = S[key]
        c = b['c']
        sgn = 1 if c[2] > 0 else -1
        xe = c[0] + end * b['s'][0] / 2
        P(F(vb.box(f'jamb_{key}', (xe - end * 0.035, (floor_top + roof_bot) / 2, sgn * (W - 0.05)), (0.07, roof_bot - floor_top + 0.1, 0.1),
                   metal, bev=0.008)))
    for sgn, (x0, x1) in ((-1, (-0.8, 1.2)), (1, (0.4, 2.3))):
        P(F(vb.box(f'header_{sgn}', ((x0 + x1) / 2, roof_bot - 0.04, sgn * (W - 0.05)), (x1 - x0 + 0.1, 0.08, 0.1), metal)))
        P(F(vb.box(f'sill_{sgn}', ((x0 + x1) / 2, floor_top + 0.02, sgn * (W - 0.05)), (x1 - x0 + 0.1, 0.05, 0.1), metal)))
        P(F(vb.tube(f'door_rail_{sgn}', [(x0 - 0.3, roof_bot + 0.02, sgn * (W + 0.03)), (x1 + 2.0, roof_bot + 0.02, sgn * (W + 0.03))],
                    0.018, metal, 8)))
    # Left sliding door slid back over the rear wall (outside); the right one torn off, on the ground.
    sd = vb.box('slide_door', (2.35, (floor_top + roof_bot) / 2, -(W + 0.045)), (2.0, roof_bot - floor_top - 0.06, 0.05), hull, bev=bv,
                segs=seg)
    cut(sd, vb.box('sdcut', (2.35, 1.85, -(W + 0.05)), (0.7, 0.5, 0.2), None))
    P(F(dent(sd, 0.03)))
    P(F(vb.box('sd_win', (2.35, 1.85, -(W + 0.04)), (0.72, 0.52, 0.02), glass_c)))
    # --- roof: skin + rounded corner fairings (inside the collision's square corners).
    rb = S['roof']
    P(F(dent(vb.box('roof', rb['c'], (rb['s'][0], rb['s'][1], 2.3), hull, bev=bv, segs=seg), 0.03, 3, 1)))
    for sgn in (-1, 1):
        fair = vb.cyl(f'fair_{sgn}', (rb['c'][0], roof_top - 0.2, sgn * (W - 0.2)), 0.2, rb['s'][0], hull, 'x', 12 if hi else 6)
        P(F(fair))
    # Engine deck / cowling (collision box) with intakes, exhausts, the mast, hub and blades.
    cb = S['cowl']
    cx, cy, cz = cb['c']
    cow = vb.prism('cowl', [(cz - 0.6, cy - 0.17), (cz + 0.6, cy - 0.17), (cz + 0.52, cy + 0.12), (cz + 0.3, cy + 0.17),
                            (cz - 0.3, cy + 0.17), (cz - 0.52, cy + 0.12)], cb['s'][0], hull, axis='x', c=(cx, 0, 0),
                   bev=0.03 if hi else 0.02, segs=seg)
    P(F(dent(cow, 0.025)))
    for k in (-1, 1):
        P(F(vb.box(f'intake_{k}', (cx - 1.0, cy + 0.02, cz + k * 0.55), (0.35, 0.22, 0.12), metal, bev=0.02)))
        P(F(vb.cyl(f'exh_{k}', (cx + 1.45, cy + 0.08, cz + k * 0.35), 0.11, 0.45, metal, 'x', 14 if hi else 8, rot=(0, 0, 18), r2=0.13)))
    mx = cx - 1.3
    P(F(vb.cyl('mast', (mx, roof_top + 0.35, 0.0), 0.11, 0.7, metal, 'y', 16 if hi else 10)))
    P(F(vb.cyl('swash', (mx, roof_top + 0.55, 0.0), 0.24, 0.08, metal, 'y', 18 if hi else 10, bev=0.01)))
    P(F(vb.cyl('hub', (mx, roof_top + 0.72, 0.0), 0.3, 0.16, metal, 'y', 18 if hi else 10, bev=0.02)))
    for k, (ang, ln, droop) in enumerate(((35, 4.8, 18), (215, 1.6, 6), (125, 3.4, 24), (305, 0.9, 3))):
        a = math.radians(ang)
        r0 = 0.32
        cxk = mx + math.cos(a) * (r0 + ln / 2 * math.cos(math.radians(droop)))
        czk = math.sin(a) * (r0 + ln / 2 * math.cos(math.radians(droop)))
        P(F(vb.box(f'blade_{k}', (cxk, roof_top + 0.74 - math.sin(math.radians(droop)) * ln / 2, czk), (ln, 0.05, 0.42), M['blade'],
                   rot=(0, -ang, -droop), bev=0.01)))
    # --- cockpit: instrument bulkhead (the windscreen collision box), crushed nose, canopy.
    nb = S['nose']
    nx = nb['c'][0]
    P(F(vb.box('bulkhead', nb['c'], (0.08, nb['s'][1], 2.4), inner, bev=0.01)))
    P(F(vb.box('console', (nx - 0.25, floor_top + 0.75, 0), (0.45, 0.22, 2.0), metal, rot=(0, 0, 25), bev=0.02, segs=seg)))
    kb = S['nose_box']
    kx, ky, kz = kb['c']
    kx0 = kx - kb['s'][0] / 2
    ktop = ky + kb['s'][1] / 2
    nose = vb.prism('nose_cone', [(nx - 0.04, ky - 0.5), (nx - 0.04, ktop), (kx0 + 0.25, ktop - 0.02), (kx0, ktop - 0.35),
                                  (kx0 + 0.08, ky - 0.5)], kb['s'][2], hull, axis='z', bev=0.06 if hi else 0.04, segs=seg)
    for v in nose.data.vertices:
        if v.co.x < kx0 + 0.4:
            v.co.z *= 0.86
    P(F(dent(nose, 0.05)))
    # Canopy: frame struts from the roof's front edge curving down to the nose top; crazed panes
    # between them (opaque: the windscreen behind is collision).
    zs = (-1.15, -0.55, 0.0, 0.55, 1.15)
    pts_for = lambda z, f: [(nx + 0.02, roof_top - 0.05, z), (nx - 0.4, roof_top - 0.25, z * 0.97), (nx - 0.75, ktop + 0.55, z * f),  # noqa: E731
                            (kx0 + 0.18, ktop + 0.02, z * f * 0.95)]
    for z in zs:
        P(F(vb.tube(f'canopy_{z}', pts_for(z, 0.9), 0.035, hull, 8 if hi else 6)))
    P(F(vb.tube('canopy_bow', [(nx - 0.75, ktop + 0.55, -1.05), (nx - 0.8, ktop + 0.58, 0.0), (nx - 0.75, ktop + 0.55, 1.05)], 0.03, hull, 6)))
    for i in range(len(zs) - 1):
        za, zb = zs[i], zs[i + 1]
        pa, pb = pts_for(za, 0.9), pts_for(zb, 0.9)
        if i == 2:
            continue  # one pane blown out
        verts = [pa[0], pb[0], pb[1], pa[1], pa[2], pb[2], pb[3], pa[3]]
        faces = [(0, 1, 2, 3), (3, 2, 5, 4), (4, 5, 6, 7)]
        P(F(vb.mesh_from(f'pane_{i}', [tuple(v) for v in verts], faces, glass_c, smooth=True)))
    # --- interior: seat frames (low), floor ribs, debris.
    for k, x in enumerate((1.6, 2.5, 3.3)):
        P(F(vb.tube(f'seatframe_{k}', [(x, floor_top, 0.9), (x, floor_top + 0.42, 0.9), (x, floor_top + 0.42, 0.2), (x, floor_top, 0.2)],
                    0.022, metal, 8)))
    if hi:
        for i in range(24):
            P(F(vb.box(f'rib_{i}', (-3.6 + i * 0.31, floor_top + 0.022, 0), (0.03, 0.012, 2.2), inner)))
        # Rivet lines along every wall and the roof.
        for key in ('wall_l1', 'wall_l2', 'wall_r1', 'wall_r2'):
            b = S[key]
            c = b['c']
            sgn = 1 if c[2] > 0 else -1
            for j in range(int(b['s'][0] / 0.09)):
                x = c[0] - b['s'][0] / 2 + 0.05 + j * 0.09
                for yy in (0.45, 1.25, 2.3):
                    P(F(vb.cyl(f'rv_{key}_{j}_{yy}', (x, yy, sgn * (W + 0.003)), 0.008, 0.008, metal, 'z', 6)))
            for j in range(int(b['s'][0] / 0.6) + 1):
                x = c[0] - b['s'][0] / 2 + 0.1 + j * 0.6
                P(F(vb.box(f'seam_{key}_{j}', (x, (floor_top + roof_bot) / 2, sgn * (W + 0.001)), (0.012, roof_bot - floor_top, 0.006), M['seam'])))
        for j in range(int(rb['s'][0] / 0.09)):
            x = rb['c'][0] - rb['s'][0] / 2 + 0.05 + j * 0.09
            for zz in (-0.9, 0.9):
                P(F(vb.cyl(f'rv_roof_{j}_{zz}', (x, roof_top + 0.003, zz), 0.008, 0.008, metal, 'y', 6)))

    # --- outside the shell (props frame): tail boom, ground rotor blade, skid, debris
    bb = B['boom']
    boom_m = bmat(bb)
    L = bb['s'][0]
    prof = [(0.40 - 0.2 * (i / 10), -L / 2 + (i / 10) * L) for i in range(11)]
    boom = vb.lathe('boom', prof, hull, segs=16 if hi else 10, axis='x', angle=60)
    vb.displace_noise(boom, 0.03 if hi else 0.015, 0.5)
    P(put(boom, boom_m))
    P(put(vb.box('boom_fin', (L / 2 - 0.45, 0.6, 0.0), (1.0, 1.1, 0.07), hull, rot=(0, 0, 25), taper=(0.45, 0.0), bev=0.01), boom_m))
    P(put(vb.box('boom_stab', (L / 2 - 1.5, 0.0, 0.0), (0.55, 0.05, 1.7), hull, bev=0.01), boom_m))
    P(put(vb.box('boom_gear', (L / 2 - 0.15, 0.15, 0.0), (0.4, 0.32, 0.3), metal, bev=0.02, segs=seg), boom_m))
    P(put(vb.cyl('tail_rotor', (L / 2 - 0.2, 0.5, 0.2), 0.08, 0.1, metal, 'z', 10), boom_m))
    for k in range(2):
        P(put(vb.box(f'tr_blade_{k}', (L / 2 - 0.2, 0.5, 0.25), (0.08, 1.1, 0.02), M['blade'], rot=(0, 0, 70 + k * 90)), boom_m))
    for k in range(8 if hi else 5):
        a = 2 * math.pi * k / (8 if hi else 5)
        P(put(vb.box(f'shard_{k}', (-L / 2 - 0.08, math.cos(a) * 0.36, math.sin(a) * 0.36), (0.22, 0.03, 0.16), hull,
                     rot=(math.degrees(a), rnd.uniform(-25, 25), rnd.uniform(-20, 20))), boom_m))
    bl = B['blade']
    bp = [(-0.22, 0.0), (-0.18, 0.035), (0.0, 0.055), (0.18, 0.03), (0.225, 0.0), (0.18, -0.01), (0.0, -0.012), (-0.18, -0.008)]
    blade = vb.prism('blade', bp, bl['s'][0], M['blade'], axis='x')
    bend = blade.modifiers.new('bend', 'SIMPLE_DEFORM')
    bend.deform_method = 'BEND'
    bend.angle = math.radians(8)
    bend.deform_axis = 'Y'
    P(put(blade, bmat(bl)))
    sk = B['skid']
    skid_m = bmat(sk)
    P(put(vb.tube('skid', [(-3.0, 0.0, 0), (2.7, 0.0, 0), (3.1, 0.18, 0)], 0.07, metal, 12 if hi else 8), skid_m))
    for x in (-1.6, 1.4):
        P(put(vb.tube(f'strut_{x}', [(x, 0.05, 0.0), (x + 0.1, 0.45, 0.25), (x + 0.15, 0.55, 0.42)], 0.05, metal, 10 if hi else 6), skid_m))
    P(vb.box('door_ground', (1.6, 0.03, 2.4), (1.8, 0.05, 1.5), hull, rot=(3, -12, 2), bev=0.01, segs=seg))
    for k in range(14 if hi else 9):
        x = rnd.uniform(-6.5, 9.0)
        z = rnd.uniform(-4.0, 5.0)
        if abs(z) < 1.6 and -5.2 < x < 4.6:
            continue
        s = rnd.uniform(0.15, 0.6)
        P(vb.box(f'debris_{k}', (x, 0.02, z), (s, 0.03, s * rnd.uniform(0.3, 1.0)), hull if k % 3 else metal,
                 rot=(rnd.uniform(-8, 8), rnd.uniform(0, 180), rnd.uniform(-8, 8))))
    return parts, cutters


# ------------------------------------------------------------------------------- tank


def tank_parts(M, hi: bool):
    B = boxes('tank')
    parts, cutters = [], []
    P = parts.append
    rnd = random.Random(23)
    hull, metal, rubber = M['hull'], M['metal'], M['rubber']
    seg = 3 if hi else 1
    bev = 0.03 if hi else 0.02

    # --- running gear inside each track box (7.2 × 1.0 × 0.75, centred z = ±1.35)
    for side, key in ((-1, 'track_l'), (1, 'track_r')):
        b = B[key]
        zc = b['c'][2]
        L = b['s'][0]
        w = 0.62
        # Road wheels (6) + idler (front, −X) + sprocket (rear) + return rollers.
        rw = 0.31
        xs = [-2.45 + i * 0.98 for i in range(6)]
        missing = (1 if side < 0 else 4)
        for i, x in enumerate(xs):
            if i == missing:
                continue
            for dz in (-0.17, 0.17):
                P(vb.cyl(f'rw_{side}_{i}_{dz}', (x, rw + 0.06, zc + dz), rw, 0.22, metal, 'z', 22 if hi else 14, bev=0.02))
            P(vb.cyl(f'hubc_{side}_{i}', (x, rw + 0.06, zc + side * 0.3), 0.1, 0.06, metal, 'z', 12 if hi else 8))
        P(vb.cyl(f'idler_{side}', (-L / 2 + 0.42, 0.55, zc), 0.30, 0.5, metal, 'z', 20 if hi else 12, bev=0.02))
        P(vb.cyl(f'sprocket_{side}', (L / 2 - 0.42, 0.58, zc), 0.34, 0.5, metal, 'z', 24 if hi else 14, bev=0.02))
        for x in (-1.5, 0.0, 1.5):
            P(vb.cyl(f'roller_{side}_{x}', (x, 0.86, zc), 0.08, 0.4, metal, 'z', 10 if hi else 8))
        # Track belt: segments along the loop (bottom, front up, top, rear down).
        loop = [(-L / 2 + 0.75, 0.04), (L / 2 - 0.75, 0.04), (L / 2 - 0.15, 0.4), (L / 2 - 0.12, 0.62), (L / 2 - 0.42, 0.93),
                (-L / 2 + 0.42, 0.93), (-L / 2 + 0.1, 0.62), (-L / 2 + 0.15, 0.36)]
        broken = side < 0
        for i in range(len(loop)):
            a, c = loop[i], loop[(i + 1) % len(loop)]
            if broken and i == 6:
                continue  # front lower run gone: the track lies broken in front
            n = max(1, int(math.hypot(c[0] - a[0], c[1] - a[1]) / (0.17 if hi else 0.5)))
            for k in range(n):
                t0, t1 = k / n, (k + 1) / n
                p0 = (a[0] + (c[0] - a[0]) * t0, a[1] + (c[1] - a[1]) * t0)
                p1 = (a[0] + (c[0] - a[0]) * t1, a[1] + (c[1] - a[1]) * t1)
                ang = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))
                ln = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
                P(vb.box(f'tl_{side}_{i}_{k}', ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, zc), (ln + (0.0 if hi else 0.01), 0.07, w),
                         rubber, rot=(0, 0, ang), bev=0.012 if hi else 0.0))
        if broken:
            # Broken run lying flat on the ground ahead of the idler.
            for k in range(8 if hi else 3):
                x = -L / 2 - 0.1 - k * (0.17 if hi else 0.45)
                P(vb.box(f'tlb_{k}', (x, 0.035, zc + 0.1 + k * 0.05), (0.17 if hi else 0.45, 0.07, w), rubber,
                         rot=(0, rnd.uniform(-6, 6) + k * 3, 0), bev=0.01 if hi else 0.0))
        # Side skirt (armour) over the upper run, one panel missing on the right.
        for i in range(5):
            if side > 0 and i == 3:
                continue
            x = -L / 2 + 0.75 + i * 1.42
            P(vb.box(f'skirt_{side}_{i}', (x, 0.74, zc + side * 0.355), (1.38, 0.5, 0.04), hull, rot=(side * 4 if i == 2 else 0, 0, 0),
                     bev=0.012, segs=seg))
        # Fender over the track (top of the track box).
        P(vb.box(f'fender_{side}', (0, 0.985, zc), (L - 0.1, 0.03, 0.75), hull, bev=0.01))
        P(vb.box(f'fender_lip_{side}', (-L / 2 + 0.15, 0.9, zc), (0.3, 0.18, 0.74), hull, rot=(0, 0, 30), bev=0.01))

    # --- hull (6.6 × 1.35 × 2.0, y 0.4 … 1.75)
    hb = B['hull']
    hx, hy, hz = hb['c']
    sx, sy, sz = hb['s']
    x0, x1, y0, y1 = hx - sx / 2, hx + sx / 2, hy - sy / 2, hy + sy / 2
    prof = [(x0 + 0.25, y0), (x1 - 0.2, y0), (x1, y0 + 0.35), (x1, y1 - 0.05), (x1 - 0.05, y1), (x0 + 0.42, y1),
            (x0, y1 - 0.2), (x0, y0 + 0.45)]
    P(vb.prism('hull', prof, sz, hull, axis='z', bev=bev, segs=seg))
    # Engine deck grilles + exhausts at the rear, hatches + periscopes at the front.
    for k in range(3):
        P(vb.box(f'grille_{k}', (1.6 + k * 0.5, y1 + 0.02, -0.45), (0.42, 0.04, 0.8), metal, bev=0.008))
        P(vb.box(f'grille_b_{k}', (1.6 + k * 0.5, y1 + 0.02, 0.45), (0.42, 0.04, 0.8), metal, bev=0.008))
    for k in (-1, 1):
        P(vb.box(f'exhaust_{k}', (x1 - 0.05, y1 - 0.3, k * 0.6), (0.12, 0.3, 0.5), metal, bev=0.015))
    P(vb.cyl('drv_hatch', (x0 + 0.75, y1 + 0.03, -0.45), 0.28, 0.06, hull, 'y', 20 if hi else 12, bev=0.01))
    for k in range(3):
        P(vb.box(f'periscope_{k}', (x0 + 0.5, y1 + 0.06, -0.75 + k * 0.2), (0.08, 0.1, 0.14), metal, bev=0.008))
    # Tow hooks, headlights (guards), front plate bolts.
    for k in (-1, 1):
        P(vb.box(f'tow_{k}', (x0 - 0.04, y0 + 0.25, k * 0.75), (0.12, 0.16, 0.12), metal, bev=0.01))
        P(vb.box(f'lamp_{k}', (x0 + 0.1, y1 - 0.1, k * 0.85), (0.14, 0.12, 0.18), metal, bev=0.01))
    for i in range(5):
        for j in range(2):
            P(vb.box(f'era_h_{i}_{j}', (x0 - 0.03, y1 - 0.34 - j * 0.27, -0.8 + i * 0.4), (0.06, 0.24, 0.36), hull, bev=0.01))
    # Tools / stowage on the fenders.
    P(vb.box('stow_box', (2.2, 1.2, 1.35), (1.0, 0.42, 0.6), hull, bev=0.02, segs=seg))
    P(vb.cyl('tow_cable', (-0.5, 1.06, -1.35), 0.04, 3.5, metal, 'x', 8))
    for k in range(2):
        P(vb.box(f'jerry_t_{k}', (2.9, 1.25, -1.2 + k * 0.25), (0.34, 0.47, 0.17), M['metal'], bev=0.02))

    # --- turret (3.4 × 0.9 × 2.8, tilted (6, 22, 4)) in its own frame
    tb = B['turret']
    tm = bmat(tb)
    tx, ty, tz = (s / 2 for s in tb['s'])
    plan = [(-tx + 0.0, -tz + 0.55), (-tx + 0.45, -tz), (tx - 0.25, -tz), (tx, -tz + 0.25), (tx, tz - 0.25), (tx - 0.25, tz),
            (-tx + 0.45, tz), (-tx, tz - 0.55)]
    tur = vb.prism('turret', plan, tb['s'][1], hull, axis='y', bev=bev, segs=seg, angle=30)
    for v in tur.data.vertices:
        if v.co.y > 0:
            v.co.x *= 0.97
            v.co.z *= 0.95
    P(put(tur, tm))
    # Mantlet + gun root, cupola (hatch blown open), sights, smoke dischargers, bustle rack.
    P(put(vb.box('mantlet', (-tx - 0.08, -0.05, 0.0), (0.3, 0.62, 0.8), hull, bev=0.03 if hi else 0.02, segs=seg), tm))
    P(put(vb.cyl('cupola', (0.6, ty + 0.1, -0.6), 0.36, 0.2, hull, 'y', 20 if hi else 12, bev=0.02), tm))
    P(put(vb.cyl('cup_hatch', (0.6 + 0.38, ty + 0.5, -0.6), 0.33, 0.05, hull, 'y', 20 if hi else 12, rot=(0, 0, -78), bev=0.01), tm))
    P(put(vb.box('sight', (-0.75, ty + 0.14, 0.8), (0.34, 0.26, 0.3), metal, bev=0.02, segs=seg), tm))
    P(put(vb.box('sight_glass', (-0.93, ty + 0.15, 0.8), (0.02, 0.14, 0.22), M['seam']), tm))
    P(put(vb.cyl('periscope', (0.25, ty + 0.08, 0.6), 0.09, 0.16, metal, 'y', 10), tm))
    P(put(vb.cyl('antenna', (tx - 0.3, ty + 0.9, 1.0), 0.008, 1.8, metal, 'y', 5, r2=0.004), tm))
    P(put(vb.cyl('ant_base', (tx - 0.3, ty + 0.03, 1.0), 0.05, 0.06, metal, 'y', 8), tm))
    # Add-on armour blocks on the turret cheeks and the glacis.
    for sgn in (-1, 1):
        for i in range(3):
            for j in range(2):
                P(put(vb.box(f'era_t_{sgn}_{i}_{j}', (-tx + 0.65 + i * 0.36, -0.14 + j * 0.27, sgn * (tz + 0.03)), (0.33, 0.24, 0.06), hull,
                             bev=0.01), tm))
    P(put(vb.box('bustle_box', (tx + 0.18, ty - 0.2, 0.0), (0.32, 0.3, 1.6), M['metal'], bev=0.02), tm))
    for k in range(4):
        for sgn in (-1, 1):
            P(put(vb.cyl(f'smoke_{sgn}_{k}', (-0.4 + k * 0.17, 0.15, sgn * (tz + 0.06)), 0.055, 0.22, metal, 'y', 8 if hi else 6,
                         rot=(sgn * 35, 0, 0)), tm))
    P(put(vb.tube('bustle', [(tx - 0.05, ty - 0.05, -tz + 0.3), (tx + 0.35, ty - 0.05, -tz + 0.3), (tx + 0.35, ty - 0.05, tz - 0.3),
                             (tx - 0.05, ty - 0.05, tz - 0.3)], 0.025, metal, 8), tm))
    P(put(vb.cyl('mg_mount', (0.1, ty + 0.12, 0.2), 0.12, 0.16, metal, 'y', 12), tm))
    # --- barrel (box 4.2 × 0.22 × 0.22) in its frame: tube, fume extractor, muzzle.
    gb = B['barrel']
    gm = bmat(gb)
    gl = gb['s'][0] / 2
    P(put(vb.cyl('barrel', (0.0, 0, 0), 0.075, gl * 2, metal, 'x', 16 if hi else 10, r2=0.085), gm))
    P(put(vb.cyl('fume', (0.3, 0, 0), 0.108, 0.8, metal, 'x', 18 if hi else 12, bev=0.02), gm))
    P(put(vb.cyl('muzzle', (-gl + 0.12, 0, 0), 0.098, 0.26, metal, 'x', 16 if hi else 10, bev=0.015), gm))
    P(put(vb.cyl('thermal', (-0.6, 0, 0), 0.095, 1.6, hull, 'x', 16 if hi else 10), gm))
    # --- debris: hatch lid, road wheel, track links, ammo boxes
    P(vb.cyl('loose_wheel', (-1.8, 0.11, 2.6), 0.31, 0.22, metal, 'y', 20 if hi else 12, bev=0.02))
    P(vb.box('loose_skirt', (1.9, 0.03, 2.45), (1.38, 0.04, 0.5), hull, rot=(0, -20, 4), bev=0.01))
    for k in range(10 if hi else 6):
        x = rnd.uniform(-6.0, 5.0)
        z = rnd.uniform(-3.5, 3.5)
        if abs(z) < 2.0 and abs(x) < 4.0:
            continue
        P(vb.box(f'link_{k}', (x, 0.035, z), (0.17, 0.07, 0.62), rubber, rot=(0, rnd.uniform(0, 180), 0), bev=0.01 if hi else 0))
    for k in range(3):
        P(vb.box(f'ammo_{k}', (-4.6 + k * 0.4, 0.15, -2.2 + k * 0.1), (0.35, 0.3, 0.55), metal, rot=(0, k * 25, 0), bev=0.015))
    if hi:
        # Weld seams and bolts on the hull and turret.
        for k in range(18):
            x = x0 + 0.3 + k * 0.34
            for zz in (-0.97, 0.97):
                P(vb.cyl(f'hb_{k}_{zz}', (x, y1 - 0.1, zz + (0.02 if zz > 0 else -0.02)), 0.014, 0.02, metal, 'z', 6))
        for k in range(12):
            P(put(vb.cyl(f'tbolt_{k}', (-tx + 0.4 + k * 0.24, ty + 0.01, -tz + 0.3), 0.016, 0.02, metal, 'y', 6), tm))
            P(put(vb.cyl(f'tbolt2_{k}', (-tx + 0.4 + k * 0.24, ty + 0.01, tz - 0.3), 0.016, 0.02, metal, 'y', 6), tm))
        # Anti-slip deck texture.
        for k in range(80):
            x = rnd.uniform(x0 + 0.3, x1 - 1.6)
            z = rnd.uniform(-0.9, 0.9)
            P(vb.box(f'dot_{k}', (x, y1 + 0.003, z), (0.06, 0.006, 0.06), metal, rot=(0, 45, 0)))
    return parts, cutters


def scorch_decal(name, radius, center=(0.0, 0.0), segs=24, mat=None, rnd_seed=3):
    """Ground scorch: an irregular disc 1 cm above the ground, uvs = planar 0–1 (its own small
    RGBA texture)."""
    rnd = random.Random(rnd_seed)
    verts = [(center[0], 0.012, center[1])]
    for i in range(segs):
        a = 2 * math.pi * i / segs
        r = radius * rnd.uniform(0.82, 1.12)
        verts.append((center[0] + math.cos(a) * r, 0.012, center[1] + math.sin(a) * r))
    faces = [(0, 1 + i, 1 + (i + 1) % segs) for i in range(segs)]
    o = vb.mesh_from(name, verts, faces, mat)
    uv = o.data.uv_layers.new(name='UVMap')
    for poly in o.data.polygons:
        for li in poly.loop_indices:
            v = verts[o.data.loops[li].vertex_index]
            uv.data[li].uv = (0.5 + (v[0] - center[0]) / (2.4 * radius), 0.5 + (v[2] - center[1]) / (2.4 * radius))
    return o
