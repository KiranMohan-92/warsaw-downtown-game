import { MOVEMENT, PLAYER, PRONE, SKATEBOARD, SLIDE, TAC_SPRINT } from '../config/tunables.ts';
import type { TraversalState } from './traversal.ts';
import { approach, yawBasis, type Vec3 } from '../math/vec3.ts';
import { Button, isDown, pressed, type PlayerInput } from './input.ts';

/** Movement-relevant part of a player's state. Plain data: cloneable for prediction replay. */
export interface MoveState {
  /** Feet position (bottom of the capsule). */
  pos: Vec3;
  vel: Vec3;
  grounded: boolean;
  crouched: boolean;
  sprinting: boolean;
  /** Sprinting bent over (Sprint + Crouch held): slower, lower, quieter than a full sprint. */
  lowRun: boolean;
  /** Smoothed camera height above feet. */
  eyeHeight: number;
  coyoteTimer: number;
  jumpBufferTimer: number;
  landingSlowTimer: number;
  strideAccum: number;
  /** Active climb/vault (movement is scripted along its path until it ends). */
  traversal: TraversalState | null;
  /** Riding the skateboard (granted by the match's board rules; a respawn clears it). */
  board: boolean;
  /** Lying on the stomach (Prone button): crawl, steady aim, low target. */
  prone: boolean;
  /** Sliding (Crouch pressed on a sprint): crouch capsule, momentum decays, weak steering. */
  sliding: boolean;
  /** Seconds into the current slide (0 until its first step launches it). */
  slideTime: number;
  /** Seconds until the next slide may start. */
  slideCooldown: number;
  /** A Crouch press in the air on a sprint jump: slide on touchdown while this runs (s). */
  slideBuffer: number;
  /** Tactical sprint burst (implies `sprinting`): faster, weapon held low (`TAC_SPRINT`). */
  tacSprint: boolean;
  /** Tactical sprint tank, 0–1 (1 = a full `TAC_SPRINT.duration`). */
  tacFuel: number;
  /** Seconds until the tank starts refilling after a burst. */
  tacDelay: number;
  /**
   * Jetpack (`sim/jetpack.ts` `JetMode`): 0 none, 1 worn (not ignited), 2 flying, 3 out of fuel
   * (the drop). Granted by the match's jetpack rules; a respawn clears it.
   */
  jet: number;
  /** Flight seconds left (`JETPACK.flightTime` when worn; counts down from ignition). */
  jetFuel: number;
  /** Thrusting (Jump held in flight) this step: exhaust, sound, others see it. */
  jetThrust: boolean;
}

export const createMoveState = (pos: Vec3): MoveState => ({
  pos: { ...pos },
  vel: { x: 0, y: 0, z: 0 },
  grounded: false,
  crouched: false,
  sprinting: false,
  lowRun: false,
  eyeHeight: PLAYER.standEyeHeight,
  coyoteTimer: 0,
  jumpBufferTimer: 0,
  landingSlowTimer: 0,
  strideAccum: 0,
  traversal: null,
  board: false,
  prone: false,
  sliding: false,
  slideTime: 0,
  slideCooldown: 0,
  slideBuffer: 0,
  tacSprint: false,
  tacFuel: 1,
  tacDelay: 0,
  jet: 0,
  jetFuel: 0,
  jetThrust: false,
});

export interface MoveModifiers {
  /** 0 = hip, 1 = fully aimed. */
  adsAmount: number;
  /** Weapon actions (firing, ADS) that forbid sprinting this step. */
  sprintBlocked: boolean;
  /** Held-weapon mobility (e.g. knife is lighter than a rifle). Default 1. */
  speedMultiplier?: number;
}

export const jumpVelocity = (): number => Math.sqrt(2 * MOVEMENT.gravity * MOVEMENT.jumpHeight);

/**
 * Skateboard physics: forward pushes up to cruise speed (and carves the board toward where you
 * look), back brakes, nothing coasts — so you can ride one way and look/shoot another; strafe
 * keys carve. Turning is limited by grip (wide at speed, tight when slow); jump is an ollie. No
 * sprint, crouch or low run. Slopes, bumps and wall scrapes are applied after the move
 * (stepPlayer). (Timers were already updated by the caller.)
 */
