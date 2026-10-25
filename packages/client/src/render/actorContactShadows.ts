import * as THREE from 'three';

export interface ActorShadowHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * Synchronous support query for actor contact shadows. The layer passes a reusable origin above
 * the actor feet and reusable output vectors; return null for no support, or the downward ray
 * distance when support was written.
 */
export type ActorGroundProbe = (
  origin: THREE.Vector3,
  outPoint: THREE.Vector3,
  outNormal: THREE.Vector3,
) => number | null;

export interface ActorContactShadowOptions {
  capacity?: number;
  radius?: number;
  fadeInNear?: number;
  fadeInFar?: number;
  maxDistance?: number;
  maxGroundGap?: number;
  minNormalY?: number;
  opacity?: number;
}

const DEFAULT_CAPACITY = 64;
const DEFAULT_RADIUS = 0.3;
const DEFAULT_FADE_IN_NEAR = 32;
const DEFAULT_FADE_IN_FAR = 48;
const DEFAULT_MAX_DISTANCE = 180;
const DEFAULT_MAX_GROUND_GAP = 0.25;
const DEFAULT_MIN_NORMAL_Y = 0.65;
const DEFAULT_OPACITY = 0.42;
const PROBE_LIFT = 0.8;
const SURFACE_LIFT = 0.012;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * One pooled draw of soft actor contact shadows for distant grounded actors. It is presentation
 * only: callers provide actor feet positions and an injected ground probe backed by their world.
 */
export class ActorContactShadows {
  readonly mesh: THREE.InstancedMesh;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly capacity: number;
  private readonly radius: number;
  private readonly fadeInNear: number;
  private readonly fadeInFar: number;
  private readonly maxDistance: number;
  private readonly maxGroundGap: number;
  private readonly minNormalY: number;
  private readonly opacity: number;
  private camera: THREE.Camera | null = null;
  private enabled = false;
  private count = 0;
  private readonly origin = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly place = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();

  constructor(
    private readonly probe: ActorGroundProbe,
    opts: ActorContactShadowOptions = {},
  ) {
    const requestedCapacity = finiteOr(opts.capacity, DEFAULT_CAPACITY);
    this.capacity = Math.max(0, Math.min(DEFAULT_CAPACITY, Math.floor(requestedCapacity)));
    this.radius = finiteOr(opts.radius, DEFAULT_RADIUS);
    this.fadeInNear = finiteOr(opts.fadeInNear, DEFAULT_FADE_IN_NEAR);
    this.fadeInFar = finiteOr(opts.fadeInFar, DEFAULT_FADE_IN_FAR);
    this.maxDistance = finiteOr(opts.maxDistance, DEFAULT_MAX_DISTANCE);
    this.maxGroundGap = finiteOr(opts.maxGroundGap, DEFAULT_MAX_GROUND_GAP);
    this.minNormalY = finiteOr(opts.minNormalY, DEFAULT_MIN_NORMAL_Y);
    this.opacity = finiteOr(opts.opacity, DEFAULT_OPACITY);

    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.name = 'fx:actor-contact-shadow-geo';
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instanceAlpha', this.alpha);
    const mat = contactShadowMaterial(this.opacity);
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.name = 'fx:actor-contact-shadows';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  begin(camera: THREE.Camera, enabled: boolean): void {
    this.camera = camera;
    this.enabled = enabled;
    this.count = 0;
    this.mesh.count = 0;
  }

  add(pos: THREE.Vector3 | { x: number; y: number; z: number }, grounded = true): void {
    if (!this.enabled || !grounded || !this.camera || this.count >= this.capacity) return;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;

    const dx = pos.x - this.camera.position.x;
    const dy = pos.y - this.camera.position.y;
    const dz = pos.z - this.camera.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const fade = this.distanceFade(dist);
    if (fade <= 0) return;

    this.origin.set(pos.x, pos.y + PROBE_LIFT, pos.z);
    const support = this.probe(this.origin, this.hit, this.normal);
    if (support === null || !Number.isFinite(support)) return;
    if (!isFiniteVec(this.hit) || !isFiniteVec(this.normal)) return;
    if (this.normal.lengthSq() < 1e-8) return;
    this.normal.normalize();
    if (this.normal.y < this.minNormalY) return;

    const gap = Math.abs(pos.y - this.hit.y);
    if (gap > this.maxGroundGap) return;

    const i = this.count++;
    this.place.copy(this.hit).addScaledVector(this.normal, SURFACE_LIFT);
    this.quat.setFromUnitVectors(Z_AXIS, this.normal);
    const diameter = this.radius * 2;
    this.scale.set(diameter, diameter, 1);
    this.matrix.compose(this.place, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
    this.alpha.setX(i, fade);
  }

  end(): void {
    this.mesh.count = this.count;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alpha.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const mat = this.mesh.material;
    if (Array.isArray(mat)) for (const m of mat) disposeMaterial(m);
    else disposeMaterial(mat);
  }

  get visibleCount(): number {
    return this.count;
  }

  private distanceFade(dist: number): number {
    if (!Number.isFinite(dist) || dist >= this.maxDistance) return 0;
    const near = smoothstep(this.fadeInNear, this.fadeInFar, dist);
    const far = 1 - smoothstep(this.maxDistance - 18, this.maxDistance, dist);
    return near * far;
  }
}

function contactShadowMaterial(opacity: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    name: 'fx:actor-contact-shadow',
    color: 0x000000,
    map: createContactShadowTexture(),
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
attribute float instanceAlpha;
varying float vInstanceAlpha;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vInstanceAlpha = instanceAlpha;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying float vInstanceAlpha;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
diffuseColor.a *= vInstanceAlpha;`,
    );
  };
  mat.customProgramCacheKey = () => 'actorContactShadowAlpha';
  return mat;
}

function createContactShadowTexture(): THREE.Texture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = u * 2 - 1;
      const dy = v * 2 - 1;
      const d = Math.hypot(dx, dy);
      const a = d >= 1 ? 0 : Math.pow(1 - d * d, 2.2);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function disposeMaterial(mat: THREE.Material): void {
  const map = (mat as THREE.MeshBasicMaterial).map;
  mat.dispose();
  map?.dispose();
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function isFiniteVec(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
