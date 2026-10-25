"""rebake_model.py end to end on a tiny dummy truck (centimetres, facing −Z, no UVs/normals): the
output must satisfy the truck contract. Needs Blender (WD_BLENDER, else the portable install);
skipped without it. ~1 min (128 px fast bake)."""

import json
import math
import os
import shutil
import struct
import subprocess
import unittest
from pathlib import Path

from vehicle_contract import load, validate_truck
from vehicle_spec import TRUCK

HERE = Path(__file__).resolve().parent
BLENDER = Path(os.environ.get('WD_BLENDER', r'C:\Users\kiran\tools\blender-5.2.1-windows-x64\blender.exe'))
WORK = HERE / 'build/test_rebake'
K = TRUCK['wheelbase'] / 3.0  # the dummy's 300 cm wheelbase is fitted to the contract


def box(c, s):
    vs = [(c[0] + sx * s[0] / 2, c[1] + sy * s[1] / 2, c[2] + sz * s[2] / 2) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return vs, [t for q in f for t in ((q[0], q[1], q[2]), (q[0], q[2], q[3]))]


def wheel(c, r, w, n=16):
    vs, tris = [], []
    for side in (-1, 1):
        for i in range(n):
            a = 2 * math.pi * i / n
            vs.append((c[0] + side * w / 2, c[1] + math.cos(a) * r, c[2] + math.sin(a) * r))
    for i in range(n):
        j = (i + 1) % n
        tris += [(i, j, n + j), (i, n + j, n + i)]
    for i in range(1, n - 1):
        tris += [(0, i + 1, i), (n, n + i, n + i + 1)]
    return vs, tris


def write_gltf(path: Path, parts):
    """parts: (name, material, verts, tris) in centimetres, glTF +Y up."""
    blob = b''
    acc, views, meshes, nodes, mats = [], [], [], [], []
    for name, mat, vs, tris in parts:
        if mat not in mats:
            mats.append(mat)
        pos = b''.join(struct.pack('<3f', *v) for v in vs)
        idx = b''.join(struct.pack('<3H', *t) for t in tris)
        idx += b'\0' * (-len(idx) % 4)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(pos), 'target': 34962})
        blob += pos
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(tris) * 6, 'target': 34963})
        blob += idx
        lo = [min(v[i] for v in vs) for i in range(3)]
        hi = [max(v[i] for v in vs) for i in range(3)]
        acc.append({'bufferView': len(views) - 2, 'componentType': 5126, 'count': len(vs), 'type': 'VEC3', 'min': lo, 'max': hi})
        acc.append({'bufferView': len(views) - 1, 'componentType': 5123, 'count': len(tris) * 3, 'type': 'SCALAR'})
        meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': len(acc) - 2}, 'indices': len(acc) - 1,
                                                     'material': mats.index(mat)}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})
    doc = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes,
           'meshes': meshes, 'materials': [{'name': m} for m in mats], 'accessors': acc, 'bufferViews': views,
           'buffers': [{'uri': path.stem + '.bin', 'byteLength': len(blob)}]}
    (path.parent / (path.stem + '.bin')).write_bytes(blob)
    path.write_text(json.dumps(doc), encoding='utf-8')


def dummy(path: Path):
    r = TRUCK['wheel_radius'] / K * 100
    tx = TRUCK['track'] / 2 / K * 100
    parts = [('Body', 'Paint_Body', *box((0, r + 60, 0), (180, 120, 470))),
             ('Siren_Bar', 'Light_Red', *box((0, r + 125, -100), (100, 10, 20))),
             ('Windshield', 'Glass_Clear', *box((0, r + 140, -120), (150, 40, 2)))]
    # Front faces −Z in the source; game left (+X when facing +Z) is source −X after the 180° yaw.
    for name, (x, z) in {'Wheel_FL': (-tx, -150), 'Wheel_FR': (tx, -150), 'Wheel_RL': (-tx, 150), 'Wheel_RR': (tx, 150)}.items():
        parts.append((name, 'Tyre_Rubber', *wheel((x, r, z), r, 28)))
    write_gltf(path, parts)