function rideBoard(s: MoveState, input: PlayerInput, dt: number): boolean {
  s.sprinting = false;
  s.lowRun = false;
  const { forward } = yawBasis(input.yaw);
  const look = Math.atan2(forward.x, forward.z);
  let speed = Math.hypot(s.vel.x, s.vel.z);
  let heading = speed > 1e-3 ? Math.atan2(s.vel.x, s.vel.z) : look;
  if (s.grounded) {
    if (input.moveZ > 0)
      speed = Math.min(SKATEBOARD.cruiseSpeed, speed + SKATEBOARD.pushAccel * input.moveZ * dt);
    else if (input.moveZ < 0)
      speed = Math.max(0, speed - SKATEBOARD.brakeDecel * -input.moveZ * dt);
    else speed = Math.max(0, speed - SKATEBOARD.coastDecel * dt);
    // Faster than cruise (walking pace carried in, a drop): bleed it off.
    if (speed > SKATEBOARD.cruiseSpeed)
      speed = Math.max(SKATEBOARD.cruiseSpeed, speed - SKATEBOARD.brakeDecel * dt);
  }
  const pushing = input.moveZ > 0;
  if (speed < SKATEBOARD.pivotSpeed) {
    // Kicking off: the board points where you look.
    if (pushing) heading = look;
  } else {
    const grip = Math.min(SKATEBOARD.turnRate, SKATEBOARD.lateralAccel / speed);
    const rate = (s.grounded ? grip : SKATEBOARD.airTurnRate) * dt;
    let turn = 0;
    if (pushing) turn = Math.atan2(Math.sin(look - heading), Math.cos(look - heading));
    // Strafe keys carve (right = clockwise from above = heading decreasing).
    turn -= input.moveX * rate;
    heading += Math.max(-rate, Math.min(rate, turn));
  }
  s.vel.x = Math.sin(heading) * speed;
  s.vel.z = Math.cos(heading) * speed;

  let jumped = false;
  if (s.jumpBufferTimer > 0 && (s.grounded || s.coyoteTimer > 0)) {
    s.vel.y = jumpVelocity();
    s.jumpBufferTimer = 0;
    s.coyoteTimer = 0;
    s.grounded = false;
    jumped = true;
  }
  s.vel.y = Math.max(-MOVEMENT.maxFallSpeed, s.vel.y - MOVEMENT.gravity * dt);
  s.eyeHeight = approach(s.eyeHeight, PLAYER.standEyeHeight, PLAYER.eyeHeightSpeed * dt);
  return jumped;
}

/** Max horizontal speed for the current stance and modifiers. */
export function targetSpeed(s: MoveState, input: PlayerInput, mods: MoveModifiers): number {
  let speed = s.prone
    ? PRONE.crawlSpeed
    : s.crouched
      ? MOVEMENT.crouchSpeed
      : s.sprinting
        ? s.lowRun
          ? MOVEMENT.lowRunSpeed
          : s.tacSprint
            ? TAC_SPRINT.speed
            : MOVEMENT.sprintSpeed
        : MOVEMENT.walkSpeed;
  if (!s.sprinting && input.moveZ < 0) speed *= MOVEMENT.backpedalMultiplier;
  speed *= 1 + (MOVEMENT.adsSpeedMultiplier - 1) * mods.adsAmount;
  if (s.landingSlowTimer > 0) speed *= MOVEMENT.landingSlowMultiplier;
  return speed * (mods.speedMultiplier ?? 1);
}

/** Camera height the current stance eases toward. */
export const stanceEyeHeight = (s: MoveState): number =>
  s.prone
    ? PLAYER.proneEyeHeight
    : s.sliding
      ? SLIDE.eyeHeight
      : s.crouched
        ? PLAYER.crouchEyeHeight
        : s.lowRun
          ? PLAYER.lowRunEyeHeight
          : PLAYER.standEyeHeight;

/**
 * Sprint + Crouch while running forward = low run (the capsule stays standing; only the body
 * bends). Held still, the same keys just crouch.
 */
export const wantsLowRun = (s: MoveState, input: PlayerInput): boolean =>
  isDown(input.buttons, Button.Sprint) &&
  isDown(input.buttons, Button.Crouch) &&
  input.moveZ >= MOVEMENT.sprintMinForward &&
  (s.grounded || s.lowRun);

/** Whether the player may sprint this step (mutates nothing). */
export function canSprint(s: MoveState, input: PlayerInput, mods: MoveModifiers): boolean {
  return (
    isDown(input.buttons, Button.Sprint) &&
    !s.crouched &&
    !s.prone &&
    s.grounded &&
    !mods.sprintBlocked &&
    input.moveZ >= MOVEMENT.sprintMinForward
  );
}

/**
 * Whether a slide starts this step: Crouch pressed (or buffered from a sprint jump's air time)
 * while sprinting on the ground above `SLIDE.minSpeed`, off cooldown. Never prone, on the board,
 * mid-climb or aiming (`aiming`: ADS held with a gun in hand). Mutates nothing.
 */
