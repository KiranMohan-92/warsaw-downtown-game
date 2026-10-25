"""Shots at a wreck stop at what it draws, and only there: a 10 cm grid of axis rays at the
shipped tank and helicopter meshes (wreck_rays.py) against their real collision. Movement keeps
the tuned boxes, checked against direct Rapier cuboids; gameplay rays use PhysicsWorld and must hit
the shipped ray mesh.

- forward: each first mesh hit has a box no later than 10 cm past it (≤ 1 % tank, ≤ 2 % heli);
- reverse: each first box hit has the mesh no later than 15 cm past it (≤ 2 %): no invisible metal.

Boxes could not meet the limits (MEASURED; greedy fits stay far off at ~40 boxes, wreck_fit.py), so
every ray now hits a ray mesh built from the visible mesh (build_wreck_collision.py →
packages/shared/src/maps/wreckGeometry.gen.json) and the boxes serve movement only. Rerun
`python tools/assets/wreck_rays.py` for the clustered misses.
"""

import re
import unittest
from pathlib import Path

import numpy as np

import wreck_rays as wr
from raw_models import MODELS
from vehicle_spec import WRECK_BOXES

PROPS = Path(__file__).resolve().parents[2] / 'packages/shared/src/maps/props.ts'
MAX_FWD = {'tank_wreck': 0.01, 'heli_wreck': 0.02}
MAX_REV = 0.02
# Rapier, 2026-10-03, the shipped boxes: forward / reverse.
MEASURED = {'tank_wreck': ('2093 / 7927 (26.4 %)', '4165 / 8491 (49.1 %)'),
            'heli_wreck': ('1711 / 9602 (17.8 %)', '8492 / 11865 (71.6 %)')}


