import { PLAYER } from '../config/tunables.ts';
import { add3, dot3, sub3, type Vec3 } from '../math/vec3.ts';

export type HitZone = 'head' | 'torso' | 'legs';

/** A hit volume. Capsules are the segment a→b swept by radius r; spheres use `a` only. */
export interface HitShape {
  zone: HitZone;
  kind: 'sphere' | 'capsule';
  a: Vec3;
  b: Vec3;
  r: number;
}

/**
 * Hit volumes for a humanoid standing at `feet`. Analytic shapes (not physics colliders) so the
 * server can rewind them cheaply for lag compensation in M3.
 */
export function humanoidHitboxes(feet: Vec3, eyeHeight: number, yaw = 0): HitShape[] {
  if (eyeHeight < PLAYER.proneHitboxEye) return proneHitboxes(feet, yaw);
  const k = eyeHeight / PLAYER.standEyeHeight; // crouch squashes everything proportionally
  const at = (y: number): Vec3 => add3(feet, { x: 0, y: y * k, z: 0 });
  const head = at(PLAYER.standEyeHeight + 0.03);
  return [
    { zone: 'head', kind: 'sphere', a: head, b: head, r: 0.14 },
    { zone: 'torso', kind: 'capsule', a: at(0.98), b: at(1.36), r: 0.24 },
    { zone: 'legs', kind: 'capsule', a: at(0.18), b: at(0.8), r: 0.19 },
  ];
}

/**
 * Lying on the stomach: `feet` is under the head (the capsule), the body lies behind along the
 * facing (`yaw`, forward = -Z rotated by yaw). The prone soldier model matches these.
 */
export function proneHitboxes(feet: Vec3, yaw: number): HitShape[] {
  const bx = Math.sin(yaw);
  const bz = Math.cos(yaw);
  const at = (back: number, y: number): Vec3 => ({
    x: feet.x + bx * back,
    y: feet.y + y,
    z: feet.z + bz * back,
  });
  const head = at(-0.05, 0.3);
  return [
    { zone: 'head', kind: 'sphere', a: head, b: head, r: 0.14 },
    { zone: 'torso', kind: 'capsule', a: at(0.3, 0.22), b: at(0.85, 0.18), r: 0.2 },
    { zone: 'legs', kind: 'capsule', a: at(0.95, 0.13), b: at(1.65, 0.1), r: 0.13 },
  ];
}

/** Ray/sphere: distance along the (unit) ray, or -1. Rays starting inside don't hit. */
export function raySphere(ro: Vec3, rd: Vec3, center: Vec3, r: number): number {
  const oc = sub3(ro, center);
  const b = dot3(oc, rd);
  const c = dot3(oc, oc) - r * r;
  if (c < 0) return -1;
  const h = b * b - c;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : -1;
}

/** Ray/capsule (Inigo Quilez's formulation): distance along the (unit) ray, or -1. */
export function rayCapsule(ro: Vec3, rd: Vec3, pa: Vec3, pb: Vec3, r: number): number {
  const ba = sub3(pb, pa);
  const oa = sub3(ro, pa);
  const baba = dot3(ba, ba);
  const bard = dot3(ba, rd);
  const baoa = dot3(ba, oa);
  const rdoa = dot3(rd, oa);
  const oaoa = dot3(oa, oa);
  const a = baba - bard * bard;
  if (a > 1e-9) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - r * r * baba;
    const h = b * b - a * c;
    if (h < 0) return -1;
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 ? t : -1;
    return raySphere(ro, rd, y <= 0 ? pa : pb, r);
  }
  // Ray parallel to the axis: only the end caps matter.
  const ta = raySphere(ro, rd, pa, r);
  const tb = raySphere(ro, rd, pb, r);
  if (ta < 0) return tb;
  if (tb < 0) return ta;
  return Math.min(ta, tb);
}

/** Is point p inside the volume? (Capsule: distance to the a→b segment < r.) */
export function pointInShape(p: Vec3, s: HitShape): boolean {
  if (s.kind === 'sphere') {
    const d = sub3(p, s.a);
    return dot3(d, d) < s.r * s.r;
  }
  const ab = sub3(s.b, s.a);
  const ap = sub3(p, s.a);
  const t = Math.max(0, Math.min(1, dot3(ap, ab) / Math.max(1e-12, dot3(ab, ab))));
  const closest = add3(s.a, { x: ab.x * t, y: ab.y * t, z: ab.z * t });
  const d = sub3(p, closest);
  return dot3(d, d) < s.r * s.r;
}

/** The volume's core point nearest p: a sphere's centre, or the closest point on a capsule's axis. */
export function axisPoint(p: Vec3, s: HitShape): Vec3 {
  if (s.kind === 'sphere') return s.a;
  const ab = sub3(s.b, s.a);
  const t = Math.max(0, Math.min(1, dot3(sub3(p, s.a), ab) / Math.max(1e-12, dot3(ab, ab))));
  return add3(s.a, { x: ab.x * t, y: ab.y * t, z: ab.z * t });
}

/** Signed distance from p to a hit volume's surface (negative inside). */
export function shapeDistance(p: Vec3, s: HitShape): number {
  const d = sub3(p, axisPoint(p, s));
  return Math.sqrt(dot3(d, d)) - s.r;
}

export function rayShape(ro: Vec3, rd: Vec3, s: HitShape): number {
  return s.kind === 'sphere' ? raySphere(ro, rd, s.a, s.r) : rayCapsule(ro, rd, s.a, s.b, s.r);
}
