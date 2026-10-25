"""Guards for source-baked tree candidate staging."""
import base64
import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import stage_tree_source_bake as stage_bake  # noqa: E402
from shrink_tree_impostor import resize_normal_atlas  # noqa: E402


def _fingerprints(species: str, manifest: dict) -> dict[str, str]:
    info = manifest["species"][species]
    names = (
        f"/models/trees/{species}.glb",
        "/models/trees/trees.json",
        f"/models/trees/bark_{info['bark']}_color.webp",
        f"/models/trees/leaf_{info['leaf']}.webp",
        f"/models/trees/{species}_impostor.webp",
    )
    return {
        name: hashlib.sha256(
            (stage_bake.ASSETS / name.removeprefix("/models/trees/")).read_bytes()
        ).hexdigest()
        for name in names
    }


def _candidate(species: str = "ash") -> tuple[dict, dict]:
    manifest = json.loads((stage_bake.ASSETS / "trees.json").read_text())
    info = manifest["species"][species]
    color = np.zeros((stage_bake.FRAME, stage_bake.FRAME * stage_bake.FRAMES, 4), np.uint8)
    normal = np.zeros_like(color)
    normal[:, :, :3] = [128, 128, 255]
    normal[:, :, 3] = 255
    views = []
    references = []
    for frame in range(stage_bake.FRAMES):
        x0 = frame * stage_bake.FRAME + 10
        x1 = x0 + 7
        y0 = 20
        y1 = y0 + 7
        color[y0 : y1 + 1, x0 : x1 + 1] = [90 + frame, 140, 70, 255]
        bounds = [10, y0, 17, y1]
        view = {"covered": 64, "bounds": bounds}
        views.append(view)
        references.append(copy.deepcopy(view))
    bundle = {
        "receipt": {
            "id": species,
            "output": [stage_bake.FRAME * stage_bake.FRAMES, stage_bake.FRAME],
            "inputSize": 1024,
            "frame": info["frame"],
            "triangleCounts": info["triangles"],
            "checks": [{"coverage": 1.0} for _ in range(stage_bake.FRAMES)],
            "sourceFingerprints": _fingerprints(species, manifest),
            "sourceGlbSha256": "",
            "ao": {"minimum": 0.65, "directLightBaked": False, "receiverPlane": False},
            "adoptedInProduction": False,
            "views": views,
            "references": references,
        },
        "colorRGBA": base64.b64encode(color.tobytes()).decode("ascii"),
        "normalAoRGBA": base64.b64encode(normal.tobytes()).decode("ascii"),
    }
    bundle["receipt"]["sourceGlbSha256"] = bundle["receipt"]["sourceFingerprints"][
        f"/models/trees/{species}.glb"
    ]
    return bundle, manifest


def _vec(px: np.ndarray) -> np.ndarray:
    return px[:3].astype(np.float64) / 255.0 * 2.0 - 1.0


class TreeSourceBakeCandidateTest(unittest.TestCase):
    def assert_rejected(self, bundle: dict, manifest: dict, text: str) -> None:
        with self.assertRaisesRegex(ValueError, text):
            stage_bake.validate_candidate(bundle, "ash", manifest)

    def test_accepts_minimal_candidate_with_exact_layout_and_provenance(self):
        bundle, manifest = _candidate()
        color, normal, summary = stage_bake.validate_candidate(bundle, "ash", manifest)

        self.assertEqual(color.size, (stage_bake.FRAME * stage_bake.FRAMES, stage_bake.FRAME))
        self.assertEqual(normal.size, color.size)
        self.assertEqual(summary["species"], "ash")
        self.assertLessEqual(summary["maxNormalLengthError"], 0.014)
        self.assertEqual(summary["maxReferenceBoundsErrorPixels"], 0)

    def test_rejects_layout_mesh_or_check_count_drift(self):
        bundle, manifest = _candidate()
        bundle["receipt"]["output"] = [stage_bake.FRAME, stage_bake.FRAME]
        self.assert_rejected(bundle, manifest, "layout")

        bundle, manifest = _candidate()
        bundle["receipt"]["triangleCounts"] = {"branches": 1, "leaves": 1}
        self.assert_rejected(bundle, manifest, "layout")

        bundle, manifest = _candidate()
        bundle["receipt"]["checks"].pop()
        self.assert_rejected(bundle, manifest, "layout")

    def test_rejects_missing_or_changed_source_provenance(self):
        bundle, manifest = _candidate()
        bundle["receipt"]["sourceFingerprints"].pop("/models/trees/trees.json")
        self.assert_rejected(bundle, manifest, "provenance")

        bundle, manifest = _candidate()
        bundle["receipt"]["sourceFingerprints"]["/models/trees/trees.json"] = "0" * 64
        self.assert_rejected(bundle, manifest, "Source changed")

        bundle, manifest = _candidate()
        bundle["receipt"]["sourceGlbSha256"] = "0" * 64
        self.assert_rejected(bundle, manifest, "GLB")

    def test_rejects_unsupported_ao_or_production_adoption_flags(self):
        bundle, manifest = _candidate()
        bundle["receipt"]["ao"]["minimum"] = 0.5
        self.assert_rejected(bundle, manifest, "occlusion")

        bundle, manifest = _candidate()
        bundle["receipt"]["ao"]["directLightBaked"] = True
        self.assert_rejected(bundle, manifest, "occlusion")

        bundle, manifest = _candidate()
        bundle["receipt"]["adoptedInProduction"] = True
        self.assert_rejected(bundle, manifest, "occlusion")

    def test_rejects_alpha_coverage_and_empty_occlusion_errors(self):
        bundle, manifest = _candidate()
        color = np.frombuffer(base64.b64decode(bundle["colorRGBA"]), np.uint8).copy()
        color[3::4] = 0
        bundle["colorRGBA"] = base64.b64encode(color.tobytes()).decode("ascii")
        self.assert_rejected(bundle, manifest, "no silhouette")

        bundle, manifest = _candidate()
        normal = np.frombuffer(base64.b64decode(bundle["normalAoRGBA"]), np.uint8).copy()
        normal[3] = 200
        bundle["normalAoRGBA"] = base64.b64encode(normal.tobytes()).decode("ascii")
        self.assert_rejected(bundle, manifest, "Empty texels")

    def test_rejects_non_unit_normals_and_receipt_framing_drift(self):
        bundle, manifest = _candidate()
        normal = np.frombuffer(base64.b64decode(bundle["normalAoRGBA"]), np.uint8).copy()
        color = np.frombuffer(base64.b64decode(bundle["colorRGBA"]), np.uint8)
        covered = color[3::4] > 0
        normal.reshape(-1, 4)[covered, :3] = [255, 255, 255]
        bundle["normalAoRGBA"] = base64.b64encode(normal.tobytes()).decode("ascii")
        self.assert_rejected(bundle, manifest, "unit vectors")

        bundle, manifest = _candidate()
        bundle["receipt"]["views"][0]["bounds"] = [12, 20, 19, 27]
        self.assert_rejected(bundle, manifest, "framing receipt")

        bundle, manifest = _candidate()
        bundle["receipt"]["references"][0]["bounds"] = [20, 20, 27, 27]
        self.assert_rejected(bundle, manifest, "framing drift")


