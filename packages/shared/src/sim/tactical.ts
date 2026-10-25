import { DRONE, JAMMER } from '../config/tunables.ts';
import type { PickupKind } from '../maps/types.ts';
import { launchDrone, type DroneState } from './drone.ts';
import { Button } from './input.ts';
import { createRadarState, grantRadarCharge, radarFull, type RadarState } from './pickups.ts';

/**
 * A player's tactical kit beyond the arsenal: radar charge, recon-drone charge and the drone in
 * flight, radar jamming, and who their drone has spotted. Pure data + fixed-step functions (the
 * M3 server owns one per player; the client predicts its own).
 */
export interface TacticalState<Id = string> {
  radar: RadarState;
  droneCharges: number;
  /** The drone this player is piloting (their body stands still meanwhile). */
  drone: DroneState | null;
  /** Seconds of radar jamming left (static, no blips). */
  jammed: number;
  /** Spotted by this player's drone: shown on their radar until `t` runs out. */
  spotted: { id: Id; t: number }[];
}

export const createTactical = <Id = string>(): TacticalState<Id> => ({
  radar: createRadarState(),
  droneCharges: 0,
  drone: null,
  jammed: 0,
  spotted: [],
});

/** Can this player take an uplink of this kind right now? */
export const takesPickup = (t: TacticalState<unknown>, kind: PickupKind): boolean =>
  kind === 'radar' ? !radarFull(t.radar) : t.droneCharges < 1;

export function grantPickup(t: TacticalState<unknown>, kind: PickupKind): void {
  if (kind === 'radar') grantRadarCharge(t.radar);
  else if (kind === 'drone') t.droneCharges = Math.min(1, t.droneCharges + 1);
  // Medkits heal the player (health lives in PlayerState, not in the tactical kit).
}

/**
 * Drone button: launch with a charge in hand, or recall a drone in flight. Returns what
 * happened. Launch needs `eye` (the pilot's eye) and their view yaw.
 */
export function toggleDrone(
  t: TacticalState<unknown>,
  buttons: number,
  prevButtons: number,
  owner: number,
  eye: { x: number; y: number; z: number },
  yaw: number,
  /** Mid-climb/vault the hands are busy: no launch (recall still works). */
  handsBusy = false,
): 'launched' | 'recalled' | null {
  const pressed = (buttons & Button.Drone) !== 0 && (prevButtons & Button.Drone) === 0;
  if (!pressed) return null;
  if (t.drone?.alive) {
    t.drone = null;
    return 'recalled';
  }
  if (t.droneCharges <= 0 || handsBusy) return null;
  t.droneCharges -= 1;
  t.drone = launchDrone(owner, eye, yaw);
  return 'launched';
}

/** Tick timers: jamming, spotted marks. */
export function stepTactical<Id>(t: TacticalState<Id>, dt: number): void {
  t.jammed = Math.max(0, t.jammed - dt);
  for (const s of t.spotted) s.t -= dt;
  t.spotted = t.spotted.filter((s) => s.t > 0);
}

/** Mark ids as spotted (refreshing their timer). */
export function markSpotted<Id>(t: TacticalState<Id>, ids: readonly Id[]): Id[] {
  const fresh: Id[] = [];
  for (const id of ids) {
    const s = t.spotted.find((x) => x.id === id);
    if (s) s.t = DRONE.spotTime;
    else {
      t.spotted.push({ id, t: DRONE.spotTime });
      fresh.push(id);
    }
  }
  return fresh;
}

/** Hit by someone else's jammer pulse: radar shows static for a while. */
export function jamRadar(t: TacticalState<unknown>): void {
  t.jammed = JAMMER.radarJam;
}

/** What this player's radar may show right now (jamming beats everything). */
export function radarView(t: TacticalState<unknown>): 'jammed' | 'live' | 'spotted' | 'dark' {
  if (t.jammed > 0) return 'jammed';
  if (t.radar.live > 0) return 'live';
  return t.spotted.length ? 'spotted' : 'dark';
}
