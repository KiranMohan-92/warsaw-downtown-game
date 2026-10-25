"""Armored 4x4 utility truck (original design, no markings). Blender only.

Game coordinates: +Y up, front +Z, left +X (facing +Z), origin on the ground midway between the
axles. Contract numbers live in vehicle_spec.TRUCK.
"""

import math
import random

import vehicle_bpy as vb
from vehicle_spec import TRUCK as T

R = T['wheel_radius']
TW = T['tyre_width']
AX = T['wheelbase'] / 2
TX = T['track'] / 2
WHEELS = {
    'wheel_fl': (TX, R, AX),
    'wheel_fr': (-TX, R, AX),
    'wheel_rl': (TX, R, -AX),
    'wheel_rr': (-TX, R, -AX),
}
ARCH_R = 0.575
Z_FRONT = T['length'] / 2
Z_REAR = -T['length'] / 2
HALF_W = T['width'] / 2

# Key heights.
BED_FLOOR = 1.14
BED_WALL = 1.62
CAB_FLOOR = 0.62
ROOF = T['height']
HOOD_REAR_Y = 1.47
CAB_BACK = -0.62
WS_BASE_Z = 0.92
WS_TOP_Z = 0.76
ROOF_UNDER = ROOF - 0.07
LEAN_BASE = 1.47
LEAN_K = 0.16


def _side_lean(x, y, base=LEAN_BASE, k=LEAN_K):
    """Cab tumblehome: the sides above the beltline lean in."""
    if y <= base:
        return x
    return x - math.copysign((y - base) * k, x)


def arch_profile(z0, grow=0.0):
    """Angular wheel-well outline (z, y) around an axle at z0."""
    w0, w1, ytop, ymid = 0.66 + grow, 0.42 + grow, 1.04 + grow, 0.64
    return [(z0 - w0, 0.15), (z0 + w0, 0.15), (z0 + w0, ymid), (z0 + w1, ytop), (z0 - w1, ytop), (z0 - w0, ymid)]


def arches(cut_objs, wheels=WHEELS):
    for o in cut_objs:
        for name, (x, y, z) in wheels.items():
            c = vb.prism(f'{o.name}_arch_{name}', arch_profile(z), 0.9, None, c=(math.copysign(0.96, x), 0, 0))
            cut(o, c)


def cut(o, cutter):
    cutter.hide_render = True
    cutter.hide_viewport = True
    m = o.modifiers.new(f'cut_{cutter.name}', 'BOOLEAN')
    m.object = cutter
    m.operation = 'DIFFERENCE'
    m.solver = 'EXACT'
    o.modifiers.move(len(o.modifiers) - 1, 0)
    return o


def strip(name, a, b, t, depth, mat, x, bev=0.0):
    """A bar of section (t, depth) from (z, y) point a to b at lateral x (flares, frames)."""
    dz, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dz, dy)
    ang = math.degrees(math.atan2(dy, dz))
    c = (x, (a[1] + b[1]) / 2, (a[0] + b[0]) / 2)
    return vb.box(name, c, (depth, t, ln), mat, rot=(-ang, 0, 0), bev=bev)


