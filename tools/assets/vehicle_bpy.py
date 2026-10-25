"""Blender helpers for the vehicle builders (tools/assets/build_vehicles.py). Blender only.

Geometry is authored in *game* coordinates (three.js / glTF: +Y up, metres) and every object gets
the matrix C = Rx(+90°) on top, so Blender sees its usual Z-up world and the glTF exporter's +Y-up
conversion hands the game back exactly the authored numbers.

Each model is built twice from the same code: `hi` (more bevel segments, bolts, seams, tread
blocks: the bake source) and low (chamfers + weighted normals: what ships). Materials are
procedural Cycles node graphs; `bake_model` bakes them from hi onto the low mesh's UVs.
"""

import math
from pathlib import Path
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

C = Matrix.Rotation(math.radians(90), 4, 'X')
"""Game (Y-up) → Blender (Z-up)."""


def game_matrix(c=(0, 0, 0), rot=None, order='XYZ') -> Matrix:
    """World matrix of a part at game-space centre `c` with Euler `rot` (degrees, three.js XYZ)."""
    m = Matrix.Translation(Vector(c))
    if rot is not None:
        m = m @ Euler([math.radians(a) for a in rot], order).to_matrix().to_4x4()
    return C @ m


# ---------------------------------------------------------------------------------------- scene


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.objects):
        for block in list(coll):
            coll.remove(block)


def collection(name: str) -> bpy.types.Collection:
    coll = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if coll.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(coll)
    return coll


_TARGET = {'coll': None}


def into(coll_name: str) -> None:
    """New parts go into this collection."""
    _TARGET['coll'] = collection(coll_name)


def _link(obj):
    (_TARGET['coll'] or bpy.context.scene.collection).objects.link(obj)
    return obj


# ---------------------------------------------------------------------------------------- parts


def _obj_from_bm(name: str, bm: bmesh.types.BMesh, mat, matrix: Matrix, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if mat is not None:
        me.materials.append(mat)
    if smooth:
        me.shade_smooth()
    obj = bpy.data.objects.new(name, me)
    obj.matrix_world = matrix
    return _link(obj)


def bevel(obj, width: float, segs: int = 1, angle: float = 35.0, harden=True, limit='ANGLE'):
    if width <= 0:
        return obj
    me = obj.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(angle))
    m = obj.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segs
    m.limit_method = limit
    m.angle_limit = math.radians(angle)
    m.harden_normals = harden
    m.miter_outer = 'MITER_ARC' if segs > 1 else 'MITER_SHARP'
    m.use_clamp_overlap = True
    return obj


