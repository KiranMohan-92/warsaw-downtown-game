import { JETPACK, MOVEMENT, PLAYER } from '../config/tunables.ts';
import { approach, yawBasis, type Vec3 } from '../math/vec3.ts';
import { Button, isDown, type PlayerInput } from './input.ts';
import { stanceEyeHeight, type MoveModifiers, type MoveState } from './movement.ts';
import type { LedgeQueries } from './traversal.ts';

/**
 * Jetpacks (Kiran): the flight physics every player runs in `stepPlayer` (client prediction and
 * server alike: deterministic, all state in `MoveState`), and the match's pickup rules (pure; the
 * server owns them online, the game loop offline).
 *
 * Flight: Jump again in the air ignites a worn pack → `JETPACK.flightTime` of flight. Hold Jump
 * to climb, Crouch to descend, neither to hover; WASD thrusts horizontally with inertia and drag.
 * The ceiling is `JETPACK.ceiling` above the ground under you (a ray down: a container roof
 * lifts it), soft — climb thrust fades over the last `ceilingFade`. The last `sputterTime`
 * seconds sputter; at zero the pack cuts out and drops you straight down, fast and controlled,
 * and you land with a thud (no fall damage, no landing slow).
 */
export const JetMode = { None: 0, Worn: 1, Flying: 2, Drop: 3 } as const;
export type JetMode = (typeof JetMode)[keyof typeof JetMode];

/** In the air on the pack (flying or the out-of-fuel drop): no sprint, slide, prone, climb, board. */
export const jetActive = (m: Pick<MoveState, 'jet'>): boolean => m.jet >= JetMode.Flying;

/** A freshly picked-up pack (the match's rules call this on a pickup). */
export function grantJetpack(m: MoveState): void {
  m.jet = JetMode.Worn;
  m.jetFuel = JETPACK.flightTime;
  m.jetThrust = false;
}

/**
 * Thrust multiplier from the fuel left: 1, then in the last `sputterTime` seconds a weaker pack
 * with regular cut-outs (deterministic: a function of the fuel alone).
 */
export function jetSputter(fuel: number): number {
  if (fuel > JETPACK.sputterTime) return 1;
  const phase = ((JETPACK.sputterTime - fuel) * JETPACK.sputterRate) % 1;
  return phase < JETPACK.sputterDuty ? JETPACK.sputterDip : JETPACK.sputterThrust;
}

/**
 * Height of the feet above the ground under them (m), by a ray straight down against what
 * characters stand on (`castGroundRay`: static world + prop movement hulls; else `castRay`).
 * Null without world queries (flat-ground test fakes: no ceiling) or with nothing below.
 */
export function jetAltitude(world: LedgeQueries | undefined, feet: Vec3): number | null {
  if (!world) return null;
  const from = { x: feet.x, y: feet.y + 0.05, z: feet.z };
  const hit = world.castGroundRay
    ? world.castGroundRay(from, DOWN, JETPACK.probeDistance)
    : world.castRay(from, DOWN, JETPACK.probeDistance);
  return hit ? Math.max(0, hit.distance - 0.05) : null;
}
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

/** How far the climb thrust reaches at this altitude: 1 below the fade band, 0 at the ceiling. */
export function ceilingFade(alt: number | null): number {
  if (alt === null) return 1;
  return Math.max(0, Math.min(1, (JETPACK.ceiling - alt) / JETPACK.ceilingFade));
}

/**
 * One airborne step on the pack (flying or the drop): timers, vertical speed toward the target
 * (climb / hover / descend / drop) at a bounded rate, horizontal thrust with drag. Collision and
 * landing are resolved afterwards by `stepPlayer`, exactly like a jump.
 */
