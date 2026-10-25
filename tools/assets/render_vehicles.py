"""Review renders of the built vehicles (what ships: the low mesh + baked maps, imported from the
exported glTF). Blender only; CPU Cycles, no GPU needed.

    blender -b --python tools/assets/render_vehicles.py -- --models truck,truck_destroyed \
        --out DIR [--samples 96] [--far] [--shots front,rear,side,detail] [--shipped [--low]]

Lighting is the repo's CC0 Poly Haven HDRI (`palermo_square`, the game's sunny sky) over a CC0
asphalt ground; AgX view transform like the game.
"""

import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ROOT = HERE.parents[1]
RAW = Path(os.environ.get('WD_RAW_ROOT', ROOT)) / 'tools/assets/raw'
BUILD = Path(os.environ['WD_VEH_BUILD']) if os.environ.get('WD_VEH_BUILD') else ROOT / 'tools/assets/build/vehicles'

# Game-space framing per model: front direction, the close-up target and its view direction.
SHOTS = {
    'truck': {'front': (0, 0, 1), 'detail': ((0.88, 0.75, 1.75), (1.0, 0.25, 0.9), 2.4), 'extra': {'bed': ((0.6, 1.3, -1.6), (1.2, 0.9, -0.9), 3.0), 'tyre': ((0.95, 0.4, 1.55), (1.0, 0.25, 0.35), 1.6), 'cab': ((0.9, 1.6, 0.4), (1.0, 0.35, 0.8), 2.6)}},
    'truck_destroyed': {'front': (0, 0, 1), 'detail': ((0.6, 1.3, -0.9), (1.0, 0.9, -0.5), 3.2)},
    'truck_wreck': {'front': (0, 0, 1), 'detail': ((0.6, 1.3, -0.9), (1.0, 0.9, -0.5), 3.2), 'extra': {'bed': ((0.6, 1.3, -1.6), (1.2, 0.9, -0.9), 3.0), 'tyre': ((0.95, 0.4, 1.55), (1.0, 0.25, 0.35), 1.6), 'cab': ((0.9, 1.6, 0.4), (1.0, 0.35, 0.8), 2.6)}},
    'heli_wreck': {'front': (-1, 0, 0), 'detail': ((-3.4, 1.2, -0.6), (-0.9, 0.35, -1.0), 4.0)},
    'tank_wreck': {'front': (-1, 0, 0), 'detail': ((-1.2, 1.4, -1.5), (-0.6, 0.45, -1.0), 4.2)},
    'armoured_wreck': {'front': (1, 0, 0), 'detail': ((0.0, 1.25, 0.9), (0.25, 0.2, 1.0), 3.6)},
}


def g2b(v):
    return Vector((v[0], -v[2], v[1]))


def setup_scene(samples, hdri='palermo_square', sun_rot=0.0):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = 90
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes['Background']
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    p = RAW / f'polyhaven/hdri/{hdri}_2k.hdr'
    if p.exists():
        env.image = bpy.data.images.load(str(p))
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Rotation'].default_value = (0, 0, math.radians(sun_rot))
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(tc.outputs['Generated'], mp.inputs['Vector'])
    nt.links.new(mp.outputs[0], env.inputs['Vector'])
    nt.links.new(env.outputs[0], bg.inputs[0])
    bg.inputs['Strength'].default_value = 0.8
    sc.world = w
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.2
    sun.angle = math.radians(1.5)
    sun.color = (1.0, 0.95, 0.88)
    so = bpy.data.objects.new('sun', sun)
    so.rotation_euler = (math.radians(48), 0, math.radians(sun_rot + 145))
    sc.collection.objects.link(so)
    ground()


