import * as THREE from 'three';
import type { MaterialId } from '@wd/shared';
import { FACADE_WINDOW, STOREY } from './facadeRelief.ts';
import {
  SURFACE_TILE_METRES,
  TEXTURED_SURFACES,
  albedoStats,
  isTextured,
  loadSurfaceSets,
  paletteGain,
  withTimeout,
  type SurfaceMaps,
  type TexturedSurface,
} from './surfaceTextures.ts';
import { addGroundDetail, GROUND_DETAIL_SURFACES } from './groundDetail.ts';
import { RAIN_OCCLUSION_GLSL, rainOcclusion } from './rainOcclusion.ts';
import { addWearDetail, WEAR_SURFACES } from './wearDetail.ts';
import { addCourtyardBake } from './courtyardBake.ts';
import { addMarketNeonBake } from './marketNeonBake.ts';
import { restorePalaceColumnMaps } from './palaceColumnMaterial.ts';
import { setPalaceEntranceGrid } from './palaceEntranceStone.ts';
import { palaceReliefMask } from './palaceReliefMask.ts';

/**
 * Map surfaces. Every surface starts with procedural PBR maps generated at construction (albedo
 * variation, normal, roughness; no downloads), so the map is always drawable. `loadTextures`
 * then swaps in the scanned CC0 sets (surfaceTextures.ts) where they exist, before
 * `Game.warmUp`: same material, same maps present, so the same shader programs, just different
 * texture objects. A set that fails to load keeps its procedural maps. Every map material also
 * gets a shared `uWetness` hook so rain darkens surfaces and makes horizontal ones glossy.
 */

const SIZE = 512;
/** World metres covered by one texture tile. */
const TILE_METRES = 2;

// ---- noise ------------------------------------------------------------------------------------
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Tileable value noise at integer period `p`. */
function vnoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  // Wrapped lattice coords (no per-call closure: this runs millions of times at load).
  const x0 = ((xi % p) + p) % p;
  const y0 = ((yi % p) + p) % p;
  const x1 = (((xi + 1) % p) + p) % p;
  const y1 = (((yi + 1) % p) + p) % p;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Tileable fBm in [0,1]. `base` = lowest frequency in cells per tile. */
