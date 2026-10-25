"""Package the re-baked vehicles for the client (system Python).

    python tools/assets/package_vehicles.py [--only armoured_wreck]  # then: pnpm assets:pack

Reads the Blender output of rebake_model.py (tools/assets/build/vehicles/<id>/: <id>.gltf and
<id>_far.gltf, the `wreck` node, plus the 2k/1k albedo/ORM/normal PNGs) and writes
packages/client/public/models/vehicles/:

- <id>.gltf/.bin, <id>_far.gltf/.bin  one primitive each (float32 position/normal/uv, uint16/32
  indices), no materials/images (the client binds its own textures, render/heroModels.ts);
- <id>_{albedo,normal,arm}.webp (1024 px) and _low (512 px); arm = the baked ORM (R AO,
  G roughness, B metalness) — the hero material reads G/B;
- vehicles.json: per model its source credit, triangles and bounding size.

The models stay in the prop's local frame (the map's anchor box carries the placement).

The drivable truck and its destroyed variant (`TRUCKS`) ship differently: one self-contained
`truck.glb` / `truck_wreck.glb` each (the vehicle lane's client loads the file as is and uses its
own materials), with every contract node (body, wheels, seat/exit empties) and the baked maps
embedded as WebP (EXT_texture_webp) at 1024 px.
"""

import json
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BUILD = HERE / 'build/vehicles'
OUT = ROOT / 'packages/client/public/models/vehicles'
SIZE, LOW = 1024, 512

MODELS = {
    'heli_wreck': {
        'title': 'Military Helicopter Blackhawk Gameready', 'author': 'Vavtrudner', 'license': 'CC BY 4.0',
        'url': 'https://sketchfab.com/3d-models/military-helicopter-blackhawk-gameready-ef68553cd30a420d8b62b22affb545e6',
        'changes': 'decimated, crashed (tail snapped, rotor broken, doors opened), burnt and re-textured, markings removed',
    },
    'tank_wreck': {
        'title': 'Leopard 2 A6', 'author': 'buh-late', 'license': 'CC BY 4.0',
        'url': 'https://sketchfab.com/3d-models/leopard-2-a6-7cb23d5322df4b409a880de635826067',
        'changes': 'decimated, wrecked (turret knocked off its ring, dents, sag, burn, debris), re-textured with our burnt bake (no markings)',
    },
    'armoured_wreck': {
        'title': 'Armoured Truck - Wrecked', 'author': 'robertmasiboda', 'license': 'CC BY 4.0',
        'url': 'https://sketchfab.com/3d-models/armoured-truck-wrecked-47fd963028384551b96d859cc2162927',
        'changes': 'decimated, re-baked, a national-colours label painted out of the scan texture',
    },
}

TRUCK_SOURCE = {
    'title': '[Free] Armored Police Vehicle', 'author': 'Roam_Man', 'license': 'CC BY 4.0',
    'url': 'https://sketchfab.com/3d-models/free-armored-police-vehicle-9aea4465dc974c728b6167eac5ffd22e',
}
TRUCKS = {
    'truck': 'cut into an open-bed technical (rear cab and box removed, bed, walls and bench added), police '
             'lights/markings removed, repainted military with our texture library + bake, fitted to the truck contract',
    'truck_wreck': 'the truck cut, burnt (our burnt bake), dented, glass gone',
}

_FMT = {5126: ('f', 4), 5125: ('I', 4), 5123: ('H', 2), 5121: ('B', 1)}
_N = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def accessor(doc, blob, i):
    a = doc['accessors'][i]
    v = doc['bufferViews'][a['bufferView']]
    fmt, size = _FMT[a['componentType']]
    n = _N[a['type']]
    stride = v.get('byteStride', size * n)
    base = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    unpack = struct.Struct('<' + fmt * n).unpack_from
    return [unpack(blob, base + k * stride) for k in range(a['count'])]


