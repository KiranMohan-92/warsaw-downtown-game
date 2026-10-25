"""Build the Market vehicles in Blender (our own modelling, no downloads, no generation).

    blender -b --python tools/assets/build_vehicles.py -- [--only truck,heli_wreck] [--size 2048]
                                                          [--preview]   # hi/low clay check only

Models (vehicle_spec.py has the contract numbers and triangle budgets):
- `truck`            drivable armored 4x4 utility truck: nodes body + wheel_fl/fr/rl/rr (pivot at
                     the wheel centre, rolling about local X) + seat/exit empties; glass is one
                     cheap transparent material on the body.
- `truck_destroyed`  the same node layout, burnt out: glass gone, tyres burnt off, body sagging.
- `heli_wreck`, `tank_wreck`  render-only replacements for the Market's box wrecks, hugging their
                     collision boxes (shared maps/props.ts) in the props' local frame.

Per model: a `hi` build (bevels, bolts, seams, tread) carries procedural Cycles materials
(vehicle_mats.py); the low build is unwrapped into one atlas and the hi is baked onto it (albedo,
roughness, metalness, tangent normal, AO; CPU Cycles, supersampled then halved). The far LOD is a
decimated copy sharing the uvs. Output (git-ignored): tools/assets/build/vehicles/<id>/ —
<id>.gltf / <id>_far.gltf (+ .bin) and <id>_{albedo,orm,normal}.png (1k) and _2k sources, plus
<id>.json (triangles, sizes). The package stage (phase 2) turns these into shipped WebP.
"""

import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import vehicle_bpy as vb  # noqa: E402
import vehicle_mats as vm  # noqa: E402
from vehicle_spec import BUDGETS  # noqa: E402

ROOT = HERE.parents[1]
RAW = Path(os.environ.get('WD_RAW_ROOT', ROOT)) / 'tools/assets/raw'
OUT = ROOT / 'tools/assets/build/vehicles'
# Healed Codex texture sources (vehicle_texprep.py output, scratch; never shipped).
SOURCES = Path(os.environ['WD_VEH_SOURCES']) if os.environ.get('WD_VEH_SOURCES') else None
PAINT = 0x575a49  # dark olive grey (no markings)
OFFSET = Vector((0.0, 0.0, -30.0))  # Blender coords: where wheels go while the body bakes


def raw_dir():
    return RAW if RAW.exists() else None


# ---------------------------------------------------------------------------------- materials


def truck_mats(destroyed: bool) -> dict:
    raw = raw_dir()
    rubber = lambda n, **k: vm.sourced_simple(n, 'tyre_sidewall', 2.5, 0.85, bump_s=0.25,  # noqa: E731
                                              fallback=lambda: vm.rubber(n, raw, **k), dust=0.5)
    if not destroyed:
        return {
            'paint': vm.sourced_paint('paint', 'olive_paint', raw, scale=0.6, wear=0.45, dirt=0.85, dust=0.45),
            'interior': vm.paint('interior', 0x6a6d60, raw, wear=0.2, dirt=0.35, dust=0.4, mud_height=0.7),
            'metal': vm.dark_metal('metal', 0x2d2e2a, raw),
            'plastic': vm.plain('plastic', 0x1d1e1c, rough=0.72),
            'fabric': vm.sourced_simple('fabric', 'canvas_tarp', 2.0, 0.92, fallback=lambda: vm.fabric('fabric', 0x3d3f35)),
            'rubber': rubber('rubber'),
            'rim': vm.sourced_paint('rim', 'olive_paint', raw, scale=1.4, wear=0.6, dirt=1.0, dust=0.2, mud_height=0.5, streaks=0.0,
                                    tint=0x45473b),
            'lens': vm.lens('lens'),
            'lens_amber': vm.lens('lens_amber', 0xc0812c, 0.2),
            'lens_red': vm.lens('lens_red', 0x7d1c17, 0.2),
            'jerry': vm.sourced_paint('jerry', 'olive_paint', raw, scale=1.8, wear=0.5, streaks=0.2, tint=0x3e4733),
            'bed': vm.sourced_simple('bed', 'bed_plating', 1.3, 0.6, metal=0.3, bump_s=0.5,
                                     fallback=lambda: vm.dark_metal('bed', 0x2d2e2a, raw)),
            'seam': vm.plain('seam', 0x121211, rough=0.9),
            'glass': vm.glass(),
        }
    burnt = vm.sourced_burnt('burnt', raw, paint_src='olive_paint')
    return {
        'paint': burnt,
        'interior': vm.sourced_burnt('burnt_in', raw, ash=0.7, rust=0.3),
        'metal': vm.sourced_burnt('burnt_metal', raw, rust=0.75, ash=0.2, scale=1.2),
        'plastic': vm.plain('melted', 0x121110, rough=0.95),
        'fabric': vm.sourced_burnt('burnt_seat', raw, ash=0.9, rust=0.1),
        'rubber': rubber('rubber_burnt', dust=0.8, burnt_off=True),
        'rim': vm.sourced_burnt('burnt_rim', raw, rust=0.8, ash=0.3, scale=1.4),
        'lens': vm.plain('lens_soot', 0x2a2a28, rough=0.4),
        'lens_amber': vm.plain('lens_soot2', 0x302820, rough=0.4),
        'lens_red': vm.plain('lens_soot3', 0x2e1d1a, rough=0.4),
        'jerry': vm.sourced_burnt('burnt_jerry', raw, rust=0.6, scale=1.8),
        'bed': vm.sourced_burnt('burnt_bed', raw, rust=0.7),
        'seam': vm.plain('seam', 0x0e0d0c, rough=0.9),
        'glass': vm.glass(),
    }


