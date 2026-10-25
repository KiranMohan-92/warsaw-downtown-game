import { beforeAll, describe, expect, it } from 'vitest';
import {
  block,
  boxMinMax,
  buildDriveGraph,
  driveRoute,
  initPhysics,
  nearestDriveNode,
  PhysicsWorld,
  refreshDriveGraph,
  type MapDefinition,
  type Vec3,
} from '@wd/shared';
import { MatchSim } from '../match/MatchSim.ts';
import { getNavGraph } from './nav.ts';

beforeAll(async () => {
  await initPhysics();
});

/**
 * A 1 m alley (x ∈ [-0.5, 0.5], z ∈ [-6, 6]) between a wall and a block; the ways round are the
 * open ground either side. A drum waits off to the side.
 */
const alley = (): MapDefinition => ({
  name: 'alley',
  bounds: { minX: -30.25, maxX: 30.25, minZ: -30.25, maxZ: 30.25 },
  boxes: [
    boxMinMax({ x: -31, y: -1, z: -31 }, { x: 31, y: 0, z: 31 }, 'ground'),
    block(-1, 0, 0, 1, 3, 12, 'concrete'),
    block(3, 0, 0, 5, 3, 12, 'concrete'),
  ],
  decor: [{ kind: 'drum', x: 20, z: 20 }],
  spawns: [],
  dummies: [],
});
const inAlley = (p: Vec3): boolean => Math.abs(p.x) < 0.6 && Math.abs(p.z) < 5;
const box = { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 };

describe('bots route round props that settle in their way', () => {
  it('the walk graph closes the alley under a settled drum and opens it once it goes', () => {
    const map = alley();
    const world = new PhysicsWorld(map);
    const nav = getNavGraph(map, world, 0.5);
    const from = { x: 0, y: 0, z: -12 };
    const to = { x: 0, y: 0, z: 12 };
    const before = nav.route(from, to);
    expect(before.complete).toBe(true);
    expect(before.points.some(inAlley)).toBe(true);
    // A drum knocked into the alley settles across it.
    world.placeProp(0, { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    world.refreshQueries();
    nav.invalidate!(box);
    const round = nav.route(from, to);
    expect(round.complete).toBe(true);
    expect(round.points.some(inAlley)).toBe(false); // round the wall or the block instead
    // Smashed (or reset): the alley again.
    world.removeProp(0);
    nav.invalidate!(box);
    expect(nav.route(from, to).points.some(inAlley)).toBe(true);
  });

  it('the drive graph drops the nodes a settled prop blocks, per match (copy on write)', () => {
    const map: MapDefinition = {
      ...alley(),
      boxes: [alley().boxes[0]!],
      decor: [{ kind: 'drum', x: 20, z: 20 }],
    };
    const world = new PhysicsWorld(map);
    const base = buildDriveGraph(world, { minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
    const a = nearestDriveNode(base, { x: 0, z: -10 });
    const b = nearestDriveNode(base, { x: 0, z: 10 });
    const straight = driveRoute(base, a, b)!;
    expect(
      straight.some((i) => Math.abs(base.nodes[i]!.z) < 1 && Math.abs(base.nodes[i]!.x) < 1),
    ).toBe(true);
    world.placeProp(0, { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    world.refreshQueries();
    const view = refreshDriveGraph(base, base, world, box);
    const route = driveRoute(view, a, b)!;
    // No node within a truck's half-width (+ margin) of the drum is on the way now.
    expect(route.some((i) => Math.hypot(view.nodes[i]!.x, view.nodes[i]!.z) < 1.4)).toBe(false);
    // The shared graph is untouched; the drum gone, the view is as before.
    expect(driveRoute(base, a, b)).toEqual(straight);
    world.removeProp(0);
    expect(driveRoute(refreshDriveGraph(base, view, world, box), a, b)).toEqual(straight);
  });

  it("a match's bots get the change within a few ticks of the prop settling", () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 1 });
    sim.addPlayer('a', 'A', 0);
    sim.bots.sync();
    const nav = getNavGraph(sim.map, sim.physics);
    const nodes = nav.nodes;
    sim.props.hit({
      id: 0,
      kind: 'smash',
      mass: 45,
      shove: 1,
      into: 6,
      normal: { x: 0, z: -1 },
      vel: { x: 0, y: 0, z: 6 },
      point: { ...sim.physics.prop(0)!.pos },
      carried: [],
    });
    for (let i = 0; i < 10; i++) sim.step();
    expect(nav.nodes).not.toBe(nodes); // the overlay took the change
    sim.dispose();
  });

  it('the backlog stays bounded with no bots to drain it, and a new match clears it', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' }); // no bots
    sim.addPlayer('a', 'A', 0);
    let most = 0;
    for (let cycle = 0; cycle < 30; cycle++) {
      for (let id = 0; id < sim.physics.propCount; id++)
        sim.props.hit({
          id,
          kind: 'smash',
          mass: 45,
          shove: 1,
          into: 6,
          normal: { x: 0, z: -1 },
          vel: { x: 0, y: 0, z: 6 },
          point: { ...sim.physics.prop(id)!.pos },
          carried: [],
        });
      sim.step();
      most = Math.max(most, sim.bots.pendingGraphChecks);
      sim.props.reset(); // what a new match does
      expect(sim.bots.pendingGraphChecks).toBe(0);
    }
    // At most one entry per 4 m of ground the props cover (12 props on the range).
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(sim.physics.propCount);
    sim.dispose();
  });
});
