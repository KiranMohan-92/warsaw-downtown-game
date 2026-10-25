"""Plain (unpacked) copies of shipped models, for asset tools that read their meshes back.

Shipped models are meshopt-packed (`pnpm assets:pack`), which Python cannot decode. `raw_model`
returns the file itself when it is not packed (e.g. freshly exported, before packing); otherwise a
decoded copy under tools/assets/build/unpacked/, regenerated with node whenever the shipped file is
newer — never a stale cache. Collision props decode bit-exactly (lossless positions, exact index
order); other models to within the packer's mantissa trim (micrometres).
"""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / 'packages/client/public/models'
UNPACKED = ROOT / 'tools/assets/build/unpacked'
PACKER = ROOT / 'tools/assets/meshopt_pack.mjs'
EXT = 'EXT_meshopt_compression'


def _json(path: Path) -> dict:
    data = path.read_bytes()
    if path.suffix == '.glb':
        n = int.from_bytes(data[12:16], 'little')
        return json.loads(data[20 : 20 + n])
    return json.loads(data)


def is_packed(path: Path) -> bool:
    return EXT in _json(path).get('extensionsUsed', [])


def raw_model(path: Path) -> Path:
    """`path` if it is plain glTF, else its up-to-date decoded copy."""
    path = Path(path).resolve()
    if not is_packed(path):
        return path
    target = UNPACKED / path.relative_to(MODELS.resolve())
    if not target.exists() or target.stat().st_mtime < path.stat().st_mtime:
        subprocess.run(['node', str(PACKER), '--unpack', '--out', str(UNPACKED), str(path)], check=True, cwd=ROOT,
                       capture_output=True)
    if not target.exists() or is_packed(target):
        raise SystemExit(f'{path}: could not unpack (run `node {PACKER} --unpack {path}`)')
    return target
