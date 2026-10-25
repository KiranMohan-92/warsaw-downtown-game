import {
  BOT,
  createPlayerState,
  hashSeed,
  mulberry32,
  placeBodyAt,
  SIM_DT,
  sightVisibility,
  withHulls,
  type BotPersonalityId,
  type CombatEvent,
  type PlayerInput,
  type Vec3,
} from '@wd/shared';
import { MatchSim, type ServerPlayer } from '../../match/MatchSim.ts';
import { BehaviorTreeDecisionProvider } from '../behaviorTree.ts';
import { getNavGraph, type NavGraph } from '../nav.ts';
import { buildBotObservation } from '../observation.ts';
import type { BotDifficulty, BotObservation, DecisionProvider } from '../types.ts';
import { ReferencePlayer, type ReferenceProfile, REFERENCE_PLAYER } from './referencePlayer.ts';

/**
 * Headless bot measurement on the real server sim (`pnpm bots:measure`): `MatchSim` on the
 * Market, the real behaviour tree through the real input path, against `ReferencePlayer` (an
 * average human, same perception, same input path). Fixed 60 Hz steps, as fast as the CPU goes,
 * deterministic per seed. Setup (placing players for a duel) is test scaffolding only: once a
 * duel starts, everyone moves and shoots by `PlayerInput` alone.
 */

export type DuelRange = 'close' | 'mid' | 'long';
/** `cold`: fresh, each facing 10–40° off the other (just spawned / rotating). `hot`: mid-fight. */
export type DuelStart = 'cold' | 'hot';

export const DUEL_RANGES: Record<DuelRange, readonly [number, number]> = {
  close: [5, 10],
  mid: [15, 25],
  long: [30, 45],
};

const RANGE_IDS: readonly DuelRange[] = ['close', 'mid', 'long'];

/** A duel that nobody wins in this long is a draw (s). */
export const DUEL_TIMEOUT_S = 15;

export interface SideStats {
  /** First tick (ms from the duel start) this side saw the other; null = never. */
  sawMs: number | null;
  firstShotMs: number | null;
  firstShotHit: boolean | null;
  shots: number;
  hits: number;
  headHits: number;
}

/**
 * The bot's personality in a duel: every seed cycles through `BOT.personalityOrder` (the duel
 * seeds are consecutive), so a difficulty's numbers are the mix a real match has.
 */
export function duelPersonality(seed: number): BotPersonalityId {
  const order = BOT.personalityOrder;
  return order[((seed % order.length) + order.length) % order.length] ?? 'rusher';
}

export interface DuelResult {
  /**
   * `trade`: both died in the same tick (the sim resolves every shot of a tick before deaths
   * land); `draw`: nobody died before the timeout. Neither counts as a win or a loss.
   */
  winner: 'bot' | 'ref' | 'trade' | 'draw';
  /** The bot's personality (`duelPersonality`). */
  personality: BotPersonalityId;
  distance: number;
  /** The winner's first shot to the kill (ms); null without a winner. */
  ttkMs: number | null;
  durationMs: number;
  /** Fastest the bot's view turned in any tick, per axis (rad/s): never past its `turnRate`. */
  botMaxTurnRate: number;
  bot: SideStats;
  ref: SideStats;
}

const REF_ID = 'ref';

/** Records what a provider was shown (the bot's own perception) before it decides. */
class WatchedProvider implements DecisionProvider {
  constructor(
    private readonly inner: DecisionProvider,
    private readonly onObserve: (o: BotObservation) => void,
  ) {}
  decide(observation: BotObservation, dt: number): PlayerInput {
    this.onObserve(observation);
    return this.inner.decide(observation, dt);
  }
}

function emptySide(): SideStats {
  return { sawMs: null, firstShotMs: null, firstShotHit: null, shots: 0, hits: 0, headHits: 0 };
}