function fbm(
  nx: number,
  ny: number,
  base: number,
  octaves: number,
  seed: number,
  sx = 1,
  sy = 1,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = base;
  for (let o = 0; o < octaves; o++) {
    sum +=
      amp *
      vnoise(
        nx * f * sx,
        ny * f * sy,
        Math.max(1, Math.round(f * Math.max(sx, sy))),
        seed + o * 17,
      );
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

interface Surface {
  color: string;
  /** Albedo variation amount (±). */
  variation: number;
  roughness: number;
  roughnessVar: number;
  metalness: number;
  normalStrength: number;
  /** Height field in [0,1] for normalised tile coords (0..1). */
  height: (u: number, v: number) => number;
  /** Optional albedo multiplier from the same coords (joints, speckles). */
  tint?: (u: number, v: number, h: number) => number;
  /** Optional roughness override (e.g. glossy window panes in a matte wall). */
  rough?: (u: number, v: number, h: number) => number | undefined;
  /** World metres per texture tile (default 2). Facades tile per storey. */
  tile?: number;
  /** Optional per-channel albedo multiplier (rust, soot hues) on top of `tint`. */
  hue?: (u: number, v: number, h: number) => readonly [number, number, number];
}

/** Wreck sheet metal: which panel a tile coord is in, and the distance to its seams (tile units). */
function wreckPanel(u: number, v: number): { seam: number; rivet: boolean; id: number } {
  // 0.75 × 0.6 m panels in a 3 m tile (4 × 5), rows offset like riveted skin.
  const row = Math.floor(v * 5);
  const uu = u * 4 + (row % 2) * 0.5;
  const col = Math.floor(uu);
  const du = Math.min(uu - col, 1 - (uu - col)) / 4; // tile units to the vertical seam
  const dv = Math.min(v * 5 - row, 1 - (v * 5 - row)) / 5;
  const seam = Math.min(du, dv);
  // Rivet lines ≈1.8 cm inside each seam, one every 9 cm.
  const onLine = (d: number): boolean => Math.abs(d - 0.006) < 0.0022;
  const pitch = 0.03; // tile units (9 cm)
  const alongU = Math.abs(((u / pitch) % 1) - 0.5) < 0.12;
  const alongV = Math.abs(((v / pitch) % 1) - 0.5) < 0.12;
  const rivet = (onLine(dv) && alongU) || (onLine(du) && alongV);
  return { seam, rivet, id: hash2(((col % 4) + 4) % 4, row, 191) };
}

/**
 * Sandbag texture layout (1.9 m tile): the lower half (v < `SANDBAG_BURLAP_V`) is a wall of three
 * courses — what a far sandbag box shows over its 0.95 m height (render/mapMesh draws its faces
 * with face-local uvs); the upper half is plain burlap at real scale, which the near bags
 * (render/sandbagWall.ts) wrap round themselves.
 */
export const SANDBAG_BURLAP_V = 0.5;

/** Sandbag wall: which bag a tile coord is in and where inside it (0..1 each way). */
function sandbagCell(u: number, v: number): { bu: number; bv: number; id: number } {
  // 1.9 m tile: 6 courses of 0.317 m (three per 0.95 m wall), three 0.63 m bags each, half-bond.
  const row = Math.floor(v * 6);
  const uu = u * 3 + (row % 2) * 0.5;
  const col = Math.floor(uu);
  return { bu: uu - col, bv: v * 6 - row, id: hash2(((col % 3) + 3) % 3, row, 211) };
}

/** Soot and rust fields; memoised for the texel `makeMaps` is on (tint, hue, rough ask in turn). */
const wreckMemo = { u: NaN, v: NaN, soot: 0, rust: 0 };
function wreckFields(u: number, v: number): { soot: number; rust: number } {
  if (u !== wreckMemo.u || v !== wreckMemo.v) {
    wreckMemo.u = u;
    wreckMemo.v = v;
    wreckMemo.soot = Math.max(0, Math.min(1, (fbm(u, v, 2, 4, 181) - 0.42) * 3.2));
    wreckMemo.rust = Math.max(0, Math.min(1, (fbm(u, v, 3, 4, 183) - 0.5) * 3.5));
  }
  return wreckMemo;
}

const windowMask = (u: number, v: number): boolean =>
  u > FACADE_WINDOW.u0 && u < FACADE_WINDOW.u1 && v > FACADE_WINDOW.v0 && v < FACADE_WINDOW.v1;

function ashlarCoords(
  u: number,
  v: number,
): {
  course: number;
  vertical: number;
  block: number;
  row: number;
  col: number;
  joint: number;
  edge: number;
} {
  const row = Math.floor(v * 3);
  const block = row % 2 === 0 ? u * 2 : u * 2 + 0.5;
  const col = Math.floor(block);
  const course = Math.abs(((v * 3) % 1) - 0.5) * 2;
  const vertical = Math.abs((block % 1) - 0.5) * 2;
  const joint = Math.max(course, vertical);
  return {
    course,
    vertical,
    block,
    row,
    col,
    joint,
    edge: Math.max(0, Math.min(1, (joint - 0.84) / 0.16)),
  };
}

function ashlarHeight(u: number, v: number): number {
  const { joint, edge, row, col } = ashlarCoords(u, v);
  if (joint > 0.985) return 0.28;
  const blockWarp = 0.08 * (fbm(u, v, 2, 3, 117) - 0.5);
  const grain = 0.13 * fbm(u, v, 42, 3, 121) + 0.05 * fbm(u, v, 120, 2, 127);
  const chipped =
    edge * (0.15 + 0.22 * Math.max(0, fbm(u + col * 0.07, v + row * 0.11, 18, 2, 129) - 0.5));
  const blockLift = 0.05 * hash2(col, row, 19);
  return Math.max(0.2, Math.min(0.95, 0.7 + blockLift + blockWarp + grain - chipped));
}

function ashlarTint(u: number, v: number): number {
  const { course, vertical, row, col, edge } = ashlarCoords(u, v);
  if (course > 0.972 || vertical > 0.985) return 0.68;
  const soot = Math.max(0, (fbm(u, v, 5, 3, 133) - 0.58) * 0.22);
  const waterRun = Math.max(0, (0.22 - Math.abs(((u * 2 + row * 0.37) % 1) - 0.5)) * 0.5);
  const edgeWear = edge * (0.04 + 0.08 * hash2(col, row, 137));
  return Math.max(
    0.78,
    Math.min(1.12, 0.94 + 0.13 * hash2(col, row, 19) - soot - waterRun + edgeWear),
  );
}

function ashlarRough(u: number, v: number, h: number): number {
  const { course, vertical, edge, row, col } = ashlarCoords(u, v);
  if (course > 0.972 || vertical > 0.985) return 1;
  const polishedHighs = Math.max(0, h - 0.76) * 0.24;
  const grime = 0.1 * fbm(u + col * 0.13, v + row * 0.17, 7, 3, 139);
  return Math.max(0.72, Math.min(0.98, 0.9 + grime + edge * 0.06 - polishedHighs));
}

interface PavingCell {
  row: number;
  col: number;
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  du: number;
  dv: number;
  edge: number;
  joint: number;
}

const pavingMemo: { u: number; v: number; tile: number; cell: PavingCell } = {
  u: NaN,
  v: NaN,
  tile: NaN,
  cell: {
    row: 0,
    col: 0,
    id: 0,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    du: 0,
    dv: 0,
    edge: 0,
    joint: 0,
  },
};

const PAVING_ROWS = [
  [1.8, 1.45, 1.6, 1.15],
  [1.35, 1.75, 1.4, 1.5],
  [1.6, 0.45, 1.85, 2.1],
  [1.25, 1.65, 1.55, 1.55],
  [2.05, 1.55, 1.9, 0.5],
  [1.5, 1.85, 1.25, 1.4],
] as const;

const SIDEWALK_ROWS = [
  [0.75, 0.5, 0.85, 0.4, 0.5],
  [0.42, 0.78, 0.55, 0.75, 0.5],
  [0.6, 0.45, 0.9, 0.55, 0.5],
  [0.8, 0.5, 0.45, 0.85, 0.4],
  [0.5, 0.7, 0.55, 0.45, 0.8],
  [0.65, 0.4, 0.8, 0.55, 0.6],
] as const;

const PAVING_ROW_OFFSETS = [0.85, 3.35, 0.8, 3.65, 0.95, 3.7] as const;
const SIDEWALK_ROW_OFFSETS = [0.38, 1.55, 0.42, 1.4, 0.6, 1.65] as const;

function pavingCell(u: number, v: number, tile = 6): PavingCell {
  if (u === pavingMemo.u && v === pavingMemo.v && tile === pavingMemo.tile) return pavingMemo.cell;
  const rows = tile === 3 ? SIDEWALK_ROWS : PAVING_ROWS;
  const rowH = tile / rows.length;
  const xM = (((u % 1) + 1) % 1) * tile;
  const yM = ((((v % 1) + 1) % 1) * tile + rowH * 0.5) % tile;
  const row = Math.min(rows.length - 1, Math.floor(yM / rowH));
  const y = (yM - row * rowH) / rowH;
  const widths = rows[row]!;
  const offsets = tile === 3 ? SIDEWALK_ROW_OFFSETS : PAVING_ROW_OFFSETS;
  const offset = offsets[row]!;
  const sx = (xM + offset + tile) % tile;
  let left = 0;
  let col = 0;
  for (; col < widths.length - 1 && sx >= left + widths[col]!; col++) left += widths[col]!;
  const w = widths[col]!;
  const x = (sx - left) / w;
  const warp = (hash2(col, row, 311 + tile) - 0.5) * 0.012;
  const du = Math.min(x, 1 - x) * w;
  const dv = Math.min(y, 1 - y) * rowH + warp;
  const widthU = 0.014 + 0.012 * hash2(col, row, 313 + tile);
  const widthV = 0.012 + 0.011 * hash2(col, row, 317 + tile);
  const joint = Math.max(Math.max(0, 1 - du / widthU), Math.max(0, 1 - Math.abs(dv) / widthV));
  const edge = Math.max(
    Math.max(0, 1 - du / (widthU + 0.05)),
    Math.max(0, 1 - Math.abs(dv) / (widthV + 0.05)),
  );
  pavingMemo.u = u;
  pavingMemo.v = v;
  pavingMemo.tile = tile;
  pavingMemo.cell = {
    row,
    col,
    id: hash2(col, row, 331 + tile),
    x,
    y,
    w,
    h: rowH,
    du,
    dv,
    edge,
    joint,
  };
  return pavingMemo.cell;
}

function pavingCrack(c: PavingCell): number {
  if (c.id < 0.92) return 0;
  const ang = (hash2(c.col, c.row, 333) - 0.5) * 1.4;
  const x = c.x;
  const y = c.y;
  const fracture = 0.012 * Math.sin(x * 23 + c.id * 7) + 0.006 * Math.sin(x * 47);
  const line = Math.abs(
    y - 0.18 - 0.58 * hash2(c.col, c.row, 337) - (x - 0.5) * Math.tan(ang) - fracture,
  );
  return (
    Math.max(0, 1 - line / 0.012) * smoothstep(0.08, 0.24, x) * (1 - smoothstep(0.82, 0.95, x))
  );
}

function periodicIndex(value: number, count: number): number {
  return Math.floor((((value % 1) + 1) % 1) * count) % count;
}

/** Balanced 2×2 specks: 6–12 mm texels, < 24 mm features, no residual grain in coarse mips. */
function pavingGrain(u: number, v: number): number {
  const x = periodicIndex(u, SIZE);
  const y = periodicIndex(v, SIZE);
  const bx = Math.floor(x / 2);
  const by = Math.floor(y / 2);
  // Randomly turn each pair so the balanced pattern has no continuous checkerboard runs.
  const turn = hash2(bx, by, 347) > 0.5;
  const pair = turn ? x % 2 : y % 2;
  const sign = (turn ? y % 2 : x % 2) ? -1 : 1;
  return sign * (hash2(bx, by, 367 + pair * 2) - 0.5) * 0.048;
}

/** One feathered stain per six slabs; grain stays fine enough to disappear in coarse mips. */
function pavingStain(c: PavingCell, tile: number): number {
  const columns = tile === 3 ? 5 : 4;
  if ((c.row * columns + c.col) % 6 !== 2) return 0;
  const x = 0.35 + hash2(c.col, c.row, 361) * 0.3;
  const y = 0.35 + hash2(c.col, c.row, 363) * 0.3;
  const d = Math.hypot((c.x - x) / 0.32, (c.y - y) / 0.34);
  return 0.035 * (1 - smoothstep(0, 1, d));
}

function pavingHeight(u: number, v: number, tile = 6): number {
  const c = pavingCell(u, v, tile);
  const grain = pavingGrain(u, v) * 0.28;
  const tilt = (c.x - 0.5) * (hash2(c.col, c.row, 349 + tile) - 0.5) * 0.08;
  const chipped =
    c.edge * Math.max(0, fbm(u + c.col * 0.03, v + c.row * 0.05, 24, 2, 353) - 0.48) * 0.45;
  const crack = pavingCrack(c) * 0.2;
  return Math.max(0.08, Math.min(0.96, 0.68 + grain + tilt - chipped - crack - c.joint * 0.28));
}

function pavingTint(u: number, v: number, _h: number, tile = 6): number {
  const c = pavingCell(u, v, tile);
  if (c.joint > 0.18) return 0.42 + 0.12 * fbm(u, v, 26, 2, 359);
  // ±6% sRGB gives quarried slabs distinct values without changing the accepted running bond.
  const slab = 1 + (c.id - 0.5) * 0.12;
  const chipWear = c.edge * (0.012 + 0.024 * hash2(c.col, c.row, 369));
  return slab * (1 + pavingGrain(u, v) - pavingStain(c, tile) - pavingCrack(c) * 0.16) + chipWear;
}

function pavingHue(u: number, v: number, tile = 6): readonly [number, number, number] {
  const c = pavingCell(u, v, tile);
  const warmth = (hash2(c.col, c.row, 371) - 0.5) * 0.012;
  return [1 + warmth, 1, 1 - warmth];
}

function pavingRough(u: number, v: number, h: number, tile = 6): number {
  const c = pavingCell(u, v, tile);
  if (c.joint > 0.18 || h < 0.22) return 0.98;
  const slabVariation = (c.id - 0.5) * 0.12;
  const pores = Math.abs(pavingGrain(u, v)) * 1.5;
  return Math.max(
    0.78,
    Math.min(0.94, 0.85 + slabVariation + pores + c.edge * 0.03 + pavingCrack(c) * 0.08),
  );
}

const SURFACES: Record<MaterialId, Surface> = {
  asphalt: {
    color: '#3d3f43',
    variation: 0.12,
    roughness: 0.9,
    roughnessVar: 0.08,
    metalness: 0,
    normalStrength: 1.2,
    height: (u, v) => fbm(u, v, 64, 3, 11) * 0.6 + fbm(u, v, 4, 3, 12) * 0.4,
    tint: (u, v) => (hash2(Math.floor(u * 420), Math.floor(v * 420), 3) > 0.985 ? 1.3 : 1),
  },
  ground: {
    color: '#5b5750',
    variation: 0.15,
    roughness: 0.95,
    roughnessVar: 0.05,
    metalness: 0,
    normalStrength: 1.5,
    height: (u, v) => fbm(u, v, 16, 4, 21),
  },
  sidewalk: {
    color: '#9f9b90',
    variation: 0,
    roughness: 0.88,
    roughnessVar: 0.08,
    metalness: 0,
    normalStrength: 1.4,
    tile: 3,
    // Warsaw-style walkway slabs: shorter running-bond strips than the plaza, same warm stone.
    height: (u, v) => pavingHeight(u, v, 3),
    tint: (u, v, h) => pavingTint(u, v, h, 3) * 0.98,
    hue: (u, v) => pavingHue(u, v, 3),
    rough: (u, v, h) => pavingRough(u, v, h, 3),
  },
  concrete: {
    color: '#9c9890',
    variation: 0.14,
    roughness: 0.88,
    roughnessVar: 0.1,
    metalness: 0,
    normalStrength: 1.4,
    height: (u, v) => {
      const pores = hash2(Math.floor(u * 300), Math.floor(v * 300), 5) > 0.97 ? -0.35 : 0;
      return fbm(u, v, 3, 5, 41) * 0.8 + fbm(u, v, 48, 2, 42) * 0.2 + pores;
    },
  },
  plaster: {
    color: '#a99f8f',
    variation: 0.16,
    roughness: 0.92,
    roughnessVar: 0.05,
    metalness: 0,
    normalStrength: 0.9,
    height: (u, v) => fbm(u, v, 2, 4, 51) * 0.5 + fbm(u, v, 64, 3, 52) * 0.5,
  },
  wood: {
    color: '#7c5b3b',
    variation: 0.2,
    roughness: 0.72,
    roughnessVar: 0.1,
    metalness: 0,
    normalStrength: 1.6,
    // Planks 0.25 m wide along V, stretched grain along U.
    height: (u, v) => {
      const plank = Math.abs(((v * 8) % 1) - 0.5) * 2 > 0.94 ? 0 : 1;
      return plank * (0.6 + 0.4 * fbm(u, v, 2, 4, 61, 1, 24));
    },
    tint: (u, v) => 0.85 + 0.3 * hash2(0, Math.floor(v * 8), 9),
  },
  metal: {
    color: '#80878e',
    variation: 0.06,
    roughness: 0.38,
    roughnessVar: 0.12,
    metalness: 0.75,
    normalStrength: 0.6,
    height: (u, v) => fbm(u, v, 1, 4, 71, 64, 1), // brushed
  },
  trim: {
    color: '#b3873a',
    variation: 0.08,
    roughness: 0.55,
    roughnessVar: 0.15,
    metalness: 0.1,
    normalStrength: 0.8,
    height: (u, v) => fbm(u, v, 6, 4, 81),
  },
  accent: {
    color: '#3f6f98',
    variation: 0.08,
    roughness: 0.5,
    roughnessVar: 0.15,
    metalness: 0.1,
    normalStrength: 0.8,
    height: (u, v) => fbm(u, v, 6, 4, 91),
  },
  grass: {
    color: '#58743a',
    variation: 0.22,
    roughness: 0.95,
    roughnessVar: 0.04,
    metalness: 0,
    normalStrength: 1.8,
    height: (u, v) => fbm(u, v, 96, 3, 101) * 0.55 + fbm(u, v, 6, 3, 102) * 0.45,
    tint: (u, v) => 0.9 + 0.2 * fbm(u, v, 3, 2, 103),
  },
  tile: {
    // Glazed subway tile: 15 × 7.5 cm, running bond, recessed grout; glossy, slightly uneven.
    color: '#dfe2dc',
    variation: 0.04,
    roughness: 0.16,
    roughnessVar: 0.06,
    metalness: 0,
    normalStrength: 1.6,
    tile: 0.6,
    height: (u, v) => {
      const row = Math.floor(v * 8);
      const uu = u * 4 + (row % 2) * 0.5;
      const gu = Math.abs((uu % 1) - 0.5) * 2;
      const gv = Math.abs(((v * 8) % 1) - 0.5) * 2;
      const edge = Math.max(gu * 0.97, gv);
      // Bevelled glaze: flat face, rounded into the grout.
      return edge > 0.94 ? 0 : edge > 0.8 ? 1 - ((edge - 0.8) / 0.14) ** 2 * 0.5 : 1;
    },
    tint: (u, v, h) => {
      const row = Math.floor(v * 8);
      const col = Math.floor(u * 4 + (row % 2) * 0.5);
      return h < 0.05 ? 0.62 : 0.95 + 0.07 * hash2(col, row, 71);
    },
    rough: (_u, _v) => undefined,
  },
  terrazzo: {
    // Polished terrazzo: cream base, stone chips, 1.2 m panels with dark divider strips.
    // Satin, not glossy: indoors a mirror-like floor would reflect the outdoor sky (no probes).
    color: '#c6baa6',
    variation: 0.05,
    roughness: 0.5,
    roughnessVar: 0.08,
    metalness: 0,
    normalStrength: 0.5,
    tile: 2.4,
    height: (u, v) => {
      const gu = Math.abs(((u * 2) % 1) - 0.5) * 2;
      const gv = Math.abs(((v * 2) % 1) - 0.5) * 2;
      return Math.max(gu, gv) > 0.992 ? 0.6 : 1;
    },
    tint: (u, v, h) => {
      if (h < 0.9) return 0.42; // divider strip
      const chip = vnoise(u, v, 44, 5);
      const fine = vnoise(u, v, 130, 9);
      if (chip > 0.72) return 0.62 + 0.3 * fine; // dark chips
      if (chip < 0.22) return 1.14; // white marble chips
      return 0.93 + 0.12 * fine;
    },
  },
  paving: {
    color: '#a29e93',
    variation: 0,
    roughness: 0.87,
    roughnessVar: 0.08,
    metalness: 0,
    normalStrength: 1.5,
    tile: 6,
    // Mixed large slabs and narrow inserts, with recessed dirty joints, chips and rare cracks.
    height: pavingHeight,
    tint: pavingTint,
    hue: (u, v) => pavingHue(u, v),
    rough: pavingRough,
  },
  facade: {
    // Near-white base: per-building tint comes from vertex colours.
    color: '#e6d8bf',
    variation: 0.06,
    roughness: 0.92,
    roughnessVar: 0.07,
    metalness: 0,
    normalStrength: 1.05,
    tile: STOREY,
    height: (u, v) => (windowMask(u, v) ? 0.15 : ashlarHeight(u, v)),
    tint: (u, v) => {
      if (windowMask(u, v)) return 0.28;
      return ashlarTint(u, v);
    },
    rough: (u, v, h) => (windowMask(u, v) ? 0.18 : ashlarRough(u, v, h)),
  },
  glass: {
    // Towers read darker than the sky behind them (tinted glass, dark spandrels).
    color: '#4f606d',
    variation: 0.05,
    roughness: 0.12,
    roughnessVar: 0.04,
    metalness: 0.4,
    normalStrength: 0.6,
    tile: STOREY,
    // Curtain wall: 1.65 m panels, slab band at each floor.
    height: (u, v) => (Math.abs(((u * 2) % 1) - 0.5) * 2 > 0.95 || v < 0.08 ? 0.9 : 0.5),
    tint: (u, v) => (Math.abs(((u * 2) % 1) - 0.5) * 2 > 0.95 ? 0.55 : v < 0.08 ? 0.7 : 1),
    rough: (u, v) => (v < 0.08 ? 0.6 : undefined),
  },
  paint: {
    // Car/vehicle paint: glossy, near-white base (colour comes from the per-object tint).
    color: '#f2f2f2',
    variation: 0.03,
    roughness: 0.3,
    roughnessVar: 0.08,
    metalness: 0.35,
    normalStrength: 0.25,
    height: (u, v) => fbm(u, v, 48, 2, 151) * 0.4 + 0.3, // faint orange-peel
  },
  container: {
    // Corrugated painted steel (ISO container sides): vertical ribs every ~0.28 m, worn paint.
    color: '#eeeeee',
    variation: 0.12,
    roughness: 0.62,
    roughnessVar: 0.15,
    metalness: 0.35,
    normalStrength: 3,
    height: (u, v) => {
      const rib = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 7);
      return rib * 0.8 + fbm(u, v, 12, 3, 161) * 0.2;
    },
    tint: (u, v) =>
      0.85 +
      0.2 * fbm(u, v, 6, 3, 162) -
      (hash2(Math.floor(u * 60), Math.floor(v * 60), 17) > 0.97 ? 0.25 : 0),
  },
  wreck: {
    // Burnt-out airframe skin: riveted panels, soot, rust blooms, scraps of the old paint.
    color: '#6a675f',
    variation: 0.1,
    roughness: 0.78,
    roughnessVar: 0.1,
    metalness: 0.45,
    normalStrength: 2.2,
    tile: 3,
    height: (u, v) => {
      const p = wreckPanel(u, v);
      const seam = p.seam < 0.0025 ? 0 : 1;
      const dent = fbm(u, v, 3, 3, 185) * 0.25; // heat-warped skin
      return (p.rivet ? 1 : 0.72) * seam + dent * seam;
    },
    tint: (u, v, h) => {
      const p = wreckPanel(u, v);
      if (h < 0.05) return 0.35; // seams hold soot
      const { soot } = wreckFields(u, v);
      return (0.93 + 0.12 * p.id) * (1 - 0.7 * soot) * (p.rivet ? 1.12 : 1);
    },
    hue: (u, v) => {
      const { soot, rust } = wreckFields(u, v);
      const r = rust * (1 - soot * 0.6);
      // Paint remnant is a cool olive-grey; rust pulls to orange-brown.
      return [0.94 + 0.5 * r, 0.98 - 0.05 * r, 1.02 - 0.45 * r];
    },
    rough: (u, v, h) => {
      const { soot, rust } = wreckFields(u, v);
      return Math.min(1, 0.62 + 0.25 * soot + 0.12 * rust + (h < 0.05 ? 0.1 : 0));
    },
  },
  sandbag: {
    // Filled burlap bags laid in courses: pillowed, pinched at the tied ends, dark gaps between.
    color: '#a39375',
    variation: 0.12,
    roughness: 0.95,
    roughnessVar: 0.03,
    metalness: 0,
    normalStrength: 3.6,
    tile: 1.9,
    height: (u, v) => {
      const weave = (hash2(Math.floor(u * 700), Math.floor(v * 700), 213) - 0.5) * 0.05;
      const crease = (fbm(u, v, 12, 2, 215) - 0.5) * 0.18;
      if (v >= SANDBAG_BURLAP_V) {
        // Plain burlap (the near bags' cloth): weave, soft creases and folds, no seams.
        // No thread weave: at 3.7 mm a texel the tile can't hold burlap threads, and per-texel
        // detail aliases into moiré on the bags. Coarse slubs, creases and folds only.
        const slub = (fbm(u, v, 64, 2, 221) - 0.5) * 0.08;
        return 0.55 + 0.5 * crease + slub + 0.12 * (fbm(u, v, 6, 2, 219) - 0.5);
      }
      const { bu, bv } = sandbagCell(u, v);
      const x = 2 * bu - 1;
      const y = 2 * bv - 1;
      const pillow = Math.sqrt(Math.max(0, 1 - x ** 4)) * Math.max(0, 1 - y * y) ** 0.6;
      return Math.max(0, pillow + crease * pillow + weave);
    },
    tint: (u, v, h) => {
      const dirt = fbm(u, v, 4, 3, 217);
      if (v >= SANDBAG_BURLAP_V) return (0.88 + 0.16 * h) * (0.84 + 0.28 * dirt);
      const { id } = sandbagCell(u, v);
      // Gaps and the undersides of each bag sit in shadow; bags vary in fill and grime.
      return (h < 0.08 ? 0.38 : 0.72 + 0.3 * Math.min(1, h) + 0.16 * id) * (0.86 + 0.24 * dirt);
    },
  },
  foliage: {
    color: '#3d5a2a',
    variation: 0.3,
    roughness: 0.9,
    roughnessVar: 0.08,
    metalness: 0,
    normalStrength: 3,
    height: (u, v) => fbm(u, v, 48, 3, 131) * 0.7 + fbm(u, v, 8, 2, 132) * 0.3,
  },
  bark: {
    color: '#5a4834',
    variation: 0.25,
    roughness: 0.92,
    roughnessVar: 0.05,
    metalness: 0,
    normalStrength: 2.4,
    height: (u, v) => fbm(u, v, 1, 4, 141, 24, 1),
  },
};

/** Median (0..255) of one channel of RGBA bytes: the typical value of a roughness map. */
export function medianChannel(rgba: ArrayLike<number>, channel: number): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = channel; i < rgba.length; i += 4) {
    hist[rgba[i]!]!++;
    n++;
  }
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc * 2 >= n) return v;
  }
  return 255;
}

