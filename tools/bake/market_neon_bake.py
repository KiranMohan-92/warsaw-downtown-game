"""Bounded landmark RGB diffuse bake. Import-safe without Blender; no live-game installation."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import time
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from courtyard_bake import _encode_pixels, _game_to_blender, _linear_color, receiver_geometry, write_png

BOUNDS = [76, 30, 112, 62]
RECEIVER_Y = 0.02
RADIANCE_SCALE = 16.0
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_TRIANGLES = 300_000
MAX_VERTICES = 500_000
MAX_MESHES = 4_000
HEX = re.compile(r"^[0-9a-f]{64}$")


def geometry_fingerprint(meshes: list[dict]) -> str:
    digest = hashlib.sha256()
    for mesh in meshes:
        digest.update(f"{mesh['name']}\n{len(mesh['positions'])}/{len(mesh['indices'])}\n".encode())
        for values in (mesh["positions"], mesh["color"]):
            digest.update(struct.pack(f"<{len(values)}d", *values))
        digest.update(struct.pack(f"<{len(mesh['indices'])}I", *mesh["indices"]))
    return digest.hexdigest()


def lighting_fingerprint(emitters: list[dict]) -> str:
    digest = hashlib.sha256()
    for emitter in emitters:
        digest.update((emitter["label"] + "\n").encode())
        digest.update(struct.pack("<8d", *(emitter[k] for k in ("x", "y", "z", "yaw", "w", "h", "color", "radiance"))))
    return digest.hexdigest()


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def validate_scene(scene: dict, size: int, samples: int) -> None:
    if not isinstance(scene, dict) or scene.get("version") != 1 or scene.get("kind") != "market-neon-ground":
        raise ValueError("Expected market-neon-ground schema version 1")
    if scene.get("bounds") != BOUNDS or scene.get("receiverY") != RECEIVER_Y or scene.get("occlusionPadding") != 16:
        raise ValueError("Unexpected bounded landmark receiver")
    if size not in (128, 256, 512, 1024) or type(samples) is not int or not 1 <= samples <= 128:
        raise ValueError("Local bake supports 128/256/512/1024 pixels and 1..128 samples")
    if not isinstance(scene.get("sceneHash"), str) or not re.fullmatch(r"[0-9a-f]{14}", scene["sceneHash"]):
        raise ValueError("Missing current-map scene hash")
    if not isinstance(scene.get("layoutHash"), str) or not re.fullmatch(r"[0-9a-f]{14}", scene["layoutHash"]):
        raise ValueError("Missing current-map layout hash")
    meshes = scene.get("meshes")
    if not isinstance(meshes, list) or not 1 <= len(meshes) <= MAX_MESHES:
        raise ValueError("Scene mesh count exceeds bounds")
    triangles = vertices = 0
    names = set()
    for mesh in meshes:
        if not isinstance(mesh, dict) or not isinstance(mesh.get("name"), str) or not 1 <= len(mesh["name"]) <= 256 or mesh["name"] in names:
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
    emitters = scene.get("emitters")
    if not isinstance(emitters, list) or not 1 <= len(emitters) <= 4:
        raise ValueError("Expected 1..4 bounded existing sign emitters")
    labels = set()
    for emitter in emitters:
        if not isinstance(emitter, dict) or not isinstance(emitter.get("label"), str) or not 1 <= len(emitter["label"]) <= 64 or emitter["label"] in labels:
            raise ValueError("Invalid emitter label")
        labels.add(emitter["label"])
        if any(not _number(emitter.get(k)) for k in ("x", "y", "z", "yaw", "w", "h", "radiance")):
            raise ValueError("Non-finite sign specification")
        if not (0 < emitter["w"] <= 16 and 0 < emitter["h"] <= 8 and 0 < emitter["radiance"] <= 120):
            raise ValueError("Emitter dimensions or radiance exceed bounds")
        if not (abs(emitter["x"]) <= 10_000 and abs(emitter["z"]) <= 10_000 and -20 <= emitter["y"] <= 100 and abs(emitter["yaw"]) <= 360):
            raise ValueError("Emitter placement exceeds bounds")
        if type(emitter.get("color")) is not int or not 0 <= emitter["color"] <= 0xFFFFFF:
            raise ValueError("Invalid sRGB sign colour")
        dx = max(BOUNDS[0] - emitter["x"], 0, emitter["x"] - BOUNDS[2])
        dz = max(BOUNDS[1] - emitter["z"], 0, emitter["z"] - BOUNDS[3])
        if math.hypot(dx, dz) > 16 + emitter["w"] * 0.5:
            raise ValueError("Emitter lies outside landmark reach")
    if "NOCNY RYNEK" not in labels:
        raise ValueError("Missing actual NOCNY RYNEK landmark sign")
    sources = scene.get("sourceFingerprints")
    if not isinstance(sources, dict) or not 1 <= len(sources) <= 32 or any(not isinstance(k, str) or len(k) > 256 or not isinstance(v, str) or not HEX.fullmatch(v) for k, v in sources.items()):
        raise ValueError("Missing bounded source fingerprints")
    if scene.get("geometryFingerprint") != geometry_fingerprint(meshes):
        raise ValueError("Geometry fingerprint mismatch")
    if scene.get("lightingFingerprint") != lighting_fingerprint(emitters):
        raise ValueError("Lighting fingerprint mismatch")


def sign_geometry(emitter: dict) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    """Match browser PlaneGeometry rotated about Y; positive normal is (sin yaw,0,cos yaw)."""
    angle = math.radians(emitter["yaw"])
    right = (math.cos(angle), 0, -math.sin(angle))
    hw, hh = emitter["w"] / 2, emitter["h"] / 2
    vertices = [(emitter["x"] + sx * hw * right[0], emitter["y"] + sy * hh,
                 emitter["z"] + sx * hw * right[2]) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    return vertices, [(0, 1, 2), (0, 2, 3)]


def bake(scene: dict, out: Path, size: int = 512, samples: int = 64, device: str = "cpu", input_sha256: str | None = None) -> dict:
    validate_scene(scene, size, samples)
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
    render.world.use_nodes = True
    for node in render.world.node_tree.nodes:
        if node.type == "BACKGROUND":
            node.inputs["Color"].default_value = (0, 0, 0, 1)
            node.inputs["Strength"].default_value = 0
    render.view_settings.view_transform = "Standard"
    render.view_settings.look = "None"
    render.view_settings.exposure = 0
    render.view_settings.gamma = 1
    devices = []
    if device == "cuda":
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        prefs.get_devices()
        for candidate in prefs.devices:
            candidate.use = candidate.type == "CUDA"
            if candidate.use:
                devices.append(candidate.name)
        if not devices:
            raise RuntimeError("CUDA requested but no GPU available; refusing CPU fallback")
        render.cycles.device = "GPU"

    materials = {}
    def matte(color):
        key = tuple(color)
        if key not in materials:
            material = bpy.data.materials.new(f"diffuse-{len(materials)}")
            material.use_nodes = True
            bsdf = material.node_tree.nodes.get("Principled BSDF")
            bsdf.inputs["Base Color"].default_value = (*color, 1)
            bsdf.inputs["Roughness"].default_value = 1
            materials[key] = material
        return materials[key]

    def mesh_object(name, vertices, faces, material):
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
        # Exact browser housing dimensions and placement; it blocks emission through the rear.
        angle = math.radians(emitter["yaw"])
        right = (math.cos(angle), 0, -math.sin(angle))
        normal = (math.sin(angle), 0, math.cos(angle))
        housing_vertices = []
        for sx, sy, sz in ((-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)):
            housing_vertices.append((emitter["x"] + sx * (emitter["w"] + .22) / 2 * right[0] + (sz * .04 - .055) * normal[0],
                                     emitter["y"] + sy * (emitter["h"] + .18) / 2,
                                     emitter["z"] + sx * (emitter["w"] + .22) / 2 * right[2] + (sz * .04 - .055) * normal[2]))
        mesh_object("housing-" + emitter["label"], housing_vertices,
                    [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)], matte((.025,.03,.035)))

    vertices, faces, uvs = receiver_geometry(BOUNDS, RECEIVER_Y)
    white = matte((1, 1, 1))
    receiver = mesh_object("market-neon-receiver", vertices, faces, white)
    uv = receiver.data.uv_layers.new(name="bake-uv")
    for loop, coords in zip(uv.data, uvs, strict=True):
        loop.uv = coords
    image = bpy.data.images.new("market-neon-ground", size, size, alpha=True, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    texture = white.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    white.node_tree.nodes.active = texture
    bpy.context.view_layer.objects.active = receiver
    bpy.ops.object.select_all(action="DESELECT")
    receiver.select_set(True)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=2)
    pixels = [0.0] * (size * size * 4)
    image.pixels.foreach_get(pixels)
    rgba, pixel_metrics = _encode_pixels(pixels, size, size)
    out.mkdir(parents=True, exist_ok=True)
    png = out / "market-neon-ground.png"
    write_png(png, size, size, rgba)
    manifest = {key: scene[key] for key in ("version", "kind", "sceneHash", "layoutHash", "bounds", "receiverY", "occlusionPadding", "emitters", "geometryFingerprint", "lightingFingerprint", "sourceFingerprints", "limitations")}
    manifest.update(file=png.name, width=size, height=size, radianceScale=RADIANCE_SCALE,
                    encoding="linear RGBA8 white Lambert diffuse radiance E/PI; row zero minimum world Z; flipY false",
                    inputSha256=input_sha256, textureHash=hashlib.sha256(png.read_bytes()).hexdigest(),
                    device="CUDA" if devices else "CPU", gpuDevices=devices, samples=samples,
                    metrics={"elapsedSeconds": round(time.perf_counter() - start, 3), "meshes": len(scene["meshes"]),
                             "triangles": sum(len(m["indices"]) // 3 for m in scene["meshes"]), "pngBytes": png.stat().st_size,
                             "pixels": pixel_metrics})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2), flush=True)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--samples", type=int, default=64)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    import sys
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    payload = args.scene.read_bytes()
    if not 0 < len(payload) <= MAX_INPUT_BYTES:
        raise ValueError("Scene exceeds 8 MiB input limit")
    bake(json.loads(payload), args.out, args.size, args.samples, args.device, hashlib.sha256(payload).hexdigest())


if __name__ == "__main__":
    main()
