import { DEG, type Vec3 } from './vec3.ts';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Quaternion from Euler angles in DEGREES, XYZ order (matches three.js default Euler order). */
export function quatFromEulerDeg(e: Vec3 | undefined): Quat {
  if (!e) return { x: 0, y: 0, z: 0, w: 1 };
  const c1 = Math.cos((e.x * DEG) / 2);
  const c2 = Math.cos((e.y * DEG) / 2);
  const c3 = Math.cos((e.z * DEG) / 2);
  const s1 = Math.sin((e.x * DEG) / 2);
  const s2 = Math.sin((e.y * DEG) / 2);
  const s3 = Math.sin((e.z * DEG) / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

/** Rotate vector v by quaternion q. */
export function rotateByQuat(v: Vec3, q: Quat): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/** Hamilton product a·b (apply b first, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Euler angles in DEGREES, XYZ order (three.js `Euler.setFromQuaternion(q, 'XYZ')`). */
export function eulerDegFromQuat(q: Quat): Vec3 {
  const { x, y, z, w } = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(Math.min(1, Math.max(-1, m13)));
  const out =
    Math.abs(m13) < 0.9999999
      ? { x: Math.atan2(-m23, m33), y: ry, z: Math.atan2(-m12, m11) }
      : { x: Math.atan2(m32, m22), y: ry, z: 0 };
  return { x: out.x / DEG, y: out.y / DEG, z: out.z / DEG };
}
