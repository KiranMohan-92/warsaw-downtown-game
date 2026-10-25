/**
 * CC0 props, loaded/uploaded before Game.warmUp. One atlas/material, one instanced draw per
 * model per spatial chunk, on every WebGL2 browser (no multi-draw extension required).
 * Shared generated surfaces keep physics and the offline grey fallback aligned with the scans.
 */
import * as THREE from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import {
  PROP_GEOMETRY,
  PROP_GEOMETRY_HASH,
  type MapDefinition,
  type PropPose,
  type Vec3,
} from '@wd/shared';
import { PROP_GREYBOX } from './mapMesh.ts';
import { addWetness } from './materials.ts';
import { withTimeout } from './surfaceTextures.ts';
import {
  fitBox,
  fitDecor,
  PROP_MODEL_IDS,
  type ModelSizes,
  type PropInstance,
  type PropModelId,
} from './propFit.ts';
import { gltfLoader } from './gltfLoader.ts';

/** How long `Game.create` waits for models before using the untextured fallback surfaces. */
export const PROP_MODELS_TIMEOUT_MS = 15_000;
/** These meshes define shootable slats and cover edges; retain their exact colour geometry. */
export const EXACT_PROP_COVER: ReadonlySet<PropModelId> = new Set([
  'crate',
  'crate_small',
  'jersey',
]);

export interface PropModels {
  geometries: ReadonlyMap<PropModelId, THREE.BufferGeometry>;
  farGeometries: ReadonlyMap<PropModelId, THREE.BufferGeometry>;
  sizes: ModelSizes;
  material: THREE.MeshStandardMaterial;
}

export interface PropLoadOptions {
  /** Low tier: the half-size atlas (what the greybox's procedural maps cost). */
  lowRes?: boolean;
  base?: string;
  timeoutMs?: number;
  /** Test hooks (default: GLTFLoader / TextureLoader over fetch). */
  loadGeometry?: (url: string) => Promise<THREE.BufferGeometry>;
  loadTexture?: (url: string) => Promise<THREE.Texture>;
}

/** The glTFs' own materials are never used (they would each fetch the atlas again). */
const SKIP_MATERIALS = new THREE.MeshBasicMaterial();

function assetManager(): THREE.LoadingManager {
  return new THREE.LoadingManager().setURLModifier(
    (url) => `${url}${url.includes('?') ? '&' : '?'}v=${PROP_GEOMETRY_HASH}`,
  );
}

/** Reject stale/mismatched assets even when their bounding boxes happen to agree. */
export function validatePropGeometry(id: PropModelId, geo: THREE.BufferGeometry): void {
  const expected = PROP_GEOMETRY[id];
  const position = geo.getAttribute('position');
  const index = geo.getIndex();
  if (!position || !index || index.count !== expected.indices.length)
    throw new Error(`prop model ${id}: collision geometry mismatch`);
  for (let i = 0; i < index.count; i++) {
    const vertex = index.getX(i);
    const p = expected.positions[expected.indices[i]!]!;
    const actual = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
    if (actual.some((v, k) => !Number.isFinite(v) || Math.abs(v - p[k]!) > 0.000002))
      throw new Error(`prop model ${id}: collision geometry mismatch`);
  }
}

async function gltfGeometry(url: string, id: PropModelId): Promise<THREE.BufferGeometry> {
  const loader = gltfLoader(assetManager());
  loader.register(() => ({
    name: 'wd_shared_atlas',
    loadMaterial: () => Promise.resolve(SKIP_MATERIALS),
  }));
  const gltf = await loader.loadAsync(url);
  let geo: THREE.BufferGeometry | null = null;
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (!geo) geo = o.geometry as THREE.BufferGeometry;
      else if (o.geometry !== geo) (o.geometry as THREE.BufferGeometry).dispose();
    }
  });
  if (!geo) throw new Error(`${url}: no mesh`);
  try {
    validatePropGeometry(id, geo);
  } catch (error) {
    (geo as THREE.BufferGeometry).dispose();
    throw error;
  }
  return geo;
}

