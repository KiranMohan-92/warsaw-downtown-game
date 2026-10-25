"""Surface-only armoured wreck bake: keep the approved shape and panel atlas.

Called by rebake_model.py --surface-only. No raw scan or generated imagery is needed. The existing
near/far vertices, normals, UVs and triangle order are retained exactly. Damage is composed from
geometry masks and a fresh AO bake; both LODs share one material. Collision is not built.
"""

import json
import math
import struct
from pathlib import Path


def surface_mesh(vertices, faces):
    """Canonical, connected mesh without moving vertices or dropping even degenerate faces."""
    points = sorted({tuple(v[:3]) for v in vertices})
    ids = {p: i for i, p in enumerate(points)}
    triangles = []
    for face in faces:
        t = tuple(ids[tuple(vertices[i][:3])] for i in face)
        triangles.append(min(t, t[1:] + t[:1], t[2:] + t[:2]))
    return points, sorted(triangles)


def surface_kind(p):
    """Measured tyre envelopes in the static scan's game frame (+X front); no runtime use."""
    x, y, z = p
    if 0.65 < abs(z) < 1.08:
        radius = min(math.hypot(x - axle, y - 0.45) for axle in (-1.42, 1.57))
        if radius < 0.46:
            return 'rim' if radius < 0.24 else 'rubber'
    return 'hull'


def read_surface(path):
    from vehicle_contract import load, positions
    doc, blob = load(path)
    prim = doc['meshes'][0]['primitives'][0]
    a = doc['accessors'][prim['indices']]
    v = doc['bufferViews'][a['bufferView']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    code = {5123: 'H', 5125: 'I'}[a['componentType']]
    ids = struct.unpack_from('<' + code * a['count'], blob, start)
    return surface_mesh(positions(doc, blob, 0), list(zip(ids[::3], ids[1::3], ids[2::3])))


def _bake_mesh(name, rows, faces):
    """Recreate the approved UVs and split normals without re-unwrapping or simplifying."""
    import bpy
    import vehicle_bpy as vb
    me = bpy.data.meshes.new(name)
    me.from_pydata([(r[0], -r[2], r[1]) for r in rows], [], faces)
    me.update()
    me.shade_smooth()
    me.normals_split_custom_set_from_vertices([(r[3], -r[5], r[4]) for r in rows])
    uv = me.uv_layers.new(name='UVMap')
    for loop in me.loops:
        row = rows[loop.vertex_index]
        uv.data[loop.index].uv = (row[6], 1-row[7])
    obj = bpy.data.objects.new(name, me)
    vb.collection(name).objects.link(obj)
    return obj


def _image(name, array, data=True):
    import numpy as np
    import vehicle_bpy as vb
    if array.ndim == 2:
        array = np.repeat(array[..., None], 3, axis=-1)
    rgba = np.concatenate((array, np.ones((*array.shape[:2], 1))), axis=-1)
    img = vb.new_image(name, len(array), data=data)
    img.pixels.foreach_set(np.flipud(rgba).astype(np.float32).ravel())
    img.update()
    return img


def rebuild(cfg, out_dir: Path):
    import bpy
    import numpy as np
    import build_vehicles as bv
    import vehicle_bpy as vb
    import vehicle_mats as vm
    from package_vehicles import read_wreck
    from raw_models import MODELS, raw_model
    from wreck_weathering import geometry_maps, weather_surface, dilate

    mid = cfg['id']
    if mid != 'armoured_wreck' or cfg.get('contract'):
        raise ValueError('--surface-only is for the static armoured wreck')
    pending = out_dir / 'surface_pending'
    pending.write_text('Surface bake in progress; do not package.\n', encoding='utf-8')
    (out_dir / 'surface_meshes.json').unlink(missing_ok=True)
    meshes = [read_wreck(raw_model(MODELS / f'vehicles/{mid}{suffix}.gltf'),
                        node=f'{mid}{suffix}') for suffix in ('', '_far')]
    vb.reset_scene()
    obj = _bake_mesh('wreck', *meshes[0])
    mat, g, bsdf = vb.principled('surface')
    obj.data.materials.append(mat)
    size = cfg.get('size', 2048)
    # A fresh AO bake drives grime/corrosion; never multiply it into the final albedo again.
    ao_image = vb.new_image('cavity', size)
    vb.bake_pass(obj, [], 'AO', ao_image, samples=16)
    ao = np.flipud(np.array(ao_image.pixels[:]).reshape(size, size, 4))[..., 0]
    print('surface baked cavity', flush=True)
    maps = geometry_maps(*meshes[0], size)
    surface = weather_surface(maps, ao)
    np.savez_compressed(out_dir / 'surface_masks.npz', **maps, ao=ao,
                        **{k: surface[k] for k in ('rust', 'soot', 'steel', 'paint')})

    # Only the relief goes through Cycles: it transforms flaking/pitting into the existing
    # tangent normal map correctly across rotated atlas islands and mirrored scan panels.
    relief = dilate(np.clip(surface['height']/0.006+0.5, 0, 1), maps['valid'])
    height_image = _image('flaking_pitting', relief)
    tex = g('ShaderNodeTexImage')
    tex.image = height_image
    # Modest relief amplification keeps pits visible after the 512-tier downsample.
    normal = vb.bump(g, tex.outputs['Color'], 1.0, 0.009)
    g.link(normal, bsdf.inputs['Normal'])
    normal_image = vb.new_image('surface_normal', size)
    vb.bake_pass(obj, [], 'NORMAL', normal_image, samples=4)
    nrm = np.flipud(np.array(normal_image.pixels[:]).reshape(size, size, 4))[..., :3]
    print('surface baked normal', flush=True)

    orm = np.stack((ao, surface['roughness'], surface['metal']), axis=-1)
    images = {}
    for key, pixels, data in (('albedo', surface['albedo'], False), ('orm', orm, True),
                               ('normal', nrm, True)):
        pixels = dilate(pixels, maps['valid'])
        if key == 'normal':
            direction = pixels*2-1
            direction /= np.maximum(np.linalg.norm(direction, axis=-1, keepdims=True), 1e-8)
            pixels = direction*0.5+0.5
        img = _image(f'{mid}_{key}', pixels, data)
        vb.save_png(img, out_dir / f'{mid}_{key}_2k.png')
        img.scale(cfg.get('out_size', 1024), cfg.get('out_size', 1024))
        vb.save_png(img, out_dir / f'{mid}_{key}.png')
        images[key] = img
    obj.data.materials.clear()
    material = vm.textured(mid, images['albedo'], images['orm'], images['normal'])
    obj.data.materials.append(material)
    far = _bake_mesh('far', *meshes[1])
    far.data.materials.append(material)
    obj['export_name'] = far['export_name'] = 'wreck'
    bv.write_outputs(mid, [obj], [far], out_dir, body_name='wreck')
    # Package the original rows: geometry, split normals, UVs and triangle order stay exact.
    (out_dir / 'surface_meshes.json').write_text(json.dumps({**dict(zip(('near', 'far'), meshes)),
                                                          'preserve_geometry': True}),
                                               encoding='utf-8')
    pending.unlink()
    print('SURFACE', mid, len(meshes[0][1]), 'near,', len(meshes[1][1]), 'far', flush=True)
