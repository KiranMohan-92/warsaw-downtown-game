"""Build the generated hero models (Higgsfield/Tripo, Kiran-approved) for the Market.

    python tools/assets/build_heroes.py [--raw DIR]

Reads tools/assets/raw/higgsfield/<source>.glb (one textured PBR mesh each, as generated) and
writes packages/client/public/models/heroes/:

- <id>.gltf + <id>.bin   the mesh recentred (footprint centre at the origin, base at y = 0),
                         turned so its length runs along +X, simplified to a budget
                         (decimate.py). float32 position/normal/uv, uint16/uint32 indices.
- <id>_{albedo,normal,arm}.webp (1024 px) and _low (512 px): own textures (hero models are
                         seen up close; the shared 512 px prop atlas tile would be too soft).
                         arm = glTF metallicRoughness (G roughness, B metalness). WebP at
                         the lowest quality as faithful as the old JPEG (tools/assets/webp.py).
- heroes.json            per model: source, triangles, bbox size and `body` — the size of the
                         solid body without thin overhangs (awnings, rotors), which the map's
                         collision box for the model uses.

Render-only: the map keeps a collision box per hero (shared maps/props.ts); nothing here feeds
the sim. Deterministic; every output is logged in ASSETS.md.
"""

import argparse
import io
import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

import decimate
from webp import save_webp
from build_models import json_text

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'tools/assets/raw/higgsfield'
OUT = ROOT / 'packages/client/public/models/heroes'
SIZE = 1024
LOW = 512


@dataclass(frozen=True)
class HeroSpec:
    source: str
    target: int
    """Triangle budget after simplification."""
    far: int = 800
    """Triangle budget of the far LOD (`<id>_far.gltf`: same frame, uvs and textures)."""
    yaw: float = 0.0
    """Extra rotation about +Y (degrees) after the automatic alignment (e.g. 180 to flip)."""
    body_band: tuple[float, float] = (0.15, 0.8)
    """Height band (fraction of the model's height) whose footprint is the solid body."""
    auto_align: bool = True
    """Principal-axis alignment (off for near-square footprints, where the axis is arbitrary)."""


HEROES: dict[str, HeroSpec] = {
    # Wrecks are common across the city (cover fill): a lighter near mesh.
    'burnt_car': HeroSpec('burnt_car', 4000, far=600),
    # Serving hatch and its propped awning on +Z (the awning is a thin overhang, not body).
    'food_truck': HeroSpec('food_truck', 6000, far=900, body_band=(0.15, 0.7)),
    'kiosk': HeroSpec('kiosk', 6000, far=700, body_band=(0.1, 0.6), auto_align=False),
    # Medkit pickup (a small prop, drawn by render/pickupView.ts, not a map body).
    'medkit': HeroSpec('medkit', 3000, far=400, body_band=(0.05, 0.9), auto_align=False),
}


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    json_len = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20 : 20 + json_len])
    bin_off = 20 + json_len
    bin_len = struct.unpack_from('<I', data, bin_off)[0]
    return doc, data[bin_off + 8 : bin_off + 8 + bin_len]


_FMT = {5126: ('f', 4), 5125: ('I', 4), 5123: ('H', 2), 5121: ('B', 1)}
_N = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def accessor(doc: dict, blob: bytes, i: int) -> list[tuple]:
    a = doc['accessors'][i]
    v = doc['bufferViews'][a['bufferView']]
    fmt, size = _FMT[a['componentType']]
    n = _N[a['type']]
    stride = v.get('byteStride', size * n)
    base = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    unpack = struct.Struct('<' + fmt * n).unpack_from
    return [unpack(blob, base + k * stride) for k in range(a['count'])]


def image(doc: dict, blob: bytes, i: int) -> Image.Image:
    v = doc['bufferViews'][doc['images'][i]['bufferView']]
    raw = blob[v.get('byteOffset', 0) : v.get('byteOffset', 0) + v['byteLength']]
    return Image.open(io.BytesIO(raw))


def body_size(verts: list[tuple], band: tuple[float, float]) -> list[float]:
    """Footprint of the vertices inside a height band (2nd–98th percentile), full height."""
    h = max(v[1] for v in verts)
    inside = [v for v in verts if band[0] * h <= v[1] <= band[1] * h]
    def span(k: int) -> float:
        xs = sorted(v[k] for v in inside)
        return xs[int(len(xs) * 0.98)] - xs[int(len(xs) * 0.02)]
    return [round(span(0), 3), round(h, 3), round(span(2), 3)]