def ground():
    me = bpy.data.meshes.new('ground')
    s = 40
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    me.uv_layers.new()
    for i, uv in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        me.uv_layers[0].data[i].uv = (uv[0] * s / 2.5, uv[1] * s / 2.5)
    o = bpy.data.objects.new('ground', me)
    bpy.context.scene.collection.objects.link(o)
    mat = bpy.data.materials.new('asphalt')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    base = RAW / 'polyhaven/textures/asphalt_02/asphalt_02'
    if Path(f'{base}_diffuse_2k.jpg').exists():
        def tex(suffix, data):
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = bpy.data.images.load(f'{base}_{suffix}_2k.jpg')
            if data:
                t.image.colorspace_settings.name = 'Non-Color'
            return t
        d = tex('diffuse', False)
        r = tex('rough', True)
        n = tex('nor_gl', True)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(n.outputs[0], nm.inputs['Color'])
        hsv = nt.nodes.new('ShaderNodeHueSaturation')
        hsv.inputs['Value'].default_value = 0.8
        hsv.inputs['Saturation'].default_value = 0.6
        nt.links.new(d.outputs[0], hsv.inputs['Color'])
        nt.links.new(hsv.outputs[0], bsdf.inputs['Base Color'])
        nt.links.new(r.outputs[0], bsdf.inputs['Roughness'])
        nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
    me.materials.append(mat)


def load(mid, far=False, shipped=False, low=False):
    path = BUILD / mid / f'{mid}{"_far" if far else ""}.gltf'
    if shipped:
        from raw_models import MODELS, raw_model
        path = raw_model(MODELS / f'vehicles/{mid}{"_far" if far else ""}.gltf')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    objs = [o for o in bpy.data.objects if o not in before]
    if shipped:
        import vehicle_mats as vm
        images = []
        for kind in ('albedo', 'arm', 'normal'):
            image = bpy.data.images.load(str(MODELS / f'vehicles/{mid}_{kind}{"_low" if low else ""}.webp'))
            if kind != 'albedo':
                image.colorspace_settings.name = 'Non-Color'
            images.append(image)
        material = vm.textured(mid, *images)
        for obj in objs:
            if obj.type == 'MESH':
                obj.data.materials.clear()
                obj.data.materials.append(material)
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != 'MESH':
            continue
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return objs, lo, hi


def camera(loc, target, lens=50):
    cam = bpy.data.cameras.new('cam')
    cam.lens = lens
    cam.sensor_width = 36
    o = bpy.data.objects.new('cam', cam)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (target - loc).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = o
    return o


def shot_cams(mid, lo, hi):
    """Camera (location, target, lens) per shot in Blender coords."""
    spec = SHOTS[mid]
    f = g2b(spec['front'])
    f.z = 0
    f.normalize()
    side = Vector((-f.y, f.x, 0))  # left of the front direction
    hi = Vector((hi.x, hi.y, min(hi.z, lo.z + 3.0)))
    c = (lo + hi) / 2
    size = (hi - lo).length
    tgt = Vector((c.x, c.y, lo.z + (hi.z - lo.z) * 0.42))
    d = size * 1.25
    cams = {
        'front': (tgt + (f * 0.78 + side * 0.62).normalized() * d + Vector((0, 0, size * 0.22)), tgt, 50),
        'rear': (tgt + (-f * 0.75 - side * 0.66).normalized() * d + Vector((0, 0, size * 0.25)), tgt, 50),
        'side': (tgt + side * d * 1.05 + Vector((0, 0, size * 0.08)), tgt, 50),
    }
    dt, ddir, dist = spec['detail']
    t = g2b(dt)
    cams['detail'] = (t + g2b(ddir).normalized() * dist, t, 50)
    for name, (dt, ddir, dist) in spec.get('extra', {}).items():
        t = g2b(dt)
        cams[name] = (t + g2b(ddir).normalized() * dist, t, 50)
    return cams


