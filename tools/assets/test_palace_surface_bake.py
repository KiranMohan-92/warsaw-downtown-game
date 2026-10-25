import hashlib
import json
import statistics

from palace_surface_bake import main, column_uv, texture_bytes


def test_palace_texture_bytes_are_deterministic_and_have_detail():
    first = texture_bytes(64)
    second = texture_bytes(64)

    assert first == second
    assert set(first) == {"albedo", "normal", "roughness"}
    assert all(len(data) == 64 * 64 * 4 for data in first.values())

    albedo_luma = [
        round(first["albedo"][i] * 0.2126 + first["albedo"][i + 1] * 0.7152 + first["albedo"][i + 2] * 0.0722)
        for i in range(0, len(first["albedo"]), 4)
    ]
    assert statistics.pstdev(albedo_luma) > 15
    assert min(albedo_luma) < 145
    assert max(albedo_luma) > 205

    blue = first["normal"][2::4]
    assert min(blue) > 120
    assert statistics.pstdev(first["normal"][0::4]) > 9


def test_column_uv_uses_world_height_and_face_axis():
    front = column_uv(51.5, 6.0, -14.54, (0.0, 0.0, 1.0))
    side = column_uv(51.5, 6.0, -14.54, (1.0, 0.0, 0.0))
    higher = column_uv(51.5, 8.2, -14.54, (0.0, 0.0, 1.0))

    assert front[0] != side[0]
    assert higher[1] != front[1]
    assert higher[1] == (8.2 / 2.2) % 1.0
    assert 0.0 <= front[0] < 1.0
    assert 0.0 <= side[0] < 1.0


def test_main_writes_portable_manifest_paths_and_truthful_hashes(tmp_path):
    assert main(["--out", str(tmp_path), "--size", "64"]) == 0
    manifest = json.loads((tmp_path / "palace_column.json").read_text())

    assert manifest["filter"] == "gaussian 1 px before WebP encode"
    for output in manifest["outputs"].values():
        path = tmp_path / output["path"]
        assert not output["path"].startswith("/")
        assert path.exists()
        data = path.read_bytes()
        assert output["bytes"] == len(data)
        assert output["sha256"] == hashlib.sha256(data).hexdigest()
