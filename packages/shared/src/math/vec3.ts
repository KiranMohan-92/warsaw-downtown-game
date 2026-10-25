/** Minimal allocation-light vector math for the shared sim (no three.js dependency). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a);
  return l > 1e-9 ? scale3(a, 1 / l) : vec3();
};
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const DEG = Math.PI / 180;
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Shortest-arc blend between two angles (radians). Client interpolation and the server's
 * lag-compensation rewind both use it, so a rewound facing is the one the shooter saw.
 */
export function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/** Move `current` toward `target` by at most `maxDelta`. */
export const approach = (current: number, target: number, maxDelta: number): number =>
  current < target ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta);

/**
 * View direction from yaw/pitch (radians). Convention: yaw 0 looks down -Z (three.js camera
 * default), positive yaw turns left (counter-clockwise seen from above), positive pitch looks up.
 */
export function viewDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Horizontal forward/right basis for movement from yaw. */
export function yawBasis(yaw: number): { forward: Vec3; right: Vec3 } {
  return {
    forward: { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) },
    right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
  };
}
