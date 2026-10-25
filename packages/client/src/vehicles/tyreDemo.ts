/**
 * The tyre demo (`__wd.tyreDemo`, autotest/dev only): a presentation-only ghost truck driven by
 * the shared vehicle step on the client's own physics world through a fixed script, so tyre dust
 * and skid marks can be graded on camera. It feeds only the trucks' view: never the sim, the
 * server or the network. Pure script + bookkeeping here; `Game` steps it.
 */
import {
  createVehicleMotion,
  SIM_DT,
  stepVehicle,
  type DriveControls,
  type VehicleMotion,
  type VehicleWorld,
} from '@wd/shared';

export type TyreDemoPhase = 'launch' | 'drift' | 'straighten' | 'brake' | 'coast' | 'done';

/** Phase lengths after the launch (s). */
const DRIFT = 1.5;
const STRAIGHTEN = 0.8;
const BRAKE = 1.2;
const COAST = 2;
/** Launch length for a run placed by hand (s). */
export const DEFAULT_LAUNCH = 2.5;
/** The camera-relative run: start this far ahead of / to the left of the camera (m). */
export const FRONT_AHEAD = 14;
export const FRONT_LEFT = 10;
/** Launch length for the camera-relative run: the drift starts near the middle of the view. */
export const FRONT_LAUNCH = 1.9;
/** Below this speed (m/s) 0.6 s into a throttle phase (launch, straighten), the run is blocked. */
const BLOCKED_SPEED = 1;

export function tyreDemoPhase(t: number, launch: number): TyreDemoPhase {
  if (t < launch) return 'launch';
  if (t < launch + DRIFT) return 'drift';
  if (t < launch + DRIFT + STRAIGHTEN) return 'straighten';
  if (t < launch + DRIFT + STRAIGHTEN + BRAKE) return 'brake';
  if (t < launch + DRIFT + STRAIGHTEN + BRAKE + COAST) return 'coast';
  return 'done';
}

const CONTROLS: Record<TyreDemoPhase, DriveControls> = {
  launch: { throttle: 1, steer: 0, handbrake: false },
  // Steer left on the handbrake: seen from the side, the tail swings toward the camera.
  drift: { throttle: 0.6, steer: 1, handbrake: true },
  straighten: { throttle: 1, steer: 0, handbrake: false },
  brake: { throttle: -1, steer: 0, handbrake: false },
  coast: { throttle: 0, steer: 0, handbrake: false },
  done: { throttle: 0, steer: 0, handbrake: false },
};

/**
 * The camera-relative start: `FRONT_AHEAD` m along the camera's horizontal forward and
 * `FRONT_LEFT` m to its left, heading to the camera's right (across the view, left to right).
 * `forward` = the camera's view direction (any length, y ignored).
 */
export function frontStart(
  camera: { x: number; z: number },
  forward: { x: number; z: number },
): { x: number; z: number; yaw: number } {
  const len = Math.hypot(forward.x, forward.z) || 1;
  const fx = forward.x / len;
  const fz = forward.z / len;
  // Right of the view = forward × up.
  const rx = -fz;
  const rz = fx;
  return {
    x: camera.x + fx * FRONT_AHEAD - rx * FRONT_LEFT,
    z: camera.z + fz * FRONT_AHEAD - rz * FRONT_LEFT,
    // Truck forward = (sin yaw, cos yaw) = the view's right.
    yaw: Math.atan2(rx, rz),
  };
}

export interface TyreDemoState {
  phase: TyreDemoPhase;
  /** Seconds since the start. */
  t: number;
  /** Horizontal speed (m/s). */
  speed: number;
  pos: { x: number; y: number; z: number };
  /** The truck stopped against something while the script was driving it. */
  blocked: boolean;
}

/** One ghost run: fixed-step script over the shared vehicle step. */
export class TyreDemoRun {
  readonly motion: VehicleMotion;
  t = 0;
  blocked = false;
  private acc = 0;

  constructor(
    x: number,
    y: number,
    z: number,
    yaw: number,
    readonly launch = DEFAULT_LAUNCH,
  ) {
    this.motion = createVehicleMotion({ x, y, z }, yaw);
  }

  get phase(): TyreDemoPhase {
    return tyreDemoPhase(this.t, this.launch);
  }

  /** Advance by a render frame's `dt` (fixed sim steps inside). */
  step(dt: number, world: VehicleWorld): void {
    this.acc += Math.min(Math.max(0, dt), 0.1);
    while (this.acc >= SIM_DT && this.phase !== 'done') {
      this.acc -= SIM_DT;
      this.t += SIM_DT;
      const phase = this.phase;
      stepVehicle(this.motion, CONTROLS[phase], SIM_DT, world);
      const speed = Math.hypot(this.motion.vel.x, this.motion.vel.z);
      // Under throttle without the handbrake, half a second into the phase (the handbrake may
      // legitimately slide it to a stop; the straighten then pulls away from rest).
      const since = phase === 'launch' ? this.t : this.t - (this.launch + DRIFT);
      const driving = phase === 'launch' || phase === 'straighten';
      if (driving && since > 0.6 && speed < BLOCKED_SPEED) this.blocked = true;
    }
  }

  state(): TyreDemoState {
    const m = this.motion;
    return {
      phase: this.phase,
      t: this.t,
      speed: Math.hypot(m.vel.x, m.vel.z),
      pos: { ...m.pos },
      blocked: this.blocked,
    };
  }
}
