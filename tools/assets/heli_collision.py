"""Collision boxes for the crashed Blackhawk wreck, derived from the same crash parameters as its
model (vehicle_configs/heli_wreck.json: tilt, sink, move ops). Pure Python.

    python tools/assets/heli_collision.py [--json OUT.json]   # boxes for the review overlay
                                                              # and the shared props.ts literal

Boxes are authored in the model's pre-crash frame (game metres, nose −X, after placement) and
carried through the crash: the cabin shell by the config's tilt + sink; the snapped tail and the
fallen blade additionally by their `move` op (pivot, Euler XYZ applied X then Y then Z — Blender's
convention). Output rotations are three.js Euler XYZ degrees (MapBox.rot).
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CFG = HERE / 'vehicle_configs/heli_wreck.json'


def rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def euler_blender(deg):
    """mathutils Euler(…, 'XYZ').to_matrix(): X applied first, then Y, then Z."""
    x, y, z = (math.radians(d) for d in deg)
    return rz(z) @ ry(y) @ rx(x)


def three_xyz(deg):
    """The game's (three.js) Euler XYZ in degrees → rotation matrix Rx·Ry·Rz (Z applied first)."""
    x, y, z = (math.radians(d) for d in deg)
    return rx(x) @ ry(y) @ rz(z)


def box_matrix(c, s, rot=None):
    """A map box {c, s, rot} as a 4×4 game-space matrix taking the unit cube (±0.5) onto the box."""
    m = np.eye(4)
    m[:3, :3] = three_xyz(rot or (0, 0, 0)) @ np.diag(s)
    m[:3, 3] = c
    return m


def to_three_xyz(m):
    """Rotation matrix → three.js Euler XYZ (matrix = Rx·Ry·Rz) in degrees."""
    y = math.asin(max(-1.0, min(1.0, m[0, 2])))
    if abs(m[0, 2]) < 0.9999999:
        x = math.atan2(-m[1, 2], m[2, 2])
        z = math.atan2(-m[0, 1], m[0, 0])
    else:
        x = math.atan2(m[2, 1], m[1, 1])
        z = 0.0
    return [round(math.degrees(a), 3) + 0.0 for a in (x, y, z)]


# Pre-crash frame (nose −X, placed at offset +2 m): cabin x −2.8 … 2.8, floor top 0.72, roof
# underside 2.95, sides z ±1.45; doors left x −1.8 … 0.2, right −1.0 … 1.0, up to 2.78 (the
# character's step-up needs floor + 0.42 + 1.8 m of headroom in the doorway).
SHELL = {
    'floor': ((0.0, 0.47, 0.0), (5.6, 0.5, 2.9)),
    'roof': ((0.0, 3.05, 0.0), (5.8, 0.2, 2.7)),
    # The nose, in two steps under the sloped windscreen (the model's nose reaches x −4.0 low down,
    # −3.1 at 1.2 m and −2.9 at 1.4 m: a single box stood 0.5 m proud of it).
    'cockpit': ((-3.375, 1.03, 0.0), (1.15, 1.0, 2.2)),
    'cockpit_top': ((-3.0, 1.78, 0.0), (0.4, 0.5, 2.2)),
    'rear': ((2.85, 1.835, 0.0), (0.1, 2.43, 2.7)),
    'wall_l1': ((-2.3, 1.835, -1.45), (1.0, 2.43, 0.1)),
    'wall_l2': ((1.5, 1.835, -1.45), (2.6, 2.43, 0.1)),
    'head_l': ((-0.8, 2.89, -1.45), (2.0, 0.22, 0.1)),
    'wall_r1': ((-1.9, 1.835, 1.45), (1.8, 2.43, 0.1)),
    'wall_r2': ((1.9, 1.835, 1.45), (1.8, 2.43, 0.1)),
    'head_r': ((0.0, 2.89, 1.45), (2.0, 0.22, 0.1)),
    'engine': ((0.6, 3.4, 0.0), (3.6, 0.6, 1.7)),
    'boom_root': ((4.3, 1.45, 0.0), (3.0, 1.5, 1.2)),
    # Over the roof (fitted to the shipped mesh by tools/assets/wreck_rays.py): the engine's
    # exhaust fairing behind the engine box, the rotor hub and mast, the fairing ahead of them.
    'exhaust': ((2.3, 3.365, 0.0), (1.4, 0.83, 2.6)),
    'hub': ((0.3, 3.5, 0.0), (1.8, 0.82, 0.9)),
    'fairing': ((-1.9, 3.38, 0.0), (1.4, 0.46, 0.72)),
    # The aft fairing tapering down from the cabin roof onto the boom root.
    'aft_1': ((3.2, 2.5, 0.0), (0.8, 0.76, 1.7)),
    'aft_2': ((4.0, 2.36, 0.0), (0.8, 0.48, 1.2)),
}
# Parts carried by a move op (index into cfg['move']), in the pre-move frame.
MOVED = {
    'boom': (1, (7.6, 1.45, 0.0), (3.6, 1.0, 0.9)),
    'fin': (1, (8.25, 2.5, -0.1), (1.9, 1.4, 0.6)),
    'fin_top': (1, (8.65, 3.9, 0.0), (1.7, 1.4, 0.9)),  # upper fin + tail rotor
    'stabiliser': (1, (8.43, 1.55, 0.0), (0.95, 0.6, 3.2)),
    'blade': (0, (0.5, 3.3, 4.6), (0.6, 0.12, 5.8)),
}


def crash(cfg):
    R = euler_blender(cfg.get('tilt', [0, 0, 0]))
    sink = cfg.get('sink', 0.0)
    return R, np.array([0.0, -sink, 0.0])


def boxes(cfg):
    R, t = crash(cfg)
    out = {}
    for name, (c, s) in SHELL.items():
        out[name] = {'c': list(np.round(R @ np.array(c) + t, 4)), 's': list(s), 'rot': to_three_xyz(R)}
    for name, (mi, c, s) in MOVED.items():
        mv = cfg['move'][mi]
        M = euler_blender(mv.get('rot', [0, 0, 0]))
        piv = np.array(mv.get('pivot', [0, 0, 0]))
        tr = np.array(mv.get('translate', [0, 0, 0]))
        cm = M @ (np.array(c) - piv) + piv + tr
        out[name] = {'c': list(np.round(R @ cm + t, 4)), 's': list(s), 'rot': to_three_xyz(R @ M)}
    for b in out.values():
        b['c'] = [float(v) + 0.0 for v in b['c']]
        b['rot'] = [0.0 if abs(v) < 1e-9 else v for v in b['rot']]
        b['s'] = [float(v) for v in b['s']]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', type=Path)
    a = ap.parse_args()
    cfg = json.loads(CFG.read_text(encoding='utf-8'))
    bx = boxes(cfg)
    if a.json:
        a.json.write_text(json.dumps(list(bx.values()), indent=1), encoding='utf-8')
    for name, b in bx.items():
        print(f"  {name:10s} c={b['c']} s={b['s']} rot={b['rot']}")


if __name__ == '__main__':
    main()
