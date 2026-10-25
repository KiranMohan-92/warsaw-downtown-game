import type { FoliageIndex } from '../maps/concealment.ts';
import type { SurfaceKind } from '../maps/surfaces.ts';
import { mulberry32 } from '../math/rng.ts';
import { add3, cross3, DEG, dot3, norm3, scale3, sub3, viewDir, type Vec3 } from '../math/vec3.ts';
import {
  axisPoint,
  pointInShape,
  rayShape,
  shapeDistance,
  type HitShape,
  type HitZone,
} from './hitbox.ts';
import { SIGHT_THRESHOLD, sightVisibility } from './perception.ts';
import type { SmokeCloud } from './smoke.ts';
import type { ShotFired } from './weapon.ts';

/**
 * Final bullet direction: recoil-adjusted aim perturbed by a uniform sample of the spread cone.
 * Deterministic from `shot.seed`, so the server reproduces the exact same ray.
 */
export function shotDirection(shot: ShotFired): Vec3 {
  const dir = viewDir(shot.yaw, shot.pitch);
  if (shot.spreadDeg <= 0) return dir;
  const rng = mulberry32(shot.seed);
  const angle = shot.spreadDeg * DEG * Math.sqrt(rng());
  const theta = rng() * Math.PI * 2;
  const helper: Vec3 = Math.abs(dir.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = norm3(cross3(dir, helper));
  const v = cross3(u, dir);
  const s = Math.sin(angle);
  const offset = add3(scale3(u, Math.cos(theta) * s), scale3(v, Math.sin(theta) * s));
  return norm3(add3(scale3(dir, Math.cos(angle)), offset));
}

/**
 * Every pellet of a shot (1 for most guns): pellet i perturbs the shot's own spread cone by the
 * gun's pellet cone, from a seed derived from the shot's, so the server traces the same fan.
 */
export function pelletDirections(
  shot: ShotFired,
  pellets: number,
  pelletSpreadDeg: number,
): Vec3[] {
  if (pellets <= 1) return [shotDirection(shot)];
  const out: Vec3[] = [];
  for (let i = 0; i < pellets; i++) {
    const seed = (Math.imul(shot.seed ^ 0x5bd1e995, 0x27d4eb2d) + i * 0x9e3779b9) >>> 0;
    out.push(shotDirection({ ...shot, seed, spreadDeg: shot.spreadDeg + pelletSpreadDeg }));
  }
  return out;
}

export interface WorldHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
  /** False for collision-only geometry (map bounds, stair ramps): skip impact effects. */
  visible: boolean;
  /** What was hit, for impact sounds/effects (presentation only; absent if unknown). */
  surface?: SurfaceKind;
  /** The map prop hit (`PhysicsWorld` prop id), if one. */
  prop?: number;
}

/** Static-geometry raycast (implemented with Rapier in `physics/world.ts`). */
export interface WorldRaycaster {
  castRay(origin: Vec3, dir: Vec3, maxDistance: number): WorldHit | null;
  /** Presentation only: ignore invisible movement helpers, retaining visible surfaces behind them. */
  castVisibleRay?(origin: Vec3, dir: Vec3, maxDistance: number): WorldHit | null;
}

export interface HitTarget<Id = string> {
  id: Id;
  shapes: HitShape[];
}

export type ShotResult<Id = string> =
  | { kind: 'miss'; end: Vec3 }
  | {
      kind: 'world';
      distance: number;
      point: Vec3;
      normal: Vec3;
      visible: boolean;
      surface?: SurfaceKind;
    }
  | { kind: 'target'; targetId: Id; zone: HitZone; distance: number; point: Vec3 };

/** What hides a body from sight besides walls: smoke clouds and the map's foliage. */
export interface SightConcealment {
  smoke: readonly SmokeCloud[];
  foliage?: FoliageIndex | null;
}

/**
 * Smart rounds (Iskra SMG): bend a shot direction toward the nearest visible target whose body
 * centre lies within `coneDeg` of it, by at most `maxBendDeg`. Visible = the shared sight model
 * (walls, smoke, foliage; sim data, the same on every quality tier), so rounds never find
 * someone hiding in a bush or a cloud. Pure and deterministic: the client prediction and the
 * server (with lag-compensated targets) bend identically, so it is fair.
 */
export function bendShot<Id>(
  origin: Vec3,
  dir: Vec3,
  maxRange: number,
  world: WorldRaycaster,
  targets: readonly HitTarget<Id>[],
  coneDeg: number,
  maxBendDeg: number,
  sight: SightConcealment,
): Vec3 {
  if (coneDeg <= 0 || maxBendDeg <= 0) return dir;
  const cone = Math.cos(coneDeg * DEG);
  let best: { to: Vec3; cos: number } | null = null;
  for (const t of targets) {
    const torso = t.shapes.find((s) => s.zone === 'torso') ?? t.shapes[0];
    if (!torso) continue;
    const centre = scale3(add3(torso.a, torso.b), 0.5);
    const off = sub3(centre, origin);
    const dist = Math.hypot(off.x, off.y, off.z);
    if (dist < 1e-3 || dist > maxRange) continue;
    const to = scale3(off, 1 / dist);
    const c = dot3(to, dir);
    if (c < cone || (best && c <= best.cos)) continue;
    // Only what the shooter can see: the sight model to that body centre.
    if (sightVisibility(origin, centre, world, sight.smoke, sight.foliage) < SIGHT_THRESHOLD)
      continue;
    best = { to, cos: c };
  }
  if (!best) return dir;
  const angle = Math.acos(Math.min(1, best.cos));
  const turn = Math.min(angle, maxBendDeg * DEG);
  if (angle < 1e-6) return dir;
  // Rotate `dir` toward `to` by `turn` within their plane.
  const perp = norm3(sub3(best.to, scale3(dir, best.cos)));
  return norm3(add3(scale3(dir, Math.cos(turn)), scale3(perp, Math.sin(turn))));
}

