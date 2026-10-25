/**
 * Baked ceiling-lamp light, shared by the static map (`mapMesh.addLampLight`, atlas texels) and
 * dynamic objects (this module's lamp *volume*: soldiers, the first-person arms and guns, pickups,
 * the skateboard, hero models). One strength and colour for both, so a soldier under a panel reads
 * as bright as the floor under it.
 *
 * The volume is one `Data3DTexture` of L1 irradiance voxels (`shared/maps/lampVolume.ts`). Every
 * patched material samples it once per fragment (trilinear, by world position; the viewmodel by
 * the world camera's position) and adds E·albedo/π to its indirect diffuse after the aoMap, like
 * the static lamps. **Medium+ only:** the code is compiled out where the material tone-maps itself
 * (`TONE_MAPPING` is defined only on Low, where the renderer tone-maps; Medium+ tone-maps in the
 * post chain), so Low keeps its exact programs and cost, and the Low/Medium variants are the two
 * programs warm-up already compiles for every material (tone mapping is in three's program key).
 * Until (or unless) a bake's volume loads, the texture is present but all zero: nothing
 * recompiles when it fills in.
 */
import * as THREE from 'three';
import { LAMP_VOLUME_SCALE, type LampVolumeLayout } from '@wd/shared';

/**
 * Strength of the baked ceiling lamps (static atlas and volume): how bright the fixtures read
 * against the day-lit exterior. Warm white.
 */
export const LAMP_INTENSITY = 2.5;
export const LAMP_COLOR = new THREE.Color(1, 0.9, 0.76);

/** How a patched material finds its sample point: its own fragments, or the world camera. */
export type LampVolumeMode = 'world' | 'camera';

const emptyVolume = (): THREE.Data3DTexture => volumeTexture(1, 1, 1);

function volumeTexture(nx: number, ny: number, nz: number): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(new Uint8Array(nx * ny * nz * 4), nx, ny, nz);
  tex.name = 'lampVolume';
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The uniforms every patched material shares by reference (three reads `.value` each draw), so
 * configuring the volume or moving the probe updates them all at once.
 */
export const LAMP_VOLUME_UNIFORMS = {
  lampVolume: { value: emptyVolume() },
  lampVolumeMin: { value: new THREE.Vector3() },
  lampVolumeInvSize: { value: new THREE.Vector3(1, 1, 1) },
  /** 'camera' mode: the world camera's position and view matrix (the viewmodel has its own). */
  lampProbe: { value: new THREE.Vector3() },
  lampProbeView: { value: new THREE.Matrix4() },
};

/**
 * Size the shared volume for a map's bake (zero-filled: dark until `startLoads` fills it in place),
 * or reset it to the empty 1×1×1 volume (no bake / no volume). Call before anything compiles or
 * uploads, i.e. at map build. Returns the texture to fill.
 */
export function configureLampVolume(layout: LampVolumeLayout | null): THREE.Data3DTexture {
  const u = LAMP_VOLUME_UNIFORMS;
  u.lampVolume.value.dispose();
  if (!layout) {
    u.lampVolume.value = emptyVolume();
    u.lampVolumeMin.value.set(0, 0, 0);
    u.lampVolumeInvSize.value.set(1, 1, 1);
    return u.lampVolume.value;
  }
  const { nx, ny, nz, cell, min } = layout;
  u.lampVolume.value = volumeTexture(nx, ny, nz);
  u.lampVolumeMin.value.set(min.x, min.y, min.z);
  u.lampVolumeInvSize.value.set(1 / (nx * cell), 1 / (ny * cell), 1 / (nz * cell));
  return u.lampVolume.value;
}

/** 'camera'-mode materials (the viewmodel) sample the volume where the world camera is. */
export function updateLampProbe(camera: THREE.Camera): void {
  LAMP_VOLUME_UNIFORMS.lampProbe.value.setFromMatrixPosition(camera.matrixWorld);
  LAMP_VOLUME_UNIFORMS.lampProbeView.value.copy(camera.matrixWorldInverse);
}

/** Materials already patched, with their mode (a second, different mode is a wiring bug). */
const patched = new WeakMap<THREE.Material, LampVolumeMode>();

/** Fragment code for a mode (exported for tests). */
export function lampVolumeFragment(mode: LampVolumeMode): string {
  const s = LAMP_VOLUME_SCALE.toFixed(4);
  const k = LAMP_INTENSITY.toFixed(4);
  const c = LAMP_COLOR.toArray()
    .map((v) => v.toFixed(3))
    .join(', ');
  // View-space → world: v · M (row vector) applies the transpose of the view rotation, its inverse.
  const at =
    mode === 'camera'
      ? 'lampProbe'
      : 'cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz';
  const view = mode === 'camera' ? 'lampProbeView' : 'viewMatrix';
  return `
#ifndef TONE_MAPPING
  {
    vec3 lampAt = ${at};
    vec3 lampN = (vec4(normal, 0.0) * ${view}).xyz;
    vec4 lampV = texture(lampVolume, (lampAt - lampVolumeMin) * lampVolumeInvSize);
    float lampA = lampV.r * ${s};
    vec3 lampDir = (lampV.gba * 255.0 - 128.0) * (2.0 * ${s} / 127.0);
    float lampE = clamp(lampA + dot(lampDir, lampN), 0.0, 3.0 * lampA);
    reflectedLight.indirectDiffuse +=
      BRDF_Lambert(material.diffuseColor) * vec3(${c}) * (lampE * ${k});
  }
#endif`;
}

const UNIFORMS_GLSL = `
uniform highp sampler3D lampVolume;
uniform vec3 lampVolumeMin;
uniform vec3 lampVolumeInvSize;
uniform vec3 lampProbe;
uniform mat4 lampProbeView;`;

/**
 * Add the lamp volume to one lit material (MeshStandard/Physical), chaining any earlier
 * `onBeforeCompile` and extending its program key. Idempotent. Materials that skip tone mapping
 * (`toneMapped: false`: glows, HUD-like parts) are left alone, since the Low gate relies on it.
 */
export function patchLampVolume(m: THREE.Material, mode: LampVolumeMode): boolean {
  if (!(m instanceof THREE.MeshStandardMaterial) || !m.toneMapped) return false;
  const done = patched.get(m);
  if (done === mode) return false;
  if (done)
    throw new Error(
      `lamp volume: material "${m.name}" is shared between '${done}' and '${mode}' objects ` +
        '(give one of them its own clone)',
    );
  patched.set(m, mode);
  const prev = m.onBeforeCompile.bind(m);
  const key = m.customProgramCacheKey();
  const frag = lampVolumeFragment(mode);
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, LAMP_VOLUME_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${UNIFORMS_GLSL}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>${frag}`);
  };
  m.customProgramCacheKey = () => `${key}|lampVolume:${mode}`;
  m.needsUpdate = true;
  return true;
}

/** Patch every lit material under `root` (see `patchLampVolume`); returns how many changed. */
export function applyLampVolume(root: THREE.Object3D, mode: LampVolumeMode): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m && patchLampVolume(m, mode)) n++;
    }
  });
  return n;
}
