import {
  Button,
  createPlayerState,
  grantSpawnProtection,
  eyePosition,
  FoliageIndex,
  getMap,
  gunConfig,
  heldGun,
  humanoidHitboxes,
  initPhysics,
  isGun,
  PhysicsWorld,
  PLAYER,
  resolveMap,
  placeBodyAt,
  sanitizeInput,
  SIM,
  SIM_DT,
  snapshotProtected,
  stepPlayerInCrowd,
  traceGunShot,
  withHulls,
  inFireArc,
  seatFromWire,
  SEATS,
  VEHICLE,
  type BotPersonalityId,
  type DriveGraph,
  type SeatId,
  type CombatMessage,
  type HitTarget,
  type MapDefinition,
  type MapId,
  type MapSize,
  type MatchMode,
  type MatchPing,
  type MatchStateMessage,
  type PlayerInput,
  type PlayerState,
  type PrimaryId,
  type RapierCharacter,
  type RespawnMessage,
  type RosterMessage,
  type ShotFired,
  type SnapshotMessage,
  type Vec3,
  type WelcomeMessage,
} from '@wd/shared';
import { hullsOf, seatEyeOf } from '../../../client/src/net/vehicleTrack.ts';
import { getDriveGraph } from '../bots/driveCache.ts';
import type { BotVehicleView } from '../bots/types.ts';
// The browser client's own session logic (prediction, reconciliation, interpolation, view time).
// DOM-free (only `@wd/shared` and its interpolation module); tsconfig references the client.
import { OnlineSession, type RemotePlayer } from '../../../client/src/net/onlineSession.ts';
import {
  BehaviorTreeDecisionProvider,
  buildBotObservation,
  getNavGraph,
  type NavGraph,
  type PublicPlayerLike,
} from '../bots/index.ts';
import {
  noteOutcome,
  shotVerdict,
  sortedIds,
  splitStruck,
  type ShotOutcomes,
  type ShotSets,
} from './shotVerdict.ts';
import { Reservoir } from './stats.ts';

/** One map's world for a run (nav, drive graph); each client keeps its own copy for its props. */
export interface SoakWorld {
  map: MapDefinition;
  physics: PhysicsWorld;
  foliage: FoliageIndex;
  nav: NavGraph;
  /** Where the map's trucks drive (null: none), for the clients' own bot brains. */
  drive: DriveGraph | null;
}

/** Build the world a client of `map`/`size` plays on (the same one the server builds). */
export async function soakWorld(map: MapId, size: MapSize): Promise<SoakWorld> {
  await initPhysics();
  const def = resolveMap(getMap(map), map === 'range' ? 'full' : size);
  const physics = new PhysicsWorld(def);
  return {
    map: def,
    physics,
    foliage: new FoliageIndex(def.foliage ?? []),
    nav: getNavGraph(def, physics),
    drive: getDriveGraph(def, physics, def.vehicles ?? []),
  };
}

/** The script's intent for a shot: at the centre of the body as drawn, or deliberately beside it. */
export type ShotIntent = 'aim' | 'miss';

/**
 * How a shot ended, as its shooter and then the server saw it: `ShotSets` (whom the shooter's
 * trace struck, whom the server damaged / blocked on) and what the script meant by it.
 */
export interface ShotRecord extends ShotSets {
  seq: number;
  localMs: number;
  intent: ShotIntent;
  /** Who the script aimed at (or beside). */
  target: string;
  /** Horizontal speed of that target as drawn (m/s) and its distance (m). */
  speed: number;
  distance: number;
  /**
   * The interpolation delay the shooter drew with (ms): 100 on a clean link; the jitter buffer
   * raises it (≤ 250) after late snapshots, and the rewind the shot needs grows with it.
   */
  delayMs: number;
  /** Why the shot is left out of the fairness figures (a death race, the match phase), if so. */
  excluded: string | null;
}