def body_parts(M, hi: bool, wrecked: bool):
    """Body parts (no wheels). Returns (parts, glass_parts, cutters)."""
    seg = 3 if hi else 1
    bev = 0.022 if hi else 0.016
    parts, glass, cutters = [], [], []
    P = parts.append
    paint, metal, plastic = M['paint'], M['metal'], M['plastic']
    interior = M['interior']

    # --- lower tub under the bed and the cab, wheel wells cut
    P(vb.prism('tub', [(Z_REAR + 0.08, 0.60), (Z_REAR + 0.03, 0.84), (Z_REAR + 0.03, BED_FLOOR - 0.02),
                       (CAB_BACK, BED_FLOOR - 0.02), (CAB_BACK, 0.50), (Z_REAR + 0.32, 0.50)],
               1.98, paint, bev=bev, segs=seg))
    # Hood / engine block: sloping top, cheeks pulled in, raked lower nose.
    hood_prof = [(WS_BASE_Z - 0.02, 0.50), (Z_FRONT - 0.24, 0.50), (Z_FRONT - 0.10, 0.76),
                 (Z_FRONT - 0.09, 1.28), (Z_FRONT - 0.15, 1.36), (WS_BASE_Z, HOOD_REAR_Y)]
    hood = vb.prism('hood', hood_prof, 1.94, paint, bev=bev, segs=seg)
    for v in hood.data.vertices:
        if v.co.y > 1.27:
            v.co.x *= 0.87
    P(hood)
    slope = math.degrees(math.atan2(HOOD_REAR_Y - 1.36, Z_FRONT - 0.15 - WS_BASE_Z))
    P(vb.box('hood_bulge', (0, (HOOD_REAR_Y + 1.36) / 2 + 0.015, (WS_BASE_Z + Z_FRONT - 0.15) / 2 + 0.05),
             (0.86, 0.05, Z_FRONT - 0.15 - WS_BASE_Z - 0.2), paint, rot=(slope, 0, 0), bev=0.02, segs=seg, taper=(0.12, 0.08)))
    # Grille frame (a recess look in the low mesh) + grille panel.
    gz = Z_FRONT - 0.085
    P(vb.box('grille', (0, 1.02, gz - 0.01), (1.04, 0.46, 0.03), metal, bev=0.006))
    for nm, c, sz in (('gf_t', (0, 1.265, gz + 0.012), (1.12, 0.04, 0.05)), ('gf_b', (0, 0.775, gz + 0.012), (1.12, 0.04, 0.05)),
                      ('gf_l', (0.54, 1.02, gz + 0.012), (0.04, 0.52, 0.05)), ('gf_r', (-0.54, 1.02, gz + 0.012), (0.04, 0.52, 0.05))):
        P(vb.box(nm, c, sz, paint, bev=0.008))
    # Cab sides (door panels) with the tumblehome, window cut, window frame.
    for sx in (1, -1):
        xo = sx * (HALF_W - 0.075)
        prof = [(CAB_BACK, 0.52), (WS_BASE_Z, 0.52), (WS_BASE_Z, HOOD_REAR_Y), (WS_TOP_Z + 0.01, ROOF_UNDER),
                (CAB_BACK, ROOF_UNDER)]
        side = vb.prism(f'cab_side_{sx}', prof, 0.07, paint, c=(xo, 0, 0), bev=bev * 0.7, segs=seg)
        for v in side.data.vertices:
            v.co.x = _side_lean(v.co.x + xo, v.co.y) - xo
        y0, y1, z0, z1 = 1.53, 1.85, -0.30, 0.66
        lean = math.degrees(math.atan(LEAN_K))
        xw = _side_lean(xo, (y0 + y1) / 2)
        win = vb.box(f'win_cut_{sx}', (xw, (y0 + y1) / 2, (z0 + z1) / 2), (0.5, y1 - y0, z1 - z0), None,
                     rot=(0, 0, -sx * lean))
        cut(side, win)
        cutters.append(win)
        P(side)
        glass.append(vb.box(f'glass_side_{sx}', (xw - sx * 0.01, (y0 + y1) / 2, (z0 + z1) / 2), (0.012, y1 - y0 + 0.02, z1 - z0 + 0.02),
                            M['glass'], rot=(0, 0, -sx * lean)))
        # Raised armour-glass frame round the window.
        for nm, c, sz in ((f'wf_t{sx}', ((y1 + 0.03), (z0 + z1) / 2), (0.06, z1 - z0 + 0.12)),
                          (f'wf_b{sx}', ((y0 - 0.03), (z0 + z1) / 2), (0.06, z1 - z0 + 0.12)),
                          (f'wf_f{sx}', ((y0 + y1) / 2, z1 + 0.03), (y1 - y0, 0.06)),
                          (f'wf_r{sx}', ((y0 + y1) / 2, z0 - 0.03), (y1 - y0, 0.06))):
            P(vb.box(nm, (_side_lean(xo, c[0]) + sx * 0.04, c[0], c[1]), (0.025, sz[0], sz[1]), paint, rot=(0, 0, -sx * lean),
                     bev=0.006))
    # Roof (+ drip rails).
    roof_w = (HALF_W - 0.075 - (ROOF_UNDER - LEAN_BASE) * LEAN_K) * 2 + 0.07
    roof_len = WS_TOP_Z - CAB_BACK + 0.07
    roof_cz = (CAB_BACK + WS_TOP_Z) / 2 + 0.005
    P(vb.box('roof', (0, ROOF - 0.035, roof_cz), (roof_w, 0.07, roof_len), paint, bev=bev, segs=seg))
    for sx in (1, -1):
        P(vb.box(f'drip_{sx}', (sx * (roof_w / 2 - 0.01), ROOF - 0.075, roof_cz), (0.03, 0.025, roof_len - 0.04), paint))
    # Windshield frame: a near-upright armoured frame with two panes.
    dz, dy = WS_TOP_Z - WS_BASE_Z, ROOF_UNDER - HOOD_REAR_Y
    ws_len = math.hypot(dz, dy)
    ws_ang = math.degrees(math.atan2(-dz, dy))
    ws_c = ((WS_BASE_Z + WS_TOP_Z) / 2, (HOOD_REAR_Y + ROOF_UNDER) / 2)
    ws_w = roof_w - 0.02
    frame = vb.box('ws_frame', (0, ws_c[1], ws_c[0]), (ws_w, ws_len + 0.05, 0.08), paint, rot=(ws_ang, 0, 0),
                   bev=bev * 0.8, segs=seg)
    for sx in (1, -1):
        hole = vb.box(f'ws_cut_{sx}', (sx * 0.405, ws_c[1] + 0.01, ws_c[0]), (0.70, ws_len - 0.14, 0.4), None, rot=(ws_ang, 0, 0))
        cut(frame, hole)
        cutters.append(hole)
        glass.append(vb.box(f'glass_ws_{sx}', (sx * 0.405, ws_c[1] + 0.01, ws_c[0] - 0.01), (0.72, ws_len - 0.12, 0.014),
                            M['glass'], rot=(ws_ang, 0, 0)))
    P(frame)
    # Visor lip over the windshield.
    P(vb.box('visor', (0, ROOF - 0.05, WS_TOP_Z + 0.07), (roof_w - 0.06, 0.03, 0.14), paint, rot=(-8, 0, 0), bev=0.008))
    # Cab back wall with a small rear window.
    back = vb.box('cab_back', (0, (BED_FLOOR + ROOF_UNDER) / 2, CAB_BACK + 0.035), (roof_w - 0.02, ROOF_UNDER - BED_FLOOR + 0.02, 0.07),
                  paint, bev=bev * 0.7, segs=seg)
    rw = vb.box('rw_cut', (0, 1.70, CAB_BACK), (0.8, 0.26, 0.4), None)
    cut(back, rw)
    cutters.append(rw)
    glass.append(vb.box('glass_rear', (0, 1.70, CAB_BACK + 0.04), (0.82, 0.28, 0.012), M['glass']))
    P(back)
    P(vb.box('cab_back_low', (0, (0.52 + BED_FLOOR) / 2, CAB_BACK + 0.035), (HALF_W * 2 - 0.1, BED_FLOOR - 0.52, 0.07), paint,
             bev=bev * 0.5, segs=seg))
    # Cab floor + dash.
    P(vb.box('cab_floor', (0, CAB_FLOOR - 0.03, (CAB_BACK + WS_BASE_Z) / 2), (HALF_W * 2 - 0.16, 0.06, WS_BASE_Z - CAB_BACK - 0.05), interior))
    dash = vb.prism('dash', [(0.56, 1.05), (WS_BASE_Z - 0.02, 1.05), (WS_BASE_Z - 0.02, 1.45), (0.74, 1.46), (0.58, 1.38),
                             (0.54, 1.20)], HALF_W * 2 - 0.2, plastic, bev=0.02 if hi else 0.012, segs=seg)
    P(dash)
    P(vb.box('dash_low', (0, (CAB_FLOOR + 1.05) / 2, WS_BASE_Z - 0.06), (HALF_W * 2 - 0.2, 1.05 - CAB_FLOOR, 0.1), interior))
    P(vb.box('gauge_hood', (0.45, 1.46, 0.67), (0.42, 0.06, 0.2), plastic, bev=0.015, segs=seg))
    P(vb.box('screen', (-0.05, 1.40, 0.60), (0.24, 0.16, 0.03), plastic, rot=(-20, 0, 0), bev=0.006))
    P(vb.box('console', (0, CAB_FLOOR + 0.17, 0.22), (0.26, 0.34, 0.70), plastic, bev=0.02, segs=seg))
    P(vb.box('radio', (0, 1.0, -0.45), (0.5, 0.3, 0.2), metal, bev=0.01, segs=seg))
    sw_c = (0.45, 1.26, 0.44)
    P(vb.lathe('steer', [(0.17, -0.015), (0.19, -0.022), (0.205, 0.0), (0.19, 0.022), (0.17, 0.015), (0.165, -0.0)],
               plastic, c=sw_c, segs=24 if hi else 16, rot=(-62, 0, 0), axis='y'))
    P(vb.cyl('column', (0.45, 1.20, 0.56), 0.035, 0.30, plastic, 'z', 10, rot=(28, 0, 0)))
    P(vb.box('steer_hub', sw_c, (0.12, 0.05, 0.12), plastic, rot=(28, 0, 0), bev=0.015, segs=seg))
    for sx in (1, -1):
        x = sx * 0.45
        P(vb.box(f'seat_base_{sx}', (x, CAB_FLOOR + 0.12, 0.02), (0.46, 0.24, 0.42), metal, bev=0.01))
        P(vb.box(f'seat_cush_{sx}', (x, 0.86, 0.04), (0.5, 0.12, 0.5), M['fabric'], bev=0.04 if hi else 0.03, segs=3 if hi else 2))
        P(vb.box(f'seat_back_{sx}', (x, 1.20, -0.28), (0.5, 0.62, 0.12), M['fabric'], rot=(-10, 0, 0),
                 bev=0.04 if hi else 0.03, segs=3 if hi else 2))
        P(vb.box(f'seat_head_{sx}', (x, 1.60, -0.35), (0.28, 0.18, 0.1), M['fabric'], rot=(-10, 0, 0), bev=0.03, segs=2))

    # --- bed: floor, ribbed side walls, tailgate, rails, seats, cargo
    bed_len = CAB_BACK - (Z_REAR + 0.03)
    bed_cz = (CAB_BACK + Z_REAR + 0.03) / 2
    P(vb.box('bed_floor', (0, BED_FLOOR - 0.03, bed_cz), (HALF_W * 2 - 0.08, 0.06, bed_len), M.get('bed', metal), bev=0.01))
    for sx in (1, -1):
        P(vb.box(f'bed_wall_{sx}', (sx * (HALF_W - 0.045), (BED_FLOOR + BED_WALL) / 2, bed_cz),
                 (0.06, BED_WALL - BED_FLOOR + 0.02, bed_len), paint, bev=bev * 0.6, segs=seg))
        for k in range(5):
            z = CAB_BACK - 0.15 - k * (bed_len - 0.3) / 4
            P(vb.box(f'rib_{sx}_{k}', (sx * (HALF_W - 0.008), (BED_FLOOR + BED_WALL) / 2 - 0.02, z), (0.018, BED_WALL - BED_FLOOR - 0.04, 0.06),
                     paint, bev=0.006))
        P(vb.box(f'wall_cap_{sx}', (sx * (HALF_W - 0.045), BED_WALL + 0.012, bed_cz), (0.09, 0.025, bed_len), paint, bev=0.006))
        P(vb.tube(f'bed_rail_{sx}', [(sx * (HALF_W - 0.06), BED_WALL + 0.16, CAB_BACK - 0.25),
                                     (sx * (HALF_W - 0.06), BED_WALL + 0.16, Z_REAR + 0.12)], 0.022, metal, 12 if hi else 8))
        for z in (CAB_BACK - 0.25, bed_cz, Z_REAR + 0.12):
            P(vb.cyl(f'stanch_{sx}_{z:.2f}', (sx * (HALF_W - 0.06), BED_WALL + 0.085, z), 0.018, 0.15, metal, 'y', 8))
    P(vb.box('tailgate', (0, (BED_FLOOR + BED_WALL) / 2 - 0.02, Z_REAR + 0.065), (HALF_W * 2 - 0.05, BED_WALL - BED_FLOOR + 0.06, 0.07),
             paint, bev=bev * 0.6, segs=seg))
    for k, y in enumerate((BED_FLOOR + 0.12, BED_FLOOR + 0.32)):
        P(vb.box(f'tg_rib_{k}', (0, y, Z_REAR + 0.022), (HALF_W * 2 - 0.2, 0.05, 0.02), paint, bev=0.005))
    for sx in (1, -1):
        x = sx * 0.46
        z = -1.36
        P(vb.box(f'rseat_ped_{sx}', (x, BED_FLOOR + 0.13, z), (0.3, 0.26, 0.3), metal, bev=0.01))
        P(vb.box(f'rseat_cush_{sx}', (x, BED_FLOOR + 0.30, z), (0.46, 0.1, 0.44), M['fabric'], bev=0.035, segs=2))
        P(vb.box(f'rseat_back_{sx}', (x, BED_FLOOR + 0.58, z - 0.27), (0.46, 0.5, 0.09), M['fabric'], rot=(-8, 0, 0),
                 bev=0.035, segs=2))
    rb = [[(sx * (HALF_W - 0.06), BED_WALL, CAB_BACK - 0.16), (sx * (HALF_W - 0.14), ROOF - 0.04, CAB_BACK - 0.16)] for sx in (1, -1)]
    P(vb.tube('rollbar', [rb[0][0], rb[0][1], rb[1][1], rb[1][0]], 0.04, metal, 12 if hi else 8))
    P(vb.lathe('spare', [(0.26, -0.13), (0.40, -0.16), (0.45, -0.1), (0.46, 0.0), (0.45, 0.1), (0.40, 0.16), (0.26, 0.13),
                         (0.26, -0.13)], M['rubber'], c=(0.0, BED_FLOOR + 0.17, -2.0), segs=24 if hi else 16, axis='y'))
    P(vb.cyl('spare_rim', (0.0, BED_FLOOR + 0.17, -2.0), 0.27, 0.22, metal, 'y', 20 if hi else 14))
    for i, (x, z) in enumerate(((0.75, -2.15), (0.75, -1.85), (-0.75, -2.15))):
        P(vb.box(f'jerry_{i}', (x, BED_FLOOR + 0.24, z), (0.17, 0.47, 0.34), M['jerry'], bev=0.03 if hi else 0.02, segs=seg))
        P(vb.box(f'jerry_h_{i}', (x, BED_FLOOR + 0.5, z + 0.05), (0.05, 0.04, 0.16), M['jerry']))
    P(vb.box('ammo_box', (-0.72, BED_FLOOR + 0.13, -1.85), (0.32, 0.26, 0.5), metal, bev=0.015, segs=seg))

    # --- front: bumper, bull bar, winch, lights
    P(vb.box('bumper_f', (0, 0.66, Z_FRONT - 0.10), (HALF_W * 2 - 0.04, 0.28, 0.2), metal, bev=0.025, segs=seg))
    P(vb.box('bumper_lip', (0, 0.50, Z_FRONT - 0.14), (HALF_W * 2 - 0.3, 0.06, 0.14), metal, bev=0.01))
    for sx in (1, -1):
        P(vb.box(f'head_h_{sx}', (sx * 0.75, 1.10, Z_FRONT - 0.07), (0.27, 0.17, 0.08), metal, bev=0.012, segs=seg))
        P(vb.box(f'head_{sx}', (sx * 0.75, 1.10, Z_FRONT - 0.03), (0.22, 0.12, 0.02), M['lens'], bev=0.004))
        P(vb.box(f'ind_{sx}', (sx * 0.75, 0.95, Z_FRONT - 0.075), (0.16, 0.05, 0.03), M['lens_amber'], bev=0.004))
        P(vb.box(f'tow_{sx}', (sx * 0.55, 0.56, Z_FRONT - 0.06), (0.05, 0.1, 0.1), metal))
        for k in (-1, 1):
            P(vb.tube(f'hg_{sx}_{k}', [(sx * 0.75 + k * 0.06, 1.0, Z_FRONT - 0.02), (sx * 0.75 + k * 0.06, 1.2, Z_FRONT - 0.02)],
                      0.008, metal, 6))
    bb = [(0.9, 0.80, Z_FRONT - 0.05), (0.9, 1.15, Z_FRONT - 0.05), (0.62, 1.30, Z_FRONT - 0.06), (-0.62, 1.30, Z_FRONT - 0.06),
          (-0.9, 1.15, Z_FRONT - 0.05), (-0.9, 0.80, Z_FRONT - 0.05)]
    P(vb.tube('bullbar', bb, 0.035, metal, 12 if hi else 8))
    for sx in (1, -1):
        P(vb.tube(f'bb_v_{sx}', [(sx * 0.34, 0.80, Z_FRONT - 0.04), (sx * 0.34, 1.30, Z_FRONT - 0.06)], 0.028, metal, 10 if hi else 6))
    P(vb.cyl('winch', (0, 0.88, Z_FRONT - 0.09), 0.075, 0.5, metal, 'x', 16 if hi else 10, bev=0.01))
    # Angular fender flares round every wheel well.
    fm = plastic if not wrecked else paint
    for name, (x, y, z) in WHEELS.items():
        sx = 1 if x > 0 else -1
        xf = sx * (HALF_W - 0.05)
        pr = arch_profile(z, 0.035)
        P(strip(f'fl_top_{name}', pr[4], pr[3], 0.07, 0.10, fm, xf, 0.01))
        P(strip(f'fl_f_{name}', pr[3], (pr[2][0], pr[2][1] - 0.02), 0.07, 0.10, fm, xf, 0.01))
        P(strip(f'fl_r_{name}', (pr[5][0], pr[5][1] - 0.02), pr[4], 0.07, 0.10, fm, xf, 0.01))
        P(strip(f'fl_fl_{name}', (pr[2][0], pr[2][1]), (pr[2][0], 0.44), 0.07, 0.10, fm, xf, 0.01))
        P(strip(f'fl_rl_{name}', (pr[5][0], 0.44), (pr[5][0], pr[5][1]), 0.07, 0.10, fm, xf, 0.01))
        if z < 0:
            P(vb.box(f'flap_{name}', (x, 0.42, z - 0.70), (0.34, 0.36, 0.012), M['plastic']))
    # Side steps under the doors.
    for sx in (1, -1):
        P(vb.box(f'step_{sx}', (sx * (HALF_W - 0.07), 0.46, 0.18), (0.14, 0.04, 0.62), metal, bev=0.008))
        P(vb.box(f'step_br_{sx}', (sx * (HALF_W - 0.11), 0.49, 0.18), (0.04, 0.06, 0.5), metal))
    # Mirrors (outside the 2.1 m body width).
    for sx in (1, -1):
        P(vb.tube(f'mirror_arm_{sx}', [(sx * 0.95, 1.55, WS_BASE_Z - 0.06), (sx * 1.13, 1.60, WS_BASE_Z + 0.02),
                                        (sx * 1.18, 1.70, WS_BASE_Z + 0.02)], 0.014, metal, 8 if hi else 6))
        P(vb.box(f'mirror_{sx}', (sx * 1.2, 1.74, WS_BASE_Z + 0.02), (0.05, 0.26, 0.17), plastic, bev=0.012, segs=seg))
    # Rear: bumper, tail lights, tow hitch.
    P(vb.box('bumper_r', (0, 0.62, Z_REAR + 0.09), (HALF_W * 2 - 0.1, 0.22, 0.18), metal, bev=0.015, segs=seg))
    P(vb.box('hitch', (0, 0.58, Z_REAR + 0.05), (0.12, 0.12, 0.1), metal))
    for sx in (1, -1):
        P(vb.box(f'tail_{sx}', (sx * 0.82, 0.98, Z_REAR + 0.03), (0.16, 0.10, 0.04), M['lens_red'], bev=0.006))
    # Roof: antenna base + whip, hatch ring, light.
    P(vb.cyl('ant_base', (-0.75, ROOF + 0.025, CAB_BACK + 0.15), 0.04, 0.05, metal, 'y', 10))
    P(vb.cyl('ant_whip', (-0.75, ROOF + 0.9, CAB_BACK + 0.15), 0.006, 1.75, metal, 'y', 5, r2=0.003))
    P(vb.cyl('hatch', (0.2, ROOF + 0.02, -0.05), 0.32, 0.04, paint, 'y', 24 if hi else 14, bev=0.01))
    # Underbody: chassis rails, axles, diffs, skid plate, exhaust, fuel tank.
    for sx in (1, -1):
        P(vb.box(f'rail_{sx}', (sx * 0.42, 0.44, 0.0), (0.09, 0.14, 4.6), metal))
    for name, (x, y, z) in (('f', WHEELS['wheel_fl']), ('r', WHEELS['wheel_rl'])):
        P(vb.cyl(f'axle_{name}', (0, R, z), 0.055, TX * 2 - 0.3, metal, 'x', 12 if hi else 8))
        P(vb.cyl(f'diff_{name}', (0.1, R, z), 0.15, 0.22, metal, 'z', 16 if hi else 10, bev=0.02))
        for sx in (1, -1):
            P(vb.cyl(f'shock_{name}_{sx}', (sx * 0.58, 0.75, z - 0.12), 0.04, 0.5, metal, 'y', 8))
            P(vb.cyl(f'spring_{name}_{sx}', (sx * 0.58, 0.72, z + 0.1), 0.08, 0.36, metal, 'y', 12 if hi else 8))
    P(vb.box('skid', (0, 0.42, 1.5), (1.1, 0.04, 1.4), metal, bev=0.01))
    P(vb.cyl('exhaust', (-0.6, 0.46, -0.6), 0.04, 2.2, metal, 'z', 10 if hi else 6))
    P(vb.box('fuel', (0.62, 0.52, -0.25), (0.28, 0.3, 0.8), metal, bev=0.02))

    if hi:
        parts += hi_details(M)
    return parts, glass, cutters


