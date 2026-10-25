/**
 * Where a truck can drive: a grid graph over the map's street level, built from the same static
 * collision the vehicle sim sweeps (no hand-placed routes). A node is a ground point where the
 * truck's body fits along at least one of the grid's directions; an edge joins two neighbours if
 * the body fits pointing along it at both ends and halfway (so a path is a corridor the truck
 * really passes, 2.1 m wide plus margin). Bots plan their drives on it; tests use it to check the
 * spawn spots and the widths of the routes.
 */
import type { Vec3 } from '../../math/vec3.ts';
import { bodyOverlaps, type VehicleWorld } from './vehicle.ts';

export interface DriveGraph {
  cell: number;
  /** Ground points (feet of the truck's origin). */
  nodes: Vec3[];
  /** Neighbours per node. */
  edges: number[][];
  /**
   * The grid (route smoothing): its origin, size, the node at each grid point (-1: none) and,
   * per node, which of the four grid axes (`DIRS`) the body fits along there (bit k = DIRS[k]).
   */
  grid?: { minX: number; minZ: number; nx: number; nz: number; index: Int32Array; fit: Uint8Array };
}

export interface DriveGraphOptions {
  cell?: number;
  /** Street level band (m): metro and roofs are not driven. */
  yMin?: number;
  yMax?: number;
  /** Extra clearance each side (m): the body is checked this much wider. */
  margin?: number;
}

export const HUG_COST = 3;
/** Fit bits (`DIRS` index) of the grid axes at 0°, 45°, 90°, 135° of heading. */
const AXIS_BIT = [1 << 1, 1 << 2, 1 << 0, 1 << 3] as const;

const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

/** Heading (forward = (sin, cos)) of a grid direction. */
const headingOf = (dx: number, dz: number): number => Math.atan2(dx, dz);

export function buildDriveGraph(
  world: VehicleWorld,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  opts: DriveGraphOptions = {},
): DriveGraph {
  const cell = opts.cell ?? 2;
  const yMin = opts.yMin ?? -0.3;
  const yMax = opts.yMax ?? 0.6;
  const nx = Math.floor((bounds.maxX - bounds.minX) / cell);
  const nz = Math.floor((bounds.maxZ - bounds.minZ) / cell);
  const index = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  const nodes: Vec3[] = [];
  const fits: number[] = [];
  const margin = opts.margin ?? 0.45;
  const clear = (p: Vec3, heading: number): boolean =>
    !bodyOverlaps(world, p, heading, 0, 0, margin);
  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const x = bounds.minX + ix * cell;
      const z = bounds.minZ + iz * cell;
      const hit = world.castRay({ x, y: yMax + 2.5, z }, { x: 0, y: -1, z: 0 }, yMax - yMin + 2.5);
      if (!hit || hit.normal.y < 0.9 || hit.point.y < yMin || hit.point.y > yMax) continue;
      const p = { x, y: hit.point.y, z };
      // At least one grid heading must fit (else nothing could ever stand here).
      let fit = 0;
      DIRS.forEach(([dx, dz], k) => {
        if (clear(p, headingOf(dx, dz))) fit |= 1 << k;
      });
      if (!fit) continue;
      index[iz * (nx + 1) + ix] = nodes.length;
      nodes.push(p);
      fits.push(fit);
    }
  }
  const edges: number[][] = nodes.map(() => []);
  const nodeAt = (ix: number, iz: number): number =>
    ix < 0 || iz < 0 || ix > nx || iz > nz ? -1 : index[iz * (nx + 1) + ix]!;
  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const a = nodeAt(ix, iz);
      if (a < 0) continue;
      for (const [dx, dz] of DIRS) {
        const b = nodeAt(ix + dx, iz + dz);
        if (b < 0) continue;
        const pa = nodes[a]!;
        const pb = nodes[b]!;
        if (Math.abs(pa.y - pb.y) > 0.35) continue;
        const h = headingOf(dx, dz);
        const mid = { x: (pa.x + pb.x) / 2, y: Math.max(pa.y, pb.y), z: (pa.z + pb.z) / 2 };
        if (!clear(pa, h) || !clear(pb, h) || !clear(mid, h)) continue;
        edges[a]!.push(b);
        edges[b]!.push(a);
      }
    }
  }
  return {
    cell,
    nodes,
    edges,
    grid: { minX: bounds.minX, minZ: bounds.minZ, nx, nz, index, fit: Uint8Array.from(fits) },
  };
}

