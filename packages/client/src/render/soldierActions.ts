/**
 * Which combat clip a soldier plays for what their hands are doing (shared sim/action.ts
 * `PlayerAction`), and where in it: pure, so the timing is tested without a renderer. The clips
 * are upper-body layers (tools/assets/build_soldiers.py ACTIONS) driven by the sim's progress, so a
 * reload, throw or strike always ends exactly when the sim's does.
 */
import { ACTION_RELEASE, type PlayerAction } from '@wd/shared';

export type ActionClip =
  | 'reload'
  | 'reloadKneel'
  | 'reloadRun'
  | 'reloadPistol'
  | 'throw'
  | 'strike'
  | 'guard'
  | 'hit'
  | 'hitHead';

export const ACTION_CLIPS: readonly ActionClip[] = [
  'reload',
  'reloadKneel',
  'reloadRun',
  'reloadPistol',
  'throw',
  'strike',
  'guard',
  'hit',
  'hitHead',
];

/** Split clips: the clip time (s) of the release / impact (soldiers.json `marks`). */
export type ClipMarks = Partial<Record<ActionClip, number>>;

/** Ground speed (m/s) above which a rifle reload is the moving (running) variant. */
const MOVING_RELOAD = 1.2;

/**
 * The clip for an action, by stance and speed: reloads are standing / kneeling (crouched) /
 * running, or the pistol's; a stun replays the chest flinch over its duration. Prone and dead
 * bodies play none (their pose has no upper body to layer over).
 */
export function pickActionClip(
  a: PlayerAction,
  s: { crouched: boolean; speed: number; prone?: boolean; alive: boolean },
): ActionClip | null {
  if (!s.alive || s.prone) return null;
  switch (a.kind) {
    case 'reload':
      if (a.v === 1) return 'reloadPistol';
      if (s.crouched) return 'reloadKneel';
      return s.speed > MOVING_RELOAD ? 'reloadRun' : 'reload';
    case 'throw':
      return 'throw';
    case 'strike':
      return 'strike';
    case 'guard':
      return 'guard';
    case 'stun':
      return 'hit';
    default:
      return null;
  }
}

/**
 * Clip time for the action's progress. Split clips (throw, strike) put the sim's release at the
 * clip's mark whatever the wind-up length; a backhand (strike variant 1) plays the slash
 * backwards (left to right); the guard rises over the parry window and holds.
 */
export function actionClipTime(
  a: PlayerAction,
  clip: ActionClip,
  duration: number,
  marks: ClipMarks,
): number {
  const t = Math.min(1, Math.max(0, a.t));
  const mark = marks[clip];
  if (mark === undefined || mark <= 0 || mark >= duration) return t * duration;
  if (clip === 'strike' && a.v === 1) {
    // Reversed: the recovery half of the clip is the wind-up, the wind-up half the follow-through.
    const back = duration - mark;
    return t < ACTION_RELEASE
      ? duration - (t / ACTION_RELEASE) * back
      : mark - ((t - ACTION_RELEASE) / (1 - ACTION_RELEASE)) * mark;
  }
  return t < ACTION_RELEASE
    ? (t / ACTION_RELEASE) * mark
    : mark + ((t - ACTION_RELEASE) / (1 - ACTION_RELEASE)) * (duration - mark);
}

/** Blend-in time (s) per clip: strikes must be up within a 0.07 s follow-up wind-up. */
export const LAYER_FADE_IN: Partial<Record<ActionClip, number>> = { strike: 0.05, guard: 0.06 };
export const LAYER_FADE_IN_DEFAULT = 0.12;
export const LAYER_FADE_OUT = 0.2;

/**
 * three's mixer averages every active action by weight, so a layer of blend `b` over locomotion
 * of total weight `base` needs weight base·b/(1−b) (b → 1 is a full override of its bones).
 */
export function layerWeight(b: number, base = 1): number {
  const c = Math.min(0.98, Math.max(0, b));
  return (base * c) / (1 - c);
}

/** While a throw is before its release the grenade is in hand (and the weapon is away). */
export const grenadeInHand = (a: PlayerAction): boolean =>
  a.kind === 'throw' && a.t < ACTION_RELEASE;
