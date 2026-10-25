import {
  BOT,
  hashSeed,
  SEATS,
  SIM_DT,
  VEHICLE,
  withHulls,
  type BotPersonalityId,
  refreshDriveGraph,
  type DriveGraph,
  type PrimaryId,
} from '@wd/shared';
import { getDriveGraph } from '../bots/driveCache.ts';
import type { BotVehicleView } from '../bots/types.ts';
import {
  BehaviorTreeDecisionProvider,
  buildBotObservation,
  getNavGraph,
  type DecisionProvider,
  type NavGraph,
} from '../bots/index.ts';
import type { MatchSim, ServerPlayer } from './MatchSim.ts';

/**
 * The personality of the bot in seat `n` (1-based, `bot:n`): the seats cycle through
 * `BOT.personalityOrder`, so five bots are a rusher, a flanker, an anchor, a marksman and a
 * second rusher.
 */
export function personalityForSeat(n: number): BotPersonalityId {
  const order = BOT.personalityOrder;
  return order[(Math.max(1, n) - 1) % order.length] ?? 'rusher';
}

/** Prop changes are merged per this many metres of ground before the graphs re-check them. */
const DIRTY_CELL = 4;

/** Bot seats and input production; decisions never receive a mutable simulation or body. */
export class MatchBots {
  readonly providers = new Map<string, DecisionProvider>();
  /** Each bot's personality (`BOT.personalities`), by id. */
  readonly personalities = new Map<string, BotPersonalityId>();
  private nav: NavGraph | null = null;
  /** Where the match's trucks can drive (undefined until first needed; null: no trucks). */
  private drive: DriveGraph | null | undefined;
  /** The shared drive graph `drive` is this match's view of (its props re-checked). */
  private driveBase: DriveGraph | null = null;
  /**
   * Ground under props that changed, not yet re-checked in the graphs (a few per tick), merged
   * per `DIRTY_CELL` grid cell: bounded by the map's area however many props change (a room with
   * no bots never drains it).
   */
  private readonly dirty = new Map<
    string,
    { minX: number; maxX: number; minZ: number; maxZ: number }
  >();
  private nextId = 1;

  constructor(private readonly sim: MatchSim) {}

  sync(): void {
    const humans = [...this.sim.players.values()].filter((p) => !p.bot).length;
    const desired = humans ? Math.min(this.sim.config.botCount ?? 0, 6 - humans) : 0;
    while (this.providers.size > desired) this.removeOne();
    while (this.providers.size < desired) {
      const n = this.nextId++;
      const id = `bot:${n}`;
      const persona = personalityForSeat(n);
      this.personalities.set(id, persona);
      const p = this.sim.addPlayer(id, this.callsign(persona, n), this.sim.nowMs, true, {
        primary: this.primaryFor(id, 0),
      });
      this.providers.set(id, this.provider(p));
    }
    for (const id of this.personalities.keys())
      if (!this.sim.players.has(id)) this.personalities.delete(id);
  }

  /** A roster name from the personality's callsigns, unique among the bots in the match. */
  private callsign(persona: BotPersonalityId, n: number): string {
    const names = BOT.personalities[persona].callsigns;
    const taken = new Set([...this.sim.players.values()].filter((p) => p.bot).map((p) => p.name));
    const lap = Math.floor((n - 1) / BOT.personalityOrder.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[(lap + i) % names.length]!;
      if (!taken.has(name)) return name;
    }
    return `${names[0] ?? 'Bot'} ${n}`;
  }

  /**
   * A bot's primary for a life: seeded by its id and life number (deterministic, varied across
   * bots and lives), from its personality's guns (`BOT.personalities[…].primaries`; every gun of
   * `BOT.primaries` belongs to some personality). Knife-only matches carry no guns: moot.
   */
  primaryFor(id: string, life: number): PrimaryId {
    if (this.sim.config.mode === 'knife') return 'ar7';
    const persona = this.personalities.get(id);
    const pool = persona ? BOT.personalities[persona].primaries : BOT.primaries;
    const idSeed = hashSeed(...Array.from(id, (c) => c.charCodeAt(0)));
    return pool[hashSeed(idSeed, life) % pool.length] ?? 'ar7';
  }

  /**
   * Before a bot respawns: pick the next life's primary through the same loadout path a human's
   * `loadout` message takes (`MatchSim.setLoadout`, applied by the respawn).
   */
  beforeRespawn(p: ServerPlayer): void {
    if (p.bot) this.sim.setLoadout(p.id, this.primaryFor(p.id, p.life + 1));
  }

  private provider(p: ServerPlayer): DecisionProvider {
    const personality = this.personalities.get(p.id);
    return new BehaviorTreeDecisionProvider({
      id: p.id,
      seed: p.seed,
      difficulty: this.sim.config.botDifficulty ?? 'normal',
      behavior: this.sim.config.botBehaviour ?? 'ffa',
      ...(personality ? { personality } : {}),
    });
  }

