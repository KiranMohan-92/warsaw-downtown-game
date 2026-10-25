"""Build the jetpack (original near-future twin-thruster backpack; Blender + system Python).

    blender -b --python tools/assets/build_jetpack.py -- model    # low + hi meshes, UVs, bakes
    python tools/assets/build_jetpack.py package                  # glTF + WebP -> models/jetpack
    blender -b --python tools/assets/build_jetpack.py -- render   # beauty renders for review

A compact hard-shell backpack: a contoured back plate, a bevelled graphite housing with an intake
hump and vent slots, a central fuel cell behind armoured ribs with two cyan status rings, and two
thruster pods on short arms either side, each ending in a heat-blued nozzle bell with a sooty
throat; webbing straps on the plate, cyan edge lights on the housing. No text, logos or emblems.

Pack space (= the glTF's own): origin at the middle of the back plate's face (where it rests on
the wearer's back), +Y up, the wearer faces -Z (so the pack extends toward +Z), metres. Anchors
(glTF empty nodes, also in jetpack.json): `jetpack_nozzle_l` / `_r` (the centre of each nozzle
exit, where the exhaust starts; exhaust points -Y), `jetpack_top` (the top of the housing).

Textures: the hi-poly carries per-part Blender materials built from the healed Codex texture
library (WD_TEXPREP: paint_darkgrey, bed_plating, burnt_metal, cast_armor, canvas_tarp + their
height maps, box-projected in object space with bump, edge wear and a heat gradient on the
bells); Cycles (CPU) bakes colour, roughness, metalness, emission, tangent normal (bump
included) and AO onto the low-poly's UVs at 2048. The package stage multiplies a little AO into
the albedo, packs AO/rough/metal into `arm` (R/G/B, the gun scans' recipe), downsamples to 1024
(shipped) and 512 (`_low`) and writes WebP. Intermediates go to WD_JETPACK_BUILD (default
tools/assets/build/jetpack, git-ignored).
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

try:
    import bpy
    import bmesh
    from mathutils import Matrix, Vector
except ImportError:  # package stage / tests (system Python)
    bpy = None

ROOT = Path(__file__).resolve().parents[2]
BUILD = Path(os.environ.get('WD_JETPACK_BUILD', ROOT / 'tools/assets/build/jetpack'))
TEXPREP = Path(os.environ.get('WD_TEXPREP', BUILD / 'texprep'))
OUT = ROOT / 'packages/client/public/models/jetpack'
REVIEW = Path(os.environ.get('WD_JETPACK_REVIEW', BUILD / 'review'))

TEX = 2048
SHIP = 1024
LOW = 512

# Parts (face attribute `part` on the low; one material per part on the hi).
SHELL, FRAME, METAL, STRAP, CELL, LIGHT, SOOT, BELL, ACCENT = range(9)
PARTS = 9

# Dimensions (pack space, metres): x right, y up, z back (away from the wearer).
PLATE = dict(w=0.30, h=0.44, d=0.03)
HOUSING = dict(w=0.235, h=0.37, d=0.12, z=0.085, y=0.02)
POD_X = 0.165
POD_Z = 0.095
POD_R = 0.048
POD_TOP = 0.13
POD_BOTTOM = -0.17
BELL_LEN = 0.075
BELL_R0 = 0.040
BELL_R1 = 0.061
CELL_R = 0.042
CELL_Z = 0.165

ANCHORS = {
    'jetpack_nozzle_l': (-POD_X, POD_BOTTOM - BELL_LEN, POD_Z),
    'jetpack_nozzle_r': (POD_X, POD_BOTTOM - BELL_LEN, POD_Z),
    'jetpack_top': (0.0, HOUSING['y'] + HOUSING['h'] / 2 + 0.05, HOUSING['z']),
}


def p2b(p):
    """Pack space (glTF, y up, +z back) -> Blender (z up; glTF export maps b(x,y,z) -> (x,z,-y))."""
    return (p[0], -p[2], p[1])


# ---------------------------------------------------------------------------------------------
# Geometry (Blender)


class Builder:
    """Adds parts to one bmesh, each face tagged with its part id."""

    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.part = self.bm.faces.layers.int.new('part')

    def _tag(self, geom, part: int) -> list:
        faces = [g for g in geom if isinstance(g, bmesh.types.BMFace)]
        for f in faces:
            f[self.part] = part
        return faces

    def box(self, c, size, part: int, taper: float = 1.0, round_: float = 0.0, seg: int = 2):
        """Box at pack-space centre `c`, `size` (w, h, d); `taper` scales its top face (x, z);
        `round_` rounds every edge (m, `seg` segments)."""
        bm = self.bm
        before = set(bm.faces)
        r = bmesh.ops.create_cube(bm, size=1.0)
        verts = r['verts']
        for v in verts:
            x, y, z = v.co.x, v.co.z, -v.co.y  # blender cube -> pack axes
            k = taper if y > 0 else 1.0
            px = c[0] + x * size[0] * k
            py = c[1] + y * size[1]
            pz = c[2] + z * size[2] * (k if taper != 1.0 else 1.0)
            v.co = Vector(p2b((px, py, pz)))
        cube_faces = list({f for v in verts for f in v.link_faces})
        if round_ > 0:
            edges = list({e for v in verts for e in v.link_edges})
            bmesh.ops.bevel(bm, geom=list(verts) + edges, offset=round_, segments=seg,
                            profile=0.5, affect='EDGES', clamp_overlap=True)
        # Every face this box made (bevel replaces the cube's own): tag them all.
        faces = [f for f in bm.faces if f not in before]
        for f in faces:
            f[self.part] = part
        return faces

    def cylinder(self, c, r: float, h: float, part: int, seg: int = 24, r_top=None, axis='y',
                 cap: bool = True, flip: bool = False):
        """Cylinder / frustum along pack `axis` centred at `c` (`flip`: faces look inward)."""
        bm = self.bm
        res = bmesh.ops.create_cone(
            bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r,
            radius2=r if r_top is None else r_top, depth=h,
        )
        if axis == 'y':
            m = Matrix.Translation(Vector(p2b(c)))
        elif axis == 'x':
            m = Matrix.Translation(Vector(p2b(c))) @ Matrix.Rotation(math.pi / 2, 4, 'Y')
        else:  # pack z = blender -y
            m = Matrix.Translation(Vector(p2b(c))) @ Matrix.Rotation(math.pi / 2, 4, 'X')
        bmesh.ops.transform(bm, matrix=m, verts=res['verts'])
        faces = list({f for v in res['verts'] for f in v.link_faces})
        if flip:
            bmesh.ops.reverse_faces(bm, faces=faces)
        for f in faces:
            f[self.part] = part
        return faces

    def finish(self, name: str):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        bm.normal_update()
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def build_pack(name: str, hi: bool):
    b = Builder()
    seg = 40 if hi else 18
    rs = 4 if hi else 1  # rounding segments (the housing keeps 2 on the low)
    P, H = PLATE, HOUSING
    top = H['y'] + H['h'] / 2
    # Back plate (frame): rounded, with webbing straps on its face and a lumbar pad.
    b.box((0, 0.0, P['d'] / 2), (P['w'], P['h'], P['d']), FRAME, round_=0.01, seg=rs)
    for sx in (-1, 1):
        b.box((sx * 0.085, 0.02, -0.004), (0.045, P['h'] * 0.96, 0.008), STRAP)
        # Shoulder clamps over the top edge.
        b.box((sx * 0.085, P['h'] / 2 + 0.012, 0.012), (0.05, 0.024, 0.05), FRAME, round_=0.006,
              seg=rs)
    b.box((0, -P['h'] / 2 + 0.05, -0.006), (0.18, 0.06, 0.012), STRAP)
    # Housing: a rounded, tapered hard shell.
    b.box((0, H['y'], H['z']), (H['w'], H['h'], H['d']), SHELL, taper=0.84, round_=0.03,
          seg=max(rs, 2))
    # Spine ridge down the back, intake hump with a cyan slit, vent slats.
    b.box((0, H['y'] - 0.01, H['z'] + H['d'] / 2 + 0.006), (0.05, H['h'] * 0.8, 0.02), SHELL,
          round_=0.008, seg=rs)
    b.box((0, top + 0.016, H['z'] + 0.004), (0.15, 0.045, 0.085), SHELL, taper=0.78, round_=0.014,
          seg=rs)
    b.box((0, top + 0.03, H['z'] + 0.047), (0.09, 0.008, 0.004), LIGHT)
    for i in range(5):
        b.box((0, top + 0.041, H['z'] - 0.028 + i * 0.013), (0.095, 0.005, 0.006), FRAME)
    for sx in (-1, 1):
        # Edge lights either side of the ridge.
        b.box((sx * 0.06, H['y'] - 0.03, H['z'] + H['d'] / 2 + 0.001), (0.006, H['h'] * 0.5, 0.005),
              LIGHT)
        # Panel seams (dark inset strips) and side grilles.
        b.box((sx * 0.092, H['y'], H['z'] + H['d'] / 2 - 0.004), (0.004, H['h'] * 0.7, 0.012), FRAME)
        for k in range(6):
            b.box((sx * (H['w'] / 2 + 0.001), H['y'] + 0.06 - k * 0.022, H['z'] + 0.01),
                  (0.008, 0.009, H['d'] * 0.55), FRAME)
        # Amber accent plates on the lower corners.
        b.box((sx * 0.085, H['y'] - H['h'] / 2 + 0.03, H['z'] + H['d'] / 2 - 0.004),
              (0.05, 0.03, 0.012), ACCENT, round_=0.004, seg=rs)
    # Fuel cell in a cradle on the ridge's lower half: armoured caps, two cyan status rings.
    cy = H['y'] - 0.03
    cz = CELL_Z + 0.02
    b.cylinder((0, cy, cz), CELL_R, 0.22, CELL, seg)
    for dy in (-0.105, 0.105):
        b.cylinder((0, cy + dy, cz), CELL_R * 0.92, 0.03, METAL, seg,
                   r_top=CELL_R * 0.6 if dy > 0 else CELL_R * 0.92)
    for dy in (-0.045, 0.045):
        b.cylinder((0, cy + dy, cz), CELL_R + 0.003, 0.01, LIGHT, seg)
    for dy in (-0.075, 0.0, 0.075):
        b.cylinder((0, cy + dy, cz), CELL_R + 0.005, 0.014, FRAME, seg)
    # Thruster pods: arms, segmented bodies, domed caps, accent bands, fins, bells.
    for sx in (-1, 1):
        x = sx * POD_X
        b.box((sx * 0.128, 0.06, POD_Z), (0.075, 0.05, 0.055), FRAME, round_=0.008, seg=rs)
        b.box((sx * 0.128, -0.10, POD_Z), (0.075, 0.04, 0.05), FRAME, round_=0.008, seg=rs)
        mid = (POD_TOP + POD_BOTTOM) / 2
        b.cylinder((x, mid, POD_Z), POD_R, POD_TOP - POD_BOTTOM, METAL, seg)
        for k in range(4):
            b.cylinder((x, POD_BOTTOM + 0.04 + k * 0.05, POD_Z), POD_R + 0.0025, 0.008, FRAME, seg)
        b.cylinder((x, POD_TOP + 0.012, POD_Z), POD_R * 0.95, 0.024, METAL, seg, r_top=POD_R * 0.7)
        b.cylinder((x, POD_TOP + 0.034, POD_Z), POD_R * 0.7, 0.02, METAL, seg, r_top=POD_R * 0.3)
        b.cylinder((x, POD_TOP - 0.028, POD_Z), POD_R + 0.004, 0.02, ACCENT, seg)
        b.cylinder((x, mid - 0.035, POD_Z), POD_R + 0.003, 0.008, LIGHT, seg)
        b.box((x + sx * (POD_R + 0.008), mid + 0.01, POD_Z), (0.016, 0.17, 0.012), FRAME,
              taper=0.55, round_=0.003, seg=rs)
        b.box((x, mid + 0.01, POD_Z + POD_R + 0.008), (0.012, 0.15, 0.016), FRAME, taper=0.55,
              round_=0.003, seg=rs)
        # Rivets round two bands, and two vertical panel seams.
        for ry in (POD_BOTTOM + 0.065, POD_TOP - 0.06):
            for k in range(8):
                a = (k + 0.5) / 8 * math.tau
                b.box((x + math.cos(a) * (POD_R + 0.002), ry, POD_Z + math.sin(a) * (POD_R + 0.002)),
                      (0.007, 0.007, 0.007), FRAME)
        for a in (0.9, math.pi + 0.9):
            b.box((x + math.cos(a) * (POD_R + 0.001), mid, POD_Z + math.sin(a) * (POD_R + 0.001)),
                  (0.004, POD_TOP - POD_BOTTOM - 0.04, 0.004), FRAME)
        b.cylinder((x, POD_BOTTOM - 0.006, POD_Z), POD_R * 0.86, 0.012, FRAME, seg)
        b.cylinder((x, POD_BOTTOM - BELL_LEN / 2 - 0.008, POD_Z), BELL_R1, BELL_LEN, BELL, seg,
                   r_top=BELL_R0, cap=False)
        # The throat: a dark inner cone visible from below.
        b.cylinder((x, POD_BOTTOM - BELL_LEN / 2 - 0.006, POD_Z), BELL_R1 * 0.9, BELL_LEN * 0.96,
                   SOOT, seg, r_top=BELL_R0 * 0.6, cap=False, flip=True)
        # The bell's lip: a flat ring closing the gap between the bell and its throat.
        lip = bmesh.ops.create_circle(b.bm, cap_ends=False, segments=seg, radius=BELL_R1)
        inner = bmesh.ops.create_circle(b.bm, cap_ends=False, segments=seg, radius=BELL_R1 * 0.9)
        y_lip = POD_BOTTOM - BELL_LEN - 0.008
        m = Matrix.Translation(Vector(p2b((x, y_lip, POD_Z))))
        bmesh.ops.transform(b.bm, matrix=m, verts=lip['verts'] + inner['verts'])
        ring = bmesh.ops.bridge_loops(
            b.bm, edges=list({e for v in lip['verts'] + inner['verts'] for e in v.link_edges}))
        for f in ring['faces']:
            f[b.part] = BELL
            f.normal_update()
        down = [f for f in ring['faces'] if f.normal.z > 0]  # the lip faces the ground
        if down:
            bmesh.ops.reverse_faces(b.bm, faces=down)
    ob = b.finish(name)
    bev = ob.modifiers.new('bevel', 'BEVEL')
    bev.width = 0.0045 if hi else 0.0025
    bev.segments = 3 if hi else 1
    bev.limit_method = 'ANGLE'
    bev.angle_limit = math.radians(35)
    bev.harden_normals = not hi
    if hi:
        sub = ob.modifiers.new('sub', 'SUBSURF')
        sub.levels = sub.render_levels = 1
    wn = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
    wn.keep_sharp = True
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    # Smooth by angle (flat faces stay crisp).
    for poly in ob.data.polygons:
        poly.use_smooth = True
    if not hi:
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.ops.object.shade_auto_smooth(angle=math.radians(40))
        tri = ob.modifiers.new('tri', 'TRIANGULATE')
        bpy.ops.object.modifier_apply(modifier=tri.name)
    return ob


def unwrap(ob) -> None:
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006,
                             area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.006, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def part_ids(ob) -> list[int]:
    attr = ob.data.attributes.get('part')
    if attr is None:
        return [0] * len(ob.data.polygons)
    return [d.value for d in attr.data]


# ---------------------------------------------------------------------------------------------
# Materials (hi-poly; Blender nodes)


PART_LOOK = {
    # source, tint (multiplies the source, linear), tile (m per repeat), roughness, metal, bump,
    # edge wear (bare metal on convex edges, from the hi-poly's curvature: Cycles pointiness)
    SHELL: ('paint_darkgrey', (0.17, 0.18, 0.205), 0.32, 0.5, 0.0, 0.25, 1.0),
    FRAME: ('bed_plating', (0.5, 0.5, 0.62), 0.2, 0.45, 0.7, 0.35, 0.5),
    METAL: ('cast_armor', (1.45, 1.55, 1.75), 0.24, 0.36, 0.85, 0.2, 0.0),
    STRAP: ('canvas_tarp', (0.55, 0.58, 0.52), 0.12, 0.9, 0.0, 0.5, 0.0),
    CELL: ('cast_armor', (0.9, 0.98, 1.12), 0.2, 0.3, 0.8, 0.2, 0.5),
    LIGHT: (None, (0.25, 0.85, 1.0), 1.0, 0.3, 0.0, 0.0, 0.0),
    SOOT: ('burnt_metal', (0.12, 0.11, 0.1), 0.18, 0.75, 0.5, 0.15, 0.0),
    BELL: ('burnt_metal', (1.9, 1.9, 2.0), 0.2, 0.36, 0.9, 0.3, 0.0),
    ACCENT: ('olive_paint', (2.6, 1.55, 0.42), 0.25, 0.5, 0.0, 0.25, 1.0),
}
EMISSIVE = (0.25, 0.9, 1.0)


def _img(name: str, colour: bool):
    key = f'{name}{"" if colour else "_nc"}'
    if key in bpy.data.images:
        return bpy.data.images[key]
    im = bpy.data.images.load(str(TEXPREP / f'{name}.png'), check_existing=False)
    im.name = key
    im.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
    return im


def part_material(part: int):
    src, tint, tile, rough, metal, bump, wear = PART_LOOK[part]
    m = bpy.data.materials.new(f'part{part}')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if src is None:
        bsdf.inputs['Base Color'].default_value = (*tint, 1)
        bsdf.inputs['Emission Color'].default_value = (*EMISSIVE, 1)
        bsdf.inputs['Emission Strength'].default_value = 1.0
        return m
    coord = nt.nodes.new('ShaderNodeTexCoord')
    mapping = nt.nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (1 / tile, 1 / tile, 1 / tile)
    nt.links.new(coord.outputs['Object'], mapping.inputs['Vector'])
    col = nt.nodes.new('ShaderNodeTexImage')
    col.image = _img(src, True)
    col.projection = 'BOX'
    col.projection_blend = 0.25
    nt.links.new(mapping.outputs[0], col.inputs[0])
    hgt = nt.nodes.new('ShaderNodeTexImage')
    hgt.image = _img(f'{src}_height', False)
    hgt.projection = 'BOX'
    hgt.projection_blend = 0.25
    nt.links.new(mapping.outputs[0], hgt.inputs[0])
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(col.outputs['Color'], mul.inputs[6])
    mul.inputs[7].default_value = (*tint, 1)
    base = mul.outputs[2]
    # Edge wear: convex edges chip to bare metal. The mask is the hi-poly's curvature (Cycles
    # pointiness: 0.5 on flats, higher on convex edges), broken up by noise; `bake_wear` bakes
    # it alone first so it can be checked before it goes into the colour.
    if wear > 0:
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        edge = nt.nodes.new('ShaderNodeMapRange')
        nt.links.new(geo.outputs['Pointiness'], edge.inputs[0])
        edge.inputs[1].default_value = 0.522
        edge.inputs[2].default_value = 0.534
        noise = nt.nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 140
        noise.inputs['Detail'].default_value = 8
        noise.inputs['Roughness'].default_value = 0.7
        nt.links.new(coord.outputs['Object'], noise.inputs['Vector'])
        chip = nt.nodes.new('ShaderNodeMath')
        chip.operation = 'MULTIPLY'
        nt.links.new(edge.outputs[0], chip.inputs[0])
        nt.links.new(noise.outputs['Fac'], chip.inputs[1])
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.name = 'wearmask'
        ramp.color_ramp.elements[0].position = 0.32
        ramp.color_ramp.elements[1].position = 0.42
        ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
        ramp.color_ramp.elements[1].color = (wear, wear, wear, 1)
        nt.links.new(chip.outputs[0], ramp.inputs['Fac'])
        mixw = nt.nodes.new('ShaderNodeMix')
        mixw.data_type = 'RGBA'
        nt.links.new(ramp.outputs['Color'], mixw.inputs['Factor'])
        nt.links.new(base, mixw.inputs[6])
        mixw.inputs[7].default_value = (0.48, 0.48, 0.5, 1)
        base = mixw.outputs[2]
        # Chipped spots are bare metal: shinier, metallic (float mixes by the chip mask).
        chipf = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(ramp.outputs['Color'], chipf.inputs[0])
        for name, a_val, b_val in (('Roughness', rough, 0.3), ('Metallic', metal, 0.9)):
            mx = nt.nodes.new('ShaderNodeMix')
            mx.data_type = 'FLOAT'
            nt.links.new(chipf.outputs[0], mx.inputs['Factor'])
            mx.inputs['A'].default_value = a_val
            mx.inputs['B'].default_value = b_val
            nt.links.new(mx.outputs['Result'], bsdf.inputs[name])
    if part == METAL:
        # Heat: the pods darken and brown toward their exhaust end (object-space height).
        sep2 = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(coord.outputs['Object'], sep2.inputs[0])
        low = nt.nodes.new('ShaderNodeMapRange')
        nt.links.new(sep2.outputs['Z'], low.inputs[0])
        low.inputs[1].default_value = POD_BOTTOM
        low.inputs[2].default_value = (POD_TOP + POD_BOTTOM) / 2
        lr = nt.nodes.new('ShaderNodeValToRGB')
        lr.color_ramp.elements[0].color = (0.42, 0.36, 0.32, 1)
        lr.color_ramp.elements[1].color = (1, 1, 1, 1)
        nt.links.new(low.outputs[0], lr.inputs['Fac'])
        mlow = nt.nodes.new('ShaderNodeMix')
        mlow.data_type = 'RGBA'
        mlow.blend_type = 'MULTIPLY'
        mlow.inputs['Factor'].default_value = 1.0
        nt.links.new(base, mlow.inputs[6])
        nt.links.new(lr.outputs['Color'], mlow.inputs[7])
        base = mlow.outputs[2]
    if part == BELL:
        # Heat: the bells and pod bottoms blue/bronze toward the exit (object-space height).
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(coord.outputs['Object'], sep.inputs[0])
        heat = nt.nodes.new('ShaderNodeMapRange')
        nt.links.new(sep.outputs['Z'], heat.inputs['Value'])
        heat.inputs['From Min'].default_value = POD_BOTTOM - BELL_LEN
        heat.inputs['From Max'].default_value = POD_BOTTOM + 0.05
        heat.inputs['To Min'].default_value = 1.0
        heat.inputs['To Max'].default_value = 0.0
        hr = nt.nodes.new('ShaderNodeValToRGB')
        e = hr.color_ramp.elements
        e[0].position, e[0].color = 0.0, (0.9, 0.85, 0.75, 1)
        e[1].position, e[1].color = 1.0, (0.22, 0.24, 0.55, 1)
        mid = hr.color_ramp.elements.new(0.45)
        mid.color = (0.85, 0.5, 0.22, 1)
        mid2 = hr.color_ramp.elements.new(0.75)
        mid2.color = (0.45, 0.25, 0.4, 1)
        nt.links.new(heat.outputs[0], hr.inputs['Fac'])
        mh = nt.nodes.new('ShaderNodeMix')
        mh.data_type = 'RGBA'
        mh.blend_type = 'MULTIPLY'
        mh.inputs['Factor'].default_value = 1.0
        nt.links.new(base, mh.inputs[6])
        nt.links.new(hr.outputs['Color'], mh.inputs[7])
        base = mh.outputs[2]
    nt.links.new(base, bsdf.inputs['Base Color'])
    bnode = nt.nodes.new('ShaderNodeBump')
    bnode.inputs['Strength'].default_value = bump
    bnode.inputs['Distance'].default_value = 0.002
    nt.links.new(hgt.outputs['Color'], bnode.inputs['Height'])
    nt.links.new(bnode.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def assign_materials(ob) -> None:
    mats = [part_material(p) for p in range(PARTS)]
    for m in mats:
        ob.data.materials.append(m)
    for poly, pid in zip(ob.data.polygons, part_ids(ob)):
        poly.material_index = pid


# ---------------------------------------------------------------------------------------------
# Blender stages


def bake_image(name: str, colour: bool):
    img = bpy.data.images.new(name, TEX, TEX, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
    return img


def stage_model() -> None:
    import time

    BUILD.mkdir(parents=True, exist_ok=True)
    (BUILD / 'maps').mkdir(exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    low = build_pack('jetpack_low', hi=False)
    hi = build_pack('jetpack_hi', hi=True)
    unwrap(low)
    assign_materials(hi)
    for name, p in ANCHORS.items():
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.02
        e.location = p2b(p)
        sc.collection.objects.link(e)
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.world = bpy.data.worlds.new('w')
    sc.world.light_settings.distance = 0.03
    # The low's bake target material: one image node, swapped per pass.
    tm = bpy.data.materials.new('target')
    tm.use_nodes = True
    low.data.materials.append(tm)
    tex = tm.node_tree.nodes.new('ShaderNodeTexImage')
    tm.node_tree.nodes.active = tex
    bk = sc.render.bake

    def bake(kind: str, img, **kw):
        tex.image = img
        bpy.ops.object.select_all(action='DESELECT')
        hi.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        t0 = time.time()
        bk.use_selected_to_active = True
        bk.cage_extrusion = 0.006
        bk.max_ray_distance = 0.012
        bk.margin = 12
        bk.margin_type = 'EXTEND'
        bk.use_clear = True
        bpy.ops.object.bake(type=kind, **kw)
        img.filepath_raw = str(BUILD / 'maps' / f'{img.name}.png')
        img.file_format = 'PNG'
        img.save()
        print(f'jetpack: baked {img.name} in {time.time() - t0:.0f} s', flush=True)

    # The edge-wear mask alone first (white = chipped): checked before it reaches the colour.
    outs = []
    for m in hi.data.materials:
        nt = m.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        keep = out.inputs[0].links[0].from_socket
        em = nt.nodes.new('ShaderNodeEmission')
        mask = nt.nodes.get('wearmask')
        if mask:
            nt.links.new(mask.outputs['Color'], em.inputs['Color'])
        else:
            em.inputs['Color'].default_value = (0, 0, 0, 1)
        nt.links.new(em.outputs[0], out.inputs[0])
        outs.append((nt, out, keep))
    sc.cycles.samples = 4
    bake('EMIT', bake_image('bake_wear', False))
    for nt, out, keep in outs:
        nt.links.new(keep, out.inputs[0])
    sc.cycles.samples = 8
    bk.use_pass_direct = False
    bk.use_pass_indirect = False
    bk.use_pass_color = True
    bake('DIFFUSE', bake_image('bake_albedo', True), pass_filter={'COLOR'})
    bake('ROUGHNESS', bake_image('bake_rough', False))
    bake('EMIT', bake_image('bake_emissive', True))
    bake('NORMAL', bake_image('bake_normal', False), normal_space='TANGENT')
    # Metalness: each part's metal value (worn spots included) as emission, then EMIT.
    for m in hi.data.materials:
        nt = m.node_tree
        bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        em = nt.nodes.new('ShaderNodeEmission')
        src = bsdf.inputs['Metallic']
        if src.links:
            nt.links.new(src.links[0].from_socket, em.inputs['Color'])
        else:
            v = src.default_value
            em.inputs['Color'].default_value = (v, v, v, 1)
        nt.links.new(em.outputs[0], out.inputs[0])
    bake('EMIT', bake_image('bake_metal', False))
    sc.cycles.samples = 128
    bake('AO', bake_image('bake_ao', False))
    export_gltf(low)
    bpy.ops.wm.save_as_mainfile(filepath=str(BUILD / 'jetpack.blend'))
    stats = {'lowTriangles': sum(len(p.vertices) - 2 for p in low.data.polygons),
             'hiTriangles': sum(len(p.vertices) - 2 for p in hi.data.polygons)}
    (BUILD / 'model.json').write_text(json.dumps(stats, indent=2))
    print('jetpack: model stage done', stats, flush=True)


def export_gltf(low) -> None:
    ex = BUILD / 'export'
    ex.mkdir(parents=True, exist_ok=True)
    low.data.materials.clear()
    low.name = low.data.name = 'jetpack'
    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    for name in ANCHORS:
        bpy.data.objects[name].select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(ex / 'jetpack.gltf'),
        export_format='GLTF_SEPARATE',
        use_selection=True,
        export_materials='NONE',
        export_tangents=False,
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_attributes=False,
    )


def _look(ob, target) -> None:
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def stage_render() -> None:
    """Beauty renders of the shipped look (the low with its baked maps) for Kiran's review."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    bpy.ops.import_scene.gltf(filepath=str(OUT / 'jetpack.gltf'))
    ob = bpy.data.objects['jetpack']
    md = BUILD / 'maps'
    m = bpy.data.materials.new('shipped')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']

    def img(name, colour):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(str(md / f'{name}.png'))
        n.image.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
        return n

    alb, arm, nrm, emi = img('ship_albedo', True), img('ship_arm', False), img('ship_normal', False), img('ship_emissive', True)
    nt.links.new(alb.outputs['Color'], bsdf.inputs['Base Color'])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(arm.outputs['Color'], sep.inputs[0])
    nt.links.new(sep.outputs[1], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs[2], bsdf.inputs['Metallic'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(nrm.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
    nt.links.new(emi.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 2.5
    ob.data.materials.clear()
    ob.data.materials.append(m)
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 96
    sc.render.resolution_x, sc.render.resolution_y = 1200, 1200
    sc.render.film_transparent = False
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.055, 0.065, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
    for name, loc, power, col in [
        ('key', (0.9, -0.6, 1.0), 120, (1, 0.95, 0.88)),
        ('rim', (-0.8, 0.9, 0.6), 90, (0.7, 0.85, 1)),
        ('fill', (-0.6, -1.0, -0.2), 30, (1, 1, 1)),
    ]:
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = power
        ld.size = 0.6
        ld.color = col
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        sc.collection.objects.link(lo)
        _look(lo, (0, 0, 0))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 70
    REVIEW.mkdir(parents=True, exist_ok=True)
    centre = (0, -0.09, -0.03)
    for name, loc in [
        ('jetpack_back_3q', (0.75, -1.0, 0.25)),
        ('jetpack_side', (1.2, -0.09, 0.05)),
        ('jetpack_below', (0.45, -0.75, -0.75)),
        ('jetpack_front', (-0.35, 1.1, 0.2)),
    ]:
        cam.location = loc
        _look(cam, centre)
        sc.render.filepath = str(REVIEW / f'{name}.png')
        bpy.ops.render.render(write_still=True)
        print('jetpack: rendered', name, flush=True)


# ---------------------------------------------------------------------------------------------
# Package stage (system Python)


def manifest(stats: dict) -> dict:
    return {
        'source': 'tools/assets/build_jetpack.py (own Blender work; healed Codex texture '
        'library, Kiran, 2026-10-01)',
        'triangles': stats['lowTriangles'],
        'anchors': {k: [round(c, 5) for c in v] for k, v in ANCHORS.items()},
        'texture': SHIP,
        'textureLow': LOW,
    }


def stage_package() -> None:
    import shutil
    import subprocess

    import numpy as np
    from PIL import Image

    sys.path.insert(0, str(Path(__file__).parent))
    from build_models import json_text
    from webp import save_webp

    md = BUILD / 'maps'
    ex = BUILD / 'export'
    load = lambda n: np.asarray(Image.open(md / f'bake_{n}.png').convert('RGB'), np.float32) / 255
    albedo, rough, metal = load('albedo'), load('rough')[..., 0], load('metal')[..., 0]
    ao, emis, normal = load('ao')[..., 0], load('emissive'), load('normal')
    # A touch of baked occlusion in the albedo (the client has no aoMap on this material).
    albedo = albedo * (0.55 + 0.45 * ao)[..., None]
    arm = np.stack([ao, rough, metal], -1)

    def size(a, n, normal_map=False):
        im = Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8))
        im = im.resize((n, n), Image.LANCZOS if not normal_map else Image.BOX)
        if normal_map:
            v = np.asarray(im, np.float32) / 127.5 - 1
            v /= np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-6)
            im = Image.fromarray(np.clip((v + 1) * 127.5 + 0.5, 0, 255).astype(np.uint8))
        return im

    OUT.mkdir(parents=True, exist_ok=True)
    for name, arr, kind in [('albedo', albedo, 'color'), ('arm', arm, 'data'),
                            ('normal', normal, 'data'), ('emissive', emis, 'color')]:
        for suffix, n in (('', SHIP), ('_low', LOW)):
            im = size(arr, n, name == 'normal')
            if suffix == '':
                im.save(md / f'ship_{name}.png')
            save_webp(im, OUT / f'jetpack_{name}{suffix}.webp', kind,
                      match_jpeg=90 if name == 'normal' else 85,
                      subsampling=0 if name == 'normal' else 2)
    doc = json.loads((ex / 'jetpack.gltf').read_text())
    src_bin = ex / doc['buffers'][0]['uri']
    doc['buffers'][0]['uri'] = 'jetpack.bin'
    doc['asset']['generator'] = 'warsaw-downtown tools/assets/build_jetpack.py'
    names = {n.get('name') for n in doc['nodes']}
    missing = {'jetpack', *ANCHORS} - names
    if missing:
        raise SystemExit(f'export lacks nodes {missing}')
    shutil.copyfile(src_bin, OUT / 'jetpack.bin')
    (OUT / 'jetpack.gltf').write_text(json.dumps(doc, separators=(',', ':')))
    stats = json.loads((BUILD / 'model.json').read_text())
    (OUT / 'jetpack.json').write_text(json_text(manifest(stats)) + '\n', encoding='utf-8',
                                      newline='\n')
    subprocess.run(['node', str(ROOT / 'tools/assets/meshopt_pack.mjs'), str(OUT / 'jetpack.gltf')],
                   check=True, shell=os.name == 'nt')
    print('jetpack: packaged', sorted(p.name for p in OUT.iterdir()), flush=True)


def main_blender(argv: list[str]) -> None:
    stage = argv[0] if argv else 'model'
    if stage == 'model':
        stage_model()
    elif stage == 'render':
        stage_render()
    else:
        raise SystemExit(f'unknown blender stage {stage}')


if __name__ == '__main__':
    if bpy is not None:
        args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
        main_blender(args)
    elif len(sys.argv) > 1 and sys.argv[1] == 'package':
        stage_package()
    else:
        raise SystemExit(__doc__)
