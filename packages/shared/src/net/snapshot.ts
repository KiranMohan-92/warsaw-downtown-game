import { DRONE, PRIMARY_IDS, type PrimaryId } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { DroneState } from '../sim/drone.ts';
import type { PlayerState } from '../sim/player.ts';
import { KNIFE_COMBO } from '../sim/arsenal.ts';
import { decodeAction, encodeAction, playerAction, type PlayerAction } from '../sim/action.ts';
import type { WeaponState } from '../sim/weapon.ts';
import type { TraversalState } from '../sim/traversal.ts';
import { isSpawnProtected } from '../sim/spawnProtection.ts';
import { seatFromWire, seatToWire } from '../sim/vehicles/seats.ts';
import { motionError, motionFromWire, motionToWire } from '../sim/vehicles/vehicle.ts';
import { JetMode } from '../sim/jetpack.ts';
import {
  SNAP_GUNS,
  SNAP_SLOTS,
  SnapFlag,
  type OwnState,
  type SnapshotDrone,
  type SnapshotPlayer,
  type TraversalWire,
} from './protocol.ts';

const slotIndex = (slot: string): number => SNAP_SLOTS.indexOf(slot as (typeof SNAP_SLOTS)[number]);

const xyz = (v: Vec3): number[] => [v.x, v.y, v.z];
const vec = (a: readonly number[], i = 0): Vec3 => ({
  x: a[i] ?? 0,
  y: a[i + 1] ?? 0,
  z: a[i + 2] ?? 0,
});

/** A climb/vault in wire form (the whole fixed path, so a client can rebuild it). */
export function traversalToWire(s: TraversalState): TraversalWire {
  return {
    k: s.kind === 'vault' ? 1 : 0,
    dur: s.dur,
    from: xyz(s.from),
    path: s.path.flatMap(xyz),
    to: xyz(s.to),
    dir: [s.dir.x, s.dir.z],
  };
}

/** The climb/vault a snapshot describes, `t` seconds in. Null for a malformed entry. */
export function traversalFromWire(w: TraversalWire, t: number): TraversalState | null {
  const ok = (a: unknown, n: number): boolean =>
    Array.isArray(a) && a.length >= n && a.every((x) => Number.isFinite(x));
  if (!ok(w.from, 3) || !ok(w.to, 3) || !ok(w.dir, 2) || !ok(w.path, 3)) return null;
  if (w.path.length % 3 !== 0 || !Number.isFinite(w.dur) || w.dur <= 0) return null;
  const path: Vec3[] = [];
  for (let i = 0; i < w.path.length; i += 3) path.push(vec(w.path, i));
  return {
    kind: w.k === 1 ? 'vault' : 'mantle',
    t: Math.max(0, t),
    dur: w.dur,
    from: vec(w.from),
    path,
    to: vec(w.to),
    dir: { x: w.dir[0]!, z: w.dir[1]! },
  };
}

/** Hand phases on the wire (`OwnState.hands`). */
const PHASES = ['idle', 'windup', 'recover'] as const;
const phaseIndex = (ph: string): number => PHASES.indexOf(ph as (typeof PHASES)[number]);

/**
 * `OwnState.hands`, field by field: a count must match exactly, a timer within tolerance; the
 * guard entry is its hold time, -1 when down (up vs down must match).
 */
const HANDS = [
  'timer',
  'timer',
  'timer',
  'count',
  'guard',
  'count',
  'timer',
  'count',
  'timer',
  'count',
  'count',
  'count',
  'count',
  'count',
  'timer',
  'timer',
  'count',
  'timer',
];
/** Full firing state: correcting only ammo leaves recoil/spread and buffered triggers wrong. */
const GUN_FIELDS = [
  'heat',
  'overheat',
  'ammo',
  'reserve',
  'reloadTimer',
  'cooldown',
  'shotCounter',
  'reloadDuration',
  'shotIndex',
  'timeSinceShot',
  'bloom',
  'recoilPitch',
  'recoilYaw',
  'adsAmount',
  'sprintBlockTimer',
  'queuedShot',
  'charge',
] as const satisfies readonly (keyof WeaponState)[];
const GUN_COUNTS = new Set<keyof WeaponState>(['ammo', 'reserve', 'shotCounter', 'shotIndex']);
const MOVE_FIELDS = [
  'coyoteTimer',
  'jumpBufferTimer',
  'landingSlowTimer',
  'strideAccum',
  'slideTime',
  'slideCooldown',
  'slideBuffer',
  'tacFuel',
  'tacDelay',
] as const;

