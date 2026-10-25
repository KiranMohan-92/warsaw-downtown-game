import * as THREE from 'three';

export const STALL_LIGHT_ATTRIBUTE = 'aStallLight';
export const STALL_LIGHT_KEY = 'stallStripLight-v1';

export const STALL_LIGHT_FIXTURE = {
  center: new THREE.Vector3(0, -0.2, 0.95),
  width: 2.4,
  depth: 0.06,
  radiance: 30,
} as const;

const WARM = new THREE.Color(1, 0.82, 0.58);
const AREA = STALL_LIGHT_FIXTURE.width * STALL_LIGHT_FIXTURE.depth;
const EPS = 0.002;
const MAX_HORIZONTAL = 2.6;
const TMP = new THREE.Vector3();
const ATTR_POS = new THREE.Vector3();
const ATTR_LIGHT = new THREE.Vector4();
const SAMPLE_LIGHT = new THREE.Vector3();
const SAMPLE_DIRECTION = new THREE.Vector3();
const RAY_START = new THREE.Vector3();
const AXES = ['x', 'y', 'z'] as const;

interface Aabb {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

const OCCLUDERS: readonly Aabb[] = [
  {
    min: new THREE.Vector3(-1.5, -2.33, 0.25),
    max: new THREE.Vector3(1.5, -1.33, 0.95),
  },
  {
    min: new THREE.Vector3(-1.5, -2.33, -0.94),
    max: new THREE.Vector3(1.5, -0.13, -0.86),
  },
];

const SAMPLES: readonly [number, number][] = [
  [-0.42, -0.32],
  [-0.14, -0.32],
  [0.14, -0.32],
  [0.42, -0.32],
  [-0.42, 0.32],
  [-0.14, 0.32],
  [0.14, 0.32],
  [0.42, 0.32],
];

function segmentHitsAabb(from: THREE.Vector3, to: THREE.Vector3, box: Aabb): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = TMP.subVectors(to, from);
  for (const axis of AXES) {
    const o = from[axis];
    const v = d[axis];
    if (Math.abs(v) < 1e-7) {
      if (o < box.min[axis] || o > box.max[axis]) return false;
      continue;
    }
    let a = (box.min[axis] - o) / v;
    let b = (box.max[axis] - o) / v;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return t1 > EPS && t0 < 1 - EPS;
}

function visible(from: THREE.Vector3, to: THREE.Vector3): boolean {
  const ray = TMP.subVectors(to, from).normalize();
  const start = RAY_START.copy(from).addScaledVector(ray, EPS);
  for (const box of OCCLUDERS) if (segmentHitsAabb(start, to, box)) return false;
  return true;
}

/**
 * Approximate one warm strip diffuser under a market awning as direct irradiance.
 * The returned vec4 stores scalar irradiance in `.x` and an irradiance-weighted local
 * light direction in `.yzw`. It is a tiny load-time fixture sample, not a GI bake.
 */
export function sampleStallLight(
  localAt: THREE.Vector3,
  target = new THREE.Vector4(),
): THREE.Vector4 {
  if (
    localAt.y >= STALL_LIGHT_FIXTURE.center.y ||
    Math.abs(localAt.x) > 1.65 ||
    localAt.z < -0.95 ||
    localAt.z > 1.15 ||
    Math.hypot(localAt.x, localAt.z - STALL_LIGHT_FIXTURE.center.z) > MAX_HORIZONTAL
  )
    return target.set(0, 0, 0, 0);

  const dir = SAMPLE_DIRECTION.set(0, 0, 0);
  let e = 0;
  const eachArea = AREA / SAMPLES.length;
  for (const [ux, uz] of SAMPLES) {
    const light = SAMPLE_LIGHT.set(
      STALL_LIGHT_FIXTURE.center.x + ux * STALL_LIGHT_FIXTURE.width,
      STALL_LIGHT_FIXTURE.center.y,
      STALL_LIGHT_FIXTURE.center.z + uz * STALL_LIGHT_FIXTURE.depth,
    );
    if (!visible(localAt, light)) continue;
    const toLight = light.sub(localAt);
    const r2 = Math.max(0.001, toLight.lengthSq());
    const invR = 1 / Math.sqrt(r2);
    const emitterCos = Math.max(0, toLight.y * invR);
    if (emitterCos <= 0) continue;
    const s = (STALL_LIGHT_FIXTURE.radiance * eachArea * emitterCos) / r2;
    e += s;
    dir.addScaledVector(toLight, s * invR);
  }
  return target.set(e, dir.x, dir.y, dir.z);
}

export function rotateStallLight(
  localLight: THREE.Vector4,
  frame: THREE.Matrix4,
  target = new THREE.Vector4(),
): THREE.Vector4 {
  if (localLight.x <= 0) return target.set(0, 0, 0, 0);
  const e = frame.elements;
  const x = localLight.y;
  const y = localLight.z;
  const z = localLight.w;
  return target.set(
    localLight.x,
    e[0] * x + e[4] * y + e[8] * z,
    e[1] * x + e[5] * y + e[9] * z,
    e[2] * x + e[6] * y + e[10] * z,
  );
}

export function setStallLightAttribute(
  geo: THREE.BufferGeometry,
  frame?: THREE.Matrix4,
): THREE.BufferGeometry {
  const p = geo.getAttribute('position');
  const data = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const light = frame
      ? rotateStallLight(
          sampleStallLight(ATTR_POS.fromBufferAttribute(p, i), ATTR_LIGHT),
          frame,
          ATTR_LIGHT,
        )
      : ATTR_LIGHT.set(0, 0, 0, 0);
    const o = i * 4;
    data[o] = light.x;
    data[o + 1] = light.y;
    data[o + 2] = light.z;
    data[o + 3] = light.w;
  }
  geo.setAttribute(STALL_LIGHT_ATTRIBUTE, new THREE.BufferAttribute(data, 4));
  return geo;
}

const patched = new WeakSet<THREE.Material>();

export function addStallLight(mat: THREE.Material): boolean {
  if (!(mat instanceof THREE.MeshStandardMaterial) || patched.has(mat)) return false;
  patched.add(mat);
  const previous = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey();
  const defaults = {
    ...(mat as { defaultAttributeValues?: Record<string, number[]> }).defaultAttributeValues,
  };
  defaults[STALL_LIGHT_ATTRIBUTE] = [0, 0, 0, 0];
  (mat as { defaultAttributeValues?: Record<string, number[]> }).defaultAttributeValues = defaults;
  const c = WARM.toArray()
    .map((v) => v.toFixed(3))
    .join(', ');
  mat.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute vec4 ${STALL_LIGHT_ATTRIBUTE};\nvarying vec4 vStallLight;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvStallLight = ${STALL_LIGHT_ATTRIBUTE};`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n#ifndef TONE_MAPPING\nvarying vec4 vStallLight;\n#endif',
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
#ifndef TONE_MAPPING
{
  vec3 stallNormal = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  float stallE = min(max(dot(stallNormal, vStallLight.yzw), 0.0), vStallLight.x * 2.5);
  reflectedLight.indirectDiffuse +=
    BRDF_Lambert(material.diffuseColor) * vec3(${c}) * stallE;
}
#endif`,
      );
  };
  mat.customProgramCacheKey = () => `${key}|${STALL_LIGHT_KEY}`;
  mat.needsUpdate = true;
  return true;
}
