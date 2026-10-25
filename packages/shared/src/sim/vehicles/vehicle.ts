/**
 * Vehicle motion: an arcade kinematic model integrated by hand (no Rapier dynamic body, so no
 * hidden solver state): the driver's client and the server run this exact function on the same
 * inputs and the same static world, so driver prediction and re-simulation are exact.
 *
 * - Bicycle-model steering (speed-sensitive lock), yaw rate limited by tyre grip, sideways slip
 *   bled off by grip (the handbrake drops the rear's: drift).
 * - Throttle / brake / reverse on W/S, handbrake on Jump.
 * - Suspension: four wheel rays onto the map collision; the body follows the ground under the
 *   wheels on a damped spring (height, pitch, roll), climbing lips up to `VEHICLE.maxStep`.
 * - Collision: the body above the climbable step is swept as an oriented box against the static
 *   world (shape cast, slide along the wall), and rotation / lift never end inside geometry.
 *   Other vehicles are pushed out of as oriented rectangles.
 * - Props (`VEHICLE_IMPACT`): a light or medium one hit fast enough is broken through. The truck
 *   loses the momentum it hands over (deterministic, from the shared table) and passes on; what
 *   happens to the prop is the caller's (`VehicleProps.hit`: the server smashes or knocks it).
 */
import { VEHICLE, VEHICLE_IMPACT, type PropImpactSpec } from '../../config/tunables.ts';
import type { PropInstance } from '../../maps/propModels.ts';
import type { Quat } from '../../math/quat.ts';
import type { Vec3 } from '../../math/vec3.ts';
import type { WorldHit, WorldRaycaster } from '../hitscan.ts';
import { collisionBox, TRUCK, WHEEL_POS, WHEELS, type LocalBox } from './truckSpec.ts';

/** Props a query leaves out (by prop id). */
export type PropSkip = (prop: number) => boolean;

/** The static world as a vehicle needs it (implemented by `PhysicsWorld`). */
export interface VehicleWorld extends WorldRaycaster {
  castRay(origin: Vec3, dir: Vec3, maxDistance: number, skip?: PropSkip): WorldHit | null;
  /**
   * Sweep an oriented box (centre, rotation, half extents) by `disp` against static geometry:
   * the first hit as a fraction of `disp`, the contact normal (world, pointing out of the
   * obstacle) and point, and the prop hit (if one), or null. Boxes already touching while moving
   * out are not stopped.
   */
  castBox(
    center: Vec3,
    rot: Quat,
    half: Vec3,
    disp: Vec3,
    skip?: PropSkip,
  ): { toi: number; normal: Vec3; point?: Vec3; prop?: number } | null;
  /** True if the oriented box overlaps static geometry. */
  boxOverlaps(center: Vec3, rot: Quat, half: Vec3, skip?: PropSkip): boolean;
  /** A prop's current pose (absent: the world has no props). */
  prop?(id: number): PropInstance | undefined;
  /** Standing props resting on top of prop `id` (they go when it goes). */
  propsOnTop?(id: number): number[];
}

/** How a truck meets this prop instance: smash / knock (with its scaled mass), or null: solid. */
export function propImpact(inst: PropInstance): (PropImpactSpec & { mass: number }) | null {
  const spec = VEHICLE_IMPACT.props[inst.model];
  if (!spec) return null;
  const mass = spec.mass * inst.scale.x * inst.scale.y * inst.scale.z;
  if (spec.maxMass !== undefined && mass > spec.maxMass) return null;
  return { ...spec, mass };
}

/**
 * The truck's speed change along the contact normal for breaking through a prop of `mass` at
 * closing speed `into`: Δv = v·(1 + e)·m/(M + m).
 */
export const propSpeedLoss = (into: number, mass: number): number =>
  (into * (1 + VEHICLE_IMPACT.restitution) * mass) / (VEHICLE_IMPACT.truckMass + mass);

