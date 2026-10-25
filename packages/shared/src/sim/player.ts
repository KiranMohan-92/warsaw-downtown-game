import {
  KNIFE,
  KNIFE_DEFENSE,
  JETPACK,
  MOVEMENT,
  PLAYER,
  PRONE,
  SKATEBOARD,
  SLIDE,
  TRAVERSAL,
  type MatchMode,
  type PrimaryId,
} from '../config/tunables.ts';
import { yawBasis, type Vec3 } from '../math/vec3.ts';
import {
  cancelForSeat,
  cloneArsenal,
  createArsenal,
  gunReady,
  gunConfig,
  isGun,
  isMeleeing,
  isThrowing,
  stepArsenal,
  type ArsenalEvent,
  type ArsenalState,
  type GunSlot,
} from './arsenal.ts';
import { Button, isDown, pressed, type PlayerInput } from './input.ts';
import {
  canSlide,
  computeVelocity,
  createMoveState,
  endSlide,
  endTacSprint,
  jumpVelocity,
  stanceEyeHeight,
  startSlide,
  wantsLowRun,
  type MoveState,
} from './movement.ts';
import {
  createWeaponState,
  stepWeapon,
  type WeaponContext,
  type WeaponEvent,
  type WeaponState,
} from './weapon.ts';
import { probeLedge, traversalDuration, traversalPoint, type LedgeQueries } from './traversal.ts';
import { stepSpawnProtection } from './spawnProtection.ts';
import {
  cloneSeat,
  seatButtonMask,
  seatEyeHeight,
  seatFeet,
  type SeatState,
} from './vehicles/seats.ts';
import {
  controlsFromInput,
  stepVehicle,
  type VehicleObstacle,
  type VehicleProps,
  type VehicleWorld,
} from './vehicles/vehicle.ts';
import { flightSteadiness, flightVelocity, jetActive, jetAltitude, JetMode } from './jetpack.ts';
import { launchDrone, stepDrone, type DroneState, type DroneWorld } from './drone.ts';

export interface MoveResult {
  /** Translation actually applied after collision. */
  moved: Vec3;
  grounded: boolean;
}

/**
 * Collision resolution for one character. Implemented by Rapier (`physics/world.ts`); tests can
 * substitute a flat-ground fake. Owns the capsule position.
 */
export interface CharacterBody {
  /** `maxStep`: highest lip to step onto (default: the walking step height). */
  move(delta: Vec3, maxStep?: number): MoveResult;
  /**
   * Switch capsule height. Returns false if getting taller (standing up, or crouching up from
   * prone) is blocked by a ceiling.
   */
  setCrouched(crouched: boolean): boolean;
  /**
   * Prone capsule on/off (off = standing height). Returns false if blocked. Absent in flat-ground
   * test fakes: no prone.
   */
  setProne?(prone: boolean): boolean;
  setPosition(feet: Vec3): void;
  /**
   * Horizontal collide-and-slide by `delta` that leaves ground contact as it was (player
   * collision pushes, `sim/playerCollision.ts`). Returns the translation applied. Absent in
   * flat-ground test fakes: `move` stands in.
   */
  nudge?(delta: Vec3): Vec3;
  /** World queries for climbing/vaulting and drone flight (absent in flat-ground test fakes). */
  readonly world?: LedgeQueries;
  /** Static-world queries a driven vehicle needs (absent in flat-ground fakes: it won't move). */
  readonly vehicleWorld?: VehicleWorld;
}

/** What else a step meets besides the static world (the same on server and in prediction). */
export interface StepEnv {
  /** Vehicles as obstacles: a driven one is pushed out of the others, walkers out of all. */
  vehicles?: readonly VehicleObstacle[];
  /** Props a driven truck can break through (absent: every prop is solid). */
  props?: VehicleProps;
  /** What drone flight collides with: movement solid geometry plus vehicles, when present. */
  droneWorld?: DroneWorld;
}

/**
 * Teleport a body to a spawn and stand it up there (every new life: offline respawn, online
 * welcome, the server's respawn). Moves first: a prone or crouched capsule under a low ceiling
 * cannot stand where it died, so resizing before the move fails and leaves a short capsule under
 * a fresh (standing) state. Returns whether it stands (true at any valid spawn).
 */
