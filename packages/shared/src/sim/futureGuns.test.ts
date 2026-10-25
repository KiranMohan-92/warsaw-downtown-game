import { beforeAll, describe, expect, it } from 'vitest';
import { COILGUN, ISKRA, PRIMARIES, SIM_DT } from '../config/tunables.ts';
import { boxMinMax } from '../maps/builder.ts';
import { FoliageIndex } from '../maps/concealment.ts';
import type { MapDefinition } from '../maps/types.ts';
import { LoadoutMessageOrNull, parseMatchOptions } from '../net/protocol.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { gunConfig } from './arsenal.ts';
import { humanoidHitboxes } from './hitbox.ts';
import { bendShot } from './hitscan.ts';
import { Button, emptyInput } from './input.ts';
import { createPlayerState } from './player.ts';
import { smokeAt, smokeLifetime, type SmokeCloud } from './smoke.ts';
import { createWeaponState, stepWeapon, type WeaponContext, type WeaponEvent } from './weapon.ts';

const ctx: WeaponContext = {
  sprinting: false,
  crouched: false,
  grounded: true,
  speed: 0,
  walkSpeed: 4.6,
  ownerSeed: 7,
};

/** Hold/press patterns: `buttons(i)` per step. */
function run(seconds: number, buttons: (step: number) => number): WeaponEvent[] {
  const w = createWeaponState(COILGUN);
  const out: WeaponEvent[] = [];
  let prev = 0;
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    const b = buttons(i);
    out.push(...stepWeapon(w, { ...emptyInput(i), buttons: b }, prev, SIM_DT, ctx, COILGUN));
    prev = b;
  }
  return out;
}
const shots = (e: WeaponEvent[]): number => e.filter((x) => x.type === 'shot').length;

describe('KS-9 Cewka coilgun', () => {
  it('fires only after holding the trigger for its charge time', () => {
    const charge = Math.round(COILGUN.chargeTime / SIM_DT);
    expect(shots(run((charge - 3) * SIM_DT, () => Button.Fire))).toBe(0);
    const e = run((charge + 3) * SIM_DT, () => Button.Fire);
    expect(shots(e)).toBe(1);
    expect(e.some((x) => x.type === 'chargeStart')).toBe(true);
  });

  it('a released charge does not fire, and one press fires one shot', () => {
    const charge = Math.round(COILGUN.chargeTime / SIM_DT);
    // Tap shorter than the charge, repeatedly: never fires.
    expect(shots(run(3, (i) => (i % (charge + 4) < charge - 4 ? Button.Fire : 0)))).toBe(0);
    // Hold for 3 s: exactly one shot (release to charge again).
    expect(shots(run(3, () => Button.Fire))).toBe(1);
  });

  it('reloading clears a charge in progress', () => {
    const w = createWeaponState(COILGUN);
    w.ammo = 2;
    let prev = 0;
    const step = (b: number): WeaponEvent[] => {
      const e = stepWeapon(w, { ...emptyInput(0), buttons: b }, prev, SIM_DT, ctx, COILGUN);
      prev = b;
      return e;
    };
    for (let i = 0; i < 8; i++) step(Button.Fire); // partly charged
    expect(w.charge).toBeGreaterThan(0);
    step(Button.Fire | Button.Reload);
    expect(w.charge).toBe(0);
  });

  it('an empty magazine (auto reload cancelled by a switch) dry-fires and reloads on Fire', () => {
    const w = createWeaponState(COILGUN);
    w.ammo = 0; // last round fired, then holstered mid-reload
    w.reserve = 6;
    const e = stepWeapon(w, { ...emptyInput(0), buttons: Button.Fire }, 0, SIM_DT, ctx, COILGUN);
    expect(e.some((x) => x.type === 'dryFire')).toBe(true);
    expect(e.some((x) => x.type === 'reloadStart')).toBe(true);
    expect(w.reloadTimer).toBeGreaterThan(0);
  });

  it('two headshots or three body shots kill', () => {
    expect(COILGUN.damage * COILGUN.headMultiplier).toBeLessThan(100);
    expect(2 * COILGUN.damage * COILGUN.headMultiplier).toBeGreaterThanOrEqual(100);
    expect(3 * COILGUN.damage).toBeGreaterThanOrEqual(100);
    expect(COILGUN.silent).toBe(true);
  });
});

