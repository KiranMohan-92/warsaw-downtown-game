/**
 * Procedural set dressing: market-stall awnings (steel posts, striped canvas with sag and a
 * scalloped hem, produce trays on the counter). Each piece replaces the drawing of one
 * `MapBox.dress` box and fills the same volume (small overhangs: hem and fruit). Timber finishes
 * add at most 4 mm over the existing solid counter/back panels; they retain the original cover.
 * Food trucks are generated hero models
 * (render/heroModels.ts).
 *
 * Built once at load, merged per chunk and material (a handful of draws), identical on every
 * quality tier. Presentation only: nothing here touches the sim.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { quatFromEulerDeg, type MapBox, type MapDefinition } from '@wd/shared';
import { addWetness } from './materials.ts';
import type { MapMaterials } from './materials.ts';
import { findMarketStallFinishes } from './marketStallFinish.ts';
import { installProduceDetail, updateProduceDetail } from './marketProduce.ts';
import { buildMarketStallProps, createMarketSignTexture } from './marketStallProps.ts';
import {
  addStallLight,
  rotateStallLight,
  sampleStallLight,
  setStallLightAttribute,
  STALL_LIGHT_ATTRIBUTE,
  STALL_LIGHT_FIXTURE,
} from './marketStallLighting.ts';
import { batchStaticChunks } from './staticBatches.ts';

type MatKey = 'matte' | 'wood' | 'canvas' | 'produce' | 'fruit' | 'metal' | 'lamp' | 'sign';

/** Materials whose pieces are big enough to be worth the shadow pass. */
const SHADOW_MATS: ReadonlySet<MatKey> = new Set(['canvas']);

/** Metres per chunk (same order as the map mesh: culling without many draws). */
const CHUNK = 64;
/** Produce is small: drawn within this distance of its chunk (every tier alike). */
export const FRUIT_CHUNK = 32;
export const FRUIT_DISTANCE = 10;
/** Small finishes and signs share one near-only policy on every tier. Cover stays permanent. */
export const STALL_DETAIL_DISTANCE = 20;
const STALL_DETAIL_HYSTERESIS = 6;
const STALL_DETAIL_CHUNK = 16;

interface DressingCell {
  bounds: THREE.Box3;
  sphere: THREE.Sphere;
  start: number;
  count: number;
  visible: boolean;
  active: boolean;
}
interface DressingBatch {
  detail: boolean;
  cells: DressingCell[];
  source: THREE.BufferAttribute['array'];
}
const dressingBatches = new WeakMap<THREE.Mesh, DressingBatch>();

