"""Ray meshes for the re-baked wrecks: bullets, knife, frags, sight and camera rays hit these
(shared PhysicsWorld), the wrecks' boxes are for movement only. Each is the shipped near mesh
(decoded through raw_models) welded and collapse-decimated in Blender to ~5–8k triangles, in the
prop frame the hero model is drawn in, written with exact (rounded, decimal) positions and index
order to packages/shared/src/maps/wreckGeometry.gen.json so server and client build identical
Rapier trimeshes. The gate is test_wreck_rays.py (Rapier-cast, forward and reverse).

    python tools/assets/build_wreck_collision.py            # Blender stage + write the JSON
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEST = ROOT / 'packages/shared/src/maps/wreckGeometry.gen.json'
BLENDER = Path(os.environ.get('WD_BLENDER', r'C:\Users\kiran\tools\blender-5.2.1-windows-x64\blender.exe'))
# Target triangles per wreck (collapse decimation of the near mesh).
# Gate-driven (test_wreck_rays.py, 10 cm forward ≤ 1 % / 2 %): the tank only passes with its visible
# faces kept whole (a collapse to 20k already misses 1.45 %), the helicopter collapses to 24k.
TARGET = {'tank_wreck': int(os.environ.get('WD_TANK_TRIS', 10**9)), 'heli_wreck': int(os.environ.get('WD_HELI_TRIS', 24000))}
# Planar pre-pass (deg): dissolve near-flat facets first so the collapse spends triangles on shape.
PLANAR = float(os.environ.get('WD_PLANAR', 0))
WELD = float(os.environ.get('WD_WELD', 0.002))
# Voxel remesh size (m) before the collapse, 0 = none.
REMESH = float(os.environ.get('WD_REMESH', 0))
# Visibility cull before decimating: keep only faces some ray can reach — parallel grids from
# VIS_DIRS directions round the sphere at VIS_STEP spacing, plus rays from viewpoints inside the
# helicopter's enterable cabin (bullets fired inside it). Hidden faces would only waste budget.
VIS_DIRS = int(os.environ.get('WD_VIS_DIRS', 48))
# Per loose part decimation, parts at or under this many faces kept whole (0 = global collapse).
PER_PART = int(os.environ.get('WD_PER_PART', 0))
VIS_STEP = float(os.environ.get('WD_VIS_STEP', 0.04))
# Game-frame viewpoints inside the cabin (cabin floor ~0.15, ceiling ~2.45, pitched 3°).
INSIDE = {'heli_wreck': [(x, y, 0.0) for x in (-2.2, -1.0, 0.2, 1.4, 2.2) for y in (0.9, 1.7)]}
STEP = 0.0005  # m: positions are int16 steps from each mesh's centre (±16 m), decoded identically


def blender_stage(src: Path, target: int, out: Path) -> None:
    """Runs inside Blender: import, weld, decimate, write raw game-frame triangles as JSON."""
    import bmesh
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(src))
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    obj = meshes[0]  # the client draws the first mesh (render/heroModels.ts heroGeometry)
    for o in meshes[1:]:
        bpy.data.objects.remove(o)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    n0 = len(obj.data.polygons)
    if VIS_DIRS:
        visibility_cull(obj, VIS_DIRS, VIS_STEP, INSIDE.get(src.stem, []))
    if REMESH:
        # Voxel remesh: one closed shell round every surface (thin open plates become thin solids
        # the collapse can't eat; openings wider than a few voxels stay open).
        rm = obj.modifiers.new('remesh', 'REMESH')
        rm.mode = 'VOXEL'
        rm.voxel_size = REMESH
        rm.adaptivity = 0.0
        bpy.ops.object.modifier_apply(modifier=rm.name)
    if PLANAR:
        pl = obj.modifiers.new('planar', 'DECIMATE')
        pl.decimate_type = 'DISSOLVE'
        pl.angle_limit = __import__('math').radians(PLANAR)
        bpy.ops.object.modifier_apply(modifier=pl.name)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()
    ratio = min(1.0, target / max(len(obj.data.polygons), 1))
    if PER_PART:
        # Decimate each loose part at the same ratio: a global collapse deletes whole small parts
        # (bolts, stowage, skirt plates) first, punching holes the rays go through.
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='LOOSE')
        bpy.ops.object.mode_set(mode='OBJECT')
        parts = [o for o in bpy.data.objects if o.type == 'MESH']
        for o in parts:
            n = len(o.data.polygons)
            if n <= PER_PART:
                continue
            m = o.modifiers.new('dec', 'DECIMATE')
            m.decimate_type = 'COLLAPSE'
            m.ratio = max(ratio, PER_PART / n)
            m.use_collapse_triangulate = True
        bpy.ops.object.select_all(action='DESELECT')
        for o in parts:
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
            for m in list(o.modifiers):
                bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.context.view_layer.objects.active = parts[0]
        for o in parts:
            o.select_set(True)
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
    else:
        mod = obj.modifiers.new('dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    me = obj.data
    me.calc_loop_triangles()
    # Blender Z-up → glTF/game Y-up: game (x, y, z) = blender (x, z, −y).
    pos = [(v.co.x, v.co.z, -v.co.y) for v in me.vertices]
    tris = [tuple(t.vertices) for t in me.loop_triangles]
    out.write_text(json.dumps({'source_triangles': n0, 'positions': pos, 'triangles': tris}))


def visibility_cull(obj, ndirs, step, inside):
    import math

    import bmesh
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    pts = [v.co for v in bm.verts]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre, radius = (lo + hi) / 2, (hi - lo).length / 2 + 0.5
    seen = set()
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(ndirs):  # Fibonacci sphere
        z = 1 - 2 * (i + 0.5) / ndirs
        r = math.sqrt(1 - z * z)
        d = Vector((math.cos(golden * i) * r, math.sin(golden * i) * r, z))
        u = d.orthogonal().normalized()
        v = d.cross(u)
        n = int(radius * 2 / step)
        for a in range(n):
            for b in range(n):
                o = centre - d * radius + u * (-radius + a * step) + v * (-radius + b * step)
                hit = tree.ray_cast(o, d, radius * 2)
                if hit[2] is not None:
                    seen.add(hit[2])
    for gx, gy, gz in inside:  # game (x, y, z) → blender (x, −z, y), pitched 3° about game Z
        c, s_ = math.cos(math.radians(3)), math.sin(math.radians(3))
        x, y = gx * c - gy * s_, gx * s_ + gy * c
        o = Vector((x, -gz, y))
        for i in range(4000):
            z = 1 - 2 * (i + 0.5) / 4000
            r = math.sqrt(1 - z * z)
            d = Vector((math.cos(golden * i) * r, math.sin(golden * i) * r, z))
            hit = tree.ray_cast(o, d, 20.0)
            if hit[2] is not None:
                seen.add(hit[2])
    drop = [f for f in bm.faces if f.index not in seen]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    bm.to_mesh(obj.data)
    bm.free()
    print(f'VISCULL kept {len(seen)} faces, dropped {len(drop)}', flush=True)


def finish(raw: dict) -> dict:
    """Quantize to STEP about the bounds centre, weld the quantized duplicates, drop degenerate
    triangles; int16 positions + uint16/uint32 indices, little-endian, base64."""
    import base64
    import math
    import struct

    pts = raw['positions']
    lo = [min(p[k] for p in pts) for k in range(3)]
    hi = [max(p[k] for p in pts) for k in range(3)]
    origin = [round((lo[k] + hi[k]) / 2, 3) for k in range(3)]
    index: dict[tuple, int] = {}
    remap = []
    for p in pts:
        q = tuple(int(math.floor((p[k] - origin[k]) / STEP + 0.5)) for k in range(3))
        if any(abs(v) > 32767 for v in q):
            raise SystemExit(f'position {p} outside the int16 range about {origin}')
        remap.append(index.setdefault(q, len(index)))
    tris = []
    for a, b, c in raw['triangles']:
        a, b, c = remap[a], remap[b], remap[c]
        if a != b and b != c and a != c:
            tris.append((a, b, c))
    verts = list(index)
    wide = len(verts) > 65535
    flat = [i for t in tris for i in t]
    return {
        'triangles': len(tris),
        'vertices': len(verts),
        'origin': origin,
        'step': STEP,
        'indexBytes': 4 if wide else 2,
        'positions': base64.b64encode(struct.pack(f'<{3 * len(verts)}h', *[c for v in verts for c in v])).decode(),
        'indices': base64.b64encode(struct.pack(f'<{len(flat)}{"I" if wide else "H"}', *flat)).decode(),
    }


def decode(m: dict):
    """(positions (n, 3) float64, indices (t, 3)) exactly as shared/maps/wreckGeometry.ts decodes."""
    import base64

    import numpy as np

    q = np.frombuffer(base64.b64decode(m['positions']), dtype='<i2').reshape(-1, 3).astype(np.float64)
    pos = np.array(m['origin'], dtype=np.float64) + q * m['step']
    idx = np.frombuffer(base64.b64decode(m['indices']), dtype='<u4' if m['indexBytes'] == 4 else '<u2')
    return pos, idx.reshape(-1, 3).astype(np.int64)


def build(ids=tuple(TARGET)) -> None:
    sys.path.insert(0, str(HERE))
    from raw_models import MODELS, raw_model

    data = json.loads(DEST.read_text(encoding='utf-8'))['models'] if DEST.exists() else {}
    for mid in ids:
        src = raw_model(MODELS / f'vehicles/{mid}.gltf')
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / f'{mid}.json'
            log = Path(tmp) / 'blender.log'
            with log.open('w') as f:  # never pipe Blender's output
                subprocess.run([str(BLENDER), '-b', '--factory-startup', '--python', __file__, '--',
                                '--blender', str(src), str(TARGET[mid]), str(out)],
                               stdout=f, stderr=subprocess.STDOUT, check=True)
            raw = json.loads(out.read_text())
        data[mid] = finish(raw)
        print(f"{mid}: {raw['source_triangles']} -> {data[mid]['triangles']} triangles")
    body = {k: data[k] for k in sorted(data)}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]
    DEST.write_text(json.dumps({'hash': digest, 'models': body}, separators=(',', ':')) + '\n',
                    encoding='utf-8', newline='\n')
    print(f'{DEST.relative_to(ROOT)}: {DEST.stat().st_size / 1000:.0f} kB ({digest})')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    if argv and argv[0] == '--blender':
        blender_stage(Path(argv[1]), int(argv[2]), Path(argv[3]))
    else:
        build(tuple(argv) or tuple(TARGET))
