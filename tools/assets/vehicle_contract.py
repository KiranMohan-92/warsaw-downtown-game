"""Truck contract validation on an exported glTF (pure Python; used by the tests and by
rebake_model.py after every export).

Contract (driving lane): glTF +Y up, front +Z, origin on the ground midway between the axles,
metres; nodes `body`, `wheel_fl/fr/rl/rr` (pivot at the wheel centre, identity rotation, rolling
about local X) and the seat/exit empties (vehicle_spec.TRUCK_NODES).
"""

import json
import math
import struct
from pathlib import Path

from vehicle_spec import TRUCK, TRUCK_NODES

TOL = 0.02
WHEEL_POS = {
    'wheel_fl': (1, 1),
    'wheel_fr': (-1, 1),
    'wheel_rl': (1, -1),
    'wheel_rr': (-1, -1),
}


def load(path: Path):
    """(json, binary buffer) of a .gltf (+ .bin) or a .glb."""
    path = Path(path)
    if path.suffix == '.glb':
        data = path.read_bytes()
        n = int.from_bytes(data[12:16], 'little')
        doc = json.loads(data[20:20 + n])
        off = 20 + n
        blob = data[off + 8: off + 8 + int.from_bytes(data[off:off + 4], 'little')] if len(data) > off else b''
        return doc, blob
    doc = json.loads(path.read_text(encoding='utf-8'))
    blob = (path.parent / doc['buffers'][0]['uri']).read_bytes()
    return doc, blob


def positions(doc, blob, mesh_index):
    out = []
    for prim in doc['meshes'][mesh_index]['primitives']:
        a = doc['accessors'][prim['attributes']['POSITION']]
        v = doc['bufferViews'][a['bufferView']]
        base = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = v.get('byteStride', 12)
        out += [struct.unpack_from('<3f', blob, base + i * stride) for i in range(a['count'])]
    return out


def triangles(doc, mesh_index):
    return sum(doc['accessors'][p['indices']]['count'] // 3 for p in doc['meshes'][mesh_index]['primitives'])


def validate_truck(path: Path, budget: int | None = None, spec: dict = TRUCK, envelope=True, wheel_shape=True) -> list[str]:
    """Every contract violation as a message (empty: valid). `envelope` checks the body's length
    and width, `wheel_shape` the tyre radius/width (both off for damaged variants: parts hang
    out, tyres are burnt off)."""
    errs: list[str] = []
    doc, blob = load(path)
    nodes = {n.get('name'): n for n in doc['nodes']}
    missing = set(TRUCK_NODES) - set(nodes)
    extra = set(nodes) - set(TRUCK_NODES)
    if missing:
        errs.append(f'missing nodes {sorted(missing)}')
    if extra:
        errs.append(f'unexpected nodes {sorted(extra)}')
    for n in nodes.values():
        if n.get('children'):
            errs.append(f'{n.get("name")}: nodes must be flat (no children)')
        if n.get('rotation') and max(abs(c) for c in n['rotation'][:3]) > 1e-4:
            errs.append(f'{n.get("name")}: rotation must be identity')
        if n.get('scale') and max(abs(c - 1) for c in n['scale']) > 1e-4:
            errs.append(f'{n.get("name")}: scale must be 1')
    if budget is not None:
        tris = sum(triangles(doc, n['mesh']) for n in doc['nodes'] if 'mesh' in n)
        if tris > budget:
            errs.append(f'{tris} triangles > budget {budget}')
    ax, tx, r = spec['wheelbase'] / 2, spec['track'] / 2, spec['wheel_radius']
    for name, (sx, sz) in WHEEL_POS.items():
        n = nodes.get(name)
        if not n or 'mesh' not in n:
            continue
        t = n.get('translation', [0, 0, 0])
        if math.dist(t, (sx * tx, r, sz * ax)) > TOL:
            errs.append(f'{name} at {[round(c, 3) for c in t]}, contract {(sx * tx, r, sz * ax)}')
        if not wheel_shape:
            continue
        pts = positions(doc, blob, n['mesh'])
        rad = max(math.hypot(p[1], p[2]) for p in pts)
        width = max(p[0] for p in pts) - min(p[0] for p in pts)
        if abs(rad - r) > TOL:
            errs.append(f'{name}: radius {rad:.3f} (contract {r})')
        if width > spec['tyre_width'] + 0.06:
            errs.append(f'{name}: width {width:.3f} (tyre {spec["tyre_width"]})')
    body = nodes.get('body')
    if body and 'mesh' in body:
        pts = positions(doc, blob, body['mesh'])
        if min(p[1] for p in pts) > 0.6:
            errs.append('body floats: lowest point above 0.6 m')
        if envelope:
            zs = [p[2] for p in pts]
            if abs(max(zs) - min(zs) - spec['length']) > TOL:
                errs.append(f'body length {max(zs) - min(zs):.3f} (contract {spec["length"]})')
            xs = [p[0] for p in pts if p[1] < 1.5]
            if abs(max(xs) - min(xs) - spec['width']) > TOL:
                errs.append(f'body width {max(xs) - min(xs):.3f} (contract {spec["width"]})')
    for name in TRUCK_NODES:
        n = nodes.get(name)
        if name.startswith(('seat_', 'exit_')) and n is not None and 'mesh' in n:
            errs.append(f'{name} must be an empty')
    return errs
