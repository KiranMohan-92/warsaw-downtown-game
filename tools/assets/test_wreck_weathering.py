"""Burnt wreck appearance: physical colour limits and geometry-driven weathering.

Colour assertions read the shipped, compressed textures. Placement tests vary one
physical cause at a time so procedural noise cannot satisfy them accidentally.
"""

from functools import lru_cache
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from package_vehicles import read_wreck
from raw_models import raw_model

MODELS = Path(__file__).resolve().parents[2] / 'packages/client/public/models/vehicles'


def saturation(rgb):
    return np.ptp(rgb, axis=-1) / np.maximum(rgb.max(axis=-1), 1e-8)


def luminance(rgb):
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    return linear @ np.array([0.2126, 0.7152, 0.0722])


@lru_cache(maxsize=2)
def shipped_maps(size):
    from wreck_weathering import geometry_maps

    rows, faces = read_wreck(raw_model(MODELS / 'armoured_wreck.gltf'), node='armoured_wreck')
    return geometry_maps(rows, faces, size)


def shipped_image(kind, size):
    suffix = '_low' if size == 512 else ''
    return np.asarray(Image.open(MODELS / f'armoured_wreck_{kind}{suffix}.webp')) / 255


def flat_panel(height=1.6, edge=0., holes=0., size=96):
    """Identical spatial sampling for each treatment; +X is the wreck's front."""
    x, z = np.meshgrid(np.linspace(-1.2, 0.4, size), np.linspace(0.8, 0.95, size))
    shape = x.shape
    position = np.stack([x, np.full(shape, height), z], axis=-1)
    normal = np.zeros_like(position)
    normal[..., 2] = 1
    return {
        'position': position,
        'normal': normal,
        'valid': np.ones(shape, dtype=bool),
        'body': np.ones(shape, dtype=bool),
        'edge': np.full(shape, edge),
        'holes': np.full(shape, holes),
    }


def weather(maps, ao=1.):
    from wreck_weathering import weather_surface

    return weather_surface(maps, np.full(maps['body'].shape, ao))


@pytest.mark.parametrize('size', [1024, 512])
def test_shipped_body_albedo_histogram_stays_desaturated_and_plausible(size):
    maps = shipped_maps(size)
    body = maps['body'] & maps['valid']
    assert body.sum() > size * size * 0.2, 'histogram must cover the actual body atlas'
    rgb = shipped_image('albedo', size)[body]
    sat, lum = saturation(rgb), luminance(rgb)
    assert np.quantile(sat, 0.99) <= 0.45, f'{size}: saturated orange corrosion returned'
    assert np.mean(sat <= 0.3) >= 0.8, f'{size}: most body texels should be muted'
    assert np.quantile(lum, 0.01) >= 0.04, f'{size}: body loses its readable charcoal floor'
    assert np.quantile(lum, 0.99) <= 0.35, f'{size}: body exceeds weathered albedo range'


@pytest.mark.parametrize('cause', ['edge', 'holes'])
def test_corrosion_follows_damage_masks_at_identical_positions(cause):
    control = weather(flat_panel())
    damaged = weather(flat_panel(**{cause: 1.}))
    assert damaged['rust'].mean() > control['rust'].mean() + 0.08
    # Inspect output colour too: a diagnostic rust mask alone cannot pass this test.
    control_warmth = (control['albedo'][..., 0] - control['albedo'][..., 1]).mean()
    damaged_warmth = (damaged['albedo'][..., 0] - damaged['albedo'][..., 1]).mean()
    assert damaged_warmth > control_warmth + 0.005


def test_lower_body_corrosion_exceeds_flat_upper_paint():
    lower = weather(flat_panel(height=0.35))
    upper = weather(flat_panel(height=1.8))
    assert lower['rust'].mean() > upper['rust'].mean() + 0.08
    assert upper['paint'].mean() > lower['paint'].mean()
    assert upper['paint'].mean() > 0.5, 'flat upper panels must retain faded paint'