/** A prop a truck broke through this step. */
export interface PropHit {
  id: number;
  kind: 'smash' | 'knock';
  /** Scaled mass (kg) and the share of the launch it takes (`PropImpactSpec.shove`). */
  mass: number;
  shove: number;
  /** Closing speed along the contact normal (m/s) and that normal (horizontal, out of the prop). */
  into: number;
  normal: { x: number; z: number };
  /** The truck's velocity just before the hit, and the contact point (world). */
  vel: Vec3;
  point: Vec3;
  /** Props that stood on it and go with it (passed from now on; the server bursts or drops them). */
  carried: number[];
}

/** The props a truck's step can break (server: the match's; prediction: the client's guess). */
export interface VehicleProps {
  /** Props this truck already broke through and must pass (its sweeps and wheels skip them). */
  passed(id: number): boolean;
  /** It broke through one now. */
  hit(h: PropHit): void;
}

/** Everything that evolves (the wire carries all of it for the driver's reconcile). */
export interface VehicleMotion {
  /** Origin: on the ground between the axles. */
  pos: Vec3;
  vel: Vec3;
  /** Heading (rad): forward = (sin h, 0, cos h); + turns left. */
  yaw: number;
  /** Yaw rate (rad/s). */
  yawRate: number;
  /** Front wheel angle (rad, + = left). */
  steer: number;
  /** Nose-up pitch and left-side-up roll (rad), following the ground. */
  pitch: number;
  roll: number;
  /** At least one wheel on the ground within its travel. */
  grounded: boolean;
}

/** What the driver asks for this step (from `PlayerInput`). */
export interface DriveControls {
  /** -1 (brake / reverse) … 1 (throttle). */
  throttle: number;
  /** -1 (right) … 1 (left). */
  steer: number;
  handbrake: boolean;
}

export const NO_CONTROLS: DriveControls = { throttle: 0, steer: 0, handbrake: false };

/**
 * A vehicle as an obstacle on the ground: centre (x, z), heading, half extents, and the height
 * span (`y` = its ground, `top`) for players walking into it.
 */
export interface VehicleObstacle {
  id: number;
  x: number;
  z: number;
  yaw: number;
  hx: number;
  hz: number;
  y: number;
  top: number;
}

export function createVehicleMotion(pos: Vec3, yaw: number): VehicleMotion {
  return {
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    yawRate: 0,
    steer: 0,
    pitch: 0,
    roll: 0,
    grounded: true,
  };
}

export function cloneVehicleMotion(m: VehicleMotion): VehicleMotion {
  return { ...m, pos: { ...m.pos }, vel: { ...m.vel } };
}

/** Motion fields in wire order (`SnapshotVehicle.m`). */
export function motionToWire(m: VehicleMotion): number[] {
  return [
    m.pos.x,
    m.pos.y,
    m.pos.z,
    m.vel.x,
    m.vel.y,
    m.vel.z,
    m.yaw,
    m.yawRate,
    m.steer,
    m.pitch,
    m.roll,
    m.grounded ? 1 : 0,
  ];
}
export const MOTION_WIRE_LENGTH = 12;

/** Decode a wire motion (null if malformed). */
export function motionFromWire(a: readonly number[] | undefined): VehicleMotion | null {
  // (Untrusted wire data: check it is an array without letting `isArray` widen it to any[].)
  const raw: unknown = a;
  if (!a || !Array.isArray(raw) || a.length < MOTION_WIRE_LENGTH) return null;
  for (let i = 0; i < MOTION_WIRE_LENGTH; i++) if (!Number.isFinite(a[i])) return null;
  return {
    pos: { x: a[0]!, y: a[1]!, z: a[2]! },
    vel: { x: a[3]!, y: a[4]!, z: a[5]! },
    yaw: a[6]!,
    yawRate: a[7]!,
    steer: a[8]!,
    pitch: a[9]!,
    roll: a[10]!,
    grounded: a[11] === 1,
  };
}

/** Largest difference between two motions (m, m/s, rad); Infinity if grounded differs. */
export function motionError(a: VehicleMotion, b: VehicleMotion): number {
  if (a.grounded !== b.grounded) return Infinity;
  const wa = motionToWire(a);
  const wb = motionToWire(b);
  let e = 0;
  for (let i = 0; i < MOTION_WIRE_LENGTH; i++) e = Math.max(e, Math.abs(wa[i]! - wb[i]!));
  return e;
}

