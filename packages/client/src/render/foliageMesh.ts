import * as THREE from 'three';
import {
  PLAYER,
  treeTrunkHeight,
  treeTrunkRadiusOf,
  type MapDefinition,
  type MapFoliage,
  type MapTree,
} from '@wd/shared';
import {
  ATLAS_RECTS,
  ATLAS_SIZE,
  CANOPY_REPEAT_INSET,
  FOLIAGE_ALPHA_TEST,
  buildFoliageAtlas,
  tileUv,
  writeOpaqueTile,
  type AtlasLevel,
} from './foliageAtlas.ts';
import { wetness } from './materials.ts';
import { withTimeout } from './surfaceTextures.ts';
import { patchBudgetShadows } from './renderBudget.ts';
import {
  FRINGE_SOLID,
  SWAY,
  bushArchetype,
  canopyArchetype,
  coniferArchetype,
  grassArchetype,
  trunkArchetype,
} from './foliageGeometry.ts';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Trees, bushes and tall grass: procedural low-poly archetypes, instanced per 96 m chunk.
 *
 * Every plant has a dense interior (leaf-textured hulls or crossed thatch cards) wrapped
 * in alpha-tested *cards* (leaf clusters, conifer sprays, grass blades) from a generated atlas
 * (`foliageAtlas.ts`). The core is what makes concealment robust: sight through a bush is blocked
 * by solid geometry, not by whichever leaf texels survive filtering, and the atlas mips keep their
 * alpha coverage so cards don't thin out at distance either.
 *
 * Gameplay volumes are shared map data and the visuals are fitted to them exactly:
 * - bushes / tall grass: unit archetypes spanning radius 1 × height 1, instanced at (r, h, r) —
 *   the `FoliageIndex` cylinder (tests check the extents per clump);
 * - tree trunks: the collider cylinder (`treeTrunkRadiusOf`, `treeTrunkHeight`) within a few cm,
 *   stopping at exactly the collider top;
 * - crowns: the old crown volume (radius `crown`, top at `height`, bottom at half height for
 *   broadleaf, 0.2 × height for conifers), well above player height.
 *
 * Opaque clump geometry is identical at every quality tier and distance; wind is identical across tiers: Low uses a cheaper
 * shader setting (diffuse environment lighting without glossy IBL or leaf backlighting), so what hides a player on High hides them
 * on Low. The wind sway is a few centimetres, driven by `foliageWind` (weather), and fades out
 * with distance. Fixed dense interiors preserve the concealment silhouette.
 */

// ---- placement (pure: tests check it against the gameplay volumes) ------------------------

export type FoliageKind = 'trunk' | 'canopy' | 'conifer' | 'bush' | 'grass';

export interface FoliageInstance {
  /** Base position of the archetype's origin. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Positive archetype scale (negative scales are unsupported by InstancedMesh). */
  sx: number;
  sy: number;
  sz: number;
  /** Instance tint (linear multiplier, ~1). */
  tint: [number, number, number];
}

const hash = (x: number, z: number, k: number): number => {
  const h = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * Lowest a crown may hang above the tree's base (m). Crowns are not in `FoliageIndex` (they only
 * hide from above), so they must clear a standing player's head (`PLAYER.standHeight` 1.8 m)
 * with room to spare; a short conifer's skirt is lifted to this.
 */
export const CROWN_CLEARANCE = PLAYER.standHeight + 0.6;

/** Crown bottom above the tree's base: half height (broadleaf), a fifth (conifer), ≥ clearance. */
export const crownBase = (t: MapTree): number =>
  Math.max(CROWN_CLEARANCE, t.height * (t.kind === 'conifer' ? 0.2 : 0.5));
/** Crown height (bottom to the tree top). */
export const crownHeight = (t: MapTree): number => t.height - crownBase(t);

export function trunkInstance(t: MapTree): FoliageInstance {
  const r = treeTrunkRadiusOf(t);
  const h = hash(t.x, t.z, 1);
  const k = 0.92 + 0.12 * h;
  return {
    x: t.x,
    y: t.y ?? 0,
    z: t.z,
    yaw: h * Math.PI * 2,
    sx: r,
    sy: treeTrunkHeight(t),
    sz: r,
    tint: [k, k * 0.97, k * 0.94],
  };
}

export function crownInstance(t: MapTree): FoliageInstance {
  const h = hash(t.z, t.x, 2);
  const h2 = hash(t.x, t.z, 3);
  const conifer = t.kind === 'conifer';
  const tint: [number, number, number] = conifer
    ? [0.82 + 0.1 * h, 0.92 + 0.08 * h2, 0.9 + 0.1 * h]
    : [0.9 + 0.22 * h, 0.95 + 0.1 * h2, 0.78 + 0.2 * (1 - h)];
  return {
    x: t.x,
    y: (t.y ?? 0) + crownBase(t),
    z: t.z,
    yaw: h * Math.PI * 2,
    sx: t.crown,
    sy: crownHeight(t),
    sz: t.crown,
    tint,
  };
}

export function clumpInstance(f: MapFoliage): FoliageInstance {
  const h = hash(f.x, f.z, f.kind === 'bush' ? 4 : 5);
  const h2 = hash(f.z, f.x, 6);
  const tint: [number, number, number] =
    f.kind === 'bush'
      ? [0.82 + 0.2 * h, 0.9 + 0.12 * h2, 0.78 + 0.16 * h]
      : [0.95 + 0.15 * h, 0.95 + 0.08 * h2, 0.75 + 0.15 * h];
  return {
    x: f.x,
    y: f.y ?? 0,
    z: f.z,
    yaw: h * Math.PI * 2,
    sx: f.r,
    sy: f.h,
    sz: f.r,
    tint,
  };
}

