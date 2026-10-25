/**
 * What a player's hands are visibly doing (reloading, throwing, a knife strike, guarding, stunned),
 * derived from the authoritative sim state, so everyone else can draw it: remote players and bots
 * from their snapshot entry (`SnapshotPlayer.ac`, one small integer), the offline sparring partner
 * and practice dummies from their local state. Presentation input only: nothing here feeds back
 * into the sim.
 */
import { GRENADE, KNIFE, KNIFE_DEFENSE } from '../config/tunables.ts';
import { isGun, isSwitching, KNIFE_COMBO } from './arsenal.ts';
import type { PlayerState } from './player.ts';

/** Action kinds on the wire (append-only: the index is the code). */
export const ACTION_KINDS = ['none', 'reload', 'throw', 'strike', 'guard', 'stun'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface PlayerAction {
  kind: ActionKind;
  /**
   * Variant: reload 0 primary / 1 sidearm; throw 0 frag / 1 smoke; strike 0 slash / 1 backhand /
   * 2 thrust (`KNIFE_COMBO` order). 0 otherwise.
   */
  v: number;
  /**
   * Progress 0–1. Throw and strike are split at `ACTION_RELEASE`: the wind-up (pin + arm back;
   * the chamber) fills [0, 0.5), the release/impact is at 0.5 and the recovery fills [0.5, 1], so
   * the animation hits the release when the sim does, whatever the wind-up length (opening
   * strike, follow-up, counter). Guard: how far it is raised (fully up after the parry window).
   */
  t: number;
}

/** Where a split action (throw, strike) releases, in `PlayerAction.t`. */
export const ACTION_RELEASE = 0.5;

export const NO_ACTION: PlayerAction = { kind: 'none', v: 0, t: 0 };

/** Progress steps on the wire (6 bits): ±0.8 % — far finer than a 30 Hz snapshot's step. */
const STEPS = 63;

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : Number.isFinite(x) ? x : 0);

/** Split progress: `phase` 'windup' over [0, 0.5), 'recover' over [0.5, 1]. */
const split = (phase: 'windup' | 'recover', timer: number, total: number): number => {
  const done = total > 0 ? clamp01(1 - timer / total) : 1;
  return phase === 'windup' ? done * ACTION_RELEASE : ACTION_RELEASE + done * (1 - ACTION_RELEASE);
};

/**
 * The action a player is visibly performing. Priority: stunned (arms thrown out) > strike >
 * throw > guard > reload (when the sim overlaps two, the busier hands are what shows). The dead
 * do nothing.
 */
export function playerAction(p: PlayerState): PlayerAction {
  if (p.health <= 0) return NO_ACTION;
  const a = p.arsenal;
  if (a.stun > 0) {
    return { kind: 'stun', v: 0, t: clamp01(1 - a.stun / KNIFE_DEFENSE.parryStun) };
  }
  const m = a.melee;
  if (m.phase !== 'idle') {
    const recovery = KNIFE.recovery + (m.quick ? KNIFE.quickMeleeExtra : 0);
    const total = m.phase === 'windup' ? m.windupTotal : recovery;
    return {
      kind: 'strike',
      v: Math.max(0, KNIFE_COMBO.indexOf(m.move)),
      t: split(m.phase, m.timer, total),
    };
  }
  if (a.throwPhase !== 'idle') {
    const total = a.throwPhase === 'windup' ? GRENADE.windup : GRENADE.recovery;
    return {
      kind: 'throw',
      v: a.throwKind === 'smoke' ? 1 : 0,
      t: split(a.throwPhase, a.throwTimer, total),
    };
  }
  if (a.guard.held) {
    return { kind: 'guard', v: 0, t: clamp01(a.guard.heldFor / KNIFE_DEFENSE.parryWindow) };
  }
  if (isGun(a.slot) && !isSwitching(a)) {
    const w = p.guns[a.slot];
    if (w.reloadTimer > 0 && w.reloadDuration > 0) {
      return {
        kind: 'reload',
        v: a.slot === 'sidearm' ? 1 : 0,
        t: clamp01(1 - w.reloadTimer / w.reloadDuration),
      };
    }
  }
  return NO_ACTION;
}

/** Pack an action into one small integer (0 = none): kind (3 bits), variant (2), progress (6). */
export function encodeAction(a: PlayerAction): number {
  const kind = ACTION_KINDS.indexOf(a.kind);
  if (kind <= 0) return 0;
  const v = Math.min(3, Math.max(0, Math.round(a.v)));
  return kind | (v << 3) | (Math.round(clamp01(a.t) * STEPS) << 5);
}

/**
 * Unpack `encodeAction`. Tolerant: a missing, fractional, negative or out-of-range code (or a
 * kind a newer server appended) decodes as no action.
 */
export function decodeAction(code: unknown): PlayerAction {
  if (typeof code !== 'number' || !Number.isInteger(code) || code <= 0 || code >= 1 << 11) {
    return NO_ACTION;
  }
  const kind = ACTION_KINDS[code & 7];
  if (!kind || kind === 'none') return NO_ACTION;
  return { kind, v: (code >> 3) & 3, t: (code >> 5) / STEPS };
}

/** Blend two samples of the same action (render interpolation); otherwise the nearer one. */
export function lerpAction(a: PlayerAction, b: PlayerAction, k: number): PlayerAction {
  if (a.kind === b.kind && a.v === b.v && b.t >= a.t) return { ...a, t: a.t + (b.t - a.t) * k };
  return k < 0.5 ? a : b;
}

/**
 * The flinch a health change calls for: 0 none, 1 a hit, 2 a heavy hit (≥ `heavy` damage, e.g.
 * a headshot or a blast). From the authoritative health alone (the snapshot's `hp`, a dummy's or
 * the partner's local health), so every viewer flinches the same body on the same hit.
 */
export function hurtFlinch(prevHp: number, hp: number, heavy = 40): 0 | 1 | 2 {
  if (!(hp < prevHp) || hp <= 0) return 0;
  return prevHp - hp >= heavy ? 2 : 1;
}
