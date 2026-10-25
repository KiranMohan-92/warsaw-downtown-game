import type { ClientStats, ShotRecord } from './soakClient.ts';
import { bodyOutcome, shotVerdict } from './shotVerdict.ts';
import { dist, fmtDist, pct, type Dist } from './stats.ts';

/** Target-speed buckets for "hit rate vs speed" (m/s, lower bounds). */
export const SPEED_BUCKETS = [0, 1, 3, 5, 7] as const;
/** Interpolation-delay buckets (ms): 100 = a clean link; more = the jitter buffer grew. */
export const DELAY_BUCKETS = [0, 110, 150, 200] as const;

export interface FairnessSummary {
  shots: number;
  excluded: Record<string, number>;
  /** Aimed dead centre: how many the shooter's own trace showed hitting that body… */
  aimed: number;
  aimedPredicted: number;
  /** …and of those, how many the server confirmed (the fairness figure; target ≥ 95 %). */
  aimedConfirmed: number;
  /** Not confirmed on that body, but the same shot damaged somebody else (bodies crossing). */
  aimedOtherConfirmed: number;
  /** Deliberate misses the shooter's trace showed hitting nobody… */
  missed: number;
  missedPredictedClear: number;
  /**
   * …that the server still counted as a hit on a body the trace never struck (false hits;
   * target ≈ 0 %): the body the shot was aimed beside, or a bystander. Damage on a body drawn
   * spawn-protected is not one (its protection ended meanwhile: `ShotVerdict.exempt`).
   */
  missedFalseHits: number;
  /** Of those, the ones that landed on somebody other than the body aimed beside. */
  missedFalseHitsOnOthers: number;
  /** Every shot the shooter saw hit nobody, counted as a hit anyway (either intent). */
  clearPredicted: number;
  clearConfirmed: number;
  /**
   * Shots that ended on spawn-protected bodies only (left out above: blocked is neither a hit
   * nor a miss): how many struck a body drawn protected (the blocked marker), how many the
   * server blocked, how many both on one body, and how many damaged a body drawn protected
   * after all (protection ended meanwhile).
   */
  protectedShots: number;
  protectedDrawn: number;
  protectedServer: number;
  protectedBoth: number;
  protectedDrawnButHit: number;
  /** Aimed shots predicted as hits, by target speed bucket: [predicted, confirmed]. */
  bySpeed: { from: number; predicted: number; confirmed: number }[];
  /** The same by the interpolation delay the shooter drew with (ms, lower bounds). */
  byDelay: { from: number; predicted: number; confirmed: number }[];
  distance: Dist;
  speed: Dist;
}