const DRONE_WIRE_FIELDS = 11;

/** A player's own weapon and kit state, for its own snapshot entry. */
export function ownState(p: PlayerState): OwnState {
  const a = p.arsenal;
  return {
    guns: SNAP_GUNS.flatMap((s) => GUN_FIELDS.map((field) => p.guns[s][field])),
    // The current primary rides with the kit: a missed respawn or contested ground swap is
    // corrected with the ammunition and hands state.
    kit: [a.grenades, a.smokes, a.jammers, PRIMARY_IDS.indexOf(a.primary)],
    hands: [
      a.stun,
      a.counter,
      a.guard.brokenTimer,
      a.guard.blocks,
      a.guard.held ? a.guard.heldFor : -1,
      phaseIndex(a.throwPhase),
      a.throwTimer,
      phaseIndex(a.melee.phase),
      a.melee.timer,
      a.throwKind === 'smoke' ? 1 : 0,
      a.melee.quick ? 1 : 0,
      a.melee.swings,
      KNIFE_COMBO.indexOf(a.melee.move),
      a.melee.combo,
      a.melee.sinceStrike,
      a.melee.windupTotal,
      a.melee.empowered ? 1 : 0,
      a.switchDuration,
    ],
    move: MOVE_FIELDS.map((field) => p.move[field]),
    buttons: p.prevButtons,
    ...(p.droneCharges > 0 ? { dc: p.droneCharges } : {}),
    ...(p.drone?.alive ? { dr: droneToOwnWire(p.drone) } : {}),
    ...(p.spawnGuard > 0 ? { sg: p.spawnGuard } : {}),
    ...(p.seat?.motion ? { vm: motionToWire(p.seat.motion) } : {}),
    ...(p.move.jet !== JetMode.None ? { jp: [p.move.jet, p.move.jetFuel] } : {}),
  };
}

function droneToOwnWire(d: DroneState): number[] {
  return [
    d.owner,
    d.pos.x,
    d.pos.y,
    d.pos.z,
    d.vel.x,
    d.vel.y,
    d.vel.z,
    d.yaw,
    d.pitch,
    d.battery,
    d.baseY,
  ];
}

function droneFromOwnWire(w: OwnState['dr']): DroneState | null {
  if (
    !Array.isArray(w) ||
    w.length !== DRONE_WIRE_FIELDS ||
    !w.every((x) => typeof x === 'number' && Number.isFinite(x))
  )
    return null;
  return {
    owner: w[0]!,
    pos: { x: w[1]!, y: w[2]!, z: w[3]! },
    vel: { x: w[4]!, y: w[5]!, z: w[6]! },
    yaw: w[7]!,
    pitch: w[8]!,
    battery: Math.max(0, w[9]!),
    baseY: w[10]!,
    alive: true,
  };
}

const ownDroneCharges = (o: OwnState): number =>
  typeof o.dc === 'number' && Number.isFinite(o.dc) && o.dc > 0 ? o.dc : 0;

/** Jetpack mode + fuel in an own-state entry: absent or junk reads as none. */
function ownJet(o: OwnState): { mode: number; fuel: number } {
  const jp = o.jp;
  if (!Array.isArray(jp) || jp.length !== 2) return { mode: 0, fuel: 0 };
  const [mode, fuel] = jp as [unknown, unknown];
  if (
    typeof mode !== 'number' ||
    !Number.isInteger(mode) ||
    mode < JetMode.None ||
    mode > JetMode.Drop ||
    typeof fuel !== 'number' ||
    !Number.isFinite(fuel)
  )
    return { mode: 0, fuel: 0 };
  return { mode, fuel: Math.max(0, fuel) };
}

/** Spawn protection left in an own-state entry (s): absent, junk or negative reads as none. */
const ownGuard = (o: OwnState): number =>
  typeof o.sg === 'number' && Number.isFinite(o.sg) && o.sg > 0 ? o.sg : 0;

