import * as THREE from 'three';
import { quatFromEulerDeg, type MapBox, type MapDefinition, type MaterialId } from '@wd/shared';
import { BAKED_AO_INTENSITY } from './mapMesh.ts';

/**
 * The market hall's interior (shared/maps/placDefilad/market.ts `HALL`), dressed as a worn Warsaw
 * covered market: glazed tile dado and oxblood glazed-brick piers on the ground floor, roller
 * shutters with blank painted boards along the walls, a chequered terrazzo floor with a border and
 * brass strips, painted ceiling panels between the joists; upstairs a painted dado, timber
 * wall plates, dark steel I-beams with knee braces under timber sarking, a ventilation duct,
 * steel window frames, boarded partitions and a guard rail round the stair void. Thresholds,
 * stair nosings, door casings, counters' tile fronts and zinc tops, a few sacks and produce crates.
 *
 * Presentation only: everything is built from the map's own boxes (wall pieces, openings, stair
 * steps, beams, counters, partitions), clings to a solid face (≤ 0.24 m off a wall, ≤ 1.2 cm off
 * cover) or hangs above head height, and never changes collision. Merged per material by
 * render/marketDistrictDetail.ts with the hall's existing fittings: one draw per material.
 *
 * Every vertex carries its own colour (tint × grime) and `aHallSky`: the baked sky occlusion the
 * map's own hall surfaces get from the lightmap, estimated here with the same metric (cosine rays,
 * 16 m falloff, the bake's AO intensity) against the hall's boxes. Without it the cladding would
 * take the open sky's fill light indoors and glow against the baked plaster around it.
 */

export type HallPieceKind =
  /** Clings to a perimeter wall or a partition (≤ 0.24 m off its face). */
  | 'hall-wall'
  /** Lies on a floor (overlay, brass strips, thresholds): ≤ 2 cm proud. */
  | 'hall-floor'
  /** Ceiling panels, beams, braces, ducts: above head height. */
  | 'hall-ceiling'
  /** Stair nosings on the treads. */
  | 'hall-stair'
  /** Guard rails and balustrade at the stair void (no collision: see the module notes). */
  | 'hall-railing'
  /** Window frames, mullions and sills in the upstairs window openings. */
  | 'hall-window'
  /** Skins on cover (the counters, the upstairs partitions): ≤ 2 cm proud, ≤ 1.2 cm higher. */
  | 'hall-cover'
  /** Sacks and produce crates against the walls (low, ≤ 0.24 m deep). */
  | 'hall-dressing';

export interface HallPiece {
  geo: THREE.BufferGeometry;
  mat: MaterialId;
  kind: HallPieceKind;
  /** Sky occlusion per vertex (large subdivided surfaces) or per face direction (small parts). */
  perVertex?: boolean;
}

/** Mirrors market.ts (tests check these against the map's boxes). */
export const HALL = { x0: 128, z0: 14, x1: 152, z1: 28 } as const;
export const HALL_LEVELS = {
  /** Top of the terrazzo slab. */
  floor: 0.05,
  /** Underside of the upper floor slab. */
  ceiling: 3.35,
  /** Top of the upper floor. */
  upper: 3.6,
  /** Underside of the roof. */
  roof: 7.2,
} as const;
const WALL_HALF = 0.15;
/** The hall's interior faces. */
export const HALL_INNER = {
  x0: HALL.x0 + WALL_HALF,
  x1: HALL.x1 - WALL_HALF,
  z0: HALL.z0 + WALL_HALF,
  z1: HALL.z1 - WALL_HALF,
} as const;
/** Deepest a wall-mounted piece stands off its wall (shutter housings). */
export const HALL_WALL_REACH = 0.24;
/** Attribute carrying the estimated baked sky occlusion (1 = open sky). */
export const HALL_SKY_ATTRIBUTE = 'aHallSky';

type V3 = { x: number; y: number; z: number };
type Rgb = readonly [number, number, number];

// ---- colour ------------------------------------------------------------------------------------

/** sRGB palette colour of each map surface (materials.ts): what a tint of white leaves alone. */
const BASE: Partial<Record<MaterialId, string>> = {
  tile: '#dfe2dc',
  plaster: '#a99f8f',
  wood: '#7c5b3b',
  paint: '#f2f2f2',
  terrazzo: '#c6baa6',
  metal: '#80878e',
  sandbag: '#a39375',
  trim: '#b3873a',
};
const _a = new THREE.Color();
const _b = new THREE.Color();
/** Linear vertex-colour multiplier that turns surface `mat` (on average) into sRGB `want`. */
function over(mat: MaterialId, want: string): Rgb {
  _a.set(want); // three converts hex/CSS strings from sRGB to linear working space
  _b.set(BASE[mat] ?? '#ffffff');
  return [_a.r / Math.max(_b.r, 1e-3), _a.g / Math.max(_b.g, 1e-3), _a.b / Math.max(_b.b, 1e-3)];
}

const hash = (a: number, b: number, salt: number): number => {
  const h = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return h - Math.floor(h);
};

// ---- box emitter -------------------------------------------------------------------------------

interface UvMap {
  /** Scale of the world-metre uvs (u, v) and an offset after scaling. */
  su?: number;
  sv?: number;
  ou?: number;
  ov?: number;
  /** Swap u and v (vertical boards: the wood grain runs along u). */
  swap?: boolean;
}

interface BoxOpts {
  mat: MaterialId;
  kind: HallPieceKind;
  tint: Rgb;
  /** Floor under the piece: walls and stacks darken towards it (splash and scuff grime). */
  floor?: number;
  /** How dark the grime gets at the floor (0..1) and how high it reaches (m). */
  grime?: number;
  grimeReach?: number;
  /** Faces left out (never seen: against a wall or another piece). Local axes. */
  skip?: readonly Face[];
  /** Subdivide faces into cells of at most this size (m): per-vertex grime and sky occlusion. */
  cell?: number;
  uv?: UvMap;
  /** Per-piece brightness jitter (±). */
  vary?: number;
}

type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
const FACE_IDS: readonly Face[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

/** World-metre uvs by the face's dominant normal axis, as render/mapMesh lays out box faces. */
function planarUv(p: V3, n: V3): [number, number] {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ay >= ax && ay >= az) return [p.x, n.y > 0 ? -p.z : p.z];
  if (ax >= az) return [n.x > 0 ? -p.z : p.z, p.y];
  return [n.z > 0 ? p.x : -p.x, p.y];
}

let pieceSeed = 0;

/**
 * An oriented box: centre, unit axes (ex, ey, ez) and half sizes. Faces are optionally subdivided
 * so per-vertex grime and occlusion have somewhere to vary.
 */
function orientedBox(c: V3, ex: V3, ey: V3, ez: V3, h: V3, o: BoxOpts): HallPiece | null {
  if (h.x < 5e-4 || h.y < 5e-4 || h.z < 5e-4) return null;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const axes = [ex, ey, ez];
  const half = [h.x, h.y, h.z];
  const seed = pieceSeed++;
  const jitter = 1 + (hash(seed, c.x + c.z, 7) - 0.5) * 2 * (o.vary ?? 0.04);
  const grime = o.grime ?? 0.22;
  const reach = o.grimeReach ?? 0.45;
  const cell = o.cell ?? 0;
  const u = o.uv ?? {};
  FACE_IDS.forEach((face, fi) => {
    if (o.skip?.includes(face)) return;
    const a = fi >> 1; // normal axis
    const sign = fi % 2 === 0 ? 1 : -1;
    const ua = (a + 1) % 3;
    const va = (a + 2) % 3;
    const n = axes[a]!;
    const nw = { x: n.x * sign, y: n.y * sign, z: n.z * sign };
    // Only broad faces are subdivided (a band's thin top and ends need no gradient).
    const broad = cell > 0 && Math.min(half[ua]!, half[va]!) * 2 >= 0.2;
    const nu = broad ? Math.max(1, Math.ceil((2 * half[ua]!) / cell)) : 1;
    const nv = broad ? Math.max(1, Math.ceil((2 * half[va]!) / cell)) : 1;
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const s = -1 + (2 * i) / nu;
        const t = -1 + (2 * j) / nv;
        const au = axes[ua]!;
        const av = axes[va]!;
        const p = {
          x: c.x + nw.x * half[a]! + au.x * s * half[ua]! + av.x * t * half[va]!,
          y: c.y + nw.y * half[a]! + au.y * s * half[ua]! + av.y * t * half[va]!,
          z: c.z + nw.z * half[a]! + au.z * s * half[ua]! + av.z * t * half[va]!,
        };
        pos.push(p.x, p.y, p.z);
        nrm.push(nw.x, nw.y, nw.z);
        let [pu, pv] = planarUv(p, nw);
        if (u.swap) [pu, pv] = [pv, pu];
        uv.push(pu * (u.su ?? 1) + (u.ou ?? 0), pv * (u.sv ?? 1) + (u.ov ?? 0));
        const g =
          o.floor === undefined ? 0 : grime * Math.max(0, 1 - Math.max(0, p.y - o.floor) / reach);
        const k = jitter * (1 - g);
        col.push(o.tint[0] * k, o.tint[1] * k, o.tint[2] * k);
      }
    }
    // Winding: (u, v, n) is right-handed for +faces; −faces flip it.
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const q = base + j * (nu + 1) + i;
        const r = q + nu + 1;
        if (sign > 0) idx.push(q, q + 1, r + 1, q, r + 1, r);
        else idx.push(q, r + 1, q + 1, q, r, r + 1);
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, mat: o.mat, kind: o.kind, perVertex: cell > 0 };
}

