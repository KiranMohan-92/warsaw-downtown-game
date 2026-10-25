import { PRIMARIES, WEAPON_DROP, type MatchMode, type PrimaryId } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import { equipTime, isGun } from './arsenal.ts';
import { holster, type PlayerState } from './player.ts';
import { createWeaponState, type WeaponState } from './weapon.ts';

export interface WeaponDropState {
  id: string;
  pos: Vec3;
  primary: PrimaryId;
  /** Remaining ammunition as a fraction of this gun's full mag + maximum reserve. */
  ammoFraction: number;
  ttl: number;
  /** Swap owner; death drops have no owner lock. */
  droppedBy?: string;
  /** Auto collection unlocks once the owner leaves pickup range, dies or respawns. */
  ownerClear?: boolean;
}

export interface WeaponDropsState {
  /** Oldest first, so cap eviction and equal-distance choices are deterministic. */
  drops: WeaponDropState[];
  nextId: number;
}

export interface WeaponDropCollector<Id extends string> {
  id: Id;
  player: PlayerState;
  bot?: boolean;
  /** A manual swap used this tick; still observe the owner leaving other drops. */
  skipAuto?: boolean;
  /** Floor below the feet, supplied by the caller's world query when a gun is left behind. */
  groundY?: number;
}

export type WeaponDropEvent<Id = string> =
  | { type: 'spawn'; drop: WeaponDropState }
  | { type: 'despawn'; dropId: string }
  | { type: 'ammo'; dropId: string; by: Id; amount: number }
  | { type: 'swap'; dropId: string; by: Id; primary: PrimaryId };

export const createWeaponDrops = (): WeaponDropsState => ({ drops: [], nextId: 1 });

const fullLoad = (primary: PrimaryId): number => {
  const cfg = PRIMARIES[primary];
  return cfg.magazineSize + cfg.reserveAmmo;
};

/** Integer rounds; epsilon only repairs floating-point loss on an exact round trip. */
const rounds = (fraction: number, primary: PrimaryId): number =>
  Math.floor(fraction * fullLoad(primary) + 1e-9);

export const primaryAmmoFraction = (
  primary: PrimaryId,
  weapon: Pick<WeaponState, 'ammo' | 'reserve'>,
): number => Math.max(0, Math.min(1, (weapon.ammo + weapon.reserve) / fullLoad(primary)));

/** Caller supplies the ground height, so the sim stays independent of physics and rendering. */
export function spawnDrop<Id extends string = string>(
  state: WeaponDropsState,
  primary: PrimaryId,
  pos: Vec3,
  ammoFraction: number,
  groundY = pos.y,
  mode: MatchMode = 'standard',
  droppedBy?: Id,
): WeaponDropEvent<Id>[] {
  const events: WeaponDropEvent<Id>[] = [];
  if (mode === 'knife' || !Number.isFinite(ammoFraction) || ammoFraction <= 0) return events;
  while (state.drops.length >= WEAPON_DROP.cap) {
    events.push({ type: 'despawn', dropId: state.drops.shift()!.id });
  }
  const drop: WeaponDropState = {
    id: `drop-${state.nextId++}`,
    pos: { x: pos.x, y: groundY, z: pos.z },
    primary,
    ammoFraction: Math.min(1, ammoFraction),
    ttl: WEAPON_DROP.ttl,
    ...(droppedBy === undefined ? {} : { droppedBy, ownerClear: false }),
  };
  state.drops.push(drop);
  events.push({ type: 'spawn', drop });
  return events;
}

/** Only the primary is dropped, regardless of the slot held at death. Bots use this too. */
export function spawnDeathDrop<Id extends string = string>(
  state: WeaponDropsState,
  player: PlayerState,
  groundY = player.move.pos.y,
): WeaponDropEvent<Id>[] {
  return spawnDrop(
    state,
    player.arsenal.primary,
    player.move.pos,
    primaryAmmoFraction(player.arsenal.primary, player.guns.rifle),
    groundY,
    player.arsenal.mode,
  );
}

function inRange(drop: WeaponDropState, pos: Vec3, radius: number): boolean {
  const dx = drop.pos.x - pos.x;
  const dz = drop.pos.z - pos.z;
  return (
    drop.ttl > 0 &&
    dx * dx + dz * dz <= radius * radius &&
    Math.abs(drop.pos.y - pos.y) <= WEAPON_DROP.pickupHeight
  );
}

function nearest(
  drops: readonly WeaponDropState[],
  pos: Vec3,
  radius: number,
  withAmmo: boolean,
  collectorId?: string,
): WeaponDropState | null {
  let found: WeaponDropState | null = null;
  let distance = Infinity;
  for (const drop of drops) {
    if (
      !inRange(drop, pos, radius) ||
      (withAmmo && rounds(drop.ammoFraction, drop.primary) <= 0) ||
      (collectorId !== undefined && ownerLocked(drop, collectorId))
    )
      continue;
    const dx = drop.pos.x - pos.x;
    const dz = drop.pos.z - pos.z;
    const d = dx * dx + dz * dz;
    if (d < distance) {
      found = drop;
      distance = d;
    }
  }
  return found;
}

/** E targeting and the HUD share this decision; an available truck seat keeps priority. */
export const nearestDrop = (
  drops: readonly WeaponDropState[],
  pos: Vec3,
  truckPriority = false,
): WeaponDropState | null =>
  truckPriority ? null : nearest(drops, pos, WEAPON_DROP.swapRadius, false);

