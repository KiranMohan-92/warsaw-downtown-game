import * as v from 'valibot';
import { PRIMARY_IDS, type BotPersonalityId, type PrimaryId } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { PickupState, RadarState } from '../sim/pickups.ts';
import type { WeaponDropEvent, WeaponDropState } from '../sim/weaponDrops.ts';
import type { BoardState } from '../sim/skateboard.ts';
import type { JetpackItem } from '../sim/jetpack.ts';
import type { SmokeCloud } from '../sim/smoke.ts';

/** Room names registered on the server. */
export const ROOMS = {
  dev: 'dev',
  /** Authoritative online match (M3): up to 6 players on one map. */
  match: 'match',
} as const;

/**
 * Online match networking constants (M3a). Wire/transport numbers, not balance: gameplay
 * tunables stay in `config/tunables.ts`.
 */
export const MATCH_NET = {
  maxPlayers: 6,
  /** Snapshots go out every Nth 60 Hz server tick (2 → 30 Hz, `NET.serverTickHz`). */
  snapshotEvery: 2,
  /** Input rate limit: sustained inputs per second (60 Hz sim + 10% clock slack)… */
  inputRateHz: 66,
  /** …and the burst a client may send at once (a frame hitch, a reconnect flush). */
  inputBurst: 30,
  /** Max inputs in one `input` message (the client batches each frame's sim steps). */
  maxInputBatch: 16,
  /** Steps the server runs per player per tick at most (catch-up after jitter). */
  maxStepsPerTick: 8,
  /** Inputs queued per player at most (beyond this the oldest are dropped, never buffered forever). */
  maxQueuedInputs: 64,
  /**
   * Movement-time budget, in ticks. Each player earns one step of credit per 60 Hz of real
   * server time and every step (input or idle) spends one, so nobody moves more steps than time
   * has passed, whatever they send. Credit saved while inputs are late (jitter) lets them catch
   * up; once it is full (200 ms without inputs: menu open, tab hidden, connection lost) the
   * server runs idle steps (gravity, deceleration; not acknowledged) instead.
   */
  stallTicks: 12,
  /**
   * Server ticks run per timer callback at most. The room steps whole 1/60 s ticks of measured
   * real time (a late or coarse timer runs two or three), so snapshot times track the wall clock.
   */
  maxCatchUpTicks: 8,
  /** Real time the server catches up on at most after a stall (ms); beyond this it is skipped. */
  maxCatchUpMs: 1000,
  /** Seconds a dropped client may reconnect into its seat (its body stays in the match). */
  reconnectSeconds: 20,
  /**
   * Snapshot pacing (server, `match/pacer.ts`): a snapshot is sent at its tick's absolute time.
   * Busy-wait at most this long for it (ms): coarse timers (15.6 ms on Windows) can't hit it.
   */
  snapshotSpinMs: 1.5,
  /** A snapshot tick may run at most this early (ms; and half the measured timer granularity). */
  snapshotMaxLeadMs: 8,
  /** Two snapshots never leave closer than this × the snapshot period (no bunching after a stall). */
  snapshotMinGapRatio: 0.75,
  /**
   * Remote players are drawn this far in the past, between two received snapshots (ms): the
   * floor of the client's adaptive jitter buffer (`client/net/interpolation.ts`), and the
   * server's lag-compensation fallback when an input carries no view time.
   */
  interpDelayMs: 100,
  /**
   * The jitter buffer's ceiling (ms): the most interpolation delay a shot's rewind is granted
   * (the server can't see a client's buffer, so this bounds what any client can claim to draw
   * with; see `lagComp.rewindCapMs`).
   */
  maxInterpDelayMs: 250,
  /** Remote players keep moving on their last velocity at most this long after data runs out (ms), then hold. */
  maxExtrapolateMs: 150,
  /** Colyseus hard cap: a client sending more messages than this per second is disconnected. */
  maxMessagesPerSecond: 120,
  /** Player names: trimmed, printable, at most this many characters. */
  maxNameLength: 16,
  /** Name changes during a match: burst, then this many per second (excess ignored). */
  nameBurst: 3,
  nameRatePerSec: 0.2,
  /**
   * Lag compensation (M3b): a shot is checked against the other players where the shooter saw
   * them (its view time). The rewind is capped per player (`lagComp.rewindCapMs`: interpolation
   * delay + the round trip the *server* measured + `rewindMarginMs`), and this is the absolute
   * ceiling (ms) whatever a client reports or however its ping is: beyond it a high-latency
   * shooter has to lead; nobody can reach further into the past.
   */
  maxRewindMs: 350,
  /**
   * Slack in the per-player rewind cap (ms) for what the measured round trip doesn't cover:
   * the input's wait for its server tick (≤ 2 ticks), the frame it was batched in, ping jitter.
   */
  rewindMarginMs: 40,
  /**
   * Round-trip samples (one per `pingIntervalMs`) the rewind cap's RTT is taken from: their 90th
   * percentile, so one spike in the window (or a client stalling one pong) never widens the cap.
   */
  rttWindow: 10,
  /** Pings per player awaiting their echo (older ones are forgotten: their pong no longer counts). */
  maxOutstandingPings: 8,
  /** A pong later than this after its ping is not a round-trip sample (ms). */
  pongTimeoutMs: 5000,
  /** Pose history kept per player for rewinding (60 Hz ticks, more than `maxRewindMs`). */
  historyTicks: 30,
  /** Server → client ping period (ms): round-trip time for lag compensation and the badge. */
  pingIntervalMs: 1000,
  /**
   * A friend-lobby player still loading the game is out of the fight until `ready`, at most this
   * long (ms): a client that never says so can't stay untouchable.
   */
  readyTimeoutMs: 20000,
} as const;