/** Deterministic 0..1 from a position and a salt (every client dresses a stall the same way). */
function rand(x: number, z: number, salt: number): () => number {
  let s = (Math.imul(Math.round(x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.round(z * 10)) + salt;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Collects coloured pieces in one box's local frame, then bakes them into world space. */
class Kit {
  readonly parts = new Map<MatKey, THREE.BufferGeometry[]>();
  /** Fruit and veg: instanced (hundreds per stall row), world matrix and colour each. */
  readonly fruit: { m: THREE.Matrix4; color: THREE.Color; light: THREE.Vector4 }[] = [];
  constructor(
    private readonly frame: THREE.Matrix4,
    private readonly stallLight = false,
  ) {}

  /** One piece of produce: a unit sphere scaled to `r × squash`, local position/rotation. */
  addFruit(
    r: number,
    squash: [number, number, number],
    color: number,
    at: [number, number, number],
    rot: [number, number, number],
    jitter: number,
    rnd: () => number,
  ): void {
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    const m = new THREE.Matrix4().compose(
      _p.set(...at),
      _q,
      _s.set(r * squash[0], r * squash[1], r * squash[2]),
    );
    m.premultiply(this.frame);
    const c = new THREE.Color().setHex(color, THREE.SRGBColorSpace);
    c.multiplyScalar(1 - jitter + rnd() * jitter * 2);
    const light = this.stallLight
      ? rotateStallLight(sampleStallLight(_p.set(...at)), this.frame)
      : new THREE.Vector4();
    this.fruit.push({ m, color: c, light });
  }

  add(
    geo: THREE.BufferGeometry,
    mat: MatKey,
    color: number,
    at: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    jitter = 0,
    rnd?: () => number,
  ): void {
    // Indexed throughout (the post-transform cache: a third of the vertex work of a soup).
    if (!geo.index) {
      const n = geo.getAttribute('position').count;
      geo.setIndex([...Array(n).keys()]);
    }
    const g = geo;
    _c.setHex(color, THREE.SRGBColorSpace);
    if (jitter && rnd) _c.multiplyScalar(1 - jitter + rnd() * jitter * 2);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([_c.r, _c.g, _c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.getAttribute('uv'))
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    _m.compose(_p.set(...at), _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    if (mat !== 'lamp') setStallLightAttribute(g, this.stallLight ? this.frame : undefined);
    g.applyMatrix4(this.frame);
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }
}

const box = (w: number, h: number, d: number): THREE.BufferGeometry =>
  new THREE.BoxGeometry(w, h, d);

/** Metre-scale grain: long tray faces and their bases share a physical timber scale. */
function trayBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const geo = box(w, h, d);
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < p.count; i++) {
    // Horizontal grain along the longer member, with end grain kept at the same scale.
    const alongZ = d > w;
    const side = Math.abs(n.getY(i)) < 0.5;
    const end = alongZ ? Math.abs(n.getZ(i)) > 0.5 : Math.abs(n.getX(i)) > 0.5;
    const u = alongZ !== end ? p.getZ(i) : p.getX(i);
    const v = side ? p.getY(i) : alongZ ? p.getX(i) : p.getZ(i);
    uv.setXY(i, u + 0.73, v + 0.41);
  }
  return geo;
}
const tube = (r: number, len: number, seg = 6): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(r, r, len, seg, 1, true);

// ---- stall awning -------------------------------------------------------------------------------

const CANVAS_CREAM = 0xefe6cf;
const STRIPES = 8;
const PRODUCE: readonly { color: number; r: number; squash?: [number, number, number] }[] = [
  { color: 0xb3261e, r: 0.038 }, // apples
  { color: 0xe0801e, r: 0.04 }, // oranges
  { color: 0xe8cf3a, r: 0.033, squash: [1.25, 0.9, 0.9] }, // lemons
  { color: 0xc8321f, r: 0.032 }, // tomatoes
  { color: 0x9b7b4f, r: 0.04, squash: [1.3, 0.75, 1] }, // potatoes
  { color: 0xb07a3a, r: 0.034 }, // onions
  { color: 0x3d8a2a, r: 0.036, squash: [1, 1.2, 1] }, // peppers
  { color: 0x7a3a8c, r: 0.03, squash: [1.1, 0.9, 1] }, // plums
];

/**
 * Canvas surface over the canopy box: sloping back-to-front with a soft sag between the posts.
 * Local frame = the canopy box (centre at the canopy, +z = the counter side).
 */
function canvasY(x: number, z: number, hw: number, hd: number): number {
  const slope = 0.07 * (-z / hd); // back high, front low
  const sag =
    -0.035 * Math.sin((Math.PI * (x + hw)) / (2 * hw)) * Math.sin((Math.PI * (z + hd)) / (2 * hd));
  return slope + sag;
}

/** Canvas texture tile (m): the weave/stain maps repeat every half metre of cloth. */
export const CANVAS_TILE = 0.5;

/**
 * A grid strip across x0..x1. UVs are cloth metres / `CANVAS_TILE` (x across, distance along
 * the surface the other way), so the weave has one real size on every stall and on the hem.
 */
function stripGeometry(
  x0: number,
  x1: number,
  cols: number,
  rows: number,
  at: (x: number, t: number) => [number, number, number],
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = new Array<number>((rows + 1) * (cols + 1) * 2).fill(0);
  const idx: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const x = x0 + ((x1 - x0) * i) / cols;
    let along = 0;
    let prev = at(x, 0);
    for (let j = 0; j <= rows; j++) {
      const p = at(x, j / rows);
      along += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      prev = p;
      uv[(j * (cols + 1) + i) * 2] = x / CANVAS_TILE;
      uv[(j * (cols + 1) + i) * 2 + 1] = along / CANVAS_TILE;
    }
  }
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const x = x0 + ((x1 - x0) * i) / cols;
      pos.push(...at(x, j / rows));
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      idx.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Valance depth (m) at `u` across one stripe (0..1): two scallops, cusps at 0, ½ and 1. */
export function hemDrop(u: number): number {
  const s = (((u * 2) % 1) + 1) % 1;
  return 0.085 + 0.08 * Math.sqrt(Math.max(0, Math.sin(Math.PI * s)));
}

function dressStall(kit: Kit, b: MapBox): void {
  const hw = b.size.x / 2;
  const hd = b.size.z / 2;
  const ground = -2.33; // canopy box centre is 2.33 m above the stall's floor
  const rnd = rand(b.center.x, b.center.z, 7);
  const tint = b.tint ?? 0xa8312e;
  // Canvas stripes (separate strips: crisp colour edges) and the scalloped front hem.
  const sw = (2 * hw) / STRIPES;
  for (let s = 0; s < STRIPES; s++) {
    const x0 = -hw + s * sw;
    const x1 = x0 + sw;
    const color = s % 2 ? CANVAS_CREAM : tint;
    kit.add(
      stripGeometry(x0, x1, 2, 6, (x, t) => {
        const z = -hd + t * 2 * hd;
        return [x, canvasY(x, z, hw, hd), z];
      }),
      'canvas',
      color,
      [0, 0, 0],
    );
    kit.add(
      stripGeometry(x0, x1, 16, 2, (x, t) => {
        const top = canvasY(x, hd, hw, hd);
        // Two round scallops per stripe with pointed cusps between them (a sewn valance).
        const drop = hemDrop((x - x0) / sw);
        return [x, top - t * drop, hd + 0.01 + t * 0.03 + t * t * 0.01];
      }),
      'canvas',
      color,
      [0, 0, 0],
    );
  }
  // Steel posts at the corners and a front rail under the hem.
  for (const [px, pz] of [
    [-hw + 0.08, hd - 0.06],
    [hw - 0.08, hd - 0.06],
    [-hw + 0.08, -hd + 0.06],
    [hw - 0.08, -hd + 0.06],
  ] as const) {
    const top = canvasY(px, pz, hw, hd) - 0.01;
    const len = top - ground;
    // Grimy, scuffed foot (splash dirt reaches ~25 cm) under the clean upper post.
    const foot = 0.26;
    kit.add(tube(0.022, len - foot), 'metal', 0x7d8285, [px, ground + foot + (len - foot) / 2, pz]);
    kit.add(tube(0.0225, foot), 'metal', 0x3b3833, [px, ground + foot / 2, pz]);
    // Cast-iron weight plate the post stands in, dark where it meets the paving.
    kit.add(new THREE.CylinderGeometry(0.066, 0.072, 0.03, 12), 'matte', 0x24221f, [
      px,
      ground + 0.015,
      pz,
    ]);
  }
  kit.add(
    tube(0.018, 2 * hw - 0.16),
    'metal',
    0x7d8285,
    [0, canvasY(0, hd - 0.06, hw, hd) - 0.03, hd - 0.06],
    [0, 0, Math.PI / 2],
  );
  // One warm strip under the front of the awning: small geometry, with the actual light baked
  // into nearby vertices/instances at load time.
  kit.add(
    box(STALL_LIGHT_FIXTURE.width + 0.08, 0.035, STALL_LIGHT_FIXTURE.depth + 0.04),
    'metal',
    0x25282b,
    [
      STALL_LIGHT_FIXTURE.center.x,
      STALL_LIGHT_FIXTURE.center.y + 0.016,
      STALL_LIGHT_FIXTURE.center.z,
    ],
  );
  kit.add(box(STALL_LIGHT_FIXTURE.width, 0.012, STALL_LIGHT_FIXTURE.depth), 'lamp', 0xffe7bd, [
    STALL_LIGHT_FIXTURE.center.x,
    STALL_LIGHT_FIXTURE.center.y - 0.006,
    STALL_LIGHT_FIXTURE.center.z,
  ]);
  // Produce trays on the counter (counter: 3 × 0.7 m at local z 0.25..0.95, top 1.0 m).
  const counterTop = ground + 1.0;
  const trayW = 0.86;
  const trayD = 0.5;
  for (const tx of [-0.95, 0, 0.95]) {
    const kind = PRODUCE[Math.floor(rnd() * PRODUCE.length)]!;
    const wood = 0xeee4d5; // neutral variation over the existing timber albedo
    const tz = 0.6;
    const y = counterTop;
    kit.add(trayBox(trayW, 0.015, trayD), 'wood', wood, [tx, y + 0.008, tz], undefined, 0.1, rnd);
    for (const sz of [-1, 1]) {
      kit.add(trayBox(trayW, 0.08, 0.012), 'wood', wood, [tx, y + 0.04, tz + (sz * trayD) / 2]);
      kit.add(trayBox(0.012, 0.08, trayD), 'wood', wood, [tx + (sz * trayW) / 2, y + 0.04, tz]);
    }
    // The tray reads full at any distance: a painted produce surface (two triangles); up close
    // real fruit sits on it (instanced, FRUIT_DISTANCE).
    const bed = new THREE.PlaneGeometry(trayW - 0.03, trayD - 0.03);
    bed.rotateX(-Math.PI / 2);
    const tile = PRODUCE.indexOf(kind);
    const uv = bed.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, (tile + uv.getX(i)) / PRODUCE.length);
    kit.add(bed, 'produce', 0xffffff, [tx, y + 0.05, tz]);
    const step = kind.r * 2.05;
    const nx = Math.floor((trayW - 0.04) / step);
    const nz = Math.floor((trayD - 0.04) / step);
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const fx = tx - ((nx - 1) * step) / 2 + i * step + (rnd() - 0.5) * kind.r * 0.3;
        const fz = tz - ((nz - 1) * step) / 2 + k * step + (rnd() - 0.5) * kind.r * 0.3;
        const squash = kind.squash ?? [1, 1, 1];
        kit.addFruit(
          kind.r,
          squash,
          kind.color,
          [fx, y + 0.045 + kind.r * squash[1] * 0.8, fz],
          [rnd() * 3, rnd() * 3, rnd() * 3],
          0.14,
          rnd,
        );
      }
    }
  }
}

