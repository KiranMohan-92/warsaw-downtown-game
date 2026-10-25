"""Offline tests for the first-person arms packaging (no Blender needed)."""
import json
import unittest

import numpy as np

from build_fparms import FOREARM_GUARD, FP_GUARD, OUT, arms_atlas, remap


def solid(h, w, colour):
    a = np.empty((h, w, 3), np.uint8)
    a[:] = colour
    return a


class ArmsAtlasTest(unittest.TestCase):
    def test_plate_strip_under_the_sleeves_with_padding(self):
        sleeve = {'albedo': solid(100, 64, (10, 20, 30)), 'normal': solid(100, 64, (128, 128, 255))}
        plate = {k: solid(8, 16, c) for k, c in (('albedo', (200, 0, 0)), ('normal', (100, 150, 250)),
                                                ('emissive', (57, 224, 255)), ('rough', (255, 97, 0)))}
        images, layout = arms_atlas(sleeve, plate, pad=2)
        for im in images.values():
            self.assertEqual(im.shape, (112, 64, 3))
        self.assertTrue((images['albedo'][:100] == (10, 20, 30)).all())
        # Plate plus its edge-replicated border; emissive only on the plate, fabric roughness elsewhere.
        self.assertTrue((images['albedo'][100:112, :20] == (200, 0, 0)).all())
        self.assertTrue((images['emissive'][:100] == 0).all())
        self.assertTrue((images['emissive'][102:110, 2:18] == (57, 224, 255)).all())
        self.assertEqual(images['rough'][50, 10, 1], round(0.85 * 255))
        self.assertEqual(images['rough'][105, 10, 1], 97)
        self.assertAlmostEqual(layout['sleeve_v'], 100 / 112)
        self.assertEqual(layout['plate'], (2 / 64, 102 / 112, 18 / 64, 110 / 112))
        with self.assertRaises(ValueError):
            arms_atlas(sleeve, {k: solid(8, 62, (0, 0, 0)) for k in plate}, pad=2)

    def test_remap_sleeve_into_the_top_and_plate_into_its_box(self):
        layout = {'sleeve_v': 0.5, 'plate': (0.1, 0.6, 0.3, 0.9)}
        v = (1, 2, 3, 0, 1, 0)
        sleeve = remap([(*v, 0.25, 0.75)], [0.0, 0.5], [0.5, 1.0], layout, plate=False)
        self.assertEqual(sleeve, [(*v, 0.5, 0.25)])
        plate = remap([(*v, 0.5, 1.0)], [0.0, 0.5], [0.5, 1.0], layout, plate=True)
        self.assertEqual(plate[0][:6], v)
        self.assertAlmostEqual(plate[0][6], 0.2)
        self.assertAlmostEqual(plate[0][7], 0.9)

    def test_first_person_plate_is_the_soldiers_plate(self):
        # Same shell as the third-person soldiers (build_soldiers reads FOREARM_GUARD); the first
        # person only shortens the span (the glove shows) and turns it toward the eye.
        for k in ('out', 'half', 'lift', 'cols', 'rows', 'thick'):
            self.assertEqual(FP_GUARD[k], FOREARM_GUARD[k], k)
        self.assertLess(FP_GUARD['t'][1], FOREARM_GUARD['t'][1])
        self.assertTrue(0 < FP_GUARD['face'] <= 1)

    def test_shipped_poses_wear_forearm_plates(self):
        poses = json.loads((OUT / 'arms.json').read_text())['poses']
        self.assertEqual(len(poses), 8)
        self.assertIn("knife", poses)  # the seax in a hammer grip, left fist in a guard
        for gid, p in poses.items():
            self.assertGreater(p['guardTriangles'], 0, gid)
            self.assertLess(p['guardTriangles'], p['triangles'], gid)
        for name in ('albedo', 'normal', 'rough', 'emissive'):
            self.assertTrue((OUT / f'arms_{name}.webp').is_file(), name)


if __name__ == '__main__':
    unittest.main()