const validOwn = (o: OwnState): boolean =>
  Array.isArray(o.guns) &&
  o.guns.length === SNAP_GUNS.length * GUN_FIELDS.length &&
  Array.isArray(o.kit) &&
  o.kit.length === 4 &&
  PRIMARY_IDS[o.kit[3]!] !== undefined &&
  Array.isArray(o.hands) &&
  o.hands.length === HANDS.length &&
  Array.isArray(o.move) &&
  o.move.length === MOVE_FIELDS.length &&
  [...o.guns, ...o.kit, ...o.hands, ...o.move, o.buttons].every((x) => Number.isFinite(x)) &&
  PHASES[o.hands[5]!] !== undefined &&
  PHASES[o.hands[7]!] !== undefined &&
  KNIFE_COMBO[o.hands[12]!] !== undefined;

/** Overwrite the weapon and kit state with the server's (in place). */
export function applyOwnState(p: PlayerState, o: OwnState): void {
  if (!validOwn(o)) return;
  SNAP_GUNS.forEach((s, i) => {
    GUN_FIELDS.forEach((field, j) => {
      p.guns[s][field] = o.guns[i * GUN_FIELDS.length + j]!;
    });
  });
  const a = p.arsenal;
  const h = o.hands;
  a.grenades = o.kit[0]!;
  a.smokes = o.kit[1]!;
  a.jammers = o.kit[2]!;
  a.primary = PRIMARY_IDS[o.kit[3]!]!;
  a.stun = h[0]!;
  a.counter = h[1]!;
  a.guard.brokenTimer = h[2]!;
  a.guard.blocks = h[3]!;
  a.guard.held = h[4]! >= 0;
  a.guard.heldFor = Math.max(0, h[4]!);
  // A throw or swing the server never started (its press was skipped) is called off, so no
  // phantom frag leaves the hand; one it did start carries on from its timer.
  a.throwPhase = PHASES[h[5]!]!;
  a.throwTimer = h[6]!;
  a.melee.phase = PHASES[h[7]!]!;
  a.melee.timer = h[8]!;
  a.throwKind = h[9] === 1 ? 'smoke' : 'frag';
  a.melee.quick = h[10] === 1;
  a.melee.swings = h[11]!;
  a.melee.move = KNIFE_COMBO[h[12]!]!;
  a.melee.combo = h[13]!;
  a.melee.sinceStrike = h[14]!;
  a.melee.windupTotal = h[15]!;
  a.melee.empowered = h[16] === 1;
  a.switchDuration = h[17]!;
  MOVE_FIELDS.forEach((field, i) => {
    p.move[field] = o.move[i]!;
  });
  p.prevButtons = o.buttons;
  p.droneCharges = ownDroneCharges(o);
  p.drone = droneFromOwnWire(o.dr);
  p.spawnGuard = ownGuard(o);
  // The driven vehicle's motion (the seat itself comes with the entry's `vh`).
  const vm = motionFromWire(o.vm);
  if (vm && p.seat?.seat === 'driver') p.seat.motion = vm;
  const jet = ownJet(o);
  p.move.jet = jet.mode;
  p.move.jetFuel = jet.fuel;
}

/**
 * How far the weapon/kit state is from the server's: Infinity when a count differs (ammo,
 * reserve, shots fired, kit, guard blocks or up/down, throw and swing phase), else the largest
 * timer difference (s).
 */