/** Median roughness (0..1, three reads G) of a loaded texture, from a 128 px downscale. */
function textureMedianRoughness(t: THREE.Texture): number | undefined {
  const img = t.image as CanvasImageSource | undefined;
  if (!img || typeof document === 'undefined') return undefined;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0, size, size);
  return medianChannel(ctx.getImageData(0, 0, size, size).data, 1) / 255;
}

const FACADE_SHELL: Surface = {
  ...SURFACES.facade,
  height: ashlarHeight,
  tint: ashlarTint,
  rough: ashlarRough,
};

export function __testPavingSurfaceTexel(
  id: 'paving' | 'sidewalk',
  u: number,
  v: number,
): { albedo: readonly [number, number, number]; rough: number; height: number } {
  const s = SURFACES[id];
  const h = s.height(u, v);
  const tint = s.tint ? s.tint(u, v, h) : 1;
  const k = (1 + (h - 0.5) * 2 * s.variation) * tint;
  const [hr, hg, hb] = s.hue ? s.hue(u, v, h) : ([1, 1, 1] as const);
  const c = new THREE.Color(s.color).convertLinearToSRGB();
  const r0 = s.rough?.(u, v, h);
  const rough = Math.min(1, Math.max(0.05, r0 ?? s.roughness + (0.5 - h) * 2 * s.roughnessVar));
  return {
    albedo: [
      Math.min(255, c.r * 255 * k * hr),
      Math.min(255, c.g * 255 * k * hg),
      Math.min(255, c.b * 255 * k * hb),
    ],
    rough,
    height: h,
  };
}