def collision_overlay(kind, boxes_json=None):
    """The shipped collision boxes (wreck_rays.collision_boxes: heli_collision.py for the
    helicopter, vehicle_spec.WRECK_BOXES for the tank — what props.ts holds), or a JSON list of
    {c, s, rot}, as red wireframes, game coords → Blender."""
    from mathutils import Matrix
    sys.path.insert(0, str(HERE))
    from heli_collision import box_matrix
    from wreck_rays import collision_boxes
    boxes = json.loads(Path(boxes_json).read_text()) if boxes_json else collision_boxes(kind)
    mat = bpy.data.materials.new('collision')
    mat.use_nodes = True
    nt = mat.node_tree
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (1.0, 0.05, 0.02, 1)
    em.inputs['Strength'].default_value = 4.0
    nt.links.new(em.outputs[0], nt.nodes['Material Output'].inputs[0])
    C = Matrix.Rotation(math.radians(90), 4, 'X')
    for i, b in enumerate(boxes):
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        o = bpy.context.active_object
        o.name = f'col_{i}'
        # The game's Euler XYZ is three.js's (Rx·Ry·Rz); mathutils' 'XYZ' is Rz·Ry·Rx.
        o.matrix_world = C @ Matrix(box_matrix(b['c'], b['s'], b.get('rot')).tolist())
        w = o.modifiers.new('w', 'WIREFRAME')
        w.thickness = 0.03
        w.use_relative_offset = False
        o.data.materials.append(mat)


def fit_views(mid, out: Path, lo, hi, far=False):
    """Orthographic side + top + front views (collision overlay check)."""
    c = (lo + hi) / 2
    size = max((hi - lo).x, (hi - lo).y, (hi - lo).z) * 1.15
    sc = bpy.context.scene
    for name, d, up in (('side', Vector((0, -1, 0)), 'Y'), ('top', Vector((0, 0, 1)), 'Y'), ('front', Vector((-1, 0, 0)), 'Y')):
        cam = bpy.data.cameras.new('o')
        cam.type = 'ORTHO'
        cam.ortho_scale = size
        o = bpy.data.objects.new('o', cam)
        sc.collection.objects.link(o)
        o.location = c + d * 60
        o.rotation_euler = (-d).to_track_quat('-Z', 'Z' if name != 'top' else 'Y').to_euler()
        sc.camera = o
        sc.render.filepath = str(out / f'{mid}_fit_{name}.jpg')
        bpy.ops.render.render(write_still=True)


def main(argv):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default='truck')
    ap.add_argument('--out', required=True)
    ap.add_argument('--samples', type=int, default=96)
    ap.add_argument('--far', action='store_true')
    ap.add_argument('--shipped', action='store_true', help='review packaged static glTF and compressed WebP maps')
    ap.add_argument('--low', action='store_true', help='512 px shipped maps (offline AgX lighting, not the Low renderer)')
    ap.add_argument('--shots', default='front,rear,side,detail')
    ap.add_argument('--hdri', default='palermo_square')
    ap.add_argument('--sun', type=float, default=0.0)
    ap.add_argument('--boxes', default='', help='overlay collision boxes: heli | tank | path to a JSON list')
    ap.add_argument('--fit', action='store_true', help='orthographic side/top/front fit views only')
    a = ap.parse_args(argv)
    if a.low and not a.shipped:
        ap.error('--low requires --shipped')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for mid in a.models.split(','):
        setup_scene(a.samples, a.hdri, a.sun)
        objs, lo, hi = load(mid, a.far, a.shipped, a.low)
        if a.boxes:
            collision_overlay(a.boxes if a.boxes in ('heli', 'tank') else None, a.boxes if a.boxes not in ('heli', 'tank') else None)
        if a.fit:
            fit_views(mid, out, lo, hi)
            continue
        for name, (loc, tgt, lens) in shot_cams(mid, lo, hi).items():
            if name not in a.shots.split(','):
                continue
            camera(loc, tgt, lens)
            bpy.context.scene.render.filepath = str(out / f'{mid}{"_far" if a.far else ""}{"_low" if a.low else ""}_{name}.jpg')
            bpy.ops.render.render(write_still=True)
            print('RENDERED', bpy.context.scene.render.filepath, flush=True)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
