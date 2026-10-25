import {
  applyDamage,
  applyKnifeStrike,
  Button,
  clonePlayerState,
  clearDropOwner,
  computeDamage,
  createPlayerState,
  createWeaponDrops,
  crowdMemberOf,
  DRONE,
  droneSpots,
  explosionDamage,
  eyePosition,
  endsSpawnProtection,
  generateSpawns,
  getMap,
  grantSpawnProtection,
  isSpawnProtected,
  placeBodyAt,
  bendShot,
  FoliageIndex,
  gunConfig,
  humanoidHitboxes,
  isGun,
  jammerPulse,
  MATCH,
  MATCH_NET,
  matchWinners,
  mulberry32,
  observeDropOwners,
  PhysicsWorld,
  PRIMARY_IDS,
  resolveMap,
  resolveMelee,
  sanitizeInput,
  sanitizeName,
  smokeAt,
  pelletDirections,
  SIM,
  SIM_DT,
  spawnsFor,
  SPAWN_PROTECTION,
  spawnGrenade,
  spawnDrop,
  spawnDeathDrop,
  stepGrenade,
  stepPlayerInCrowd,
  stepDrops,
  swapWithDrop,
  toSnapshotDrone,
  toSnapshotPlayer,
  TokenBucket,
  traceShot,
  type CombatEvent,
  type CombatWeapon,
  type CrowdMember,
  type GrenadeState,
  type HitShape,
  type HitTarget,
  type HitZone,
  type KnifeMove,
  type MapDefinition,
  type MapId,
  type MapSize,
  type MatchMode,
  type MatchScoreLimit,
  type MatchTimeLimit,
  type MatchPing,
  type MatchStateMessage,
  type PlayerEvent,
  type PlayerInput,
  type PlayerState,
  type RapierCharacter,
  type PrimaryId,
  type RespawnMessage,
  type RosterMessage,
  type ShotFired,
  type SmokeCloud,
  type SnapshotMessage,
  type SpawnPoint,
  type Vec3,
  UNLIMITED,
  inFireArc,
  pressed,
  SEAT_SPEC,
  sameCrew,
  VEHICLE,
  withHulls,
  type SeatId,
  type StepEnv,
  type VehicleObstacle,
  type WorldRaycaster,
  type WeaponDropCollector,
  type WeaponDropEvent,
  type WeaponDropState,
} from '@wd/shared';
import { PingTracker, PoseHistory, rewoundShapes, RttEstimate, shotViewTime } from './lagComp.ts';
import { pickSpawn, spawnCandidates } from './spawn.ts';
import { MatchTactics } from './tactics.ts';
import { MatchBots } from './bots.ts';
import { MatchProps } from './props.ts';
import { MatchVehicles, type ServerVehicle, type VehicleDamage } from './vehicles.ts';
import { getNavGraph } from '../bots/nav.ts';
import { getDriveGraph } from '../bots/driveCache.ts';

export interface MatchConfig {
  map: MapId;
  size: MapSize;
  mode: MatchMode;
  /** Kills to win, or `'unlimited'` (kills never end the match). Default `MATCH.scoreLimit`. */
  scoreLimit?: MatchScoreLimit;
  /** Match clock (s), or `'unlimited'` (only the host's `end` or the score ends it). */
  timeLimit?: MatchTimeLimit;
  radar?: 'uplinks' | 'off';
  botCount?: number;
  botBehaviour?: 'ffa' | 'hunt-humans';
  botDifficulty?: 'easy' | 'normal' | 'hard';
  /** Spawn protection per life (s; default `SPAWN_PROTECTION.duration`, 0 = off: tests). */
  spawnProtection?: number;
  /** Spawn-only RNG seed (default 0 for replay); live hosts supply a fresh seed per match. */
  spawnSeed?: number;
  /** The map's armored trucks (host setting, default on). */
  vehicles?: 'on' | 'off';
  /** Truck spawns instead of the map's (tests, harnesses). */
  vehicleSpawns?: MapDefinition['vehicles'];
  /** The map's jetpacks (default on; skill duels turn them off). */
  jetpacks?: 'on' | 'off';
}

/** A queued input and the view time the client reported with it (lag compensation). */
export type QueuedInput = PlayerInput & { vt?: number };

export interface ServerPlayer {
  readonly id: string;
  readonly bot: boolean;
  name: string;
  /** Colour slot 0–5 (lowest free on join). */
  readonly slot: number;
  readonly seed: number;
  /** Loadout primary for the next life (the current life keeps `state.arsenal.primary`). */
  primary: PrimaryId;
  state: PlayerState;
  readonly body: RapierCharacter;
  /** Validated, sanitized inputs waiting for the next tick. */
  queue: QueuedInput[];
  /** Highest sequence number accepted into the queue (stale/duplicate inputs are dropped). */
  lastSeq: number;
  /** Last sequence number applied (sent back as `ack`). */
  ack: number;
  lastInput: PlayerInput | null;
  /** Movement-time budget in steps (see `MATCH_NET.stallTicks`). */
  credit: number;
  /**
   * Idle steps run since inputs stopped, not yet matched by late inputs. That time is already
   * simulated: when the late inputs arrive, the ones the budget can't cover are skipped
   * (acknowledged unapplied) instead of queueing behind every later input forever.
   */
  idleDebt: number;
  readonly bucket: TokenBucket;
  /** Name changes (`MATCH_NET.nameBurst`, `nameRatePerSec`). */
  readonly nameBucket: TokenBucket;
  /** Spawn counter (snapshots carry it so clients never interpolate across a teleport). */
  life: number;
  connected: boolean;
  /** Inputs refused by the rate limiter or the queue cap (diagnostics, tests). */
  dropped: number;
  /** Inputs applied (diagnostics, tests). */
  applied: number;
  /** Late inputs skipped against idle debt (diagnostics, tests). */
  skipped: number;
  /** The last respawn (life + last old-life input), resent to a reconnecting client. */
  lastRespawn: RespawnMessage | null;
  kills: number;
  deaths: number;
  /** Killed: the tick the respawn comes (0 = alive). */
  respawnTick: number;
  /** Where this player was, tick by tick (lag compensation rewinds others' shots into it). */
  readonly history: PoseHistory;
  /** Smoothed round-trip time (ms), null until the first pong (the badge; the no-`vt` fallback). */
  rtt: number | null;
  /** The pong samples behind it: their spike-resistant percentile sets the rewind cap. */
  readonly ping: RttEstimate;
  /** Pings sent and not yet echoed: only their echoes are samples (no forged/replayed pongs). */
  readonly pings: PingTracker;
  /** Shots the server fired for this player (diagnostics, tests). */
  shots: number;
  /**
   * In the fight: a friend-lobby player joins the running match while their client still builds
   * and warms up the game (seconds on integrated GPUs). Until they say `ready` (or send inputs,
   * or `MATCH_NET.readyTimeoutMs` passes) nobody can hit them, bots ignore them, and they are not
   * in the hunt-humans target set.
   */
  ready: boolean;
  /** The tick a player still loading is put in the fight anyway (safety timeout). */
  readyByTick: number;
  /** Practice reserves its intro destination while the entire simulation waits for readiness. */
  readySpawn: SpawnPoint | null;
  /**
   * The server tick this life's spawn protection runs out (the authoritative clock: inputs and
   * idle steps don't drive it). An attack ends it earlier (`state.spawnGuard` = 0).
   */
  guardEndsTick: number;
  /** This life's protection was ended by an attack (a shot, swing or throw): it stays off. */
  guardBroken: boolean;
}

/** Below this the player fell out of the world: respawn (never fall forever). */
const KILL_Y = -20;
const TICK_MS = 1000 / SIM.tickHz;
const SPAWN_CLEARANCE = 3;
const SPAWN_RESERVATION_TICKS = SIM.tickHz;

/** Map + generated spawns per (map, size): identical for every room, so built once. */
const mapCache = new Map<string, { map: MapDefinition; spawns: SpawnPoint[] | null }>();

function loadMap(cfg: Pick<MatchConfig, 'map' | 'size'>): {
  map: MapDefinition;
  spawns: SpawnPoint[] | null;
} {
  const key = `${cfg.map}/${cfg.size}`;
  let entry = mapCache.get(key);
  if (!entry) {
    const map = resolveMap(getMap(cfg.map), cfg.map === 'range' ? 'full' : cfg.size);
    entry = { map, spawns: map.spawns.length ? map.spawns : null };
    mapCache.set(key, entry);
  }
  return entry;
}

/**
 * Build every playable map's cached map entry and bot nav graph once, before the server takes
 * matches: a first build is 0.2-0.6 s of synchronous work that would otherwise stall every other
 * room's tick the first time a map is played. Needs `initPhysics()` to have resolved.
 */