// ---- frames ----------------------------------------------------------------------------------

/** Rotation matrix (row-major 3×3) for heading, pitch (nose up), roll (left up). */
export function vehicleBasis(yaw: number, pitch: number, roll: number, out = new Array<number>(9)) {
  // R = Ry(yaw) · Rx(-pitch) · Rz(roll)
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(-pitch);
  const sp = Math.sin(-pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // Rx·Rz
  const a00 = cr;
  const a01 = -sr;
  const a02 = 0;
  const a10 = cp * sr;
  const a11 = cp * cr;
  const a12 = -sp;
  const a20 = sp * sr;
  const a21 = sp * cr;
  const a22 = cp;
  // Ry · (Rx·Rz)
  out[0] = cy * a00 + sy * a20;
  out[1] = cy * a01 + sy * a21;
  out[2] = cy * a02 + sy * a22;
  out[3] = a10;
  out[4] = a11;
  out[5] = a12;
  out[6] = -sy * a00 + cy * a20;
  out[7] = -sy * a01 + cy * a21;
  out[8] = -sy * a02 + cy * a22;
  return out;
}

/** Local point → world for a pose. */
export function localToWorld(
  pos: Vec3,
  basis: readonly number[],
  p: Vec3,
  out: Vec3 = { x: 0, y: 0, z: 0 },
): Vec3 {
  const b = basis;
  out.x = pos.x + b[0]! * p.x + b[1]! * p.y + b[2]! * p.z;
  out.y = pos.y + b[3]! * p.x + b[4]! * p.y + b[5]! * p.z;
  out.z = pos.z + b[6]! * p.x + b[7]! * p.y + b[8]! * p.z;
  return out;
}

/** World point → local for a pose. */
export function worldToLocal(pos: Vec3, basis: readonly number[], p: Vec3): Vec3 {
  const b = basis;
  const dx = p.x - pos.x;
  const dy = p.y - pos.y;
  const dz = p.z - pos.z;
  return {
    x: b[0]! * dx + b[3]! * dy + b[6]! * dz,
    y: b[1]! * dx + b[4]! * dy + b[7]! * dz,
    z: b[2]! * dx + b[5]! * dy + b[8]! * dz,
  };
}

/** Quaternion of `vehicleBasis` (for Rapier). */
export function basisQuat(b: readonly number[]): Quat {
  const m00 = b[0]!;
  const m11 = b[4]!;
  const m22 = b[8]!;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return { w: 0.25 * s, x: (b[7]! - b[5]!) / s, y: (b[2]! - b[6]!) / s, z: (b[3]! - b[1]!) / s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return { w: (b[7]! - b[5]!) / s, x: 0.25 * s, y: (b[1]! + b[3]!) / s, z: (b[2]! + b[6]!) / s };
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return { w: (b[2]! - b[6]!) / s, x: (b[1]! + b[3]!) / s, y: 0.25 * s, z: (b[5]! + b[7]!) / s };
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return { w: (b[3]! - b[1]!) / s, x: (b[2]! + b[6]!) / s, y: (b[5]! + b[7]!) / s, z: 0.25 * s };
}

export const forwardOf = (yaw: number): { x: number; z: number } => ({
  x: Math.sin(yaw),
  z: Math.cos(yaw),
});
/** The vehicle's right (local -X) in world. */
export const rightOf = (yaw: number): { x: number; z: number } => ({
  x: -Math.cos(yaw),
  z: Math.sin(yaw),
});

const COLLIDE: LocalBox = collisionBox(VEHICLE.maxStep);
const HALF: Vec3 = {
  x: (COLLIDE.max.x - COLLIDE.min.x) / 2,
  y: (COLLIDE.max.y - COLLIDE.min.y) / 2,
  z: (COLLIDE.max.z - COLLIDE.min.z) / 2,
};
const CENTRE_LOCAL: Vec3 = {
  x: (COLLIDE.max.x + COLLIDE.min.x) / 2,
  y: (COLLIDE.max.y + COLLIDE.min.y) / 2,
  z: (COLLIDE.max.z + COLLIDE.min.z) / 2,
};
/** Half extents of the body as an obstacle (x, z). */
export const BODY_HALF = { x: TRUCK.width / 2, z: TRUCK.length / 2 };

const basisScratch = new Array<number>(9);
const centreScratch: Vec3 = { x: 0, y: 0, z: 0 };

function bodyCentre(pos: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
  vehicleBasis(yaw, pitch, roll, basisScratch);
  return localToWorld(pos, basisScratch, CENTRE_LOCAL, centreScratch);
}

/** Does the collision body overlap static geometry at this pose? */
export function bodyOverlaps(
  world: VehicleWorld,
  pos: Vec3,
  yaw: number,
  pitch: number,
  roll: number,
  /** Extra width and length each side (m): route planning keeps a margin. */
  inflate = 0,
): boolean {
  const c = bodyCentre(pos, yaw, pitch, roll);
  const half = inflate ? { x: HALF.x + inflate, y: HALF.y, z: HALF.z + inflate } : HALF;
  return world.boxOverlaps({ ...c }, basisQuat(basisScratch), half);
}

const clampAbs = (v: number, m: number): number => Math.max(-m, Math.min(m, v));
const approach = (v: number, target: number, step: number): number =>
  v < target ? Math.min(target, v + step) : Math.max(target, v - step);

/**
 * Ground under one wheel: height, or null with nothing within reach. A prop the wheel lands on
 * that `crush` breaks (cartons, bags: below the body's sweep) is rolled through instead.
 */
function wheelGround(
  world: VehicleWorld,
  m: VehicleMotion,
  basis: readonly number[],
  local: Vec3,
  crush?: (hit: WorldHit) => boolean,
): number | null {
  // From inside the body (always clear of static geometry) straight down past the droop.
  const top = 1.0;
  const at = localToWorld(m.pos, basis, { x: local.x, y: top, z: local.z });
  const reach = top + VEHICLE.droop + 0.6;
  let hit = world.castRay(at, DOWN, reach);
  for (let i = 0; i < 3 && hit?.prop !== undefined && crush?.(hit); i++)
    hit = world.castRay(at, DOWN, reach);
  if (!hit || hit.normal.y < 0.5) return null;
  return hit.point.y;
}
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };
/** Off a wall after sliding into it (m): keeps the next sweep from starting in contact. */
const WALL_SEPARATION = 0.004;
/** Hits more nose-on than this (rad off the wall's line) don't turn the body. */
const WALL_ALIGN_MAX = 0.9;

export interface VehicleStepResult {
  /** Hit a wall this step (speed into it, m/s; 0 = none): audio/camera shake. */
  impact: number;
  /** The wheels just landed after a drop (vertical speed, m/s). */
  landed: number;
}

/**
 * Advance a vehicle by one fixed step. Deterministic given (motion, controls, dt, world,
 * obstacles). `obstacles` (other vehicles) are pushed out of; the vehicle never moves them.
 */
export function stepVehicle(
  m: VehicleMotion,
  c: DriveControls,
  dt: number,
  base: VehicleWorld,
  obstacles: readonly VehicleObstacle[] = [],
  selfId = -1,
  props?: VehicleProps,
): VehicleStepResult {
  const V = VEHICLE;
  // Props broken through this step (and before) are passed by every query below.
  const through: number[] = [];
  const skip: PropSkip | undefined = props
    ? (id) => through.includes(id) || props.passed(id)
    : undefined;
  const world: VehicleWorld = skip
    ? {
        castRay: (o, d, max) => base.castRay(o, d, max, skip),
        castBox: (ce, ro, h, d) => base.castBox(ce, ro, h, d, skip),
        boxOverlaps: (ce, ro, h) => base.boxOverlaps(ce, ro, h, skip),
      }
    : base;
  let breaks = 0;
  // A wheel rolling onto a prop it crushes (smash class, at speed): through it, as in a sweep.
  const crush =
    props &&
    ((hit: WorldHit): boolean => {
      const inst = base.prop?.(hit.prop!);
      const spec = inst && propImpact(inst);
      const speed = Math.hypot(m.vel.x, m.vel.z);
      if (!spec || spec.kind !== 'smash' || speed < spec.minSpeed || speed < 1e-3) return false;
      if (breaks >= VEHICLE_IMPACT.maxPerStep) return false;
      breaks++;
      const contact = { prop: hit.prop!, point: hit.point };
      // The wheel meets it head on: the normal against the motion.
      const n = { x: -m.vel.x / speed, y: 0, z: -m.vel.z / speed };
      return breakThrough(base, m, { ...contact, normal: n }, props, through, result);
    });
  const result: VehicleStepResult = { impact: 0, landed: 0 };
  const throttle = clampAbs(Number.isFinite(c.throttle) ? c.throttle : 0, 1);
  const steerIn = clampAbs(Number.isFinite(c.steer) ? c.steer : 0, 1);
  const f = forwardOf(m.yaw);
  const r = rightOf(m.yaw);
  let vf = m.vel.x * f.x + m.vel.z * f.z;
  let vr = m.vel.x * r.x + m.vel.z * r.z;
  const speed = Math.abs(vf);

  // Steering: speed-sensitive lock, the wheel turns at a finite rate (returns faster).
  const lockT = Math.min(1, speed / V.topSpeed);
  const lock = V.maxSteer + (V.minSteer - V.maxSteer) * lockT;
  const steerTarget = steerIn * lock;
  const rate = Math.abs(steerTarget) < Math.abs(m.steer) ? V.steerReturnRate : V.steerRate;
  m.steer = approach(m.steer, steerTarget, rate * dt);

  if (m.grounded) {
    // Longitudinal: throttle forward, brake when moving the other way, reverse from a stop.
    if (throttle > 0.05) {
      if (vf < -0.3) vf = approach(vf, 0, V.brakeDecel * throttle * dt);
      else {
        const fade = Math.max(0, 1 - (vf / V.topSpeed) ** 2);
        vf = Math.min(V.topSpeed, vf + V.accel * throttle * fade * dt);
      }
    } else if (throttle < -0.05) {
      if (vf > 0.3) vf = approach(vf, 0, V.brakeDecel * -throttle * dt);
      else {
        const fade = Math.max(0, 1 - (vf / V.reverseSpeed) ** 2);
        vf = Math.max(-V.reverseSpeed, vf + V.reverseAccel * throttle * fade * dt);
      }
    } else vf = approach(vf, 0, V.coastDecel * dt);
    if (c.handbrake) vf = approach(vf, 0, V.handbrakeDecel * dt);

    // Yaw: bicycle model, capped by the cornering limit; the handbrake swings the tail out.
    let yawTarget = (vf * Math.tan(m.steer)) / TRUCK.wheelbase;
    const cap = V.maxLateralAccel / Math.max(1, Math.abs(vf));
    yawTarget = clampAbs(yawTarget, cap);
    if (c.handbrake && Math.abs(vf) > 2) yawTarget *= V.handbrakeYaw;
    m.yawRate += (yawTarget - m.yawRate) * Math.min(1, V.yawResponse * dt);

    // Sideways slip: grip bleeds it off (less with the handbrake: the tail slides).
    const grip = V.lateralGrip * (c.handbrake ? V.handbrakeGrip : 1);
    vr = approach(vr, 0, grip * dt);
  } else {
    // Airborne: momentum only, the steering wheel still turns.
    m.yawRate *= Math.max(0, 1 - 2 * dt);
  }
  m.vel.x = f.x * vf + r.x * vr;
  m.vel.z = f.z * vf + r.z * vr;

  // ---- horizontal move: sweep the body, slide along walls ----
  vehicleBasis(m.yaw, m.pitch, m.roll, basisScratch);
  const rot = basisQuat(basisScratch);
  let dx = m.vel.x * dt;
  let dz = m.vel.z * dt;
  // Start clear (a correction or a respawn could leave the body touching): lift out first.
  depenetrate(world, m);
  for (let pass = 0; pass < 3 && dx * dx + dz * dz > 1e-10; pass++) {
    const centre = { ...bodyCentre(m.pos, m.yaw, m.pitch, m.roll) };
    const hit = world.castBox(centre, rot, HALF, { x: dx, y: 0, z: dz });
    if (!hit) {
      m.pos.x += dx;
      m.pos.z += dz;
      break;
    }
    if (
      props &&
      hit.prop !== undefined &&
      breaks < VEHICLE_IMPACT.maxPerStep &&
      breakThrough(base, m, hit as PropContact, props, through, result)
    ) {
      breaks++;
      pass--; // the same move again, past it
      continue;
    }
    const k = Math.max(0, hit.toi);
    m.pos.x += dx * k;
    m.pos.z += dz * k;
    // Slide: drop the remaining motion and the velocity into the wall (horizontal normal).
    let nx = hit.normal.x;
    let nz = hit.normal.z;
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-6) break;
    nx /= nl;
    nz /= nl;
    const into = -(m.vel.x * nx + m.vel.z * nz);
    if (into > 0) {
      result.impact = Math.max(result.impact, into);
      scrapeWall(m, nx, nz, into);
    }
    const restX = dx * (1 - k);
    const restZ = dz * (1 - k);
    const restInto = restX * nx + restZ * nz;
    // Slide along it, eased a hair off the wall: moving exactly parallel at the cast's skin
    // distance reads as a contact at once and would pin the body there.
    dx = restX - nx * restInto + nx * WALL_SEPARATION;
    dz = restZ - nz * restInto + nz * WALL_SEPARATION;
  }

  // ---- rotation: never into geometry ----
  const yawNext = m.yaw + m.yawRate * dt;
  if (bodyOverlaps(world, m.pos, yawNext, m.pitch, m.roll)) m.yawRate = 0;
  else m.yaw = wrapAngle(yawNext);

  // ---- suspension: wheels onto the ground, body follows on a damped spring ----
  vehicleBasis(m.yaw, m.pitch, m.roll, basisScratch);
  const support: number[] = [];
  let contacts = 0;
  for (const w of WHEELS) {
    const g = wheelGround(world, m, basisScratch, WHEEL_POS[w], crush);
    const resting = m.pos.y;
    if (g !== null && g >= resting - V.droop) {
      contacts++;
      support.push(g);
    } else support.push(resting - V.droop);
  }
  const [sfl, sfr, srl, srr] = support as [number, number, number, number];
  const target = (sfl + sfr + srl + srr) / 4;
  const wasGrounded = m.grounded;
  m.grounded = contacts > 0;
  const prevY = m.pos.y;
  if (m.grounded) {
    const a = V.spring * (target - m.pos.y) - V.damping * m.vel.y;
    m.vel.y += a * dt;
    if (!wasGrounded && m.vel.y < 0) {
      result.landed = -m.vel.y;
      m.vel.y *= 0.3; // tyres soak most of the drop
    }
    m.pos.y += m.vel.y * dt;
    // Never sink through the ground under the wheels.
    if (m.pos.y < target - 0.12) {
      m.pos.y = target - 0.12;
      m.vel.y = Math.max(0, m.vel.y);
    }
  } else {
    m.vel.y -= V.gravity * dt;
    m.pos.y += m.vel.y * dt;
  }
  // Tilt toward the ground plane under the wheels.
  const pitchT = clampAbs(
    Math.atan2((sfl + sfr) / 2 - (srl + srr) / 2, TRUCK.wheelbase),
    V.maxTilt,
  );
  const rollT = clampAbs(Math.atan2((sfl + srl) / 2 - (sfr + srr) / 2, TRUCK.track), V.maxTilt);
  const k = Math.min(1, V.tiltResponse * dt);
  const pitchNext = m.grounded ? m.pitch + (pitchT - m.pitch) * k : m.pitch;
  const rollNext = m.grounded ? m.roll + (rollT - m.roll) * k : m.roll;
  if (bodyOverlaps(world, m.pos, m.yaw, pitchNext, rollNext)) {
    // Lifting or tilting into something overhead (a canopy, a beam): hold the old pose.
    m.pos.y = prevY;
    m.vel.y = Math.min(0, m.vel.y);
  } else {
    m.pitch = pitchNext;
    m.roll = rollNext;
  }

  // ---- other vehicles: push ourselves out ----
  for (const o of obstacles) {
    if (o.id === selfId) continue;
    // Not level with us (the car park under the plaza): no contact, however they overlap in plan.
    if (o.top <= m.pos.y || o.y >= m.pos.y + TRUCK.height) continue;
    const push = obbPush(m.pos.x, m.pos.z, m.yaw, BODY_HALF.x, BODY_HALF.z, o);
    if (!push) continue;
    const moved = { x: push.x, z: push.z };
    if (
      !bodyOverlaps(
        world,
        { x: m.pos.x + moved.x, y: m.pos.y, z: m.pos.z + moved.z },
        m.yaw,
        m.pitch,
        m.roll,
      )
    ) {
      m.pos.x += moved.x;
      m.pos.z += moved.z;
    }
    const nl = Math.hypot(push.x, push.z);
    const nx = push.x / nl;
    const nz = push.z / nl;
    const into = -(m.vel.x * nx + m.vel.z * nz);
    if (into > 0) {
      result.impact = Math.max(result.impact, into);
      m.vel.x += nx * into;
      m.vel.z += nz * into;
    }
  }
  return result;
}

