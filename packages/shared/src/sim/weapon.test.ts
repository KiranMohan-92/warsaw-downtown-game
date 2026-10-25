import { describe, expect, it } from 'vitest';
import { RIFLE, SIM_DT } from '../config/tunables.ts';
import { Button, emptyInput } from './input.ts';
import {
  createWeaponState,
  currentSpread,
  stepWeapon,
  type WeaponContext,
  type WeaponEvent,
} from './weapon.ts';

const ctx: WeaponContext = {
  sprinting: false,
  crouched: false,
  grounded: true,
  speed: 0,
  walkSpeed: 4.6,
  ownerSeed: 7,
};

function hold(
  w: ReturnType<typeof createWeaponState>,
  seconds: number,
  buttons: number,
  dt = SIM_DT,
  c: WeaponContext = ctx,
): WeaponEvent[] {
  const out: WeaponEvent[] = [];
  let prev = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    out.push(...stepWeapon(w, { ...emptyInput(i), buttons }, prev, dt, c));
    prev = buttons;
  }
  return out;
}

const shots = (ev: WeaponEvent[]): number => ev.filter((e) => e.type === 'shot').length;

describe('weapon', () => {
  it('fires at the tuned RPM regardless of step size', () => {
    const perSecond = RIFLE.roundsPerMinute / 60;
    for (const dt of [1 / 60, 1 / 30, 1 / 144, 0.013]) {
      const w = createWeaponState();
      const n = shots(hold(w, 1.0, Button.Fire, dt));
      expect(Math.abs(n - perSecond)).toBeLessThanOrEqual(1);
    }
  });

  it('fires on the first tick of a press', () => {
    const w = createWeaponState();
    expect(shots(hold(w, SIM_DT, Button.Fire))).toBe(1);
  });

  it('empties the magazine and auto-reloads', () => {
    const w = createWeaponState();
    const ev = hold(w, 3.0, Button.Fire);
    expect(shots(ev)).toBe(RIFLE.magazineSize);
    expect(ev.some((e) => e.type === 'reloadStart' && e.empty)).toBe(true);
  });

  it('reload takes the tuned time and moves ammo from reserve', () => {
    const w = createWeaponState();
    hold(w, 0.5, Button.Fire); // fire a few
    const fired = RIFLE.magazineSize - w.ammo;
    hold(w, 0.3, 0);
    const ev = hold(w, SIM_DT, Button.Reload);
    expect(ev[0]).toMatchObject({ type: 'reloadStart', duration: RIFLE.reloadTime, empty: false });
    hold(w, RIFLE.reloadTime - 0.1, 0);
    expect(w.ammo).toBe(RIFLE.magazineSize - fired); // not yet
    hold(w, 0.15, 0);
    expect(w.ammo).toBe(RIFLE.magazineSize);
    expect(w.reserve).toBe(RIFLE.reserveAmmo - fired);
  });

  it('cannot fire while reloading', () => {
    const w = createWeaponState();
    hold(w, 0.2, Button.Fire);
    hold(w, SIM_DT, Button.Reload);
    expect(shots(hold(w, 1.0, Button.Fire))).toBe(0);
  });

  it('does not reload a full magazine', () => {
    const w = createWeaponState();
    expect(hold(w, SIM_DT, Button.Reload)).toEqual([]);
  });

  it('needs a sprint-out delay before firing', () => {
    const w = createWeaponState();
    hold(w, 0.5, 0, SIM_DT, { ...ctx, sprinting: true });
    const ev = hold(w, RIFLE.sprintToFireTime - 0.05, Button.Fire);
    expect(shots(ev)).toBe(0);
    expect(shots(hold(w, 0.1, Button.Fire))).toBeGreaterThan(0);
  });

  it('recoil follows the pattern (climbs up) and recovers to zero', () => {
    const w = createWeaponState();
    hold(w, 0.5, Button.Fire);
    expect(w.recoilPitch).toBeGreaterThan(3);
    hold(w, 2, 0);
    expect(w.recoilPitch).toBe(0);
    expect(w.recoilYaw).toBe(0);
  });

  it('recoil pattern is deterministic for the same seed', () => {
    const a = createWeaponState();
    const b = createWeaponState();
    hold(a, 1, Button.Fire);
    hold(b, 1, Button.Fire);
    expect(a.recoilYaw).toBe(b.recoilYaw);
    expect(a.recoilPitch).toBe(b.recoilPitch);
  });

  it('bloom grows with sustained fire and recovers', () => {
    const w = createWeaponState();
    const base = currentSpread(w, ctx);
    hold(w, 0.5, Button.Fire);
    expect(currentSpread(w, ctx)).toBeGreaterThan(base + 1);
    hold(w, 2, 0);
    expect(currentSpread(w, ctx)).toBeCloseTo(base, 6);
  });

  it('ADS tightens spread; moving and jumping widen it', () => {
    const w = createWeaponState();
    const hip = currentSpread(w, ctx);
    expect(currentSpread(w, { ...ctx, speed: 4.6 })).toBeGreaterThan(hip);
    expect(currentSpread(w, { ...ctx, grounded: false })).toBeGreaterThan(hip);
    hold(w, 0.5, Button.Ads);
    expect(w.adsAmount).toBe(1);
    expect(currentSpread(w, ctx)).toBeCloseTo(RIFLE.spread.ads, 6);
  });
});