/** Message: client → server ping used by the dev room to prove the wiring end-to-end. */
export const PingMessage = v.object({
  t: v.pipe(v.number(), v.finite()),
});
export type PingMessage = v.InferOutput<typeof PingMessage>;

export interface PongMessage {
  t: number;
  serverTime: number;
}

// ---------------------------------------------------------------------------------------------
// Online match (M3a): clients send inputs only; the server simulates and sends snapshots.
// ---------------------------------------------------------------------------------------------

export const MATCH_MAPS = ['defilad', 'range'] as const;
export const MATCH_SIZES = ['market', 'full', 'north', 'south'] as const;
export const MATCH_MODES = ['standard', 'knife'] as const;
/** Append-only: the default is golden hour (Kiran, 2026-10-13). */
export const MATCH_WEATHERS = ['sunny', 'overcast', 'rain', 'dusk', 'neon', 'golden'] as const;
export const MATCH_RADARS = ['uplinks', 'off'] as const;
export const MATCH_BOT_BEHAVIOURS = ['ffa', 'hunt-humans'] as const;
export const MATCH_BOT_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
/** Vehicles on the map (the armored trucks): host setting, default on. */
export const MATCH_VEHICLES = ['on', 'off'] as const;
/** Bots' chat lines (`server/match/botChatter.ts`): host setting, on unless turned off. */
export const MATCH_BOT_CHATTER = ['on', 'off'] as const;

const finite = v.pipe(v.number(), v.finite());
const boundedInt = (min: number, max: number) =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(min), v.maxValue(max));

/** A match limit that never ends the match by itself (the explicit string, never Infinity). */
export const UNLIMITED = 'unlimited' as const;
/** Kills to win (1–100), or unlimited. */
export type MatchScoreLimit = number | typeof UNLIMITED;
/** Match clock (60–3600 s), or unlimited. */
export type MatchTimeLimit = number | typeof UNLIMITED;
const scoreLimitSchema = v.union([boundedInt(1, 100), v.literal(UNLIMITED)]);
const timeLimitSchema = v.union([boundedInt(60, 3600), v.literal(UNLIMITED)]);
/** The menu/lobby choices (the wire accepts any value in range). Default first to 25 in 10 min. */
export const MATCH_SCORE_LIMITS: readonly MatchScoreLimit[] = [10, 25, 50, UNLIMITED];
export const MATCH_TIME_LIMITS: readonly MatchTimeLimit[] = [300, 600, 900, 1200, UNLIMITED];

const matchSettingsEntries = {
  map: v.optional(v.picklist(MATCH_MAPS), 'defilad'),
  size: v.optional(v.picklist(MATCH_SIZES), 'market'),
  mode: v.optional(v.picklist(MATCH_MODES), 'standard'),
  weather: v.optional(v.picklist(MATCH_WEATHERS), 'golden'),
  radar: v.optional(v.picklist(MATCH_RADARS), 'uplinks'),
  botCount: v.optional(boundedInt(0, MATCH_NET.maxPlayers - 1), MATCH_NET.maxPlayers - 1),
  botBehaviour: v.optional(v.picklist(MATCH_BOT_BEHAVIOURS), 'ffa'),
  botDifficulty: v.optional(v.picklist(MATCH_BOT_DIFFICULTIES), 'normal'),
  scoreLimit: v.optional(scoreLimitSchema, 25),
  timeLimit: v.optional(timeLimitSchema, 600),
  vehicles: v.optional(v.picklist(MATCH_VEHICLES), 'on'),
  /** Absent = on (older peers send none). */
  botChatter: v.optional(v.picklist(MATCH_BOT_CHATTER)),
} as const;

