"""Procedural PBR materials for the vehicle bakes (Cycles node graphs). Blender only.

Every material is a bake *source*: albedo, roughness, metalness and the normal detail (bevelled
edges, orange peel, grunge, chips) are baked from these onto the low mesh's UVs. Grunge inputs
include the repo's CC0 Poly Haven `rusty_painted_metal` / `metal_plate` scans (box-projected, used
only as masks), when present.
"""

import os
from pathlib import Path

import vehicle_bpy as vb

_CACHE: dict = {}


def _grunge(g, raw: Path | None, name: str, scale: float):
    """A CC0 scan's roughness map as a 0–1 grunge mask, or procedural noise without it."""
    if raw is not None:
        p = raw / f'polyhaven/textures/{name}/{name}_rough_1k.jpg'
        if p.exists():
            t = vb.image_box(g, str(p), scale=scale)
            return t.outputs['Color']
    return g.noise(scale * 4, 8, 0.65).outputs['Fac']


def paint(name, base: int, raw=None, wear=0.35, dirt=0.6, dust=0.3, rough=0.58, mud_height=0.9,
          metal_under=0x6e6c66, camo=None, low_grime=0.0, edge_radius=0.015, chip_reach=1.0):
    """Matte military paint: tonal variation, chipped edges to primer/steel, mud from below, dust
    on top, grime in crevices. `wear` / `dirt` / `dust` scale each layer."""
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    base_c = vb.srgb(base)
    # Tonal variation: large blotches ±7 % value, slight hue drift.
    var = g.noise(1.6, 4, 0.5, co).outputs['Fac']
    var2 = g.noise(7.0, 6, 0.55, co).outputs['Fac']
    tone = g.mix(g.math('MULTIPLY', g.math('SUBTRACT', var, 0.5), 1.4, clamp=False), base_c,
                 tuple(c * 0.82 for c in base_c), 'MIX')
    tone = g.mix(g.math('MULTIPLY', var2, 0.35), tone, tuple(min(1, c * 1.18) for c in base_c))
    if camo is not None:
        # Two-tone disruptive pattern with crisp edges (a hard threshold of a warped noise), the
        # second tone keeping the same tonal variation.
        dark, cscale = camo
        cn = g.noise(cscale, 3.0, 0.55, co, dist=0.45).outputs['Fac']
        cm = g.math('GREATER_THAN', cn, 0.53)
        dark_c = vb.srgb(dark)
        dtone = g.mix(g.math('MULTIPLY', g.math('SUBTRACT', var, 0.5), 1.4, clamp=False), dark_c,
                      tuple(c * 0.85 for c in dark_c), 'MIX')
        tone = g.mix(cm, tone, dtone)
    grunge = _grunge(g, raw, 'rusty_painted_metal', 0.9)
    grunge_fine = _grunge(g, raw, 'metal_plate', 2.5)
    edge, bev = vb.edge_mask(g, edge_radius)
    if chip_reach != 1.0:
        # Curvature from a wide bevel probe, grown inward so chips read at a 1k bake.
        edge = g.math('POWER', edge, 1.0 / chip_reach)
    # Chips: edges broken up by noise; primer under the paint, bare steel under the primer.
    chip_n = g.noise(38.0, 8, 0.7, co).outputs['Fac']
    # A coarse blotch gates the edge so it breaks into separate chips instead of an outline.
    blotch = g.ramp(g.noise(7.0, 4, 0.6, co, dist=0.5).outputs['Fac'], [(0.42, 0.0), (0.62, 1.0)])
    edge = g.math('MULTIPLY', edge, blotch)
    chip = g.math('MULTIPLY', edge, g.math('MULTIPLY', chip_n, 2.2), clamp=True)
    chip = g.math('GREATER_THAN', g.math('ADD', chip, g.math('MULTIPLY', grunge, 0.25)), 1.0 - wear * 0.9)
    steel = g.math('GREATER_THAN', g.math('MULTIPLY', chip_n, edge), 0.62)
    if os.environ.get('WD_MASK_DEBUG') == 'chip':
        # Mask check: white = chipped to primer, grey = through to bare steel.
        dbg = g.mix(chip, vb.srgb(0x000000), vb.srgb(0x9a9a9a))
        dbg = g.mix(g.math('MULTIPLY', steel, chip), dbg, vb.srgb(0xffffff))
        vb.set_bsdf(g, bsdf, dbg, 0.9, 0.0, None)
        return mat
    col = tone
    # Grime in cavities.
    cav = vb.cavity_mask(g, 0.22)
    grime = g.math('MULTIPLY', g.math('POWER', cav, 0.7), dirt)
    col = g.mix(grime, col, vb.srgb(0x2c271f), 'MULTIPLY')
    # Mud / road dirt from below, broken up.
    h = vb.height(g)
    mud_f = g.math('SUBTRACT', 1.0, g.math('DIVIDE', h, mud_height), clamp=True)
    mud_n = g.noise(4.0, 10, 0.7, co, dist=0.4).outputs['Fac']
    mud = g.math('MULTIPLY', g.math('POWER', mud_f, 1.3), g.math('MULTIPLY', mud_n, 1.6))
    mud = g.math('MULTIPLY', g.math('SUBTRACT', mud, 0.25), dirt * 1.6, clamp=True)
    col = g.mix(mud, col, vb.srgb(0x6a5a44))
    if low_grime:
        # Road grime gradient: darker low down (sills, arches, bed sides), fading by ~1.3 m.
        lg = g.math('MULTIPLY', g.ramp(h, [(0.3, 1.0), (1.3, 0.0)]), low_grime)
        lg = g.math('MULTIPLY', lg, g.math('ADD', 0.6, g.math('MULTIPLY', mud_n, 0.6)), clamp=True)
        col = g.mix(lg, col, vb.srgb(0x24211b), 'MULTIPLY')
    # Chips sit on top of the grime (fresh knocks): a pale grey primer, bright worn steel inside.
    col = g.mix(chip, col, vb.srgb(0x77756b))
    col = g.mix(g.math('MULTIPLY', steel, chip), col, vb.srgb(metal_under))
    # Dust on up-facing surfaces.
    up = g.math('SUBTRACT', g.math('MULTIPLY', vb.up_facing(g), 2.0), 1.0, clamp=True)
    dust_n = g.noise(9.0, 6, 0.6, co).outputs['Fac']
    dmask = g.math('MULTIPLY', g.math('MULTIPLY', up, dust_n), dust * 1.4, clamp=True)
    col = g.mix(dmask, col, vb.srgb(0x9c9180))
    # Fine grunge darkening.
    col = g.mix(g.math('MULTIPLY', grunge_fine, 0.25), col, tuple(c * 0.7 for c in base_c), 'MULTIPLY')
    # Roughness / metalness.
    r = g.math('ADD', rough, g.math('MULTIPLY', g.math('SUBTRACT', grunge, 0.5), 0.25))
    r = g.mixf(mud, r, 0.95)
    r = g.mixf(dmask, r, 0.9)
    r = g.mixf(g.math('MULTIPLY', steel, chip), r, 0.38)
    met = g.math('MULTIPLY', steel, chip)
    # Normal: bevelled edges + orange peel + grunge pits + mud crust.
    peel = g.noise(220.0, 2, 0.5, co).outputs['Fac']
    hgt = g.math('ADD', g.math('MULTIPLY', peel, 0.15), g.math('MULTIPLY', grunge_fine, 0.4))
    hgt = g.math('ADD', hgt, g.math('MULTIPLY', mud, 0.8))
    hgt = g.math('SUBTRACT', hgt, g.math('MULTIPLY', chip, 0.35))
    nrm = vb.bump(g, hgt, 0.25, 0.004, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, met, nrm)
    return mat


