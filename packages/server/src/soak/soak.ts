/**
 * Soak / fairness harness: N headless clients (the browser's own session code, see
 * `soakClient.ts`), each in its own worker thread, play a real match over real Colyseus SDK
 * sockets against a real server process, through a TCP proxy that adds the latency. Prints a
 * report and exits non-zero when the fairness, snapshot or error thresholds fail.
 *
 *   pnpm soak                                  # 6 clients, 50 ms each way (100 ms RTT), 60 s
 *   pnpm soak --full                           # a full match (the 10 min time limit)
 *   pnpm soak --clients 3 --latency 75 --jitter 10 --loss 1 --seconds 120
 *   pnpm soak --clients 1 --bots 5 --quick     # one client + 5 server bots (quick join)
 *   pnpm soak --server 127.0.0.1:2567          # against a server you started (no server probes)
 *   pnpm soak --virtual --latency 75           # no sockets: MatchSim on a virtual clock
 *
 * What each figure means: docs/ARCHITECTURE.md › Soak and fairness harness.
 */
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MATCH_NET, normalizeMatchOptions, type BotPersonalityId } from '@wd/shared';
import { startClientWorker, type SeatJob } from './clientWorker.ts';
import { startProxyWorker, type ProxyStats } from './latencyProxy.ts';
import {
  clientTotals,
  DEFAULT_THRESHOLDS,
  fairness,
  formatClients,
  formatFairness,
  formatScores,
  verdict,
  type ClientTotals,
  type FairnessSummary,
} from './report.ts';
import { RewindProbe } from './rewindProbe.ts';
import type { ServerReport } from './serverProcess.ts';
import { parseSoakArgs, Teardown, type SoakArgs } from './soakArgs.ts';
import { soakWorld, type ClientStats, type ShotRecord } from './soakClient.ts';
import { dist, fmtDist, pct } from './stats.ts';
import { VirtualMatch } from './virtualMatch.ts';

const log = (s: string): void => console.log(`[soak] ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const linkText = ({ link }: SoakArgs): string =>
  `${2 * link.delayMs} ms RTT (${link.delayMs} ms each way${link.jitterMs ? ` ±${link.jitterMs}` : ''}` +
  `${link.loss ? `, ${(link.loss * 100).toFixed(1)} % loss` : ''})`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface ServerHandle {
  host: string;
  port: number;
  report(): Promise<ServerReport | null>;
}

/** The first two clients play a rusher and a flanker: they take the trucks (drive and ride). */
const TRUCKERS: readonly (BotPersonalityId | undefined)[] = ['rusher', 'flanker'];
/** The client that goes for a jetpack (not a trucker: a rider takes none). */
const FLYER = 2;
/** Start (or point at) the server; its stop is registered with `teardown` before anything else. */
async function startServer(args: SoakArgs, teardown: Teardown): Promise<ServerHandle> {
  if (args.server) return { ...args.server, report: () => Promise.resolve(null) };
  let port = await freePort();
  // Ports the dev servers of other work on this machine use.
  while ([2600, 2567, 2625, 5173].includes(port)) port = await freePort();
  const child = fork(fileURLToPath(new URL('./serverProcess.ts', import.meta.url)), [], {
    env: {
      ...process.env,
      SOAK_PORT: String(port),
      SOAK_BOTS: String(args.bots),
      SOAK_MAP: args.settings.map,
      SOAK_SIZE: args.settings.size,
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let exited = false;
  child.once('exit', () => (exited = true));
  // Registered the moment the process exists: every later failure still stops it.
  teardown.add(
    'server',
    () =>
      new Promise<void>((resolve) => {
        if (exited) return resolve();
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        if (child.connected) child.send('stop');
        else child.kill();
      }),
  );
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited (${code}) before listening`)));
    child.on('message', (m: { type?: string }) => {
      if (m.type === 'listening') resolve();
    });
  });
  return {
    host: '127.0.0.1',
    port,
    report: () =>
      new Promise((resolve) => {
        if (exited || !child.connected) return resolve(null);
        const timer = setTimeout(() => resolve(null), 5000);
        child.on('message', (m: { type?: string; report?: ServerReport }) => {
          if (m.type !== 'report' || !m.report) return;
          clearTimeout(timer);
          resolve(m.report);
        });
        child.send('report');
      }),
  };
}

