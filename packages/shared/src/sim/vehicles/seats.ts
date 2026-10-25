/**
 * Seats: who sits where, what each seat lets you do, getting in (the nearest free seat) and out
 * (a safe spot beside the truck, never into a wall). Pure; the server applies them (enter/exit
 * are server decisions the client learns from its own snapshot), bots press the same buttons.
 */
import { PLAYER, VEHICLE } from '../../config/tunables.ts';
import type { Vec3 } from '../../math/vec3.ts';
import { Button } from '../input.ts';
import type { Slot } from '../arsenal.ts';
import { EXIT_POS, SEAT_SPEC, SEATS, TRUCK, type SeatId } from './truckSpec.ts';
import {
  localToWorld,
  vehicleBasis,
  worldToLocal,
  wrapAngle,
  type VehicleMotion,
} from './vehicle.ts';

/** A player's seat (`PlayerState.seat`). The driver's state carries the vehicle's motion. */
export interface SeatState {
  vehicle: number;
  seat: SeatId;
  /** The driven vehicle's motion (driver only): stepped with the driver's inputs. */
  motion?: VehicleMotion;
}

export const cloneSeat = (s: SeatState | null): SeatState | null =>
  s
    ? {
        vehicle: s.vehicle,
        seat: s.seat,
        ...(s.motion
          ? { motion: { ...s.motion, pos: { ...s.motion.pos }, vel: { ...s.motion.vel } } }
          : {}),
      }
    : null;

/** Seat on the wire: vehicle id × 8 + seat index (`SnapshotPlayer.vh`). */
export const seatToWire = (s: SeatState): number => s.vehicle * 8 + SEATS.indexOf(s.seat);
export function seatFromWire(vh: number | undefined): { vehicle: number; seat: SeatId } | null {
  if (vh === undefined || !Number.isInteger(vh) || vh < 0) return null;
  const seat = SEATS[vh % 8];
  return seat ? { vehicle: Math.floor(vh / 8), seat } : null;
}

/**
 * Buttons a seat can't use: the driver's hands are on the wheel (no shooting, aiming, knife,
 * throws or guard; reloading is fine), the cab is too tight for knife or throws, the bed lets
 * you throw over the side but not swing a knife.
 */
export function seatButtonMask(seat: SeatId, slot?: Slot): number {
  const hands = Button.Melee | Button.Block;
  const throws = Button.Grenade | Button.Smoke | Button.Jammer;
  const move = Button.Sprint | Button.Crouch | Button.Prone | Button.TacSprint;
  if (seat === 'driver') return hands | throws | move | Button.Fire | Button.Ads;
  // With the knife in hand, Fire is a slash: no knife from a seat (knife-only mode included).
  const knife = slot === 'knife' ? Button.Fire : 0;
  if (SEAT_SPEC[seat].cab) return hands | throws | move | knife;
  return hands | move | knife;
}

/**
 * Riding together is a truce: is a player in vehicle `other` the crew of a shooter in vehicle
 * `crew`? The one rule for hits, smart-round homing and knife targets, client and server.
 */
export const sameCrew = (
  crew: number | null | undefined,
  other: number | null | undefined,
): boolean => crew !== undefined && crew !== null && other === crew;

/** Feet (the floor under the seat) and eye height for an occupant (hit volumes, shots, camera). */
export function seatFeet(m: VehicleMotion, seat: SeatId, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const s = SEAT_SPEC[seat];
  return localToWorld(
    m.pos,
    vehicleBasis(m.yaw, m.pitch, m.roll),
    // (A leaning seat shifts the body toward its window.)
    { x: s.hip.x + (s.lean ?? 0), y: s.floor, z: s.hip.z },
    out,
  );
}

export const seatEyeHeight = (seat: SeatId): number => SEAT_SPEC[seat].eye;

/**
 * Whether a shot from `seat` along view yaw `viewYaw` is inside the seat's fire arc on a vehicle
 * heading `heading`: the front passenger shoots out of the right window and through the
 * windscreen (`VEHICLE.frontArcMin/Max`), the bed seats all round, the driver never.
 */
export function inFireArc(seat: SeatId, viewYaw: number, heading: number): boolean {
  if (seat === 'driver') return false;
  if (seat !== 'front') return true;
  // View forward = (-sin yaw, -cos yaw); relative to the vehicle's forward (+ = left).
  const aim = Math.atan2(-Math.sin(viewYaw), -Math.cos(viewYaw));
  const rel = wrapAngle(aim - heading);
  return rel >= VEHICLE.frontArcMin && rel <= VEHICLE.frontArcMax;
}

/** Where someone gets in to each seat (local): beside the doors, beside the bed. */
const ACCESS: Readonly<Record<SeatId, Vec3>> = {
  driver: { x: TRUCK.width / 2 + 0.3, y: 0, z: SEAT_SPEC.driver.hip.z },
  front: { x: -TRUCK.width / 2 - 0.3, y: 0, z: SEAT_SPEC.front.hip.z },
  rearL: { x: TRUCK.width / 2 + 0.3, y: 0, z: SEAT_SPEC.rearL.hip.z },
  rearR: { x: -TRUCK.width / 2 - 0.3, y: 0, z: SEAT_SPEC.rearR.hip.z },
};

