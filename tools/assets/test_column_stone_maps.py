"""Physical channel contracts for the generated column material data."""

import hashlib
import json
from pathlib import Path
import re

import numpy as np
import pytest
from PIL import Image

from column_stone_maps import FACADE_SANDSTONE_SRGB, build, data_maps, normalise_albedo_mean


def linear_rgb(pixels: np.ndarray) -> np.ndarray:
    srgb = np.asarray(pixels, dtype=np.float64) / 255
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)


def lab(linear: np.ndarray) -> np.ndarray:
    # CIE Lab, D65 reference white; Delta E 1976 is Euclidean distance in Lab.
    xyz = linear @ np.array([
        [0.4124564, 0.2126729, 0.0193339],
        [0.3575761, 0.7151522, 0.1191920],
        [0.1804375, 0.0721750, 0.9503041],
    ]) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def test_shipped_stone_mean_matches_facade_palette():
    root = Path(__file__).resolve().parents[2]
    directory = root / "packages/client/public/tex/palace-columns-v2"
    manifest = json.loads((directory / "manifest.json").read_text())
    with Image.open(directory / "stone_albedo.webp") as image:
        pixels = linear_rgb(np.asarray(image.convert("RGB")))
    measured = pixels.mean(axis=(0, 1))
    recorded = np.asarray(manifest["albedoMeanLinear"])
    np.testing.assert_allclose(recorded, measured, atol=1e-8, rtol=0)

    palette_source = (root / "packages/client/src/render/materials.ts").read_text()
    facade = re.search(r"facade:\s*\{.*?color:\s*'(#[0-9a-fA-F]{6})'", palette_source, re.S)
    assert facade is not None
    palette = facade.group(1)
    target = linear_rgb(np.array([int(palette[i:i + 2], 16) for i in (1, 3, 5)]))
    assert manifest["albedoPalette"] == palette
    assert np.linalg.norm(lab(measured) - lab(target)) < 1.0
    assert np.std(pixels @ np.array([0.2126, 0.7152, 0.0722])) > 0.05


def test_albedo_normalisation_matches_facade_sandstone_mean():
    cool_stone = np.full((32, 32, 3), [0.87, 0.84, 0.79], dtype=np.float32)
    cool_stone[8:16, 8:16] *= 0.75
    normalised = normalise_albedo_mean(cool_stone)
    mean = linear_rgb(normalised * 255).mean(axis=(0, 1))

    assert np.linalg.norm(lab(mean) - lab(linear_rgb(FACADE_SANDSTONE_SRGB * 255))) < 0.25
    assert normalised[..., 0].std() > 0.01


def test_flat_colour_has_flat_normal_and_dielectric_channels():
    maps = data_maps(np.full((64, 64, 3), 0.8, dtype=np.float32))
    assert np.max(np.abs(maps["normal"][..., :2].astype(float) - 128)) <= 1
    assert np.all(maps["normal"][..., 2] == 255)
    assert np.all(maps["orm"][..., 0] == 255)
    assert np.all(maps["orm"][..., 2] == 0)


def test_pores_have_upward_normals_roughness_and_local_cavity():
    rgb = np.full((128, 128, 3), 0.82, dtype=np.float32)
    rgb[58:68, 58:68] = 0.42
    maps = data_maps(rgb)
    n = maps["normal"].astype(float) / 255 * 2 - 1
    assert np.min(n[..., 2]) > 0
    assert np.max(np.abs(np.linalg.norm(n, axis=2) - 1)) < 0.012
    assert maps["orm"][63, 63, 0] < maps["orm"][10, 10, 0]
    assert maps["orm"][63, 63, 1] > maps["orm"][10, 10, 1]
    assert np.count_nonzero(maps["normal"][..., 0] != 128) > 20


def test_builder_refuses_fake_upscaled_colour(tmp_path):
    from PIL import Image

    source = tmp_path / "small.png"
    Image.new("RGB", (64, 64), "ivory").save(source)
    with pytest.raises(ValueError, match="Do not upscale"):
        build(source, tmp_path / "out", size=1024)


def test_builder_writes_1k_webps_with_bounded_filter_error(tmp_path):
    source = Path(__file__).parent / "source/column-stone-v2.png"
    manifest = build(source, tmp_path / "out", size=1024)

    assert manifest["size"] == 1024
    assert manifest["bytes"] < 260_000
    for name in ("stone_albedo.webp", "stone_normal.webp", "stone_orm.webp"):
        path = tmp_path / "out" / name
        assert manifest["files"][name]["bytes"] == path.stat().st_size
        assert manifest["files"][name]["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
        with Image.open(path) as image:
            assert image.format == "WEBP"
            assert image.size == (1024, 1024)
    assert not list((tmp_path / "out").glob("*.png"))

    original = Image.open(source).convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS)
    original_rgb = np.asarray(original, dtype=np.float32) / 255
    tinted_rgb = normalise_albedo_mean(original_rgb)
    reference = data_maps(original_rgb)
    decoded_normal = np.asarray(Image.open(tmp_path / "out/stone_normal.webp").convert("RGB"), dtype=np.float32)
    decoded_orm = np.asarray(Image.open(tmp_path / "out/stone_orm.webp").convert("RGB"), dtype=np.float32)
    decoded_albedo = np.asarray(Image.open(tmp_path / "out/stone_albedo.webp").convert("RGB"), dtype=np.float32)
    np.testing.assert_allclose(
        manifest["albedoMeanLinear"], linear_rgb(decoded_albedo).mean(axis=(0, 1)), atol=1e-8, rtol=0,
    )
    target = linear_rgb(np.array([230, 216, 191]))
    assert np.linalg.norm(lab(linear_rgb(decoded_albedo).mean(axis=(0, 1))) - lab(target)) < 1.0

    def unit_normals(pixels: np.ndarray) -> np.ndarray:
        vectors = pixels / 255 * 2 - 1
        return vectors / np.maximum(np.linalg.norm(vectors, axis=2, keepdims=True), 1e-6)

    dots = np.sum(unit_normals(reference["normal"].astype(np.float32)) * unit_normals(decoded_normal), axis=2)
    angles = np.degrees(np.arccos(np.clip(dots, -1, 1)))
    assert angles.mean() < 4.5
    assert np.percentile(angles, 95) < 14.0

    reference_roughness = reference["orm"][..., 1].astype(np.float32) / 255
    decoded_roughness = decoded_orm[..., 1] / 255
    roughness_error = decoded_roughness - reference_roughness
    assert np.mean(np.abs(roughness_error)) < 0.014
    assert np.sqrt(np.mean(roughness_error * roughness_error)) < 0.025
    assert decoded_roughness.std() / reference_roughness.std() > 0.25

    albedo_error = tinted_rgb * 255 - decoded_albedo
    mse = np.mean(albedo_error * albedo_error)
    psnr = 99 if mse == 0 else 10 * np.log10(255**2 / mse)
    assert psnr > 32.0