/** Palette colour of a surface (sRGB hex): the procedural base, and what scans are matched to. */
export function surfacePalette(id: MaterialId): string {
  return SURFACES[id].color;
}

/**
 * Generated texels per surface definition (albedo, normal, roughness), kept for the session: the
 * maps are pure functions of the surface, so a second `MapMaterials` (tests, a map reload) wraps
 * the same read-only bytes in its own textures instead of regenerating every 512² set on the CPU.
 */
const texelCache = new WeakMap<
  Surface,
  { albedo: Uint8Array; normal: Uint8Array; rough: Uint8Array }
>();

function makeMaps(s: Surface): {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  rough: THREE.DataTexture;
} {
  const n = SIZE;
  const { albedo, normal, rough } = texelCache.get(s) ?? surfaceTexels(s);
  texelCache.set(s, { albedo, normal, rough });
  const tex = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / (s.tile ?? TILE_METRES), 1 / (s.tile ?? TILE_METRES));
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: tex(albedo, true), normal: tex(normal, false), rough: tex(rough, false) };
}

function surfaceTexels(s: Surface): { albedo: Uint8Array; normal: Uint8Array; rough: Uint8Array } {
  const n = SIZE;
  const reliefMasks = s === SURFACES.facade || s === FACADE_SHELL;
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = s.height(x / n, y / n);
  // Albedo base in sRGB (the texture is tagged sRGB): once per set, not per texel.
  const c = new THREE.Color(s.color).convertLinearToSRGB();
  const albedo = new Uint8Array(n * n * 4);
  const normal = new Uint8Array(n * n * 4);
  const rough = new Uint8Array(n * n * 4);
  const at = (x: number, y: number): number => h[((y + n) % n) * n + ((x + n) % n)]!;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const hv = h[i]!;
      const tint = s.tint ? s.tint(x / n, y / n, hv) : 1;
      const k = (1 + (hv - 0.5) * 2 * s.variation) * tint;
      const [hr, hg, hb] = s.hue ? s.hue(x / n, y / n, hv) : ([1, 1, 1] as const);
      albedo[i * 4] = Math.min(255, c.r * 255 * k * hr);
      albedo[i * 4 + 1] = Math.min(255, c.g * 255 * k * hg);
      albedo[i * 4 + 2] = Math.min(255, c.b * 255 * k * hb);
      albedo[i * 4 + 3] = 255;
      // Normal from height gradient (Sobel-lite), tangent space.
      const dx = (at(x + 1, y) - at(x - 1, y)) * s.normalStrength * (n / 64);
      const dy = (at(x, y + 1) - at(x, y - 1)) * s.normalStrength * (n / 64);
      const len = Math.hypot(dx, dy, 1);
      normal[i * 4] = ((-dx / len) * 0.5 + 0.5) * 255;
      normal[i * 4 + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      normal[i * 4 + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      normal[i * 4 + 3] = 255;
      // Roughness in G (three reads roughness from G, metalness from B).
      const r0 = s.rough?.(x / n, y / n, hv);
      const r = Math.min(1, Math.max(0.05, r0 ?? s.roughness + (0.5 - hv) * 2 * s.roughnessVar));
      rough[i * 4] = 255;
      rough[i * 4 + 1] = r * 255;
      rough[i * 4 + 2] = 255;
      rough[i * 4 + 3] = 255;
      if (reliefMasks) {
        // Facade/shell never bind a metalness map. Reuse otherwise-unused R/B/A; G and
        // all albedo/normal bytes retain their existing PBR values and sampling grid.
        const [jamb, head, ledge] = palaceReliefMask((x + 0.5) / n, (y + 0.5) / n, 1 / n);
        rough[i * 4] = Math.round(jamb * 255);
        rough[i * 4 + 2] = Math.round(head * 255);
        rough[i * 4 + 3] = Math.round(ledge * 255);
      }
    }
  }
  return { albedo, normal, rough };
}