@unittest.skipUnless(BLENDER.exists(), 'Blender not available (set WD_BLENDER)')
class RebakeDummyTest(unittest.TestCase):
    def test_dummy_truck_meets_the_contract(self):
        if WORK.exists():
            shutil.rmtree(WORK)
        WORK.mkdir(parents=True)
        src = WORK / 'dummy.gltf'
        dummy(src)
        cfg = {
            'id': 'dummy_truck', 'input': str(src), 'scale': 0.01, 'yaw': 180, 'palette': 'truck', 'contract': 'truck',
            'materials': [['glass*', 'glass'], ['tyre*', 'rubber'], ['*', 'paint']],
            'wheels': {'wheel_fl': 'wheel_fl*', 'wheel_fr': 'wheel_fr*', 'wheel_rl': 'wheel_rl*', 'wheel_rr': 'wheel_rr*'},
            'envelope': False, 'budget': [14000, 2600],
            'drop_objects': ['siren*'],
            # Open the rear: drop the body's top behind the cab, add a low bed wall cap.
            'cut': [{'min': [-2, 1.3, -3], 'max': [2, 3, -0.6]}],
            'add': [{'c': [0.9, 1.25, -1.5], 's': [0.06, 0.4, 1.8], 'kind': 'paint'}],
        }
        (WORK / 'cfg.json').write_text(json.dumps(cfg), encoding='utf-8')
        env = {**os.environ, 'WD_SCRATCH': str(WORK)}
        env.pop('WD_VEH_SOURCES', None)
        with open(WORK / 'blender.log', 'w', encoding='utf-8') as log:
            r = subprocess.run([str(BLENDER), '--background', '--factory-startup', '--python', str(HERE / 'rebake_model.py'), '--',
                                '--config', str(WORK / 'cfg.json'), '--out', str(WORK / 'out'), '--fast'],
                               stdout=log, stderr=subprocess.STDOUT, env=env, timeout=600)
        text = (WORK / 'blender.log').read_text(encoding='utf-8', errors='replace')
        self.assertIn('REBAKE dummy_truck ok', text, text[-3000:])
        self.assertEqual(r.returncode, 0)
        out = WORK / 'out/dummy_truck'
        for lod in ('', '_far'):
            self.assertEqual(validate_truck(out / f'dummy_truck{lod}.gltf', 14000, envelope=False), [])
        doc, _ = load(out / 'dummy_truck.gltf')
        # Glass stays its own (transparent) primitive on the body; the atlas maps exist.
        body = next(n for n in doc['nodes'] if n['name'] == 'body')
        mats = {doc['materials'][p['material']]['name'] for p in doc['meshes'][body['mesh']]['primitives']}
        self.assertIn('glass', mats)
        # The cut opened the rear above the bed; the siren is gone; the added wall cap is there.
        from vehicle_contract import positions
        pts = positions(doc, _, body['mesh'])
        rear_high = [p for p in pts if p[2] < -0.7 and p[1] > 1.45 and abs(p[0]) < 0.5]
        self.assertEqual(rear_high, [])
        self.assertTrue(any(abs(p[0] - 0.93) < 0.02 and p[2] < -0.7 and 1.0 < p[1] < 1.5 for p in pts))
        for m in ('albedo', 'orm', 'normal'):
            self.assertTrue((out / f'dummy_truck_{m}.png').exists(), m)
        # Without the wheelbase fit the dummy's 3.0 m axle spacing breaks the contract: exit 2.
        cfg.update(id='dummy_bad', fit_wheelbase=False)
        (WORK / 'bad.json').write_text(json.dumps(cfg), encoding='utf-8')
        r = subprocess.run([str(BLENDER), '--background', '--factory-startup', '--python', str(HERE / 'rebake_model.py'), '--',
                            '--config', str(WORK / 'bad.json'), '--out', str(WORK / 'out'), '--fast'],
                           capture_output=True, text=True, errors='replace', env=env, timeout=600)
        self.assertEqual(r.returncode, 2, r.stdout[-2000:])
        self.assertIn('CONTRACT', r.stdout)


    def test_dummy_wreck_static_edits(self):
        WORK.mkdir(parents=True, exist_ok=True)
        src = WORK / 'dummy_static.gltf'
        dummy(src)
        cfg = {
            'id': 'dummy_wreck', 'input': str(src), 'scale': 0.01, 'yaw': 90, 'palette': 'tank', 'contract': None,
            'materials': [['glass*', 'drop'], ['*', 'hull']], 'fit': {'axis': 'x', 'length': 7.2},
            'tilt': [0, 0, 4], 'sink': 0.05, 'dent': {'strength': 0.04, 'scale': 0.5},
            'debris': {'count': 6, 'inner': [-4, -1.5, 4, 1.5], 'outer': [-6, -3, 6, 3], 'kind': 'metal'},
            'scorch': {'radius': 5.0}, 'budget': [8000, 1500],
        }
        (WORK / 'static.json').write_text(json.dumps(cfg), encoding='utf-8')
        env = {**os.environ, 'WD_SCRATCH': str(WORK)}
        env.pop('WD_VEH_SOURCES', None)
        r = subprocess.run([str(BLENDER), '--background', '--factory-startup', '--python', str(HERE / 'rebake_model.py'), '--',
                            '--config', str(WORK / 'static.json'), '--out', str(WORK / 'out'), '--fast'],
                           capture_output=True, text=True, errors='replace', env=env, timeout=600)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])
        doc, blob = load(WORK / 'out/dummy_wreck/dummy_wreck.gltf')
        names = {n['name'] for n in doc['nodes']}
        self.assertEqual(names, {'wreck', 'scorch'})
        from vehicle_contract import positions
        wreck = next(n for n in doc['nodes'] if n['name'] == 'wreck')
        xs = [p[0] for p in positions(doc, blob, wreck['mesh'])]
        self.assertGreater(max(xs) - min(xs), 7.0)  # fitted (debris reaches further out)


if __name__ == '__main__':
    unittest.main()
