"""Re-texture and re-bake any vehicle model (glTF / GLB / FBX / OBJ) with our texture library and
layered-wear bake. Model-agnostic; Blender only.

    blender -b --python tools/assets/rebake_model.py -- --config CFG.json [--out DIR] [--fast]
    # Armoured wreck: repair the atlas/material of the shipped shape, preserving collision:
    blender -b --python tools/assets/rebake_model.py -- --config tools/assets/vehicle_configs/armoured_wreck.json --surface-only

The config (JSON) says how to read the source model; everything else is our pipeline:

    {
      "id": "truck",                         output name (<out>/<id>/<id>.gltf, _far.gltf, maps)
      "input": "C:/.../model.glb",           .gltf/.glb/.fbx/.obj
      "scale": 1.0,                          source units → metres (applied first)
      "yaw": 0,                              degrees about game +Y, so the front faces +Z
      "palette": "truck",                    material set: truck | truck_destroyed | heli | tank
      "materials": [["*glass*", "glass"], ["*tyre*", "rubber"], ["*", "paint"]],
                                             source material (or object) name glob → palette kind;
                                             first match wins; kind "glass" stays a separate
                                             transparent primitive (not baked), "drop" deletes,
                                             "source" keeps the model's own material (a photo
                                             scan) and bakes it as is
      "replace_images": {"0_6": "vehicles/x/textures_clean/0_6.jpeg"},  swap source images by
                                             name stem (a cleaned copy with markings painted out)
      "contract": "truck",                   null for static props (one `wreck` node)
      "wheels": {"wheel_fl": "*front*left*", ...},  object-name globs (truck contract)
      "fit_wheelbase": true,                 scale uniformly so the axle spacing is the contract's
      "seats": {"seat_driver": [x, y, z], ...},     empties added by us (game coords)
      "envelope": true,                      check body length/width against the contract
      "wheel_shape": true,                   check tyre radius/width (off for burnt-out variants)
      "budget": [14000, 2600],               near/far triangles (near: decimated if over)
      "uv": "auto",                          auto = always re-unwrap into one unique atlas;
                                             keep = trust the source's UV0 if it has one
      "size": 2048, "out_size": 1024         bake size, shipped size (Low 512 at packaging)

      edits (all game coords, after placement):
      "drop_objects": ["*siren*", "*lightbar*"],   delete whole source objects (globs)
      "cut": [{"min": [x,y,z], "max": [x,y,z], "objects": "*"}],
                                             delete faces whose centre is in the box (open a roof)
      "move": [{"min": [..], "max": [..], "pivot": [x,y,z], "rot": [rx,ry,rz], "translate": [..]}],
                                             split off the faces in a box and move them (snap a
                                             tail boom off, drop a door)
      "add": [{"c": [x,y,z], "s": [w,h,d], "rot": [rx,ry,rz], "kind": "paint"}],
                                             new box parts (bed wall caps, patches), bevelled
      "fit_track": false,                    truck: scale X alone so the track is the contract's
      "fit": {"axis": "x", "length": 7.2},   statics: uniform scale to this extent along an axis
      "offset": [x, y, z],                   statics: move after centring (to sit on collision)
      "tilt": [rx, ry, rz], "sink": 0.0,     crash pose (degrees about the origin) / lower it
      "dent": {"strength": 0.05, "scale": 0.6},    crumple everything (wrecks)
      "keep_source_normals": true,           the source's normal maps feed the bake (panel lines,
                                             bolts) under our materials; its albedo is never used
      "debris": {"count": 14, "inner": [x0,z0,x1,z1], "outer": [x0,z0,x1,z1], "kind": "hull"},
      "scorch": {"radius": 6.0, "center": [x, z]}   ground decal node `scorch` (statics)
      "smooth_angle": 60,                    re-smooth the low by angle (scans, dented wrecks)
    }

Steps: import → apply all transforms, scale/yaw → classify faces by material into palette kinds
→ wheels split out and re-pivoted at their centres (contract), grounded, centred between the
axles → unique UVs (body + all four wheels in one atlas) → bake hi (the source geometry with our
sourced materials) onto low (same geometry, decimated to the budget if needed) → albedo/ORM/normal
→ near + far LOD export → contract validation (vehicle_contract.py; exit code 2 on violations).
"""

