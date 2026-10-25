"""The armoured wreck's surface rebuild must spend its atlas on connected panels, not facets."""

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from package_vehicles import read_wreck
from raw_models import raw_model
from wreck_surface import read_surface, surface_mesh, surface_kind

MODELS = Path(__file__).resolve().parents[2] / 'packages/client/public/models/vehicles'


def test_surface_mesh_only_welds_exact_coincidences_and_keeps_winding():
    vertices = [(0., 0., 0.), (1., 0., 0.), (0., 1., 0.), (0., 0., 0.),
                (0., 0., 0.000001)]
    faces = [(0, 1, 2), (3, 2, 1), (4, 1, 2)]
    points, triangles = surface_mesh(vertices, faces)
    assert len(points) == 4
    assert len(triangles) == len(faces)
    assert sorted(tuple(sorted(vertices[i] for i in f)) for f in faces) == sorted(
        tuple(sorted(points[i] for i in f)) for f in triangles)
    normals = [np.cross(np.subtract(points[f[1]], points[f[0]]),
                        np.subtract(points[f[2]], points[f[0]]))[2] for f in triangles]
    assert sorted(normals) == [-1, 1, 1]
    # Reordering input vertices/faces must not change the atlas build's starting mesh.
    assert surface_mesh(vertices[::-1], [tuple(4-i for i in f) for f in faces[::-1]]) == (points, triangles)


def test_tyre_rim_and_body_have_distinct_materials():
    assert surface_kind((1.57, 0.45, 0.93)) == 'rim'
    assert surface_kind((1.57, 0.08, 0.93)) == 'rubber'
    assert surface_kind((-1.42, 0.79, -0.88)) == 'rubber'
    assert surface_kind((1.57, 1.1, 0.93)) == 'hull'
    assert surface_kind((3.5, 0.05, 1.5)) == 'hull'  # scattered metal, not a tyre


def test_shipped_atlas_reserves_area_for_real_detail():
    vertices, faces = read_wreck(raw_model(MODELS / 'armoured_wreck.gltf'), node='armoured_wreck')
    uv = np.array(vertices)[:, 6:8][np.array(faces)]
    a, b = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
    area = np.abs(a[:, 0]*b[:, 1] - a[:, 1]*b[:, 0]).sum() / 2
    # At least 40% of the atlas, retaining island padding for the 512 px tier.
    # The old disconnected-triangle atlas used only 1.4%.
    assert area > 0.4, f'only {area:.1%} of the 1k atlas carries surface detail'
    assert np.isfinite(uv).all() and uv.min() >= 0 and uv.max() <= 1
    assert len(faces) == 30000  # material work must not change the near triangle budget


def test_close_body_panels_get_the_texel_density():
    vertices, faces = read_wreck(raw_model(MODELS / 'armoured_wreck.gltf'), node='armoured_wreck')
    triangles = np.array(vertices)[np.array(faces)]
    p, uv = triangles[:, :, :3], triangles[:, :, 6:8]
    centres = p.mean(axis=1)
    normals = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    area = np.linalg.norm(normals, axis=1) / 2
    # The broad side panels nearest the sandbag survey camera, excluding tyres and turret.
    panel = ((centres[:, 1] > 0.8) & (np.abs(centres[:, 2]) > 0.7)
             & (centres[:, 0] > -1.8) & (centres[:, 0] < 0.9)
             & (np.abs(normals[:, 2]) > area * 1.4))
    a, b = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
    uv_area = np.abs(a[:, 0]*b[:, 1] - a[:, 1]*b[:, 0]) / 2
    density = 1024 * np.sqrt(uv_area[panel].sum() / area[panel].sum())
    assert density > 110, f'body panels only get {density:.1f} texels/metre at 1k'


def test_shipped_shape_stays_exactly_the_approved_scan():
    points, faces = read_surface(raw_model(MODELS / 'armoured_wreck.gltf'))
    digest = hashlib.sha256(json.dumps([points, faces], separators=(',', ':')).encode()).hexdigest()
    # Pre-polish, decoded shipped mesh: UVs/normals may change; triangle positions/winding may not.
    assert digest == '1005a83a04a492cfa97ffe83cd36bad34e586c2b1520117c033016511629020e'
    far, far_faces = read_surface(raw_model(MODELS / 'armoured_wreck_far.gltf'))
    assert len(far_faces) <= 3000
    assert abs(min(p[1] for p in far) - min(p[1] for p in points)) < 0.03