/** 1 m grid (level-design aid, toggled in settings). */
function gridTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let k = 1; k < 4; k++) {
    g.fillRect(k * 64, 0, 1, 256);
    g.fillRect(0, k * 64, 256, 1);
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, 3, 256);
  g.fillRect(0, 0, 256, 3);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Shared uniform: 0 = dry, 1 = soaked. Driven by the weather system. */
export const wetness = { value: 0 };

/** World position for the wetness hook's shelter lookup (instancing/batching aware). */
const WET_VERTEX = /* glsl */ `
vec4 wetWorld = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  wetWorld = batchingMatrix * wetWorld;
#endif
#ifdef USE_INSTANCING
  wetWorld = instanceMatrix * wetWorld;
#endif
vWetPos = ( modelMatrix * wetWorld ).xyz;
`;

/**
 * Wet surfaces (exported for the shader-source tests). Only where rain reaches (the rain
 * occlusion map, sampled a little out along the surface normal so walls look past their own
 * footprint): sheltered and indoor surfaces stay dry. Porous rough dielectrics (concrete,
 * paving, asphalt, plaster, wood) darken most; metal, glass and glaze only take a film. Water
 * film: up-facing surfaces pool a near-mirror layer, walls a glossy sheet. `wetExposed` is left
 * for later hooks (puddles, ripples).
 */
