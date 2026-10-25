/**
 * Generated hero models (Kiran-approved Higgsfield/Tripo assets, built by
 * tools/assets/build_heroes.py): the burnt-out sedan, the food-truck van and the street kiosk.
 * Each `MapBox.hero` box is the model's solid body (its collision, shared maps/props.ts
 * `HERO_BODY`); the model draws over it at 1:1, thin overhangs (awning, mirrors) visual only.
 * One instanced draw per model per chunk, own 1k textures (512 px on Low), identical geometry on
 * every tier. If loading fails, the boxes themselves are drawn (same silhouette as collision).
 */
import * as THREE from 'three';
import { quatFromEulerDeg, type HeroId, type MapBox, type MapDefinition } from '@wd/shared';
import { addWetness } from './materials.ts';
import { withTimeout } from './surfaceTextures.ts';
import { gltfLoader } from './gltfLoader.ts';

/** Heroes over one body box (models/heroes/, Higgsfield). */
export const BODY_HERO_IDS = ['burnt_car', 'food_truck', 'kiosk'] as const;
/** Re-baked CC BY wrecks (models/vehicles/, tools/assets/package_vehicles.py), at an anchor box. */
export const WRECK_HERO_IDS = ['heli_wreck', 'armoured_wreck', 'tank_wreck'] as const;
export const HERO_IDS: readonly HeroId[] = [...BODY_HERO_IDS, ...WRECK_HERO_IDS];
const HERO_DIR: Partial<Record<HeroId, string>> = {
  heli_wreck: 'vehicles',
  armoured_wreck: 'vehicles',
  tank_wreck: 'vehicles',
};
export const HERO_TIMEOUT_MS = 15_000;
const CHUNK = 64;

