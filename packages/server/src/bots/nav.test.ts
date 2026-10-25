import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPlayerState,
  initPhysics,
  type MapDefinition,
  type PlayerState,
  type Vec3,
} from '@wd/shared';
import { MatchSim } from '../match/MatchSim.ts';
import { BehaviorTreeDecisionProvider } from './behaviorTree.ts';
import {
  NAV_MAX_EXPANSIONS,
  findPath,
  getNavGraph,
  largestComponent,
  type NavGraph,
  type NavNode,
} from './nav.ts';
import { buildBotObservation } from './observation.ts';

beforeAll(async () => {
  await initPhysics();
});

/** A w × h grid, 4-connected, plus `islands` unlinked nodes far off to the side. */
function grid(w: number, h: number, islands = 0): NavNode[] {
  const nodes: { i: number; x: number; y: number; z: number; links: number[] }[] = [];
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) nodes.push({ i: nodes.length, x, y: 0, z, links: [] });
  }
  for (const n of nodes) {
    if (n.x + 1 < w) {
      n.links.push(n.i + 1);
      nodes[n.i + 1]!.links.push(n.i);
    }
    if (n.z + 1 < h) {
      n.links.push(n.i + w);
      nodes[n.i + w]!.links.push(n.i);
    }
  }
  for (let k = 0; k < islands; k++) {
    nodes.push({ i: nodes.length, x: w + 10 + k * 3, y: 0, z: h / 2, links: [] });
  }
  return nodes;
}

describe('nav path search', () => {
  it('finds the shortest path on a grid (heap open set + closed set)', () => {
    const nodes = grid(20, 20);
    const r = findPath(nodes, 0, 399);
    expect(r.complete).toBe(true);
    expect(r.path.at(-1)).toBe(399);
    // Manhattan distance on a 4-connected grid: 19 + 19 steps.
    expect(r.path).toHaveLength(38);
    for (let i = 1; i < r.path.length; i++) {
      expect(nodes[r.path[i - 1]!]!.links).toContain(r.path[i]!);
    }
  });

  it('an unreachable goal (an island) is bounded by the cap and gives a best partial path', () => {
    const nodes = grid(100, 100, 1); // 10k connected nodes, one island beyond them
    const island = nodes.length - 1;
    const r = findPath(nodes, 0, island);
    expect(r.complete).toBe(false);
    expect(r.expanded).toBeLessThanOrEqual(NAV_MAX_EXPANSIONS);
    // Heads towards the island rather than standing still.
    expect(r.path.length).toBeGreaterThan(0);
    const end = nodes[r.path.at(-1)!]!;
    expect(end.x).toBeGreaterThan(nodes[0]!.x);
  });

  it('wander targets exclude islands: only the largest connected component', () => {
    const nodes = grid(10, 10, 3);
    const main = largestComponent(nodes);
    expect(main).toHaveLength(100);
    expect(main.every((n) => n.links.length > 0)).toBe(true);
  });

  it('the full Plac Defilad graph: bounded search time, islands left out of wandering', () => {
    const sim = new MatchSim({ map: 'defilad', size: 'full', mode: 'standard', botCount: 0 });
    try {
      const graph = sim.bots.prewarm();
      // Built once, before any tick; the tick path reuses the same cached graph.
      expect(sim.bots.prewarm()).toBe(graph);
      expect(getNavGraph(sim.map, sim.physics)).toBe(graph);
      expect(graph.nodes.length).toBeGreaterThan(NAV_MAX_EXPANSIONS);
      const main = new Set(graph.wanderNodes.map((n) => n.i));
      expect(main.size).toBeGreaterThan(graph.nodes.length / 2);
      const islands = graph.nodes.filter((n) => !main.has(n.i));
      expect(islands.length).toBeGreaterThan(0); // crate / kiosk tops exist on this map
      // Corner to corner of the main component, and into an island (the old worst case: the
      // search exhausted the whole component with a full sort per pop).
      const byX = [...graph.wanderNodes].sort((a, b) => a.x + a.z - (b.x + b.z));
      const a = byX[0]!;
      const b = byX.at(-1)!;
      for (const goal of [b, islands[0]!, islands.at(-1)!]) {
        const t0 = performance.now();
        const r = findPath(graph.nodes, a.i, goal.i);
        const ms = performance.now() - t0;
        expect(r.expanded).toBeLessThanOrEqual(NAV_MAX_EXPANSIONS);
        // Generous for slow CI; the unbounded search took seconds here.
        expect(ms).toBeLessThan(250);
      }
    } finally {
      sim.dispose();
    }
  }, 120000);
});