def box(name, c, s, mat, rot=None, bev=0.0, segs=1, taper=None):
    """Box of size s centred at c. `taper` = (dx_top, dz_top): the top face shrinks by these."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        x, y, z = v.co
        if taper and y > 0:
            x *= 1 - taper[0] / max(s[0], 1e-6)
            z *= 1 - taper[1] / max(s[2], 1e-6)
        v.co = Vector((x * s[0], y * s[1], z * s[2]))
    obj = _obj_from_bm(name, bm, mat, game_matrix(c, rot))
    return bevel(obj, bev, segs)


def prism(name, profile, width, mat, axis='x', c=(0, 0, 0), rot=None, bev=0.0, segs=1, angle=35.0):
    """Extrude a closed 2D profile. axis 'x': profile in (z, y), extruded along x (side views);
    axis 'z': profile in (x, y) along z (front views); axis 'y': profile in (x, z) along y (plans)."""
    bm = bmesh.new()
    h = width / 2
    def p3(u, v, w):
        if axis == 'x':
            return Vector((w, v, u))
        if axis == 'z':
            return Vector((u, v, w))
        return Vector((u, w, v))
    a = [bm.verts.new(p3(u, v, -h)) for u, v in profile]
    b = [bm.verts.new(p3(u, v, h)) for u, v in profile]
    n = len(profile)
    f0 = bm.faces.new(a[::-1])
    f1 = bm.faces.new(b)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = _obj_from_bm(name, bm, mat, game_matrix(c, rot))
    return bevel(obj, bev, segs, angle)


def cyl(name, c, r, depth, mat, axis='x', segs=24, rot=None, bev=0.0, bsegs=1, r2=None, cap=True):
    """Cylinder (or cone with r2) along a game axis."""
    bm = bmesh.new()
    r2 = r if r2 is None else r2
    ring0, ring1 = [], []
    for i in range(segs):
        t = 2 * math.pi * i / segs
        ca, sa = math.cos(t), math.sin(t)
        for ring, rr, w in ((ring0, r, -depth / 2), (ring1, r2, depth / 2)):
            if axis == 'x':
                p = (w, ca * rr, sa * rr)
            elif axis == 'y':
                p = (ca * rr, w, sa * rr)
            else:
                p = (ca * rr, sa * rr, w)
            ring.append(bm.verts.new(p))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new((ring0[i], ring0[j], ring1[j], ring1[i]))
    if cap:
        bm.faces.new(ring0[::-1])
        bm.faces.new(ring1)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = _obj_from_bm(name, bm, mat, game_matrix(c, rot))
    obj.data.shade_smooth()
    obj.data.set_sharp_from_angle(angle=math.radians(35))
    return bevel(obj, bev, bsegs) if bev else obj


def lathe(name, profile, mat, c=(0, 0, 0), segs=32, rot=None, axis='x', angle=40.0):
    """Revolve a profile of (radius, offset-along-axis) points (open polyline) about a game axis."""
    bm = bmesh.new()
    rings = []
    for i in range(segs):
        t = 2 * math.pi * i / segs
        ca, sa = math.cos(t), math.sin(t)
        ring = []
        for rr, w in profile:
            if axis == 'x':
                p = (w, ca * rr, sa * rr)
            elif axis == 'y':
                p = (ca * rr, w, sa * rr)
            else:
                p = (ca * rr, sa * rr, w)
            ring.append(bm.verts.new(p))
        rings.append(ring)
    n = len(profile)
    for i in range(segs):
        j = (i + 1) % segs
        for k in range(n - 1):
            bm.faces.new((rings[i][k], rings[j][k], rings[j][k + 1], rings[i][k + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = _obj_from_bm(name, bm, mat, game_matrix(c, rot))
    obj.data.shade_smooth()
    obj.data.set_sharp_from_angle(angle=math.radians(angle))
    return obj


def tube(name, pts, r, mat, segs=10, closed=False, cap=True):
    """Bent tube through game-space points (bull bars, roll bars, skids, cables)."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = r
    cu.bevel_resolution = max(1, segs // 4 - 1)
    cu.use_fill_caps = cap
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for p, q in zip(sp.points, pts):
        p.co = (*q, 1.0)
    sp.use_cyclic_u = closed
    tmp = bpy.data.objects.new(name + '_c', cu)
    _link(tmp)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp)
    bpy.data.curves.remove(cu)
    if mat is not None:
        me.materials.clear()
        me.materials.append(mat)
    me.shade_smooth()
    obj = bpy.data.objects.new(name, me)
    obj.matrix_world = C
    return _link(obj)


def mesh_from(name, verts, faces, mat, matrix=None, smooth=False):
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in verts]
    for f in faces:
        try:
            bm.faces.new([vs[i] for i in f])
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _obj_from_bm(name, bm, mat, matrix if matrix is not None else C, smooth)


def solidify(obj, t, offset=-1.0):
    m = obj.modifiers.new('solid', 'SOLIDIFY')
    m.thickness = t
    m.offset = offset
    m.use_even_offset = True
    return obj


def displace_noise(obj, strength, scale=0.6, seed=0):
    """Dents / crumple (wrecks): a cloud-texture displacement before the bevel."""
    tex = bpy.data.textures.new(f'{obj.name}_dent', 'CLOUDS')
    tex.noise_scale = scale
    tex.noise_depth = 2
    m = obj.modifiers.new('dent', 'DISPLACE')
    m.texture = tex
    m.strength = strength
    m.mid_level = 0.5
    m.texture_coords = 'GLOBAL'
    obj.modifiers.move(len(obj.modifiers) - 1, 0)
    random.seed(seed)
    return obj


def subdivide(obj, cuts=2):
    """Simple subdivision (for displacement on flat panels), placed first in the stack."""
    m = obj.modifiers.new('subd', 'SUBSURF')
    m.subdivision_type = 'SIMPLE'
    m.levels = cuts
    m.render_levels = cuts
    obj.modifiers.move(len(obj.modifiers) - 1, 0)
    return obj