export interface HeroModel {
  geometry: THREE.BufferGeometry;
  /** Far LOD (same frame, uvs and material): past `HERO_LOD_DISTANCE`, every tier alike. */
  far: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

/** Near mesh (and shadow casting) within this distance of a batch; far mesh beyond. */
export const HERO_LOD_DISTANCE = 40;
const HERO_LOD_HYSTERESIS = 6;
export type HeroModels = ReadonlyMap<HeroId, HeroModel>;

/** Distance-only detail budget on every tier; projection cannot extend geometry or casters. */
export function heroNeedsDetail(
  distance: number,
  _height: number,
  _pixelsPerRadian: number,
  wasDetailed: boolean,
): boolean {
  return distance <= HERO_LOD_DISTANCE + (wasDetailed ? HERO_LOD_HYSTERESIS : 0);
}

/** Simplification may remove the lowest wheel/base vertices; align only proven body-model LOD drift. */
export function alignHeroLodGround(
  id: string,
  near: THREE.BufferGeometry,
  far: THREE.BufferGeometry,
): void {
  if (!(BODY_HERO_IDS as readonly string[]).includes(id) || near === far) return;
  for (const geo of [near, far]) {
    const position = geo.getAttribute('position');
    if (!position?.count) throw new Error(`hero ${id}: missing ground bounds`);
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    if (![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
      throw new Error(`hero ${id}: invalid ground bounds`);
  }
  const offset = near.boundingBox!.min.y - far.boundingBox!.min.y;
  if (Math.abs(offset) > 0.05) throw new Error(`hero ${id}: LOD ground drift exceeds 5 cm`);
  if (Math.abs(offset) > 1e-7) {
    // BufferGeometry.translate also re-normalizes packed normals; move positions alone.
    const position = far.getAttribute('position');
    for (let i = 0; i < position.count; i++) position.setY(i, position.getY(i) + offset);
    position.needsUpdate = true;
    far.computeBoundingBox();
  }
  far.computeBoundingSphere();
}

async function heroGeometry(url: string): Promise<THREE.BufferGeometry> {
  const loader = gltfLoader();
  const gltf = await loader.loadAsync(url);
  let geo: THREE.BufferGeometry | null = null;
  gltf.scene.traverse((o) => {
    if (!geo && o instanceof THREE.Mesh) geo = (o.geometry as THREE.BufferGeometry).clone();
  });
  if (!geo) throw new Error(`hero ${url}: no mesh`);
  (gltf.scene.children[0] as THREE.Mesh | undefined)?.geometry?.dispose();
  return geo;
}

/** Load every hero (geometry + textures, uploaded now so nothing uploads in play). */
export async function loadHeroModels(
  renderer: THREE.WebGLRenderer | null,
  opts: { lowRes?: boolean; base?: string; timeoutMs?: number } = {},
): Promise<HeroModels> {
  const work = Promise.all(HERO_IDS.map((id) => loadHeroModel(renderer, id, opts)));
  return new Map(await withTimeout(work, opts.timeoutMs ?? HERO_TIMEOUT_MS, 'hero models'));
}

/** One hero-built model by id (map heroes, or props like the medkit): geometry + textures. */
export async function loadHeroModel<Id extends string>(
  renderer: THREE.WebGLRenderer | null,
  id: Id,
  opts: { lowRes?: boolean; base?: string; timeoutMs?: number } = {},
): Promise<readonly [Id, HeroModel]> {
  const base = `${opts.base ?? import.meta.env.BASE_URL}models/${HERO_DIR[id as HeroId] ?? 'heroes'}/`;
  const suffix = opts.lowRes ? '_low' : '';
  const tex = new THREE.TextureLoader();
  const aniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  const setup = (t: THREE.Texture, srgb: boolean): THREE.Texture => {
    t.flipY = false; // glTF uv convention
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    t.needsUpdate = true;
    renderer?.initTexture(t);
    return t;
  };
  // Bounded (a stalled server must not hold startup); on timeout nothing is uploaded later.
  const [geometry, far, albedo, normal, arm] = await withTimeout(
    Promise.all([
      heroGeometry(`${base}${id}.gltf`),
      heroGeometry(`${base}${id}_far.gltf`),
      tex.loadAsync(`${base}${id}_albedo${suffix}.webp`),
      tex.loadAsync(`${base}${id}_normal${suffix}.webp`),
      tex.loadAsync(`${base}${id}_arm${suffix}.webp`),
    ]),
    opts.timeoutMs ?? HERO_TIMEOUT_MS,
    `hero ${id}`,
  );
  try {
    alignHeroLodGround(id, geometry, far);
  } catch (error) {
    geometry.dispose();
    if (far !== geometry) far.dispose();
    for (const texture of [albedo, normal, arm]) texture.dispose();
    throw error;
  }
  const armTex = setup(arm, false);
  const material = new THREE.MeshStandardMaterial({
    name: `hero:${id}`,
    map: setup(albedo, true),
    normalMap: setup(normal, false),
    roughnessMap: armTex, // G
    metalnessMap: armTex, // B
    roughness: 1,
    metalness: 1,
  });
  addWetness(material);
  return [id, { geometry, far, material }] as const;
}

/** The world transform of a hero instance: the bottom centre of its body box, the box's yaw. */
export function heroMatrix(b: MapBox, out = new THREE.Matrix4()): THREE.Matrix4 {
  const r = quatFromEulerDeg(b.rot);
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const down = new THREE.Vector3(0, -b.size.y / 2, 0).applyQuaternion(q);
  const p = new THREE.Vector3(b.center.x, b.center.y, b.center.z).add(down);
  return out.compose(p, q, new THREE.Vector3(1, 1, 1));
}

const _eye = new THREE.Vector3();
/** Per frame: near/far mesh and shadow casting per batch by distance (same on every tier). */
export function updateHeroes(
  group: THREE.Object3D,
  eye: THREE.Vector3,
  _pixelsPerRadian = 0,
): void {
  _eye.copy(eye);
  for (const o of group.children) {
    const lod = o.userData.hero as
      { near: THREE.BufferGeometry; far: THREE.BufferGeometry; distant: boolean } | undefined;
    if (!lod || !(o instanceof THREE.InstancedMesh)) continue;
    const distant = !heroNeedsDetail(o.boundingBox!.distanceToPoint(_eye), 0, 0, !lod.distant);
    if (distant === lod.distant) continue;
    lod.distant = distant;
    o.geometry = distant ? lod.far : lod.near;
    o.castShadow = !distant;
  }
}

const chunkOf = (b: MapBox): string =>
  `${Math.floor(b.center.x / CHUNK)},${Math.floor(b.center.z / CHUNK)}`;

/**
 * Hero instances of `map`, one InstancedMesh per model per chunk. With `models` null (load
 * failed) the body boxes are drawn instead, in their tint, with the model's hidden extra
 * colliders (`heroPart`: the wreck's cabin), so what is drawn is what blocks.
 */
export function buildHeroMeshes(map: MapDefinition, models: HeroModels | null): THREE.Group {
  const group = new THREE.Group();
  group.name = 'heroes';
  const buckets = new Map<string, MapBox[]>();
  for (const b of map.boxes) {
    const id = b.hero ?? b.heroPart;
    if (!id || (!b.hero && models?.get(id))) continue;
    const key = `${id}|${chunkOf(b)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), b]);
  }
  const m = new THREE.Matrix4();
  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  for (const [key, list] of buckets) {
    const id = (list[0]!.hero ?? list[0]!.heroPart)!;
    const model = models?.get(id);
    const mesh = model
      ? new THREE.InstancedMesh(model.geometry, model.material, list.length)
      : new THREE.InstancedMesh(
          unitBox,
          new THREE.MeshStandardMaterial({ color: list[0]!.tint ?? 0x777777, roughness: 0.8 }),
          list.length,
        );
    list.forEach((b, i) => {
      heroMatrix(b, m);
      if (!model) m.multiply(new THREE.Matrix4().makeScale(b.size.x, b.size.y, b.size.z));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = `heroes:${key}`;
    mesh.castShadow = true;
    if (model) mesh.userData.hero = { near: model.geometry, far: model.far, distant: false };
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