describe('bot wandering', () => {
  it('never picks an island node as a wander goal', () => {
    const nodes = grid(6, 6, 4);
    const main = largestComponent(nodes);
    const mainIds = new Set(main.map((n) => n.i));
    const goals: Vec3[] = [];
    const nav: NavGraph = {
      key: 'islands',
      cellSize: 1,
      nodes,
      wanderNodes: main,
      nearest: (p) =>
        nodes.reduce((best, n) =>
          Math.hypot(n.x - p.x, n.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z) ? n : best,
        ),
      path: (_from, to) => {
        goals.push(to);
        return [to];
      },
      route: (_from, to) => {
        goals.push(to);
        return { points: [to], complete: true };
      },
      lineOfSight: () => false,
    };
    const map: MapDefinition = {
      name: 'islands',
      bounds: { minX: -1, maxX: 30, minZ: -1, maxZ: 10 },
      boxes: [],
      spawns: [],
      dummies: [],
    };
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const physics = sim.physics;
    for (let seed = 1; seed <= 20; seed++) {
      const bot = new BehaviorTreeDecisionProvider({
        id: 'bot',
        seed,
        difficulty: 'normal',
        behavior: 'ffa',
      });
      const state: PlayerState = createPlayerState({ x: 0, y: 0, z: 0 });
      const self = { id: 'bot', name: 'Bot', slot: 0, isBot: true, state };
      for (let t = 0; t < 40; t++) {
        const o = buildBotObservation({
          map,
          physics,
          self,
          players: [self],
          nowMs: t * 5000,
          seq: t,
          nav,
          mode: 'standard',
        });
        bot.decide({ ...o, nav }, 1 / 60);
      }
    }
    sim.dispose();
    expect(goals.length).toBeGreaterThan(0);
    for (const g of goals) {
      const n = nodes.find((m) => m.x === g.x && m.z === g.z);
      expect(n && mainIds.has(n.i), `goal ${g.x},${g.z}`).toBe(true);
    }
  });
});

describe('partial routes (capped search)', () => {
  it('a bot re-searches from the end of a partial route instead of walking at the raw goal', () => {
    const nodes = grid(3, 1, 4);
    let searches = 0;
    const partial: NavGraph = {
      key: 'partial',
      cellSize: 4,
      nodes,
      wanderNodes: nodes,
      nearest: (p) =>
        nodes.reduce((best, n) =>
          Math.hypot(n.x - p.x, n.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z) ? n : best,
        ),
      path: () => [],
      route: () => {
        searches++;
        return { points: [], complete: false };
      },
      lineOfSight: () => false,
    };
    const bot = new BehaviorTreeDecisionProvider({
      id: 'b',
      seed: 7,
      difficulty: 'normal',
      behavior: 'ffa',
    });
    const steer = (
      bot as unknown as {
        steer(p: Vec3, g: Vec3, n: NavGraph, t: number): { x: number; z: number };
      }
    ).steer.bind(bot);
    // Goal far away behind whatever the capped search could not route around.
    const move = steer({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -80 }, partial, 0);
    expect(move).toEqual({ x: 0, z: 0 }); // no beeline at the goal
    steer({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -80 }, partial, 16);
    expect(searches).toBe(2); // searched again next decision
  });
});