/** Feet on a nav node, eyes at standing height. */
const eyeOf = (feet: Vec3): Vec3 => ({ x: feet.x, y: feet.y + 1.62, z: feet.z });

/**
 * Pairs of standing spots on the Market with a clear, unconcealed eye-to-eye line at `range`
 * (deterministic): the duel arenas.
 */
export function duelPairs(
  sim: MatchSim,
  nav: NavGraph,
  range: readonly [number, number],
  count: number,
  seed = 1,
): [Vec3, Vec3][] {
  const rng = mulberry32(hashSeed(seed, range[0], range[1]));
  const nodes = nav.wanderNodes;
  const out: [Vec3, Vec3][] = [];
  for (let tries = 0; out.length < count && tries < count * 400; tries++) {
    const a = nodes[Math.floor(rng() * nodes.length)]!;
    const b = nodes[Math.floor(rng() * nodes.length)]!;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < range[0] || d > range[1] || Math.abs(a.y - b.y) > 1.5) continue;
    const ea = eyeOf(a);
    const eb = eyeOf(b);
    if (sightVisibility(ea, eb, sim.physics, [], sim.foliage) < 0.9) continue;
    if (sightVisibility(eb, ea, sim.physics, [], sim.foliage) < 0.9) continue;
    out.push([
      { x: a.x, y: a.y, z: a.z },
      { x: b.x, y: b.y, z: b.z },
    ]);
  }
  return out;
}

