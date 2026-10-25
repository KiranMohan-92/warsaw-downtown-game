import {
  BOT,
  CHARACTER,
  MOVEMENT,
  PLAYER,
  type Bounds,
  type MapDefinition,
  type PhysicsWorld,
  type Vec3,
} from '@wd/shared';

export interface NavNode {
  readonly i: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly links: readonly number[];
}

export interface NavGraph {
  readonly key: string;
  readonly cellSize: number;
  readonly nodes: readonly NavNode[];
  /**
   * The largest connected component: wander targets come from here, never from one-node islands
   * (crate and kiosk tops) a path could only reach by exhausting the graph.
   */
  readonly wanderNodes: readonly NavNode[];
  nearest(pos: Vec3): NavNode | null;
  path(from: Vec3, to: Vec3): readonly Vec3[];
  /**
   * `path` plus whether it reaches the goal: a capped search returns only the best partial route,
   * and a bot must not beeline from its end to the raw goal (through buildings).
   */
  route(from: Vec3, to: Vec3): { points: readonly Vec3[]; complete: boolean };
  lineOfSight(from: Vec3, to: Vec3): boolean;
  /**
   * The match's props moved in `box` (a truck knocked, smashed or a prop settled): its nodes and
   * edges are checked again against this world as it is now (per world: matches share the
   * topology build, never each other's props).
   */
  invalidate?(box: { minX: number; maxX: number; minZ: number; maxZ: number }): void;
  /** Every prop home again: drop the overlay (the shared topology is exact again). */
  reset?(): void;
}

const EDGE_CLEARANCE = PLAYER.radius + 0.08;

/**
 * Most nodes one path search may expand (the full map has ~12k): past it the search returns the
 * best partial path found, so a bot's decision never stalls the server's event loop.
 */
export const NAV_MAX_EXPANSIONS = 4000;

/** Binary min-heap of node indices by priority (A*'s open set). */
class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      ids[i] = ids[parent]!;
      keys[i] = keys[parent]!;
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0]!;
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n === 0) return top;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && keys[r]! < keys[l]! ? r : l;
      if (keys[c]! >= lastKey) break;
      ids[i] = ids[c]!;
      keys[i] = keys[c]!;
      i = c;
    }
    ids[i] = lastId;
    keys[i] = lastKey;
    return top;
  }
}

export interface PathSearch {
  /** Node indices after the start, ending at the goal (or the closest node reached). */
  readonly path: number[];
  /** Nodes expanded (bounded by the cap). */
  readonly expanded: number;
  /** The goal was reached (false: a best-effort partial path). */
  readonly complete: boolean;
}

/**
 * A* over the nav graph: binary-heap open set, closed set, and an expansion cap. When the goal
 * is unreachable (another component) or too far to finish within the cap, the path leads to the
 * expanded node closest to the goal.
 */
export function findPath(
  nodes: readonly NavNode[],
  start: number,
  goal: number,
  maxExpansions = NAV_MAX_EXPANSIONS,
): PathSearch {
  const goalNode = nodes[goal]!;
  const came = new Map<number, number>();
  const cost = new Map<number, number>([[start, 0]]);
  const closed = new Set<number>();
  const open = new MinHeap();
  open.push(start, heuristic(nodes[start]!, goalNode));
  let best = start;
  let bestH = heuristic(nodes[start]!, goalNode);
  let expanded = 0;
  let complete = false;
  while (open.size && expanded < maxExpansions) {
    const current = open.pop();
    if (closed.has(current)) continue; // a stale entry (a cheaper one was expanded)
    if (current === goal) {
      complete = true;
      break;
    }
    closed.add(current);
    expanded++;
    const node = nodes[current]!;
    const h = heuristic(node, goalNode);
    if (h < bestH) {
      best = current;
      bestH = h;
    }
    const base = cost.get(current)!;
    for (const next of node.links) {
      if (closed.has(next)) continue;
      const newCost = base + heuristic(node, nodes[next]!);
      if (newCost >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, newCost);
      came.set(next, current);
      open.push(next, newCost + heuristic(nodes[next]!, goalNode));
    }
  }
  const end = complete ? goal : best;
  const path: number[] = [];
  for (let cur = end; cur !== start; cur = came.get(cur)!) path.push(cur);
  return { path: path.reverse(), expanded, complete };
}

/** The nodes of the largest connected component (by node count). */
export function largestComponent(nodes: readonly NavNode[]): NavNode[] {
  const component = new Int32Array(nodes.length).fill(-1);
  let bestId = -1;
  let bestSize = 0;
  let id = 0;
  for (const root of nodes) {
    if (component[root.i] !== -1) continue;
    let size = 0;
    const stack = [root.i];
    component[root.i] = id;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      for (const next of nodes[i]!.links) {
        if (component[next] !== -1) continue;
        component[next] = id;
        stack.push(next);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestId = id;
    }
    id++;
  }
  return nodes.filter((n) => component[n.i] === bestId);
}