type PropContact = { prop: number; normal: Vec3; point?: Vec3 };

/**
 * A prop in the way: broken through if its class allows at this closing speed. The truck loses
 * the momentum it hands over along the normal; the prop is passed from now on.
 */
function breakThrough(
  world: VehicleWorld,
  m: VehicleMotion,
  hit: PropContact,
  props: VehicleProps,
  through: number[],
  result: VehicleStepResult,
): boolean {
  const inst = world.prop?.(hit.prop);
  const spec = inst && propImpact(inst);
  if (!spec) return false;
  let nx = hit.normal.x;
  let nz = hit.normal.z;
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-6) return false;
  nx /= nl;
  nz /= nl;
  const into = -(m.vel.x * nx + m.vel.z * nz);
  if (into < spec.minSpeed) return false;
  const vel = { ...m.vel };
  const loss = propSpeedLoss(into, spec.mass);
  m.vel.x += nx * loss;
  m.vel.z += nz * loss;
  result.impact = Math.max(result.impact, loss);
  through.push(hit.prop);
  const carried: number[] = [];
  // What stood on it goes with it (the server bursts or drops it: `MatchProps`): passed at
  // once, with no speed lost, on both sides — found before the hit changes the world.
  const stack = [hit.prop];
  while (stack.length) {
    for (const top of world.propsOnTop?.(stack.pop()!) ?? []) {
      if (through.includes(top)) continue;
      through.push(top);
      carried.push(top);
      stack.push(top);
    }
  }
  props.hit({
    id: hit.prop,
    kind: spec.kind,
    mass: spec.mass,
    shove: spec.shove ?? 1,
    into,
    normal: { x: nx, z: nz },
    vel,
    point: hit.point ?? { ...inst.pos },
    carried,
  });
  return true;
}

