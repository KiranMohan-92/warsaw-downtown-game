import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '@wd/shared';
import { DEFAULT_LINK } from './delayLine.ts';
import { clientTotals, fairness, formatClients, formatFairness } from './report.ts';
import { RewindProbe } from './rewindProbe.ts';
import { soakWorld, type SoakWorld } from './soakClient.ts';
import { dist, fmtDist, pct } from './stats.ts';
import { VirtualMatch } from './virtualMatch.ts';

// The M3 done-criterion "hits feel fair at 100 ms", on a virtual clock: headless clients running
// the browser's own session code against MatchSim, every message 50 ms each way. Deterministic
// (seeded links, seeded behaviour trees, fixed steps), so it doesn't flake under load; the real
// sockets and the real room are `pnpm soak`.
let world: SoakWorld;

beforeAll(async () => {
  await initPhysics();
  world = await soakWorld('range', 'full');
});

describe('soak: fairness at 100 and 150 ms round trip (virtual clock)', () => {
  it('replays unseeded construction with the same clients and delayed inputs', () => {
    const config = { map: 'range', size: 'full', mode: 'standard', botCount: 0 } as const;
    const a = new VirtualMatch(config, DEFAULT_LINK, DEFAULT_LINK);
    const b = new VirtualMatch({ ...config, spawnSeed: 0 }, DEFAULT_LINK, DEFAULT_LINK);
    try {
      for (const vm of [a, b]) {
        vm.join(world, { name: 'Soak 1', seed: 11 });
        vm.join(world, { name: 'Soak 2', seed: 12 });
      }
      for (let ms = 100; ms <= 3000; ms += 100) {
        a.runUntil(ms);
        b.runUntil(ms);
        expect(a.sim.snapshot()).toEqual(b.sim.snapshot());
      }
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it.each(
    [0, 1, 2].flatMap((spawnSeed) => [
      { rtt: 100, link: DEFAULT_LINK, spawnSeed },
      { rtt: 150, link: { ...DEFAULT_LINK, delayMs: 75 }, spawnSeed },
    ]),
  )(
    '$rtt ms / spawn seed $spawnSeed: dead-centre shots are confirmed; deliberate misses are not',
    ({ link, spawnSeed }) => {
      const vm = new VirtualMatch(
        { map: 'range', size: 'full', mode: 'standard', botCount: 0, spawnSeed },
        link,
        link,
      );
      const rewind = new RewindProbe();
      rewind.install(vm.sim);
      const clients = [0, 1, 2, 3].map((i) =>
        vm.join(world, { name: `Soak ${i + 1}`, seed: 11 + i }),
      );
      const seconds = 90;
      vm.runUntil(seconds * 1000);
      vm.dispose();
      const f = fairness(clients.flatMap((c) => c.judged));
      const t = clientTotals(
        clients.map((c) => c.stats()),
        seconds,
      );
      const lag = dist(rewind.lagMs.values);
      const report = [
        ...formatFairness(f),
        ...formatClients(t),
        `rewind asked ms p50/p95/p99/max ${fmtDist(lag)}; over the cap ${pct(rewind.clamped, rewind.shots)}`,
      ].join('\n');
      if (process.env.SOAK_VERBOSE) console.log(report);
      expect(f.aimedPredicted, report).toBeGreaterThanOrEqual(30);
      expect(f.aimedConfirmed / f.aimedPredicted, report).toBeGreaterThanOrEqual(0.95);
      expect(f.missedPredictedClear, report).toBeGreaterThanOrEqual(8);
      expect(f.missedFalseHits, report).toBe(0);
      // The per-player rewind cap covers what an honest client asks for: nothing is clamped.
      expect(rewind.shots, report).toBeGreaterThan(50);
      expect(rewind.clamped, report).toBe(0);
      expect(t.errors, report).toEqual([]);
      expect(t.snapshotRate, report).toBeGreaterThan(28);
      // Same code, same map, a clean link: away from other players prediction never disagrees
      // with the server. Touching someone (soft-push collision) it may: each side resolves the
      // push against the other as of its own newest snapshot, and the replay of the unacked
      // inputs carries the difference (a few cm typically; a head-on bump can shift the replay
      // by up to one unacknowledged window of walking).
      expect(t.corrections, report).toBe(0);
      expect(t.contactCorrections, report).toBeLessThan(60);
      expect(t.contactError.p50, report).toBeLessThan(0.15);
      expect(t.contactError.max, report).toBeLessThan(1);
    },
    180_000,
  );
});