/** `--virtual`: MatchSim on a virtual clock, no sockets (the fairness test's setup, any size). */
async function runVirtual(args: SoakArgs): Promise<number> {
  const world = await soakWorld(args.settings.map, args.settings.size);
  const vm = new VirtualMatch(args.settings, args.link, args.link, args.seed);
  const rewind = new RewindProbe();
  rewind.install(vm.sim);
  const clients = Array.from({ length: args.clients }, (_, i) =>
    // Clients 1–2 take the trucks (rusher, flanker); client 3 is the flyer: it goes for a
    // jetpack and flies it.
    vm.join(world, {
      name: `Soak ${i + 1}`,
      seed: args.seed * 101 + i,
      ...(TRUCKERS[i] ? { personality: TRUCKERS[i] } : {}),
      flyer: i === FLYER,
    }),
  );
  const t0 = performance.now();
  vm.runUntil(args.seconds * 1000);
  vm.dispose();
  const stats = clients.map((c) => c.stats());
  const f = fairness(stats.flatMap((c) => c.judged));
  const t = clientTotals(stats, args.seconds);
  const lines = [
    '',
    `=== virtual soak: ${args.clients} clients, ${linkText(args)}, ${args.seconds} s simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s ===`,
    ...formatFairness(f),
    ...formatClients(t),
    ...formatScores(stats),
    `rewind asked (server now − vt) ms p50/p95/p99/max ${fmtDist(dist(rewind.lagMs.values))}; over the player's cap (ceiling ${MATCH_NET.maxRewindMs} ms) ${pct(rewind.clamped, rewind.shots)}`,
  ];
  return finish(args, lines, f, t, { seconds: args.seconds, fairness: f, clients: t }, stats);
}

/** Verdict, report, optional JSON; returns the exit code. */
function finish(
  args: SoakArgs,
  lines: string[],
  f: FairnessSummary,
  t: ClientTotals,
  json: Record<string, unknown>,
  stats: readonly ClientStats[],
): number {
  const fails = verdict(f, DEFAULT_THRESHOLDS, {
    snapshotRates: t.snapshotRates,
    errors: t.errors.length,
    driverCorrections: t.driverCorrections,
  });
  lines.push('', fails.length ? `FAIL: ${fails.join('; ')}` : 'PASS');
  console.log(lines.join('\n'));
  if (args.json) {
    const shots = stats.flatMap((c) => c.judged);
    writeFileSync(args.json, JSON.stringify({ args, ...json, fails, shots }, null, 1));
  }
  return fails.length ? 1 : 0;
}

/** The real-socket run. Everything it starts is stopped by `teardown`, however it ends. */
async function runSockets(args: SoakArgs, teardown: Teardown): Promise<number> {
  const { map, size } = args.settings;
  const server = await startServer(args, teardown);
  const proxy = await startProxyWorker(
    { host: server.host, port: server.port },
    args.link,
    args.link,
    args.seed,
  );
  teardown.add('proxy', () => proxy.stop());
  const endpoint = `http://127.0.0.1:${proxy.port}`;
  const t0 = performance.now();

  // Seats: the first creates the friend lobby (the run's settings), the rest join it by id, then
  // the host starts it. (Quick join: the first matchmakes into the server's settings, the rest
  // follow it into that room.) Every worker builds its world at once, in parallel.
  const handles = Array.from({ length: args.clients }, (_, i) => {
    const name = `Soak ${i + 1}`;
    const quick = {
      ...normalizeMatchOptions({ map, size, mode: 'standard', name }),
      primary: 'ar7',
    };
    const seat: SeatJob =
      i > 0
        ? { kind: 'join', options: args.quick ? quick : { name, primary: 'ar7' } }
        : args.quick
          ? { kind: 'quick', options: quick }
          : { kind: 'create', options: { ...args.settings, lobby: true, name, primary: 'ar7' } };
    const h = startClientWorker({
      endpoint,
      name,
      seed: args.seed * 101 + i,
      map,
      size,
      seat,
      ...(TRUCKERS[i] ? { personality: TRUCKERS[i] } : {}),
      flyer: i === FLYER,
    });
    teardown.add(name, () => h.terminate());
    return h;
  });
  const roomId = await handles[0]!.roomId;
  for (const h of handles.slice(1)) h.join(roomId);
  await Promise.all(handles.map((h) => h.roomId));
  if (!args.quick) handles[0]!.start();
  log(`joined in ${Math.round(performance.now() - t0)} ms (room ${roomId})`);

  const status = handles.map(() => ({ playing: false, phase: null as string | null, errors: 0 }));
  const shots: ShotRecord[] = [];
  handles.forEach((h, i) =>
    h.onStatus((s) => {
      status[i] = { playing: s.playing, phase: s.phase, errors: s.errors };
      shots.push(...s.shots);
    }),
  );
  let playStart = 0;
  let ended = false;
  let lastProgress = 0;
  const cap = (args.seconds + 180) * 1000;
  for (;;) {
    await sleep(250);
    const now = performance.now();
    if (!playStart && status.every((s) => s.playing)) {
      playStart = now;
      lastProgress = now;
      log('match running');
    }
    const played = playStart ? (now - playStart) / 1000 : 0;
    if (status[0]!.phase === 'ended' && played > 5) ended = true;
    if (playStart && (args.full ? ended : played >= args.seconds)) break;
    // A dead client never reports again: end the run now, its error is in the report.
    const dead = handles.find((h) => h.failure !== null);
    if (dead) {
      log(`stopping: ${dead.failure}`);
      break;
    }
    // Without the proxy nobody reaches the server any more.
    if (proxy.failure !== null) {
      log(`stopping: ${proxy.failure}`);
      break;
    }
    if (now - t0 > cap) {
      log('run never finished (cap reached)');
      break;
    }
    if (playStart && now - lastProgress > 30_000) {
      lastProgress = now;
      const f = fairness(shots);
      log(
        `${played.toFixed(0)} s: shots ${f.shots}, confirmed ${pct(f.aimedConfirmed, f.aimedPredicted)}, ` +
          `false hits ${f.missedFalseHits}, errors ${status.reduce((a, s) => a + s.errors, 0)}`,
      );
    }
  }
  const seconds = playStart ? (performance.now() - playStart) / 1000 : 0;
  const serverReport = await server.report();
  const proxyStats = await proxy.stats();
  // `finish` always settles (a failed or silent worker yields its error as the result).
  const results = await Promise.all(handles.map((h) => h.finish()));

  const stats = results.map((r) => r.stats);
  if (!playStart) stats[0]?.errors.push('the match never started for every client');
  if (proxy.failure !== null) stats[0]?.errors.push(proxy.failure);
  const f = fairness(stats.flatMap((c) => c.judged));
  const t = clientTotals(stats, seconds);
  const lines = [
    '',
    `=== soak report: ${args.clients} clients, ${linkText(args)}, ` +
      `${seconds.toFixed(0)} s played${ended ? ' (match ended)' : ''} ===`,
    '-- fairness (each shooter judges by what it drew) --',
    ...formatFairness(f),
    '-- clients (one worker thread each) --',
    ...formatClients(t),
    `frame gaps ms p50/p95/p99/max ${fmtDist(dist(results.flatMap((r) => r.frameGaps)))} (host stalls show here)`,
    ...formatScores(stats),
    '-- latency proxy --',
    ...formatProxy(proxyStats),
    '-- server --',
    ...(serverReport ? formatServer(serverReport) : ['(no server probes)']),
  ];
  return finish(
    args,
    lines,
    f,
    t,
    { seconds, fairness: f, clients: t, proxy: proxyStats, server: serverReport },
    stats,
  );
}

