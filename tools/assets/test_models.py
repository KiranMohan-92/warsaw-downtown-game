"""Small, offline tests for the prop pipeline; runnable with Python's unittest."""
import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from build_models import (
    OUT, ROOT, PAD, TILE, albedo_with_ao, gltf_json, gutter, normal_matrix,
    node_matrix, read_accessor, recentre, rough_metal, tile_uv, transform_normal,
    transform_point, transform_uv,
)
from build_prop_collision import collision_mesh
from decimate import simplify


class ModelsTest(unittest.TestCase):
    def test_interleaved_normalized_accessor(self):
        data = b'xxxx' + struct.pack('<4H', 32768, 65535, 0, 16384)
        doc = {'accessors': [{'bufferView': 0, 'componentType': 5123, 'type': 'VEC2',
                             'count': 2, 'normalized': True}],
               'bufferViews': [{'buffer': 0, 'byteOffset': 4, 'byteStride': 4}]}
        values = read_accessor(doc, [data], 0)
        self.assertAlmostEqual(values[0][0], 32768 / 65535)
        self.assertEqual(values[0][1], 1)
        self.assertAlmostEqual(values[1][1], 16384 / 65535)

    def test_texture_transform_order_and_texcoord(self):
        info = {'extensions': {'KHR_texture_transform': {
            'offset': [.5, .125], 'scale': [.25, .5], 'rotation': math.pi / 2}}}
        u, v = transform_uv(info, (.2, .6))
        self.assertAlmostEqual(u, .2)
        self.assertAlmostEqual(v, .175)
        with self.assertRaises(ValueError):
            transform_uv({'texCoord': 1}, (0, 0))

    def test_nonuniform_node_transform_and_normal(self):
        matrix = node_matrix({'translation': [1, 2, 3], 'scale': [2, 3, 4]})
        self.assertEqual(transform_point(matrix, (1, 1, 1)), (3, 5, 7))
        n = transform_normal(normal_matrix(matrix), (1, 1, 0))
        self.assertAlmostEqual(n[0] / n[1], 1.5)
        self.assertAlmostEqual(sum(v*v for v in n), 1)

    def test_recentre_and_binary_round_trip(self):
        verts = [(1, 2, 3, 0, 1, 0, 0, 0), (3, 2, 3, 0, 1, 0, 1, 0),
                 (1, 4, 5, 0, 1, 0, 0, 1)]
        centred, size = recentre(verts)
        self.assertEqual(size, [2, 2, 2])
        doc, blob = gltf_json('test', centred, [(0, 1, 2)])
        self.assertTrue(all(v['byteOffset'] % 4 == 0 for v in doc['bufferViews']))
        self.assertEqual(doc['bufferViews'][3]['byteLength'], 6)
        self.assertEqual(read_accessor(doc, [blob], 3), [(0,), (1,), (2,)])
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder/'test.gltf').write_text(json.dumps(doc))
            (folder/'test.bin').write_bytes(blob)
            mesh = collision_mesh(folder, 'test')
            self.assertEqual(mesh['positions'], [tuple(p[:3]) for p in centred])
            self.assertEqual(mesh['indices'], [0, 1, 2])

    def test_atlas_gutters_uv_and_pbr_channels(self):
        img = Image.new('RGB', (2, 2), (100, 120, 140))
        padded = gutter(img)
        self.assertEqual(padded.size, (TILE, TILE))
        self.assertEqual(padded.getpixel((0, 0)), (100, 120, 140))
        self.assertEqual(tile_uv(1, 0, 0, 4, 3), ((TILE + PAD) / (4*TILE), PAD / (3*TILE)))
        arm = Image.new('RGB', (2, 2), (0, 80, 30))
        self.assertEqual(rough_metal(arm).getpixel((0, 0)), (255, 80, 30))
        self.assertEqual(albedo_with_ao(img, arm).getpixel((0, 0)), (40, 48, 56))

    def test_simplification_is_deterministic_and_preserves_attributes(self):
        verts = [(0, 0, 0, 0, 1, 0, 0, 0), (1, 0, 0, 0, 1, 0, 1, 0),
                 (1, 0, 1, 0, 1, 0, 1, 1), (0, 0, 1, 0, 1, 0, 0, 1)]
        tris = [(0, 1, 2), (0, 2, 3)]
        result = simplify(verts, tris, 1)
        self.assertEqual(result, simplify(verts, tris, 1))
        self.assertEqual(len(result[1]), 1)
        self.assertTrue(all(v in verts for v in result[0]))
        self.assertTrue(all(i < len(result[0]) for t in result[1] for i in t))

    def test_retired_models_keep_their_atlas_tile_but_ship_nothing(self):
        # Shipped uvs index atlas tiles by position: a retired spec must stay in MODELS (in
        # place) so a partial rebuild never shifts later models onto another tile.
        from build_models import MODELS
        manifest = json.loads((OUT / 'manifest.json').read_text(encoding='utf-8'))
        sources = [s.source for s in MODELS.values()]
        tiles = manifest['tiles']
        self.assertEqual([t for t in sources if t in tiles], [t for t in tiles if t in sources])
        for mid, spec in MODELS.items():
            if spec.retired:
                self.assertIn(spec.source, tiles)
                self.assertNotIn(mid, manifest['models'])
                self.assertFalse((OUT / mid).exists())
            else:
                self.assertIn(mid, manifest['models'])

    def test_shipped_collision_budget_and_provenance(self):
        manifest = json.loads((OUT/'manifest.json').read_text())
        collision = json.loads((ROOT/'packages/shared/src/maps/propGeometry.gen.json').read_text())
        log = (ROOT/'ASSETS.md').read_text(encoding='utf-8')
        # Byte budgets (download size is a feature): the prop set this pipeline ships (their folders +
        # the shared atlas), every other model folder (~10 % headroom over the WebP re-encode of
        # 2026-09-29; arms: other lane), and the whole models tree. Raise one deliberately, with the
        # reason in the commit.
        props = [f for mid in manifest['models'] for f in (OUT/mid).rglob('*') if f.is_file()]
        props += [f for f in OUT.glob('atlas_*') if f.is_file()]
        self.assertLess(sum(f.stat().st_size for f in props), 2_400_000)
        size = lambda d: sum(f.stat().st_size for f in (OUT/d).rglob('*') if f.is_file())
        for folder, cap in [('soldiers', 5_200_000), ('guns', 4_500_000), ('trees', 2_150_000),
                            ('heroes', 2_450_000), ('arms', 1_000_000),
                            ('knife', 600_000), ('vehicles', 9_700_000), ('jetpack', 1_000_000)]:
            self.assertLess(size(folder), cap, f'models/{folder} over its byte budget')
        # 17.5 -> 25.5 MB (2026-10-02): the CC BY vehicles in models/vehicles (8.8 MB): helicopter
        # (60k near), tank and armoured-truck wrecks (30k; 1k/512 textures) over the Market's box
        # wrecks, and the drivable truck + its destroyed variant (24k each, self-contained GLBs).
        # 25.5 -> 26.5 MB (2026-10-03, merging main): the jetpack lane's models/jetpack (0.97 MB),
        # budgeted on main against the 17.5 MB total before the vehicles landed.
        self.assertLess(sum(f.stat().st_size for f in OUT.rglob('*') if f.is_file()), 26_500_000)
        for mid, spec in manifest['models'].items():
            self.assertIn('https://polyhaven.com/a/' + spec['source'], log)
            rebuilt = json.loads(json.dumps(collision_mesh(OUT/mid, mid)))
            self.assertEqual(rebuilt, collision['models'][mid], f'{mid}: collision needs rebuilding')
        for name, size in [('atlas_albedo.webp', (2048, 1536)), ('atlas_albedo_low.webp', (1024, 768))]:
            with Image.open(OUT/name) as image:
                self.assertEqual(image.size, size)


if __name__ == '__main__':
    unittest.main()