def read_wreck(path: Path, node='wreck'):
    """The named node's mesh, all primitives merged: [(px,py,pz,nx,ny,nz,u,v)], [(a,b,c)]."""
    doc = json.loads(path.read_text(encoding='utf-8'))
    blob = (path.parent / doc['buffers'][0]['uri']).read_bytes()
    n = next(n for n in doc['nodes'] if n.get('name') == node)
    verts, tris = [], []
    for prim in doc['meshes'][n['mesh']]['primitives']:
        at = prim['attributes']
        pos = accessor(doc, blob, at['POSITION'])
        nor = accessor(doc, blob, at['NORMAL'])
        uv = accessor(doc, blob, at['TEXCOORD_0'])
        idx = [i[0] for i in accessor(doc, blob, prim['indices'])]
        base = len(verts)
        verts += [(*p, *q, *t) for p, q, t in zip(pos, nor, uv)]
        tris += [(base + idx[k], base + idx[k + 1], base + idx[k + 2]) for k in range(0, len(idx), 3)]
    return verts, tris


def package(mid: str) -> dict:
    # Keep the glTF reader usable in Blender's Python, which does not ship Pillow.
    from PIL import Image
    from build_heroes import gltf as write_gltf
    from build_models import json_text
    from webp import save_webp

    src = BUILD / mid
    info = {}
    if (src / 'surface_pending').exists():
        raise SystemExit(f'{mid}: surface rebuild incomplete; rerun --surface-only before packaging')
    surface = src / 'surface_meshes.json'
    exact = json.loads(surface.read_text(encoding='utf-8')) if surface.exists() else None
    meshes = [exact[key] if exact else read_wreck(src / f'{mid}{suffix}.gltf')
              for key, suffix in (('near', ''), ('far', '_far'))]
    preserve = exact and exact.get('preserve_geometry', False)
    if preserve:
        from raw_models import raw_model
        for suffix, (vertices, faces) in zip(('', '_far'), meshes):
            shipped = read_wreck(raw_model(OUT / f'{mid}{suffix}.gltf'), node=f'{mid}{suffix}')
            if any(len(a) != len(b) or any(tuple(x) != tuple(y) for x, y in zip(a, b))
                   for a, b in zip(shipped, (vertices, faces))):
                raise SystemExit(f'{mid}: shipped geometry changed since the surface bake')
    maps = [('albedo', 'albedo', 'color', 85), ('normal', 'normal', 'data', 90), ('arm', 'orm', 'data', 85)]
    images = {}
    # Check every bake input before replacing any shipped mesh or texture.
    for ours, theirs, _, _ in maps:
        path = src / f'{mid}_{theirs}_2k.png'
        if path.stat().st_mtime < (src / f'{mid}.gltf').stat().st_mtime - 120:
            raise SystemExit(f'{mid}: {theirs} map is older than the mesh (stale bake)')
        images[ours] = Image.open(path).convert('RGB')
    for (lod, name), (verts, tris) in zip((('', mid), ('_far', f'{mid}_far')), meshes):
        if not preserve:
            doc, blob = write_gltf(name, verts, tris)
            doc['asset']['generator'] = 'warsaw-downtown tools/assets/package_vehicles.py'
            (OUT / f'{name}.bin').write_bytes(blob)
            (OUT / f'{name}.gltf').write_text(json_text(doc) + '\n', encoding='utf-8', newline='\n')
        info['triangles' if not lod else 'farTriangles'] = len(tris)
        if not lod:
            lo = [min(v[i] for v in verts) for i in range(3)]
            hi = [max(v[i] for v in verts) for i in range(3)]
            info['size'] = [round(hi[i] - lo[i], 3) for i in range(3)]
    for ours, _, kind, q in maps:
        img = images[ours]
        for suffix, px in (('', SIZE), ('_low', LOW)):
            save_webp(img.resize((px, px), Image.Resampling.LANCZOS), OUT / f'{mid}_{ours}{suffix}.webp', kind,
                      match_jpeg=q, subsampling=0 if ours == 'normal' else 2)
    credit = MODELS[mid]
    if exact:
        credit = {**credit, 'changes': 'original scan shape preserved; coincident render vertices joined, '
                  'atlas re-unwrapped, procedural burnt steel/rust/chipped paint/rubber baked; no source markings'}
    return {**credit, **info}


