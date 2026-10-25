import * as THREE from 'three';

/** One camera-facing instanced quad buffer; attributes and material are never rebuilt on hits. */
export class ImpactSprites {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshBasicMaterial>;
  readonly centers: Float32Array;
  readonly colors: Float32Array;
  readonly sizes: Float32Array;
  readonly angles: Float32Array;
  readonly velocities: Float32Array;
  private readonly height = { value: 900 };
  private readonly limit = { value: 198 };
  private readonly sun = { value: new THREE.Vector3(0, 1, 0) };

  constructor(capacity: number, additive: boolean, name: string) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute('position', plane.getAttribute('position'));
    geo.setAttribute('uv', plane.getAttribute('uv'));
    this.centers = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 4);
    this.sizes = new Float32Array(capacity * 2);
    this.angles = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    geo.setAttribute('aCenter', attribute(this.centers, 3));
    geo.setAttribute('color', attribute(this.colors, 4));
    geo.setAttribute('aSize', attribute(this.sizes, 2));
    geo.setAttribute('aAngle', attribute(this.angles, 1));
    geo.setAttribute('aVelocity', attribute(this.velocities, 3));
    geo.instanceCount = 0;
    // Three sorts transparent meshes by this centre; aCenter lives outside the plane bounds.
    geo.boundingSphere = new THREE.Sphere();
    const mat = new THREE.MeshBasicMaterial({
      map: impactTexture(additive),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: !additive,
      // Metal carries hot linear radiance; the same material also handles cool glass glints.
      toneMapped: !additive,
    });
    mat.name = name;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.fxHeight = this.height;
      shader.uniforms.fxLimit = this.limit;
      shader.uniforms.fxSun = this.sun;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `
#include <common>
attribute vec3 aCenter;
attribute vec2 aSize;
attribute float aAngle;
attribute vec3 aVelocity;
uniform float fxHeight;
uniform float fxLimit;
uniform vec3 fxSun;
varying vec2 vFxLight;
`,
        )
        .replace(
          '#include <project_vertex>',
          `
vec4 mvPosition = modelViewMatrix * vec4(aCenter, 1.0);
vec2 motion = (modelViewMatrix * vec4(aVelocity, 0.0)).xy;
float angle = dot(motion, motion) > 0.00001 ? atan(motion.y, motion.x) : aAngle;
float c = cos(angle), s = sin(angle);
float projected = max(aSize.x, aSize.y) * projectionMatrix[1][1] * fxHeight / (2.0 * max(0.1, -mvPosition.z));
vec2 corner = position.xy * aSize * min(1.0, fxLimit / max(1.0, projected));
vec2 key = (viewMatrix * vec4(fxSun, 0.0)).xy;
vFxLight = mat2(c, -s, s, c) * key;
mvPosition.xy += mat2(c, s, -s, c) * corner;
gl_Position = projectionMatrix * mvPosition;
`,
        );
      if (!additive) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vFxLight;')
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
diffuseColor.rgb *= 0.9 + 0.24 * dot(vFxLight, vMapUv * 2.0 - 1.0);`,
          );
      }
    };
    mat.customProgramCacheKey = () => 'impact-billboard-v1';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    // Default depth sorting plus per-instance smoke attenuation in ImpactDebris.
    this.mesh.renderOrder = 0;
  }

  setView(height: number, limit: number): void {
    this.height.value = height;
    this.limit.value = limit;
  }

  setLighting(direction: THREE.Vector3): void {
    this.sun.value.copy(direction);
  }

  finish(count: number): void {
    this.mesh.geometry.instanceCount = count;
    if (!count) return;
    const center = this.mesh.geometry.boundingSphere!.center;
    center.set(0, 0, 0);
    for (let i = 0; i < count; i++) {
      center.x += this.centers[i * 3]!;
      center.y += this.centers[i * 3 + 1]!;
      center.z += this.centers[i * 3 + 2]!;
    }
    center.multiplyScalar(1 / count);
    for (const key in this.mesh.geometry.attributes) {
      const attr = this.mesh.geometry.attributes[key];
      if (attr instanceof THREE.InstancedBufferAttribute) attr.needsUpdate = true;
    }
  }

  beginWarmUp(): () => void {
    const count = this.mesh.geometry.instanceCount;
    const savedCenter = this.centers.slice(0, 3);
    const savedSize = this.sizes.slice(0, 2);
    const savedColor = this.colors.slice(0, 4);
    this.centers.set([0, -500, 0]);
    this.sizes.set([0.01, 0.01]);
    this.colors.set([1, 0.5, 0.1, 0.5]);
    this.finish(Math.max(1, count));
    return () => {
      this.centers.set(savedCenter);
      this.sizes.set(savedSize);
      this.colors.set(savedColor);
      this.finish(count);
    };
  }
}

function attribute(array: Float32Array, size: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
}

let dust: THREE.DataTexture | undefined;
let glint: THREE.DataTexture | undefined;
function impactTexture(additive: boolean): THREE.DataTexture {
  const cached = additive ? glint : dust;
  if (cached) return cached;
  const size = additive ? 32 : 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const d = Math.hypot(u, v);
      const t = Math.min(1, Math.max(0, (d - 0.12) / 0.88));
      const edge = 1 - t * t * (3 - 2 * t);
      // Smooth low-frequency lobes, rather than a uniform disc or sharp pixel noise.
      const lobe = 0.74 + 0.16 * Math.sin(u * 9 + Math.sin(v * 6)) + 0.1 * Math.cos(v * 11 - u * 4);
      const core = additive ? Math.pow(Math.max(0, 1 - d), 1.4) : edge * lobe;
      const i = (y * size + x) * 4;
      // Dark dense core and lighter scattering rim, with no extra per-pixel texture fetch.
      const shade = additive ? 1 : 0.73 + 0.27 * Math.min(1, d / 0.65);
      data[i] = data[i + 1] = data[i + 2] = Math.round(shade * 255);
      data[i + 3] = Math.round(Math.max(0, core) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  if (additive) glint = tex;
  else dust = tex;
  return tex;
}
