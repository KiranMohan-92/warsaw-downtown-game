"""Prepare the CC0 scanned shrub (Poly Haven `shrub_02`, 4 variants) as input for the canopy bake.

    python tools/assets/build_shrubs.py [--raw DIR]

Reads tools/assets/raw/polyhaven/models/shrub_02/ (glTF + 1k textures + the leaf mask) and writes
tools/assets/build/shrubs/ (bake input only; nothing here ships):

- shrubs.bin   per variant: float32 positions (xyz), normals (xyz), uvs (uv), uint32 indices; each
               variant recentred on its footprint and normalised to a unit cylinder (footprint
               radius 1, height 1) so the bake can scale and scatter them.
- shrubs.json  byte offsets and counts per variant.
- albedo.png   512 px RGBA: the scan's diffuse (AO folded in) with the leaf mask as alpha.
- normal.jpg   512 px OpenGL normal map.

Deterministic. Next: `node tools/assets/bake_canopy.mjs` (see its header).
"""

import argparse
import json
import struct
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'tools/assets/raw/polyhaven/models/shrub_02'
OUT = ROOT / 'tools/assets/build/shrubs'
SIZE = 512
AO_STRENGTH = 0.5

COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
FORMATS = {5126: 'f', 5125: 'I', 5123: 'H', 5121: 'B'}


def read_accessor(gltf: dict, blob: bytes, index: int) -> list[tuple]:
    acc = gltf['accessors'][index]
    view = gltf['bufferViews'][acc['bufferView']]
    n = COMPONENTS[acc['type']]
    fmt = FORMATS[acc['componentType']]
    size = struct.calcsize(fmt)
    stride = view.get('byteStride', size * n)
    start = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    out = []
    for i in range(acc['count']):
        o = start + i * stride
        out.append(struct.unpack_from(f'<{n}{fmt}', blob, o))
    return out


def variants(raw: Path) -> list[dict]:
    gltf = json.loads((raw / 'shrub_02_1k.gltf').read_text(encoding='utf-8'))
    blob = (raw / gltf['buffers'][0]['uri']).read_bytes()
    result = []
    for node in sorted(gltf['nodes'], key=lambda n: n.get('name', '')):
        if 'mesh' not in node:
            continue
        prim = gltf['meshes'][node['mesh']]['primitives'][0]
        pos = read_accessor(gltf, blob, prim['attributes']['POSITION'])
        nor = read_accessor(gltf, blob, prim['attributes']['NORMAL'])
        uv = read_accessor(gltf, blob, prim['attributes']['TEXCOORD_0'])
        idx = [i[0] for i in read_accessor(gltf, blob, prim['indices'])]
        # Recentre on the footprint and normalise to a unit cylinder (radius 1, height 1).
        xs = [p[0] for p in pos]
        zs = [p[2] for p in pos]
        cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
        y0 = min(p[1] for p in pos)
        h = max(p[1] for p in pos) - y0
        r = max(((p[0] - cx) ** 2 + (p[2] - cz) ** 2) ** 0.5 for p in pos)
        unit = [((p[0] - cx) / r, (p[1] - y0) / h, (p[2] - cz) / r) for p in pos]
        # Normals follow the non-uniform scale (inverse-transpose of diag(1/r, 1/h, 1/r)).
        nn = []
        for n in nor:
            v = (n[0] * r, n[1] * h, n[2] * r)
            ln = sum(c * c for c in v) ** 0.5 or 1.0
            nn.append(tuple(c / ln for c in v))
        result.append({'name': node['name'], 'pos': unit, 'nor': nn, 'uv': uv, 'idx': idx})
    return result


def build(raw: Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    parts = variants(raw)
    blob = bytearray()
    meta = []
    for v in parts:
        entry = {'name': v['name'], 'vertices': len(v['pos']), 'indices': len(v['idx'])}
        for key, fmt, data in (
            ('position', 'fff', v['pos']),
            ('normal', 'fff', v['nor']),
            ('uv', 'ff', v['uv']),
        ):
            entry[key] = len(blob)
            for t in data:
                blob += struct.pack(f'<{fmt}', *t)
        entry['index'] = len(blob)
        blob += struct.pack(f'<{len(v["idx"])}I', *v['idx'])
        meta.append(entry)
    (OUT / 'shrubs.bin').write_bytes(bytes(blob))
    (OUT / 'shrubs.json').write_text(json.dumps({'variants': meta}, indent=2) + '\n', encoding='utf-8', newline='\n')

    tex = raw / 'textures'
    diff = Image.open(tex / 'shrub_02_diff_1k.jpg').convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
    arm = Image.open(tex / 'shrub_02_arm_1k.jpg').convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
    ao = arm.split()[0].point(lambda a: round(255 - (255 - a) * AO_STRENGTH))
    diff = ImageChops.multiply(diff, Image.merge('RGB', (ao, ao, ao)))
    mask = Image.open(tex / 'shrub_02_mask_1k.png').convert('L').resize((SIZE, SIZE), Image.LANCZOS)
    rgba = diff.copy()
    rgba.putalpha(mask)
    rgba.save(OUT / 'albedo.png', optimize=True)
    Image.open(tex / 'shrub_02_nor_gl_1k.jpg').convert('RGB').resize((SIZE, SIZE), Image.LANCZOS).save(
        OUT / 'normal.jpg', quality=88, optimize=True
    )
    total = sum(f.stat().st_size for f in OUT.iterdir())
    tris = sum(m['indices'] // 3 for m in meta)
    print(f'{len(meta)} variants, {tris} triangles, {total / 1e6:.2f} MB in {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', type=Path, default=RAW)
    build(ap.parse_args().raw)