type NavTopology = Omit<NavGraph, 'lineOfSight'>;

const topologyCache = new WeakMap<MapDefinition, Map<string, NavTopology>>();
const graphCache = new WeakMap<PhysicsWorld, Map<string, NavGraph>>();

function graphKey(map: MapDefinition, cellSize: number): string {
  const b = map.bounds;
  return `${map.name}:${b.minX},${b.maxX},${b.minZ},${b.maxZ}:${cellSize}`;
}

function sampleGround(physics: PhysicsWorld, x: number, z: number): number | null {
  const origin = { x, y: BOT.navGroundRayStart, z };
  const hit = physics.castRay(origin, { x: 0, y: -1, z: 0 }, BOT.navGroundRayDistance);
  if (!hit) return null;
  const y = hit.point.y;
  const feet = { x, y: y + 0.03, z };
  return physics.overlapsStatic(feet, PLAYER.standHeight, 0.02) ? null : feet.y;
}

function inside(bounds: Bounds, x: number, z: number): boolean {
  return x > bounds.minX && x < bounds.maxX && z > bounds.minZ && z < bounds.maxZ;
}

function edgeWalkable(physics: PhysicsWorld, a: Vec3, b: Vec3): boolean {
  if (Math.abs(a.y - b.y) > CHARACTER.stepHeight + 0.08) return false;
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(2, Math.ceil(dist));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const p = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
    if (physics.overlapsStatic(p, PLAYER.standHeight, 0.02)) return false;
  }
  const eye = PLAYER.standEyeHeight * 0.65;
  const from = { x: a.x, y: a.y + eye, z: a.z };
  const to = { x: b.x, y: b.y + eye, z: b.z };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  for (const offset of [-EDGE_CLEARANCE, 0, EDGE_CLEARANCE]) {
    const nx = (-dz / len) * offset;
    const nz = (dx / len) * offset;
    if (
      physics.castRay(
        { x: from.x + nx, y: from.y, z: from.z + nz },
        dir,
        Math.max(0, len - PLAYER.radius),
      )
    )
      return false;
  }
  return true;
}

export function getNavGraph(
  map: MapDefinition,
  physics: PhysicsWorld,
  cellSize = defaultCellSize(map),
): NavGraph {
  const key = graphKey(map, cellSize);
  let byWorld = graphCache.get(physics);
  if (!byWorld) {
    byWorld = new Map();
    graphCache.set(physics, byWorld);
  }
  const cachedGraph = byWorld.get(key);
  if (cachedGraph) return cachedGraph;
  let byCell = topologyCache.get(map);
  if (!byCell) {
    byCell = new Map();
    topologyCache.set(map, byCell);
  }
  const cached = byCell.get(key);
  if (cached) {
    const graph = withLineOfSight(cached, physics);
    byWorld.set(key, graph);
    return graph;
  }
  const cols = Math.floor((map.bounds.maxX - map.bounds.minX) / cellSize) + 1;
  const rows = Math.floor((map.bounds.maxZ - map.bounds.minZ) / cellSize) + 1;
  const index = new Map<string, number>();
  const mutable: { x: number; y: number; z: number; links: number[] }[] = [];
  for (let rz = 0; rz < rows; rz++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = map.bounds.minX + cx * cellSize + cellSize / 2;
      const z = map.bounds.minZ + rz * cellSize + cellSize / 2;
      if (!inside(map.bounds, x, z)) continue;
      const y = sampleGround(physics, x, z);
      if (y === null) continue;
      index.set(`${cx},${rz}`, mutable.length);
      mutable.push({ x, y, z, links: [] });
    }
  }
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ] as const;
  for (const [k, aIndex] of index) {
    const parts = k.split(',').map(Number);
    const cx = parts[0];
    const rz = parts[1];
    if (cx === undefined || rz === undefined) continue;
    for (const [dx, dz] of dirs) {
      const bIndex = index.get(`${cx + dx},${rz + dz}`);
      if (bIndex === undefined) continue;
      const a = mutable[aIndex]!;
      const b = mutable[bIndex]!;
      if (!edgeWalkable(physics, a, b)) continue;
      a.links.push(bIndex);
      b.links.push(aIndex);
    }
  }
  const nodes = mutable.map((n, i): NavNode => ({ i, x: n.x, y: n.y, z: n.z, links: n.links }));
  const topology: NavTopology = {
    key,
    cellSize,
    nodes,
    wanderNodes: largestComponent(nodes),
    nearest(pos) {
      let best: NavNode | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - pos.x, (n.y - pos.y) * 2, n.z - pos.z);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    },
    path(from, to) {
      return this.route(from, to).points;
    },
    route(from, to) {
      const start = this.nearest(from);
      // Goals come from the main component: an island node (crate/kiosk top) is never a goal,
      // so a search can't exhaust the graph trying to reach it.
      const goal = nearestOf(this.wanderNodes, to);
      if (!start || !goal) return { points: [], complete: false };
      if (start.i === goal.i)
        return { points: [{ x: goal.x, y: goal.y, z: goal.z }], complete: true };
      const found = findPath(nodes, start.i, goal.i);
      return {
        points: found.path.map((i) => {
          const n = nodes[i]!;
          return { x: n.x, y: n.y, z: n.z };
        }),
        complete: found.complete,
      };
    },
  };
  byCell.set(key, topology);
  const graph = withLineOfSight(topology, physics);
  byWorld.set(key, graph);
  return graph;
}

