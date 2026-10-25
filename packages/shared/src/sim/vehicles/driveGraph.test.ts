import { beforeAll, describe, expect, it } from 'vitest';
import { boxMinMax } from '../../maps/builder.ts';
import type { MapBox, MapDefinition } from '../../maps/types.ts';
import { initPhysics, PhysicsWorld } from '../../physics/world.ts';
import {
  buildDriveGraph,
  driveLineClear,
  driveRoute,
  nearestDriveNode,
  roomy,
  smoothDriveRoute,
} from './driveGraph.ts';

beforeAll(async () => {
  await initPhysics();
});

const B = { minX: -30, maxX: 30, minZ: -20, maxZ: 20 };
const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'lot',
  bounds: B,
  boxes: [boxMinMax({ x: -40, y: -1, z: -30 }, { x: 40, y: 0, z: 30 }, 'ground'), ...boxes],
  spawns: [],
  dummies: [],
});

describe('drive graph: straight legs and other trucks', () => {
  it('a straight run across open ground is one leg; through a wall it is not clear', () => {
    // A wall across the lot's middle with a gap at its north end.
    const g = buildDriveGraph(
      new PhysicsWorld(
        mapOf([boxMinMax({ x: -0.5, y: 0, z: -20 }, { x: 0.5, y: 3, z: 8 }, 'concrete')]),
      ),
      B,
    );
    const a = { x: -20, y: 0, z: -10 };
    const b = { x: -6, y: 0, z: -10 };
    expect(driveLineClear(g, a, b)).toBe(true);
    expect(driveLineClear(g, a, { x: 20, y: 0, z: -10 })).toBe(false);
    // Out in the open the body fits at every heading; right by the wall only along it.
    expect(roomy(g, nearestDriveNode(g, a))).toBe(true);
    const tight = g.nodes.findIndex((n) => Math.abs(n.x) <= 3 && n.z < 6);
    if (tight >= 0) expect(roomy(g, tight)).toBe(false);
    // Round the wall's end: the grid's dozens of steps become a few straight legs.
    const from = nearestDriveNode(g, a);
    const to = nearestDriveNode(g, { x: 20, z: -10 });
    const ids = driveRoute(g, from, to)!;
    expect(ids.length).toBeGreaterThan(15);
    const legs = smoothDriveRoute(g, ids);
    expect(legs.length).toBeLessThanOrEqual(8);
    expect(legs.length).toBeLessThan(ids.length / 3);
    // Every leg is a clear straight run, or one of the graph's own steps (beside the wall).
    for (let k = 0; k + 1 < legs.length; k++) {
      const [p, q] = [legs[k]!, legs[k + 1]!];
      const step = Math.hypot(q.x - p.x, q.z - p.z) <= g.cell * Math.SQRT2 + 1e-6;
      expect(step || driveLineClear(g, p, q)).toBe(true);
    }
  });

  it('never routes or smooths through ground another truck stands on', () => {
    const g = buildDriveGraph(new PhysicsWorld(mapOf([])), B);
    const from = nearestDriveNode(g, { x: -20, z: 0 });
    const to = nearestDriveNode(g, { x: 20, z: 0 });
    // A parked truck across the straight line in the middle.
    const blocked = (i: number): boolean =>
      Math.abs(g.nodes[i]!.x) < 4 && Math.abs(g.nodes[i]!.z) < 5;
    const open = smoothDriveRoute(g, driveRoute(g, from, to)!);
    expect(open).toHaveLength(2); // straight across
    const ids = driveRoute(g, from, to, blocked)!;
    expect(ids.some(blocked)).toBe(false);
    const legs = smoothDriveRoute(g, ids, blocked);
    expect(legs.length).toBeGreaterThan(2);
    for (const p of legs) expect(Math.abs(p.x) < 4 && Math.abs(p.z) < 5).toBe(false);
  });

  it('a route weight keeps it to the cheap ground where there is a choice', () => {
    const g = buildDriveGraph(new PhysicsWorld(mapOf([])), B);
    const from = nearestDriveNode(g, { x: -20, z: 0 });
    const to = nearestDriveNode(g, { x: 20, z: 0 });
    // A "lane" along z = 14: everywhere else costs 3×.
    const lane = (i: number): boolean => Math.abs(g.nodes[i]!.z - 14) < 3;
    const ids = driveRoute(g, from, to, undefined, (i, j) => (lane(i) && lane(j) ? 1 : 3))!;
    const share = ids.filter(lane).length / ids.length;
    expect(share).toBeGreaterThan(0.5);
  });
});
