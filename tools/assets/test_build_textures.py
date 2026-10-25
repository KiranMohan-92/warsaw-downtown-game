"""Tests for build_textures.py:  python -m pytest tools/assets -q"""

import random
from array import array

import pytest
from PIL import Image

import build_textures as bt


def test_srgb_to_linear_endpoints_and_midpoint():
    assert bt.srgb_to_linear(0) == 0.0
    assert bt.srgb_to_linear(255) == pytest.approx(1.0)
    # sRGB 188 is ~50% linear light.
    assert bt.srgb_to_linear(188) == pytest.approx(0.5, abs=0.01)


def test_linear_stats_uniform_image():
    img = Image.new('RGB', (8, 8), (255, 188, 0))
    mean, p95 = bt.linear_stats(img)
    assert mean == pytest.approx([1.0, bt.srgb_to_linear(188), 0.0])
    assert p95 == pytest.approx(mean)


def test_linear_stats_mean_is_in_linear_light_and_percentile_picks_the_top():
    # Half black, half white: linear mean 0.5 (an sRGB-space average would say 127/255).
    img = Image.new('RGB', (10, 10), (0, 0, 0))
    img.paste((255, 255, 255), (0, 0, 10, 5))
    mean, p95 = bt.linear_stats(img)
    assert mean == pytest.approx([0.5, 0.5, 0.5])
    assert p95 == pytest.approx([1.0, 1.0, 1.0])
    # 4 % bright pixels: the 95th percentile is still the dark value.
    img = Image.new('RGB', (10, 10), (0, 0, 0))
    img.paste((255, 255, 255), (0, 0, 4, 1))
    _, p95 = bt.linear_stats(img)
    assert p95 == [0.0, 0.0, 0.0]


def test_stats_source_is_a_typed_ts_module():
    src = bt.stats_source({'asphalt': ([0.1, 0.2, 0.3], [0.4, 0.5, 0.6])}, {'asphalt': 1024})
    assert 'export const ALBEDO_STATS = {' in src
    assert '  asphalt: { mean: [0.1, 0.2, 0.3], p95: [0.4, 0.5, 0.6] },' in src
    assert f'export const LOW_TEXTURE_SIZE = {bt.LOW_SIZE};' in src
    assert '  asphalt: 1024,' in src
    assert src.endswith('};\n')


def test_reads_the_palette_of_every_scanned_surface_from_materials_ts():
    palette = bt.read_palette(bt.MATERIALS.read_text(encoding='utf-8'))
    assert set(bt.SURFACES) <= set(palette)
    assert palette['metal'] == '#80878e'
    # A comment line before `color` (facade, paint, container) is skipped.
    assert palette['container'] == '#eeeeee'
    assert palette['facade'] == '#e6d8bf'  # warm sandstone, a touch deeper for the stone relief (d243fe3)


def _noisy_tinted_scan(size=64, seed=5):
    """A dark, strongly orange scan (like metal_plate): blue sits near sRGB code 20, where each
    code step is ~7 % of the value, so its quantisation/JPEG noise dwarfs the other channels'."""
    rnd = random.Random(seed)
    img = Image.new('RGB', (size, size))
    img.putdata(
        [
            (60 + rnd.randint(-2, 2), 45 + rnd.randint(-2, 2), 20 + rnd.randint(-3, 3))
            for _ in range(size * size)
        ]
    )
    return img


def _floats(band: Image.Image) -> array:
    """Pixels of a float ('F') band (tobytes works on every Pillow; getdata is deprecated)."""
    return array('f', band.tobytes())


def _rel_noise(band: Image.Image) -> float:
    vals = _floats(band)
    mean = sum(vals) / len(vals)
    return (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5 / mean


def test_match_palette_lands_on_the_palette_colour():
    target = bt.hex_to_linear('#80878e')
    out = bt.match_palette(_noisy_tinted_scan(), target)
    mean, _ = bt.linear_stats(out)
    for c in range(3):
        assert mean[c] == pytest.approx(target[c], rel=0.03)


def test_match_palette_does_not_blow_up_the_faint_channel():
    """A per-channel gain keeps each channel's relative noise, so the target's blue inherited the
    scan's noisy blue (~25x gain on metal_plate). Now every output channel is built on the scan's
    luminance, and the faint channel's own noise enters at most CHROMA_KEEP-scaled."""
    scan = _noisy_tinted_scan()
    src = bt.to_linear(scan)
    lum = bt.ImageMath.lambda_eval(
        lambda a: a['r'] * 0.2126 + a['g'] * 0.7152 + a['b'] * 0.0722, r=src[0], g=src[1], b=src[2]
    )
    lum_noise, blue_noise = _rel_noise(lum), _rel_noise(src[2])
    assert blue_noise > 3 * lum_noise  # the faint channel is the noisy one
    out = bt.to_linear(bt.match_palette(scan, bt.hex_to_linear('#80878e')))
    for band in out:
        assert _rel_noise(band) < lum_noise + (bt.CHROMA_KEEP + 0.1) * blue_noise


def test_retint_keep_zero_is_a_tinted_grey_and_keeps_luminance():
    scan = _noisy_tinted_scan()
    target = (0.2, 0.25, 0.3)
    r, g, b = bt.retint(bt.to_linear(scan), target, keep=0.0)
    for x, y in zip(_floats(r), _floats(b)):
        assert y / x == pytest.approx(0.3 / 0.2, rel=1e-4)
    src = bt.to_linear(scan)
    lum_in = bt.luminance([bt.band_mean(x) for x in src])
    lum_out = bt.luminance([bt.band_mean(x) for x in (r, g, b)])
    assert lum_out == pytest.approx(lum_in, rel=1e-3)


def test_srgb_encode_round_trips_every_code():
    img = Image.new('RGB', (256, 1))
    img.putdata([(v, 255 - v, v // 2) for v in range(256)])
    assert bt.to_srgb(bt.to_linear(img)).tobytes() == img.tobytes()


def test_low_copy_keeps_the_mean_brightness():
    """Downsampling sRGB-encoded values darkens contrasty textures (a gamma-space average); the
    Low copy is resized in linear light so it draws as bright as the full set."""
    img = Image.new('RGB', (64, 64))
    img.putdata([(250, 250, 250) if (x // 1 + y // 1) % 2 else (5, 5, 5) for y in range(64) for x in range(64)])
    small = bt.downsize(img, 16)
    assert small.size == (16, 16)
    full_mean, _ = bt.linear_stats(img)
    low_mean, _ = bt.linear_stats(small)
    assert low_mean[1] == pytest.approx(full_mean[1], rel=0.03)
