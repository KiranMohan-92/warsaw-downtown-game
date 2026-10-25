import { describe, expect, it } from 'vitest';
import { GRENADE, KNIFE, RIFLE, SIDEARM, SIM_DT } from '../config/tunables.ts';
import { Button } from './input.ts';
import { createPlayerState, heldGun, type PlayerEvent } from './player.ts';
import { FlatGroundBody, run } from './testUtils.ts';

const fresh = (mode: 'standard' | 'knife' = 'standard') => {
  const p = createPlayerState({ x: 0, y: 0, z: 0 }, 1, mode);
  const body = new FlatGroundBody();
  run(p, body, 0.1, {});
  return { p, body };
};
const count = (ev: PlayerEvent[], type: PlayerEvent['type']): number =>
  ev.filter((e) => e.type === type).length;
/** Press `b` on the first step only. */
const tap = (b: number) => (i: number) => ({ buttons: i === 0 ? b : 0 });

describe('weapon switching', () => {
  it('starts with the rifle; 2 raises the sidearm after its equip time', () => {
    const { p, body } = fresh();
    expect(p.arsenal.slot).toBe('rifle');
    run(p, body, SIDEARM.equipTime - 0.05, tap(Button.Slot2));
    expect(p.arsenal.slot).toBe('rifle'); // still raising
    run(p, body, 0.1, {});
    expect(p.arsenal.slot).toBe('sidearm');
    expect(heldGun(p)).toBe(p.guns.sidearm);
  });

  it('cannot fire while switching', () => {
    const { p, body } = fresh();
    const ev = run(p, body, SIDEARM.equipTime - 0.05, (i) => ({
      buttons: i === 0 ? Button.Slot2 : Button.Fire,
    }));
    expect(count(ev, 'shot')).toBe(0);
  });

  it('switching away cancels a reload', () => {
    const { p, body } = fresh();
    run(p, body, 0.3, { buttons: Button.Fire });
    run(p, body, SIM_DT, {});
    run(p, body, SIM_DT, { buttons: Button.Reload });
    expect(p.guns.rifle.reloadTimer).toBeGreaterThan(0);
    run(p, body, 0.5, tap(Button.Slot2));
    expect(p.guns.rifle.reloadTimer).toBe(0);
    expect(p.guns.rifle.ammo).toBeLessThan(RIFLE.magazineSize);
  });

  it('mouse wheel cycles rifle → sidearm → knife → rifle', () => {
    const { p, body } = fresh();
    const seen: string[] = [];
    for (let k = 0; k < 3; k++) {
      run(p, body, 0.6, tap(Button.NextWeapon));
      seen.push(p.arsenal.slot);
    }
    expect(seen).toEqual(['sidearm', 'knife', 'rifle']);
  });
});

describe('sidearm (semi-auto)', () => {
  const pistol = () => {
    const f = fresh();
    run(f.p, f.body, 0.6, tap(Button.Slot2));
    return f;
  };

  it('holding the trigger fires exactly once', () => {
    const { p, body } = pistol();
    expect(count(run(p, body, 1, { buttons: Button.Fire }), 'shot')).toBe(1);
  });

  it('each tap fires, capped by the trigger rate', () => {
    const { p, body } = pistol();
    // Tap every 4 steps (15 taps/s) for 1 s; cap is 420 RPM = 7/s.
    const ev = run(p, body, 1, (i) => ({ buttons: i % 4 === 0 ? Button.Fire : 0 }));
    const shots = count(ev, 'shot');
    expect(shots).toBeGreaterThanOrEqual(6);
    expect(shots).toBeLessThanOrEqual(8);
  });
});