export function prewarmMatchMaps(
  maps: readonly Pick<MatchConfig, 'map' | 'size'>[] = [
    { map: 'defilad', size: 'market' },
    { map: 'defilad', size: 'full' },
    { map: 'defilad', size: 'north' },
    { map: 'defilad', size: 'south' },
    { map: 'range', size: 'full' },
  ],
): void {
  for (const cfg of maps) {
    const { map } = loadMap(cfg);
    const physics = new PhysicsWorld(map);
    getNavGraph(map, physics); // the topology (the costly part) is cached per map
    getDriveGraph(map, physics, map.vehicles ?? []); // where bots drive the trucks, likewise
    physics.free();
  }
}

const wire = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
/** Blast damage is taken at the centre of mass (the client uses the same point for itself). */
const chest = (p: PlayerState): Vec3 => ({
  x: p.move.pos.x,
  y: p.move.pos.y + p.move.eyeHeight * 0.65,
  z: p.move.pos.z,
});
const droneTargetId = (owner: string, flight: number): string => `drone:${owner}:${flight}`;
const droneTarget = (id: string): { owner: string; flight: number } | null => {
  if (!id.startsWith('drone:')) return null;
  const tail = id.slice('drone:'.length);
  const split = tail.lastIndexOf(':');
  if (split <= 0) return null;
  const flight = Number(tail.slice(split + 1));
  return Number.isInteger(flight) ? { owner: tail.slice(0, split), flight } : null;
};
const droneHitShape = (pos: Vec3): HitShape => ({
  zone: 'torso',
  kind: 'sphere',
  a: { ...pos },
  b: { ...pos },
  r: DRONE.radius,
});
type CombatIntent =
  | {
      type: 'shot';
      by: string;
      slot: 'rifle' | 'sidearm';
      /** The gun that fired, before any swap later in this input or catch-up batch. */
      primary: PrimaryId;
      seq: number;
      shot: ShotFired;
      eye: Vec3;
      viewMs: number;
      /** Fired from a vehicle seat (its own hull and crew are not targets). */
      seat?: { vehicle: number; seat: SeatId };
    }
  | {
      type: 'melee';
      by: string;
      yaw: number;
      pitch: number;
      move: KnifeMove;
      eye: Vec3;
      viewMs: number;
      attacker: PlayerState;
      seat?: { vehicle: number; seat: SeatId };
    }
  | {
      type: 'jammer';
      by: string;
      at: Vec3;
    }
  | {
      type: 'grenade';
      kind: 'frag' | 'smoke';
      by: string;
      yaw: number;
      pitch: number;
      eye: Vec3;
      vel: Vec3;
      seed: number;
    };

/**
 * The authoritative match simulation, independent of Colyseus (unit-testable): the shared
 * physics world for the host's map, one character per player, input queues, the 60 Hz step,
 * combat (hitscan with lag compensation, knife, frags), deaths, respawns, the score and the
 * match clock, and the snapshot / roster / score views. Needs `initPhysics()` to have resolved.
 */
export class MatchSim {
  readonly physics: PhysicsWorld;
  readonly map: MapDefinition;
  /** The map's bushes and tall grass (sight: smart rounds, bot perception). */
  readonly foliage: FoliageIndex;
  readonly spawns: SpawnPoint[];
  readonly players = new Map<string, ServerPlayer>();
  readonly tactics: MatchTactics;
  readonly bots: MatchBots;
  /** The armored trucks (none with `vehicles: 'off'` or on a map without spawns). */
  readonly vehicles: MatchVehicles;
  /** Props trucks smash and knock over (they stay so until the next match). */
  readonly props: MatchProps;
  /** Vehicles as obstacles this substep (walkers are pushed out, drivers out of each other). */
  private readonly obstacleList: VehicleObstacle[] = [];
  private readonly env: StepEnv = { vehicles: this.obstacleList };
  /** Seat changes are spaced out per player (`VEHICLE.seatCooldown`): player → next tick. */
  private readonly seatCooldowns = new Map<string, number>();
  tick = 0;
  /** Told when a player was respawned (the room sends them a `RespawnMessage`). */
  onRespawn: ((p: ServerPlayer, msg: RespawnMessage) => void) | null = null;
  phase: MatchStateMessage['phase'] = 'playing';
  /**
   * The tick the current phase ends (match clock, or the next match after the results); null
   * while playing without a time limit.
   */
  phaseEnds: number | null;
  winners: string[] = [];
  /** Frags in flight (server-side: they hurt whoever is near when they go off). */
  readonly grenades: { g: GrenadeState; owner: string }[] = [];
  private nextGrenadeId = 1;
  /** Server time (ms) the smoke list's ages are as of: its last step (see `smokeAt`). */
  private smokeMs = 0;
  /** Combat events since the last `drainEvents` (the room broadcasts them). */
  private events: CombatEvent[] = [];
  /** Ground guns are match state; bots contribute on death but never collect them. */
  private readonly dropState = createWeaponDrops();
  private dropEvents: WeaponDropEvent<string>[] = [];
  private readonly dropCollectors: WeaponDropCollector<string>[] = [];
  /** A manual swap preserves the outgoing gun's ammo until the following tick. */
  private readonly swappedThisTick = new Set<string>();
  /** Score or phase changed since the last `takeMatchChange`. */
  private matchDirty = true;
  /**
   * The living players as of the start of the current substep: what everyone's steps bump into
   * (player collision), the same for every player whatever order they step in. Entries reused.
   */
  private readonly crowd: CrowdMember[] = [];
  /** `applied` per player at the start of the tick (who stepped this tick; reused). */
  private readonly appliedBefore = new Map<string, number>();
  /** Rewound drone poses for lag-compensated hitscan. */
  private readonly droneHistory = new Map<
    string,
    { ms: number; pos: Vec3; flight: number; alive: boolean }[]
  >();
  /** Monotonic flight identity per owner, so old rewind samples cannot kill a relaunched drone. */
  private readonly droneFlights = new Map<string, number>();
  private readonly spawnRandom: () => number;
  private recentSpawns: { id: string; pos: Vec3; untilTick: number }[] = [];
  private readonly multiplayerSpawns: SpawnPoint[];

  constructor(readonly config: MatchConfig) {
    this.spawnRandom = mulberry32(config.spawnSeed ?? 0);
    const entry = loadMap(config);
    this.map = entry.map;
    this.foliage = new FoliageIndex(entry.map.foliage ?? []);
    this.physics = new PhysicsWorld(entry.map);
    this.tactics = new MatchTactics(entry.map, config.radar ?? 'uplinks', this.physics, {
      jetpacks: config.jetpacks !== 'off',
    });
    this.vehicles = new MatchVehicles(
      entry.map,
      this.physics,
      (config.vehicles ?? 'on') === 'on',
      config.vehicleSpawns,
    );
    this.props = new MatchProps(
      this.physics,
      (e) => this.events.push(e),
      () => this.tick,
      () => this.vehicles.obstacles(this.obstacleList),
    );
    this.vehicles.props = this.props;
    this.env.props = this.props;
    this.bots = new MatchBots(this);
    // A prop that went, or settled, changes where bots can walk and drive.
    this.props.onChange = (box) => this.bots.propsChanged(box);
    this.props.onReset = () => this.bots.propsReset();
    // Generated spawns are deterministic: the same set the clients derive for this map/size.
    entry.spawns ??= spawnsFor(this.physics, getMap(config.map), entry.map, config.size);
    this.spawns = entry.spawns;
    if (!this.spawns.length) throw new Error(`map ${this.map.name}: no valid spawn points`);
    // A short authored set (the range has three) cannot spread a full room. Generate the
    // extra covered, capsule-clear positions against pristine geometry, before props move.
    this.multiplayerSpawns =
      this.spawns.length < MATCH_NET.maxPlayers
        ? [
            ...this.spawns,
            ...generateSpawns(this.physics, this.map.bounds, {
              count: MATCH_NET.maxPlayers * 4,
              foliage: this.map.foliage,
              avoid: [...(this.map.vehicles ?? []), ...(this.map.jetpacks ?? [])],
            }),
          ]
        : this.spawns;
    this.phaseEnds = this.playingEnds();
  }

  /** The tick a match starting now ends by the clock (null: no time limit). */
  private playingEnds(): number | null {
    const limit = this.config.timeLimit ?? MATCH.timeLimit;
    return limit === UNLIMITED ? null : this.tick + Math.round(limit * SIM.tickHz);
  }

  /** Kills that win (null: no score limit). */
  private killsToWin(): number | null {
    const limit = this.config.scoreLimit ?? MATCH.scoreLimit;
    return limit === UNLIMITED ? null : limit;
  }

  get full(): boolean {
    return this.players.size >= MATCH_NET.maxPlayers;
  }

  /** Server time now (ms): the timeline of snapshots, view times and the pose history. */
  get nowMs(): number {
    return this.tick * TICK_MS;
  }