/** A client's figures as plain data (what a client worker posts back; see `SoakClient.stats`). */
export interface ClientStats {
  name: string;
  judged: ShotRecord[];
  corrections: number;
  correctionErrors: number[];
  stateCorrections: number;
  deathCorrections: number;
  contactCorrections: number;
  contactErrors: number[];
  /** Getting in / out / switching seats (the server's call: always a correction). */
  seatCorrections: number;
  /** Corrections that moved this client while it drove a truck, nobody near: mispredictions. */
  driverCorrections: number;
  driverErrors: number[];
  /** Steps spent at the wheel / in a passenger seat. */
  drivingSteps: number;
  ridingSteps: number;
  respawns: number;
  snapshots: number;
  snapIntervals: number[];
  interpDelays: number[];
  frameCost: number[];
  errors: string[];
  kills: number;
  deaths: number;
  /** Jetpack: flights lit, seconds flown, mispredictions while flying, pickups granted. */
  flights?: number;
  flySeconds?: number;
  flyCorrections?: number;
  jetGrants?: number;
}

export interface SoakClientOptions {
  name: string;
  /** Seeds the behaviour tree and the script. */
  seed: number;
  /** Every Nth shot is a deliberate miss (0: none). */
  missEvery?: number;
  /** How far beside the torso axis a deliberate miss is aimed (m; the torso radius is 0.24). */
  missOffset?: number;
  /** Seconds between trigger taps while a target is in sight. */
  tapSeconds?: number;
  /**
   * How its behaviour tree plays (`BOT.personalities`): rushers and flankers take the trucks,
   * so the harness drives and rides them. Absent: the plain tree (on foot).
   */
  personality?: BotPersonalityId;
  /** Plays as a rusher: goes for the nearest jetpack and flies it (the soak's flyer). */
  flyer?: boolean;
}

export interface SoakLink {
  send(type: 'input' | 'pong' | 'ready', message: unknown): void;
}

/** A shot is judged this long after it was fired (confirms come one round trip later). */
const JUDGE_AFTER_MS = 1500;
/** A death of the shooter or the target this close to a shot makes it a race, not a verdict. */
const DEATH_RACE_BEFORE_MS = 300;
const DEATH_RACE_AFTER_MS = 500;
/** Shots this close to a phase change (match end, fresh match) are left out. */
const PHASE_MARGIN_MS = 1500;
/** Another player this close (feet to feet, m) counts as contact for a correction's cause… */
const CONTACT_RANGE = 1.2;
/** …and for this long after (ms): the correction arrives a round trip after the push. */
const CONTACT_MEMORY_MS = 600;
/** Which seat a state is in (null on foot), as one comparable key. */
const seatKey = (p: PlayerState): string | null =>
  p.seat ? `${p.seat.vehicle}:${p.seat.seat}` : null;

/** Buttons the script never presses: it measures gunfire (knife, frags, smoke, kit are out). */
const STRIPPED =
  Button.Fire |
  Button.Ads |
  Button.Melee |
  Button.Grenade |
  Button.Smoke |
  Button.Slot3 |
  Button.NextWeapon |
  Button.PrevWeapon |
  Button.Block |
  Button.Radar |
  Button.Drone |
  Button.Jammer;

/**
 * A headless player: the browser client's online loop (`OnlineSession` prediction +
 * reconciliation + interpolation, the same `stepPlayer` and view-time reporting as `Game`) with
 * a scripted player at the controls. The server's behaviour tree drives movement (seek, strafe,
 * cover, reload) from what *this client* sees — remote players interpolated at its view time —
 * and the script aims and fires: dead centre on the nearest visible body as drawn, or beside it
 * (`missEvery`), in ADS taps. Each shot is traced locally exactly like the game's predicted hit
 * marker (`traceGunShot` against the bodies as drawn) and then matched with the server's `hit`
 * confirm (same input seq), so fairness is measured in the shooter's own terms.
 *
 * Transport-agnostic: `receive` takes the server's messages, `link.send` carries inputs, pongs
 * and `ready`. Real sockets (`soak.ts`) and the virtual-clock test (`virtualMatch.ts`) both
 * drive it.
 */
export class SoakClient {
  readonly session = new OnlineSession();
  /** This client's static world (the run's map; its props as this client last heard). */
  readonly physics: PhysicsWorld;
  state: PlayerState | null = null;
  private body: RapierCharacter | null = null;
  private readonly provider: BehaviorTreeDecisionProvider;
  private readonly missEvery: number;
  private readonly missOffset: number;
  private readonly tapMs: number;
  private seq = 0;
  private lastFrameMs: number | null = null;
  private accMs = 0;
  private welcomeMs = -1;
  private nextTapMs = 0;
  private shotCount = 0;
  private pendingShot: { intent: ShotIntent; target: string } | null = null;
  private readonly shots = new Map<number, PendingShot>();
  private readonly deaths = new Map<string, number[]>();
  private lastPhase: MatchStateMessage['phase'] | null = null;
  private phaseChangeMs = Number.NEGATIVE_INFINITY;
  private readonly speeds = new Map<
    string,
    { vt: number; x: number; z: number; life: number; speed: number }
  >();

