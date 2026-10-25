/**
 * Realistic trees (EZ-Tree, MIT, baked by tools/assets/bake_trees.mjs): each map tree is one of
 * three species — ash or oak for broadleaf, pine for conifers — chosen from its position, so every
 * client sees the same tree. Near trees (within `TREE_NEAR`) draw their real branches and alpha
 * leaf clusters; farther trees are impostors: one camera-facing card per tree showing the baked
 * view closest to the camera's angle, lit per pixel from the baked world normals (so the far
 * forest takes the sun, sky and shadows of every weather). Identical on every tier: crowns are
 * scenery (they do not conceal in the sight model); trunk collision is the shared cylinder.
 */
import * as THREE from 'three';
import {
  TREE_SPECIES,
  treeSpecies,
  treeWidthRatio,
  type MapDefinition,
  type MapTree,
  type TreeSpecies,
} from '@wd/shared';
import { addWetness } from './materials.ts';
import { withTimeout } from './surfaceTextures.ts';
import { gltfLoader } from './gltfLoader.ts';
import {
  coverageMips,
  coverageWeightsForSize,
  normalMips,
  type TreeMip,
} from './treeTextureMips.ts';
export { coverageMips } from './treeTextureMips.ts';

export const TREE_NEAR = 32;
const TREE_HYSTERESIS = 4;
export const TREE_TIMEOUT_MS = 15_000;

interface SpeciesInfo {
  crown: number;
  frame: { frames: number; size: number; half: number; ambientOcclusion?: boolean };
  bark: string;
  leaf: string;
  barkTint: number;
  leafTint: number;
}

export interface TreeModel {
  info: SpeciesInfo;
  branches: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  bark: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  foliageDepth: THREE.MeshDepthMaterial;
  impostor: THREE.MeshStandardMaterial;
}
export type TreeModels = ReadonlyMap<TreeSpecies, TreeModel>;

const hash = (x: number, z: number, salt: number): number => {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return h - Math.floor(h);
};

/** World transform of a tree: trunk base, random yaw, scaled to its height and crown. */
export function treeMatrix(
  t: MapTree,
  crownUnit: number,
  out = new THREE.Matrix4(),
): THREE.Matrix4 {
  const yaw = hash(t.x, t.z, 12) * Math.PI * 2;
  const sxz = (treeWidthRatio(t, crownUnit) * t.height) / (2 * crownUnit); // = treeHorizontalScale
  return out.compose(
    new THREE.Vector3(t.x, t.y ?? 0, t.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    new THREE.Vector3(sxz, t.height, sxz),
  );
}

// ---- impostor shader ----------------------------------------------------------------------------

const IMPOSTOR_VERTEX_PARS = /* glsl */ `
uniform float uFrames, uHalf;
varying vec2 vAtlasUv;
varying vec3 vTreeX, vTreeZ;
`;
/**
 * Cylindrical billboard: the unit quad (x -0.5..0.5, y 0..1) turns to face the camera around the
 * tree's vertical axis, spans the baked frame (±half around the tree's mid-height, scaled by the
 * instance), and picks the baked view nearest to the camera's direction in the tree's frame.
 */
const IMPOSTOR_VERTEX = /* glsl */ `
vec3 tOrigin = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
vec3 tX = ( modelMatrix * instanceMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz;
vec3 tY = ( modelMatrix * instanceMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
vec3 tZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz;
float sxz = length( tX ), sy = length( tY );
vec3 toCam = cameraPosition - tOrigin;
toCam.y = 0.0;
toCam = normalize( toCam + vec3( 1e-5, 0.0, 0.0 ) );
vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), toCam ) );
// View angle in the tree's own frame (the bake orbits +Z towards +X).
vec3 lx = tX / sxz, lz = tZ / sxz;
float ang = atan( dot( toCam, lx ), dot( toCam, lz ) );
float fr = mod( floor( ang / 6.2831853 * uFrames + 0.5 ), uFrames );
vAtlasUv = vec2( ( fr + position.x + 0.5 ) / uFrames, position.y );
// Baked normals are in the tree's own frame: hand the fragment the tree's axes.
vTreeX = lx;
vTreeZ = lz;
vec3 world = tOrigin + right * ( position.x * 2.0 * uHalf * sxz )
  + vec3( 0.0, ( 0.5 + ( position.y - 0.5 ) * 2.0 * uHalf ) * sy, 0.0 );
vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
gl_Position = projectionMatrix * mvPosition;
`;
/**
 * three's world position (shadow-map coordinates, env map) would come from the unit quad
 * (`transformed`): the billboard's world position replaces it, so received shadows stay put.
 */
const IMPOSTOR_WORLDPOS = /* glsl */ `#include <worldpos_vertex>
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
worldPosition = vec4( world, 1.0 );
#endif
// The wetness hook's shelter lookup must read where the billboard is drawn, not the unit quad.
vWetPos = world;
`;

/** The impostor material (exported for tests). */
export function impostorMaterial(
  color: THREE.Texture,
  normals: THREE.Texture,
  info: SpeciesInfo,
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    name: 'tree:impostor',
    map: color,
    alphaTest: 0.5,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const uniforms = {
    uFrames: { value: info.frame.frames },
    uHalf: { value: info.frame.half },
    uNormals: { value: normals },
    uBakedAO: { value: info.frame.ambientOcclusion ? 1 : 0 },
  };
  // Wetness first: addWetness replaces the hook, so the impostor hook chains after it.
  addWetness(m);
  const wet = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    wet(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMPOSTOR_VERTEX_PARS}`)
      .replace('#include <project_vertex>', IMPOSTOR_VERTEX)
      .replace('#include <worldpos_vertex>', IMPOSTOR_WORLDPOS);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uNormals;
        uniform float uBakedAO;
        varying vec2 vAtlasUv;
        varying vec3 vTreeX, vTreeZ;`,
      )
      .replace('#include <map_fragment>', 'diffuseColor *= texture2D( map, vAtlasUv );')
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        // Baked normal (tree space) → world (the tree's yaw) → view space.
        vec4 treeNormalSample = texture2D( uNormals, vAtlasUv );
        vec3 bn = treeNormalSample.xyz * 2.0 - 1.0;
        vec3 wn = vTreeX * bn.x + vec3( 0.0, bn.y, 0.0 ) + vTreeZ * bn.z;
        normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
        nonPerturbedNormal = normal;`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        // Packed canopy occlusion dims sky/ambient light; direct sun remains dynamic.
        reflectedLight.indirectDiffuse *= mix( 1.0, treeNormalSample.a, uBakedAO );`,
      );
  };
  m.customProgramCacheKey = () => 'wet|treeImpostor|packedAO';
  return m;
}