function formatProxy(p: ProxyStats | null): string[] {
  if (!p) return ['(no figures: the proxy worker was gone or did not answer)'];
  return [
    `${p.connections} connections, ${p.chunks} chunks, ${p.lost} "lost" (retransmitted late)`,
    `delivery lateness vs schedule ms p50/p99/max ${p.lateP50.toFixed(2)} / ${p.lateP99.toFixed(2)} / ${p.lateMax.toFixed(2)}`,
  ];
}

function formatServer(r: ServerReport): string[] {
  const inputs = r.inputs.filter((p) => !p.bot);
  const sum = (k: 'applied' | 'dropped' | 'skipped'): number =>
    inputs.reduce((a, p) => a + p[k], 0);
  return [
    `${r.ticks} ticks in ${r.wallSeconds.toFixed(1)} s (${(r.ticks / Math.max(1e-9, r.wallSeconds)).toFixed(2)}/s), sim − wall drift ${r.driftMs.toFixed(1)} ms`,
    `tick cost ms p50/p95/p99/max ${fmtDist(r.tickMs, 3)}; per wake-up ${fmtDist(r.wakeMs, 2)}; ticks per wake-up ${fmtDist(r.ticksPerWake, 0)}`,
    `snapshot send interval ms p50/p95/p99/max ${fmtDist(r.snapshotIntervalMs)} (min ${r.snapshotIntervalMs.min.toFixed(1)})`,
    `event-loop delay ms p50/p99/max ${r.loopDelayMs.p50.toFixed(1)} / ${r.loopDelayMs.p99.toFixed(1)} / ${r.loopDelayMs.max.toFixed(1)}; rss ${r.rssMb.toFixed(0)} MB`,
    `inputs applied ${sum('applied')}, dropped ${sum('dropped')}, skipped late ${sum('skipped')}`,
    `rewind asked (server now − vt) ms p50/p95/p99/max ${fmtDist(r.rewindMs)}; over the player's cap (ceiling ${MATCH_NET.maxRewindMs} ms) ${pct(r.rewindClamped, r.rewindShots)}`,
  ];
}

/** Exit code: 0 pass, 1 thresholds failed, 2 the run itself failed (bad flags, startup, crash). */
async function main(): Promise<number> {
  let args: SoakArgs;
  try {
    args = parseSoakArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[soak] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  log(
    `${args.clients} clients, ${linkText(args)}, ${args.full ? 'a full match' : `${args.seconds} s`} ` +
      `on ${args.settings.map}/${args.settings.size}${args.virtual ? ' (virtual clock)' : ''}`,
  );
  if (args.virtual) return runVirtual(args);
  // Server, proxy and client workers are stopped on every path: a pass, a failed threshold, a
  // rejected matchmaking request, a crashed worker (no orphan server process is left behind).
  const teardown = new Teardown();
  try {
    return await runSockets(args, teardown);
  } catch (err) {
    console.error('[soak] failed', err);
    // Set before the teardown runs: should a stop step ever leave nothing for the event loop
    // to wait on, Node exits on its own, and must not do so with 0 after a failed run.
    process.exitCode = 2;
    return 2;
  } finally {
    await teardown.run();
    for (const e of teardown.errors) console.error(`[soak] teardown: ${e}`);
  }
}

void main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('[soak] failed', err);
    process.exit(2);
  },
);