export function canSlide(
  s: MoveState,
  input: PlayerInput,
  prevButtons: number,
  aiming: boolean,
): boolean {
  return (
    (pressed(input.buttons, prevButtons, Button.Crouch) || s.slideBuffer > 0) &&
    !s.sliding &&
    s.slideCooldown <= 0 &&
    s.grounded &&
    s.sprinting &&
    !s.prone &&
    !s.board &&
    s.traversal === null &&
    !aiming &&
    Math.hypot(s.vel.x, s.vel.z) >= SLIDE.minSpeed
  );
}

/** Enter a slide (the caller has already switched the body to the crouch capsule). */
export function startSlide(s: MoveState): void {
  s.sliding = true;
  s.slideTime = 0;
  s.slideBuffer = 0;
  s.crouched = true;
  s.sprinting = false;
  s.lowRun = false;
  endTacSprint(s);
}

/**
 * Whether a tactical sprint burst starts this step: `TacSprint` pressed while sprinting upright
 * on the ground (not a low run), with at least `TAC_SPRINT.minStart` in the tank. Call after the
 * step's sprint state is known. Mutates nothing.
 */
export function canTacSprint(s: MoveState, input: PlayerInput, prevButtons: number): boolean {
  return (
    pressed(input.buttons, prevButtons, Button.TacSprint) &&
    !s.tacSprint &&
    s.sprinting &&
    !s.lowRun &&
    s.grounded &&
    s.tacFuel >= TAC_SPRINT.minStart - 1e-9
  );
}

/** End a burst (if one runs): the tank refills after `TAC_SPRINT.rechargeDelay`. */
export function endTacSprint(s: MoveState): void {
  if (!s.tacSprint) return;
  s.tacSprint = false;
  s.tacDelay = TAC_SPRINT.rechargeDelay;
}

/**
 * The tactical sprint for this step, once the sprint state is decided: a burst ends with the
 * sprint (released, fired, aimed, crouched into a low run, stopped going forward) or when the
 * tank runs dry (back to a normal sprint while Sprint stays held); otherwise it drains. Off a
 * burst the tank refills after its delay.
 */
function stepTacSprint(s: MoveState, input: PlayerInput, prevButtons: number, dt: number): void {
  if (s.tacSprint && (!s.sprinting || s.lowRun)) endTacSprint(s);
  if (canTacSprint(s, input, prevButtons)) s.tacSprint = true;
  if (s.tacSprint) {
    s.tacFuel = Math.max(0, s.tacFuel - dt / TAC_SPRINT.duration);
    if (s.tacFuel <= 0) endTacSprint(s);
  } else if (s.tacDelay > 0) {
    s.tacDelay = Math.max(0, s.tacDelay - dt);
  } else {
    s.tacFuel = Math.min(1, s.tacFuel + dt / TAC_SPRINT.rechargeTime);
  }
}

/** Leave a slide (still crouched: the stance logic stands you up next step if it should). */
export function endSlide(s: MoveState): void {
  s.sliding = false;
  s.slideTime = 0;
  s.slideCooldown = SLIDE.cooldown;
}

/**
 * One slide step: the first launches along the current velocity (entry speed × boost, the entry
 * capped at sprint speed × weapon mobility), then constant friction on the ground; the heading
 * turns toward the stick direction at most `SLIDE.steerRate`. Slopes and walls are applied after
 * the move (stepPlayer). Ends below crouch-walk speed or at `SLIDE.maxTime`. Never jumps (a Jump
 * press cancels the slide in stepPlayer before this runs).
 */
function slideVelocity(s: MoveState, input: PlayerInput, dt: number, mods: MoveModifiers): void {
  s.sprinting = false;
  s.lowRun = false;
  let speed = Math.hypot(s.vel.x, s.vel.z);
  let heading = Math.atan2(s.vel.x, s.vel.z);
  if (s.slideTime === 0) {
    speed = Math.min(speed, MOVEMENT.sprintSpeed * (mods.speedMultiplier ?? 1)) * SLIDE.boost;
  } else if (s.grounded) {
    speed = Math.max(0, speed - SLIDE.friction * dt);
  }
  s.slideTime += dt;
  const { forward, right } = yawBasis(input.yaw);
  const wx = forward.x * input.moveZ + right.x * input.moveX;
  const wz = forward.z * input.moveZ + right.z * input.moveX;
  if (Math.hypot(wx, wz) > 1e-3) {
    const d = Math.atan2(wx, wz) - heading;
    const turn = Math.atan2(Math.sin(d), Math.cos(d));
    const max = SLIDE.steerRate * dt;
    heading += Math.max(-max, Math.min(max, turn));
  }
  s.vel.x = Math.sin(heading) * speed;
  s.vel.z = Math.cos(heading) * speed;
  s.vel.y = Math.max(-MOVEMENT.maxFallSpeed, s.vel.y - MOVEMENT.gravity * dt);
  s.eyeHeight = approach(s.eyeHeight, SLIDE.eyeHeight, SLIDE.eyeSpeed * dt);
  if (speed < MOVEMENT.crouchSpeed || s.slideTime >= SLIDE.maxTime - 1e-9) endSlide(s);
}