// ---- assembly -----------------------------------------------------------------------------------

let shared: Record<MatKey, THREE.Material> | null = null;

/** The dressing materials (vertex-coloured; shared by every piece on every tier). */
export function setDressingMaterials(): Record<MatKey, THREE.Material> {
  if (shared) return shared;
  const std = (p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...p });
    addWetness(m);
    return m;
  };
  shared = {
    matte: std({ roughness: 0.86, metalness: 0 }),
    fruit: std({ roughness: 0.62, metalness: 0 }),
    wood: std({ color: 0x9a7b55, roughness: 0.86, metalness: 0 }),
    canvas: std({ roughness: 1, metalness: 0, side: THREE.DoubleSide, ...canvasMaps() }),
    produce: std({ vertexColors: false, map: produceTexture(), roughness: 0.62, metalness: 0 }),
    metal: std({ roughness: 0.38, metalness: 0.85 }),
    sign: std({
      map: createMarketSignTexture(),
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    // Light fixtures: unlit warm white (bloom makes them glow on Medium+).
    lamp: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };
  for (const [k, m] of Object.entries(shared)) m.name = `dress:${k}`;
  return shared;
}

// ---- canvas weave (procedural, tileable) --------------------------------------------------------

function whash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Tileable value noise at integer period `p`. */
function wnoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const v = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
  const m = (a: number): number => ((a % p) + p) % p;
  const a = whash(m(xi), m(yi), seed);
  const b = whash(m(xi + 1), m(yi), seed);
  const c = whash(m(xi), m(yi + 1), seed);
  const d = whash(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Texels per canvas tile, and weave threads across it (≈5 mm threads: a fine sheen up close, gone by a few metres). */
export const CANVAS_TEX = 256;
const THREADS = 96;

/** Plain-weave height at tile coords (0..1): the thread on top at each crossing, rounded. */
export function weaveHeight(u: number, v: number): number {
  const tu = u * THREADS;
  const tv = v * THREADS;
  const i = Math.floor(tu);
  const j = Math.floor(tv);
  const warpTop = (i + j) % 2 === 0;
  const across = Math.sin(Math.PI * (tu - i)); // warp thread profile
  const along = Math.sin(Math.PI * (tv - j)); // weft thread profile
  const top = warpTop ? across * (0.6 + 0.4 * along) : along * (0.6 + 0.4 * across);
  // Soft creases (tileable) under the weave.
  const crease = wnoise(u * 2, v * 2, 2, 5) * 0.8;
  return 0.2 + 0.18 * top + 0.62 * crease;
}

interface CanvasMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
}
let canvasCache: CanvasMaps | null = null;

/**
 * Canvas maps, one `CANVAS_TILE` each: albedo = a grey multiplier on the stripe colour (thread
 * shading, weathered blotches, faint water stains), normal = the weave + creases, roughness =
 * matte cloth, a little smoother where worn. Shared by every stall; created before warm-up.
 */
export function canvasMaps(): CanvasMaps {
  if (canvasCache) return canvasCache;
  const n = CANVAS_TEX;
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = weaveHeight(x / n, y / n);
  const at = (x: number, y: number): number => h[((y + n) % n) * n + ((x + n) % n)]!;
  const albedo = new Uint8Array(n * n * 4);
  const normal = new Uint8Array(n * n * 4);
  const rough = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = x / n;
      const v = y / n;
      const hv = h[i]!;
      const blotch = wnoise(u * 4, v * 4, 4, 17);
      const stain = Math.max(0, wnoise(u * 2, v * 2, 2, 29) - 0.62) * 2.2;
      const k = (0.9 + 0.1 * hv) * (0.88 + 0.12 * blotch) * (1 - 0.2 * stain);
      albedo.set([k * 255, k * 255, k * 255, 255], i * 4);
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.9 * (n / 64);
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.9 * (n / 64);
      const len = Math.hypot(dx, dy, 1);
      normal.set(
        [
          ((-dx / len) * 0.5 + 0.5) * 255,
          ((dy / len) * 0.5 + 0.5) * 255,
          ((1 / len) * 0.5 + 0.5) * 255,
          255,
        ],
        i * 4,
      );
      rough.set([255, (0.93 - 0.1 * hv - 0.08 * (1 - blotch)) * 255, 255, 255], i * 4);
    }
  }
  const tex = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  canvasCache = {
    map: tex(albedo, true),
    normalMap: tex(normal, false),
    roughnessMap: tex(rough, false),
  };
  return canvasCache;
}