/** Largest input sequence number (int32, the range `sanitizeInput` keeps: ~414 days at 60 Hz). */
export const MAX_INPUT_SEQ = 2 ** 31 - 1;

/** Authoritative host settings for an M3 match/lobby. */
export const MatchSettings = v.object(matchSettingsEntries);
export type MatchSettings = v.InferOutput<typeof MatchSettings>;

/**
 * Room options (create and join). Quick join creates/joins a playing match (`lobby: false`);
 * explicit friend lobbies set `lobby: true` and then the host starts the frozen settings.
 */
export const MatchOptions = v.object({
  ...matchSettingsEntries,
  lobby: v.optional(v.boolean(), false),
  name: v.optional(v.pipe(v.string(), v.maxLength(64))),
  /** This player's loadout primary (per player, like the name; never a room setting). */
  primary: v.optional(v.picklist(PRIMARY_IDS)),
});
export type MatchOptions = v.InferOutput<typeof MatchOptions>;

/**
 * The room keys matchmaking filters on (`filterBy`). Colyseus only filters on keys the request
 * carries, so a create/join/joinOrCreate must send every one of them (the server refuses it
 * otherwise); a share-link `joinById` needs none.
 */
export const MATCH_KEYS = ['lobby', 'map', 'size', 'mode'] as const;

/** Whether raw room options carry every matchmaking key (`MATCH_KEYS`). */
export function hasAllMatchKeys(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  return MATCH_KEYS.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(raw, k) && (raw as Record<string, unknown>)[k] != null,
  );
}

/** Everything a match plays with besides its matchmaking keys (host-only in friend lobbies). */
export type QuickJoinSettings = Omit<MatchSettings, 'map' | 'size' | 'mode'>;

/**
 * What every quick-join match plays with. Only map, size and mode are the joiner's choice: the
 * server ignores anything else a room's creator sends, so nobody can impose bots, limits or
 * weather on the honest players matched into their room.
 */
export const QUICK_JOIN_SETTINGS: Readonly<QuickJoinSettings> = {
  weather: 'golden',
  radar: 'uplinks',
  botCount: MATCH_NET.maxPlayers - 1,
  botBehaviour: 'ffa',
  botDifficulty: 'normal',
  scoreLimit: 25,
  timeLimit: 600,
  vehicles: 'on',
  botChatter: 'on',
};

/** Host-only settings update while the room is still in the lobby. */
export const MatchSettingsUpdate = v.object({
  map: v.optional(v.picklist(MATCH_MAPS)),
  size: v.optional(v.picklist(MATCH_SIZES)),
  mode: v.optional(v.picklist(MATCH_MODES)),
  weather: v.optional(v.picklist(MATCH_WEATHERS)),
  radar: v.optional(v.picklist(MATCH_RADARS)),
  botCount: v.optional(boundedInt(0, MATCH_NET.maxPlayers - 1)),
  botBehaviour: v.optional(v.picklist(MATCH_BOT_BEHAVIOURS)),
  botDifficulty: v.optional(v.picklist(MATCH_BOT_DIFFICULTIES)),
  scoreLimit: v.optional(scoreLimitSchema),
  timeLimit: v.optional(timeLimitSchema),
  vehicles: v.optional(v.picklist(MATCH_VEHICLES)),
  botChatter: v.optional(v.picklist(MATCH_BOT_CHATTER)),
});
export type MatchSettingsUpdate = v.InferOutput<typeof MatchSettingsUpdate>;

const normalizeSettings = (s: MatchSettings): MatchSettings => ({
  ...s,
  size: s.map === 'range' ? 'full' : s.size,
});

/**
 * The options a client should send: every matchmaking key explicit (rooms are matched on the
 * raw options, so an omitted key would match any room), and the range's single size.
 */
