import {
  GRENADE,
  JAMMER,
  KNIFE,
  PRIMARIES,
  SIDEARM,
  type PrimaryId,
  SMOKE,
  type MatchMode,
} from '../config/tunables.ts';
import { Button, isDown, pressed, type PlayerInput } from './input.ts';
import type { WeaponConfig } from './weapon.ts';

/**
 * Loadout and "what the hands are doing": weapon slots and switching, knife swings (from the knife
 * slot or the Q quick-melee), and the frag grenade throw. Plain data + fixed-step functions, so it
 * runs identically for client prediction, the server, and bots.
 */

export type Slot = 'rifle' | 'sidearm' | 'knife';
export type GunSlot = Exclude<Slot, 'knife'>;
/** The gun in a slot: the primary slot holds the loadout gun or the latest ground swap. */
export const gunConfig = (a: Pick<ArsenalState, 'primary'>, s: GunSlot): WeaponConfig =>
  s === 'rifle' ? PRIMARIES[a.primary] : SIDEARM;
export const isGun = (s: Slot): s is GunSlot => s !== 'knife';

export const SLOT_ORDER: readonly Slot[] = ['rifle', 'sidearm', 'knife'];
export const slotsFor = (mode: MatchMode): readonly Slot[] =>
  mode === 'knife' ? ['knife'] : SLOT_ORDER;

type Phase = 'idle' | 'windup' | 'recover';

/** Knife strikes chain in this order (Krav Maga-style combo). */
export type KnifeMove = 'slash' | 'backhand' | 'thrust';
export const KNIFE_COMBO: readonly KnifeMove[] = ['slash', 'backhand', 'thrust'];

export interface ArsenalState {
  mode: MatchMode;
  /** Current primary in the 'rifle' slot; drops can replace it until respawn restores the loadout. */
  primary: PrimaryId;
  /** Weapon currently in hand (after any switch completes). */
  slot: Slot;
  /** Weapon being raised; equals `slot` when not switching. */
  target: Slot;
  /** Seconds left raising `target`. */
  switchTimer: number;
  switchDuration: number;
  melee: {
    phase: Phase;
    timer: number;
    quick: boolean;
    swings: number;
    move: KnifeMove;
    /** Position in the combo chain. */
    combo: number;
    /** Seconds since the last strike landed (combo reset timer). */
    sinceStrike: number;
    /** Wind-up of the current strike (opening chamber vs fast follow-up vs counter). */
    windupTotal: number;
    /** This strike is a post-parry counter (bonus damage), spent hit or miss. */
    empowered: boolean;
  };
  /** Knife defense. */
  guard: {
    /** Guard is up this step. */
    held: boolean;
    /** Seconds since the guard went up (parry = small). */
    heldFor: number;
    /** Strikes absorbed since the guard went up. */
    blocks: number;
    /** Guard unavailable (recovering from a break) for this long. */
    brokenTimer: number;
  };
  /** Can't strike, shoot, throw or switch while > 0 (parried, or guard broken). */
  stun: number;
  /** After a parry: the next strike is a fast, harder counter while > 0. */
  counter: number;
  grenades: number;
  /** Smoke grenades and jammer charges (tactical equipment, per life). */
  smokes: number;
  jammers: number;
  /** What the current throw releases. */
  throwKind: ThrowKind;
  throwPhase: Phase;
  throwTimer: number;
}

export type ThrowKind = 'frag' | 'smoke';

export function createArsenal(
  mode: MatchMode = 'standard',
  primary: PrimaryId = 'ar7',
): ArsenalState {
  const slot: Slot = mode === 'knife' ? 'knife' : 'rifle';
  return {
    mode,
    primary,
    slot,
    target: slot,
    switchTimer: 0,
    switchDuration: 0,
    melee: {
      phase: 'idle',
      timer: 0,
      quick: false,
      swings: 0,
      move: 'slash',
      combo: 0,
      sinceStrike: 99,
      windupTotal: KNIFE.windup,
      empowered: false,
    },
    guard: { held: false, heldFor: 0, blocks: 0, brokenTimer: 0 },
    stun: 0,
    counter: 0,
    grenades: mode === 'knife' ? 0 : GRENADE.perLife,
    // Tactical kit isn't lethal, so knife-only matches keep it.
    smokes: SMOKE.perLife,
    jammers: JAMMER.perLife,
    throwKind: 'frag',
    throwPhase: 'idle',
    throwTimer: 0,
  };
}