const X = { x: 1, y: 0, z: 0 };
const Y = { x: 0, y: 1, z: 0 };
const Z = { x: 0, y: 0, z: 1 };

function aabb(min: V3, max: V3, o: BoxOpts): HallPiece | null {
  return orientedBox(
    { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    X,
    Y,
    Z,
    { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 },
    o,
  );
}

/** A bar of square section `w` × `d` from `a` to `b` (`side` fixes its roll: a horizontal axis). */
function bar(a: V3, b: V3, w: number, d: number, side: V3, o: BoxOpts): HallPiece | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return null;
  const ex = { x: dx / len, y: dy / len, z: dz / len };
  // ez = side made perpendicular to ex; ey = ez × ex.
  const k = side.x * ex.x + side.y * ex.y + side.z * ex.z;
  let ez = { x: side.x - k * ex.x, y: side.y - k * ex.y, z: side.z - k * ex.z };
  const el = Math.hypot(ez.x, ez.y, ez.z);
  ez = { x: ez.x / el, y: ez.y / el, z: ez.z / el };
  const ey = {
    x: ez.y * ex.z - ez.z * ex.y,
    y: ez.z * ex.x - ez.x * ex.z,
    z: ez.x * ex.y - ez.y * ex.x,
  };
  return orientedBox(
    { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
    ex,
    ey,
    ez,
    { x: len / 2, y: w / 2, z: d / 2 },
    o,
  );
}

// ---- the hall's walls, from the map ------------------------------------------------------------

interface Rect2 {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

/** One perimeter wall: runs along `axis`, inner face at `face` on the other axis. */
interface WallLine {
  name: 'north' | 'south' | 'west' | 'east';
  axis: 'x' | 'z';
  face: number;
  /** +1: the room is on the + side of the face. */
  inward: 1 | -1;
  from: number;
  to: number;
  rects: Rect2[];
}

function boxBounds(b: MapBox): { min: V3; max: V3 } {
  const h = { x: b.size.x / 2, y: b.size.y / 2, z: b.size.z / 2 };
  const r = b.rot;
  if (!r || (Math.abs(r.x) < 1e-6 && Math.abs(r.y) < 1e-6 && Math.abs(r.z) < 1e-6)) {
    return {
      min: { x: b.center.x - h.x, y: b.center.y - h.y, z: b.center.z - h.z },
      max: { x: b.center.x + h.x, y: b.center.y + h.y, z: b.center.z + h.z },
    };
  }
  const q = quatFromEulerDeg(r);
  const qt = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        v.set(sx * h.x, sy * h.y, sz * h.z).applyQuaternion(qt);
        box.expandByPoint(v.add(new THREE.Vector3(b.center.x, b.center.y, b.center.z)));
      }
  return { min: box.min, max: box.max };
}

const inHall = (min: V3, max: V3, grow = 0): boolean =>
  max.x >= HALL.x0 - grow &&
  min.x <= HALL.x1 + grow &&
  max.z >= HALL.z0 - grow &&
  min.z <= HALL.z1 + grow;

/** The hall's own plaster wall pieces (perimeter and upstairs partitions). */
export function isHallPlaster(b: MapBox): boolean {
  if (b.visible === false || b.mat !== 'plaster') return false;
  const { min, max } = boxBounds(b);
  return inHall(min, max) && (b.size.x <= 0.31 || b.size.z <= 0.31) && max.y <= 7.3;
}

function wallLines(boxes: readonly MapBox[]): WallLine[] {
  const lines: WallLine[] = [
    {
      name: 'north',
      axis: 'x',
      face: HALL_INNER.z0,
      inward: 1,
      from: HALL_INNER.x0,
      to: HALL_INNER.x1,
      rects: [],
    },
    {
      name: 'south',
      axis: 'x',
      face: HALL_INNER.z1,
      inward: -1,
      from: HALL_INNER.x0,
      to: HALL_INNER.x1,
      rects: [],
    },
    {
      name: 'west',
      axis: 'z',
      face: HALL_INNER.x0,
      inward: 1,
      from: HALL_INNER.z0,
      to: HALL_INNER.z1,
      rects: [],
    },
    {
      name: 'east',
      axis: 'z',
      face: HALL_INNER.x1,
      inward: -1,
      from: HALL_INNER.z0,
      to: HALL_INNER.z1,
      rects: [],
    },
  ];
  for (const b of boxes) {
    if (!isHallPlaster(b)) continue;
    const { min, max } = boxBounds(b);
    for (const l of lines) {
      const cross = l.axis === 'x' ? b.center.z : b.center.x;
      const wallAt = l.face - l.inward * WALL_HALF;
      if (Math.abs(cross - wallAt) > 0.05) continue;
      l.rects.push({
        a0: l.axis === 'x' ? min.x : min.z,
        a1: l.axis === 'x' ? max.x : max.z,
        y0: min.y,
        y1: max.y,
      });
    }
  }
  return lines;
}

/** Along-intervals of `l` that are solid wall over the whole height band [y0, y1]. */
function solidSpans(l: WallLine, y0: number, y1: number): [number, number][] {
  const spans = l.rects
    .filter((r) => r.y0 <= y0 + 1e-3 && r.y1 >= y1 - 1e-3)
    .map((r): [number, number] => [Math.max(r.a0, l.from), Math.min(r.a1, l.to)])
    .filter(([a, b]) => b - a > 1e-3)
    .sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s[0] <= last[1] + 2e-3) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** The solid part of band [ya, yb] on wall `l`, as rects (split where wall pieces start/stop). */
function bandRects(l: WallLine, ya: number, yb: number): Rect2[] {
  const cuts = new Set<number>([ya, yb]);
  for (const r of l.rects) {
    if (r.y0 > ya + 1e-3 && r.y0 < yb - 1e-3) cuts.add(r.y0);
    if (r.y1 > ya + 1e-3 && r.y1 < yb - 1e-3) cuts.add(r.y1);
  }
  const ys = [...cuts].sort((p, q) => p - q);
  const out: Rect2[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    for (const [a0, a1] of solidSpans(l, ys[i]!, ys[i + 1]!))
      out.push({ a0, a1, y0: ys[i]!, y1: ys[i + 1]! });
  }
  return out;
}

/** World point at (along `a`, height `y`, `d` metres into the room) on wall `l`. */
function onWall(l: WallLine, a: number, y: number, d: number): V3 {
  const c = l.face + l.inward * d;
  return l.axis === 'x' ? { x: a, y, z: c } : { x: c, y, z: a };
}

/** A slab on wall `l`'s face: along [a0, a1], height [y0, y1], depth [d0, d1] into the room. */
function wallSlab(
  l: WallLine,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  d0: number,
  d1: number,
  o: Omit<BoxOpts, 'kind'> & { kind?: HallPieceKind },
): HallPiece | null {
  const p = onWall(l, a0, y0, d0);
  const q = onWall(l, a1, y1, d1);
  // The back face is against the wall (or the piece behind): never seen.
  const back: Face = l.axis === 'x' ? (l.inward > 0 ? '-z' : '+z') : l.inward > 0 ? '-x' : '+x';
  return aabb(
    { x: Math.min(p.x, q.x), y: y0, z: Math.min(p.z, q.z) },
    { x: Math.max(p.x, q.x), y: y1, z: Math.max(p.z, q.z) },
    { kind: 'hall-wall', skip: Math.abs(d0) < 1e-4 ? [back] : undefined, ...o },
  );
}

/** Openings of wall `l` in band [ya, yb]: along-gaps with wall above (doors) or above and below. */
function openings(
  l: WallLine,
  probe: number,
): { a0: number; a1: number; y0: number; y1: number }[] {
  const solid = solidSpans(l, probe - 0.01, probe + 0.01);
  const gaps: [number, number][] = [];
  let cursor = l.from;
  for (const [a, b] of solid) {
    if (a - cursor > 0.3) gaps.push([cursor, a]);
    cursor = b;
  }
  if (l.to - cursor > 0.3) gaps.push([cursor, l.to]);
  return gaps.map(([a0, a1]) => {
    const mid = (a0 + a1) / 2;
    const at = l.rects.filter((r) => r.a0 <= mid && r.a1 >= mid);
    const below = at.filter((r) => r.y1 <= probe).reduce((m, r) => Math.max(m, r.y1), 0);
    const above = at.filter((r) => r.y0 >= probe).reduce((m, r) => Math.min(m, r.y0), 99);
    return { a0, a1, y0: below, y1: above };
  });
}

// ---- builders ----------------------------------------------------------------------------------

const L = HALL_LEVELS;
const GF_PIER_X = [130, 133, 136, 139, 142, 145, 148]; // under the joists (market.ts)
const UF_PIER_X = [129.5, 132.5, 135.5, 138.5, 141.5, 144.5, 147.5, 150.5]; // under the beams
const END_PIER_Z = [15.75, 19.25, 22.75, 26.25];
const PIER_W = 0.5;

interface Ctx {
  out: HallPiece[];
  lines: WallLine[];
  push: (p: HallPiece | null) => void;
  stair: StairInfo | null;
}

interface StairInfo {
  steps: { x0: number; x1: number; top: number }[];
  z0: number;
  z1: number;
}

/** The hall stair's treads (wood boxes on the hall floor, stepping up towards −x). */
function findStair(boxes: readonly MapBox[]): StairInfo | null {
  const steps = boxes
    .filter((b) => b.mat === 'wood' && b.visible !== false && b.center.y - b.size.y / 2 < 0.01)
    .map(boxBounds)
    .filter(
      ({ min, max }) =>
        min.x >= HALL_INNER.x0 &&
        max.x <= HALL_INNER.x1 &&
        min.z > 25 &&
        max.z <= HALL_INNER.z1 &&
        max.x - min.x < 0.4 &&
        max.y > 0.1,
    )
    .map(({ min, max }) => ({ x0: min.x, x1: max.x, top: max.y, z0: min.z, z1: max.z }))
    .sort((a, b) => a.top - b.top);
  if (steps.length < 4) return null;
  return { steps, z0: steps[0]!.z0, z1: steps[0]!.z1 };
}

function pierAt(c: Ctx, l: WallLine, a: number, y0: number, y1: number, floor: number): void {
  const brick = over('tile', '#93503b');
  const dark = over('tile', '#5c3529');
  const glaze = { su: 0.6, sv: 1 }; // glazed brick: 25 × 7.5 cm out of the 15 cm subway tile
  c.push(
    wallSlab(l, a - PIER_W / 2, a + PIER_W / 2, y0, y1, 0, 0.08, {
      mat: 'tile',
      tint: brick,
      floor,
      grime: 0.18,
      cell: 1.2,
      uv: glaze,
      vary: 0.06,
    }),
  );
  // Plinth and capital: a darker glazed course, a little proud.
  c.push(
    wallSlab(l, a - 0.3, a + 0.3, y0, y0 + 0.24, 0, 0.11, {
      mat: 'tile',
      tint: dark,
      floor,
      grime: 0.25,
      uv: glaze,
    }),
  );
  c.push(
    wallSlab(l, a - 0.3, a + 0.3, y1 - 0.14, y1, 0, 0.11, { mat: 'tile', tint: dark, uv: glaze }),
  );
}

/** Piers at the candidate positions where the wall is solid round them for the whole storey. */
function piers(
  c: Ctx,
  l: WallLine,
  y0: number,
  y1: number,
  floor: number,
  skip: (a: number) => boolean,
): number[] {
  const at = l.axis === 'x' ? (y0 < 1 ? GF_PIER_X : UF_PIER_X) : END_PIER_Z;
  const solid = solidSpans(l, y0, y1);
  const placed: number[] = [];
  for (const a of at) {
    if (skip(a)) continue;
    if (!solid.some(([s0, s1]) => s0 <= a - 0.36 && s1 >= a + 0.36)) continue;
    pierAt(c, l, a, y0, y1, floor);
    placed.push(a);
  }
  return placed;
}

const SHUTTER_TINTS = ['#8c998e', '#8592a0', '#8e7563', '#8f8f70', '#9aa39a'];
const SIGN_TINTS = ['#2f5e59', '#b08a3e', '#7a3530', '#d6ccb1', '#2e3f58', '#5d6b3c'];
const SIGN_STRIPES = ['#e8dfc6', '#1f2321', '#c9a04e'];

/** A closed roller shutter (stall front) with its guides, housing and a blank painted board. */
function shutter(c: Ctx, l: WallLine, a0: number, a1: number, n: number): void {
  const f = L.floor;
  const steel = over('paint', '#4a504c');
  const slats = over('tile', SHUTTER_TINTS[n % SHUTTER_TINTS.length]!);
  // Curtain: the subway tile's courses as 9 cm slats; u held at 0.0375 m, mid-way between its
  // vertical joints in both bond courses, so no joint ever shows.
  c.push(
    wallSlab(l, a0 + 0.05, a1 - 0.05, f, 2.3, 0, 0.042, {
      mat: 'tile',
      tint: slats,
      floor: f,
      grime: 0.3,
      cell: 1.0,
      uv: { su: 0, sv: 0.833, ou: 0.0375 },
      vary: 0.05,
    }),
  );
  c.push(
    wallSlab(l, a0 + 0.05, a1 - 0.05, f, f + 0.06, 0.042, 0.055, {
      mat: 'paint',
      tint: steel,
      floor: f,
    }),
  );
  for (const [g0, g1] of [
    [a0, a0 + 0.05],
    [a1 - 0.05, a1],
  ] as const)
    c.push(wallSlab(l, g0, g1, f, 2.32, 0, 0.06, { mat: 'paint', tint: steel, floor: f }));
  c.push(
    wallSlab(l, a0 - 0.02, a1 + 0.02, 2.3, 2.54, 0, 0.22, { mat: 'paint', tint: steel, cell: 1.2 }),
  );
  // Signboard: blank, two-tone with an abstract stripe (no text, no marks).
  const bg = over('paint', SIGN_TINTS[(n * 7 + 3) % SIGN_TINTS.length]!);
  const st = over('paint', SIGN_STRIPES[n % SIGN_STRIPES.length]!);
  const s0 = a0 + 0.12;
  const s1 = a1 - 0.12;
  c.push(
    wallSlab(l, s0, s1, 2.6, 2.9, 0, 0.035, { mat: 'paint', tint: bg, cell: 1.2, vary: 0.08 }),
  );
  const w = s1 - s0;
  const k = hash(n, a0, 3);
  if (k < 0.5) {
    c.push(wallSlab(l, s0, s1, 2.66, 2.69, 0.035, 0.04, { mat: 'paint', tint: st }));
    c.push(wallSlab(l, s0, s1, 2.81, 2.84, 0.035, 0.04, { mat: 'paint', tint: st }));
  } else {
    const b0 = s0 + w * (0.08 + 0.2 * k);
    c.push(wallSlab(l, b0, b0 + w * 0.18, 2.6, 2.9, 0.035, 0.04, { mat: 'paint', tint: st }));
    c.push(
      wallSlab(l, b0 + w * 0.22, b0 + w * 0.26, 2.6, 2.9, 0.035, 0.04, { mat: 'paint', tint: st }),
    );
  }
}

/**
 * A filled sack lying along wall `l`, centred at `a`, resting at `y`: a squashed ellipsoid with a
 * flat underside and pinched ends, 0.22 m deep. Uvs stay in the burlap half of the sandbag texture
 * (v 0.95–1.9 m of its 1.9 m tile).
 */
function sack(l: WallLine, a: number, y: number, len: number, tint: Rgb): HallPiece {
  const g = new THREE.SphereGeometry(1, 12, 8);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const centre = onWall(l, a, y + 0.068, 0.12);
  for (let i = 0; i < pos.count; i++) {
    const sy = Math.max(pos.getY(i), -0.72); // settled flat on the floor
    const along = pos.getX(i) * (len / 2) * (1 - 0.18 * sy * sy);
    const deep = pos.getZ(i) * 0.11;
    // East/west walls: a quarter turn about y (along → −z, deep → x), not an axis swap: a swap
    // is a reflection and would turn the sphere's winding inside out.
    const p = l.axis === 'x' ? { x: along, z: deep } : { x: deep, z: -along };
    pos.setXYZ(i, centre.x + p.x, centre.y + sy * 0.095, centre.z + p.z);
    uv.setXY(i, uv.getX(i) * len * 2 + a, 1.0 + uv.getY(i) * 0.8);
  }
  g.computeVertexNormals();
  // The sphere's spare pole vertices belong to no triangle: give them a unit normal anyway.
  const nrm = g.getAttribute('normal');
  for (let i = 0; i < nrm.count; i++) {
    if (Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) < 0.5)
      nrm.setXYZ(i, 0, pos.getY(i) > centre.y ? 1 : -1, 0);
  }
  return fromGeometry(g, 'sandbag', 'hall-dressing', tint, 0.1, a + y, false);
}