def hi_details(M):
    """Bake-only detail: bolts along panel edges, door seams/hinges/handles, grille slats, hood
    louvres, light-guard mesh. Floating just on the surfaces; the low mesh receives them as
    normal/AO/albedo."""
    out = []
    P = out.append
    metal, paint = M['metal'], M['paint']
    rnd = random.Random(4)
    # Grille slats (vertical).
    for i in range(11):
        x = -0.45 + i * 0.09
        P(vb.box(f'slat_{i}', (x, 1.02, Z_FRONT - 0.08), (0.025, 0.42, 0.03), M['plastic']))
    hood_y = lambda z: HOOD_REAR_Y - (z - WS_BASE_Z) * (HOOD_REAR_Y - 1.36) / (Z_FRONT - 0.15 - WS_BASE_Z)  # noqa: E731
    # Hood louvres (two vents beside the bulge).
    for sx in (1, -1):
        for i in range(8):
            z = 1.25 + i * 0.065
            P(vb.box(f'louv_{sx}_{i}', (sx * 0.64, hood_y(z) + 0.004, z), (0.26, 0.012, 0.03), M['plastic'], rot=(-6, 0, 0)))
    # Door seams + hinges + handles.
    for sx in (1, -1):
        x = sx * (HALF_W - 0.04)
        for z in (-0.52, 0.88):
            P(vb.box(f'seam_v_{sx}_{z}', (x, 1.0, z), (0.008, 0.9, 0.012), M['seam']))
        P(vb.box(f'seam_h_{sx}', (x, 0.56, 0.18), (0.008, 0.012, 1.40), M['seam']))
        for y in (0.85, 1.30):
            P(vb.cyl(f'hinge_{sx}_{y}', (x + sx * 0.012, y, 0.84), 0.022, 0.12, metal, 'y', 10))
        P(vb.box(f'handle_{sx}', (x + sx * 0.015, 1.25, -0.40), (0.02, 0.04, 0.2), metal, bev=0.008))
        # Tie-down rings on the bed walls (inside).
        for z in (-0.9, -1.7, -2.3):
            P(vb.lathe(f'tie_{sx}_{z}', [(0.02, -0.006), (0.03, 0.0), (0.02, 0.006), (0.02, -0.006)], metal,
                       c=(sx * (HALF_W - 0.085), BED_FLOOR + 0.12, z), segs=10, axis='x'))
    # Bolts along armour panel edges (cab sides, hood, bed walls).
    def bolt_row(p0, p1, n, normal_axis):
        for i in range(n):
            t = (i + 0.5) / n
            p = [p0[k] + (p1[k] - p0[k]) * t for k in range(3)]
            P(vb.cyl(f'bolt_{len(out)}', tuple(p), 0.011, 0.014, metal, normal_axis, 8))
    for sx in (1, -1):
        xc = sx * (HALF_W - 0.04)
        xb = sx * (HALF_W - 0.015)
        bolt_row((xc, 0.60, -0.50), (xc, 0.60, 0.86), 12, 'x')
        bolt_row((xc, 1.42, -0.50), (xc, 1.42, 0.86), 12, 'x')
        bolt_row((xb, 1.57, Z_REAR + 0.1), (xb, 1.57, CAB_BACK - 0.1), 14, 'x')
        bolt_row((xb, 1.19, Z_REAR + 0.1), (xb, 1.19, CAB_BACK - 0.1), 14, 'x')
        bolt_row((sx * 0.80, hood_y(1.0) + 0.006, 1.0), (sx * 0.80, hood_y(2.25) + 0.006, 2.25), 12, 'y')
        bolt_row((xc, 0.62, 1.0), (xc, 0.62, 2.2), 0, 'x')
    # Light guard mesh.
    for sx in (1, -1):
        for k in range(5):
            P(vb.tube(f'hgm_{sx}_{k}', [(sx * 0.75 - 0.11, 1.03 + k * 0.035, Z_FRONT - 0.02),
                                        (sx * 0.75 + 0.11, 1.03 + k * 0.035, Z_FRONT - 0.02)], 0.004, metal, 4))
    # Tread plate dimples on the bed floor and steps.
    for i in range(60):
        x = rnd.uniform(-0.9, 0.9)
        z = rnd.uniform(-2.3, -0.75)
        P(vb.box(f'dimple_{i}', (x, BED_FLOOR + 0.002, z), (0.08, 0.006, 0.02), metal, rot=(0, 45 if i % 2 else -45, 0)))
    return out


