import { KNIFE_DEFENSE } from '../config/tunables.ts';
import { DEG, dot3, len3, norm3, sub3 } from '../math/vec3.ts';
import type { KnifeMove } from './arsenal.ts';
import { knifeDamage } from './melee.ts';
import type { PlayerState } from './player.ts';

/**
 * Knife defense, resolved when a strike connects (Krav Maga-inspired):
 * - **parry** ("burst"): guard raised within the parry window before impact → no damage; the
 *   attacker is stunned and shoved back; the defender gets a fast, harder counter.
 * - **guard** (360° outside defense): guard held longer → reduced damage; guard wears out and
 *   breaks after a few strikes, stunning the defender briefly.
 * - Strikes from outside the defender's front arc can't be defended at all.
 */
export type StrikeOutcome = 'parried' | 'blocked' | 'guardBroken' | 'hit';

export interface StrikeResult {
  outcome: StrikeOutcome;
  damage: number;
}

/** Damage an attacker's strike deals before defense (includes the counter bonus). */
export function strikeDamage(attacker: PlayerState, move: KnifeMove): number {
  return (
    knifeDamage(move) + (attacker.arsenal.melee.empowered ? KNIFE_DEFENSE.counterBonusDamage : 0)
  );
}

/** Is the attacker inside the defender's guard arc (facing them)? */
export function facesAttacker(defender: PlayerState, attacker: PlayerState): boolean {
  const toA = sub3(attacker.move.pos, defender.move.pos);
  const flat = { x: toA.x, y: 0, z: toA.z };
  if (len3(flat) < 1e-3) return true;
  const yaw = defender.view.yaw;
  const facing = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
  const cos = dot3(facing, norm3(flat));
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= (KNIFE_DEFENSE.frontArcDeg / 2) * DEG;
}

/** Decide the outcome only (no state changes). */
export function strikeOutcome(
  attacker: PlayerState,
  defender: PlayerState,
  move: KnifeMove,
): Exclude<StrikeOutcome, 'guardBroken'> {
  const g = defender.arsenal.guard;
  if (!g.held || !facesAttacker(defender, attacker)) return 'hit';
  const window = move === 'thrust' ? KNIFE_DEFENSE.thrustParryWindow : KNIFE_DEFENSE.parryWindow;
  return g.heldFor <= window ? 'parried' : 'blocked';
}

/** Resolve a connecting strike: mutates both players (stun, pushback, counter, guard wear). */
export function applyKnifeStrike(
  attacker: PlayerState,
  defender: PlayerState,
  move: KnifeMove,
): StrikeResult {
  const base = strikeDamage(attacker, move);
  const outcome = strikeOutcome(attacker, defender, move);
  const g = defender.arsenal.guard;
  if (outcome === 'parried') {
    const a = attacker.arsenal;
    a.stun = KNIFE_DEFENSE.parryStun;
    a.melee.combo = 0;
    // Shove the attacker away from the defender.
    const away = sub3(attacker.move.pos, defender.move.pos);
    const flat = norm3({ x: away.x, y: 0, z: away.z });
    attacker.move.vel.x += flat.x * KNIFE_DEFENSE.parryPushback;
    attacker.move.vel.z += flat.z * KNIFE_DEFENSE.parryPushback;
    defender.arsenal.counter = KNIFE_DEFENSE.counterWindow;
    g.blocks = 0;
    return { outcome, damage: 0 };
  }
  if (outcome === 'blocked') {
    g.blocks += 1;
    const damage = Math.round(base * KNIFE_DEFENSE.guardDamageMultiplier * 10) / 10;
    if (g.blocks >= KNIFE_DEFENSE.guardMaxBlocks) {
      g.held = false;
      g.brokenTimer = KNIFE_DEFENSE.guardRecovery;
      defender.arsenal.stun = KNIFE_DEFENSE.guardBreakStun;
      return { outcome: 'guardBroken', damage };
    }
    return { outcome, damage };
  }
  return { outcome: 'hit', damage: base };
}
