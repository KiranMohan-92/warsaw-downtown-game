"""Tests for build_env.py:  python -m pytest tools/assets -q"""

import math
import random
import statistics

import pytest

import build_env as be


def test_rgbe_round_trip_within_one_percent():
    rnd = random.Random(7)
    for _ in range(2000):
        rgb = tuple(10 ** rnd.uniform(-4, 4) for _ in range(3))
        back = be.rgbe_to_float(*be.float_to_rgbe(*rgb))
        top = max(rgb)
        for a, b in zip(rgb, back):
            # Shared exponent: absolute error bounded by ~1/256 of the brightest channel.
            assert abs(a - b) <= top / 128


def test_rgbe_black_and_known_values():
    assert be.float_to_rgbe(0, 0, 0) == (0, 0, 0, 0)
    assert be.rgbe_to_float(0, 0, 0, 0) == (0.0, 0.0, 0.0)
    r, g, b, e = be.float_to_rgbe(1.0, 0.5, 0.25)
    assert e == 129 and r == 128 and g == 64 and b == 32


@pytest.mark.parametrize(
    'data',
    [
        bytes(range(200)),  # all literals, > 128 long
        bytes([5]) * 300,  # long run, > 127
        bytes([1, 2, 3]) + bytes([9]) * 4 + bytes([1, 2]) + bytes([7]) * 3,
        bytes([0]),
        bytes(),
    ],
)
def test_rle_round_trip(data):
    enc = be.rle_encode(data)
    if data:
        dec, pos = be.rle_decode(enc, 0, len(data))
        assert dec == data and pos == len(enc)
    else:
        assert enc == b''


def test_rle_compresses_runs():
    assert len(be.rle_encode(bytes([3]) * 512)) < 12


def _const(w, h, v):
    return [v] * (w * h), [v] * (w * h), [v] * (w * h)


def test_uniform_sky_upper_mean_equals_radiance():
    w, h = 64, 32
    assert be.upper_mean_luminance(w, h, _const(w, h, 2.5)) == pytest.approx(2.5, rel=2e-3)


def test_azimuth_convention_matches_three_equirect():
    # Game azimuth 0 (north, -Z): three's equirectUv gives u = atan2(-1, 0)/2pi + 0.5 = 0.25.
    w = 360
    assert be.azimuth_of_column(0.25 * w - 0.5, w) == pytest.approx(0.0, abs=1e-9)
    # East (+X) is azimuth 90: u = atan2(0, 1)/2pi + 0.5 = 0.5.
    assert be.azimuth_of_column(0.5 * w - 0.5, w) == pytest.approx(90.0)
    # Cross-check against the sunDirection formula in weather.ts for an arbitrary azimuth.
    az = 215.0
    dx, dz = math.sin(math.radians(az)), -math.cos(math.radians(az))
    u = math.atan2(dz, dx) / (2 * math.pi) + 0.5
    assert be.azimuth_of_column(u * w - 0.5, w) == pytest.approx(az)


def _sky_with_sun(w, h, sx, sy, sun=5000.0):
    rs, gs, bs = _const(w, h, 1.0)
    i = sy * w + sx
    rs[i], gs[i], bs[i] = sun, sun * 0.9, sun * 0.8
    return rs, gs, bs


def test_find_and_clamp_sun():
    w, h = 64, 32
    ch = _sky_with_sun(w, h, 40, 6)
    assert be.find_sun(w, h, ch) == (40, 6)
    clamped, limit = be.clamp_sun(w, h, ch)
    assert limit == pytest.approx(be.SUN_CLAMP)
    i = 6 * w + 40
    assert be.luminance(clamped[0][i], clamped[1][i], clamped[2][i]) == pytest.approx(limit)
    # Hue survives the clamp; the rest of the sky is untouched.
    assert clamped[2][i] / clamped[0][i] == pytest.approx(0.8)
    assert clamped[0][0] == 1.0


def test_rotate_moves_columns():
    w, h = 8, 2
    ch = ([float(x) for _ in range(h) for x in range(w)],) * 3
    rot = be.rotate(w, h, ch, 3)
    assert rot[0][:w] == [5.0, 6.0, 7.0, 0.0, 1.0, 2.0, 3.0, 4.0]


