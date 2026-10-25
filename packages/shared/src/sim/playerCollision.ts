import { PLAYER, PLAYER_COLLISION } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import { isMeleeing } from './arsenal.ts';
import type { PlayerInput } from './input.ts';
import type { MoveState } from './movement.ts';
import {
  stepPlayer,
  type CharacterBody,
  type PlayerEvent,
  type PlayerState,
  type StepEnv,
} from './player.ts';
import type { VehicleObstacle } from './vehicles/vehicle.ts';
import { pushOutOfVehicle } from './vehicles/vehicleHits.ts';

/**
 * Someone a player can bump into: feet position and cylinder height (m). The server lists every
 * living player as of the start of each substep of its tick; a client lists the others as of
 * their newest snapshot (it never knows them any better), so both resolve the same way up to
 * that lag.
 */
export interface CrowdMember {
  id: string;
  x: number;
  y: number;
  z: number;
  height: number;
}

/** Collision cylinder height for a stance (prone keeps the short upright cylinder). */
export const crowdHeight = (crouched: boolean, prone: boolean): number =>
  prone ? PLAYER.proneHeight : crouched ? PLAYER.crouchHeight : PLAYER.standHeight;

/** Write a living player's collision cylinder into `out` (reused: no garbage per tick). */
export function crowdMemberOf(id: string, m: MoveState, out: CrowdMember): CrowdMember {
  out.id = id;
  out.x = m.pos.x;
  out.y = m.pos.y;
  out.z = m.pos.z;
  out.height = crowdHeight(m.crouched, m.prone);
  return out;
}

/** Passes of the joint walking restriction (contacts are few: 2–3 settle a wedge). */
const SOLVE_PASSES = 4;

/** Someone else, and overlapping vertically (feet `y`, cylinder `height`). */
const beside = (q: CrowdMember, selfId: string, y: number, height: number): boolean =>
  q.id !== selfId && y < q.y + q.height && q.y < y + height;

const before: Vec3 = { x: 0, y: 0, z: 0 };
const push: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * `stepPlayer`, then the player-collision pass against `crowd` (the stepping player's own entry,
 * `selfId`, is skipped). Every caller that steps a player among others uses this: the server's
 * tick and idle steps, client prediction and its reconcile replays, so all of them agree.
 */
export function stepPlayerInCrowd(
  p: PlayerState,
  input: PlayerInput,
  dt: number,
  body: CharacterBody,
  crowd: readonly CrowdMember[] | undefined,
  selfId: string,
  env?: StepEnv,
): PlayerEvent[] {
  before.x = p.move.pos.x;
  before.y = p.move.pos.y;
  before.z = p.move.pos.z;
  const events = stepPlayer(p, input, dt, body, env);
  if (p.seat) return events;
  if (crowd?.length) separateFromCrowd(p, before, crowd, selfId, body, dt);
  if (env?.vehicles?.length) separateFromVehicles(p, env.vehicles, body);
  return events;
}

/**
 * Vehicles are solid to walkers: a player inside a truck's footprint (inflated by the capsule
 * radius) is moved straight out of it through the character controller (never into a wall), and
 * loses the velocity into it. A truck driving into someone shoves them aside this way; above
 * `VEHICLE.runOverSpeed` the server's run-over damage comes on top. Seated players are skipped.
 */
export function separateFromVehicles(
  p: PlayerState,
  vehicles: readonly VehicleObstacle[],
  body: CharacterBody,
): boolean {
  const m = p.move;
  if (p.seat || p.health <= 0 || m.traversal) return false;
  const height = crowdHeight(m.crouched, m.prone);
  let any = false;
  for (const o of vehicles) {
    const push = pushOutOfVehicle(m.pos, PLAYER.radius, height, o);
    if (!push) continue;
    any = true;
    const len = Math.hypot(push.x, push.z);
    const k = (len + 0.002) / Math.max(len, 1e-9);
    const delta = { x: push.x * k, y: 0, z: push.z * k };
    const moved = body.nudge ? body.nudge(delta) : body.move(delta).moved;
    m.pos = { x: m.pos.x + moved.x, y: m.pos.y + moved.y, z: m.pos.z + moved.z };
    const nx = push.x / Math.max(len, 1e-9);
    const nz = push.z / Math.max(len, 1e-9);
    const into = -(m.vel.x * nx + m.vel.z * nz);
    if (into > 0) {
      m.vel.x += nx * into;
      m.vel.z += nz * into;
    }
  }
  return any;
}