def test_cavity_occlusion_changes_grime_at_identical_positions():
    panel = flat_panel()
    open_air = weather(panel)
    cavity = weather(panel, ao=0.2)
    assert (cavity['rust'] + cavity['soot']).mean() > (open_air['rust'] + open_air['soot']).mean() + 0.03
    assert luminance(cavity['albedo']).mean() < luminance(open_air['albedo']).mean()


def test_uv_or_triangle_boundaries_do_not_become_physical_damage():
    from wreck_weathering import geometry_maps

    # A tessellated planar panel with duplicated vertices at EVERY triangle seam.
    # The welded panel's outside border is its only physical damage boundary.
    rows, faces = [], []
    for j in range(8):
        for i in range(8):
            corners = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            for tri in ((0, 1, 2), (0, 2, 3)):
                first = len(rows)
                for index in tri:
                    x, y = corners[index]
                    rows.append((-0.8 + x * 0.2, 1.1 + y * 0.1, 0.9,
                                 0., 0., 1., x / 8, 1 - y / 8))
                faces.append((first, first + 1, first + 2))
    maps = geometry_maps(rows, faces, 128)
    yy, xx = np.indices((128, 128))
    interior = (xx > 38) & (xx < 90) & (yy > 38) & (yy < 90) & maps['valid']
    diagonal = interior & (np.abs(xx + yy - 127) < 3)
    off_diagonal = interior & (np.abs(xx + yy - 127) > 15)
    assert diagonal.sum() > 100 and off_diagonal.sum() > 100
    for field in ('edge', 'holes'):
        assert np.quantile(maps[field][interior], 0.9) < 0.1
        assert maps[field][diagonal].mean() <= maps[field][off_diagonal].mean() + 0.05


def test_coarse_panel_damage_does_not_fill_the_triangle_interior():
    from wreck_weathering import geometry_maps

    # Only two large triangles: every vertex touches the outside boundary. Vertex
    # distance interpolation would incorrectly mark this entire flat panel torn.
    rows = [
        (-0.8, 1.1, 0.9, 0., 0., 1., 0., 1.),
        (0.8, 1.1, 0.9, 0., 0., 1., 1., 1.),
        (0.8, 1.9, 0.9, 0., 0., 1., 1., 0.),
        (-0.8, 1.1, 0.9, 0., 0., 1., 0., 1.),
        (0.8, 1.9, 0.9, 0., 0., 1., 1., 0.),
        (-0.8, 1.9, 0.9, 0., 0., 1., 0., 0.),
    ]
    maps = geometry_maps(rows, [(0, 1, 2), (3, 4, 5)], 128)
    yy, xx = np.indices((128, 128))
    centre = (xx > 48) & (xx < 80) & (yy > 48) & (yy < 80)
    border = (yy < 3) | (yy > 124)
    for field in ('edge', 'holes'):
        assert np.quantile(maps[field][centre], 0.99) < 0.05
        assert np.median(maps[field][border]) > 0.65


def test_damage_distance_is_invariant_to_panel_triangulation():
    from wreck_weathering import geometry_maps

    def panel(divisions):
        rows = [(-0.8 + 1.6 * i / divisions, 1.1 + 0.8 * j / divisions, 0.9,
                 0., 0., 1., i / divisions, 1 - j / divisions)
                for j in range(divisions + 1) for i in range(divisions + 1)]
        faces = []
        for j in range(divisions):
            for i in range(divisions):
                a = j * (divisions + 1) + i
                b, c, d = a + 1, a + divisions + 2, a + divisions + 1
                faces.extend(((a, b, c), (a, c, d)))
        return geometry_maps(rows, faces, 128)

    coarse, subdivided = panel(1), panel(8)
    np.testing.assert_array_equal(coarse['valid'], subdivided['valid'])
    for field in ('edge', 'holes'):
        np.testing.assert_allclose(coarse[field], subdivided[field], atol=1e-4, rtol=0,
                                   err_msg=f'{field} changes at artificial triangle boundaries')


