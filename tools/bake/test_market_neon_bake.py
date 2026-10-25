"""Pure contract tests; no Blender, account, network or cloud invocation needed."""
import hashlib
import json
import math
from pathlib import Path
import unittest

from courtyard_bake import _encode_pixels, face_normal
from market_neon_bake import BOUNDS, geometry_fingerprint, lighting_fingerprint, sign_geometry, validate_scene


def tiny_scene():
    scene = {"version": 1, "kind": "market-neon-ground", "bounds": BOUNDS.copy(), "receiverY": .02,
             "occlusionPadding": 16, "sceneHash": "0123456789abcd", "layoutHash": "0123456789abcd",
             "sourceFingerprints": {"exporter": "a" * 64}, "limitations": ["tiny test scene"],
             "meshes": [{"name": "tri", "positions": [92, 0, 43, 94, 0, 43, 93, 1, 43],
                         "indices": [0, 1, 2], "color": [.5, .5, .5]}],
             "emitters": [{"label": "NOCNY RYNEK", "x": 93, "y": 4.25, "z": 45, "yaw": 180,
                           "w": 4.2, "h": 1.35, "color": 0xFF3DBD, "radiance": 120}]}
    scene["geometryFingerprint"] = geometry_fingerprint(scene["meshes"])
    scene["lightingFingerprint"] = lighting_fingerprint(scene["emitters"])
    return scene


class MarketNeonBakeTests(unittest.TestCase):
    def test_tiny_scene_validates_without_blender(self):
        validate_scene(tiny_scene(), 512, 128)

    def test_general_yaw_matches_browser_front_face_and_dimensions(self):
        for yaw in (0, 90, 180, -12, -92):
            with self.subTest(yaw=yaw):
                emitter = dict(tiny_scene()["emitters"][0], yaw=yaw)
                vertices, faces = sign_geometry(emitter)
                a, b, c = (vertices[i] for i in faces[0])
                normal = face_normal(a, b, c)
                self.assertAlmostEqual(normal[0], math.sin(math.radians(yaw)))
                self.assertAlmostEqual(normal[1], 0)
                self.assertAlmostEqual(normal[2], math.cos(math.radians(yaw)))
                self.assertAlmostEqual(math.dist(vertices[0], vertices[1]), emitter["w"])
                self.assertAlmostEqual(math.dist(vertices[1], vertices[2]), emitter["h"])

    def test_rejects_stale_bounds_and_geometry_or_emitter_edits(self):
        for edit in (lambda s: s["bounds"].__setitem__(0, 75),
                     lambda s: s["meshes"][0]["positions"].__setitem__(0, 93),
                     lambda s: s["emitters"][0].__setitem__("yaw", 90)):
            scene = tiny_scene()
            edit(scene)
            with self.assertRaises(ValueError):
                validate_scene(scene, 512, 128)

    def test_rejects_invalid_work_before_blender_import(self):
        for size, samples in ((2048, 128), (512, 129), (512, 0)):
            with self.assertRaises(ValueError):
                validate_scene(tiny_scene(), size, samples)
        scene = tiny_scene()
        scene["meshes"][0]["positions"][0] = float("nan")
        with self.assertRaisesRegex(ValueError, "finite"):
            validate_scene(scene, 512, 128)
        scene = tiny_scene()
        scene["meshes"][0]["indices"][0] = -1
        with self.assertRaisesRegex(ValueError, "indices"):
            validate_scene(scene, 512, 128)

    def test_rejects_excess_radiance_missing_sources_and_far_signs(self):
        for edit in (lambda s: s["emitters"][0].__setitem__("radiance", 121),
                     lambda s: s.__setitem__("sourceFingerprints", {}),
                     lambda s: s["emitters"][0].__setitem__("x", 300)):
            scene = tiny_scene()
            edit(scene)
            with self.assertRaises(ValueError):
                validate_scene(scene, 512, 128)

    def test_linear_encoder_preserves_row_order_and_counts_clipping(self):
        rgba, metrics = _encode_pixels([16, 0, 0, 1, 0, 32, 0, 1], 1, 2)
        self.assertEqual(rgba, bytes([255, 0, 0, 255, 0, 255, 0, 255]))
        self.assertEqual(metrics["clippedChannels"], 1)

    def test_staged_actual_export_cross_language_fingerprints(self):
        path = Path(__file__).parents[1] / "assets/build/market-neon-staging/scene.json"
        if not path.exists():
            self.skipTest("Run exporter to exercise actual-map cross-language fingerprint evidence")
        payload = path.read_bytes()
        scene = json.loads(payload)
        validate_scene(scene, 512, 128)
        self.assertLess(len(payload), 8 * 1024 * 1024)
        self.assertIn("NOCNY RYNEK", [e["label"] for e in scene["emitters"]])
        self.assertEqual(len(hashlib.sha256(payload).hexdigest()), 64)


if __name__ == "__main__":
    unittest.main()
