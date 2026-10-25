/**
 * Tyre slip for the trucks' dust and skid marks: pure maths, presentation only. Everything comes
 * from the vehicle state every client already draws (pose + velocity + yaw rate, interpolated for
 * remote trucks, predicted for our own), so remote trucks kick up the same dust: no wire fields.
 *
 * The sim (`shared/sim/vehicles/vehicle.ts`) bleeds sideways velocity at the tyres' grip, so in
 * normal cornering the body barely slides; with the handbrake the rear grip drops and the tail
 * swings out (sideways speed builds). Hard launches and hard braking show as a large change of
 * speed. Both are what a tyre does when it slips.
 */
import { VEHICLE, WHEEL_POS, type SurfaceKind, type Vec3, type WheelId } from '@wd/shared';
import { OVER_FLATS } from '../render/mapMesh.ts';

/** The state a frame of tyre effects reads (a subset of `VehicleMotion`). */
export interface SlipPose {
  pos: Vec3;
  vel: Vec3;
  /** Heading (rad): forward = (sin yaw, 0, cos yaw), + turns left. */
  yaw: number;
  /** Yaw rate (rad/s, + = left). */
  yawRate: number;
  grounded: boolean;
}

/** The body's slip this frame. */
export interface TruckSlip {
  /** Speed along the heading (m/s, + = forward). */
  forward: number;
  /** Sideways speed (m/s, + = to the right): the slide. */
  side: number;
  /**
   * Change of horizontal speed (m/s²): + speeding up (either way), − slowing. Speed, not the
   * forward component: in a drift the velocity turns away from the heading without braking.
   */
  accel: number;
  /** Horizontal speed (m/s). */
  speed: number;
  yawRate: number;
  /** On the ground and not a jump (respawn, correction, replay cut): emit nothing. */
  valid: boolean;
}

/** A frame moving the truck farther than its velocity explains by this much (m) is a cut. */
export const SLIP_CUT = 1.5;
/** Sideways speed at a wheel (m/s) below which it rolls cleanly / at which it slides fully. */
export const LAT_SLIP_START = 1.0;
export const LAT_SLIP_FULL = 4.0;
/** Speeding up (m/s²) where wheelspin starts / is full: a launch from a standstill is ~6.5. */
export const SPIN_START = 4.2;
export const SPIN_FULL = 9;
/**
 * Slowing (m/s²) where the wheels lock / are fully locked. The rear locks first (the handbrake,
 * 6 m/s², is rear-only); the service brake (13) and a crash lock all four. Coasting (1.8) never.
 */
export const REAR_LOCK_START = 4.5;
export const REAR_LOCK_FULL = 8;
export const FRONT_LOCK_START = 8;
export const FRONT_LOCK_FULL = 11.5;
/** The front wheels steer into a slide: they show this share of the rear's sideways slip. */
export const FRONT_LAT_SHARE = 0.45;
/**
 * Share of the yaw's swing at each axle that counts as slip. The sim pins its no-slip point
 * between the axles, so even clean cornering moves both axles sideways a little; only a hard
 * swing (the handbrake's turn-in, a spin) should read as tyres sliding.
 */
export const YAW_SWING_SLIP = 0.5;

/**
 * The body's slip from this frame's pose and the previous one. `pose.vel` is the sim's own
 * velocity (exact for our truck, interpolated for others); the change of speed gives the
 * longitudinal slip. A displacement the velocity can't explain (a respawn, a reconcile snap, a
 * kill-cam cut) or a bad `dt` is invalid: no dust, and skid ribbons restart.
 */