/**
 * Hit a wall with normal (nx, nz) at `into` m/s: the speed into it is gone, the speed along it
 * loses `wallScrape` × the impact, and the body turns to run along the wall (a glancing hit
 * straightens up and carries on instead of grinding its nose along it).
 */
function scrapeWall(m: VehicleMotion, nx: number, nz: number, into: number): void {
  m.vel.x += nx * into;
  m.vel.z += nz * into;
  const vt = Math.hypot(m.vel.x, m.vel.z);
  if (vt > 1e-6) {
    const keep = Math.max(0, vt - into * VEHICLE.wallScrape) / vt;
    m.vel.x *= keep;
    m.vel.z *= keep;
  }
  const f = forwardOf(m.yaw);
  // The tangent closest to the heading (driving or reversing along the wall).
  let tx = -nz;
  let tz = nx;
  if (tx * f.x + tz * f.z < 0) {
    tx = -tx;
    tz = -tz;
  }
  const angle = Math.atan2(f.z * tx - f.x * tz, f.x * tx + f.z * tz);
  // Glancing hits only: a nose-on hit stops the truck, it doesn't spin it round.
  if (Math.abs(angle) < WALL_ALIGN_MAX) {
    m.yawRate += angle * Math.min(into, 6) * VEHICLE.wallTurn;
  }
}

