import { PLAYER } from '../config/tunables.ts';
import { mulberry32 } from '../math/rng.ts';
import type { PhysicsWorld } from '../physics/world.ts';
import type { Bounds, MapFoliage, SpawnPoint } from './types.ts';

export interface SpawnOptions {
  count: number;
  seed?: number;
  /** Candidate grid spacing (m). */
  spacing?: number;
  /** Keep this far inside the bounds (m). */
  margin?: number;
  /** Street level only: ground hit must be within this band (no roofs, no tunnels). */
  groundBand?: [number, number];
  /**
   * Soft cover (bushes, tall grass) to keep spawns out of: foliage has no collider, so the capsule
   * test alone would spawn a player hidden inside a hedge (an unfair ambush spot) or nose-deep in
   * one. Candidates within a clump's radius + `FOLIAGE_SPAWN_CLEARANCE` are dropped.
   */
  foliage?: readonly MapFoliage[];
  /**
   * Points to keep spawns away from by `AVOID_SPAWN_RADIUS` (the trucks' parking spots: nobody
   * spawns beside a truck, or under one coming back from its respawn; the jetpacks: nobody
   * spawns on one).
   */
  avoid?: readonly { x: number; z: number }[];
}

/** Metres kept between a spawn and each `avoid` point. */
export const AVOID_SPAWN_RADIUS = 15;

/** Metres kept between a spawn and the edge of any foliage clump (room to see past it). */
export const FOLIAGE_SPAWN_CLEARANCE = 1.2;

/**
 * Deterministic spawn generation from the physics world, identical on client and server:
 * 1. jittered grid of candidates, each dropped onto street-level ground where a standing capsule
 *    fits;
 * 2. keep candidates with cover nearby (≥2 of 8 chest-height rays blocked within 7 m) — nobody
 *    spawns in the open;
 * 3. farthest-point sampling spreads the chosen set evenly across the area;
 * 4. each spawn faces the direction whose tightest chest-height ray within ±15° is longest,
 *    so a single ray that only grazes a corner does not count as an open view.
 */
export function generateSpawns(
  physics: PhysicsWorld,
  bounds: Bounds,
  opts: SpawnOptions,
): SpawnPoint[] {
  const rng = mulberry32(opts.seed ?? 0x5eed);
  const spacing = opts.spacing ?? 7;
  const margin = opts.margin ?? 8;
  const [lo, hi] = opts.groundBand ?? [-0.2, 0.6];
  const chest = 1.3;
  const dirs = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);
  const spread = (15 * Math.PI) / 180;
  const candidates: { x: number; y: number; z: number; yaw: number; cover: number }[] = [];
  for (let x = bounds.minX + margin; x <= bounds.maxX - margin; x += spacing) {
    for (let z = bounds.minZ + margin; z <= bounds.maxZ - margin; z += spacing) {
      const px = x + (rng() - 0.5) * spacing * 0.8;
      const pz = z + (rng() - 0.5) * spacing * 0.8;
      // Drop from just above street level so roofs/canopies above don't count as ground.
      const hit = physics.castRay(
        { x: px, y: hi + 2.5, z: pz },
        { x: 0, y: -1, z: 0 },
        hi + 2.5 - lo + 0.5,
      );
      if (!hit || hit.point.y < lo || hit.point.y > hi) continue;
      if (opts.foliage?.some((f) => Math.hypot(f.x - px, f.z - pz) < f.r + FOLIAGE_SPAWN_CLEARANCE))
        continue;
      if (opts.avoid?.some((a) => Math.hypot(a.x - px, a.z - pz) < AVOID_SPAWN_RADIUS)) continue;
      const feet = { x: px, y: hit.point.y + 0.02, z: pz };
      // 15 cm elbow room all round: inflate the capsule and lift it by the same 15 cm so the
      // inflation doesn't just dig into the ground.
      const lifted = { x: feet.x, y: feet.y + 0.17, z: feet.z };
      if (physics.overlapsStatic(lifted, PLAYER.standHeight, -0.15)) continue;
      // Something overhead within 2.4 m (inside a building/under a stair)? Skip.
      const up = physics.castRay({ x: px, y: feet.y + 0.3, z: pz }, { x: 0, y: 1, z: 0 }, 2.1);
      if (up) continue;
      let cover = 0;
      let bestYaw = 0;
      let bestOpen = -1;
      const openAlong = (yaw: number): number => {
        const d = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) }; // yaw looks along this
        const h = physics.castRay({ x: px, y: feet.y + chest, z: pz }, d, 60);
        return h ? h.distance : 60;
      };
      for (const a of dirs) {
        const open = openAlong(a);
        if (open < 7) cover++;
        const score = Math.min(openAlong(a - spread), open, openAlong(a + spread));
        if (score > bestOpen) {
          bestOpen = score;
          bestYaw = a;
        }
      }
      if (cover < 2) continue;
      candidates.push({ ...feet, yaw: bestYaw, cover });
    }
  }
  if (candidates.length === 0) return [];
  // Farthest-point sampling, seeded from the candidate nearest the centre.
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  let first = 0;
  let bestD = Infinity;
  candidates.forEach((c, i) => {
    const d = Math.hypot(c.x - cx, c.z - cz);
    if (d < bestD) {
      bestD = d;
      first = i;
    }
  });
  const chosen = [candidates[first]!];
  const minDist = candidates.map((c) => Math.hypot(c.x - chosen[0]!.x, c.z - chosen[0]!.z));
  while (chosen.length < Math.min(opts.count, candidates.length)) {
    let idx = 0;
    let far = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (minDist[i]! > far) {
        far = minDist[i]!;
        idx = i;
      }
    }
    const c = candidates[idx]!;
    chosen.push(c);
    for (let i = 0; i < candidates.length; i++) {
      minDist[i] = Math.min(
        minDist[i]!,
        Math.hypot(candidates[i]!.x - c.x, candidates[i]!.z - c.z),
      );
    }
  }
  return chosen.map((c) => ({ pos: { x: c.x, y: c.y, z: c.z }, yaw: c.yaw }));
}