export function flightVelocity(
  s: MoveState,
  input: PlayerInput,
  dt: number,
  alt: number | null,
  mods: MoveModifiers,
): void {
  s.coyoteTimer = 0;
  s.jumpBufferTimer = 0;
  s.slideBuffer = 0;
  s.landingSlowTimer = Math.max(0, s.landingSlowTimer - dt);
  s.slideCooldown = Math.max(0, s.slideCooldown - dt);
  s.sprinting = false;
  s.lowRun = false;
  const sputter = jetSputter(s.jetFuel);
  const jump = isDown(input.buttons, Button.Jump);
  const crouch = isDown(input.buttons, Button.Crouch);

  // Vertical: a target speed reached at a bounded rate (a stabilised pack).
  let target: number;
  let rate: number;
  if (s.jet === JetMode.Drop) {
    target = -JETPACK.dropSpeed;
    rate = JETPACK.dropAccel;
  } else if (jump) {
    target = JETPACK.climbSpeed * ceilingFade(alt) * sputter;
    rate = JETPACK.thrustAccel * sputter;
  } else if (crouch) {
    target = -JETPACK.descendSpeed;
    rate = JETPACK.descendAccel;
  } else {
    // Hover; a sputter cut-out sags it.
    target = sputter < 1 ? -(1 - sputter) * 2 : 0;
    rate = JETPACK.hoverAccel * sputter;
  }
  if (s.jet === JetMode.Flying && alt !== null && alt > JETPACK.ceiling) {
    // Flown off a roof's edge: settle back under the ceiling, gently.
    const sink = Math.min(
      JETPACK.overCeilingSinkMax,
      (alt - JETPACK.ceiling) * JETPACK.overCeilingSink,
    );
    if (target > -sink) target = -sink;
    rate = Math.max(rate, JETPACK.hoverAccel);
  }
  s.vel.y = approach(s.vel.y, target, rate * dt);
  s.vel.y = Math.max(-MOVEMENT.maxFallSpeed, s.vel.y);

  // Horizontal: thrust along the stick with linear drag (inertia), braking without input.
  if (s.jet === JetMode.Drop) {
    const k = Math.max(0, 1 - JETPACK.dropDrag * dt);
    s.vel.x *= k;
    s.vel.z *= k;
  } else {
    const { forward, right } = yawBasis(input.yaw);
    let wx = forward.x * input.moveZ + right.x * input.moveX;
    let wz = forward.z * input.moveZ + right.z * input.moveX;
    const len = Math.hypot(wx, wz);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    const has = len > 1e-3;
    const accel =
      JETPACK.airAccel *
      sputter *
      (1 + (JETPACK.adsThrustMultiplier - 1) * mods.adsAmount) *
      (mods.speedMultiplier ?? 1);
    s.vel.x += wx * accel * dt;
    s.vel.z += wz * accel * dt;
    const k = Math.max(0, 1 - (has ? JETPACK.airDrag : JETPACK.brakeDrag) * dt);
    s.vel.x *= k;
    s.vel.z *= k;
  }
  // The eye follows the capsule actually in use: lit crouched under a low ceiling, standing up
  // fails and the crouched capsule stays, so must the crouched eye (shots leave from the eye).
  s.eyeHeight = approach(s.eyeHeight, stanceEyeHeight(s), PLAYER.eyeHeightSpeed * dt);
}

/**
 * How steady a flyer is for aiming, 0–1: 1 hovering still, 0 at `JETPACK.steadySpeed` (3-D).
 */
export function flightSteadiness(m: Pick<MoveState, 'vel'>): number {
  const v = Math.hypot(m.vel.x, m.vel.y, m.vel.z);
  return Math.max(0, 1 - v / JETPACK.steadySpeed);
}

// ---------------------------------------------------------------------------------------------
// Pickup rules
// ---------------------------------------------------------------------------------------------

/** One of the match's jetpacks. */
export interface JetpackItem {
  /** Stable index (its spot's). */
  id: number;
  /** Where it lies (feet level), or its carrier's feet. */
  pos: Vec3;
  /** Who wears it (null: lying free, or spent). */
  carrier: string | null;
  /** Its carrier ignited it: once the flight ends (or they die) it is gone for the match. */
  armed: boolean;
  /** Used up: gone until the next match. */
  spent: boolean;
}

