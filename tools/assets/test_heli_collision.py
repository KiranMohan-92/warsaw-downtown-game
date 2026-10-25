"""The helicopter wreck's collision (shared maps/props.ts `helicopterWreck`) is generated from the
model's crash parameters (heli_collision.py + vehicle_configs/heli_wreck.json): they must agree, so
the visual model and the gameplay boxes never drift apart."""

import json
import re
import unittest
from pathlib import Path

import heli_collision as hc

HERE = Path(__file__).resolve().parent
PROPS = HERE.parents[1] / 'packages/shared/src/maps/props.ts'


class HeliCollisionTest(unittest.TestCase):
    def test_props_match_the_generated_boxes(self):
        src = PROPS.read_text(encoding='utf-8')
        fn = src[src.index('export function helicopterWreck'):]
        fn = fn[: fn.index('\n}\n')]
        rows = re.findall(r'box\(\s*([-\d.,\s]+?)\s*\),\s*//\s*(\w+)', fn)
        got = {name: [float(v) for v in nums.replace('\n', ' ').split(',') if v.strip()] for nums, name in rows}
        cfg = json.loads(hc.CFG.read_text(encoding='utf-8'))
        want = hc.boxes(cfg)
        self.assertEqual(set(got), set(want))
        for name, b in want.items():
            exp = [*b['c'], *b['s'], *b['rot']]
            for g, e in zip(got[name], exp):
                self.assertAlmostEqual(g, e, places=3, msg=name)

    def test_euler_round_trip(self):
        m = hc.euler_blender([33, 18, 0])
        x, y, z = hc.to_three_xyz(m)
        import math
        import numpy as np
        r = hc.rx(math.radians(x)) @ hc.ry(math.radians(y)) @ hc.rz(math.radians(z))
        self.assertTrue(np.allclose(r, m, atol=1e-4))


if __name__ == '__main__':
    unittest.main()