/**
 * Pure movement intent: updates timers, sprint state, and velocity for one step. Collision is
 * resolved afterwards by the character body; see `stepPlayer`.
 * Returns true if a jump was triggered this step.
 */
export function computeVelocity(
  s: MoveState,
  input: PlayerInput,
  prevButtons: number,
  dt: number,
  mods: MoveModifiers,
): boolean {
  // Timers
  s.coyoteTimer = s.grounded ? MOVEMENT.coyoteTime : Math.max(0, s.coyoteTimer - dt);
  s.jumpBufferTimer = pressed(input.buttons, prevButtons, Button.Jump)
    ? MOVEMENT.jumpBufferTime
    : Math.max(0, s.jumpBufferTimer - dt);
  s.landingSlowTimer = Math.max(0, s.landingSlowTimer - dt);
  s.slideCooldown = Math.max(0, s.slideCooldown - dt);
  // Crouch pressed in the air on a sprint jump: a slide waits for the touchdown (stepPlayer).
  s.slideBuffer =
    !s.grounded && s.sprinting && pressed(input.buttons, prevButtons, Button.Crouch)
      ? SLIDE.landBuffer
      : Math.max(0, s.slideBuffer - dt);

  if (s.board) {
    if (s.sliding) endSlide(s);
    endTacSprint(s);
    stepTacSprint(s, input, prevButtons, dt);
    return rideBoard(s, input, dt);
  }
  if (s.sliding) {
    stepTacSprint(s, input, prevButtons, dt);
    slideVelocity(s, input, dt, mods);
    return false;
  }

  // Sprint persists in the air (keeps momentum) but can only start on the ground.
  const sprintHeld = isDown(input.buttons, Button.Sprint);
  s.sprinting = s.grounded
    ? canSprint(s, input, mods)
    : s.sprinting && sprintHeld && input.moveZ >= MOVEMENT.sprintMinForward;
  s.lowRun = s.sprinting && isDown(input.buttons, Button.Crouch);
  stepTacSprint(s, input, prevButtons, dt);

  // Wish direction on the horizontal plane
  const { forward, right } = yawBasis(input.yaw);
  let wx = forward.x * input.moveZ + right.x * input.moveX;
  let wz = forward.z * input.moveZ + right.z * input.moveX;
  const wlen = Math.hypot(wx, wz);
  if (wlen > 1) {
    wx /= wlen;
    wz /= wlen;
  }
  const hasInput = wlen > 1e-3;
  const speed = targetSpeed(s, input, mods);
  const tx = wx * speed;
  const tz = wz * speed;

  // Horizontal: approach the target velocity vector at a bounded rate.
  const accel = s.grounded
    ? hasInput
      ? MOVEMENT.groundAcceleration
      : MOVEMENT.groundDeceleration
    : hasInput
      ? MOVEMENT.airAcceleration
      : 0;
  const dx = tx - s.vel.x;
  const dz = tz - s.vel.z;
  const dlen = Math.hypot(dx, dz);
  const maxDelta = accel * dt;
  if (dlen <= maxDelta) {
    s.vel.x = tx;
    s.vel.z = tz;
  } else if (dlen > 0) {
    s.vel.x += (dx / dlen) * maxDelta;
    s.vel.z += (dz / dlen) * maxDelta;
  }

  // Vertical. The caller integrates position with the step's average vertical velocity
  // (trapezoid), which is exact under constant gravity: apex == jumpHeight at any dt.
  let jumped = false;
  // Prone: Jump gets you up (stepPlayer), it never launches you.
  const canJumpNow = (s.grounded || s.coyoteTimer > 0) && !s.crouched && !s.prone;
  if (s.jumpBufferTimer > 0 && canJumpNow) {
    s.vel.y = jumpVelocity();
    s.jumpBufferTimer = 0;
    s.coyoteTimer = 0;
    s.grounded = false;
    jumped = true;
  }
  s.vel.y = Math.max(-MOVEMENT.maxFallSpeed, s.vel.y - MOVEMENT.gravity * dt);

  // Eye height eases toward the stance target (visual + where shots originate); getting down
  // onto the stomach or back up is slower than a crouch.
  const target = stanceEyeHeight(s);
  const slow = s.prone || s.eyeHeight < PLAYER.crouchEyeHeight - 0.05;
  s.eyeHeight = approach(
    s.eyeHeight,
    target,
    (slow ? PLAYER.proneEyeSpeed : PLAYER.eyeHeightSpeed) * dt,
  );

  return jumped;
}