def apply_all(objs):
    """Bake modifiers + matrices into world-space mesh data (Blender coords)."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in objs:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        me.transform(o.matrix_world)
        name = o.name
        coll = o.users_collection[0] if o.users_collection else bpy.context.scene.collection
        bpy.data.objects.remove(o)
        n = bpy.data.objects.new(name, me)
        coll.objects.link(n)
        out.append(n)
    return out


def join(objs, name):
    """Join objects (modifiers applied) into one world-space mesh object."""
    objs = apply_all(objs)
    bm = bmesh.new()
    mats = []
    for o in objs:
        me = o.data
        remap = []
        for m in me.materials:
            if m not in mats:
                mats.append(m)
            remap.append(mats.index(m))
        tmp = bmesh.new()
        tmp.from_mesh(me)
        for f in tmp.faces:
            f.material_index = remap[f.material_index] if remap else 0
        tmp_me = bpy.data.meshes.new('tmp')
        tmp.to_mesh(tmp_me)
        tmp.free()
        bm.from_mesh(tmp_me)
        bpy.data.meshes.remove(tmp_me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    coll = objs[0].users_collection[0]
    # Custom split normals do not survive bmesh: recompute per-face sharpness from the angle.
    for o in objs:
        bpy.data.objects.remove(o)
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    return obj


def join_keep_normals(objs, name):
    """Join with custom normals (weighted/hardened) kept: uses the join operator."""
    objs = apply_all(objs)
    with bpy.context.temp_override(
        active_object=objs[0], selected_editable_objects=objs, selected_objects=objs, object=objs[0]
    ):
        bpy.ops.object.join()
    o = objs[0]
    o.name = name
    o.data.name = name
    return o


def weighted_normals(obj):
    m = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
    m.keep_sharp = True
    m.weight = 50
    return obj


def tri_count(obj) -> int:
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---------------------------------------------------------------------------------------- uv


def shrink_small_parts(obj, area=0.02, factor=0.3):
    """Scale down the UVs of every small detached part (bolts, handles, lug nuts, debris): a
    decimated model is thousands of them, and packed at full texel density with a margin each
    they took most of the atlas while the big panels got a corner of it. Returns the count."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uvl = bm.loops.layers.uv.active
    seen, n = set(), 0
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        comp, stack = [], [f0]
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            comp.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        a = sum(f.calc_area() for f in comp)
        if a >= area:
            continue
        loops = [lp for f in comp for lp in f.loops]
        cu = sum(lp[uvl].uv.x for lp in loops) / len(loops)
        cv = sum(lp[uvl].uv.y for lp in loops) / len(loops)
        k = max(factor, (a / area) ** 0.5 * factor * 2) if a > 0 else factor
        k = min(k, 1.0)
        for lp in loops:
            uv = lp[uvl].uv
            uv.x = cu + (uv.x - cu) * k
            uv.y = cv + (uv.y - cv) * k
        n += 1
    bm.to_mesh(obj.data)
    bm.free()
    return n


