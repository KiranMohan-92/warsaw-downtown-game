"""The seax knife's geometry, anchors, UVs and shipped files (pure Python; no Blender, no raw
sources: the shipped mesh is read back through raw_models)."""
import json
import math
import unittest

import numpy as np
from PIL import Image, ImageDraw

import build_knife as k
from build_heroes import accessor
from raw_models import raw_model

OUT = k.OUT


class ProfileTest(unittest.TestCase):
    def test_broken_back_seax_profile(self):
        # The spine rises to the break, then a straight clip of 24-31 deg down to the tip.
        self.assertGreater(k.CLIP_DEG, 24)
        self.assertLess(k.CLIP_DEG, 31)
        self.assertGreater(k.spine_y(k.BREAK_S), k.spine_y(0) + 0.005)
        for s in np.linspace(0.0, k.BLADE_LEN - 1e-4, 200):
            self.assertGreater(k.spine_y(s), k.edge_y(s), s)  # never inverts
        self.assertAlmostEqual(k.spine_y(k.BLADE_LEN), k.TIP_Y, places=6)
        self.assertAlmostEqual(k.edge_y(k.BLADE_LEN), k.TIP_Y, places=6)
        # Deepest at the break (~3.3 cm), single edge, 20-22 cm blade.
        depth = [k.spine_y(s) - k.edge_y(s) for s in np.linspace(0, k.BLADE_LEN, 400)]
        self.assertAlmostEqual(np.argmax(depth) / 399 * k.BLADE_LEN, k.BREAK_S, delta=0.01)
        self.assertTrue(0.20 <= k.BLADE_LEN <= 0.22)

    def test_anchors_sit_on_the_geometry(self):
        a = k.ANCHORS
        self.assertEqual(a['knife_grip'], (0.0, 0.0, 0.0))
        self.assertEqual(a['knife_tip'], (0.0, k.TIP_Y, k.z_of(k.BLADE_LEN)))
        e = a['knife_edge']
        self.assertAlmostEqual(e[1], k.edge_y(k.s_of(e[2])), places=9)
        self.assertGreater(k.s_of(e[2]), 0.03)  # on the sharpened edge, past the ricasso
        # The fist (origin) is inside the grip, between the collars.
        self.assertLess(k.COLLAR_G[1], 0.0)
        self.assertGreater(k.COLLAR_P[0], 0.0)


class LowMeshTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = k.low_mesh()

    def test_triangle_budget(self):
        self.assertLess(self.m.triangles(), 2500)
        self.assertGreater(self.m.triangles(), 1200)  # the close first-person silhouette

    def test_faces_point_outward(self):
        v = np.array(self.m.v)
        bad = 0
        for f, p in zip(self.m.f, self.m.part):
            pts = v[list(f)]
            n = np.cross(pts[1] - pts[0], pts[-1] - pts[0])
            if np.linalg.norm(n) < 1e-12:
                continue
            c = pts.mean(0)
            # Out = away from the knife's axis (the blade: away from its centre plane / the spine
            # side); caps: along +-z away from the part's middle.
            if p >= 11 and p <= 14:
                ref = np.array([c[0], c[1] - (k.spine_y(k.s_of(c[2])) + k.edge_y(k.s_of(c[2]))) / 2, 0])
            else:
                ref = np.array([c[0], c[1] - (k.GUARD['cy'] if p == 40 else 0), 0])
            if np.linalg.norm(ref) < 1e-4:
                continue
            bad += float(n @ ref) < 0 and abs(n[2]) < 0.9 * np.linalg.norm(n)
        self.assertLess(bad, 0.02 * len(self.m.f))

    def test_uv_islands_inside_the_atlas_and_not_overlapping(self):
        res = 1024
        s = res / k.TEX
        count = np.zeros((res, res), np.int32)
        for uv in self.m.uv:
            for u, vv in uv:
                self.assertTrue(0 <= u <= k.TEX and 0 <= vv <= k.TEX)
            im = Image.new('L', (res, res))
            pts = [(u * s, res - vv * s) for u, vv in uv]
            cx = sum(x for x, _ in pts) / len(pts)
            cy = sum(y for _, y in pts) / len(pts)
            ImageDraw.Draw(im).polygon([(cx + (x - cx) * 0.8, cy + (y - cy) * 0.8) for x, y in pts], fill=1)
            count += np.asarray(im, np.int32)
        # Sub-pixel slivers at the tip rasterise to a pixel each; real overlaps would be islands.
        self.assertLess(int((count > 1).sum()), 80)

    def test_every_part_has_a_zone(self):
        self.assertEqual(set(self.m.part), set(k.PART_NAMES))


class ShippedTest(unittest.TestCase):
    def test_shipped_model_matches_the_build(self):
        path = raw_model(OUT / 'knife.gltf')
        doc = json.loads(path.read_text())
        blob = (path.parent / doc['buffers'][0]['uri']).read_bytes()
        nodes = {n.get('name'): n for n in doc['nodes']}
        for name, p in k.ANCHORS.items():
            t = nodes[name].get('translation', [0, 0, 0])
            for c in range(3):
                self.assertAlmostEqual(t[c], p[c], places=5, msg=name)
        prim = doc['meshes'][nodes['knife']['mesh']]['primitives'][0]
        tris = len(accessor(doc, blob, prim['indices'])) // 3
        manifest = json.loads((OUT / 'knife.json').read_text())
        self.assertEqual(manifest['triangles'], tris)
        self.assertEqual(manifest['triangles'], k.low_mesh().triangles())
        self.assertEqual(manifest['anchors'], k.manifest()['anchors'])
        pos = accessor(doc, blob, prim['attributes']['POSITION'])
        self.assertAlmostEqual(min(p[2] for p in pos), k.ANCHORS['knife_tip'][2], places=3)
        self.assertNotIn('TANGENT', prim['attributes'])  # derivative tangents, like the scans

    def test_textures_and_budget(self):
        for name, _ in k.MAPS:
            for suffix, px in (('', k.SHIP), ('_low', k.LOW)):
                with Image.open(OUT / f'knife_{name}{suffix}.webp') as im:
                    self.assertEqual(im.size, (px, px))
                    self.assertEqual(im.mode, 'RGB')
        size = sum(f.stat().st_size for f in OUT.iterdir() if f.is_file())
        self.assertLess(size, 600_000)

    def test_logged_in_assets_md(self):
        log = (k.ROOT / 'ASSETS.md').read_text(encoding='utf-8')
        self.assertIn('models/knife', log)
        self.assertIn('build_knife.py', log)


if __name__ == '__main__':
    unittest.main()