def test_shipped_torn_fold_geometry_actually_seeds_hole_weathering():
    rows, faces = read_wreck(raw_model(MODELS / 'armoured_wreck.gltf'), node='armoured_wreck')
    points, indices = np.unique(np.asarray(rows)[:, :3], axis=0, return_inverse=True)
    triangles = indices[np.asarray(faces)]
    p = points[triangles]
    normals = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    adjacent = {}
    for face, tri in enumerate(triangles):
        for a, b in zip(tri, np.roll(tri, -1)):
            adjacent.setdefault(tuple(sorted((int(a), int(b)))), []).append(face)
    # Independent witnesses: near-opposed triangle normals mark folded sheet lips
    # in this closed scan even though it has no open topological boundary edges.
    folds = np.array([
        points[list(edge)].mean(axis=0)
        for edge, linked in adjacent.items()
        if len(linked) == 2 and normals[linked[0]] @ normals[linked[1]] < -0.65
        and points[list(edge), 1].min() > 0.7
    ])
    assert len(folds) >= 20, 'the approved scan must retain its folded/torn metal'
    witnesses = folds[np.linspace(0, len(folds) - 1, 32).astype(int)]
    maps = shipped_maps(512)
    body = maps['body'] & maps['valid']
    distance = np.full(body.sum(), np.inf)
    for witness in witnesses:
        distance = np.minimum(distance, np.linalg.norm(maps['position'][body] - witness, axis=-1))
    near, away = distance < 0.04, distance > 0.25
    assert near.sum() >= 100 and away.sum() >= 1000
    holes = maps['holes'][body]
    assert 0.01 < np.mean(holes > 0.5) < 0.5, 'hole weathering must exist but stay localized'
    assert holes[near].mean() > holes[away].mean() + 0.2
    assert np.median(holes[near]) > 0.5


def test_damage_drains_down_the_panel_without_creating_streaks_above():
    x, y = np.meshgrid(np.linspace(-1.2, -0.8, 96), np.linspace(1.16, 2.1, 96))
    clean = flat_panel()
    clean = {**clean, 'position': np.stack([x, y, np.full(x.shape, 0.9)], axis=-1)}
    donor = np.where(np.abs(y - 1.65) < 0.025, 1., 0.)
    damaged = {**clean, 'edge': donor}
    control, streaked = weather(clean), weather(damaged)
    delta = streaked['rust'] - control['rust']
    below = (y > 1.3) & (y < 1.55)
    above = y > 1.75
    assert np.mean(delta[below] > 0.01) > 0.03, 'sparse streaks must descend from the donor edge'
    assert np.abs(delta[above]).max() < 1e-8, 'drainage cannot run upward'


@pytest.mark.parametrize('size', [1024, 512])
def test_shipped_lower_side_panels_show_more_brown_corrosion_than_flat_upper(size):
    maps = shipped_maps(size)
    p, n = maps['position'], maps['normal']
    # Geometry-only regions, not the generator's returned rust/low/paint masks.
    sides = (maps['valid'] & maps['body'] & (np.abs(n[..., 2]) > 0.7)
             & (p[..., 0] > -1.2) & (p[..., 0] < 0.65))
    lower = sides & (p[..., 1] > 0.35) & (p[..., 1] < 0.85)
    # A side-facing triangle can still sit on a torn fold. The comparison target
    # is intact flat upper metal, so exclude proximity to physical tears/creases.
    upper = (sides & (p[..., 1] > 1.2) & (p[..., 1] < 1.8)
             & (maps['edge'] < 0.1) & (maps['holes'] < 0.1))
    assert lower.sum() > 100 and upper.sum() > 100
    rgb = shipped_image('albedo', size)
    brown = ((rgb[..., 0] > rgb[..., 1] + 0.008)
             & (rgb[..., 1] > rgb[..., 2] + 0.008))
    assert brown[lower].mean() > brown[upper].mean() + 0.1


