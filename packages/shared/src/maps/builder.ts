import { quatFromEulerDeg, rotateByQuat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { MapBox, MaterialId } from './types.ts';

type BoxOpts = Pick<MapBox, 'collide' | 'visible'>;

/** Axis-aligned box from min/max corners. */
export function boxMinMax(min: Vec3, max: Vec3, mat: MaterialId, opts: BoxOpts = {}): MapBox {
  return {
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    mat,
    ...opts,
  };
}

/** Box standing on y0 with footprint centred at (x, z). */
export function block(
  x: number,
  z: number,
  y0: number,
  w: number,
  h: number,
  d: number,
  mat: MaterialId,
  rotY = 0,
): MapBox {
  return {
    center: { x, y: y0 + h / 2, z },
    size: { x: w, y: h, z: d },
    mat,
    ...(rotY ? { rot: { x: 0, y: rotY, z: 0 } } : {}),
  };
}

export type Dir = '+x' | '-x' | '+z' | '-z';

/**
 * Sloped slab rising `rise` over horizontal `run` in direction `dir`, starting at (x, y0, z) on
 * the centreline. The TOP surface lies exactly on the slope line.
 */
export function ramp(
  start: Vec3,
  dir: Dir,
  run: number,
  rise: number,
  width: number,
  mat: MaterialId,
  opts: BoxOpts & { thickness?: number } = {},
): MapBox {
  const t = opts.thickness ?? 0.3;
  const angle = (Math.atan2(rise, run) * 180) / Math.PI;
  const hyp = Math.hypot(run, rise);
  const alongX = dir === '+x' || dir === '-x';
  const sign = dir === '+x' || dir === '+z' ? 1 : -1;
  // Rotation that tilts the run axis upward in the travel direction.
  const rot = alongX ? { x: 0, y: 0, z: sign * angle } : { x: -sign * angle, y: 0, z: 0 };
  const normal = rotateByQuat({ x: 0, y: 1, z: 0 }, quatFromEulerDeg(rot));
  const topMid = {
    x: start.x + (alongX ? (sign * run) / 2 : 0),
    y: start.y + rise / 2,
    z: start.z + (alongX ? 0 : (sign * run) / 2),
  };
  return {
    center: {
      x: topMid.x - (normal.x * t) / 2,
      y: topMid.y - (normal.y * t) / 2,
      z: topMid.z - (normal.z * t) / 2,
    },
    size: alongX ? { x: hyp, y: t, z: width } : { x: width, y: t, z: hyp },
    rot,
    mat,
    collide: opts.collide ?? true,
    visible: opts.visible ?? true,
  };
}

/**
 * Staircase: visible solid steps plus an invisible collision ramp through the step nosings, so
 * the capsule glides up smoothly instead of bumping over every step.
 */
export function stairs(
  start: Vec3,
  dir: Dir,
  run: number,
  rise: number,
  width: number,
  mat: MaterialId,
): MapBox[] {
  const n = Math.max(2, Math.ceil(rise / 0.19));
  const h = rise / n;
  const d = run / n;
  const alongX = dir === '+x' || dir === '-x';
  const sign = dir === '+x' || dir === '+z' ? 1 : -1;
  const out: MapBox[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * d;
    const b = (i + 1) * d;
    const lo = alongX ? start.x + sign * a : start.z + sign * a;
    const hi = alongX ? start.x + sign * b : start.z + sign * b;
    const minRun = Math.min(lo, hi);
    const maxRun = Math.max(lo, hi);
    out.push(
      alongX
        ? boxMinMax(
            { x: minRun, y: start.y, z: start.z - width / 2 },
            { x: maxRun, y: start.y + (i + 1) * h, z: start.z + width / 2 },
            mat,
          )
        : boxMinMax(
            { x: start.x - width / 2, y: start.y, z: minRun },
            { x: start.x + width / 2, y: start.y + (i + 1) * h, z: maxRun },
            mat,
          ),
    );
  }
  // Ramp through the nosings: from one step before the first riser up to the last step's front.
  const back = alongX ? { x: -sign * d, y: 0, z: 0 } : { x: 0, y: 0, z: -sign * d };
  out.push(
    ramp({ x: start.x + back.x, y: start.y, z: start.z + back.z }, dir, n * d, rise, width, mat, {
      visible: false,
      thickness: 0.1,
    }),
  );
  return out;
}

export interface Opening {
  /** Offset along the wall from its start (m). */
  from: number;
  to: number;
  /** Height of the opening's bottom/top above the wall base. */
  bottom: number;
  top: number;
}

/**
 * Straight wall from `a` to `b` (must be axis-aligned: same x or same z) with rectangular
 * openings (doors, windows). Emits wall pieces around each opening.
 */
export function wall(
  a: { x: number; z: number },
  b: { x: number; z: number },
  y0: number,
  height: number,
  thickness: number,
  mat: MaterialId,
  openings: Opening[] = [],
): MapBox[] {
  const alongX = a.z === b.z;
  if (!alongX && a.x !== b.x) throw new Error('wall() must be axis-aligned');
  const s0 = alongX ? Math.min(a.x, b.x) : Math.min(a.z, b.z);
  const s1 = alongX ? Math.max(a.x, b.x) : Math.max(a.z, b.z);
  const fixed = alongX ? a.z : a.x;
  const piece = (u0: number, u1: number, v0: number, v1: number): MapBox | null => {
    if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return null;
    return alongX
      ? boxMinMax(
          { x: s0 + u0, y: y0 + v0, z: fixed - thickness / 2 },
          { x: s0 + u1, y: y0 + v1, z: fixed + thickness / 2 },
          mat,
        )
      : boxMinMax(
          { x: fixed - thickness / 2, y: y0 + v0, z: s0 + u0 },
          { x: fixed + thickness / 2, y: y0 + v1, z: s0 + u1 },
          mat,
        );
  };
  const len = s1 - s0;
  const sorted = [...openings].sort((p, q) => p.from - q.from);
  const out: (MapBox | null)[] = [];
  let cursor = 0;
  for (const o of sorted) {
    out.push(piece(cursor, o.from, 0, height));
    out.push(piece(o.from, o.to, 0, o.bottom));
    out.push(piece(o.from, o.to, o.top, height));
    cursor = o.to;
  }
  out.push(piece(cursor, len, 0, height));
  return out.filter((p): p is MapBox => p !== null);
}