import fnmatch
import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import build_vehicles as bv  # noqa: E402
import vehicle_bpy as vb  # noqa: E402
import vehicle_mats as vm  # noqa: E402
from vehicle_contract import validate_truck  # noqa: E402
from vehicle_spec import TRUCK  # noqa: E402

WHEEL_NAMES = ('wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr')
PALETTES = {
    'truck': lambda: bv.truck_mats(False),
    'truck_destroyed': lambda: bv.truck_mats(True),
    'heli': lambda: bv.wreck_mats('heli'),
    'tank': lambda: bv.wreck_mats('tank'),
    'technical': lambda: technical_mats(False),
    'technical_burnt': lambda: technical_mats(True),
}


def technical_mats(burnt: bool) -> dict:
    """The CC BY technical's look: the truck palette with a crisp two-tone fictional repaint
    (dark olive / near-black green), road grime low down, diamond tread plate in the bed; the
    destroyed variant burnt with soot climbing from the openings and heat-tinted bare steel."""
    raw = bv.raw_dir()
    m = bv.truck_mats(burnt)
    if not burnt:
        m['paint'] = vm.paint('paint', 0x4e5541, raw, wear=0.62, dirt=1.0, dust=0.3, mud_height=1.0,
                              camo=(0x262a22, 0.55), low_grime=0.75, edge_radius=0.028,
                              metal_under=0x8a877f)
        m['metal'] = vm.paint('metal', 0x2f312b, raw, wear=0.7, dirt=0.9, dust=0.2, mud_height=0.8,
                              edge_radius=0.025, metal_under=0x8a877f)
        m['interior'] = vm.paint('interior', 0x4a4d42, raw, wear=0.3, dirt=0.6, dust=0.35, mud_height=0.6)
        m['bed'] = vm.tread_plate('bed', raw)
        m['rim'] = vm.paint('rim', 0x34372e, raw, wear=0.6, dirt=0.9, dust=0.15, mud_height=0.42)
    else:
        m['paint'] = vm.burnt('burnt', raw, paint_left=0x4e5541, rust=0.95, ash=0.35, heat=0.8,
                              soot_up=0.95, heat_tint=1.0)
        m['interior'] = vm.burnt('burnt_in', raw, rust=0.5, ash=0.75, heat=0.6, soot_up=0.9)
        m['bed'] = vm.tread_plate('burnt_bed', raw, burnt=True)
        m['rim'] = vm.burnt('burnt_rim', raw, rust=0.85, ash=0.3, heat=0.8, heat_tint=0.8)
    return m


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


def import_model(path: Path):
    before = set(bpy.data.objects)
    ext = path.suffix.lower()
    if ext in ('.gltf', '.glb'):
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(path))
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=str(path))
    elif ext == '.blend':
        append_blend(path)
    else:
        raise SystemExit(f'unsupported model format {ext}')
    objs = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in objs if o.type == 'MESH']
    if not meshes:
        raise SystemExit(f'{path}: no meshes')
    return meshes, [o for o in objs if o.type != 'MESH']


def bake_transforms(meshes, others, scale: float, yaw: float):
    """World-space mesh data (Blender coords), identity matrices, parents/empties removed."""
    g = Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Scale(scale, 4)  # game +Y = Blender +Z
    for o in meshes:
        mw = o.matrix_world.copy()
        if o.data.users > 1:
            o.data = o.data.copy()
        o.parent = None
        o.data.transform(g @ mw)
        o.matrix_world = Matrix()
    for o in others:
        bpy.data.objects.remove(o)


def kind_of(name: str, rules) -> str:
    low = name.lower()
    for pat, kind in rules:
        if fnmatch.fnmatch(low, pat.lower()):
            return kind
    return 'paint'


