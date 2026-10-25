import {
  applySnapshotMove,
  Button,
  chooseSeat,
  clonePlayerState,
  createPlayerState,
  createWeaponDrops,
  clearDropOwner,
  crowdHeight,
  DRONE,
  grantSpawnProtection,
  MATCH_NET,
  jetActive,
  observeDropOwners,
  pressed,
  PRIMARY_IDS,
  reconcile,
  RECONCILE_TOLERANCE,
  SIM,
  SnapFlag,
  smokeAt,
  snapshotError,
  toSnapshotPlayer,
  type CombatEvent,
  type CombatMessage,
  type CrowdMember,
  type InputMessage,
  type LobbyMessage,
  type MatchPing,
  type MatchStateMessage,
  type BoardState,
  type JetpackItem,
  type PickupState,
  type PlayerInput,
  type PlayerState,
  type PredictedStep,
  type RadarState,
  type ReconcileResult,
  type ReplayBody,
  type PrimaryId,
  type RespawnMessage,
  type RosterEntry,
  type RosterMessage,
  type SnapshotMessage,
  type SnapshotPlayer,
  type SnapshotDrone,
  type SmokeCloud,
  type Vec3,
  seatFeet,
  seatFromWire,
  stepDrops,
  swapWithDrop,
  type DropGunMessage,
  type DropMessage,
  type LedgeQueries,
  type SeatId,
  type WeaponDropEvent,
  type WeaponDropState,
  type StepEnv,
  type VehicleObstacle,
  type WelcomeMessage,
  type WorldRaycaster,
} from '@wd/shared';
import { JitterBuffer, RemoteTrack, ServerClock, type RemotePose } from './interpolation.ts';
import { isPropEvent, PropSync } from './propSync.ts';
import { obstaclesOf, VehicleTrack, withTrucks, type VehiclePose } from './vehicleTrack.ts';

/** What the HUD's network indicator shows (see `hud/netIndicator.ts`). */
export interface NetStats {
  /** Round trip the server measured (ms), -1 until known. */
  rttMs: number;
  /** Snapshot arrival jitter (ms, EWMA). */
  jitterMs: number;
  /** The adaptive interpolation delay in use (ms). */
  delayMs: number;
  /** Time since the last snapshot (ms). */
  silenceMs: number;
  /** Arrival gaps over 150 ms in the last 10 s. */
  stalls: number;
}

export type OnlineStatus =
  /** Not joined yet: the page joins at the first Play (so the room gets the chosen name). */
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'reconnecting' }
  | { state: 'offline'; error: string };

/** What the session sends. (Transport-agnostic, so the logic is testable.) */
export interface SessionTransport {
  sendInputs(msg: InputMessage): void;
  /** Host command: end the running match (absent: this transport can't). */
  endMatch?(): void;
  /** Dev/autotest only; the server gates and validates this request. */
  dropGun?(msg: DropGunMessage): void;
}

export interface RemotePlayer {
  id: string;
  name: string;
  /** Colour slot 0–5. */
  slot: number;
  pose: RemotePose;
}

export interface RemoteDrone {
  owner: string;
  pos: Vec3;
  yaw: number;
  battery: number;
}

export interface OnlineTacticalSnapshot {
  smoke: SmokeCloud[];
  pickups: PickupState[];
  radar: RadarState;
  jammed: number;
  spotted: { id: string; pos: Vec3; t: number }[];
  /** The skateboard (absent: none on this map). */
  board?: BoardState;
  /** The match's jetpacks (absent: none on this map). */
  jetpacks?: JetpackItem[];
}

export function rosterDisplayName(p: RosterEntry): string {
  return p.bot === true ? `[BOT] ${p.name}` : p.name;
}

function tacticalFromSnapshot(snap: SnapshotMessage): OnlineTacticalSnapshot | null {
  const t = snap.tactical;
  if (!t) return null;
  const smoke = Array.isArray(t.smoke) ? t.smoke : [];
  const pickups = Array.isArray(t.pickups) ? t.pickups : [];
  const radar = t.radar;
  if (!radar || typeof radar.charges !== 'number' || typeof radar.live !== 'number') return null;
  return {
    // Junk entries are dropped, never drawn or judged (a NaN age would hide nobody or everybody).
    smoke: smoke
      .filter(
        (s) =>
          Number.isFinite(s?.id) &&
          Number.isFinite(s.age) &&
          Number.isFinite(s.pos?.x) &&
          Number.isFinite(s.pos?.y) &&
          Number.isFinite(s.pos?.z),
      )
      .map((s) => ({ id: s.id, pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z }, age: s.age })),
    pickups: pickups.map((p) => ({
      id: p.id,
      pos: { ...p.pos },
      kind: p.kind,
      cooldown: p.cooldown,
    })),
    radar: { charges: radar.charges, live: radar.live },
    jammed: typeof t.jammed === 'number' && Number.isFinite(t.jammed) ? Math.max(0, t.jammed) : 0,
    spotted: Array.isArray(t.spotted)
      ? t.spotted
          .filter(
            (s) =>
              typeof s?.id === 'string' &&
              Number.isFinite(s.t) &&
              Number.isFinite(s.pos?.x) &&
              Number.isFinite(s.pos?.y) &&
              Number.isFinite(s.pos?.z),
          )
          .map((s) => ({ id: s.id, pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z }, t: s.t }))
      : [],
    ...(t.board && typeof t.board.pos?.x === 'number'
      ? {
          board: {
            pos: { x: t.board.pos.x, y: t.board.pos.y, z: t.board.pos.z },
            rider: typeof t.board.rider === 'string' ? t.board.rider : null,
          },
        }
      : {}),
    ...(Array.isArray(t.jetpacks)
      ? {
          jetpacks: t.jetpacks
            .filter(
              (j) =>
                Number.isInteger(j?.id) &&
                Number.isFinite(j.pos?.x) &&
                Number.isFinite(j.pos?.y) &&
                Number.isFinite(j.pos?.z),
            )
            .map((j) => ({
              id: j.id,
              pos: { x: j.pos.x, y: j.pos.y, z: j.pos.z },
              carrier: typeof j.carrier === 'string' ? j.carrier : null,
              armed: j.armed === true,
              spent: j.spent === true,
            })),
        }
      : {}),
  };
}