/**
 * `cur` (a view of `base`) with the nodes and edges in `box` (plus a truck's reach) checked again
 * against `world` as it is now: a prop that settled there blocks them, one smashed frees them
 * again (never beyond what `base` had). Copy on write: `base` and `cur` are left as they were,
 * so a per-match view can follow its own props while every match shares the costly build.
 */
export function refreshDriveGraph(
  base: DriveGraph,
  cur: DriveGraph,
  world: VehicleWorld,
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
  opts: Pick<DriveGraphOptions, 'margin'> = {},
): DriveGraph {
  const grid = base.grid;
  if (!grid || !cur.grid) return cur;
  const margin = opts.margin ?? 0.45;
  const clear = (p: Vec3, heading: number): boolean =>
    !bodyOverlaps(world, p, heading, 0, 0, margin);
  const pad = 4; // the body's half-length and margin round the box
  const fit = Uint8Array.from(cur.grid.fit);
  const edges = cur.edges.slice();
  const cell = base.cell;
  const nodeAt = (ix: number, iz: number): number =>
    ix < 0 || iz < 0 || ix > grid.nx || iz > grid.nz ? -1 : grid.index[iz * (grid.nx + 1) + ix]!;
  const touched: number[] = [];
  base.nodes.forEach((p, i) => {
    if (p.x < box.minX - pad || p.x > box.maxX + pad) return;
    if (p.z < box.minZ - pad || p.z > box.maxZ + pad) return;
    touched.push(i);
  });
  for (const i of touched) {
    const p = base.nodes[i]!;
    let f = 0;
    DIRS.forEach(([dx, dz], k) => {
      if (clear(p, headingOf(dx, dz))) f |= 1 << k;
    });
    fit[i] = f & grid.fit[i]!;
  }
  const setEdge = (a: number, b: number, on: boolean): void => {
    const has = edges[a]!.includes(b);
    if (has === on) return;
    edges[a] = on ? [...edges[a]!, b] : edges[a]!.filter((x) => x !== b);
  };
  for (const a of touched) {
    const pa = base.nodes[a]!;
    const ix = Math.round((pa.x - grid.minX) / cell);
    const iz = Math.round((pa.z - grid.minZ) / cell);
    for (const [dx, dz] of DIRS) {
      for (const s of [1, -1]) {
        const b = nodeAt(ix + dx * s, iz + dz * s);
        if (b < 0 || !base.edges[a]!.includes(b)) continue;
        const pb = base.nodes[b]!;
        const h = headingOf(dx, dz);
        const mid = { x: (pa.x + pb.x) / 2, y: Math.max(pa.y, pb.y), z: (pa.z + pb.z) / 2 };
        const on = fit[a] !== 0 && fit[b] !== 0 && clear(pa, h) && clear(pb, h) && clear(mid, h);
        setEdge(a, b, on);
        setEdge(b, a, on);
      }
    }
  }
  return { ...cur, edges, grid: { ...cur.grid, fit } };
}

/**
 * Whether the truck can drive straight from a to b: every grid square the line crosses (sampled
 * each half metre) has nodes at all four corners where the body fits along the grid axes either
 * side of the line's heading (so it fits at the heading itself). Near walls and props the route
 * keeps the grid's own steps.
 */
export function driveLineClear(
  g: DriveGraph,
  a: Vec3,
  b: Vec3,
  blocked?: (node: number) => boolean,
): boolean {
  const grid = g.grid;
  if (!grid) return false;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  // The line's axis in [0, π), and the grid axes (every 45°) either side of it.
  let th = Math.atan2(b.x - a.x, b.z - a.z);
  if (th < 0) th += Math.PI;
  if (th >= Math.PI) th -= Math.PI;
  const step = th / (Math.PI / 4);
  const lo = Math.floor(step) % 4;
  const hi = (lo + 1) % 4;
  const frac = step - Math.floor(step);
  const need =
    (frac < 0.07 ? 0 : AXIS_BIT[hi]!) | (frac > 0.93 ? 0 : AXIS_BIT[lo]!) || AXIS_BIT[lo]!;
  const n = Math.max(1, Math.ceil(len / 0.5));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const gx = (a.x + (b.x - a.x) * t - grid.minX) / g.cell;
    const gz = (a.z + (b.z - a.z) * t - grid.minZ) / g.cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    for (const [dx, dz] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const x = ix + dx;
      const z = iz + dz;
      if (x < 0 || z < 0 || x > grid.nx || z > grid.nz) return false;
      const node = grid.index[z * (grid.nx + 1) + x]!;
      if (node < 0 || (grid.fit[node]! & need) !== need || blocked?.(node)) return false;
      if (Math.abs(g.nodes[node]!.y - a.y) > 0.35) return false;
    }
  }
  return true;
}

