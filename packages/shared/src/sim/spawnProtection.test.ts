import { describe, expect, it } from 'vitest';
import { SIM_DT, SPAWN_PROTECTION } from '../config/tunables.ts';
import { Button } from './input.ts';
import { clonePlayerState, createPlayerState, type PlayerEvent } from './player.ts';
import {
  endsSpawnProtection,
  grantSpawnProtection,
  isSpawnProtected,
  stepSpawnProtection,
} from './spawnProtection.ts';
import { FlatGroundBody, run } from './testUtils.ts';

/** A player a moment after spawning (weapon raised), protection granted as every spawn does. */
const spawned = (mode: 'standard' | 'knife' = 'standard') => {
  const p = createPlayerState({ x: 0, y: 0, z: 0 }, 1, mode);
  const body = new FlatGroundBody();
  grantSpawnProtection(p);
  return { p, body };
};
const steps = (seconds: number): number => Math.round(seconds / SIM_DT);

describe('spawn protection', () => {
  it('is off for a fresh state until granted (tests and dummies start vulnerable)', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    expect(p.spawnGuard).toBe(0);
    expect(isSpawnProtected(p)).toBe(false);
    grantSpawnProtection(p);
    expect(p.spawnGuard).toBe(SPAWN_PROTECTION.duration);
    expect(isSpawnProtected(p)).toBe(true);
    expect(clonePlayerState(p).spawnGuard).toBe(SPAWN_PROTECTION.duration);
    grantSpawnProtection(p, 0); // off (match configs, tests)
    expect(isSpawnProtected(p)).toBe(false);
  });

  it(`expires after exactly ${SPAWN_PROTECTION.duration} s of steps`, () => {
    const { p, body } = spawned();
    run(p, body, SPAWN_PROTECTION.duration - SIM_DT, {});
    expect(isSpawnProtected(p)).toBe(true);
    expect(p.spawnGuard).toBeCloseTo(SIM_DT, 9);
    run(p, body, SIM_DT, {});
    expect(p.spawnGuard).toBe(0);
    expect(isSpawnProtected(p)).toBe(false);
  });

  it('ends the step a shot leaves the gun', () => {
    const { p, body } = spawned();
    run(p, body, 0.3, {});
    const ev = run(p, body, SIM_DT, { buttons: Button.Fire });
    expect(ev.some((e) => e.type === 'shot')).toBe(true);
    expect(p.spawnGuard).toBe(0);
  });

  it('ends when a knife swing starts (the chamber), from the knife in hand or a quick knife', () => {
    const inHand = spawned('knife');
    run(inHand.p, inHand.body, 0.3, {});
    expect(isSpawnProtected(inHand.p)).toBe(true);
    const ev = run(inHand.p, inHand.body, SIM_DT, { buttons: Button.Fire });
    expect(ev.some((e) => e.type === 'meleeStart')).toBe(true);
    expect(ev.some((e) => e.type === 'melee')).toBe(false); // ended before the cut lands
    expect(inHand.p.spawnGuard).toBe(0);

    const quick = spawned();
    run(quick.p, quick.body, 0.3, {});
    run(quick.p, quick.body, SIM_DT, { buttons: Button.Melee });
    expect(quick.p.spawnGuard).toBe(0);
  });

  it('ends when a throw winds up (frag or smoke)', () => {
    for (const button of [Button.Grenade, Button.Smoke]) {
      const { p, body } = spawned();
      run(p, body, 0.3, {});
      const ev = run(p, body, SIM_DT, { buttons: button });
      expect(ev.some((e) => e.type === 'grenadeWindup')).toBe(true);
      expect(p.spawnGuard).toBe(0);
    }
  });

  it('does not end on aiming, reloading, sprinting, switching, blocking or a dry trigger', () => {
    const { p, body } = spawned();
    run(p, body, 0.1, {});
    run(p, body, 0.2, { buttons: Button.Ads });
    p.guns.rifle.ammo = 5; // something to reload
    const reload = run(p, body, SIM_DT, { buttons: Button.Reload });
    expect(reload.some((e) => e.type === 'reloadStart')).toBe(true);
    run(p, body, 0.2, { moveZ: 1, buttons: Button.Sprint });
    expect(p.move.sprinting).toBe(true);
    run(p, body, 0.2, (i) => ({ buttons: i === 0 ? Button.Slot2 : 0 }));
    run(p, body, 0.1, { buttons: Button.Block });
    expect(isSpawnProtected(p)).toBe(true);
    expect(p.spawnGuard).toBeCloseTo(SPAWN_PROTECTION.duration - (steps(0.8) + 1) * SIM_DT, 9);

    // An empty gun's click is not an attack.
    const dry = spawned();
    run(dry.p, dry.body, 0.3, {});
    dry.p.guns.rifle.ammo = 0;
    dry.p.guns.rifle.reserve = 0;
    const ev = run(dry.p, dry.body, SIM_DT, { buttons: Button.Fire });
    expect(ev.some((e) => e.type === 'dryFire')).toBe(true);
    expect(isSpawnProtected(dry.p)).toBe(true);
  });

  it('grants nothing else: a protected player moves exactly like an unprotected one', () => {
    const a = spawned();
    const b = { p: createPlayerState({ x: 0, y: 0, z: 0 }), body: new FlatGroundBody() };
    const input = { moveZ: 1, buttons: Button.Sprint };
    run(a.p, a.body, 1, input);
    run(b.p, b.body, 1, input);
    expect(isSpawnProtected(a.p)).toBe(true);
    expect(a.p.move).toEqual(b.p.move);
  });

  it('the dead are never protected; the pure step reads only attack events', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    grantSpawnProtection(p);
    p.health = 0;
    expect(isSpawnProtected(p)).toBe(false);
    const q = createPlayerState({ x: 0, y: 0, z: 0 });
    grantSpawnProtection(q);
    const idle: PlayerEvent[] = [{ type: 'jump' }, { type: 'reloadEnd' }];
    stepSpawnProtection(q, idle, 0.5);
    expect(q.spawnGuard).toBeCloseTo(SPAWN_PROTECTION.duration - 0.5, 9);
    expect(endsSpawnProtection({ type: 'chargeStart', time: 0.25 })).toBe(false);
    stepSpawnProtection(q, [{ type: 'grenadeWindup', kind: 'smoke' }], 0);
    expect(q.spawnGuard).toBe(0);
  });
});