/** If the body starts inside geometry (a correction, a spawn), lift / shift it out. */
function depenetrate(world: VehicleWorld, m: VehicleMotion): void {
  if (!bodyOverlaps(world, m.pos, m.yaw, m.pitch, m.roll)) return;
  const f = forwardOf(m.yaw);
  const r = rightOf(m.yaw);
  const dirs = [
    { x: 0, z: 0 },
    { x: f.x, z: f.z },
    { x: -f.x, z: -f.z },
    { x: r.x, z: r.z },
    { x: -r.x, z: -r.z },
  ];
  for (const d of [0.1, 0.25, 0.5]) {
    for (const dir of dirs) {
      const lift = dir.x === 0 && dir.z === 0 ? d : 0;
      const p = { x: m.pos.x + dir.x * d, y: m.pos.y + lift, z: m.pos.z + dir.z * d };
      if (!bodyOverlaps(world, p, m.yaw, m.pitch, m.roll)) {
        m.pos = p;
        return;
      }
    }
  }
  // Level the body as a last resort (tilt into an overhang).
  if (!bodyOverlaps(world, m.pos, m.yaw, 0, 0)) {
    m.pitch = 0;
    m.roll = 0;
  }
}

export const wrapAngle = (a: number): number => {
  const t = Math.PI * 2;
  let x = a % t;
  if (x > Math.PI) x -= t;
  else if (x < -Math.PI) x += t;
  return x;
};