export function normalizeMatchOptions(
  o: Partial<MatchSettings> & {
    map: MatchSettings['map'];
    size: MatchSettings['size'];
    mode: MatchSettings['mode'];
    lobby?: boolean;
    name?: string;
    primary?: PrimaryId;
  },
): MatchOptions {
  const name = o.name?.trim();
  const settings = parseMatchOptions({ ...o, name: undefined });
  if (!settings) {
    return {
      map: 'defilad',
      size: 'market',
      mode: 'standard',
      ...QUICK_JOIN_SETTINGS,
      lobby: false,
      ...(name ? { name } : {}),
      ...(o.primary ? { primary: o.primary } : {}),
    };
  }
  return {
    ...settings,
    lobby: o.lobby ?? false,
    ...(name ? { name } : {}),
  };
}

/** Validate room create/join options (null = invalid: the join is refused). */
export function parseMatchOptions(raw: unknown): MatchOptions | null {
  const r = v.safeParse(MatchOptions, raw ?? {});
  if (!r.success) return null;
  const name = r.output.name?.trim();
  return {
    ...normalizeSettings(r.output),
    lobby: r.output.lobby,
    ...(name ? { name } : {}),
    ...(r.output.primary ? { primary: r.output.primary } : {}),
  };
}

/** Validate a host settings patch (null = invalid; no payload is logged by Colyseus). */
export function parseMatchSettingsUpdate(raw: unknown): MatchSettingsUpdate | null {
  const r = v.safeParse(MatchSettingsUpdate, raw ?? {});
  return r.success ? r.output : null;
}

/**
 * One sim step of intent on the wire. Types and finiteness are checked here; ranges are clamped
 * by `sanitizeInput` on the server (stick magnitude, pitch, unknown button bits).
 */
export const WireInput = v.object({
  seq: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(MAX_INPUT_SEQ)),
  moveX: finite,
  moveZ: finite,
  yaw: finite,
  pitch: finite,
  buttons: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /**
   * View time (server ms): when this step was taken the client was drawing the other players as
   * they were at this server time (its server clock − `interpDelayMs`). The server checks this
   * step's shots against them there, never more than `maxRewindMs` in the past.
   */
  vt: v.optional(finite),
});
export type WireInput = v.InferOutput<typeof WireInput>;

/** Message: client → server, the sim steps since the last send (one per 60 Hz step, in order). */
export const InputMessage = v.object({
  inputs: v.pipe(v.array(WireInput), v.minLength(1), v.maxLength(MATCH_NET.maxInputBatch)),
});
export type InputMessage = v.InferOutput<typeof InputMessage>;

/**
 * A valibot schema's output, or null for any other payload: a Standard Schema that never fails,
 * for a room handler that kicks the sender itself. A failing schema makes Colyseus log the whole
 * payload as an error and, for a `room.request` frame, reply ERROR without kicking, so a client
 * could flood the server log.
 */
function orNull<T>(schema: v.GenericSchema<unknown, T>) {
  return {
    '~standard': {
      version: 1,
      vendor: 'wd',
      validate: (value: unknown): { value: T | null } => {
        const r = v.safeParse(schema, value);
        return { value: r.success ? r.output : null };
      },
      types: undefined as { input: T | null; output: T | null } | undefined,
    },
  } as const;
}

/** `InputMessage`, or null for anything else (the sender is kicked). */
export const InputMessageOrNull = orNull(InputMessage);

/**
 * Message: client → server, the player's name changed (Menu › "Your name online"). Sanitized
 * with `sanitizeName` and rate limited on the server; anything else kicks the sender.
 */
export const NameMessage = v.object({ name: v.pipe(v.string(), v.maxLength(64)) });
export type NameMessage = v.InferOutput<typeof NameMessage>;
export const NameMessageOrNull = orNull(NameMessage);

/** `MatchSettingsUpdate`, or null for anything else (the room replies with a lobby error). */
export const MatchSettingsUpdateOrNull = orNull(MatchSettingsUpdate);

/** Message: host → server, start the lobby using the current frozen settings. */
export const StartMatchMessage = v.object({});
export type StartMatchMessage = v.InferOutput<typeof StartMatchMessage>;
export const StartMatchMessageOrNull = orNull(StartMatchMessage);

/**
 * Message: host → server, end the running match now (the normal results and shared-win rule):
 * how a match with no limits ends. Refused for anyone but the connected host, or after it ended.
 */
export const EndMatchMessage = v.object({});
export type EndMatchMessage = v.InferOutput<typeof EndMatchMessage>;
export const EndMatchMessageOrNull = orNull(EndMatchMessage);

/**
 * Message: client → server, the game is built and warmed up (friend lobbies: the match started
 * while this client was still loading). Until then the server keeps the player out of the fight.
 */