// ---- wind (presentation only; the weather drives it) ----------------------------------------

/** Shared uniforms of every foliage shader (like `wetness`): wind time, strength, direction. */
export const foliageWind = {
  time: { value: 0 },
  strength: { value: 0.4 },
  dir: { value: new THREE.Vector2(0.8, 0.6) },
  /** Main view position, shared by colour and shadow passes. */
  eye: { value: new THREE.Vector3() },
};
let windTarget = 0.4;

/** Wind strength for a weather preset: a breeze when clear, gusty in rain (0..1). */
export function windStrengthFor(p: { cloudCover: number; rain: number }): number {
  return clamp01(0.3 + 0.25 * p.cloudCover + 0.45 * p.rain);
}

/** Set the wind the foliage eases towards (weather change). */
export function setFoliageWind(strength: number): void {
  windTarget = clamp01(strength);
}

let gustScale = 1;
/** Gusts (0..1, shared with the wind sound): sway swells and settles with what you hear. */
export function setFoliageGust(gust: number): void {
  gustScale = 0.75 + 0.5 * clamp01(gust);
}

/** Advance the wind clock (every frame; uniforms only, no shader work). */
export function advanceFoliageWind(dt: number): void {
  foliageWind.time.value += dt;
  const s = foliageWind.strength;
  s.value += (clamp01(windTarget * gustScale) - s.value) * Math.min(1, dt * 0.5);
}

// ---- materials ------------------------------------------------------------------------------

/** Distance (m) over which sway and translucency fade out (static far foliage, no shimmer). */
export const FOLIAGE_DETAIL_FADE: readonly [number, number] = [60, 110];
/** Distance (m) over which decorative leaf cards fade before tree LOD swaps to the solid crown. */
export const FOLIAGE_CARD_FADE: readonly [number, number] = [30, 42];

/** Low skips glossy IBL/backlighting and alpha test; Low boundary warmup compiles that program. */
export const foliageDetail = { value: 1 };
let foliageLowQuality = false;

export type FoliageQuality = boolean | 'low' | 'medium' | 'high' | 'ultra';

const isLowQuality = (q: FoliageQuality): boolean => q === true || q === 'low';

/**
 * Leaf sprigs whose stem is within this distance (m) of the eye shrink into the hedge about their
 * stem (vertex shader, smooth), so a hedge you hug shows its leaf mass, not leaf polygons across
 * the screen. Presentation only: the concealment core never shrinks; same on every tier.
 */
export const SPRIG_NEAR_FADE: readonly [number, number] = [0.55, 1.2];

const VERTEX_PARS = /* glsl */ `
attribute vec3 aFoliage;
attribute vec4 aFoliageRoot;
uniform float uWindTime;
uniform float uWindStrength;
uniform vec2 uWindDir;
uniform vec3 uFoliageEye;
varying vec3 vFoliage;
varying float vFoliageNear;
vec3 foliageSway( vec3 root, float amp ) {
  float t = uWindTime;
  float ph = dot( root.xz, vec2( 0.071, 0.053 ) );
  float gust = 0.65 + 0.35 * sin( t * 0.37 + dot( root.xz, uWindDir ) * 0.021 );
  float bend = gust * ( 0.55 + 0.3 * sin( t * 1.3 + ph ) + 0.15 * sin( t * 2.9 + ph * 1.7 ) );
  return vec3( uWindDir.x, 0.0, uWindDir.y ) * bend * amp * uWindStrength;
}
`;

const PROJECT_VERTEX = /* glsl */ `
mat4 foliageTransform = modelMatrix;
vec3 foliageLocalRoot = aFoliageRoot.xyz;
float foliageRadius = max( aFoliageRoot.w, 0.001 );
#ifdef USE_INSTANCING
  foliageTransform = modelMatrix * instanceMatrix;
  foliageLocalRoot = vec3( 0.0 );
  foliageRadius = 1.0;
#endif
vec3 foliageRoot = ( foliageTransform * vec4( foliageLocalRoot, 1.0 ) ).xyz;
float foliageDistance = distance( foliageRoot, uFoliageEye );
float foliageFade = 1.0 - smoothstep( ${FOLIAGE_DETAIL_FADE[0].toFixed(1)}, ${FOLIAGE_DETAIL_FADE[1].toFixed(1)}, foliageDistance );
float foliageCardFade = 1.0 - smoothstep( ${FOLIAGE_CARD_FADE[0].toFixed(1)}, ${FOLIAGE_CARD_FADE[1].toFixed(1)}, foliageDistance );
// Fixed concealment hulls never move. Only cards sway; all tiers use the same displacement.
if ( aFoliage.x > 0.0 && aFoliage.z < 0.5 && foliageFade > 0.0 ) {
  vec3 off = foliageSway( foliageRoot, aFoliage.x * foliageFade );
  // Inverse of the orthogonal rotation/scale, without a per-vertex matrix inverse.
  transformed += vec3(
    dot( off, foliageTransform[ 0 ].xyz ) / dot( foliageTransform[ 0 ].xyz, foliageTransform[ 0 ].xyz ),
    dot( off, foliageTransform[ 1 ].xyz ) / dot( foliageTransform[ 1 ].xyz, foliageTransform[ 1 ].xyz ),
    dot( off, foliageTransform[ 2 ].xyz ) / dot( foliageTransform[ 2 ].xyz, foliageTransform[ 2 ].xyz )
  );
  // Keep leaf/blade tips inside the gameplay cylinder even in the strongest gust.
  vec2 foliageFromRoot = transformed.xz - foliageLocalRoot.xz;
  transformed.xz = foliageLocalRoot.xz + foliageFromRoot / max( 1.0, length( foliageFromRoot ) / foliageRadius );
}
#ifndef USE_INSTANCING
// Leaf sprigs (root w < 0 = the leaf's stem): shrink into the hedge about the stem as the eye
// closes in. Geometry, so it reads clean up close (no dither stipple without TAA) and never pops.
if ( aFoliageRoot.w < 0.0 ) {
  float sprigScale = smoothstep( ${SPRIG_NEAR_FADE[0].toFixed(2)}, ${SPRIG_NEAR_FADE[1].toFixed(2)}, foliageDistance );
  transformed = foliageLocalRoot + ( transformed - foliageLocalRoot ) * sprigScale;
}
#endif
vFoliage = vec3( aFoliage.y * foliageFade, aFoliage.z, foliageCardFade );
vFoliageNear = distance( ( foliageTransform * vec4( transformed, 1.0 ) ).xyz, uFoliageEye );
// Deform before project/worldpos/shadowmap chunks, so colour, depth and received shadows agree.
#include <project_vertex>
`;