# ---------------------------------------------------------------------------------- pipeline


def offset_objs(objs, off: Vector):
    for o in objs:
        o.matrix_world = Matrix.Translation(off) @ o.matrix_world


def finish_low(objs, name):
    obj = vb.join_keep_normals(objs, name)
    return obj


def bake_all(low, his, size, mid, out_dir: Path, ao_dist=0.6, fast=False):
    """Bake hi → low: albedo (with AO multiplied in lightly), ORM, normal. Saves 2k + 1k PNGs."""
    bake_mat = bpy.data.materials.new(f'bake_{mid}')
    bake_mat.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(bake_mat)
    imgs = {}
    for kind in ('DIFFUSE', 'ROUGHNESS', 'METAL', 'NORMAL', 'AO'):
        img = vb.new_image(f'{mid}_{kind}', size, data=kind != 'DIFFUSE')
        if kind == 'METAL':
            saved = vm_route(his)
            vb.bake_pass(low, his, 'EMIT', img, samples=1)
            vb.restore_bsdf(saved)
        elif kind == 'AO':
            bpy.context.scene.world = bpy.context.scene.world or bpy.data.worlds.new('w')
            bpy.context.scene.world.light_settings.distance = ao_dist
            vb.bake_pass(low, his, 'AO', img, samples=2 if fast else 16)
        else:
            vb.bake_pass(low, his, kind, img, samples=1 if fast else {'DIFFUSE': 4, 'ROUGHNESS': 2, 'NORMAL': 4}[kind])
        imgs[kind] = img
        print(f'  baked {kind}', flush=True)
    return imgs


def vm_route(his):
    mats = []
    for h in his:
        for m in h.data.materials:
            if m and m not in mats and 'bsdf' in m:
                mats.append(m)
    return vb.route_emission(mats, 'Metallic')