  /** Shots judged so far (kept for the report). */
  readonly judged: ShotRecord[] = [];
  /**
   * Reconciliation corrections that moved a living player (a misprediction: the size, m); those
   * that only changed server-owned state (damage taken, a kit count; the body stayed put); deaths
   * (the body stops where the server killed it); respawns.
   */
  corrections = 0;
  readonly correctionErrors = new Reservoir(20_000);
  stateCorrections = 0;
  deathCorrections = 0;
  /** Corrections while touching another player (soft-push collision), and their size (m). */
  contactCorrections = 0;
  readonly contactErrors = new Reservoir(20_000);
  private lastContactMs = Number.NEGATIVE_INFINITY;
  seatCorrections = 0;
  driverCorrections = 0;
  readonly driverErrors = new Reservoir(20_000);
  drivingSteps = 0;
  ridingSteps = 0;
  respawns = 0;
  flights = 0;
  flySteps = 0;
  flyCorrections = 0;
  jetGrants = 0;
  /** Snapshot arrivals: count, intervals (ms), the interpolation delay in use (ms). */
  snapshots = 0;
  private lastSnapMs: number | null = null;
  readonly snapIntervals = new Reservoir();
  readonly interpDelays = new Reservoir();
  /** Socket errors, unexpected leaves, exceptions (each fails the run). */
  errors: string[] = [];
  frames = 0;
  /** CPU time of each frame (ms): the harness must stay far below a frame to be faithful. */
  readonly frameCost = new Reservoir();
  steps = 0;

  constructor(
    readonly world: SoakWorld,
    private readonly link: SoakLink,
    readonly opts: SoakClientOptions,
  ) {
    this.provider = new BehaviorTreeDecisionProvider({
      id: opts.name,
      seed: opts.seed,
      difficulty: 'hard',
      behavior: 'ffa',
      ...(opts.personality
        ? { personality: opts.personality }
        : opts.flyer
          ? { personality: 'rusher' as const }
          : {}),
    });
    this.missEvery = opts.missEvery ?? 4;
    this.missOffset = opts.missOffset ?? 0.7;
    this.tapMs = (opts.tapSeconds ?? 0.3) * 1000;
    this.session.attach({ sendInputs: (m) => this.link.send('input', m) });
    // Its own world, as a browser has: props a truck breaks change it when this client hears.
    this.physics = new PhysicsWorld(world.map);
    this.session.props.physics = this.physics;
  }

  get id(): string | null {
    return this.session.id;
  }

  /** A server message (`type` as sent by `MatchRoom`) arriving at local time `localMs`. */
  receive(type: string, msg: unknown, localMs: number): void {
    const s = this.session;
    switch (type) {
      case 'welcome':
        this.onWelcome(msg as WelcomeMessage, localMs);
        return;
      case 'snap':
        this.snapshots++;
        if (this.lastSnapMs !== null) this.snapIntervals.push(localMs - this.lastSnapMs);
        this.lastSnapMs = localMs;
        s.handleSnapshot(msg as SnapshotMessage, localMs);
        return;
      case 'roster':
        s.handleRoster(msg as RosterMessage);
        return;
      case 'match': {
        const m = msg as MatchStateMessage;
        if (this.lastPhase !== null && m.phase !== this.lastPhase) this.phaseChangeMs = localMs;
        this.lastPhase = m.phase;
        s.handleMatch(m);
        return;
      }
      case 'combat':
        s.handleCombat(msg as CombatMessage);
        return;
      case 'respawn':
        s.handleRespawn(msg as RespawnMessage);
        return;
      case 'ping': {
        const p = msg as MatchPing;
        s.handlePing(p);
        this.link.send('pong', { t: p.t });
        return;
      }
      default:
        return; // lobby traffic and anything newer: not this client's business
    }
  }