/** Sacks and produce crates against a wall, ≤ 0.24 m deep and knee-high. */
function stock(c: Ctx, l: WallLine, a0: number, a1: number, n: number): void {
  const f = L.floor;
  const burlap = over('sandbag', '#ad9b78');
  let a = a0 + 0.1;
  let i = 0;
  while (a + 0.62 < a1 && i < 4) {
    const kind = hash(n * 13 + i, a, 11);
    if (kind < 0.5) {
      // A pile of filled sacks: one or two lying against the wall, one on top.
      const two = a + 1.25 < a1;
      c.push(sack(l, a + 0.3, f, 0.6, burlap));
      if (two) c.push(sack(l, a + 0.93, f, 0.6, burlap));
      c.push(sack(l, two ? a + 0.62 : a + 0.3, f + 0.14, two ? 0.62 : 0.5, burlap));
      a += two ? 1.4 : 0.75;
    } else {
      // An open slatted crate of produce (crate 0.5 × 0.22 deep × 0.3, fruit heaped in it).
      const wood = over('wood', '#9b7752');
      const p0 = a;
      const p1 = a + 0.5;
      for (const [d0, d1] of [
        [0.0, 0.02],
        [0.2, 0.22],
      ] as const)
        c.push(
          wallSlab(l, p0, p1, f, f + 0.3, d0, d1, {
            mat: 'wood',
            kind: 'hall-dressing',
            tint: wood,
            floor: f,
            uv: { su: 2, sv: 2 },
          }),
        );
      for (const [e0, e1] of [
        [p0, p0 + 0.02],
        [p1 - 0.02, p1],
      ] as const)
        c.push(
          wallSlab(l, e0, e1, f, f + 0.3, 0.02, 0.2, {
            mat: 'wood',
            kind: 'hall-dressing',
            tint: wood,
            floor: f,
          }),
        );
      const produce = ['#a3271c', '#d9781c', '#6b8f3a', '#b88a4a', '#9a7a52'][(n + i) % 5]!;
      const fruit = new THREE.IcosahedronGeometry(0.05, 0);
      const fr = over('paint', produce);
      for (let k = 0; k < 8; k++) {
        const s = p0 + 0.07 + (k % 4) * 0.12 + (hash(k, a, 5) - 0.5) * 0.03;
        const d = 0.06 + Math.floor(k / 4) * 0.09;
        const y = f + 0.26 + hash(k, a, 9) * 0.03;
        const at = onWall(l, s, y, d);
        const g = fruit.clone();
        g.translate(at.x, at.y, at.z);
        const piece = fromGeometry(g, 'paint', 'hall-dressing', fr, 0.1, k + a);
        c.push(piece);
      }
      fruit.dispose();
      a += 0.62;
    }
    i++;
  }
}

