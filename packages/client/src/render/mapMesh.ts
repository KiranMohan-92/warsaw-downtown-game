import * as THREE from 'three';
import {
  BAKED_LIGHTMAPS,
  DECOR,
  fitBox,
  fitDecor,
  PROP_SIZES,
  propSurface,
  quatFromEulerDeg,
  rectUv,
  rotateByQuat,
  LAMP_SCALE,
  lampVolumeImageSize,
  lampVolumeRgba,
  selectBakedLightmap,
  selectLampVolume,
  type BakedLightmap,
  type LightmapLayout,
  type MapBox,
  type MapDefinition,
  type MapFlat,
  type MapPrism,
  type MaterialId,
  type Vec3,
  type PropInstance,
} from '@wd/shared';
import { buildFoliageLayer } from './foliageMesh.ts';
import type { MapMaterials } from './materials.ts';
import { buildFacadeDetail, type FacadeBake } from './facadeDetail.ts';
import { isReliefPrism } from './facadeRelief.ts';
import { isPalaceSpire } from './palaceSilhouette.ts';
import { configureLampVolume, LAMP_COLOR, LAMP_INTENSITY } from './lampLight.ts';
import { innerContainerFaces, WEAR_SURFACES } from './wearDetail.ts';
import { emitSandbagWall, SANDBAG_LOD_DISTANCE, type BagVertex } from './sandbagWall.ts';
import { buildPalaceColumns, isPalacePorticoColumn } from './palaceColumns.ts';
import { addPalaceEntranceStone } from './palaceEntranceStone.ts';
import {
  acceptsMarketNeonStaticBake,
  addMarketNeonStaticBake,
  marketNeonStaticMaterial,
} from './marketNeonStaticBake.ts';
import { batchStaticChunks } from './staticBatches.ts';
import { buildSkylineBackdrop } from './skylineBackdrop.ts';
import { SKYLINE_SATIN_KEY } from './skylineFacades.ts';
import { skylineBackdropMaterial } from './skylineMaterials.ts';

export { LAMP_INTENSITY } from './lampLight.ts';