  private onWelcome(w: WelcomeMessage, localMs: number): void {
    const spawn = { x: w.spawn.x, y: w.spawn.y, z: w.spawn.z };
    // As `Game.onWelcome`: the body at the spawn, a fresh state, this life spawn-protected.
    this.body ??= this.physics.createCharacter(spawn);
    placeBodyAt(this.body, spawn);
    this.state = createPlayerState(spawn, w.seed, w.mode, w.primary);
    grantSpawnProtection(this.state); // as the server's new life (its snapshot corrects)
    this.state.view = { yaw: w.spawn.yaw, pitch: 0 };
    this.welcomeMs = localMs;
    this.session.handleWelcome(w);
    // Friend lobbies keep a player out of the fight until its game is built: headless is ready.
    this.link.send('ready', {});
  }

  /** The socket dropped / came back (the SDK reconnects into the same seat). */
  setConnected(connected: boolean): void {
    this.session.handleStatus(connected ? { state: 'online' } : { state: 'reconnecting' });
  }

  /** One rendered frame at local time `localMs`: reconcile, step the due 60 Hz steps, send. */
  frame(localMs: number): void {
    const s = this.session;
    const dtMs = this.lastFrameMs === null ? 0 : Math.min(250, localMs - this.lastFrameMs);
    this.lastFrameMs = localMs;
    if (!this.state || !this.body || s.status.state !== 'online') return;
    this.frames++;
    const cpu0 = performance.now();
    const vt = s.viewTime(localMs);
    this.interpDelays.push(s.jitter.delayMs(localMs));
    const life = s.currentLife;
    const before = { ...this.state.move.pos };
    const hpBefore = this.state.health;
    const seatBefore = seatKey(this.state);
    const jetBefore = this.state.move.jet;
    const r = s.reconcile(this.state, this.body, SIM_DT);
    if (r?.corrected) {
      this.state = r.state;
      if (jetBefore === 0 && r.state.move.jet !== 0) this.jetGrants++;
      const p = r.state.move.pos;
      const moved = Math.hypot(p.x - before.x, p.y - before.y, p.z - before.z);
      const seat = r.state.seat;
      if (s.currentLife !== life) this.respawns++;
      // Killed: the body froze where the server's bullet found it (the steps predicted since
      // are rolled back). Not a misprediction.
      else if (r.state.health <= 0 && hpBefore > 0) this.deathCorrections++;
      // In, out or another seat: decided by the server, learnt from the snapshot.
      else if (seatKey(r.state) !== seatBefore) this.seatCorrections++;
      // A passenger's feet follow a truck this client only draws: not predicted, not an error.
      else if (moved < 1e-3 || (seat !== null && seat.seat !== 'driver')) this.stateCorrections++;
      else if (localMs - this.lastContactMs < CONTACT_MEMORY_MS) {
        // Touching (or just was) another player: the push is resolved against positions one
        // snapshot apart on the two sides, so small corrections are expected there.
        this.contactCorrections++;
        this.contactErrors.push(moved);
      } else {
        this.corrections++;
        this.correctionErrors.push(moved);
        if (seat?.seat === 'driver') {
          this.driverCorrections++;
          this.driverErrors.push(moved);
        }
        if (jetBefore >= 2 || r.state.move.jet >= 2) this.flyCorrections++;
      }
    }
    this.takeCombat(localMs);
    const remotes = s.remotePlayers(localMs);
    this.trackSpeeds(remotes, vt);
    this.accMs += dtMs;
    let steps = 0;
    const stepMs = SIM_DT * 1000;
    while (this.accMs >= stepMs && steps < SIM.maxStepsPerFrame) {
      this.step(remotes, vt, localMs);
      this.accMs -= stepMs;
      steps++;
    }
    if (steps === SIM.maxStepsPerFrame) this.accMs = 0;
    s.flush();
    this.judge(localMs);
    this.frameCost.push(performance.now() - cpu0);
  }

  private takeCombat(localMs: number): void {
    const me = this.id;
    for (const e of this.session.takeCombat()) {
      if (e.type !== 'hit') continue;
      if (e.killed) {
        const list = this.deaths.get(e.target) ?? [];
        list.push(localMs);
        if (list.length > 64) list.shift();
        this.deaths.set(e.target, list);
      }
      if (e.by !== me || e.seq === undefined) continue;
      const pending = this.shots.get(e.seq);
      if (!pending) continue;
      // Spawn-protected target: the server blocked it (no damage). Neither a hit nor a miss.
      // A fan (shotgun) can do both at once, and to several bodies: every target is kept, and
      // the shot is judged from all of them (`shotVerdict`), never by arrival order.
      noteOutcome(pending, e.target, e.outcome);
    }
  }