function droneFromWire(d: SnapshotDrone): RemoteDrone | null {
  if (
    !Array.isArray(d) ||
    d.length < 6 ||
    typeof d[0] !== 'string' ||
    !Number.isFinite(d[1]) ||
    !Number.isFinite(d[2]) ||
    !Number.isFinite(d[3]) ||
    !Number.isFinite(d[4]) ||
    !Number.isFinite(d[5])
  )
    return null;
  return {
    owner: d[0],
    pos: { x: d[1], y: d[2], z: d[3] },
    yaw: d[4],
    battery: (Math.max(0, Math.min(255, d[5])) / 255) * DRONE.battery,
  };
}

function dropsFromSnapshot(drops: readonly WeaponDropState[]): WeaponDropState[] {
  return drops
    .filter(
      (d) =>
        typeof d?.id === 'string' &&
        PRIMARY_IDS.includes(d.primary) &&
        Number.isFinite(d.pos?.x) &&
        Number.isFinite(d.pos?.y) &&
        Number.isFinite(d.pos?.z) &&
        Number.isFinite(d.ammoFraction) &&
        d.ammoFraction >= 0 &&
        d.ammoFraction <= 1 &&
        Number.isFinite(d.ttl) &&
        d.ttl > 0 &&
        (d.droppedBy === undefined || typeof d.droppedBy === 'string') &&
        (d.ownerClear === undefined || typeof d.ownerClear === 'boolean'),
    )
    .map((d) => ({ ...d, pos: { ...d.pos } }));
}

/** TTL advances locally; ownership, position and ammo changes need input replay. */
function sameDrops(a: readonly WeaponDropState[], b: readonly WeaponDropState[]): boolean {
  return (
    a.length === b.length &&
    a.every((d, i) => {
      const other = b[i]!;
      return (
        d.id === other.id &&
        d.primary === other.primary &&
        d.droppedBy === other.droppedBy &&
        d.ownerClear === other.ownerClear &&
        d.pos.x === other.pos.x &&
        d.pos.y === other.pos.y &&
        d.pos.z === other.pos.z &&
        Math.abs(d.ammoFraction - other.ammoFraction) < 1e-9
      );
    })
  );
}

interface DroneSample {
  t: number;
  pose: RemoteDrone | null;
}

/**
 * Steps predicted but not yet acknowledged, at most (2 s at 60 Hz). Past this the server has
 * stopped answering; the oldest predictions are dropped (the next snapshot then corrects fully).
 */
export const MAX_PENDING = 120;

const TICK_MS = 1000 / SIM.tickHz;
const DRONE_TRACK_KEEP_MS = 1000;

/**
 * Client side of an online match (M3a), minus the socket:
 *
 * - **Inputs:** every sim step's input is queued (`recordStep`) and sent once per frame
 *   (`flush`), batched and sequence-numbered. Never positions or hits.
 * - **Prediction + reconciliation:** each step's predicted state is kept until the server
 *   acknowledges its input; on a snapshot the local player is checked against the server and,
 *   if they disagree, reset to the server state with the unacknowledged inputs replayed
 *   (`reconcile` in shared, the same `stepPlayer` the server runs).
 * - **Remote players:** buffered per player and drawn in the past by the adaptive jitter buffer
 *   (`JitterBuffer`: 100 ms on a clean link, up to 250 ms on a stalling one), blended between
 *   two real snapshots; after a stall briefly extrapolated, then held, and blended back in.
 */
/** A backward step of the draw timeline larger than this is a resync, not jitter (ms). */
export const DRAW_TIME_RESYNC_MS = 250;

export class OnlineSession {
  status: OnlineStatus = { state: 'idle' };
  welcome: WelcomeMessage | null = null;
  roster: RosterEntry[] = [];
  readonly clock = new ServerClock();
  /** How far back remote players are drawn (adapts to snapshot jitter and stalls). */
  readonly jitter = new JitterBuffer();
  /** Diagnostics: corrections applied, and the last prediction error (m). */
  corrections = 0;
  lastError = 0;
  /** Called once the server has placed us (reset the local player to `welcome.spawn`). */
  onWelcome: ((w: WelcomeMessage) => void) | null = null;
  /** Called after every roster update (e.g. to acknowledge this client's accepted name). */
  onRoster: ((r: RosterMessage) => void) | null = null;

