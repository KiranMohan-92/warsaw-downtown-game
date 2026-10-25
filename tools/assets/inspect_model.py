"""Inspect a downloaded model before writing its rebake config. Blender only.

    blender -b --python tools/assets/inspect_model.py -- MODEL.glb OUT_DIR [--yaw 0] [--scale 1] [--no-sheet]

Prints (and writes OUT_DIR/<stem>_inspect.json): every mesh object with its triangle count,
materials, world bounding box in game coords (Y up), images per material; plus wheel candidates
(objects whose bounding box is near-square in the Y/Z plane and that touch the ground). Renders a
contact sheet (front, side, top, 3/4; workbench, no GPU) to OUT_DIR/<stem>_views.png so markings,
lights and parts can be found by eye.
"""

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def g(v):
    """Blender → game coords."""
    return (v.x, v.z, -v.y)


def append_blend(path):
    """Append every object of a .blend into the current scene (meshes keep their materials/images)."""
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = list(src.objects)
    for o in dst.objects:
        if o is not None and o.name not in bpy.context.scene.collection.objects:
            bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.update()  # matrix_world of appended objects is stale until evaluated
    # Bake modifiers (the tracks are an array along a curve) into plain meshes.
    dg = bpy.context.evaluated_depsgraph_get()
    for o in [o for o in dst.objects if o is not None and o.type == 'MESH' and o.modifiers]:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        o.modifiers.clear()
        o.data = me
    bpy.context.view_layer.update()


def main(argv):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('model', type=Path)
    ap.add_argument('out', type=Path)
    ap.add_argument('--yaw', type=float, default=0.0)
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--no-sheet', action='store_true', help='skip the contact sheet (tests)')
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = a.model.suffix.lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=str(a.model))
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(a.model))
    elif ext == '.blend':
        append_blend(a.model)
    else:
        bpy.ops.wm.obj_import(filepath=str(a.model))
    # Apply --yaw/--scale to the scene itself (the roots; children follow), so the rendered views
    # show the same model the bounds and wheel candidates describe.
    T = Matrix.Rotation(math.radians(a.yaw), 4, 'Z') @ Matrix.Scale(a.scale, 4)
    for o in bpy.data.objects:
        if o.parent is None:
            o.matrix_world = T @ o.matrix_world
    bpy.context.view_layer.update()
    rows, glo, ghi = [], Vector((1e9,) * 3), Vector((-1e9,) * 3)
    dg = bpy.context.evaluated_depsgraph_get()
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        me = o.evaluated_get(dg).data
        M = o.matrix_world
        pts = [M @ v.co for v in me.vertices]
        if not pts:
            continue
        lo = Vector(tuple(min(p[k] for p in pts) for k in range(3)))
        hi = Vector(tuple(max(p[k] for p in pts) for k in range(3)))
        glo = Vector(map(min, glo, lo))
        ghi = Vector(map(max, ghi, hi))
        tris = sum(len(p.vertices) - 2 for p in me.polygons)
        mats = []
        for m in o.data.materials:
            if not m:
                continue
            imgs = sorted({n.image.name for n in (m.node_tree.nodes if m.use_nodes else []) if n.type == 'TEX_IMAGE' and n.image})
            mats.append({'name': m.name, 'images': imgs})
        rows.append({'object': o.name, 'parent': o.parent.name if o.parent else None, 'triangles': tris,
                     'bbox_game': [list(g(lo)), list(g(hi))], 'materials': mats})
    zmin = glo.z
    for r in rows:
        (x0, y0, za), (x1, y1, zb) = r['bbox_game']
        z0, z1 = min(za, zb), max(za, zb)
        dy, dz, dx = y1 - y0, z1 - z0, x1 - x0
        r['wheel_like'] = bool(dy > 0.05 and abs(dy - dz) < 0.12 * max(dy, dz) and dx < 0.8 * dy and y0 - zmin < 0.15 * dy)
    info = {'model': str(a.model), 'objects': rows, 'triangles': sum(r['triangles'] for r in rows),
            'bbox_game': [list(g(glo)), list(g(ghi))], 'size_game': [abs(c) for c in g(ghi - glo)],
            'images': sorted((i.name, list(i.size)) for i in bpy.data.images)}
    # What the views render: the scene objects' own bounds (must match bbox_game).
    corners = [o.matrix_world @ Vector(c) for o in bpy.data.objects if o.type == 'MESH' for c in o.bound_box]
    slo = Vector(tuple(min(p[k] for p in corners) for k in range(3)))
    shi = Vector(tuple(max(p[k] for p in corners) for k in range(3)))
    info['scene_bbox_game'] = [list(g(slo)), list(g(shi))]
    stem = a.model.stem
    (a.out / f'{stem}_inspect.json').write_text(json.dumps(info, indent=1), encoding='utf-8')
    print(f'{stem}: {info["triangles"]} tris, size (game x,y,z) {[round(v, 3) for v in info["size_game"]]}')
    for r in sorted(rows, key=lambda r: -r['triangles']):
        print(f'  {r["object"][:40]:40s} {r["triangles"]:7d}  {"WHEEL? " if r["wheel_like"] else ""}'
              f'{[m["name"] for m in r["materials"]]}')
    if a.no_sheet:
        return
    # Contact sheet: four views (workbench, material colours), 2×2.
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.color_type = 'TEXTURE'
    sc.display.shading.light = 'STUDIO'
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    cam_d = bpy.data.cameras.new('c')
    cam = bpy.data.objects.new('c', cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    c = (glo + ghi) / 2
    size = (ghi - glo).length
    views = {'front': Vector((0, -1, 0.15)), 'side': Vector((1, 0, 0.15)), 'top': Vector((0.001, 0, 1)),
             'three_q': Vector((0.8, -0.8, 0.5))}
    shots = []
    for name, d in views.items():
        cam_d.type = 'ORTHO'
        cam_d.ortho_scale = size * 1.05
        cam.location = c + d.normalized() * size * 2
        cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
        p = a.out / f'{stem}_{name}.png'
        sc.render.filepath = str(p)
        bpy.ops.render.render(write_still=True)
        shots.append(p)
    try:
        import numpy as np
        ims = [bpy.data.images.load(str(p)) for p in shots]
        w, h = ims[0].size
        sheet = np.zeros((h * 2, w * 2, 4), np.float32)
        for i, im in enumerate(ims):
            px = np.array(im.pixels[:], np.float32).reshape(h, w, 4)
            r, cc = divmod(i, 2)
            sheet[(1 - r) * h:(2 - r) * h, cc * w:(cc + 1) * w] = px
        out = bpy.data.images.new('sheet', w * 2, h * 2)
        out.pixels[:] = sheet.ravel()
        out.filepath_raw = str(a.out / f'{stem}_views.png')
        out.file_format = 'PNG'
        out.save()
        for p in shots:
            p.unlink()
    except Exception as e:  # noqa: BLE001
        print('sheet failed', e)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