export const cloneArsenal = (a: ArsenalState): ArsenalState => ({
  ...a,
  melee: { ...a.melee },
  guard: { ...a.guard },
});

export const isGuarding = (a: ArsenalState): boolean => a.guard.held;
export const isStunned = (a: ArsenalState): boolean => a.stun > 0;

export const equipTime = (a: Pick<ArsenalState, 'primary'>, s: Slot): number =>
  isGun(s) ? gunConfig(a, s).equipTime : KNIFE.equipTime;
export const isSwitching = (a: ArsenalState): boolean => a.switchTimer > 0;
export const isMeleeing = (a: ArsenalState): boolean => a.melee.phase !== 'idle';
export const isThrowing = (a: ArsenalState): boolean => a.throwPhase !== 'idle';

/**
 * Called each step in a seat that forbids them: a throw still winding up is put away (the frag
 * or smoke goes back in the pouch: it never left the hand) and a knife strike is dropped, so an
 * attack begun on foot can't go off from the driver's seat.
 */
export function cancelForSeat(a: ArsenalState, throws: boolean, melee: boolean): void {
  if (throws && a.throwPhase === 'windup') {
    if (a.throwKind === 'frag') a.grenades += 1;
    else a.smokes += 1;
    a.throwPhase = 'idle';
    a.throwTimer = 0;
  }
  if (melee && a.melee.phase !== 'idle') {
    a.melee.phase = 'idle';
    a.melee.timer = 0;
    a.melee.quick = false;
  }
}
/** The gun in hand may fire / aim / reload only when the hands are otherwise free. */
export const gunReady = (a: ArsenalState): boolean =>
  isGun(a.slot) &&
  !isSwitching(a) &&
  !isMeleeing(a) &&
  !isThrowing(a) &&
  !a.guard.held &&
  a.stun <= 0;

export type ArsenalEvent =
  | { type: 'switchStart'; from: Slot; to: Slot; duration: number }
  | { type: 'switchEnd'; slot: Slot }
  | { type: 'meleeStart'; quick: boolean; move: KnifeMove; yaw: number }
  /** The swing connects this step: resolve the hit along (yaw, pitch). */
  | {
      type: 'melee';
      yaw: number;
      pitch: number;
      quick: boolean;
      swing: number;
      move: KnifeMove;
    }
  | { type: 'grenadeWindup'; kind: ThrowKind }
  /** Jammer pulse triggered (instant, hands free). */
  | { type: 'jammer' }
  | { type: 'guardUp' }
  /** Release: spawn a grenade from the eye along (yaw, pitch). */
  | { type: 'grenadeThrow'; yaw: number; pitch: number; kind: ThrowKind };

function requestedSlot(a: ArsenalState, input: PlayerInput, prev: number): Slot | null {
  const slots = slotsFor(a.mode);
  const p = (b: number): boolean => pressed(input.buttons, prev, b);
  let want: Slot | null = null;
  if (p(Button.Slot1)) want = 'rifle';
  if (p(Button.Slot2)) want = 'sidearm';
  if (p(Button.Slot3)) want = 'knife';
  if (p(Button.NextWeapon) || p(Button.PrevWeapon)) {
    const i = slots.indexOf(a.target);
    const d = p(Button.NextWeapon) ? 1 : -1;
    want = slots[(i + d + slots.length) % slots.length] ?? null;
  }
  return want && slots.includes(want) && want !== a.target ? want : null;
}