/** Every prop model's bounding size, measured from its geometry (base at y = 0). */
export function measureSizes(
  geometries: ReadonlyMap<PropModelId, THREE.BufferGeometry>,
): ModelSizes {
  const out = {} as Record<PropModelId, { x: number; y: number; z: number }>;
  for (const id of PROP_MODEL_IDS) {
    const g = geometries.get(id);
    if (!g) throw new Error(`prop model ${id} missing`);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const size = { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
    if (
      Object.values(size).some((n) => !Number.isFinite(n) || n <= 0) ||
      Math.abs(b.min.y) > 0.001 ||
      Math.abs(b.min.x + b.max.x) > 0.001 ||
      Math.abs(b.min.z + b.max.z) > 0.001
    )
      throw new Error(`prop model ${id}: invalid bounds/origin`);
    out[id] = size;
  }
  return out;
}

/**
 * Load every prop model and the atlas; all or nothing (a partial set would mix models and
 * greybox for the same kind of cover). `renderer` uploads the atlas now, so nothing uploads in
 * play. Rejects on any failure or after `timeoutMs`.
 */
export async function loadPropModels(
  renderer: THREE.WebGLRenderer | null,
  opts: PropLoadOptions = {},
): Promise<PropModels> {
  const base = opts.base ?? import.meta.env.BASE_URL;
  const loadGeometry = (url: string, id: PropModelId): Promise<THREE.BufferGeometry> =>
    opts.loadGeometry ? opts.loadGeometry(url) : gltfGeometry(url, id);
  const texLoader = new THREE.TextureLoader(assetManager());
  const loadTexture = opts.loadTexture ?? ((url: string) => texLoader.loadAsync(url));
  const suffix = opts.lowRes ? '_low' : '';
  const resources: (THREE.BufferGeometry | THREE.Texture)[] = [];
  let failed = false;
  const track = async <T extends THREE.BufferGeometry | THREE.Texture>(
    work: Promise<T>,
  ): Promise<T> => {
    const resource = await work;
    if (failed) resource.dispose();
    else resources.push(resource);
    return resource;
  };
  try {
    const work = Promise.all([
      Promise.all(
        PROP_MODEL_IDS.map(
          async (id) =>
            [id, await track(loadGeometry(`${base}models/${id}/${id}.gltf`, id))] as const,
        ),
      ),
      Promise.all(
        (['albedo', 'normal', 'arm'] as const).map((m) =>
          track(loadTexture(`${base}models/atlas_${m}${suffix}.webp`)),
        ),
      ),
    ]).then(async ([geos, maps]) => {
      const geometries = new Map<PropModelId, THREE.BufferGeometry>(geos);
      for (const [id, g] of geometries) {
        for (const a of ['position', 'normal', 'uv']) {
          if (!g.getAttribute(a)) throw new Error(`prop model ${id}: no ${a}`);
        }
        if (!g.getIndex()) throw new Error(`prop model ${id}: not indexed`);
      }
      const sizes = measureSizes(geometries);
      // Three ships the simplifier and WASM. Include readiness and all work in the load deadline.
      const simplify = new SimplifyModifier();
      const farGeometries = new Map<PropModelId, THREE.BufferGeometry>();
      for (const [id, geometry] of geometries) {
        if (failed) throw new Error('prop model preparation expired');
        const far = EXACT_PROP_COVER.has(id)
          ? geometry
          : await track(
              simplify.modify(geometry, Math.floor(geometry.getAttribute('position').count * 0.8)),
            );
        farGeometries.set(id, far);
      }
      return { geometries, sizes, farGeometries, maps };
    });
    const {
      geometries,
      sizes,
      farGeometries,
      maps: [albedo, normal, arm],
    } = await withTimeout(work, opts.timeoutMs ?? PROP_MODELS_TIMEOUT_MS, 'prop models');
    const maxAniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
    const setup = (t: THREE.Texture, srgb: boolean): THREE.Texture => {
      t.flipY = false; // glTF uv convention (v down from the image top)
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = maxAniso;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      renderer?.initTexture(t);
      return t;
    };
    const armTex = setup(arm!, false);
    const material = new THREE.MeshStandardMaterial({
      name: 'props',
      map: setup(albedo!, true),
      normalMap: setup(normal!, false),
      roughnessMap: armTex, // G
      metalnessMap: armTex, // B
      roughness: 1,
      metalness: 1,
      // The scans are authored double-sided (open crates, thin lids, bin rims).
      side: THREE.DoubleSide,
    });
    addWetness(material);
    return { geometries, farGeometries, sizes, material };
  } catch (error) {
    failed = true;
    for (const resource of resources) resource.dispose();
    throw error;
  }
}

/** Every model instance on `map`: its tagged boxes, then its decor. */
export function propInstances(map: MapDefinition, sizes: ModelSizes): PropInstance[] {
  return propEntries(map, sizes).map((e) => e.inst);
}

/**
 * `propInstances` with each one's physics prop id (`PhysicsWorld`, `mapPropInstances` order:
 * the same instances minus the boxes that don't collide), null for a drawn-only one.
 */
export function propEntries(
  map: MapDefinition,
  sizes: ModelSizes,
): { inst: PropInstance; id: number | null }[] {
  const out: { inst: PropInstance; id: number | null }[] = [];
  let next = 0;
  for (const b of map.boxes) {
    if (!b.model || b.visible === false) continue;
    for (const inst of fitBox(b, sizes))
      out.push({ inst, id: b.collide !== false ? next++ : null });
  }
  for (const d of map.decor ?? [])
    for (const inst of fitDecor(d, sizes)) out.push({ inst, id: next++ });
  return out;
}

/** Street-scale batches let both the view and shadow frusta reject offscreen props. */
export const PROP_CHUNK_SIZE = 32;
/** Distance to the nearest point of a batch, so a nearby prop always keeps its full mesh. */
export const PROP_LOD_DISTANCE = 45;
export const PROP_LOD_HYSTERESIS = 6;
/** Distance-only detail budget on every tier; projection cannot extend geometry or casters. */
export function propNeedsDetail(
  distance: number,
  _height: number,
  _pixelsPerRadian: number,
  wasDetailed: boolean,
): boolean {
  return distance <= PROP_LOD_DISTANCE + (wasDetailed ? PROP_LOD_HYSTERESIS : 0);
}

interface PropBatch {
  mesh: THREE.InstancedMesh;
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  shadow: boolean;
  distant: boolean;
}

/** Where one physics prop is drawn: its batch slot, and its shadow proxy's (exact cover). */
interface PropSlot {
  mesh: THREE.InstancedMesh;
  slot: number;
  shadow?: { mesh: THREE.InstancedMesh; slot: number; size: Vec3 };
  home: PropInstance;
}

const poseMatrix = new THREE.Matrix4();
const poseP = new THREE.Vector3();
const poseQ = new THREE.Quaternion();
const poseS = new THREE.Vector3();

/**
 * Switching geometry never changes shader attributes or materials. Props a truck moved are
 * redrawn in their own slots (`setPose`): same meshes, same programs, bounds refitted.
 */
export class PropDetail extends THREE.Group {
  private readonly eye = new THREE.Vector3();
  /** Props drawn away from home (moved, tumbling or hidden). */
  private readonly moved = new Set<number>();
  /** Meshes whose instances moved this frame: bounds are refitted in `update`. */
  private readonly refit = new Set<THREE.InstancedMesh>();
  constructor(
    private readonly batches: readonly PropBatch[],
    private readonly shadows: readonly THREE.InstancedMesh[],
    private readonly slots: ReadonlyMap<number, PropSlot> = new Map(),
  ) {
    super();
    this.name = 'props';
    for (const { mesh } of batches) this.add(mesh);
    for (const mesh of shadows) this.add(mesh);
  }

  /** Draw physics prop `id` at `pose` (null: hidden, smashed). */
  setPose(id: number, pose: PropPose | null): void {
    const s = this.slots.get(id);
    if (!s) return;
    this.moved.add(id);
    const scale = s.home.scale;
    if (pose) poseMatrix.compose(poseP.copy(pose.pos), poseQ.copy(pose.quat), poseS.copy(scale));
    else poseMatrix.makeScale(0, 0, 0);
    s.mesh.setMatrixAt(s.slot, poseMatrix);
    s.mesh.instanceMatrix.needsUpdate = true;
    this.refit.add(s.mesh);
    const sh = s.shadow;
    if (!sh) return;
    if (pose)
      poseMatrix.compose(
        poseP.copy(pose.pos),
        poseQ.copy(pose.quat),
        poseS.set(sh.size.x * scale.x, sh.size.y * scale.y, sh.size.z * scale.z),
      );
    sh.mesh.setMatrixAt(sh.slot, poseMatrix);
    sh.mesh.instanceMatrix.needsUpdate = true;
    this.refit.add(sh.mesh);
  }

  /** Every prop back where the map put it (a new match). */
  resetPoses(): void {
    for (const id of this.moved) {
      const home = this.slots.get(id)?.home;
      if (home) this.setPose(id, home);
    }
    this.moved.clear();
  }

  update(camera: { x: number; y: number; z: number }, _pixelsPerRadian = 0): void {
    for (const mesh of this.refit) {
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    }
    this.refit.clear();
    this.eye.copy(camera);
    for (const batch of this.batches) {
      const distant = !propNeedsDetail(
        batch.mesh.boundingBox!.distanceToPoint(this.eye),
        0,
        0,
        !batch.distant,
      );
      if (distant === batch.distant) continue;
      batch.distant = distant;
      batch.mesh.geometry = distant ? batch.far : batch.near;
      batch.mesh.castShadow = batch.shadow && !distant;
    }
    for (const mesh of this.shadows) {
      mesh.visible = propNeedsDetail(
        mesh.boundingBox!.distanceToPoint(this.eye),
        0,
        0,
        mesh.visible,
      );
    }
  }

  /** compileAsync does not discover custom depth materials; warm the new proxy variant explicitly. */
  async warmUp(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    scene: THREE.Scene,
  ): Promise<void> {
    const shadow = this.shadows[0];
    if (!shadow) return;
    const proxy = new THREE.InstancedMesh(shadow.geometry, shadow.customDepthMaterial, 1);
    const root = new THREE.Group();
    root.add(proxy);
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const level = renderer.getActiveMipmapLevel();
    const toneMapping = renderer.toneMapping;
    const depthTarget = new THREE.WebGLRenderTarget(1, 1);
    try {
      renderer.setRenderTarget(depthTarget);
      renderer.toneMapping = THREE.NoToneMapping;
      await renderer.compileAsync(root, camera, scene);
    } finally {
      renderer.setRenderTarget(target, face, level);
      renderer.toneMapping = toneMapping;
      depthTarget.dispose();
      proxy.dispose();
    }
  }
}

export function buildPropMeshes(map: MapDefinition, models: PropModels): PropDetail | null {
  const entries = propEntries(map, models.sizes);
  if (!entries.length) return null;
  const idOf = new Map(entries.map((e) => [e.inst, e.id]));
  const slots = new Map<number, PropSlot>();
  const buckets = new Map<string, PropInstance[]>();
  const shadowBuckets = new Map<string, PropInstance[]>();
  for (const { inst } of entries) {
    const chunk = `${Math.floor((inst.pos.x - map.bounds.minX) / PROP_CHUNK_SIZE)}:${Math.floor((inst.pos.z - map.bounds.minZ) / PROP_CHUNK_SIZE)}`;
    const key = `${inst.model}:${chunk}`;
    const list = buckets.get(key) ?? [];
    list.push(inst);
    buckets.set(key, list);
    if (EXACT_PROP_COVER.has(inst.model)) {
      const casters = shadowBuckets.get(chunk) ?? [];
      casters.push(inst);
      shadowBuckets.set(chunk, casters);
    }
  }
  const batches: PropBatch[] = [];
  const matrix = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  for (const [key, batch] of buckets) {
    const id = batch[0]!.model;
    const near = models.geometries.get(id)!;
    const mesh = new THREE.InstancedMesh(near, models.material, batch.length);
    mesh.name = `props:${key}`;
    batch.forEach((inst, slot) => {
      matrix.compose(p.copy(inst.pos), q.copy(inst.quat), s.copy(inst.scale));
      mesh.setMatrixAt(slot, matrix);
      const pid = idOf.get(inst);
      if (pid !== null && pid !== undefined) slots.set(pid, { mesh, slot, home: inst });
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Tiny dressing contributes little to the shadow silhouette; larger cover still casts.
    const shadow = !EXACT_PROP_COVER.has(id) && !['trashbag', 'tyre', 'cardboard_box'].includes(id);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    batches.push({
      mesh,
      near,
      far: models.farGeometries.get(id)!,
      shadow,
      distant: false,
    });
  }
  // Opaque box proxies approximate sub-texel slat shadows, while visible/shot surfaces remain
  // exact. One batch per block combines both crate shapes and barriers. Invisible colour-pass
  // submissions cost just 12 triangles per instance; geometry is also frustum culled there.
  const shadows: THREE.InstancedMesh[] = [];
  if (shadowBuckets.size) {
    const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const depth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.BackSide,
    });
    for (const [key, batch] of shadowBuckets) {
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      mesh.name = `props:shadow:${key}`;
      batch.forEach((inst, index) => {
        const size = models.sizes[inst.model];
        s.set(size.x * inst.scale.x, size.y * inst.scale.y, size.z * inst.scale.z);
        mesh.setMatrixAt(index, matrix.compose(p.copy(inst.pos), q.copy(inst.quat), s));
        const slot = slots.get(idOf.get(inst) ?? -1);
        if (slot) slot.shadow = { mesh, slot: index, size };
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.customDepthMaterial = depth;
      mesh.matrixAutoUpdate = false;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      shadows.push(mesh);
    }
  }
  return new PropDetail(batches, shadows, slots);
}

/**
 * Swap the map's greybox props for the models (call before warm-up). `models` null (they failed
 * to load) keeps the greybox. Returns the props mesh, if any.
 */
export function installPropModels(
  scene: THREE.Object3D,
  map: MapDefinition,
  models: PropModels | null,
): PropDetail | null {
  if (!models) return null;
  const mesh = buildPropMeshes(map, models);
  if (!mesh) return null;
  scene.add(mesh);
  const greybox: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (o.name === PROP_GREYBOX) greybox.push(o);
  });
  for (const g of greybox) {
    g.removeFromParent();
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
    });
  }
  return mesh;
}
