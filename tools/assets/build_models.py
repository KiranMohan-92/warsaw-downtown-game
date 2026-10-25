"""Build web-ready prop models from the raw Poly Haven (CC0) glTF scans.

    python tools/assets/build_models.py [--raw DIR] [--only ID ...]

Reads tools/assets/raw/polyhaven/models/<source>/ and writes packages/client/public/models/:

- <id>/<id>.gltf + <id>.bin   one mesh, one primitive: the chosen nodes of the scan with their
                               node transforms baked in, recentred (footprint centre at the origin,
                               base at y = 0), simplified to a game budget (decimate.py), uvs
                               remapped into the shared texture atlas. float32 position / normal /
                               uv, uint16 indices.
- atlas_{albedo,normal,arm}.webp     every model's textures, 512 px per model (a 496 px tile with
                                     an 8 px edge-extended gutter, so mipmaps don't bleed), so all
                                     props share ONE material and draw as one batch at run time.
                                     albedo: sRGB colour with the scan's ambient occlusion
                                     multiplied in (AO_STRENGTH; no aoMap needed). normal: OpenGL
                                     convention (what three.js expects). arm: G = roughness,
                                     B = metalness (glTF metallicRoughness), R = 1.
- atlas_*_low.webp                   half-size copies for the Low quality tier.
                                     WebP (tools/assets/webp.py) at the lowest quality as faithful
                                     as the JPEG (q85, normal q90 4:4:4) it replaced; the glTFs
                                     reference it through EXT_texture_webp.
- manifest.json                      atlas layout and each model's source, size and budget.

Deterministic; safe to re-run. Every output is logged in ASSETS.md.
"""

import argparse
import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

import decimate
from webp import save_webp

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'tools/assets/raw/polyhaven/models'
OUT = ROOT / 'packages/client/public/models'

TILE = 512
PAD = 8
COLS = 4
AO_STRENGTH = 0.6
# WebP quality is matched to these JPEG qualities (the pre-WebP encode; tools/assets/webp.py).
QUALITY = 85
NORMAL_QUALITY = 90


@dataclass(frozen=True)
class ModelSpec:
    source: str
    target: int
    """Triangle budget after simplification."""
    nodes: tuple[str, ...] | None = None
    """Node names to keep (None = the whole scene)."""
    tilt_x: float = 0.0
    """Rotation about +X (degrees) before recentring, e.g. to lay a standing tyre flat."""
    retired: bool = False
    """No longer shipped, but its texture set keeps its atlas tile: the shipped meshes' uvs index
    tiles by position, so dropping a spec would shift every later model onto the wrong tile."""


# Game model id -> source scan. The ids are the client's `PropModelId`s (render/propModels.ts).
MODELS: dict[str, ModelSpec] = {
    # Crate cover (shared maps/props.ts `crate`, `cratePile`, `crateSteps`): two crate shapes so
    # the fitter can tile any crate box with little stretching. (wooden_military_crate was tried:
    # its many uv islands stop the simplifier at ~1.7k triangles, too heavy to tile.)
    'crate': ModelSpec('wooden_crate_02', 300),
    'crate_small': ModelSpec('wooden_crate_01', 300),
    # Jersey barrier runs (maps/props.ts `jersey`), tiled along their length.
    'jersey': ModelSpec('concrete_road_barrier', 600),
    # Street dressing (maps/decor.ts).
    'drum': ModelSpec('barrel_03', 500),
    'bin': ModelSpec(
        'metal_trash_can',
        700,
        # The scan's lid leans against the can: left out (an open bin; its footprint stays round).
        ('metal_trash_can', 'metal_trash_can_handle_left', 'metal_trash_can_handle_right'),
    ),
    # Retired 2026-10-01 (Kiran: no hydrants in the Market); kept only to hold its atlas tile.
    'hydrant': ModelSpec(
        'fire_hydrant',
        1500,
        ('fire_hydrant', 'fire_hydrant_cap_01', 'fire_hydrant_cap_02', 'fire_hydrant_cap_03'),
        retired=True,
    ),
    'lamp': ModelSpec('street_lamp_01', 1000),
    'trashbag': ModelSpec('trashbag', 500),
    'tyre': ModelSpec('old_tyre', 400, tilt_x=90),
    'utility_box': ModelSpec('utility_box_01', 300),
    'cardboard_box': ModelSpec('cardboard_box_01', 300),
    # Parked car under a fitted cover (maps/props.ts `car`): a real silhouette and no make or
    # badges to scrub (fictional city).
    'car': ModelSpec('covered_car', 4000),
}