export function ownStateError(p: PlayerState, o: OwnState): number {
  if (!validOwn(o)) return 0;
  const mine = ownState(p);
  if (mine.buttons !== o.buttons) return Infinity;
  let err = 0;
  for (let i = 0; i < mine.guns.length; i++) {
    const d = Math.abs(mine.guns[i]! - o.guns[i]!);
    if (!GUN_COUNTS.has(GUN_FIELDS[i % GUN_FIELDS.length]!)) err = Math.max(err, d);
    else if (d > 0) return Infinity;
  }
  for (let i = 0; i < 4; i++) if (mine.kit[i] !== o.kit[i]) return Infinity;
  if (p.droneCharges !== ownDroneCharges(o)) return Infinity;
  const drone = droneFromOwnWire(o.dr);
  if (!!p.drone?.alive !== !!drone) return Infinity;
  if (p.drone?.alive && drone) {
    err = Math.max(
      err,
      Math.hypot(
        p.drone.pos.x - drone.pos.x,
        p.drone.pos.y - drone.pos.y,
        p.drone.pos.z - drone.pos.z,
      ),
      Math.hypot(
        p.drone.vel.x - drone.vel.x,
        p.drone.vel.y - drone.vel.y,
        p.drone.vel.z - drone.vel.z,
      ),
      Math.abs(p.drone.yaw - drone.yaw),
      Math.abs(p.drone.pitch - drone.pitch),
      Math.abs(p.drone.battery - drone.battery),
      Math.abs(p.drone.baseY - drone.baseY),
    );
    if (p.drone.owner !== drone.owner) return Infinity;
  }
  for (let i = 0; i < MOVE_FIELDS.length; i++) {
    err = Math.max(err, Math.abs(mine.move[i]! - o.move[i]!));
  }
  // Spawn protection: on/off must match (a life's protection the client never granted, or one
  // the server ended or ran down while the client was paused). Its timer alone never forces a
  // replay: nothing predicted depends on it, and it is adopted with any correction.
  if (p.spawnGuard > 0 !== ownGuard(o) > 0) return Infinity;
  // Driving: the vehicle's motion is part of the prediction (none predicted, or one too many,
  // is a mismatch).
  const vm = motionFromWire(o.vm);
  if (!!vm !== !!p.seat?.motion) return Infinity;
  if (vm && p.seat?.motion) err = Math.max(err, motionError(p.seat.motion, vm));
  // Jetpack: the mode must match (a pickup the client never saw, an ignition it missed); the
  // fuel is a timer.
  const jet = ownJet(o);
  if (p.move.jet !== jet.mode) return Infinity;
  err = Math.max(err, Math.abs(p.move.jetFuel - jet.fuel));
  for (let i = 0; i < HANDS.length; i++) {
    const a = mine.hands[i]!;
    const b = o.hands[i]!;
    const kind = HANDS[i];
    if (kind === 'timer') err = Math.max(err, Math.abs(a - b));
    else if (kind === 'count') {
      if (a !== b) return Infinity;
    } else if (a < 0 !== b < 0) return Infinity;
    else if (a >= 0) err = Math.max(err, Math.abs(a - b));
  }
  return err;
}

/** Compact public drone state for `SnapshotMessage.drones`. */
export function toSnapshotDrone(owner: string, d: DroneState): SnapshotDrone {
  const bucket = Math.max(0, Math.min(255, Math.round((d.battery / DRONE.battery) * 255)));
  return [owner, d.pos.x, d.pos.y, d.pos.z, d.yaw, bucket];
}

/**
 * Pack a player's authoritative state into its snapshot entry. `own`: the entry goes to this
 * player itself, so it carries the weapon and kit state too.
 */
export function toSnapshotPlayer(
  id: string,
  p: PlayerState,
  ack: number,
  life: number,
  opts: { own?: boolean } = {},
): SnapshotPlayer {
  const m = p.move;
  const f =
    (m.grounded ? SnapFlag.Grounded : 0) |
    (m.crouched ? SnapFlag.Crouched : 0) |
    (m.sprinting ? SnapFlag.Sprinting : 0) |
    (m.lowRun ? SnapFlag.LowRun : 0) |
    (m.traversal ? SnapFlag.Traversing : 0) |
    (m.board ? SnapFlag.Board : 0) |
    (m.prone ? SnapFlag.Prone : 0) |
    (isSpawnProtected(p) ? SnapFlag.Protected : 0) |
    (m.sliding ? SnapFlag.Sliding : 0) |
    (m.tacSprint ? SnapFlag.TacSprint : 0) |
    jetFlags(m);
  const s: SnapshotPlayer = {
    id,
    x: m.pos.x,
    y: m.pos.y,
    z: m.pos.z,
    vx: m.vel.x,
    vy: m.vel.y,
    vz: m.vel.z,
    yaw: p.view.yaw,
    pitch: p.view.pitch,
    eye: m.eyeHeight,
    f,
    tt: m.traversal ? m.traversal.t : -1,
    hp: p.health,
    sl: slotIndex(p.arsenal.slot),
    tg: slotIndex(p.arsenal.target),
    sw: p.arsenal.switchTimer,
    pr: Math.max(0, PRIMARY_IDS.indexOf(p.arsenal.primary)),
    ack,
    life,
  };
  const ac = encodeAction(playerAction(p));
  if (ac) s.ac = ac;
  if (m.traversal) s.tr = traversalToWire(m.traversal);
  if (p.seat) s.vh = seatToWire(p.seat);
  if (opts.own) s.own = ownState(p);
  return s;
}

