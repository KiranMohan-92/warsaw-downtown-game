import { describe, expect, it } from 'vitest';
import { ARC, MARKSMAN, PLAYER, SHOTGUN } from '../config/tunables.ts';
import { computeDamage } from './damage.ts';
import { pelletDirections } from './hitscan.ts';
import { Button, emptyInput } from './input.ts';
import { createWeaponState, stepWeapon, type WeaponEvent } from './weapon.ts';

const ctx = {
  sprinting: false,
  crouched: false,
  grounded: true,
  speed: 0,
  walkSpeed: 4.6,
  ownerSeed: 7,
};

function hold(
  w: ReturnType<typeof createWeaponState>,
  cfg: typeof ARC,
  seconds: number,
  fire = true,
) {
  const events: WeaponEvent[] = [];
  const input = { ...emptyInput(), buttons: fire ? Button.Fire : 0 };
  for (let n = Math.round(seconds * 60); n > 0; n--)
    events.push(...stepWeapon(w, input, input.buttons, 1 / 60, ctx, cfg));
  return events;
}

describe('ŁUK-3 arc rifle (heat)', () => {
  it('never spends ammo, overheats, locks the trigger, then cools', () => {
    const w = createWeaponState(ARC);
    const events = hold(w, ARC, 3);
    const shots = events.filter((e) => e.type === 'shot').length;
    expect(shots).toBe(Math.round(1 / ARC.heat!.perShot));
    expect(events.some((e) => e.type === 'overheat')).toBe(true);
    expect(w.ammo).toBe(ARC.magazineSize);
    expect(w.overheat).toBeGreaterThan(0);
    // Still locked a moment later, even holding the trigger.
    expect(hold(w, ARC, 0.3).filter((e) => e.type === 'shot')).toHaveLength(0);
    hold(w, ARC, ARC.heat!.lockout, false);
    expect(w.overheat).toBe(0);
    expect(hold(w, ARC, 0.2).some((e) => e.type === 'shot')).toBe(true);
  });

  it('cools between bursts so short bursts never overheat', () => {
    const w = createWeaponState(ARC);
    for (let b = 0; b < 8; b++) {
      hold(w, ARC, 0.5);
      hold(w, ARC, 1.2, false);
    }
    expect(w.overheat).toBe(0);
  });
});

describe('M-12 Grom shotgun (pellets)', () => {
  const shot = { yaw: 0.3, pitch: -0.1, spreadDeg: 0.8, seed: 12345, shotCounter: 0 };
  it('fires a deterministic fan of pellets', () => {
    const a = pelletDirections(shot, SHOTGUN.pellets, SHOTGUN.pelletSpreadDeg);
    const b = pelletDirections(shot, SHOTGUN.pellets, SHOTGUN.pelletSpreadDeg);
    expect(a).toHaveLength(SHOTGUN.pellets);
    expect(a).toEqual(b);
    expect(new Set(a.map((d) => d.x.toFixed(4))).size).toBe(SHOTGUN.pellets);
  });

  it('kills up close in one pull and barely scratches at range', () => {
    const close = SHOTGUN.pellets * computeDamage('torso', 4, SHOTGUN);
    expect(close).toBeGreaterThanOrEqual(PLAYER.maxHealth);
    expect(SHOTGUN.pellets * computeDamage('torso', 40, SHOTGUN)).toBeLessThan(40);
  });
});

describe('SR-8 Sokół marksman', () => {
  it('kills with a headshot, needs two to the body', () => {
    expect(computeDamage('head', 60, MARKSMAN)).toBeGreaterThanOrEqual(PLAYER.maxHealth);
    expect(computeDamage('torso', 20, MARKSMAN)).toBeLessThan(PLAYER.maxHealth);
    expect(2 * computeDamage('torso', 60, MARKSMAN)).toBeGreaterThanOrEqual(PLAYER.maxHealth);
  });
});