export const WET_FRAGMENT = /* glsl */ `
if ( uWetness > 0.0 ) {
  vec3 wetN = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz );
  // Medium+ only (Low, the one tier that tone-maps in the material, keeps its frame budget and
  // wets everything: looks only, never concealment); past 70 m shelter can't be told apart.
  #ifndef TONE_MAPPING
  if ( distance( vWetPos, cameraPosition ) < 70.0 ) wetExposed = rainExposure( vWetPos + wetN * 0.3 );
  #endif
  float up = smoothstep( 0.55, 0.95, wetN.y );
  // A multiplier can push mapped roughness past 1 (satin glass slab bands): saturate first so
  // the film still reads (three would clamp only after the blend).
  roughnessFactor = min( roughnessFactor, 1.0 );
  float porosity = ( 1.0 - metalnessFactor ) * smoothstep( 0.3, 0.85, roughnessFactor );
  float wet = uWetness * wetExposed * ( 0.4 + 0.6 * up );
  diffuseColor.rgb *= mix( 1.0, 0.5, wet * porosity ) * ( 1.0 - 0.08 * wet * ( 1.0 - porosity ) );
  roughnessFactor = mix( roughnessFactor, min( roughnessFactor, mix( 0.32, 0.14, up ) ), wet );
}
`;

