import { SPAWN_PROTECTION } from '../config/tunables.ts';
import type { PlayerEvent, PlayerState } from './player.ts';

/**
 * Spawn protection: after every (re)spawn a player takes no damage (bullets, knife, frags —
 * anything) for `SPAWN_PROTECTION.duration` seconds or until they attack. One rule for the
 * server (`MatchSim`) and the offline game, both of which grant it at the spawn and step it
 * with `stepPlayer`.
 *
 * What ends it: a shot leaving the gun, a knife swing starting (the chamber is the commitment:
 * a strike begun under protection must not land under it), a throw's wind-up (frag or smoke).
 * What doesn't: aiming, reloading, sprinting, switching weapons, charging the coilgun (the shot
 * is what ends it), a dry trigger, raising the guard, moving. Those don't threaten anyone, and a
 * fresh spawn should be able to get its bearings (look down sights, top up) before choosing to
 * fight. It grants nothing else: no speed, no damage, no extra sight.
 */

/** Start a life's protection (every spawn). `seconds` = 0 turns it off (tests, match configs). */
export function grantSpawnProtection(p: PlayerState, seconds = SPAWN_PROTECTION.duration): void {
  p.spawnGuard = Math.max(0, seconds);
}

/** Whether damage to this player is blocked right now. */
export const isSpawnProtected = (p: Pick<PlayerState, 'spawnGuard' | 'health'>): boolean =>
  p.spawnGuard > 0 && p.health > 0;

/** An event that is an attack, and so ends the player's own protection. */
export function endsSpawnProtection(e: PlayerEvent): boolean {
  return e.type === 'shot' || e.type === 'meleeStart' || e.type === 'grenadeWindup';
}

/**
 * One step: an attack among this step's events ends protection at once (before any of the
 * step's shots, strikes or throws resolve, so nobody attacks while protected); otherwise it runs
 * down by `dt`.
 */
export function stepSpawnProtection(
  p: PlayerState,
  events: readonly PlayerEvent[],
  dt: number,
): void {
  if (p.spawnGuard <= 0) return;
  // 120 steps of 1/60 s must end exactly at 2 s, not one step later on a rounding residue.
  const left = p.spawnGuard - dt;
  p.spawnGuard = events.some(endsSpawnProtection) || left < 1e-9 ? 0 : left;
}
