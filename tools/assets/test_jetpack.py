"""The jetpack's shipped files, anchors and budgets (pure Python; no Blender)."""
import json
import re
import unittest
from pathlib import Path

import build_jetpack as j

OUT = j.OUT
CLIENT = Path(__file__).resolve().parents[2] / 'packages/client/src/jetpack/jetpackModel.ts'


class ShippedTest(unittest.TestCase):
    def test_files_manifest_and_anchors(self):
        names = {p.name for p in OUT.iterdir()}
        for m in ('albedo', 'normal', 'arm', 'emissive'):
            for s in ('', '_low'):
                self.assertIn(f'jetpack_{m}{s}.webp', names)
        manifest = json.loads((OUT / 'jetpack.json').read_text())
        # Worn by up to six soldiers at once: keep it a backpack, not a hero prop (the pods' rivets
        # and seams, 2026-10-03, took it to 9.5k; each soldier is ~14k).
        self.assertLess(manifest['triangles'], 10_000)
        doc = json.loads((OUT / 'jetpack.gltf').read_text())
        nodes = {n.get('name'): n for n in doc['nodes']}
        for name, p in j.ANCHORS.items():
            self.assertIn(name, nodes)
            for a, b in zip(nodes[name].get('translation', [0, 0, 0]), p):
                self.assertAlmostEqual(a, b, places=4)
            self.assertEqual(manifest['anchors'][name], [round(c, 5) for c in p])
        # The client's fallback constants match the build (exhaust starts at the real nozzles).
        src = CLIENT.read_text(encoding='utf-8')
        for key, name in (('nozzleL', 'jetpack_nozzle_l'), ('nozzleR', 'jetpack_nozzle_r'),
                          ('top', 'jetpack_top')):
            m = re.search(key + r': \[([^\]]+)\]', src)
            self.assertIsNotNone(m, key)
            vals = [float(v) for v in m.group(1).split(',')]
            for a, b in zip(vals, j.ANCHORS[name]):
                self.assertAlmostEqual(a, b, places=3, msg=key)

    def test_nozzles_point_down_below_the_pods(self):
        for side in ('l', 'r'):
            x, y, z = j.ANCHORS[f'jetpack_nozzle_{side}']
            self.assertLess(y, j.POD_BOTTOM)
            self.assertAlmostEqual(abs(x), j.POD_X)
            self.assertGreater(z, 0)  # behind the wearer


if __name__ == '__main__':
    unittest.main()
