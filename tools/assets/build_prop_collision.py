"""Derive shared collision surfaces from the shipped reduced glTFs (no raw scans needed).

Shipped models are meshopt-packed: they are read through `raw_models.raw_model`, which decodes
them bit-exactly (props keep lossless positions and index order).

Run after build_models.py. Physics and the untextured fallback use these exact surfaces;
open bins/tyres and tapered barriers must not acquire invisible bounding-box walls.
"""

import hashlib
import json
from pathlib import Path

from build_models import OUT, ROOT, read_accessor, write_json
from raw_models import raw_model

DEST = ROOT / 'packages/shared/src/maps/propGeometry.gen.json'


def collision_mesh(folder: Path, model_id: str) -> dict:
    path = raw_model(folder / f'{model_id}.gltf')
    doc = json.loads(path.read_text())
    buffers = [(path.parent / b['uri']).read_bytes() for b in doc['buffers']]
    primitive = doc['meshes'][0]['primitives'][0]
    positions = read_accessor(doc, buffers, primitive['attributes']['POSITION'])
    triangles = read_accessor(doc, buffers, primitive['indices'])
    # Weld texture/normal seams, at micrometre precision, for continuous Rapier contacts.
    unique: dict[tuple, int] = {}
    remap = []
    for p in positions:
        point = tuple(round(v, 6) for v in p)
        remap.append(unique.setdefault(point, len(unique)))
    vertices = list(unique)
    indices = [remap[t[0]] for t in triangles]
    lo = [min(p[k] for p in positions) for k in range(3)]
    hi = [max(p[k] for p in positions) for k in range(3)]
    return {'size': [hi[k] - lo[k] for k in range(3)], 'positions': vertices, 'indices': indices}


def build() -> None:
    manifest = json.loads((OUT / 'manifest.json').read_text())
    models = {mid: collision_mesh(OUT / mid, mid) for mid in manifest['models']}
    digest = hashlib.sha256(json.dumps(models, sort_keys=True).encode()).hexdigest()[:16]
    write_json(DEST, {'hash': digest, 'models': models})
    print(f'Shared prop collision: {DEST.stat().st_size / 1000:.0f} kB ({digest})')


if __name__ == '__main__':
    build()