  /** Horizontal speed of each remote player along the drawn timeline (m/s, smoothed). */
  private trackSpeeds(remotes: readonly RemotePlayer[], vt: number | undefined): void {
    if (vt === undefined) return;
    for (const r of remotes) {
      const prev = this.speeds.get(r.id);
      const at = { vt, x: r.pose.x, z: r.pose.z, life: r.pose.life };
      // A respawn teleports: start over (speed 0), never a 30 m "step".
      if (!prev || prev.life !== r.pose.life || vt - prev.vt > 250 || prev.vt >= vt) {
        this.speeds.set(r.id, { ...at, speed: prev?.life === r.pose.life ? prev.speed : 0 });
        continue;
      }
      const dt = (vt - prev.vt) / 1000;
      if (dt < 0.03) continue; // keep sampling over ≥ 30 ms (one snapshot interval)
      const v = Math.hypot(r.pose.x - prev.x, r.pose.z - prev.z) / dt;
      this.speeds.set(r.id, { ...at, speed: prev.speed * 0.5 + v * 0.5 });
    }
  }

  private step(remotes: readonly RemotePlayer[], vt: number | undefined, localMs: number): void {
    const state = this.state!;
    const input = sanitizeInput(this.decide(state, remotes, vt, localMs));
    // As `Game.simStep`: the step and its player-collision pass against the others at their
    // newest snapshots (`OnlineSession.crowd`, which the reconcile replays use too).
    const crowd = this.session.crowd();
    const events = stepPlayerInCrowd(
      state,
      input,
      SIM_DT,
      this.body!,
      crowd,
      this.id ?? 'local',
      this.session.vehicleEnv(),
    );
    this.session.followSeat(state, localMs);
    this.steps++;
    if (state.seat?.seat === 'driver') this.drivingSteps++;
    else if (state.seat) this.ridingSteps++;
    if (state.move.jet >= 2) this.flySteps++;
    if (events.some((e) => e.type === 'jetIgnite')) this.flights++;
    const me = state.move.pos;
    for (const q of crowd) {
      if (Math.hypot(q.x - me.x, q.z - me.z) < CONTACT_RANGE && Math.abs(q.y - me.y) < 2.5) {
        this.lastContactMs = localMs;
        break;
      }
    }
    // A truck against us (we walk into one, or ours meets another truck or a walker): the two
    // sides resolve it against positions one snapshot apart, like the soft push.
    if (this.vehicleContact(state)) this.lastContactMs = localMs;
    for (const e of events)
      if (e.type === 'shot') this.onShot(e.shot, input.seq, remotes, vt, localMs);
    this.session.recordStep(input, state, vt);
  }

