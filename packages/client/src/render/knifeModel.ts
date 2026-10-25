import * as THREE from 'three';
import { gltfLoader } from './gltfLoader.ts';
import { skinArms, type ArmPivots } from './fpRig.ts';
import { withTimeout } from './surfaceTextures.ts';

/**
 * The seax-style combat knife (tools/assets/build_knife.py → public/models/knife/): one mesh, one
 * material (albedo + normal + AO/rough/metal "arm" map, the gun scans' recipe, so it shares their
 * program), drawn as the viewmodel knife, the soldiers' held knife and the sparring partner's.
 *
 * Knife space = the glTF's: grip origin at the centre of the fist, blade along -Z, edge down
 * (-Y), spine up (+Y). The build exports the anchors as empty nodes; the trail runs tip → edge.
 */

type V3 = [number, number, number];

export interface KnifeAnchors {
  /** Blade tip. */
  tip: V3;
  /** A point on the edge toward the guard (the trail ribbon's inner end). */
  edge: V3;
  guard: V3;
  pommel: V3;
}

export interface KnifeModel {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  anchors: KnifeAnchors;
}

/** The anchors the build writes (knife.json); the loader reads the glTF nodes, tests compare. */
export const KNIFE_ANCHORS: KnifeAnchors = {
  tip: [0, -0.006, -0.276],
  edge: [0, -0.0135, -0.156],
  guard: [0, 0, -0.066],
  pommel: [0, 0, 0.0698],
};

const NODE: Record<keyof KnifeAnchors, string> = {
  tip: 'knife_tip',
  edge: 'knife_edge',
  guard: 'knife_guard',
  pommel: 'knife_pommel',
};

/** Read the anchor nodes of a loaded knife scene (falls back to the build's constants). */
export function knifeAnchors(scene: THREE.Object3D): KnifeAnchors {
  const out = { ...KNIFE_ANCHORS };
  for (const k of Object.keys(NODE) as (keyof KnifeAnchors)[]) {
    const n = scene.getObjectByName(NODE[k]);
    if (n) out[k] = [n.position.x, n.position.y, n.position.z];
  }
  return out;
}

/** The knife material (same maps and flags as a gun scan's: no new program). */
export function knifeMaterial(maps: {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  arm: THREE.Texture;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'knife',
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.arm,
    metalnessMap: maps.arm,
    roughness: 1,
    metalness: 1,
  });
}

/** Load the knife (geometry + 1k textures, 512 px on Low), uploaded before warm-up. */
export async function loadKnifeModel(
  renderer: THREE.WebGLRenderer | null,
  opts: { lowRes?: boolean; base?: string; timeoutMs?: number } = {},
): Promise<KnifeModel> {
  const base = `${opts.base ?? import.meta.env.BASE_URL}models/knife/`;
  const suffix = opts.lowRes ? '_low' : '';
  const tex = new THREE.TextureLoader();
  const aniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  const load = async (name: string, srgb: boolean): Promise<THREE.Texture> => {
    const t = await tex.loadAsync(`${base}knife_${name}${suffix}.webp`);
    t.flipY = false; // glTF uv convention
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    renderer?.initTexture(t);
    return t;
  };
  const work = Promise.all([
    gltfLoader().loadAsync(`${base}knife.gltf`),
    load('albedo', true),
    load('normal', false),
    load('arm', false),
  ]).then(([gltf, map, normalMap, arm]) => {
    let geometry: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((o) => {
      if (!geometry && o instanceof THREE.Mesh && o.name === 'knife')
        geometry = o.geometry as THREE.BufferGeometry;
    });
    if (!geometry) throw new Error('knife: no mesh');
    return {
      geometry,
      material: knifeMaterial({ map, normalMap, arm }),
      anchors: knifeAnchors(gltf.scene),
    } satisfies KnifeModel;
  });
  return withTimeout(work, opts.timeoutMs ?? 15_000, 'knife model');
}

/** The first-person arms posed on the knife (build_fparms.py `knife`: forward hammer grip, left
 * fist raised in a guard), skinned at load like the guns' arms. */
export interface KnifeArms {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  pivots: ArmPivots;
}

/**
 * Load the knife pose of the first-person arms (models/arms/knife.gltf + its pivots in
 * arms.json), sharing the guns' arms material (same program, same lamp-volume patch).
 */
export async function loadKnifeArms(
  material: THREE.Material,
  opts: { base?: string; timeoutMs?: number } = {},
): Promise<KnifeArms> {
  const base = `${opts.base ?? import.meta.env.BASE_URL}models/arms/`;
  const work = Promise.all([
    fetch(`${base}arms.json`).then(
      (r) => r.json() as Promise<{ poses: Record<string, { bones?: ArmPivots } | undefined> }>,
    ),
    gltfLoader().loadAsync(`${base}knife.gltf`),
  ]).then(([manifest, gltf]) => {
    const pivots = manifest.poses.knife?.bones;
    if (!pivots) throw new Error('arms: no knife pose');
    let geometry: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((o) => {
      if (!geometry && o instanceof THREE.Mesh) geometry = o.geometry as THREE.BufferGeometry;
    });
    if (!geometry) throw new Error('arms knife: no mesh');
    skinArms(geometry, pivots);
    return { geometry, material, pivots } satisfies KnifeArms;
  });
  return withTimeout(work, opts.timeoutMs ?? 15_000, 'knife arms');
}