  /** Score, phase and clock of the match (server-owned), null until the first `match`. */
  match: MatchStateMessage | null = null;
  tactical: OnlineTacticalSnapshot | null = null;
  private tacticalMs = Number.NEGATIVE_INFINITY;
  private droneMs = Number.NEGATIVE_INFINITY;
  /**
   * The server's smoke as of `smokeMs` (the newest snapshot that carried it): live clouds and
   * the ones that ran out within the rewind window, the very set `MatchSim.smokeAt` rewinds.
   * `smokeAt` keeps only those alive at the queried time, so spent ones are never drawn.
   */
  private smokeList: SmokeCloud[] = [];
  private smokeMs = 0;
  /** `smokeAt`'s last answer (reused: one per view time, no per-frame garbage). */
  private smokeView: SmokeCloud[] = [];
  private smokeViewMs = Number.NaN;
  /** Round trip the server measured (ms), -1 until known. */
  rtt = -1;
  /** Everyone else's round trip (ms, the server's measure; humans only), from the last ping. */
  pings: Readonly<Record<string, number>> = {};
  /** The friend room's host (null: unknown, or a quick-join room: nobody may end it). */
  hostId: string | null = null;

  private transport: SessionTransport | null = null;
  /** Inputs not sent yet, each with the view time it was taken at (lag compensation). */
  private outbox: { input: PlayerInput; vt?: number }[] = [];
  /** Combat events received and not yet taken by the game. */
  private combat: CombatEvent[] = [];
  private dropEvents: WeaponDropEvent<string>[] = [];
  private readonly dropState = createWeaponDrops();
  private authoritativeDrops: WeaponDropState[] | null = null;
  private authoritativeDropNextId = 1;
  private dropMs = Number.NEGATIVE_INFINITY;
  private readonly occupiedDropSeats = new Set<SeatId>();
  private pending: PredictedStep[] = [];
  /**
   * The predicted state just before `pending[0]`, when `pending` no longer starts at a step the
   * server could acknowledge (after a reconnect or a trim). A snapshot acknowledging something
   * older rebuilds on this and replays all of `pending`, so no input is ever applied twice.
   */
  private floor: PlayerState | null = null;
  /** Reconnected: capture `floor` at the next `reconcile` (before any new step). */
  private resync = false;
  /**
   * Back from a drop and not yet rebuilt on the server's state: even a snapshot without an ack
   * (the server never applied any of our inputs) must replace the prediction, which still holds
   * steps the server never got.
   */
  private reconnected = false;
  /** Server baseline before its first input: damage and idle movement can still change it. */
  private unackedBase: PlayerState | null = null;
  /** Our entry in the newest snapshot not yet reconciled. */
  private latestOwn: { t: number; s: SnapshotPlayer } | null = null;
  private lastOwnT = -1;
  /** Frozen bootstrap time, used for drawing until the first running snapshot arrives. */
  private heldServerMs: number | null = null;
  private life = 0;
  /** A respawn the server told us about, applied at the next `reconcile`. */
  private respawn: RespawnMessage | null = null;
  /** The current primary, updated from prediction and authoritative corrections. */
  primary: PrimaryId = 'ar7';
  private readonly remotes = new Map<string, RemoteTrack>();
  private readonly drones = new Map<string, DroneSample[]>();
  /** `crowd`'s answer (entries reused: no garbage per frame). */
  private readonly crowdList: CrowdMember[] = [];
  /** The match's vehicles, buffered for drawing (same timeline as remote players). */
  private readonly vehicleTracks = new Map<number, VehicleTrack>();
  /** `vehicleEnv`'s obstacles (reused). */
  private readonly obstacleList: VehicleObstacle[] = [];
  /** The props trucks break: applied to the world, passed by the driver's prediction, drawn. */
  readonly props = new PropSync();
  private readonly env: StepEnv = { vehicles: this.obstacleList, props: this.props };
  private readonly replayProps = (): void => {
    this.props.replay();
    if (this.authoritativeDrops) this.resetDropPrediction();
  };

  attach(transport: SessionTransport): void {
    this.transport = transport;
  }