def gltf(mid: str, verts: list[tuple], tris: list[tuple[int, int, int]]) -> tuple[dict, bytes]:
    big = len(verts) > 65535
    pos = b''.join(struct.pack('<3f', *v[0:3]) for v in verts)
    nrm = b''.join(struct.pack('<3f', *v[3:6]) for v in verts)
    uv = b''.join(struct.pack('<2f', *v[6:8]) for v in verts)
    idx = b''.join(struct.pack('<3I' if big else '<3H', *t) for t in tris)
    idx_len = len(idx)
    idx += b'\0' * (-len(idx) % 4)
    views, blob = [], b''
    for chunk, target in ((pos, 34962), (nrm, 34962), (uv, 34962), (idx, 34963)):
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(chunk), 'target': target})
        blob += chunk
    views[3]['byteLength'] = idx_len
    lo = [min(v[i] for v in verts) for i in range(3)]
    hi = [max(v[i] for v in verts) for i in range(3)]
    doc = {
        'asset': {'version': '2.0', 'generator': 'warsaw-downtown tools/assets/build_heroes.py'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': mid}],
        'meshes': [{'name': mid, 'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2}, 'indices': 3}]}],
        'buffers': [{'uri': f'{mid}.bin', 'byteLength': len(blob)}],
        'bufferViews': views,
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': len(verts), 'type': 'VEC3', 'min': lo, 'max': hi},
            {'bufferView': 1, 'componentType': 5126, 'count': len(verts), 'type': 'VEC3'},
            {'bufferView': 2, 'componentType': 5126, 'count': len(verts), 'type': 'VEC2'},
            {'bufferView': 3, 'componentType': 5125 if big else 5123, 'count': len(tris) * 3, 'type': 'SCALAR'},
        ],
    }
    return doc, blob


def build(raw: Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict = {'models': {}}
    for mid, spec in HEROES.items():
        doc, blob = read_glb(raw / f'{spec.source}.glb')
        prim = doc['meshes'][0]['primitives'][0]
        pos = accessor(doc, blob, prim['attributes']['POSITION'])
        nor = accessor(doc, blob, prim['attributes']['NORMAL'])
        uvs = accessor(doc, blob, prim['attributes']['TEXCOORD_0'])
        idx = [i[0] for i in accessor(doc, blob, prim['indices'])]
        # Tripo stores a unit mesh under a uniform node scale (auto_size = metres).
        node = doc['nodes'][0]
        k = node['matrix'][0] if 'matrix' in node else node.get('scale', [1, 1, 1])[0]
        pos = [(p[0] * k, p[1] * k, p[2] * k) for p in pos]
        # Generated meshes can sit at any heading: align the body footprint's principal axis
        # (the length) with +X, then apply the spec's extra yaw.
        h = max(p[1] for p in pos) - min(p[1] for p in pos)
        y0 = min(p[1] for p in pos)
        band = [p for p in pos if spec.body_band[0] * h <= p[1] - y0 <= spec.body_band[1] * h]
        mx = sum(p[0] for p in band) / len(band)
        mz = sum(p[2] for p in band) / len(band)
        sxx = sum((p[0] - mx) ** 2 for p in band)
        szz = sum((p[2] - mz) ** 2 for p in band)
        sxz = sum((p[0] - mx) * (p[2] - mz) for p in band)
        axis = 0.5 * math.atan2(2 * sxz, sxx - szz)  # angle of the major axis from +X
        yaw = (math.degrees(axis) if spec.auto_align else 0.0) + spec.yaw
        c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
        rot = lambda x, z: (x * c + z * s, -x * s + z * c)  # noqa: E731
        verts = []
        for p, n, t in zip(pos, nor, uvs):
            px, pz = rot(p[0], p[2])
            nx, nz = rot(n[0], n[2])
            verts.append((px, p[1], pz, nx, n[1], nz, t[0], t[1]))
        tris = [tuple(idx[k : k + 3]) for k in range(0, len(idx), 3)]
        before = len(tris)
        verts, tris = decimate.simplify(verts, tris, spec.target)
        lo = [min(v[i] for v in verts) for i in range(3)]
        hi = [max(v[i] for v in verts) for i in range(3)]
        cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
        verts = [(v[0] - cx, v[1] - lo[1], v[2] - cz, *v[3:]) for v in verts]
        size = [round(hi[i] - lo[i], 4) for i in range(3)]
        gdoc, gblob = gltf(mid, verts, tris)
        (OUT / f'{mid}.bin').write_bytes(gblob)
        (OUT / f'{mid}.gltf').write_text(json_text(gdoc) + '\n', encoding='utf-8', newline='\n')
        # Far LOD from the near mesh (already recentred: both share one frame).
        fverts, ftris = decimate.simplify(verts, tris, spec.far)
        fdoc, fblob = gltf(f'{mid}_far', fverts, ftris)
        (OUT / f'{mid}_far.bin').write_bytes(fblob)
        (OUT / f'{mid}_far.gltf').write_text(json_text(fdoc) + '\n', encoding='utf-8', newline='\n')
        mat = doc['materials'][prim.get('material', 0)]
        pbr = mat['pbrMetallicRoughness']
        tex = lambda info: doc['textures'][info['index']]['source']  # noqa: E731
        maps = {
            'albedo': image(doc, blob, tex(pbr['baseColorTexture'])).convert('RGB'),
            'arm': image(doc, blob, tex(pbr['metallicRoughnessTexture'])).convert('RGB'),
            'normal': image(doc, blob, tex(mat['normalTexture'])).convert('RGB'),
        }
        for name, img in maps.items():
            q = 90 if name == 'normal' else 85
            for suffix, px in (('', SIZE), ('_low', LOW)):
                save_webp(
                    img.resize((px, px), Image.Resampling.LANCZOS),
                    OUT / f'{mid}_{name}{suffix}.webp',
                    'color' if name == 'albedo' else 'data',
                    match_jpeg=q,
                    subsampling=0 if name == 'normal' else 2,
                )
        body = body_size(verts, spec.body_band)
        manifest['models'][mid] = {
            'source': spec.source,
            'triangles': len(tris),
            'farTriangles': len(ftris),
            'size': size,
            'body': body,
        }
        print(f'{mid:12s} {before:6d} -> {len(tris):5d} tris (far {len(ftris)})  size {size}  body {body}')
    (OUT / 'heroes.json').write_text(json_text(manifest) + '\n', encoding='utf-8', newline='\n')
    total = sum(f.stat().st_size for f in OUT.iterdir())
    print(f'{len(HEROES)} heroes, {total / 1e6:.2f} MB in {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', type=Path, default=RAW)
    build(ap.parse_args().raw)
