"""Bake NOCNY RYNEK RGB irradiance into the existing static box-face lightmap atlas."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from courtyard_bake import _encode_pixels, _game_to_blender, _linear_color, write_png
from market_neon_bake import (
    BOUNDS,
    MAX_INPUT_BYTES,
    RADIANCE_SCALE,
    geometry_fingerprint,
    lighting_fingerprint,
    sign_geometry,
)

MAX_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_ATLAS_PIXELS = MAX_OUTPUT_BYTES // 4
MAX_TRIANGLES = 300_000
MAX_VERTICES = 500_000
MAX_MESHES = 4_000
HEX = re.compile(r"^[0-9a-f]{64}$")
ENCODING = "linear RGBA8 white Lambert diffuse radiance E/PI; row zero atlas row; flipY false"
PNG_FILE = "market-neon-static.png"
HOUSING_COLOR = [0.025, 0.03, 0.035]


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def receiver_fingerprint(receiver: dict[str, Any]) -> str:
    import struct

    digest = hashlib.sha256()
    flat_uvs = [v for uv in receiver["uvs"] for v in uv]
    for values in (receiver["positions"], receiver["indices"], flat_uvs):
        digest.update(struct.pack(f"<{len(values)}d", *values))
    for item in receiver["receivers"]:
        digest.update(
            f"{item['boxIndex']}:{item['material']}:{','.join(str(v) for v in item['faceRects'])}\n".encode()
        )
    return digest.hexdigest()


def housing_name(emitter: dict[str, Any]) -> str:
    return "emitter-housing:" + str(emitter["label"])


def sign_housing_geometry(emitter: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, ...]]]:
    """Opaque browser sign housing, placed behind the emissive panel to block rear emission."""
    angle = math.radians(emitter["yaw"])
    right = (math.cos(angle), 0, -math.sin(angle))
    normal = (math.sin(angle), 0, math.cos(angle))
    hw = (emitter["w"] + 0.22) / 2
    hh = (emitter["h"] + 0.18) / 2
    vertices = []
    for sx, sy, sz in (
        (-1, -1, -1),
        (1, -1, -1),
        (1, 1, -1),
        (-1, 1, -1),
        (-1, -1, 1),
        (1, -1, 1),
        (1, 1, 1),
        (-1, 1, 1),
    ):
        depth = sz * 0.04 - 0.055
        vertices.append(
            (
                emitter["x"] + sx * hw * right[0] + depth * normal[0],
                emitter["y"] + sy * hh,
                emitter["z"] + sx * hw * right[2] + depth * normal[2],
            )
        )
    return vertices, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def validate_static_scene(scene: dict[str, Any], samples: int) -> None:
    if scene.get("version") != 1 or scene.get("kind") != "market-neon-static-atlas":
        raise ValueError("Expected market-neon-static-atlas schema version 1")
    if scene.get("bounds") != BOUNDS or scene.get("receiverY") != 0.02 or scene.get("occlusionPadding") != 16:
        raise ValueError("Unexpected bounded landmark receiver contract")
    if type(samples) is not int or not 1 <= samples <= 128:
        raise ValueError("Local bake supports 1..128 samples")
    if not isinstance(scene.get("sceneHash"), str) or not re.fullmatch(r"[0-9a-f]{14}", scene["sceneHash"]):
        raise ValueError("Missing current-map scene hash")
    if not isinstance(scene.get("layoutHash"), str) or not re.fullmatch(r"[0-9a-f]{14}", scene["layoutHash"]):
        raise ValueError("Missing current-map layout hash")
    atlas = scene.get("atlas")
    if (
        not isinstance(atlas, dict)
        or type(atlas.get("width")) is not int
        or type(atlas.get("height")) is not int
        or not 1 <= atlas["width"] <= 2048
        or not 1 <= atlas["height"] <= 4096
        or atlas["width"] * atlas["height"] > MAX_ATLAS_PIXELS
    ):
        raise ValueError("Atlas dimensions exceed static texture budget")
    meshes = scene.get("meshes")
    if not isinstance(meshes, list) or not 1 <= len(meshes) <= MAX_MESHES:
        raise ValueError("Scene mesh count exceeds bounds")
    triangles = vertices = 0
    names = set()
    for mesh in meshes:
        if not isinstance(mesh, dict) or not isinstance(mesh.get("name"), str) or mesh["name"] in names:
            raise ValueError("Invalid or duplicate mesh name")
        names.add(mesh["name"])
        positions, indices, color = (mesh.get(k) for k in ("positions", "indices", "color"))
        if not isinstance(positions, list) or not positions or len(positions) % 3 or any(not _number(v) or abs(v) > 10_000 for v in positions):
            raise ValueError("Invalid finite bounded positions")
        if not isinstance(indices, list) or not indices or len(indices) % 3 or any(type(i) is not int or not 0 <= i < len(positions) // 3 for i in indices):
            raise ValueError("Invalid triangle indices")
        if not isinstance(color, list) or len(color) != 3 or any(not _number(v) or not 0 <= v <= 1 for v in color):
            raise ValueError("Invalid linear diffuse colour")
        triangles += len(indices) // 3
        vertices += len(positions) // 3
        if triangles > MAX_TRIANGLES or vertices > MAX_VERTICES:
            raise ValueError("Geometry exceeds work budget")
    receiver = scene.get("receiver")
    if not isinstance(receiver, dict):
        raise ValueError("Missing receiver geometry")
    positions, indices, uvs = (receiver.get(k) for k in ("positions", "indices", "uvs"))
    if not isinstance(positions, list) or len(positions) < 72 or len(positions) % 3:
        raise ValueError("Invalid receiver positions")
    if not isinstance(indices, list) or len(indices) < 36 or len(indices) % 3 or any(type(i) is not int or not 0 <= i < len(positions) // 3 for i in indices):
        raise ValueError("Invalid receiver indices")
    if not isinstance(uvs, list) or len(uvs) != len(positions) // 3:
        raise ValueError("Receiver UV count must match vertices")
    if any(not isinstance(uv, list) or len(uv) != 2 or any(not _number(v) or not 0 <= v <= 1 for v in uv) for uv in uvs):
        raise ValueError("Receiver UVs must be finite normalized atlas coordinates")
    receivers = receiver.get("receivers")
    if not isinstance(receivers, list) or not receivers:
        raise ValueError("Missing selected receivers")
    seen = set()
    for item in receivers:
        if not isinstance(item, dict) or type(item.get("boxIndex")) is not int or item["boxIndex"] in seen:
            raise ValueError("Duplicate or invalid receiver box")
        seen.add(item["boxIndex"])
        if not isinstance(item.get("material"), str) or item["material"] in ("facade", "sandbag"):
            raise ValueError("Invalid receiver material")
        if not isinstance(item.get("faceRects"), list) or not item["faceRects"] or any(type(v) is not int or v < 0 for v in item["faceRects"]):
            raise ValueError("Invalid receiver face rects")
    if scene.get("receiverFingerprint") != receiver_fingerprint(receiver):
        raise ValueError("Receiver fingerprint mismatch")
    emitters = scene.get("emitters")
    if not isinstance(emitters, list) or not 1 <= len(emitters) <= 4:
        raise ValueError("Expected bounded existing sign emitters")
    if "NOCNY RYNEK" not in {e.get("label") for e in emitters if isinstance(e, dict)}:
        raise ValueError("Missing actual NOCNY RYNEK landmark sign")
    if scene.get("geometryFingerprint") != geometry_fingerprint(meshes):
        raise ValueError("Geometry fingerprint mismatch")
    if scene.get("lightingFingerprint") != lighting_fingerprint(emitters):
        raise ValueError("Lighting fingerprint mismatch")
    for emitter in emitters:
        housing = next((mesh for mesh in meshes if mesh["name"] == housing_name(emitter)), None)
        if housing is None:
            raise ValueError("Missing opaque sign housing behind emitter")
        vertices, faces = sign_housing_geometry(emitter)
        positions = [v for vertex in vertices for v in vertex]
        indices = [i for face in faces for tri in ((face[0], face[1], face[2]), (face[0], face[2], face[3])) for i in tri]
        if (len(housing["positions"]) != len(positions)
                or any(abs(a - b) > 0.00001 for a, b in zip(housing["positions"], positions))
                or housing["indices"] != indices or housing["color"] != HOUSING_COLOR):
            raise ValueError("Sign housing must match opaque browser geometry behind emitter")
    sources = scene.get("sourceFingerprints")
    if not isinstance(sources, dict) or any(not isinstance(k, str) or not isinstance(v, str) or not HEX.fullmatch(v) for k, v in sources.items()):
        raise ValueError("Missing bounded source fingerprints")
    materials = scene.get("receiverMaterials")
    if not isinstance(materials, list) or sorted(materials) != materials or any(not isinstance(m, str) for m in materials):
        raise ValueError("Invalid receiver material list")


def configure_device(bpy: Any, render: Any, device: str) -> list[str]:
    """Enable actual CUDA devices exclusively; an unavailable GPU is a failed bake."""
    if device not in ("cpu", "cuda"):
        raise ValueError("Device must be cpu or cuda")
    render.cycles.device = "CPU"
    if device == "cpu":
        return []
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "CUDA"
    prefs.get_devices()
    devices = []
    for candidate in prefs.devices:
        candidate.use = candidate.type == "CUDA"
        if candidate.use:
            devices.append(candidate.name)
    if not devices:
        raise RuntimeError("CUDA requested but no GPU available; refusing CPU fallback")
    render.cycles.device = "GPU"
    return devices


def bake(scene: dict[str, Any], out: Path, samples: int = 128, device: str = "cpu", input_sha256: str | None = None) -> dict[str, Any]:
    validate_static_scene(scene, samples)
    if device not in ("cpu", "cuda"):
        raise ValueError("Device must be cpu or cuda")
    if out.exists() and any(out.iterdir()):
        raise ValueError("Use a new or empty staging directory")
    start = time.perf_counter()
    import bpy  # type: ignore

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    render = bpy.context.scene
    render.render.engine = "CYCLES"
    render.cycles.samples = samples
    render.cycles.device = "CPU"
    render.cycles.use_denoising = True
    devices = configure_device(bpy, render, device)
    render.world.use_nodes = True
    for node in render.world.node_tree.nodes:
        if node.type == "BACKGROUND":
            node.inputs["Color"].default_value = (0, 0, 0, 1)
            node.inputs["Strength"].default_value = 0
    render.view_settings.view_transform = "Standard"
    render.view_settings.look = "None"
    render.view_settings.exposure = 0
    render.view_settings.gamma = 1

    materials: dict[tuple[float, float, float], Any] = {}

    def matte(color: tuple[float, float, float] | list[float]):
        key = tuple(float(v) for v in color)
        if key not in materials:
            material = bpy.data.materials.new(f"diffuse-{len(materials)}")
            material.use_nodes = True
            bsdf = material.node_tree.nodes.get("Principled BSDF")
            bsdf.inputs["Base Color"].default_value = (*key, 1)
            bsdf.inputs["Roughness"].default_value = 1
            materials[key] = material
        return materials[key]

    def mesh_object(name: str, vertices, faces, material):
        data = bpy.data.meshes.new(name)
        data.from_pydata([_game_to_blender(v) for v in vertices], [], faces)
        data.update()
        obj = bpy.data.objects.new(name, data)
        obj.data.materials.append(material)
        bpy.context.collection.objects.link(obj)
        return obj

    for mesh in scene["meshes"]:
        vertices = [tuple(mesh["positions"][i:i + 3]) for i in range(0, len(mesh["positions"]), 3)]
        faces = [tuple(mesh["indices"][i:i + 3]) for i in range(0, len(mesh["indices"]), 3)]
        mesh_object(mesh["name"], vertices, faces, matte(mesh["color"]))
    for emitter in scene["emitters"]:
        material = bpy.data.materials.new("sign-" + emitter["label"])
        material.use_nodes = True
        nodes = material.node_tree.nodes
        nodes.clear()
        emission = nodes.new("ShaderNodeEmission")
        emission.inputs["Color"].default_value = _linear_color(emitter["color"], 1)
        emission.inputs["Strength"].default_value = emitter["radiance"]
        output = nodes.new("ShaderNodeOutputMaterial")
        material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
        vertices, faces = sign_geometry(emitter)
        mesh_object("panel-" + emitter["label"], vertices, faces, material)

    width = scene["atlas"]["width"]
    height = scene["atlas"]["height"]
    receiver_material = matte((1, 1, 1))
    receiver_material.name = "whiteLambert-static-receiver"
    receiver_positions = scene["receiver"]["positions"]
    vertices = [tuple(receiver_positions[i:i + 3]) for i in range(0, len(receiver_positions), 3)]
    receiver_indices = scene["receiver"]["indices"]
    faces = [tuple(receiver_indices[i:i + 3]) for i in range(0, len(receiver_indices), 3)]
    receiver = mesh_object("market-neon-static-receiver", vertices, faces, receiver_material)
    uv = receiver.data.uv_layers.new(name="bake-uv")
    loop_uvs = [scene["receiver"]["uvs"][index] for index in receiver_indices]
    for loop, coords in zip(uv.data, loop_uvs, strict=True):
        loop.uv = coords
    image = bpy.data.images.new("market-neon-static", width, height, alpha=True, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    texture = receiver_material.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    receiver_material.node_tree.nodes.active = texture
    bpy.context.view_layer.objects.active = receiver
    bpy.ops.object.select_all(action="DESELECT")
    receiver.select_set(True)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=1)
    pixels = [0.0] * (width * height * 4)
    image.pixels.foreach_get(pixels)
    rgba, pixel_metrics = _encode_pixels(pixels, width, height)
    out.mkdir(parents=True, exist_ok=True)
    png = out / PNG_FILE
    write_png(png, width, height, rgba)
    manifest = {
        key: scene[key]
        for key in (
            "version",
            "kind",
            "sceneHash",
            "layoutHash",
            "bounds",
            "receiverY",
            "occlusionPadding",
            "emitters",
            "geometryFingerprint",
            "lightingFingerprint",
            "receiverFingerprint",
            "receiverMaterials",
            "sourceFingerprints",
            "limitations",
        )
    }
    manifest.update(
        file=png.name,
        width=width,
        height=height,
        radianceScale=RADIANCE_SCALE,
        encoding=ENCODING,
        inputSha256=input_sha256,
        textureHash=hashlib.sha256(png.read_bytes()).hexdigest(),
        receiverCount=len(scene["receiver"]["receivers"]),
        device="CUDA" if devices else "CPU",
        gpuDevices=devices,
        samples=samples,
        metrics={
            "elapsedSeconds": round(time.perf_counter() - start, 3),
            "meshes": len(scene["meshes"]),
            "triangles": sum(len(m["indices"]) // 3 for m in scene["meshes"]),
            "receiverTriangles": len(scene["receiver"]["indices"]) // 3,
            "pngBytes": png.stat().st_size,
            "pixels": pixel_metrics,
        },
    )
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2), flush=True)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    import sys

    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    payload = args.scene.read_bytes()
    if not 0 < len(payload) <= MAX_INPUT_BYTES:
        raise ValueError("Scene exceeds 8 MiB input limit")
    bake(json.loads(payload), args.out, args.samples, args.device, hashlib.sha256(payload).hexdigest())


if __name__ == "__main__":
    main()
