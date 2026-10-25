import { KNIFE } from '../config/tunables.ts';
import { add3, DEG, dot3, len3, norm3, scale3, sub3, viewDir, type Vec3 } from '../math/vec3.ts';
import type { KnifeMove } from './arsenal.ts';
import { pointInShape, shapeDistance } from './hitbox.ts';
import { traceShot, type HitTarget, type ShotResult, type WorldRaycaster } from './hitscan.ts';

export const knifeDamage = (move: KnifeMove): number =>
  move === 'thrust' ? KNIFE.thrustDamage : KNIFE.damage;

/**
 * Point-blank strike: a lunge can carry you inside a target's reach, where every ray would start
 * inside the volume and miss. It must still be a real strike: the target lies within the knife's
 * arc (horizontally) and in clear line of sight — no hits behind you or through cover. The zone
 * is whichever real volume the aim passes closest to, a hand's length out.
 */
function pointBlank<Id>(
  eye: Vec3,
  view: Vec3,
  arcHalf: number,
  world: WorldRaycaster,
  targets: readonly HitTarget<Id>[],
  inflated: readonly HitTarget<Id>[],
): ShotResult<Id> | null {
  const flat = norm3({ x: view.x, y: 0, z: view.z });
  const probe = add3(eye, scale3(view, 0.35));
  // Cover right in front of the blade (a chest-high lip, a doorframe) stops the strike itself.
  const blocked = world.castRay(eye, view, 0.35);
  if (blocked) return null;
  // Every qualifying target is a candidate; the body the blade meets first wins (targets can
  // overlap at contact range, and list order must never decide who gets hit).
  let best: ShotResult<Id> | null = null;
  let bestContact = Infinity;
  for (let i = 0; i < inflated.length; i++) {
    const t = inflated[i]!;
    if (!t.shapes.some((sh) => pointInShape(eye, sh))) continue;
    const orig = targets[i]!.shapes;
    const torso = orig.find((sh) => sh.zone === 'torso') ?? orig[0]!;
    const centre = scale3(add3(torso.a, torso.b), 0.5);
    const toT = sub3(centre, eye);
    const horiz = { x: toT.x, y: 0, z: toT.z };
    const facing =
      len3(horiz) < 0.05 ||
      Math.acos(Math.max(-1, Math.min(1, dot3(flat, norm3(horiz))))) <= arcHalf + 15 * DEG;
    if (!facing) continue;
    // Vertical aim must fall within the body's height span (plus a margin), seen from the eye.
    let lo = Infinity;
    let hi = -Infinity;
    for (const sh of orig) {
      lo = Math.min(lo, sh.a.y - sh.r, sh.b.y - sh.r);
      hi = Math.max(hi, sh.a.y + sh.r, sh.b.y + sh.r);
    }
    const reach = Math.max(len3(horiz), 0.3);
    const aimElev = Math.asin(Math.max(-1, Math.min(1, view.y)));
    const margin = 20 * DEG;
    if (
      aimElev > Math.atan2(hi - eye.y, reach) + margin ||
      aimElev < Math.atan2(lo - eye.y, reach) - margin
    )
      continue;
    const d = len3(toT);
    const hit = d > 1e-3 ? world.castRay(eye, scale3(toT, 1 / d), d) : null;
    if (hit && hit.distance < d - 0.05) continue;
    const contact = Math.min(...orig.map((sh) => shapeDistance(eye, sh)));
    if (contact < bestContact) {
      bestContact = contact;
      // Zone: whichever real volume the aim passes closest to, a hand's length out.
      const nearest = orig.reduce((a, sh) =>
        shapeDistance(probe, sh) < shapeDistance(probe, a) ? sh : a,
      );
      best = { kind: 'target', targetId: t.id, zone: nearest.zone, distance: 0, point: probe };
    }
  }
  return best;
}

/**
 * Knife hit test. A slash sweeps a fan of rays across `slashArcDeg` (tilted like a diagonal cut),
 * a thrust a narrow cone with longer reach; each ray tests target hit volumes inflated by the
 * blade's sweep radius. The nearest target hit across the fan wins; walls block individual rays.
 * Same analytic volumes as bullets, so it rewinds identically for lag compensation (M3).
 */
export function resolveMelee<Id>(
  eye: Vec3,
  yaw: number,
  pitch: number,
  world: WorldRaycaster,
  targets: readonly HitTarget<Id>[],
  move: KnifeMove = 'slash',
): ShotResult<Id> {
  const inflated = targets.map((t) => ({
    id: t.id,
    shapes: t.shapes.map((sh) => ({ ...sh, r: sh.r + KNIFE.sweepRadius })),
  }));
  const thrust = move === 'thrust';
  const arc = (thrust ? KNIFE.thrustArcDeg : KNIFE.slashArcDeg) * DEG;
  const close = pointBlank(eye, viewDir(yaw, pitch), arc / 2, world, targets, inflated);
  if (close) return close;
  const range = thrust ? KNIFE.thrustRange : KNIFE.range;
  // Live-tunable: keep at least two rays so the fan is well-defined.
  const n = thrust ? 3 : Math.max(2, Math.round(KNIFE.slashRays));
  // Diagonal cut: the fan tilts so one end is higher than the other.
  const tilt = thrust ? 0 : move === 'slash' ? 0.18 : -0.18;
  const centre = traceShot(eye, viewDir(yaw, pitch), range, world, inflated);
  let best: ShotResult<Id> | null = centre.kind === 'target' ? centre : null;
  // Nearest wall contact anywhere in the fan (sparks/sound when no target is hit).
  let wall: ShotResult<Id> | null = centre.kind === 'world' ? centre : null;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1) - 0.5; // -0.5 … 0.5 across the arc
    const r = traceShot(
      eye,
      viewDir(yaw - u * arc, pitch + u * arc * tilt),
      range,
      world,
      inflated,
    );
    if (r.kind === 'target' && (!best || (best.kind === 'target' && r.distance < best.distance))) {
      best = r;
    } else if (
      r.kind === 'world' &&
      (!wall || (wall.kind === 'world' && r.distance < wall.distance))
    ) {
      wall = r;
    }
  }
  return best ?? wall ?? centre;
}