def compose_maps(imgs, size_out, mid, out_dir: Path):
    """albedo = diffuse × lerp(1, ao, 0.65); orm = (ao, rough, metal). numpy, then 2k + 1k."""
    import numpy as np
    def arr(img):
        a = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
        return a
    dif, rough, metal, nrm, ao = (arr(imgs[k]) for k in ('DIFFUSE', 'ROUGHNESS', 'METAL', 'NORMAL', 'AO'))
    occ = ao[..., :1]
    # DIFFUSE pixels are linear floats in Blender's buffer for a non-float sRGB image? The image is
    # 8-bit sRGB, and .pixels returns the stored (display) values: work in that space.
    albedo = dif.copy()
    albedo[..., :3] = dif[..., :3] * (1.0 - 0.6 * (1.0 - occ))
    orm = np.concatenate([occ, rough[..., :1], metal[..., :1], np.ones_like(occ)], axis=-1)
    out = {}
    for key, a, data in (('albedo', albedo, False), ('orm', orm, True), ('normal', nrm, True)):
        a[..., 3] = 1.0
        for suffix, px in (('_2k', imgs['DIFFUSE'].size[0]), ('', size_out)):
            img = bpy.data.images.new(f'{mid}_{key}{suffix}', imgs['DIFFUSE'].size[0], imgs['DIFFUSE'].size[0], alpha=False)
            if data:
                img.colorspace_settings.name = 'Non-Color'
            img.pixels[:] = a.ravel()
            if px != img.size[0]:
                img.scale(px, px)
            vb.save_png(img, out_dir / f'{mid}_{key}{suffix}.png')
            if suffix == '':
                out[key] = img
    return out


def separate_by_name(obj, prefix_set, name):
    """Split faces whose part attribute (int) is in prefix_set into a new object."""
    import bmesh
    me = obj.data
    attr = me.attributes.get('part')
    bm_all = bmesh.new()
    bm_all.from_mesh(me)
    layer = bm_all.faces.layers.int.get('part')
    keep = bmesh.new()
    keep.from_mesh(me)
    lk = keep.faces.layers.int.get('part')
    bmesh.ops.delete(bm_all, geom=[f for f in bm_all.faces if f[layer] in prefix_set], context='FACES')
    bmesh.ops.delete(keep, geom=[f for f in keep.faces if f[lk] not in prefix_set], context='FACES')
    rest_me = bpy.data.meshes.new(obj.name)
    bm_all.to_mesh(rest_me)
    sep_me = bpy.data.meshes.new(name)
    keep.to_mesh(sep_me)
    for m in me.materials:
        rest_me.materials.append(m)
        sep_me.materials.append(m)
    bm_all.free()
    keep.free()
    obj.data = rest_me
    o = bpy.data.objects.new(name, sep_me)
    obj.users_collection[0].objects.link(o)
    del attr
    return o


def tag_part(obj, value: int):
    me = obj.data
    a = me.attributes.get('part') or me.attributes.new('part', 'INT', 'FACE')
    for i in range(len(me.polygons)):
        a.data[i].value = value


def mirror_x(obj, name):
    me = obj.data.copy()
    me.name = name
    me.transform(Matrix.Scale(-1, 4, Vector((1, 0, 0))))
    me.flip_normals()
    o = bpy.data.objects.new(name, me)
    obj.users_collection[0].objects.link(o)
    return o


def export_gltf(objs, path: Path):
    bpy.context.view_layer.update()
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format='GLTF_SEPARATE', use_selection=True, export_yup=True,
        export_apply=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='EXPORT', export_image_format='AUTO', export_texture_dir='',
        export_extras=False, export_cameras=False, export_lights=False, export_animations=False,
        export_skins=False, export_morph=False,
    )


def bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != 'MESH':
            continue
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            g = Vector((w.x, w.z, -w.y))
            lo = Vector(map(min, lo, g))
            hi = Vector(map(max, hi, g))
    return lo, hi


def remove_cutters(cutters):
    for c in cutters:
        if c.name in bpy.data.objects:
            bpy.data.objects.remove(c)


# ---------------------------------------------------------------------------------- truck


def sag(objs, dy, roll_deg, pitch_deg=0.0):
    S = vb.C @ Matrix.Translation((0, dy, 0)) @ Matrix.Rotation(math.radians(roll_deg), 4, 'Z') @ \
        Matrix.Rotation(math.radians(pitch_deg), 4, 'X') @ vb.C.inverted()
    for o in objs:
        o.matrix_world = S @ o.matrix_world