export const ReadyMessage = v.object({});
/**
 * Message: client → server, the player picked another loadout primary. Takes effect at their
 * next spawn (ground swaps affect only the current life); anything else kicks the sender.
 */
export const LoadoutMessage = v.object({ primary: v.picklist(PRIMARY_IDS) });
export type LoadoutMessage = v.InferOutput<typeof LoadoutMessage>;
export const LoadoutMessageOrNull = orNull(LoadoutMessage);
/** Dev/autotest only: validated by both the practice host and development match rooms. */
export const DropGunMessage = v.object({
  primaryId: v.picklist(PRIMARY_IDS),
  x: finite,
  z: finite,
  ammoFraction: v.pipe(finite, v.minValue(0), v.maxValue(1)),
});
export type DropGunMessage = v.InferOutput<typeof DropGunMessage>;
export const DropGunMessageOrNull = orNull(DropGunMessage);
export type ReadyMessage = v.InferOutput<typeof ReadyMessage>;
export const ReadyMessageOrNull = orNull(ReadyMessage);

/** Message: server → client every `pingIntervalMs`: `t` to echo, and the round trip measured. */
export interface MatchPing {
  t: number;
  /** Smoothed round-trip time (ms), -1 until measured. */
  rtt: number;
  /**
   * Everyone else's round trip as the server measured it (ms, rounded; humans only, -1 until
   * measured), for the scoreboard. Absent from older servers.
   */
  pings?: Record<string, number>;
}

/** Message: client → server, the echo of a `MatchPing` (its `t`, unchanged). */
export const MatchPong = v.object({ t: finite });
export type MatchPong = v.InferOutput<typeof MatchPong>;
export const MatchPongOrNull = orNull(MatchPong);

/** Snapshot flag bits (movement state the client needs to replay exactly). */
export const SnapFlag = {
  Grounded: 1 << 0,
  Crouched: 1 << 1,
  Sprinting: 1 << 2,
  LowRun: 1 << 3,
  Traversing: 1 << 4,
  /** Riding the skateboard. */
  Board: 1 << 5,
  /** Lying prone. */
  Prone: 1 << 6,
  /**
   * Spawn-protected (takes no damage; `sim/spawnProtection.ts`): clients draw the shimmer and
   * the blocked marker from it. Older clients ignore the bit.
   */
  Protected: 1 << 7,
  /** Sliding (crouch capsule; soldiers lean back over the crouch clip). Older peers ignore it. */
  // (`f` is a plain number on the wire — msgpack integer, no byte packing — so bits past 7 are safe.)
  Sliding: 1 << 8,
  /** Tactical sprint burst (weapon held low; `TAC_SPRINT`). Older peers ignore it. */
  TacSprint: 1 << 9,
  /**
   * Wearing a jetpack (lit or not: it is on their back). Bits 10–13 are the jetpack's (the
   * vehicle lane uses no flag bits); older peers ignore them.
   */
  Jetpack: 1 << 10,
  /** Flying on it (or the out-of-fuel drop): no sprint/slide/prone; others see the flyer. */
  JetFlight: 1 << 11,
  /** Thrusting (Jump held): the exhaust and the roar others see and hear. */
  JetThrust: 1 << 12,
  /**
   * Out of fuel: the drop (with `JetFlight`, which it never comes without). Unpowered: no
   * exhaust, no engine. Without it a drop and a hover with Jump released looked the same.
   */
  JetDrop: 1 << 13,
} as const;

/** Arsenal slots on the wire (`SnapshotPlayer.sl` / `tg` index this). */
export const SNAP_SLOTS = ['rifle', 'sidearm', 'knife'] as const;

/**
 * An active climb or vault on the wire (its path is fixed when it starts), so a client that never
 * predicted it (the server found a ledge the client missed, or stepped an input the client never
 * had) rebuilds the exact move instead of only knowing that one is running.
 */
export interface TraversalWire {
  /** 0 = mantle, 1 = vault. */
  k: 0 | 1;
  dur: number;
  /** Start (feet): x, y, z. */
  from: number[];
  /** Waypoints after the start, x y z each (flattened). */
  path: number[];
  /** End (feet): x, y, z. */
  to: number[];
  /** Horizontal direction of travel: x, z. */
  dir: number[];
}

/**
 * The recipient's own weapon and kit state (only in its own entry of the snapshot it is sent).
 * Inputs the server skipped (late after a stall, lost in a reconnect) or strikes it resolved (a
 * parry stuns, a block wears the guard down) would leave the client's counts wrong for good if
 * only movement were corrected; with these the correction is complete.
 */
