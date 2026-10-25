"""Vehicle contract checks (vehicle_spec.py) and, when the Blender build has run, its glTF output.

The build output (tools/assets/build/vehicles, git-ignored) is checked only if present; the
shipped models get the same checks once they are integrated.
"""

import json
import math
import struct
import unittest
from pathlib import Path

from vehicle_contract import validate_truck
from vehicle_spec import BUDGETS, HELI_DROP, HELI_PITCH, HELI_SHELL, PHASE1_HELI_BOXES, TRUCK, TRUCK_NODES, WRECK_BOXES

HERE = Path(__file__).resolve().parent
BUILD = HERE / 'build/vehicles'
TOL = 0.02


def load(path: Path):
    doc = json.loads(path.read_text(encoding='utf-8'))
    blob = (path.parent / doc['buffers'][0]['uri']).read_bytes()
    return doc, blob


def positions(doc, blob, mesh_index):
    out = []
    for prim in doc['meshes'][mesh_index]['primitives']:
        a = doc['accessors'][prim['attributes']['POSITION']]
        v = doc['bufferViews'][a['bufferView']]
        base = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = v.get('byteStride', 12)
        out += [struct.unpack_from('<3f', blob, base + i * stride) for i in range(a['count'])]
    return out


def triangles(doc, mesh_index):
    return sum(doc['accessors'][p['indices']]['count'] // 3 for p in doc['meshes'][mesh_index]['primitives'])


class SpecTest(unittest.TestCase):
    def test_truck_numbers(self):
        self.assertAlmostEqual(TRUCK['wheelbase'], 3.1)
        self.assertAlmostEqual(TRUCK['track'], 1.75)
        self.assertAlmostEqual(TRUCK['wheel_radius'], 0.46)
        self.assertEqual(len(set(TRUCK_NODES)), len(TRUCK_NODES))

    def test_only_the_tank_lives_in_wreck_boxes(self):
        # The helicopter's shipped collision is heli_collision.py (test_heli_collision.py); the old
        # 13-box table is the phase-1 builder's and must not be read as the shipped one.
        self.assertEqual(set(WRECK_BOXES), {'tank'})
        self.assertEqual(WRECK_BOXES['tank']['hull']['s'], (6.6, 1.35, 2.0))

    def test_phase1_heli_shell_frame_matches_its_world_boxes(self):
        th = math.radians(HELI_PITCH)
        for key, b in HELI_SHELL.items():
            x, y, z = b['c']
            w = PHASE1_HELI_BOXES[key]
            self.assertEqual(w['s'], b['s'], key)
            self.assertEqual(w['rot'], (0, 0, 5), key)
            got = (x * math.cos(th) - y * math.sin(th), x * math.sin(th) + y * math.cos(th) + HELI_DROP, z)
            self.assertLess(math.dist(got, w['c']), 1e-3, key)


MODELS = HERE.parents[1] / 'packages/client/public/models/vehicles'


class ShippedTruckTest(unittest.TestCase):
    """The drivable truck (CC BY Armored Police Vehicle, cut to the open-bed technical) and its
    destroyed variant: every contract node, wheel pivots/size, the vehicle lane's seat and exit
    empties (packages/shared/src/sim/vehicles/truckSpec.ts on lane/vehicle-drive), budgets."""

    SEATS = {'seat_driver': (0.45, 1.12, 0.45), 'seat_front': (-0.45, 1.12, 0.45),
             'seat_rear_l': (0.55, 1.5, -1.35), 'seat_rear_r': (-0.55, 1.5, -1.35),
             'exit_l': (1.55, 0.0, 0.3), 'exit_r': (-1.55, 0.0, 0.3)}

    def check(self, mid, wheel_shape):
        from raw_models import raw_model
        from vehicle_contract import load as load_any
        path = raw_model(MODELS / f'{mid}.glb')
        errs = validate_truck(path, BUDGETS[mid][0], envelope=False, wheel_shape=wheel_shape)
        self.assertEqual(errs, [], mid)
        doc, _ = load_any(path)
        nodes = {n['name']: n for n in doc['nodes']}
        for name, want in self.SEATS.items():
            got = nodes[name].get('translation', [0, 0, 0])
            self.assertLess(math.dist(got, want), 1e-3, (mid, name, got))
        self.assertIn('EXT_texture_webp', doc.get('extensionsRequired', []))
        for img in doc.get('images', []):
            self.assertEqual(img['mimeType'], 'image/webp', mid)

    def test_truck(self):
        self.check('truck', True)

    def test_truck_wreck(self):
        self.check('truck_wreck', False)


if __name__ == '__main__':
    unittest.main()