/** Wrap a ready geometry (non-indexed or indexed) as a piece with a flat jittered tint. */
function fromGeometry(
  g: THREE.BufferGeometry,
  mat: MaterialId,
  kind: HallPieceKind,
  tint: Rgb,
  vary: number,
  seed: number,
  planar = true,
): HallPiece {
  const geo = g;
  const n = geo.getAttribute('position').count;
  if (!geo.index) geo.setIndex([...Array(n).keys()]);
  const k = 1 + (hash(seed, n, 17) - 0.5) * 2 * vary;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([tint[0] * k, tint[1] * k, tint[2] * k], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (planar) {
    // Fruit: the paint's orange-peel grain at fruit scale.
    const pos = geo.getAttribute('position');
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) uv.set([pos.getX(i) * 6, pos.getY(i) * 6], i * 2);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, mat, kind };
}

/** Painted render (cream) above a dado whose top is at `base`. */
function creamRender(base: number): BoxOpts {
  return {
    mat: 'trim',
    kind: 'hall-wall',
    tint: over('trim', '#ddd3bd'),
    floor: base,
    grime: 0.07,
    grimeReach: 0.6,
    cell: 1.2,
    uv: { su: 0.5, sv: 0.5 }, // its gentle undulation at 4 m, not 2 m
    vary: 0.02,
  };
}

/** Ground floor walls: tiled dado, piers, cornice, conduit, door casings, stall fronts. */
function groundFloorWalls(c: Ctx, l: WallLine): void {
  const f = L.floor;
  const stairX = c.stair ? Math.min(...c.stair.steps.map((s) => s.x0)) - 0.4 : Infinity;
  const nearStair = (a: number): boolean =>
    (l.name === 'south' && a > stairX) || (l.name === 'east' && a > 25.4);
  // Glazed tile: dark cove/plinth course, the field, a dark capping course + painted rail.
  for (const r of bandRects(l, f, 0.2))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.02, {
        mat: 'tile',
        tint: over('tile', '#455f51'),
        floor: f,
        grime: 0.3,
        cell: 1.2,
      }),
    );
  for (const r of bandRects(l, 0.2, 1.3))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.012, {
        mat: 'tile',
        tint: over('tile', '#c3d0ba'),
        floor: f,
        grime: 0.2,
        grimeReach: 0.7,
        cell: 1.0,
      }),
    );
  for (const r of bandRects(l, 1.3, 1.36))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.035, {
        mat: 'paint',
        tint: over('paint', '#2f4a3e'),
      }),
    );
  // Above the dado: painted render, clean warm cream. Drawn with the procedural trim surface
  // (low-variation satin, no scanned stains: the plaster scan's blotches read as dirty concrete);
  // only a faint low-frequency ageing just above the rail.
  for (const r of bandRects(l, 1.36, 3.17))
    c.push(wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.004, creamRender(1.36)));
  // Cornice under the upper floor and a conduit run below it.
  for (const r of bandRects(l, 3.17, L.ceiling))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.06, {
        mat: 'wood',
        tint: over('wood', '#4f3b2a'),
        cell: 1.5,
      }),
    );
  for (const r of bandRects(l, 2.95, 2.975))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0.02, 0.045, {
        mat: 'paint',
        tint: over('paint', '#6b6f70'),
      }),
    );

  const placed = piers(c, l, f, 3.17, f, nearStair);

  // Doors (gaps at head height with wall above): casings and steel thresholds.
  for (const o of openings(l, 1.2)) {
    if (o.y1 > 3.2) continue; // not a door
    const casing = over('wood', '#46362a');
    c.push(
      wallSlab(l, o.a0 - 0.1, o.a0, f, o.y1 + 0.1, 0, 0.025, {
        mat: 'wood',
        tint: casing,
        floor: f,
      }),
    );
    c.push(
      wallSlab(l, o.a1, o.a1 + 0.1, f, o.y1 + 0.1, 0, 0.025, {
        mat: 'wood',
        tint: casing,
        floor: f,
      }),
    );
    c.push(
      wallSlab(l, o.a0 - 0.1, o.a1 + 0.1, o.y1, o.y1 + 0.1, 0, 0.025, {
        mat: 'wood',
        tint: casing,
      }),
    );
    // Threshold across the wall's thickness, 1.5 cm proud of the terrazzo.
    c.push(
      wallSlab(l, o.a0, o.a1, 0, f + 0.015, -2 * WALL_HALF, 0.05, {
        kind: 'hall-floor',
        mat: 'metal',
        tint: over('metal', '#9da2a4'),
        uv: { su: 1, sv: 1 },
      }),
    );
  }

  // Stall fronts in the bays between piers and doors (not at the stair, nor at door casings).
  let n = l.name.length * 3;
  for (const [s0, s1] of solidSpans(l, f, 2.95)) {
    const bays = subtract(
      [s0 + 0.15, s1 - 0.15],
      placed.map((a): [number, number] => [a - 0.31, a + 0.31]),
    );
    for (const [b0, b1] of bays) {
      if (b1 - b0 < 1.6 || nearStair(b1) || nearStair(b0)) continue;
      const w = Math.min(b1 - b0 - 0.1, 2.8);
      const m = (b0 + b1) / 2;
      const roll = hash(n, m, 23);
      if (roll < 0.72) shutter(c, l, m - w / 2, m + w / 2, n);
      if (roll > 0.35) stock(c, l, m - w / 2, m + w / 2, n);
      n++;
    }
  }
}

/** Interval `span` minus `cuts`, as sorted intervals. */
function subtract(span: [number, number], cuts: readonly [number, number][]): [number, number][] {
  let out: [number, number][] = span[1] > span[0] ? [span] : [];
  for (const [c0, c1] of cuts) {
    out = out.flatMap(([a, b]): [number, number][] => {
      if (c1 <= a || c0 >= b) return [[a, b]];
      const keep: [number, number][] = [];
      if (c0 > a) keep.push([a, c0]);
      if (c1 < b) keep.push([c1, b]);
      return keep;
    });
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** Upper floor walls: timber skirting, painted dado, piers, wall plate, conduit, vents. */
function upperFloorWalls(c: Ctx, l: WallLine): void {
  const f = L.upper;
  for (const r of bandRects(l, f, f + 0.12))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.02, {
        mat: 'wood',
        tint: over('wood', '#4f3b2a'),
        floor: f,
        grime: 0.2,
      }),
    );
  // Paint over the render: the plaster's own stains show through, darker towards the floor.
  for (const r of bandRects(l, f + 0.12, f + 1.22))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.006, {
        mat: 'plaster',
        tint: over('plaster', '#6f8580'),
        floor: f,
        grime: 0.22,
        grimeReach: 0.8,
        cell: 1.0,
      }),
    );
  for (const r of bandRects(l, f + 1.22, f + 1.26))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.008, {
        mat: 'plaster',
        tint: over('plaster', '#3d4b47'),
      }),
    );
  const long = l.axis === 'x';
  for (const r of bandRects(l, f + 1.26, long ? 6.85 : 6.95))
    c.push(wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, 0.004, creamRender(f + 1.26)));
  for (const r of bandRects(l, long ? 6.85 : 6.95, L.roof))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0, long ? 0.1 : 0.06, {
        mat: 'wood',
        tint: over('wood', '#5a4430'),
        cell: 1.5,
      }),
    );
  for (const r of bandRects(l, 6.6, 6.625))
    c.push(
      wallSlab(l, r.a0, r.a1, r.y0, r.y1, 0.02, 0.045, {
        mat: 'paint',
        tint: over('paint', '#6b6f70'),
      }),
    );
  piers(c, l, f, long ? 6.85 : 6.95, f, () => false);

  // Steel windows: slim jambs, head and one mullion in the opening, on a timber sill.
  for (const o of openings(l, 5.1)) {
    if (o.y0 < f + 0.5) continue; // a door, not a window
    const frame = over('paint', '#34433d');
    const mid = -WALL_HALF; // the wall's centre plane, in depth from the inner face
    const opts = { kind: 'hall-window' as const, mat: 'paint' as const, tint: frame };
    const t = 0.035;
    c.push(wallSlab(l, o.a0, o.a0 + t, o.y0, o.y1, mid - 0.03, mid + 0.03, opts));
    c.push(wallSlab(l, o.a1 - t, o.a1, o.y0, o.y1, mid - 0.03, mid + 0.03, opts));
    c.push(wallSlab(l, o.a0 + t, o.a1 - t, o.y1 - t, o.y1, mid - 0.03, mid + 0.03, opts));
    const m = (o.a0 + o.a1) / 2;
    c.push(
      wallSlab(l, m - t / 2, m + t / 2, o.y0 + 0.03, o.y1 - t, mid - 0.025, mid + 0.025, opts),
    );
    c.push(
      wallSlab(l, o.a0, o.a1, o.y0, o.y0 + 0.03, mid, 0.06, {
        ...opts,
        mat: 'wood',
        tint: over('wood', '#6e5238'),
      }),
    );
  }

  // Louvred vents high on the long walls, between the piers.
  if (long) {
    for (const a of [134, 143.5]) {
      if (!solidSpans(l, 6.1, 6.55).some(([s0, s1]) => s0 <= a - 0.4 && s1 >= a + 0.4)) continue;
      const grille = over('metal', '#6e7478');
      c.push(
        wallSlab(l, a - 0.32, a + 0.32, 6.1, 6.55, 0, 0.02, {
          mat: 'metal',
          tint: over('metal', '#3a3e40'),
        }),
      );
      for (let k = 0; k < 4; k++) {
        const y = 6.15 + k * 0.1;
        const p = onWall(l, a, y + 0.03, 0.04);
        const q = onWall(l, a + 0.3, y + 0.03, 0.04);
        const side = l.axis === 'x' ? Z : X;
        const tilt = { x: side.x * l.inward, y: 0.7, z: side.z * l.inward };
        const b = bar({ x: 2 * p.x - q.x, y: p.y, z: 2 * p.z - q.z }, q, 0.012, 0.06, tilt, {
          mat: 'metal',
          kind: 'hall-wall',
          tint: grille,
        });
        c.push(b);
      }
    }
  }
}