/** Core fragments within this distance get a finer detail sample of the canopy scan. */
export const CANOPY_DETAIL_DISTANCE = 6;
/** Detail repeats per canopy repeat (the scan at a third of its size, luminance only). */
export const CANOPY_DETAIL_SCALE = 3;

const CANOPY_WINDOW = tileUv('canopy', CANOPY_REPEAT_INSET);

/** Up close the scan is magnified (≈2.5 mm/texel): modulate by a finer copy of itself. */
const CANOPY_DETAIL = /* glsl */ `
#ifdef USE_MAP
if ( vFoliage.y > 0.99 && vFoliageNear < ${CANOPY_DETAIL_DISTANCE.toFixed(1)} ) {
  const vec2 winMin = vec2( ${CANOPY_WINDOW.u0.toFixed(6)}, ${CANOPY_WINDOW.v0.toFixed(6)} );
  const vec2 winSize = vec2( ${(CANOPY_WINDOW.u1 - CANOPY_WINDOW.u0).toFixed(6)}, ${(CANOPY_WINDOW.v1 - CANOPY_WINDOW.v0).toFixed(6)} );
  vec2 local = ( vMapUv - winMin ) / winSize;
  if ( local.x > -0.02 && local.y > -0.02 && local.x < 1.02 && local.y < 1.02 ) {
    vec2 duv = winMin + fract( local * ${CANOPY_DETAIL_SCALE.toFixed(1)} ) * winSize;
    vec3 det = textureGrad( map, duv, dFdx( vMapUv ) * ${CANOPY_DETAIL_SCALE.toFixed(1)}, dFdy( vMapUv ) * ${CANOPY_DETAIL_SCALE.toFixed(1)} ).rgb;
    float ratio = clamp( dot( det, vec3( 0.2126, 0.7152, 0.0722 ) ) / uCanopyMean, 0.45, 1.8 );
    float near = 1.0 - smoothstep( ${(CANOPY_DETAIL_DISTANCE * 0.5).toFixed(1)}, ${CANOPY_DETAIL_DISTANCE.toFixed(1)}, vFoliageNear );
    diffuseColor.rgb *= mix( 1.0, ratio, 0.4 * near );
  }
}
#endif`;

/** Solid cores never lose a texel to the alpha test (at any mip, in any pass). */
const SOLID_ALPHA = /* glsl */ `
#ifdef USE_ALPHATEST
  if ( vFoliage.y < 0.5 ) {
    if ( vFoliage.z <= 0.0 ) discard;
    if ( vFoliage.z < 1.0 ) {
      float cardNoise = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
      if ( cardNoise > vFoliage.z ) discard;
    }
  }
#endif
diffuseColor.a = max( diffuseColor.a, min( vFoliage.y, 1.0 ) );
#ifdef USE_ALPHATEST
#include <alphatest_fragment>
#endif`;

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uWindTime = foliageWind.time;
  shader.uniforms.uWindStrength = foliageWind.strength;
  shader.uniforms.uWindDir = foliageWind.dir;
  shader.uniforms.uFoliageEye = foliageWind.eye;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <project_vertex>', PROJECT_VERTEX);
}

/** Mean linear luminance of the canopy repeat window (the detail layer's reference). */
export const canopyMean = { value: 0.12 };

/** Mean linear luminance of the canopy window in an atlas level-0 buffer (sRGB bytes). */
export function canopyWindowLuma(level0: Uint8Array): number {
  const r = ATLAS_RECTS.canopy;
  const inset = Math.round(r.w * CANOPY_REPEAT_INSET);
  const lin = (b: number): number => Math.pow(b / 255, 2.2);
  let sum = 0;
  let n = 0;
  for (let y = r.y + inset; y < r.y + r.h - inset; y += 2) {
    for (let x = r.x + inset; x < r.x + r.w - inset; x += 2) {
      const i = (y * ATLAS_SIZE + x) * 4;
      sum += 0.2126 * lin(level0[i]!) + 0.7152 * lin(level0[i + 1]!) + 0.0722 * lin(level0[i + 2]!);
      n++;
    }
  }
  return Math.max(0.01, sum / n);
}