class TreeNormalAtlasResizeTest(unittest.TestCase):
    def test_weighted_resize_ignores_uncovered_pixels_and_averages_ao(self):
        color = np.zeros((2, stage_bake.FRAMES * 2, 4), np.uint8)
        normal = np.zeros_like(color)
        color[0, 0, 3] = 255
        color[0, 1, 3] = 128
        color[1, 0, 3] = 0
        color[1, 1, 3] = 0
        normal[0, 0] = [255, 128, 128, 166]
        normal[0, 1] = [128, 255, 128, 255]
        normal[1, 0] = [0, 0, 255, 0]
        normal[1, 1] = [0, 0, 255, 0]

        out = np.asarray(
            resize_normal_atlas(Image.fromarray(normal, "RGBA"), Image.fromarray(color, "RGBA"), 1)
        )
        got = _vec(out[0, 0])
        expected = np.array([1.0 * 255, 1.0 * 128, 0.0]) / 383
        expected /= np.linalg.norm(expected)
        self.assertLess(np.linalg.norm(got - expected), 0.01)
        self.assertEqual(out[0, 0, 3], round((166 * 255 + 255 * 128) / 383))

    def test_weighted_resize_renormalizes_or_outputs_neutral_empty_texels(self):
        color = np.zeros((2, stage_bake.FRAMES * 2, 4), np.uint8)
        normal = np.zeros_like(color)
        color[0, 0, 3] = 255
        color[0, 1, 3] = 255
        normal[0, 0] = [170, 255, 128, 180]
        normal[0, 1] = [150, 255, 128, 220]

        out = np.asarray(
            resize_normal_atlas(Image.fromarray(normal, "RGBA"), Image.fromarray(color, "RGBA"), 1)
        )
        self.assertAlmostEqual(np.linalg.norm(_vec(out[0, 0])), 1.0, places=2)
        self.assertGreater(_vec(out[0, 0])[1], 0.85)
        self.assertEqual(out[0, 0, 3], 200)
        self.assertEqual(out[0, 1].tolist(), [128, 255, 128, 255])


class TreeSourceBakeStageTest(unittest.TestCase):
    def test_staging_output_must_stay_under_tools_asset_build(self):
        candidates = stage_bake.ROOT / "tools/assets/build/missing-tree-candidates"
        with self.assertRaisesRegex(ValueError, "tools/assets/build"):
            stage_bake.stage(candidates, stage_bake.ROOT / "packages/client/public/models/trees")

        allowed = stage_bake.ROOT / "tools/assets/build/tree-source-staged"
        self.assertTrue(allowed.resolve().is_relative_to(stage_bake.ROOT / "tools/assets/build"))

    def test_stage_keeps_full_colour_and_ships_smaller_lossless_normals(self):
        import tempfile

        with tempfile.TemporaryDirectory(dir=stage_bake.ROOT / "tools/assets/build") as tmp:
            candidates = Path(tmp) / "candidates"
            output = Path(tmp) / "out"
            candidates.mkdir()
            for species in ("ash", "oak", "pine"):
                bundle, _ = _candidate(species)
                (candidates / f"{species}-candidate.json").write_text(json.dumps(bundle))

            stage_bake.stage(candidates, output)

            for species in ("ash", "oak", "pine"):
                with Image.open(output / f"{species}_impostor.webp") as color:
                    self.assertEqual(color.size, (stage_bake.FRAME * stage_bake.FRAMES, stage_bake.FRAME))
                normal_path = output / f"{species}_impostor_n.webp"
                with Image.open(normal_path) as normal:
                    self.assertEqual(
                        normal.size,
                        (stage_bake.SHIPPED_FRAME * stage_bake.FRAMES, stage_bake.SHIPPED_FRAME),
                    )
                self.assertIn(b"VP8L", normal_path.read_bytes()[:64])


if __name__ == "__main__":
    unittest.main()
