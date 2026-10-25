import { GRENADE, SMOKE } from '../config/tunables.ts';
import { add3, DEG, dot3, len3, scale3, sub3, viewDir, type Vec3 } from '../math/vec3.ts';
import type { WorldRaycaster } from './hitscan.ts';

/** A thrown frag in flight or at rest. Plain data; stepped deterministically at the sim rate. */
export interface GrenadeState {
  id: number;
  /** Player seed / id of the thrower (kill credit in M3). */
  owner: number;
  pos: Vec3;
  vel: Vec3;
  fuse: number;
  resting: boolean;
  /** Frag explodes; smoke pops into a cloud (see sim/smoke.ts). */
  kind: 'frag' | 'smoke';
}

/**
 * Release a grenade from the eye along the view, pitched up by `throwUpAngle`, inheriting part of
 * the thrower's velocity. If the release point would be inside a wall, it's pulled back.
 */
export function spawnGrenade(
  id: number,
  owner: number,
  eye: Vec3,
  yaw: number,
  pitch: number,
  throwerVel: Vec3,
  world: WorldRaycaster,
  kind: 'frag' | 'smoke' = 'frag',
): GrenadeState {
  const dir = viewDir(yaw, Math.min(Math.PI / 2 - 0.01, pitch + GRENADE.throwUpAngle * DEG));
  const reach = 0.45;
  const hit = world.castRay(eye, dir, reach + GRENADE.radius);
  const out = hit ? Math.max(0, hit.distance - GRENADE.radius - 0.02) : reach;
  return {
    id,
    owner,
    pos: add3(eye, scale3(dir, out)),
    vel: add3(scale3(dir, GRENADE.throwSpeed), scale3(throwerVel, 0.6)),
    fuse: kind === 'smoke' ? SMOKE.fuse : GRENADE.fuse,
    resting: false,
    kind,
  };
}

export interface GrenadeStep {
  /** Impact speed of a bounce this step (0 if none): drives clink audio. */
  bounceSpeed: number;
  exploded: boolean;
}

const DOWN = { x: 0, y: -1, z: 0 };

/** Ballistic step with swept collision against static geometry: bounce, damp, settle, fuse. */
export function stepGrenade(g: GrenadeState, dt: number, world: WorldRaycaster): GrenadeStep {
  let bounceSpeed = 0;
  // A grenade resting on something that moved away (a truck's bed or bonnet) falls again.
  if (g.resting && !world.castRay(g.pos, DOWN, GRENADE.radius + 0.05)) g.resting = false;
  if (!g.resting) {
    g.vel.y -= GRENADE.gravity * dt;
    const move = scale3(g.vel, dt);
    const dist = len3(move);
    if (dist > 1e-6) {
      const dir = scale3(move, 1 / dist);
      const hit = world.castRay(g.pos, dir, dist + GRENADE.radius);
      if (hit) {
        const n = hit.normal;
        g.pos = add3(hit.point, scale3(n, GRENADE.radius + 0.002));
        const vn = dot3(g.vel, n);
        if (vn < 0) {
          const normalPart = scale3(n, vn);
          const tangent = sub3(g.vel, normalPart);
          g.vel = add3(scale3(tangent, GRENADE.friction), scale3(normalPart, -GRENADE.restitution));
          bounceSpeed = -vn;
        }
        if (n.y > 0.7 && len3(g.vel) < 1.2) {
          g.resting = true;
          g.vel = { x: 0, y: 0, z: 0 };
        }
      } else {
        g.pos = add3(g.pos, move);
      }
    }
  }
  g.fuse -= dt;
  return { bounceSpeed, exploded: g.fuse <= 0 };
}

/**
 * Blast damage at `target` (use the victim's centre of mass). Full damage inside the inner radius,
 * linear falloff to `minDamage` at the blast radius, nothing beyond. Solid geometry between the
 * blast and the target blocks it entirely: cover works.
 */
export function explosionDamage(center: Vec3, target: Vec3, world: WorldRaycaster): number {
  const d = len3(sub3(target, center));
  if (d > GRENADE.blastRadius) return 0;
  if (d > 0.05) {
    // Lift the origin slightly so a grenade resting on the floor doesn't hit the floor itself.
    const origin = add3(center, { x: 0, y: 0.12, z: 0 });
    const to = sub3(target, origin);
    const len = len3(to);
    const hit = world.castRay(origin, scale3(to, 1 / len), len);
    if (hit && hit.distance < len - 0.05) return 0;
  }
  const t = Math.max(0, (d - GRENADE.innerRadius) / (GRENADE.blastRadius - GRENADE.innerRadius));
  const dmg =
    d <= GRENADE.innerRadius
      ? GRENADE.maxDamage
      : GRENADE.maxDamage + (GRENADE.minDamage - GRENADE.maxDamage) * t;
  return Math.round(dmg * 10) / 10;
}