export function placeBodyAt(
  body: CharacterBody & { setGrounded?(grounded: boolean): void },
  feet: Vec3,
): boolean {
  body.setPosition(feet);
  const stands = body.setCrouched(false) && (body.setProne?.(false) ?? true);
  body.setGrounded?.(false);
  return stands;
}

export interface PlayerState {
  move: MoveState;
  /** Per-gun state (ammo, recoil, reload); only the gun in hand is stepped. */
  guns: Record<GunSlot, WeaponState>;
  /** Slots, switching, knife and grenade. */
  arsenal: ArsenalState;
  health: number;
  prevButtons: number;
  /** Last view direction (radians): facing for guard arcs, hitboxes and bots. */
  view: { yaw: number; pitch: number };
  /** Stable per-player seed for deterministic spread/recoil. */
  seed: number;
  /**
   * Spawn protection left (s; 0 = none): no damage until it runs out or the player attacks
   * (`sim/spawnProtection.ts`). Granted at each spawn by whoever spawns the player.
   */
  spawnGuard: number;
  /** In a vehicle (`sim/vehicles/seats.ts`): set and cleared by the match's seat rules. */
  seat: SeatState | null;
  /** Stored recon-drone uplink charges, granted by server-owned pickups. */
  droneCharges: number;
  /** The recon drone this player is piloting; while live, their body stands still exposed. */
  drone: DroneState | null;
}

export type PlayerEvent =
  | WeaponEvent
  | ArsenalEvent
  | { type: 'jump' }
  | { type: 'traverse'; kind: 'mantle' | 'vault'; height: number }
  /** A slide started (`speed`: horizontal speed going in, m/s). */
  | { type: 'slide'; speed: number }
  | { type: 'land'; impactSpeed: number }
  | { type: 'footstep'; sprint: boolean; crouch: boolean }
  /** The vehicle we drive hit something (speed into it, m/s; presentation). */
  | { type: 'vehicleImpact'; speed: number }
  /** Jetpack lit (Jump again in the air). */
  | { type: 'jetIgnite' }
  /** Out of fuel: the pack cuts out and the drop begins. */
  | { type: 'jetCutoff' }
  /** Touched down from the out-of-fuel drop (the thud; no fall damage). */
  | { type: 'jetLand'; impactSpeed: number }
  | { type: 'droneLaunched' }
  | { type: 'droneRecalled' }
  | { type: 'droneBattery' };

export function createPlayerState(
  feet: Vec3,
  seed = 1,
  mode: MatchMode = 'standard',
  primary: PrimaryId = 'ar7',
): PlayerState {
  const arsenal = createArsenal(mode, primary);
  return {
    move: createMoveState(feet),
    guns: {
      rifle: createWeaponState(gunConfig(arsenal, 'rifle')),
      sidearm: createWeaponState(gunConfig(arsenal, 'sidearm')),
    },
    arsenal,
    health: PLAYER.maxHealth,
    prevButtons: 0,
    view: { yaw: 0, pitch: 0 },
    seed,
    spawnGuard: 0,
    seat: null,
    droneCharges: 0,
    drone: null,
  };
}

/** Deep copy (for prediction snapshots / render interpolation). */
export function clonePlayerState(p: PlayerState): PlayerState {
  return {
    ...p,
    move: {
      ...p.move,
      pos: { ...p.move.pos },
      vel: { ...p.move.vel },
      traversal: p.move.traversal
        ? {
            ...p.move.traversal,
            from: { ...p.move.traversal.from },
            path: p.move.traversal.path.map((q) => ({ ...q })),
            to: { ...p.move.traversal.to },
            dir: { ...p.move.traversal.dir },
          }
        : null,
    },
    guns: { rifle: { ...p.guns.rifle }, sidearm: { ...p.guns.sidearm } },
    arsenal: cloneArsenal(p.arsenal),
    view: { ...p.view },
    seat: cloneSeat(p.seat),
    drone: p.drone
      ? {
          ...p.drone,
          pos: { ...p.drone.pos },
          vel: { ...p.drone.vel },
        }
      : null,
  };
}

/** The gun in hand, or null when holding the knife. */
export const heldGun = (p: PlayerState): WeaponState | null =>
  isGun(p.arsenal.slot) ? p.guns[p.arsenal.slot] : null;

