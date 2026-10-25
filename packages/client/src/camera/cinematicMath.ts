/**
 * Pure camera maths for the cinematic moments (render/Game only read the results): easing,
 * a centripetal Catmull–Rom spline through camera keys, orbit and over-the-shoulder placement,
 * and camera-vs-wall collision. Everything writes into caller-owned objects: nothing here
 * allocates per frame. Yaw/pitch follow the game camera ('YXZ' Euler; forward = -Z turned by yaw).
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** C1 ease in/out (zero velocity at both ends). */
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** C2 ease in/out (zero velocity and acceleration at both ends: no jerk at a handoff). */
export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Ease out (fast start, gentle arrival): a camera pulled off the head. */
export const easeOutCubic = (t: number): number => {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
};

/** Frame-rate independent exponential approach: the fraction to move this frame (time const `tau` s). */
export const follow = (dt: number, tau: number): number =>
  tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau);

export function set3(out: V3, x: number, y: number, z: number): V3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function lerp3(out: V3, a: V3, b: V3, t: number): V3 {
  return set3(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

export const dist3 = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The view direction of a camera at (yaw, pitch). */
export function forwardOf(yaw: number, pitch: number, out: V3): V3 {
  const c = Math.cos(pitch);
  return set3(out, -Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
}

/** Yaw/pitch that look from `from` toward `to` (the inverse of `forwardOf`). */
export function lookAngles(from: V3, to: V3, out: { yaw: number; pitch: number }): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

/**
 * A point on a horizontal circle round `center`: `angle` uses the yaw convention, so
 * `angle = yaw` sits directly behind someone facing `yaw`, and `yaw + π` in front of them.
 */
export function orbitPoint(center: V3, radius: number, height: number, angle: number, out: V3) {
  return set3(
    out,
    center.x + Math.sin(angle) * radius,
    center.y + height,
    center.z + Math.cos(angle) * radius,
  );
}

/**
 * Over-the-shoulder: `back` metres behind the eye along the view, `side` to its right, `up`
 * above. Pitch is damped (`pitchScale`) so a player looking at their feet doesn't put the camera
 * above their head.
 */
export function overShoulder(
  eye: V3,
  yaw: number,
  pitch: number,
  back: number,
  side: number,
  up: number,
  out: V3,
  pitchScale = 0.6,
): V3 {
  const p = pitch * pitchScale;
  const c = Math.cos(p);
  const fx = -Math.sin(yaw) * c;
  const fy = Math.sin(p);
  const fz = -Math.cos(yaw) * c;
  // Right of the view: forward × up (yaw 0 faces -Z, its right is +X).
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return set3(
    out,
    eye.x - fx * back + rx * side,
    eye.y - fy * back + up,
    eye.z - fz * back + rz * side,
  );
}

/**
 * A static ray cast: distance to the first hit along the unit `dir`, or null (the physics ray).
 * `normal`, when given, receives the surface normal at the hit.
 */
export type RayCast = (origin: V3, dir: V3, maxDistance: number, normal?: V3) => number | null;

/** A grazing hit pulls back at most radius / this (≈ 1.1 m): keeps the margin off the wall. */
const MIN_INCIDENCE = 0.25;

/** How far above the ground (or roof) under the map's middle the wide shot's pivot floats. */
export const WIDE_PIVOT_HEIGHT = 20;

const DOWN: V3 = { x: 0, y: -1, z: 0 };

/**
 * The wide shot's vantage over a map: a pivot in open air above the middle of `bounds` — found
 * from the sky down, so it is never in the ground or inside a building, where a camera collided
 * from it would collapse onto it — and the surface point under it to look at.
 */
export function wideVantage(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  cast: RayCast,
): { pivot: V3; look: V3 } {
  const x = (bounds.minX + bounds.maxX) / 2;
  const z = (bounds.minZ + bounds.maxZ) / 2;
  const sky = 400;
  const hit = cast({ x, y: sky, z }, DOWN, sky + 100);
  const top = hit === null ? 0 : sky - hit;
  return { pivot: { x, y: top + WIDE_PIVOT_HEIGHT, z }, look: { x, y: top, z } };
}

/** Keeps the camera this far off a wall (> the camera's near plane, so it never sees inside). */
export const CAMERA_RADIUS = 0.28;

const scratchDir: V3 = { x: 0, y: 0, z: 0 };
const scratchNormal: V3 = { x: 0, y: 0, z: 0 };

/**
 * Pull a camera in front of any wall between the subject (`pivot`) and where the shot wants it
 * (`desired`): the free distance from the pivot, or the full one when nothing is in the way.
 * `out` receives the collided position (it may be `desired` itself). The wall always wins: hard
 * against one, the camera closes in on the subject rather than pass through (the local body
 * hides when the camera is that close).
 */
export function collideCamera(
  pivot: V3,
  desired: V3,
  cast: RayCast,
  out: V3,
  radius = CAMERA_RADIUS,
): number {
  const dx = desired.x - pivot.x;
  const dy = desired.y - pivot.y;
  const dz = desired.z - pivot.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) {
    set3(out, desired.x, desired.y, desired.z);
    return len;
  }
  set3(scratchDir, dx / len, dy / len, dz / len);
  // Unknown normal: treat the wall as square to the ray.
  set3(scratchNormal, -scratchDir.x, -scratchDir.y, -scratchDir.z);
  const hit = cast(pivot, scratchDir, len + radius / MIN_INCIDENCE, scratchNormal);
  // The margin is kept off the wall itself, not only along the ray: a wall met at a grazing
  // angle pulls the camera back further (the near plane's corners would reach it otherwise).
  const facing = -(
    scratchDir.x * scratchNormal.x +
    scratchDir.y * scratchNormal.y +
    scratchDir.z * scratchNormal.z
  );
  const back = radius / Math.max(MIN_INCIDENCE, facing);
  const free = hit === null ? len : Math.min(len, Math.max(0, hit - back));
  set3(
    out,
    pivot.x + scratchDir.x * free,
    pivot.y + scratchDir.y * free,
    pivot.z + scratchDir.z * free,
  );
  return free;
}

/**
 * Smooths the collided distance of a shot: a wall coming closer pulls the camera in at once
 * (it must never clip), a wall that clears lets it ease back out (no pop when a pillar passes).
 */
export class CollisionSmoother {
  private value = Number.POSITIVE_INFINITY;

  reset(): void {
    this.value = Number.POSITIVE_INFINITY;
  }

  /** The distance to use this frame, given the wall-free distance `limit` (and the wanted one). */
  update(limit: number, wanted: number, dt: number, tau = 0.35): number {
    const target = Math.min(limit, wanted);
    if (!Number.isFinite(this.value) || target <= this.value) this.value = target;
    else this.value += (target - this.value) * follow(dt, tau);
    return this.value;
  }
}

/**
 * A centripetal Catmull–Rom spline through camera keys (α = 0.5: no cusps or overshoot loops
 * between uneven keys), parametrised by chord length so the camera's speed stays even. Keys are
 * mutable (`setKey`; the last one can follow the player's eye every frame) and every buffer is
 * allocated once. The ends extend by reflection, so the path starts and ends on its keys.
 */
export class CameraSpline {
  private readonly keys: V3[];
  /** Cumulative chord length at each key. */
  private readonly cum: Float64Array;
  private readonly n: number;

  constructor(count: number) {
    if (count < 2) throw new Error('CameraSpline needs at least two keys');
    this.n = count;
    this.keys = Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0 }));
    this.cum = new Float64Array(count);
  }

  get count(): number {
    return this.n;
  }

  key(i: number): V3 {
    return this.keys[i]!;
  }

  setKey(i: number, x: number, y: number, z: number): void {
    set3(this.keys[i]!, x, y, z);
  }

  /** Recompute the chord lengths (after moving keys). */
  update(): void {
    this.cum[0] = 0;
    for (let i = 1; i < this.n; i++) {
      this.cum[i] = this.cum[i - 1]! + dist3(this.keys[i - 1]!, this.keys[i]!);
    }
  }

  get length(): number {
    return this.cum[this.n - 1]!;
  }

  /** The point at `u` ∈ [0, 1] of the path's length. */
  sample(u: number, out: V3): V3 {
    const total = this.length;
    const n = this.n;
    if (total < 1e-9) return set3(out, this.keys[0]!.x, this.keys[0]!.y, this.keys[0]!.z);
    const s = clamp01(u) * total;
    let i = 0;
    while (i < n - 2 && this.cum[i + 1]! < s) i++;
    const segLen = this.cum[i + 1]! - this.cum[i]!;
    const local = segLen > 1e-9 ? (s - this.cum[i]!) / segLen : 0;
    const p1 = this.keys[i]!;
    const p2 = this.keys[i + 1]!;
    const p0 = i > 0 ? this.keys[i - 1]! : null;
    const p3 = i + 2 < n ? this.keys[i + 2]! : null;
    // Phantom ends by reflection (p0 = 2·p1 − p2), per axis below.
    const q0x = p0 ? p0.x : 2 * p1.x - p2.x;
    const q0y = p0 ? p0.y : 2 * p1.y - p2.y;
    const q0z = p0 ? p0.z : 2 * p1.z - p2.z;
    const q3x = p3 ? p3.x : 2 * p2.x - p1.x;
    const q3y = p3 ? p3.y : 2 * p2.y - p1.y;
    const q3z = p3 ? p3.z : 2 * p2.z - p1.z;
    const t1 = knot(q0x, q0y, q0z, p1.x, p1.y, p1.z);
    const t2 = t1 + knot(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    const t3 = t2 + knot(p2.x, p2.y, p2.z, q3x, q3y, q3z);
    const t = t1 + (t2 - t1) * local;
    return set3(
      out,
      barryGoldman(q0x, p1.x, p2.x, q3x, t1, t2, t3, t),
      barryGoldman(q0y, p1.y, p2.y, q3y, t1, t2, t3, t),
      barryGoldman(q0z, p1.z, p2.z, q3z, t1, t2, t3, t),
    );
  }
}

/** Knot spacing: √(chord) (centripetal), never zero. */
function knot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.max(1e-4, Math.sqrt(Math.hypot(bx - ax, by - ay, bz - az)));
}

/** One axis of the Barry–Goldman pyramid (knots t0 = 0, t1, t2, t3; t ∈ [t1, t2]). */
function barryGoldman(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t1: number,
  t2: number,
  t3: number,
  t: number,
): number {
  const a1 = ((t1 - t) / t1) * p0 + (t / t1) * p1;
  const a2 = ((t2 - t) / (t2 - t1)) * p1 + ((t - t1) / (t2 - t1)) * p2;
  const a3 = ((t3 - t) / (t3 - t2)) * p2 + ((t - t2) / (t3 - t2)) * p3;
  const b1 = ((t2 - t) / t2) * a1 + (t / t2) * a2;
  const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
  return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
}
