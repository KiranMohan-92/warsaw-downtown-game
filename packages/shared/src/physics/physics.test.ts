import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER } from '../config/tunables.ts';
import { block, boxMinMax, ramp } from '../maps/builder.ts';
import { tankWreck } from '../maps/props.ts';
import type { MapBox, MapDefinition } from '../maps/types.ts';
import { Button } from '../sim/input.ts';
import { createPlayerState, type PlayerState } from '../sim/player.ts';
import { run } from '../sim/testUtils.ts';
import { initPhysics, PhysicsWorld, type RapierCharacter } from './world.ts';

beforeAll(async () => {
  await initPhysics();
});

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'test',
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  boxes: [boxMinMax({ x: -50, y: -1, z: -50 }, { x: 50, y: 0, z: 50 }, 'ground'), ...boxes],
  spawns: [],
  dummies: [],
});

function spawn(
  world: PhysicsWorld,
  feet = { x: 0, y: 0.05, z: 0 },
): { p: PlayerState; body: RapierCharacter } {
  const p = createPlayerState(feet);
  const body = world.createCharacter(feet);
  run(p, body, 0.3, {});
  return { p, body };
}

describe('Rapier character', () => {
  it('stands on the ground', () => {
    const world = new PhysicsWorld(mapOf([]));
    const { p } = spawn(world);
    expect(p.move.grounded).toBe(true);
    expect(p.move.pos.y).toBeGreaterThan(-0.01);
    expect(p.move.pos.y).toBeLessThan(0.05);
  });

  it('walks, sprints, and crouch-walks up a step below the step height without jumping', () => {
    for (const buttons of [0, Button.Sprint, Button.Crouch]) {
      const world = new PhysicsWorld(mapOf([block(0, -12, 0, 4, 0.4, 20, 'concrete')]));
      const { p, body } = spawn(world);
      run(p, body, 1.5, { moveZ: 1, buttons });
      expect(p.move.pos.y).toBeGreaterThan(0.38);
      expect(p.move.pos.z).toBeLessThan(-2.5);
    }
  });

  it('keeps full speed when stepping up a curb', () => {
    const world = new PhysicsWorld(mapOf([block(0, -12, 0, 4, 0.15, 20, 'sidewalk')]));
    const { p, body } = spawn(world);
    run(p, body, 1.0, { moveZ: 1 });
    const z0 = p.move.pos.z;
    run(p, body, 0.5, { moveZ: 1 });
    expect(p.move.pos.y).toBeGreaterThan(0.14);
    expect(Math.abs(p.move.pos.z - z0)).toBeGreaterThan(0.5 * 4.6 * 0.95);
  });

  it('is blocked by a step above the step height, but can jump onto it', () => {
    const world = new PhysicsWorld(mapOf([block(0, -3, 0, 4, 0.6, 4, 'concrete')]));
    const { p, body } = spawn(world);
    run(p, body, 1.5, { moveZ: 1 });
    expect(p.move.pos.y).toBeLessThan(0.1);
    expect(p.move.pos.z).toBeGreaterThan(-1.2); // stopped at the face (z = -1)
    run(p, body, 1.0, (i) => ({ moveZ: 1, buttons: i === 0 ? Button.Jump : 0 }));
    expect(p.move.pos.y).toBeGreaterThan(0.55);
  });

  it('climbs a 30° ramp but slides back down a 60° ramp', () => {
    const r30 = new PhysicsWorld(
      mapOf([ramp({ x: 0, y: 0, z: -2 }, '-z', 5, 5 * Math.tan(Math.PI / 6), 3, 'trim')]),
    );
    const a = spawn(r30);
    // 1 s at walk speed covers ~2.4 m of the 5 m ramp (the free-standing ramp ends in a drop).
    run(a.p, a.body, 1, { moveZ: 1 });
    expect(a.p.move.pos.y).toBeGreaterThan(1.0);

    const r60 = new PhysicsWorld(
      mapOf([ramp({ x: 0, y: 0, z: -2 }, '-z', 2, 2 * Math.tan(Math.PI / 3), 3, 'trim')]),
    );
    const b = spawn(r60);
    run(b.p, b.body, 2, { moveZ: 1 });
    expect(b.p.move.pos.y).toBeLessThan(1.0);
  });

  it('cannot stand up under a low ceiling, stands once clear', () => {
    const world = new PhysicsWorld(
      mapOf([boxMinMax({ x: -2, y: 1.4, z: -6 }, { x: 2, y: 2, z: -2 }, 'concrete')]),
    );
    const { p, body } = spawn(world);
    // Standing: blocked by the slab.
    run(p, body, 1.5, { moveZ: 1 });
    expect(p.move.pos.z).toBeGreaterThan(-2);
    // Crouched: passes under.
    run(p, body, 1.2, { moveZ: 1, buttons: Button.Crouch });
    expect(p.move.pos.z).toBeLessThan(-2.5);
    expect(p.move.pos.z).toBeGreaterThan(-5.5);
    // Releasing crouch under the slab keeps us crouched.
    run(p, body, 0.1, {});
    expect(p.move.crouched).toBe(true);
    // Walk out (still crouched automatically), then stand.
    run(p, body, 3, { moveZ: 1 });
    expect(p.move.pos.z).toBeLessThan(-6.5);
    expect(p.move.crouched).toBe(false);
  });

  it('never hitches on flat ground (constant speed every step)', () => {
    const world = new PhysicsWorld(mapOf([block(0, -20, 0, 6, 0.15, 36, 'sidewalk')]));
    const { p, body } = spawn(world, { x: 0, y: 0.2, z: -3 });
    run(p, body, 0.6, { moveZ: 1 }); // reach full speed
    let slowest = Infinity;
    run(p, body, 5, { moveZ: 1 }, () => {
      slowest = Math.min(slowest, Math.hypot(p.move.vel.x, p.move.vel.z));
    });
    expect(p.move.pos.z).toBeLessThan(-26);
    expect(slowest).toBeGreaterThan(4.6 * 0.999);
  });

  it('does not tunnel through a thin wall at terminal speed', () => {
    const world = new PhysicsWorld(
      mapOf([boxMinMax({ x: -5, y: 0, z: -3.05 }, { x: 5, y: 4, z: -2.95 }, 'metal')]),
    );
    const { p, body } = spawn(world);
    p.move.vel = { x: 0, y: 0, z: -60 };
    run(p, body, 0.5, { moveZ: 1, buttons: Button.Sprint });
    expect(p.move.pos.z).toBeGreaterThan(-2.95 + PLAYER.radius - 0.05);
  });

  it('lands on a slab after a long fall', () => {
    const world = new PhysicsWorld(
      mapOf([boxMinMax({ x: -3, y: 4.8, z: -3 }, { x: 3, y: 5, z: 3 }, 'concrete')]),
    );
    const p = createPlayerState({ x: 0, y: 30, z: 0 });
    const body = world.createCharacter({ x: 0, y: 30, z: 0 });
    const events = run(p, body, 4, {});
    expect(p.move.pos.y).toBeGreaterThan(4.95);
    expect(p.move.grounded).toBe(true);
    const land = events.find((e) => e.type === 'land');
    expect(land && land.type === 'land' && land.impactSpeed).toBeGreaterThan(15);
  });

  it('raycasts flag collision-only geometry as invisible (no decals on map bounds)', () => {
    const world = new PhysicsWorld(
      mapOf([
        boxMinMax({ x: -5, y: 0, z: -11 }, { x: 5, y: 5, z: -10 }, 'concrete', { visible: false }),
        boxMinMax({ x: -5, y: 0, z: 10 }, { x: 5, y: 5, z: 11 }, 'concrete'),
      ]),
    );
    expect(world.castRay({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 100)?.visible).toBe(false);
    expect(world.castRay({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 100)?.visible).toBe(true);
  });

  it('world raycast hits boxes and reports the face normal', () => {
    const world = new PhysicsWorld(mapOf([block(0, -10, 0, 2, 2, 2, 'concrete')]));
    const hit = world.castRay({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 100);
    expect(hit?.distance).toBeCloseTo(9, 4);
    expect(hit?.normal.z).toBeCloseTo(1, 4);
  });

  it('presentation rays see the wall behind hidden movement helpers without changing bullet hits', () => {
    const world = new PhysicsWorld(
      mapOf([
        { ...block(0, -3, 0, 4, 3, 1, 'concrete'), visible: false },
        block(0, -7, 0, 4, 3, 1, 'metal'),
      ]),
    );
    const origin = { x: 0, y: 1, z: 0 };
    const dir = { x: 0, y: 0, z: -1 };
    expect(world.castRay(origin, dir, 10)?.visible).toBe(false);
    const visible = world.castVisibleRay(origin, dir, 10);
    expect(visible?.visible).toBe(true);
    expect(visible?.distance).toBeCloseTo(6.5, 4);
    expect(visible?.surface).toBe('metal');
    expect(visible?.normal.z).toBeCloseTo(1, 4);
    expect(world.castVisibleRay(origin, dir, 5)).toBeNull();
    expect(world.castRay(origin, dir, 10)?.distance).toBeCloseTo(2.5, 4);
  });

  it('presentation support reaches the visible floor below a hidden helper', () => {
    const world = new PhysicsWorld(
      mapOf([{ ...block(0, 0, 0.2, 4, 0.4, 4, 'concrete'), visible: false }]),
    );
    const origin = { x: 0, y: 1, z: 0 };
    const dir = { x: 0, y: -1, z: 0 };
    expect(world.castRay(origin, dir, 2)?.visible).toBe(false);
    expect(world.castVisibleRay(origin, dir, 2)?.point.y).toBeCloseTo(0, 4);
    expect(world.castVisibleRay(origin, { x: 1, y: 0, z: 0 }, 5)).toBeNull();
  });

  it('raycasts wrecks against their visible ray mesh instead of movement boxes', () => {
    const world = new PhysicsWorld(mapOf(tankWreck({ x: 0, z: 0 })));
    const hit = world.castRay({ x: 3.1, y: 2.7, z: -5 }, { x: 0, y: 0, z: 1 }, 10);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeLessThan(4.25);
    expect(hit!.surface).toBe('metal');
  });

  it('keeps wreck boxes for character movement', () => {
    const world = new PhysicsWorld(mapOf(tankWreck({ x: 0, z: 0 })));
    const { p, body } = spawn(world, { x: 0, y: 1.1, z: -3.8 });
    run(p, body, 1.2, { moveZ: -1, buttons: Button.Sprint });
    expect(p.move.pos.z).toBeLessThan(-1.7);
  });
});