def wreck_truck_parts(parts, hi):
    """Destroyed-variant geometry changes on top of the intact parts (deterministic)."""
    import vehicle_truck as vt
    by = {o.name: o for o in parts}
    # Tailgate dropped open, hanging from its bottom hinge.
    tg = by.get('tailgate')
    if tg:
        piv = Vector((0, vt.BED_FLOOR, vt.Z_REAR + 0.05))
        M = vb.C @ Matrix.Translation(piv) @ Matrix.Rotation(math.radians(-78), 4, 'X') @ Matrix.Translation(-piv) @ vb.C.inverted()
        tg.matrix_world = M @ tg.matrix_world
    # One mirror gone, the other hanging; the spare tyre burnt away (rim stays); antenna snapped.
    for n in ('mirror_-1', 'mirror_arm_-1', 'spare', 'ant_whip'):
        if n in by:
            bpy.data.objects.remove(by[n])
            parts.remove(by[n])
    m = by.get('mirror_1')
    if m:
        m.matrix_world = Matrix.Translation((0, 0, -0.12)) @ m.matrix_world
    # Dents: subdivided + displaced panels (low keeps them coarse).
    for n in ('roof', 'hood', 'bed_wall_1', 'bed_wall_-1', 'cab_side_1', 'cab_side_-1', 'tailgate'):
        o = by.get(n)
        if not o:
            continue
        vb.displace_noise(o, 0.05 if hi else 0.04, 0.5)
        vb.subdivide(o, 3 if hi else 1)
    return parts