def package_truck(mid: str) -> dict:
    """build/vehicles/<mid>/<mid>.gltf (+ PNG maps) → public/models/vehicles/<mid>.glb."""
    from PIL import Image
    from webp import save_webp

    src = BUILD / mid / f'{mid}.gltf'
    doc = json.loads(src.read_text(encoding='utf-8'))
    blob = bytearray((src.parent / doc['buffers'][0]['uri']).read_bytes())
    import io
    for img in doc.get('images', []):
        name = Path(img['uri']).stem
        kind = 'color' if name.endswith('albedo') else 'data'
        two_k = src.parent / f'{name}_2k.png'
        im = Image.open(two_k if two_k.exists() else src.parent / img['uri']).convert('RGB')
        if im.size[0] < SIZE:
            raise SystemExit(f'{mid}: {name} is {im.size[0]} px (a fast/test bake?)')
        im = im.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
        tmp = BUILD / mid / f'{name}.webp'
        # ORM (AO / roughness / metal) at the JPEG-80 match: the tread + chip detail bake grew the
        # trucks past the folder budget, and roughness steps hide far better than albedo ones.
        q = 90 if name.endswith('normal') else 80 if name.endswith('orm') else 85
        save_webp(im, tmp, kind, match_jpeg=q, subsampling=0 if name.endswith('normal') else 2)
        data = tmp.read_bytes()
        blob += b'\0' * (-len(blob) % 4)
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)})
        blob += data
        img.pop('uri')
        img['bufferView'] = len(doc['bufferViews']) - 1
        img['mimeType'] = 'image/webp'
    for t in doc.get('textures', []):
        if 'source' in t:
            t['extensions'] = {'EXT_texture_webp': {'source': t.pop('source')}}
    for key in ('extensionsUsed', 'extensionsRequired'):
        doc[key] = sorted(set(doc.get(key, [])) | {'EXT_texture_webp'})
    blob += b'\0' * (-len(blob) % 4)
    doc['buffers'] = [{'byteLength': len(blob)}]
    doc['asset']['generator'] = 'warsaw-downtown tools/assets/package_vehicles.py'
    js = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    js += b' ' * (-len(js) % 4)
    out = OUT / f'{mid}.glb'
    body = (struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))
    out.write_bytes(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    tris = sum(doc['accessors'][p['indices']]['count'] // 3 for m in doc['meshes'] for p in m['primitives'])
    return {**TRUCK_SOURCE, 'changes': TRUCKS[mid], 'file': out.name, 'triangles': tris}


def main() -> None:
    import argparse
    from build_models import json_text
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', choices=[*MODELS, *TRUCKS], nargs='+', help='package only these assets, retaining other manifest entries')
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.only:
        manifest = json.loads((OUT / 'vehicles.json').read_text(encoding='utf-8'))
        for mid in args.only:
            section, build = ('models', package) if mid in MODELS else ('trucks', package_truck)
            manifest[section][mid] = build(mid)
    else:
        manifest = {'models': {mid: package(mid) for mid in MODELS},
                    'trucks': {mid: package_truck(mid) for mid in TRUCKS}}
    (OUT / 'vehicles.json').write_text(json_text(manifest) + '\n', encoding='utf-8', newline='\n')
    total = sum(f.stat().st_size for f in OUT.iterdir())
    for mid, m in manifest['models'].items():
        print(f'{mid:15s} {m["triangles"]:6d} tris (far {m["farTriangles"]})  size {m["size"]}')
    for mid, m in manifest['trucks'].items():
        print(f'{mid:15s} {m["triangles"]:6d} tris  {m["file"]}')
    print(f'{len(MODELS) + len(TRUCKS)} vehicles, {total / 1e6:.2f} MB in {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