function patchLit(shader: THREE.WebGLProgramParametersWithUniforms): void {
  patchVertex(shader);
  shader.uniforms.uCanopyMean = canopyMean;
  shader.uniforms.uWetness = wetness;
  shader.uniforms.uFoliageDetail = foliageDetail;
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vFoliage;\nvarying float vFoliageNear;\nuniform float uWetness;\nuniform float uFoliageDetail;\nuniform float uCanopyMean;',
    )
    .replace('#include <map_fragment>', `#include <map_fragment>\n${CANOPY_DETAIL}`)
    .replace(
      '#include <alphatest_fragment>',
      `${SOLID_ALPHA}\ndiffuseColor.rgb *= mix( 1.0, 0.72, uWetness );`,
    )
    .replace(
      '#include <normal_fragment_begin>',
      // Volume normals on both faces of a card (no flip): foliage shades as a soft mass.
      `#include <normal_fragment_begin>
      #ifdef DOUBLE_SIDED
        normal = normalize( vNormal );
        nonPerturbedNormal = normal;
      #endif`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.42, uWetness );',
    )
    .replace(
      '#include <lights_fragment_maps>',
      // Diffuse environment light stays on Low. Glossy IBL costs extra PMREM samples and
      // adds little to matte leaves: skip it on Low and once distance detail has faded.
      `#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
        iblIrradiance += getIBLIrradiance( geometryNormal );
        if ( uFoliageDetail > 0.0 && vFoliage.x > 0.0 ) {
          radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * vFoliage.x;
        }
      #endif`,
    )
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      #if NUM_DIR_LIGHTS > 0
      if ( uFoliageDetail > 0.0 && vFoliage.x > 0.0 ) {
        // Sun through the leaves when looking towards it (thin cards glow, cores barely).
        float back = saturate( dot( - geometryViewDir, directionalLights[ 0 ].direction ) );
        float glow = back * back * back * vFoliage.x;
        reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[ 0 ].color * glow * 0.45;
      }
      #endif`,
    );
}

function patchDepth(shader: THREE.WebGLProgramParametersWithUniforms): void {
  patchVertex(shader);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFoliage;')
    .replace('#include <alphatest_fragment>', SOLID_ALPHA);
}

export interface FoliageMaterials {
  atlas: THREE.DataTexture;
  /** Same program/geometry at every tier; glossy IBL and leaf backlighting are optional. */
  lit: THREE.MeshStandardMaterial;
  /** Shadow pass shares the same wind, atlas, alpha test and opaque hulls. */
  depth: THREE.MeshDepthMaterial;
}

let shared: FoliageMaterials | null = null;

/** The atlas texture (level 0 plus the coverage-preserving chain; no GPU mip generation). */
export function foliageAtlasTexture(seed = 1): THREE.DataTexture {
  const atlas = buildFoliageAtlas(seed);
  const l0 = atlas.levels[0]!;
  const tex = new THREE.DataTexture(l0.data, ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat);
  tex.mipmaps = atlas.levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.name = 'foliage-atlas';
  // Bush cores are seen at grazing angles up close; three clamps this to the GPU's maximum.
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  canopyMean.value = canopyWindowLuma(l0.data);
  return tex;
}

/** Startup waits this long for the canopy scan, then plays with the painted tile. */
export const CANOPY_SCAN_TIMEOUT_MS = 15_000;

async function decodeCanopyScan(
  url: string,
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const cv = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    pixels: ctx.getImageData(0, 0, cv.width, cv.height).data,
    width: cv.width,
    height: cv.height,
  };
}

/**
 * Swap the painted canopy tile for the scan-baked one (CC0 Poly Haven `shrub_02`, baked by
 * tools/assets/bake_canopy.mjs) and upload it. Fills the existing atlas in place: no new
 * texture, no recompile, so call it any time before `Game.warmUp`. On failure the painted tile
 * stays (the caller warns). Rejects after `timeoutMs` (a stalled server must not hold startup);
 * a scan that decodes later is dropped, never written into the atlas mid-play.
 */
export async function loadCanopyScan(
  renderer: THREE.WebGLRenderer,
  url = `${import.meta.env.BASE_URL}tex/canopy_albedo.webp`,
  timeoutMs = CANOPY_SCAN_TIMEOUT_MS,
): Promise<void> {
  const { pixels, width, height } = await withTimeout(decodeCanopyScan(url), timeoutMs, url);
  const { atlas } = foliageMaterials();
  const levels = atlas.mipmaps as AtlasLevel[];
  writeOpaqueTile(levels, 'canopy', pixels, width, height);
  canopyMean.value = canopyWindowLuma(levels[0]!.data);
  atlas.needsUpdate = true;
  renderer.initTexture(atlas);
}

/** One lit and one depth material, shared by every plant at every quality tier. */
export function foliageMaterials(): FoliageMaterials {
  if (shared) return shared;
  const atlas = foliageAtlasTexture();
  const lit = new THREE.MeshStandardMaterial({
    name: 'foliage',
    map: atlas,
    alphaTest: FOLIAGE_ALPHA_TEST,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.78,
    metalness: 0,
  });
  lit.onBeforeCompile = patchLit;
  const litKey = () => `foliage-5-${lit.alphaTest > 0 ? 'alpha' : 'opaque'}`;
  lit.customProgramCacheKey = litKey;
  patchBudgetShadows(lit);
  lit.customProgramCacheKey = () => `${litKey()}|budget-pcf-1`;
  // Set these before compiling; do not depend on the first shadow render copying them.
  const depth = new THREE.MeshDepthMaterial({
    name: 'foliage-depth',
    map: atlas,
    alphaTest: FOLIAGE_ALPHA_TEST,
    side: THREE.DoubleSide,
  });
  depth.onBeforeCompile = patchDepth;
  depth.customProgramCacheKey = () => `foliage-depth-4-${depth.alphaTest > 0 ? 'alpha' : 'opaque'}`;
  shared = { atlas, lit, depth };
  return shared;
}

// ---- meshes --------------------------------------------------------------------------------