export function fairness(shots: readonly ShotRecord[]): FairnessSummary {
  const excluded: Record<string, number> = {};
  const kept = shots.filter((s) => {
    if (s.excluded) excluded[s.excluded] = (excluded[s.excluded] ?? 0) + 1;
    return !s.excluded;
  });
  // Every figure is read off the per-body verdict: a fan strikes several bodies, so "the" body a
  // shot hit does not exist; what the script aimed at (or beside) is one body among them.
  const judged = kept.map((s) => {
    const v = shotVerdict(s);
    return { s, v, onTarget: bodyOutcome(v, s.target) };
  });
  type Judged = (typeof judged)[number];
  const hitAnyway = (j: Judged): boolean => j.v.falseHits.length > 0;
  const aimed = judged.filter((j) => j.s.intent === 'aim');
  // Predicted hits on the aimed-at body that protection does not explain away.
  const aimedPredicted = aimed.filter(
    (j) => j.onTarget === 'confirmed' || j.onTarget === 'unconfirmed',
  );
  const aimedConfirmed = aimedPredicted.filter((j) => j.onTarget === 'confirmed');
  const missed = judged.filter((j) => j.s.intent === 'miss');
  const missedClear = missed.filter((j) => j.s.hits.length === 0);
  const clear = judged.filter((j) => j.s.hits.length === 0);
  const guarded = shots.filter((s) => s.excluded === 'target protected');
  const bucket = (bounds: readonly number[], value: (s: ShotRecord) => number) =>
    bounds.map((from, i) => {
      const to = bounds[i + 1] ?? Infinity;
      const within = (j: Judged): boolean => value(j.s) >= from && value(j.s) < to;
      return {
        from,
        predicted: aimedPredicted.filter(within).length,
        confirmed: aimedConfirmed.filter(within).length,
      };
    });
  const bySpeed = bucket(SPEED_BUCKETS, (s) => s.speed);
  const byDelay = bucket(DELAY_BUCKETS, (s) => s.delayMs);
  return {
    shots: shots.length,
    excluded,
    aimed: aimed.length,
    aimedPredicted: aimedPredicted.length,
    aimedConfirmed: aimedConfirmed.length,
    aimedOtherConfirmed: aimedPredicted.filter(
      (j) => j.onTarget === 'unconfirmed' && j.v.confirmed.length + j.v.falseHits.length > 0,
    ).length,
    missed: missed.length,
    missedPredictedClear: missedClear.length,
    missedFalseHits: missedClear.filter(hitAnyway).length,
    missedFalseHitsOnOthers: missedClear.filter((j) =>
      j.v.falseHits.some((id) => id !== j.s.target),
    ).length,
    clearPredicted: clear.length,
    clearConfirmed: clear.filter(hitAnyway).length,
    protectedShots: guarded.length,
    protectedDrawn: guarded.filter((s) => s.shielded.length > 0).length,
    protectedServer: guarded.filter((s) => s.blocked.length > 0).length,
    protectedBoth: guarded.filter((s) => s.shielded.some((id) => s.blocked.includes(id))).length,
    protectedDrawnButHit: guarded.filter((s) => s.shielded.some((id) => s.damaged.includes(id)))
      .length,
    bySpeed,
    byDelay,
    distance: dist(aimedPredicted.map((j) => j.s.distance)),
    speed: dist(aimedPredicted.map((j) => j.s.speed)),
  };
}

/** Pass/fail limits for a run. */
export interface Thresholds {
  /** Confirmed / predicted for dead-centre shots. */
  minConfirmRate: number;
  /** Server hits / predicted-clear for deliberate misses. */
  maxFalseHitRate: number;
  /** Fewer predicted hits than this = inconclusive (fails). */
  minSamples: number;
  /** Per-client snapshot arrivals per second, at least. */
  minSnapshotRate: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minConfirmRate: 0.95,
  maxFalseHitRate: 0.01,
  minSamples: 30,
  minSnapshotRate: 27,
};

/** Every check that failed (empty = pass). */
export function verdict(
  f: FairnessSummary,
  t: Thresholds,
  extra: {
    snapshotRates: readonly { name: string; rate: number }[];
    errors: number;
    /** The drivers' mispredictions away from others (prediction must be exact: 0). */
    driverCorrections?: number;
  },
): string[] {
  const fails: string[] = [];
  if ((extra.driverCorrections ?? 0) > 0) {
    fails.push(`${extra.driverCorrections} driver mispredictions (nobody near): must be 0`);
  }
  if (f.aimedPredicted < t.minSamples) {
    fails.push(`only ${f.aimedPredicted} predicted hits (need ${t.minSamples}): inconclusive`);
  } else if (f.aimedConfirmed / f.aimedPredicted < t.minConfirmRate) {
    fails.push(
      `hit confirm ${pct(f.aimedConfirmed, f.aimedPredicted)} < ${(t.minConfirmRate * 100).toFixed(0)} %`,
    );
  }
  if (f.missedPredictedClear && f.missedFalseHits / f.missedPredictedClear > t.maxFalseHitRate) {
    fails.push(`false hits ${pct(f.missedFalseHits, f.missedPredictedClear)}`);
  }
  // Every client on its own: a pooled mean would let one starved client hide behind the rest.
  if (!extra.snapshotRates.length) fails.push('no client reported a snapshot rate');
  for (const c of extra.snapshotRates) {
    if (c.rate < t.minSnapshotRate) {
      fails.push(`${c.name}: snapshot rate ${c.rate.toFixed(1)}/s < ${t.minSnapshotRate}/s`);
    }
  }
  if (extra.errors > 0) fails.push(`${extra.errors} client errors/disconnects`);
  return fails;
}

