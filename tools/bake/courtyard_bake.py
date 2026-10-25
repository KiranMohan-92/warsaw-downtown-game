"""Bake the Palace entrance sign illumination onto a small flat courtyard texture.

The module is import-safe outside Blender; bpy is imported only inside bake().
"""

from __future__ import annotations

import argparse
import binascii
import json
import math
import struct
import time
import zlib
from pathlib import Path
from typing import Any

BOUNDS = [48, -22, 80, 22]
RECEIVER_Y = 0.02
RADIANCE_SCALE = 16.0


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)


def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    if width <= 0 or height <= 0 or len(rgba) != width * height * 4:
        raise ValueError("Invalid PNG dimensions or buffer length")
    rows = bytearray()
    stride = width * 4
    for y in range(height):
        rows.append(0)
        rows.extend(rgba[y * stride : (y + 1) * stride])
    payload = b"\x89PNG\r\n\x1a\n"
    payload += _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    payload += _chunk(b"IDAT", zlib.compress(bytes(rows), level=9))
    payload += _chunk(b"IEND", b"")
    path.write_bytes(payload)


def _validate_scene(scene: dict[str, Any], size: int, samples: int) -> None:
    if scene.get("version") != 1:
        raise ValueError("Scene version must be 1")
    if scene.get("bounds") != BOUNDS or scene.get("receiverY") != RECEIVER_Y:
        raise ValueError("Scene bounds or receiver height do not match the runtime contract")
    if not isinstance(scene.get("sceneHash"), str) or not scene["sceneHash"]:
        raise ValueError("Scene hash is required")
    emitter = scene.get("emitter")
    if not isinstance(emitter, dict) or emitter.get("x") != 58 or emitter.get("yaw") != 90:
        raise ValueError("Emitter must be the Palace cyan sign")
    if size not in (64, 128, 256, 512, 1024):
        raise ValueError("Size must be one of 64, 128, 256, 512 or 1024")
    if not 1 <= samples <= 256:
        raise ValueError("Samples must be between 1 and 256")
    meshes = scene.get("meshes")
    if not isinstance(meshes, list) or not meshes:
        raise ValueError("Scene must contain at least one mesh")
    tri_count = 0
    for mesh in meshes:
        positions = mesh.get("positions")
        indices = mesh.get("indices")
        if not isinstance(positions, list) or len(positions) % 3:
            raise ValueError(f"Mesh {mesh.get('name')} has invalid positions")
        if not isinstance(indices, list) or len(indices) % 3:
            raise ValueError(f"Mesh {mesh.get('name')} has invalid indices")
        if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in positions):
            raise ValueError(f"Mesh {mesh.get('name')} has non-finite positions")
        if any(not isinstance(i, int) or i < 0 for i in indices):
            raise ValueError(f"Mesh {mesh.get('name')} has negative or non-integer indices")
        if positions and max(indices, default=-1) >= len(positions) // 3:
            raise ValueError(f"Mesh {mesh.get('name')} has out-of-range indices")
        tri_count += len(indices) // 3
    if tri_count <= 0:
        raise ValueError("Scene has no triangles")


def _game_to_blender(p: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = p
    return (x, -z, y)


def receiver_geometry(bounds: list[float], y: float) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]], list[tuple[float, float]]]:
    x0, z0, x1, z1 = bounds
    return (
        [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)],
        [(0, 2, 1), (0, 3, 2)],
        [(0, 0), (1, 1), (1, 0), (0, 0), (0, 1), (1, 1)],
    )