let archetypes: Record<FoliageKind, THREE.BufferGeometry> | null = null;
let farCrownArchetypes: Pick<
  Record<FoliageKind, THREE.BufferGeometry>,
  'canopy' | 'conifer'
> | null = null;

function solidLeafCrownGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = source.getIndex();
  const position = source.getAttribute('position');
  const normal = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const color = source.getAttribute('color');
  const foliage = source.getAttribute('aFoliage');
  const root = source.getAttribute('aFoliageRoot');
  const pos: number[] = [];
  const nrm: number[] = [];
  const tex: number[] = [];
  const col: number[] = [];
  const fol: number[] = [];
  const roots: number[] = [];
  const idx: number[] = [];
  const sourceIndex = (i: number): number => (index ? index.getX(i) : i);
  const copyVertex = (v: number): number => {
    pos.push(position.getX(v), position.getY(v), position.getZ(v));
    nrm.push(normal.getX(v), normal.getY(v), normal.getZ(v));
    tex.push(uv.getX(v), uv.getY(v));
    col.push(color.getX(v), color.getY(v), color.getZ(v));
    fol.push(foliage.getX(v), foliage.getY(v), foliage.getZ(v));
    roots.push(root.getX(v), root.getY(v), root.getZ(v), root.getW(v));
    return pos.length / 3 - 1;
  };
  const triCount = (index?.count ?? position.count) / 3;
  for (let tri = 0; tri < triCount; tri++) {
    const a = sourceIndex(tri * 3);
    const b = sourceIndex(tri * 3 + 1);
    const c = sourceIndex(tri * 3 + 2);
    // Exact opaque crown core only: decorative cards have solid=0.
    if (foliage.getZ(a) !== 1 || foliage.getZ(b) !== 1 || foliage.getZ(c) !== 1) {
      continue;
    }
    idx.push(copyVertex(a), copyVertex(b), copyVertex(c));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(tex, 2));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('aFoliage', new THREE.Float32BufferAttribute(fol, 3));
  out.setAttribute('aFoliageRoot', new THREE.Float32BufferAttribute(roots, 4));
  out.setIndex(idx);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** The five shared archetype geometries (generated once per session, deterministic). */
export function foliageArchetypes(): Record<FoliageKind, THREE.BufferGeometry> {
  archetypes ??= {
    trunk: trunkArchetype().toGeometry(),
    canopy: canopyArchetype().toGeometry(),
    conifer: coniferArchetype().toGeometry(),
    bush: bushArchetype().toGeometry(),
    grass: grassArchetype().toGeometry(),
  };
  return archetypes;
}

function foliageFarCrownArchetypes(): Pick<
  Record<FoliageKind, THREE.BufferGeometry>,
  'canopy' | 'conifer'
