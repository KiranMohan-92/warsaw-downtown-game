import json
import struct
import unittest
import zlib
from pathlib import Path

from courtyard_bake import _encode_pixels, _validate_scene, face_normal, receiver_geometry, sign_geometry, write_png


def tiny_scene():
    return {
        "version": 1,
        "sceneHash": "abc123",
        "bounds": [48, -22, 80, 22],
        "receiverY": 0.02,
        "emitter": {"x": 58, "y": 5.15, "z": 0, "yaw": 90, "w": 8, "h": 2.2, "color": 0x5EE7FF},
        "meshes": [
            {
                "name": "tri",
                "positions": [50, 0, 0, 51, 0, 0, 50, 1, 0],
                "indices": [0, 1, 2],
                "color": [1, 1, 1],
            }
        ],
    }


def png_rows(path: Path):
    data = path.read_bytes()
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    pos = 8
    width = height = None
    compressed = b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        kind = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, bit_depth, color_type, *_ = struct.unpack(">IIBBBBB", payload)
            assert bit_depth == 8
            assert color_type == 6
        elif kind == b"IDAT":
            compressed += payload
        elif kind == b"IEND":
            break
    assert width is not None and height is not None
    raw = zlib.decompress(compressed)
    rows = []
    stride = width * 4
    for y in range(height):
        assert raw[y * (stride + 1)] == 0
        rows.append(raw[y * (stride + 1) + 1 : y * (stride + 1) + 1 + stride])
    return width, height, rows


class CourtyardBakeTests(unittest.TestCase):
    def test_linear_encoding_keeps_minimum_z_row_and_clamps_once(self):
        rgba, metrics = _encode_pixels([16, 0, 0, 1, 0, 32, 0, 1], 1, 2)
        self.assertEqual(rgba, bytes([255, 0, 0, 255, 0, 255, 0, 255]))
        self.assertEqual(metrics['clippedChannels'], 1)

    def test_scene_validation_contract_accepts_tiny_triangle(self):
        _validate_scene(tiny_scene(), 256, 32)

    def test_scene_validation_rejects_stale_bounds_and_bad_indices(self):
        scene = tiny_scene()
        scene["bounds"] = [0, 0, 1, 1]
        with self.assertRaisesRegex(ValueError, "bounds"):
            _validate_scene(scene, 256, 32)

        scene = tiny_scene()
        scene["meshes"][0]["indices"] = [0, 1, 3]
        with self.assertRaisesRegex(ValueError, "out-of-range"):
            _validate_scene(scene, 256, 32)

        scene = tiny_scene()
        scene["meshes"][0]["indices"] = [0, -1, 2]
        with self.assertRaisesRegex(ValueError, "negative"):
            _validate_scene(scene, 256, 32)

        scene = tiny_scene()
        scene["meshes"][0]["positions"][1] = float("nan")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            _validate_scene(scene, 256, 32)

    def test_write_png_preserves_top_row_order(self):
        pixels = bytes(
            [
                255,
                0,
                0,
                255,
                0,
                255,
                0,
                255,
                0,
                0,
                255,
                255,
                255,
                255,
                255,
                255,
            ]
        )
        path = Path(__file__).with_name("_tmp_tiny.png")
        try:
            write_png(path, 2, 2, pixels)
            width, height, rows = png_rows(path)
            self.assertEqual((width, height), (2, 2))
            self.assertEqual(rows[0][:8], pixels[:8])
            self.assertEqual(rows[1][:8], pixels[8:])
        finally:
            path.unlink(missing_ok=True)

    def test_tiny_scene_json_is_stdlib_serializable(self):
        self.assertEqual(json.loads(json.dumps(tiny_scene()))["sceneHash"], "abc123")

    def test_receiver_and_sign_winding_match_game_contract(self):
        verts, faces, uvs = receiver_geometry([48, -22, 80, 22], 0.02)
        self.assertGreater(face_normal(verts[faces[0][0]], verts[faces[0][1]], verts[faces[0][2]])[1], 0.99)
        self.assertEqual(uvs[0], (0, 0))
        self.assertEqual(uvs[1], (1, 1))
        self.assertEqual(uvs[2], (1, 0))

        sign_verts, sign_faces = sign_geometry(tiny_scene()["emitter"])
        self.assertGreater(
            face_normal(sign_verts[sign_faces[0][0]], sign_verts[sign_faces[0][1]], sign_verts[sign_faces[0][2]])[0],
            0.99,
        )


if __name__ == "__main__":
    unittest.main()