/**
 * A grid route as a few straight legs: from each kept point, the farthest later point still in a
 * clear straight line (`driveLineClear`). The truck then drives lanes straight, not the grid's
 * 45° zigzag.
 */
export function smoothDriveRoute(
  g: DriveGraph,
  ids: readonly number[],
  blocked?: (node: number) => boolean,
): Vec3[] {
  if (!ids.length) return [];
  const pts = ids.map((i) => g.nodes[i]!);
  const out: Vec3[] = [{ ...pts[0]! }];
  let i = 0;
  while (i < pts.length - 1) {
    let j = i + 1;
    // Look up to ~40 grid steps ahead (a long lane is several legs; the cost stays small).
    for (let k = Math.min(pts.length - 1, i + 40); k > i + 1; k--) {
      if (driveLineClear(g, pts[i]!, pts[k]!, blocked)) {
        j = k;
        break;
      }
    }
    out.push({ ...pts[j]! });
    i = j;
  }
  return out;
}

/** Room to turn at node `i`: the body fits along all four grid axes there. */
export function roomy(g: DriveGraph, i: number): boolean {
  return g.grid ? g.grid.fit[i] === 15 : g.edges[i]!.length >= 6;
}

/** The node nearest a point (horizontal), or -1. */
export function nearestDriveNode(g: DriveGraph, p: { x: number; z: number }, maxDist = 6): number {
  let best = -1;
  let bestD = maxDist * maxDist;
  g.nodes.forEach((n, i) => {
    if (!g.edges[i]!.length) return;
    const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * Shortest path (A*, straight-line heuristic) as node indices, or null. Ground where the body
 * doesn't fit at every heading (next to walls and props) costs `HUG_COST`× to cross, so routes
 * keep to open ground and the truck lanes where there is a choice. `blocked` nodes (where
 * another truck stands: the graph only knows the static world) are not entered.
 */
export function driveRoute(
  g: DriveGraph,
  from: number,
  to: number,
  blocked?: (node: number) => boolean,
  /** Cost multiplier of crossing between two nodes (default: `HUG_COST` off roomy ground). */
  weight?: (a: number, b: number) => number,
): number[] | null {
  if (from < 0 || to < 0) return null;
  const n = g.nodes.length;
  const cost = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const goal = g.nodes[to]!;
  const h = (i: number): number => Math.hypot(g.nodes[i]!.x - goal.x, g.nodes[i]!.z - goal.z);
  // Binary heap of [f, node].
  const heap: [number, number][] = [];
  const push = (f: number, i: number): void => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (heap[parent]![0] <= heap[k]![0]) break;
      [heap[parent], heap[k]] = [heap[k]!, heap[parent]!];
      k = parent;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  cost[from] = 0;
  push(h(from), from);
  while (heap.length) {
    const [, i] = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === to) break;
    const pi = g.nodes[i]!;
    for (const j of g.edges[i]!) {
      if (blocked && j !== to && blocked(j)) continue;
      const pj = g.nodes[j]!;
      const w = weight ? weight(i, j) : !roomy(g, i) || !roomy(g, j) ? HUG_COST : 1;
      const c = cost[i]! + Math.hypot(pj.x - pi.x, pj.z - pi.z) * w;
      if (c < cost[j]!) {
        cost[j] = c;
        came[j] = i;
        push(c + h(j), j);
      }
    }
  }
  if (!done[to]) return null;
  const path: number[] = [];
  for (let i = to; i >= 0; i = came[i]!) {
    path.push(i);
    if (i === from) break;
  }
  return path.reverse();
}

/** Connected components (node → component id; -1 for isolated nodes). */
export function driveComponents(g: DriveGraph): Int32Array {
  const comp = new Int32Array(g.nodes.length).fill(-1);
  let next = 0;
  for (let s = 0; s < g.nodes.length; s++) {
    if (comp[s] !== -1 || !g.edges[s]!.length) continue;
    const stack = [s];
    comp[s] = next;
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of g.edges[i]!) {
        if (comp[j] === -1) {
          comp[j] = next;
          stack.push(j);
        }
      }
    }
    next++;
  }
  return comp;
}