  get id(): string | null {
    return this.welcome?.id ?? null;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  handleWelcome(w: WelcomeMessage): void {
    this.welcome = w;
    this.status = { state: 'online' };
    this.outbox = [];
    this.pending = [];
    this.floor = null;
    this.resync = false;
    this.reconnected = false;
    this.primary = w.primary;
    this.unackedBase = createPlayerState(w.spawn, w.seed, w.mode, w.primary);
    this.unackedBase.view = { yaw: w.spawn.yaw, pitch: 0 };
    // Every life starts spawn-protected on the server; predict it (the own snapshot corrects).
    grantSpawnProtection(this.unackedBase);
    this.latestOwn = null;
    this.lastOwnT = -1;
    this.heldServerMs = null;
    this.life = 0;
    this.respawn = null;
    this.combat = [];
    this.dropEvents = [];
    this.dropState.drops.length = 0;
    this.dropState.nextId = 1;
    this.authoritativeDrops = null;
    this.authoritativeDropNextId = 1;
    this.dropMs = Number.NEGATIVE_INFINITY;
    this.jitter.reset();
    this.vehicleTracks.clear();
    this.drones.clear();
    this.tacticalMs = Number.NEGATIVE_INFINITY;
    this.droneMs = Number.NEGATIVE_INFINITY;
    this.onWelcome?.(w);
  }

  /** Combat events from the server (hit confirms, deaths, other players' shots and frags). */
  handleCombat(m: CombatMessage): void {
    // Props change this client's world at once (the snapshot after them already has them).
    for (const e of m.events) if (isPropEvent(e)) this.props.apply(e);
    this.combat.push(...m.events);
    // A page that stopped drawing (hidden tab) must not hoard them: the newest matter.
    if (this.combat.length > 512) this.combat.splice(0, this.combat.length - 512);
  }

  /** Take the combat events received since the last call, in order. */
  takeCombat(): CombatEvent[] {
    const e = this.combat;
    this.combat = [];
    return e;
  }

  /** Predicted ground guns; snapshots reset them before replaying unacknowledged interactions. */
  get drops(): readonly WeaponDropState[] {
    return this.dropState.drops;
  }

  handleDrops(m: DropMessage): void {
    this.dropEvents.push(...m.events);
    if (this.dropEvents.length > 128) this.dropEvents.splice(0, this.dropEvents.length - 128);
  }

  /** Feedback is confirmed by the server, so replay and prediction never duplicate it. */
  takeDrops(): WeaponDropEvent<string>[] {
    const events = this.dropEvents;
    this.dropEvents = [];
    return events;
  }

  dropGun(primaryId: PrimaryId, x: number, z: number, ammoFraction: number): boolean {
    if (this.status.state !== 'online' || !this.transport?.dropGun) return false;
    this.transport.dropGun({ primaryId, x, z, ammoFraction });
    return true;
  }

  /** Same available-seat test as the server, including occupied seats and walls. */
  dropTruckPriority(player: PlayerState, world?: Pick<LedgeQueries, 'castRay'>): boolean {
    if (player.seat) return true;
    const m = player.move;
    if (player.health <= 0 || m.prone || m.board || m.traversal || jetActive(m)) return false;
    for (const [id, track] of this.vehicleTracks) {
      const vehicle = track.newest();
      if (!vehicle || vehicle.condition !== 'active') continue;
      this.occupiedDropSeats.clear();
      for (const remote of this.remotes.values()) {
        const pose = remote.buffer.newest()?.s;
        const seat = seatFromWire(pose?.vh);
        if (seat?.vehicle === id) this.occupiedDropSeats.add(seat.seat);
      }
      if (chooseSeat(vehicle.motion, this.occupiedDropSeats, m.pos, world)) return true;
    }
    return false;
  }

  /** Called after stepPlayer and before recordStep; the replay uses this exact same path. */
  predictDrops(
    player: PlayerState,
    input: PlayerInput,
    previousButtons: number,
    dt: number,
    world?: LedgeQueries,
  ): void {
    if (!this.id || this.status.state !== 'online') return;
    if (!this.dropState.drops.length) {
      this.primary = player.arsenal.primary;
      return;
    }
    const pos = player.move.pos;
    const playing = this.match?.phase !== 'ended';
    const interact = pressed(input.buttons, previousButtons, Button.Interact);
    const empty = player.guns.rifle.ammo + player.guns.rifle.reserve === 0;
    const ground =
      player.health > 0 && (interact || empty)
        ? world?.castGroundRay?.(
            { x: pos.x, y: pos.y + 0.25, z: pos.z },
            { x: 0, y: -1, z: 0 },
            2048,
          )
        : null;
    const collector = { id: this.id, player, groundY: ground?.point.y ?? pos.y };
    if (playing) observeDropOwners(this.dropState, [collector]);
    const events =
      playing && interact
        ? swapWithDrop(this.dropState, collector, this.dropTruckPriority(player, world))
        : [];
    stepDrops(
      this.dropState,
      playing ? [{ ...collector, skipAuto: events.some((e) => e.type === 'swap') }] : [],
      dt,
    );
    this.primary = player.arsenal.primary;
  }

  private resetDropPrediction(ahead = 0): void {
    this.dropState.drops.length = 0;
    this.dropState.nextId = this.authoritativeDropNextId;
    for (const d of this.authoritativeDrops ?? []) {
      if (d.ttl <= ahead) continue;
      this.dropState.drops.push({ ...d, pos: { ...d.pos }, ttl: d.ttl - ahead });
    }
  }

  handleMatch(m: MatchStateMessage): void {
    this.match = m;
  }

  handlePing(m: MatchPing): void {
    this.rtt = m.rtt;
    if (m.pings && typeof m.pings === 'object') this.pings = m.pings;
  }

  /** Local time the server's clock stopped at (a paused practice match), null while it runs. */
  private pausedAt: number | null = null;

  /**
   * The server's clock stops (practice: the worker pauses with the menu). The draw timeline
   * (and the view time inputs report) holds here, and arrivals don't count as link timing.
   */
  pauseTiming(localMs: number): void {
    this.pausedAt ??= localMs;
  }

  /**
   * The server's clock runs again: server time continues from where it stopped (the clock is
   * rebased by the pause, never extrapolated across it) and the jitter buffer starts afresh (the
   * silence was the pause, not the link).
   */
  resumeTiming(localMs: number): void {
    if (this.pausedAt === null) return;
    this.clock.shift(localMs - this.pausedAt);
    this.jitter.reset();
    this.pausedAt = null;
  }

  /**
   * The server's time at local time `localMs` (null before the first snapshot); held at the
   * moment the server's clock stopped while a practice match is paused. Everything derived from
   * server time (draw timeline, match countdown, kill cam, replay) goes through this.
   */
  serverNow(localMs: number): number | null {
    return this.heldServerMs ?? this.clock.now(this.pausedAt ?? localMs);
  }

  /** A friend room's lobby update (host transfers included). */
  handleLobby(m: Pick<LobbyMessage, 'hostId'>): void {
    this.hostId = m.hostId;
  }

  /**
   * This client may end the match: a friend (or practice) room whose transport can end it, its
   * host, connected, while it is played. Quick-join rooms have a host too, but no End match.
   */
  get canEndMatch(): boolean {
    const id = this.id;
    return (
      id !== null &&
      this.hostId === id &&
      this.status.state === 'online' &&
      this.match?.phase === 'playing' &&
      this.transport?.endMatch !== undefined
    );
  }

  /** Ask the server to end the match (it checks host and phase again). False if not allowed. */
  endMatch(): boolean {
    if (!this.canEndMatch) return false;
    this.transport?.endMatch?.();
    return true;
  }

  /** A player's name from the roster (`fallback` for someone who already left). */
  nameOf(id: string, fallback = 'someone'): string {
    const r = this.roster.find((entry) => entry.id === id);
    return r ? rosterDisplayName(r) : fallback;
  }

  /**
   * The server time (ms) the other players are drawn at, at local time `localMs` (the view time
   * every input carries, so the server checks shots against what this player saw).
   */
  viewTime(localMs: number): number | undefined {
    return this.drawTime(localMs);
  }

  /**
   * The smoke as it was at server time `viewMs` (a step's `vt`; undefined = as of the newest
   * snapshot): what smart rounds judge concealment by, exactly as the server does
   * (`MatchSim.smokeAt`), and what is drawn. Cached per view time and refilled in place, so the
   * shot and the frame share one list; read-only for callers, valid until the next call.
   */
  smokeAt(viewMs: number | undefined): readonly SmokeCloud[] {
    const at = viewMs ?? this.smokeMs;
    if (at !== this.smokeViewMs) {
      smokeAt(this.smokeList, this.smokeMs, at, this.smokeView);
      this.smokeViewMs = at;
    }
    return this.smokeView;
  }

  /** Last draw time handed out (never goes back: see `drawTime`). */
  private drawnAt = Number.NEGATIVE_INFINITY;

  /**
   * The one server-time timeline remote players are drawn on (and that shots report as `vt`):
   * server clock minus the adaptive delay, held rather than stepped back. After a stall a burst
   * of late snapshots slews the clock estimate back faster than the delay rises; without the
   * hold, players would twitch backwards and the reported view time would disagree with what
   * was drawn.
   */
  private drawTime(localMs: number): number | undefined {
    if (this.heldServerMs !== null) return this.heldServerMs;
    // While the server's clock is stopped (paused practice) the timeline stands still too.
    const at = this.pausedAt ?? localMs;
    const now = this.serverNow(localMs);
    if (now === null) return undefined;
    const t = now - this.jitter.delayMs(at);
    // Hold only jitter-sized regressions. A bigger one is a hard resync (e.g. the server skipped
    // a multi-second stall and the clock estimate corrected back by seconds): rebase onto it, or
    // the held future time would freeze everyone and clamp every reported view time.
    this.drawnAt = t < this.drawnAt - DRAW_TIME_RESYNC_MS ? t : Math.max(this.drawnAt, t);
    return this.drawnAt;
  }

  /**
   * Who the local player bumps into (player collision): every other living player where its
   * newest snapshot has it (never the interpolated, drawn pose: that is 100 ms older still).
   * Not moved on along its velocity: players in contact are held back by each other, so the
   * snapshot velocity overshoots exactly when it matters (measured in `playerCollision.test`:
   * extrapolating doubled the corrections).
   */
  crowd(): readonly CrowdMember[] {
    let n = 0;
    for (const [id, track] of this.remotes) {
      const e = track.buffer.newest();
      // The dead, and the seated (they ride a vehicle), bump into nobody.
      if (!e || e.s.hp <= 0 || e.s.vh !== undefined) continue;
      const out = (this.crowdList[n++] ??= { id: '', x: 0, y: 0, z: 0, height: 0 });
      out.id = id;
      out.x = e.s.x;
      out.y = e.s.y;
      out.z = e.s.z;
      out.height = crowdHeight((e.s.f & SnapFlag.Crouched) !== 0, (e.s.f & SnapFlag.Prone) !== 0);
    }
    this.crowdList.length = n;
    return this.crowdList;
  }

  /**
   * What the local player's steps meet besides the map: every vehicle where its newest snapshot
   * has it (walkers are pushed out of them, a driven truck out of the others). The server meets
   * them where they are at its substep; for parked trucks the two are the same.
   */
  vehicleEnv(droneBase?: WorldRaycaster): StepEnv {
    obstaclesOf(this.vehicleTracks.values(), this.obstacleList);
    if (droneBase) this.env.droneWorld = withTrucks(droneBase, this.newestVehicles());
    else delete this.env.droneWorld;
    return this.env;
  }

  private newestVehicles(): VehiclePose[] {
    const out: VehiclePose[] = [];
    for (const [id, track] of this.vehicleTracks) {
      const n = track.newest();
      if (!n) continue;
      out.push({
        id,
        motion: { ...n.motion, pos: { ...n.motion.pos }, vel: { ...n.motion.vel } },
        hp: n.hp,
        condition: n.condition,
      });
    }
    return out;
  }

  /** Vehicles to draw at local time `localMs` (interpolated in the past, like remote players). */
  vehicles(localMs: number): VehiclePose[] {
    const t = this.drawTime(localMs);
    if (t === undefined) return [];
    const out: VehiclePose[] = [];
    for (const track of this.vehicleTracks.values()) {
      const p = track.sample(t);
      track.prune(t - 500);
      if (p) out.push(p);
    }
    return out;
  }

  /**
   * A passenger rides a truck this client only draws: its feet (radar, sounds, sight checks, a
   * bot's own position) follow the seat in the truck as drawn now. Not predicted (the snapshot
   * comparison skips a passenger's position), so this changes nothing the server checks.
   */
  followSeat(p: PlayerState, localMs: number): void {
    const seat = p.seat;
    if (!seat || seat.seat === 'driver') return;
    const v = this.vehicles(localMs).find((x) => x.id === seat.vehicle);
    if (!v) return;
    p.move.pos = seatFeet(v.motion, seat.seat);
    p.move.vel = { ...v.motion.vel };
  }

  /** Vehicles as they were drawn at server time `viewMs` (a shot's view time). */
  vehiclesAt(viewMs: number): VehiclePose[] {
    const out: VehiclePose[] = [];
    for (const track of this.vehicleTracks.values()) {
      const p = track.sample(viewMs);
      if (p) out.push(p);
    }
    return out;
  }

  /** The network indicator's numbers at local time `localMs`. */
  netStats(localMs: number): NetStats {
    return {
      rttMs: this.rtt,
      jitterMs: this.jitter.jitterMs,
      delayMs: this.jitter.delayMs(localMs),
      silenceMs: this.jitter.silenceMs(localMs),
      stalls: this.jitter.recentStalls(localMs),
    };
  }

  /**
   * Seconds left in the match phase (clock, or the next match); null before it is known, and
   * while a match without a time limit is played.
   */
  phaseSecondsLeft(localMs: number): number | null {
    const now = this.serverNow(localMs);
    if (!this.match || this.match.endsAt === null || now === null) return null;
    return Math.max(0, (this.match.endsAt * TICK_MS - now) / 1000);
  }

  handleRoster(r: RosterMessage): void {
    this.roster = r.players;
    this.onRoster?.(r);
    const ids = new Set(r.players.map((p) => p.id));
    for (const id of this.remotes.keys()) if (!ids.has(id)) this.remotes.delete(id);
    for (const id of this.drones.keys()) if (!ids.has(id)) this.drones.delete(id);
  }

  handleSnapshot(snap: SnapshotMessage, localMs: number): void {
    const me = this.id;
    if (me === null) return;
    const serverMs = snap.t * TICK_MS;
    if (Array.isArray(snap.drops) && serverMs >= this.dropMs) {
      this.authoritativeDrops = dropsFromSnapshot(snap.drops);
      for (const d of this.authoritativeDrops) {
        const seq = Number(d.id.replace(/^drop-/, ''));
        if (Number.isSafeInteger(seq)) {
          this.authoritativeDropNextId = Math.max(this.authoritativeDropNextId, seq + 1);
        }
      }
      this.dropMs = serverMs;
      // State-only snapshots are useful to spectators and the dev harness too.
      if (!snap.players.some((p) => p.id === me)) this.resetDropPrediction();
    }
    // Bootstrap state is visible before ready, but its frozen timestamps are not timing samples.
    // A late held packet must not freeze a clock that already started with a running snapshot.
    if (snap.held && !this.clock.synced) this.heldServerMs = serverMs;
    // (A snapshot still in flight when the clock stopped says nothing about the link's timing.)
    if (!snap.held && this.pausedAt === null) {
      this.heldServerMs = null;
      this.clock.observe(serverMs, localMs);
      this.jitter.observe(serverMs, localMs, this.clock.lateness(serverMs, localMs));
    }
    const tactical = tacticalFromSnapshot(snap);
    if (tactical && serverMs >= this.tacticalMs) {
      this.tactical = tactical;
      this.tacticalMs = serverMs;
      // Smoke only moves forward (a late, older snapshot would undo newer ages).
      if (serverMs > this.smokeMs) {
        this.smokeList = tactical.smoke;
        this.smokeMs = serverMs;
        this.smokeViewMs = Number.NaN;
      }
    }
    this.props.snapshot(serverMs, snap.props);
    for (const v of snap.vehicles ?? []) {
      if (!Number.isInteger(v?.id)) continue;
      let track = this.vehicleTracks.get(v.id);
      if (!track) this.vehicleTracks.set(v.id, (track = new VehicleTrack(v.id)));
      track.push(serverMs, v);
    }
    if (serverMs >= this.droneMs) {
      this.droneMs = serverMs;
      const liveDrones = new Set<string>();
      for (const wire of snap.drones ?? []) {
        const d = droneFromWire(wire);
        if (!d || d.owner === me) continue;
        liveDrones.add(d.owner);
        this.pushDroneSample(serverMs, d.owner, d);
      }
      for (const [owner, list] of this.drones) {
        if (!liveDrones.has(owner) && list.at(-1)?.pose !== null)
          this.pushDroneSample(serverMs, owner, null);
        this.pruneDroneTrack(owner, serverMs);
      }
    }
    for (const p of snap.players) {
      if (p.id === me) {
        if (snap.t > this.lastOwnT) {
          this.lastOwnT = snap.t;
          this.latestOwn = { t: snap.t, s: p };
        }
        continue;
      }
      let buf = this.remotes.get(p.id);
      if (!buf) this.remotes.set(p.id, (buf = new RemoteTrack(MATCH_NET.maxExtrapolateMs)));
      buf.push(serverMs, p);
    }
  }

  handleRespawn(m: RespawnMessage): void {
    if (m.life > (this.respawn?.life ?? this.life)) this.respawn = m;
  }

  handleStatus(status: OnlineStatus): void {
    const was = this.status.state;
    this.status = status;
    // Dropped: inputs not sent yet are discarded (the SDK would deliver them after the
    // reconnect, behind predictions this session no longer keeps).
    if (status.state !== 'online') this.outbox = [];
    // Back in the seat: whatever was in flight when the socket dropped may never have arrived,
    // so no prediction made before the drop can be trusted to be acknowledged. The next
    // snapshot resets us to the server's state and replays only inputs sent after this.
    if (was === 'reconnecting' && status.state === 'online') {
      this.pending = [];
      this.floor = null;
      this.resync = true;
      this.reconnected = true;
      this.latestOwn = null; // from before the drop: the next one describes the resumed seat
      this.jitter.reset(); // the outage says nothing about the resumed link
      this.drones.clear();
      this.droneMs = Number.NEGATIVE_INFINITY;
    }
  }

  /** Life counter (bumps when the server respawns us; the game re-aims the camera). */
  get currentLife(): number {
    return this.life;
  }

  /**
   * Queue one sim step: the input as the body used it, and the state it produced. Only while
   * connected: steps taken during a drop never reach the server (the SDK would only buffer a
   * few), so they are not predicted as if they had; the first snapshot after reconnecting puts
   * the player back where the server kept them. `vt`: the view time the step was taken at
   * (`viewTime`), so the server checks its shots against the players as drawn.
   */
  recordStep(input: PlayerInput, after: PlayerState, vt?: number): void {
    if (!this.welcome || this.status.state !== 'online') return;
    this.outbox.push(vt === undefined ? { input } : { input, vt });
    this.pending.push({ input, after: clonePlayerState(after) });
    if (this.pending.length > MAX_PENDING) {
      const dropped = this.pending.splice(0, this.pending.length - MAX_PENDING);
      this.floor = dropped.at(-1)!.after;
    }
  }

  /** Send the queued inputs (call once per frame, after the sim steps). */
  flush(): void {
    const t = this.transport;
    if (!t || this.status.state !== 'online') return;
    while (this.outbox.length) {
      const inputs = this.outbox.splice(0, MATCH_NET.maxInputBatch).map(({ input: i, vt }) => ({
        seq: i.seq,
        moveX: i.moveX,
        moveZ: i.moveZ,
        yaw: i.yaw,
        pitch: i.pitch,
        buttons: i.buttons,
        ...(vt === undefined ? {} : { vt }),
      }));
      t.sendInputs({ inputs });
    }
  }

  /**
   * Check the local player against the newest snapshot (call before stepping the frame).
   * Returns null when there is nothing new, else the reconcile result (the caller adopts
   * `result.state` when `corrected`). `body` is moved along with a replay, which bumps into the
   * other players (`crowd`) as the prediction did.
   */
  reconcile(current: PlayerState, body: ReplayBody, dt: number): ReconcileResult | null {
    const w = this.welcome;
    if (!w) return null;
    const crowd = { members: this.crowd(), selfId: w.id };
    const movement = body.world;
    const droneBase: WorldRaycaster | undefined = movement
      ? {
          castRay(origin, dir, maxDistance) {
            const hit = movement.castGroundRay
              ? movement.castGroundRay(origin, dir, maxDistance)
              : movement.castRay(origin, dir, maxDistance);
            // Replay bodies expose movement queries without presentation metadata.
            return hit
              ? { ...hit, normal: hit.normal ?? { x: 0, y: 0, z: 0 }, visible: false }
              : null;
          },
        }
      : undefined;
    const env = this.vehicleEnv(droneBase);
    const afterStep = (state: PlayerState, input: PlayerInput, previousButtons: number): void =>
      this.predictDrops(state, input, previousButtons, dt, body.world);
    let result: ReconcileResult | null = null;
    // First check since reconnecting, before any new step: this is the state the inputs sent
    // from now on start from.
    if (this.resync) {
      this.resync = false;
      this.floor = clonePlayerState(current);
    }

    // A respawn: the new life starts fresh at the spawn right after input `seq`; every later
    // input (some maybe already applied by the server) is replayed on it.
    const rs = this.respawn;
    if (rs && rs.life > this.life) {
      this.respawn = null;
      this.life = rs.life;
      clearDropOwner(this.dropState.drops, w.id);
      // A newer snapshot may already contain swaps made in this new life; trust its locks.
      if (!this.latestOwn || this.latestOwn.s.life < rs.life)
        clearDropOwner(this.authoritativeDrops ?? [], w.id);
      this.primary = rs.primary;
      const fresh = createPlayerState({ x: rs.x, y: rs.y, z: rs.z }, w.seed, w.mode, rs.primary);
      fresh.view = { yaw: rs.yaw, pitch: 0 };
      grantSpawnProtection(fresh);
      this.unackedBase = clonePlayerState(fresh);
      result = this.adopt(
        reconcile(current, this.pending, toSnapshotPlayer(w.id, fresh, rs.seq, rs.life), body, dt, {
          forceReset: true,
          base: fresh,
          crowd,
          env,
          beforeReplay: this.replayProps,
          afterStep,
        }),
      );
      current = result.state;
    }

    const own = this.latestOwn;
    this.latestOwn = null;
    if (!own || own.s.life < this.life) return result; // nothing new, or from the old life
    const s = own.s;
    const dropsChanged =
      this.authoritativeDrops !== null && !sameDrops(this.dropState.drops, this.authoritativeDrops);
    let base: PlayerState | undefined;
    const respawned = s.life > this.life;
    if (respawned) {
      // Fallback (the respawn message went missing): rebuild the new life at the snapshot.
      this.life = s.life;
      clearDropOwner(this.dropState.drops, w.id);
      base = createPlayerState({ x: s.x, y: s.y, z: s.z }, w.seed, w.mode, this.primary);
    } else if (s.ack < 0) {
      // No input applied does not mean no change: another player can kill us, or the server
      // can idle our body. Compare against the last server baseline, never the predicted head.
      base = this.unackedBase ?? createPlayerState(w.spawn, w.seed, w.mode, this.primary);
      if (!this.reconnected && !dropsChanged && snapshotError(base, s) <= RECONCILE_TOLERANCE) {
        if (this.authoritativeDrops) {
          this.resetDropPrediction(
            this.pending.filter((step) => step.input.seq > s.ack).length * dt,
          );
        }
        return result;
      }
    } else if (this.floor && !this.pending.some((p) => p.input.seq === s.ack)) {
      // The acknowledged step is older than every prediction kept (reconnect, trim): rebuild on
      // the state before them and replay them all, rather than on `current` (which already has
      // them applied). Also after a reconnect before the server ever applied an input (ack =
      // -1): the steps predicted before the drop never reached it, so they are dropped too.
      base = this.floor;
    }
    if (s.ack < 0 && base) {
      this.unackedBase = clonePlayerState(base);
      applySnapshotMove(this.unackedBase, s);
    } else this.unackedBase = null;
    const r = this.adopt(
      reconcile(current, this.pending, s, body, dt, {
        forceReset: respawned || !!base || dropsChanged,
        base,
        crowd,
        env,
        beforeReplay: this.replayProps,
        afterStep,
      }),
    );
    if (!r.corrected && this.authoritativeDrops) {
      this.resetDropPrediction(this.pending.filter((step) => step.input.seq > s.ack).length * dt);
    }
    this.primary = r.state.arsenal.primary;
    return result?.corrected && !r.corrected ? { ...r, corrected: true, error: result.error } : r;
  }

  private adopt(r: ReconcileResult): ReconcileResult {
    this.pending = r.pending;
    // `pending` now starts at the server's acknowledged step (the reference), or is all new.
    this.floor = null;
    this.reconnected = false;
    if (r.corrected) {
      this.corrections++;
      this.lastError = r.error;
    }
    return r;
  }

  /** Remote players to draw at local time `localMs` (interpolated in the past). */
  remotePlayers(localMs: number): RemotePlayer[] {
    const t = this.drawTime(localMs);
    if (t === undefined) return [];
    const out: RemotePlayer[] = [];
    for (const [id, buf] of this.remotes) {
      const pose = buf.sample(t);
      buf.prune(t);
      if (!pose) continue;
      const entry = this.roster.find((r) => r.id === id);
      out.push({ id, name: entry ? rosterDisplayName(entry) : '…', slot: entry?.slot ?? 0, pose });
    }
    return out;
  }

  /** Live enemy drones to draw at local time `localMs` (same timeline as remote players). */
  remoteDrones(localMs: number): RemoteDrone[] {
    const t = this.drawTime(localMs);
    if (t === undefined) return [];
    const out: RemoteDrone[] = [];
    for (const [owner, samples] of this.drones) {
      while (samples.length > 2 && samples[1]!.t < t - 500) samples.shift();
      let before: DroneSample | undefined;
      let after: DroneSample | undefined;
      for (const s of samples) {
        if (s.t <= t) before = s;
        else {
          after = s;
          break;
        }
      }
      const pose =
        before?.pose && after?.pose
          ? mixDrone(before.pose, after.pose, (t - before.t) / Math.max(1, after.t - before.t))
          : before?.pose;
      if (pose) out.push({ ...pose, owner });
    }
    return out;
  }

  private pushDroneSample(serverMs: number, owner: string, pose: RemoteDrone | null): void {
    const list = this.drones.get(owner) ?? [];
    if (list.length && serverMs <= list.at(-1)!.t) return;
    list.push({ t: serverMs, pose });
    this.drones.set(owner, list);
  }

  private pruneDroneTrack(owner: string, serverMs: number): void {
    const list = this.drones.get(owner);
    if (!list?.length) return;
    const keepFrom = serverMs - DRONE_TRACK_KEEP_MS;
    while (list.length > 1 && list[1]!.t < keepFrom) list.shift();
    const latest = list.at(-1)!;
    if (latest.pose === null && serverMs - latest.t > DRONE_TRACK_KEEP_MS)
      this.drones.delete(owner);
  }
}

function mixDrone(a: RemoteDrone, b: RemoteDrone, f: number): RemoteDrone {
  const k = Math.max(0, Math.min(1, f));
  const lerp = (x: number, y: number): number => x + (y - x) * k;
  const yawDelta = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
  return {
    owner: a.owner,
    pos: {
      x: lerp(a.pos.x, b.pos.x),
      y: lerp(a.pos.y, b.pos.y),
      z: lerp(a.pos.z, b.pos.z),
    },
    yaw: a.yaw + yawDelta * k,
    battery: lerp(a.battery, b.battery),
  };
}