def classify(meshes, rules, palette: dict, object_kinds=(), radial=None):
    """Each face gets a palette kind from its material (else object) name; returns the kinds used.
    `object_kinds` ([pattern, kind]) overrides by object name (a shared material on unlike parts);
    `radial` {objects, ratio, inner, outer} splits wheels by each face's distance from the wheel's
    axle (game X): rims inside ratio × radius, tyres outside."""
    used = set()
    for o in meshes:
        me = o.data
        attr = me.attributes.get('kind') or me.attributes.new('kind', 'INT', 'FACE')
        names = [m.name if m else '' for m in me.materials] or ['']
        if radial and fnmatch.fnmatch(o.name.lower(), radial['objects'].lower()):
            vs = [v.co for v in me.vertices]
            cy = (min(v.y for v in vs) + max(v.y for v in vs)) / 2
            cz = (min(v.z for v in vs) + max(v.z for v in vs)) / 2
            r = max(max(v.z for v in vs) - cz, 1e-6)
            order = sorted({radial['inner'], radial['outer']})
            for i, p in enumerate(me.polygons):
                c = p.center
                d = ((c.y - cy) ** 2 + (c.z - cz) ** 2) ** 0.5
                attr.data[i].value = order.index(radial['inner'] if d < radial['ratio'] * r else radial['outer'])
            me['kinds'] = order
            sattr = me.attributes.get('srcmat') or me.attributes.new('srcmat', 'INT', 'FACE')
            for i, p in enumerate(me.polygons):
                sattr.data[i].value = p.material_index
            me['src_mats'] = names
            used |= set(order)
            continue
        forced = next((k for pat, k in object_kinds if fnmatch.fnmatch(o.name.lower(), pat.lower())), None)
        kinds = []
        for n in names:
            k = forced or kind_of(n or o.name, rules)
            if k not in palette and k not in ('glass', 'drop', 'source'):
                k = kind_of(o.name, rules)
            if k not in palette and k not in ('glass', 'drop', 'source'):
                k = 'paint' if 'paint' in palette else next(iter(palette))
            kinds.append(k)
        order = sorted(set(kinds))
        for i, p in enumerate(me.polygons):
            attr.data[i].value = order.index(kinds[min(p.material_index, len(kinds) - 1)])
        me['kinds'] = order
        # Per face: its source material index (for keep_source_normals).
        sattr = me.attributes.get('srcmat') or me.attributes.new('srcmat', 'INT', 'FACE')
        for i, p in enumerate(me.polygons):
            sattr.data[i].value = p.material_index
        me['src_mats'] = names
        used |= set(order)
    return used


def apply_palette(o, palette: dict, keep: set, src_normals=False):
    """Replace the object's materials with palette materials by face kind; drop faces whose kind is
    not in `keep`. Returns the object (None if nothing is left)."""
    me = o.data
    order = list(me['kinds'])
    bm = bmesh.new()
    bm.from_mesh(me)
    layer = bm.faces.layers.int.get('kind')
    kill = [f for f in bm.faces if order[f[layer]] not in keep]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    if not bm.faces:
        bm.free()
        bpy.data.objects.remove(o)
        return None
    slayer = bm.faces.layers.int.get('srcmat')
    src_names = list(me.get('src_mats', []))
    key = (lambda f: (order[f[layer]], f[slayer] if ((src_normals or order[f[layer]] == 'source') and slayer) else 0))  # noqa: E731
    slots = sorted({key(f) for f in bm.faces})
    for f in bm.faces:
        f.material_index = slots.index(key(f))
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    for k, si in slots:
        if k == 'source':
            me.materials.append(bpy.data.materials.get(src_names[si]) if si < len(src_names) else None)
            continue
        pm = palette[k]
        if src_normals and si < len(src_names):
            pm = keep_source_normal(o, pm, bpy.data.materials.get(src_names[si]))
        me.materials.append(pm)
    return o


def game_m(M: Matrix) -> Matrix:
    """A game-space transform as a Blender-space one."""
    return vb.C @ M @ vb.C.inverted()


def in_box(p_b: Vector, lo, hi) -> bool:
    g = (p_b.x, p_b.z, -p_b.y)
    return all(lo[i] <= g[i] <= hi[i] for i in range(3))


def apply_cuts(objs, cuts):
    for cut in cuts:
        pat = cut.get('objects', '*').lower()
        for o in objs:
            if not fnmatch.fnmatch(o.name.lower(), pat):
                continue
            bm = bmesh.new()
            bm.from_mesh(o.data)
            # `bisect`: split faces along these box planes first (game axis 0/1/2 = x/y/z, min or
            # max side), so faces straddling the box edge are cut there instead of kept whole.
            for axis, side in cut.get('bisect', []):
                v = (cut['min'] if side == 'min' else cut['max'])[axis]
                co = Vector(((v, 0, 0), (0, 0, v), (0, -v, 0))[axis])
                no = Vector(((1, 0, 0), (0, 0, 1), (0, -1, 0))[axis])
                bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no)
            kill = [f for f in bm.faces if in_box(f.calc_center_median(), cut['min'], cut['max'])]
            bmesh.ops.delete(bm, geom=kill, context='FACES')
            bm.to_mesh(o.data)
            bm.free()