export interface OwnState {
  /** Per gun (`SNAP_GUNS` order): numeric WeaponState fields in snapshot.ts GUN_FIELDS order. */
  guns: number[];
  /** Frags, smokes, jammer charges. */
  kit: number[];
  /**
   * Stun, counter window, guard-broken timer, blocks absorbed, guard held for (-1 = down), throw
   * phase (0 idle, 1 wind-up, 2 recover) and timer, knife swing phase and timer, throw kind
   * (0 frag, 1 smoke), quick swing, swings, move (0 slash, 1 backhand, 2 thrust), combo,
   * since strike, windup duration, empowered, switch duration.
   */
  hands: number[];
  /**
   * Coyote, jump buffer, landing slowdown timers, footstep distance, slide time/cooldown/buffer,
   * tactical sprint tank and refill delay (`snapshot.ts` MOVE_FIELDS).
   */
  move: number[];
  /** The last buttons the server consumed: replayed edges must not inherit lost inputs. */
  buttons: number;
  /** Stored drone uplink charges, omitted at 0. */
  dc?: number;
  /**
   * Own recon-drone state while flying:
   * [owner, x, y, z, vx, vy, vz, yaw, pitch, battery, baseY].
   */
  dr?: number[];
  /** Jetpack mode (`JetMode`) and flight seconds left, omitted without a pack. */
  jp?: number[];
  /**
   * Spawn protection left (s), omitted at 0: the HUD's draining chip, and a new life's
   * protection the client never granted itself. Absent or junk reads as none.
   */
  sg?: number;
  /**
   * The vehicle this player drives: its whole motion (`motionToWire`), so the driver's
   * prediction of it is reconciled like its own movement. Only while driving.
   */
  vm?: number[];
}

/** Guns in `OwnState.guns` order. */
export const SNAP_GUNS = ['rifle', 'sidearm'] as const;

/** One player in a snapshot. Positions are feet (bottom of the capsule). */
export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  /** Eye height above the feet (stance: crouch / low run / stand, eased). */
  eye: number;
  /** `SnapFlag` bits. */
  f: number;
  /** Climb/vault progress (s into the move), -1 when not traversing. */
  tt: number;
  hp: number;
  /**
   * Weapon in hand and weapon being raised (`SNAP_SLOTS` index), and seconds left raising it.
   * Movement speed depends on the weapon (knife runs faster), so a switch the server never saw
   * (an input lost in a reconnect) must be corrected like a position error.
   */
  sl: number;
  tg: number;
  sw: number;
  /**
   * The currently held primary (`PRIMARY_IDS` index, append-only), so everyone draws the gun a
   * player really carries. One small integer per entry; unknown values decode as the AR-7.
   */
  pr: number;
  /**
   * What their hands are visibly doing (sim/action.ts `encodeAction`: reload / throw / knife
   * strike / guard / stun with progress), from the authoritative state, so others draw it.
   * Omitted when idle (0); unknown codes decode as no action.
   */
  ac?: number;
  /** Last input sequence number the server applied for this player (-1: none yet). */
  ack: number;
  /** Increments on every (re)spawn: a teleport, never interpolated across. */
  life: number;
  /** The climb or vault in progress (sent with `SnapFlag.Traversing`). */
  tr?: TraversalWire;
  /** Only in the recipient's own entry: its weapon and kit state. */
  own?: OwnState;
  /** In a vehicle: vehicle id × 8 + seat index (`seatToWire`); absent on foot. */
  vh?: number;
}

/** Vehicle condition on the wire (`SnapshotVehicle.st`). */
export const VEHICLE_STATES = ['active', 'wreck', 'gone'] as const;
export type VehicleCondition = (typeof VEHICLE_STATES)[number];

/** One vehicle in a snapshot (occupants come from the players' `vh`). */
export interface SnapshotVehicle {
  id: number;
  /** Motion (`motionToWire`): pose, velocity, yaw rate, steering, tilt, grounded. */
  m: number[];
  hp: number;
  /** `VEHICLE_STATES` index. */
  st: number;
}

/** Compact live-drone entry: [owner, x, y, z, yaw, battery bucket 0..255]. */
export type SnapshotDrone = [
  owner: string,
  x: number,
  y: number,
  z: number,
  yaw: number,
  battery: number,
];

