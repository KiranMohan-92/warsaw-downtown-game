/**
 * The game server for a soak run, in its own process (forked by `soak.ts`): the production
 * `createGameServer` on a port, with probes on the match simulation — tick cost, wake-ups,
 * snapshot cadence, clock drift, event-loop delay, input drops and lag-compensation rewinds —
 * reported to the parent over IPC. Nothing here changes what the server does.
 *
 * Env: SOAK_PORT, SOAK_BOTS (quick-join bot count), SOAK_MAP, SOAK_SIZE.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { initPhysics, MATCH_NET, SIM, type MapId, type MapSize } from '@wd/shared';
import { createGameServer } from '../app.ts';
import { MatchSim, prewarmMatchMaps } from '../match/MatchSim.ts';
import { RewindProbe } from './rewindProbe.ts';
import { dist, Reservoir, type Dist } from './stats.ts';

export interface ServerReport {
  /** CPU time per sim tick (ms), and per wake-up (all its ticks, snapshots excluded). */
  tickMs: Dist;
  wakeMs: Dist;
  /** Ticks run per wake-up. */
  ticksPerWake: Dist;
  /** Time between snapshot ticks leaving the server (ms). */
  snapshotIntervalMs: Dist;
  /** Sim time − wall time since the first tick (ms; ≈ 0 = the tick clock follows real time). */
  driftMs: number;
  ticks: number;
  wallSeconds: number;
  /** Event-loop delay (ms). */
  loopDelayMs: { p50: number; p99: number; max: number };
  rewindMs: Dist;
  rewindShots: number;
  rewindClamped: number;
  /** Per player: inputs applied / dropped (rate, queue) / skipped (late after idling). */
  inputs: { id: string; bot: boolean; applied: number; dropped: number; skipped: number }[];
  rssMb: number;
}

const tick = new Reservoir();
const wake = new Reservoir();
const perWake = new Reservoir();
const snapGaps = new Reservoir();
const rewind = new RewindProbe();
const sims = new Set<MatchSim>();
let firstTick: { wall: number; tick: number } | null = null;
let lastTick = { wall: 0, tick: 0 };
let lastSnapWall: number | null = null;
let lastSnapTick = -1;
/** Event-loop delay counts from the first tick (building the room's world stalls before it). */
const loop = monitorEventLoopDelay({ resolution: 5 });
const onFirstTick = (): void => {
  loop.reset();
  loop.enable();
};

function instrument(): void {
  const proto = MatchSim.prototype;
  // The originals, called on each instance (`.call`) from the wrappers.
  const original = <T>(name: 'runTicks' | 'snapshot'): T =>
    Object.getOwnPropertyDescriptor(proto, name)!.value as T;
  const runTicks = original<(this: MatchSim, ticks: number) => boolean>('runTicks');
  proto.runTicks = function (this: MatchSim, ticks: number): boolean {
    sims.add(this);
    const t0 = performance.now();
    const due = runTicks.call(this, ticks);
    const t1 = performance.now();
    if (ticks > 0) {
      wake.push(t1 - t0);
      tick.push((t1 - t0) / ticks);
      perWake.push(ticks);
      if (!firstTick) {
        firstTick = { wall: t0, tick: this.tick - ticks };
        onFirstTick();
      }
      lastTick = { wall: t1, tick: this.tick };
    }
    return due;
  };
  // The room builds one snapshot per client right after the pacer's snapshot tick: the first
  // call for a new tick is when that snapshot leaves.
  const snapshot =
    original<(this: MatchSim, forId?: string) => ReturnType<MatchSim['snapshot']>>('snapshot');
  proto.snapshot = function (this: MatchSim, forId?: string) {
    if (this.tick !== lastSnapTick) {
      const now = performance.now();
      if (lastSnapWall !== null) snapGaps.push(now - lastSnapWall);
      lastSnapWall = now;
      lastSnapTick = this.tick;
    }
    return snapshot.call(this, forId);
  };
  rewind.install(proto);
}

function report(): ServerReport {
  const f = firstTick;
  const wallMs = f ? lastTick.wall - f.wall : 0;
  const simMs = f ? ((lastTick.tick - f.tick) * 1000) / SIM.tickHz : 0;
  return {
    tickMs: dist(tick.values),
    wakeMs: dist(wake.values),
    ticksPerWake: dist(perWake.values),
    snapshotIntervalMs: dist(snapGaps.values),
    driftMs: simMs - wallMs,
    ticks: f ? lastTick.tick - f.tick : 0,
    wallSeconds: wallMs / 1000,
    loopDelayMs: {
      p50: loop.percentile(50) / 1e6,
      p99: loop.percentile(99) / 1e6,
      max: loop.max / 1e6,
    },
    rewindMs: dist(rewind.lagMs.values),
    rewindShots: rewind.shots,
    rewindClamped: rewind.clamped,
    inputs: [...sims].flatMap((s) =>
      [...s.players.values()].map((p) => ({
        id: p.id,
        bot: p.bot,
        applied: p.applied,
        dropped: p.dropped,
        skipped: p.skipped,
      })),
    ),
    rssMb: process.memoryUsage().rss / 2 ** 20,
  };
}

async function main(): Promise<void> {
  // The harness that forked us is gone (it crashed, was killed, or closed the channel): never
  // outlive it as an orphan holding the port. Registered before the slow start-up below.
  if (process.send) process.once('disconnect', () => process.exit(0));
  const port = Number.parseInt(process.env.SOAK_PORT ?? '', 10);
  if (!Number.isFinite(port)) throw new Error('SOAK_PORT is required');
  const bots = Number.parseInt(process.env.SOAK_BOTS ?? '0', 10);
  const map = (process.env.SOAK_MAP ?? 'defilad') as MapId;
  const size = (process.env.SOAK_SIZE ?? 'market') as MapSize;
  await initPhysics();
  prewarmMatchMaps([{ map, size }]);
  instrument();
  const server = createGameServer(undefined, {
    quickJoin: { botCount: Math.max(0, Math.min(MATCH_NET.maxPlayers - 1, bots)) },
  });
  await server.listen(port, '127.0.0.1');
  process.on('message', (m: unknown) => {
    if (m === 'report') process.send?.({ type: 'report', report: report() });
    else if (m === 'stop') {
      void server
        .gracefullyShutdown(false)
        .catch(() => {})
        .finally(() => process.exit(0));
    }
  });
  process.send?.({ type: 'listening', port });
}

main().catch((err: unknown) => {
  console.error('[soak server] failed', err);
  process.exit(1);
});