  addPlayer(
    id: string,
    name: string,
    nowMs: number,
    bot = false,
    opts: { ready?: boolean; primary?: PrimaryId } = {},
  ): ServerPlayer {
    if (this.players.has(id)) return this.players.get(id)!;
    if (!bot && this.full) this.bots.removeOne();
    if (this.full) throw new Error('match is full');
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const spawn = this.spawnPoint(id);
    const seed = 101 + slot * 7919;
    const primary = opts.primary ?? 'ar7';
    const state = createPlayerState(spawn.pos, seed, this.config.mode, primary);
    state.view = { yaw: spawn.yaw, pitch: 0 };
    const player: ServerPlayer = {
      id,
      bot,
      name,
      slot,
      seed,
      primary,
      state,
      body: this.physics.createCharacter(spawn.pos),
      queue: [],
      lastSeq: -1,
      ack: -1,
      lastInput: null,
      credit: 0,
      idleDebt: 0,
      bucket: new TokenBucket(MATCH_NET.inputRateHz, MATCH_NET.inputBurst, nowMs),
      nameBucket: new TokenBucket(MATCH_NET.nameRatePerSec, MATCH_NET.nameBurst, nowMs),
      life: 0,
      connected: true,
      dropped: 0,
      applied: 0,
      skipped: 0,
      lastRespawn: null,
      kills: 0,
      deaths: 0,
      respawnTick: 0,
      history: new PoseHistory(),
      rtt: null,
      ping: new RttEstimate(),
      pings: new PingTracker(),
      shots: 0,
      ready: bot || (opts.ready ?? true),
      readyByTick: this.tick + Math.ceil(MATCH_NET.readyTimeoutMs / TICK_MS),
      readySpawn: null,
      guardEndsTick: 0,
      guardBroken: false,
    };
    this.protect(player);
    this.players.set(id, player);
    this.tactics.add(id);
    this.droneFlights.set(id, 0);
    this.droneHistory.set(id, []);
    this.recordPose(player);
    this.recordDronePose(player);
    this.matchDirty = true;
    if (!bot) this.bots.sync();
    return player;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.vehicles.unseat(p);
    this.vehicles.release(id);
    this.seatCooldowns.delete(id);
    p.body.free();
    this.players.delete(id);
    this.recentSpawns = this.recentSpawns.filter((s) => s.id !== id);
    this.bots.providers.delete(id);
    this.tactics.remove(id);
    this.tactics.clearSpottedTarget(id);
    this.droneFlights.delete(id);
    this.droneHistory.delete(id);
    this.matchDirty = true;
    if (!p.bot) this.bots.sync();
  }

  /**
   * A name change from the player (Menu › "Your name online"): sanitized, rate limited.
   * Returns true when the roster changed.
   */
  rename(id: string, raw: string, nowMs: number): boolean {
    const p = this.players.get(id);
    if (!p || !p.nameBucket.take(nowMs)) return false;
    const name = sanitizeName(raw, p.name);
    if (name === p.name) return false;
    p.name = name;
    return true;
  }

  /** The player's client finished loading: in the fight from now on. */
  markReady(id: string): void {
    const p = this.players.get(id);
    if (p) this.enterFight(p);
  }

  /**
   * Choose the playable spawn before welcome, after bots have joined. Only for a host that
   * freezes the whole simulation until ready: the intro must land here and it must stay safe.
   */
  prepareReadySpawn(id: string): void {
    const p = this.players.get(id);
    if (!p || p.ready) return;
    const spawn = this.spawnPoint(id);
    p.readySpawn = spawn;
    placeBodyAt(p.body, spawn.pos);
    p.state.move.pos = { ...spawn.pos };
    p.state.view = { yaw: spawn.yaw, pitch: 0 };
    this.recordPose(p);
  }

  /**
   * A loading player joins the fight: keep a frozen practice match's intro destination, or
   * choose again against opponents that may have moved. Grant a full life of protection now.
   * The ordinary respawn message also prevents prediction from interpolating across the move.
   */
  private enterFight(p: ServerPlayer): void {
    if (p.ready) return;
    p.ready = true;
    if (p.state.health > 0) this.respawn(p, p.readySpawn ?? undefined);
    p.readySpawn = null;
  }

  /** Players in the fight (hittable, visible to bots): everyone but those still loading. */
  fighting(): ServerPlayer[] {
    return [...this.players.values()].filter((p) => p.ready);
  }

  /**
   * The next `ping` for this player, stamped `nowMs` (the caller's clock, the one `receivePong`
   * is given too) and remembered until it is echoed. Null for an unknown player.
   */
  issuePing(id: string, nowMs: number): MatchPing | null {
    const p = this.players.get(id);
    if (!p) return null;
    p.pings.issue(nowMs);
    const pings: Record<string, number> = {};
    for (const q of this.players.values())
      if (q !== p && !q.bot) pings[q.id] = q.rtt === null ? -1 : Math.round(q.rtt);
    return { t: nowMs, rtt: p.rtt === null ? -1 : Math.round(p.rtt), pings };
  }

  /**
   * A `pong` from this player echoing stamp `t`, arriving at `nowMs`. It is a round-trip sample
   * only if it answers a ping the server sent this player and that is still outstanding, once
   * (`PingTracker`): forged, replayed and stale echoes change nothing. Returns whether it counted.
   */
  receivePong(id: string, t: number, nowMs: number): boolean {
    const p = this.players.get(id);
    const rtt = p?.pings.consume(t, nowMs) ?? null;
    if (rtt === null) return false;
    this.observeRtt(id, rtt);
    return true;
  }

  /**
   * A round-trip sample (ms) the server measured (`receivePong`; tests feed it directly):
   * smoothed, implausible ones ignored. Never called with a number a client chose.
   */
  observeRtt(id: string, sampleMs: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.ping.observe(sampleMs);
    p.rtt = p.ping.smoothed;
  }