export interface ClientTotals {
  corrections: number;
  correctionsPerMin: number;
  correctionError: Dist;
  /** Corrections that left the body where it was (damage taken, kit counts). */
  stateCorrections: number;
  /** Corrections at a death (the body stops where the server's shot found it). */
  deathCorrections: number;
  /** Corrections while touching another player (soft-push collision), and their size (m). */
  contactCorrections: number;
  contactError: Dist;
  /** Trucks: seat changes (expected), the driver's mispredictions (must be 0), time in seats. */
  seatCorrections: number;
  driverCorrections: number;
  driverError: Dist;
  drivingSeconds: number;
  ridingSeconds: number;
  respawns: number;
  /** Jetpack flights lit, seconds flown, pickups the server granted, mispredictions in flight. */
  flights: number;
  flySeconds: number;
  jetGrants: number;
  flyCorrections: number;
  /** Snapshot arrivals per second: the mean over the clients (a statistic)… */
  snapshotRate: number;
  /** …and each client's own (what the verdict checks). */
  snapshotRates: { name: string; rate: number }[];
  snapInterval: Dist;
  interpDelay: Dist;
  /** CPU time per client frame (ms). */
  frameCost: Dist;
  errors: string[];
}

/** The clients' network figures, summed / pooled over `seconds` of play. */
export function clientTotals(clients: readonly ClientStats[], seconds: number): ClientTotals {
  const corrections = clients.reduce((a, c) => a + c.corrections, 0);
  const snaps = clients.reduce((a, c) => a + c.snapshots, 0);
  return {
    corrections,
    correctionsPerMin: seconds > 0 ? corrections / clients.length / (seconds / 60) : 0,
    correctionError: dist(clients.flatMap((c) => c.correctionErrors)),
    stateCorrections: clients.reduce((a, c) => a + c.stateCorrections, 0),
    deathCorrections: clients.reduce((a, c) => a + c.deathCorrections, 0),
    contactCorrections: clients.reduce((a, c) => a + c.contactCorrections, 0),
    contactError: dist(clients.flatMap((c) => c.contactErrors)),
    seatCorrections: clients.reduce((a, c) => a + (c.seatCorrections ?? 0), 0),
    driverCorrections: clients.reduce((a, c) => a + (c.driverCorrections ?? 0), 0),
    driverError: dist(clients.flatMap((c) => c.driverErrors ?? [])),
    drivingSeconds: clients.reduce((a, c) => a + (c.drivingSteps ?? 0), 0) / 60,
    ridingSeconds: clients.reduce((a, c) => a + (c.ridingSteps ?? 0), 0) / 60,
    respawns: clients.reduce((a, c) => a + c.respawns, 0),
    flights: clients.reduce((a, c) => a + (c.flights ?? 0), 0),
    flySeconds: clients.reduce((a, c) => a + (c.flySeconds ?? 0), 0),
    jetGrants: clients.reduce((a, c) => a + (c.jetGrants ?? 0), 0),
    flyCorrections: clients.reduce((a, c) => a + (c.flyCorrections ?? 0), 0),
    snapshotRate: seconds > 0 && clients.length ? snaps / clients.length / seconds : 0,
    snapshotRates: clients.map((c) => ({
      name: c.name,
      rate: seconds > 0 ? c.snapshots / seconds : 0,
    })),
    snapInterval: dist(clients.flatMap((c) => c.snapIntervals)),
    interpDelay: dist(clients.flatMap((c) => c.interpDelays)),
    frameCost: dist(clients.flatMap((c) => c.frameCost)),
    errors: clients.flatMap((c) => c.errors.map((e) => `${c.name}: ${e}`)),
  };
}