/** Message: server → clients at 30 Hz. `t` = server tick (60 Hz) the state belongs to. */
export interface SnapshotMessage {
  t: number;
  /** Frozen practice bootstrap state: render it, but do not sample clock or link timing. */
  held?: true;
  players: SnapshotPlayer[];
  /** Dropped primary guns, including their remaining ammo and expiry (absent: none). */
  drops?: WeaponDropState[];
  tactical?: {
    /**
     * Live clouds plus those that ran out within the longer of the rewind cap and the
     * interpolation ceiling (age ≥ the smoke lifetime: rewound, never drawn now), ages as of
     * `t`. None through the results, so a new match starts with none.
     */
    smoke: SmokeCloud[];
    pickups: PickupState[];
    radar: RadarState;
    /** The skateboard (absent: none on this map): where it lies, and who rides it. */
    board?: BoardState;
    /** The match's jetpacks (absent: none on this map): where each lies, who wears it, spent. */
    jetpacks?: JetpackItem[];
    /** Radar static left for this recipient, omitted at 0. */
    jammed?: number;
    /** Enemy positions spotted by this recipient's drone only. */
    spotted?: { id: string; pos: Vec3; t: number }[];
  };
  /** Live recon drones in this match. */
  drones?: SnapshotDrone[];
  /** The match's vehicles (absent: none, or vehicles off). */
  vehicles?: SnapshotVehicle[];
  /** Props tumbling now (absent: none): [id, knock number, x, y, z, qx, qy, qz, qw] each. */
  props?: number[][];
}

/** Small drop feedback events, sent before the snapshot that carries the resulting state. */
export interface DropMessage {
  events: WeaponDropEvent<string>[];
}

export interface RosterEntry {
  id: string;
  name: string;
  /** Stable colour slot 0–5 for the match. */
  slot: number;
  connected: boolean;
  bot?: boolean;
  /** A bot's personality (`BOT.personalities`: rusher, flanker, anchor, marksman). */
  persona?: BotPersonalityId;
}

/** Message: server → clients whenever someone joins, leaves, drops or reconnects. */
export interface RosterMessage {
  players: RosterEntry[];
}

/**
 * Message: server → that player only, when the server respawned them (killed, or fell out of
 * the world). `seq` is the last input applied in the old life (-1: none): every later input
 * belongs to the new life, which starts from a fresh state at the spawn.
 */
