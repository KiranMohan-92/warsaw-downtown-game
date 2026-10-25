import { describe, expect, it } from 'vitest';
import { GRENADE, KNIFE, KNIFE_DEFENSE, RIFLE, SIDEARM, SIM } from '../config/tunables.ts';
import {
  ACTION_RELEASE,
  decodeAction,
  encodeAction,
  hurtFlinch,
  lerpAction,
  NO_ACTION,
  playerAction,
  type PlayerAction,
} from './action.ts';
import { Button, emptyInput, type PlayerInput } from './input.ts';
import { createPlayerState, stepPlayer, type PlayerEvent, type PlayerState } from './player.ts';
import { FlatGroundBody } from './testUtils.ts';

const DT = 1 / SIM.tickHz;

/** Step a player through the real sim, one tick per input; the actions seen after each. */
function run(
  p: PlayerState,
  inputs: Partial<PlayerInput>[],
): { a: PlayerAction; ev: PlayerEvent[] }[] {
  const body = new FlatGroundBody();
  return inputs.map((extra, i) => {
    const ev = stepPlayer(p, { ...emptyInput(i), ...extra }, DT, body);
    return { a: playerAction(p), ev };
  });
}

const ticks = (s: number): number => Math.round(s / DT);
const hold = (n: number, input: Partial<PlayerInput> = {}): Partial<PlayerInput>[] =>
  Array.from({ length: n }, () => input);

describe('player action (what others see the hands doing)', () => {
  it('a reload runs 0 → 1 over the sim reload and ends when it does', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    p.guns.rifle.ammo = 3;
    const seen = run(p, [{ buttons: Button.Reload }, ...hold(ticks(RIFLE.reloadTime) + 2)]);
    const reloads = seen.filter((s) => s.a.kind === 'reload');
    // Within a tick of the real reload time, rising, primary variant.
    expect(Math.abs(reloads.length - ticks(RIFLE.reloadTime))).toBeLessThanOrEqual(1);
    expect(reloads[0]!.a.t).toBeLessThan(0.05);
    expect(reloads.at(-1)!.a.t).toBeGreaterThan(0.95);
    expect(reloads.every((s, i) => i === 0 || s.a.t >= reloads[i - 1]!.a.t)).toBe(true);
    expect(reloads.every((s) => s.a.v === 0)).toBe(true);
    expect(seen.at(-1)!.a).toEqual(NO_ACTION);
  });

  it('a sidearm reload is variant 1', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    p.arsenal.slot = p.arsenal.target = 'sidearm';
    p.guns.sidearm.ammo = 1;
    const seen = run(p, [{ buttons: Button.Reload }, ...hold(ticks(SIDEARM.reloadTime / 2))]);
    expect(seen.at(-1)!.a).toMatchObject({ kind: 'reload', v: 1 });
  });

  it('a throw reaches the release mark on the tick the grenade leaves the hand', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    const total = ticks(GRENADE.windup + GRENADE.recovery) + 3;
    const seen = run(p, [{ buttons: Button.Grenade }, ...hold(total)]);
    const release = seen.findIndex((s) => s.ev.some((e) => e.type === 'grenadeThrow'));
    expect(release).toBeGreaterThan(0);
    const before = seen[release - 1]!.a;
    expect(before.kind).toBe('throw');
    expect(before.t).toBeLessThan(ACTION_RELEASE);
    expect(before.t).toBeGreaterThan(ACTION_RELEASE * 0.85);
    expect(seen[release]!.a.t).toBeGreaterThanOrEqual(ACTION_RELEASE);
    expect(seen.at(-1)!.a).toEqual(NO_ACTION);
  });

  it('a knife strike hits the impact mark when the sim strikes, whatever the wind-up', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    p.arsenal.slot = p.arsenal.target = 'knife';
    const n = ticks(KNIFE.openingWindup + KNIFE.recovery) + 2;
    const seen = run(p, [{ buttons: Button.Fire }, ...hold(n)]);
    const strike = seen.findIndex((s) => s.ev.some((e) => e.type === 'melee'));
    expect(seen[strike - 1]!.a).toMatchObject({ kind: 'strike', v: 0 }); // opening slash
    expect(seen[strike - 1]!.a.t).toBeLessThan(ACTION_RELEASE);
    expect(seen[strike]!.a.t).toBeGreaterThanOrEqual(ACTION_RELEASE);
    // The follow-up (backhand) has a 0.07 s wind-up: still split at the same mark.
    const q = createPlayerState({ x: 0, y: 0, z: 0 });
    q.arsenal.slot = q.arsenal.target = 'knife';
    q.arsenal.melee.phase = 'windup';
    q.arsenal.melee.move = 'backhand';
    q.arsenal.melee.windupTotal = KNIFE.windup;
    q.arsenal.melee.timer = KNIFE.windup / 2;
    expect(playerAction(q)).toMatchObject({ kind: 'strike', v: 1 });
    expect(playerAction(q).t).toBeCloseTo(ACTION_RELEASE / 2, 5);
  });

  it('guard rises over the parry window; stun outranks everything; the dead do nothing', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    const seen = run(p, hold(ticks(KNIFE_DEFENSE.parryWindow * 2), { buttons: Button.Block }));
    expect(seen[0]!.a.kind).toBe('guard');
    expect(seen[0]!.a.t).toBeLessThan(0.2);
    expect(seen.at(-1)!.a).toEqual({ kind: 'guard', v: 0, t: 1 });
    p.arsenal.stun = KNIFE_DEFENSE.parryStun / 2;
    expect(playerAction(p)).toMatchObject({ kind: 'stun', t: 0.5 });
    p.health = 0;
    expect(playerAction(p)).toEqual(NO_ACTION);
  });
});

