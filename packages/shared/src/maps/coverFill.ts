/**
 * Cover fill: make sure nowhere on the street level is far from cover (Kiran: "too open
 * everywhere, we lose each other and run around"). Deterministic, so client and server build the
 * same map.
 *
 * 1. Rasterise everything that gives cover at body height (buildings, props, trunks, bushes) onto
 *    a 2 m grid; mark protected space (stairs, doors, passages, routes) as off-limits.
 * 2. Distance transform: each cell's distance to the nearest cover.
 * 3. Repeatedly put a cover piece on the most exposed cell until every cell is within `maxGap`.
 */
import { pointInPolygon } from './geom.ts';
import {
  car,
  container,
  crate,
  cratePile,
  foodTruck,
  helicopterWreck,
  jersey,
  sandbags,
  tankWreck,
  type Place,
} from './props.ts';
import type { Rect } from './solids.ts';
import type { Bounds, MapBox, MapFoliage, MapPrism, MapTree } from './types.ts';

const CELL = 2;

export interface CoverFillInput {
  bounds: Bounds;
  boxes: readonly MapBox[];
  prisms: readonly MapPrism[];
  trees: readonly MapTree[];
  foliage: readonly MapFoliage[];
  /** Space that must stay clear (stairs, doors, passages, routes). */
  keepClear: readonly Rect[];
  /**
   * Space kept free of new cover that still counts toward `maxGap` (truck lanes): unlike
   * `keepClear`, a spot in it must still be within the gap of cover, placed beside it.
   */
  keepOpen?: readonly Rect[];
  /** Max distance (m) from any street-level spot to the nearest cover. */
  maxGap: number;
  seed?: number;
}