def sign_geometry(emitter: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    half_w = float(emitter["w"]) / 2
    half_h = float(emitter["h"]) / 2
    sx = float(emitter["x"])
    sy = float(emitter["y"])
    sz = float(emitter["z"])
    verts = [
        (sx, sy - half_h, sz - half_w),
        (sx, sy - half_h, sz + half_w),
        (sx, sy + half_h, sz + half_w),
        (sx, sy + half_h, sz - half_w),
    ]
    return verts, [(0, 2, 1), (0, 3, 2)]


def face_normal(a: tuple[float, float, float], b: tuple[float, float, float], c: tuple[float, float, float]) -> tuple[float, float, float]:
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    n = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    length = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
    return (n[0] / length, n[1] / length, n[2] / length)


def _linear_color(hex_color: int, energy: float) -> tuple[float, float, float, float]:
    r = ((hex_color >> 16) & 255) / 255.0
    g = ((hex_color >> 8) & 255) / 255.0
    b = (hex_color & 255) / 255.0

    def srgb_to_linear(v: float) -> float:
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    return (srgb_to_linear(r) * energy, srgb_to_linear(g) * energy, srgb_to_linear(b) * energy, 1.0)


def _encode_pixels(pixel_values: list[float], width: int, height: int) -> tuple[bytes, dict[str, float]]:
    out = bytearray(width * height * 4)
    values: list[float] = []
    clipped = 0
    nonzero = 0
    for y in range(height):
      for x in range(width):
        src = (y * width + x) * 4
        dst = (y * width + x) * 4
        for c in range(3):
            v = max(0.0, pixel_values[src + c])
            values.append(v)
            q = v / RADIANCE_SCALE
            if q > 1.0:
                clipped += 1
                q = 1.0
            if q > 0.0005:
                nonzero += 1
            out[dst + c] = min(255, max(0, round(q * 255)))
        out[dst + 3] = 255
    mean = sum(values) / len(values)
    return bytes(out), {
        "min": min(values),
        "max": max(values),
        "mean": mean,
        "nonzeroChannels": nonzero,
        "clippedChannels": clipped,
    }


def bake(scene: dict[str, Any], out: Path, size: int, samples: int, device: str = "cpu") -> dict[str, Any]:
    _validate_scene(scene, size, samples)
    started = time.perf_counter()
    import bpy  # type: ignore

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = samples
    bpy.context.scene.cycles.use_denoising = True
    bpy.context.scene.cycles.device = "CPU"
    bpy.context.scene.world.color = (0.0, 0.0, 0.0)
    # Factory startup's World uses nodes: its legacy color does not disable the Background.
    world = bpy.context.scene.world
    world.use_nodes = True
    for node in world.node_tree.nodes:
        if node.type == "BACKGROUND":
            node.inputs["Color"].default_value = (0, 0, 0, 1)
            node.inputs["Strength"].default_value = 0
    bpy.context.scene.view_settings.view_transform = "Standard"
    bpy.context.scene.view_settings.look = "None"
    bpy.context.scene.view_settings.exposure = 0
    bpy.context.scene.view_settings.gamma = 1
    actual_device = "CPU"
    if device == "cuda":
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        prefs.get_devices()
        enabled = 0
        for dev in prefs.devices:
            dev.use = False
            if dev.type == "CUDA":
                dev.use = True
                enabled += 1
        if not enabled:
            raise RuntimeError("CUDA device requested but not available")
        bpy.context.scene.cycles.device = "GPU"
        actual_device = "CUDA"

    white = bpy.data.materials.new("matte-white")
    white.use_nodes = True
    bsdf = white.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
    bsdf.inputs["Roughness"].default_value = 1
    color_mats: dict[tuple[float, float, float], Any] = {}

    def matte(color: list[float] | tuple[float, float, float]):
        key = tuple(round(max(0.0, min(1.0, float(c))), 4) for c in color)
        mat = color_mats.get(key)
        if mat:
            return mat
        mat = bpy.data.materials.new(f"matte-{key[0]:.2f}-{key[1]:.2f}-{key[2]:.2f}")
        mat.use_nodes = True
        node = mat.node_tree.nodes.get("Principled BSDF")
        node.inputs["Base Color"].default_value = (key[0], key[1], key[2], 1)
        node.inputs["Roughness"].default_value = 1
        color_mats[key] = mat
        return mat

    for mesh in scene["meshes"]:
        verts = [
            _game_to_blender((mesh["positions"][i], mesh["positions"][i + 1], mesh["positions"][i + 2]))
            for i in range(0, len(mesh["positions"]), 3)
        ]
        faces = [tuple(mesh["indices"][i : i + 3]) for i in range(0, len(mesh["indices"]), 3)]
        data = bpy.data.meshes.new(mesh["name"])
        data.from_pydata(verts, [], faces)
        data.update()
        obj = bpy.data.objects.new(mesh["name"], data)
        obj.data.materials.append(matte(mesh.get("color", (0.74, 0.72, 0.68))))
        bpy.context.collection.objects.link(obj)

    receiver_verts, receiver_faces, receiver_uvs = receiver_geometry(scene["bounds"], scene["receiverY"])
    receiver_mesh = bpy.data.meshes.new("courtyard-receiver")
    receiver_mesh.from_pydata(
        [_game_to_blender(v) for v in receiver_verts],
        [],
        receiver_faces,
    )
    receiver_mesh.update()
    uv = receiver_mesh.uv_layers.new(name="bake-uv")
    for loop, co in zip(uv.data, receiver_uvs, strict=True):
        loop.uv = co
    receiver = bpy.data.objects.new("courtyard-receiver", receiver_mesh)
    receiver.data.materials.append(white)
    bpy.context.collection.objects.link(receiver)

    emitter = scene["emitter"]
    emit_mat = bpy.data.materials.new("cyan-sign-emitter")
    emit_mat.use_nodes = True
    emit_mat.node_tree.nodes.clear()
    emission = emit_mat.node_tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = _linear_color(int(emitter["color"]), 1.0)
    emission.inputs["Strength"].default_value = 120.0
    output = emit_mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
    emit_mat.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    sign_verts, sign_faces = sign_geometry(emitter)
    sign_mesh = bpy.data.meshes.new("palace-neon-sign")
    sign_mesh.from_pydata(
        [_game_to_blender(v) for v in sign_verts],
        [],
        sign_faces,
    )
    sign_mesh.update()
    sign = bpy.data.objects.new("palace-neon-sign", sign_mesh)
    sign.data.materials.append(emit_mat)
    bpy.context.collection.objects.link(sign)

    image = bpy.data.images.new("courtyard-bake", size, size, alpha=True, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    nodes = white.node_tree.nodes
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    nodes.active = tex
    bpy.context.view_layer.objects.active = receiver
    receiver.select_set(True)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=2)
    pixels = [0.0] * (size * size * 4)
    image.pixels.foreach_get(pixels)
    rgba, pixel_metrics = _encode_pixels(pixels, size, size)

    out.mkdir(parents=True, exist_ok=True)
    png = out / "courtyard.png"
    write_png(png, size, size, rgba)
    metrics = {
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "device": actual_device,
        "samples": samples,
        "triangles": sum(len(m["indices"]) // 3 for m in scene["meshes"]),
        "meshes": len(scene["meshes"]),
        "pngBytes": png.stat().st_size,
        "pixels": pixel_metrics,
    }
    manifest = {
        "version": 1,
        "sceneHash": scene["sceneHash"],
        "layoutHash": scene.get("layoutHash"),
        "bounds": scene["bounds"],
        "receiverY": scene["receiverY"],
        "file": "courtyard.png",
        "width": size,
        "height": size,
        "radianceScale": RADIANCE_SCALE,
        "emitter": scene["emitter"],
        "device": actual_device,
        "samples": samples,
        "metrics": metrics,
        "limitations": scene.get("limitations", []),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2), flush=True)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--size", type=int, default=256)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    args = parser.parse_args(argv)
    bake(json.loads(args.scene.read_text(encoding="utf-8")), args.out, args.size, args.samples, args.device)
    return 0


if __name__ == "__main__":
    import sys

    cli = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    raise SystemExit(main(cli))