export function addWetness(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWetness = wetness;
    shader.uniforms.uRainOcc = rainOcclusion.map;
    shader.uniforms.uRainOccRect = rainOcclusion.rect;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWetPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WET_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uWetness;\nvarying vec3 vWetPos;\nfloat wetExposed = 1.0;\n${RAIN_OCCLUSION_GLSL}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${WET_FRAGMENT}`,
      );
  };
  mat.customProgramCacheKey = () => 'wet';
}

/** World metres per texture tile for surface `id` (scanned set if loaded, else procedural). */
export function tileMetres(id: MaterialId, scanned: boolean): number {
  if (scanned && isTextured(id)) return SURFACE_TILE_METRES[id];
  return SURFACES[id].tile ?? TILE_METRES;
}

/**
 * Colour multiplier for a scanned surface: one grey gain that moves its scan's mean brightness
 * onto the surface's palette colour (the procedural `color`; the texture already carries its hue),
 * so scans keep the tuned look and exposure.
 */
export function scannedColor(id: TexturedSurface): THREE.Color {
  const target = new THREE.Color(SURFACES[id].color);
  const g = paletteGain([target.r, target.g, target.b], albedoStats(id));
  return new THREE.Color(g, g, g);
}

/** The maps a surface currently draws with, and the colour multiplier that goes with them. */
interface ActiveMaps extends SurfaceMaps<THREE.Texture> {
  color: THREE.Color;
}

export class MapMaterials {
  private readonly mats = new Map<MaterialId, THREE.MeshStandardMaterial>();
  private readonly active = new Map<MaterialId, ActiveMaps>();
  private readonly facadeShell: ActiveMaps;
  private readonly grid = gridTexture();

  constructor(private readonly maxAnisotropy: number) {
    this.grid.anisotropy = maxAnisotropy;
    for (const id of Object.keys(SURFACES) as MaterialId[]) {
      const s = SURFACES[id];
      const maps = makeMaps(s);
      for (const t of [maps.albedo, maps.normal, maps.rough]) t.anisotropy = maxAnisotropy;
      const mat = new THREE.MeshStandardMaterial({
        map: maps.albedo,
        normalMap: maps.normal,
        roughnessMap: maps.rough,
        roughness: 1,
        metalness: s.metalness,
        // Every map geometry carries a colour attribute (white unless tinted): per-building
        // tints share one material, so hundreds of buildings cost one draw call per chunk.
        vertexColors: true,
      });
      addWetness(mat);
      if (GROUND_DETAIL_SURFACES.includes(id))
        addGroundDetail(mat, id === 'paving' || id === 'sidewalk');
      if (['ground', ...GROUND_DETAIL_SURFACES].includes(id)) addCourtyardBake(mat);
      // Lawns are visible overlays on the same ground receiver. Excluding them leaves a
      // hard illumination seam at the paving edge, even though the baked light is continuous.
      if (['ground', 'grass', ...GROUND_DETAIL_SURFACES].includes(id)) addMarketNeonBake(mat);
      if (WEAR_SURFACES.includes(id)) addWearDetail(mat, id);
      // Corrugation reads as relief, not print, at the distances containers are seen from.
      if (id === 'container') mat.normalScale.set(1.9, 1.9);
      // Sandbags are closed, rounded bags (render/sandbagWall.ts): their far sides cast the shadow,
      // so the sunlit curves never shade themselves (no acne stripes on the grazing shoulders).
      if (id === 'sandbag') mat.shadowSide = THREE.BackSide;
      this.mats.set(id, mat);
      this.active.set(id, { ...maps, color: new THREE.Color('#ffffff') });
    }
    const shellMaps = makeMaps(FACADE_SHELL);
    for (const t of [shellMaps.albedo, shellMaps.normal, shellMaps.rough]) {
      t.anisotropy = maxAnisotropy;
    }
    this.facadeShell = { ...shellMaps, color: new THREE.Color('#ffffff') };
  }

  get(id: MaterialId): THREE.MeshStandardMaterial {
    return this.mats.get(id)!;
  }

  /** Which surfaces draw with a scanned texture set (the rest are procedural). */
  readonly scanned = new Set<MaterialId>();

  /**
   * Swap in the scanned texture sets. Call before `Game.warmUp` (and before the first frame):
   * the textures are uploaded here (`initTexture`), so nothing uploads or compiles in play.
   * Resolves with the surfaces that loaded; failures keep their procedural maps (a warning).
   * `lowRes` (the Low tier at load) caps every set at 512 px, what the procedural maps cost; the
   * size is picked once per session (swapping sets in play would upload mid-game).
   */
  async loadTextures(
    renderer: THREE.WebGLRenderer,
    {
      lowRes = false,
      base = import.meta.env.BASE_URL,
      timeoutMs = 20_000,
    }: { lowRes?: boolean; base?: string; timeoutMs?: number } = {},
  ): Promise<MaterialId[]> {
    const loader = new THREE.TextureLoader();
    const sets = await loadSurfaceSets(
      TEXTURED_SURFACES,
      (url) => withTimeout(loader.loadAsync(url), timeoutMs, url),
      base,
      undefined,
      lowRes,
    );
    for (const [id, set] of sets) {
      const tile = tileMetres(id, true);
      const setup = (t: THREE.Texture, srgb: boolean): THREE.Texture => {
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(1 / tile, 1 / tile);
        t.anisotropy = this.maxAnisotropy;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.needsUpdate = true;
        renderer.initTexture(t);
        return t;
      };
      const old = this.active.get(id)!;
      const now: ActiveMaps = {
        albedo: setup(set.albedo, true),
        normal: setup(set.normal, false),
        rough: setup(set.rough, false),
        color: scannedColor(id),
      };
      this.active.set(id, now);
      this.scanned.add(id);
      const median = textureMedianRoughness(now.rough);
      if (median !== undefined) this.noteActiveRoughness(id, median);
      // Base material and every clone made from it (clones hold texture references). A clone
      // whose configure() replaced a map keeps its own.
      const mats = [this.mats.get(id)!];
      for (const v of this.variants.values()) if (v.id === id) mats.push(v.mat);
      for (const mat of mats) {
        if (mat.normalMap === old.normal) mat.normalMap = now.normal;
        if (mat.roughnessMap === old.rough) mat.roughnessMap = now.rough;
        this.applyMaps(id, mat);
      }
      // The procedural maps of a scanned surface are never drawn again.
      for (const t of [old.albedo, old.normal, old.rough]) t.dispose();
    }
    return [...this.scanned];
  }

  /** Swap albedo for the flat-colour grid (level design) or back to the surface. */
  private gridOn = false;
  /** Variants of a base surface (polygon offset, double-sided…): kept in sync with grid mode. */
  private readonly variants = new Map<
    string,
    { id: MaterialId; mat: THREE.MeshStandardMaterial }
  >();
  private readonly facadeShellVariants = new Map<string, THREE.MeshStandardMaterial>();
  /** Median roughness of each scanned surface's map (procedural maps use the surface value). */
  private readonly roughMedian = new Map<MaterialId, number>();
  private readonly mapListeners: Array<() => void> = [];

  /**
   * The typical roughness of surface `id`'s active map. Materials keep `roughness: 1` and carry
   * the surface in their roughness map, so a per-material roughness multiplies this value: a
   * variant that wants an absolute roughness divides by it (and re-tunes in `onActiveMaps`).
   */
  typicalRoughness(id: MaterialId): number {
    return this.roughMedian.get(id) ?? SURFACES[id].roughness;
  }

  /** Called after scanned maps replace procedural ones (`loadTextures`). */
  onActiveMaps(fn: () => void): void {
    this.mapListeners.push(fn);
  }

  /** Record a surface's active-map median roughness and re-tune listeners (loadTextures, tests). */
  noteActiveRoughness(id: MaterialId, median: number): void {
    this.roughMedian.set(id, median);
    for (const fn of this.mapListeners) fn();
  }

  /** A cached clone of surface `id` with extra state (keeps the wetness hook and grid mode). */
  variant(
    id: MaterialId,
    key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    const k = `${id}|${key}`;
    const hit = this.variants.get(k);
    if (hit) return hit.mat;
    const base = this.get(id);
    const m = base.clone();
    m.onBeforeCompile = (shader, renderer) => base.onBeforeCompile(shader, renderer);
    m.customProgramCacheKey = () => `${base.customProgramCacheKey()}|${key}`;
    configure(m);
    this.variants.set(k, { id, mat: m });
    this.applyMaps(id, m);
    return m;
  }

  /** A facade material clone with clean sandstone shell maps and no painted windows. */
  facadeShellVariant(
    key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    const hit = this.facadeShellVariants.get(key);
    if (hit) return hit;
    const base = this.get('facade');
    const m = base.clone();
    m.onBeforeCompile = (shader, renderer) => base.onBeforeCompile(shader, renderer);
    m.customProgramCacheKey = () => `${base.customProgramCacheKey()}|facadeShell|${key}`;
    configure(m);
    this.facadeShellVariants.set(key, m);
    m.normalMap = this.facadeShell.normal;
    m.roughnessMap = this.facadeShell.rough;
    this.applyActiveMaps('facade', this.facadeShell, m);
    return m;
  }

  /** Point a material (base or variant) at the surface's active albedo, honouring grid mode. */
  private applyMaps(id: MaterialId, mat: THREE.MeshStandardMaterial): void {
    this.applyActiveMaps(id, this.active.get(id)!, mat);
  }

  private applyActiveMaps(
    id: MaterialId,
    active: ActiveMaps,
    mat: THREE.MeshStandardMaterial,
  ): void {
    setPalaceEntranceGrid(mat, this.gridOn);
    if (!this.gridOn && restorePalaceColumnMaps(mat)) {
      mat.color.set('#ffffff');
      return;
    }
    mat.map = this.gridOn ? this.grid : active.albedo;
    mat.color = this.gridOn ? new THREE.Color(SURFACES[id].color) : active.color.clone();
    mat.needsUpdate = true;
  }

  setGrid(on: boolean): void {
    this.gridOn = on;
    for (const [id, mat] of this.mats) this.applyMaps(id, mat);
    for (const { id, mat } of this.variants.values()) this.applyMaps(id, mat);
    for (const mat of this.facadeShellVariants.values()) {
      this.applyActiveMaps('facade', this.facadeShell, mat);
    }
  }

  /** The maps surface `id` draws with now (for tests and the perf overlay). */
  activeMaps(id: MaterialId): Readonly<ActiveMaps> {
    return this.active.get(id)!;
  }
}