/** The jetpack's flag bits for a move state. */
function jetFlags(m: PlayerState['move']): number {
  return (
    (m.jet !== JetMode.None ? SnapFlag.Jetpack : 0) |
    (m.jet >= JetMode.Flying ? SnapFlag.JetFlight : 0) |
    (m.jet === JetMode.Drop ? SnapFlag.JetDrop : 0) |
    (m.jetThrust ? SnapFlag.JetThrust : 0)
  );
}

/**
 * The primary a snapshot entry says this life carries. Tolerant: an index this client doesn't
 * know (a newer server appended a gun) or an entry without one decodes as the AR-7.
 */
export function snapshotPrimary(s: Pick<SnapshotPlayer, 'pr'>): PrimaryId {
  const i = s.pr;
  return (Number.isInteger(i) ? PRIMARY_IDS[i] : undefined) ?? 'ar7';
}

/** What a snapshot entry says the player's hands are doing (none when absent or unknown). */
export function snapshotAction(s: Pick<SnapshotPlayer, 'ac'>): PlayerAction {
  return decodeAction(s.ac ?? 0);
}

/**
 * Overwrite what a snapshot carries (in place): movement, the climb/vault in progress, health,
 * the weapon in hand (it sets the movement speed) and, in our own entry, the weapon and kit
 * state (including recoil, action metadata, movement timers and previous input buttons).
 * Other players omit that private continuation state; only their visible pose is needed.
 */
export function applySnapshotMove(p: PlayerState, s: SnapshotPlayer): void {
  const m = p.move;
  m.pos = { x: s.x, y: s.y, z: s.z };
  m.vel = { x: s.vx, y: s.vy, z: s.vz };
  m.eyeHeight = s.eye;
  m.grounded = (s.f & SnapFlag.Grounded) !== 0;
  m.crouched = (s.f & SnapFlag.Crouched) !== 0;
  m.sprinting = (s.f & SnapFlag.Sprinting) !== 0;
  m.lowRun = (s.f & SnapFlag.LowRun) !== 0;
  m.board = (s.f & SnapFlag.Board) !== 0;
  m.prone = (s.f & SnapFlag.Prone) !== 0;
  m.sliding = (s.f & SnapFlag.Sliding) !== 0;
  m.tacSprint = (s.f & SnapFlag.TacSprint) !== 0;
  // Jetpack from the flags (our own entry's exact mode and fuel follow in its own state).
  m.jet =
    (s.f & SnapFlag.JetFlight) !== 0
      ? (s.f & SnapFlag.JetDrop) !== 0
        ? JetMode.Drop
        : JetMode.Flying
      : (s.f & SnapFlag.Jetpack) !== 0
        ? JetMode.Worn
        : JetMode.None;
  m.jetThrust = (s.f & SnapFlag.JetThrust) !== 0;
  if ((s.f & SnapFlag.Traversing) === 0) {
    // The server finished (or never started) a climb the client thinks is running: drop it.
    m.traversal = null;
  } else {
    // The server's climb, exactly (path included): one the client never predicted is rebuilt,
    // one it predicted differently is replaced. Without a path (malformed), keep ours.
    const rebuilt = s.tr ? traversalFromWire(s.tr, s.tt) : null;
    if (rebuilt) m.traversal = rebuilt;
    else if (m.traversal && s.tt >= 0) m.traversal.t = s.tt;
  }
  p.view = { yaw: s.yaw, pitch: s.pitch };
  p.health = s.hp;
  // Weapon in hand (it sets the movement speed): the server's, if it is a known slot.
  const a = p.arsenal;
  const slot = SNAP_SLOTS[s.sl];
  const target = SNAP_SLOTS[s.tg];
  if (slot && target) {
    a.slot = slot;
    a.target = target;
    a.switchTimer = s.sw;
    a.switchDuration = Math.max(a.switchDuration, s.sw);
  }
  // The seat (before the own state: a driver's motion lands in it).
  const seat = seatFromWire(s.vh);
  if (!seat) p.seat = null;
  else if (p.seat?.vehicle !== seat.vehicle || p.seat.seat !== seat.seat) p.seat = { ...seat };
  if (p.seat && p.seat.seat !== 'driver') delete p.seat.motion;
  if (s.own) applyOwnState(p, s.own);
  // Others' entries carry no timer, only the flag: off means off.
  else if ((s.f & SnapFlag.Protected) === 0) p.spawnGuard = 0;
}

