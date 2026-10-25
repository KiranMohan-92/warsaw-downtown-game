import { describe, expect, it } from 'vitest';
import { KNIFE, KNIFE_DEFENSE, SIM_DT } from '../config/tunables.ts';
import { Button } from './input.ts';
import { applyKnifeStrike, strikeOutcome } from './knifeDefense.ts';
import { createPlayerState, type PlayerState } from './player.ts';
import { FlatGroundBody, run } from './testUtils.ts';

/** Defender at the origin facing -Z (yaw 0); attacker 1.5 m in front, facing the defender. */
function duel(): { att: PlayerState; def: PlayerState; defBody: FlatGroundBody } {
  const att = createPlayerState({ x: 0, y: 0, z: -1.5 }, 1, 'knife');
  att.view = { yaw: Math.PI, pitch: 0 };
  const def = createPlayerState({ x: 0, y: 0, z: 0 }, 2, 'knife');
  const defBody = new FlatGroundBody();
  run(def, defBody, 0.1, {});
  return { att, def, defBody };
}
const guardFor = (def: PlayerState, body: FlatGroundBody, seconds: number): void => {
  run(def, body, seconds, { buttons: Button.Block });
};

describe('knife defense', () => {
  it('no guard: full hit', () => {
    const { att, def } = duel();
    expect(applyKnifeStrike(att, def, 'slash')).toEqual({ outcome: 'hit', damage: KNIFE.damage });
  });

  it('guard raised just before impact: parry — no damage, attacker stunned and shoved, counter granted', () => {
    const { att, def, defBody } = duel();
    guardFor(def, defBody, 0.1);
    const r = applyKnifeStrike(att, def, 'slash');
    expect(r).toEqual({ outcome: 'parried', damage: 0 });
    expect(att.arsenal.stun).toBeCloseTo(KNIFE_DEFENSE.parryStun, 6);
    expect(att.move.vel.z).toBeLessThan(-1); // pushed away (further -Z)
    expect(def.arsenal.counter).toBeGreaterThan(0);
  });

  it('thrusts have a tighter parry window than slashes', () => {
    const { att, def, defBody } = duel();
    guardFor(def, defBody, 0.2); // inside the slash window, outside the thrust window
    expect(strikeOutcome(att, def, 'slash')).toBe('parried');
    expect(strikeOutcome(att, def, 'thrust')).toBe('blocked');
  });

  it('guard held longer: blocked for reduced damage, breaks after the max blocks', () => {
    const { att, def, defBody } = duel();
    guardFor(def, defBody, 0.6);
    const outcomes = Array.from({ length: KNIFE_DEFENSE.guardMaxBlocks }, () =>
      applyKnifeStrike(att, def, 'slash'),
    );
    expect(outcomes[0]).toEqual({
      outcome: 'blocked',
      damage: Math.round(KNIFE.damage * KNIFE_DEFENSE.guardDamageMultiplier * 10) / 10,
    });
    expect(outcomes.at(-1)!.outcome).toBe('guardBroken');
    expect(def.arsenal.guard.held).toBe(false);
    expect(def.arsenal.stun).toBeGreaterThan(0);
    // Can't raise the guard again while it recovers.
    guardFor(def, defBody, SIM_DT * 3);
    expect(def.arsenal.guard.held).toBe(false);
  });

  it('strikes from behind cannot be defended', () => {
    const { att, def, defBody } = duel();
    def.move.pos = { x: 0, y: 0, z: 0 };
    att.move.pos = { x: 0, y: 0, z: 1.5 }; // behind the defender (defender faces -Z)
    guardFor(def, defBody, 0.1);
    expect(applyKnifeStrike(att, def, 'slash').outcome).toBe('hit');
  });

  it('a counter after a parry comes out fast and hits harder', () => {
    const { att, def, defBody } = duel();
    guardFor(def, defBody, 0.1);
    applyKnifeStrike(att, def, 'slash');
    // Release guard and strike immediately: counter wind-up.
    const ev = run(def, defBody, KNIFE.counterWindup + 0.05, (i) => ({
      buttons: i === 0 ? 0 : Button.Fire,
    }));
    expect(ev.some((e) => e.type === 'melee')).toBe(true);
    const bystander = createPlayerState({ x: 0, y: 0, z: -1 }, 3, 'knife');
    expect(applyKnifeStrike(def, bystander, 'slash').damage).toBe(
      KNIFE.damage + KNIFE_DEFENSE.counterBonusDamage,
    );
  });

  it('a stunned attacker cannot strike', () => {
    const { att } = duel();
    att.arsenal.stun = KNIFE_DEFENSE.parryStun;
    const body = new FlatGroundBody({ x: 0, y: 0, z: -1.5 });
    const ev = run(att, body, KNIFE_DEFENSE.parryStun * 0.8, { buttons: Button.Fire });
    expect(ev.some((e) => e.type === 'meleeStart')).toBe(false);
  });

  it('the opening strike chambers visibly; follow-ups are fast', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 1, 'knife');
    const body = new FlatGroundBody();
    run(p, body, 0.1, {});
    const starts: number[] = [];
    run(p, body, 1.2, { buttons: Button.Fire }, (ev) => {
      if (ev.some((e) => e.type === 'meleeStart')) starts.push(p.arsenal.melee.windupTotal);
    });
    expect(starts[0]).toBe(KNIFE.openingWindup);
    expect(starts[1]).toBe(KNIFE.windup);
  });
});

describe('knife defense regressions (Codex review)', () => {
  it('a counter is spent when the strike starts, even if it misses', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 1, 'knife');
    const body = new FlatGroundBody();
    run(p, body, 0.1, {});
    p.arsenal.counter = KNIFE_DEFENSE.counterWindow;
    run(p, body, SIM_DT, { buttons: Button.Fire });
    expect(p.arsenal.counter).toBe(0);
    expect(p.arsenal.melee.empowered).toBe(true);
    // The next strike is ordinary again.
    run(p, body, 0.6, {});
    run(p, body, SIM_DT * 2, { buttons: Button.Fire });
    expect(p.arsenal.melee.empowered).toBe(false);
  });

  it('cannot raise the guard in the middle of your own swing', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 1, 'knife');
    const body = new FlatGroundBody();
    run(p, body, 0.1, {});
    run(p, body, SIM_DT, { buttons: Button.Fire }); // start a 0.22 s opening wind-up
    run(p, body, SIM_DT * 3, { buttons: Button.Block });
    expect(p.arsenal.guard.held).toBe(false);
  });
});
