import { PLAYER, SPAWN_SAFETY } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { SpawnPoint } from '../maps/types.ts';
import { sightVisibility, type SightWorld } from './perception.ts';

/**
 * How safe a spawn is from the living enemies (higher = safer): the horizontal distance to the
 * nearest one, minus `SPAWN_SAFETY.seenPenalty` for every enemy with a clear line of sight from
 * their eye to a standing eye at the spawn. Sight is hard geometry only (the sight model's ray,
 * no smoke or foliage): clouds drift and fade within seconds, and spawns are generated outside
 * foliage. `enemies` are eye positions. With no world, distance only.
 */
export function spawnSafety(
  spawn: SpawnPoint,
  enemies: readonly Vec3[],
  world?: SightWorld | null,
): number {
  if (!enemies.length) return Infinity;
  const eye = { x: spawn.pos.x, y: spawn.pos.y + PLAYER.standEyeHeight, z: spawn.pos.z };
  let nearest = Infinity;
  let seen = 0;
  for (const e of enemies) {
    nearest = Math.min(nearest, Math.hypot(spawn.pos.x - e.x, spawn.pos.z - e.z));
    if (world && sightVisibility(e, eye, world, []) > 0) seen++;
  }
  return nearest - seen * SPAWN_SAFETY.seenPenalty;
}

/**
 * The safest spawn from the living enemies (`spawnSafety`): out of sight first, then farthest.
 * A supplied random draw rotates the search order: empty maps and equal-safety ties vary without
 * ever choosing a worse score. The default preserves deterministic callers. Cost: one sight ray
 * per enemy per spawn (6 players × 28 spawns ≈ 140 rays per respawn at most).
 */
export function pickSafeSpawn(
  spawns: readonly SpawnPoint[],
  enemies: readonly Vec3[],
  world?: SightWorld | null,
  draw = 0,
): SpawnPoint {
  if (spawns.length === 0) throw new Error('no spawn points');
  const start = Math.min(spawns.length - 1, Math.max(0, Math.floor(draw * spawns.length)));
  if (enemies.length === 0) return spawns[start]!;
  let best = spawns[start]!;
  let bestScore = -Infinity;
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[(start + i) % spawns.length]!;
    const score = spawnSafety(s, enemies, world);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