  /** The behaviour tree's movement from this client's view, with the script's aim and trigger. */
  private decide(
    state: PlayerState,
    remotes: readonly RemotePlayer[],
    vt: number | undefined,
    localMs: number,
  ): PlayerInput {
    const seq = this.seq++;
    const me = this.id ?? this.opts.name;
    const self: PublicPlayerLike = { id: me, name: this.opts.name, slot: 0, isBot: false, state };
    const others = remotes
      .filter((r) => r.pose.hp > 0)
      .map((r): PublicPlayerLike => ({
        id: r.id,
        name: r.name,
        slot: r.slot,
        isBot: false,
        state: remoteState(r, state.arsenal.primary, this.session.welcome?.mode ?? 'standard'),
      }));
    const vehicles = this.vehicleViews(remotes, localMs);
    const obs = buildBotObservation({
      map: this.world.map,
      physics: this.physics,
      // The trucks as drawn block sight like walls (as the server's bots).
      sight:
        vt === undefined
          ? this.physics
          : withHulls(this.physics, hullsOf(this.session.vehiclesAt(vt))),
      self,
      players: [self, ...others],
      smoke: this.session.smokeAt(vt),
      foliage: this.world.foliage,
      nowMs: localMs,
      seq,
      nav: this.world.nav,
      mode: this.session.welcome?.mode ?? 'standard',
      vehicles,
      drive: vehicles.length ? this.world.drive : null,
      // Only the flyer goes for jetpacks (the others keep measuring gunfire as before).
      ...(this.opts.flyer && this.session.tactical?.jetpacks
        ? { jetpacks: this.session.tactical.jetpacks }
        : {}),
    });
    const tree = this.provider.decide(obs, SIM_DT);
    const input: PlayerInput = { ...tree, seq, buttons: tree.buttons & ~STRIPPED };
    // At the wheel the hands steer: no aim script (the shots are measured on foot and in seats).
    if (state.health <= 0 || state.seat?.seat === 'driver') return input;

    // The target: the nearest body in sight, where this client draws it (prone ones are skipped:
    // their volumes lie along the ground, beside the point the script would aim at).
    const eye = eyePosition(state);
    let best: RemotePlayer | null = null;
    let bestD = Infinity;
    for (const v of obs.visiblePlayers) {
      const r = remotes.find((q) => q.id === v.id);
      if (!r || r.pose.eye < PLAYER.proneHitboxEye) continue;
      // Like a player, the script does not fire at someone shimmering (spawn-protected): that
      // would only spend its own protection. Shots at targets whose shimmer is not drawn yet
      // still happen, and are counted as blocked.
      if (snapshotProtected(r.pose)) continue;
      const d = Math.hypot(r.pose.x - eye.x, r.pose.z - eye.z);
      if (d < bestD && d > 2) {
        best = r;
        bestD = d;
      }
    }
    if (!best || !isGun(state.arsenal.slot)) return input;

    const shootMiss = this.missEvery > 0 && this.shotCount % this.missEvery === this.missEvery - 1;
    // Aim from where the eye will be after this step (the shot leaves from there).
    const from = {
      x: eye.x + state.move.vel.x * SIM_DT,
      y: eye.y + state.move.vel.y * SIM_DT,
      z: eye.z + state.move.vel.z * SIM_DT,
    };
    const aimAt = torsoCentre(best);
    if (shootMiss) {
      const dx = aimAt.x - from.x;
      const dz = aimAt.z - from.z;
      const len = Math.hypot(dx, dz) || 1;
      const side = this.shotCount % (2 * this.missEvery) < this.missEvery ? 1 : -1;
      aimAt.x += (-dz / len) * this.missOffset * side;
      aimAt.z += (dx / len) * this.missOffset * side;
    }
    const dx = aimAt.x - from.x;
    const dy = aimAt.y - from.y;
    const dz = aimAt.z - from.z;
    input.yaw = Math.atan2(-dx, -dz);
    input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    input.buttons = (input.buttons & ~Button.Sprint) | Button.Ads;
    const gun = heldGun(state);
    const ready =
      gun !== null &&
      gun.adsAmount >= 0.85 &&
      gun.ammo > 0 &&
      gun.reloadTimer <= 0 &&
      localMs >= this.nextTapMs;
    if (ready) {
      input.buttons |= Button.Fire;
      this.pendingShot = { intent: shootMiss ? 'miss' : 'aim', target: best.id };
      this.nextTapMs = localMs + this.tapMs;
    }
    return input;
  }