/** Whether a snapshot entry (or an interpolated pose from one) says the player is protected. */
export const snapshotProtected = (s: Pick<SnapshotPlayer, 'f'>): boolean =>
  (s.f & SnapFlag.Protected) !== 0;

/**
 * How far a predicted state is from a snapshot: max of position (m), velocity (m/s), climb end
 * point (m) and weapon/kit timer (s) error; Infinity for a different stance, weapon in hand,
 * health (damage is the server's alone) or weapon/kit count.
 */
export function snapshotError(p: PlayerState, s: SnapshotPlayer): number {
  const m = p.move;
  const dp = Math.hypot(m.pos.x - s.x, m.pos.y - s.y, m.pos.z - s.z);
  const dv = Math.hypot(m.vel.x - s.vx, m.vel.y - s.vy, m.vel.z - s.vz);
  const flags =
    (m.grounded ? SnapFlag.Grounded : 0) |
    (m.crouched ? SnapFlag.Crouched : 0) |
    (m.traversal ? SnapFlag.Traversing : 0) |
    (m.board ? SnapFlag.Board : 0) |
    (m.prone ? SnapFlag.Prone : 0) |
    (m.sliding ? SnapFlag.Sliding : 0) |
    (m.tacSprint ? SnapFlag.TacSprint : 0) |
    (jetFlags(m) & (SnapFlag.Jetpack | SnapFlag.JetFlight | SnapFlag.JetDrop));
  const stance =
    SnapFlag.Grounded |
    SnapFlag.Crouched |
    SnapFlag.Traversing |
    SnapFlag.Board |
    SnapFlag.Prone |
    SnapFlag.Sliding |
    SnapFlag.TacSprint |
    SnapFlag.Jetpack |
    SnapFlag.JetFlight |
    SnapFlag.JetDrop;
  const stanceMismatch = (s.f & stance) !== flags;
  const a = p.arsenal;
  const weaponMismatch = slotIndex(a.slot) !== s.sl || slotIndex(a.target) !== s.tg;
  if (stanceMismatch || weaponMismatch || p.health !== s.hp) return Infinity;
  // Getting in, out or switching seats is the server's call: a different seat rebuilds.
  const seat = seatFromWire(s.vh);
  if (!seat !== !p.seat) return Infinity;
  if (seat && p.seat && (seat.vehicle !== p.seat.vehicle || seat.seat !== p.seat.seat)) {
    return Infinity;
  }
  // Compare the entire path: equal endpoints can still take different routes around cover.
  let dt = 0;
  if (m.traversal && s.tr) {
    const mine = traversalToWire(m.traversal);
    if (mine.k !== s.tr.k || mine.path.length !== s.tr.path.length) return Infinity;
    const a = [mine.dur, m.traversal.t, ...mine.from, ...mine.path, ...mine.to, ...mine.dir];
    const b = [s.tr.dur, s.tt, ...s.tr.from, ...s.tr.path, ...s.tr.to, ...s.tr.dir];
    dt = Math.max(...a.map((n, i) => Math.abs(n - b[i]!)));
  }
  const own = s.own ? ownStateError(p, s.own) : 0;
  // A passenger's feet follow a vehicle the client only draws (interpolated): where the seat is
  // isn't predicted, only what the passenger does (the hands, in the own state).
  const passenger = p.seat !== null && p.seat.seat !== 'driver';
  return Math.max(passenger ? 0 : dp, passenger ? 0 : dv, dt, own, Math.abs(a.switchTimer - s.sw));
}