export interface JetpackHolder {
  id: string;
  pos: Vec3;
  alive: boolean;
  /** `MoveState.jet`. */
  jet: number;
  /** May take one (default true): not while riding the skateboard, crawling or already wearing one. */
  eligible?: boolean;
}

export type JetpackEvent =
  | { type: 'pickup'; id: number; by: string }
  /** Its carrier died (or left) before igniting it: it lies there for anyone. */
  | { type: 'drop'; id: number; by: string; pos: Vec3 }
  /** Flown and done (or its carrier died mid-flight): gone for this match. */
  | { type: 'spent'; id: number; by: string };

/** The match's packs at their spots (cast onto the floor by the caller). */
export const createJetpacks = (spots: readonly Vec3[]): JetpackItem[] =>
  spots.map((pos, id) => ({ id, pos: { ...pos }, carrier: null, armed: false, spent: false }));

/**
 * One step of the rules. A carried pack follows its carrier, arms at ignition and is spent when
 * the flight ends; a carrier who dies (or leaves) drops an unlit pack where they were (`castDown`
 * puts it on the floor below) and loses a lit one. A free pack goes to the first eligible living
 * player in reach who wears none (list order: stable ties); the caller then `grantJetpack`s them.
 */
export function stepJetpacks(
  items: JetpackItem[],
  players: readonly JetpackHolder[],
  castDown: (from: Vec3) => Vec3 = (p) => p,
): JetpackEvent[] {
  const events: JetpackEvent[] = [];
  const taken = new Set<string>();
  for (const it of items) if (!it.spent && it.carrier !== null) taken.add(it.carrier);
  for (const it of items) {
    if (it.spent) continue;
    if (it.carrier !== null) {
      const by = it.carrier;
      const r = players.find((p) => p.id === by);
      // Lit is lit, alive or not: ignited and killed in the same tick still spends it.
      if (r && r.jet >= JetMode.Flying) it.armed = true;
      if (r && r.alive) {
        it.pos = { ...r.pos };
        if (r.jet !== JetMode.None) continue;
      }
      if (r) it.pos = { ...r.pos };
      it.carrier = null;
      taken.delete(by);
      if (it.armed) {
        it.spent = true;
        events.push({ type: 'spent', id: it.id, by });
      } else {
        it.pos = castDown(it.pos);
        events.push({ type: 'drop', id: it.id, by, pos: { ...it.pos } });
      }
      continue; // no same-step pickup: it lands first
    }
    for (const p of players) {
      if (!p.alive || p.eligible === false || p.jet !== JetMode.None || taken.has(p.id)) continue;
      if (Math.hypot(p.pos.x - it.pos.x, p.pos.z - it.pos.z) > JETPACK.pickupRadius) continue;
      if (Math.abs(p.pos.y - it.pos.y) > JETPACK.pickupHeight) continue;
      it.carrier = p.id;
      taken.add(p.id);
      events.push({ type: 'pickup', id: it.id, by: p.id });
      break;
    }
  }
  return events;
}

/**
 * A new life wears no pack (a fall out of the world respawns without a death step): an unlit one
 * goes back where it was last seen (its spot, if that was below the map), a lit one is spent.
 */
export function jetpackRespawned(
  items: JetpackItem[],
  id: string,
  homes: readonly Vec3[],
  castDown: (from: Vec3) => Vec3 = (p) => p,
): JetpackEvent[] {
  const events: JetpackEvent[] = [];
  for (const it of items) {
    if (it.spent || it.carrier !== id) continue;
    it.carrier = null;
    if (it.armed) {
      it.spent = true;
      events.push({ type: 'spent', id: it.id, by: id });
      continue;
    }
    it.pos = it.pos.y < -5 ? { ...(homes[it.id] ?? it.pos) } : castDown(it.pos);
    events.push({ type: 'drop', id: it.id, by: id, pos: { ...it.pos } });
  }
  return events;
}

/** Packs still in play (lying free or worn): the HUD's "n left" and the bots' targets. */
export const jetpacksLeft = (items: readonly JetpackItem[]): number =>
  items.filter((i) => !i.spent).length;
