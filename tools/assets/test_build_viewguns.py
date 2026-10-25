"""The moving parts cut out of the gun scans sit where their measured anchors say (no raw scans
needed: reads the shipped, packed meshes through raw_models)."""
import json
import unittest

from build_heroes import accessor
from build_viewguns import OUT, PARTS, in_part, split_parts
from raw_models import raw_model


def shipped(gid: str) -> dict:
    """{node name: (positions, triangles)} of a shipped gun."""
    path = raw_model(OUT / f'{gid}.gltf')
    doc = json.loads(path.read_text())
    blob = (path.parent / doc['buffers'][0]['uri']).read_bytes()
    out = {}
    for node in doc['nodes']:
        prim = doc['meshes'][node['mesh']]['primitives'][0]
        pos = accessor(doc, blob, prim['attributes']['POSITION'])
        idx = [i[0] for i in accessor(doc, blob, prim['indices'])]
        out[node['name']] = (pos, [idx[i : i + 3] for i in range(0, len(idx), 3)])
    return out


def centroid(pos, t):
    return [sum(pos[i][k] for i in t) / 3 for k in range(3)]


class PartsTest(unittest.TestCase):
    def test_parts_are_where_the_anchors_say(self):
        manifest = json.loads((OUT / 'guns.json').read_text())['guns']
        for gid, specs in PARTS.items():
            nodes = shipped(gid)
            self.assertEqual(list(nodes)[0], gid)
            gen = manifest[gid]['generatedTriangles']
            body_pos, body_tris = nodes[gid]
            for name, spec in specs.items():
                with self.subTest(gun=gid, part=name):
                    pos, tris = nodes[name]
                    scan = tris[: len(tris) - (12 if spec.ext else 0)]  # extension box last
                    self.assertGreater(len(scan), 40)
                    # Every cut triangle lies in the measured region…
                    for t in scan:
                        self.assertTrue(in_part(spec, centroid(pos, t)))
                    # …the pivot sits on the part (within 1.5 cm of its bounds)…
                    lo = [min(p[k] for p in pos) for k in range(3)]
                    hi = [max(p[k] for p in pos) for k in range(3)]
                    for k in range(3):
                        self.assertGreater(spec.pivot[k], lo[k] - 0.015)
                        self.assertLess(spec.pivot[k], hi[k] + 0.015)
                    # …and nothing of the scan left in the body falls inside it.
                    n_scan_body = len(body_tris) - sum(
                        (12 if s.cap and s.ext else 0) + 32 * len(s.tubes) for s in specs.values())
                    self.assertGreaterEqual(n_scan_body, 0)
                    for t in body_tris[:n_scan_body]:
                        self.assertFalse(in_part(spec, centroid(body_pos, t)))
                    m = manifest[gid]['parts'][name]
                    self.assertEqual(m['pivot'], [round(c, 4) for c in spec.pivot])
                    self.assertAlmostEqual(sum(c * c for c in m['axis']), 1, places=2)
            self.assertEqual(
                sum(len(t) for _, t in nodes.values()), manifest[gid]['triangles'] + gen)

    def test_magazines_come_out_of_their_wells(self):
        # The removal axis points out of the gun (down, give or take the rake) and the magazine's
        # bulk lies along it from the pivot.
        for gid, specs in PARTS.items():
            for name in ('mag', 'cell'):
                spec = specs.get(name)
                if not spec:
                    continue
                with self.subTest(gun=gid, part=name):
                    self.assertLess(spec.axis[1], -0.9)
                    pos, tris = shipped(gid)[name]
                    scan = tris[: len(tris) - 12]
                    along = [sum((centroid(pos, t)[k] - spec.pivot[k]) * spec.axis[k] for k in range(3))
                             for t in scan]
                    # The pistol's scan shows only the floor plate (the body is the extension).
                    self.assertGreater(sum(along) / len(along), 0.0 if gid == 'pistol' else 0.01,
                                       f'{gid}.{name}')

    def test_split_assigns_each_triangle_once_and_adds_fillers(self):
        # A synthetic gun: one triangle inside the rifle magazine box, one elsewhere.
        v = lambda x, y, z: (x, y, z, 0, 1, 0, 0.5, 0.5)  # noqa: E731
        verts = [v(0, -0.1, -0.05), v(0.01, -0.1, -0.05), v(0, -0.09, -0.06),
                 v(0, 0.1, 0.3), v(0.01, 0.1, 0.3), v(0, 0.11, 0.3),
                 v(0, 0.12, 0.13), v(0.01, 0.12, 0.13), v(0, 0.125, 0.13)]
        parts = split_parts('rifle', verts, [(0, 1, 2), (3, 4, 5), (6, 7, 8)])
        names = [p[0] for p in parts]
        self.assertEqual(names, ['rifle', 'mag', 'bolt'])
        body, mag, bolt = parts
        self.assertEqual(len(mag[2]), 1 + 12)  # the cut + its extension box
        self.assertEqual(len(bolt[2]), 1)
        self.assertEqual(len(body[2]), 1 + 12)  # the rest + the dark well plug


if __name__ == '__main__':
    unittest.main()