function wrap(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

const yawTo = (from: Vec3, to: Vec3): number => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/**
 * One Market sim, reused for many duels (a fresh one costs ~0.5 s: the Rapier world). Every duel
 * starts from a full reset (`fresh`): clock at zero, match phase and pickups reset, both players
 * re-seated from scratch (new bodies, input queues, rate limiters, pose histories). So a duel's
 * outcome depends only on its seed, never on which duels ran before it (or on which worker).
 */
export class DuelBench {
  readonly sim: MatchSim;
  readonly nav: NavGraph;
  bot!: ServerPlayer;
  ref!: ServerPlayer;
  private readonly pairs = new Map<DuelRange, [Vec3, Vec3][]>();

  constructor(pairsPerRange = 400) {
    this.sim = new MatchSim({
      map: 'defilad',
      size: 'market',
      mode: 'standard',
      botCount: 1,
      // Skill duels model mid-fight encounters: nobody is freshly spawned, so no protection
      // (with it, a duel measures who respects the shimmer, not who aims better).
      spawnProtection: 0,
      radar: 'off',
      // Duels measure aim and nerve on foot (the targets were tuned without vehicles).
      vehicles: 'off',
      // Duels have no jetpacks (the duel targets were measured without them).
      jetpacks: 'off',
      scoreLimit: 1e6,
      timeLimit: 1e7,
    });
    this.nav = getNavGraph(this.sim.map, this.sim.physics);
    this.fresh();
    for (const r of Object.keys(DUEL_RANGES) as DuelRange[])
      this.pairs.set(r, duelPairs(this.sim, this.nav, DUEL_RANGES[r], pairsPerRange));
  }

  dispose(): void {
    this.sim.dispose();
  }

  /** Back to a just-built match: clock 0, no players, then the reference (and its bot) join. */
  private fresh(): void {
    const sim = this.sim;
    // Removing the human also removes the bot (`MatchBots.sync`); bodies are freed.
    for (const id of [...sim.players.keys()]) sim.removePlayer(id);
    sim.tick = 0;
    sim.phase = 'playing';
    sim.phaseEnds = Math.round(1e7 * MatchSim.tickHz);
    sim.winners = [];
    sim.grenades.length = 0;
    sim.tactics.reset();
    sim.drainEvents();
    this.ref = sim.addPlayer(REF_ID, 'Reference', 0);
    this.bot = [...sim.players.values()].find((p) => p.bot)!;
  }

  pairCount(range: DuelRange): number {
    return this.pairs.get(range)!.length;
  }

  /** One seeded duel: the bot (AR-7, no frags) against the reference (AR-7, no frags). */
  duel(
    difficulty: BotDifficulty,
    range: DuelRange,
    start: DuelStart,
    seed: number,
    profile: ReferenceProfile = REFERENCE_PLAYER,
  ): DuelResult {
    const sim = this.sim;
    const personality = duelPersonality(seed);
    // Each cell (range × start) gets its own seed stream; difficulties share it (paired runs).
    seed = hashSeed(seed, RANGE_IDS.indexOf(range), start === 'cold' ? 1 : 2);
    const rng = mulberry32(hashSeed(seed, 0x5eed));
    const pairs = this.pairs.get(range)!;
    const pair = pairs[Math.floor(rng() * pairs.length)]!;
    const swap = rng() < 0.5;
    const refFeet = swap ? pair[1] : pair[0];
    const botFeet = swap ? pair[0] : pair[1];
    const off = (): number => {
      const deg = start === 'cold' ? 10 + rng() * 30 : rng() * 4;
      return ((rng() < 0.5 ? -1 : 1) * deg * Math.PI) / 180;
    };
    const hp = (): number => (start === 'hot' ? 45 + Math.floor(rng() * 56) : 100);
    // Test setup on fresh players: the duel's kit, spot, facing and health.
    const reset = (p: ServerPlayer, feet: Vec3, yaw: number, health: number): void => {
      p.primary = 'ar7';
      p.state = createPlayerState(feet, hashSeed(seed, p.slot), 'standard', 'ar7');
      p.state.view = { yaw, pitch: 0 };
      p.state.health = health;
      p.state.arsenal.grenades = 0;
      placeBodyAt(p.body, feet);
    };
    this.fresh();
    reset(this.ref, refFeet, yawTo(refFeet, botFeet) + off(), hp());
    reset(this.bot, botFeet, yawTo(botFeet, refFeet) + off(), hp());
    const t0 = sim.nowMs;
    const botSide = emptySide();
    const refSide = emptySide();
    sim.bots.providers.set(
      this.bot.id,
      new WatchedProvider(
        new BehaviorTreeDecisionProvider({
          id: this.bot.id,
          seed: hashSeed(seed, 0xb07),
          difficulty,
          behavior: 'ffa',
          personality,
        }),
        (o) => {
          if (botSide.sawMs === null && o.visiblePlayers.some((v) => v.id === REF_ID))
            botSide.sawMs = o.nowMs - t0;
        },
      ),
    );
    const human = new ReferencePlayer(hashSeed(seed, 0x4ef), profile);
    sim.drainEvents();
    let winner: DuelResult['winner'] = 'draw';
    let ttkMs: number | null = null;
    const firstShot = (side: SideStats): number => side.firstShotMs ?? 0;
    const ticks = Math.round(DUEL_TIMEOUT_S / SIM_DT);
    let botMaxTurnRate = 0;
    let botView = { ...this.bot.state.view };
    for (let t = 0; t < ticks && winner === 'draw'; t++) {
      const obs = this.observe(this.ref);
      if (refSide.sawMs === null && obs.visiblePlayers.length) refSide.sawMs = obs.nowMs - t0;
      const input = human.decide(obs, this.ref.state, SIM_DT);
      sim.receiveInputs(REF_ID, [{ ...input, vt: sim.nowMs }], sim.nowMs);
      sim.step();
      const view = this.bot.state.view;
      // Per axis, as the bot caps it.
      const turned = Math.max(
        Math.abs(wrap(view.yaw - botView.yaw)),
        Math.abs(view.pitch - botView.pitch),
      );
      botMaxTurnRate = Math.max(botMaxTurnRate, turned / SIM_DT);
      botView = { ...view };
      const now = sim.nowMs - t0;
      const shotThisTick = { bot: false, ref: false };
      // The outcome is decided after the whole tick's events: both lethal = a trade.
      const killed = { bot: false, ref: false };
      for (const e of sim.drainEvents()) {
        if (!('by' in e)) continue; // props
        const side = e.by === REF_ID ? refSide : e.by === this.bot.id ? botSide : null;
        if (!side) continue;
        if (e.type === 'shot') {
          side.shots++;
          if (side.firstShotMs === null) {
            side.firstShotMs = now;
            side.firstShotHit = false;
            shotThisTick[side === refSide ? 'ref' : 'bot'] = true;
          }
        } else if (e.type === 'hit') {
          if (e.target === REF_ID) human.hurt(e.from, sim.nowMs);
          side.hits++;
          if (e.zone === 'head') side.headHits++;
          if (shotThisTick[side === refSide ? 'ref' : 'bot']) side.firstShotHit = true;
          if (e.killed) killed[side === refSide ? 'ref' : 'bot'] = true;
        }
      }
      if (killed.bot && killed.ref) winner = 'trade';
      else if (killed.bot) {
        winner = 'bot';
        ttkMs = now - firstShot(botSide);
      } else if (killed.ref) {
        winner = 'ref';
        ttkMs = now - firstShot(refSide);
      }
    }
    return {
      winner,
      personality,
      distance: Math.hypot(refFeet.x - botFeet.x, refFeet.z - botFeet.z),
      ttkMs,
      durationMs: sim.nowMs,
      botMaxTurnRate,
      bot: botSide,
      ref: refSide,
    };
  }

  private observe(p: ServerPlayer): BotObservation {
    return observeFor(this.sim, this.nav, p);
  }
}

/** What a player can see right now: the same perception the bots get (`buildBotObservation`). */
function observeFor(sim: MatchSim, nav: NavGraph, p: ServerPlayer): BotObservation {
  const players = sim.fighting().map((q) => ({ ...q, isBot: q.bot }));
  return buildBotObservation({
    map: sim.map,
    physics: sim.physics,
    sight: withHulls(sim.physics, sim.vehicles.hullsNow()),
    self: { ...p, isBot: p.bot },
    players,
    smoke: sim.tactics.smoke,
    foliage: sim.foliage,
    nowMs: sim.nowMs,
    seq: p.lastSeq + 1,
    nav,
    mode: sim.config.mode,
  });
}

export interface FfaResult {
  minutes: number;
  refKills: number;
  refDeaths: number;
  /** Reference deaths within 1.5 s / 3 s / 5 s of (re)spawning. */
  refSpawnDeaths15: number;
  refSpawnDeaths3: number;
  refSpawnDeaths5: number;
  /** …of which the killer is a bot. */
  botKills: number;
  botDeaths: number;
  botSpawnDeaths15: number;
  botSpawnDeaths3: number;
  bots: number;
  refShots: number;
  refHits: number;
  botShotsAtRef: number;
  botHitsOnRef: number;
  botHeadHitsOnRef: number;
  /** With trucks in play: seconds bots spent at the wheel / riding, and what the trucks did. */
  truck?: {
    drivenSeconds: number;
    /** Distance the bot drivers covered (m): over `drivenSeconds`, their mean speed on drives. */
    drivenMeters: number;
    /** Of `drivenSeconds`, the time under way (faster than 1 m/s), and the share above 5 m/s. */
    movingSeconds: number;
    fastSeconds: number;
    riddenSeconds: number;
    runOverKills: number;
    explosionKills: number;
    destroyed: number;
    /** Kills by bots while riding (from a passenger seat). */
    seatKills: number;
  };
  /**
   * Jetpacks (3 per match on the Market): packs picked up, flights lit (bots / the reference),
   * shots and hits from the air, kills from the air, flyers killed in the air.
   */
  jetPickups: number;
  jetFlights: number;
  refJetFlights: number;
  airShots: number;
  airHits: number;
  airKills: number;
  airKillsOnRef: number;
  airDeaths: number;
  /** …and killed at any point of their flight window (in the air or landed). */
  windowDeaths: number;
}

/**
 * One reference + five bots, free for all on the Market, natural arsenal (bots draw per life),
 * spawn protection on as in a real match (bots and the reference both hold fire on the shimmer).
 */
export function runFfa(
  difficulty: BotDifficulty,
  seconds: number,
  seed: number,
  vehicles: 'on' | 'off' = 'off',
): FfaResult {
  const sim = new MatchSim({
    map: 'defilad',
    size: 'market',
    mode: 'standard',
    botCount: 5,
    botDifficulty: difficulty,
    spawnSeed: seed,
    radar: 'off',
    vehicles,
    scoreLimit: 1e6,
    timeLimit: 1e7,
  });
  try {
    const ref = sim.addPlayer(REF_ID, 'Reference', 0);
    const nav = getNavGraph(sim.map, sim.physics);
    // Vary the bots per run: fresh providers with run-seeded rngs (same class, same config).
    for (const p of sim.players.values())
      if (p.bot)
        sim.bots.providers.set(
          p.id,
          new BehaviorTreeDecisionProvider({
            id: p.id,
            seed: hashSeed(seed, p.slot),
            difficulty,
            behavior: 'ffa',
            ...(sim.bots.personalities.has(p.id)
              ? { personality: sim.bots.personalities.get(p.id)! }
              : {}),
          }),
        );
    const res: FfaResult = {
      minutes: seconds / 60,
      refKills: 0,
      refDeaths: 0,
      refSpawnDeaths15: 0,
      refSpawnDeaths3: 0,
      refSpawnDeaths5: 0,
      botKills: 0,
      botDeaths: 0,
      botSpawnDeaths15: 0,
      botSpawnDeaths3: 0,
      bots: 5,
      refShots: 0,
      refHits: 0,
      botShotsAtRef: 0,
      botHitsOnRef: 0,
      botHeadHitsOnRef: 0,
      ...(vehicles === 'on'
        ? {
            truck: {
              drivenSeconds: 0,
              drivenMeters: 0,
              movingSeconds: 0,
              fastSeconds: 0,
              riddenSeconds: 0,
              runOverKills: 0,
              explosionKills: 0,
              destroyed: 0,
              seatKills: 0,
            },
          }
        : {}),
      jetPickups: 0,
      jetFlights: 0,
      refJetFlights: 0,
      airShots: 0,
      airHits: 0,
      airKills: 0,
      airKillsOnRef: 0,
      airDeaths: 0,
      windowDeaths: 0,
    };
    const jets = new Map<string, number>();
    const spawnedAt = new Map<string, number>();
    const lives = new Map<string, number>();
    for (const p of sim.players.values()) {
      spawnedAt.set(p.id, sim.nowMs);
      lives.set(p.id, p.life);
    }
    let human = new ReferencePlayer(hashSeed(seed, 0));
    const ticks = Math.round(seconds / SIM_DT);
    for (let t = 0; t < ticks; t++) {
      if (ref.state.health > 0) {
        const input = human.decide(observeFor(sim, nav, ref), ref.state, SIM_DT);
        sim.receiveInputs(REF_ID, [{ ...input, vt: sim.nowMs }], sim.nowMs);
      }
      sim.step();
      for (const p of sim.players.values()) {
        if (lives.get(p.id) === p.life) continue;
        lives.set(p.id, p.life);
        spawnedAt.set(p.id, sim.nowMs);
        if (p === ref) human = new ReferencePlayer(hashSeed(seed, p.life));
      }
      const truck = res.truck;
      if (truck) {
        for (const p of sim.players.values()) {
          if (!p.bot || !p.state.seat) continue;
          if (p.state.seat.seat === 'driver') {
            truck.drivenSeconds += SIM_DT;
            const v = sim.vehicles.get(p.state.seat.vehicle)?.motion.vel;
            const speed = v ? Math.hypot(v.x, v.z) : 0;
            truck.drivenMeters += speed * SIM_DT;
            if (speed > 1) truck.movingSeconds += SIM_DT;
            if (speed > 5) truck.fastSeconds += SIM_DT;
          } else truck.riddenSeconds += SIM_DT;
        }
      }
      for (const p of sim.players.values()) {
        const was = jets.get(p.id) ?? 0;
        const now = p.state.move.jet;
        if (was === 0 && now === 1) res.jetPickups++;
        if (was === 1 && now === 2) {
          if (p === ref) res.refJetFlights++;
          else res.jetFlights++;
        }
        jets.set(p.id, now);
      }
      for (const e of sim.drainEvents()) {
        if (truck) {
          if (e.type === 'vboom') truck.destroyed++;
          if (e.type === 'hit' && e.killed) {
            if (e.weapon === 'truck') truck.runOverKills++;
            else if (e.weapon === 'wreck') truck.explosionKills++;
            else if (sim.players.get(e.by)?.state.seat) truck.seatKills++;
          }
        }
        countFfa(e, res, sim, human, spawnedAt);
        countAir(e, res, sim);
      }
    }
    return res;
  } finally {
    sim.dispose();
  }
}

/** Shots, hits and kills from the air (a flyer's), and flyers brought down. */
function countAir(e: CombatEvent, res: FfaResult, sim: MatchSim): void {
  // In the air on the pack (a flyer standing on the ground mid-window is not in the air).
  const flying = (id: string): boolean => {
    const m = sim.players.get(id)?.state.move;
    return m !== undefined && m.jet >= 2 && !m.grounded;
  };
  if (e.type === 'shot' && flying(e.by)) res.airShots++;
  if (e.type !== 'hit' || e.dmg <= 0) return;
  if (flying(e.by)) {
    res.airHits++;
    if (e.killed && e.by !== e.target) {
      res.airKills++;
      if (e.target === REF_ID) res.airKillsOnRef++;
    }
  }
  if (e.killed && flying(e.target)) res.airDeaths++;
  if (e.killed && (sim.players.get(e.target)?.state.move.jet ?? 0) >= 2) res.windowDeaths++;
}

function countFfa(
  e: CombatEvent,
  res: FfaResult,
  sim: MatchSim,
  human: ReferencePlayer,
  spawnedAt: Map<string, number>,
): void {
  if (e.type === 'shot') {
    if (e.by === REF_ID) res.refShots++;
    return;
  }
  if (e.type !== 'hit') return;
  if (e.by === REF_ID) res.refHits++;
  if (e.target === REF_ID) {
    human.hurt(e.from, sim.nowMs);
    if (e.by !== REF_ID) {
      res.botHitsOnRef++;
      if (e.zone === 'head') res.botHeadHitsOnRef++;
    }
  }
  if (!e.killed) return;
  const alive = sim.nowMs - (spawnedAt.get(e.target) ?? -Infinity);
  const isRef = e.target === REF_ID;
  if (isRef) {
    res.refDeaths++;
    if (alive < 1500) res.refSpawnDeaths15++;
    if (alive < 3000) res.refSpawnDeaths3++;
    if (alive < 5000) res.refSpawnDeaths5++;
  } else {
    res.botDeaths++;
    if (alive < 1500) res.botSpawnDeaths15++;
    if (alive < 3000) res.botSpawnDeaths3++;
  }
  if (e.by === REF_ID && !isRef) res.refKills++;
  else if (e.by !== REF_ID && e.by !== e.target) res.botKills++;
}

/** Wilson score interval (95 %) for k successes out of n. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/** Mean and 95 % half-width (normal approximation). */
export function meanCi(xs: readonly number[]): { mean: number; half: number; n: number } {
  const n = xs.length;
  if (!n) return { mean: NaN, half: NaN, n };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, half: (1.96 * Math.sqrt(v)) / Math.sqrt(n), n };
}