  reset(id: string): void {
    const p = this.sim.players.get(id);
    if (p?.bot) this.providers.set(id, this.provider(p));
  }

  removeOne(): void {
    const id = [...this.providers.keys()].at(-1);
    if (id) this.sim.removePlayer(id);
  }

  /**
   * Build the nav graph now (seconds on the full map, cached per map): the room calls this before
   * its loop starts, so the first tick with bots never stalls the event loop building it.
   */
  prewarm(): NavGraph {
    this.driveGraph();
    return (this.nav ??= getNavGraph(this.sim.map, this.sim.physics));
  }

  private driveGraph(): DriveGraph | null {
    if (this.drive === undefined) {
      const spawns = this.sim.vehicles.list.map((v) => v.spawn.pos);
      this.drive = this.driveBase = getDriveGraph(this.sim.map, this.sim.physics, spawns);
    }
    return this.drive;
  }

  /** A prop moved off (or onto) this ground: the bots' walk and drive graphs re-check it. */
  propsChanged(box: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    const key = `${Math.floor((box.minX + box.maxX) / 2 / DIRTY_CELL)},${Math.floor((box.minZ + box.maxZ) / 2 / DIRTY_CELL)}`;
    const had = this.dirty.get(key);
    this.dirty.set(
      key,
      had
        ? {
            minX: Math.min(had.minX, box.minX),
            maxX: Math.max(had.maxX, box.maxX),
            minZ: Math.min(had.minZ, box.minZ),
            maxZ: Math.max(had.maxZ, box.maxZ),
          }
        : { ...box },
    );
  }

  /** Every prop is home again (a new match): the graphs are their shared builds again. */
  propsReset(): void {
    this.dirty.clear();
    this.nav?.reset?.();
    if (this.drive !== undefined) this.drive = this.driveBase;
  }

  /** Spots still waiting to be re-checked (tests). */
  get pendingGraphChecks(): number {
    return this.dirty.size;
  }

  /** Re-check up to `max` changed spots (bounded work per tick; a burst of cartons queues). */
  private refreshGraphs(max = 6): void {
    if (!this.dirty.size) return;
    const nav = (this.nav ??= getNavGraph(this.sim.map, this.sim.physics));
    const drive = this.sim.vehicles.list.length ? this.driveGraph() : null;
    for (const [key, box] of [...this.dirty].slice(0, max)) {
      this.dirty.delete(key);
      nav.invalidate?.(box);
      if (drive && this.driveBase && this.drive)
        this.drive = refreshDriveGraph(this.driveBase, this.drive, this.sim.physics, box);
    }
  }

  /** The trucks as everyone can see them (each bot's observation keeps the ones it notices). */
  private vehicleViews(): BotVehicleView[] {
    return this.sim.vehicles.list
      .filter((v) => v.condition !== 'gone')
      .map((v) => {
        const m = v.motion;
        return {
          id: v.id,
          pos: { ...m.pos },
          yaw: m.yaw,
          speed: Math.hypot(m.vel.x, m.vel.z),
          forwardSpeed: m.vel.x * Math.sin(m.yaw) + m.vel.z * Math.cos(m.yaw),
          condition: v.condition,
          health: v.health / VEHICLE.maxHealth,
          free: SEATS.filter((s) => v.seats[s] === null),
          hasDriver: v.seats.driver !== null,
        };
      });
  }

  /** This method only enqueues intent, so tests can prove it never moves or fires a player. */
  enqueue(): void {
    if (!this.providers.size || this.sim.phase !== 'playing') return;
    this.nav ??= getNavGraph(this.sim.map, this.sim.physics);
    this.refreshGraphs();
    // Players still loading are out of the fight: never seen, targeted or hunted.
    const players = this.sim.fighting().map((p) => ({ ...p, isBot: p.bot }));
    const vehicles = this.sim.vehicles.list.length ? this.vehicleViews() : [];
    const drive = vehicles.length ? this.driveGraph() : null;
    // Trucks block sight like walls (the same armour that stops rounds).
    const sight = vehicles.length
      ? withHulls(this.sim.physics, this.sim.vehicles.hullsNow())
      : this.sim.physics;
    for (const p of players) {
      const provider = this.providers.get(p.id);
      if (!provider || p.state.health <= 0) continue;
      const observation = buildBotObservation({
        map: this.sim.map,
        physics: this.sim.physics,
        sight,
        self: p,
        players,
        smoke: this.sim.tactics.smoke,
        foliage: this.sim.foliage,
        nowMs: this.sim.nowMs,
        seq: p.lastSeq + 1,
        nav: this.nav,
        mode: this.sim.config.mode,
        vehicles,
        drive,
        jetpacks: this.sim.tactics.jetpacks,
      });
      // Bots see the present snapshot, so their view time is now; humans report their view time.
      const input = provider.decide(observation, SIM_DT);
      this.sim.receiveInputs(p.id, [{ ...input, vt: this.sim.nowMs }], this.sim.nowMs);
    }
  }
}
