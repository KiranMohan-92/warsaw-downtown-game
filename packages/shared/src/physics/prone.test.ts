import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER, PRONE } from '../config/tunables.ts';
import { block, boxMinMax } from '../maps/builder.ts';
import type { MapBox, MapDefinition } from '../maps/types.ts';
import { humanoidHitboxes } from '../sim/hitbox.ts';
import { Button } from '../sim/input.ts';
import { createPlayerState, placeBodyAt, type PlayerState } from '../sim/player.ts';
import { run } from '../sim/testUtils.ts';
import { currentSpread } from '../sim/weapon.ts';
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

function spawn(world: PhysicsWorld, feet = { x: 0, y: 0.05, z: 0 }) {
  const p: PlayerState = createPlayerState(feet);
  const body: RapierCharacter = world.createCharacter(feet);
  run(p, body, 0.3, {});
  return { p, body };
}

const tap = (p: PlayerState, body: RapierCharacter, buttons: number): void => {
  run(p, body, 1 / 60, { buttons });
  run(p, body, 1 / 60, {});
};

describe('prone', () => {
  it('drops onto the stomach, crawls slowly, and Jump gets you up (no launch)', () => {
    const { p, body } = spawn(new PhysicsWorld(mapOf([])));
    tap(p, body, Button.Prone);
    expect(p.move.prone).toBe(true);
    run(p, body, 1, {});
    expect(p.move.eyeHeight).toBeCloseTo(PLAYER.proneEyeHeight, 2);
    const z0 = p.move.pos.z;
    run(p, body, 2, { moveZ: 1, buttons: Button.Sprint });
    const crawled = z0 - p.move.pos.z;
    expect(crawled).toBeGreaterThan(PRONE.crawlSpeed * 1.5);
    expect(crawled).toBeLessThan(PRONE.crawlSpeed * 2.05);
    expect(p.move.sprinting).toBe(false);
    tap(p, body, Button.Jump);
    expect(p.move.prone).toBe(false);
    expect(p.move.pos.y).toBeLessThan(0.1); // stood up, didn't jump
    run(p, body, 1, {});
    expect(p.move.eyeHeight).toBeCloseTo(PLAYER.standEyeHeight, 2);
  });

  it('needs clear ground behind for the body', () => {
    // A wall 0.8 m behind (the player faces -Z, so behind is +Z).
    const { p, body } = spawn(new PhysicsWorld(mapOf([block(0, 1.2, 0, 4, 2, 0.4, 'concrete')])));
    tap(p, body, Button.Prone);
    expect(p.move.prone).toBe(false);
  });

  it('gets up to a crouch under a low ceiling', () => {
    // Lie down in the open, crawl under a 1.4 m slab: standing is blocked, crouching fits.
    const world = new PhysicsWorld(mapOf([block(0, -6, 1.4, 6, 0.3, 6, 'concrete')]));
    const { p, body } = spawn(world);
    tap(p, body, Button.Prone);
    run(p, body, 4, { moveZ: 1 });
    tap(p, body, Button.Prone);
    expect(p.move.prone).toBe(false);
    expect(p.move.crouched).toBe(true);
  });

  it('a new life stands at the spawn after dying prone under a low ceiling', () => {
    const world = new PhysicsWorld(mapOf([block(0, -6, 1.4, 6, 0.3, 6, 'concrete')]));
    const { p, body } = spawn(world);
    tap(p, body, Button.Prone);
    run(p, body, 4, { moveZ: 1 });
    expect(body.capsuleHeight).toBe(PLAYER.proneHeight);
    // Standing up is blocked where the body lies (the old respawn resized here, then moved).
    expect(body.setProne(false)).toBe(false);
    const open = { x: 20, y: 0.05, z: 20 };
    expect(placeBodyAt(body, open)).toBe(true);
    expect(body.capsuleHeight).toBe(PLAYER.standHeight);
    expect(body.position).toEqual(open);
  });

  it('a new life stands after dying crouched too', () => {
    const { p, body } = spawn(new PhysicsWorld(mapOf([])));
    run(p, body, 0.5, { buttons: Button.Crouch });
    expect(body.capsuleHeight).toBe(PLAYER.crouchHeight);
    expect(placeBodyAt(body, { x: 5, y: 0.05, z: 5 })).toBe(true);
    expect(body.capsuleHeight).toBe(PLAYER.standHeight);
  });

  it('stays prone under a ceiling too low to crouch (never gets up into geometry)', () => {
    // A 1.0 m slab: the prone capsule (0.75 m) fits, a crouch (1.2 m) doesn't.
    const world = new PhysicsWorld(mapOf([block(0, -6, 1.0, 6, 0.3, 6, 'concrete')]));
    const { p, body } = spawn(world);
    tap(p, body, Button.Prone);
    run(p, body, 4, { moveZ: 1 });
    expect(p.move.pos.z).toBeLessThan(-3.5); // under the slab
    for (const b of [Button.Prone, Button.Crouch, Button.Jump]) {
      tap(p, body, b);
      expect(p.move.prone).toBe(true);
      expect(p.move.crouched).toBe(false);
      expect(world.overlapsStatic(p.move.pos, PLAYER.proneHeight, 0.02)).toBe(false);
    }
  });

  it('one Jump press only gets up from prone, even facing a ledge (no mantle with it)', () => {
    // A 1 m high block ahead: a mantle from standing.
    const world = new PhysicsWorld(
      mapOf([boxMinMax({ x: -3, y: 0, z: -6 }, { x: 3, y: 1.0, z: -3 }, 'concrete')]),
    );
    const { p, body } = spawn(world);
    tap(p, body, Button.Prone);
    run(p, body, 4, { moveZ: 1 }); // crawl up against it
    expect(p.move.pos.z).toBeGreaterThan(-3);
    expect(p.move.pos.z).toBeLessThan(-2.4);
    run(p, body, 1 / 60, { moveZ: 1, buttons: Button.Jump });
    expect(p.move.prone).toBe(false);
    expect(p.move.traversal).toBeNull();
    run(p, body, 1 / 60, { moveZ: 1 });
    // A second press climbs.
    run(p, body, 1 / 60, { moveZ: 1, buttons: Button.Jump });
    expect(p.move.traversal).not.toBeNull();
  });

  it('lies its hit volumes behind the head along the facing', () => {
    const shapes = humanoidHitboxes({ x: 0, y: 0, z: 0 }, PLAYER.proneEyeHeight, 0);
    const legs = shapes.find((s) => s.zone === 'legs')!;
    expect(legs.b.z).toBeGreaterThan(1.4); // facing -Z: the body lies toward +Z
    expect(Math.max(...shapes.map((s) => s.a.y + s.r))).toBeLessThan(0.5);
    const turned = humanoidHitboxes({ x: 0, y: 0, z: 0 }, PLAYER.proneEyeHeight, Math.PI / 2);
    expect(turned.find((s) => s.zone === 'legs')!.b.x).toBeGreaterThan(1.4);
  });

  it('steadies hip fire', () => {
    const w = createPlayerState({ x: 0, y: 0, z: 0 }).guns.rifle;
    const ctx = {
      sprinting: false,
      crouched: false,
      grounded: true,
      speed: 0,
      walkSpeed: 4.6,
      ownerSeed: 1,
    };
    expect(currentSpread(w, { ...ctx, prone: true })).toBeLessThan(
      currentSpread(w, { ...ctx, crouched: true }),
    );
  });
});