describe('knife', () => {
  it('Q quick-melee from the rifle swings once and returns to the rifle', () => {
    const { p, body } = fresh();
    const ev = run(p, body, KNIFE.openingWindup + 0.05, tap(Button.Melee));
    expect(ev.find((e) => e.type === 'melee')).toMatchObject({ type: 'melee', quick: true });
    expect(p.arsenal.slot).toBe('rifle');
    // Can't shoot during recovery…
    expect(count(run(p, body, KNIFE.recovery * 0.8, { buttons: Button.Fire }), 'shot')).toBe(0);
    // …then the rifle is back.
    run(p, body, KNIFE.recovery + KNIFE.quickMeleeExtra, {});
    expect(count(run(p, body, 0.2, { buttons: Button.Fire }), 'shot')).toBeGreaterThan(0);
  });

  it('knife in hand: holding fire keeps slashing at the swing cadence', () => {
    const { p, body } = fresh();
    run(p, body, 0.5, tap(Button.Slot3));
    expect(p.arsenal.slot).toBe('knife');
    const swings = count(run(p, body, 2, { buttons: Button.Fire }), 'melee');
    const expected = 2 / (KNIFE.windup + KNIFE.recovery);
    expect(swings).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
    expect(swings).toBeLessThanOrEqual(Math.ceil(expected));
  });

  it('knife-only mode: only the knife, slot keys do nothing, no grenade', () => {
    const { p, body } = fresh('knife');
    expect(p.arsenal.slot).toBe('knife');
    expect(p.arsenal.grenades).toBe(0);
    run(p, body, 0.6, tap(Button.Slot1));
    run(p, body, 0.6, tap(Button.NextWeapon));
    expect(p.arsenal.slot).toBe('knife');
    expect(count(run(p, body, 0.6, tap(Button.Grenade)), 'grenadeThrow')).toBe(0);
  });

  it('holding the knife is slightly faster than a rifle', () => {
    const rifle = fresh();
    run(rifle.p, rifle.body, 1.5, { moveZ: 1 });
    const knife = fresh('knife');
    run(knife.p, knife.body, 1.5, { moveZ: 1 });
    expect(Math.hypot(knife.p.move.vel.x, knife.p.move.vel.z)).toBeGreaterThan(
      Math.hypot(rifle.p.move.vel.x, rifle.p.move.vel.z),
    );
  });
});

describe('frag grenade', () => {
  it('one per life: releases after the wind-up, a second press does nothing', () => {
    const { p, body } = fresh();
    const first = run(p, body, GRENADE.windup + 0.05, tap(Button.Grenade));
    expect(count(first, 'grenadeThrow')).toBe(1);
    run(p, body, 1, {});
    expect(count(run(p, body, 1, tap(Button.Grenade)), 'grenadeThrow')).toBe(0);
    expect(p.arsenal.grenades).toBe(0);
  });

  it('cannot shoot while throwing', () => {
    const { p, body } = fresh();
    const ev = run(p, body, GRENADE.windup, (i) => ({
      buttons: i === 0 ? Button.Grenade : Button.Fire,
    }));
    expect(count(ev, 'shot')).toBe(0);
  });
});

describe('knife combo (Krav Maga style)', () => {
  const strikes = (ev: PlayerEvent[]): string[] =>
    ev.flatMap((e) => (e.type === 'melee' ? [e.move] : []));

  it('chains slash → backhand → thrust, then starts over', () => {
    const { p, body } = fresh('knife');
    const ev = run(p, body, 1.6, { buttons: Button.Fire });
    expect(strikes(ev).slice(0, 4)).toEqual(['slash', 'backhand', 'thrust', 'slash']);
  });

  it('a pause longer than the reset window restarts the combo', () => {
    const { p, body } = fresh('knife');
    run(p, body, KNIFE.openingWindup + 0.05, tap(Button.Fire));
    run(p, body, KNIFE.recovery + KNIFE.comboResetTime + 0.1, {});
    const ev = run(p, body, KNIFE.openingWindup + 0.05, tap(Button.Fire));
    expect(strikes(ev)).toEqual(['slash']);
  });

  it('each strike lunges you forward', () => {
    const { p, body } = fresh('knife');
    const z0 = p.move.pos.z;
    run(p, body, 0.35, tap(Button.Fire));
    expect(z0 - p.move.pos.z).toBeGreaterThan(0.3); // yaw 0 = -Z
  });
});

describe('knife lunge regressions (Codex review)', () => {
  it('slashing in mid-air never stacks lunge speed beyond sprint speed', () => {
    const { p, body } = fresh('knife');
    let peak = 0;
    run(
      p,
      body,
      1.2,
      (i) => ({ buttons: (i === 0 ? Button.Jump : 0) | (i > 2 ? Button.Fire : 0) }),
      () => {
        if (!p.move.grounded) peak = Math.max(peak, Math.hypot(p.move.vel.x, p.move.vel.z));
      },
    );
    expect(peak).toBeLessThanOrEqual(7);
  });
});
