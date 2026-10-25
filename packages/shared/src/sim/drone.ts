import { DRONE, JAMMER } from '../config/tunables.ts';
import { DEG, type Vec3 } from '../math/vec3.ts';
import type { WorldRaycaster } from './hitscan.ts';
import { Button, type PlayerInput } from './input.ts';
import type { FoliageIndex } from '../maps/concealment.ts';
import { SIGHT_THRESHOLD, sightVisibility } from './perception.ts';
import type { SmokeCloud } from './smoke.ts';

/**
 * FPV recon drone. While a player pilots it, their PlayerInput drives the drone (their body
 * stands still and exposed): WASD fly, Jump climbs, Crouch descends, mouse looks. Anyone the
 * drone camera sees in the clear is *spotted*: shown on the pilot's radar for DRONE.spotTime.
 * It can be shot down (M3) or knocked out by a jammer. Deterministic: same code on the server.
 */
export interface DroneState {
  owner: number;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  battery: number;
  /** Launch height (the altitude cap is relative to it). */
  baseY: number;
  alive: boolean;
}

export interface DroneWorld {
  castRay(origin: Vec3, dir: Vec3, maxDistance: number): { distance: number } | null;
}

export function launchDrone(owner: number, eye: Vec3, yaw: number): DroneState {
  return {
    owner,
    pos: { x: eye.x, y: eye.y + 0.6, z: eye.z },
    vel: { x: 0, y: 2.5, z: 0 },
    yaw,
    pitch: -0.15,
    battery: DRONE.battery,
    baseY: eye.y,
    alive: true,
  };
}

/** One fixed step. Returns 'battery' when the flight ends because the battery ran out. */
export function stepDrone(
  d: DroneState,
  input: PlayerInput,
  dt: number,
  world: DroneWorld,
): 'battery' | null {
  if (!d.alive) return null;
  d.yaw = input.yaw;
  d.pitch = input.pitch;
  d.battery -= dt;
  if (d.battery <= 0) {
    d.alive = false;
    return 'battery';
  }
  // Target velocity: W/S fly along the camera's look direction (look up + W climbs, like an
  // FPV drone); A/D strafe level; Jump/Crouch add straight up/down on top.
  const cp = Math.cos(d.pitch);
  const fx = -Math.sin(d.yaw) * cp;
  const fy = Math.sin(d.pitch);
  const fz = -Math.cos(d.yaw) * cp;
  const rx = Math.cos(d.yaw);
  const rz = -Math.sin(d.yaw);
  // Diagonal sticks aren't faster than straight ones.
  const len = Math.max(1, Math.hypot(input.moveX, input.moveZ));
  const mx = input.moveX / len;
  const mz = input.moveZ / len;
  const tx = (fx * mz + rx * mx) * DRONE.speed;
  const tz = (fz * mz + rz * mx) * DRONE.speed;
  const lift =
    (input.buttons & Button.Jump ? DRONE.climb : 0) -
    (input.buttons & Button.Crouch ? DRONE.climb : 0);
  const ty = Math.max(-DRONE.speed, Math.min(DRONE.speed, fy * mz * DRONE.speed + lift));
  const step = DRONE.accel * dt;
  const toward = (v: number, t: number): number =>
    Math.abs(t - v) <= step ? t : v + Math.sign(t - v) * step;
  d.vel.x = toward(d.vel.x, tx);
  d.vel.z = toward(d.vel.z, tz);
  d.vel.y = toward(d.vel.y, ty);
  // Move one axis at a time, stopping short of geometry by the drone's radius (slides along
  // walls and ceilings instead of sticking).
  const move = { x: d.vel.x * dt, y: d.vel.y * dt, z: d.vel.z * dt };
  for (const axis of ['x', 'y', 'z'] as const) {
    const m = move[axis];
    if (Math.abs(m) < 1e-6) continue;
    const dir: Vec3 = { x: 0, y: 0, z: 0 };
    dir[axis] = Math.sign(m);
    // The drone is a ball, not a point: probe from its centre plus eight rim points (95% of its
    // radius, so a drone resting against a wall can still slide along it) around the travel axis:
    // it can't slip through gaps narrower than itself.
    const [u, v] = (['x', 'y', 'z'] as const).filter((a) => a !== axis) as [
      'x' | 'y' | 'z',
      'x' | 'y' | 'z',
    ];
    const k = DRONE.radius * 0.95;
    const q = k * Math.SQRT1_2;
    const rim: readonly (readonly [number, number])[] = [
      [0, 0],
      [k, 0],
      [-k, 0],
      [0, k],
      [0, -k],
      [q, q],
      [q, -q],
      [-q, q],
      [-q, -q],
    ];
    let hit: { distance: number } | null = null;
    for (const [ou, ov] of rim) {
      const o = { ...d.pos };
      o[u] += ou;
      o[v] += ov;
      const h = world.castRay(o, dir, Math.abs(m) + DRONE.radius);
      if (h && (!hit || h.distance < hit.distance)) hit = h;
    }
    if (hit) {
      d.pos[axis] += Math.sign(m) * Math.max(0, hit.distance - DRONE.radius);
      d.vel[axis] = 0;
    } else {
      d.pos[axis] += m;
    }
  }
  d.pos.y = Math.min(d.pos.y, d.baseY + DRONE.maxAltitude);
  return null;
}

export interface SpotTarget<Id> {
  id: Id;
  /** Chest point to check line of sight to. */
  pos: Vec3;
}

/** Everyone the drone camera sees: in range, inside the view cone, in line of sight, not in smoke. */
export function droneSpots<Id>(
  d: DroneState,
  targets: readonly SpotTarget<Id>[],
  world: WorldRaycaster,
  smoke: readonly SmokeCloud[],
  foliage?: FoliageIndex | null,
): Id[] {
  if (!d.alive) return [];
  const cp = Math.cos(d.pitch);
  const view = { x: -Math.sin(d.yaw) * cp, y: Math.sin(d.pitch), z: -Math.cos(d.yaw) * cp };
  const cosHalf = Math.cos((DRONE.spotFovDeg / 2) * DEG);
  const out: Id[] = [];
  for (const t of targets) {
    const dx = t.pos.x - d.pos.x;
    const dy = t.pos.y - d.pos.y;
    const dz = t.pos.z - d.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > DRONE.spotRange || dist < 1e-3) continue;
    if ((dx * view.x + dy * view.y + dz * view.z) / dist < cosHalf) continue;
    // Same sight rules as everyone: walls hide, smoke and foliage thin the view.
    if (sightVisibility(d.pos, t.pos, world, smoke, foliage) < SIGHT_THRESHOLD) continue;
    out.push(t.id);
  }
  return out;
}

/**
 * Jammer pulse at `center`: knocks down every drone in range except the jammer owner's own,
 * and lists who else gets a jammed radar. (Line of sight doesn't matter — it's radio.)
 */
export function jammerPulse<Id>(
  center: Vec3,
  owner: number,
  drones: readonly DroneState[],
  players: readonly { id: Id; pos: Vec3; owner: number }[],
): { downed: DroneState[]; jammed: Id[] } {
  const inRange = (p: Vec3): boolean =>
    Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) <= JAMMER.radius;
  const downed = drones.filter((d) => d.alive && d.owner !== owner && inRange(d.pos));
  for (const d of downed) d.alive = false;
  const jammed = players.filter((p) => p.owner !== owner && inRange(p.pos)).map((p) => p.id);
  return { downed, jammed };
}
