import copy
import hashlib
import json
import unittest

from market_neon_static_bake import (
    HOUSING_COLOR,
    housing_name,
    receiver_fingerprint,
    sign_housing_geometry,
    validate_static_scene,
)
from market_neon_bake import BOUNDS, geometry_fingerprint, lighting_fingerprint


def tiny_static_scene():
    mesh = {
        "name": "occluder",
        "positions": [92, 0, 43, 94, 0, 43, 93, 1, 43],
        "indices": [0, 1, 2],
        "color": [0.5, 0.5, 0.5],
    }
    receiver = {
        "positions": [
            92, 0, 43, 94, 0, 43, 94, 2, 43, 92, 2, 43,
            92, 0, 44, 94, 0, 44, 94, 2, 44, 92, 2, 44,
            92, 0, 45, 94, 0, 45, 94, 2, 45, 92, 2, 45,
            92, 0, 46, 94, 0, 46, 94, 2, 46, 92, 2, 46,
            92, 0, 47, 94, 0, 47, 94, 2, 47, 92, 2, 47,
            92, 0, 48, 94, 0, 48, 94, 2, 48, 92, 2, 48,
        ],
        "indices": sum(([i, i + 1, i + 2, i, i + 2, i + 3] for i in range(0, 24, 4)), []),
        "uvs": [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]] * 6,
        "receivers": [{"boxIndex": 7, "material": "container", "faceRects": [1, 2, 3, 4, 5, 6]}],
        "receiverMaterials": ["container"],
    }
    emitter = {
        "label": "NOCNY RYNEK",
        "x": 93,
        "y": 4.25,
        "z": 45,
        "yaw": 180,
        "w": 4.2,
        "h": 1.35,
        "color": 0xFF3DBD,
        "radiance": 120,
    }
    housing_vertices, housing_faces = sign_housing_geometry(emitter)
    housing = {
        "name": housing_name(emitter),
        "positions": [v for vertex in housing_vertices for v in vertex],
        "indices": [i for face in housing_faces for tri in ((face[0], face[1], face[2]), (face[0], face[2], face[3])) for i in tri],
        "color": HOUSING_COLOR,
    }
    scene = {
        "version": 1,
        "kind": "market-neon-static-atlas",
        "bounds": BOUNDS.copy(),
        "receiverY": 0.02,
        "occlusionPadding": 16,
        "sceneHash": "0123456789abcd",
        "layoutHash": "0123456789abcd",
        "atlas": {"width": 2048, "height": 1560},
        "meshes": [mesh, housing],
        "receiver": receiver,
        "emitters": [emitter],
        "sourceFingerprints": {"tools/bake/export-market-neon-static.mjs": "a" * 64},
        "limitations": ["tiny static scene"],
        "receiverMaterials": ["container"],
    }
    scene["geometryFingerprint"] = geometry_fingerprint(scene["meshes"])
    scene["lightingFingerprint"] = lighting_fingerprint(scene["emitters"])
    scene["receiverFingerprint"] = receiver_fingerprint(receiver)
    return scene


class MarketNeonStaticBakeTests(unittest.TestCase):
    def test_cuda_selects_only_real_cuda_devices_and_refuses_cpu_fallback(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from market_neon_static_bake import configure_device

        cuda = SimpleNamespace(type="CUDA", name="test CUDA device", use=False)
        cpu = SimpleNamespace(type="CPU", name="test CPU", use=True)
        prefs = SimpleNamespace(devices=[cpu, cuda], get_devices=Mock())
        bpy = SimpleNamespace(context=SimpleNamespace(preferences=SimpleNamespace(
            addons={"cycles": SimpleNamespace(preferences=prefs)})))
        render = SimpleNamespace(cycles=SimpleNamespace(device="CPU"))
        self.assertEqual(configure_device(bpy, render, "cuda"), ["test CUDA device"])
        self.assertEqual(render.cycles.device, "GPU")
        self.assertFalse(cpu.use)
        self.assertTrue(cuda.use)
        prefs.devices = [cpu]
        with self.assertRaisesRegex(RuntimeError, "refusing CPU fallback"):
            configure_device(bpy, render, "cuda")
        self.assertEqual(render.cycles.device, "CPU")
        prefs.get_devices.reset_mock()
        self.assertEqual(configure_device(bpy, render, "cpu"), [])
        prefs.get_devices.assert_not_called()

    def test_tiny_scene_validates_without_blender(self):
        validate_static_scene(tiny_static_scene(), 128)

    def test_static_scene_requires_opaque_housing_behind_each_emitter(self):
        scene = tiny_static_scene()
        emitter = scene["emitters"][0]
        housing = next(mesh for mesh in scene["meshes"] if mesh["name"] == housing_name(emitter))
        panel_z = emitter["z"]
        housing_z = housing["positions"][2::3]
        self.assertGreater(min(housing_z), panel_z)

        scene["meshes"] = [mesh for mesh in scene["meshes"] if mesh["name"] != housing_name(emitter)]
        scene["geometryFingerprint"] = geometry_fingerprint(scene["meshes"])
        with self.assertRaisesRegex(ValueError, "Missing opaque sign housing"):
            validate_static_scene(scene, 128)

    def test_rejects_misplaced_or_nonopaque_housing_even_with_current_fingerprint(self):
        for field, value in (("positions", [0] * 24), ("indices", [0, 1, 2]), ("color", [1, 1, 1])):
            with self.subTest(field=field):
                scene = tiny_static_scene()
                scene["meshes"][1][field] = value
                scene["geometryFingerprint"] = geometry_fingerprint(scene["meshes"])
                with self.assertRaisesRegex(ValueError, "Sign housing must match"):
                    validate_static_scene(scene, 128)

    def test_rejects_receiver_uv_hash_dimensions_and_duplicate_receivers(self):
        edits = (
            lambda s: s["atlas"].__setitem__("height", 4097),
            lambda s: s["receiver"]["uvs"][0].__setitem__(0, 1.5),
            lambda s: s["receiver"]["receivers"].append(copy.deepcopy(s["receiver"]["receivers"][0])),
            lambda s: s.__setitem__("receiverFingerprint", "b" * 64),
        )
        for edit in edits:
            scene = tiny_static_scene()
            edit(scene)
            with self.assertRaises(ValueError):
                validate_static_scene(scene, 128)

    def test_rejects_specialized_receiver_materials_and_changed_occluders(self):
        scene = tiny_static_scene()
        scene["receiver"]["receivers"][0]["material"] = "sandbag"
        scene["receiverFingerprint"] = receiver_fingerprint(scene["receiver"])
        with self.assertRaises(ValueError):
            validate_static_scene(scene, 128)
        scene = tiny_static_scene()
        scene["meshes"][0]["positions"][0] += 1
        with self.assertRaisesRegex(ValueError, "Geometry"):
            validate_static_scene(scene, 128)

    def test_actual_staged_export_validates_when_present(self):
        path = __import__("pathlib").Path(__file__).parents[1] / "assets/build/market-neon-static/scene.json"
        if not path.exists():
            self.skipTest("Run static exporter to exercise actual-map scene")
        payload = path.read_bytes()
        scene = json.loads(payload)
        validate_static_scene(scene, 128)
        self.assertLess(len(payload), 8 * 1024 * 1024)
        self.assertLessEqual(scene["atlas"]["width"] * scene["atlas"]["height"] * 4, 32 * 1024 * 1024)
        self.assertEqual(hashlib.sha256(payload).hexdigest(), hashlib.sha256(payload).hexdigest())


if __name__ == "__main__":
    unittest.main()