/** Advance hands one step. `onSwitch` lets the caller reset per-gun transient state. */
export function stepArsenal(
  a: ArsenalState,
  input: PlayerInput,
  prevButtons: number,
  dt: number,
): ArsenalEvent[] {
  const events: ArsenalEvent[] = [];

  // Timers
  if (a.switchTimer > 0) {
    a.switchTimer = Math.max(0, a.switchTimer - dt);
    if (a.switchTimer === 0) {
      a.slot = a.target;
      events.push({ type: 'switchEnd', slot: a.slot });
    }
  }
  // Defense timers.
  a.stun = Math.max(0, a.stun - dt);
  a.counter = Math.max(0, a.counter - dt);
  a.guard.brokenTimer = Math.max(0, a.guard.brokenTimer - dt);
  const wantGuard =
    isDown(input.buttons, Button.Block) &&
    a.guard.brokenTimer <= 0 &&
    a.stun <= 0 &&
    !isThrowing(a) &&
    // No guarding mid-swing: you can't defend and land your own strike at the same time.
    a.melee.phase !== 'windup';
  if (wantGuard && !a.guard.held) {
    a.guard.held = true;
    a.guard.heldFor = 0;
    a.guard.blocks = 0;
    events.push({ type: 'guardUp' });
  } else if (wantGuard) {
    a.guard.heldFor += dt;
  } else {
    a.guard.held = false;
  }

  const m = a.melee;
  m.sinceStrike += dt;
  if (m.phase !== 'idle') {
    m.timer -= dt;
    if (m.phase === 'windup' && m.timer <= 0) {
      m.swings += 1;
      m.sinceStrike = 0;
      events.push({
        type: 'melee',
        yaw: input.yaw,
        pitch: input.pitch,
        quick: m.quick,
        swing: m.swings,
        move: m.move,
      });
      m.phase = 'recover';
      m.timer += KNIFE.recovery + (m.quick ? KNIFE.quickMeleeExtra : 0);
    } else if (m.phase === 'recover' && m.timer <= 0) {
      m.phase = 'idle';
      m.timer = 0;
    }
  }
  if (a.throwPhase !== 'idle') {
    a.throwTimer -= dt;
    if (a.throwPhase === 'windup' && a.throwTimer <= 0) {
      events.push({ type: 'grenadeThrow', yaw: input.yaw, pitch: input.pitch, kind: a.throwKind });
      a.throwPhase = 'recover';
      a.throwTimer += GRENADE.recovery;
    } else if (a.throwPhase === 'recover' && a.throwTimer <= 0) {
      a.throwPhase = 'idle';
      a.throwTimer = 0;
    }
  }

  // New commands: only with free hands (a swing or throw finishes first), not while stunned, and
  // not while guarding (the forearm is up).
  if (isMeleeing(a) || isThrowing(a) || a.stun > 0 || a.guard.held) return events;

  const want = requestedSlot(a, input, prevButtons);
  if (want) {
    events.push({ type: 'switchStart', from: a.target, to: want, duration: equipTime(a, want) });
    a.target = want;
    a.switchDuration = equipTime(a, want);
    a.switchTimer = a.switchDuration;
  }

  const knifeInHand = a.slot === 'knife' && !isSwitching(a);
  const quick = pressed(input.buttons, prevButtons, Button.Melee);
  const slash = knifeInHand && isDown(input.buttons, Button.Fire);
  if (quick || slash) {
    // Quick melee from a gun (or mid-switch) holsters it for the swing.
    m.phase = 'windup';
    m.quick = !knifeInHand;
    if (m.sinceStrike > KNIFE.comboResetTime) m.combo = 0;
    // Opening strike chambers visibly (the tell); follow-ups are fast; a counter is near-instant.
    m.empowered = a.counter > 0;
    a.counter = 0; // the counter is spent on this strike, whether it lands or not
    m.windupTotal = m.empowered
      ? KNIFE.counterWindup
      : m.combo === 0
        ? KNIFE.openingWindup
        : KNIFE.windup;
    m.timer = m.windupTotal;
    m.move = KNIFE_COMBO[m.combo % KNIFE_COMBO.length]!;
    m.combo += 1;
    events.push({ type: 'meleeStart', quick: m.quick, move: m.move, yaw: input.yaw });
    return events;
  }

  if (pressed(input.buttons, prevButtons, Button.Grenade) && a.grenades > 0) {
    a.grenades -= 1;
    a.throwKind = 'frag';
    a.throwPhase = 'windup';
    a.throwTimer = GRENADE.windup;
    events.push({ type: 'grenadeWindup', kind: 'frag' });
  } else if (pressed(input.buttons, prevButtons, Button.Smoke) && a.smokes > 0) {
    a.smokes -= 1;
    a.throwKind = 'smoke';
    a.throwPhase = 'windup';
    a.throwTimer = GRENADE.windup;
    events.push({ type: 'grenadeWindup', kind: 'smoke' });
  } else if (pressed(input.buttons, prevButtons, Button.Jammer) && a.jammers > 0) {
    a.jammers -= 1;
    events.push({ type: 'jammer' });
  }
  return events;
}