> {
  const near = foliageArchetypes();
  farCrownArchetypes ??= {
    canopy: solidLeafCrownGeometry(near.canopy),
    conifer: solidLeafCrownGeometry(near.conifer),
  };
  return farCrownArchetypes;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _eye = new THREE.Vector3();
const _center = new THREE.Vector3();
const _box = new THREE.Box3();
const _yaw = new THREE.Quaternion();
const _stem = new THREE.Vector3();

/**
 * World size of a bush's leaf sprigs relative to their unit-space size: uniform (no stretched
 * kites on a long hedge), following the smaller of radius and height within 0.8–1.5.
 */
export function sprigLeafScale(f: Pick<MapFoliage, 'r' | 'h'>): number {
  return Math.min(1.5, Math.max(0.8, Math.min(f.r, f.h)));
}

/** Instance transform of a placement (tests use it to check extents in world space). */
export function instanceMatrix(i: FoliageInstance, out = new THREE.Matrix4()): THREE.Matrix4 {
  _q.setFromAxisAngle(UP, i.yaw);
  return out.compose(_p.set(i.x, i.y, i.z), _q, _s.set(i.sx, i.sy, i.sz));
}

function instanced(
  name: string,
  kind: FoliageKind,
  list: readonly FoliageInstance[],
  castShadow: boolean,
  geometry: THREE.BufferGeometry = foliageArchetypes()[kind],
): THREE.InstancedMesh {
  const mats = foliageMaterials();
  const im = new THREE.InstancedMesh(geometry, mats.lit, list.length);
  im.name = name;
  list.forEach((inst, i) => {
    im.setMatrixAt(i, instanceMatrix(inst, _m));
    // Every foliage mesh has instance colours: one program for all of them.
    im.setColorAt(i, _c.setRGB(inst.tint[0], inst.tint[1], inst.tint[2]));
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.customDepthMaterial = mats.depth;
  im.castShadow = castShadow;
  im.receiveShadow = true;
  im.userData.foliage = true;
  im.matrixAutoUpdate = false;
  im.computeBoundingSphere();
  // Conservative world-space padding for moving card tips at frustum/shadow boundaries.
  im.boundingSphere!.radius += Math.max(...Object.values(SWAY));
  im.onBeforeRender = (_renderer, _scene, camera) => {
    camera.getWorldPosition(foliageWind.eye.value);
  };
  im.onBeforeShadow = (_renderer, _object, camera) => {
    camera.getWorldPosition(foliageWind.eye.value);
  };
  return im;
}

/**
 * Which clump triangles a merged mesh keeps: `near` everything (High/Medium up close), `far` the
 * concealment cores only, `fringe` only the opaque leaf sprigs (Low up close, beside `far`, so
 * Low draws exactly the solid geometry High does at every distance).
 */
type ClumpLod = 'near' | 'far' | 'fringe';

function keepClumpTri(
  lod: ClumpLod,
  a: number,
  b: number,
  c: number,
  kind: MapFoliage['kind'],
): boolean {
  // Grass blades are drawn instanced (`grassBladeMesh`), never merged per clump.
  if (kind === 'grass' && a === FRINGE_SOLID && b === FRINGE_SOLID && c === FRINGE_SOLID) {
    return false;
  }
  if (lod === 'near') return true;
  const want = lod === 'far' ? 1 : FRINGE_SOLID;
  return a === want && b === want && c === want;
}

function mergedClumpMesh(items: readonly MapFoliage[], lod: ClumpLod): THREE.Mesh {
  const mats = foliageMaterials();
  const arches = foliageArchetypes();
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const fol: number[] = [];
  const root: number[] = [];
  const idx: number[] = [];
  let bushes = 0;
  let grass = 0;

  for (const item of items) {
    const kind = item.kind;
    if (kind === 'bush') bushes++;
    else grass++;
    const inst = clumpInstance(item);
    const matrix = instanceMatrix(inst, _m);
    _n.getNormalMatrix(matrix);
    const geo = arches[kind];
    const srcPos = geo.getAttribute('position');
    const srcNrm = geo.getAttribute('normal');
    const srcUv = geo.getAttribute('uv');
    const srcCol = geo.getAttribute('color');
    const srcFol = geo.getAttribute('aFoliage');
    const srcIdx = geo.getIndex();
    const stems = geo.userData.sprigStem as Float32Array | undefined;
    const leafScale = sprigLeafScale(item);
    _yaw.setFromAxisAngle(UP, inst.yaw);
    const kept = new Map<number, number>();

    const keepVertex = (i: number): number => {
      const existing = kept.get(i);
      if (existing !== undefined) return existing;
      const next = pos.length / 3;
      const sx = stems?.[i * 3];
      if (stems && sx !== undefined && !Number.isNaN(sx)) {
        // Leaf sprig: its stem follows the fitted core; the leaf itself keeps leaf size
        // (uniform scale about the stem), however long or flat the hedge.
        const sy = stems[i * 3 + 1]!;
        const sz = stems[i * 3 + 2]!;
        _v.set(srcPos.getX(i) - sx, srcPos.getY(i) - sy, srcPos.getZ(i) - sz)
          .applyQuaternion(_yaw)
          .multiplyScalar(leafScale);
        _stem.set(sx, sy, sz).applyMatrix4(matrix);
        _v.add(_stem);
      } else {
        _v.set(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i)).applyMatrix4(matrix);
      }
      pos.push(_v.x, _v.y, _v.z);
      _v.set(srcNrm.getX(i), srcNrm.getY(i), srcNrm.getZ(i)).applyMatrix3(_n).normalize();
      nrm.push(_v.x, _v.y, _v.z);
      uv.push(srcUv.getX(i), srcUv.getY(i));
      col.push(
        srcCol.getX(i) * inst.tint[0],
        srcCol.getY(i) * inst.tint[1],
        srcCol.getZ(i) * inst.tint[2],
      );
      fol.push(srcFol.getX(i), srcFol.getY(i), srcFol.getZ(i));
      // Sprig vertices carry their stem (w < 0: shrink about it up close); the rest the plant.
      if (stems && sx !== undefined && !Number.isNaN(sx))
        root.push(_stem.x, _stem.y, _stem.z, -item.r);
      else root.push(inst.x, inst.y, inst.z, item.r);
      kept.set(i, next);
      return next;
    };

    // Copy only vertices referenced by retained triangles. Far LOD keeps the exact opaque
    // triangles and plant roots, without allocating/uploading unused decorative card vertices.
    if (srcIdx) {
      for (let i = 0; i < srcIdx.count; i += 3) {
        const a = srcIdx.getX(i);
        const b = srcIdx.getX(i + 1);
        const c = srcIdx.getX(i + 2);
        if (!keepClumpTri(lod, srcFol.getZ(a), srcFol.getZ(b), srcFol.getZ(c), kind)) continue;
        idx.push(keepVertex(a), keepVertex(b), keepVertex(c));
      }
    } else {
      for (let i = 0; i < srcPos.count; i += 3) {
        if (!keepClumpTri(lod, srcFol.getZ(i), srcFol.getZ(i + 1), srcFol.getZ(i + 2), kind))
          continue;
        idx.push(keepVertex(i), keepVertex(i + 1), keepVertex(i + 2));
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aFoliage', new THREE.Float32BufferAttribute(fol, 3));
  geo.setAttribute('aFoliageRoot', new THREE.Float32BufferAttribute(root, 4));
  geo.setIndex(idx);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += Math.max(...Object.values(SWAY));

  const mesh = new THREE.Mesh(geo, mats.lit);
  mesh.name = { near: 'foliage:clumps', far: 'foliage:clumps:far', fringe: 'foliage:fringe' }[lod];
  mesh.customDepthMaterial = mats.depth;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.foliage = true;
  // The fringe mesh repeats plants already counted by the near/far pair.
  mesh.userData.foliageCounts = lod === 'fringe' ? {} : { bush: bushes, grass };
  mesh.userData.foliageLod = lod;
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    camera.getWorldPosition(foliageWind.eye.value);
  };
  mesh.onBeforeShadow = (_renderer, _object, camera) => {
    camera.getWorldPosition(foliageWind.eye.value);
  };
  return mesh;
}

let grassBladeGeo: THREE.BufferGeometry | null = null;
/** The grass archetype's opaque blades only (shared by every clump: instanced, not merged). */
export function grassBladeGeometry(): THREE.BufferGeometry {
  if (grassBladeGeo) return grassBladeGeo;
  const src = foliageArchetypes().grass;
  const fol = src.getAttribute('aFoliage');
  const index = src.getIndex()!;
  const keep: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if ([a, b, c].every((v) => fol.getZ(v) === FRINGE_SOLID)) keep.push(a, b, c);
  }
  const g = src.clone();
  g.setIndex(keep);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  grassBladeGeo = g;
  return g;
}

/**
 * Every grass clump's blades in one instanced draw per chunk (the archetype's blades at each
 * clump's transform and tint). Shown with the chunk's near LOD on every tier (opaque geometry:
 * Low draws what High draws), like the bush sprigs.
 */
function grassBladeMesh(items: readonly MapFoliage[]): THREE.InstancedMesh | null {
  const grass = items.filter((f) => f.kind === 'grass');
  if (!grass.length) return null;
  const im = instanced(
    'foliage:grassBlades',
    'grass',
    grass.map(clumpInstance),
    false,
    grassBladeGeometry(),
  );
  im.userData.foliageLod = 'nearAll';
  return im;
}

/** Trees of one chunk: trunks, broadleaf crowns, conifers (≤ 3 draws). */
export function buildTrees(trees: readonly MapTree[]): THREE.Group {
  const g = new THREE.Group();
  g.name = 'trees';
  if (!trees.length) return g;
  g.add(instanced('trees:trunks', 'trunk', trees.map(trunkInstance), true));
  const broad = trees.filter((t) => t.kind === 'broadleaf');
  const conif = trees.filter((t) => t.kind === 'conifer');
  const far = foliageFarCrownArchetypes();
  if (broad.length) {
    const near = instanced('trees:crowns', 'canopy', broad.map(crownInstance), true);
    const farMesh = instanced(
      'trees:crowns:far',
      'canopy',
      broad.map(crownInstance),
      false,
      far.canopy,
    );
    farMesh.visible = false;
    near.userData.foliageLod = 'near';
    farMesh.userData.foliageLod = 'far';
    g.add(near, farMesh);
  }
  if (conif.length) {
    const near = instanced('trees:conifers', 'conifer', conif.map(crownInstance), true);
    const farMesh = instanced(
      'trees:conifers:far',
      'conifer',
      conif.map(crownInstance),
      false,
      far.conifer,
    );
    farMesh.visible = false;
    near.userData.foliageLod = 'near';
    farMesh.userData.foliageLod = 'far';
    g.add(near, farMesh);
  }
  return g;
}

/**
 * Bushes and tall grass of one chunk (soft concealment: no colliders, but they block sight for
 * players and bots alike through the shared `FoliageIndex`). Never culled or thinned by settings.
 */
export function buildClumps(items: readonly MapFoliage[]): THREE.Group {
  const g = new THREE.Group();
  g.name = 'foliage';
  if (items.length) {
    const near = mergedClumpMesh(items, 'near');
    const far = mergedClumpMesh(items, 'far');
    far.visible = false;
    g.add(near, far);
    const blades = grassBladeMesh(items);
    if (blades) {
      blades.visible = false;
      g.add(blades);
    }
    const fringe = mergedClumpMesh(items, 'fringe');
    if (fringe.geometry.index!.count > 0) {
      fringe.visible = false;
      g.add(fringe);
    } else {
      fringe.geometry.dispose();
    }
  }
  return g;
}

/** Spatial chunk size for clump LOD: 96 m trades a few triangles for many fewer draws. */
export const FOLIAGE_CHUNK = 96;
/** Trees can use coarser batches because far LOD keeps the silhouette cheap. */
export const TREE_FOLIAGE_CHUNK = 96;
export const FOLIAGE_TREE_NEAR_DISTANCE = 48;
export const FOLIAGE_CLUMP_NEAR_DISTANCE = 32;
export const FOLIAGE_LOD_HYSTERESIS = 4;
/** Far tree meshes stay visible but stop casting into the shadow pass. */
export const FOLIAGE_TREE_SHADOW_DISTANCE = 56;

function byChunk<T extends { x: number; z: number }>(items: readonly T[], chunk: number): T[][] {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = `${Math.floor(it.x / chunk)},${Math.floor(it.z / chunk)}`;
    const list = out.get(k) ?? [];
    list.push(it);
    out.set(k, list);
  }
  return [...out.values()];
}

/** Every tree, bush and grass clump of a map, instanced per chunk. */
export function buildFoliageLayer(map: MapDefinition): THREE.Group[] {
  return [
    ...byChunk(map.trees ?? [], TREE_FOLIAGE_CHUNK).map(buildTrees),
    ...byChunk(map.foliage ?? [], FOLIAGE_CHUNK).map(buildClumps),
  ];
}

type FoliageRuntimeKind = 'tree' | 'clump';

interface FoliageRuntimeMesh {
  mesh: THREE.Mesh;
  kind: FoliageRuntimeKind;
  lod: 'near' | 'far' | 'fringe' | 'nearAll' | 'always';
  chunk: {
    center: THREE.Vector3;
    radius: number;
    near: boolean | null;
  };
}

const foliageRuntimeCache = new WeakMap<THREE.Object3D, FoliageRuntimeMesh[]>();
const isFoliageMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  object instanceof THREE.Mesh && object.userData.foliage === true;

function foliageRuntimeMeshes(root: THREE.Object3D): FoliageRuntimeMesh[] {
  const cached = foliageRuntimeCache.get(root);
  if (cached) return cached;
  const meshes: FoliageRuntimeMesh[] = [];
  const chunks = new Map<THREE.Object3D, FoliageRuntimeMesh['chunk']>();
  root.traverse((object) => {
    if (!isFoliageMesh(object)) return;
    const mesh = object;
    const owner = mesh.parent ?? mesh;
    let chunk = chunks.get(owner);
    if (!chunk) {
      _box.setFromObject(owner);
      const center = new THREE.Vector3();
      _box.getCenter(center);
      chunk = { center, radius: _box.getBoundingSphere(new THREE.Sphere()).radius, near: null };
      chunks.set(owner, chunk);
    }
    const lod: unknown = mesh.userData.foliageLod;
    meshes.push({
      mesh,
      kind: mesh.name.startsWith('trees:') ? 'tree' : 'clump',
      lod:
        lod === 'near' || lod === 'far' || lod === 'fringe' || lod === 'nearAll' ? lod : 'always',
      chunk,
    });
  });
  foliageRuntimeCache.set(root, meshes);
  return meshes;
}

/**
 * Per-frame foliage visibility/shadow trim. This is intentionally cache-backed: call it from the
 * render loop with the foliage/map root and active camera. Foliage stays visible at every distance
 * and quality because trunks, crowns, bushes and grass can all contribute to cover or readability.
 */
export function updateFoliage(root: THREE.Object3D, camera: THREE.Camera | THREE.Vector3): void {
  if (camera instanceof THREE.Vector3) _eye.copy(camera);
  else camera.getWorldPosition(_eye);
  const shadowDistanceSq = FOLIAGE_TREE_SHADOW_DISTANCE * FOLIAGE_TREE_SHADOW_DISTANCE;
  for (const { mesh, kind, lod, chunk } of foliageRuntimeMeshes(root)) {
    const sphere =
      mesh instanceof THREE.InstancedMesh ? mesh.boundingSphere : mesh.geometry.boundingSphere;
    if (sphere) _center.copy(sphere.center).applyMatrix4(mesh.matrixWorld);
    else mesh.getWorldPosition(_center);
    const nearest = Math.max(0, _center.distanceTo(_eye) - (sphere?.radius ?? 0));
    const distanceSq = nearest * nearest;
    const nearLimit = kind === 'tree' ? FOLIAGE_TREE_NEAR_DISTANCE : FOLIAGE_CLUMP_NEAR_DISTANCE;
    const chunkNearest = Math.max(0, chunk.center.distanceTo(_eye) - chunk.radius);
    if (chunk.near === null) {
      chunk.near = chunkNearest <= nearLimit;
    } else if (chunk.near) {
      chunk.near = chunkNearest <= nearLimit + FOLIAGE_LOD_HYSTERESIS;
    } else {
      chunk.near = chunkNearest < nearLimit - FOLIAGE_LOD_HYSTERESIS;
    }
    const lowSolidLod = foliageLowQuality && lod !== 'always';
    // Fringe: Low's copy of the sprigs the near mesh already has (same chunks, same distance).
    mesh.visible =
      lod === 'nearAll'
        ? chunk.near
        : lod === 'fringe'
          ? foliageLowQuality && chunk.near
          : lowSolidLod
            ? lod === 'far'
            : lod === 'far'
              ? !chunk.near
              : chunk.near || lod === 'always';
    if (kind === 'clump') {
      mesh.castShadow = false;
      continue;
    }
    // Whatever crown is drawn casts the shade, on every tier: a player under a tree is shaded
    // the same on Low (opaque core) as on High (leaf cards) — concealment parity.
    mesh.castShadow = mesh.visible && distanceSq <= shadowDistanceSq;
  }
}

/** Low uses opaque solid foliage LODs and skips optional glossy IBL/backlighting. */
export function setFoliageQuality(q: FoliageQuality): void {
  const low = isLowQuality(q);
  foliageLowQuality = low;
  foliageDetail.value = low ? 0 : 1;
  const { lit, depth } = foliageMaterials();
  const alphaTest = low ? 0 : FOLIAGE_ALPHA_TEST;
  if (lit.alphaTest !== alphaTest) {
    lit.alphaTest = alphaTest;
    depth.alphaTest = alphaTest;
    lit.needsUpdate = true;
    depth.needsUpdate = true;
  }
}

/**
 * compileAsync does not visit customDepthMaterial. Compile a depth proxy explicitly, together
 * with the lit program for both the Low canvas and Medium+ linear HDR target. This covers new
 * foliage programs even when all plants are outside the initial camera/shadow frustum.
 */
export async function warmFoliage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<void> {
  const { atlas, lit, depth } = foliageMaterials();
  renderer.initTexture(atlas);
  const proxies = new THREE.Group();
  for (const material of [lit, depth]) {
    const instancedMesh = new THREE.InstancedMesh(foliageArchetypes().bush, material, 1);
    instancedMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    instancedMesh.receiveShadow = true;
    proxies.add(instancedMesh);
    const mergedMesh = new THREE.Mesh(foliageArchetypes().grass, material);
    mergedMesh.receiveShadow = true;
    proxies.add(mergedMesh);
  }
  const target = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const level = renderer.getActiveMipmapLevel();
  const toneMapping = renderer.toneMapping;
  const hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const wasLow = foliageLowQuality;
  try {
    for (const quality of ['low', 'medium'] as const) {
      setFoliageQuality(quality);
      renderer.setRenderTarget(null);
      renderer.toneMapping = THREE.AgXToneMapping;
      await renderer.compileAsync(proxies, camera, scene);
      renderer.setRenderTarget(hdr);
      renderer.toneMapping = THREE.NoToneMapping;
      await renderer.compileAsync(proxies, camera, scene);
    }
  } finally {
    setFoliageQuality(wasLow);
    renderer.setRenderTarget(target, face, level);
    renderer.toneMapping = toneMapping;
    hdr.dispose();
    for (const mesh of proxies.children) (mesh as THREE.Mesh).dispose();
  }
}