export interface RespawnMessage {
  life: number;
  seq: number;
  /** The new life's loadout primary. */
  primary: PrimaryId;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Message: server → the joining client only. */
export interface WelcomeMessage {
  id: string;
  map: (typeof MATCH_MAPS)[number];
  size: (typeof MATCH_SIZES)[number];
  mode: (typeof MATCH_MODES)[number];
  settings?: MatchSettings;
  tick: number;
  tickHz: number;
  spawn: { x: number; y: number; z: number; yaw: number };
  /** Per-player seed (spread/recoil streams). */
  seed: number;
  /** This life's loadout primary (the client predicts with the same gun). */
  primary: PrimaryId;
}

// ---------------------------------------------------------------------------------------------
// Online combat (M3b): the server resolves every shot, strike and blast; clients only draw them.
// ---------------------------------------------------------------------------------------------

/** What dealt damage: guns, knife, frag; a truck running someone over; a truck blowing up. */
export type CombatWeapon = 'rifle' | 'sidearm' | 'knife' | 'frag' | 'truck' | 'wreck';
export type WireZone = 'head' | 'torso' | 'legs';
export interface WireVec {
  x: number;
  y: number;
  z: number;
}

/** Something that happened in combat, for every client in the match. */
export type CombatEvent =
  /** A bullet the server fired for `by`: the others draw it (the shooter predicted its own). */
  | {
      type: 'shot';
      by: string;
      slot: 'rifle' | 'sidearm';
      from: WireVec;
      to: WireVec;
      /** A silent gun (coilgun): others hear only a faint crack, close by. */
      silent?: boolean;
    }
  /**
   * Damage dealt (the hit confirm): `hp` is the target's health after it, `killed` if this was
   * the killing blow. Knife strikes carry the defense outcome. `from` is where it came from (the
   * attacker's eye, or the blast) for the victim's damage arrow.
   */
  | {
      type: 'hit';
      by: string;
      target: string;
      weapon: CombatWeapon;
      zone: WireZone;
      dmg: number;
      hp: number;
      killed: boolean;
      at: WireVec;
      from: WireVec;
      /** Present for gun hits; matches the input sequence that produced the shot. */
      seq?: number;
      /**
       * Knife defense outcome, or `protected`: the target was spawn-protected, nothing landed
       * (`dmg` 0, any weapon; the shooter shows the blocked marker).
       */
      outcome?: 'hit' | 'blocked' | 'guardBroken' | 'parried' | 'protected';
    }
  /** A handheld jammer pulse, for remote presentation and drone-counter feedback. */
  | { type: 'jammer'; by: string; at: WireVec }
  /** A frag thrown by `by` (the shared flight code: every client can draw its path). */
  | {
      type: 'nade';
      id: number;
      by: string;
      pos: WireVec;
      vel: WireVec;
      fuse: number;
      kind?: 'frag' | 'smoke';
      /** Restore/replay may send an already-settled frag. Omitted by old throw events. */
      resting?: boolean;
    }
  /** That frag went off. */
  | { type: 'boom'; id: number; by: string; pos: WireVec; kind?: 'frag' | 'smoke' }
  /**
   * A vehicle took damage from `by` (health `hp` after it; `seq` = the shooter's input for its
   * hit marker). Vehicle health also rides in every snapshot.
   */
  | {
      type: 'vhit';
      by: string;
      vehicle: number;
      weapon: CombatWeapon;
      dmg: number;
      hp: number;
      at: WireVec;
      seq?: number;
    }
  /** A vehicle was destroyed (by `by`): its explosion at `pos`. */
  | { type: 'vboom'; vehicle: number; by: string; pos: WireVec }
  /**
   * A prop changed (`PhysicsWorld` prop id, map order), at server tick `at`: a truck smashed it
   * (`at` = the contact point) or knocked it over (it tumbles in the snapshots' `props` until it
   * settles), it settled at pose `p` (`propPoseToWire`), or it is gone (fell out of the world).
   * `quiet`: a joiner's restore (no debris, no sound). Props stay so until `propsReset`.
   */
  | {
      type: 'prop';
      id: number;
      k: 'smash' | 'knock' | 'settle' | 'gone';
      tick: number;
      at?: WireVec;
      p?: number[];
      /** Closing speed of the hit (m/s): how loud. */
      v?: number;
      /**
       * The prop's knock number this match (absent: 0): a tumble's knock, settle and snapshot
       * rows share it, so an older settle can't end a newer tumble.
       */
      n?: number;
      quiet?: boolean;
    }
  /** A new match: every prop back where the map put it. */
  | { type: 'propsReset' };

/** Message: server → clients, the combat events since the last one, in order. */
export interface CombatMessage {
  events: CombatEvent[];
}

export interface MatchScore {
  id: string;
  kills: number;
  deaths: number;
}

/**
 * Message: server → clients on every change of score or phase (and to each joiner). `endsAt` is
 * the server tick the phase ends: the match clock while playing, the next match's start while
 * the results show.
 */
export interface MatchStateMessage {
  phase: 'playing' | 'ended';
  /** Null while playing without a time limit (the results always end at a tick). */
  endsAt: number | null;
  scoreLimit: MatchScoreLimit;
  scores: MatchScore[];
  /** When ended: who won (more than one = a shared win). */
  winners: string[];
}

export interface LobbyPlayer {
  id: string;
  name: string;
  connected: boolean;
  bot?: boolean;
}

/** Message: server → clients whenever lobby membership, host or settings change. */
export interface LobbyMessage {
  roomId: string;
  hostId: string | null;
  phase: 'lobby' | 'playing';
  settings: MatchSettings;
  players: LobbyPlayer[];
}

/** Message: server → one client when a lobby command is refused. */
export interface LobbyErrorMessage {
  code: 'invalid-settings' | 'host-only' | 'already-started' | 'not-lobby';
  message: string;
}

/**
 * Winners of a free-for-all: most kills; among those, fewest deaths; still level = a shared win
 * (Kiran: a tie on kills and deaths is a shared win), including a zero-kill match.
 */
export function matchWinners(scores: readonly MatchScore[]): string[] {
  const best = Math.max(0, ...scores.map((s) => s.kills));
  const top = scores.filter((s) => s.kills === best);
  const fewest = Math.min(...top.map((s) => s.deaths));
  return top.filter((s) => s.deaths === fewest).map((s) => s.id);
}

/** Printable, trimmed player name; empty → fallback. */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // Drop control and format characters (incl. bidi overrides), collapse whitespace.
  const clean = raw
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  const cut = Array.from(clean).slice(0, MATCH_NET.maxNameLength).join('').trim();
  return cut || fallback;
}
