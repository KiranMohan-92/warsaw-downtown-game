import {
  withHulls,
  type WorldRaycaster,
  hullAt,
  hullObstacle,
  lerpAngle,
  motionFromWire,
  seatEyeHeight,
  seatFeet,
  VEHICLE_STATES,
  type SeatId,
  type Vec3,
  type SnapshotVehicle,
  type VehicleCondition,
  type VehicleHull,
  type VehicleMotion,
  type VehicleObstacle,
} from '@wd/shared';

/** A vehicle as drawn at one instant (interpolated between snapshots). */
export interface VehiclePose {
  id: number;
  motion: VehicleMotion;
  hp: number;
  condition: VehicleCondition;
}

interface Entry {
  t: number;
  motion: VehicleMotion;
  hp: number;
  condition: VehicleCondition;
}

/**
 * One vehicle's recent snapshots, sampled in the past on the same draw timeline as remote players
 * (and as the server rewinds it for shots): pose, steering and tilt blended, condition and health
 * from the nearer one, never blended across a respawn (a condition change). Past the newest it
 * moves on its velocity for at most `extrapolateMs`, then holds. Pure: time is passed in.
 */
export class VehicleTrack {
  private entries: Entry[] = [];
  constructor(
    readonly id: number,
    private readonly extrapolateMs = 150,
    private readonly capacity = 32,
  ) {}

  push(t: number, v: SnapshotVehicle): void {
    const motion = motionFromWire(v.m);
    if (!motion) return;
    const last = this.entries.at(-1);
    if (last && t <= last.t) return;
    const condition = VEHICLE_STATES[v.st] ?? 'active';
    this.entries.push({ t, motion, hp: Number.isFinite(v.hp) ? v.hp : 0, condition });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  newest(): Readonly<Entry> | undefined {
    return this.entries.at(-1);
  }

  sample(t: number): VehiclePose | null {
    const e = this.entries;
    const first = e[0];
    if (!first) return null;
    if (t <= first.t) return this.pose(first);
    for (let i = 1; i < e.length; i++) {
      const b = e[i]!;
      if (t > b.t) continue;
      const a = e[i - 1]!;
      const k = (t - a.t) / (b.t - a.t);
      if (a.condition !== b.condition) return this.pose(k < 0.5 ? a : b);
      const l = (x: number, y: number): number => x + (y - x) * k;
      const ma = a.motion;
      const mb = b.motion;
      const near = k < 0.5 ? a : b;
      return {
        id: this.id,
        motion: {
          pos: { x: l(ma.pos.x, mb.pos.x), y: l(ma.pos.y, mb.pos.y), z: l(ma.pos.z, mb.pos.z) },
          vel: { x: l(ma.vel.x, mb.vel.x), y: l(ma.vel.y, mb.vel.y), z: l(ma.vel.z, mb.vel.z) },
          yaw: lerpAngle(ma.yaw, mb.yaw, k),
          yawRate: l(ma.yawRate, mb.yawRate),
          steer: l(ma.steer, mb.steer),
          pitch: l(ma.pitch, mb.pitch),
          roll: l(ma.roll, mb.roll),
          grounded: near.motion.grounded,
        },
        hp: near.hp,
        condition: near.condition,
      };
    }
    const newest = e.at(-1)!;
    const p = this.pose(newest);
    const ahead = Math.min(t - newest.t, this.extrapolateMs) / 1000;
    if (ahead > 0 && newest.condition !== 'gone') {
      p.motion.pos.x += newest.motion.vel.x * ahead;
      p.motion.pos.z += newest.motion.vel.z * ahead;
      p.motion.yaw += newest.motion.yawRate * ahead;
    }
    return p;
  }

  prune(t: number): void {
    let keepFrom = 0;
    for (let i = 0; i < this.entries.length; i++) if (this.entries[i]!.t <= t) keepFrom = i;
    if (keepFrom > 0) this.entries.splice(0, keepFrom);
  }

  private pose(e: Entry): VehiclePose {
    const m = e.motion;
    return {
      id: this.id,
      motion: { ...m, pos: { ...m.pos }, vel: { ...m.vel } },
      hp: e.hp,
      condition: e.condition,
    };
  }
}

/** The obstacles a step meets (newest snapshot: what both sides know), reusing `out`. */
export function obstaclesOf(
  tracks: Iterable<VehicleTrack>,
  out: VehicleObstacle[] = [],
): VehicleObstacle[] {
  out.length = 0;
  for (const t of tracks) {
    const n = t.newest();
    if (!n || n.condition === 'gone') continue;
    out.push(hullObstacle(t.id, n.motion.pos, n.motion.yaw));
  }
  return out;
}

/**
 * The eye of a seat in a drawn truck (a passenger shoots from what it was drawn at; the server
 * rewinds the truck to the same view time), or null if that truck isn't drawn.
 */
export function seatEyeOf(
  poses: readonly VehiclePose[],
  seat: { vehicle: number; seat: SeatId },
): Vec3 | null {
  const v = poses.find((p) => p.id === seat.vehicle);
  if (!v) return null;
  const feet = seatFeet(v.motion, seat.seat);
  return { x: feet.x, y: feet.y + seatEyeHeight(seat.seat), z: feet.z };
}

/** Hulls as drawn (the predicted hit marker traces against these, as the server rewinds). */
/**
 * The trucks where this client draws them: the network poses, except the truck we drive, which
 * is where our own prediction has it (`motion`; the server's pose of it is a round trip late).
 * Rendering and every client query (frag flight, name-tag sight) take their poses from here.
 */
export function withOwnTruck(
  poses: readonly VehiclePose[],
  seat: { vehicle: number; seat: SeatId } | null | undefined,
  motion: VehicleMotion | undefined,
): VehiclePose[] {
  if (!seat || seat.seat !== 'driver' || !motion) return [...poses];
  return poses.map((p) => (p.id === seat.vehicle ? { ...p, motion } : p));
}

/**
 * The static world plus the trucks as drawn: what the client's rays meet (shots, its copy of
 * the frags' flight, name-tag sight) — the same armour the server's rays meet.
 */
export function withTrucks(world: WorldRaycaster, poses: readonly VehiclePose[]): WorldRaycaster {
  return withHulls(world, hullsOf(poses));
}

export function hullsOf(poses: readonly VehiclePose[]): VehicleHull[] {
  return poses
    .filter((p) => p.condition !== 'gone')
    .map((p) => {
      const m = p.motion;
      return hullAt(p.id, m.pos, m.yaw, m.pitch, m.roll, p.condition === 'wreck');
    });
}