type Piece = {
  make: (at: Place) => MapBox[];
  w: number;
  d: number;
  weight: number;
  /** Placement style: cars get a slight parking skew, wrecks a dramatic angle, the rest square. */
  style?: 'car' | 'wreck';
};
/** Footprint (w along local X, d along Z) incl. a little breathing room. */
const PIECES: Piece[] = [
  { make: (a) => car(a, false), w: 5, d: 2.2, weight: 18, style: 'car' },
  { make: (a) => car(a, true), w: 5, d: 2.2, weight: 10, style: 'wreck' },
  { make: (a) => cratePile(a), w: 2.8, d: 2.8, weight: 18 },
  // Micro cover for pinch points (a single crate) — only used when bigger pieces don't fit.
  { make: (a) => crate(a, 1.1), w: 1.2, d: 1.2, weight: 0 },
  { make: (a) => sandbags(a, 5), w: 5.4, d: 1.2, weight: 14 },
  { make: (a) => container(a, 'ends'), w: 6.5, d: 2.8, weight: 8 },
  { make: (a) => container(a, 'closed'), w: 6.5, d: 2.8, weight: 7 },
  {
    make: (a) => [...jersey(a, 4), ...jersey({ ...a, z: a.z + 1.4 }, 4)],
    w: 4.4,
    d: 2.2,
    weight: 9,
  },
  { make: (a) => foodTruck(a), w: 6, d: 2.6, weight: 5 },
  // The Leopard wreck model reaches local x −6.8 (gun) … 4.1 (rear plate), z −1.95 … 2.45 (the
  // barrel swung 22°; debris is decal-flat): centre that on the spot.
  {
    make: (a) => tankWreck(centred(a, -1.35, 0.25)),
    w: 11,
    d: 4.5,
    weight: 3,
    style: 'wreck',
  },
  // The crashed Blackhawk's collision spans local x −4.4 … 9.7, z −1.5 … 6.5 (tail and fallen
  // blade): centre that on the spot so the footprint is honest.
  {
    make: (a) => helicopterWreck(centred(a, 2.66, 2.5)),
    w: 14.6,
    d: 8.4,
    weight: 2,
    style: 'wreck',
  },
];
/** The prop origin that puts local point (lx, lz) on the spot (props.ts `place` rotation). */
function centred(a: Place, lx: number, lz: number): Place {
  const yaw = ((a.rot ?? 0) * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { ...a, x: a.x - (lx * c + lz * s), z: a.z - (-lx * s + lz * c) };
}
const TOTAL_WEIGHT = PIECES.reduce((s, p) => s + p.weight, 0);

const hash = (x: number, z: number, salt: number): number => {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return h - Math.floor(h);
};

/** Axis-aligned footprint of a (possibly yawed) box. */
function boxRect(b: MapBox): Rect {
  const yaw = ((b.rot?.y ?? 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (b.size.x * c + b.size.z * s) / 2;
  const hz = (b.size.x * s + b.size.z * c) / 2;
  return { x0: b.center.x - hx, z0: b.center.z - hz, x1: b.center.x + hx, z1: b.center.z + hz };
}

export interface CoverFillResult {
  boxes: MapBox[];
  /** Largest remaining gap (m) over all unprotected cells — the metric tests assert on. */
  maxGap: number;
  placed: number;
  /** Where that gap is (for debugging layouts). */
  worstAt: { x: number; z: number } | null;
}

export function coverFill(input: CoverFillInput): CoverFillResult {
  const B = input.bounds;
  const nx = Math.ceil((B.maxX - B.minX) / CELL);
  const nz = Math.ceil((B.maxZ - B.minZ) / CELL);
  const N = nx * nz;
  const occ = new Uint8Array(N); // gives cover
  const blocked = new Uint8Array(N); // may not place here (and not measured)
  const open = new Uint8Array(N); // may not place here (still measured)
  const idx = (i: number, j: number): number => j * nx + i;
  const cx = (i: number): number => B.minX + (i + 0.5) * CELL;
  const cz = (j: number): number => B.minZ + (j + 0.5) * CELL;
  const cellsOf = (r: Rect, fn: (k: number) => void): void => {
    const i0 = Math.max(0, Math.floor((r.x0 - B.minX) / CELL));
    const i1 = Math.min(nx - 1, Math.floor((r.x1 - B.minX) / CELL));
    const j0 = Math.max(0, Math.floor((r.z0 - B.minZ) / CELL));
    const j1 = Math.min(nz - 1, Math.floor((r.z1 - B.minZ) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(idx(i, j));
  };
  const coversBody = (y0: number, y1: number): boolean => y0 < 1.2 && y1 > 0.8;

  for (const b of input.boxes) {
    if (b.collide === false) continue;
    const y0 = b.center.y - b.size.y / 2;
    const y1 = b.center.y + b.size.y / 2;
    if (!coversBody(y0, y1)) continue;
    // Thin rails/fences still count (they're in the way), invisible walls are the edge.
    cellsOf(boxRect(b), (k) => (occ[k] = 1));
  }
  for (const p of input.prisms) {
    if (p.backdrop || p.collide === false || !coversBody(p.y0, p.y1)) continue;
    const xs = p.pts.map((q) => q[0]);
    const zs = p.pts.map((q) => q[1]);
    const r = {
      x0: Math.min(...xs),
      z0: Math.min(...zs),
      x1: Math.max(...xs),
      z1: Math.max(...zs),
    };
    cellsOf(r, (k) => {
      const i = k % nx;
      const j = (k - i) / nx;
      if (pointInPolygon([cx(i), cz(j)], p.pts)) occ[k] = 1;
    });
  }
  for (const t of input.trees)
    cellsOf({ x0: t.x - 0.3, z0: t.z - 0.3, x1: t.x + 0.3, z1: t.z + 0.3 }, (k) => (occ[k] = 1));
  for (const f of input.foliage) {
    if (f.kind !== 'bush') continue;
    cellsOf(
      { x0: f.x - f.r * 0.6, z0: f.z - f.r * 0.6, x1: f.x + f.r * 0.6, z1: f.z + f.r * 0.6 },
      (k) => (occ[k] = 1),
    );
  }
  for (const r of input.keepClear) cellsOf(r, (k) => (blocked[k] = 1));
  // Keep-open cells: those whose centre is inside (a lane's shoulder already gives the margin;
  // every cell it merely touched would widen a 7 m lane to 10 m of grid).
  for (const r of input.keepOpen ?? [])
    cellsOf(r, (k) => {
      const i = k % nx;
      const x = cx(i);
      const z = cz((k - i) / nx);
      if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) open[k] = 1;
    });
  // The map boundary is a wall (it stops movement and bullets): the outer ring counts as cover.
  for (let i = 0; i < nx; i++) {
    occ[idx(i, 0)] = 1;
    occ[idx(i, nz - 1)] = 1;
  }
  for (let j = 0; j < nz; j++) {
    occ[idx(0, j)] = 1;
    occ[idx(nx - 1, j)] = 1;
  }

  // Chamfer distance transform (1, √2) in metres.
  const dist = new Float32Array(N);
  const D1 = CELL;
  const D2 = CELL * Math.SQRT2;
  const pass = (i0: number, i1: number, j0: number, j1: number): void => {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = idx(i, j);
        let d = dist[k]!;
        if (i > 0) d = Math.min(d, dist[k - 1]! + D1);
        if (j > 0) d = Math.min(d, dist[k - nx]! + D1);
        if (i > 0 && j > 0) d = Math.min(d, dist[k - nx - 1]! + D2);
        if (i < nx - 1 && j > 0) d = Math.min(d, dist[k - nx + 1]! + D2);
        dist[k] = d;
      }
    }
    for (let j = j1; j >= j0; j--) {
      for (let i = i1; i >= i0; i--) {
        const k = idx(i, j);
        let d = dist[k]!;
        if (i < nx - 1) d = Math.min(d, dist[k + 1]! + D1);
        if (j < nz - 1) d = Math.min(d, dist[k + nx]! + D1);
        if (i < nx - 1 && j < nz - 1) d = Math.min(d, dist[k + nx + 1]! + D2);
        if (i > 0 && j < nz - 1) d = Math.min(d, dist[k + nx - 1]! + D2);
        dist[k] = d;
      }
    }
  };
  for (let k = 0; k < N; k++) dist[k] = occ[k] ? 0 : 1e9;
  pass(0, nx - 1, 0, nz - 1);

  const out: MapBox[] = [];
  const tried = new Uint8Array(N);
  const seed = input.seed ?? 7;
  let placed = 0;
  for (let guard = 0; guard < 4000; guard++) {
    // Most exposed placeable cell (deterministic: first max in scan order).
    let best = -1;
    let bestD = input.maxGap;
    for (let k = 0; k < N; k++) {
      if (occ[k] || blocked[k] || tried[k]) continue;
      const d = dist[k]!;
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best < 0) break;
    const i = best % nx;
    const j = (best - i) / nx;
    const x = cx(i);
    const z = cz(j);
    // Pick a piece (weighted by hash), fall back to smaller ones if it doesn't fit.
    let r = hash(x, z, seed) * TOTAL_WEIGHT;
    let first = 0;
    for (; first < PIECES.length; first++) {
      r -= PIECES[first]!.weight;
      if (r <= 0) break;
    }
    // The chosen piece first, then the biggest that fits (micro crates last).
    const chosen = PIECES[Math.min(first, PIECES.length - 1)]!;
    const order = [
      chosen,
      ...PIECES.filter((p) => p !== chosen).sort((a, b) => b.w * b.d - a.w * a.d),
    ];
    // Square to the street grid (the map frame is street-aligned): 0° or 90°.
    const base = hash(x, z, seed + 1) < 0.5 ? 0 : 90;
    const skew = hash(x, z, seed + 2) - 0.5;
    let done = false;
    // Try the exposed spot itself, then nudged 2–4 m in eight directions (next to an apron or
    // a pinch point the piece only needs to be *near* the gap).
    const offsets: [number, number][] = [[0, 0]];
    // (6 m only helps beside a wide keep-open area such as a truck-lane junction.)
    for (const r of input.keepOpen?.length ? [2, 4, 6] : [2, 4]) {
      for (let a = 0; a < 8; a++) {
        offsets.push([Math.cos((a * Math.PI) / 4) * r, Math.sin((a * Math.PI) / 4) * r]);
      }
    }
    for (const [ox, oz] of offsets) {
      if (done) break;
      const px = x + ox;
      const pz = z + oz;
      for (const piece of order) {
        const rot =
          base + (piece.style === 'wreck' ? skew * 70 : piece.style === 'car' ? skew * 10 : 0);
        const axis = piece.style !== 'wreck'; // small skews fit the square footprint + margin
        const hw = (axis ? (base === 0 ? piece.w : piece.d) : (piece.w + piece.d) * 0.72) / 2;
        const hd = (axis ? (base === 0 ? piece.d : piece.w) : (piece.w + piece.d) * 0.72) / 2;
        const foot = { x0: px - hw, z0: pz - hd, x1: px + hw, z1: pz + hd };
        if (
          foot.x0 < B.minX + 1.5 ||
          foot.x1 > B.maxX - 1.5 ||
          foot.z0 < B.minZ + 1.5 ||
          foot.z1 > B.maxZ - 1.5
        ) {
          continue;
        }
        // The piece itself may not sit on anything solid or protected; its 1.2 m walk-around
        // margin only has to avoid solid things (protected zones carry their own apron).
        let ok = true;
        cellsOf(foot, (k) => {
          if (occ[k] || blocked[k] || open[k]) ok = false;
        });
        cellsOf(
          { x0: foot.x0 - 1.2, z0: foot.z0 - 1.2, x1: foot.x1 + 1.2, z1: foot.z1 + 1.2 },
          (k) => {
            if (occ[k]) ok = false;
          },
        );
        if (!ok) continue;
        // Real footprint check (e.g. a helicopter's tail reaches well beyond its body box).
        const made = piece.make({ x: px, z: pz, rot });
        const rects = made.filter((b) => b.collide !== false).map(boxRect);
        let clear = true;
        for (const r of rects) {
          if (
            r.x0 < B.minX + 0.5 ||
            r.x1 > B.maxX - 0.5 ||
            r.z0 < B.minZ + 0.5 ||
            r.z1 > B.maxZ - 0.5
          ) {
            clear = false;
          }
          cellsOf(r, (k) => {
            if (occ[k] || blocked[k] || open[k]) clear = false;
          });
        }
        if (!clear) continue;
        out.push(...made);
        for (const r of rects) {
          cellsOf(r, (k) => {
            occ[k] = 1;
            dist[k] = 0;
          });
        }
        // Local distance update around the new piece.
        const reach = Math.ceil((input.maxGap * 2) / CELL) + 4;
        const pi = Math.floor((px - B.minX) / CELL);
        const pj = Math.floor((pz - B.minZ) / CELL);
        pass(
          Math.max(0, pi - reach),
          Math.min(nx - 1, pi + reach),
          Math.max(0, pj - reach),
          Math.min(nz - 1, pj + reach),
        );
        placed++;
        done = true;
        break;
      }
    }
    if (!done) tried[best] = 1;
  }
  // Remaining largest gap over every unprotected street cell — including cells where no piece
  // could be placed (honest metric: what a player standing there actually experiences).
  let maxGap = 0;
  let worst = -1;
  for (let k = 0; k < N; k++) {
    if (!occ[k] && !blocked[k] && dist[k]! > maxGap) {
      maxGap = dist[k]!;
      worst = k;
    }
  }
  const wi = worst % nx;
  const worstAt = worst < 0 ? null : { x: cx(wi), z: cz((worst - wi) / nx) };
  return { boxes: out, maxGap, placed, worstAt };
}