/**
 * Soft player collision for one player after its step (`from`: its feet before the step). Each
 * player only ever moves itself, from positions both machines know, so prediction is the same
 * code as the server; two players in contact each resolve their own share:
 *
 * 1. Walking in stops at `walkPenetration` (or at the start-of-step overlap, if deeper: being
 *    shoved or spawned inside someone never teleports you out). It is solved jointly over all
 *    contacts and never undoes more than this step's own motion; velocity into them is cut to
 *    `shoveSpeed`. A knife lunge stops at the target the same way.
 * 2. The remaining overlap is resolved at `resolveRate` of it per step, capped (with the slip)
 *    at `maxPushSpeed` in total: a standing player is shoved along at ~1.4 m/s, never flung.
 * 3. Head-on, you sidestep to your right (`slipSpeed`): nobody holds a corridor or a doorway.
 *    Not mid knife strike: the lunge stays on its target.
 *
 * The push goes through the character controller (`nudge`): it slides along walls and never
 * enters geometry. The dead, and climbers (on a fixed path), are not resolved.
 */
export function separateFromCrowd(
  p: PlayerState,
  from: Vec3,
  crowd: readonly CrowdMember[],
  selfId: string,
  body: CharacterBody,
  dt: number,
): boolean {
  const C = PLAYER_COLLISION;
  const m = p.move;
  if (!C.enabled || p.health <= 0 || m.traversal) return false;
  const reach = 2 * C.radius;
  const height = crowdHeight(m.crouched, m.prone);
  const { x, y, z } = m.pos;
  // This step's own horizontal motion: its direction decides "head-on" and the slip side.
  const mx = x - from.x;
  const mz = z - from.z;
  const mLen = Math.hypot(mx, mz);
  // Mid-strike you stay on the target (a lunge stops at it rather than sliding round it).
  const slip = !isMeleeing(p.arsenal);

  // 1. Walking restriction, jointly: a few Gauss-Seidel passes, each moving the point just out to
  //    one contact's limit. Summing every contact's full rollback instead would retract more
  //    than the step moved when two neighbours already press on you (a fast backward shove).
  let px = x;
  let pz = z;
  let touched = false;
  for (let pass = 0; pass < SOLVE_PASSES; pass++) {
    let corrected = false;
    for (const q of crowd) {
      if (!beside(q, selfId, y, height)) continue;
      const ox = px - q.x;
      const oz = pz - q.z;
      const d2 = ox * ox + oz * oz;
      if (d2 >= reach * reach) continue;
      touched = true;
      const d = Math.sqrt(d2);
      const allowed = Math.max(reach - Math.hypot(from.x - q.x, from.z - q.z), C.walkPenetration);
      const excess = reach - d - allowed;
      if (excess <= 1e-9) continue;
      // Exactly on top of each other, the ids split the two apart (opposite ways on both sides).
      const nx = d > 1e-4 ? ox / d : selfId < q.id ? 1 : -1;
      const nz = d > 1e-4 ? oz / d : 0;
      px += nx * excess;
      pz += nz * excess;
      corrected = true;
      const into = -(m.vel.x * nx + m.vel.z * nz);
      if (into > C.shoveSpeed) {
        m.vel.x += nx * (into - C.shoveSpeed);
        m.vel.z += nz * (into - C.shoveSpeed);
      }
    }
    if (!corrected) break;
  }
  if (!touched) return false;
  // Only ever undo this step's own motion: never more than it moved.
  let hardX = px - x;
  let hardZ = pz - z;
  const hard = Math.hypot(hardX, hardZ);
  if (hard > mLen) {
    hardX *= mLen / hard;
    hardZ *= mLen / hard;
  }
  px = x + hardX;
  pz = z + hardZ;

  // 2. + 3. Soft separation of the overlap that remains, and the head-on sidestep, from where the
  //    walking restriction left you; capped as a whole.
  let softX = 0;
  let softZ = 0;
  for (const q of crowd) {
    if (!beside(q, selfId, y, height)) continue;
    const ox = px - q.x;
    const oz = pz - q.z;
    const d2 = ox * ox + oz * oz;
    if (d2 >= reach * reach) continue;
    const d = Math.sqrt(d2);
    const nx = d > 1e-4 ? ox / d : selfId < q.id ? 1 : -1;
    const nz = d > 1e-4 ? oz / d : 0;
    softX += nx * (reach - d) * C.resolveRate;
    softZ += nz * (reach - d) * C.resolveRate;
    // Head-on: they are (nearly) on my line of motion and I moved toward them.
    if (slip && mLen > 1e-5 && mx * nx + mz * nz < 0) {
      const fx = mx / mLen;
      const fz = mz / mLen;
      // Right of the motion is (-fz, fx); their offset across my line decides "head-on".
      const across = -(q.x - px) * fz + (q.z - pz) * fx;
      if (Math.abs(across) < C.slipBand) {
        softX += -fz * C.slipSpeed * dt;
        softZ += fx * C.slipSpeed * dt;
      }
    }
  }
  const soft = Math.hypot(softX, softZ);
  const cap = C.maxPushSpeed * dt;
  const k = soft > cap ? cap / soft : 1;
  push.x = hardX + softX * k;
  push.z = hardZ + softZ * k;
  if (Math.hypot(push.x, push.z) < 1e-6) return true;
  const moved = body.nudge ? body.nudge(push) : body.move(push).moved;
  m.pos = { x: x + moved.x, y: y + moved.y, z: z + moved.z };
  return true;
}