/**
 * Separating-axis test of two rectangles on the ground: the smallest push for rectangle A out of
 * B (world x, z), or null if they don't overlap.
 */
export function obbPush(
  ax: number,
  az: number,
  ayaw: number,
  ahx: number,
  ahz: number,
  b: VehicleObstacle,
): { x: number; z: number } | null {
  const axes = [rightOf(ayaw), forwardOf(ayaw), rightOf(b.yaw), forwardOf(b.yaw)];
  const dx = ax - b.x;
  const dz = az - b.z;
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  const projA = (n: { x: number; z: number }): number => {
    const ar = rightOf(ayaw);
    const af = forwardOf(ayaw);
    return Math.abs(ar.x * n.x + ar.z * n.z) * ahx + Math.abs(af.x * n.x + af.z * n.z) * ahz;
  };
  const projB = (n: { x: number; z: number }): number => {
    const br = rightOf(b.yaw);
    const bf = forwardOf(b.yaw);
    return Math.abs(br.x * n.x + br.z * n.z) * b.hx + Math.abs(bf.x * n.x + bf.z * n.z) * b.hz;
  };
  for (const n of axes) {
    const d = dx * n.x + dz * n.z;
    const overlap = projA(n) + projB(n) - Math.abs(d);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      const s = d >= 0 ? 1 : -1;
      bx = n.x * s * overlap;
      bz = n.z * s * overlap;
    }
  }
  return { x: bx, z: bz };
}

/** Controls from a player input: W/S throttle, A/D steer, Jump handbrake. */
export function controlsFromInput(moveX: number, moveZ: number, handbrake: boolean): DriveControls {
  // The move stick is limited to the unit disk (`sanitizeInput`): W+A arrives as (-0.71, 0.71).
  // Driving wants full throttle and full lock together, so the disk is mapped onto the square.
  const len = Math.hypot(moveX, moveZ);
  const big = Math.max(Math.abs(moveX), Math.abs(moveZ));
  const k = big > 1e-6 ? Math.min(1, len) / big : 0;
  return { throttle: moveZ * k, steer: -moveX * k, handbrake };
}

/** World heading → the yaw a player looks along it with (view forward = (-sin, -cos)). */
export const viewYawOf = (heading: number): number => wrapAngle(heading + Math.PI);