def test_material_response_distinguishes_coatings_from_bare_steel():
    maps = shipped_maps(512)
    generated = weather(maps, ao=0.8)
    body = maps['valid'] & maps['body']
    selections = {
        'rust': (generated['rust'] > 0.7) & (generated['soot'] < 0.15),
        'soot': generated['soot'] > 0.85,
        'paint': generated['paint'] > 0.9,
        'steel': ((generated['steel'] > 0.3) & (generated['soot'] < 0.15)
                  & (generated['rust'] < 0.15)),
    }
    for material in ('rust', 'soot', 'paint', 'steel'):
        dominant = body & selections[material]
        assert dominant.sum() >= 10, f'no dominant {material} samples to inspect'
        rough = generated['roughness'][dominant]
        metal = generated['metal'][dominant]
        if material in ('rust', 'soot'):
            assert np.quantile(rough, 0.05) >= 0.8
            assert np.quantile(rough, 0.95) <= 0.95
            assert np.quantile(metal, 0.95) <= 0.15
        elif material == 'paint':
            assert 0.6 <= np.median(rough) <= 0.75
            assert np.quantile(metal, 0.95) <= 0.15
        else:
            assert np.median(rough) < 0.65
            assert np.median(metal) > 0.2


@pytest.mark.parametrize('size', [1024, 512])
def test_shipped_arm_keeps_coatings_rough_and_sparse_chips_metallic(size):
    from wreck_weathering import weather_surface

    maps = shipped_maps(size)
    arm = shipped_image('arm', size)
    generated = weather_surface(maps, arm[..., 0])
    body = maps['body'] & maps['valid']
    rough, metal = arm[..., 1], arm[..., 2]
    # Only strongly dominant regions are tested as pure coatings; low-tier
    # resampling necessarily blends their narrow boundaries with adjacent chips.
    coats = {
        'rust': ((generated['rust'] > 0.7) & (generated['soot'] < 0.15)
                 & (generated['steel'] < 0.1)),
        'soot': (generated['soot'] > 0.85) & (generated['steel'] < 0.1),
        'paint': generated['paint'] > 0.9,
    }
    for material, selected in coats.items():
        selected = selected & body
        assert selected.sum() > 20, f'{size}: missing dominant {material} coating'
        assert np.quantile(metal[selected], 0.9) < 0.15, f'{size}: metallic {material}'
        if material == 'paint':
            assert 0.6 <= np.median(rough[selected]) <= 0.76
        else:
            assert 0.8 <= np.median(rough[selected]) <= 0.96
    # Read the packed map directly: metallicity cannot exist only in debug masks.
    # Metallic coverage above .3 identifies chip cores rather than their mostly
    # painted, low-metal mip fringes. Low has fewer cores, but must retain some.
    chips = body & (metal > 0.3)
    assert 0.0002 < chips.sum() / body.sum() < 0.1, f'{size}: bare steel must be sparse but visible'
    coatings = body & (metal < 0.05)
    assert np.median(rough[chips]) < np.median(rough[coatings]) - 0.1
    assert np.median(rough[chips]) < 0.72


def test_weathering_is_deterministic_finite_and_keeps_masks_bounded():
    maps = flat_panel(edge=0.7, holes=0.5)
    first, second = weather(maps, ao=0.5), weather(maps, ao=0.5)
    for key in ('albedo', 'roughness', 'metal', 'height', 'rust', 'soot', 'steel', 'paint', 'low'):
        assert np.isfinite(first[key]).all(), key
        np.testing.assert_array_equal(first[key], second[key], err_msg=key)
        if key != 'height':
            assert first[key].min() >= 0 and first[key].max() <= 1, key