# Painted marks to clone out of a scan's textures (no real-world company marks in game): texture
# file name -> [(x0, y0, x1, y1, dy)] in 1k-texture pixels; each rect is replaced by the rect `dy`
# pixels below it (negative = above: the same plank), with a feathered edge.
SCRUB: dict[str, list[tuple[int, int, int, int, int]]] = {
    # wooden_crate_02: a historic trading-company merchant mark stencilled on both ends.
    'wooden_crate_02': [(18, 733, 150, 864, -123), (242, 743, 378, 874, -123)],
    # Safety labels and stamped numbers: fictional setting, no copied signage.
    'utility_box_01': [(274, 550, 333, 629, 150), (705, 550, 759, 629, 150),
                       (372, 889, 455, 990, -240), (257, 971, 355, 1020, -240)],
}

# ---- glTF reading ----------------------------------------------------------------------------------

_COMPONENT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
_WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_accessor(gltf: dict, buffers: list[bytes], index: int) -> list[tuple]:
    acc = gltf['accessors'][index]
    view = gltf['bufferViews'][acc['bufferView']]
    fmt, size = _COMPONENT[acc['componentType']]
    width = _WIDTH[acc['type']]
    stride = view.get('byteStride', size * width)
    base = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    data = buffers[view['buffer']]
    unpack = struct.Struct('<' + fmt * width).unpack_from
    values = [unpack(data, base + i * stride) for i in range(acc['count'])]
    if acc.get('normalized') and acc['componentType'] != 5126:
        signed = acc['componentType'] in (5120, 5122)
        maximum = 2 ** (size * 8 - int(signed)) - 1
        values = [tuple(max(-1, v / maximum) for v in row) for row in values]
    return values


def transform_uv(info: dict, uv: tuple) -> tuple[float, float]:
    """Bake glTF KHR_texture_transform before mapping to the shared atlas."""
    transform = info.get('extensions', {}).get('KHR_texture_transform', {})
    if transform.get('texCoord', info.get('texCoord', 0)) != 0:
        raise ValueError('Only TEXCOORD_0 is supported by the prop atlas')
    sx, sy = transform.get('scale', (1, 1))
    ox, oy = transform.get('offset', (0, 0))
    rotation = transform.get('rotation', 0)
    c, s = math.cos(rotation), math.sin(rotation)
    u, v = uv[0] * sx, uv[1] * sy
    return c * u - s * v + ox, s * u + c * v + oy


Mat4 = list[float]  # column-major, like glTF


def mat_mul(a: Mat4, b: Mat4) -> Mat4:
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def node_matrix(node: dict) -> Mat4:
    if 'matrix' in node:
        return [float(v) for v in node['matrix']]
    tx, ty, tz = node.get('translation', (0, 0, 0))
    qx, qy, qz, qw = node.get('rotation', (0, 0, 0, 1))
    sx, sy, sz = node.get('scale', (1, 1, 1))
    r = [
        1 - 2 * (qy * qy + qz * qz),
        2 * (qx * qy + qz * qw),
        2 * (qx * qz - qy * qw),
        2 * (qx * qy - qz * qw),
        1 - 2 * (qx * qx + qz * qz),
        2 * (qy * qz + qx * qw),
        2 * (qx * qz + qy * qw),
        2 * (qy * qz - qx * qw),
        1 - 2 * (qx * qx + qy * qy),
    ]
    return [
        r[0] * sx, r[1] * sx, r[2] * sx, 0.0,
        r[3] * sy, r[4] * sy, r[5] * sy, 0.0,
        r[6] * sz, r[7] * sz, r[8] * sz, 0.0,
        tx, ty, tz, 1.0,
    ]  # fmt: skip


