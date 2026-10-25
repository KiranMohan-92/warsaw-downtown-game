import { BOT } from '@wd/shared';
import type { BotDifficulty } from '../types.ts';
import {
  meanCi,
  wilson,
  type DuelRange,
  type DuelResult,
  type DuelStart,
  type FfaResult,
  type SideStats,
} from './harness.ts';

/** Aggregates of a set of duels from one side's point of view (bot or reference). */
export interface SideSummary {
  n: number;
  /** Duels this side won / lost (the other side's kill); trades and timeouts are neither. */
  wins: number;
  losses: number;
  /** Both died in the same tick. */
  trades: number;
  /** Nobody died before the timeout. */
  draws: number;
  /** The tuning target: wins / (wins + losses). */
  winRate: number;
  winCi: [number, number];
  /** Wins / all duels (trades and timeouts count as not won). */
  winAllRate: number;
  /** First sight → first shot (ms). */
  reaction: { mean: number; half: number; n: number };
  firstShotAcc: number;
  firstShotCi: [number, number];
  accuracy: number;
  accCi: [number, number];
  headShare: number;
  headCi: [number, number];
  /** The side's first shot → its kill (ms), over the duels it won. */
  ttk: { mean: number; half: number; n: number };
}

export function summarize(results: readonly DuelResult[], side: 'bot' | 'ref'): SideSummary {
  const s = (r: DuelResult): SideStats => r[side];
  const wins = results.filter((r) => r.winner === side).length;
  const losses = results.filter((r) => r.winner === (side === 'bot' ? 'ref' : 'bot')).length;
  const trades = results.filter((r) => r.winner === 'trade').length;
  const draws = results.filter((r) => r.winner === 'draw').length;
  const decided = wins + losses;
  const reactions = results
    .map((r) =>
      s(r).sawMs !== null && s(r).firstShotMs !== null ? s(r).firstShotMs! - s(r).sawMs! : null,
    )
    .filter((x): x is number => x !== null);
  const first = results.filter((r) => s(r).firstShotHit !== null);
  const firstHits = first.filter((r) => s(r).firstShotHit).length;
  const shots = results.reduce((a, r) => a + s(r).shots, 0);
  const hits = results.reduce((a, r) => a + s(r).hits, 0);
  const heads = results.reduce((a, r) => a + s(r).headHits, 0);
  const ttk = results.filter((r) => r.winner === side && r.ttkMs !== null).map((r) => r.ttkMs!);
  return {
    n: results.length,
    wins,
    losses,
    trades,
    draws,
    winRate: decided ? wins / decided : NaN,
    winCi: wilson(wins, decided),
    winAllRate: results.length ? wins / results.length : NaN,
    reaction: meanCi(reactions),
    firstShotAcc: first.length ? firstHits / first.length : NaN,
    firstShotCi: wilson(firstHits, first.length),
    accuracy: shots ? hits / shots : NaN,
    accCi: wilson(hits, shots),
    headShare: hits ? heads / hits : NaN,
    headCi: wilson(heads, hits),
    ttk: meanCi(ttk),
  };
}

export interface FfaSummary {
  matches: number;
  minutes: number;
  botKillsPerMin: number;
  refKillsPerMin: number;
  refDeathsPerMin: number;
  refKd: number;
  refSpawnDeaths15: number;
  refSpawnDeaths3: number;
  refSpawnDeaths5: number;
  refDeaths: number;
  botSpawnDeaths15: number;
  botSpawnDeaths3: number;
  botDeaths: number;
  refAccuracy: number;
  botHeadShareOnRef: number;
  /** Per-match bot kills/min (mean ± 95 %). */
  botKpmCi: { mean: number; half: number; n: number };
  refKpmCi: { mean: number; half: number; n: number };
}