/** Holstering a gun cancels its reload and drops transient aim state. */
export function holster(w: WeaponState): void {
  w.reloadTimer = 0;
  w.adsAmount = 0;
  w.recoilPitch = 0;
  w.recoilYaw = 0;
  w.bloom = 0;
  w.queuedShot = 0;
  w.charge = 0; // a coilgun never comes back from the holster pre-charged
}

export const eyePosition = (p: PlayerState): Vec3 => ({
  x: p.move.pos.x,
  y: p.move.pos.y + p.move.eyeHeight,
  z: p.move.pos.z,
});

export const horizontalSpeed = (m: MoveState): number => Math.hypot(m.vel.x, m.vel.z);

/**
 * Advance one player by one fixed step. Deterministic given (state, input, dt, world geometry).
 * The same function runs for client prediction and on the authoritative server.
 */
export function stepPlayer(
  p: PlayerState,
  input: PlayerInput,
  dt: number,
  body: CharacterBody,
  env?: StepEnv,
): PlayerEvent[] {
  return stepPlayerInternal(p, input, dt, body, env, true);
}

function stepPlayerInternal(
  p: PlayerState,
  input: PlayerInput,
  dt: number,
  body: CharacterBody,
  env: StepEnv | undefined,
  allowDrone: boolean,
): PlayerEvent[] {
  const m = p.move;
  const a = p.arsenal;
  const events: PlayerEvent[] = [];
  // The dead don't act (online a killed player waits for the server's respawn): no movement,
  // no aim, no hands. The same rule on the server, in prediction and in replays, so a death
  // never makes the client disagree with the server.
  if (p.health <= 0) {
    p.drone = null;
    // A flyer killed in the air drops (gravity only, no input): never a body hanging at 4 m
    // until the respawn. The same on every side, like everything else here.
    if (jetActive(m) && !m.grounded) {
      m.vel = { x: 0, y: Math.max(-MOVEMENT.maxFallSpeed, m.vel.y - MOVEMENT.gravity * dt), z: 0 };
      const { moved, grounded } = body.move({ x: 0, y: m.vel.y * dt, z: 0 });
      m.pos = { x: m.pos.x + moved.x, y: m.pos.y + moved.y, z: m.pos.z + moved.z };
      m.grounded = grounded;
      if (grounded) m.vel.y = 0;
    }
    p.prevButtons = input.buttons;
    return events;
  }
  if (allowDrone) {
    const originalPrevButtons = p.prevButtons;
    const originalView = { ...p.view };
    const droneEvents: PlayerEvent[] = [];
    const dronePressed = pressed(input.buttons, originalPrevButtons, Button.Drone);
    if (dronePressed && p.drone?.alive) {
      p.drone = null;
      droneEvents.push({ type: 'droneRecalled' });
    } else if (dronePressed && canLaunchDrone(p) && body.world) {
      p.droneCharges -= 1;
      p.drone = launchDrone(p.seed, eyePosition(p), input.yaw);
      droneEvents.push({ type: 'droneLaunched' });
    }
    if (p.drone?.alive) {
      const bodyInput: PlayerInput = {
        ...input,
        moveX: 0,
        moveZ: 0,
        yaw: originalView.yaw,
        pitch: originalView.pitch,
        buttons: 0,
      };
      events.push(...stepPlayerInternal(p, bodyInput, dt, body, env, false));
      const droneWorld = env?.droneWorld ?? body.world;
      const ended = droneWorld ? stepDrone(p.drone, input, dt, droneWorld) : null;
      if (ended === 'battery') {
        p.drone = null;
        droneEvents.push({ type: 'droneBattery' });
      }
      p.prevButtons = input.buttons;
      return [...events, ...droneEvents];
    }
    if (p.drone && !p.drone.alive) p.drone = null;
    events.push(...droneEvents);
  }
  p.view = { yaw: input.yaw, pitch: input.pitch };
  if (p.seat) {
    stepSeated(p, input, dt, body, env, events);
    return events;
  }

  // Climb / vault: jump facing a ledge (or hold jump in the air against one) while moving forward.
  // Not from prone: there that Jump press only gets you up (below); the next one climbs.
  const jumpDown = isDown(input.buttons, Button.Jump);
  const jumpPressed = jumpDown && !isDown(p.prevButtons, Button.Jump);
  // Jetpack ignition: a worn pack lights on a Jump press in the air (after the jump's own press,
  // or off a ledge once the coyote time is over). Not mid-climb or on the board.
  let ignited = false;
  if (
    m.jet === JetMode.Worn &&
    jumpPressed &&
    !m.grounded &&
    m.coyoteTimer <= 0 &&
    !m.traversal &&
    !m.board &&
    !m.prone
  ) {
    m.jet = JetMode.Flying;
    m.vel.y = Math.max(m.vel.y, JETPACK.igniteBoost);
    if (m.sliding) endSlide(m);
    endTacSprint(m);
    ignited = true;
    events.push({ type: 'jetIgnite' });
  }
  const flying = jetActive(m);
  if (
    !m.traversal &&
    !flying &&
    !m.prone &&
    body.world &&
    // Hands must be free: no climbing out of a knife swing or a grenade throw.
    !isMeleeing(a) &&
    !isThrowing(a) &&
    input.moveZ > 0.3 &&
    a.stun <= 0 &&
    (jumpPressed || (!m.grounded && jumpDown && m.vel.y < 2.5))
  ) {
    const dir = { x: -Math.sin(input.yaw), z: -Math.cos(input.yaw) };
    const ledge = probeLedge(
      body.world,
      m.pos,
      dir,
      m.sprinting,
      horizontalSpeed(m) * TRAVERSAL.reachPerSpeed,
      m.crouched ? PLAYER.crouchHeight : PLAYER.standHeight,
    );
    if (ledge) {
      if (ledge.crouch && body.setCrouched(true)) m.crouched = true;
      m.traversal = {
        kind: ledge.kind,
        t: 0,
        dur: traversalDuration(ledge, m.pos),
        from: { ...m.pos },
        path: ledge.path,
        to: ledge.to,
        dir,
      };
      m.jumpBufferTimer = 0;
      endTacSprint(m);
      events.push({ type: 'traverse', kind: ledge.kind, height: ledge.top - m.pos.y });
    }
  }
  const traversing = m.traversal !== null;
  // Sliding into a ledge with Jump climbs/vaults it: that ends the slide.
  if (traversing && m.sliding) endSlide(m);

  // Prone (Kiran): the Prone button drops onto the stomach (grounded, not skating, clear ground
  // behind for the body); Prone again, Jump or Crouch gets back up if there's headroom (standing,
  // else a crouch; under a ceiling too low for either you stay down). The body lies behind the head: `pos` is under the head.
  const proneTap = pressed(input.buttons, p.prevButtons, Button.Prone);
  let rose = false;
  if (m.prone) {
    const up =
      proneTap ||
      pressed(input.buttons, p.prevButtons, Button.Jump) ||
      pressed(input.buttons, p.prevButtons, Button.Crouch);
    if (up && body.setProne) {
      if (body.setProne(false)) m.prone = false;
      else if (body.setCrouched(true)) {
        m.prone = false;
        m.crouched = true;
      }
      rose = !m.prone;
    }
  } else if (proneTap && body.setProne && m.grounded && !m.board && !traversing && !flying) {
    const { forward } = yawBasis(p.view.yaw);
    const back = { x: -forward.x, y: 0, z: -forward.z };
    const from = { x: m.pos.x, y: m.pos.y + 0.3, z: m.pos.z };
    const clear =
      !body.world ||
      (body.world.castRay(from, back, PRONE.bodyLength)?.distance ?? Infinity) >= PRONE.bodyLength;
    if (clear && body.setProne(true)) {
      if (m.sliding) endSlide(m);
      m.prone = true;
      m.crouched = false;
      m.sprinting = false;
      m.lowRun = false;
      endTacSprint(m);
    }
  }

  // Slide (Kiran): Crouch pressed on a sprint (hold or toggle crouch alike: both raise the
  // button) drops into the crouch capsule and slides; see movement.ts. Jump cancels it into a
  // normal jump if there's headroom to stand (under a low ceiling the press does nothing and the
  // slide carries on). The slide keeps the crouch capsule until it ends; the stance logic then
  // stands you up (Crouch released, headroom) or keeps the crouch.
  // (A held Crouch doesn't pull the jump back down this step: the stance logic skips it.)
  let slideJump = false;
  if (m.sliding && jumpPressed && !traversing && body.setCrouched(false)) {
    m.crouched = false;
    endSlide(m);
    slideJump = true;
  }
  const aiming = heldGun(p) !== null && isDown(input.buttons, Button.Ads);
  if (!traversing && canSlide(m, input, p.prevButtons, aiming)) {
    if (jumpPressed) {
      // Crouch and Jump in the same tick on a sprint: the jump wins (no slide, a normal jump;
      // a held Crouch doesn't pull it down this step either).
      slideJump = true;
    } else if (body.setCrouched(true)) {
      startSlide(m);
      events.push({ type: 'slide', speed: horizontalSpeed(m) });
    }
  }

  // Stance: crouch immediately; stand only if there's headroom (not mid-climb or mid-slide).
  // (Sprint + Crouch on the run is a low run instead: bent over, capsule standing — reached by
  // holding Crouch before sprinting, or through the end of a slide with both still held.)
  // On the skateboard you stand (the board has no crouch).
  const wantCrouch =
    !m.board &&
    !m.prone &&
    !flying &&
    isDown(input.buttons, Button.Crouch) &&
    !wantsLowRun(m, input);
  if (
    !traversing &&
    !m.sliding &&
    !slideJump &&
    wantCrouch !== m.crouched &&
    body.setCrouched(wantCrouch)
  )
    m.crouched = wantCrouch;

  // Hands first: switching, knife swings, grenade throws. Mid-climb the hands are busy: no
  // firing, aiming, swinging or throwing (switching and reloads carry on).
  const BUSY =
    Button.Fire |
    Button.Ads |
    Button.Melee |
    Button.Grenade |
    Button.Smoke |
    Button.Jammer |
    Button.Block;
  const handsInput = traversing ? { ...input, buttons: input.buttons & ~BUSY } : input;
  for (const e of stepArsenal(a, handsInput, p.prevButtons, dt)) {
    if (e.type === 'switchStart' && isGun(e.from)) holster(p.guns[e.from]);
    if (e.type === 'meleeStart' && m.grounded) {
      // Lunge into the strike: a forward impulse that ground deceleration then bleeds off.
      // Ground only: in the air nothing decays horizontal speed, so impulses would stack.
      m.vel.x += -Math.sin(e.yaw) * KNIFE.lungeSpeed;
      m.vel.z += -Math.cos(e.yaw) * KNIFE.lungeSpeed;
    }
    events.push(e);
  }
  const w = heldGun(p);
  const ready = gunReady(a) && !traversing;

  // Firing, aiming, swinging or throwing cancels sprint (then the gun applies its sprint-out).
  const fireHeld = isDown(input.buttons, Button.Fire);
  const wantsToShoot = w !== null && ready && fireHeld && w.ammo > 0 && w.reloadTimer <= 0;
  const sprintBlocked =
    wantsToShoot ||
    (w !== null && isDown(input.buttons, Button.Ads)) ||
    isMeleeing(a) ||
    isThrowing(a) ||
    (a.slot === 'knife' && fireHeld);

  if (m.traversal) {
    stepTraversal(m, body, dt, events);
    stepHands(p, w, ready, handsInput, dt, events);
    stepSpawnProtection(p, events, dt);
    p.prevButtons = input.buttons;
    return events;
  }

  const wasGrounded = m.grounded;
  const vyStart = m.vel.y;
  // Getting up from prone consumes that press: the movement step sees Jump as already held.
  const mods = {
    adsAmount: w?.adsAmount ?? 0,
    sprintBlocked: sprintBlocked || flying,
    speedMultiplier:
      (a.slot === 'knife' ? KNIFE.speedMultiplier : 1) *
      (a.guard.held ? KNIFE_DEFENSE.guardSpeedMultiplier : 1) *
      (a.stun > 0 ? KNIFE_DEFENSE.stunSpeedMultiplier : 1),
  };
  // On the pack: flight physics in the air, or while Jump lifts you off; on the ground without
  // Jump you walk (no sprint, no jump). The out-of-fuel drop always falls.
  const flyStep = flying && (m.jet === JetMode.Drop || !m.grounded || jumpDown || ignited);
  let jumped = false;
  if (flyStep) {
    flightVelocity(m, input, dt, jetAltitude(body.world, m.pos), mods);
    if (jumpDown && m.vel.y > 0) m.grounded = false; // lifting off
  } else if (flying) {
    computeVelocity(
      m,
      { ...input, buttons: input.buttons & ~(Button.Jump | Button.Sprint) },
      p.prevButtons & ~Button.Jump,
      dt,
      mods,
    );
  } else {
    jumped = computeVelocity(
      m,
      input,
      rose ? p.prevButtons | Button.Jump : p.prevButtons,
      dt,
      mods,
    );
  }
  m.jetThrust = m.jet === JetMode.Flying && jumpDown;
  if (jumped) events.push({ type: 'jump' });

  const fallSpeed = -m.vel.y;
  // Trapezoidal vertical integration (exact jump apex); a jump impulse starts at launch speed.
  const vyAvg = ((jumped ? jumpVelocity() : vyStart) + m.vel.y) / 2;
  const desired = { x: m.vel.x * dt, y: vyAvg * dt, z: m.vel.z * dt };
  const { moved, grounded } = body.move(desired, m.board ? SKATEBOARD.maxStep : undefined);
  m.pos = { x: m.pos.x + moved.x, y: m.pos.y + moved.y, z: m.pos.z + moved.z };

  // Post-collision velocity: lose the component that went into walls. The 1% band ignores the
  // sub-millimetre skin nudges the controller applies on open ground.
  const desiredH = Math.hypot(desired.x, desired.z);
  const movedH = Math.hypot(moved.x, moved.z);
  if (movedH < desiredH * 0.99) {
    // On the board, scraping along a wall bleeds speed too (a head-on hit already stops it).
    const keep = m.board ? 1 - SKATEBOARD.scrape * (1 - movedH / Math.max(desiredH, 1e-9)) : 1;
    m.vel.x = (moved.x / dt) * keep;
    m.vel.z = (moved.z / dt) * keep;
  }
  if (m.board && grounded && wasGrounded && movedH > 0.01) {
    const hs = Math.hypot(m.vel.x, m.vel.z);
    if (moved.y > 0.03) {
      // Rolled over a lip: a bump costs speed.
      m.vel.x *= SKATEBOARD.bumpKeep;
      m.vel.z *= SKATEBOARD.bumpKeep;
    } else if (hs > 0.05) {
      // Slopes: gravity along the travel (the step's own rise over run, clamped).
      const slope = Math.max(-0.5, Math.min(0.5, moved.y / movedH));
      const next = Math.max(0, hs - MOVEMENT.gravity * SKATEBOARD.slopeFactor * slope * dt);
      m.vel.x *= next / hs;
      m.vel.z *= next / hs;
    }
  }
  if (m.sliding) {
    if (movedH < desiredH * SLIDE.wallStop) {
      endSlide(m); // ran into a wall (a glancing scrape keeps sliding along it)
    } else if (grounded && wasGrounded && movedH > 0.01) {
      // Slopes: gravity along the travel, clamped. Uphill shortens the slide, downhill extends
      // it. The grade comes from the ground under the capsule (its normal: a ramp or ramped
      // stairs keep dragging however fast you climb, while a kerb's step-up lands on a flat top
      // and costs nothing); bodies without world queries (test fakes) use the step's rise/run.
      const hs = Math.hypot(m.vel.x, m.vel.z);
      const slope = Math.max(-0.5, Math.min(0.5, slideGrade(body, m.pos, moved, movedH)));
      const next = Math.max(0, hs - MOVEMENT.gravity * SLIDE.slopeFactor * slope * dt);
      if (hs > 1e-6) {
        m.vel.x *= next / hs;
        m.vel.z *= next / hs;
      }
    }
  }
  if (!grounded && desired.y > 0 && moved.y < desired.y * 0.5) m.vel.y = 0; // bonked head

  const landed = !wasGrounded && grounded && !jumped;
  m.grounded = grounded && !jumped;
  if (m.grounded && m.vel.y < 0) m.vel.y = 0;
  if (landed && m.jet === JetMode.Drop) {
    // The drop's touchdown: a controlled landing — the thud, no slow-down, the pack is done.
    m.jet = JetMode.None;
    m.jetFuel = 0;
    events.push({ type: 'jetLand', impactSpeed: fallSpeed });
  } else if (landed) {
    events.push({ type: 'land', impactSpeed: fallSpeed });
    // A pack lets you down gently: no landing slow while flying.
    if (fallSpeed > 5 && !flying) m.landingSlowTimer = MOVEMENT.landingSlowTime;
  }
  // The flight window runs from ignition, in the air or not.
  if (m.jet === JetMode.Flying) {
    m.jetFuel = Math.max(0, m.jetFuel - dt);
    if (m.jetFuel <= 1e-9) {
      m.jetFuel = 0;
      m.jet = JetMode.Drop;
      m.jetThrust = false;
      events.push({ type: 'jetCutoff' });
    }
  } else if (m.jet === JetMode.Drop && m.grounded) {
    // Ran out standing on the ground: nothing to drop.
    m.jet = JetMode.None;
    events.push({ type: 'jetLand', impactSpeed: 0 });
  }
  // Slid off an edge: the slide is over (you fall crouched).
  if (m.sliding && !m.grounded) endSlide(m);

  // Footsteps (audio now, server-side audibility later).
  const hs = horizontalSpeed(m);
  if (m.grounded && hs > 0.5 && !m.board && !m.sliding) {
    const stride =
      MOVEMENT.strideLength * (m.lowRun ? 1.1 : m.sprinting ? 1.3 : m.crouched ? 0.75 : 1);
    m.strideAccum += hs * dt;
    if (m.strideAccum >= stride) {
      m.strideAccum -= stride;
      // A low run treads like a crouch (quiet), not a full sprint.
      events.push({
        type: 'footstep',
        sprint: m.sprinting && !m.lowRun,
        crouch: m.crouched || m.lowRun,
      });
    }
  } else if (m.grounded) {
    m.strideAccum = 0;
  }

  stepHands(p, w, ready, input, dt, events);
  // Last: any attack this step (shot, swing, throw) ends spawn protection before it resolves.
  stepSpawnProtection(p, events, dt);

  p.prevButtons = input.buttons;
  return events;
}

