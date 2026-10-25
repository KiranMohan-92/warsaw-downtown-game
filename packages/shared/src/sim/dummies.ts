import { DUMMY, PLAYER } from '../config/tunables.ts';
import { len3, lerp3, sub3, type Vec3 } from '../math/vec3.ts';
import type { DummyDef } from '../maps/types.ts';
import { applyDamage } from './damage.ts';
import { humanoidHitboxes } from './hitbox.ts';
import type { HitTarget } from './hitscan.ts';

/** Target-range dummy: a humanoid hitbox set that patrols, takes damage, and respawns. */
export interface DummyState {
  def: DummyDef;
  pos: Vec3;
  health: number;
  respawnTimer: number;
  /** Patrol phase in metres travelled. */
  travelled: number;
}

export const createDummies = (defs: readonly DummyDef[]): DummyState[] =>
  defs.map((def) => ({
    def,
    pos: { ...def.pos },
    health: DUMMY.maxHealth,
    respawnTimer: 0,
    travelled: 0,
  }));

export const dummyEyeHeight = (d: DummyState): number =>
  d.def.crouched ? PLAYER.crouchEyeHeight : PLAYER.standEyeHeight;

export function stepDummies(dummies: DummyState[], dt: number): void {
  for (const d of dummies) {
    if (d.health <= 0) {
      d.respawnTimer -= dt;
      if (d.respawnTimer <= 0) {
        d.health = DUMMY.maxHealth;
        d.travelled = 0;
        d.pos = { ...d.def.pos };
      }
      continue;
    }
    const path = d.def.path;
    if (path) {
      const length = len3(sub3(path.to, d.def.pos));
      d.travelled += path.speed * dt;
      const phase = (d.travelled / length) % 2;
      d.pos = lerp3(d.def.pos, path.to, phase <= 1 ? phase : 2 - phase);
    }
  }
}

export function dummyTargets(dummies: readonly DummyState[]): HitTarget<string>[] {
  return dummies
    .filter((d) => d.health > 0)
    .map((d) => ({ id: d.def.id, shapes: humanoidHitboxes(d.pos, dummyEyeHeight(d)) }));
}

/** Returns true if the hit killed the dummy (which then respawns after `DUMMY.respawnTime`). */
export function damageDummy(d: DummyState, amount: number): boolean {
  const killed = applyDamage(d, amount);
  if (killed) d.respawnTimer = DUMMY.respawnTime;
  return killed;
}
