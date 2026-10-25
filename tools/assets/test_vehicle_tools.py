"""The review/inspection tools must show the game's geometry: collision overlays in the game's
Euler convention (three.js XYZ = Rx·Ry·Rz, not mathutils' Rz·Ry·Rx), and inspect_model's --yaw /
--scale applied to the rendered objects, not only to the reported bounds."""

import json
import math
import os
import shutil
import subprocess
import unittest
from pathlib import Path

import numpy as np

import heli_collision as hc
from test_rebake_model import box, write_gltf

HERE = Path(__file__).resolve().parent
BLENDER = Path(os.environ.get('WD_BLENDER', r'C:\Users\kiran\tools\blender-5.2.1-windows-x64\blender.exe'))
WORK = HERE / 'build/test_vehicle_tools'


def quat_xyz(deg):
    """The shared sim's quatFromEulerDeg (three.js XYZ) as a matrix, written independently."""
    c = [math.cos(math.radians(d) / 2) for d in deg]
    s = [math.sin(math.radians(d) / 2) for d in deg]
    x = s[0] * c[1] * c[2] + c[0] * s[1] * s[2]
    y = c[0] * s[1] * c[2] - s[0] * c[1] * s[2]
    z = c[0] * c[1] * s[2] + s[0] * s[1] * c[2]
    w = c[0] * c[1] * c[2] - s[0] * s[1] * s[2]
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


class OverlayConventionTest(unittest.TestCase):
    def test_box_matrix_matches_the_game_rotation(self):
        # The crashed blade's rotation: all three axes, where the two conventions disagree.
        rot, c, s = (33.619, 16.697, -7.449), (1.1775, 1.4185, 4.0649), (0.6, 0.12, 5.8)
        m = hc.box_matrix(c, s, rot)
        corner = np.array([0.5, 0.5, 0.5, 1.0])
        want = np.array(c) + quat_xyz(rot) @ (np.array(s) / 2)
        self.assertTrue(np.allclose((m @ corner)[:3], want, atol=1e-9))
        wrong = np.array(c) + hc.euler_blender(rot) @ (np.array(s) / 2)
        self.assertGreater(np.linalg.norm(wrong - want), 0.3)  # mathutils' order is way off


@unittest.skipUnless(BLENDER.exists(), 'Blender not available (set WD_BLENDER)')
class InspectTransformTest(unittest.TestCase):
    def test_yaw_and_scale_reach_the_scene_objects(self):
        if WORK.exists():
            shutil.rmtree(WORK)
        WORK.mkdir(parents=True)
        src = WORK / 'slab.gltf'
        # glTF +Y up: 4 long (x), 1 high, 2 deep (z), off the origin.
        write_gltf(src, [('Slab', 'M', *box((3, 0.5, 0), (4, 1, 2)))])
        with open(WORK / 'blender.log', 'w', encoding='utf-8') as log:
            r = subprocess.run([str(BLENDER), '--background', '--factory-startup', '--python', str(HERE / 'inspect_model.py'), '--',
                                str(src), str(WORK), '--yaw', '90', '--scale', '2', '--no-sheet'],
                               stdout=log, stderr=subprocess.STDOUT, timeout=300)
        self.assertEqual(r.returncode, 0, (WORK / 'blender.log').read_text(errors='replace')[-2000:])
        info = json.loads((WORK / 'slab_inspect.json').read_text())
        # Bounds come from the objects' own world matrices (what renders): scaled ×2, turned 90°
        # about the up axis, so the 4 m length now runs along the other horizontal axis.
        size = sorted(round(v, 3) for v in info['size_game'])
        self.assertEqual(size, [2.0, 4.0, 8.0])
        (x0, y0, z0), (x1, y1, z1) = info['bbox_game']
        self.assertAlmostEqual(abs(x1 - x0), 4.0, places=3)
        self.assertAlmostEqual(abs(z1 - z0), 8.0, places=3)
        self.assertAlmostEqual(abs(y1 - y0), 2.0, places=3)
        # …and the rendered scene is that same model (the views used to show it untransformed).
        for got, want in zip(sum(info['scene_bbox_game'], []), sum(info['bbox_game'], [])):
            self.assertAlmostEqual(got, want, places=3)


if __name__ == '__main__':
    unittest.main()