function defaultCellSize(map: MapDefinition): number {
  const area = (map.bounds.maxX - map.bounds.minX) * (map.bounds.maxZ - map.bounds.minZ);
  return Math.max(BOT.navCellSize, Math.sqrt(area / 12000));
}

function nearestOf(nodes: readonly NavNode[], pos: Vec3): NavNode | null {
  let best: NavNode | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - pos.x, (n.y - pos.y) * 2, n.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/**
 * The topology on one world: line of sight against it, and a copy-on-write overlay of the nodes
 * and edges its props changed (`invalidate`), which nearest/route/path follow.
 */
function withLineOfSight(topology: NavTopology, physics: PhysicsWorld): NavGraph {
  const base = topology.nodes;
  let nodes: readonly NavNode[] = base;
  let wander: readonly NavNode[] = topology.wanderNodes;
  const blocked = new Set<number>();
  const open = (n: NavNode): boolean => !blocked.has(n.i);
  const graph: NavGraph = {
    key: topology.key,
    cellSize: topology.cellSize,
    get nodes() {
      return nodes;
    },
    get wanderNodes() {
      return wander;
    },
    nearest(pos) {
      return blocked.size ? nearestOf(nodes.filter(open), pos) : topology.nearest(pos);
    },
    path(from, to) {
      return this.route(from, to).points;
    },
    route(from, to) {
      if (!blocked.size && nodes === base) return topology.route(from, to);
      const start = this.nearest(from);
      const goal = nearestOf(wander, to);
      if (!start || !goal) return { points: [], complete: false };
      if (start.i === goal.i)
        return { points: [{ x: goal.x, y: goal.y, z: goal.z }], complete: true };
      const found = findPath(nodes, start.i, goal.i);
      return {
        points: found.path.map((i) => {
          const n = nodes[i]!;
          return { x: n.x, y: n.y, z: n.z };
        }),
        complete: found.complete,
      };
    },
    lineOfSight(from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return true;
      const dir = { x: dx / len, y: dy / len, z: dz / len };
      return physics.castRay(from, dir, Math.max(0, len - PLAYER.radius)) === null;
    },
    reset() {
      nodes = base;
      wander = topology.wanderNodes;
      blocked.clear();
    },
    invalidate(box) {
      const pad = topology.cellSize;
      const touched = new Set<number>();
      for (const n of base) {
        if (n.x < box.minX - pad || n.x > box.maxX + pad) continue;
        if (n.z < box.minZ - pad || n.z > box.maxZ + pad) continue;
        touched.add(n.i);
      }
      if (!touched.size) return;
      const valid = new Map<number, boolean>();
      for (const i of touched) {
        const n = base[i]!;
        const y = sampleGround(physics, n.x, n.z);
        valid.set(i, y !== null && Math.abs(y - n.y) < 0.2);
      }
      const ok = (i: number): boolean => valid.get(i) ?? !blocked.has(i);
      const edge = new Map<string, boolean>();
      for (const i of touched) {
        for (const j of base[i]!.links) {
          const k = i < j ? `${i},${j}` : `${j},${i}`;
          if (edge.has(k)) continue;
          edge.set(k, ok(i) && ok(j) && edgeWalkable(physics, base[i]!, base[j]!));
        }
      }
      const next = nodes.slice();
      const affected = new Set<number>(touched);
      for (const i of touched) for (const j of base[i]!.links) affected.add(j);
      for (const a of affected) {
        const links = base[a]!.links.filter((b) => {
          const v = edge.get(a < b ? `${a},${b}` : `${b},${a}`);
          return v ?? nodes[a]!.links.includes(b);
        });
        next[a] = { ...base[a]!, links };
      }
      for (const [i, v] of valid) {
        if (v) blocked.delete(i);
        else blocked.add(i);
      }
      nodes = next;
      wander = topology.wanderNodes.filter(open);
    },
  };
  return graph;
}

function heuristic(a: Pick<NavNode, 'x' | 'z'>, b: Pick<NavNode, 'x' | 'z'>): number {
  return Math.hypot(a.x - b.x, a.z - b.z) / MOVEMENT.walkSpeed;
}