function canLaunchDrone(p: PlayerState): boolean {
  const m = p.move;
  return p.droneCharges > 0 && p.health > 0 && !m.traversal;
}

/**
 * A step in a vehicle seat: no walking (the seat holds you), the hands do what the seat allows
 * (`seatButtonMask`: the driver steers, passengers shoot), and the driver's inputs drive the
 * vehicle (its motion lives in the driver's seat state, so prediction steps it exactly like the
 * server). Occupants' feet follow their seat; spread is a standing shooter's (the speed of the
 * truck isn't in the client's prediction for passengers, so it must not change the shot).
 */
function stepSeated(
  p: PlayerState,
  input: PlayerInput,
  dt: number,
  body: CharacterBody,
  env: StepEnv | undefined,
  events: PlayerEvent[],
): void {
  const m = p.move;
  const a = p.arsenal;
  const seat = p.seat!;
  const mask = seatButtonMask(seat.seat, a.slot);
  const masked = { ...input, buttons: input.buttons & ~mask };
  // An attack begun on foot (a frag winding up, a knife strike) doesn't carry into the seat.
  cancelForSeat(a, (mask & Button.Grenade) !== 0, (mask & Button.Melee) !== 0);
  m.crouched = false;
  m.prone = false;
  m.sprinting = false;
  m.lowRun = false;
  m.sliding = false;
  m.tacSprint = false;
  m.traversal = null;
  for (const e of stepArsenal(a, masked, p.prevButtons, dt)) {
    if (e.type === 'switchStart' && isGun(e.from)) holster(p.guns[e.from]);
    events.push(e);
  }
  if (seat.seat === 'driver' && seat.motion && body.vehicleWorld) {
    const r = stepVehicle(
      seat.motion,
      controlsFromInput(input.moveX, input.moveZ, isDown(input.buttons, Button.Jump)),
      dt,
      body.vehicleWorld,
      env?.vehicles,
      seat.vehicle,
      env?.props,
    );
    if (r.impact > 2) events.push({ type: 'vehicleImpact', speed: r.impact });
  }
  if (seat.motion) {
    m.pos = seatFeet(seat.motion, seat.seat);
    m.vel = { ...seat.motion.vel };
  }
  m.grounded = true;
  m.eyeHeight = seatEyeHeight(seat.seat);
  stepHands(p, heldGun(p), gunReady(a), masked, dt, events, true);
  stepSpawnProtection(p, events, dt);
  p.prevButtons = input.buttons;
}