def burnt(name, raw=None, paint_left: int | None = None, rust=0.55, ash=0.4, heat=0.5, soot_up=0.0,
          heat_tint=0.0):
    """Fire-gutted steel: charcoal soot with vertical streaking, grey ash on top surfaces, dull
    brown rust bloom in soft patches, heat-browned paint surviving low down and in cavities, worn
    bare-steel edges, blistered surface."""
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    grunge = _grunge(g, raw, 'rusty_painted_metal', 0.7)
    n1 = g.noise(1.4, 6, 0.6, co, dist=0.25).outputs['Fac']
    n2 = g.noise(9.0, 8, 0.7, co).outputs['Fac']
    # Vertical streaks: noise stretched along world Z (Blender up).
    mp = g('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (7.0, 7.0, 0.7)
    g.link(co, mp.inputs['Vector'])
    streak = g.noise(1.0, 4, 0.5, mp.outputs[0]).outputs['Fac']
    col = g.mix(g.ramp(n2, [(0.3, 0.0), (0.75, 1.0)]), vb.srgb(0x2a2724), vb.srgb(0x58524b))
    col = g.mix(g.math('MULTIPLY', g.ramp(streak, [(0.45, 0.0), (0.7, 1.0)]), 0.55), col, vb.srgb(0x161412))
    # Rust: soft patches, dull brown.
    rsrc = g.math('ADD', g.math('MULTIPLY', n1, 0.8), g.math('MULTIPLY', grunge, 0.45))
    lo = 0.95 - rust * 0.35
    rmask = g.ramp(rsrc, [(lo, 0.0), (lo + 0.12, 1.0)])
    rust_c = g.mix(n2, vb.srgb(0x4a2c1a), vb.srgb(0x6e4226))
    col = g.mix(g.math('MULTIPLY', rmask, 0.8), col, rust_c)
    # Ash: pale grey on up-facing surfaces, broken up.
    up = g.ramp(vb.up_facing(g), [(0.55, 0.0), (0.85, 1.0)])
    an = g.noise(4.0, 6, 0.7, co).outputs['Fac']
    amask = g.math('MULTIPLY', g.math('MULTIPLY', up, g.ramp(an, [(0.45, 0.0), (0.6, 1.0)])), ash * 1.2, clamp=True)
    col = g.mix(amask, col, vb.srgb(0x8a847b))
    # Heat-browned surviving paint low down and in cavities.
    if paint_left is not None:
        cav = vb.cavity_mask(g, 0.2)
        h = vb.height(g)
        low = g.math('SUBTRACT', 1.0, g.math('DIVIDE', h, 0.9), clamp=True)
        src = g.math('ADD', g.math('ADD', g.math('MULTIPLY', low, 0.7), g.math('MULTIPLY', cav, 0.5)), g.math('MULTIPLY', n1, 0.4))
        t = 1.15 - heat * 0.5
        keep = g.ramp(src, [(t, 0.0), (t + 0.1, 1.0)])
        pc = vb.srgb(paint_left)
        pcol = g.mix(n2, tuple(c * 0.75 for c in pc), tuple(c * 0.45 + 0.02 for c in pc))
        col = g.mix(keep, col, pcol)
    edge, bev = vb.edge_mask(g, 0.012)
    ed = g.math('MULTIPLY', edge, g.ramp(n2, [(0.4, 0.0), (0.55, 1.0)]))
    col = g.mix(g.math('MULTIPLY', ed, 0.55), col, vb.srgb(0x46433f))
    if heat_tint:
        # Bare steel turned straw / blue by the heat, in patches along the worn edges.
        tint = g.mix(g.ramp(n1, [(0.4, 0.0), (0.6, 1.0)]), vb.srgb(0x7a6038), vb.srgb(0x404a5e))
        hm = g.math('MAXIMUM', ed, g.math('MULTIPLY', rmask, 0.3))
        col = g.mix(g.math('MULTIPLY', hm, heat_tint, clamp=True), col, tint)
    if soot_up:
        # Fire rises: black soot climbing from the openings and the bonnet up over the cab, and
        # heavy on every frame edge (the glassless window frames).
        hh = vb.height(g)
        sm = g.math('MULTIPLY', g.ramp(hh, [(0.9, 0.0), (1.9, 1.0)]), g.math('ADD', 0.55, g.math('MULTIPLY', n2, 0.6)))
        sm = g.math('MAXIMUM', sm, g.math('MULTIPLY', edge, 0.9))
        col = g.mix(g.math('MULTIPLY', sm, soot_up, clamp=True), col, vb.srgb(0x0b0a09))
    r = g.math('ADD', 0.84, g.math('MULTIPLY', g.math('SUBTRACT', n2, 0.5), 0.2))
    r = g.mixf(g.math('MULTIPLY', ed, 0.6), r, 0.45)
    met = g.math('MULTIPLY', ed, 0.55)
    blist = g.voronoi(45.0, co, 'F1').outputs['Distance']
    hgt = g.math('ADD', g.math('MULTIPLY', blist, 0.25), g.math('MULTIPLY', grunge, 0.6))
    hgt = g.math('ADD', hgt, g.math('MULTIPLY', rmask, 0.2))
    nrm = vb.bump(g, hgt, 0.4, 0.006, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, met, nrm)
    return mat


def g_noise_bias(g, co):
    return 0.0


def rubber(name, raw=None, dust=0.5, burnt_off=False):
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    n = g.noise(30.0, 6, 0.6, co).outputs['Fac']
    col = g.mix(g.math('MULTIPLY', n, 0.5), vb.srgb(0x1a1a19), vb.srgb(0x262624))
    cav = vb.cavity_mask(g, 0.06)
    col = g.mix(g.math('MULTIPLY', cav, dust * 1.2, clamp=True), col, vb.srgb(0x5d564b))
    edge, bev = vb.edge_mask(g, 0.008)
    col = g.mix(g.math('MULTIPLY', edge, 0.35), col, vb.srgb(0x3a3834))
    if burnt_off:
        col = g.mix(0.6, col, vb.srgb(0x2b2926))
    r = g.math('ADD', 0.82, g.math('MULTIPLY', n, 0.12))
    hgt = g.math('MULTIPLY', g.noise(140.0, 3, 0.5, co).outputs['Fac'], 0.3)
    nrm = vb.bump(g, hgt, 0.2, 0.002, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, 0.0, nrm)
    return mat


def dark_metal(name, base=0x2b2c29, raw=None, rough=0.5, metal=0.7, wear=0.5):
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    grunge = _grunge(g, raw, 'metal_plate', 1.6)
    edge, bev = vb.edge_mask(g, 0.008)
    n = g.noise(25.0, 6, 0.6, co).outputs['Fac']
    col = g.mix(g.math('MULTIPLY', grunge, 0.4), vb.srgb(base), tuple(c * 0.7 for c in vb.srgb(base)))
    worn = g.math('MULTIPLY', edge, g.math('MULTIPLY', n, 1.8), clamp=True)
    worn = g.math('GREATER_THAN', worn, 1.0 - wear * 0.8)
    col = g.mix(worn, col, vb.srgb(0x7b7a76))
    cav = vb.cavity_mask(g, 0.15)
    col = g.mix(g.math('MULTIPLY', cav, 0.5), col, vb.srgb(0x2b251d), 'MULTIPLY')
    r = g.math('ADD', rough, g.math('MULTIPLY', g.math('SUBTRACT', grunge, 0.5), 0.3))
    r = g.mixf(worn, r, 0.32)
    met = g.mixf(worn, metal, 1.0)
    nrm = vb.bump(g, g.math('MULTIPLY', grunge, 0.5), 0.2, 0.003, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, met, nrm)
    return mat


def plain(name, base, rough=0.8, metal=0.0, bevel=0.006, noise=0.15):
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    n = g.noise(18.0, 5, 0.6, co).outputs['Fac']
    col = g.mix(g.math('MULTIPLY', n, noise), vb.srgb(base), tuple(c * 0.6 for c in vb.srgb(base)))
    cav = vb.cavity_mask(g, 0.12)
    col = g.mix(g.math('MULTIPLY', cav, 0.6), col, vb.srgb(0x30302c), 'MULTIPLY')
    edge, bev = vb.edge_mask(g, bevel)
    nrm = vb.bump(g, g.math('MULTIPLY', n, 0.2), 0.1, 0.002, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, rough, metal, nrm)
    return mat


def fabric(name, base=0x3a3b34):
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    weave = g('ShaderNodeTexWave', wave_type='BANDS', bands_direction='DIAGONAL')
    weave.inputs['Scale'].default_value = 260
    g.link(co, weave.inputs['Vector'])
    n = g.noise(12.0, 5, 0.6, co).outputs['Fac']
    col = g.mix(g.math('MULTIPLY', n, 0.3), vb.srgb(base), tuple(c * 0.7 for c in vb.srgb(base)))
    cav = vb.cavity_mask(g, 0.1)
    col = g.mix(g.math('MULTIPLY', cav, 0.7), col, vb.srgb(0x26241f), 'MULTIPLY')
    edge, bev = vb.edge_mask(g, 0.02)
    nrm = vb.bump(g, g.math('MULTIPLY', weave.outputs['Fac'], 0.2), 0.25, 0.002, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, 0.95, 0.0, nrm)
    return mat


def lens(name, base=0xb8bdbf, rough=0.12):
    mat, g, bsdf = vb.principled(name)
    edge, bev = vb.edge_mask(g, 0.004)
    co = vb.world_coords(g)
    fac = g('ShaderNodeTexWave', wave_type='RINGS')
    fac.inputs['Scale'].default_value = 60
    g.link(co, fac.inputs['Vector'])
    col = g.mix(g.math('MULTIPLY', fac.outputs['Fac'], 0.25), vb.srgb(base), tuple(c * 0.6 for c in vb.srgb(base)))
    nrm = vb.bump(g, g.math('MULTIPLY', fac.outputs['Fac'], 0.3), 0.15, 0.002, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, rough, 0.0, nrm)
    return mat


def glass(name='glass', tint=0x394143, alpha=0.32):
    """The one cheap transparent material (low mesh, not baked)."""
    mat, g, bsdf = vb.principled(name)
    vb.set_bsdf(g, bsdf, vb.srgb(tint), 0.06, 0.0)
    bsdf.inputs['Alpha'].default_value = alpha
    bsdf.inputs['IOR'].default_value = 1.5
    mat.surface_render_method = 'BLENDED'
    return mat


def emission_rgb(name, rgb):
    mat, g, bsdf = vb.principled(name)
    vb.set_bsdf(g, bsdf, rgb, 0.9, 0.0)
    return mat


def textured(name, albedo, orm, normal, alpha_blend=False):
    """Final low-mesh material: baked albedo / ORM (R ao, G roughness, B metalness) / normal."""
    mat, g, bsdf = vb.principled(name)
    ta = g('ShaderNodeTexImage')
    ta.image = albedo
    to = g('ShaderNodeTexImage')
    to.image = orm
    tn = g('ShaderNodeTexImage')
    tn.image = normal
    sep = g('ShaderNodeSeparateColor')
    g.link(to.outputs['Color'], sep.inputs[0])
    nm = g('ShaderNodeNormalMap')
    g.link(tn.outputs['Color'], nm.inputs['Color'])
    g.link(ta.outputs['Color'], bsdf.inputs['Base Color'])
    g.link(sep.outputs['Green'], bsdf.inputs['Roughness'])
    g.link(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    g.link(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if alpha_blend:
        g.link(ta.outputs['Alpha'], bsdf.inputs['Alpha'])
        mat.surface_render_method = 'BLENDED'
    return mat


def crazed_glass(name, base=0x1b1f20):
    """Opaque shattered, sooty glass (the wreck panes are collision: they must read as solid)."""
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    cr = g.voronoi(9.0, co, 'DISTANCE_TO_EDGE').outputs['Distance']
    cr2 = g.voronoi(26.0, co, 'DISTANCE_TO_EDGE').outputs['Distance']
    crack = g.math('LESS_THAN', g.math('MINIMUM', cr, g.math('MULTIPLY', cr2, 1.5)), 0.03)
    soot = g.noise(3.0, 6, 0.6, co).outputs['Fac']
    col = g.mix(g.math('MULTIPLY', soot, 0.8), vb.srgb(base), vb.srgb(0x0b0b0a))
    col = g.mix(g.math('MULTIPLY', crack, 0.5), col, vb.srgb(0x3c403f))
    r = g.mixf(g.math('MULTIPLY', soot, 0.9), 0.08, 0.7)
    r = g.mixf(crack, r, 0.5)
    edge, bev = vb.edge_mask(g, 0.004)
    nrm = vb.bump(g, crack, 0.4, 0.002, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, 0.0, nrm)
    return mat


def decal(name, img):
    """Alpha-blended ground decal (scorch)."""
    mat, g, bsdf = vb.principled(name)
    t = g('ShaderNodeTexImage')
    t.image = img
    g.link(t.outputs['Color'], bsdf.inputs['Base Color'])
    g.link(t.outputs['Alpha'], bsdf.inputs['Alpha'])
    bsdf.inputs['Roughness'].default_value = 0.95
    mat.surface_render_method = 'BLENDED'
    return mat


# ----------------------------------------------------------------------------- sourced materials
# Texture sources: Codex image_generation (Kiran's account), healed + de-lit by
# vehicle_texprep.py into SOURCES (scratch; never shipped). Each sourced material falls back to
# the procedural one above when its source is missing.

SOURCES: Path | None = None


def have(name: str) -> bool:
    return SOURCES is not None and (SOURCES / f'{name}.png').exists()


def src(g, name, scale, blend=0.3):
    """Box-projected source albedo (sRGB) and its height (high-passed luminance)."""
    col = vb.image_box(g, str(SOURCES / f'{name}.png'), scale=scale, noncolor=False, blend=blend)
    hgt = vb.image_box(g, str(SOURCES / f'{name}_height.png'), scale=scale, blend=blend)
    return col.outputs['Color'], hgt.outputs['Color']


def _hsv(g, col):
    sep = g('ShaderNodeSeparateColor', mode='HSV')
    g.link(col, sep.inputs[0])
    return sep.outputs[0], sep.outputs[1], sep.outputs[2]


def _streaks(g, co, amount):
    """Rain/soot streaks running down vertical faces (0 on tops/bottoms)."""
    mp = g('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (9.0, 9.0, 0.45)
    g.link(co, mp.inputs['Vector'])
    st = g.noise(1.0, 5, 0.55, mp.outputs[0]).outputs['Fac']
    vert = g.math('SUBTRACT', 1.0, g.math('ABSOLUTE', vb.up_facing(g)))
    vert = g.ramp(vert, [(0.6, 0.0), (0.9, 1.0)])
    return g.math('MULTIPLY', g.math('MULTIPLY', g.ramp(st, [(0.5, 0.0), (0.72, 1.0)]), vert), amount)


def sourced_paint(name, src_name, raw=None, scale=0.75, wear=0.5, dirt=0.8, dust=0.4, mud_height=0.9,
                  streaks=0.5, tint=None):
    """Worn paint from a texture source + model-driven layers: edge wear to rust/steel, cavity grime,
    mud from below, dust on top, streaks down vertical panels."""
    if not have(src_name):
        return paint(name, tint or 0x575a49, raw, wear=wear, dirt=dirt, dust=dust, mud_height=mud_height)
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    base, h0 = src(g, src_name, scale)
    if tint is not None:
        base = g.mix(0.35, base, vb.srgb(tint), 'COLOR')
    hue, sat, val = _hsv(g, base)
    bare = g.math('MULTIPLY', g.ramp(sat, [(0.10, 1.0), (0.2, 0.0)]), g.ramp(val, [(0.3, 0.0), (0.45, 1.0)]))
    rusty = g.math('MULTIPLY', g.ramp(sat, [(0.35, 0.0), (0.5, 1.0)]), g.ramp(hue, [(0.12, 1.0), (0.16, 0.0)]))
    col = base
    edge, bev = vb.edge_mask(g, 0.015)
    chip_n = g.noise(34.0, 8, 0.7, co).outputs['Fac']
    chip = g.math('MULTIPLY', edge, g.math('MULTIPLY', chip_n, 2.2), clamp=True)
    chip = g.ramp(chip, [(1.0 - wear * 0.8, 0.0), (1.05 - wear * 0.8, 1.0)])
    if have('rust_heavy'):
        rc, rh = src(g, 'rust_heavy', 1.6)
    else:
        rc = vb.srgb(0x6a3a1c)
    col = g.mix(g.math('MULTIPLY', chip, 0.8), col, rc)
    steel = g.math('MULTIPLY', chip, g.ramp(chip_n, [(0.62, 0.0), (0.7, 1.0)]))
    col = g.mix(steel, col, vb.srgb(0x77756f))
    cav = vb.cavity_mask(g, 0.22)
    col = g.mix(g.math('MULTIPLY', g.math('POWER', cav, 0.7), dirt), col, vb.srgb(0x2a251d), 'MULTIPLY')
    st = _streaks(g, co, streaks)
    col = g.mix(st, col, vb.srgb(0x3a352d), 'MULTIPLY')
    h = vb.height(g)
    mud_f = g.math('SUBTRACT', 1.0, g.math('DIVIDE', h, mud_height), clamp=True)
    mud_n = g.noise(4.0, 10, 0.7, co, dist=0.4).outputs['Fac']
    mud = g.math('MULTIPLY', g.math('POWER', mud_f, 1.2), g.math('MULTIPLY', mud_n, 1.7))
    mud = g.math('MULTIPLY', g.math('SUBTRACT', mud, 0.25), dirt * 1.6, clamp=True)
    if have('mud_dust'):
        mc, mh = src(g, 'mud_dust', 1.1)
    else:
        mc = vb.srgb(0x6a5a44)
    col = g.mix(mud, col, mc)
    up = g.ramp(vb.up_facing(g), [(0.5, 0.0), (0.85, 1.0)])
    dust_n = g.noise(8.0, 6, 0.6, co).outputs['Fac']
    dmask = g.math('MULTIPLY', g.math('MULTIPLY', up, dust_n), dust * 1.4, clamp=True)
    col = g.mix(dmask, col, vb.srgb(0x9a8f7e))
    r = g.mixf(rusty, 0.6, 0.86)
    r = g.mixf(bare, r, 0.38)
    r = g.mixf(chip, r, 0.8)
    r = g.mixf(steel, r, 0.35)
    r = g.mixf(mud, r, 0.95)
    r = g.mixf(dmask, r, 0.9)
    r = g.mixf(st, r, 0.7)
    met = g.math('MAXIMUM', g.math('MULTIPLY', bare, 0.75), g.math('MULTIPLY', steel, 0.9))
    met = g.mixf(g.math('MAXIMUM', mud, dmask), met, 0.0)
    hgt = g.math('ADD', g.math('MULTIPLY', h0, 0.6), g.math('MULTIPLY', mud, 0.7))
    hgt = g.math('SUBTRACT', hgt, g.math('MULTIPLY', chip, 0.3))
    nrm = vb.bump(g, hgt, 0.35, 0.004, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, met, nrm)
    return mat


def sourced_burnt(name, raw=None, paint_src=None, heat=0.5, rust=0.55, ash=0.4, scale=0.7):
    """Fire-gutted metal from the burnt_metal source; rust_heavy patches; remnants of the paint
    source low down and in cavities; ash on top; soot streaks."""
    if not have('burnt_metal'):
        return burnt(name, raw, paint_left=0x575a49 if paint_src else None, rust=rust, ash=ash, heat=heat)
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    base, h0 = src(g, 'burnt_metal', scale)
    col = base
    n1 = g.noise(1.3, 6, 0.6, co, dist=0.25).outputs['Fac']
    n2 = g.noise(9.0, 8, 0.7, co).outputs['Fac']
    rmask = g.ramp(n1, [(0.68 - rust * 0.25, 0.0), (0.78 - rust * 0.25, 1.0)])
    if have('rust_heavy'):
        rc, rh = src(g, 'rust_heavy', 1.2)
        col = g.mix(g.math('MULTIPLY', rmask, 0.85), col, g.mix(0.35, rc, vb.srgb(0x2a2420), 'MULTIPLY'))
    if paint_src and have(paint_src):
        pc, ph = src(g, paint_src, 0.75)
        cav = vb.cavity_mask(g, 0.2)
        hh = vb.height(g)
        low = g.math('SUBTRACT', 1.0, g.math('DIVIDE', hh, 1.0), clamp=True)
        s_ = g.math('ADD', g.math('ADD', g.math('MULTIPLY', low, 0.7), g.math('MULTIPLY', cav, 0.5)), g.math('MULTIPLY', n1, 0.4))
        t = 1.15 - heat * 0.5
        keep = g.ramp(s_, [(t, 0.0), (t + 0.1, 1.0)])
        col = g.mix(keep, col, g.mix(0.4, pc, vb.srgb(0x3a3026), 'MULTIPLY'))
    up = g.ramp(vb.up_facing(g), [(0.55, 0.0), (0.85, 1.0)])
    an = g.noise(4.0, 6, 0.7, co).outputs['Fac']
    amask = g.math('MULTIPLY', g.math('MULTIPLY', up, g.ramp(an, [(0.45, 0.0), (0.6, 1.0)])), ash * 1.2, clamp=True)
    col = g.mix(amask, col, vb.srgb(0x87827a))
    st = _streaks(g, co, 0.6)
    col = g.mix(st, col, vb.srgb(0x1a1816), 'MULTIPLY')
    edge, bev = vb.edge_mask(g, 0.012)
    ed = g.math('MULTIPLY', edge, g.ramp(n2, [(0.4, 0.0), (0.55, 1.0)]))
    col = g.mix(g.math('MULTIPLY', ed, 0.5), col, vb.srgb(0x4a4743))
    r = g.math('ADD', 0.82, g.math('MULTIPLY', g.math('SUBTRACT', n2, 0.5), 0.2))
    r = g.mixf(g.math('MULTIPLY', ed, 0.6), r, 0.45)
    met = g.math('MULTIPLY', ed, 0.55)
    hgt = g.math('ADD', g.math('MULTIPLY', h0, 0.7), g.math('MULTIPLY', rmask, 0.15))
    nrm = vb.bump(g, hgt, 0.4, 0.005, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, met, nrm)
    return mat


def sourced_simple(name, src_name, scale, rough, metal=0.0, bump_s=0.3, fallback=None, dust=0.3, tint=None):
    """A source with cavity grime + dust (rubber, canvas, tread plate)."""
    if not have(src_name):
        return fallback() if fallback else plain(name, 0x333333, rough)
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    col, h0 = src(g, src_name, scale)
    if tint is not None:
        col = g.mix(0.5, col, vb.srgb(tint), 'COLOR')
    cav = vb.cavity_mask(g, 0.12)
    col = g.mix(g.math('MULTIPLY', cav, 0.6), col, vb.srgb(0x2a2722), 'MULTIPLY')
    up = g.ramp(vb.up_facing(g), [(0.5, 0.0), (0.85, 1.0)])
    dmask = g.math('MULTIPLY', g.math('MULTIPLY', up, g.noise(8.0, 6, 0.6, co).outputs['Fac']), dust * 1.3, clamp=True)
    col = g.mix(dmask, col, vb.srgb(0x8f8574))
    _, sat, val = _hsv(g, col)
    r = g.math('ADD', rough, g.math('MULTIPLY', g.math('SUBTRACT', 0.5, val), 0.2))
    edge, bev = vb.edge_mask(g, 0.008)
    nrm = vb.bump(g, h0, bump_s, 0.003, bev.outputs[0])
    vb.set_bsdf(g, bsdf, col, r, metal, nrm)
    return mat


def _uv_image(g, path, noncolor):
    import bpy
    t = g('ShaderNodeTexImage')
    t.image = bpy.data.images.load(str(path), check_existing=True)
    t.image.colorspace_settings.name = 'Non-Color' if noncolor else 'sRGB'
    uv = g('ShaderNodeUVMap')
    g.link(uv.outputs[0], t.inputs['Vector'])
    return t


def tyre_maps(name, base, normal, rough=None, mud=0.6, burnt=False):
    """The source wheel's own UV maps (dark rubber with its moulded tread blocks + rim) with mud
    on the lower tread and rim lip (world height: the wheel is parked on the ground plane while
    baking); `burnt`: charred to near-black with grey ash, the rubber dull."""
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    col = _uv_image(g, base, False).outputs['Color']
    # Rubber reads near-black with a slightly warm grey: pull the source toward it.
    col = g.mix(0.6, col, vb.srgb(0x161513))
    r = g.math('MAXIMUM', _uv_image(g, rough, True).outputs['Color'], 0.82) if rough else 0.9
    nm = g('ShaderNodeNormalMap')
    g.link(_uv_image(g, normal, True).outputs['Color'], nm.inputs['Color'])
    nm.inputs['Strength'].default_value = 1.4
    h = vb.height(g)
    n = g.noise(6.0, 8, 0.7, co, dist=0.3).outputs['Fac']
    mm = g.math('MULTIPLY', g.ramp(h, [(0.04, 1.0), (0.32, 0.0)]), g.math('MULTIPLY', n, 1.6))
    mm = g.math('MULTIPLY', g.math('SUBTRACT', mm, 0.25), mud * 1.6, clamp=True)
    col = g.mix(mm, col, vb.srgb(0x4b3f31))
    r = g.mixf(mm, r, 0.96)
    # Sidewall + shoulder relief on the source's tyre disc (UV centre / radii measured from its
    # basecolor): fine concentric moulding ridges on the sidewall, chunky lugs round the shoulder.
    uv = g('ShaderNodeUVMap')
    sep = g('ShaderNodeSeparateXYZ')
    g.link(uv.outputs[0], sep.inputs[0])
    dx = g.math('SUBTRACT', sep.outputs['X'], 0.373)
    dy = g.math('SUBTRACT', sep.outputs['Y'], 0.389)
    d = g.math('SQRT', g.math('ADD', g.math('MULTIPLY', dx, dx), g.math('MULTIPLY', dy, dy)))
    ang = g.math('ARCTAN2', dy, dx)
    side = g.math('MULTIPLY', g.ramp(d, [(0.205, 0.0), (0.215, 1.0)]), g.ramp(d, [(0.325, 1.0), (0.335, 0.0)]))
    ridge = g.math('MULTIPLY', g.math('ADD', g.math('SINE', g.math('MULTIPLY', d, 377.0)), 1.0), 0.5)
    ring = g.math('MULTIPLY', g.ramp(d, [(0.268, 0.0), (0.272, 1.0)]), g.ramp(d, [(0.282, 1.0), (0.286, 0.0)]))
    lug_on = g.math('LESS_THAN', g.math('FRACT', g.math('MULTIPLY', ang, 36.0 / 6.2832)), 0.55)
    shoulder = g.ramp(d, [(0.335, 0.0), (0.342, 1.0)])
    hgt = g.math('ADD', g.math('MULTIPLY', g.math('MULTIPLY', side, ridge), 0.25),
                 g.math('ADD', g.math('MULTIPLY', ring, 0.8), g.math('MULTIPLY', shoulder, lug_on)))
    # Tread face: wheels bake parked on the ground plane with the axle along X at height r, centres
    # at x = 6, 12, 18, 24 — so the angle about the axle and the offset across the tread are known.
    wp = g('ShaderNodeSeparateXYZ')
    g.link(co, wp.inputs[0])
    ty = wp.outputs['Y']
    tz = g.math('SUBTRACT', wp.outputs['Z'], 0.46)
    rad = g.math('SQRT', g.math('ADD', g.math('MULTIPLY', ty, ty), g.math('MULTIPLY', tz, tz)))
    tang = g.math('ARCTAN2', tz, ty)
    lx = g.math('SUBTRACT', wp.outputs['X'], g.math('MULTIPLY', g.math('ROUND', g.math('DIVIDE', wp.outputs['X'], 6.0)), 6.0))
    alx = g.math('ABSOLUTE', lx)
    face = g.ramp(rad, [(0.395, 0.0), (0.415, 1.0)])
    # Chevron blocks: 28 round the tyre, angled across the tread; a centre rib; grooves between.
    chev = g.math('FRACT', g.math('ADD', g.math('MULTIPLY', tang, 28.0 / 6.2832), g.math('MULTIPLY', alx, 2.2)))
    block = g.math('MULTIPLY', g.ramp(chev, [(0.08, 0.0), (0.14, 1.0)]), g.ramp(chev, [(0.56, 1.0), (0.62, 0.0)]))
    rib = g.ramp(alx, [(0.025, 1.0), (0.035, 0.0)])
    # Shoulder lugs: bigger blocks stepping onto the sidewall edge, staggered with the chevrons.
    lugc = g.math('FRACT', g.math('ADD', g.math('MULTIPLY', tang, 14.0 / 6.2832), 0.25))
    lug = g.math('MULTIPLY', g.ramp(alx, [(0.12, 0.0), (0.135, 1.0)]),
                 g.math('MULTIPLY', g.ramp(lugc, [(0.05, 0.0), (0.1, 1.0)]), g.ramp(lugc, [(0.6, 1.0), (0.65, 0.0)])))
    tread = g.math('MAXIMUM', g.math('MAXIMUM', block, rib), lug)
    groove = g.math('MULTIPLY', face, g.math('SUBTRACT', 1.0, tread, clamp=True))
    hgt = g.math('ADD', hgt, g.math('MULTIPLY', g.math('MULTIPLY', face, tread), 2.2))
    # Block tops scuffed to a dusty grey, grooves near-black: the tread reads at chase distance.
    col = g.mix(g.math('MULTIPLY', g.math('MULTIPLY', face, tread), 0.8), col, vb.srgb(0x45423c))
    col = g.mix(groove, col, vb.srgb(0x060606))
    r = g.mixf(groove, r, 0.97)
    r = g.mixf(g.math('MULTIPLY', face, tread), r, 0.84)
    nrm = vb.bump(g, hgt, 1.0, 0.012, nm.outputs['Normal'])
    if burnt:
        col = g.mix(0.8, col, vb.srgb(0x121110))
        # Fine grey ash in the moulding and cracks, never spots.
        grain = g.ramp(g.noise(60.0, 8, 0.7, co).outputs['Fac'], [(0.6, 0.0), (0.75, 1.0)])
        col = g.mix(g.math('MULTIPLY', grain, 0.35), col, vb.srgb(0x55514b))
        r = 0.95
    vb.set_bsdf(g, bsdf, col, r, 0.0, nrm)
    return mat


def tread_plate(name, raw, tint=0x3c3f33, scale=1.4, burnt=False):
    """Diamond tread plate (the CC0 metal_plate scan, box-projected) painted over and worn: paint
    rubbed off the raised diamonds, dirt packed into the corners, scuffs along the floor."""
    tex = raw / 'polyhaven/textures/metal_plate' if raw else None
    if tex is None or not (tex / 'metal_plate_diffuse_1k.jpg').exists():
        return dark_metal(name, tint, raw)
    mat, g, bsdf = vb.principled(name)
    co = vb.world_coords(g)
    src = vb.image_box(g, str(tex / 'metal_plate_diffuse_1k.jpg'), scale=scale, noncolor=False).outputs['Color']
    ao = vb.image_box(g, str(tex / 'metal_plate_ao_1k.jpg'), scale=scale).outputs['Color']
    col = g.mix(0.65, src, vb.srgb(tint), 'COLOR')
    raised = g.ramp(ao, [(0.75, 0.0), (0.95, 1.0)])
    col = g.mix(g.math('MULTIPLY', raised, 0.7), col, vb.srgb(0x6f6c64))
    cav = vb.cavity_mask(g, 0.2)
    col = g.mix(g.math('MULTIPLY', g.math('POWER', cav, 0.6), 0.9), col, vb.srgb(0x2a251d), 'MULTIPLY')
    mp = g('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (0.6, 9.0, 0.6)
    g.link(co, mp.inputs['Vector'])
    sc = g.ramp(g.noise(3.0, 4, 0.5, mp.outputs[0]).outputs['Fac'], [(0.62, 0.0), (0.72, 1.0)])
    col = g.mix(g.math('MULTIPLY', sc, 0.5), col, vb.srgb(0x7c776d))
    if burnt:
        col = g.mix(0.75, col, vb.srgb(0x1a1715))
    r = g.mixf(raised, 0.72, 0.42)
    met = g.math('MULTIPLY', raised, 0.6)
    nrm = vb.bump(g, ao, 0.6, 0.004)
    vb.set_bsdf(g, bsdf, col, r, met, nrm)
    return mat