  /**
   * Keep clear of every living player and this second's assigned spawns before scoring cover.
   * Loading players and earlier choices in the same tick count, regardless of team or readiness.
   */
  private spawnPoint(exclude: string): SpawnPoint {
    const others = [...this.players.values()]
      .filter((p) => p.id !== exclude && p.state.health > 0)
      .map((p) => eyePosition(p.state));
    this.recentSpawns = this.recentSpawns.filter((s) => s.untilTick > this.tick);
    const occupied = [
      ...others,
      ...this.recentSpawns.filter((s) => s.id !== exclude).map((s) => s.pos),
    ];
    const clear = (s: SpawnPoint): boolean =>
      occupied.every((p) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) >= SPAWN_CLEARANCE);
    // Preserve authored solo starts; use the spacious pool as soon as opponents join.
    const pool = others.length || this.players.size > 1 ? this.multiplayerSpawns : this.spawns;
    const candidates = spawnCandidates(pool, this.spawns, clear);
    const spawn = pickSpawn(candidates, others, this.physics, this.spawnRandom());
    this.recentSpawns.push({
      id: exclude,
      pos: spawn.pos,
      untilTick: this.tick + SPAWN_RESERVATION_TICKS,
    });
    return spawn;
  }

  /** A new life's spawn protection (`sim/spawnProtection.ts`), from this tick on. */
  private protect(p: ServerPlayer): void {
    const seconds = this.config.spawnProtection ?? SPAWN_PROTECTION.duration;
    grantSpawnProtection(p.state, seconds);
    p.guardEndsTick = this.tick + Math.round(seconds * SIM.tickHz);
    p.guardBroken = false;
  }

  /**
   * Spawn protection left, every tick after the player's inputs and before any hit resolves:
   * purely the server clock (exactly `SPAWN_PROTECTION.duration` after the spawn), unless an
   * attack ended it. The steps' own countdown (the client's prediction) is overwritten either
   * way, so a batch of inputs after a stall can neither shorten nor stretch the window.
   */
  private runSpawnClock(p: ServerPlayer): void {
    const left = (p.guardEndsTick - this.tick) / SIM.tickHz;
    p.state.spawnGuard = !p.guardBroken && left > 1e-9 ? left : 0;
  }

  /**
   * Queue already schema-validated inputs from one client: each is rate limited, sanitized, and
   * must be newer than the last accepted one. Returns how many were accepted.
   */
  receiveInputs(id: string, inputs: readonly QueuedInput[], nowMs: number): number {
    const p = this.players.get(id);
    if (!p) return 0;
    let accepted = 0;
    for (const raw of inputs) {
      if (!p.bucket.take(nowMs)) {
        p.dropped++;
        continue;
      }
      const input: QueuedInput = sanitizeInput(raw);
      if (input.seq <= p.lastSeq) continue; // stale or duplicate
      if (raw.vt !== undefined && Number.isFinite(raw.vt)) input.vt = raw.vt;
      p.lastSeq = input.seq;
      // Full: the oldest input goes (it is the most out of date), never the newest.
      if (p.queue.length >= MATCH_NET.maxQueuedInputs) {
        p.queue.shift();
        p.dropped++;
      }
      p.queue.push(input);
      accepted++;
    }
    // Acting means playing: nobody stays untouchable while moving or shooting.
    if (accepted) this.enterFight(p);
    return accepted;
  }

  /**
   * One authoritative tick (`elapsedMs` of real time, 1/60 s nominally): apply queued inputs
   * within each player's movement-time budget (resolving the shots, strikes and throws they
   * make), idle stalled players, fly the frags, respawn the dead and the fallen, record where
   * everyone is (for rewinding), and run the match clock.
   */
  step(elapsedMs = TICK_MS): void {
    this.bots.enqueue();
    this.tick++;
    const earned = Math.max(0, elapsedMs) / TICK_MS;
    const intents: CombatIntent[] = [];
    const runOvers: VehicleDamage[] = [];
    this.appliedBefore.clear();
    this.swappedThisTick.clear();
    for (const p of this.players.values()) {
      if (!p.ready && this.tick >= p.readyByTick) this.enterFight(p);
      p.credit = Math.min(MATCH_NET.stallTicks, p.credit + earned);
      this.skipLateInputs(p);
      this.appliedBefore.set(p.id, p.applied);
    }
    // Queued inputs run in synchronized substeps: everyone with an input due steps once, then the
    // crowd (player collision) is refreshed before the next round. A player catching up on a
    // batch of late inputs therefore meets the others where they are now, never stepping eight
    // times against their old positions (which let two walkers pass right through each other).
    for (let round = 0; round < MATCH_NET.maxStepsPerTick; round++) {
      this.fillCrowd();
      this.vehicles.obstacles(this.obstacleList);
      let any = false;
      for (const p of this.players.values()) {
        if (!p.queue.length || p.credit < 1) continue;
        const input = p.queue.shift()!;
        if (this.phase === 'playing') this.tactics.input(p, input);
        const prev = p.state.prevButtons;
        // A driver's step drives the truck: the seat holds the vehicle's own motion object.
        this.vehicles.bindDriver(p);
        if (p.state.drone?.alive || input.buttons & Button.Drone)
          this.env.droneWorld = this.droneWorldNow();
        else delete this.env.droneWorld;
        // Continue the same shared prediction during results; collectIntents suppresses combat.
        const events = stepPlayerInCrowd(
          p.state,
          input,
          SIM_DT,
          p.body,
          this.crowd,
          p.id,
          this.env,
        );
        this.vehicles.afterDriverStep(p, this.tick);
        if (this.phase === 'playing' && p.ready && !p.bot)
          observeDropOwners(this.dropState, [{ id: p.id, player: p.state }]);
        // This step's attacks were made from where the player sat (or stood) during it: a seat
        // change below (Fire + Interact in one input) must not move them to the exit spot.
        const firedFrom = {
          seat: p.state.seat ? { vehicle: p.state.seat.vehicle, seat: p.state.seat.seat } : null,
          eye: eyePosition(p.state),
        };
        const drove = p.state.seat?.seat === 'driver' ? p.state.seat.vehicle : null;
        // Run-overs land after every player's step this tick (like shots): a victim later in
        // the order still makes its same-tick attack.
        if (drove !== null && this.phase === 'playing')
          runOvers.push(...this.vehicles.runOversOf(drove, this.players, this.tick));
        // Getting in / out / switching seats: the server's call, from the same button edges.
        const canUseSeat = p.state.drone?.alive !== true;
        const interact = canUseSeat && pressed(input.buttons, prev, Button.Interact);
        const hadSeat = p.state.seat !== null;
        const seated = this.vehicles.seatInput(
          p,
          interact,
          canUseSeat && pressed(input.buttons, prev, Button.SwitchSeat),
          this.tick,
          this.seatCooldowns,
        );
        // Getting in is acting: this life's spawn protection ends for good (no shielded driver).
        if (seated && p.state.seat) p.guardBroken = true;
        p.ack = input.seq;
        p.lastInput = input;
        p.credit--;
        p.applied++;
        any = true;
        // An attack ends this life's protection for good (the countdown alone never does).
        if (events.some(endsSpawnProtection)) p.guardBroken = true;
        this.noteDroneEvents(p, events);
        this.collectIntents(p, events, input.vt, intents, firedFrom);
        if (interact && this.phase === 'playing' && p.ready && !p.bot) {
          const swaps = swapWithDrop(
            this.dropState,
            { id: p.id, player: p.state, groundY: this.dropGround(p.state.move.pos) },
            hadSeat || seated || this.vehicles.hasSeatInRange(p),
          );
          if (swaps.some((e) => e.type === 'swap')) this.swappedThisTick.add(p.id);
          this.dropEvents.push(...swaps);
        }
      }
      if (!any) break;
    }
    for (const d of runOvers) {
      const target = this.players.get(d.target);
      if (target) this.damage(target, d.by, d.amount, d.weapon, 'torso', d.at, d.from);
    }
    this.fillCrowd();
    for (const p of this.players.values()) {
      const steps = p.applied - (this.appliedBefore.get(p.id) ?? p.applied);
      // Inputs stopped (menu open, tab hidden, connection lost) and the budget is full: gravity
      // and deceleration still apply, so nobody hangs in mid-air. Unacknowledged.
      while (steps === 0 && p.credit >= MATCH_NET.stallTicks - 1e-9) {
        this.idleStep(p);
        if (this.phase === 'playing' && p.ready && !p.bot)
          observeDropOwners(this.dropState, [{ id: p.id, player: p.state }]);
        p.credit--;
        p.idleDebt = Math.min(MATCH_NET.maxQueuedInputs, p.idleDebt + 1);
      }
      this.runSpawnClock(p);
      if (p.state.move.pos.y < KILL_Y) this.respawn(p);
    }
    // Driverless trucks roll to a stop, occupants ride along, run-overs hurt.
    for (const d of this.vehicles.step(this.players, this.tick, this.phase === 'playing')) {
      const target = this.players.get(d.target);
      if (target) this.damage(target, d.by, d.amount, d.weapon, 'torso', d.at, d.from);
    }
    // Knocked props tumble on (and settle).
    this.props.step();
    this.resolveIntents(intents);
    this.stepGrenades();
    this.blowUpVehicles();
    this.stepWeaponDrops();
    if (this.phase === 'playing') {
      this.tactics.step(this.players.values());
      this.spotDrones();
      this.smokeMs = this.nowMs;
    }
    this.finishCombatBatch();
    for (const p of this.players.values()) {
      if (p.respawnTick > 0 && this.tick >= p.respawnTick) this.respawn(p);
      this.recordPose(p);
      this.recordDronePose(p);
    }
    this.vehicles.record(this.nowMs);
    if (this.phaseEnds !== null && this.tick >= this.phaseEnds) {
      if (this.phase === 'playing') this.endMatch();
      else this.startMatch();
    }
  }

  /** Snapshot the living players into `crowd` (reusing its entries). */
  private fillCrowd(): void {
    let n = 0;
    for (const p of this.players.values()) {
      // The dead and the seated (they ride in a vehicle) bump into nobody.
      if (p.state.health <= 0 || p.state.seat) continue;
      const entry = (this.crowd[n] ??= { id: '', x: 0, y: 0, z: 0, height: 0 });
      crowdMemberOf(p.id, p.state.move, entry);
      n++;
    }
    this.crowd.length = n;
  }

  /** What one step of a player's hands did: shots, knife strikes and frag throws. */
  private collectIntents(
    p: ServerPlayer,
    events: readonly PlayerEvent[],
    vt: number | undefined,
    out: CombatIntent[],
    /** Where the step's attacks came from (taken before any seat change in the same input). */
    firedFrom?: { seat: { vehicle: number; seat: SeatId } | null; eye: Vec3 },
  ): void {
    if (this.phase !== 'playing') return;
    // The rewind cap is per player: its round trip as the server measured it (spike-resistant).
    const viewMs = shotViewTime(this.nowMs, vt, p.ping.forRewind ?? p.rtt);
    const sat = firedFrom ? firedFrom.seat : p.state.seat;
    const seat = sat ? { vehicle: sat.vehicle, seat: sat.seat } : undefined;
    // A passenger shoots from where its client drew it: the seat of the truck as it was at the
    // view time (the client draws the truck it rides in on the same timeline as everyone else).
    const eye =
      (sat && sat.seat !== 'driver'
        ? this.vehicles.seatEyeAt(sat.vehicle, sat.seat, viewMs)
        : null) ??
      firedFrom?.eye ??
      eyePosition(p.state);
    for (const e of events) {
      if (e.type === 'shot') {
        const slot = p.state.arsenal.slot;
        if (!isGun(slot)) continue;
        p.shots++;
        out.push({
          type: 'shot',
          by: p.id,
          slot,
          primary: p.state.arsenal.primary,
          seq: p.ack,
          shot: e.shot,
          eye: wire(eye),
          viewMs,
          ...(seat ? { seat } : {}),
        });
      } else if (e.type === 'melee') {
        out.push({
          type: 'melee',
          by: p.id,
          yaw: e.yaw,
          pitch: e.pitch,
          move: e.move,
          eye: wire(eye),
          viewMs,
          attacker: clonePlayerState(p.state),
          ...(seat ? { seat } : {}),
        });
      } else if (e.type === 'jammer') {
        out.push({ type: 'jammer', by: p.id, at: wire(p.state.move.pos) });
      } else if (e.type === 'grenadeThrow') {
        out.push({
          type: 'grenade',
          kind: e.kind,
          by: p.id,
          yaw: e.yaw,
          pitch: e.pitch,
          eye: wire(eye),
          vel: wire(p.state.move.vel),
          seed: p.seed,
        });
      }
    }
  }

  private resolveIntents(intents: readonly CombatIntent[]): void {
    if (this.phase !== 'playing') return;
    for (const i of intents) {
      if (i.type === 'shot') this.fire(i);
      else if (i.type === 'melee') this.strike(i);
      else if (i.type === 'jammer') this.jam(i);
      else this.throwGrenade(i);
    }
  }

  /**
   * Everyone but `shooter` as they were at server time `viewMs` (lag compensation): the bodies
   * the shooter saw. Dead players, and anyone respawned since, can't be hit.
   */
  targetsAt(
    viewMs: number,
    shooter: string,
    /** The truck the attack was made from (null: on foot); defaults to the shooter's seat now. */
    crew: number | null | undefined = this.players.get(shooter)?.state.seat?.vehicle,
  ): HitTarget<string>[] {
    const out: HitTarget<string>[] = [];
    // Riding together is a truce: nobody hits their own vehicle's crew.
    for (const q of this.players.values()) {
      if (q.id === shooter || !q.ready) continue;
      if (sameCrew(crew, q.state.seat?.vehicle)) continue;
      const shapes = rewoundShapes(q.history, viewMs, {
        life: q.life,
        alive: q.state.health > 0,
      });
      if (shapes) out.push({ id: q.id, shapes });
    }
    return out;
  }

  /**
   * Everyone the shooter could *see* at their view time — alive in that pose, whether or not
   * they have died since or are still spawn-protected (not `ready`). Smart rounds bend toward
   * this set, the same bodies the shooter's client drew; damage still only lands on
   * `targetsAt` (the eligible ones).
   */
  private sightTargetsAt(
    viewMs: number,
    shooter: string,
    crew: number | null | undefined = this.players.get(shooter)?.state.seat?.vehicle,
  ): HitTarget<string>[] {
    const out: HitTarget<string>[] = [];
    // The crew of the truck it was fired from is out of it, as the shooter's client leaves them
    // out (a round never bends into a crewmate it can't hurt).
    for (const q of this.players.values()) {
      if (q.id === shooter || sameCrew(crew, q.state.seat?.vehicle)) continue;
      const pose = q.history.at(viewMs);
      if (pose?.alive)
        out.push({ id: q.id, shapes: humanoidHitboxes(pose.feet, pose.eye, pose.yaw ?? 0) });
    }
    return out;
  }

  /**
   * The smoke clouds as they were at server time `viewMs` (what the shooter saw). The live list
   * is stepped after combat, so its ages are as of the last tactics step (`smokeMs`), the same
   * time the snapshot carrying it is stamped with (the client's side of `smokeAt`). Clouds that
   * ran out within the rewind window are kept for this, as the client keeps them.
   */
  smokeAt(viewMs: number): SmokeCloud[] {
    return smokeAt(this.tactics.smokeHistory(), this.smokeMs, viewMs);
  }

  private dronePoseAt(owner: string, ms: number): { pos: Vec3; flight: number } | null {
    const h = this.droneHistory.get(owner);
    const player = this.players.get(owner);
    if (!h?.length || player?.state.drone?.alive !== true) return null;
    const liveFlight = this.droneFlights.get(owner) ?? 0;
    const first = h[0]!;
    if (ms <= first.ms) return first.alive && first.flight === liveFlight ? first : null;
    for (let i = 1; i < h.length; i++) {
      const b = h[i]!;
      if (ms > b.ms) continue;
      const a = h[i - 1]!;
      if (!a.alive || !b.alive || a.flight !== b.flight || a.flight !== liveFlight) {
        const near = ms - a.ms < b.ms - ms ? a : b;
        return near.alive && near.flight === liveFlight
          ? { pos: { ...near.pos }, flight: near.flight }
          : null;
      }
      const k = (ms - a.ms) / Math.max(1e-6, b.ms - a.ms);
      const lerp = (x: number, y: number): number => x + (y - x) * k;
      return {
        pos: {
          x: lerp(a.pos.x, b.pos.x),
          y: lerp(a.pos.y, b.pos.y),
          z: lerp(a.pos.z, b.pos.z),
        },
        flight: a.flight,
      };
    }
    const last = h.at(-1)!;
    return last.alive && last.flight === liveFlight
      ? { pos: { ...last.pos }, flight: last.flight }
      : null;
  }

  private droneTargetsAt(viewMs: number, shooter: string): HitTarget<string>[] {
    const out: HitTarget<string>[] = [];
    for (const p of this.players.values()) {
      if (p.id === shooter || p.state.drone?.alive !== true) continue;
      const pose = this.dronePoseAt(p.id, viewMs);
      if (!pose) continue;
      out.push({ id: droneTargetId(p.id, pose.flight), shapes: [droneHitShape(pose.pos)] });
    }
    return out;
  }

  private downDrone(owner: string, flight: number): boolean {
    const p = this.players.get(owner);
    if (!p?.state.drone?.alive || (this.droneFlights.get(owner) ?? 0) !== flight) return false;
    p.state.drone.alive = false;
    p.state.drone = null;
    return true;
  }

  private spotDrones(): void {
    if (this.tick % 6 !== 0) return;
    const world = withHulls(this.physics, this.vehicles.hullsNow());
    for (const pilot of this.players.values()) {
      const drone = pilot.state.drone;
      if (!drone?.alive || pilot.state.health <= 0 || !pilot.ready) continue;
      const targets = this.fighting()
        .filter((p) => p.id !== pilot.id && p.state.health > 0)
        .map((p) => ({ id: p.id, pos: chest(p.state) }));
      const ids = droneSpots(drone, targets, world, this.tactics.smoke, this.foliage);
      if (ids.length) {
        const byId = new Map(targets.map((t) => [t.id, t.pos]));
        this.tactics.markSpotted(
          pilot.id,
          ids.map((id) => ({ id, pos: byId.get(id)! })),
        );
      }
    }
  }

  private jam(i: Extract<CombatIntent, { type: 'jammer' }>): void {
    const by = this.players.get(i.by);
    if (!by) return;
    const liveDrones = [...this.players.values()]
      .map((p) => p.state.drone)
      .filter((d): d is NonNullable<typeof d> => d?.alive === true);
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      pos: p.state.move.pos,
      owner: p.seed,
    }));
    const { downed, jammed } = jammerPulse(i.at, by.seed, liveDrones, players);
    for (const d of downed) {
      const owner = [...this.players.values()].find((p) => p.state.drone === d);
      if (owner) owner.state.drone = null;
    }
    for (const id of jammed) this.tactics.jam(id);
    this.events.push({ type: 'jammer', by: i.by, at: wire(i.at) });
  }

  private snapshotDrones(): Pick<SnapshotMessage, 'drones'> {
    const drones = [...this.players.values()]
      .filter((p) => p.state.drone?.alive === true)
      .map((p) => toSnapshotDrone(p.id, p.state.drone!));
    return drones.length ? { drones } : {};
  }

  /** A bullet the shooter's own weapon state fired (fire rate and ammo are the shared sim's). */
  private fire(i: Extract<CombatIntent, { type: 'shot' }>): void {
    const shooter = this.players.get(i.by);
    if (!shooter) return;
    const cfg = gunConfig({ primary: i.primary }, i.slot);
    // The crew of the seat it was fired from (it may have got out in the same input).
    const crew = i.seat?.vehicle ?? null;
    const droneTargets = this.droneTargetsAt(i.viewMs, i.by);
    const targets = [...this.targetsAt(i.viewMs, i.by, crew), ...droneTargets];
    const sight = cfg.homingConeDeg > 0 ? this.sightTargetsAt(i.viewMs, i.by, crew) : targets;
    // Concealment at the view time too: a cloud that popped after it doesn't hide anyone.
    const concealment = { smoke: this.smokeAt(i.viewMs), foliage: this.foliage };
    // Vehicles as the shooter saw them: armour stops rounds like a wall (and takes the damage).
    const world: WorldRaycaster = withHulls(this.physics, this.vehicles.hullsAt(i.viewMs));
    // Out of the front passenger's window arc the round meets the cab itself.
    if (
      i.seat &&
      !inFireArc(i.seat.seat, i.shot.yaw, this.vehicles.yawAt(i.seat.vehicle, i.viewMs))
    ) {
      this.events.push({
        type: 'shot',
        by: i.by,
        slot: i.slot,
        from: wire(i.eye),
        to: wire(i.eye),
      });
      return;
    }
    const armour =
      i.slot === 'rifle' && i.primary === 'arc' ? VEHICLE.arcDamage : VEHICLE.bulletDamage;
    const vehicleHits = new Map<number, { dmg: number; point: Vec3 }>();
    // Every pellet (1 for most guns) from the shot's seed: the client traces the same fan. A
    // target's pellets add up into one hit (best zone), so a shotgun blast is one damage event.
    const hits = new Map<string, { dmg: number; zone: HitZone; point: Vec3 }>();
    const zoneRank = { head: 2, torso: 1, legs: 0 } as const;
    pelletDirections(i.shot, cfg.pellets, cfg.pelletSpreadDeg).forEach((d, k) => {
      // Smart rounds bend toward what the shooter saw (the client bends toward the same bodies).
      const dir = bendShot(
        i.eye,
        d,
        cfg.maxRange,
        world,
        sight,
        cfg.homingConeDeg,
        cfg.homingMaxBendDeg,
        concealment,
      );
      const r = traceShot(i.eye, dir, cfg.maxRange, world, targets, true);
      if (k === 0)
        this.events.push({
          type: 'shot',
          by: i.by,
          slot: i.slot,
          from: wire(i.eye),
          to: wire(r.kind === 'miss' ? r.end : r.point),
          ...(cfg.silent ? { silent: true } : {}),
        });
      if (r.kind === 'world' && 'vehicle' in r && typeof r.vehicle === 'number') {
        const vid = r.vehicle;
        const v = this.vehicles.get(vid);
        // Your own truck (the cab frame), and wrecks, take nothing.
        if (!v || v.condition !== 'active' || vid === i.seat?.vehicle) return;
        const dmg = computeDamage('torso', r.distance, cfg) * armour;
        const h = vehicleHits.get(vid);
        if (h) h.dmg += dmg;
        else vehicleHits.set(vid, { dmg, point: r.point });
        return;
      }
      if (r.kind !== 'target') return;
      const droneHit = droneTarget(r.targetId);
      if (droneHit) {
        this.downDrone(droneHit.owner, droneHit.flight);
        return;
      }
      // Through the cab glass a round keeps only part of its punch: in the cab as the shooter
      // saw them (rewound with the hit volumes), not as they sit now.
      const inCab = this.players.get(r.targetId)?.history.at(i.viewMs)?.cab === true;
      const glass = inCab ? VEHICLE.glassDamage : 1;
      const dmg = computeDamage(r.zone, r.distance, cfg) * glass;
      const h = hits.get(r.targetId);
      if (!h) hits.set(r.targetId, { dmg, zone: r.zone, point: r.point });
      else {
        h.dmg += dmg;
        if (zoneRank[r.zone] > zoneRank[h.zone]) h.zone = r.zone;
      }
    });
    for (const [id, h] of hits) {
      const target = this.players.get(id);
      if (target)
        this.damage(target, i.by, h.dmg, i.slot, h.zone, h.point, i.eye, undefined, i.seq);
    }
    for (const [vid, h] of vehicleHits) {
      const v = this.vehicles.get(vid);
      if (v) this.damageVehicle(v, i.by, h.dmg, i.slot, h.point, i.seq);
    }
  }

  /** Damage to a vehicle from `by` (armour already applied), reported to everyone. */
  private damageVehicle(
    v: ServerVehicle,
    by: string,
    amount: number,
    weapon: CombatWeapon,
    at: Vec3,
    seq?: number,
  ): void {
    if (this.phase !== 'playing' || v.condition !== 'active') return;
    const dmg = Math.round(amount * 10) / 10;
    const dealt = this.vehicles.damage(v, by, dmg, this.tick);
    if (dealt <= 0) return;
    this.events.push({
      type: 'vhit',
      by,
      vehicle: v.id,
      weapon,
      dmg: dealt,
      hp: v.health,
      at: wire(at),
      ...(seq === undefined ? {} : { seq }),
    });
  }

  /**
   * Trucks destroyed this tick blow up: the crew takes `VEHICLE.occupantBlast`, everyone in the
   * open nearby a falling-off blast (walls block it), other trucks a share — all credited to
   * whoever destroyed it. The wreck stays a while, then the truck is back at its spawn.
   */
  private blowUpVehicles(): void {
    for (const { v, by } of this.vehicles.takeBooms()) {
      const m = v.motion;
      const centre = { x: m.pos.x, y: m.pos.y + 1.2, z: m.pos.z };
      this.events.push({ type: 'vboom', vehicle: v.id, by, pos: wire(centre) });
      if (this.phase !== 'playing') {
        for (const q of this.players.values())
          if (q.state.seat?.vehicle === v.id) this.vehicles.unseat(q);
        continue;
      }
      for (const q of this.players.values()) {
        if (q.state.health <= 0 || !q.ready) continue;
        const at = chest(q.state);
        if (q.state.seat?.vehicle === v.id) {
          this.damage(q, by, VEHICLE.occupantBlast, 'wreck', 'torso', at, centre);
          continue;
        }
        const d = Math.hypot(at.x - centre.x, at.y - centre.y, at.z - centre.z);
        if (d > VEHICLE.explosionRadius) continue;
        const len = Math.max(d, 1e-6);
        const dir = {
          x: (at.x - centre.x) / len,
          y: (at.y - centre.y) / len,
          z: (at.z - centre.z) / len,
        };
        const hit = this.physics.castRay(centre, dir, len);
        if (hit && hit.distance < len - 0.05) continue;
        const dmg = Math.round(VEHICLE.explosionDamage * (1 - d / VEHICLE.explosionRadius));
        if (dmg > 0) this.damage(q, by, dmg, 'wreck', 'torso', at, centre);
      }
      // Nobody rides a wreck (the crew is dead; a survivor would be thrown clear).
      for (const q of this.players.values())
        if (q.state.seat?.vehicle === v.id) this.vehicles.unseat(q);
      for (const w of this.vehicles.list) {
        if (w === v || w.condition !== 'active') continue;
        const cp = this.vehicles.closestPoint(w, centre);
        const d = Math.hypot(cp.x - centre.x, cp.y - centre.y, cp.z - centre.z);
        if (d > VEHICLE.explosionRadius) continue;
        // Static cover shields a truck as it shields a player.
        if (d > 0.05) {
          const dir = {
            x: (cp.x - centre.x) / d,
            y: (cp.y - centre.y) / d,
            z: (cp.z - centre.z) / d,
          };
          const hit = this.physics.castRay(centre, dir, d);
          if (hit && hit.distance < d - 0.05) continue;
        }
        const dmg =
          VEHICLE.explosionDamage * (1 - d / VEHICLE.explosionRadius) * VEHICLE.fragDamage;
        this.damageVehicle(w, by, dmg, 'wreck', cp);
      }
    }
  }

  /** A knife strike connects this step: the same fan of rays as the client, rewound targets. */
  private strike(i: Extract<CombatIntent, { type: 'melee' }>): void {
    const r = resolveMelee(
      i.eye,
      i.yaw,
      i.pitch,
      withHulls(this.physics, this.vehicles.hullsAt(i.viewMs)),
      this.targetsAt(i.viewMs, i.by, i.seat?.vehicle ?? null),
      i.move,
    );
    if (r.kind !== 'target' || this.phase !== 'playing') return;
    const target = this.players.get(r.targetId);
    if (!target || target.state.health <= 0) return;
    const attacker = this.players.get(i.by);
    if (!attacker) return;
    // A protected target's guard never meets the blade: no parry, no guard wear, no damage.
    if (isSpawnProtected(target.state)) {
      this.damage(target, i.by, 0, 'knife', r.zone, r.point, i.eye);
      return;
    }
    // Guard is current, but the incoming strike's pose and counter bonus belong to its release.
    // Apply parry side effects to the live attacker without rolling back later movement/inputs.
    const before = wire(i.attacker.move.vel);
    const res = applyKnifeStrike(i.attacker, target.state, i.move);
    if (res.outcome === 'parried') {
      attacker.state.arsenal.stun = Math.max(attacker.state.arsenal.stun, i.attacker.arsenal.stun);
      attacker.state.arsenal.melee.combo = 0;
      attacker.state.move.vel.x += i.attacker.move.vel.x - before.x;
      attacker.state.move.vel.z += i.attacker.move.vel.z - before.z;
    }
    this.damage(target, i.by, res.damage, 'knife', r.zone, r.point, i.eye, res.outcome);
  }

  private throwGrenade(i: Extract<CombatIntent, { type: 'grenade' }>): void {
    const g = spawnGrenade(
      this.nextGrenadeId++,
      i.seed,
      i.eye,
      i.yaw,
      i.pitch,
      i.vel,
      // Released against the trucks too: a bed gunner's frag can't start inside the cab.
      withHulls(this.physics, this.vehicles.hullsNow()),
      i.kind,
    );
    this.grenades.push({ g, owner: i.by });
    this.events.push({
      type: 'nade',
      id: g.id,
      by: i.by,
      pos: wire(g.pos),
      vel: wire(g.vel),
      fuse: g.fuse,
      kind: g.kind,
    });
  }

  /** Frags fly and go off: blast damage to everyone in the open around them (cover blocks). */
  private stepGrenades(): void {
    if (!this.grenades.length) return;
    // In flight they bounce off the trucks' armour (chassis, doors, bed walls) like any wall,
    // never through it into the cab.
    const flight = withHulls(this.physics, this.vehicles.hullsNow());
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const { g, owner } = this.grenades[i]!;
      if (!stepGrenade(g, SIM_DT, flight).exploded) continue;
      this.grenades.splice(i, 1);
      this.events.push({ type: 'boom', id: g.id, by: owner, pos: wire(g.pos), kind: g.kind });
      if (this.phase !== 'playing') continue;
      if (g.kind === 'smoke') {
        this.tactics.popSmoke(g, this.physics);
        continue;
      }
      // Trucks are cover from a blast; the crew's own truck is shielded by its cab instead (the
      // bed is open), while every other truck's armour still covers them.
      const hulls = this.vehicles.hullsNow();
      const covered = withHulls(this.physics, hulls);
      for (const q of this.players.values()) {
        if (q.state.health <= 0 || !q.ready) continue;
        const at = chest(q.state);
        const seat = q.state.seat;
        const dmg = seat
          ? explosionDamage(
              g.pos,
              at,
              withHulls(
                this.physics,
                hulls.filter((h) => h.id !== seat.vehicle),
              ),
            ) * (SEAT_SPEC[seat.seat].cab ? VEHICLE.cabBlastDamage : 1)
          : explosionDamage(g.pos, at, covered);
        if (dmg > 0) this.damage(q, owner, Math.round(dmg * 10) / 10, 'frag', 'torso', at, g.pos);
      }
      for (const v of this.vehicles.list) {
        if (v.condition !== 'active') continue;
        const cp = this.vehicles.closestPoint(v, g.pos);
        const dmg = explosionDamage(g.pos, cp, this.physics) * VEHICLE.fragDamage;
        if (dmg > 0) this.damageVehicle(v, owner, dmg, 'frag', cp);
      }
    }
  }

  /** Apply damage from `by` (a player id, maybe gone by now) and report it to everyone. */
  private damage(
    target: ServerPlayer,
    by: string,
    amount: number,
    weapon: CombatWeapon,
    zone: HitZone,
    at: Vec3,
    from: Vec3,
    outcome?: 'hit' | 'blocked' | 'guardBroken' | 'parried',
    seq?: number,
  ): void {
    if (target.state.health <= 0 || this.phase !== 'playing') return;
    // Spawn protection blocks everything (bullets, knife, frags, one's own frag), judged now:
    // lag compensation rewinds where the target was, not whether it was protected. Protection
    // only ever runs down, so a target protected now was protected at any earlier view time
    // of this life (earlier lives are never hit: `targetsAt` checks the life). One whose
    // protection ended since the view time (it fired) takes the hit.
    if (isSpawnProtected(target.state)) {
      this.events.push({
        type: 'hit',
        by,
        target: target.id,
        weapon,
        zone,
        dmg: 0,
        hp: target.state.health,
        killed: false,
        at: wire(at),
        from: wire(from),
        ...(seq === undefined ? {} : { seq }),
        outcome: 'protected',
      });
      return;
    }
    const killed = applyDamage(target.state, amount);
    this.events.push({
      type: 'hit',
      by,
      target: target.id,
      weapon,
      zone,
      dmg: amount,
      hp: target.state.health,
      killed,
      at: wire(at),
      from: wire(from),
      ...(seq === undefined ? {} : { seq }),
      ...(outcome ? { outcome } : {}),
    });
    if (killed) this.kill(target, by);
  }

  private kill(victim: ServerPlayer, by: string): void {
    clearDropOwner(this.dropState.drops, victim.id);
    this.dropEvents.push(
      ...spawnDeathDrop(this.dropState, victim.state, this.dropGround(victim.state.move.pos)),
    );
    // The dead leave their seat (the body stays where it sat).
    this.vehicles.unseat(victim);
    victim.state.drone = null;
    this.tactics.clearSpottedTarget(victim.id);
    victim.deaths++;
    victim.respawnTick = this.tick + Math.max(1, Math.round(MATCH.respawnDelay * SIM.tickHz));
    const killer = by !== victim.id ? this.players.get(by) : undefined;
    if (killer) killer.kills++;
    this.matchDirty = true;
  }

  private finishCombatBatch(): void {
    if (this.phase !== 'playing') return;
    const win = this.killsToWin();
    if (win !== null && this.scores().some((s) => s.kills >= win)) this.endMatch();
  }

  /**
   * Score limit reached, the clock ran out, or the host ended it (`end`): results for
   * `MATCH.intermission` seconds. Returns false if the results were already showing.
   */
  endMatch(): boolean {
    if (this.phase === 'ended') return false;
    this.phase = 'ended';
    this.phaseEnds = this.tick + Math.round(MATCH.intermission * SIM.tickHz);
    this.winners = matchWinners(this.scores());
    this.grenades.length = 0;
    // Smoke goes too: tactics stop stepping in the results (see `MatchTactics.clearSmoke`).
    this.tactics.clearSmoke();
    for (const p of this.players.values()) p.state.drone = null;
    this.matchDirty = true;
    return true;
  }

  /** The next match: scores reset, frags cleared, everyone respawns fresh. */
  private startMatch(): void {
    this.phase = 'playing';
    this.phaseEnds = this.playingEnds();
    this.winners = [];
    this.grenades.length = 0;
    this.tactics.reset();
    for (const d of this.dropState.drops) this.dropEvents.push({ type: 'despawn', dropId: d.id });
    this.dropState.drops.length = 0;
    this.vehicles.reset();
    this.props.reset();
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      this.respawn(p);
    }
    this.matchDirty = true;
  }

  /**
   * Inputs that arrive after the server idled for them (a network stall longer than the budget)
   * would otherwise sit in the queue for good: from then on it drains exactly as fast as the
   * client fills it. The ones the budget can't cover, up to the idle steps already run in their
   * place, are skipped oldest first and acknowledged, so the queue (and the lag everyone sees)
   * shrinks back at once. The client's reconcile treats a skipped input like any misprediction.
   * Inputs that fit the budget (jitter, a resume after a pause) are never skipped.
   */
  private skipLateInputs(p: ServerPlayer): void {
    const backlog = p.queue.length - Math.floor(p.credit + 1e-9);
    const n = Math.min(p.idleDebt, backlog);
    if (n <= 0) return;
    const last = p.queue.splice(0, n).at(-1)!;
    p.ack = last.seq;
    p.lastInput = last;
    // Button edges continue from the acknowledged input, exactly as the client's replay does
    // (a Jump held through the skipped inputs is not pressed again).
    p.state.prevButtons = last.buttons;
    p.idleDebt -= n;
    p.skipped += n;
  }

  /**
   * Movement-only step with no intent (crouch kept). Weapons and kit stay frozen, exactly like
   * the paused client, so the only thing a later snapshot corrects is where the body went.
   */
  private idleStep(p: ServerPlayer): void {
    if (p.state.drone?.alive) {
      this.env.droneWorld = this.droneWorldNow();
      const seat = p.state.seat;
      if (seat?.seat === 'driver') this.vehicles.bindDriver(p);
      const scratch = clonePlayerState(p.state);
      stepPlayerInCrowd(
        scratch,
        {
          seq: p.ack,
          moveX: 0,
          moveZ: 0,
          yaw: p.state.drone.yaw,
          pitch: p.state.drone.pitch,
          buttons: 0,
        },
        SIM_DT,
        p.body,
        this.crowd,
        p.id,
        this.env,
      );
      if (scratch.seat?.motion && seat?.motion) Object.assign(seat.motion, scratch.seat.motion);
      p.state.move = scratch.move;
      p.state.drone = scratch.drone;
      return;
    }
    delete this.env.droneWorld;
    const seat = p.state.seat;
    if (seat) {
      // Seated and silent: a driver's truck brakes to a stop (handbrake), as the paused client
      // holds it; a passenger just rides (the vehicle step places them).
      if (seat.seat !== 'driver') return;
      this.vehicles.bindDriver(p);
      const scratch = clonePlayerState(p.state);
      stepPlayerInCrowd(
        scratch,
        {
          seq: p.ack,
          moveX: 0,
          moveZ: 0,
          yaw: p.state.view.yaw,
          pitch: p.state.view.pitch,
          buttons: Button.Jump,
        },
        SIM_DT,
        p.body,
        this.crowd,
        p.id,
        this.env,
      );
      if (scratch.seat?.motion && seat.motion) Object.assign(seat.motion, scratch.seat.motion);
      p.state.move = scratch.move;
      return;
    }
    const scratch = clonePlayerState(p.state);
    // Still bumpable: an idle player standing in a doorway gets pushed aside like anyone.
    stepPlayerInCrowd(
      scratch,
      {
        seq: p.ack,
        moveX: 0,
        moveZ: 0,
        yaw: p.state.view.yaw,
        pitch: p.state.view.pitch,
        buttons: (p.lastInput?.buttons ?? 0) & Button.Crouch,
      },
      SIM_DT,
      p.body,
      this.crowd,
      p.id,
      this.env,
    );
    p.state.move = scratch.move;
  }

  /** A player picked another primary: it arrives with their next life (validated upstream). */
  setLoadout(id: string, primary: PrimaryId): void {
    const p = this.players.get(id);
    if (p) p.primary = primary;
  }

  private respawn(p: ServerPlayer, spawn = this.spawnPoint(p.id)): void {
    clearDropOwner(this.dropState.drops, p.id);
    this.vehicles.unseat(p);
    this.vehicles.release(p.id);
    placeBodyAt(p.body, spawn.pos);
    // Bots choose this life's primary now, by the same `setLoadout` path a human's message takes.
    this.bots.beforeRespawn(p);
    p.state = createPlayerState(spawn.pos, p.seed, this.config.mode, p.primary);
    p.state.view = { yaw: spawn.yaw, pitch: 0 };
    this.protect(p);
    p.state.drone = null;
    this.bumpDroneFlight(p.id);
    this.tactics.respawned(p.id);
    this.tactics.clearSpottedTarget(p.id);
    this.tactics.add(p.id);
    this.bots.reset(p.id);
    p.respawnTick = 0;
    p.life++;
    p.lastRespawn = {
      life: p.life,
      seq: p.ack,
      primary: p.primary,
      x: spawn.pos.x,
      y: spawn.pos.y,
      z: spawn.pos.z,
      yaw: spawn.yaw,
    };
    this.onRespawn?.(p, p.lastRespawn);
    this.recordPose(p);
    this.recordDronePose(p);
  }

  private recordPose(p: ServerPlayer): void {
    p.history.record({
      ms: this.nowMs,
      feet: p.state.move.pos,
      eye: p.state.move.eyeHeight,
      yaw: p.state.view.yaw,
      life: p.life,
      alive: p.state.health > 0,
      ...(p.state.seat && SEAT_SPEC[p.state.seat.seat].cab ? { cab: true } : {}),
    });
  }

  private bumpDroneFlight(id: string): number {
    const next = (this.droneFlights.get(id) ?? 0) + 1;
    this.droneFlights.set(id, next);
    return next;
  }

  private droneWorldNow(): WorldRaycaster {
    const movement = {
      castRay: (origin: Vec3, dir: Vec3, maxDistance: number) =>
        this.physics.castGroundRay(origin, dir, maxDistance),
    };
    return withHulls(movement, this.vehicles.hullsNow());
  }

  private noteDroneEvents(p: ServerPlayer, events: readonly PlayerEvent[]): void {
    if (events.some((e) => e.type === 'droneLaunched')) this.bumpDroneFlight(p.id);
  }

  private recordDronePose(p: ServerPlayer): void {
    const h = this.droneHistory.get(p.id);
    if (!h) return;
    const drone = p.state.drone;
    const sample = {
      ms: this.nowMs,
      pos: drone?.alive ? { ...drone.pos } : { x: 0, y: 0, z: 0 },
      flight: this.droneFlights.get(p.id) ?? 0,
      alive: drone?.alive === true,
    };
    const last = h.at(-1);
    if (last && sample.ms <= last.ms) h.pop();
    h.push(sample);
    if (h.length > MATCH_NET.historyTicks) h.shift();
  }

  /**
   * Run `ticks` fixed ticks (from the room's `SnapshotPacer`, or `FixedTicker.advance` in tests,
   * so server time tracks real time however coarse the timer). Returns whether a snapshot tick
   * was crossed (the room's pacer decides when snapshots actually leave).
   */
  runTicks(ticks: number): boolean {
    let due = false;
    for (let i = 0; i < ticks; i++) {
      this.step();
      if (this.tick % MATCH_NET.snapshotEvery === 0) due = true;
    }
    return due;
  }

  /**
   * The snapshot for one recipient (`forId`: its own entry carries its weapon and kit state), or
   * the shared view without one.
   */
  snapshot(forId?: string): SnapshotMessage {
    const props = this.props.snapshot();
    return {
      t: this.tick,
      players: [...this.players.values()].map((p) =>
        toSnapshotPlayer(p.id, p.state, p.ack, p.life, { own: p.id === forId }),
      ),
      drops: this.drops.map((d) => ({ ...d, pos: { ...d.pos } })),
      ...(forId ? { tactical: this.tactics.snapshot(forId) } : {}),
      ...this.snapshotDrones(),
      ...(this.vehicles.list.length ? { vehicles: this.vehicles.snapshot() } : {}),
      ...(props ? { props } : {}),
    };
  }

  /** Combat events since the last call (in order), for the room to broadcast. */
  drainEvents(): CombatEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get drops(): readonly WeaponDropState[] {
    return this.dropState.drops;
  }

  /** The existing floor under the feet, including upper floors and elevated deaths. */
  private dropGround(pos: Vec3): number {
    return (
      this.physics.castGroundRay(
        { x: pos.x, y: pos.y + 0.25, z: pos.z },
        { x: 0, y: -1, z: 0 },
        2048,
      )?.point.y ?? pos.y
    );
  }

  private stepWeaponDrops(): void {
    let n = 0;
    if (this.phase === 'playing') {
      for (const p of this.players.values()) {
        if (p.bot || !p.ready) continue;
        const collector = (this.dropCollectors[n] ??= { id: p.id, player: p.state });
        collector.id = p.id;
        collector.player = p.state;
        collector.skipAuto = this.swappedThisTick.has(p.id);
        n++;
      }
    }
    this.dropCollectors.length = n;
    this.dropEvents.push(...stepDrops(this.dropState, this.dropCollectors, SIM_DT));
  }

  /** Dev/autotest entry; transport callers gate access, this boundary still validates geometry. */
  spawnWeaponDrop(primaryId: PrimaryId, x: number, z: number, ammoFraction: number): boolean {
    const b = this.map.bounds;
    if (
      this.phase !== 'playing' ||
      !PRIMARY_IDS.includes(primaryId) ||
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(ammoFraction) ||
      ammoFraction < 0 ||
      ammoFraction > 1 ||
      x < b.minX ||
      x > b.maxX ||
      z < b.minZ ||
      z > b.maxZ
    )
      return false;
    const pos = { x, y: 512, z };
    const ground = this.dropGround(pos);
    const events = spawnDrop(
      this.dropState,
      primaryId,
      pos,
      ammoFraction,
      ground,
      this.config.mode,
    );
    this.dropEvents.push(...events);
    return events.some((e) => e.type === 'spawn');
  }

  drainDrops(): WeaponDropEvent<string>[] {
    const events = this.dropEvents;
    this.dropEvents = [];
    return events;
  }

  scores(): { id: string; kills: number; deaths: number }[] {
    return [...this.players.values()].map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths }));
  }

  matchState(): MatchStateMessage {
    return {
      phase: this.phase,
      endsAt: this.phaseEnds,
      scoreLimit: this.config.scoreLimit ?? MATCH.scoreLimit,
      scores: this.scores(),
      winners: this.winners,
    };
  }

  /** The match state if the score, the players or the phase changed since the last call. */
  takeMatchChange(): MatchStateMessage | null {
    if (!this.matchDirty) return null;
    this.matchDirty = false;
    return this.matchState();
  }

  roster(): RosterMessage {
    return {
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        slot: p.slot,
        connected: p.connected,
        ...(p.bot ? { bot: true } : {}),
        ...(p.bot && this.bots.personalities.has(p.id)
          ? { persona: this.bots.personalities.get(p.id) }
          : {}),
      })),
    };
  }

  static readonly tickHz = SIM.tickHz;

  dispose(): void {
    for (const p of this.players.values()) p.body.free();
    this.players.clear();
    this.physics.free();
  }
}