interface FaceDef {
  n: Vec3;
  u: Vec3;
  v: Vec3;
}
const FACES: FaceDef[] = [
  { n: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 } },
  { n: { x: 0, y: -1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  { n: { x: 0, y: 0, z: 1 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 0, z: -1 }, u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
];

const halfAlong = (size: Vec3, axis: Vec3): number =>
  Math.abs(axis.x) * size.x * 0.5 +
  Math.abs(axis.y) * size.y * 0.5 +
  Math.abs(axis.z) * size.z * 0.5;
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Lightmap uv (`uv1`) of a world point on the face being emitted. */
type LmUv = (p: Vec3) => readonly [number, number];

/** Growable geometry buffers (position, normal, uv, colour, index; `uv1` when baked). */
export class GeoBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  /** Lightmap uvs: present iff the bucket samples a baked lightmap (then for every vertex). */
  readonly uv1: number[] | null;
  /**
   * Vertices of a baked bucket that came without a lightmap uv (geometry the lightmap layout does
   * not enumerate, e.g. a new map feature): they get `fallback` (unbaked), never an exception.
   */
  unbaked = 0;
  /**
   * Face-local coordinates (`aFace`: s, t in metres from the face's lower corner, face width,
   * height) for surfaces with edge wear (render/wearDetail.ts); zeros for non-box vertices.
   */
  readonly face: number[] | null;
  /** `fallback`: uv1 for vertices without one; null = the bucket is not baked (no uv1 at all). */
  constructor(
    private readonly fallback: LmUv | null = null,
    faces = false,
  ) {
    this.uv1 = fallback ? [] : null;
    this.face = faces ? [] : null;
  }
  get vertexCount(): number {
    return this.pos.length / 3;
  }
  vertex(
    p: Vec3,
    n: Vec3,
    u: number,
    v: number,
    c: THREE.Color,
    lm: LmUv | null = null,
    face: readonly [number, number, number, number] | null = null,
  ): void {
    if (this.face) this.face.push(...(face ?? [0, 0, 0, 0]));
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    if (this.uv1 && this.fallback) {
      if (!lm) this.unbaked++;
      const [a, b] = (lm ?? this.fallback)(p);
      this.uv1.push(a, b);
    }
  }
  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv1) geo.setAttribute('uv1', new THREE.Float32BufferAttribute(this.uv1, 2));
    if (this.face) geo.setAttribute('aFace', new THREE.Float32BufferAttribute(this.face, 4));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/** Untextured fallback uses the collision surface, preserving holes and cover edges on failure. */
function addProp(g: GeoBuilder, inst: PropInstance): void {
  const { positions, indices } = propSurface(inst);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const normal = geo.getAttribute('normal');
  const base = g.vertexCount;
  for (let i = 0; i < positions.length / 3; i++) {
    const p = { x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! };
    g.vertex(p, { x: normal.getX(i), y: normal.getY(i), z: normal.getZ(i) }, p.x, p.y + p.z, WHITE);
  }
  for (const index of indices) g.idx.push(base + index);
  geo.dispose();
}

const boxTint = new THREE.Color();
/**
 * `lm(face)` = the lightmap uv function of box face `face` (FACES order), when baked; `inner(face)`
 * = the face looks into its container (its `aFace` height is negated: wear, no stencil).
 */
function addBox(
  g: GeoBuilder,
  b: MapBox,
  lm: ((face: number) => LmUv) | null = null,
  inner: ((face: number) => boolean) | null = null,
  faceUv = false,
): void {
  const q = quatFromEulerDeg(b.rot);
  const colour = b.tint !== undefined ? boxTint.setHex(b.tint, THREE.SRGBColorSpace) : WHITE;
  FACES.forEach((f, fi) => {
    const faceLm = lm ? lm(fi) : null;
    const hn = halfAlong(b.size, f.n);
    const hu = halfAlong(b.size, f.u);
    const hv = halfAlong(b.size, f.v);
    const wn = rotateByQuat(f.n, q);
    const wu = rotateByQuat(f.u, q);
    const wv = rotateByQuat(f.v, q);
    const u0 = dot(b.center, wu);
    const v0 = dot(b.center, wv);
    const base = g.vertexCount;
    const hSign = inner?.(fi) ? -1 : 1;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const local = {
        x: f.n.x * hn + f.u.x * hu * su + f.v.x * hv * sv,
        y: f.n.y * hn + f.u.y * hu * su + f.v.y * hv * sv,
        z: f.n.z * hn + f.u.z * hu * su + f.v.z * hv * sv,
      };
      const w = rotateByQuat(local, q);
      g.vertex(
        { x: b.center.x + w.x, y: b.center.y + w.y, z: b.center.z + w.z },
        wn,
        // `faceUv`: metres from the face's lower corner (a texture laid out per face height).
        faceUv ? (su + 1) * hu : u0 + hu * su,
        faceUv ? (sv + 1) * hv : v0 + hv * sv,
        colour,
        faceLm,
        [(su + 1) * hu, (sv + 1) * hv, 2 * hu, 2 * hv * hSign],
      );
    }
    g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
}

/**
 * A sandbag box drawn as its bags (render/sandbagWall.ts). Each bag reads the lightmap texels of
 * its row's side face (box-local position clamped onto the box), so the bags sit in the box's
 * baked occlusion.
 */
function addSandbagBags(g: GeoBuilder, b: MapBox, lm: ((face: number) => LmUv) | null): void {
  const tint =
    b.tint !== undefined ? new THREE.Color().setHex(b.tint, THREE.SRGBColorSpace) : WHITE;
  const q = quatFromEulerDeg(b.rot);
  const hx = b.size.x / 2 - 0.02;
  const hy = b.size.y / 2 - 0.02;
  const hz = b.size.z / 2 - 0.02;
  const clamp = (v: number, h: number): number => Math.max(-h, Math.min(h, v));
  const c = new THREE.Color();
  const base = g.vertexCount;
  emitSandbagWall(
    b,
    (v: BagVertex) => {
      const i = g.vertexCount;
      let faceLm: LmUv | null = null;
      if (lm) {
        const f = lm(v.lmFace);
        const w = rotateByQuat(
          { x: clamp(v.local.x, hx), y: clamp(v.local.y, hy), z: clamp(v.local.z, hz) },
          q,
        );
        const uv = f({ x: b.center.x + w.x, y: b.center.y + w.y, z: b.center.z + w.z });
        faceLm = () => uv;
      }
      g.vertex(v.p, v.n, v.u, v.v, c.copy(tint).multiplyScalar(v.shade), faceLm);
      return i - base;
    },
    (x, y, z) => g.idx.push(base + x, base + y, base + z),
  );
}

/**
 * Warm-up: draw every level of every `THREE.LOD` under `root` (sandbag walls: bags and box), so
 * the first approach to a wall that was far at load uploads nothing mid-game. Turns automatic
 * level selection off and shows all levels; the returned function restores both (the renderer
 * picks the right level again on the next draw).
 */
export function showAllLodLevels(root: THREE.Object3D): () => void {
  const restore: (() => void)[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.LOD)) return;
    const auto = o.autoUpdate;
    const shown = o.levels.map((l) => l.object.visible);
    o.autoUpdate = false;
    for (const l of o.levels) l.object.visible = true;
    restore.push(() => {
      o.autoUpdate = auto;
      o.levels.forEach((l, i) => (l.object.visible = shown[i]!));
    });
  });
  return () => {
    for (const r of restore) r();
  };
}

/** Sandbag walls: bags within `SANDBAG_LOD_DISTANCE` of their chunk, the plain box beyond. */
const SANDBAG_CHUNK = 32;

/** Merge boxes into one indexed geometry with world-metre UVs (grid lines align across boxes). */
export function boxesToGeometry(boxes: readonly MapBox[]): THREE.BufferGeometry {
  const g = new GeoBuilder();
  for (const b of boxes) addBox(g, b);
  return g.build();
}

/**
 * Convex prism walls (u = metres along the building perimeter, v = height, so storeys line up
 * everywhere). Returns nothing for the top (added separately with its own material).
 */