/** Horizontal distance from a point to the vehicle's footprint (0 inside). */
export function distanceToVehicle(m: VehicleMotion, p: Vec3): number {
  const l = worldToLocal(m.pos, vehicleBasis(m.yaw, 0, 0), p);
  const dx = Math.max(0, Math.abs(l.x) - TRUCK.width / 2);
  const dz = Math.max(0, Math.abs(l.z) - TRUCK.length / 2);
  return Math.hypot(dx, dz);
}

/**
 * The seat a player at `feet` gets into: the free one whose door (or bed side) is nearest, if the
 * player is within `VEHICLE.enterReach` of the body and level with it. With `world`, only a
 * door the player can reach without passing through static geometry counts (chest height to
 * chest height): a truck on the other side of a wall is not within reach. Null if none.
 */
export function chooseSeat(
  m: VehicleMotion,
  occupied: ReadonlySet<SeatId>,
  feet: Vec3,
  world?: Pick<ExitQueries, 'castRay'>,
): SeatId | null {
  if (distanceToVehicle(m, feet) > VEHICLE.enterReach) return null;
  if (Math.abs(feet.y - m.pos.y) > 1.6) return null;
  const basis = vehicleBasis(m.yaw, 0, 0);
  let best: SeatId | null = null;
  let bestD = Infinity;
  for (const seat of SEATS) {
    if (occupied.has(seat)) continue;
    const a = localToWorld(m.pos, basis, ACCESS[seat]);
    const d = Math.hypot(a.x - feet.x, a.z - feet.z);
    if (d >= bestD) continue;
    if (world && !accessClear(world, feet, { x: a.x, y: m.pos.y, z: a.z })) continue;
    bestD = d;
    best = seat;
  }
  return best;
}

/** No static geometry between a player's chest and a door's (both 1.1 m over their feet). */
function accessClear(world: Pick<ExitQueries, 'castRay'>, feet: Vec3, door: Vec3): boolean {
  const from = { x: feet.x, y: feet.y + 1.1, z: feet.z };
  const dx = door.x - from.x;
  const dy = door.y + 1.1 - from.y;
  const dz = door.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return true;
  const hit = world.castRay(from, { x: dx / len, y: dy / len, z: dz / len }, len);
  return !hit || hit.distance >= len - 0.05;
}

/** The next free seat after `from` in seat order (seat switching), or null. */
export function nextFreeSeat(from: SeatId, occupied: ReadonlySet<SeatId>): SeatId | null {
  const i = SEATS.indexOf(from);
  for (let k = 1; k < SEATS.length; k++) {
    const s = SEATS[(i + k) % SEATS.length]!;
    if (!occupied.has(s)) return s;
  }
  return null;
}

/** What `findExitSpot` needs of the world (the physics world provides both). */
export interface ExitQueries {
  overlapsStatic(feet: Vec3, height: number, shrink?: number): boolean;
  castRay(origin: Vec3, dir: Vec3, maxDistance: number): { distance: number; point: Vec3 } | null;
}

/**
 * A safe spot to get out of `seat` at: the seat's own side first, then the other side, behind,
 * in front, a little further out each ring. A spot must fit a standing capsule, have ground under
 * it within a metre, be clear of `blocked` (other vehicles' footprints) and be reachable from the
 * seat without passing through a wall (never out through geometry). Null if boxed in.
 */
export function findExitSpot(
  world: ExitQueries,
  m: VehicleMotion,
  seat: SeatId,
  blocked: (feet: Vec3) => boolean = () => false,
): Vec3 | null {
  const basis = vehicleBasis(m.yaw, 0, 0);
  const own = EXIT_POS[SEAT_SPEC[seat].exit];
  const other = EXIT_POS[SEAT_SPEC[seat].exit === 'l' ? 'r' : 'l'];
  const hz = TRUCK.length / 2 + PLAYER.radius + 0.25;
  const candidates: Vec3[] = [];
  for (const out of [0, 0.6, 1.3]) {
    const side = (e: Vec3, z: number): Vec3 => ({ x: e.x + Math.sign(e.x) * out, y: 0, z });
    candidates.push(side(own, own.z), side(own, own.z - 1.4), side(own, own.z + 1.2));
    candidates.push(side(other, other.z), side(other, other.z - 1.4), side(other, other.z + 1.2));
    candidates.push({ x: 0, y: 0, z: -hz - out }, { x: 0, y: 0, z: hz + out });
  }
  const hip = localToWorld(m.pos, basis, SEAT_SPEC[seat].hip);
  for (const c of candidates) {
    const at = localToWorld(m.pos, basis, c);
    // Ground under it: from hip height down.
    const top = { x: at.x, y: m.pos.y + 1.4, z: at.z };
    const down = world.castRay(top, { x: 0, y: -1, z: 0 }, 2.6);
    if (!down) continue;
    const feet = { x: at.x, y: down.point.y + 0.02, z: at.z };
    if (Math.abs(feet.y - m.pos.y) > 1) continue;
    if (world.overlapsStatic(feet, PLAYER.standHeight)) continue;
    if (blocked(feet)) continue;
    // Never out through a wall: the way from the seat to the spot's chest height is clear.
    const chest = { x: feet.x, y: feet.y + 1.1, z: feet.z };
    const dx = chest.x - hip.x;
    const dy = chest.y - hip.y;
    const dz = chest.z - hip.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-3) {
      const hit = world.castRay(hip, { x: dx / len, y: dy / len, z: dz / len }, len);
      if (hit && hit.distance < len - 0.05) continue;
    }
    return feet;
  }
  return null;
}