def build_truck(destroyed: bool, size: int, preview=False):
    import vehicle_truck as vt
    mid = 'truck_destroyed' if destroyed else 'truck'
    out_dir = OUT / mid
    out_dir.mkdir(parents=True, exist_ok=True)
    vb.reset_scene()
    M = truck_mats(destroyed)

    def build(hi):
        vb.into('hi' if hi else 'low')
        parts, glass, cutters = vt.body_parts(M, hi, destroyed)
        vt.arches([o for o in parts if o.name.split('.')[0] in ('tub', 'hood', 'cab_side_1', 'cab_side_-1')])
        if destroyed:
            parts = wreck_truck_parts(parts, hi)
            for gpart in glass:
                bpy.data.objects.remove(gpart)
            glass = []
            sag(parts, -0.07, 1.6, -0.8)
        wheel = vt.wheel_parts(M, hi, destroyed, side=1)
        return parts, glass, cutters, wheel

    lo_parts, lo_glass, lo_cut, lo_wheel = build(False)
    hi_parts, _hg, hi_cut, hi_wheel = build(True)
    for o in _hg:
        bpy.data.objects.remove(o)
    if preview:
        def place4(ws):
            out = []
            for name, pos in vt.WHEELS.items():
                for w in ws:
                    o = w.copy()
                    w.users_collection[0].objects.link(o)
                    mirror = Matrix.Scale(-1, 4, Vector((1, 0, 0))) if pos[0] < 0 else Matrix()
                    o.matrix_world = Matrix.Translation(vb.C @ Vector(pos)) @ mirror @ w.matrix_world
                    out.append(o)
            for w in ws:
                bpy.data.objects.remove(w)
            return out
        return {'low': lo_parts + lo_glass + place4(lo_wheel), 'hi': hi_parts + place4(hi_wheel)}

    # Low: body (+ the left wheel parked at OFFSET for the bake), glass separate.
    body = finish_low(lo_parts, 'body')
    wheel = finish_low(lo_wheel, 'wheel')
    glass = finish_low(lo_glass, 'glass') if lo_glass else None
    remove_cutters(lo_cut)
    offset_objs([wheel], OFFSET)
    tag_part(body, 0)
    tag_part(wheel, 1)
    combo = vb.join_keep_normals([body, wheel], 'combo')
    combo = vb.triangulate(combo)
    vb.smart_uv(combo, margin=0.004)
    # Hi: everything applied in place (wheel parts offset alike).
    his = vb.apply_all(hi_parts)
    hw = vb.apply_all(hi_wheel)
    offset_objs(hw, OFFSET)
    remove_cutters(hi_cut)
    # One hi object: selected-to-active casts per pixel against every selected object.
    hi_obj = vb.join_keep_normals(his + hw, 'hi')
    imgs = bake_all(combo, [hi_obj], size, mid, out_dir)
    maps = compose_maps(imgs, size // 2, mid, out_dir)
    bpy.data.objects.remove(hi_obj)
    tex_mat = vm.textured(mid, maps['albedo'], maps['orm'], maps['normal'])
    combo.data.materials.clear()
    combo.data.materials.append(tex_mat)
    wheel = separate_by_name(combo, {1}, 'wheel_L')
    body = combo
    body.name = 'body'
    wheel.data.transform(Matrix.Translation(-OFFSET))
    wheel.matrix_world = Matrix()
    # Wheel mesh data around its own centre: the left wheel was built at the origin.
    wl = wheel
    wr = mirror_x(wl, 'wheel_R')
    if glass:
        glass.data.materials.clear()
        glass.data.materials.append(M['glass'])
        body = vb.join_keep_normals([body, glass], 'body')
    near = place_truck(body, wl, wr, vt, mid)
    # Far LOD.
    fb = body.copy()
    fb.data = body.data.copy()
    fb = vb.decimate(fb, BUDGETS[mid][1] - 4 * 160)
    print('FAR body', vb.tri_count(fb), flush=True)
    fw = wl.copy()
    fw.data = wl.data.copy()
    fw.matrix_world = Matrix()
    fw = vb.decimate(fw, 150)
    fwr = mirror_x(fw, 'wheel_R_far')
    far = place_truck(fb, fw, fwr, vt, mid + '_far', far=True)
    stats = write_outputs(mid, near, far, out_dir)
    bpy.ops.wm.save_as_mainfile(filepath=str(scratch() / f'{mid}.blend'), compress=True)
    return stats


def place_truck(body, wl, wr, vt, tag, far=False):
    """Nodes per the contract: body at the origin, wheels at their centres, seat/exit empties."""
    coll = vb.collection(tag)
    objs = []
    body.name = 'body'
    for c in body.users_collection:
        c.objects.unlink(body)
    coll.objects.link(body)
    objs.append(body)
    for name, pos in vt.WHEELS.items():
        src = wl if pos[0] > 0 else wr
        o = bpy.data.objects.new(name, src.data)
        o.matrix_world = Matrix.Translation(vb.C @ Vector(pos))
        coll.objects.link(o)
        objs.append(o)
    for name, pos in vt.SEATS.items():
        e = bpy.data.objects.new(name, None)
        e.empty_display_type = 'ARROWS'
        e.empty_display_size = 0.3
        e.matrix_world = Matrix.Translation(vb.C @ Vector(pos))
        coll.objects.link(e)
        objs.append(e)
    # Unique names inside this export (Blender suffixes .001 across collections).
    return objs


def write_outputs(mid, near, far, out_dir: Path, body_name='body'):
    stats = {'model': mid}
    for key, objs, fname in (('near', near, f'{mid}.gltf'), ('far', far, f'{mid}_far.gltf')):
        # Rename to exact contract names for the export (others step aside meanwhile).
        names = {o: o.get('export_name', o.name.split('.')[0]) for o in objs}
        for o in objs:
            o['export_name'] = names[o]
        for o in bpy.data.objects:
            if o not in objs:
                o.name = o.get('export_name', o.name) + '__aside'
        for o, n in names.items():
            o.name = n
        export_gltf(objs, out_dir / fname)
        tris = sum(vb.tri_count(o) for o in objs if o.type == 'MESH')
        lo, hi = bounds([o for o in objs if o.name == body_name])
        stats[key] = {'triangles': tris, 'body_bbox': [list(lo), list(hi)]}
        for o in objs:
            if o.type == 'MESH':
                stats[key].setdefault('nodes', {})[o.name] = vb.tri_count(o)
    (out_dir / f'{mid}.json').write_text(json.dumps(stats, indent=2), encoding='utf-8')
    print(json.dumps(stats))
    return stats


def wreck_mats(kind: str) -> dict:
    raw = raw_dir()
    if kind == 'heli':
        return {
            'hull': vm.sourced_burnt('heli_hull', raw, paint_src='paint_darkgrey', heat=0.55, rust=0.5, ash=0.45),
            'inner': vm.sourced_burnt('heli_inner', raw, ash=0.7, rust=0.35),
            'metal': vm.sourced_burnt('heli_metal', raw, rust=0.7, ash=0.2, scale=1.2),
            'crazed': vm.crazed_glass('crazed'),
            'blade': vm.sourced_burnt('heli_blade', raw, paint_src='paint_darkgrey', heat=0.25, rust=0.25, ash=0.25),
            'seam': vm.plain('seam', 0x0e0d0c, rough=0.9),
        }
    hull_src = 'cast_armor' if vm.have('cast_armor') else 'olive_paint'
    return {
        'hull': vm.sourced_burnt('tank_hull', raw, paint_src=hull_src, heat=0.3, rust=0.45, ash=0.35),
        'metal': vm.sourced_burnt('tank_metal', raw, rust=0.7, ash=0.25, scale=1.2),
        'rubber': vm.sourced_burnt('tank_track', raw, rust=0.85, ash=0.15, scale=1.5),
        'seam': vm.plain('seam', 0x0e0d0c, rough=0.9),
    }


def scorch_texture(path: Path, size=512, seed=5):
    """Ground scorch RGBA (soot, ash specks, ragged alpha falloff), numpy only."""
    import numpy as np
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / (size - 1) * 2 - 1
    r = np.sqrt(x * x + y * y)
    noise = np.zeros_like(r)
    for octave in range(5):
        n = 4 * 2 ** octave
        g = rng.random((n + 1, n + 1)).astype(np.float32)
        gi = np.kron(g, np.ones((size // n + 1, size // n + 1), np.float32))[:size, :size]
        noise += gi / 2 ** octave
    noise /= noise.max()
    a = np.clip((1.0 - r / 0.9) * 1.6 + (noise - 0.5) * 0.9, 0, 1)
    a = a ** 1.2
    soot = np.stack([0.035 + 0.04 * noise, 0.032 + 0.035 * noise, 0.03 + 0.03 * noise], -1)
    ash = (rng.random((size, size)) > 0.985)[..., None] * 0.18
    rgb = np.clip(soot + ash, 0, 1)
    if vm.have('scorched_ground'):
        si = bpy.data.images.load(str(vm.SOURCES / 'scorched_ground.png'))
        si.scale(size, size)
        src_px = np.array(si.pixels[:], dtype=np.float32).reshape(size, size, 4)[::-1, :, :3]
        rgb = np.clip(src_px * (0.55 + 0.45 * (1 - a[..., None])) + ash * 0.3, 0, 1)
    rgba = np.concatenate([rgb, a[..., None]], -1).astype(np.float32)
    img = bpy.data.images.new('scorch', size, size, alpha=True)
    img.pixels[:] = rgba[::-1].ravel()
    vb.save_png(img, path)
    return img


def build_static(mid: str, size: int, preview_only=False):
    """A wreck: one `wreck` node (baked atlas) + a `scorch` ground decal node; near + far."""
    import vehicle_wrecks as vw
    kind = 'heli' if mid.startswith('heli') else 'tank'
    out_dir = OUT / mid
    out_dir.mkdir(parents=True, exist_ok=True)
    vb.reset_scene()
    M = wreck_mats(kind)
    fn = vw.heli_parts if kind == 'heli' else vw.tank_parts
    vb.into('low')
    lo_parts, lo_cut = fn(M, False)
    vb.into('hi')
    hi_parts, hi_cut = fn(M, True)
    if preview_only:
        return {'low': vb.apply_all(lo_parts), 'hi': vb.apply_all(hi_parts)}
    low = vb.join_keep_normals(lo_parts, 'wreck')
    remove_cutters(lo_cut)
    low = vb.triangulate(low)
    vb.smart_uv(low, margin=0.003)
    his = vb.apply_all(hi_parts)
    remove_cutters(hi_cut)
    hi_obj = vb.join_keep_normals(his, 'hi')
    imgs = bake_all(low, [hi_obj], size, mid, out_dir)
    maps = compose_maps(imgs, size // 2, mid, out_dir)
    bpy.data.objects.remove(hi_obj)
    low.data.materials.clear()
    low.data.materials.append(vm.textured(mid, maps['albedo'], maps['orm'], maps['normal']))
    # Scorch decal.
    sc_img = scorch_texture(out_dir / f'{mid}_scorch.png')
    sc_mat = vm.decal('scorch', sc_img)
    radius = 7.5 if kind == 'heli' else 6.0
    center = (1.5, 0.5) if kind == 'heli' else (0.0, 0.0)
    vb.into('out')
    decal = vw.scorch_decal('scorch', radius, center, 28, sc_mat)
    near = [low, decal]
    far_low = low.copy()
    far_low.data = low.data.copy()
    far_low = vb.decimate(far_low, BUDGETS[mid][1] - 30)
    far_decal = decal.copy()
    far_decal.data = decal.data.copy()
    vb.collection('far').objects.link(far_decal)
    for c in list(far_low.users_collection):
        c.objects.unlink(far_low)
    vb.collection('far').objects.link(far_low)
    for c in list(low.users_collection):
        c.objects.unlink(low)
    vb.collection('out').objects.link(low)
    stats = write_outputs(mid, near, [far_low, far_decal], out_dir, body_name='wreck')
    bpy.ops.wm.save_as_mainfile(filepath=str(scratch() / f'{mid}.blend'), compress=True)
    return stats


def scratch() -> Path:
    p = Path(os.environ.get('WD_SCRATCH', os.environ.get('TEMP', '/tmp'))) / 'wd-vehicles'
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------------------------- preview


def preview(groups, path: Path, cam_loc, target, lens=40, res=(960, 540), samples=12):
    """Quick Cycles clay/material check of the procedural hi + low side by side."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = 'JPEG'
    world = bpy.data.worlds.new('pw')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    hdr = RAW / 'polyhaven/hdri/palermo_square_2k.hdr'
    if hdr.exists():
        env = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
        env.image = bpy.data.images.load(str(hdr))
        world.node_tree.links.new(env.outputs[0], bg.inputs[0])
    sc.world = world
    ground = vb.box('ground', (0, -0.05, 0), (60, 0.1, 60), vm.plain('ground', 0x6b6a66, rough=0.9))
    del ground
    cam = bpy.data.cameras.new('cam')
    cam.lens = lens
    co = bpy.data.objects.new('cam', cam)
    bpy.context.scene.collection.objects.link(co)
    co.location = vb.C @ Vector(cam_loc)
    d = (vb.C @ Vector(target)) - co.location
    co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = co
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main(argv):
    vm.SOURCES = SOURCES
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='truck')
    ap.add_argument('--size', type=int, default=2048)
    ap.add_argument('--preview', action='store_true')
    a = ap.parse_args(argv)
    for mid in a.only.split(','):
        if mid in ('truck', 'truck_destroyed'):
            if a.preview:
                g = build_truck(mid == 'truck_destroyed', a.size, preview=True)
                g = {k: vb.apply_all(v) for k, v in g.items()}
                # Low on the left, hi copy offset to the right (game +X is left: shift hi to -X).
                for o in g['hi']:
                    o.matrix_world = Matrix.Translation(vb.C @ Vector((-3.0, 0, 0))) @ o.matrix_world
                for o in g['low']:
                    o.matrix_world = Matrix.Translation(vb.C @ Vector((3.0, 0, 0))) @ o.matrix_world
                prev = scratch() / 'preview'
                prev.mkdir(exist_ok=True)
                preview(g, prev / f'{mid}_front.jpg', (6.5, 3.2, 9.0), (0, 0.9, 0))
                preview(g, prev / f'{mid}_rear.jpg', (-7.0, 3.6, -8.0), (0, 0.9, 0))
            else:
                build_truck(mid == 'truck_destroyed', a.size)
        else:
            if a.preview:
                g = build_static(mid, a.size, preview_only=True)
                for o in g['hi']:
                    o.matrix_world = Matrix.Translation(vb.C @ Vector((0, 0, -9.0))) @ o.matrix_world
                prev = scratch() / 'preview'
                prev.mkdir(exist_ok=True)
                preview(g, prev / f'{mid}_a.jpg', (-9.0, 6.5, 12.0), (0, 0.9, -4.5), lens=32)
                preview(g, prev / f'{mid}_b.jpg', (12.0, 7.0, -14.0), (0, 0.9, -4.5), lens=32)
            else:
                build_static(mid, a.size)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    main(argv)