/** Partitions upstairs: vertical timber boards on every face, a steel cap, timber skirting. */
function partitions(c: Ctx, boxes: readonly MapBox[], lines: readonly WallLine[]): void {
  for (const b of boxes) {
    if (!isHallPlaster(b)) continue;
    const { min, max } = boxBounds(b);
    const onLine = lines.some((l) =>
      l.axis === 'x'
        ? Math.abs(b.center.z - (l.face - l.inward * WALL_HALF)) <= 0.05
        : Math.abs(b.center.x - (l.face - l.inward * WALL_HALF)) <= 0.05,
    );
    if (onLine) continue;
    const boards = over('wood', '#8a6a49');
    const e = 0.012;
    const y0 = min.y;
    const opts = (tint: Rgb, y: number): BoxOpts => ({
      mat: 'wood',
      kind: 'hall-cover',
      tint,
      floor: y,
      grime: 0.2,
      cell: 1.2,
      uv: { swap: true, su: 1, sv: 1 },
      vary: 0.05,
    });
    // Four sides as skins (1.2 cm), a skirting (2 cm) and a steel cap (1.6 cm, 1.2 cm higher).
    c.push(
      aabb(
        { x: min.x - e, y: y0 + 0.1, z: min.z - e },
        { x: max.x + e, y: max.y - 0.05, z: max.z + e },
        { ...opts(boards, y0), skip: ['-y', '+y'] },
      ),
    );
    c.push(
      aabb(
        { x: min.x - 0.02, y: y0, z: min.z - 0.02 },
        { x: max.x + 0.02, y: y0 + 0.1, z: max.z + 0.02 },
        { ...opts(over('wood', '#4f3b2a'), y0), skip: ['-y'], uv: {} },
      ),
    );
    c.push(
      aabb(
        { x: min.x - 0.016, y: max.y - 0.05, z: min.z - 0.016 },
        { x: max.x + 0.016, y: max.y + 0.012, z: max.z + 0.016 },
        { mat: 'paint', kind: 'hall-cover', tint: over('paint', '#3a3f3c'), skip: ['-y'] },
      ),
    );
  }
}

/** Chequered terrazzo with an oxblood border and brass strips; one quad per 1.2 m panel. */
function groundFloor(c: Ctx): void {
  const y = L.floor + 0.004;
  const I = HALL_INNER;
  // 0.6 m tiles: the terrazzo's uvs are doubled, so its divider strips (every 1.2 m of texture)
  // fall on the 0.6 m grid and its chips are half size (a finer speckle).
  const TILE = 0.6;
  const border = 0.75;
  const lines = (lo: number, hi: number): number[] => {
    const out = new Set<number>([lo, hi, lo + border, hi - border]);
    for (let v = Math.ceil(lo / TILE) * TILE; v < hi; v += TILE)
      out.add(Math.round(v * 1000) / 1000);
    return [...out]
      .filter((v) => v >= lo && v <= hi)
      .sort((p, q) => p - q)
      .filter((v, i, a) => i === 0 || v - a[i - 1]! > 1e-3);
  };
  const xs = lines(I.x0, I.x1);
  const zs = lines(I.z0, I.z1);
  // A quiet two-tone field (close values), an oxblood band round the walls.
  const cream = over('terrazzo', '#cdc4b2');
  const grey = over('terrazzo', '#b5ae9f');
  const oxblood = over('terrazzo', '#8c4a3a');
  const up = { x: 0, y: 1, z: 0 };
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      const z0 = zs[j]!;
      const z1 = zs[j + 1]!;
      if (x1 - x0 < 1e-3 || z1 - z0 < 1e-3) continue;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const edge =
        cx < I.x0 + border || cx > I.x1 - border || cz < I.z0 + border || cz > I.z1 - border;
      const chequer = (Math.floor(cx / TILE) + Math.floor(cz / TILE)) % 2 === 0;
      const tint = edge ? oxblood : chequer ? cream : grey;
      const k = 1 + (hash(cx, cz, 31) - 0.5) * 0.05;
      const stain = hash(cz, cx, 37) > 0.96 ? 0.92 : 1;
      c.push(
        quad(
          x0,
          z0,
          x1,
          z1,
          y,
          up,
          'terrazzo',
          'hall-floor',
          [tint[0] * k * stain, tint[1] * k * stain, tint[2] * k * stain],
          2,
        ),
      );
    }
  }
  // Brass strip round the border's inner edge.
  // Brass: the paint surface (semi-gloss, part metallic) in a brass tint, sharing its draw.
  const brass = over('paint', '#b8914c');
  const s = 0.012;
  const b = { x0: I.x0 + border, x1: I.x1 - border, z0: I.z0 + border, z1: I.z1 - border };
  const strip = {
    mat: 'paint' as const,
    kind: 'hall-floor' as const,
    tint: brass,
    skip: ['-y'] as Face[],
  };
  c.push(
    aabb(
      { x: b.x0 - s, y: L.floor, z: b.z0 - s },
      { x: b.x1 + s, y: y + 0.0015, z: b.z0 + s },
      strip,
    ),
  );
  c.push(
    aabb(
      { x: b.x0 - s, y: L.floor, z: b.z1 - s },
      { x: b.x1 + s, y: y + 0.0015, z: b.z1 + s },
      strip,
    ),
  );
  c.push(
    aabb(
      { x: b.x0 - s, y: L.floor, z: b.z0 + s },
      { x: b.x0 + s, y: y + 0.0015, z: b.z1 - s },
      strip,
    ),
  );
  c.push(
    aabb(
      { x: b.x1 - s, y: L.floor, z: b.z0 + s },
      { x: b.x1 + s, y: y + 0.0015, z: b.z1 - s },
      strip,
    ),
  );
}

function quad(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  n: V3,
  mat: MaterialId,
  kind: HallPieceKind,
  tint: Rgb,
  uvScale = 1,
): HallPiece {
  const down = n.y < 0;
  const p = [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ] as const;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const [x, z] of p) {
    pos.push(x, y, z);
    const [u, v] = planarUv({ x, y, z }, n);
    uv.push(u * uvScale, v * uvScale);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      [n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z],
      3,
    ),
  );
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      [0, 1, 2, 3].flatMap(() => [tint[0], tint[1], tint[2]]),
      3,
    ),
  );
  // Up faces wind (0, 3, 2) with x → z ⇒ +y; down faces the other way.
  geo.setIndex(down ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, mat, kind, perVertex: true };
}

/** Painted panels between the joists under the upper floor (not over the stair well). */
function groundFloorCeiling(c: Ctx, boxes: readonly MapBox[]): void {
  const joists = boxes
    .filter((b) => b.mat === 'wood' && b.visible !== false && b.size.x < 0.25 && b.size.z > 4)
    .map(boxBounds)
    .filter(({ min, max }) => inHall(min, max) && max.y <= L.ceiling + 1e-3 && min.y > 2.8);
  const xs = [
    ...new Set(joists.map(({ min, max }) => Math.round(((min.x + max.x) / 2) * 100) / 100)),
  ].sort((p, q) => p - q);
  const edges = [HALL_INNER.x0, ...xs.flatMap((x) => [x - 0.09, x + 0.09]), HALL_INNER.x1];
  // Bays beside joists that stop short of the south wall stop there too (the stair well).
  const zEnd = (x0: number, x1: number): number =>
    Math.min(
      HALL_INNER.z1,
      ...joists
        .filter(({ min, max }) => max.x > x0 - 0.3 && min.x < x1 + 0.3)
        .map(({ max }) => (max.z >= HALL_INNER.z1 ? HALL_INNER.z1 : max.z - 0.05)),
    );
  // Painted tongue-and-groove boards across each bay (the clean paint surface, warm off-white),
  // 14 cm wide with a 1 cm groove that shows the dark timber slab above.
  const paint = over('paint', '#e2d8c6');
  const y = L.ceiling - 0.004;
  const down = { x: 0, y: -1, z: 0 };
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const x0 = edges[i]!;
    const x1 = edges[i + 1]!;
    if (x1 - x0 < 0.2) continue;
    const z1 = zEnd(x0, x1);
    for (let z = HALL_INNER.z0; z + 0.05 < z1; z += 0.15) {
      const k = 1 + (hash(x0, z, 43) - 0.5) * 0.05;
      c.push(
        quad(x0, z, x1, Math.min(z + 0.14, z1), y, down, 'paint', 'hall-ceiling', [
          paint[0] * k,
          paint[1] * k,
          paint[2] * k,
        ]),
      );
    }
  }
}

