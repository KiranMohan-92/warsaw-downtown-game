import type { Vec3, WorldHit, WorldRaycaster } from '@wd/shared';

export interface DebrisBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  settled: boolean;
  collide: boolean;
  planeNx: number;
  planeNy: number;
  planeNz: number;
  planeD: number;
  /** The last surface it bounced off (written on every bounce; persistent chunks rest on it). */
  hitNx?: number;
  hitNy?: number;
  hitNz?: number;
}

export interface DebrisMotionOptions {
  gravity: number;
  radius: number;
  restitution: number;
  tangentDamping: number;
  settleSpeed: number;
  maxDt: number;
}

const EPS = 1e-5;
const scratchDir: Vec3 = { x: 0, y: 0, z: 0 };

export function sourcePlane(
  point: Vec3,
  normal: Vec3,
): {
  nx: number;
  ny: number;
  nz: number;
  d: number;
} {
  const len = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const nx = normal.x / len;
  const ny = normal.y / len;
  const nz = normal.z / len;
  return { nx, ny, nz, d: nx * point.x + ny * point.y + nz * point.z };
}

export function stepDebrisBody(
  p: DebrisBody,
  dt: number,
  world: WorldRaycaster | null,
  opt: DebrisMotionOptions,
): boolean {
  if (!Number.isFinite(dt) || dt <= 0 || p.settled) return false;
  const step = Math.min(dt, opt.maxDt);
  p.vy -= opt.gravity * step;
  const dx = p.vx * step;
  const dy = p.vy * step;
  const dz = p.vz * step;
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len <= EPS) return false;

  if (world && p.collide) {
    scratchDir.x = dx / len;
    scratchDir.y = dy / len;
    scratchDir.z = dz / len;
    const hit = world.castRay(p, scratchDir, len + opt.radius);
    if (hit && hit.distance <= len + opt.radius) {
      bounceFromHit(p, hit, opt);
      return true;
    }
  }

  p.x += dx;
  p.y += dy;
  p.z += dz;
  keepOutsideSourcePlane(p, opt);
  return false;
}

function bounceFromHit(p: DebrisBody, hit: WorldHit, opt: DebrisMotionOptions): void {
  const n = hit.normal;
  p.hitNx = n.x;
  p.hitNy = n.y;
  p.hitNz = n.z;
  p.x = hit.point.x + n.x * opt.radius;
  p.y = hit.point.y + n.y * opt.radius;
  p.z = hit.point.z + n.z * opt.radius;

  const vn = p.vx * n.x + p.vy * n.y + p.vz * n.z;
  const tx = p.vx - vn * n.x;
  const ty = p.vy - vn * n.y;
  const tz = p.vz - vn * n.z;
  const away = Math.max(0, -vn) * opt.restitution;
  p.vx = tx * opt.tangentDamping + n.x * away;
  p.vy = ty * opt.tangentDamping + n.y * away;
  p.vz = tz * opt.tangentDamping + n.z * away;

  if (Math.hypot(p.vx, p.vy, p.vz) < opt.settleSpeed && n.y > 0.55) {
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.settled = true;
  }
}

function keepOutsideSourcePlane(p: DebrisBody, opt: DebrisMotionOptions): void {
  const behind = p.x * p.planeNx + p.y * p.planeNy + p.z * p.planeNz - p.planeD;
  if (behind >= opt.radius) return;
  const push = opt.radius - behind;
  p.x += p.planeNx * push;
  p.y += p.planeNy * push;
  p.z += p.planeNz * push;
  const vn = p.vx * p.planeNx + p.vy * p.planeNy + p.vz * p.planeNz;
  if (vn < 0) {
    p.vx -= p.planeNx * vn * (1 + opt.restitution * 0.35);
    p.vy -= p.planeNy * vn * (1 + opt.restitution * 0.35);
    p.vz -= p.planeNz * vn * (1 + opt.restitution * 0.35);
  }
}