export function summarizeFfa(results: readonly FfaResult[]): FfaSummary {
  const sum = (f: (r: FfaResult) => number): number => results.reduce((a, r) => a + f(r), 0);
  const minutes = sum((r) => r.minutes);
  const refDeaths = sum((r) => r.refDeaths);
  return {
    matches: results.length,
    minutes,
    botKillsPerMin: sum((r) => r.botKills) / (minutes * 5),
    refKillsPerMin: sum((r) => r.refKills) / minutes,
    refDeathsPerMin: refDeaths / minutes,
    refKd: sum((r) => r.refKills) / Math.max(1, refDeaths),
    refSpawnDeaths15: sum((r) => r.refSpawnDeaths15),
    refSpawnDeaths3: sum((r) => r.refSpawnDeaths3),
    refSpawnDeaths5: sum((r) => r.refSpawnDeaths5),
    refDeaths,
    botSpawnDeaths15: sum((r) => r.botSpawnDeaths15),
    botSpawnDeaths3: sum((r) => r.botSpawnDeaths3),
    botDeaths: sum((r) => r.botDeaths),
    refAccuracy:
      sum((r) => r.refHits) /
      Math.max(
        1,
        sum((r) => r.refShots),
      ),
    botHeadShareOnRef:
      sum((r) => r.botHeadHitsOnRef) /
      Math.max(
        1,
        sum((r) => r.botHitsOnRef),
      ),
    botKpmCi: meanCi(results.map((r) => r.botKills / (r.minutes * r.bots))),
    refKpmCi: meanCi(results.map((r) => r.refKills / r.minutes)),
  };
}

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}` : '–');
const ci = (c: [number, number]): string => `${pct(c[0])}–${pct(c[1])}`;
const ms = (m: { mean: number; half: number; n: number }): string =>
  m.n ? `${m.mean.toFixed(0)} ± ${m.half.toFixed(0)}` : '–';

export interface DuelCell {
  difficulty: BotDifficulty;
  range: DuelRange | 'all';
  start: DuelStart | 'all';
  results: DuelResult[];
}

/** Markdown tables: duels per difficulty × range × start, the reference, and the FFA. */
export function renderReport(
  cells: readonly DuelCell[],
  ffa: ReadonlyMap<BotDifficulty, readonly FfaResult[]>,
): string {
  const lines: string[] = [];
  lines.push(
    '### Duels vs the reference (mid-fight: spawn protection off; AR-7 both, no frags; win % = wins / (wins + losses), 95 % CI)',
    '',
    '| difficulty | range | start | n | bot win % | win % of all | trades | timeouts | bot reaction ms | 1st-shot hit % | accuracy % | head % of hits | bot TTK ms | ref reaction ms | ref acc % | ref head % |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const c of cells) {
    const b = summarize(c.results, 'bot');
    const r = summarize(c.results, 'ref');
    lines.push(
      `| ${c.difficulty} | ${c.range} | ${c.start} | ${b.n} | **${pct(b.winRate)}** (${ci(b.winCi)}) | ${pct(b.winAllRate)} | ${b.trades} | ${b.draws} | ${ms(b.reaction)} | ${pct(b.firstShotAcc)} (${ci(b.firstShotCi)}) | ${pct(b.accuracy)} | ${pct(b.headShare)} (${ci(b.headCi)}) | ${ms(b.ttk)} | ${ms(r.reaction)} | ${pct(r.accuracy)} | ${pct(r.headShare)} |`,
    );
  }
  const all = cells.filter((c) => c.range === 'all' && c.start === 'all');
  if (all.length) {
    lines.push(
      '',
      "### Duels by personality (the same duels, split by the bot's personality)",
      '',
      '| difficulty | personality | n | bot win % | head % of hits | bot reaction ms | accuracy % |',
      '|---|---|---|---|---|---|---|',
    );
    for (const c of all)
      for (const persona of BOT.personalityOrder) {
        const b = summarize(
          c.results.filter((r) => r.personality === persona),
          'bot',
        );
        lines.push(
          `| ${c.difficulty} | ${persona} | ${b.n} | ${pct(b.winRate)} (${ci(b.winCi)}) | ${pct(b.headShare)} | ${ms(b.reaction)} | ${pct(b.accuracy)} |`,
        );
      }
  }
  if (ffa.size) {
    lines.push(
      '',
      '### FFA: 1 reference + 5 bots on the Market (spawn protection on; bots draw their primary per life; reference AR-7)',
      '',
      '| difficulty | matches × min | bot kills/min | ref kills/min | ref deaths/min | ref K/D | ref spawn deaths < 1.5 s | < 3 s | < 5 s | bot spawn deaths < 1.5 s | < 3 s | bot head % on ref | ref acc % |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const [d, rs] of ffa) {
      const f = summarizeFfa(rs);
      const share = (k: number, n: number): string => `${k}/${n} (${pct(n ? k / n : NaN)} %)`;
      lines.push(
        `| ${d} | ${f.matches} × ${(f.minutes / Math.max(1, f.matches)).toFixed(0)} | ${f.botKpmCi.mean.toFixed(2)} ± ${f.botKpmCi.half.toFixed(2)} | ${f.refKpmCi.mean.toFixed(2)} ± ${f.refKpmCi.half.toFixed(2)} | ${f.refDeathsPerMin.toFixed(2)} | ${f.refKd.toFixed(2)} | ${share(f.refSpawnDeaths15, f.refDeaths)} | ${share(f.refSpawnDeaths3, f.refDeaths)} | ${share(f.refSpawnDeaths5, f.refDeaths)} | ${share(f.botSpawnDeaths15, f.botDeaths)} | ${share(f.botSpawnDeaths3, f.botDeaths)} | ${pct(f.botHeadShareOnRef)} | ${pct(f.refAccuracy)} |`,
      );
    }
    const trucks = [...ffa].filter(([, rs]) => rs.some((r) => r.truck));
    if (trucks.length) {
      lines.push(
        '',
        '### FFA trucks (bots at the wheel / riding, per match minute; kills by the trucks)',
        '',
        '| difficulty | driven s/min | mean speed at the wheel m/s | under way (> 1 m/s) | > 5 m/s | ridden s/min | kills from a seat | run-over kills | explosion kills | trucks destroyed |',
        '|---|---|---|---|---|---|---|---|---|---|',
      );
      for (const [d, rs] of trucks) {
        const min = rs.reduce((a, r) => a + r.minutes, 0) || 1;
        const sum = (k: keyof NonNullable<FfaResult['truck']>): number =>
          rs.reduce((a, r) => a + (r.truck?.[k] ?? 0), 0);
        lines.push(
          `| ${d} | ${(sum('drivenSeconds') / min).toFixed(1)} | ${(sum('drivenMeters') / Math.max(1e-9, sum('drivenSeconds'))).toFixed(2)} | ${pct(sum('movingSeconds') / Math.max(1e-9, sum('drivenSeconds')))} % | ${pct(sum('fastSeconds') / Math.max(1e-9, sum('drivenSeconds')))} % | ${(sum('riddenSeconds') / min).toFixed(1)} | ${sum('seatKills')} | ${sum('runOverKills')} | ${sum('explosionKills')} | ${sum('destroyed')} |`,
        );
      }
    }
    lines.push(
      '',
      '### FFA jetpacks (3 per match; one match = one clock run, no reset)',
      '',
      '| difficulty | pickups | bot flights | ref flights | air shots | air hit % | kills from the air (of all kills) | …of them on the ref | flyers killed in the air | …in the flight window (air or landed) |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const [d, rs] of ffa) {
      const s = (f: (r: FfaResult) => number): number => rs.reduce((a, r) => a + f(r), 0);
      const kills = s((r) => r.botKills + r.refKills);
      lines.push(
        `| ${d} | ${s((r) => r.jetPickups)} | ${s((r) => r.jetFlights)} | ${s((r) => r.refJetFlights)} | ${s((r) => r.airShots)} | ${pct(
          s((r) => r.airHits) /
            Math.max(
              1,
              s((r) => r.airShots),
            ),
        )} | ${s((r) => r.airKills)}/${kills} | ${s((r) => r.airKillsOnRef)} | ${s((r) => r.airDeaths)} | ${s((r) => r.windowDeaths)} |`,
      );
    }
  }
  return lines.join('\n');
}