/** Roof: beams sheathed as dark steel I-beams, knee braces, timber sarking, a duct. */
function roof(c: Ctx, boxes: readonly MapBox[]): void {
  const beams = boxes
    .filter((b) => b.mat === 'trim' && b.visible !== false && b.size.z > 4 && b.size.x < 0.3)
    .map(boxBounds)
    .filter(({ min, max }) => inHall(min, max) && Math.abs(max.y - L.roof) < 0.01);
  const steel = over('paint', '#3a4440');
  const steelOpts = {
    mat: 'paint' as const,
    kind: 'hall-ceiling' as const,
    tint: steel,
    cell: 1.5,
  };
  const z0 = HALL_INNER.z0;
  const z1 = HALL_INNER.z1;
  const xs = beams.map(({ min, max }) => (min.x + max.x) / 2).sort((p, q) => p - q);
  for (const { min, max } of beams) {
    const x = (min.x + max.x) / 2;
    const yb = min.y;
    // Web skins, bottom and top flanges.
    c.push(
      aabb(
        { x: min.x - 0.008, y: yb + 0.03, z: z0 },
        { x: max.x + 0.008, y: L.roof - 0.03, z: z1 },
        { ...steelOpts, skip: ['-y', '+y', '-z', '+z'] },
      ),
    );
    c.push(
      aabb(
        { x: x - 0.16, y: yb - 0.004, z: z0 },
        { x: x + 0.16, y: yb + 0.03, z: z1 },
        { ...steelOpts, skip: ['-z', '+z'] },
      ),
    );
    c.push(
      aabb(
        { x: x - 0.16, y: L.roof - 0.03, z: z0 },
        { x: x + 0.16, y: L.roof, z: z1 },
        { ...steelOpts, skip: ['+y', '-z', '+z'] },
      ),
    );
    // Knee braces to the walls, above any upstairs eye (stand + jump).
    for (const [zw, dir] of [
      [z0, 1],
      [z1, -1],
    ] as const) {
      c.push(
        bar({ x, y: 6.42, z: zw }, { x, y: yb - 0.004, z: zw + dir * 0.75 }, 0.07, 0.08, X, {
          ...steelOpts,
          cell: 0,
        }),
      );
      c.push(
        aabb(
          { x: x - 0.1, y: 6.3, z: Math.min(zw, zw + dir * 0.02) },
          { x: x + 0.1, y: 6.62, z: Math.max(zw, zw + dir * 0.02) },
          { ...steelOpts, cell: 0 },
        ),
      );
    }
  }
  // Sarking boards between the beams (and between the end beams and the walls).
  const edges = [HALL_INNER.x0, ...xs.flatMap((x) => [x - 0.16, x + 0.16]), HALL_INNER.x1];
  const boards = over('wood', '#94744f');
  for (let i = 0; i + 1 < edges.length; i += 2) {
    if (edges[i + 1]! - edges[i]! < 0.1) continue;
    c.push(
      aabb(
        { x: edges[i]!, y: L.roof - 0.014, z: z0 },
        { x: edges[i + 1]!, y: L.roof - 0.002, z: z1 },
        {
          mat: 'wood',
          kind: 'hall-ceiling',
          tint: boards,
          skip: ['+y', '-z', '+z'],
          cell: 1.5,
          uv: { su: 2, sv: 2 },
          vary: 0.05,
        },
      ),
    );
  }
  // Galvanised duct along the north wall, just inside the knee braces, square to the beams and
  // strapped to their bottom flanges, with two diffusers. It stops short of the upstairs crate
  // at (149, 16): someone standing on it could jump into the duct.
  const dz0 = HALL_INNER.z0 + 1.0;
  const dz1 = dz0 + 0.45;
  const dx1 = 147.6;
  const dy0 = 6.55;
  const dy1 = 6.82;
  const galv = over('metal', '#a3a8aa');
  c.push(
    aabb(
      { x: HALL_INNER.x0 + 0.9, y: dy0, z: dz0 },
      { x: dx1, y: dy1, z: dz1 },
      {
        mat: 'metal',
        kind: 'hall-ceiling',
        tint: galv,
        cell: 1.5,
        // Diamond plate stretched along the run reads as rolled-steel streaks.
        uv: { su: 0.04, sv: 1 },
      },
    ),
  );
  for (const x of xs) {
    if (x < HALL_INNER.x0 + 1 || x > dx1 - 0.1) continue;
    c.push(
      aabb(
        { x: x - 0.025, y: dy0 - 0.012, z: dz0 - 0.012 },
        { x: x + 0.025, y: dy1, z: dz1 + 0.012 },
        { ...steelOpts, cell: 0, skip: ['+y'] },
      ),
    );
  }
  for (const x of [135, 143]) {
    c.push(
      aabb(
        { x: x - 0.3, y: dy0 - 0.03, z: dz0 + 0.06 },
        { x: x + 0.3, y: dy0, z: dz1 - 0.06 },
        { mat: 'metal', kind: 'hall-ceiling', tint: over('metal', '#4c5154'), skip: ['+y'] },
      ),
    );
  }
}

/** Stair: steel nosings; upstairs a guard rail round the void, a balustrade up the open side. */
function stairAndRails(c: Ctx, boxes: readonly MapBox[]): void {
  const s = c.stair;
  if (!s) return;
  const nosing = over('metal', '#9a9fa3');
  for (const st of s.steps) {
    // The climb runs towards −x: each tread's leading edge is its +x end.
    c.push(
      aabb(
        { x: st.x1 - 0.045, y: st.top - 0.03, z: s.z0 + 0.01 },
        { x: st.x1 + 0.004, y: st.top + 0.004, z: s.z1 - 0.01 },
        {
          mat: 'metal',
          kind: 'hall-stair',
          tint: nosing,
          skip: ['-y'],
        },
      ),
    );
  }
  const rail = over('paint', '#2f3a36');
  const ro = { mat: 'paint' as const, kind: 'hall-railing' as const, tint: rail };
  const timber = {
    mat: 'wood' as const,
    kind: 'hall-railing' as const,
    tint: over('wood', '#6b4a30'),
  };
  // The void: upper-floor slabs end round it (market.ts: the well).
  const top = s.steps.at(-1)!;
  const bottom = s.steps[0]!;
  const voidX0 = top.x0;
  const voidX1 = bottom.x1;
  const slabs = boxes
    .filter((b) => b.mat === 'wood' && Math.abs(b.center.y + b.size.y / 2 - L.upper) < 0.01)
    .map(boxBounds);
  const voidZ0 = Math.max(
    ...slabs
      .filter(({ min, max }) => min.x < voidX1 && max.x > voidX0 && max.z <= s.z0 + 0.1)
      .map(({ max }) => max.z),
  );
  const uf = L.upper;
  const posts = (from: V3, to: V3, n: number, side: V3): void => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = { x: from.x + (to.x - from.x) * t, y: uf - 0.2, z: from.z + (to.z - from.z) * t };
      c.push(
        aabb(
          { x: p.x - 0.022, y: p.y, z: p.z - 0.022 },
          { x: p.x + 0.022, y: uf + 1.0, z: p.z + 0.022 },
          ro,
        ),
      );
    }
    for (const y of [uf + 0.5, uf + 0.98])
      c.push(
        bar(
          { ...from, y },
          { ...to, y },
          y > uf + 0.9 ? 0.05 : 0.025,
          y > uf + 0.9 ? 0.07 : 0.025,
          side,
          y > uf + 0.9 ? timber : ro,
        ),
      );
  };
  // Side-mounted on the slab's edge, over the void: the floor stays clear to its edge.
  const zr = voidZ0 + 0.03;
  const xe = voidX1 - 0.03;
  posts(
    { x: voidX0 + 0.05, y: 0, z: zr },
    { x: xe, y: 0, z: zr },
    Math.ceil((xe - voidX0) / 1.1),
    Y,
  );
  posts({ x: xe, y: 0, z: zr }, { x: xe, y: 0, z: s.z1 + 0.02 }, 2, Y);
  // Fascia on the slab edge.
  c.push(
    aabb(
      { x: voidX0, y: L.ceiling, z: voidZ0 },
      { x: voidX1, y: uf, z: voidZ0 + 0.012 },
      { mat: 'wood', kind: 'hall-railing', tint: over('wood', '#4f3b2a') },
    ),
  );
  // Balustrade up the stair's open side: posts on every other tread, a timber handrail and a
  // steel mid-rail following the pitch.
  const zb = s.z0 + 0.04;
  const run = (bottom.x1 - top.x0) / s.steps.length;
  const rise = top.top / s.steps.length;
  const pitchY = (x: number, h: number): number => (bottom.x1 - x) * (rise / run) + rise + h;
  s.steps.forEach((st, i) => {
    if (i % 2 !== 0 && i !== s.steps.length - 1) return;
    const x = st.x1 - 0.06;
    c.push(
      aabb(
        { x: x - 0.022, y: st.top, z: zb - 0.022 },
        { x: x + 0.022, y: pitchY(x, 0.88), z: zb + 0.022 },
        ro,
      ),
    );
  });
  const xa = bottom.x1 - 0.06;
  const xb = top.x0 + 0.05;
  c.push(
    bar(
      { x: xa, y: pitchY(xa, 0.9), z: zb },
      { x: xb, y: pitchY(xb, 0.9), z: zb },
      0.05,
      0.07,
      Z,
      timber,
    ),
  );
  c.push(
    bar(
      { x: xa, y: pitchY(xa, 0.45), z: zb },
      { x: xb, y: pitchY(xb, 0.45), z: zb },
      0.025,
      0.025,
      Z,
      ro,
    ),
  );
}

