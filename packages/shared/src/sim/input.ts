/** Buttons packed into a bitmask so inputs are tiny on the wire (M3). */
export const Button = {
  Jump: 1 << 0,
  Sprint: 1 << 1,
  Crouch: 1 << 2,
  Fire: 1 << 3,
  Ads: 1 << 4,
  Reload: 1 << 5,
  /** Quick melee (knife) from any weapon. */
  Melee: 1 << 6,
  /** Throw the frag grenade. */
  Grenade: 1 << 7,
  Slot1: 1 << 8,
  Slot2: 1 << 9,
  Slot3: 1 << 10,
  /** Cycle weapons (mouse wheel). */
  NextWeapon: 1 << 11,
  PrevWeapon: 1 << 12,
  /** Hold to guard against knife strikes; tap just before a strike to parry. */
  Block: 1 << 13,
  /** Call in a stored radar charge (collected from an uplink). */
  Radar: 1 << 14,
  /** Throw the smoke grenade. */
  Smoke: 1 << 15,
  /** Launch / recall the recon drone (needs a drone charge). */
  Drone: 1 << 16,
  /** Trigger the drone jammer pulse. */
  Jammer: 1 << 17,
  Prone: 1 << 18,
  /**
   * Tactical sprint (a press edge starts a burst from a sprint; `TAC_SPRINT`). The client sends
   * it for a Sprint double tap, or a second Sprint press while a toggled sprint runs.
   */
  TacSprint: 1 << 19,
  /** Get in / out of a vehicle (press edge; the server decides the seat and the exit spot). */
  Interact: 1 << 20,
  /** Move to the next free seat of the vehicle you are in (press edge). */
  SwitchSeat: 1 << 21,
} as const;

/** All defined button bits (anything else from a client is dropped). */
export const BUTTON_MASK = (1 << 22) - 1;
export type ButtonName = keyof typeof Button;

/** One simulation step of player intent. The server only ever receives these. */
export interface PlayerInput {
  /** Monotonic per-player sequence number (reconciliation key in M3). */
  seq: number;
  /** Strafe axis, -1 (left) … 1 (right). */
  moveX: number;
  /** Forward axis, -1 (back) … 1 (forward). */
  moveZ: number;
  /** View yaw (radians). */
  yaw: number;
  /** View pitch (radians, clamped to ±89°). */
  pitch: number;
  buttons: number;
}

export const emptyInput = (seq = 0): PlayerInput => ({
  seq,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
});

export const isDown = (buttons: number, b: number): boolean => (buttons & b) !== 0;
export const pressed = (buttons: number, prev: number, b: number): boolean =>
  (buttons & b) !== 0 && (prev & b) === 0;

export const MAX_PITCH = (89 * Math.PI) / 180;

/** Clamp untrusted input into legal ranges (server calls this on every received input). */
export function sanitizeInput(input: PlayerInput): PlayerInput {
  const finite = (n: number, fallback = 0): number => (Number.isFinite(n) ? n : fallback);
  let moveX = Math.max(-1, Math.min(1, finite(input.moveX)));
  let moveZ = Math.max(-1, Math.min(1, finite(input.moveZ)));
  const mag = Math.hypot(moveX, moveZ);
  if (mag > 1) {
    moveX /= mag;
    moveZ /= mag;
  }
  return {
    seq: finite(input.seq) | 0,
    moveX,
    moveZ,
    yaw: finite(input.yaw) % (Math.PI * 2),
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, finite(input.pitch))),
    buttons: finite(input.buttons) & BUTTON_MASK,
  };
}