def apply_moves(objs, moves):
    from mathutils import Euler
    for mv in moves:
        R = Euler([math.radians(a) for a in mv.get('rot', [0, 0, 0])], 'XYZ').to_matrix().to_4x4()
        piv = Vector(mv.get('pivot', [0, 0, 0]))
        G = game_m(Matrix.Translation(Vector(mv.get('translate', [0, 0, 0])) + piv) @ R @ Matrix.Translation(-piv))
        pat = mv.get('objects', '*').lower()
        for o in objs:
            if not fnmatch.fnmatch(o.name.lower(), pat):
                continue
            bm = bmesh.new()
            bm.from_mesh(o.data)
            faces = [f for f in bm.faces if in_box(f.calc_center_median(), mv['min'], mv['max'])]
            if faces:
                res = bmesh.ops.split(bm, geom=faces)
                verts = {v for g in res['geom'] if isinstance(g, bmesh.types.BMFace) for v in g.verts}
                for v in verts:
                    v.co = G @ v.co
                bm.to_mesh(o.data)
            bm.free()


def keep_source_normal(h, palette_mat, src_mat):
    """A copy of a palette material whose bump chains the source material's normal map."""
    if src_mat is None or not src_mat.use_nodes:
        return palette_mat
    tex = None
    for n in src_mat.node_tree.nodes:
        if n.type == 'NORMAL_MAP' and n.inputs['Color'].is_linked:
            tex = n.inputs['Color'].links[0].from_node
            break
    if tex is None or tex.type != 'TEX_IMAGE' or tex.image is None:
        return palette_mat
    key = f'{palette_mat.name}+{tex.image.name}'
    if key in bpy.data.materials:
        return bpy.data.materials[key]
    m = palette_mat.copy()
    m.name = key
    nt = m.node_tree
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = tex.image
    t.image.colorspace_settings.name = 'Non-Color'
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = h.data.uv_layers[0].name if h.data.uv_layers else ''
    nt.links.new(uv.outputs[0], t.inputs['Vector'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.uv_map = uv.uv_map
    nt.links.new(t.outputs['Color'], nm.inputs['Color'])
    for n in nt.nodes:
        if n.type == 'BUMP':
            nt.links.new(nm.outputs['Normal'], n.inputs['Normal'])
    return m


def tag_kind(o, kind: str):
    me = o.data
    a = me.attributes.get('kind') or me.attributes.new('kind', 'INT', 'FACE')
    sa = me.attributes.get('srcmat') or me.attributes.new('srcmat', 'INT', 'FACE')
    for i in range(len(me.polygons)):
        a.data[i].value = 0
        sa.data[i].value = 0
    me['kinds'] = [kind]
    me['src_mats'] = ['']
    return o


def make_part(name, c, size, rot, kind, bev=0.01):
    o = vb.box(name, tuple(c), tuple(size), None, rot=tuple(rot) if rot else None, bev=bev, segs=2)
    o = vb.apply_all([o])[0]
    return tag_kind(o, kind)


def debris_parts(spec):
    import random
    rnd = random.Random(spec.get('seed', 7))
    ix0, iz0, ix1, iz1 = spec.get('inner', [0, 0, 0, 0])
    ox0, oz0, ox1, oz1 = spec['outer']
    out = []
    tries = 0
    while len(out) < spec.get('count', 12) and tries < 500:
        tries += 1
        x, z = rnd.uniform(ox0, ox1), rnd.uniform(oz0, oz1)
        if ix0 <= x <= ix1 and iz0 <= z <= iz1:
            continue
        w = rnd.uniform(0.15, 0.7)
        out.append(make_part(f'debris_{len(out)}', (x, 0.02, z), (w, 0.03, w * rnd.uniform(0.3, 1.0)),
                             (rnd.uniform(-8, 8), rnd.uniform(0, 180), rnd.uniform(-8, 8)), spec.get('kind', 'hull'), 0.005))
    return out


def bounds_b(o):
    vs = [v.co for v in o.data.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    return lo, hi


def main(argv):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', required=True, type=Path)
    ap.add_argument('--out', type=Path, default=bv.OUT)
    ap.add_argument('--fast', action='store_true', help='tiny bake for tests (128 px, 1 sample)')
    ap.add_argument('--surface-only', action='store_true', help='rebuild the static armoured wreck surface from its shipped shape')
    a = ap.parse_args(argv)
    if a.surface_only and a.fast:
        ap.error('--surface-only requires the full atlas bake; omit --fast')
    cfg = json.loads(a.config.read_text(encoding='utf-8'))
    mid = cfg['id']
    out_dir = a.out / mid
    out_dir.mkdir(parents=True, exist_ok=True)
    if a.surface_only:
        from wreck_surface import rebuild
        rebuild(cfg, out_dir)
        return
    # A full source rebuild must not accidentally package a previous surface-only snapshot.
    (out_dir / 'surface_meshes.json').unlink(missing_ok=True)
    (out_dir / 'surface_pending').unlink(missing_ok=True)
    size = 128 if a.fast else cfg.get('size', 2048)
    out_size = 64 if a.fast else cfg.get('out_size', size // 2)
    budget = cfg.get('budget', [14000, 2600])
    contract = cfg.get('contract')
    vm.SOURCES = bv.SOURCES
    vb.reset_scene()
    palette = PALETTES[cfg.get('palette', 'truck')]()
    if cfg.get('tyre_maps'):
        tm = {k: (Path(v) if Path(v).is_absolute() else bv.RAW / v) for k, v in cfg['tyre_maps'].items()
              if k in ('base', 'normal', 'rough')}
        palette['tyre'] = vm.tyre_maps('tyre', tm['base'], tm['normal'], tm.get('rough'),
                                       mud=cfg['tyre_maps'].get('mud', 0.6), burnt=cfg['tyre_maps'].get('burnt', False))
    if 'glass' not in palette:
        palette['glass'] = vm.glass()
    vb.into('src')
    src = Path(cfg['input'])
    if not src.is_absolute():
        src = bv.RAW / src  # relative to tools/assets/raw (WD_RAW_ROOT)
    meshes, others = import_model(src)
    bake_transforms(meshes, others, cfg.get('scale', 1.0), cfg.get('yaw', 0.0))
    for stem, path in cfg.get('replace_images', {}).items():
        rp = Path(path) if Path(path).is_absolute() else bv.RAW / path
        for img in bpy.data.images:
            if Path(img.filepath or img.name).stem.lower().startswith(stem.lower()) or img.name.lower().startswith(stem.lower()):
                img.filepath = str(rp)
                img.reload()
                print('replaced image', img.name, '->', rp, flush=True)
    for pat in cfg.get('drop_objects', []):
        for o in [o for o in meshes if fnmatch.fnmatch(o.name.lower(), pat.lower())]:
            meshes.remove(o)
            bpy.data.objects.remove(o)
    if cfg.get('smooth_angle'):
        for o in meshes:
            with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
                if o.data.has_custom_normals:
                    bpy.ops.mesh.customdata_custom_splitnormals_clear()
            o.data.shade_smooth()
            o.data.set_sharp_from_angle(angle=math.radians(cfg['smooth_angle']))
    rules = cfg.get('materials', [['*', 'paint']])
    classify(meshes, rules, palette, cfg.get('object_kinds', []), cfg.get('radial'))
    coll = vb.collection('src')
    for o in meshes:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)

    # --- wheels (contract): split out, re-pivot at their centres.
    wheels = {}
    if contract == 'truck':
        for wname, pat in cfg.get('wheels', {}).items():
            hits = [o for o in meshes if fnmatch.fnmatch(o.name.lower(), pat.lower())]
            if not hits:
                raise SystemExit(f'{mid}: no object matches {wname} pattern {pat!r}')
            w = vb.join_keep_normals(hits, wname) if len(hits) > 1 else hits[0]
            w.name = wname
            meshes = [o for o in meshes if o not in hits]
            wheels[wname] = w
        if set(wheels) != set(WHEEL_NAMES):
            raise SystemExit(f'{mid}: the truck contract needs all four wheels {WHEEL_NAMES}')
    body_parts = meshes
    # Ground + centre: between the axles (contract) or on the footprint centre (props).
    allv = [v.co for o in body_parts + list(wheels.values()) for v in o.data.vertices]
    zmin = min(v.z for v in allv)
    if wheels:
        cs = {n: sum(bounds_b(w), Vector()) / 2 for n, w in wheels.items()}
        cx = sum(c.x for c in cs.values()) / 4
        cy = sum(c.y for c in cs.values()) / 4
        if cfg.get('fit_wheelbase', True):
            # Blender −Y = game +Z (front): wheelbase along Blender Y.
            front = (cs['wheel_fl'].y + cs['wheel_fr'].y) / 2
            rear = (cs['wheel_rl'].y + cs['wheel_rr'].y) / 2
            k = TRUCK['wheelbase'] / abs(front - rear)
        else:
            k = 1.0
        M = Matrix.Scale(k, 4) @ Matrix.Translation((-cx, -cy, -zmin))
    else:
        fit = cfg.get('fit')
        if fit and fit.get('objects'):
            # Measure (and centre, and ground) on these parts only (the tracks, not the gun).
            ref = [v.co for o in body_parts if fnmatch.fnmatch(o.name.lower(), fit['objects'].lower()) for v in o.data.vertices]
            if not ref:
                raise SystemExit(f"{mid}: fit objects {fit['objects']!r} match nothing")
            allv = ref
            zmin = min(v.z for v in allv)
        xs = [v.x for v in allv]
        ys = [v.y for v in allv]
        k = 1.0
        if fit:
            ext = {'x': max(xs) - min(xs), 'z': max(ys) - min(ys), 'y': max(v.z for v in allv) - zmin}[fit['axis']]
            k = fit['length'] / ext
        off = cfg.get('offset', [0.0, 0.0, 0.0])
        M = Matrix.Translation(vb.C @ Vector(off)) @ Matrix.Scale(k, 4) @             Matrix.Translation((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -zmin))
    if wheels and cfg.get('fit_track'):
        cs2 = {n: sum(bounds_b(w), Vector()) / 2 for n, w in wheels.items()}
        tr = (abs(cs2['wheel_fl'].x - cs2['wheel_fr'].x) + abs(cs2['wheel_rl'].x - cs2['wheel_rr'].x)) / 2
        M = Matrix.Diagonal((TRUCK['track'] / (tr * k), 1.0, 1.0, 1.0)) @ M
    for o in body_parts + list(wheels.values()):
        o.data.transform(M)
    if wheels and (cfg.get('wheel_width') or cfg.get('wheel_radius')):
        # Resize each wheel about its own centre to the contract tyre width (game X) / radius.
        for w in wheels.values():
            lo, hi = bounds_b(w)
            c = (lo + hi) / 2
            sx = cfg['wheel_width'] / max(hi.x - lo.x, 1e-6) if cfg.get('wheel_width') else 1.0
            sr = cfg['wheel_radius'] / max((hi.z - lo.z) / 2, 1e-6) if cfg.get('wheel_radius') else 1.0
            w.data.transform(Matrix.Translation(c) @ Matrix.Diagonal((sx, sr, sr, 1.0)) @ Matrix.Translation(-c))
    if os.environ.get('WD_BOUNDS'):
        # Each part's game-space bounds after the fit (for writing cut/move/add boxes).
        for o in body_parts:
            lo, hi = bounds_b(o)
            print('BOUNDS', o.name, [round(lo.x, 3), round(lo.z, 3), round(-hi.y, 3)], [round(hi.x, 3), round(hi.z, 3), round(-lo.y, 3)], flush=True)
    # Edits in game coords: cuts, added parts, crash pose, dents, debris.
    apply_cuts(body_parts, cfg.get('cut', []))
    apply_moves(body_parts, cfg.get('move', []))
    hi_detail = []
    for i, spec in enumerate(cfg.get('add', [])):
        part = make_part(f'add_{i}', spec['c'], spec['s'], spec.get('rot'), spec.get('kind', 'paint'),
                         spec.get('bevel', cfg.get('bevel', 0.01)))
        # `hi_only`: relief (ribs, tread, welds) baked into the low's maps, never shipped as mesh.
        (hi_detail if spec.get('hi_only') else body_parts).append(part)
    if cfg.get('debris'):
        body_parts += debris_parts(cfg['debris'])
    if cfg.get('dent'):
        d = cfg['dent']
        props = {o.name: (list(o.data['kinds']), list(o.data.get('src_mats', []))) for o in body_parts}
        for o in body_parts:
            vb.displace_noise(o, d.get('strength', 0.05), d.get('scale', 0.6))
            vb.subdivide(o, d.get('subdiv', 0)) if d.get('subdiv') else None
        body_parts[:] = vb.apply_all(body_parts)
        for o in body_parts:
            o.data['kinds'], o.data['src_mats'] = props[o.name]
    if cfg.get('tilt') or cfg.get('sink'):
        from mathutils import Euler
        R = Euler([math.radians(a) for a in cfg.get('tilt', [0, 0, 0])], 'XYZ').to_matrix().to_4x4()
        G = game_m(Matrix.Translation((0.0, -cfg.get('sink', 0.0), 0.0)) @ R)
        for o in body_parts:
            o.data.transform(G)
    if wheels and cfg.get('wheel_bulge'):
        k_b = cfg['wheel_bulge']
        for w in wheels.values():
            lo, hi = bounds_b(w)
            c = (lo + hi) / 2
            r = (hi.z - lo.z) / 2
            for v in w.data.vertices:
                t = (c.z - 0.55 * r - v.co.z) / (0.45 * r)
                if t > 0:
                    v.co.x = c.x + (v.co.x - c.x) * (1.0 + k_b * min(t, 1.0))
                    v.co.z = max(v.co.z, c.z - (1.0 - 0.06 * k_b) * r)
    wheel_centres = {}
    for n, w in wheels.items():
        c = sum(bounds_b(w), Vector()) / 2
        w.data.transform(Matrix.Translation(-c))
        wheel_centres[n] = c

    # --- hi (bake source): the geometry as is, with the palette's sourced materials.
    keep_baked = (set(palette) - {'glass'}) | {'source'}
    hi_objs = []
    for o in body_parts + list(wheels.values()) + hi_detail:
        h = o.copy()
        h.data = o.data.copy()
        coll.objects.link(h)
        h = apply_palette(h, palette, keep_baked, src_normals=cfg.get('keep_source_normals', False))
        if h:
            hi_objs.append((o, h))
    for o in hi_detail:
        o.hide_render = True  # only its hi copy bakes; the original never reaches the low
    # Glass (separate transparent primitive, not baked).
    glass = []
    for o in body_parts:
        gcopy = o.copy()
        gcopy.data = o.data.copy()
        coll.objects.link(gcopy)
        gcopy = apply_palette(gcopy, palette, {'glass'})
        if gcopy:
            glass.append(gcopy)
    # Low: same geometry minus glass/drop, palette slots irrelevant (re-materialled after bake).
    lows = []
    for o in body_parts + list(wheels.values()):
        lo_ = apply_palette(o, palette, keep_baked)
        if lo_:
            lows.append(lo_)
    # Park each wheel (low + hi) away from the body while baking.
    offsets = {}
    for i, n in enumerate(WHEEL_NAMES if wheels else ()):
        r = (bounds_b(wheels[n])[1].z - bounds_b(wheels[n])[0].z) / 2
        off = Vector((6.0 * (i + 1), 0.0, r))
        offsets[n] = off
    for o, h in hi_objs:
        if o.name in offsets:
            h.data.transform(Matrix.Translation(offsets[o.name]))
    for o in lows:
        if o.name in offsets:
            o.data.transform(Matrix.Translation(offsets[o.name]))
        bv.tag_part(o, (WHEEL_NAMES.index(o.name) + 1) if o.name in offsets else 0)
    combo = vb.join_keep_normals(lows, 'combo') if len(lows) > 1 else lows[0]
    combo = vb.triangulate(combo)
    if vb.tri_count(combo) > budget[0]:
        combo = vb.decimate(combo, int(budget[0] * 0.985))  # the decimator overshoots by a few
    if cfg.get('smooth_angle'):
        # Organic / scanned / dented sources: drop imported split normals, smooth by angle (the
        # decimated low otherwise shows its facets; the bake carries the detail).
        with bpy.context.temp_override(object=combo, active_object=combo, selected_objects=[combo],
                                       selected_editable_objects=[combo]):
            if combo.data.has_custom_normals:
                bpy.ops.mesh.customdata_custom_splitnormals_clear()
        combo.data.shade_smooth()
        combo.data.set_sharp_from_angle(angle=math.radians(cfg['smooth_angle']))
    if cfg.get('uv', 'auto') == 'auto' or not combo.data.uv_layers:
        while combo.data.uv_layers:
            combo.data.uv_layers.remove(combo.data.uv_layers[0])
        combo.data.uv_layers.new(name='UVMap')
        vb.smart_uv(combo, margin=cfg.get('uv_margin', 0.004), angle=cfg.get('uv_angle', 50.0),
                    small_area=cfg.get('uv_small_area'))
    hi = vb.join_keep_normals([h for _, h in hi_objs], 'hi')
    imgs = bv.bake_all(combo, [hi], size, mid, out_dir, fast=a.fast)
    maps = bv.compose_maps(imgs, out_size, mid, out_dir)
    bpy.data.objects.remove(hi)
    tex = vm.textured(mid, maps['albedo'], maps['orm'], maps['normal'])
    combo.data.materials.clear()
    combo.data.materials.append(tex)

    if contract == 'truck':
        parts = {}
        for i, n in enumerate(WHEEL_NAMES):
            w = bv.separate_by_name(combo, {i + 1}, n)
            w.data.transform(Matrix.Translation(-offsets[n]))
            w.matrix_world = Matrix()
            parts[n] = w
        body = combo
        if glass:
            for gl in glass:
                gl.data.materials.clear()
                gl.data.materials.append(palette['glass'])
            body = vb.join_keep_normals([body, *glass], 'body')
        if 'seats' not in cfg:
            import vehicle_truck
            cfg['seats'] = vehicle_truck.SEATS
        near = place(body, parts, wheel_centres, cfg['seats'], mid)
        fb = body.copy()
        fb.data = body.data.copy()
        far_body_budget = budget[1] - 4 * 160
        fb = vb.decimate(fb, far_body_budget)
        fparts = {}
        for n, w in parts.items():
            fw = w.copy()
            fw.data = w.data.copy()
            fw.matrix_world = Matrix()
            fparts[n] = vb.decimate(fw, 150)
        far = place(fb, fparts, wheel_centres, cfg.get('seats', {}), mid + '_far')
        stats = bv.write_outputs(mid, near, far, out_dir)
        errs = []
        for lod, b in (('', budget[0]), ('_far', budget[1])):
            errs += [f'{lod or "near"}: {e}' for e in
                     validate_truck(out_dir / f'{mid}{lod}.gltf', b, envelope=cfg.get('envelope', True),
                                    wheel_shape=cfg.get('wheel_shape', True))]
    else:
        body = combo
        if glass:
            body = vb.join_keep_normals([body, *glass], 'wreck')
        body.name = 'wreck'
        far = body.copy()
        far.data = body.data.copy()
        vb.collection('far').objects.link(far)
        far = vb.decimate(far, budget[1])
        far.name = 'wreck'
        near_objs, far_objs = [body], [far]
        if cfg.get('scorch'):
            import vehicle_wrecks as vw
            sc = cfg['scorch']
            img = bv.scorch_texture(out_dir / f'{mid}_scorch.png')
            dmat = vm.decal('scorch', img)
            dec = vw.scorch_decal('scorch', sc.get('radius', 6.0), tuple(sc.get('center', (0.0, 0.0))), 28, dmat)
            fdec = dec.copy()
            fdec.data = dec.data.copy()
            vb.collection('far').objects.link(fdec)
            dec['export_name'] = fdec['export_name'] = 'scorch'
            near_objs.append(dec)
            far_objs.append(fdec)
        stats = bv.write_outputs(mid, near_objs, far_objs, out_dir, body_name='wreck')
        errs = []
    stats['contract_errors'] = errs
    (out_dir / f'{mid}.json').write_text(json.dumps(stats, indent=2), encoding='utf-8')
    for e in errs:
        print('CONTRACT', e, flush=True)
    print('REBAKE', mid, 'ok' if not errs else f'{len(errs)} contract errors', flush=True)
    if errs:
        sys.exit(2)


def place(body, wheels, centres, seats, tag):
    coll = vb.collection(tag)
    objs = []
    for o, name in ((body, 'body'),):
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
        o.name = name
        o['export_name'] = name
        objs.append(o)
    for n, w in wheels.items():
        o = bpy.data.objects.new(n, w.data)
        o.matrix_world = Matrix.Translation(centres[n])
        o['export_name'] = n
        coll.objects.link(o)
        objs.append(o)
    for n, pos in seats.items():
        e = bpy.data.objects.new(n, None)
        e.matrix_world = Matrix.Translation(vb.C @ Vector(pos))
        e['export_name'] = n
        coll.objects.link(e)
        objs.append(e)
    return objs


if __name__ == '__main__':
    os.environ.setdefault('WD_SCRATCH', os.environ.get('TEMP', '/tmp'))
    try:
        main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    except SystemExit:
        raise
    except BaseException:  # Blender exits 0 on a script error: make failures visible
        import traceback
        traceback.print_exc()
        sys.stdout.flush()
        os._exit(1)