def smart_uv(obj, margin=0.003, angle=50.0, small_area=None):
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.view_layer.objects:
        o.select_set(o == obj)
    with bpy.context.temp_override(active_object=obj, object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        if small_area:
            bpy.ops.object.mode_set(mode='OBJECT')
            print('UV: shrank', shrink_small_parts(obj, small_area), 'small parts', flush=True)
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.pack_islands(margin=margin, rotate=True, shape_method='CONCAVE')
        bpy.ops.object.mode_set(mode='OBJECT')


def decimate(obj, target_tris: int):
    """Collapse decimation to a triangle budget (UVs kept), applied."""
    n = tri_count(obj)
    if n <= target_tris:
        return obj
    m = obj.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = target_tris / n
    m.use_collapse_triangulate = True
    if not obj.users_collection:
        bpy.context.scene.collection.objects.link(obj)
    out = apply_all([obj])[0]
    print('decimate', n, '->', tri_count(out), flush=True)
    return out


def triangulate(obj):
    m = obj.modifiers.new('tri', 'TRIANGULATE')
    m.keep_custom_normals = True
    return apply_all([obj])[0]


# ---------------------------------------------------------------------------------------- materials


class N:
    """Tiny node-graph builder."""

    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nodes = self.nt.nodes
        self.links = self.nt.links

    def __call__(self, kind, **props):
        n = self.nodes.new(kind)
        for k, v in props.items():
            if k.startswith('in_'):
                key = k[3:]
                key = int(key) if key.isdigit() else key.replace('_', ' ')
                n.inputs[key].default_value = v
            else:
                setattr(n, k, v)
        return n

    def link(self, a, b):
        self.links.new(a, b)
        return b

    def math(self, op, a, b=None, clamp=False):
        n = self('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        n = self('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=True)
        for sock, v in ((n.inputs[0], fac), (n.inputs[6], a), (n.inputs[7], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            elif isinstance(v, tuple):
                sock.default_value = (*v, 1.0) if len(v) == 3 else v
            else:
                self.link(v, sock)
        return n.outputs[2]

    def mixf(self, fac, a, b):
        n = self('ShaderNodeMix', data_type='FLOAT', clamp_factor=True)
        for sock, v in ((n.inputs[0], fac), (n.inputs[2], a), (n.inputs[3], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            else:
                self.link(v, sock)
        return n.outputs[0]

    def ramp(self, inp, stops, interp='LINEAR'):
        n = self('ShaderNodeValToRGB')
        cr = n.color_ramp
        cr.interpolation = interp
        while len(cr.elements) > len(stops):
            cr.elements.remove(cr.elements[-1])
        while len(cr.elements) < len(stops):
            cr.elements.new(0.5)
        for el, (pos, col) in zip(cr.elements, stops):
            el.position = pos
            el.color = (*col, 1.0) if isinstance(col, tuple) and len(col) == 3 else (
                (col, col, col, 1.0) if isinstance(col, (int, float)) else col)
        self.link(inp, n.inputs[0])
        return n.outputs[0]

    def noise(self, scale, detail=6.0, rough=0.6, coord=None, dist=0.0, w=None):
        n = self('ShaderNodeTexNoise', noise_dimensions='4D' if w is not None else '3D')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        n.inputs['Distortion'].default_value = dist
        if w is not None:
            n.inputs['W'].default_value = w
        if coord is not None:
            self.link(coord, n.inputs['Vector'])
        return n

    def voronoi(self, scale, coord=None, feature='F1', rand=1.0):
        n = self('ShaderNodeTexVoronoi', feature=feature)
        n.inputs['Scale'].default_value = scale
        n.inputs['Randomness'].default_value = rand
        if coord is not None:
            self.link(coord, n.inputs['Vector'])
        return n


def principled(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    g = N(mat)
    out = g('ShaderNodeOutputMaterial')
    bsdf = g('ShaderNodeBsdfPrincipled')
    g.link(bsdf.outputs[0], out.inputs[0])
    mat['bsdf'] = bsdf.name
    mat['out'] = out.name
    return mat, g, bsdf


def edge_mask(g, radius=0.012, samples=8):
    """1 on rounded edges (bevel normal ≠ true normal), 0 on flats."""
    bev = g('ShaderNodeBevel', samples=samples)
    bev.inputs['Radius'].default_value = radius
    geo = g('ShaderNodeNewGeometry')
    dot = g('ShaderNodeVectorMath', operation='DOT_PRODUCT')
    g.link(bev.outputs[0], dot.inputs[0])
    g.link(geo.outputs['Normal'], dot.inputs[1])
    e = g.math('SUBTRACT', 1.0, dot.outputs['Value'])
    return g.math('MULTIPLY', e, 18.0, clamp=True), bev


def cavity_mask(g, dist=0.25):
    """1 in crevices (ambient occlusion), 0 in the open."""
    ao = g('ShaderNodeAmbientOcclusion', samples=8, only_local=True)
    ao.inputs['Distance'].default_value = dist
    return g.math('SUBTRACT', 1.0, ao.outputs['AO'], clamp=True)


def world_coords(g):
    return g('ShaderNodeNewGeometry').outputs['Position']


def height(g):
    """Height above the ground in metres (Blender world Z = game Y)."""
    sep = g('ShaderNodeSeparateXYZ')
    g.link(world_coords(g), sep.inputs[0])
    return sep.outputs['Z']


def up_facing(g):
    sep = g('ShaderNodeSeparateXYZ')
    g.link(g('ShaderNodeNewGeometry').outputs['Normal'], sep.inputs[0])
    return sep.outputs['Z']


def image_box(g, path, scale=1.0, noncolor=True, blend=0.25):
    """Box-projected image (object-independent world coords) — CC0 scan detail as a grunge input."""
    img = bpy.data.images.load(path, check_existing=True)
    if noncolor:
        img.colorspace_settings.name = 'Non-Color'
    t = g('ShaderNodeTexImage', projection='BOX', projection_blend=blend)
    t.image = img
    mp = g('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (scale, scale, scale)
    g.link(world_coords(g), mp.inputs['Vector'])
    g.link(mp.outputs[0], t.inputs['Vector'])
    return t


def set_bsdf(g, bsdf, color=None, rough=None, metal=None, normal=None):
    for key, v in (('Base Color', color), ('Roughness', rough), ('Metallic', metal), ('Normal', normal)):
        if v is None:
            continue
        sock = bsdf.inputs[key]
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, tuple):
            sock.default_value = (*v, 1.0) if len(v) == 3 else v
        else:
            g.link(v, sock)


def bump(g, height_sock, strength=0.3, dist=0.01, normal=None):
    b = g('ShaderNodeBump')
    b.inputs['Strength'].default_value = strength
    b.inputs['Distance'].default_value = dist
    g.link(height_sock, b.inputs['Height'])
    if normal is not None:
        g.link(normal, b.inputs['Normal'])
    return b.outputs[0]


def srgb(h: int):
    """sRGB hex → linear tuple."""
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin((h >> 16) & 255), lin((h >> 8) & 255), lin(h & 255))


# ---------------------------------------------------------------------------------------- bake


def _bake_target(low, img):
    for m in low.data.materials:
        g = m.node_tree
        node = g.nodes.get('__bake__')
        if node is None:
            node = g.nodes.new('ShaderNodeTexImage')
            node.name = '__bake__'
        node.image = img
        g.nodes.active = node
        node.select = True


def bake_pass(low, his, kind, img, extrusion=0.04, ray=0.12, samples=16, margin=8):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.render.bake.use_selected_to_active = bool(his)
    sc.render.bake.cage_extrusion = extrusion
    sc.render.bake.max_ray_distance = ray
    sc.render.bake.margin = margin
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.target = 'IMAGE_TEXTURES'
    _bake_target(low, img)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for h in his:
        h.hide_render = False
        h.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    kw = {}
    if kind == 'DIFFUSE':
        sc.render.bake.use_pass_direct = False
        sc.render.bake.use_pass_indirect = False
        sc.render.bake.use_pass_color = True
    if kind == 'NORMAL':
        sc.render.bake.normal_space = 'TANGENT'
    with bpy.context.temp_override(active_object=low, object=low,
                                   selected_objects=[low, *his], selected_editable_objects=[low, *his]):
        bpy.ops.object.bake(type=kind, **kw)


def route_emission(mats, socket_name):
    """For a bake of a non-bakeable input (metallic): send that input into an Emission shader."""
    saved = []
    for m in mats:
        g = N(m)
        bsdf = m.node_tree.nodes[m['bsdf']]
        out = m.node_tree.nodes[m['out']]
        em = g('ShaderNodeEmission')
        src = bsdf.inputs[socket_name]
        if src.is_linked:
            g.link(src.links[0].from_socket, em.inputs['Color'])
        else:
            v = src.default_value
            em.inputs['Color'].default_value = (v, v, v, 1.0)
        g.link(em.outputs[0], out.inputs[0])
        saved.append((m, em))
    return saved


def restore_bsdf(saved):
    for m, em in saved:
        bsdf = m.node_tree.nodes[m['bsdf']]
        out = m.node_tree.nodes[m['out']]
        m.node_tree.links.new(bsdf.outputs[0], out.inputs[0])
        m.node_tree.nodes.remove(em)


def new_image(name, size, alpha=False, data=True):
    img = bpy.data.images.new(name, size, size, alpha=alpha, float_buffer=False)
    if data:
        img.colorspace_settings.name = 'Non-Color'
    return img


def save_png(img, path):
    # Replace, never reuse: saving over an existing PNG left the old pixels in place (a re-bake
    # into a used build dir kept the previous bake's maps, mismatched to the new UVs).
    Path(path).unlink(missing_ok=True)
    img.filepath_raw = str(path)
    img.file_format = 'PNG'
    img.save()