describe('Iskra smart rounds', () => {
  let world: PhysicsWorld;
  beforeAll(async () => {
    await initPhysics();
    const map: MapDefinition = {
      name: 'bend',
      bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      boxes: [
        boxMinMax({ x: -40, y: -1, z: -40 }, { x: 40, y: 0, z: 40 }, 'ground'),
        boxMinMax({ x: 2, y: 0, z: -12 }, { x: 6, y: 3, z: -11 }, 'concrete'), // hides target B
      ],
      spawns: [],
      dummies: [],
    };
    world = new PhysicsWorld(map);
  });
  const eye = { x: 0, y: 1.6, z: 0 };
  const clear = { smoke: [] };
  const target = (id: string, x: number, z: number) => ({
    id,
    shapes: humanoidHitboxes({ x, y: 0, z }, 1.62),
  });
  const angle = (a: { x: number; y: number; z: number }, b: typeof a): number =>
    Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) * (180 / Math.PI);

  it('bends toward a visible target near the aim, by at most its limit', () => {
    const aim = { x: 0, y: 0, z: -1 };
    const bent = bendShot(
      eye,
      aim,
      150,
      world,
      [target('a', 0.6, -20)],
      ISKRA.homingConeDeg,
      ISKRA.homingMaxBendDeg,
      clear,
    );
    expect(angle(aim, bent)).toBeGreaterThan(0.5);
    expect(angle(aim, bent)).toBeLessThanOrEqual(ISKRA.homingMaxBendDeg + 1e-6);
  });

  it('never bends outside the cone, behind a wall, or for guns without smart rounds', () => {
    const aim = { x: 0, y: 0, z: -1 };
    const far = [target('wide', 8, -20)]; // ~22° off the aim
    expect(
      bendShot(eye, aim, 150, world, far, ISKRA.homingConeDeg, ISKRA.homingMaxBendDeg, clear),
    ).toBe(aim);
    const hidden = [target('b', 6.5, -20)];
    const toward = { x: 6.5 / Math.hypot(6.5, 20), y: 0, z: -20 / Math.hypot(6.5, 20) };
    expect(bendShot(eye, toward, 150, world, hidden, 20, 5, clear)).toBe(toward); // wall in the way
    expect(bendShot(eye, aim, 150, world, [target('a', 0.6, -20)], 0, 0, clear)).toBe(aim);
  });

  it('never bends onto someone concealed in smoke or foliage (the shared sight model)', () => {
    const aim = { x: 0, y: 0, z: -1 };
    const a = [target('a', 0.6, -20)];
    const bend = (sight: Parameters<typeof bendShot>[7]) =>
      bendShot(eye, aim, 150, world, a, ISKRA.homingConeDeg, ISKRA.homingMaxBendDeg, sight);
    // A bloomed cloud between shooter and target.
    expect(bend({ smoke: [{ id: 1, pos: { x: 0.3, y: 0, z: -10 }, age: 5 }] })).toBe(aim);
    // A dense bush right in front of them.
    const bush = new FoliageIndex([{ x: 0.6, z: -18.5, r: 1.2, h: 2.2, kind: 'bush' }]);
    expect(bend({ smoke: [], foliage: bush })).toBe(aim);
    expect(bend(clear)).not.toBe(aim);
  });

  it('judges smoke at the view time: a cloud popped after it does not block the bend', () => {
    const aim = { x: 0, y: 0, z: -1 };
    const a = [target('a', 0.6, -20)];
    const bend = (smoke: SmokeCloud[]) =>
      bendShot(eye, aim, 150, world, a, ISKRA.homingConeDeg, ISKRA.homingMaxBendDeg, { smoke });
    const pos = { x: 0.3, y: 0, z: -10 };
    // The list as of t = 1000 ms: one cloud 3 s old, one popped 50 ms ago.
    const old = { id: 1, pos, age: 3 };
    const fresh = { id: 2, pos, age: 0.05 };
    expect(bend([fresh])).toBe(aim); // judged on the live list, the fresh cloud would hide them
    // The shot was drawn at 900 ms: the fresh cloud wasn't there yet, the old one was.
    expect(smokeAt([fresh], 1000, 900)).toEqual([]);
    expect(bend(smokeAt([fresh], 1000, 900))).not.toBe(aim);
    expect(smokeAt([old], 1000, 900)).toEqual([{ id: 1, pos, age: 2.9 }]);
    expect(bend(smokeAt([old], 1000, 900))).toBe(aim);
    // The tick a cloud pops (listed at age one step) it isn't there a step earlier.
    expect(smokeAt([{ id: 3, pos, age: SIM_DT }], 1000, 1000 - 1000 * SIM_DT)).toEqual([]);
    // Later than the list: aged forward; and gone once past its lifetime, by age alone.
    expect(smokeAt([fresh], 1000, 1200)[0]!.age).toBeCloseTo(0.25, 12);
    const dying = { id: 4, pos, age: smokeLifetime() - 0.05 };
    expect(smokeAt([dying], 1000, 1040)).toHaveLength(1);
    expect(smokeAt([dying], 1000, 1060)).toEqual([]);
    // The reused output keeps its objects (no per-frame garbage).
    const out: SmokeCloud[] = [];
    const first = smokeAt([old], 1000, 900, out)[0];
    expect(smokeAt([old], 1000, 950, out)[0]).toBe(first);
    expect(first!.age).toBeCloseTo(2.95, 12);
  });
});

describe('loadout', () => {
  it('the primary slot holds the chosen gun, with its magazine', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 1, 'standard', 'coil');
    expect(gunConfig(p.arsenal, 'rifle')).toBe(PRIMARIES.coil);
    expect(p.guns.rifle.ammo).toBe(COILGUN.magazineSize);
    expect(gunConfig(p.arsenal, 'sidearm').name).toBe('P-9 pistol');
  });

  it('only known primaries pass validation', () => {
    expect(LoadoutMessageOrNull && typeof LoadoutMessageOrNull).toBeTruthy();
    expect(
      parseMatchOptions({ map: 'defilad', size: 'market', mode: 'standard', primary: 'iskra' })
        ?.primary,
    ).toBe('iskra');
    expect(
      parseMatchOptions({
        map: 'defilad',
        size: 'market',
        mode: 'standard',
        primary: 'railgun9000',
      }),
    ).toBeNull();
  });
});