/**
 * Counters (cover): vertical timber boarding, a dark zinc top, a dark kick strip. Skins ≤ 1.2 cm.
 * Dark and warm, so they read as market counters and the cover silhouette stays legible.
 */
function counters(c: Ctx, boxes: readonly MapBox[]): void {
  for (const b of boxes) {
    if (b.mat !== 'wood' || b.visible === false || b.model) continue;
    const { min, max } = boxBounds(b);
    if (!inHall(min, max) || min.y > 0.01 || max.y < 0.8 || max.y > 1.3) continue;
    if (max.x - min.x < 0.8 || max.z - min.z < 0.8) continue; // treads are narrower
    const e = 0.01;
    c.push(
      aabb(
        { x: min.x - e, y: L.floor + 0.12, z: min.z - e },
        { x: max.x + e, y: max.y - 0.06, z: max.z + e },
        {
          mat: 'wood',
          kind: 'hall-cover',
          tint: over('wood', '#6b4f36'),
          floor: L.floor,
          grime: 0.2,
          skip: ['+y', '-y'],
          cell: 1.0,
          uv: { swap: true },
          vary: 0.06,
        },
      ),
    );
    c.push(
      aabb(
        { x: min.x - e - 0.002, y: L.floor, z: min.z - e - 0.002 },
        { x: max.x + e + 0.002, y: L.floor + 0.12, z: max.z + e + 0.002 },
        {
          mat: 'paint',
          kind: 'hall-cover',
          tint: over('paint', '#2f3a36'),
          floor: L.floor,
          skip: ['+y', '-y'],
        },
      ),
    );
    c.push(
      aabb(
        { x: min.x - e, y: max.y - 0.06, z: min.z - e },
        { x: max.x + e, y: max.y + 0.012, z: max.z + e },
        {
          mat: 'metal',
          kind: 'hall-cover',
          tint: over('metal', '#5b6164'),
          skip: ['-y'],
          uv: { su: 0.05, sv: 1 },
        },
      ),
    );
  }
}

// ---- sky occlusion -----------------------------------------------------------------------------

const RAYS = 20;
const REACH = 16;
const OFFSET = 0.03;

/**
 * Cosine-weighted hemisphere (Hammersley), as the lightmap baker samples it. One fixed pattern for
 * every vertex (the baker rotates it per texel and blurs; vertices are a metre apart and are not
 * blurred, so a shared pattern keeps neighbours' estimates smooth rather than noisy).
 */
function pattern(n: number): Float64Array {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    let b = i >>> 0;
    let r = 0;
    for (let k = 0, f = 0.5; k < 16; k++, f *= 0.5, b >>>= 1) r += (b & 1) * f;
    const a = (i + 0.5) / n;
    const sin = Math.sqrt(a);
    out[i * 3] = sin * Math.cos(2 * Math.PI * r);
    out[i * 3 + 1] = sin * Math.sin(2 * Math.PI * r);
    out[i * 3 + 2] = Math.sqrt(1 - a);
  }
  return out;
}

/** Axis-aligned occluders (the hall's rendered boxes and anything just outside it). */
function occluders(boxes: readonly MapBox[]): Float64Array {
  const list: { min: V3; max: V3 }[] = [];
  for (const b of boxes) {
    if (b.visible === false) continue;
    const { min, max } = boxBounds(b);
    if (!inHall(min, max, 3) || max.y < -1 || min.y > 8.5) continue;
    list.push({ min, max });
  }
  return Float64Array.from(
    list.flatMap(({ min, max }) => [min.x, min.y, min.z, max.x, max.y, max.z]),
  );
}

/**
 * The occluders binned into a 2D grid of vertical columns (xz cells), walked by a ray with a DDA
 * (each box tested once per ray): a ray tests the few boxes along its path, not all of them.
 */
class OccluderGrid {
  private readonly cells: number[][];
  private readonly stamp: Int32Array;
  private ray = 0;
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;

  constructor(
    private readonly occ: Float64Array,
    private readonly cell = 1.5,
  ) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (let k = 0; k < occ.length; k += 6) {
      x0 = Math.min(x0, occ[k]!);
      z0 = Math.min(z0, occ[k + 2]!);
      x1 = Math.max(x1, occ[k + 3]!);
      z1 = Math.max(z1, occ[k + 5]!);
    }
    if (!Number.isFinite(x0)) x0 = z0 = x1 = z1 = 0;
    this.x0 = x0;
    this.z0 = z0;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell));
    this.nz = Math.max(1, Math.ceil((z1 - z0) / cell));
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
    this.stamp = new Int32Array(occ.length / 6);
    for (let k = 0; k < occ.length; k += 6) {
      const i0 = this.ix(occ[k]!);
      const i1 = this.ix(occ[k + 3]!);
      const j0 = this.iz(occ[k + 2]!);
      const j1 = this.iz(occ[k + 5]!);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) this.cells[j * this.nx + i]!.push(k);
    }
  }

  private ix(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  private iz(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.cell)));
  }

  /** Distance to the nearest occluder along unit `d` from `o`, at most `reach`. */
  nearest(o: number[], d: number[], reach: number): number {
    const occ = this.occ;
    const ray = ++this.ray;
    let best = reach;
    const inv = [1 / d[0]!, 1 / d[1]!, 1 / d[2]!];
    let i = this.ix(o[0]!);
    let j = this.iz(o[2]!);
    const si = d[0]! > 0 ? 1 : -1;
    const sj = d[2]! > 0 ? 1 : -1;
    const edgeX = this.x0 + (i + (si > 0 ? 1 : 0)) * this.cell;
    const edgeZ = this.z0 + (j + (sj > 0 ? 1 : 0)) * this.cell;
    let tx = d[0] === 0 ? Infinity : (edgeX - o[0]!) * inv[0]!;
    let tz = d[2] === 0 ? Infinity : (edgeZ - o[2]!) * inv[2]!;
    const dx = d[0] === 0 ? Infinity : this.cell * Math.abs(inv[0]!);
    const dz = d[2] === 0 ? Infinity : this.cell * Math.abs(inv[2]!);
    for (;;) {
      for (const k of this.cells[j * this.nx + i]!) {
        if (this.stamp[k / 6] === ray) continue;
        this.stamp[k / 6] = ray;
        let lo = -Infinity;
        let hi = Infinity;
        for (let a = 0; a < 3; a++) {
          const t0 = (occ[k + a]! - o[a]!) * inv[a]!;
          const t1 = (occ[k + 3 + a]! - o[a]!) * inv[a]!;
          // A ray parallel to a slab: inside it (NaN-free) or never.
          if (Number.isNaN(t0) || Number.isNaN(t1)) continue;
          lo = Math.max(lo, Math.min(t0, t1));
          hi = Math.min(hi, Math.max(t0, t1));
        }
        if (hi >= Math.max(lo, 0) && lo < best) best = Math.max(lo, 0);
      }
      // Next column; stop once it starts beyond the nearest hit or the grid.
      if (tx < tz) {
        if (tx >= best) break;
        i += si;
        tx += dx;
      } else {
        if (tz >= best) break;
        j += sj;
        tz += dz;
      }
      if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) break;
    }
    return best;
  }
}

function inside(p: number[], occ: Float64Array): boolean {
  for (let k = 0; k < occ.length; k += 6) {
    if (
      p[0]! > occ[k]! &&
      p[0]! < occ[k + 3]! &&
      p[1]! > occ[k + 1]! &&
      p[1]! < occ[k + 4]! &&
      p[2]! > occ[k + 2]! &&
      p[2]! < occ[k + 5]!
    )
      return true;
  }
  return false;
}

/** Pieces small enough to take one sample (top centre, facing up) for every vertex. */
const SMALL_PIECE = 0.7;
/** Stand-in for a sample buried in geometry with nothing better to borrow (a dim interior). */
const BURIED_SKY = 1 - 0.7 * BAKED_AO_INTENSITY;

/**
 * Per-vertex sky visibility with the baker's metric (cosine rays; an occluder at distance d
 * blocks d / 16 m of its ray), turned into the factor the bake's aoMap applies to fill light.
 * Vertices buried in other geometry take their piece's mean (they are hidden; their quads not).
 * Small pieces (sacks, fruit, crate sides) take one sample.
 */