/**
 * Rise per metre of travel of the ground under the feet, along this step's horizontal motion:
 * from the ground normal (a short ray down at the capsule's centre line) when the body has world
 * queries, else the step's own rise over run. A vertical step face is never under the centre
 * line, so a kerb reads as the flat ground on top of it.
 */
function slideGrade(body: CharacterBody, feet: Vec3, moved: Vec3, movedH: number): number {
  const w = body.world;
  if (!w) return moved.y / movedH;
  const n = w.castRay({ x: feet.x, y: feet.y + 0.3, z: feet.z }, DOWN, 0.6)?.normal;
  if (!n) return moved.y / movedH;
  if (n.y < 0.2) return 0;
  // Ground plane n·p = c: moving (dx, dz) horizontally rises -(nx·dx + nz·dz) / ny.
  return -(n.x * moved.x + n.z * moved.z) / (n.y * movedH);
}
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

/**
 * Tick the gun in hand. While switching / swinging / throwing / climbing it keeps ticking
 * (reload, recovery) but can't fire, aim, or start a reload.
 */
function stepHands(
  p: PlayerState,
  w: WeaponState | null,
  ready: boolean,
  input: PlayerInput,
  dt: number,
  events: PlayerEvent[],
  seated = false,
): void {
  const a = p.arsenal;
  if (w && isGun(a.slot)) {
    // While switching / swinging / throwing the gun keeps ticking (reload, recovery) but can't
    // fire, aim, or start a reload.
    const gunInput = ready
      ? input
      : { ...input, buttons: input.buttons & ~(Button.Fire | Button.Ads | Button.Reload) };
    events.push(
      ...stepWeapon(w, gunInput, p.prevButtons, dt, weaponContext(p, seated), gunConfig(a, a.slot)),
    );
  }
}