class WreckRayTest(unittest.TestCase):
    tris: dict = {}
    grid: dict = {}

    @classmethod
    def setUpClass(cls):
        cls.tris = {m: wr.mesh_triangles(MODELS / f'vehicles/{m}.gltf') for m in wr.WRECKS}
        cls.grid = {m: wr.ray_grid(t) for m, t in cls.tris.items()}
        cls.hits = {}
        for m, (_, o, d, _) in cls.grid.items():
            py = wr.first_box_hit(o, d, [wr.box_inverse(b) for b in wr.WRECKS[m]()])
            cls.hits[m] = (py, wr.rapier_box_hits(m.split('_')[0], o, d))

    def test_python_slab_maths_is_what_rapier_hits(self):
        # The grid is axis-aligned: exactly the parallel-ray case the old slab test got wrong.
        for m, (py, ra) in self.hits.items():
            both = np.isfinite(py) & np.isfinite(ra)
            differ = (np.isfinite(py) != np.isfinite(ra)) | (both & (np.abs(np.where(both, py, 0) - np.where(both, ra, 0)) > 0.01))
            self.assertLessEqual(int(differ.sum()), 5, f'{m}: {int(differ.sum())} / {len(py)} rays differ')

    def test_parallel_ray_outside_a_slab_misses(self):
        # Codex: a ray from (−2, 2, 0) along +X "hit" a unit box at 1.5.
        inv = [wr.box_inverse({'c': (0, 0, 0), 's': (1, 1, 1)})]
        o = np.array([[-2.0, 2.0, 0.0], [-2.0, 0.0, 0.0]])
        d = np.array([[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
        hit = wr.first_box_hit(o, d, inv)
        self.assertTrue(np.isinf(hit[0]))
        self.assertAlmostEqual(hit[1], 1.5)

    def test_ray_mesh_meets_the_drawn_surface_and_only_there(self):
        # The shipped ray mesh (wreckGeometry.gen.json): what bullets and every ray hit.
        for m, (names, o, d, tm) in self.grid.items():
            r = wr.evaluate(o, d, tm, wr.mesh_hits(wr.ray_mesh(m), names, o), wr.SKIPS.get(m))
            self.assertGreater(r['mesh'], 5000, m)
            self.assertLessEqual(r['fwd'].sum() / r['mesh'], MAX_FWD[m], f"{m}: forward {r['fwd'].sum()} / {r['mesh']}")
            self.assertLessEqual(r['rev'].sum() / r['box'], MAX_REV, f"{m}: reverse {r['rev'].sum()} / {r['box']}")

    def test_gameplay_rapier_queries_hit_the_ray_mesh(self):
        # The real PhysicsWorld must agree with the ray mesh on rays where the old movement boxes
        # visibly differ: this is the server/client combat, LOS, camera and bake path.
        for m, (names, o, d, _) in self.grid.items():
            mesh = wr.mesh_hits(wr.ray_mesh(m), names, o)
            box = wr.first_box_hit(o, d, [wr.box_inverse(b) for b in wr.WRECKS[m]()])
            finite_box = np.isfinite(box)
            box_delta = np.zeros_like(mesh)
            box_delta[finite_box] = np.abs(mesh[finite_box] - box[finite_box])
            differs_from_boxes = np.isfinite(mesh) & (o[:, 1] > 0.4) & (
                ~finite_box | (box_delta > 0.25)
            )
            sample = np.nonzero(differs_from_boxes)[0][:48]
            self.assertEqual(len(sample), 48, m)
            rapier = wr.rapier_world_hits(m.split('_')[0], o[sample], d[sample])
            delta = np.abs(rapier - mesh[sample])
            self.assertTrue(np.isfinite(rapier).all(), m)
            self.assertLessEqual(float(delta.max()), 0.02, m)

    def test_ray_mesh_decodes_identically_in_the_game(self):
        # Server and client build the trimesh from shared/maps/wreckGeometry.ts: its decoded arrays
        # must be byte-identical to the ones these gates measure (float32 positions, uint32 indices).
        import hashlib
        import json
        import subprocess
        from build_wreck_collision import decode
        root = Path(__file__).resolve().parents[2]
        res = subprocess.run(['node', str(root / 'packages/server/node_modules/tsx/dist/cli.mjs'),
                              str(Path(__file__).parent / 'wreck_rays_rapier.ts'), 'decode'],
                             cwd=root, capture_output=True, text=True, check=True)
        ts = json.loads(res.stdout)
        data = json.loads(wr.RAY_MESH.read_text(encoding='utf-8'))['models']
        self.assertEqual(set(ts), set(data))
        for m, g in data.items():
            pos, idx = decode(g)
            self.assertEqual(hashlib.sha256(pos.astype('<f4').tobytes()).hexdigest(), ts[m]['positions'], m)
            self.assertEqual(hashlib.sha256(idx.astype('<u4').tobytes()).hexdigest(), ts[m]['indices'], m)

    def test_ray_mesh_data_is_intact(self):
        import hashlib
        import json
        data = json.loads(wr.RAY_MESH.read_text(encoding='utf-8'))
        body = data['models']
        self.assertEqual(hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16], data['hash'])
        for m, g in body.items():
            tris = wr.ray_mesh(m)
            self.assertEqual(len(tris), g['triangles'], m)
            self.assertTrue(np.isfinite(tris).all(), m)

    def test_the_bustle_ray_from_review(self):
        # Codex P2: prop-local ray (3.1, 2.7, −5) along +Z met the mesh at z ≈ −0.86, no box.
        o = np.array([[3.1, 2.7, -5.0]])
        d = np.array([[0.0, 0.0, 1.0]])
        tm = wr.mesh_hits(wr.ray_mesh('tank_wreck'), ['+z'], o)[0]
        tb = wr.first_box_hit(o, d, [wr.box_inverse(b) for b in wr.tank_boxes()])[0]
        self.assertTrue(np.isfinite(tm))
        self.assertGreater(abs(tb - tm), 0.04)
        self.assertAlmostEqual(wr.rapier_world_hits('tank', o, d)[0], tm, delta=0.02)

    def test_overlay_boxes_are_the_shipped_props(self):
        # render_vehicles.py --boxes heli|tank draws wreck_rays.collision_boxes(); that list must be
        # props.ts's, box for box (Codex: the overlay once drew the obsolete 13-box helicopter).
        for kind, want in (('heli', props_boxes('helicopterWreck')), ('tank', props_boxes('tankWreck'))):
            got = wr.collision_boxes(kind)
            self.assertEqual(len(got), len(want), kind)
            for i, (g, w) in enumerate(zip(got, want)):
                for k in ('c', 's', 'rot'):
                    gv = [float(v) for v in g.get(k, (0, 0, 0))]
                    for x, y in zip(gv, w[k]):
                        self.assertAlmostEqual(x, y, places=3, msg=(kind, i, k))
        src = (Path(__file__).parent / 'render_vehicles.py').read_text(encoding='utf-8')
        self.assertIn('collision_boxes(kind)', src)
        self.assertNotIn('from vehicle_spec import', src)  # no second, hand-kept table

    def test_tank_spec_is_the_props(self):
        # vehicle_spec.WRECK_BOXES['tank'] is what the rays test; props.ts tankWreck must match.
        want = list(WRECK_BOXES['tank'].values())
        got = props_boxes('tankWreck')
        self.assertEqual(len(got), len(want))
        for g, b in zip(got, want):
            for k in ('c', 's'):
                for x, y in zip(g[k], b[k]):
                    self.assertAlmostEqual(x, y, places=3, msg=b)
            self.assertEqual(tuple(g['rot']), tuple(float(v) for v in b.get('rot', (0, 0, 0))))


def props_boxes(fn_name):
    """The collision boxes of props.ts `<fn_name>` at the origin (rot 0) as {c, s, rot} lists:
    `box(x, y, z, w, h, d, rx, ry, rz)` rows (helicopter) or `lb(x, z, w, h, d, 'metal'[, y0])`
    with an optional `tilt` (tank)."""
    src = PROPS.read_text(encoding='utf-8')
    fn = src[src.index(f'export function {fn_name}'):]
    fn = fn[: fn.index('\n}\n')]
    body = fn[fn.index('place(at, ['):]
    out = []
    for nums in re.findall(r'\bbox\(\s*([-\d.,\s]+?)\s*\)', body):
        v = [float(x) for x in nums.split(',') if x.strip()]
        out.append({'c': v[0:3], 's': v[3:6], 'rot': v[6:9]})
    rows = re.findall(r"lb\(\s*([-\d.,\s]+?),\s*'metal'(?:,\s*([-\d.]+))?\s*\)(?:,\s*tilt:\s*\{\s*x:\s*([-\d.]+),"
                      r"\s*y:\s*([-\d.]+),\s*z:\s*([-\d.]+)\s*\})?", body)
    for nums, y0, rx, ry, rz in rows:
        x, z, w, h, d = (float(v) for v in nums.split(','))
        out.append({'c': [x, float(y0 or 0) + h / 2, z], 's': [w, h, d],
                    'rot': [float(v) for v in (rx or 0, ry or 0, rz or 0)]})
    return out


if __name__ == '__main__':
    unittest.main()