def transform_point(m: Mat4, p) -> tuple[float, float, float]:
    return (
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    )


def normal_matrix(m: Mat4) -> list[float]:
    """Inverse-transpose of the upper 3x3 (row-major 3x3 result)."""
    a, b, c = m[0], m[4], m[8]
    d, e, f = m[1], m[5], m[9]
    g, h, i = m[2], m[6], m[10]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    inv = [
        (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
        (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
        (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
    ]  # fmt: skip
    # transpose
    return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]


def transform_normal(n3: list[float], n) -> tuple[float, float, float]:
    x = n3[0] * n[0] + n3[1] * n[1] + n3[2] * n[2]
    y = n3[3] * n[0] + n3[4] * n[1] + n3[5] * n[2]
    z = n3[6] * n[0] + n3[7] * n[1] + n3[8] * n[2]
    ln = math.sqrt(x * x + y * y + z * z) or 1.0
    return (x / ln, y / ln, z / ln)


# ---- atlas -----------------------------------------------------------------------------------------


def tile_uv(tile: int, u: float, v: float, cols: int, rows: int) -> tuple[float, float]:
    """A model uv (0..1, glTF: v down from the image top) → atlas uv for tile `tile`."""
    u = min(1.0, max(0.0, u))
    v = min(1.0, max(0.0, v))
    content = TILE - 2 * PAD
    col, row = tile % cols, tile // cols
    return (
        (col * TILE + PAD + u * content) / (cols * TILE),
        (row * TILE + PAD + v * content) / (rows * TILE),
    )


def gutter(img: Image.Image) -> Image.Image:
    """Resize to the tile's content size and edge-extend PAD px all round (no mip bleeding)."""
    content = TILE - 2 * PAD
    src = img.resize((content, content), Image.Resampling.LANCZOS)
    out = Image.new(img.mode, (TILE, TILE))
    out.paste(src, (PAD, PAD))
    c = content
    out.paste(src.crop((0, 0, c, 1)).resize((c, PAD)), (PAD, 0))
    out.paste(src.crop((0, c - 1, c, c)).resize((c, PAD)), (PAD, PAD + c))
    out.paste(src.crop((0, 0, 1, c)).resize((PAD, c)), (0, PAD))
    out.paste(src.crop((c - 1, 0, c, c)).resize((PAD, c)), (PAD + c, PAD))
    for x, y, px in ((0, 0, (0, 0)), (PAD + c, 0, (c - 1, 0)), (0, PAD + c, (0, c - 1)), (PAD + c, PAD + c, (c - 1, c - 1))):
        out.paste(Image.new(img.mode, (PAD, PAD), src.getpixel(px)), (x, y))
    return out


def scrub(img: Image.Image, rects: list[tuple[int, int, int, int, int]]) -> Image.Image:
    """Clone each rect from `dy` px away (same plank), feathered, at any texture size."""
    out = img.copy()
    k = img.width / 1024
    feather = max(2, round(6 * k))
    for x0, y0, x1, y1, dy in rects:
        box = tuple(round(v * k) for v in (x0, y0, x1, y1))
        w, h = box[2] - box[0], box[3] - box[1]
        src = img.crop((box[0], box[1] + round(dy * k), box[2], box[3] + round(dy * k)))
        mask = Image.new('L', (w, h), 0)
        mask.paste(255, (feather, feather, w - feather, h - feather))
        mask = mask.filter(ImageFilter.GaussianBlur(feather / 2))
        out.paste(src, box[:2], mask)
    return out


def albedo_with_ao(diffuse: Image.Image, arm: Image.Image) -> Image.Image:
    ao = arm.convert('RGB').split()[0].resize(diffuse.size, Image.Resampling.LANCZOS)
    k = AO_STRENGTH
    factor = ao.point(lambda v: round(255 * ((1 - k) + k * v / 255)))
    return ImageChops.multiply(diffuse.convert('RGB'), Image.merge('RGB', (factor, factor, factor)))


def rough_metal(arm: Image.Image) -> Image.Image:
    _, g, b = arm.convert('RGB').split()
    return Image.merge('RGB', (Image.new('L', g.size, 255), g, b))


# ---- one model -----------------------------------------------------------------------------------------


def load_model(raw: Path, spec: ModelSpec, tiles: list[tuple[Path, Path, Path]], cols: int, rows: int):
    """Collect the chosen nodes' triangles in atlas uv space (tiles are appended as found)."""
    d = raw / spec.source
    gltf_path = next(d.glob('*.gltf'))
    gltf = json.loads(gltf_path.read_text(encoding='utf-8'))
    buffers = [(d / b['uri']).read_bytes() for b in gltf['buffers']]

    def tex_path(info: dict | None) -> Path:
        if info is None:
            raise ValueError(f'{spec.source}: material without a texture')
        return d / gltf['images'][gltf['textures'][info['index']]['source']]['uri']

    def tile_of(mat_index: int) -> int:
        m = gltf['materials'][mat_index]
        pbr = m['pbrMetallicRoughness']
        key = (tex_path(pbr.get('baseColorTexture')), tex_path(m.get('normalTexture')), tex_path(pbr.get('metallicRoughnessTexture')))
        if key not in tiles:
            tiles.append(key)
        return tiles.index(key)

    verts: list[tuple] = []
    tris: list[tuple[int, int, int]] = []
    kept: list[str] = []

    def visit(ni: int, parent: Mat4) -> None:
        node = gltf['nodes'][ni]
        m = mat_mul(parent, node_matrix(node))
        if 'mesh' in node and (spec.nodes is None or node.get('name') in spec.nodes):
            kept.append(node.get('name', str(ni)))
            n3 = normal_matrix(m)
            for prim in gltf['meshes'][node['mesh']]['primitives']:
                tile = tile_of(prim['material'])
                material = gltf['materials'][prim['material']]
                pbr = material['pbrMetallicRoughness']
                texture_infos = [pbr['baseColorTexture'], material['normalTexture'], pbr['metallicRoughnessTexture']]
                # A single atlas UV cannot represent independently transformed PBR maps.
                transforms = [[transform_uv(info, point) for point in ((0, 0), (1, 0), (0, 1))] for info in texture_infos]
                if not all(t == transforms[0] for t in transforms):
                    raise ValueError(f'{spec.source}: inconsistent PBR texture transforms')
                a = prim['attributes']
                p = read_accessor(gltf, buffers, a['POSITION'])
                n = read_accessor(gltf, buffers, a['NORMAL'])
                uv = read_accessor(gltf, buffers, a['TEXCOORD_0'])
                idx = [i[0] for i in read_accessor(gltf, buffers, prim['indices'])]
                base = len(verts)
                for k in range(len(p)):
                    x, y, z = transform_point(m, p[k])
                    nx, ny, nz = transform_normal(n3, n[k])
                    u0, v0 = transform_uv(texture_infos[0], uv[k])
                    u, v = tile_uv(tile, u0, v0, cols, rows)
                    verts.append((x, y, z, nx, ny, nz, u, v))
                for k in range(0, len(idx) - 2, 3):
                    tris.append((base + idx[k], base + idx[k + 1], base + idx[k + 2]))
        for c in node.get('children', []):
            visit(c, m)

    c, s_ = math.cos(math.radians(spec.tilt_x)), math.sin(math.radians(spec.tilt_x))
    identity = [1.0, 0, 0, 0, 0, c, s_, 0, 0, -s_, c, 0, 0, 0, 0, 1.0]
    for ni in gltf['scenes'][gltf.get('scene', 0)]['nodes']:
        visit(ni, identity)
    if spec.nodes is not None and sorted(kept) != sorted(spec.nodes):
        raise ValueError(f'{spec.source}: expected nodes {spec.nodes}, found {kept}')
    return verts, tris


def recentre(verts: list[tuple]) -> tuple[list[tuple], list[float]]:
    """Footprint centre to the origin, base to y = 0. Returns the vertices and the bbox size."""
    lo = [min(v[i] for v in verts) for i in range(3)]
    hi = [max(v[i] for v in verts) for i in range(3)]
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    out = [(v[0] - cx, v[1] - lo[1], v[2] - cz, *v[3:]) for v in verts]
    return out, [hi[i] - lo[i] for i in range(3)]


def gltf_json(model_id: str, verts: list[tuple], tris: list[tuple[int, int, int]]) -> tuple[dict, bytes]:
    n = len(verts)
    if n > 65535:
        raise ValueError(f'{model_id}: {n} vertices (uint16 indices)')
    pos = b''.join(struct.pack('<3f', *v[0:3]) for v in verts)
    nrm = b''.join(struct.pack('<3f', *v[3:6]) for v in verts)
    uv = b''.join(struct.pack('<2f', *v[6:8]) for v in verts)
    idx = b''.join(struct.pack('<3H', *t) for t in tris)
    idx += b'\0' * (-len(idx) % 4)
    views = []
    blob = b''
    for chunk, target in ((pos, 34962), (nrm, 34962), (uv, 34962), (idx, 34963)):
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(chunk), 'target': target})
        blob += chunk
    views[3]['byteLength'] = len(tris) * 6
    lo = [min(v[i] for v in verts) for i in range(3)]
    hi = [max(v[i] for v in verts) for i in range(3)]
    doc = {
        'asset': {'version': '2.0', 'generator': 'warsaw-downtown tools/assets/build_models.py'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': model_id}],
        'meshes': [
            {
                'name': model_id,
                'primitives': [
                    {'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2}, 'indices': 3, 'material': 0}
                ],
            }
        ],
        'materials': [
            {
                'name': 'props_atlas',
                'doubleSided': True,
                'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicRoughnessTexture': {'index': 2}},
                'normalTexture': {'index': 1},
            }
        ],
        'extensionsUsed': ['EXT_texture_webp'],
        'extensionsRequired': ['EXT_texture_webp'],
        'textures': [{'sampler': 0, 'extensions': {'EXT_texture_webp': {'source': i}}} for i in range(3)],
        'images': [{'uri': f'../atlas_{m}.webp'} for m in ('albedo', 'normal', 'arm')],
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
        'buffers': [{'uri': f'{model_id}.bin', 'byteLength': len(blob)}],
        'bufferViews': views,
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': n, 'type': 'VEC3', 'min': lo, 'max': hi},
            {'bufferView': 1, 'componentType': 5126, 'count': n, 'type': 'VEC3'},
            {'bufferView': 2, 'componentType': 5126, 'count': n, 'type': 'VEC2'},
            {'bufferView': 3, 'componentType': 5123, 'count': len(tris) * 3, 'type': 'SCALAR'},
        ],
    }
    return doc, blob


