"""Job boundaries and staging checks; uses no Modal account or cloud resources."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from courtyard_bake import write_png
from install_palace import validate_result


class FakeImage:
    @classmethod
    def debian_slim(cls, **kwargs):
        return cls()

    def apt_install(self, *args):
        return self

    def uv_pip_install(self, *args):
        return self

    def add_local_file(self, *args, **kwargs):
        return self


class FakeApp:
    def __init__(self, name):
        self.options = None

    def function(self, **kwargs):
        self.options = kwargs

        def decorate(fn):
            fn.remote = Mock(side_effect=AssertionError("Unexpected cloud call"))
            return fn

        return decorate

    def local_entrypoint(self):
        return lambda fn: fn


class PalaceJobTests(unittest.TestCase):
    def setUp(self):
        fake = types.SimpleNamespace(Image=FakeImage, App=FakeApp)
        source = Path(__file__).with_name("modal_palace.py")
        spec = importlib.util.spec_from_file_location("test_modal_palace", source)
        self.job = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"modal": fake}):
            spec.loader.exec_module(self.job)

    def test_import_and_zero_budget_never_invoke_cloud(self):
        self.job.bake_entrance.remote.assert_not_called()
        with self.assertRaisesRegex(ValueError, "spending limit"):
            self.job.main("missing-scene.json", "missing-target")
        self.job.bake_entrance.remote.assert_not_called()

    def test_single_container_execution_is_bounded(self):
        cfg = self.job.app.options
        self.assertEqual(cfg["gpu"], "L4")
        self.assertEqual(cfg["max_containers"], 1)
        self.assertEqual(cfg["retries"], 0)
        self.assertLessEqual(cfg["timeout"], 600)
        self.assertLessEqual(cfg["scaledown_window"], 2)

    def test_cloud_rejects_oversized_input_and_invalid_work_before_importing_blender(self):
        with self.assertRaisesRegex(ValueError, "upload limit"):
            self.job.bake_entrance(b"x" * (self.job.MAX_INPUT_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "128 samples"):
            self.job.bake_entrance(b"{}", size=2048)
        with self.assertRaisesRegex(ValueError, "128 samples"):
            self.job.bake_entrance(b"{}", samples=129)

    def test_existing_staging_directory_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "new staging"):
                self.job.main("not-read.json", directory, approved_budget_usd=1)
        self.job.bake_entrance.remote.assert_not_called()

    def test_install_rejects_wrong_dimensions_and_untrusted_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            record = dict(version=1, sceneHash="test", bounds=[48, -22, 80, 22],
                          receiverY=0.02, file="courtyard.png", width=256, height=256,
                          radianceScale=16, emitter={"x": 58})
            (path / "manifest.json").write_text(json.dumps(record), encoding="utf-8")
            write_png(path / "courtyard.png", 2, 2, bytes([0, 0, 0, 255] * 4))
            with self.assertRaisesRegex(ValueError, "RGBA8"):
                validate_result(path)
            record["file"] = "../../other.png"
            (path / "manifest.json").write_text(json.dumps(record), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "bounded Palace"):
                validate_result(path)


if __name__ == "__main__":
    unittest.main()
