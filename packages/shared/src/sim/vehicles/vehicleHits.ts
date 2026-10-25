/**
 * Vehicles in combat: the armoured hull as analytic boxes (rewindable like player hit volumes,
 * so lag compensation checks a shot against the truck the shooter saw), bullets stopping at it
 * like at a wall, blasts reaching it, and the truck as an obstacle players are pushed out of.
 */
import type { Vec3 } from '../../math/vec3.ts';
import type { WorldHit, WorldRaycaster } from '../hitscan.ts';
import { HULL_BOXES, TRUCK, type LocalBox } from './truckSpec.ts';
import { localToWorld, vehicleBasis, worldToLocal, type VehicleObstacle } from './vehicle.ts';

/** A vehicle's armour at one pose. */
export interface VehicleHull {
  id: number;
  pos: Vec3;
  basis: number[];
  /** A wreck still stops bullets but takes no more damage. */
  wreck?: boolean;
}

export function hullAt(
  id: number,
  pos: Vec3,
  yaw: number,
  pitch: number,
  roll: number,
  wreck = false,
): VehicleHull {
  return { id, pos: { ...pos }, basis: vehicleBasis(yaw, pitch, roll), wreck };
}

/** The hull as an obstacle on the ground (players are pushed out of it). */
export function hullObstacle(id: number, pos: Vec3, yaw: number): VehicleObstacle {
  return {
    id,
    x: pos.x,
    z: pos.z,
    yaw,
    hx: TRUCK.width / 2,
    hz: TRUCK.length / 2,
    y: pos.y,
    top: pos.y + TRUCK.height,
  };
}

/** Ray vs one local box (slab test, in the box's frame): entry distance + local normal. */
function rayBox(o: Vec3, d: Vec3, b: LocalBox, maxDist: number): { t: number; n: Vec3 } | null {
  let t0 = 0;
  let t1 = maxDist;
  let axis = -1;
  let sign = 0;
  const os = [o.x, o.y, o.z];
  const ds = [d.x, d.y, d.z];
  const mins = [b.min.x, b.min.y, b.min.z];
  const maxs = [b.max.x, b.max.y, b.max.z];
  for (let i = 0; i < 3; i++) {
    const oi = os[i]!;
    const di = ds[i]!;
    if (Math.abs(di) < 1e-12) {
      if (oi < mins[i]! || oi > maxs[i]!) return null;
      continue;
    }
    let a = (mins[i]! - oi) / di;
    let c = (maxs[i]! - oi) / di;
    let s = -1;
    if (a > c) {
      [a, c] = [c, a];
      s = 1;
    }
    if (a > t0) {
      t0 = a;
      axis = i;
      sign = s;
    }
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  if (axis < 0) return null; // starts inside: not a hit (shooting out of the bed)
  const n = { x: 0, y: 0, z: 0 };
  if (axis === 0) n.x = sign;
  else if (axis === 1) n.y = sign;
  else n.z = sign;
  return { t: t0, n };
}

/** First hit of a ray on a hull (distance, world normal), or null. */
export function rayHull(
  origin: Vec3,
  dir: Vec3,
  hull: VehicleHull,
  maxDist: number,
): { distance: number; normal: Vec3 } | null {
  const o = worldToLocal(hull.pos, hull.basis, origin);
  const zero = { x: 0, y: 0, z: 0 };
  const d0 = worldToLocal(zero, hull.basis, dir);
  // Quick reject: the ray never comes within the body's bounding sphere.
  const r = 3.2;
  const cy = 1;
  const ox = o.x;
  const oy = o.y - cy;
  const oz = o.z;
  const b = ox * d0.x + oy * d0.y + oz * d0.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  if (c > 0 && (b > 0 || b * b - c < 0)) return null;
  let best: { t: number; n: Vec3 } | null = null;
  for (const box of HULL_BOXES) {
    const h = rayBox(o, d0, box, best ? best.t : maxDist);
    if (h && (!best || h.t < best.t)) best = h;
  }
  if (!best) return null;
  const n = localToWorld(zero, hull.basis, best.n);
  return { distance: best.t, normal: n };
}

/** A world hit that may be a vehicle's hull (`vehicle` = its id). */
export type VehicleWorldHit = WorldHit & { vehicle?: number };

/**
 * The static world plus vehicle hulls for bullets and sight: the nearer of the two. Bullets stop
 * at the armour (a world hit carrying the vehicle's id, so the server damages it).
 */
export function withHulls(
  world: WorldRaycaster,
  hulls: readonly VehicleHull[],
): WorldRaycaster & { castRay(o: Vec3, d: Vec3, max: number): VehicleWorldHit | null } {
  if (!hulls.length) return world;
  return {
    castRay(origin: Vec3, dir: Vec3, maxDistance: number): VehicleWorldHit | null {
      const base = world.castRay(origin, dir, maxDistance);
      let best: VehicleWorldHit | null = base;
      let bestD = base ? base.distance : maxDistance;
      for (const h of hulls) {
        const hit = rayHull(origin, dir, h, bestD);
        if (!hit || hit.distance >= bestD) continue;
        bestD = hit.distance;
        best = {
          distance: hit.distance,
          point: {
            x: origin.x + dir.x * hit.distance,
            y: origin.y + dir.y * hit.distance,
            z: origin.z + dir.z * hit.distance,
          },
          normal: hit.normal,
          visible: true,
          surface: 'metal',
          vehicle: h.id,
        };
      }
      return best;
    },
  };
}

/** The point of the hull's bounding box nearest `p` (world): where a blast reaches it. */
export function hullClosestPoint(hull: VehicleHull, p: Vec3): Vec3 {
  const l = worldToLocal(hull.pos, hull.basis, p);
  const c = {
    x: Math.max(-TRUCK.width / 2, Math.min(TRUCK.width / 2, l.x)),
    y: Math.max(0.42, Math.min(TRUCK.height, l.y)),
    z: Math.max(-TRUCK.length / 2, Math.min(TRUCK.length / 2, l.z)),
  };
  return localToWorld(hull.pos, hull.basis, c);
}

/**
 * Push a standing body (feet, cylinder radius `r` and height) out of a vehicle's footprint: the
 * shortest horizontal move out, or null when clear (or above / below it).
 */
export function pushOutOfVehicle(
  feet: Vec3,
  r: number,
  height: number,
  o: VehicleObstacle,
): { x: number; z: number } | null {
  if (feet.y >= o.top || feet.y + height <= o.y + 0.05) return null;
  const sy = Math.sin(o.yaw);
  const cy = Math.cos(o.yaw);
  const dx = feet.x - o.x;
  const dz = feet.z - o.z;
  // Local: forward (sin, cos), left = (cos, -sin) (local +X).
  const lx = dx * cy - dz * sy;
  const lz = dx * sy + dz * cy;
  const ex = o.hx + r;
  const ez = o.hz + r;
  if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) return null;
  const px = ex - Math.abs(lx);
  const pz = ez - Math.abs(lz);
  let mx = 0;
  let mz = 0;
  if (px < pz) mx = lx >= 0 ? px : -px;
  else mz = lz >= 0 ? pz : -pz;
  // Back to world: local +X = (cos, -sin), local +Z = (sin, cos).
  return { x: mx * cy + mz * sy, z: -mx * sy + mz * cy };
}