// ---- camera-occluder fade -----------------------------------------------------------------------

/**
 * The chase camera's line of sight (camera `a` → subject `b`): near tree leaves and branches within
 * `r` of it dither out, so a crown the camera can't frame around (a truck parked under a pine)
 * doesn't fill the view. `r` = 0: off (on foot, first person). Shared by every tree material.
 */
export const treeFade = {
  a: { value: new THREE.Vector3() },
  b: { value: new THREE.Vector3() },
  r: { value: 0 },
};

/** Set (or with `r` 0 clear) the tree fade's line of sight. */
export function setTreeFade(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number): void {
  treeFade.a.value.set(a.x, a.y, a.z);
  treeFade.b.value.set(b.x, b.y, b.z);
  treeFade.r.value = r;
}

const FADE_VERTEX = /* glsl */ `
#include <project_vertex>
#ifdef USE_INSTANCING
  vFadeWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
  vFadeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;
/**
 * Screen-door fade (interleaved gradient noise, no blending or sorting): full near the line,
 * easing out to its edge; spared near the subject, so the tree it stands under still reads.
 */
const FADE_FRAGMENT = /* glsl */ `
#include <clipping_planes_fragment>
if ( uFadeR > 0.0 ) {
  vec3 fadeAB = uFadeB - uFadeA;
  float fadeT = clamp( dot( vFadeWorld - uFadeA, fadeAB ) / max( dot( fadeAB, fadeAB ), 1e-4 ), 0.0, 1.0 );
  float fadeD = length( vFadeWorld - ( uFadeA + fadeAB * fadeT ) );
  float fadeK = ( 1.0 - smoothstep( uFadeR * 0.55, uFadeR, fadeD ) ) * ( 1.0 - smoothstep( 0.8, 1.0, fadeT ) );
  float fadeN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  if ( fadeN < fadeK * 0.92 ) discard;
}
`;

/** Chain the camera-occluder fade onto a near tree material (after its wetness hook). */
export function addTreeFade(m: THREE.MeshStandardMaterial): void {
  const prev = m.onBeforeCompile.bind(m);
  const key = m.customProgramCacheKey();
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uFadeA = treeFade.a;
    shader.uniforms.uFadeB = treeFade.b;
    shader.uniforms.uFadeR = treeFade.r;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFadeWorld;')
      .replace('#include <project_vertex>', FADE_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vFadeWorld;\nuniform vec3 uFadeA, uFadeB;\nuniform float uFadeR;',
      )
      .replace('#include <clipping_planes_fragment>', FADE_FRAGMENT);
  };
  m.customProgramCacheKey = () => `${key}|treeFade`;
}

// ---- coverage-preserving mips ----------------------------------------------------------------

async function readRgba(url: string): Promise<ImageData> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return img;
}

function mipTexture(levels: TreeMip[], flip = true): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    levels[0]!.data,
    levels[0]!.width,
    levels[0]!.height,
    THREE.RGBAFormat,
  );
  tex.mipmaps = levels;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = flip;
  tex.needsUpdate = true;
  return tex;
}

/** Shared leaf maps use the same coverage treatment as the far canopy. */
async function coverageTexture(url: string, flip: boolean): Promise<THREE.DataTexture> {
  const img = await readRgba(url);
  return mipTexture(coverageMips(img.data, img.width, img.height), flip);
}

async function impostorTextures(
  base: string,
  id: TreeSpecies,
  frames: number,
  ambientOcclusion = false,
): Promise<[THREE.DataTexture, THREE.DataTexture]> {
  const [color, normals] = await Promise.all([
    readRgba(`${base}${id}_impostor.webp`),
    readRgba(`${base}${id}_impostor_n.webp`),
  ]);
  if (
    color.width % normals.width !== 0 ||
    color.height % normals.height !== 0 ||
    color.width / normals.width !== color.height / normals.height ||
    color.width % frames !== 0 ||
    normals.width % frames !== 0
  )
    throw new Error(`Tree ${id}: colour/normal atlas dimensions are incompatible`);
  const normalCoverage =
    color.width === normals.width && color.height === normals.height
      ? color.data
      : coverageWeightsForSize(
          color.data,
          color.width,
          color.height,
          normals.width,
          normals.height,
        );
  return [
    mipTexture(coverageMips(color.data, color.width, color.height, frames)),
    mipTexture(
      normalMips(normals.data, normalCoverage, normals.width, normals.height, ambientOcclusion),
    ),
  ];
}

// ---- loading ------------------------------------------------------------------------------------

export async function loadTreeModels(
  renderer: THREE.WebGLRenderer | null,
  opts: { base?: string; timeoutMs?: number } = {},
): Promise<TreeModels> {
  const base = `${opts.base ?? import.meta.env.BASE_URL}models/trees/`;
  const work = (async () => {
    const res = await fetch(`${base}trees.json`);
    if (!res.ok) throw new Error(`trees.json ${res.status}`);
    const manifest = (await res.json()) as { species: Record<TreeSpecies, SpeciesInfo> };
    const tex = new THREE.TextureLoader();
    const aniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
    const load = async (
      url: string,
      srgb: boolean,
      flip = true,
      coverage = false,
    ): Promise<THREE.Texture> => {
      const t = coverage ? await coverageTexture(url, flip) : await tex.loadAsync(url);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso;
      t.flipY = flip;
      renderer?.initTexture(t);
      return t;
    };
    const shared = new Map<string, Promise<THREE.Texture>>();
    const once = (
      url: string,
      srgb: boolean,
      flip?: boolean,
      coverage = false,
    ): Promise<THREE.Texture> => {
      if (!shared.has(url)) shared.set(url, load(url, srgb, flip, coverage));
      return shared.get(url)!;
    };
    const out = new Map<TreeSpecies, TreeModel>();
    await Promise.all(
      TREE_SPECIES.map(async (id) => {
        const info = manifest.species[id];
        const gltf = await gltfLoader().loadAsync(`${base}${id}.glb`);
        const geo = (name: string): THREE.BufferGeometry => {
          const m = gltf.scene.getObjectByName(name) as THREE.Mesh | undefined;
          if (!m) throw new Error(`tree ${id}: no ${name}`);
          return m.geometry;
        };
        const [barkC, barkN, leaf, [impC, impN]] = await Promise.all([
          once(`${base}bark_${info.bark}_color.webp`, true, false),
          once(`${base}bark_${info.bark}_normal.webp`, false, false),
          once(`${base}leaf_${info.leaf}.webp`, true, false, true),
          impostorTextures(base, id, info.frame.frames, info.frame.ambientOcclusion),
        ]);
        impC.colorSpace = THREE.SRGBColorSpace;
        // Keep the previous sampling budget: normal atlas uses anisotropy, colour does not.
        impN.anisotropy = aniso;
        for (const t of [impC, impN]) {
          renderer?.initTexture(t);
        }
        for (const t of [barkC, barkN]) {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
        }
        const bark = new THREE.MeshStandardMaterial({
          name: `tree:bark:${id}`,
          map: barkC,
          normalMap: barkN,
          color: info.barkTint,
          roughness: 0.9,
          metalness: 0,
        });
        addWetness(bark);
        addTreeFade(bark);
        const foliage = new THREE.MeshStandardMaterial({
          name: `tree:leaves:${id}`,
          map: leaf,
          color: info.leafTint,
          alphaTest: 0.5,
          side: THREE.DoubleSide,
          roughness: 0.75,
          metalness: 0,
        });
        addWetness(foliage);
        addTreeFade(foliage);
        const foliageDepth = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          map: leaf,
          alphaTest: 0.5,
        });
        out.set(id, {
          info,
          branches: geo('branches'),
          leaves: geo('leaves'),
          bark,
          foliage,
          foliageDepth,
          impostor: impostorMaterial(impC, impN, info),
        });
      }),
    );
    return out as TreeModels;
  })();
  return withTimeout(work, opts.timeoutMs ?? TREE_TIMEOUT_MS, 'tree models');
}

// ---- meshes -------------------------------------------------------------------------------------

/** Most trees drawn as full models at once (per species; the rest stay impostors). */
export const TREE_NEAR_MAX = 48;

interface SpeciesLayer {
  trees: MapTree[];
  matrices: THREE.Matrix4[];
  near: Uint8Array;
  branches: THREE.InstancedMesh;
  leaves: THREE.InstancedMesh;
  impostors: THREE.InstancedMesh;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Nine draws for every tree on the map: per species one impostor mesh (all its trees) and two
 * small near meshes (bark, leaves) refilled by `updateTrees` with the trees around the camera,
 * whose impostor instances collapse meanwhile.
 */
export function buildTreeMeshes(map: MapDefinition, models: TreeModels): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees:real';
  const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const layers: SpeciesLayer[] = [];
  for (const id of TREE_SPECIES) {
    const trees = (map.trees ?? []).filter((t) => treeSpecies(t) === id);
    if (!trees.length) continue;
    const model = models.get(id)!;
    const matrices = trees.map((t) => treeMatrix(t, model.info.crown));
    const impostors = new THREE.InstancedMesh(quad, model.impostor, trees.length);
    matrices.forEach((m, i) => impostors.setMatrixAt(i, m));
    impostors.name = `trees:impostor:${id}`;
    impostors.receiveShadow = true;
    // Billboards turn in the shader: bound the mesh by the trees (a generous box), not the quad.
    impostors.computeBoundingBox();
    const bb = new THREE.Box3();
    for (const t of trees) {
      bb.expandByPoint(new THREE.Vector3(t.x - t.height, t.y ?? 0, t.z - t.height));
      bb.expandByPoint(new THREE.Vector3(t.x + t.height, (t.y ?? 0) + t.height, t.z + t.height));
    }
    impostors.boundingBox = bb;
    impostors.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
    const near = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string) => {
      const mesh = new THREE.InstancedMesh(geometry, material, TREE_NEAR_MAX);
      mesh.count = 0;
      mesh.name = `trees:${name}:${id}`;
      mesh.frustumCulled = false; // a handful of trees around the camera
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return mesh;
    };
    const branches = near(model.branches, model.bark, 'branches');
    const leaves = near(model.leaves, model.foliage, 'leaves');
    leaves.customDepthMaterial = model.foliageDepth;
    for (const mesh of [impostors, branches, leaves]) {
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    layers.push({
      trees,
      matrices,
      near: new Uint8Array(trees.length),
      branches,
      leaves,
      impostors,
    });
  }
  group.userData.treeLayers = layers;
  group.userData.treeEye = new THREE.Vector3(Infinity, 0, Infinity);
  return group;
}

/**
 * Per frame (work only after the camera moves a metre): trees within `TREE_NEAR` (with a
 * little hysteresis) draw as full models, the rest as impostors. Same on every tier.
 */
export function updateTrees(group: THREE.Object3D, eye: THREE.Vector3): void {
  const layers = group.userData.treeLayers as SpeciesLayer[] | undefined;
  const last = group.userData.treeEye as THREE.Vector3 | undefined;
  if (!layers || !last) return;
  if ((eye.x - last.x) ** 2 + (eye.z - last.z) ** 2 < 1) return;
  last.copy(eye);
  for (const L of layers) {
    let n = 0;
    let changed = false;
    L.trees.forEach((t, i) => {
      const d = Math.hypot(t.x - eye.x, t.z - eye.z) - t.height * 0.3;
      const was = L.near[i] === 1;
      const now = n < TREE_NEAR_MAX && d <= TREE_NEAR + (was ? TREE_HYSTERESIS : 0);
      if (now) {
        L.branches.setMatrixAt(n, L.matrices[i]!);
        L.leaves.setMatrixAt(n, L.matrices[i]!);
        n++;
      }
      if (now !== was) {
        L.near[i] = now ? 1 : 0;
        L.impostors.setMatrixAt(i, now ? ZERO : L.matrices[i]!);
        changed = true;
      }
    });
    L.branches.count = n;
    L.leaves.count = n;
    L.branches.instanceMatrix.needsUpdate = true;
    L.leaves.instanceMatrix.needsUpdate = true;
    if (changed) L.impostors.instanceMatrix.needsUpdate = true;
  }
}