function addPrismWalls(
  g: GeoBuilder,
  p: MapPrism,
  c: THREE.Color,
  lm: ((edge: number) => LmUv) | null = null,
): void {
  const n = p.pts.length;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const a = p.pts[i]!;
    const b = p.pts[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    // CCW in (x, z) → outward normal is (dz, -dx) / len.
    const nrm = { x: dz / len, y: 0, z: -dx / len };
    const base = g.vertexCount;
    const l = lm ? lm(i) : null;
    g.vertex({ x: a[0], y: p.y0, z: a[1] }, nrm, run, p.y0, c, l);
    g.vertex({ x: b[0], y: p.y0, z: b[1] }, nrm, run + len, p.y0, c, l);
    g.vertex({ x: b[0], y: p.y1, z: b[1] }, nrm, run + len, p.y1, c, l);
    g.vertex({ x: a[0], y: p.y1, z: a[1] }, nrm, run, p.y1, c, l);
    // Winding: CCW seen from outside.
    g.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    run += len;
  }
}

/** Horizontal convex polygon (fan) at height y, facing up or down. */
function addCap(
  g: GeoBuilder,
  pts: readonly (readonly [number, number])[],
  y: number,
  up: boolean,
  c: THREE.Color,
  lm: LmUv | null = null,
): void {
  const base = g.vertexCount;
  const nrm = { x: 0, y: up ? 1 : -1, z: 0 };
  for (const [x, z] of pts) g.vertex({ x, y, z }, nrm, x, -z, c, lm);
  for (let i = 1; i + 1 < pts.length; i++) {
    // Points are CCW in (x, z); seen from above (+Y) that is clockwise → flip for up faces.
    if (up) g.idx.push(base, base + i + 1, base + i);
    else g.idx.push(base, base + i, base + i + 1);
  }
}

/**
 * Chunk keys for draw-call batching + frustum culling. Buildings/props use 256 m chunks (culling
 * pays off); the ground (street slab, road/grass/paving markings) is nearly always in view, so it
 * merges into 384 m chunks and costs a handful of draw calls.
 */
const CHUNK = 256;
const GROUND_CHUNK = 384;
const chunkKey = (x: number, z: number, size = CHUNK): string =>
  `${size}:${Math.floor(x / size)},${Math.floor(z / size)}`;

type Bucket = {
  mat: MaterialId;
  g: GeoBuilder;
  shadow: boolean;
  order: number;
  offset: number;
  /** Baked lightmap this bucket samples (null = unbaked). */
  lm: LightmapKind | null;
  /** Greybox stand-in for prop models (goes in the `PROP_GREYBOX` group). */
  prop: boolean;
  /** Dressed-stone boxes use the facade shell without painted windows. */
  shell: boolean;
};

type BuiltBucket = {
  key: string;
  bucket: Bucket;
  plain: THREE.Material;
  baked: THREE.Material | null;
  geometry: THREE.BufferGeometry;
  renderOrder: number;
  castShadow: boolean;
};

/**
 * Name of the group holding the greybox stand-ins for boxes drawn as prop models (`MapBox.model`)
 * and for street dressing (`MapDecor`): render/propModels.ts removes it once the models load;
 * if they don't, the map keeps drawing it.
 */
export const PROP_GREYBOX = 'map:prop-greybox';
/** Prop surfaces do not use the box-face lightmap layout. */
const DECOR_KEY = '|decor';

// ---- baked lighting ------------------------------------------------------------------------------

/**
 * Strength of the baked sky occlusion on the fill light (hemisphere + IBL): 1 would let a fully
 * enclosed texel go black; 0.85 keeps tunnels and deep doorways readable. The sun and its
 * realtime shadows are untouched (three's aoMap only scales indirect light).
 */
export const BAKED_AO_INTENSITY = 0.85;

type LightmapKind = 'atlas' | 'ground';

/**
 * How long `Game.create` waits for the lightmap PNGs before warm-up; after that the map plays
 * with white (unbaked) lightmaps rather than hitching mid-match when they finally decode.
 */
export const LIGHTMAP_LOAD_TIMEOUT_MS = 6000;