const ownerLocked = (drop: WeaponDropState, id: string): boolean =>
  drop.droppedBy === id && !drop.ownerClear;

/** Life boundaries release old swaps even if death/respawn occurs between proximity steps. */
export function clearDropOwner(drops: readonly WeaponDropState[], id: string): void {
  for (const drop of drops) if (drop.droppedBy === id) drop.ownerClear = true;
}

/** Observe after every movement substep; neither ages drops nor collects their ammo. */
export function observeDropOwners<Id extends string>(
  state: WeaponDropsState,
  collectors: readonly WeaponDropCollector<Id>[],
): void {
  for (const drop of state.drops) {
    if (drop.droppedBy === undefined || drop.ownerClear) continue;
    const owner = collectors.find((c) => c.id === drop.droppedBy);
    if (
      owner &&
      (owner.player.health <= 0 || !inRange(drop, owner.player.move.pos, WEAPON_DROP.pickupRadius))
    )
      drop.ownerClear = true;
  }
}

const canCollect = <Id extends string>(c: WeaponDropCollector<Id>): boolean =>
  !c.bot && c.player.health > 0 && c.player.arsenal.mode !== 'knife' && c.player.seat === null;

function takeDrop<Id extends string>(
  state: WeaponDropsState,
  c: WeaponDropCollector<Id>,
  drop: WeaponDropState,
  events: WeaponDropEvent<Id>[],
): void {
  const p = c.player;
  const a = p.arsenal;
  const previous = a.primary;
  const fraction = primaryAmmoFraction(previous, p.guns.rifle);
  const shotCounter = p.guns.rifle.shotCounter;
  state.drops.splice(state.drops.indexOf(drop), 1);
  events.push({ type: 'despawn', dropId: drop.id });
  events.push(...spawnDrop<Id>(state, previous, p.move.pos, fraction, c.groundY, a.mode, c.id));
  if (isGun(a.target)) holster(p.guns[a.target]);
  a.primary = drop.primary;
  a.target = 'rifle';
  a.switchDuration = equipTime(a, 'rifle');
  a.switchTimer = a.switchDuration;
  const cfg = PRIMARIES[drop.primary];
  const ammo = rounds(drop.ammoFraction, drop.primary);
  p.guns.rifle = createWeaponState(cfg);
  p.guns.rifle.ammo = Math.min(cfg.magazineSize, ammo);
  p.guns.rifle.reserve = Math.min(cfg.reserveAmmo, Math.max(0, ammo - cfg.magazineSize));
  p.guns.rifle.shotCounter = shotCounter;
  events.push({ type: 'swap', dropId: drop.id, by: c.id, primary: drop.primary });
}

/** An Interact pressed edge, after the caller has offered that edge to truck seats. */
export function swapWithDrop<Id extends string>(
  state: WeaponDropsState,
  collector: WeaponDropCollector<Id>,
  truckPriority = false,
): WeaponDropEvent<Id>[] {
  const events: WeaponDropEvent<Id>[] = [];
  if (!canCollect(collector) || collector.player.drone?.alive) return events;
  const drop = nearestDrop(state.drops, collector.player.move.pos, truckPriority);
  if (drop) takeDrop(state, collector, drop, events);
  return events;
}

/**
 * Expire first, then let living human collectors act in stable list order. A completely empty
 * primary swaps before ammo transfer. Manual swappers skip auto collection this tick,
 * so their new gun cannot collect other nearby ammo in that same tick. Their discarded gun
 * stays locked to auto collection until they leave its range or their life ends.
 */
export function stepDrops<Id extends string>(
  state: WeaponDropsState,
  collectors: readonly WeaponDropCollector<Id>[],
  dt: number,
): WeaponDropEvent<Id>[] {
  const events: WeaponDropEvent<Id>[] = [];
  observeDropOwners(state, collectors);
  for (let i = 0; i < state.drops.length;) {
    const drop = state.drops[i]!;
    drop.ttl = Math.max(0, drop.ttl - dt);
    if (drop.ttl > 0) i++;
    else {
      state.drops.splice(i, 1);
      events.push({ type: 'despawn', dropId: drop.id });
    }
  }
  for (const c of collectors) {
    if (c.skipAuto || !canCollect(c)) continue;
    const p = c.player;
    const gun = p.guns.rifle;
    if (gun.ammo + gun.reserve === 0) {
      const drop = nearest(state.drops, p.move.pos, WEAPON_DROP.pickupRadius, true, c.id);
      if (drop) {
        takeDrop(state, c, drop, events);
        continue;
      }
    }
    const primary = p.arsenal.primary;
    const maxReserve = PRIMARIES[primary].reserveAmmo;
    for (const drop of state.drops) {
      if (gun.reserve >= maxReserve) break;
      if (ownerLocked(drop, c.id) || !inRange(drop, p.move.pos, WEAPON_DROP.pickupRadius)) continue;
      const amount = Math.min(maxReserve - gun.reserve, rounds(drop.ammoFraction, primary));
      if (amount <= 0) continue;
      gun.reserve += amount;
      drop.ammoFraction = Math.max(0, drop.ammoFraction - amount / fullLoad(primary));
      events.push({ type: 'ammo', dropId: drop.id, by: c.id, amount });
    }
  }
  return events;
}