@pytest.mark.parametrize('suffix,digest', [
    ('', '58ad0688ba4f6862ccd4ab7e4d7599b1838f6f2636b514f0c6edc94271b6a506'),
    ('_far', '32bcadd0ffb22b285cc90981e846c318e4965174812e364b9fffc9dfb147e555'),
])
def test_round_two_keeps_approved_uvs_normals_and_lod_topology(suffix, digest):
    rows, faces = read_wreck(raw_model(MODELS / f'armoured_wreck{suffix}.gltf'),
                             node=f'armoured_wreck{suffix}')
    # Round 2 is reflectance/relief only: preserve 22e6ee5's successful panel atlas exactly.
    assert hashlib.sha256(json.dumps([rows, faces], separators=(',', ':')).encode()).hexdigest() == digest


def test_shipped_maps_fit_both_tiers_and_have_valid_normals():
    vertices, faces = read_wreck(raw_model(MODELS / 'armoured_wreck.gltf'), node='armoured_wreck')
    uv = np.array(vertices)[:, 6:8][np.array(faces)].mean(axis=1)
    for suffix, size in (('', 1024), ('_low', 512)):
        for kind in ('albedo', 'normal', 'arm'):
            im = Image.open(MODELS / f'armoured_wreck_{kind}{suffix}.webp')
            assert im.size == (size, size)
            pixels = np.array(im)[np.clip((uv[:, 1]*size).astype(int), 0, size-1),
                                  np.clip((uv[:, 0]*size).astype(int), 0, size-1)] / 255
            if kind == 'normal':
                lengths = np.linalg.norm(pixels * 2 - 1, axis=1)
                assert np.quantile(lengths, 0.1) > 0.85
                assert np.quantile(lengths, 0.9) < 1.1
                assert pixels[:, :2].std() > 0.01  # a real tangent-space bake
            if kind == 'arm':
                assert np.median(pixels[:, 1]) > 0.65  # burnt coatings are rough
                assert np.median(pixels[:, 2]) < 0.35  # rust/soot/rubber are dielectric
    assert sum(p.stat().st_size for p in MODELS.iterdir() if p.is_file()) < 9_700_000


def test_incomplete_bake_cannot_overwrite_shipped_files(tmp_path, monkeypatch):
    import package_vehicles as pack
    build = tmp_path / 'build'
    src = build / 'armoured_wreck'
    src.mkdir(parents=True)
    (src / 'surface_pending').touch()
    out = tmp_path / 'out'
    out.mkdir()
    sentinel = out / 'armoured_wreck.bin'
    sentinel.write_bytes(b'previous approved mesh')
    monkeypatch.setattr(pack, 'BUILD', build)
    monkeypatch.setattr(pack, 'OUT', out)
    with pytest.raises(SystemExit, match='surface rebuild incomplete'):
        pack.package('armoured_wreck')
    assert sentinel.read_bytes() == b'previous approved mesh'


def test_geometry_changed_since_bake_cannot_receive_stale_surface_maps(tmp_path, monkeypatch):
    import package_vehicles as pack
    import raw_models
    build, out = tmp_path / 'build', tmp_path / 'out'
    src = build / 'armoured_wreck'
    src.mkdir(parents=True)
    out.mkdir()
    original = [[0., 0., 0., 0., 1., 0., 0., 0.]]
    mesh = [original, [[0, 0, 0]]]
    (src / 'surface_meshes.json').write_text(json.dumps({
        'near': mesh, 'far': mesh, 'preserve_geometry': True,
    }))
    sentinel = out / 'armoured_wreck_albedo.webp'
    sentinel.write_bytes(b'approved surface')
    changed_uv = [[0., 0., 0., 0., 1., 0., 0.5, 0.5]]
    monkeypatch.setattr(pack, 'BUILD', build)
    monkeypatch.setattr(pack, 'OUT', out)
    monkeypatch.setattr(raw_models, 'raw_model', lambda path: path)
    monkeypatch.setattr(pack, 'read_wreck', lambda path, node: (changed_uv, mesh[1]))
    with pytest.raises(SystemExit, match='geometry changed since the surface bake'):
        pack.package('armoured_wreck')
    assert sentinel.read_bytes() == b'approved surface'
