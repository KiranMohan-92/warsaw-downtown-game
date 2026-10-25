import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOT, Button, createPlayerState, initPhysics } from '@wd/shared';
import { playerObservation } from '../observation.ts';
import type { BotDifficulty, BotObservation } from '../types.ts';
import { DuelBench, type DuelRange, type DuelResult, type DuelStart } from './harness.ts';
import { ReferencePlayer } from './referencePlayer.ts';
import { summarize } from './report.ts';

/**
 * A short, seeded slice of `pnpm bots:measure`: duels on the Market against the reference
 * player, the same seeds for every difficulty (paired), so the ordering is stable. The full
 * tool (hundreds of duels per cell, FFA) is what the difficulty tunables are tuned with.
 * Duels run without spawn protection (mid-fight encounters); the FFA keeps it on.
 */
let bench: DuelBench;
const results = new Map<BotDifficulty, DuelResult[]>();
const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];
const CELLS: [DuelRange, DuelStart][] = [
  ['close', 'cold'],
  ['close', 'hot'],
  ['mid', 'cold'],
  ['mid', 'hot'],
];
const PER_CELL = 12;

beforeAll(async () => {
  await initPhysics();
  bench = new DuelBench(120);
  for (const d of DIFFICULTIES) {
    const out: DuelResult[] = [];
    for (const [range, start] of CELLS)
      for (let s = 1; s <= PER_CELL; s++) out.push(bench.duel(d, range, start, s));
    results.set(d, out);
  }
}, 120_000);

afterAll(() => bench?.dispose());

describe('bot difficulty ordering (measured against the reference player)', () => {
  it('wins more duels from easy to normal to hard, and hard stays beatable', () => {
    const [easy, normal, hard] = DIFFICULTIES.map((d) => summarize(results.get(d)!, 'bot'));
    expect(easy!.winRate).toBeLessThan(normal!.winRate);
    expect(normal!.winRate).toBeLessThan(hard!.winRate);
    expect(hard!.winRate).toBeLessThan(0.9);
    expect(easy!.winRate).toBeGreaterThan(0.05);
  });

  it('reacts slower from hard to normal to easy (first sight to first shot)', () => {
    const [easy, normal, hard] = DIFFICULTIES.map((d) => summarize(results.get(d)!, 'bot'));
    expect(hard!.reaction.mean).toBeLessThan(normal!.reaction.mean);
    expect(normal!.reaction.mean).toBeLessThan(easy!.reaction.mean);
    // No instant shots: even hard takes a human-scale moment.
    expect(hard!.reaction.mean).toBeGreaterThan(150);
    expect(easy!.reaction.mean).toBeGreaterThan(450);
  });

  it('aims at centre mass mostly (no headshot aimbot) and never turns past its turn rate', () => {
    for (const d of DIFFICULTIES) {
      const r = results.get(d)!;
      expect(summarize(r, 'bot').headShare, d).toBeLessThan(0.35);
      const fastest = Math.max(...r.map((x) => x.botMaxTurnRate));
      expect(fastest, d).toBeLessThanOrEqual(BOT.difficulty[d].turnRate + 1e-6);
    }
  });

  it('the reference player lands a human share of its shots', () => {
    const all = DIFFICULTIES.flatMap((d) => results.get(d)!);
    const ref = summarize(all, 'ref');
    expect(ref.accuracy).toBeGreaterThan(0.3);
    expect(ref.accuracy).toBeLessThan(0.7);
    expect(ref.reaction.mean).toBeGreaterThan(350);
  });
});

/**
 * `pnpm bots:measure` splits duels across workers, each reusing its own `DuelBench`, so a
 * worker's history (which duels ran before, in which order) must never change a duel's
 * outcome: a second "worker" re-running some of the duels above, out of order and across
 * cells and difficulties, must reproduce them exactly.
 */
describe('bot measurement is independent of the worker split', () => {
  it('a second bench, another order, the same seeds: identical duels', () => {
    const two = new DuelBench(120);
    try {
      const picks: [BotDifficulty, number][] = [
        ['hard', 47],
        ['easy', 30],
        ['normal', 13],
        ['hard', 2],
        ['easy', 20],
        ['normal', 38],
      ];
      for (const [d, i] of picks) {
        const [range, start] = CELLS[Math.floor(i / PER_CELL)]!;
        const again = two.duel(d, range, start, (i % PER_CELL) + 1);
        expect(again, `${d} #${i}`).toEqual(results.get(d)![i]);
      }
    } finally {
      two.dispose();
    }
  }, 60_000);
});

describe('the reference player respects spawn protection (FFA runs keep it on)', () => {
  /** Two seconds facing a standing target 12 m ahead: did the reference ever pull the trigger? */
  function fires(protectedTarget: boolean): boolean {
    const own = createPlayerState({ x: 0, y: 0, z: 0 });
    const human = new ReferencePlayer(7);
    const self = playerObservation({ id: 'ref', name: 'R', slot: 0, isBot: false, state: own });
    for (let t = 0; t < 120; t++) {
      const obs: BotObservation = {
        nowMs: (t * 1000) / 60,
        seq: t,
        map: bench.sim.map,
        nav: bench.nav,
        self,
        visiblePlayers: [
          {
            id: 'bot',
            name: 'Bot',
            isBot: true,
            pos: { x: 0, y: 0, z: -12 },
            eye: { x: 0, y: 1.62, z: -12 },
            yaw: Math.PI,
            pitch: 0,
            slot: 1,
            visibility: 1,
            protected: protectedTarget,
            reloading: false,
          },
        ],
        memories: [],
        smoke: [],
        mode: 'standard',
      };
      if (human.decide(obs, own, 1 / 60).buttons & Button.Fire) return true;
    }
    return false;
  }

  it('holds fire on a shimmering target (no wasted shots, its own protection kept)', () => {
    expect(fires(true)).toBe(false);
    expect(fires(false)).toBe(true);
  });

  it('duels run with protection off', () => {
    expect(bench.sim.config.spawnProtection).toBe(0);
    expect(bench.ref.state.spawnGuard).toBe(0);
  });
});
