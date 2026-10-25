import {
  BOT,
  FoliageIndex,
  SIGHT_THRESHOLD,
  eyePosition,
  isGun,
  isSpawnProtected,
  jetAltitude,
  sightVisibility,
  type JetpackItem,
  type MapDefinition,
  type PhysicsWorld,
  type SightWorld,
  type SmokeCloud,
  type Vec3,
} from '@wd/shared';
import type {
  BotPlayerObservation,
  BotVisibleDrone,
  BotVisiblePlayer,
  PublicPlayerLike,
} from './types.ts';
import type { BotMemory, BotObservation, BotVehicleView } from './types.ts';
import type { DriveGraph } from '@wd/shared';
import type { NavGraph } from './nav.ts';

const copyVec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const BOT_FOV_COS = Math.cos(((BOT.sightFovDeg / 2) * Math.PI) / 180);

export function playerObservation(p: PublicPlayerLike): BotPlayerObservation {
  const weapon = isGun(p.state.arsenal.slot) ? p.state.arsenal.slot : 'knife';
  const gun = weapon === 'knife' ? null : p.state.guns[weapon];
  return {
    id: p.id,
    name: p.name,
    slot: p.slot,
    isBot: p.isBot,
    health: p.state.health,
    ammo: gun?.ammo ?? 0,
    reserve: gun?.reserve ?? 0,
    reloadTimer: gun?.reloadTimer ?? 0,
    grenades: p.state.arsenal.grenades,
    weapon,
    primary: p.state.arsenal.primary,
    heat: gun?.heat ?? 0,
    charge: gun?.charge ?? 0,
    adsAmount: gun?.adsAmount ?? 0,
    primaryRounds: p.state.guns.rifle.ammo + p.state.guns.rifle.reserve,
    recoilPitch: gun?.recoilPitch ?? 0,
    recoilYaw: gun?.recoilYaw ?? 0,
    sprinting: p.state.move.sprinting,
    tacSprint: p.state.move.tacSprint,
    tacFuel: p.state.move.tacFuel,
    grounded: p.state.move.grounded,
    jet: p.state.move.jet,
    jetFuel: p.state.move.jetFuel,
    pos: copyVec(p.state.move.pos),
    eye: eyePosition(p.state),
    yaw: p.state.view.yaw,
    pitch: p.state.view.pitch,
    seat: p.state.seat ? { vehicle: p.state.seat.vehicle, seat: p.state.seat.seat } : null,
  };
}

export interface VisibilityOptions {
  readonly map: MapDefinition;
  readonly physics: PhysicsWorld;
  readonly self: PublicPlayerLike;
  readonly players: Iterable<PublicPlayerLike>;
  readonly smoke?: readonly SmokeCloud[];
  readonly foliage?: FoliageIndex | null;
  /**
   * What sight lines meet: the static world plus the trucks' armour (`withHulls`), as for
   * bullets — a bot doesn't see through a truck. Defaults to the static world.
   */
  readonly sight?: SightWorld;
}

export function buildVisiblePlayers(opts: VisibilityOptions): BotVisiblePlayer[] {
  const smoke = opts.smoke ?? [];
  const foliage = opts.foliage ?? new FoliageIndex(opts.map.foliage ?? []);
  const from = eyePosition(opts.self.state);
  const visible: BotVisiblePlayer[] = [];
  for (const p of opts.players) {
    if (p.id === opts.self.id || p.state.health <= 0) continue;
    const base = playerObservation(p);
    if (!insideSightCone(from, opts.self.state.view.yaw, opts.self.state.view.pitch, base.eye))
      continue;
    const visibility = sightVisibility(from, base.eye, opts.sight ?? opts.physics, smoke, foliage);
    if (visibility >= SIGHT_THRESHOLD) {
      visible.push({
        id: base.id,
        kind: 'player',
        name: base.name,
        isBot: base.isBot,
        pos: base.pos,
        eye: base.eye,
        yaw: base.yaw,
        pitch: base.pitch,
        slot: base.slot,
        visibility,
        protected: isSpawnProtected(p.state),
        reloading: base.reloadTimer > 0,
        ...(p.state.seat ? { vehicle: p.state.seat.vehicle } : {}),
      });
    }
  }
  return visible;
}

