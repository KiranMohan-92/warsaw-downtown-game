"""Strict installer accepts only exact staged provenance and isolated allowlisted targets."""
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from courtyard_bake import write_png
import install_market_neon as installer
from test_market_neon_bake import tiny_scene


class InstallMarketNeonTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.scope = patch.object(installer, "ROOT", self.root)
        self.scope.start()
        self.source = self.root / "staging"
        self.source.mkdir()
        self.scene = tiny_scene()
        self.scene["sourceFingerprints"] = {}
        for name in ("tools/bake/export-market-neon.mjs", "tools/bake/market_neon_bake.py", "tools/bake/courtyard_bake.py"):
            source = self.root / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"fixture source")
            self.scene["sourceFingerprints"][name] = hashlib.sha256(source.read_bytes()).hexdigest()
        self.scene_path = self.source / "scene.json"
        payload = json.dumps(self.scene).encode()
        self.scene_path.write_bytes(payload)
        write_png(self.source / installer.PNG_FILE, 512, 512, bytes([17, 17, 17, 255]) * (512 * 512))
        png = (self.source / installer.PNG_FILE).read_bytes()
        keys = ("version", "kind", "sceneHash", "layoutHash", "bounds", "receiverY", "occlusionPadding", "emitters", "geometryFingerprint", "lightingFingerprint", "sourceFingerprints", "limitations")
        self.manifest = {key: self.scene[key] for key in keys}
        self.manifest.update(file=installer.PNG_FILE, width=512, height=512, samples=128, radianceScale=16,
            encoding=installer.ENCODING, inputSha256=hashlib.sha256(payload).hexdigest(),
            textureHash=hashlib.sha256(png).hexdigest(), device="CPU", gpuDevices=[],
            metrics={"elapsedSeconds": 1, "meshes": 1, "triangles": 1, "pngBytes": len(png),
                     "pixels": {"min": 17 / 255 * 16, "max": 17 / 255 * 16, "mean": 17 / 255 * 16,
                                "nonzeroChannels": 512 * 512 * 3, "clippedChannels": 0}})
        self.write_manifest()

    def tearDown(self):
        self.scope.stop()
        self.directory.cleanup()

    def write_manifest(self):
        (self.source / "manifest.json").write_text(json.dumps(self.manifest))

    def test_valid_cpu_reference_is_honest_and_complete(self):
        validated = installer.validate_result(self.source, self.scene_path)
        self.assertEqual(validated["device"], "CPU")
        self.assertEqual(validated["gpuDevices"], [])

    def test_rejects_bad_orientation_bounds_hash_and_sample_provenance(self):
        edits = (("encoding", "sRGB flipped image"), ("bounds", [0, 0, 1, 1]),
                 ("inputSha256", "b" * 64), ("textureHash", "c" * 64), ("samples", 16),
                 ("geometryFingerprint", "d" * 64), ("device", "CUDA"))
        original = self.manifest.copy()
        for key, value in edits:
            with self.subTest(key=key):
                self.manifest = dict(original, **{key: value})
                self.write_manifest()
                with self.assertRaises(ValueError):
                    installer.validate_result(self.source, self.scene_path)

    def test_rejects_nan_and_clipped_or_black_metrics(self):
        for key, value in (("mean", float("nan")), ("clippedChannels", 1), ("nonzeroChannels", 0)):
            original = self.manifest["metrics"]["pixels"][key]
            self.manifest["metrics"]["pixels"][key] = value
            self.write_manifest()
            with self.assertRaises(ValueError):
                installer.validate_result(self.source, self.scene_path)
            self.manifest["metrics"]["pixels"][key] = original

    def test_rejects_exporter_source_change_before_install(self):
        (self.root / "tools/bake/export-market-neon.mjs").write_bytes(b"changed source")
        with self.assertRaisesRegex(ValueError, "Source changed"):
            installer.validate_result(self.source, self.scene_path)

    def test_png_checks_real_dimensions_crc_alpha_and_nonzero_rgb(self):
        good = (self.source / installer.PNG_FILE).read_bytes()
        bad = bytearray(good)
        bad[-1] ^= 1
        with self.assertRaisesRegex(ValueError, "CRC"):
            installer.validate_png(bytes(bad), 512)
        with self.assertRaises(ValueError):
            installer.validate_png(good, 1024)
        for rgba, expected in (([17,17,17,0], "opaque"), ([0,0,0,255], "no visible")):
            path = self.source / "invalid.png"
            write_png(path, 512, 512, bytes(rgba) * (512 * 512))
            with self.assertRaisesRegex(ValueError, expected):
                installer.validate_png(path.read_bytes(), 512)

    def test_copied_directory_and_wrong_branch_are_refused_without_writes(self):
        with self.assertRaisesRegex(ValueError, "git checkout"):
            installer.install(self.source, self.scene_path)
        (self.root / ".git").write_text("gitdir: .git-linked")
        with patch.object(installer.subprocess, "run", return_value=types.SimpleNamespace(stdout="feature/other\n")):
            with self.assertRaisesRegex(ValueError, "feature/other"):
                installer.install(self.source, self.scene_path)
        self.assertFalse((self.root / "packages").exists())

    def test_main_in_an_original_checkout_installs(self):
        (self.root / ".git").mkdir()
        (self.root / "packages/client/src/render").mkdir(parents=True)
        with patch.object(installer.subprocess, "run", return_value=types.SimpleNamespace(stdout="main\n")), patch("builtins.print"):
            installer.install(self.source, self.scene_path)
        self.assertTrue((self.root / "packages/client/src/render/marketNeonBakeManifest.ts").is_file())

    def test_allowlisted_install_writes_only_png_manifest_and_generated_module(self):
        (self.root / ".git").write_text("gitdir: .git-linked")
        runtime = self.root / "packages/client/src/render"
        runtime.mkdir(parents=True)
        with patch.object(installer.subprocess, "run", return_value=types.SimpleNamespace(stdout="codex/isolated-finish\n")), patch("builtins.print"):
            installer.install(self.source, self.scene_path)
        files = sorted(p.relative_to(self.root / "packages").as_posix() for p in (self.root / "packages").rglob("*") if p.is_file())
        self.assertEqual(files, ["client/public/lightmaps/market-neon-pilot/manifest.json", "client/public/lightmaps/market-neon-pilot/market-neon-ground.png", "client/src/render/marketNeonBakeManifest.ts"])
        module = (runtime / "marketNeonBakeManifest.ts").read_text()
        self.assertIn("export const MARKET_NEON_BAKE", module)
        self.assertIn('"device": "CPU"', module)
        self.assertIn('"bounds": [', module)


if __name__ == "__main__":
    unittest.main()