const buckets = (rows: FairnessSummary['bySpeed'], bounds: readonly number[]): string[] =>
  rows.map((b, i) => {
    const to = bounds[i + 1];
    return `  ${b.from}${to !== undefined ? `-${to}` : '+'}: ${pct(b.confirmed, b.predicted)}`;
  });

export function formatFairness(f: FairnessSummary): string[] {
  const lines = [
    `shots fired ${f.shots} (left out: ${
      Object.entries(f.excluded)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    })`,
    `dead-centre shots ${f.aimed}; the shooter's own trace hit the body in ${pct(f.aimedPredicted, f.aimed)}`,
    `  server confirmed ${pct(f.aimedConfirmed, f.aimedPredicted)}  <- hit-confirm rate (target >= 95 %)`,
    `  confirmed on someone else ${f.aimedOtherConfirmed}`,
    `deliberate misses ${f.missed}; seen clear by the shooter ${f.missedPredictedClear}`,
    `  server counted a hit anyway ${pct(f.missedFalseHits, f.missedPredictedClear)}  <- false hits (target ~0 %; ${f.missedFalseHitsOnOthers} on a bystander)`,
    `any shot seen clear, hit anyway ${pct(f.clearConfirmed, f.clearPredicted)}`,
    `spawn-protected targets: ${f.protectedShots} shots left out (drawn protected ${f.protectedDrawn}, blocked by the server ${f.protectedServer}, both ${f.protectedBoth}; drawn protected but damaged ${f.protectedDrawnButHit})`,
    `hit confirm by target speed (m/s):`,
    ...buckets(f.bySpeed, SPEED_BUCKETS),
    `hit confirm by the shooter's interpolation delay (ms; 100 = clean link):`,
    ...buckets(f.byDelay, DELAY_BUCKETS),
    `predicted-hit distance m p50/p95/p99/max ${fmtDist(f.distance)}, target speed m/s ${fmtDist(f.speed)}`,
  ];
  return lines;
}

export function formatClients(t: ClientTotals): string[] {
  return [
    `snapshots ${t.snapshotRate.toFixed(2)}/s per client (slowest ${Math.min(...t.snapshotRates.map((c) => c.rate), Infinity).toFixed(2)}/s); arrival interval ms p50/p95/p99/max ${fmtDist(t.snapInterval)}`,
    `interpolation delay ms p50/p95/p99/max ${fmtDist(t.interpDelay)}`,
    `client frame CPU ms p50/p95/p99/max ${fmtDist(t.frameCost, 2)}`,
    `mispredictions (corrections that moved a living player, nobody near) ${t.corrections} (${t.correctionsPerMin.toFixed(2)}/min per client; size m ${fmtDist(t.correctionError, 3)})`,
    `  in contact with another player (soft push) ${t.contactCorrections} (size m ${fmtDist(t.contactError, 3)})`,
    `  expected corrections: damage/kit only ${t.stateCorrections}, deaths ${t.deathCorrections}, respawns ${t.respawns}, seat changes ${t.seatCorrections}`,
    `jetpack: flights ${t.flights}, ${t.flySeconds.toFixed(1)} s flown, pickups granted ${t.jetGrants}, mispredictions in flight ${t.flyCorrections}`,
    `trucks: driven ${t.drivingSeconds.toFixed(0)} s, ridden ${t.ridingSeconds.toFixed(0)} s (all clients); driver mispredictions (nobody near) ${t.driverCorrections} (size m ${fmtDist(t.driverError, 3)})  <- target 0`,
    `errors/disconnects ${t.errors.length}${t.errors.length ? `: ${t.errors.slice(0, 5).join('; ')}` : ''}`,
  ];
}

export function formatScores(clients: readonly ClientStats[]): string[] {
  return [
    `scores (kills/deaths): ${clients.map((c) => `${c.name} ${c.kills}/${c.deaths}`).join(', ')}`,
  ];
}