export function applyHallSky(pieces: readonly HallPiece[], boxes: readonly MapBox[]): void {
  const occ = occluders(boxes);
  const grid = new OccluderGrid(occ);
  const pat = pattern(RAYS);
  const cache = new Map<string, number>();
  const o = [0, 0, 0];
  const d = [0, 0, 0];
  const sky = (px: number, py: number, pz: number, nx: number, ny: number, nz: number): number => {
    const key = `${Math.round(px * 50)},${Math.round(py * 50)},${Math.round(pz * 50)},${Math.round(nx * 4)},${Math.round(ny * 4)},${Math.round(nz * 4)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    o[0] = px + nx * OFFSET;
    o[1] = py + ny * OFFSET;
    o[2] = pz + nz * OFFSET;
    let value = NaN;
    if (!inside(o, occ)) {
      // Tangent frame round n.
      const t0 = Math.abs(ny) < 0.9 ? [nz, 0, -nx] : [0, -nz, ny];
      const tl = Math.hypot(t0[0]!, t0[1]!, t0[2]!);
      const t = [t0[0]! / tl, t0[1]! / tl, t0[2]! / tl];
      const b = [ny * t[2]! - nz * t[1]!, nz * t[0]! - nx * t[2]!, nx * t[1]! - ny * t[0]!];
      let sum = 0;
      for (let s = 0; s < RAYS; s++) {
        const cu = pat[s * 3]!;
        const cv = pat[s * 3 + 1]!;
        const cz = pat[s * 3 + 2]!;
        d[0] = t[0]! * cu + b[0]! * cv + nx * cz;
        d[1] = t[1]! * cu + b[1]! * cv + ny * cz;
        d[2] = t[2]! * cu + b[2]! * cv + nz * cz;
        sum += grid.nearest(o, d, REACH) / REACH;
      }
      value = 1 + (sum / RAYS - 1) * BAKED_AO_INTENSITY;
    }
    cache.set(key, value);
    return value;
  };
  const size = new THREE.Vector3();
  for (const piece of pieces) {
    const pos = piece.geo.getAttribute('position');
    const nrm = piece.geo.getAttribute('normal');
    const out = new Float32Array(pos.count);
    const box = piece.geo.boundingBox!;
    box.getSize(size);
    if (Math.max(size.x, size.y, size.z) < SMALL_PIECE) {
      const v = sky((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2, 0, 1, 0);
      out.fill(Number.isNaN(v) ? BURIED_SKY : v);
    } else if (!piece.perVertex) {
      // One sample per face direction, at the middle of the piece's bounds on that side.
      const c = box.getCenter(new THREE.Vector3());
      const dirs = new Map<number, number>();
      for (let i = 0; i < pos.count; i++) {
        const nx = nrm.getX(i);
        const ny = nrm.getY(i);
        const nz = nrm.getZ(i);
        const ax =
          Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)
            ? 0
            : Math.abs(ny) >= Math.abs(nz)
              ? 1
              : 2;
        const sg = (ax === 0 ? nx : ax === 1 ? ny : nz) >= 0 ? 1 : -1;
        const k = ax * 2 + (sg > 0 ? 0 : 1);
        let v = dirs.get(k);
        if (v === undefined) {
          const h = (ax === 0 ? size.x : ax === 1 ? size.y : size.z) / 2;
          v = sky(
            c.x + (ax === 0 ? sg * h : 0),
            c.y + (ax === 1 ? sg * h : 0),
            c.z + (ax === 2 ? sg * h : 0),
            ax === 0 ? sg : 0,
            ax === 1 ? sg : 0,
            ax === 2 ? sg : 0,
          );
          dirs.set(k, v);
        }
        out[i] = v;
      }
      const ok = [...dirs.values()].filter((v) => !Number.isNaN(v));
      const mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : BURIED_SKY;
      for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i]!)) out[i] = mean;
    } else {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < pos.count; i++) {
        const v = sky(pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        out[i] = v;
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      const mean = n ? sum / n : BURIED_SKY;
      for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i]!)) out[i] = mean;
    }
    piece.geo.setAttribute(HALL_SKY_ATTRIBUTE, new THREE.BufferAttribute(out, 1));
  }
}

// ---- bullet-hole decals ------------------------------------------------------------------------

/**
 * How far (m) a bullet-hole decal must move out along the hit normal to sit on the hall dressing
 * covering that spot, for a hit on the map's own collision surface (0 where nothing covers it).
 */
export type DecalLift = (point: Readonly<V3>, normal: Readonly<V3>) => number;

/** Dressing a decal may land on: wall/cover skins, floor, ceiling, frames, nosings. */
const DECAL_KINDS: ReadonlySet<HallPieceKind> = new Set([
  'hall-wall',
  'hall-cover',
  'hall-floor',
  'hall-ceiling',
  'hall-window',
  'hall-stair',
]);
/** Furthest a covering surface can stand off the collision face (shutter housings: 0.22). */
const DECAL_REACH = 0.3;
/** Collision faces and skins meet within float noise; a skin wrapping cover starts behind it. */
const DECAL_SLACK = 0.02;

/** Every face normal lies along a world axis (the piece is its own bounding box). */
function axisAligned(geo: THREE.BufferGeometry): boolean {
  const n = geo.getAttribute('normal');
  for (let i = 0; i < n.count; i++) {
    const m = Math.max(Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i)));
    if (m < 1 - 1e-4) return false;
  }
  return true;
}

/**
 * The lookup for these pieces: their bounds in one flat array, scanned per hit with no
 * allocation (a few hundred boxes, a handful of compares each; only hits inside the hall look).
 * The visible surface over a collision face is the outermost dressing whose footprint on that
 * face contains the hit and which starts at or in front of it (within `DECAL_REACH`).
 */
export function hallDecalLift(
  pieces: readonly { geo: THREE.BufferGeometry; kind: string }[],
): DecalLift {
  const list: number[] = [];
  for (const p of pieces) {
    if (!DECAL_KINDS.has(p.kind as HallPieceKind)) continue;
    // Tilted pieces (vent louvres, knee braces): their bounds' faces aren't their surfaces, so a
    // hole would float in front of them. Left out, holes stay on the wall behind (like sacks).
    if (!axisAligned(p.geo)) continue;
    p.geo.computeBoundingBox();
    const { min, max } = p.geo.boundingBox!;
    list.push(min.x, min.y, min.z, max.x, max.y, max.z);
  }
  const boxes = Float32Array.from(list);
  const lo = { x: HALL.x0 - 0.5, y: -0.5, z: HALL.z0 - 0.5 };
  const hi = { x: HALL.x1 + 0.5, y: HALL_LEVELS.roof + 0.5, z: HALL.z1 + 0.5 };
  return (p, n) => {
    if (p.x < lo.x || p.x > hi.x || p.y < lo.y || p.y > hi.y || p.z < lo.z || p.z > hi.z) return 0;
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    // Axis of the face the round hit (dressing is axis-aligned), and its outward sign.
    const a = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const s = (a === 0 ? n.x : a === 1 ? n.y : n.z) >= 0 ? 1 : -1;
    const pa = a === 0 ? p.x : a === 1 ? p.y : p.z;
    const pu = a === 0 ? p.y : p.x; // the two face axes
    const pv = a === 2 ? p.y : p.z;
    const ua = a === 0 ? 1 : 0;
    const va = a === 2 ? 1 : 2;
    let lift = 0;
    for (let k = 0; k < boxes.length; k += 6) {
      if (pu < boxes[k + ua]! - 1e-3 || pu > boxes[k + 3 + ua]! + 1e-3) continue;
      if (pv < boxes[k + va]! - 1e-3 || pv > boxes[k + 3 + va]! + 1e-3) continue;
      const b0 = boxes[k + a]!;
      const b1 = boxes[k + 3 + a]!;
      const far = s > 0 ? b1 - pa : pa - b0;
      const near = s > 0 ? b0 - pa : pa - b1;
      // In front of the face (or wrapping it), not behind it, within reach.
      if (far < -DECAL_SLACK || near > DECAL_REACH || far > DECAL_REACH) continue;
      if (far > lift) lift = far;
    }
    return lift;
  };
}

// ---- entry -------------------------------------------------------------------------------------

/**
 * The hall's interior dressing for a map that has the Market hall (none otherwise). Deterministic:
 * a pure function of the map's boxes.
 */
export function buildMarketHallPieces(map: Pick<MapDefinition, 'boxes'>): HallPiece[] {
  const lines = wallLines(map.boxes);
  // No hall (the range, or a map without it): nothing to dress.
  if (lines.some((l) => l.rects.length === 0)) return [];
  pieceSeed = 0;
  const out: HallPiece[] = [];
  const c: Ctx = {
    out,
    lines,
    push: (p) => {
      if (p) out.push(p);
    },
    stair: findStair(map.boxes),
  };
  for (const l of lines) {
    groundFloorWalls(c, l);
    upperFloorWalls(c, l);
  }
  partitions(c, map.boxes, lines);
  groundFloor(c);
  groundFloorCeiling(c, map.boxes);
  roof(c, map.boxes);
  stairAndRails(c, map.boxes);
  counters(c, map.boxes);
  applyHallSky(out, map.boxes);
  return out;
}

/**
 * Fragment hook: the estimated baked sky occlusion scales the fill light (hemisphere + IBL), as
 * the map's aoMap does — Medium+ only, like the bake (Low, which tone-maps in the material, draws
 * the map unbaked). Inserted before `aomap_fragment`, so lamp light added after it (lampLight.ts)
 * is never dimmed. Pieces without the attribute carry 1 (unchanged).
 */
export function addHallSky(m: THREE.MeshStandardMaterial): void {
  const prev = m.onBeforeCompile.bind(m);
  const key = m.customProgramCacheKey();
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute float ${HALL_SKY_ATTRIBUTE};\nvarying float vHallSky;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvHallSky = ${HALL_SKY_ATTRIBUTE};`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHallSky;')
      .replace(
        '#include <aomap_fragment>',
        `#ifndef TONE_MAPPING
  reflectedLight.indirectDiffuse *= vHallSky;
  reflectedLight.indirectSpecular *= vHallSky;
#endif
#include <aomap_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `${key}|hallSky-v1`;
  m.needsUpdate = true;
}