  private onShot(
    shot: ShotFired,
    seq: number,
    remotes: readonly RemotePlayer[],
    vt: number | undefined,
    localMs: number,
  ): void {
    const state = this.state!;
    const intent = this.pendingShot;
    this.pendingShot = null;
    if (!intent) return; // a shot the script did not ask for (never expected)
    this.shotCount++;
    const slot = state.arsenal.slot;
    if (!isGun(slot)) return;
    const cfg = gunConfig(state.arsenal, slot);
    // The game's predicted hit marker: the bodies as drawn this frame (alive), the smoke at vt.
    // Riding together is a truce: the crew of our own truck is no target (the server agrees).
    const crew = state.seat?.vehicle;
    const targets: HitTarget<string>[] = remotes
      .filter(
        (r) => r.pose.hp > 0 && (crew === undefined || seatFromWire(r.pose.vh)?.vehicle !== crew),
      )
      .map((r) => ({
        id: r.id,
        shapes: humanoidHitboxes({ x: r.pose.x, y: r.pose.y, z: r.pose.z }, r.pose.eye, r.pose.yaw),
      }));
    // A passenger shoots from the seat of the truck as drawn at vt (where the server rewinds it).
    const drawn = vt === undefined ? [] : this.session.vehiclesAt(vt);
    const eye = (state.seat && seatEyeOf(drawn, state.seat)) || eyePosition(state);
    const ride = state.seat ? drawn.find((v) => v.id === state.seat!.vehicle) : undefined;
    if (state.seat && ride && !inFireArc(state.seat.seat, shot.yaw, ride.motion.yaw)) {
      // Out of the window arc: the round meets the cab (the server does the same). No marker.
      this.pendingShot = null;
      return;
    }
    const world = withHulls(this.physics, hullsOf(drawn));
    const results = traceGunShot(eye, shot, cfg, world, targets, {
      smoke: this.session.smokeAt(vt),
      foliage: this.world.foliage,
    });
    // As `Game.fireShot`: a body drawn spawn-protected (its shimmer) shows the blocked marker,
    // anyone else hit shows the hit marker. A fan can strike several of each: all are kept.
    const drawnProtected = new Set(
      remotes.filter((r) => snapshotProtected(r.pose)).map((r) => r.id),
    );
    const struck = results.flatMap((r) => (r.kind === 'target' ? [r.targetId] : []));
    const t = remotes.find((r) => r.id === intent.target);
    this.shots.set(seq, {
      shot: {
        seq,
        localMs,
        intent: intent.intent,
        target: intent.target,
        speed: this.speeds.get(intent.target)?.speed ?? 0,
        distance: t ? Math.hypot(t.pose.x - eye.x, t.pose.z - eye.z) : 0,
        delayMs: this.session.jitter.delayMs(localMs),
        ...splitStruck(struck, drawnProtected),
        damaged: [],
        blocked: [],
        excluded: null,
      },
      damaged: new Set(),
      blocked: new Set(),
    });
  }

  /** Close the books on shots old enough for their confirm to have arrived. */
  private judge(localMs: number): void {
    for (const [seq, pending] of this.shots) {
      const { shot } = pending;
      if (localMs - shot.localMs < JUDGE_AFTER_MS) break; // Map keeps insertion order
      this.shots.delete(seq);
      shot.damaged = sortedIds(pending.damaged);
      shot.blocked = sortedIds(pending.blocked);
      shot.excluded = this.exclusion(shot);
      this.judged.push(shot);
    }
  }

  /**
   * End of run: judge the shots old enough to have their confirm; the ones fired within the
   * last `JUDGE_AFTER_MS` are dropped unjudged (their confirm may still be on the way).
   */
  finish(localMs: number): void {
    this.judge(localMs);
    this.shots.clear();
  }

  /** Everything the report needs, as plain data. */
  stats(): ClientStats {
    const score = this.session.match?.scores.find((s) => s.id === this.id);
    return {
      name: this.opts.name,
      judged: [...this.judged],
      corrections: this.corrections,
      correctionErrors: [...this.correctionErrors.values],
      stateCorrections: this.stateCorrections,
      deathCorrections: this.deathCorrections,
      contactCorrections: this.contactCorrections,
      contactErrors: [...this.contactErrors.values],
      seatCorrections: this.seatCorrections,
      driverCorrections: this.driverCorrections,
      driverErrors: [...this.driverErrors.values],
      drivingSteps: this.drivingSteps,
      ridingSteps: this.ridingSteps,
      respawns: this.respawns,
      snapshots: this.snapshots,
      snapIntervals: [...this.snapIntervals.values],
      interpDelays: [...this.interpDelays.values],
      frameCost: [...this.frameCost.values],
      errors: [...this.errors],
      kills: score?.kills ?? 0,
      deaths: score?.deaths ?? 0,
      flights: this.flights,
      flySeconds: this.flySteps * SIM_DT,
      flyCorrections: this.flyCorrections,
      jetGrants: this.jetGrants,
    };
  }

