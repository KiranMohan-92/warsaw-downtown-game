import { beforeAll, describe, expect, it } from 'vitest';
import { mulberry32 } from '../math/rng.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { boxMinMax } from './builder.ts';
import { generateSpawns } from './spawns.ts';
import type { MapDefinition } from './types.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('generateSpawns yaw', () => {
  it('keeps a 15° clearance instead of grazing a wall corner', () => {
    const seed = 0x5eed;
    const spacing = 7;
    const margin = 8;
    const bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    // Same first grid cell and jitter generateSpawns will use, so the wall sits on that spawn.
    const rng = mulberry32(seed);
    const px = bounds.minX + margin + (rng() - 0.5) * spacing * 0.8;
    const pz = bounds.minZ + margin + (rng() - 0.5) * spacing * 0.8;
    // Face at +0.9 m in x, running far along -Z and ending just past the player. Yaw 0
    // (look -Z) misses the corner; yaw 0−15° hits the face a few metres out.
    const map: MapDefinition = {
      name: 'spawn-yaw',
      bounds,
      boxes: [
        boxMinMax({ x: -80, y: -1, z: -80 }, { x: 80, y: 0, z: 80 }, 'ground'),
        boxMinMax(
          { x: px + 0.9, y: 0, z: pz - 30 },
          { x: px + 1.6, y: 3, z: pz + 0.35 },
          'concrete',
        ),
      ],
      spawns: [],
      dummies: [],
    };
    const world = new PhysicsWorld(map);
    const spawns = generateSpawns(world, bounds, { count: 1, seed, spacing, margin });
    expect(spawns).toHaveLength(1);
    const s = spawns[0]!;
    expect(s.pos.x).toBeCloseTo(px, 5);
    expect(s.pos.z).toBeCloseTo(pz, 5);
    const chest = { x: s.pos.x, y: s.pos.y + 1.3, z: s.pos.z };
    const spread = (15 * Math.PI) / 180;
    const openAt = (yaw: number): number => {
      const d = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      return world.castRay(chest, d, 60)?.distance ?? 60;
    };
    const clearance = (yaw: number): number =>
      Math.min(openAt(yaw - spread), openAt(yaw), openAt(yaw + spread));
    // The straight -Z ray is the one a single-ray pick would take, and it has no side margin.
    expect(openAt(0)).toBe(60);
    expect(clearance(0)).toBeLessThan(8);
    expect(clearance(s.yaw)).toBeGreaterThanOrEqual(8);
    world.free();
  });
});