def build_atlas(tiles: list[tuple[Path, Path, Path]], cols: int, rows: int) -> dict[str, Image.Image]:
    size = (cols * TILE, rows * TILE)
    out = {m: Image.new('RGB', size, (128, 128, 255) if m == 'normal' else (128, 128, 128)) for m in ('albedo', 'normal', 'arm')}
    for t, (diff, nor, arm) in enumerate(tiles):
        at = ((t % cols) * TILE, (t // cols) * TILE)
        rects = SCRUB.get(diff.parent.parent.name, [])
        diff_img, nor_img, arm_img = (scrub(Image.open(p).convert('RGB'), rects) for p in (diff, nor, arm))
        out['albedo'].paste(gutter(albedo_with_ao(diff_img, arm_img)), at)
        out['normal'].paste(gutter(nor_img), at)
        out['arm'].paste(gutter(rough_metal(arm_img)), at)
    return out


def json_text(value, indent: int = 0, prefix: int = 0) -> str:
    """JSON laid out the way prettier formats it (format:check covers public/): objects expanded,
    arrays of scalars on one line when the whole line fits in 100 columns. `prefix`: columns
    already used on the value's line."""
    pad = '  ' * indent
    if isinstance(value, dict):
        if not value:
            return '{}'
        items = []
        for k, v in value.items():
            head = f'{pad}  {json.dumps(k)}: '
            items.append(head + json_text(v, indent + 1, len(head)))
        return '{\n' + ',\n'.join(items) + '\n' + pad + '}'
    if isinstance(value, list):
        if not value:
            return '[]'
        if all(not isinstance(v, (dict, list)) for v in value):
            line = '[' + ', '.join(json.dumps(v) for v in value) + ']'
            if prefix + len(line) + 1 <= 100:  # + trailing comma
                return line
        items = [f'{pad}  {json_text(v, indent + 1, len(pad) + 2)}' for v in value]
        return '[\n' + ',\n'.join(items) + '\n' + pad + ']'
    return json.dumps(value)


def write_json(path: Path, value) -> None:
    path.write_text(json_text(value) + '\n', encoding='utf-8', newline='\n')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--raw', type=Path, default=RAW, help='folder with the Poly Haven model folders')
    ap.add_argument('--only', nargs='*', help='rebuild just these models (the atlas is always rebuilt)')
    args = ap.parse_args()

    # Pass 1: count tiles (one per distinct texture set) to size the atlas.
    tiles: list[tuple[Path, Path, Path]] = []
    loaded = {mid: load_model(args.raw, spec, tiles, COLS, 1) for mid, spec in MODELS.items()}
    rows = math.ceil(len(tiles) / COLS)
    # Pass 2: reload with the final row count (uvs depend on the atlas height).
    tiles = []
    loaded = {mid: load_model(args.raw, spec, tiles, COLS, rows) for mid, spec in MODELS.items()}

    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict = {
        'atlas': {'tile': TILE, 'pad': PAD, 'cols': COLS, 'rows': rows, 'width': COLS * TILE, 'height': rows * TILE},
        'models': {},
    }
    old = OUT / 'manifest.json'
    if args.only and old.exists():
        manifest['models'] = json.loads(old.read_text(encoding='utf-8'))['models']
    for mid, (verts, tris) in loaded.items():
        spec = MODELS[mid]
        if spec.retired or (args.only and mid not in args.only):
            continue
        before = len(tris)
        verts, tris = decimate.simplify(verts, tris, spec.target)
        # Recentre what survived (the simplifier keeps a subset of the scan's vertices).
        verts, size = recentre(verts)
        doc, blob = gltf_json(mid, verts, tris)
        folder = OUT / mid
        folder.mkdir(exist_ok=True)
        (folder / f'{mid}.bin').write_bytes(blob)
        write_json(folder / f'{mid}.gltf', doc)
        manifest['models'][mid] = {
            'source': spec.source,
            'triangles': len(tris),
            'vertices': len(verts),
            'size': [round(s, 4) for s in size],
        }
        print(f'{mid:15s} {spec.source:24s} {before:6d} -> {len(tris):5d} tris, {len(verts):5d} verts, size {[round(s, 3) for s in size]}')

    atlas = build_atlas(tiles, COLS, rows)
    for name, img in atlas.items():
        q = NORMAL_QUALITY if name == 'normal' else QUALITY
        sub = 0 if name == 'normal' else 2
        kind = 'color' if name == 'albedo' else 'data'
        save_webp(img, OUT / f'atlas_{name}.webp', kind, match_jpeg=q, subsampling=sub)
        low = img.resize((img.width // 2, img.height // 2), Image.Resampling.LANCZOS)
        save_webp(low, OUT / f'atlas_{name}_low.webp', kind, match_jpeg=q, subsampling=sub)
    manifest['tiles'] = [str(t[0].parent.parent.name) for t in tiles]
    write_json(OUT / 'manifest.json', manifest)
    total = sum(f.stat().st_size for f in OUT.rglob('*') if f.is_file())
    from build_prop_collision import build as build_collision
    build_collision()
    print(f'{len(tiles)} atlas tiles ({COLS}x{rows}), total {total / 1e6:.2f} MB in {OUT}')


if __name__ == '__main__':
    main()