/** Resolve a hitscan ray: nearest of static world and target hit volumes. */
export function traceShot<Id>(
  origin: Vec3,
  dir: Vec3,
  maxRange: number,
  world: WorldRaycaster,
  targets: readonly HitTarget<Id>[],
  /**
   * Bullets: a muzzle already inside a body (contact range, bodies overlapping) hits it at
   * distance 0. Off for the knife, whose rays start inside *inflated* volumes by design and
   * resolve that case with their own aim checks (see melee `pointBlank`).
   */
  hitFromInside = false,
): ShotResult<Id> {
  const worldHit = world.castRay(origin, dir, maxRange);
  let best = worldHit ? worldHit.distance : maxRange;
  let bestTarget: { id: Id; zone: HitZone } | null = null;
  if (hitFromInside) {
    // Overlapping bodies can all contain the muzzle: the one the shot direction points into
    // (closest to a point 30 cm along it) wins, never list order.
    const probe = add3(origin, scale3(dir, 0.3));
    let pick: { id: Id; zone: HitZone; d: number } | null = null;
    for (const t of targets) {
      const inside = t.shapes.filter((s) => pointInShape(origin, s));
      if (inside.length === 0) continue;
      // Only if the shot goes *into* the body: still inside 30 cm on, deep in a volume, or heading
      // toward its core. Firing out of someone you barely overlap is a miss on them.
      const inward =
        t.shapes.some((s) => pointInShape(probe, s)) ||
        inside.some((s) => {
          const toCore = sub3(axisPoint(origin, s), origin);
          // Deep inside (near the core) every direction passes through the body.
          return dot3(toCore, toCore) < (s.r * 0.5) ** 2 || dot3(dir, toCore) > 0;
        });
      if (!inward) continue;
      const d = Math.min(...t.shapes.map((s) => shapeDistance(probe, s)));
      const zone = inside.some((s) => s.zone === 'head') ? 'head' : inside[0]!.zone;
      if (!pick || d < pick.d) pick = { id: t.id, zone, d };
    }
    if (pick) {
      return {
        kind: 'target',
        targetId: pick.id,
        zone: pick.zone,
        distance: 0,
        point: { ...origin },
      };
    }
  }
  for (const t of targets) {
    let nearest = Infinity;
    let zone: HitZone | null = null;
    let headDist = Infinity;
    for (const s of t.shapes) {
      const d = rayShape(origin, dir, s);
      if (d < 0) continue;
      if (s.zone === 'head') headDist = d;
      if (d < nearest) {
        nearest = d;
        zone = s.zone;
      }
    }
    // Overlapping volumes: the head wins if it's within 3 cm of the nearest entry point.
    if (headDist <= nearest + 0.03) zone = 'head';
    if (zone && nearest < best) {
      best = nearest;
      bestTarget = { id: t.id, zone };
    }
  }
  if (bestTarget) {
    return {
      kind: 'target',
      targetId: bestTarget.id,
      zone: bestTarget.zone,
      distance: best,
      point: add3(origin, scale3(dir, best)),
    };
  }
  if (worldHit) return { kind: 'world', ...worldHit };
  return { kind: 'miss', end: add3(origin, scale3(dir, maxRange)) };
}

/** What `traceGunShot` needs of a gun's config (`gunConfig(arsenal, slot)`). */
export interface GunTraceConfig {
  maxRange: number;
  pellets: number;
  pelletSpreadDeg: number;
  homingConeDeg: number;
  homingMaxBendDeg: number;
}

/**
 * One gun shot as its shooter sees it: every pellet (1 for most guns) from the shot's seed, smart
 * rounds bent toward a visible body in `sight` (default: the targets), each traced against
 * `targets`. The client's predicted hit marker and the soak harness's fairness check both use
 * this; `MatchSim.fire` traces the same fan against the rewound bodies.
 */
export function traceGunShot<Id>(
  eye: Vec3,
  shot: ShotFired,
  cfg: GunTraceConfig,
  world: WorldRaycaster,
  targets: readonly HitTarget<Id>[],
  concealment: SightConcealment,
  sight: readonly HitTarget<Id>[] = targets,
): ShotResult<Id>[] {
  return pelletDirections(shot, cfg.pellets, cfg.pelletSpreadDeg).map((d) =>
    traceShot(
      eye,
      bendShot(
        eye,
        d,
        cfg.maxRange,
        world,
        sight,
        cfg.homingConeDeg,
        cfg.homingMaxBendDeg,
        concealment,
      ),
      cfg.maxRange,
      world,
      targets,
      true,
    ),
  );
}