/**
 * The stance a shot is judged in (spread, recoil): the sim's shots and the crosshair both use
 * this. Seated, the truck's speed isn't the shooter's (a passenger's spread is a standing one).
 */
export function weaponContext(p: PlayerState, seated = p.seat !== null): WeaponContext {
  const m = p.move;
  return {
    sprinting: m.sprinting,
    tacSprinting: m.tacSprint,
    crouched: m.crouched,
    prone: m.prone,
    sliding: m.sliding,
    grounded: m.grounded,
    ...(!seated && jetActive(m) && !m.grounded ? { flying: flightSteadiness(m) } : {}),
    speed: seated ? 0 : horizontalSpeed(m),
    walkSpeed: MOVEMENT.walkSpeed,
    // Distinct spread streams per gun so switching never replays a pattern.
    ownerSeed: p.seed * 2 + (p.arsenal.slot === 'sidearm' ? 1 : 0),
  };
}

/** Advance an active climb/vault along its fixed path; hand control back when it ends. */
function stepTraversal(
  m: PlayerState['move'],
  body: CharacterBody,
  dt: number,
  events: PlayerEvent[],
): void {
  const s = m.traversal!;
  s.t += dt;
  // Keep the camera height easing with the stance (a crouched mantle lowers the view).
  const eyeTarget = stanceEyeHeight(m);
  const step = PLAYER.eyeHeightSpeed * dt;
  m.eyeHeight += Math.max(-step, Math.min(step, eyeTarget - m.eyeHeight));
  const pos = traversalPoint(s);
  body.setPosition(pos);
  m.pos = pos;
  m.vel = { x: 0, y: 0, z: 0 };
  m.grounded = false;
  m.sprinting = s.kind === 'vault' && m.sprinting;
  m.lowRun = m.sprinting && m.lowRun;
  if (s.t >= s.dur) {
    m.traversal = null;
    m.grounded = true;
    m.coyoteTimer = 0;
    if (s.kind === 'vault') {
      const v = MOVEMENT.sprintSpeed * TRAVERSAL.vaultCarry;
      m.vel = { x: s.dir.x * v, y: 0, z: s.dir.z * v };
    }
    events.push({ type: 'land', impactSpeed: 0 });
  }
}
