/**
 * Bot difficulty measurement (`pnpm bots:measure`): seeded duels and FFA matches on the Market,
 * the real server sim and behaviour tree against the scripted reference player. Prints markdown
 * tables (means and 95 % intervals) per difficulty.
 *
 *   pnpm bots:measure                               # 200 duels per difficulty/range/start + FFA
 *   pnpm bots:measure --duels 60 --ffa 0            # quick duel-only pass
 *   pnpm bots:measure --difficulty hard --json out.json
 *   pnpm bots:measure --duels 0 --ffa 6 --ffa-vehicles on   # FFA with the trucks in play
 *
 * Deterministic: every duel/match is a pure function of its seed (independent of --workers).
 */
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { initPhysics } from '@wd/shared';
import type { BotDifficulty } from '../types.ts';
import {
  DuelBench,
  runFfa,
  type DuelRange,
  type DuelResult,
  type DuelStart,
  type FfaResult,
} from './harness.ts';
import { renderReport, type DuelCell } from './report.ts';

type Job =
  | {
      kind: 'duel';
      difficulty: BotDifficulty;
      range: DuelRange;
      start: DuelStart;
      seeds: [number, number];
    }
  | {
      kind: 'ffa';
      difficulty: BotDifficulty;
      seed: number;
      seconds: number;
      vehicles: 'on' | 'off';
    };
type JobResult =
  | { kind: 'duel'; job: Job & { kind: 'duel' }; results: DuelResult[] }
  | { kind: 'ffa'; job: Job & { kind: 'ffa' }; result: FfaResult };

const RANGES: DuelRange[] = ['close', 'mid', 'long'];
const STARTS: DuelStart[] = ['cold', 'hot'];

const jobOrder = (j: Extract<Job, { kind: 'duel' }>): number =>
  (RANGES.indexOf(j.range) * STARTS.length + STARTS.indexOf(j.start)) * 1e9 + j.seeds[0];

async function worker(): Promise<void> {
  await initPhysics();
  let bench: DuelBench | null = null;
  parentPort!.on('message', (job: Job | null) => {
    if (!job) {
      bench?.dispose();
      parentPort!.close();
      return;
    }
    if (job.kind === 'duel') {
      bench ??= new DuelBench();
      const results: DuelResult[] = [];
      for (let s = job.seeds[0]; s < job.seeds[1]; s++)
        results.push(bench.duel(job.difficulty, job.range, job.start, s));
      parentPort!.postMessage({ kind: 'duel', job, results } satisfies JobResult);
    } else {
      const result = runFfa(job.difficulty, job.seconds, job.seed, job.vehicles);
      parentPort!.postMessage({ kind: 'ffa', job, result } satisfies JobResult);
    }
  });
  parentPort!.postMessage({ ready: true });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      duels: { type: 'string', default: '200' },
      ffa: { type: 'string', default: '12' },
      'ffa-seconds': { type: 'string', default: '180' },
      difficulty: { type: 'string', multiple: true },
      workers: { type: 'string' },
      seed: { type: 'string', default: '1' },
      json: { type: 'string' },
      // The FFA matches with the Market's trucks in play (duels always on foot).
      'ffa-vehicles': { type: 'string', default: 'off' },
    },
  });
  const ffaVehicles = values['ffa-vehicles'] === 'on' ? 'on' : 'off';
  const duels = Number(values.duels);
  const ffaMatches = Number(values.ffa);
  const ffaSeconds = Number(values['ffa-seconds']);
  const base = Number(values.seed) * 1_000_000;
  const difficulties = (values.difficulty ?? ['easy', 'normal', 'hard']) as BotDifficulty[];
  const jobs: Job[] = [];
  // FFA first (the longest jobs), then duels in chunks.
  for (const difficulty of difficulties)
    for (let m = 0; m < ffaMatches; m++)
      jobs.push({
        kind: 'ffa',
        difficulty,
        seed: base + 900_000 + m,
        seconds: ffaSeconds,
        vehicles: ffaVehicles,
      });
  const chunk = 25;
  for (const difficulty of difficulties)
    for (const range of RANGES)
      for (const start of STARTS)
        for (let s = 0; s < duels; s += chunk)
          jobs.push({
            kind: 'duel',
            difficulty,
            range,
            start,
            seeds: [base + s, base + Math.min(duels, s + chunk)],
          });
  // Each worker holds its own Rapier world of the Market (~300 MB): 14 at once ran out of memory.
  const count = Math.max(
    1,
    Math.min(jobs.length, Number(values.workers ?? Math.min(8, availableParallelism() - 2))),
  );
  const t0 = performance.now();
  const done: JobResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url));
          const feed = (): void => {
            w.postMessage(next < jobs.length ? jobs[next++]! : null);
          };
          w.on('message', (m: JobResult | { ready: true }) => {
            if ('kind' in m) {
              done.push(m);
              process.stderr.write(`\r${done.length}/${jobs.length} jobs`);
            }
            feed();
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  process.stderr.write(`\n${((performance.now() - t0) / 1000).toFixed(0)} s, ${count} workers\n`);
  const cells: DuelCell[] = [];
  const byKey = (d: BotDifficulty, r: DuelRange | 'all', s: DuelStart | 'all'): DuelResult[] =>
    done
      .filter(
        (j): j is Extract<JobResult, { kind: 'duel' }> =>
          j.kind === 'duel' &&
          j.job.difficulty === d &&
          (r === 'all' || j.job.range === r) &&
          (s === 'all' || j.job.start === s),
      )
      // A fixed order (cell, then seed), whatever order the workers finished in.
      .sort((a, b) => jobOrder(a.job) - jobOrder(b.job))
      .flatMap((j) => j.results);
  if (duels > 0)
    for (const difficulty of difficulties) {
      for (const range of RANGES)
        for (const start of STARTS)
          cells.push({ difficulty, range, start, results: byKey(difficulty, range, start) });
      cells.push({
        difficulty,
        range: 'all',
        start: 'all',
        results: byKey(difficulty, 'all', 'all'),
      });
    }
  const ffa = new Map<BotDifficulty, FfaResult[]>();
  if (ffaMatches > 0)
    for (const difficulty of difficulties)
      ffa.set(
        difficulty,
        done
          .filter(
            (j): j is Extract<JobResult, { kind: 'ffa' }> =>
              j.kind === 'ffa' && j.job.difficulty === difficulty,
          )
          .sort((a, b) => a.job.seed - b.job.seed)
          .map((j) => j.result),
      );
  console.log(renderReport(cells, ffa));
  if (values.json) writeFileSync(values.json, JSON.stringify({ cells, ffa: [...ffa] }, null, 1));
}

if (isMainThread) await main();
else await worker();