def _upper_lums(w, h, ch):
    return [be.luminance(ch[0][i], ch[1][i], ch[2][i]) for i in range(w * (h // 2))]


def test_process_rotates_to_target_removes_the_sun_and_normalises():
    w, h = 1024, 512  # downsampled 2x to 512 x 256
    ch = _sky_with_sun(w, h, 100, 60)
    # A bright cloud 90 deg of azimuth east of the sun, on the sun's row: it must survive and move
    # with the rotation.
    for x in range(356, 364):
        for y in range(56, 64):
            i = y * w + x
            ch[0][i], ch[1][i], ch[2][i] = 4.0, 4.0, 4.0
    out, info = be.process(w, h, ch, 215.0)
    assert info['sunAzimuth'] == pytest.approx(215.0, abs=360 / be.WIDTH)
    assert be.upper_mean_luminance(be.WIDTH, be.HEIGHT, out) == pytest.approx(1.0, rel=1e-6)
    lums = _upper_lums(be.WIDTH, be.HEIGHT, out)
    cx, _ = be.find_sun(be.WIDTH, be.HEIGHT, out)  # now the brightest thing is the cloud
    assert be.azimuth_of_column(cx, be.WIDTH) == pytest.approx(215.0 + 90.0, abs=2 * 360 / be.WIDTH)
    # The sun is gone: nothing near where it was is brighter than the uniform sky around it.
    sun_col = round((215.0 / 360.0 + 0.25) * be.WIDTH - 0.5) % be.WIDTH
    sky = statistics.median(lums)
    for y in range(20, 40):
        for x in range(sun_col - 10, sun_col + 11):
            assert lums[y * be.WIDTH + x % be.WIDTH] <= sky * 1.001


def _glare_sky(w=128, h=64, sun=(40, 24)):
    """A sky of luminance ~1 with a sun and a wide glare (falls off with angle), a bright cloud far
    from the sun, and a dark building band on the horizon under the sun."""
    rs, gs, bs = [0.0] * (w * h), [0.0] * (w * h), [0.0] * (w * h)
    sd = be.direction(sun[0], sun[1], w, h)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            a = be.angle_deg(be.direction(x, y, w, h), sd)
            v = 1.0 + 30.0 * math.exp(-a / 6.0)
            if y in (28, 29, 30, 31) and 30 <= x < 50:
                v = 0.1  # rooftops
            if 100 <= x < 104 and 10 <= y < 14:
                v = 6.0  # cloud, ~100 deg from the sun
            rs[i], gs[i], bs[i] = v * 1.1, v, v * 0.9
    return w, h, (rs, gs, bs)


def test_remove_sun_leaves_no_peak_at_the_sun():
    w, h, ch = _glare_sky()
    out, level = be.remove_sun(w, h, ch, (40, 24))
    lum = lambda c, i: be.luminance(c[0][i], c[1][i], c[2][i])  # noqa: E731
    sd = be.direction(40, 24, w, h)
    inner, ring = [], []
    for i in range(w * (h // 2)):
        a = be.angle_deg(be.direction(i % w, i // w, w, h), sd)
        if a < 10:
            inner.append(lum(out, i))
        elif be.SUN_RADIUS <= a < be.SUN_RADIUS + 5:
            ring.append(lum(out, i))
    # The sun direction is no longer a highlight: the inpainted disc is no brighter than the sky
    # just outside it (the old clamp left it at 5-10x the median).
    assert max(inner) <= max(ring) * 1.001
    assert max(inner) < 2.0 * statistics.median(_upper_lums(w, h, out))
    # The rooftops under the sun (inside the radius, but darker than the sky) and the far cloud
    # are untouched.
    assert lum(out, 29 * w + 40) == pytest.approx(lum(ch, 29 * w + 40))
    assert lum(out, 12 * w + 101) == pytest.approx(lum(ch, 12 * w + 101))
    assert level > 1.0


def test_hdr_bytes_round_trip():
    w, h = 32, 4
    rnd = random.Random(3)
    ch = tuple([rnd.uniform(0, 4) for _ in range(w * h)] for _ in range(3))
    buf = be.encode_hdr(w, h, ch, 'test')
    assert buf.startswith(b'#?RADIANCE\n') and b'FORMAT=32-bit_rle_rgbe' in buf
    rw, rh, back = be.decode_hdr(buf)
    assert (rw, rh) == (w, h)
    for c, bc in zip(ch, back):
        for a, b in zip(c, bc):
            assert b == pytest.approx(a, abs=4 / 128)