export interface MapMeshOptions {
  /** Bakes to choose from (default: the bundled manifest written by `pnpm bake`). */
  bakes?: readonly BakedLightmap[];
  /** Load a baked PNG as `width × height` single-channel bytes (default: fetch + decode). */
  loadLightmap?: (
    file: string,
    width: number,
    height: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
}

interface LightmapTexture {
  file: string;
  tex: THREE.DataTexture | THREE.Data3DTexture;
  /** Byte shown until (or if never) loaded: 255 = unoccluded AO, 0 = no lamp light. */
  blank: number;
  /**
   * A texture whose pixels are not the PNG's bytes (the lamp volume: planes → RGBA voxels): the
   * PNG's size, and how to write its decoded bytes into the texture (which already holds `blank`).
   */
  convert?: { width: number; height: number; fill: (pixels: Uint8Array) => void };
}

/**
 * Baked ceiling-lamp light (`<bake>-lamps.png`, atlas layout; strength and colour shared with the
 * dynamic objects' lamp volume in `lampLight.ts`). Added to the indirect diffuse *after* the
 * aoMap, so the sky occlusion that darkens an interior never dims its lamps.
 */
function addLampLight(m: THREE.MeshStandardMaterial, tex: THREE.Texture): void {
  const prev = m.onBeforeCompile.bind(m);
  const k = (LAMP_SCALE * LAMP_INTENSITY).toFixed(4);
  const c = LAMP_COLOR.toArray()
    .map((v) => v.toFixed(3))
    .join(', ');
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.lampMap = { value: tex };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D lampMap;')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        {
          float lampT = texture2D(lampMap, vAoMapUv).r;
          reflectedLight.indirectDiffuse +=
            BRDF_Lambert(material.diffuseColor) * vec3(${c}) * (lampT * lampT * ${k});
        }`,
      );
  };
}

/** A built map's baked lighting: material swaps plus its lazily loaded lightmaps. */
interface BakedMap {
  swaps: { mesh: THREE.Mesh; baked: THREE.Material; plain: THREE.Material }[];
  textures: LightmapTexture[];
  load: NonNullable<MapMeshOptions['loadLightmap']>;
  abort: AbortController;
  /** Set when the first `setBakedLighting(…, true)` starts the loads (never rejects). */
  loading: Promise<void> | null;
}

const bakedMaps = new WeakMap<THREE.Object3D, BakedMap>();

const bakedMapsUnder = (root: THREE.Object3D): BakedMap[] => {
  const out: BakedMap[] = [];
  root.traverse((o) => {
    const b = bakedMaps.get(o);
    if (b) out.push(b);
  });
  return out;
};

/**
 * Turn baked lighting on or off for every map built under `root` (swaps materials; the plain ones
 * are exactly the pre-bake materials, so Low keeps its old programs and cost). Maps are built
 * plain; the first switch-on starts fetching and decoding the lightmaps. Game primes this at load
 * even on Low, then warms both material variants, so tier changes only select cached programs.
 */
export function setBakedLighting(root: THREE.Object3D, on: boolean): void {
  for (const b of bakedMapsUnder(root)) {
    for (const s of b.swaps) s.mesh.material = on ? s.baked : s.plain;
    if (on && !b.loading) b.loading = startLoads(b);
  }
}

/**
 * Wait (at most `timeoutMs`) for the lightmaps that `setBakedLighting` started under `root`, and
 * return their textures so the caller can upload them before warm-up. On timeout the loads are
 * cancelled with one `console.warn` and the lightmaps stay white (unbaked): no late decode or
 * upload hitch mid-match. Resolves immediately when nothing is loading (no bake, or Low).
 */
export async function bakedLightingReady(
  root: THREE.Object3D,
  timeoutMs = LIGHTMAP_LOAD_TIMEOUT_MS,
): Promise<THREE.Texture[]> {
  const started = bakedMapsUnder(root).filter((b) => b.loading !== null);
  const loads = started.flatMap((b) => (b.loading ? [b.loading] : []));
  if (!loads.length) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const done = Promise.all(loads).then(() => false as const);
  const late = await Promise.race([done, timedOut]);
  clearTimeout(timer);
  if (late) {
    for (const b of started) b.abort.abort();
    console.warn(
      `baked lightmaps not loaded after ${timeoutMs} ms: rendering unbaked for this session`,
    );
  }
  return started.flatMap((b) => b.textures.map((t) => t.tex));
}

/**
 * A lightmap texture with no pixels yet: shaders compile with the aoMap at warm-up whether or not
 * it is loaded. `startLoads` fills it white (unoccluded) first, then uploads the PNG in place:
 * same size, no recompile, no dark flash while loading (or if loading fails).
 */
function lightmapTexture(
  file: string,
  width: number,
  height: number,
  mipmaps: boolean,
): LightmapTexture {
  const tex = new THREE.DataTexture(null, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = `lightmap:${file}`;
  tex.channel = 1; // sampled with uv1
  tex.flipY = false; // row 0 = v 0 (the layout's texel y)
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  // The atlas packs faces 1 texel apart: mipmaps would bleed neighbours into each other.
  tex.generateMipmaps = mipmaps;
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  return { file, tex, blank: 255 };
}

/** White first, then each PNG as it arrives; failures warn and stay white. Never rejects. */
async function startLoads(b: BakedMap): Promise<void> {
  const { signal } = b.abort;
  await Promise.all(
    b.textures.map(async ({ file, tex, blank, convert }) => {
      const { width, height } = convert ?? tex.image;
      let data: Uint8Array | null = null;
      if (!convert) {
        data = new Uint8Array(width * height).fill(blank);
        tex.image.data = data;
        tex.needsUpdate = true;
      }
      try {
        const pixels = await b.load(file, width, height, signal);
        if (signal.aborted) return; // timed out: already warned, stays white
        if (pixels.length !== width * height) {
          throw new Error(`${pixels.length} bytes, expected ${width * height}`);
        }
        if (convert) convert.fill(pixels);
        else data!.set(pixels);
        tex.needsUpdate = true;
      } catch (e) {
        if (!signal.aborted) {
          console.warn(`baked lightmap ${file} failed to load (${String(e)}): rendering unbaked`);
        }
      }
    }),
  );
}

/** Default loader: fetch from `public/lightmaps/` and decode the PNG's red channel on a canvas. */
async function fetchLightmap(
  file: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(`${import.meta.env.BASE_URL}lightmaps/${file}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  signal.throwIfAborted(); // no decode for a load nobody waits for any more
  const bmp = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  if (bmp.width !== width || bmp.height !== height) {
    bmp.close();
    throw new Error(`image is ${bmp.width}×${bmp.height}, expected ${width}×${height}`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2D canvas');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]!;
  return out;
}

interface BakedLighting {
  layout: LightmapLayout;
  atlas: LightmapTexture;
  ground: LightmapTexture;
  /** Ceiling-lamp light (atlas layout); null for a bake without it. */
  lamps: LightmapTexture | null;
  /** Lamp irradiance volume for dynamic objects (`lampLight.ts`); null for a bake without it. */
  volume: LightmapTexture | null;
}

/**
 * The map's bake, if one exists and still matches its layout (warns, never throws, otherwise).
 * Also sizes the shared lamp volume (`configureLampVolume`) for it, or empties it.
 */
function bakedLightingFor(map: MapDefinition, opts: MapMeshOptions): BakedLighting | null {
  configureLampVolume(null);
  const sel = selectBakedLightmap(map, opts.bakes ?? BAKED_LIGHTMAPS);
  if (sel.kind === 'none') return null;
  if (sel.kind === 'skip') {
    console.warn(sel.message);
    return null;
  }
  if (sel.warning) console.warn(sel.warning);
  const { atlas, ground, lamps } = sel.baked;
  return {
    layout: sel.layout,
    atlas: lightmapTexture(atlas.file, atlas.width, atlas.height, false),
    ground: lightmapTexture(ground.file, ground.width, ground.height, true),
    lamps: lamps
      ? { ...lightmapTexture(lamps.file, lamps.width, lamps.height, false), blank: 0 }
      : null,
    volume: lampVolumeFor(map, sel.baked),
  };
}

function addBucketMesh(
  group: THREE.Group,
  greybox: THREE.Group,
  swaps: BakedMap['swaps'],
  item: BuiltBucket,
): THREE.Mesh {
  const mesh = new THREE.Mesh(item.geometry, item.plain);
  mesh.name = `map:${item.key}`;
  mesh.castShadow = item.castShadow;
  mesh.receiveShadow = true;
  mesh.renderOrder = item.renderOrder;
  mesh.matrixAutoUpdate = false;
  if (item.baked) swaps.push({ mesh, baked: item.baked, plain: item.plain });
  (item.bucket.prop ? greybox : group).add(mesh);
  return mesh;
}

/** The bake's lamp volume if it still fits the map's fixtures (else a warning and none). */
function lampVolumeFor(map: MapDefinition, baked: BakedLightmap): LightmapTexture | null {
  const sel = selectLampVolume(map, baked);
  if (sel.kind === 'none') return null;
  if (sel.kind === 'skip') {
    console.warn(sel.message);
    return null;
  }
  const tex = configureLampVolume(sel.layout);
  const [width, height] = lampVolumeImageSize(sel.layout);
  return {
    file: sel.file,
    tex,
    blank: 0,
    convert: {
      width,
      height,
      fill: (pixels) => lampVolumeRgba(pixels, tex.image.data as Uint8Array),
    },
  };
}

/** uv1 functions for a baked layout: per atlas rect index (−1 = white, −2 = ground projection). */
function lightmapUvs(layout: LightmapLayout): (rect: number) => LmUv {
  const { atlas, ground } = layout;
  const white = [atlas.white.x / atlas.width, atlas.white.y / atlas.height] as const;
  const toWhite: LmUv = () => white;
  const toGround: LmUv = (p) => rectUv(ground.rect, p, ground.width, ground.height);
  return (r) => {
    if (r === -2) return toGround;
    const rect = r >= 0 ? atlas.rects[r] : undefined;
    return rect ? (p) => rectUv(rect, p, atlas.width, atlas.height) : toWhite;
  };
}

/**
 * Whole map → meshes. Compatible spatial material buckets share a BatchedMesh submission,
 * retaining the original per-chunk frustum culling; the skyline backdrop is one mesh per
 * material; flats render in layer order with polygon offset (no z-fighting on the street slab).
 *
 * Baked lighting (maps with a matching bake, see `shared/maps/lightmap.ts`): the same buckets get
 * a `uv1` channel and an aoMap variant of their material — the atlas for walls/roofs/props, the
 * top-down ground projection for the street slab and markings. No extra draw calls. The map is
 * built with its plain materials and loads nothing: `setBakedLighting(…, true)` swaps the baked
 * variants in and starts loading the lightmaps (`bakedLightingReady` waits for them).
 */
export function buildMapMeshes(
  map: MapDefinition,
  materials: MapMaterials,
  opts: MapMeshOptions = {},
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';
  const baked = bakedLightingFor(map, opts);
  const neonAtlas = baked !== null && acceptsMarketNeonStaticBake(map);
  const uvOf = baked ? lightmapUvs(baked.layout) : null;
  const buckets = new Map<string, Bucket>();
  const bucket = (
    mat: MaterialId,
    key: string,
    shadow = true,
    order = 0,
    offset = 0,
  ): GeoBuilder => {
    const k = `${mat}|${key}|${order}`;
    let b = buckets.get(k);
    if (!b) {
      // Street-slab tops (order −1) and markings (order > 0) use the ground projection; every
      // other non-backdrop surface uses the atlas.
      const lm: LightmapKind | null =
        !uvOf || key === 'backdrop' || key === SKYLINE_SATIN_KEY || key.endsWith(DECOR_KEY)
          ? null
          : order === 0
            ? 'atlas'
            : 'ground';
      // Vertices emitted without a lightmap uv fall back to unbaked: the atlas's white texel, or
      // the ground projection (which covers everything at street level).
      const fallback = !uvOf || !lm ? null : uvOf(lm === 'atlas' ? -1 : -2);
      const prop = key.endsWith(DECOR_KEY);
      b = {
        mat,
        g: new GeoBuilder(fallback, WEAR_SURFACES.includes(mat)),
        shadow,
        order,
        offset,
        lm,
        prop,
        shell: key.endsWith('|stone'),
      };
      buckets.set(k, b);
    }
    return b.g;
  };

  const boxFaces = baked?.layout.boxFaces;
  const reach = SANDBAG_LOD_DISTANCE + SANDBAG_CHUNK;
  const bagReach = (x: number, z: number): boolean =>
    x >= map.bounds.minX - reach &&
    x <= map.bounds.maxX + reach &&
    z >= map.bounds.minZ - reach &&
    z <= map.bounds.maxZ + reach;
  const innerFaces = innerContainerFaces(map.boxes);
  map.boxes.forEach((b, bi) => {
    if (b.visible === false) return;
    if (isPalacePorticoColumn(b)) return;
    // Stalls' canopies and food trucks are drawn by render/setDressing.ts (same volume).
    if (b.dress) return;
    // Hero boxes are drawn by render/heroModels.ts (the model, or this box as its fallback);
    // a wreck's collision boxes (heroPart) only as that fallback.
    if (b.hero || b.heroPart) return;
    if (b.model) {
      for (const inst of fitBox(b, PROP_SIZES)) {
        addProp(bucket(b.mat, chunkKey(b.center.x, b.center.z) + DECOR_KEY), inst);
      }
      return;
    }
    if (b.mat === 'sandbag') {
      const ck = `sandbags:${Math.floor(b.center.x / SANDBAG_CHUNK)},${Math.floor(b.center.z / SANDBAG_CHUNK)}`;
      const lm = uvOf && boxFaces ? (f: number) => uvOf(boxFaces[bi * 6 + f]!) : null;
      // Face-local uvs: the 0.95 m face shows exactly the three courses of the texture's wall half.
      // Bags only where an eye inside the playable bounds can come within the LOD distance;
      // the rest of the city is backdrop for this map size: its walls stay boxes (merged with the
      // map chunk like any box, no bag memory, no extra draws).
      if (!bagReach(b.center.x, b.center.z)) {
        addBox(bucket(b.mat, chunkKey(b.center.x, b.center.z)), b, lm, null, true);
        return;
      }
      addBox(bucket(b.mat, `${ck}|far`), b, lm, null, true);
      addSandbagBags(bucket(b.mat, `${ck}|near`), b, lm);
      return;
    }
    addBox(
      bucket(b.mat, chunkKey(b.center.x, b.center.z) + (b.mat === 'facade' ? '|stone' : '')),
      b,
      uvOf && boxFaces ? (f) => uvOf(boxFaces[bi * 6 + f]!) : null,
      b.mat === 'container' ? (f) => innerFaces.has(bi * 6 + f) : null,
    );
  });
  // Dressing retains its actual silhouette even if the downloaded models/textures fail.
  for (const d of map.decor ?? []) {
    for (const inst of fitDecor(d, PROP_SIZES))
      addProp(bucket(DECOR[d.kind].mat, chunkKey(d.x, d.z) + DECOR_KEY), inst);
  }

  // Presentation-only OSM dressing, unbaked and non-casting, in the existing backdrop buckets.
  const skyline = buildSkylineBackdrop(map);
  const skylineSources = new Set(skyline.sources);
  const skylineAttributes = new Map<GeoBuilder, number[]>();
  for (const { mat, key, geometry } of skyline.buckets) {
    const g = bucket(mat, key, false);
    skylineAttributes.set(g, geometry.detail);
    const base = g.vertexCount;
    const c = new THREE.Color();
    for (let i = 0; i < geometry.pos.length / 3; i++) {
      g.vertex(
        { x: geometry.pos[i * 3]!, y: geometry.pos[i * 3 + 1]!, z: geometry.pos[i * 3 + 2]! },
        { x: geometry.nrm[i * 3]!, y: geometry.nrm[i * 3 + 1]!, z: geometry.nrm[i * 3 + 2]! },
        geometry.uv[i * 2]!,
        geometry.uv[i * 2 + 1]!,
        c.setRGB(geometry.col[i * 3]!, geometry.col[i * 3 + 1]!, geometry.col[i * 3 + 2]!),
      );
    }
    for (const index of geometry.idx) g.idx.push(base + index);
  }
  const tint = new THREE.Color();
  (map.prisms ?? []).forEach((p, pi) => {
    if (p.visible === false) return;
    if (skylineSources.has(pi)) return;
    // Client-only tapered needle replaces the final box's visual, preserving map/bake/collision.
    if (isPalaceSpire(p)) return;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of p.pts) {
      cx += x;
      cz += z;
    }
    cx /= p.pts.length;
    cz /= p.pts.length;
    // Street slab pieces go in the coarse ground chunks. Their underside is the tunnel ceiling
    // and their edges line the stair openings, so they keep walls and bottom too.
    const slab = p.y1 <= 0.001 && p.y0 < 0;
    const key = p.backdrop ? 'backdrop' : chunkKey(cx, cz, slab ? GROUND_CHUNK : CHUNK);
    if (p.tint !== undefined) tint.setHex(p.tint, THREE.SRGBColorSpace);
    const c = p.tint !== undefined ? tint : WHITE;
    // Per-face lightmap slots: walls 0..n−1, top n, bottom n + 1 (null = backdrop, unbaked).
    const faces = baked?.layout.prismFaces[pi] ?? null;
    const n = p.pts.length;
    const face = uvOf && faces ? (slot: number): LmUv => uvOf(faces[slot]!) : null;
    // Facade walls with relief (Palace, OSM blocks) are drawn by facadeDetail instead.
    if (!isReliefPrism(p)) addPrismWalls(bucket(p.mat, key, !p.backdrop), p, c, face);
    // Facade caps (soffits such as the Palace portico ceiling, roofs without a `top`) are dressed
    // stone: the painted facade texture's window grid would land on them (black "windows" seen
    // from below). Same shell material and chunk as the facade-stone boxes: no new draw.
    const capKey = (mat: MaterialId): string =>
      mat === 'facade' && !p.backdrop ? `${key}|stone` : key;
    // Slab top: its own bucket (order −1) so it draws after the markings (see renderOrder below).
    addCap(
      bucket(p.top ?? p.mat, capKey(p.top ?? p.mat), !p.backdrop, slab ? -1 : 0),
      p.pts,
      p.y1,
      true,
      p.top ? WHITE : c,
      face ? face(n) : null,
    );
    if (p.y0 > 0.05 || slab) {
      addCap(
        bucket(p.mat, capKey(p.mat), !p.backdrop),
        p.pts,
        p.y0,
        false,
        c,
        face ? face(n + 1) : null,
      );
    }
  });

  const groundUv = uvOf ? uvOf(-2) : null;
  for (const f of map.flats ?? []) {
    const key = chunkKey(f.pts[0]![0], f.pts[0]![1], GROUND_CHUNK);
    const layer = flatDrawLayer(f);
    addFlat(bucket(f.mat, key, false, 1 + layer, layer), f, groundUv);
  }

  const swaps: BakedMap['swaps'] = [];
  const sandbagLods = new Map<string, { near: THREE.Mesh | null; far: THREE.Mesh | null }>();
  const chunks: THREE.Mesh[] = [];
  let unbaked = 0;
  const greybox = new THREE.Group();
  greybox.name = PROP_GREYBOX;
  for (const [k, b] of buckets) {
    const plain = skylineAttributes.has(b.g)
      ? skylineBackdropMaterial(materials)
      : b.shell
        ? materials.facadeShellVariant('stone', addPalaceEntranceStone)
        : b.prop
          ? materials.variant(b.mat, 'prop-fallback', (m) => {
              m.side = THREE.DoubleSide;
            })
          : b.order > 0
            ? flatMaterial(materials, b.mat, b.offset)
            : materials.get(b.mat);
    unbaked += b.g.unbaked;
    let bakedMaterial: THREE.Material | null = null;
    if (baked && b.lm) {
      const tex = (b.lm === 'atlas' ? baked.atlas : baked.ground).tex;
      const lamps = b.lm === 'atlas' ? baked.lamps : null;
      const key = `bake-${b.lm}-${baked.layout.hash}${lamps ? '-lamps' : ''}`;
      const mat = b.shell
        ? materials.facadeShellVariant(`stone|${key}`, (m) => {
            m.aoMap = tex;
            m.aoMapIntensity = BAKED_AO_INTENSITY;
            addPalaceEntranceStone(m);
          })
        : b.order > 0
          ? flatMaterial(materials, b.mat, b.offset, key, tex)
          : materials.variant(b.mat, key, (m) => {
              m.aoMap = tex;
              m.aoMapIntensity = BAKED_AO_INTENSITY;
              if (lamps) addLampLight(m, lamps.tex);
              if (neonAtlas && b.lm === 'atlas' && marketNeonStaticMaterial(b.mat))
                addMarketNeonStaticBake(m);
            });
      bakedMaterial = mat;
    }
    const geometry = b.g.build();
    const skylineDetail = skylineAttributes.get(b.g);
    if (skylineDetail) {
      // Any undecorated backdrop primitives appended to the bucket remain opaque solids.
      const data = new Float32Array(b.g.vertexCount * 4);
      data.set(skylineDetail);
      geometry.setAttribute('aSkyline', new THREE.BufferAttribute(data, 4));
    }
    // Early-Z: draw ground markings first, top layer first, then the street slab, then the
    // rest. Covered slab/marking pixels then fail the depth test before any lighting runs —
    // the ground's overdraw was the largest single cost on integrated GPUs.
    const renderOrder = b.order > 0 ? -10 - b.offset : b.order;
    const item: BuiltBucket = {
      key: k,
      bucket: b,
      plain,
      baked: bakedMaterial,
      geometry,
      renderOrder,
      castShadow: b.shadow && b.order === 0,
    };
    const mesh = addBucketMesh(group, greybox, swaps, item);
    chunks.push(mesh);
    const sb = /\|(sandbags:[^|]+)\|(near|far)\|/.exec(k);
    if (sb) {
      const lod = sandbagLods.get(sb[1]!) ?? { near: null, far: null };
      lod[sb[2] as 'near' | 'far'] = mesh;
      sandbagLods.set(sb[1]!, lod);
      continue;
    }
  }
  for (const [key, { near, far }] of sandbagLods) {
    if (!near || !far) continue;
    // three's LOD measures from its own position: sit it at the chunk's centre (the meshes are
    // in world space, so they move back by as much), levels picked every frame by the renderer.
    const lod = new THREE.LOD();
    lod.name = `map:${key}`;
    far.geometry.computeBoundingSphere();
    const centre = far.geometry.boundingSphere!.center;
    lod.position.copy(centre);
    for (const m of [near, far]) {
      m.position.copy(centre).negate();
      m.updateMatrix();
    }
    lod.addLevel(near, 0);
    lod.addLevel(far, SANDBAG_LOD_DISTANCE, 0.08);
    lod.updateMatrix();
    lod.matrixAutoUpdate = false;
    group.add(lod);
  }
  // Relief walls sample the atlas rects of the walls they replace (projected onto the wall
  // plane, so the recesses read the same texels); walls the layout lacks stay unbaked.
  const facadeBake: FacadeBake | null =
    baked && uvOf
      ? {
          uvFor: (prism, edge) => uvOf(baked.layout.prismFaces[prism]?.[edge] ?? -1),
          unbakedUv: uvOf(-1),
          tex: baked.atlas.tex,
          key: `bake-atlas-${baked.layout.hash}`,
          intensity: BAKED_AO_INTENSITY,
        }
      : null;
  const facade = buildFacadeDetail(map, materials, facadeBake);
  if (facade) {
    group.add(facade);
    swaps.push(...facade.swaps);
  }
  const palaceColumns = buildPalaceColumns(map, materials);
  if (palaceColumns) group.add(palaceColumns);
  if (greybox.children.length) group.add(greybox);
  const batchedSwaps = batchStaticChunks(group, chunks, swaps);
  if (unbaked) {
    console.warn(
      `mapMesh: ${unbaked} vertices of "${map.name}" are outside the lightmap layout, rendered unbaked (buildLightmapLayout must enumerate new geometry; the lead then re-bakes)`,
    );
  }
  if (baked && swaps.length) {
    bakedMaps.set(group, {
      swaps: batchedSwaps,
      textures: [
        baked.atlas,
        baked.ground,
        ...(baked.lamps ? [baked.lamps] : []),
        ...(baked.volume ? [baked.volume] : []),
      ],
      load: opts.loadLightmap ?? fetchLightmap,
      abort: new AbortController(),
      loading: null,
    });
  }
  // Trees, bushes and tall grass (instanced per chunk; see foliageMesh.ts).
  for (const g of buildFoliageLayer(map)) group.add(g);
  return group;
}

/**
 * A flat's draw layer: its map layer, split so flats that share a layer never share a depth.
 * In the OSM layer 2, footpath strips cross lawns; overlapping at an identical lift and polygon
 * offset, their differently triangulated surfaces z-fought (grass shimmering along the path).
 * The path draws over the lawn (as `build-map.groundAt` already decides the ground there); the
 * map data (collision, bakes) is untouched.
 */
export function flatDrawLayer(f: Pick<MapFlat, 'layer' | 'mat'>): number {
  return (f.layer ?? 0) * 2 + (f.mat === 'grass' ? 0 : 1);
}

/** Lift above the surface per draw layer (m): a hair, but distinct for every layer. */
export const FLAT_LIFT = { base: 0.004, perLayer: 0.0015 };

/**
 * Anything laid on the ground at runtime (skid marks, ground bullet holes) must clear every flat:
 * a flat of draw layer L sits `FLAT_LIFT.base + L × perLayer` up (≤ ~2 cm at the Market's top
 * layer 11) with polygon offset (−1 − L, −4 − 2L), so a mark lifted 1.2 cm with (−2, −4) was
 * under the paving flats and never showed. Lift and offset beyond the deepest layer
 * `OVER_FLATS.maxLayer` (a test checks every map's flats stay within it).
 */
export const OVER_FLATS = {
  maxLayer: 13,
  lift: 0.03,
  factor: -16,
  units: -32,
} as const;

function addFlat(g: GeoBuilder, f: MapFlat, lm: LmUv | null): void {
  addCap(g, f.pts, f.y + FLAT_LIFT.base + flatDrawLayer(f) * FLAT_LIFT.perLayer, true, WHITE, lm);
}

/**
 * Flats share the surface but draw with polygon offset by layer (decals on the slab); `bake`
 * names the baked-lighting variant that also samples `aoMap`.
 */
function flatMaterial(
  materials: MapMaterials,
  id: MaterialId,
  layer: number,
  bake?: string,
  aoMap?: THREE.Texture,
): THREE.Material {
  return materials.variant(id, bake ? `flat${layer}|${bake}` : `flat${layer}`, (c) => {
    c.polygonOffset = true;
    c.polygonOffsetFactor = -1 - layer;
    c.polygonOffsetUnits = -4 - layer * 2;
    if (aoMap) {
      c.aoMap = aoMap;
      c.aoMapIntensity = BAKED_AO_INTENSITY;
    }
  });
}