/**
 * Packed produce, one tile per PRODUCE kind across the texture (tile = one tray, 0.83 × 0.47 m):
 * shaded discs with a highlight over dark gaps, laid out like the instanced fruit.
 */
function produceTexture(): THREE.DataTexture {
  const T = 128;
  const W = T * PRODUCE.length;
  const data = new Uint8Array(W * T * 4);
  const pxU = T / 0.83;
  const pxV = T / 0.47;
  const c = new THREE.Color();
  PRODUCE.forEach((kind, k) => {
    c.setHex(kind.color); // sRGB bytes straight into an sRGB texture
    const [r0, g0, b0] = [c.r, c.g, c.b];
    const [sx, , sz] = kind.squash ?? [1, 1, 1];
    const step = kind.r * 2.05;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const mx = x / pxU;
        const mz = y / pxV;
        // Offset rows (hex-ish packing) and a per-row jitter.
        const row = Math.floor(mz / step);
        const ox = row % 2 ? step / 2 : 0;
        const cx = (Math.floor((mx + ox) / step) + 0.5) * step - ox;
        const cz = (row + 0.5) * step;
        const dx = (mx - cx) / (kind.r * sx);
        const dz = (mz - cz) / (kind.r * sz);
        const d2 = dx * dx + dz * dz;
        const i = (y * W + k * T + x) * 4;
        let shade = 0.28;
        if (d2 < 1) {
          const h = Math.sqrt(1 - d2);
          shade = 0.45 + 0.6 * h;
          const spec = Math.max(0, 1 - ((dx + 0.35) ** 2 + (dz + 0.35) ** 2) * 9);
          shade += spec * 0.35;
        }
        const v = (ch: number): number => Math.round(Math.min(1, ch * shade) * 255);
        data[i] = v(r0);
        data[i + 1] = v(g0);
        data[i + 2] = v(b0);
        data[i + 3] = 255;
      }
    }
  });
  const tex = new THREE.DataTexture(data, W, T, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let fruitGeo: THREE.BufferGeometry | null = null;
/** Unit low-poly sphere (indexed, shared by every piece of produce), white vertex colour. */
function fruitGeometry(): THREE.BufferGeometry {
  if (fruitGeo) return fruitGeo;
  const g = new THREE.SphereGeometry(1, 6, 4);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  fruitGeo = g;
  return g;
}

const _eye = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _viewProjection = new THREE.Matrix4();
const _cellSphere = new THREE.Sphere();
/** Repack only when an original cell crosses its distance or camera-frustum boundary. */
function updateDressingBatch(
  mesh: THREE.Mesh<THREE.BufferGeometry>,
  groupMatrix: THREE.Matrix4,
  frustum?: THREE.Frustum,
): void {
  const batch = dressingBatches.get(mesh)!;
  let changed = false;
  for (const cell of batch.cells) {
    const reach = STALL_DETAIL_DISTANCE + (cell.visible ? STALL_DETAIL_HYSTERESIS : 0);
    cell.visible = !batch.detail || cell.bounds.distanceToPoint(_eye) <= reach;
    const active =
      cell.visible &&
      (!frustum ||
        frustum.intersectsSphere(_cellSphere.copy(cell.sphere).applyMatrix4(groupMatrix)));
    if (active !== cell.active) changed = true;
    cell.active = active;
  }
  if (!changed) return;
  const index = mesh.geometry.getIndex()!;
  let count = 0;
  for (const cell of batch.cells) {
    if (!cell.active) continue;
    index.array.set(batch.source.subarray(cell.start, cell.start + cell.count), count);
    count += cell.count;
  }
  if (count > 0) index.addUpdateRange(0, count);
  index.needsUpdate = true;
  mesh.geometry.setDrawRange(0, count);
  mesh.visible = count > 0;
}

/** Per frame: produce shows within `FRUIT_DISTANCE` of the camera (same on every tier). */
export function updateSetDressing(
  group: THREE.Object3D,
  eye: THREE.Vector3,
  camera?: THREE.Camera,
): void {
  _eye.copy(eye);
  if (camera) {
    camera.updateWorldMatrix(true, false);
    group.updateWorldMatrix(true, false);
    _frustum.setFromProjectionMatrix(
      _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
  }
  for (const o of group.children) {
    const mesh = o instanceof THREE.Mesh ? (o as THREE.Mesh<THREE.BufferGeometry>) : null;
    if (mesh && dressingBatches.has(mesh)) {
      updateDressingBatch(mesh, group.matrixWorld, camera ? _frustum : undefined);
      continue;
    }
    if (!(o instanceof THREE.InstancedMesh) || !o.userData.fruit) continue;
    o.visible = o.boundingBox!.distanceToPoint(_eye) <= FRUIT_DISTANCE;
  }
  updateProduceDetail(group, eye);
}

/** Recessed ceiling light (metro strips, hall panels): a dark housing, a glowing diffuser. */
function dressLightPanel(kit: Kit, b: MapBox): void {
  const { x: w, y: h, z: d } = b.size;
  kit.add(box(w, h, d), 'metal', 0x2b2f33, [0, 0, 0]);
  kit.add(box(w - 0.05, 0.012, d - 0.05), 'lamp', 0xfff0d8, [0, -h / 2 - 0.006, 0]);
}

/** Hanging industrial lamp (hall roof): cable, dark metal shade, a glowing bulb face. */
function dressPendant(kit: Kit, b: MapBox): void {
  const { y: h } = b.size;
  kit.add(box(0.015, h - 0.25, 0.015), 'metal', 0x1d1f21, [0, 0.125, 0]);
  const shade = new THREE.CylinderGeometry(0.06, 0.24, 0.22, 16, 1, true);
  kit.add(shade, 'metal', 0x2e3a36, [0, -h / 2 + 0.14, 0]);
  kit.add(
    new THREE.CircleGeometry(0.2, 16),
    'lamp',
    0xffe9c4,
    [0, -h / 2 + 0.035, 0],
    [Math.PI / 2, 0, 0],
  );
}

const DRESSERS: Record<NonNullable<MapBox['dress']>, (kit: Kit, b: MapBox) => void> = {
  stallAwning: dressStall,
  lightPanel: dressLightPanel,
  pendant: dressPendant,
};

/** All dressed set pieces of a map, merged per chunk and material. */
export function buildSetDressing(map: MapDefinition, materials?: MapMaterials): THREE.Group {
  const group = new THREE.Group();
  group.name = 'dressing';
  const mats = { ...setDressingMaterials() };
  if (materials) {
    // Shared maps/settings, with fixture shading confined to dressed timber.
    mats.wood = materials.variant('wood', 'market-strip-light', addStallLight);
  }
  for (const m of Object.values(mats)) addStallLight(m);
  const finishes = findMarketStallFinishes(map);
  const chunks = new Map<string, Map<MatKey, THREE.BufferGeometry[]>>();
  const detailChunks = new Map<string, Map<MatKey, THREE.BufferGeometry[]>>();
  const fruitChunks = new Map<string, Kit['fruit']>();
  const frame = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (const b of map.boxes) {
    if (!b.dress) continue;
    const r = quatFromEulerDeg(b.rot);
    frame.compose(
      _p.set(b.center.x, b.center.y, b.center.z),
      q.set(r.x, r.y, r.z, r.w),
      _s.set(1, 1, 1),
    );
    const kit = new Kit(frame.clone(), b.dress === 'stallAwning');
    DRESSERS[b.dress](kit, b);
    const detail = new Kit(frame.clone(), b.dress === 'stallAwning');
    for (const piece of finishes.get(b) ?? [])
      detail.add(piece.geo, piece.mat, piece.color, piece.at, piece.rot);
    if (finishes.has(b))
      for (const piece of buildMarketStallProps(b))
        detail.add(piece.geo, piece.mat, piece.color, piece.at, piece.rot);
    if (detail.parts.size) {
      const key = `${Math.floor(b.center.x / STALL_DETAIL_CHUNK)},${Math.floor(b.center.z / STALL_DETAIL_CHUNK)}`;
      const chunk = detailChunks.get(key) ?? new Map<MatKey, THREE.BufferGeometry[]>();
      for (const [mat, list] of detail.parts) chunk.set(mat, [...(chunk.get(mat) ?? []), ...list]);
      detailChunks.set(key, chunk);
    }
    const key = `${Math.floor(b.center.x / CHUNK)},${Math.floor(b.center.z / CHUNK)}`;
    const chunk = chunks.get(key) ?? new Map<MatKey, THREE.BufferGeometry[]>();
    for (const [mat, list] of kit.parts) chunk.set(mat, [...(chunk.get(mat) ?? []), ...list]);
    chunks.set(key, chunk);
    if (kit.fruit.length) {
      const fk = `${Math.floor(b.center.x / FRUIT_CHUNK)},${Math.floor(b.center.z / FRUIT_CHUNK)}`;
      fruitChunks.set(fk, [...(fruitChunks.get(fk) ?? []), ...kit.fruit]);
    }
  }
  const sphere = fruitGeometry();
  for (const [key, list] of fruitChunks) {
    const geo = sphere.clone();
    const light = new Float32Array(list.length * 4);
    list.forEach((f, i) => light.set(f.light.toArray(), i * 4));
    geo.setAttribute(STALL_LIGHT_ATTRIBUTE, new THREE.InstancedBufferAttribute(light, 4));
    const mesh = new THREE.InstancedMesh(geo, mats.fruit, list.length);
    list.forEach((f, i) => {
      mesh.setMatrixAt(i, f.m);
      mesh.setColorAt(i, f.color);
    });
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.name = `dressing:fruit|${key}`;
    mesh.castShadow = false; // centimetre-scale: not worth the shadow pass
    mesh.receiveShadow = false;
    mesh.userData.fruit = true;
    group.add(mesh);
  }
  const casterMeshes: THREE.Mesh[] = [];
  for (const [key, chunk] of chunks) {
    for (const [mat, list] of chunk) {
      if (!SHADOW_MATS.has(mat)) continue;
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats[mat]);
      mesh.name = `dressing:${mat}|${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      casterMeshes.push(mesh);
    }
  }
  batchStaticChunks(group, casterMeshes, []);
  // Casters retain their original cells so off-camera canvas still casts shadows.
  mergeDressingBatches(group, chunks, mats, false);
  mergeDressingBatches(group, detailChunks, mats, true);
  if (fruitChunks.size) installProduceDetail(group, mats.fruit);
  return group;
}

/** One draw per material, with the original cells' distance and frustum reach intact. */
function mergeDressingBatches(
  group: THREE.Group,
  chunks: Map<string, Map<MatKey, THREE.BufferGeometry[]>>,
  mats: Record<MatKey, THREE.Material>,
  detail: boolean,
): void {
  const batches = new Map<MatKey, { parts: THREE.BufferGeometry[]; cells: DressingCell[] }>();
  for (const chunk of chunks.values()) {
    for (const [mat, list] of chunk) {
      if (!detail && SHADOW_MATS.has(mat)) continue;
      const geo = mergeGeometries(list, false);
      for (const part of list) part.dispose();
      if (!geo) throw new Error(`Dressing: incompatible geometry for ${mat}`);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const batch = batches.get(mat) ?? { parts: [], cells: [] };
      const previous = batch.cells.at(-1);
      batch.cells.push({
        bounds: geo.boundingBox!.clone(),
        sphere: geo.boundingSphere!.clone(),
        start: previous ? previous.start + previous.count : 0,
        count: geo.getIndex()!.count,
        visible: true,
        active: true,
      });
      batch.parts.push(geo);
      batches.set(mat, batch);
    }
  }
  for (const [mat, batch] of batches) {
    const geo = mergeGeometries(batch.parts, false);
    for (const part of batch.parts) part.dispose();
    if (!geo) throw new Error(`Dressing: incompatible merged geometry for ${mat}`);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const index = geo.getIndex()!;
    index.setUsage(THREE.DynamicDrawUsage);
    const mesh = new THREE.Mesh(geo, mats[mat]);
    mesh.name = `dressing:${detail ? 'detail:' : ''}${mat}|merged`;
    mesh.userData.stallDetail = detail;
    mesh.castShadow = false;
    mesh.receiveShadow = !detail;
    mesh.matrixAutoUpdate = false;
    dressingBatches.set(mesh, { detail, cells: batch.cells, source: index.array.slice() });
    group.add(mesh);
  }
}