export function slipAmount(pose: SlipPose, prev: SlipPose, dt: number): TruckSlip {
  const fx = Math.sin(pose.yaw);
  const fz = Math.cos(pose.yaw);
  // Right = (−cos yaw, 0, sin yaw): left is +x at yaw 0 (`WHEEL_POS.fl.x` > 0).
  const forward = pose.vel.x * fx + pose.vel.z * fz;
  const side = -pose.vel.x * fz + pose.vel.z * fx;
  const speed = Math.hypot(pose.vel.x, pose.vel.z);
  const out: TruckSlip = { forward, side, accel: 0, speed, yawRate: pose.yawRate, valid: false };
  if (!(dt > 0) || !Number.isFinite(dt) || !pose.grounded) return out;
  const prevSpeed = Math.hypot(prev.vel.x, prev.vel.z);
  const moved = Math.hypot(
    pose.pos.x - prev.pos.x - pose.vel.x * dt,
    pose.pos.z - prev.pos.z - pose.vel.z * dt,
  );
  if (moved > SLIP_CUT || !Number.isFinite(moved)) return out;
  out.accel = (speed - prevSpeed) / dt;
  out.valid = true;
  return out;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Sideways speed of a wheel's contact patch (m/s, + = right): the body's slide plus the yaw
 * swinging that end round (ω × r: the front goes left in a left turn, the tail right).
 */
export function wheelSideSpeed(wheel: WheelId, side: number, yawRate: number): number {
  return side - yawRate * WHEEL_POS[wheel].z;
}

/**
 * How much one wheel slips, 0–1 (`accel` already smoothed by the caller). Normal cornering at the
 * grip limit leaves every wheel under `LAT_SLIP_START`; a handbrake drift slides the rear fully
 * and the front partly; a launch spins all four (4x4), the handbrake locks the rear and hard
 * braking all four.
 */
export function wheelSlip(wheel: WheelId, s: TruckSlip, accel = s.accel): number {
  if (!s.valid) return 0;
  const rear = WHEEL_POS[wheel].z < 0;
  const lateral =
    smoothstep(
      LAT_SLIP_START,
      LAT_SLIP_FULL,
      Math.abs(wheelSideSpeed(wheel, s.side, s.yawRate * YAW_SWING_SLIP)),
    ) * (rear ? 1 : FRONT_LAT_SHARE);
  const longitudinal =
    accel >= 0
      ? smoothstep(SPIN_START, SPIN_FULL, accel)
      : rear
        ? smoothstep(REAR_LOCK_START, REAR_LOCK_FULL, -accel)
        : smoothstep(FRONT_LOCK_START, FRONT_LOCK_FULL, -accel);
  return Math.min(1, Math.hypot(lateral, longitudinal));
}

/** Dust particles per second per wheel at full slip (High; Low halves it). */
export const DUST_RATE = 16;
/** Slip below this emits no dust; at or above `SKID_SLIP` the wheel also lays a skid mark. */
export const DUST_SLIP = 0.12;
export const SKID_SLIP = 0.3;

/** Dust particles per second for one wheel: more slip and more speed, more dust. */
export function dustRate(slip: number, speed: number, low = false): number {
  if (!(slip >= DUST_SLIP)) return 0;
  const bySpeed = 0.4 + 0.6 * Math.min(1, Math.max(0, speed) / 10);
  return DUST_RATE * Math.min(1, slip) * bySpeed * (low ? 0.5 : 1);
}

/**
 * Whole particles to spawn this frame from a running fraction (`carry` in [0, 1)): steady rates
 * at any frame rate, nothing lost between frames. At most `cap` per call (a hitch never bursts).
 */
export function emitCount(
  rate: number,
  dt: number,
  carry: number,
  cap = 6,
): { count: number; carry: number } {
  const total = carry + Math.max(0, rate) * Math.max(0, dt);
  const count = Math.min(cap, Math.floor(total));
  return { count, carry: count === cap ? 0 : total - count };
}

/**
 * Dust colour by the ground the wheel is on: paving/asphalt kick up a warm grey-beige grit that
 * suits golden hour; lawn and dirt (`soft`) a brown earth.
 */
export function groundDust(surface: SurfaceKind | undefined): readonly [number, number, number] {
  return surface === 'soft' ? SOIL_DUST : PAVING_DUST;
}
const PAVING_DUST = [0.74, 0.68, 0.58] as const;
const SOIL_DUST = [0.55, 0.43, 0.3] as const;

/**
 * Skid colour (linear) and peak opacity by ground: rubber on paving, a dark rut on soil. A mark
 * is laid at 0.8–1 of this (`skidOpacity`): denser where the wheel slides harder.
 */
export function skidInk(surface: SurfaceKind | undefined): {
  rgb: readonly [number, number, number];
  alpha: number;
} {
  return surface === 'soft' ? SOIL_RUT : RUBBER;
}
const RUBBER = { rgb: [0.012, 0.011, 0.011] as const, alpha: 0.7 };
const SOIL_RUT = { rgb: [0.06, 0.042, 0.027] as const, alpha: 0.66 };

/** Opacity a mark is laid at: 0.8 of the ground's peak at the skid threshold, full when sliding. */
export function skidOpacity(peak: number, slip: number): number {
  return peak * (0.8 + 0.2 * Math.min(1, Math.max(0, slip)));
}

/** Skid marks fade out over this long (s), starting at `SKID_FADE_FROM` of it. */
export const SKID_LIFE = 26;
export const SKID_FADE_FROM = 0.4;

/** Opacity factor of a skid mark `age` seconds old (mirrored by the skid shader). */
export function skidFade(age: number): number {
  if (!(age >= 0)) return age < 0 ? 1 : 0;
  return 1 - smoothstep(SKID_LIFE * SKID_FADE_FROM, SKID_LIFE, age);
}

/** Tyre width (m) and how much a sideways-sliding tyre smears beyond it (its contact length). */
export const TYRE_WIDTH = 0.28;
export const TYRE_SMEAR = 0.12;

/**
 * Half the width of a skid ribbon: the tyre's width when it rolls straight along its track, wider
 * as the travel turns across the wheel's heading (a sideways slide smears the contact patch).
 * `travel` = the wheel's motion this step (x, z), `heading` = the wheel's yaw.
 */
export function skidHalfWidth(travelX: number, travelZ: number, heading: number): number {
  const len = Math.hypot(travelX, travelZ);
  if (len < 1e-6) return TYRE_WIDTH / 2;
  const across = Math.abs((travelX * Math.cos(heading) - travelZ * Math.sin(heading)) / len);
  return (TYRE_WIDTH + TYRE_SMEAR * across) / 2;
}

/**
 * Height (y) at (x, z) of the plane through `p` with normal `n`: a ribbon edge sits on the
 * (lifted) ground plane under its contact, not level with it, so it hugs slopes and cambers.
 * Steeper than ~78° is treated as 78° (a wheel never lays a mark on a wall).
 */
export function planeHeight(
  px: number,
  py: number,
  pz: number,
  n: Vec3,
  x: number,
  z: number,
): number {
  return py - (n.x * (x - px) + n.z * (z - pz)) / Math.max(0.2, n.y);
}

/**
 * Whether ground found under a wheel is that wheel's own contact: `gap` = the ground's height
 * relative to the tyre's rest bottom (truck frame, m; < 0 below). Within the suspension's droop
 * below (plus a little) and a climbable lip above. A wheel hanging over a drop finds ground far
 * below with the down ray even while the truck is grounded on its other wheels: that is no
 * contact (no dust, no skid on the lower surface).
 */
export function inWheelReach(gap: number): boolean {
  return gap >= -(VEHICLE.droop + WHEEL_REACH_SLACK) && gap <= VEHICLE.maxStep + WHEEL_REACH_SLACK;
}
const WHEEL_REACH_SLACK = 0.06;

/** A ribbon point is laid every this far along the wheel's track (m). */
export const SKID_STEP = 0.3;
/** Pooled segments shared by every truck (~230 m of ribbon). */
export const SKID_CAPACITY = 768;
/** The ribbon sits this far above the ground along its normal (m), plus a polygon offset. */
export const SKID_LIFT = OVER_FLATS.lift;

/**
 * A ring of skid segments (one quad each) in flat typed arrays the GPU buffers wrap directly:
 * pushing past capacity overwrites the oldest; nothing is allocated after construction. Vertex
 * order per segment: start-left, start-right, end-left, end-right.
 */
export class SkidRing {
  readonly positions: Float32Array;
  /** RGBA per vertex (A = the mark's peak opacity; the shader fades it by age). */
  readonly colors: Float32Array;
  readonly uvs: Float32Array;
  /** Time each vertex was laid (s, the owner's clock). */
  readonly born: Float32Array;
  private cursor = 0;
  private used = 0;

  constructor(readonly capacity: number) {
    this.positions = new Float32Array(capacity * 12);
    this.colors = new Float32Array(capacity * 16);
    this.uvs = new Float32Array(capacity * 8);
    // Never laid: long dead.
    this.born = new Float32Array(capacity * 4).fill(-1e6);
  }

  /** Segments laid and still in the ring. */
  get count(): number {
    return this.used;
  }

  /** The slot the next push writes. */
  get next(): number {
    return this.cursor;
  }

  /**
   * Lay a segment from `quad` (12 numbers: start L, start R, end L, end R) with texture distance
   * `v0` → `v1` along the track. Returns the slot written.
   */
  push(
    quad: ArrayLike<number>,
    v0: number,
    v1: number,
    rgb: readonly [number, number, number],
    alpha: number,
    time: number,
  ): number {
    const i = this.cursor;
    for (let k = 0; k < 12; k++) this.positions[i * 12 + k] = quad[k]!;
    for (let k = 0; k < 4; k++) {
      const c = i * 16 + k * 4;
      this.colors[c] = rgb[0];
      this.colors[c + 1] = rgb[1];
      this.colors[c + 2] = rgb[2];
      this.colors[c + 3] = alpha;
      this.born[i * 4 + k] = time;
      this.uvs[i * 8 + k * 2] = k % 2;
      this.uvs[i * 8 + k * 2 + 1] = k < 2 ? v0 : v1;
    }
    this.cursor = (i + 1) % this.capacity;
    this.used = Math.min(this.capacity, this.used + 1);
    return i;
  }

  /** Seconds since slot `slot` was laid. */
  ageAt(slot: number, time: number): number {
    return time - this.born[slot * 4]!;
  }
}
