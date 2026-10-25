"""Modal boundary tests with fake API/CUDA receipts; these are not remote GPU evidence."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from courtyard_bake import write_png
from test_market_neon_bake import tiny_scene
from test_market_neon_static_bake import tiny_static_scene


class FakeImage:
    def __init__(self):
        self.files = []
    @classmethod
    def debian_slim(cls, **kwargs):
        return cls()
    def env(self, *args, **kwargs):
        return self
    def apt_install(self, *args):
        return self
    def uv_pip_install(self, *args):
        return self
    def add_local_file(self, source, target, **kwargs):
        self.files.append((source, target))
        return self


class FakeApp:
    def __init__(self, name):
        self.options = None
    def function(self, **kwargs):
        self.options = kwargs
        def decorate(fn):
            fn.remote = Mock(side_effect=AssertionError("Unexpected cloud invocation"))
            return fn
        return decorate
    def local_entrypoint(self):
        return lambda fn: fn


class ModalMarketNeonTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("test_market_neon_modal", Path(__file__).with_name("modal_market_neon.py"))
        self.job = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"modal": types.SimpleNamespace(Image=FakeImage, App=FakeApp)}):
            spec.loader.exec_module(self.job)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.job.PROJECT_ROOT = self.root
        self.source = self.root / "scene.json"
        self.target = self.root / "tools/assets/build/mock-output"

    def stage_scene(self, mode="ground"):
        scene = tiny_static_scene() if mode == "static" else tiny_scene()
        if mode == "static":
            scene["atlas"] = {"width": 64, "height": 48}
        required = ("export-market-neon.mjs", "market_neon_bake.py", "courtyard_bake.py")
        if mode == "static":
            required += ("export-market-neon-static.mjs", "market_neon_static_bake.py", "install_market_neon_static.py")
        scene["sourceFingerprints"] = {}
        for name in required:
            relative = f"tools/bake/{name}"
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"mock source fixture")
            scene["sourceFingerprints"][relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.source.write_bytes(json.dumps(scene).encode())
        return scene

    def response(self, scene, mode="ground", size=512, samples=128):
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        filename, width, height, _ = self.job.validate_request(scene, size, samples, mode)
        png_path = self.root / "fixture.png"
        # Sparse static receiver contract: one lit pixel, opaque black unused slots.
        rgba = bytes([1, 0, 0, 255]) + bytes([0, 0, 0, 255]) * (width * height - 1)
        write_png(png_path, width, height, rgba)
        png = png_path.read_bytes()
        manifest = {key: scene[key] for key in self.job.COMMON_KEYS}
        manifest.update(device="CUDA", inputSha256=digest, width=width, height=height, samples=samples,
                        radianceScale=16, file=filename, textureHash=hashlib.sha256(png).hexdigest(),
                        encoding=self.job.STATIC_ENCODING if mode == "static" else self.job.GROUND_ENCODING,
                        gpuDevices=["mock CUDA device"],
                        metrics={"elapsedSeconds": 1.5, "pngBytes": len(png), "meshes": len(scene["meshes"]),
                                 "triangles": sum(len(m["indices"]) // 3 for m in scene["meshes"]),
                                 "pixels": {"min": 0, "max": 1, "mean": .01, "nonzeroChannels": 1, "clippedChannels": 0}})
        if mode == "static":
            manifest.update(receiverFingerprint=scene["receiverFingerprint"], receiverMaterials=scene["receiverMaterials"],
                            receiverCount=len(scene["receiver"]["receivers"]))
            manifest["metrics"]["receiverTriangles"] = len(scene["receiver"]["indices"]) // 3
        files = {filename: png, "manifest.json": json.dumps(manifest).encode()}
        result = {"files": files, "mode": mode, "inputSha256": digest, "geometryFingerprint": scene["geometryFingerprint"],
                  "lightingFingerprint": scene["lightingFingerprint"], "sourceFingerprints": copy.deepcopy(scene["sourceFingerprints"]),
                  "gpu": "L4", "gpuDevices": ["mock CUDA device"], "elapsedSeconds": 2,
                  "timeoutSeconds": 600, "fileSha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        if mode == "static":
            result["receiverFingerprint"] = scene["receiverFingerprint"]
        return result

    def run_main(self, mode="ground"):
        with patch("builtins.print"):
            self.job.main(str(self.source), str(self.target), .25, mode=mode)

    def test_import_unapproved_nonfinite_budget_never_invoke_cloud(self):
        for budget in (0, -1, float("nan"), float("inf"), True):
            with self.assertRaisesRegex(ValueError, "spending limit"):
                self.job.main("missing", "missing", budget)
        self.job.bake_landmark.remote.assert_not_called()

    def test_worker_resource_caps_and_static_baker_in_image(self):
        cfg = self.job.app.options
        self.assertEqual({key: cfg[key] for key in ("gpu", "cpu", "memory", "timeout", "max_containers", "retries", "scaledown_window")},
                         {"gpu": "L4", "cpu": 4, "memory": 8192, "timeout": 600, "max_containers": 1, "retries": 0, "scaledown_window": 2})
        self.assertIn("/opt/market_neon_static_bake.py", [target for _, target in self.job.image.files])

    def test_remote_rejects_oversized_bad_dimensions_samples_mode_before_blender(self):
        with self.assertRaisesRegex(ValueError, "8 MiB"):
            self.job.bake_landmark(b"x" * (8 * 1024 * 1024 + 1))
        for size, samples in ((256, 64), (2048, 128), (512, 129), (True, 128)):
            with self.assertRaisesRegex(ValueError, "Cloud bake limited"):
                self.job.bake_landmark(b"{}", size, samples)
        with self.assertRaisesRegex(ValueError, "mode"):
            self.job.bake_landmark(b"{}", mode="unbounded")

    def test_existing_live_and_outside_output_never_call_remote(self):
        self.stage_scene()
        self.target.mkdir(parents=True)
        for target in (self.target, self.root / "packages/client/public/lightmaps/new", self.root / "outside"):
            with self.assertRaisesRegex(ValueError, "new staging"):
                self.job.main(str(self.source), str(target), 1)
        self.job.bake_landmark.remote.assert_not_called()

    def test_missing_stale_and_escaping_sources_never_call_remote(self):
        for edit in (lambda s: s["sourceFingerprints"].clear(),
                     lambda s: s["sourceFingerprints"].__setitem__("tools/bake/courtyard_bake.py", "0" * 64),
                     lambda s: s["sourceFingerprints"].__setitem__("../outside.py", "a" * 64)):
            scene = self.stage_scene("static")
            edit(scene)
            self.source.write_text(json.dumps(scene))
            with self.assertRaises(ValueError):
                self.run_main("static")
        self.job.bake_landmark.remote.assert_not_called()

    def test_static_rejects_unbounded_receiver_and_emitters_before_blender(self):
        for edit in (lambda s: s["receiver"]["positions"].__setitem__(0, float("nan")),
                     lambda s: s["emitters"][0].__setitem__("radiance", 121),
                     lambda s: s["receiverMaterials"].clear()):
            scene = self.stage_scene("static")
            edit(scene)
            from market_neon_static_bake import receiver_fingerprint
            from market_neon_bake import lighting_fingerprint
            scene["receiverFingerprint"] = receiver_fingerprint(scene["receiver"])
            scene["lightingFingerprint"] = lighting_fingerprint(scene["emitters"])
            with self.assertRaises(ValueError):
                self.job.validate_request(scene, 512, 128, "static")

    def test_ground_and_static_mock_staging_receipts_preserve_budget_caveat(self):
        for mode in ("ground", "static"):
            scene = self.stage_scene(mode)
            self.target = self.root / f"tools/assets/build/mock-{mode}"
            self.job.bake_landmark.remote = Mock(return_value=self.response(scene, mode))
            self.run_main(mode)
            self.job.bake_landmark.remote.assert_called_once_with(self.source.read_bytes(), 512, 128, mode)
            receipt = json.loads((self.target / "receipt.json").read_text())
            self.assertFalse(receipt["budgetIsEnforcedByModal"])
            self.assertEqual(receipt["approvedBudgetUsd"], .25)
            self.assertEqual(receipt["mode"], mode)
            self.assertEqual(set(p.name for p in self.target.iterdir()), {f"market-neon-{mode}.png", "manifest.json", "receipt.json"})
            self.assertEqual((receipt["width"], receipt["height"]), (64, 48) if mode == "static" else (512, 512))

    def test_receipt_mode_gpu_hash_timing_mismatches_write_nothing(self):
        scene = self.stage_scene("static")
        for key, value in (("inputSha256", "bad"), ("receiverFingerprint", "0" * 64), ("gpu", "unknown"),
                           ("gpuDevices", ["contradictory GPU"]), ("elapsedSeconds", float("nan")),
                           ("timeoutSeconds", 601), ("fileSha256", {}), ("mode", "ground")):
            result = self.response(scene, "static")
            result[key] = value
            self.job.bake_landmark.remote = Mock(return_value=result)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.run_main("static")
            self.assertFalse(self.target.exists())

    def test_manifest_cpu_encoding_receiver_sources_dimensions_and_metrics_rejected(self):
        scene = self.stage_scene("static")
        for key, value in (("device", "CPU"), ("gpuDevices", []), ("encoding", "sRGB"), ("receiverCount", 2),
                           ("receiverFingerprint", "0" * 64), ("sourceFingerprints", {}), ("width", 65),
                           ("textureHash", "0" * 64), ("samples", 127), ("metrics", {})):
            result = self.response(scene, "static")
            manifest = json.loads(result["files"]["manifest.json"])
            manifest[key] = value
            result["files"]["manifest.json"] = json.dumps(manifest).encode()
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.job.validate_result(result["files"], scene, result["inputSha256"], 512, 128, "static")

    def test_corrupt_png_extra_file_oversized_manifest_rejected(self):
        scene = self.stage_scene("static")
        for mutation in (lambda f: f.__setitem__("evil.txt", b"bad"),
                         lambda f: f.__setitem__("market-neon-static.png", b"fake"),
                         lambda f: f.__setitem__("manifest.json", b" " * (64 * 1024 + 1))):
            result = self.response(scene, "static")
            mutation(result["files"])
            with self.assertRaises(ValueError):
                self.job.validate_result(result["files"], scene, result["inputSha256"], 512, 128, "static")

    def test_source_edit_during_remote_call_rejected_before_write(self):
        scene = self.stage_scene("static")
        result = self.response(scene, "static")
        def changed(*args):
            (self.root / "tools/bake/market_neon_static_bake.py").write_bytes(b"changed")
            return result
        self.job.bake_landmark.remote = Mock(side_effect=changed)
        with self.assertRaisesRegex(ValueError, "Source changed"):
            self.run_main("static")
        self.assertFalse(self.target.exists())

    def test_static_png_pixels_reject_black_or_fully_lit_atlas_despite_manifest_metrics(self):
        scene = self.stage_scene("static")
        for pixel in (bytes([0, 0, 0, 255]), bytes([1, 1, 1, 255])):
            result = self.response(scene, "static")
            path = self.root / "fixture.png"
            write_png(path, 64, 48, pixel * (64 * 48))
            png = path.read_bytes()
            result["files"]["market-neon-static.png"] = png
            manifest = json.loads(result["files"]["manifest.json"])
            manifest["textureHash"] = hashlib.sha256(png).hexdigest()
            manifest["metrics"]["pngBytes"] = len(png)
            result["files"]["manifest.json"] = json.dumps(manifest).encode()
            with self.assertRaisesRegex(ValueError, "lit receiver"):
                self.job.validate_result(result["files"], scene, result["inputSha256"], 512, 128, "static")


if __name__ == "__main__":
    unittest.main()