  /** The trucks as this client draws them, with the seats its roster says are taken. */
  private vehicleViews(remotes: readonly RemotePlayer[], localMs: number): BotVehicleView[] {
    const poses = this.session.vehicles(localMs);
    if (!poses.length) return [];
    const taken = new Map<number, Set<SeatId>>();
    const take = (s: { vehicle: number; seat: SeatId } | null | undefined): void => {
      if (!s) return;
      let set = taken.get(s.vehicle);
      if (!set) taken.set(s.vehicle, (set = new Set()));
      set.add(s.seat);
    };
    for (const r of remotes) if (r.pose.hp > 0) take(seatFromWire(r.pose.vh));
    take(this.state?.seat);
    return poses
      .filter((p) => p.condition !== 'gone')
      .map((p) => {
        const m = p.motion;
        const used = taken.get(p.id) ?? new Set<SeatId>();
        return {
          id: p.id,
          pos: { ...m.pos },
          yaw: m.yaw,
          speed: Math.hypot(m.vel.x, m.vel.z),
          forwardSpeed: m.vel.x * Math.sin(m.yaw) + m.vel.z * Math.cos(m.yaw),
          condition: p.condition,
          health: p.hp / VEHICLE.maxHealth,
          free: SEATS.filter((s) => !used.has(s)),
          hasDriver: used.has('driver'),
        };
      });
  }

  /** Touching a truck (on foot), or driving one into something (another truck, a walker). */
  private vehicleContact(state: PlayerState): boolean {
    const obstacles = this.session.vehicleEnv().vehicles ?? [];
    const mine = state.seat?.vehicle;
    const me = state.move.pos;
    for (const o of obstacles) {
      if (o.id === mine) continue;
      const reach = state.seat ? 4.5 : 1.6;
      const d = Math.hypot(o.x - me.x, o.z - me.z) - Math.hypot(o.hx, o.hz);
      if (d < reach) return true;
    }
    if (mine !== undefined) {
      for (const q of this.session.crowd()) {
        if (Math.hypot(q.x - me.x, q.z - me.z) < 4) return true;
      }
    }
    return false;
  }

  private exclusion(shot: ShotRecord): string | null {
    const near = (id: string | null): boolean =>
      id !== null &&
      (this.deaths.get(id) ?? []).some(
        (t) => t >= shot.localMs - DEATH_RACE_BEFORE_MS && t <= shot.localMs + DEATH_RACE_AFTER_MS,
      );
    if (near(this.id)) return 'shooter died';
    if (near(shot.target) || shot.hits.some(near) || shot.damaged.some(near)) return 'target died';
    if (Math.abs(shot.localMs - this.phaseChangeMs) < PHASE_MARGIN_MS) return 'phase change';
    if (this.lastPhase !== 'playing' && this.lastPhase !== null) return 'phase change';
    if (shot.localMs - this.welcomeMs < 1000) return 'just joined';
    // Spawn protection alone explains how it ended: "blocked", neither a hit nor a miss.
    return shotVerdict(shot).protectedOnly ? 'target protected' : null;
  }
}

/** A shot awaiting its verdict, with every answer the server has sent for it so far. */
interface PendingShot extends ShotOutcomes {
  shot: ShotRecord;
}

/** The centre of a drawn body's torso capsule (what "dead centre" means). */
function torsoCentre(r: RemotePlayer): Vec3 {
  const torso = humanoidHitboxes(
    { x: r.pose.x, y: r.pose.y, z: r.pose.z },
    r.pose.eye,
    r.pose.yaw,
  )[1]!;
  return {
    x: (torso.a.x + torso.b.x) / 2,
    y: (torso.a.y + torso.b.y) / 2,
    z: (torso.a.z + torso.b.z) / 2,
  };
}

/** A remote player as the behaviour tree's observation needs it (public pose only). */
export function remoteState(r: RemotePlayer, primary: PrimaryId, mode: MatchMode): PlayerState {
  const s = createPlayerState({ x: r.pose.x, y: r.pose.y, z: r.pose.z }, 1, mode, primary);
  s.move.eyeHeight = r.pose.eye;
  s.view = { yaw: r.pose.yaw, pitch: r.pose.pitch };
  s.health = r.pose.hp;
  // Drawn spawn-protected (the shimmer a player sees): the tree then tracks it without firing.
  if (snapshotProtected(r.pose)) grantSpawnProtection(s);
  // Seated as drawn: a visible driver is a truck's crew (boardable, a truce), not a foot target.
  const seat = seatFromWire(r.pose.vh);
  if (seat) s.seat = { vehicle: seat.vehicle, seat: seat.seat };
  return s;
}