def wheel_parts(M, hi: bool, wrecked: bool, side=1):
    """One wheel at the origin (its centre), outer face toward `side`·X."""
    parts = []
    P = parts.append
    s = side
    segs = 48 if hi else 26
    w = TW / 2
    if not wrecked:
        prof = [(0.27, 0.135), (0.33, 0.158), (0.40, 0.165), (0.445, 0.152), (R, 0.11), (R, -0.11), (0.445, -0.152),
                (0.40, -0.165), (0.33, -0.158), (0.27, -0.135)]
        if hi:
            # Tread carcass sits below the lug tops.
            prof = [(r if r < R - 0.001 else R - 0.024, x) for r, x in prof]
        P(vb.lathe('tyre', [(r, x * s) for r, x in prof], M['rubber'], segs=segs, axis='x', angle=30))
        if hi:
            for i in range(44):
                a = 2 * math.pi * i / 44
                for row, off in ((0, 0.055), (1, -0.055)):
                    aa = a + (math.pi / 44 if row else 0)
                    c = (off * s, math.cos(aa) * (R - 0.012), math.sin(aa) * (R - 0.012))
                    P(vb.box(f'lug_{i}_{row}', c, (0.13, 0.026, 0.05), M['rubber'],
                             rot=(math.degrees(aa), 0, 0), bev=0.006, segs=2))
                # Shoulder blocks.
                for sh in (1, -1):
                    c = (sh * 0.135 * s, math.cos(a) * (R - 0.03), math.sin(a) * (R - 0.03))
                    P(vb.box(f'sh_{i}_{sh}', c, (0.05, 0.03, 0.045), M['rubber'], rot=(math.degrees(a), 0, 0), bev=0.005, segs=2))
    else:
        # Burnt off: bead wire + charred remnants hanging off a sagging carcass.
        prof = [(0.27, 0.12), (0.31, 0.13), (0.335, 0.11), (0.34, 0.0), (0.335, -0.11), (0.31, -0.13), (0.27, -0.12)]
        tyre = vb.lathe('tyre_burnt', [(r, x * s) for r, x in prof], M['rubber'], segs=segs, axis='x', angle=30)
        # Sag: the bottom of the carcass flattens.
        for v in tyre.data.vertices:
            if v.co.y < -0.2:
                v.co.y = -0.2 - (v.co.y + 0.2) * 0.25
        P(tyre)
    # Rim: steel disc, beadlock ring, hub.
    rim = [(0.255, -0.13 * s), (0.27, -0.12 * s), (0.27, 0.11 * s), (0.255, 0.125 * s), (0.235, 0.12 * s),
           (0.22, 0.09 * s), (0.14, 0.07 * s), (0.09, 0.075 * s), (0.07, 0.10 * s), (0.0, 0.10 * s)]
    P(vb.lathe('rim', rim, M['rim'], segs=40 if hi else 24, axis='x', angle=35))
    P(vb.lathe('beadlock', [(0.205, 0.126 * s), (0.27, 0.126 * s), (0.27, 0.14 * s), (0.205, 0.14 * s), (0.205, 0.126 * s)],
               M['rim'], segs=40 if hi else 24, axis='x', angle=35))
    # Inner barrel + brake drum (seen from behind).
    P(vb.cyl('drum', (-0.06 * s, 0, 0), 0.19, 0.12, M['metal'], 'x', 20 if hi else 12))
    # Lug nuts (low: 8 six-sided nuts; hi also beadlock bolts).
    for i in range(8):
        a = 2 * math.pi * i / 8
        P(vb.cyl(f'nut_{i}', (0.105 * s, math.cos(a) * 0.105, math.sin(a) * 0.105), 0.016, 0.03, M['metal'], 'x', 6))
    P(vb.cyl('hubcap', (0.11 * s, 0, 0), 0.055, 0.05, M['metal'], 'x', 16 if hi else 10, bev=0.008))
    if hi:
        for i in range(16):
            a = 2 * math.pi * (i + 0.5) / 16
            P(vb.cyl(f'bl_{i}', (0.142 * s, math.cos(a) * 0.238, math.sin(a) * 0.238), 0.009, 0.012, M['metal'], 'x', 6))
        # Valve stem.
        P(vb.cyl('valve', (0.12 * s, 0.2, 0.05), 0.006, 0.03, M['metal'], 'x', 6))
    return parts


SEATS = {
    'seat_driver': (0.45, 0.98, 0.04),
    'seat_front': (-0.45, 0.98, 0.04),
    'seat_rear_l': (0.46, BED_FLOOR + 0.40, -1.36),
    'seat_rear_r': (-0.46, BED_FLOOR + 0.40, -1.36),
    'exit_l': (HALF_W + 1.2, 0.0, 0.1),
    'exit_r': (-HALF_W - 1.2, 0.0, 0.1),
}
