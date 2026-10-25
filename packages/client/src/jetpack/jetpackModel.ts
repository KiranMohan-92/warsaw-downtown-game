import * as THREE from 'three';
import { gltfLoader } from '../render/gltfLoader.ts';
import { withTimeout } from '../render/surfaceTextures.ts';

/**
 * The jetpack (tools/assets/build_jetpack.py → public/models/jetpack/): one mesh, one material
 * (albedo + normal + AO/rough/metal "arm" + emissive), drawn as the pickup and on soldiers' backs.
 *
 * Pack space = the glTF's: origin where the back plate rests on the wearer's back, +Y up, the
 * wearer faces -Z (the pack extends toward +Z). The nozzle exits are anchors (exhaust points -Y).
 */

type V3 = [number, number, number];

export interface JetpackAnchors {
  nozzleL: V3;
  nozzleR: V3;
  top: V3;
}

export interface JetpackModel {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  anchors: JetpackAnchors;
}

/** The build's anchors (jetpack.json); the loader reads the glTF nodes. */
export const JETPACK_ANCHORS: JetpackAnchors = {
  nozzleL: [-0.165, -0.245, 0.095],
  nozzleR: [0.165, -0.245, 0.095],
  top: [0, 0.255, 0.085],
};

const NODE: Record<keyof JetpackAnchors, string> = {
  nozzleL: 'jetpack_nozzle_l',
  nozzleR: 'jetpack_nozzle_r',
  top: 'jetpack_top',
};

export function jetpackAnchors(scene: THREE.Object3D): JetpackAnchors {
  const out = { ...JETPACK_ANCHORS };
  for (const k of Object.keys(NODE) as (keyof JetpackAnchors)[]) {
    const n = scene.getObjectByName(NODE[k]);
    if (n) out[k] = [n.position.x, n.position.y, n.position.z];
  }
  return out;
}

/** Emissive strength of the cyan status lights (the map is the light's colour). */
export const JETPACK_GLOW = 2.2;

export function jetpackMaterial(maps: {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  arm: THREE.Texture;
  emissive: THREE.Texture;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'jetpack',
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.arm,
    metalnessMap: maps.arm,
    roughness: 1,
    metalness: 1,
    emissiveMap: maps.emissive,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: JETPACK_GLOW,
  });
}

/**
 * A stand-in until (or if) the model fails to load: the same silhouette in primitives (housing,
 * two pods, bells), one material, so everything that mounts a pack still works.
 */
export function fallbackJetpack(): JetpackModel {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number): void => {
    g.translate(x, y, z);
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  add(new THREE.BoxGeometry(0.3, 0.44, 0.03), 0, 0, 0.015);
  add(new THREE.BoxGeometry(0.235, 0.37, 0.12), 0, 0.02, 0.085);
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.048, 0.048, 0.3, 16), sx * 0.165, -0.02, 0.095);
    add(new THREE.CylinderGeometry(0.04, 0.061, 0.075, 16, 1, true), sx * 0.165, -0.21, 0.095);
  }
  const merged = mergeSimple(parts);
  const material = new THREE.MeshStandardMaterial({
    name: 'jetpack',
    color: '#3a3f45',
    roughness: 0.5,
    metalness: 0.6,
    emissive: new THREE.Color('#40e0ff'),
    emissiveIntensity: 0.05,
  });
  return { geometry: merged, material, anchors: { ...JETPACK_ANCHORS } };
}

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const g of parts) {
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nrm.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

/** Load the jetpack (geometry + 1k textures, 512 px on Low), uploaded before warm-up. */
export async function loadJetpackModel(
  renderer: THREE.WebGLRenderer | null,
  opts: { lowRes?: boolean; base?: string; timeoutMs?: number } = {},
): Promise<JetpackModel> {
  const base = `${opts.base ?? import.meta.env.BASE_URL}models/jetpack/`;
  const suffix = opts.lowRes ? '_low' : '';
  const tex = new THREE.TextureLoader();
  const aniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  const load = async (name: string, srgb: boolean): Promise<THREE.Texture> => {
    const t = await tex.loadAsync(`${base}jetpack_${name}${suffix}.webp`);
    t.flipY = false; // glTF uv convention
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    renderer?.initTexture(t);
    return t;
  };
  const work = Promise.all([
    gltfLoader().loadAsync(`${base}jetpack.gltf`),
    load('albedo', true),
    load('normal', false),
    load('arm', false),
    load('emissive', true),
  ]).then(([gltf, map, normalMap, arm, emissive]) => {
    let geometry: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((o) => {
      if (!geometry && o instanceof THREE.Mesh && o.name === 'jetpack')
        geometry = o.geometry as THREE.BufferGeometry;
    });
    if (!geometry) throw new Error('jetpack: no mesh');
    return {
      geometry,
      material: jetpackMaterial({ map, normalMap, arm, emissive }),
      anchors: jetpackAnchors(gltf.scene),
    } satisfies JetpackModel;
  });
  return withTimeout(work, opts.timeoutMs ?? 15_000, 'jetpack model');
}
