import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from courtyard_bake import write_png
import install_market_neon_static as installer
from market_neon_static_bake import ENCODING, PNG_FILE
from test_market_neon_static_bake import tiny_static_scene


class InstallMarketNeonStaticTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.scope = patch.object(installer, "ROOT", self.root)
        self.scope.start()
        self.source = self.root / "staging"
        self.source.mkdir()
        self.scene = tiny_static_scene()
        self.scene["sourceFingerprints"] = {}
        for name in ("tools/bake/export-market-neon-static.mjs", "tools/bake/market_neon_static_bake.py", "tools/bake/install_market_neon_static.py"):
            source = self.root / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"fixture source")
            self.scene["sourceFingerprints"][name] = hashlib.sha256(source.read_bytes()).hexdigest()
        self.scene_path = self.source / "scene.json"
        payload = json.dumps(self.scene).encode()
        self.scene_path.write_bytes(payload)
        width, height = self.scene["atlas"]["width"], self.scene["atlas"]["height"]
        rgba = bytearray([0, 0, 0, 255]) * (width * height)
        rgba[0:4] = bytes([17, 17, 17, 255])
        write_png(self.source / PNG_FILE, width, height, bytes(rgba))
        png = (self.source / PNG_FILE).read_bytes()
        keys = (
            "version", "kind", "sceneHash", "layoutHash", "bounds", "receiverY", "occlusionPadding",
            "emitters", "geometryFingerprint", "lightingFingerprint", "receiverFingerprint",
            "receiverMaterials", "sourceFingerprints", "limitations",
        )
        self.manifest = {key: self.scene[key] for key in keys}
        self.manifest.update(
            file=PNG_FILE,
            width=width,
            height=height,
            samples=128,
            radianceScale=16,
            encoding=ENCODING,
            inputSha256=hashlib.sha256(payload).hexdigest(),
            textureHash=hashlib.sha256(png).hexdigest(),
            receiverCount=1,
            device="CPU",
            metrics={
                "elapsedSeconds": 1,
                "meshes": 1,
                "triangles": 1,
                "receiverTriangles": 12,
                "pngBytes": len(png),
                "pixels": {
                    "min": 0,
                    "max": 17 / 255 * 16,
                    "mean": 0.001,
                    "nonzeroChannels": 3,
                    "clippedChannels": 0,
                },
            },
        )
        self.write_manifest()

    def tearDown(self):
        self.scope.stop()
        self.directory.cleanup()

    def write_manifest(self):
        (self.source / "manifest.json").write_text(json.dumps(self.manifest))

    def test_valid_sparse_static_atlas_is_honest_and_complete(self):
        validated = installer.validate_result(self.source, self.scene_path)
        self.assertEqual(validated["device"], "CPU")
        self.assertEqual(validated["receiverCount"], 1)

    def test_cuda_requires_devices_and_cpu_rejects_a_gpu_claim(self):
        self.manifest.update(device="CUDA", gpuDevices=["test CUDA device"])
        self.write_manifest()
        self.assertEqual(installer.validate_result(self.source, self.scene_path)["device"], "CUDA")
        for device, devices in (("CUDA", []), ("CPU", ["claimed GPU"]), ("CUDA", [""]), ("other", [])):
            self.manifest.update(device=device, gpuDevices=devices)
            self.write_manifest()
            with self.assertRaisesRegex(ValueError, "provenance"):
                installer.validate_result(self.source, self.scene_path)

    def test_rejects_wrong_dimensions_hash_samples_or_blackless_atlas(self):
        for key, value in (("width", 1024), ("inputSha256", "b" * 64), ("samples", 64), ("textureHash", "c" * 64)):
            original = self.manifest[key]
            self.manifest[key] = value
            self.write_manifest()
            with self.assertRaises(ValueError):
                installer.validate_result(self.source, self.scene_path)
            self.manifest[key] = original
        width, height = self.scene["atlas"]["width"], self.scene["atlas"]["height"]
        write_png(self.source / PNG_FILE, width, height, bytes([17, 17, 17, 255]) * (width * height))
        self.manifest["textureHash"] = hashlib.sha256((self.source / PNG_FILE).read_bytes()).hexdigest()
        self.manifest["metrics"]["pngBytes"] = (self.source / PNG_FILE).stat().st_size
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "black"):
            installer.validate_result(self.source, self.scene_path)

    def test_rejects_exporter_source_change_before_install(self):
        (self.root / "tools/bake/export-market-neon-static.mjs").write_bytes(b"changed source")
        with self.assertRaisesRegex(ValueError, "Source changed"):
            installer.validate_result(self.source, self.scene_path)

    def test_allowlisted_install_writes_only_static_public_asset_and_generated_module(self):
        (self.root / ".git").write_text("gitdir: .git-linked")
        runtime = self.root / "packages/client/src/render"
        runtime.mkdir(parents=True)
        with patch.object(installer.subprocess, "run", return_value=types.SimpleNamespace(stdout="codex/isolated-finish\n")), patch("builtins.print"):
            installer.install(self.source, self.scene_path)
        files = sorted(
            p.relative_to(self.root / "packages").as_posix()
            for p in (self.root / "packages").rglob("*")
            if p.is_file()
        )
        self.assertEqual(
            files,
            [
                "client/public/lightmaps/market-neon-static/manifest.json",
                "client/public/lightmaps/market-neon-static/market-neon-static.png",
                "client/src/render/marketNeonStaticManifest.ts",
            ],
        )
        module = (runtime / "marketNeonStaticManifest.ts").read_text()
        self.assertIn("export const MARKET_NEON_STATIC_BAKE", module)
        self.assertIn('"receiverCount": 1', module)
        self.assertIn('"device": "CPU"', module)


if __name__ == "__main__":
    unittest.main()
