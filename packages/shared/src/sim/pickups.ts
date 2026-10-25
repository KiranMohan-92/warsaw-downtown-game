import { MEDKIT, PLAYER, RADAR } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { PickupDef, PickupKind } from '../maps/types.ts';
import { Button } from './input.ts';

/**
 * Radar uplinks: walking onto one stores a radar *charge*; the player calls it in when they
 * choose (Radar button) to see every opponent for `RADAR.duration` seconds. The uplink then
 * recharges. Nobody is ever shown on your radar unless you called it in (Kiran). Contested spots pull players together (a modern-shooter fix for
 * big maps where people lose each other). Pure and deterministic: the M3 server owns this state.
 */
export interface PickupState {
  id: string;
  pos: Vec3;
  kind: PickupKind;
  /** Seconds until available again (0 = available). */
  cooldown: number;
}

export const createPickups = (defs: readonly PickupDef[]): PickupState[] =>
  defs.map((d) => ({ id: d.id, pos: { ...d.pos }, kind: d.kind, cooldown: 0 }));

/**
 * The pickups an online match owns: medkits always, radar uplinks unless the host turned radar
 * off. Recon uplinks remain available with radar off: their spotting is a separate sight rule.
 * The server builds its state from this; clients draw it until the first snapshot.
 */
export const matchPickupDefs = (
  defs: readonly PickupDef[],
  radar: 'uplinks' | 'off',
): PickupDef[] =>
  defs.filter(
    (p) => (radar === 'uplinks' && p.kind === 'radar') || p.kind === 'drone' || p.kind === 'medkit',
  );

export interface Collector<Id> {
  id: Id;
  /** Feet position. */
  pos: Vec3;
  alive: boolean;
  /** Whether they can take this kind now (already full → walks past, leaving it for others). */
  takes?: (kind: PickupKind) => boolean;
}

export interface PickupEvent<Id> {
  pickupId: string;
  by: Id;
  kind: PickupKind;
}

/**
 * Tick cooldowns and hand available uplinks to the first living collector in range (in list
 * order — the server passes players in a stable order, so ties are deterministic).
 */
export function stepPickups<Id>(
  pickups: PickupState[],
  collectors: readonly Collector<Id>[],
  dt: number,
): PickupEvent<Id>[] {
  const events: PickupEvent<Id>[] = [];
  for (const p of pickups) {
    if (p.cooldown > 0) {
      p.cooldown = Math.max(0, p.cooldown - dt);
      continue;
    }
    for (const c of collectors) {
      if (!c.alive || (c.takes && !c.takes(p.kind))) continue;
      // Horizontal distance, and roughly the same floor (hall upstairs vs. street below).
      const dx = c.pos.x - p.pos.x;
      const dz = c.pos.z - p.pos.z;
      const rules = p.kind === 'medkit' ? MEDKIT : RADAR;
      if (Math.hypot(dx, dz) > rules.pickupRadius || Math.abs(c.pos.y - p.pos.y) > 1.5) continue;
      p.cooldown = rules.respawn;
      events.push({ pickupId: p.id, by: c.id, kind: p.kind });
      break;
    }
  }
  return events;
}

/** A medkit's heal on a player's health (capped at max). */
export const healWithMedkit = (health: number): number =>
  Math.min(PLAYER.maxHealth, health + MEDKIT.heal);

/** Per-player radar: stored charges and how long a called-in radar stays live. */
export interface RadarState {
  charges: number;
  /** Seconds of live radar left (0 = off). */
  live: number;
}

export const createRadarState = (): RadarState => ({ charges: 0, live: 0 });

export const radarFull = (r: RadarState): boolean => r.charges >= RADAR.maxCharges;

export function grantRadarCharge(r: RadarState): void {
  r.charges = Math.min(RADAR.maxCharges, r.charges + 1);
}

/**
 * Tick the radar and handle a call-in (Radar button pressed this step, a charge in hand, not
 * already live). Returns true when a radar was called in.
 */
export function stepRadar(
  r: RadarState,
  buttons: number,
  prevButtons: number,
  dt: number,
): boolean {
  r.live = Math.max(0, r.live - dt);
  const pressed = (buttons & Button.Radar) !== 0 && (prevButtons & Button.Radar) === 0;
  if (!pressed || r.charges <= 0 || r.live > 0) return false;
  r.charges -= 1;
  r.live = RADAR.duration;
  return true;
}
