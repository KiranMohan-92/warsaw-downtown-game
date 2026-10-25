import type { Vec3 } from '../math/vec3.ts';
import type { FoliageIndex } from '../maps/concealment.ts';
import { smokeVisibility, type SmokeCloud } from './smoke.ts';

/** What a sight check needs from the world: a static-geometry ray cast. */
export interface SightWorld {
  castRay(origin: Vec3, dir: Vec3, maxDistance: number): unknown;
}

/**
 * How well `from` sees `to`: 0 = hidden, 1 = clear. Hard cover (any solid geometry) hides
 * completely; smoke and foliage thin the view by how much of the sight line passes through them.
 * The one sight model for bots, drones and (M3) server checks — nobody sees through what hides
 * a human player.
 */
export function sightVisibility(
  from: Vec3,
  to: Vec3,
  world: SightWorld,
  smoke: readonly SmokeCloud[],
  foliage?: FoliageIndex | null,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > 1e-6) {
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    if (world.castRay(from, dir, Math.max(0, dist - 0.3))) return 0;
  }
  const v = smokeVisibility(smoke, from, to);
  return foliage ? v * foliage.visibility(from, to) : v;
}

/** Below this, a target counts as unseen (a glimpse through thin smoke/leaves still counts). */
export const SIGHT_THRESHOLD = 0.35;
