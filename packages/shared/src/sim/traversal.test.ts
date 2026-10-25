import { beforeAll, describe, expect, it } from 'vitest';
import { boxMinMax } from '../maps/builder.ts';
import type { MapBox, MapDefinition } from '../maps/types.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { Button } from './input.ts';
import { createPlayerState, type PlayerEvent } from './player.ts';
import { run } from './testUtils.ts';

beforeAll(async () => {
  await initPhysics();
});

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'traversal',
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  boxes: [boxMinMax({ x: -50, y: -1, z: -50 }, { x: 50, y: 0, z: 50 }, 'ground'), ...boxes],
  spawns: [],
  dummies: [],
});

/** Obstacle across the path at z ∈ [-5, -5 - depth], height h (player walks towards −Z). */
const obstacle = (h: number, depth: number): MapBox =>
  boxMinMax({ x: -3, y: 0, z: -5 - depth }, { x: 3, y: h, z: -5 }, 'concrete');

function approach(
  boxes: MapBox[],
  opts: { sprint: boolean; jumpAt: number; hold?: boolean; seconds?: number },
) {
  const world = new PhysicsWorld(mapOf(boxes));
  const p = createPlayerState({ x: 0, y: 0.05, z: 0 });
  const body = world.createCharacter({ x: 0, y: 0.05, z: 0 });
  run(p, body, 0.3, {});
  const events: PlayerEvent[] = [];
  let firstNear = -1;
  let traversed = false;
  run(
    p,
    body,
    opts.seconds ?? 3,
    (step) => {
      const near = p.move.pos.z < opts.jumpAt;
      // Tap once on arrival (then every 20 steps if still there), or hold.
      if (near && firstNear < 0) firstNear = step;
      if (p.move.traversal) traversed = true;
      const jump = !traversed && (opts.hold ? near : near && (step - firstNear) % 20 === 0);
      return {
        moveZ: 1,
        buttons: (opts.sprint ? Button.Sprint : 0) | (jump ? Button.Jump : 0),
      };
    },
    (e) => events.push(...e),
  );
  return { p, events };
}

describe('climbing and vaulting', () => {
  it('sprint + jump at a waist-high barrier vaults you over it, keeping momentum', () => {
    const { p, events } = approach([obstacle(1.0, 0.6)], { sprint: true, jumpAt: -3.6 });
    expect(events.some((e) => e.type === 'traverse' && e.kind === 'vault')).toBe(true);
    expect(p.move.pos.z).toBeLessThan(-7); // well past the far side
    expect(p.move.pos.y).toBeLessThan(0.2); // back on the ground
  });

  it('jump at a 2.2 m block pulls you up onto it', () => {
    const { p, events } = approach([obstacle(2.2, 6)], {
      sprint: false,
      jumpAt: -4.2,
      seconds: 2.5,
    });
    expect(events.some((e) => e.type === 'traverse' && e.kind === 'mantle')).toBe(true);
    expect(p.move.pos.y).toBeGreaterThan(2.1);
  });

  it('walking (not sprinting) at a waist-high barrier climbs onto it instead of vaulting', () => {
    const { events } = approach([obstacle(1.0, 2)], { sprint: false, jumpAt: -4.2, seconds: 1.5 });
    expect(events.some((e) => e.type === 'traverse' && e.kind === 'mantle')).toBe(true);
  });

  it('sprint + jump vaults a thin crowd barrier (8 cm panel)', () => {
    const { p, events } = approach([obstacle(1.1, 0.08)], { sprint: true, jumpAt: -3.6 });
    expect(events.some((e) => e.type === 'traverse' && e.kind === 'vault')).toBe(true);
    expect(p.move.pos.z).toBeLessThan(-6);
  });

  it('you cannot mantle onto the top of a thin fence (nothing to stand on)', () => {
    const { events } = approach([obstacle(1.8, 0.06)], {
      sprint: false,
      jumpAt: -4.2,
      seconds: 1.5,
    });
    expect(events.some((e) => e.type === 'traverse' && e.kind === 'mantle')).toBe(false);
  });

  it('a 3.5 m wall cannot be climbed', () => {
    const { p, events } = approach([obstacle(3.5, 1)], {
      sprint: false,
      jumpAt: -4.2,
      hold: true,
      seconds: 2,
    });
    expect(events.some((e) => e.type === 'traverse')).toBe(false);
    expect(p.move.pos.y).toBeLessThan(1.2);
    expect(p.move.pos.z).toBeGreaterThan(-5);
  });

  it('no climbing into a gap too low to fit (ledge under a ceiling)', () => {
    const { events } = approach(
      [obstacle(1.5, 3), boxMinMax({ x: -3, y: 2.2, z: -8 }, { x: 3, y: 3, z: -5 }, 'concrete')],
      { sprint: false, jumpAt: -4.2, seconds: 1.5 },
    );
    expect(events.some((e) => e.type === 'traverse')).toBe(false);
  });

  it('while climbing you cannot fire', () => {
    const world = new PhysicsWorld(mapOf([obstacle(2.2, 6)]));
    const p = createPlayerState({ x: 0, y: 0.05, z: -4.3 });
    const body = world.createCharacter({ x: 0, y: 0.05, z: -4.3 });
    run(p, body, 0.6, {});
    const events: PlayerEvent[] = [];
    run(
      p,
      body,
      0.3,
      (step) => ({ moveZ: 1, buttons: step === 0 ? Button.Jump : Button.Fire }),
      (e) => events.push(...e),
    );
    expect(events.some((e) => e.type === 'traverse')).toBe(true);
    expect(events.some((e) => e.type === 'shot')).toBe(false);
  });

  it('while climbing you cannot throw smoke or pulse the jammer', () => {
    const world = new PhysicsWorld(mapOf([obstacle(2.2, 6)]));
    const p = createPlayerState({ x: 0, y: 0.05, z: -4.3 });
    const body = world.createCharacter({ x: 0, y: 0.05, z: -4.3 });
    run(p, body, 0.6, {});
    const events: PlayerEvent[] = [];
    run(
      p,
      body,
      0.3,
      (step) => ({
        moveZ: 1,
        buttons:
          step === 0 ? Button.Jump : step === 3 ? Button.Smoke : step === 6 ? Button.Jammer : 0,
      }),
      (e) => events.push(...e),
    );
    expect(events.some((e) => e.type === 'traverse')).toBe(true);
    expect(events.some((e) => e.type === 'grenadeWindup' || e.type === 'jammer')).toBe(false);
    expect(p.arsenal.smokes).toBeGreaterThan(0);
  });
});
