import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../config/tunables.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { emptyInput } from '../sim/input.ts';
import { createPlayerState, stepPlayer } from '../sim/player.ts';
import { getMap, resolveMap } from './registry.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('Market hall stair landing', () => {
  it('has visible upper tread support across the connection to the landing', () => {
    const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
    try {
      // Probe both boot lanes across the former 0.8 m gap, excluding hidden ramps.
      for (const z of [26.45, 26.95])
        for (let i = 0; i <= 22; i++) {
          const x = 144.65 + i * 0.05;
          const hit = world.castVisibleRay({ x, y: 4.1, z }, { x: 0, y: -1, z: 0 }, 4.1);
          expect(hit, `visible tread x=${x}, z=${z}`).not.toBeNull();
          expect(hit!.normal.y).toBeGreaterThan(0.65);
          expect(hit!.point.y, `upper support x=${x}, z=${z}`).toBeGreaterThan(3.2);
        }
    } finally {
      world.free();
    }
  });

  it.each([true, false])('walks continuously across the landing (ascending=%s)', (ascending) => {
    const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
    const start = { x: ascending ? 151.3 : 144.5, y: ascending ? 0.06 : 3.62, z: 26.7 };
    const player = createPlayerState(start);
    const body = world.createCharacter(start);
    let connectionSamples = 0;
    let airborneRun = 0;
    let longestAirborneRun = 0;
    try {
      for (let tick = 0; tick < 144; tick++) {
        stepPlayer(
          player,
          {
            ...emptyInput(tick),
            yaw: ascending ? Math.PI / 2 : -Math.PI / 2,
            moveZ: tick >= 12 ? 1 : 0,
          },
          SIM_DT,
          body,
        );
        const { pos, grounded } = player.move;
        expect([pos.x, pos.y, pos.z].every(Number.isFinite)).toBe(true);
        if (pos.x >= 144.8 && pos.x <= 145.6) {
          connectionSamples++;
          expect(pos.y).toBeGreaterThan(3.2);
          airborneRun = grounded ? 0 : airborneRun + 1;
          longestAirborneRun = Math.max(longestAirborneRun, airborneRun);
        } else airborneRun = 0;
      }
      expect(connectionSamples).toBeGreaterThan(3);
      expect(longestAirborneRun).toBeLessThanOrEqual(2);
      expect(player.move.grounded).toBe(true);
      if (ascending) {
        expect(player.move.pos.x).toBeLessThan(144.8);
        expect(player.move.pos.y).toBeGreaterThan(3.5);
      } else {
        expect(player.move.pos.x).toBeGreaterThan(151);
        expect(player.move.pos.y).toBeLessThan(0.15);
      }
    } finally {
      body.free();
      world.free();
    }
  });
});