describe('action wire code', () => {
  it('round-trips kind and variant exactly and progress within 1/63', () => {
    for (const kind of ['reload', 'throw', 'strike', 'guard', 'stun'] as const) {
      for (const v of [0, 1, 2]) {
        for (const t of [0, 0.123, ACTION_RELEASE, 0.77, 1]) {
          const code = encodeAction({ kind, v, t });
          expect(code).toBeGreaterThan(0);
          expect(code).toBeLessThan(1 << 11); // small integer: 1–2 msgpack bytes
          const back = decodeAction(code);
          expect(back.kind).toBe(kind);
          expect(back.v).toBe(v);
          expect(Math.abs(back.t - t)).toBeLessThanOrEqual(0.5 / 63 + 1e-9);
        }
      }
    }
    expect(decodeAction(encodeAction({ kind: 'throw', v: 0, t: ACTION_RELEASE })).t).toBeCloseTo(
      32 / 63,
    );
    expect(encodeAction(NO_ACTION)).toBe(0);
  });

  it('decodes junk (missing, fractional, negative, too big, unknown kind) as no action', () => {
    for (const junk of [undefined, null, 'x', 1.5, -3, 1 << 11, 7, 6, Number.NaN]) {
      expect(decodeAction(junk)).toEqual(NO_ACTION);
    }
  });

  it('blends the same action by progress, else takes the nearer sample', () => {
    const a = { kind: 'reload', v: 0, t: 0.2 } as const;
    const b = { kind: 'reload', v: 0, t: 0.4 } as const;
    expect(lerpAction(a, b, 0.5).t).toBeCloseTo(0.3);
    const next = { kind: 'strike', v: 0, t: 0.1 } as const;
    expect(lerpAction(a, next, 0.4)).toEqual(a);
    expect(lerpAction(a, next, 0.6)).toEqual(next);
    // A new action of the same kind (progress went back): no blending across it.
    expect(lerpAction(b, a, 0.6)).toEqual(a);
  });
});

describe('hurt flinch', () => {
  it('flinches on a health drop, harder on a heavy hit; never on heals or a kill', () => {
    expect(hurtFlinch(100, 80)).toBe(1);
    expect(hurtFlinch(100, 40)).toBe(2);
    expect(hurtFlinch(50, 100)).toBe(0);
    expect(hurtFlinch(100, 100)).toBe(0);
    expect(hurtFlinch(30, 0)).toBe(0);
  });
});
