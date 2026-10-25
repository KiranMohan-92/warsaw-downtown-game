import { pickSafeSpawn, type SightWorld, type SpawnPoint, type Vec3 } from '@wd/shared';

/**
 * Pick the respawn point safest from the living enemies (their eye positions): a spawn none of
 * them can see beats any spawn one of them can, then the one farthest from the nearest enemy
 * (horizontal). The match supplies a seeded draw for empty maps and ties; it never overrides
 * safety. The scoring is shared (`sim/spawnSafety.ts`): the offline game picks the same way
 * against its sparring partner.
 */
export function pickSpawn(
  spawns: readonly SpawnPoint[],
  enemies: readonly Vec3[],
  world?: SightWorld | null,
  draw = 0,
): SpawnPoint {
  return pickSafeSpawn(spawns, enemies, world, draw);
}

/**
 * The spawns to score: the clear ones, else the whole pool, else the authored fallback. Never
 * empty while any spawn exists, so a crowded match (every point within clearance of someone)
 * spawns at the safest occupied point instead of throwing in the authoritative tick.
 */
export function spawnCandidates(
  pool: readonly SpawnPoint[],
  fallback: readonly SpawnPoint[],
  clear: (s: SpawnPoint) => boolean,
): readonly SpawnPoint[] {
  const candidates = pool.filter(clear);
  if (candidates.length) return candidates;
  return pool.length ? pool : fallback;
}