export function buildVisibleDrones(opts: VisibilityOptions): BotVisibleDrone[] {
  const smoke = opts.smoke ?? [];
  const foliage = opts.foliage ?? new FoliageIndex(opts.map.foliage ?? []);
  const from = eyePosition(opts.self.state);
  const visible: BotVisibleDrone[] = [];
  for (const p of opts.players) {
    if (p.id === opts.self.id || p.state.health <= 0 || !p.state.drone?.alive) continue;
    const d = p.state.drone;
    if (!insideSightCone(from, opts.self.state.view.yaw, opts.self.state.view.pitch, d.pos))
      continue;
    const visibility = sightVisibility(from, d.pos, opts.sight ?? opts.physics, smoke, foliage);
    if (visibility >= SIGHT_THRESHOLD) {
      visible.push({
        kind: 'drone',
        id: `drone:${p.id}`,
        ownerId: p.id,
        isBot: p.isBot,
        pos: copyVec(d.pos),
        eye: copyVec(d.pos),
        yaw: d.yaw,
        pitch: d.pitch,
        slot: p.slot,
        visibility,
        protected: false,
        reloading: false,
      });
    }
  }
  return visible;
}

export interface BotObservationOptions extends VisibilityOptions {
  readonly nowMs: number;
  readonly seq: number;
  readonly nav: NavGraph;
  readonly memories?: readonly BotMemory[];
  readonly mode: 'standard' | 'knife';
  /** Every truck of the match (filtered here to the ones this bot notices). */
  readonly vehicles?: readonly BotVehicleView[];
  readonly drive?: DriveGraph | null;
  /** The match's jetpacks (free ones go into the observation). */
  readonly jetpacks?: readonly JetpackItem[];
}

export function buildBotObservation(opts: BotObservationOptions): BotObservation {
  return {
    nowMs: opts.nowMs,
    seq: opts.seq,
    map: opts.map,
    nav: opts.nav,
    self: selfObservation(opts),
    visiblePlayers: buildVisiblePlayers(opts),
    visibleDrones: buildVisibleDrones(opts),
    memories: opts.memories ?? [],
    smoke: (opts.smoke ?? []).map((c) => ({ id: c.id, age: c.age, pos: copyVec(c.pos) })),
    mode: opts.mode,
    vehicles: noticedVehicles(opts),
    drive: opts.drive ?? null,
    ...(opts.jetpacks?.length
      ? {
          jetpacks: opts.jetpacks
            .filter((j) => !j.spent && j.carrier === null)
            .map((j) => ({ id: j.id, pos: copyVec(j.pos) })),
        }
      : {}),
  };
}

/** Our own HUD: everything public plus, on a jetpack, the altitude bar's reading. */
function selfObservation(opts: BotObservationOptions): BotPlayerObservation {
  const base = playerObservation(opts.self);
  if (!base.jet) return base;
  const alt = jetAltitude(opts.physics, opts.self.state.move.pos);
  return alt === null ? base : { ...base, jetAlt: alt };
}

/**
 * The trucks a bot knows about by player rules: heard within `BOT.vehicle.noticeRange` (a diesel
 * engine), or seen (a clear line to the cab roof) within sight range; its own, always.
 */
function noticedVehicles(opts: BotObservationOptions): BotVehicleView[] {
  const all = opts.vehicles ?? [];
  if (!all.length) return [];
  const eye = eyePosition(opts.self.state);
  const mine = opts.self.state.seat?.vehicle;
  return all.filter((v) => {
    if (v.id === mine) return true;
    const d = Math.hypot(v.pos.x - eye.x, v.pos.z - eye.z);
    if (d <= BOT.vehicle.noticeRange) return true;
    if (d > BOT.sightRange) return false;
    const roof = { x: v.pos.x, y: v.pos.y + 1.9, z: v.pos.z };
    return sightVisibility(eye, roof, opts.physics, [], null) >= SIGHT_THRESHOLD;
  });
}

function insideSightCone(from: Vec3, yaw: number, pitch: number, to: Vec3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  if (dist > BOT.sightRange) return false;
  const cosPitch = Math.cos(pitch);
  const forwardX = -Math.sin(yaw) * cosPitch;
  const forwardY = Math.sin(pitch);
  const forwardZ = -Math.cos(yaw) * cosPitch;
  return (forwardX * dx + forwardY * dy + forwardZ * dz) / dist >= BOT_FOV_COS;
}
