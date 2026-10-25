/**
 * Snapshot pacing: turns coarse, irregular timer wake-ups into whole fixed 60 Hz sim ticks of
 * measured real time (like `FixedTicker`) *and* sends the 30 Hz snapshots on an even cadence.
 *
 * Why: Node's timers fire on a 15.6 ms grid on Windows (every timer is late by 0–15.6 ms), so a
 * plain `setInterval(16.67)` wakes every ~31 ms and snapshots left 31 / 62 ms apart (and now and
 * then two nearly together). Remote players are interpolated on those arrivals, so uneven
 * sending is jitter the client has to buffer.
 *
 * How, per wake-up (`step(now)`):
 * - Every tick whose nominal time (`origin + n × stepMs`) has passed runs, as before: server time
 *   never runs ahead of the clock by more than `lead` (below), and the sim steps are exactly the
 *   same fixed 1/60 s steps whatever the timer does (deterministic).
 * - Snapshot ticks (every `snapshotEvery`th) are aimed at their absolute nominal time:
 *   - if it is at most `spinMs` away, the caller busy-waits until then (`spinUntil`) and calls
 *     again: a short high-resolution catch-up, bounded per snapshot (`spinMs`);
 *   - if the next coarse wake-up would come too late, the snapshot tick may run up to `lead`
 *     early (half the measured timer granularity, ≤ `maxLeadMs`): the snapshot then goes at the
 *     nearest wake-up instead of always the next one. (≈ 0.5 ms on a fine-grained timer.)
 * - Two snapshots never leave closer than `minGapRatio` × the snapshot period: after a late one
 *   (a stall), the next is held back instead of bunched behind it.
 * - The caller sleeps `sleepMs` (≥ 1, ≤ one sim step) between calls: on a coarse timer that
 *   means waking at every grid point near a target, on a fine one close to it.
 *
 * The timer granularity is learned from how late wake-ups actually come (a decaying peak), so
 * the same code paces well on Linux (≈ 1 ms timers) and Windows (15.6 ms). Time is injected
 * (pure: tests drive it with a fake clock).
 */
export interface PacerConfig {
  /** Sim step (ms). */
  stepMs: number;
  /** A snapshot every this many sim ticks. */
  snapshotEvery: number;
  /** Ticks run per call at most (the rest carries over). */
  maxPerCall: number;
  /** Real time caught up on at most after a stall (ms); beyond this it is skipped. */
  maxBacklogMs: number;
  /** Busy-wait at most this long to send a snapshot on time (ms). */
  spinMs: number;
  /** A snapshot tick runs at most this early (ms), and at most half the timer granularity. */
  maxLeadMs: number;
  /** Two snapshots never leave closer than this × the snapshot period. */
  minGapRatio: number;
}

export interface PacerStep {
  /** Sim ticks to run now. */
  ticks: number;
  /** Send a snapshot after running them. */
  snapshot: boolean;
  /** A snapshot is due within `spinMs`: busy-wait until this time, then call `step` again. */
  spinUntil: number | null;
  /** Otherwise sleep this long (ms, whole, ≥ 1) before the next call. */
  sleepMs: number;
}

export class SnapshotPacer {
  /** Time of tick 0 (moves forward when a stall's excess is skipped). */
  private origin: number;
  /** Ticks run so far. */
  private ticks = 0;
  /** A snapshot tick ran but its snapshot is held back (min gap). */
  private held = false;
  private lastSnap = Number.NEGATIVE_INFINITY;

  /**
   * The snapshot just left (after the sim and serialisation that produced it): the minimum gap
   * counts from here, not from when its callback started, so a slow tick can't bunch the next.
   */
  markSent(now: number): void {
    this.lastSnap = Math.max(this.lastSnap, now);
  }
  /** Learned timer lateness (ms): a decaying peak of how late wake-ups come. */
  private grain: number;
  /** When the last requested sleep should end (to measure lateness), null while spinning. */
  private expected: number | null = null;
  private last: number;

  constructor(
    readonly cfg: PacerConfig,
    nowMs: number,
    /** Initial granularity guess (ms): the coarse Windows timer, until measured. */
    initialGrainMs = 16,
  ) {
    this.origin = nowMs;
    this.last = nowMs;
    this.grain = initialGrainMs;
  }

  get periodMs(): number {
    return this.cfg.stepMs * this.cfg.snapshotEvery;
  }

  /** The learned timer granularity (ms). */
  get timerGrainMs(): number {
    return this.grain;
  }

  /** How early a snapshot tick may run (ms). */
  get leadMs(): number {
    return Math.min(this.cfg.maxLeadMs, this.grain / 2);
  }

  private tickTime(n: number): number {
    return this.origin + n * this.cfg.stepMs;
  }

  step(nowMs: number): PacerStep {
    const c = this.cfg;
    // A clock that steps backwards is treated as standing still.
    const now = Math.max(this.last, nowMs);
    this.last = now;
    if (this.expected !== null) {
      const late = Math.max(0, now - this.expected);
      this.grain = late > this.grain ? late : this.grain + (late - this.grain) * 0.05;
      this.expected = null;
    }
    // A long stall: catch up on at most `maxBacklogMs`, skip the rest.
    const behind = now - this.tickTime(this.ticks);
    if (behind > c.maxBacklogMs) this.origin += behind - c.maxBacklogMs;

    const minGap = this.periodMs * c.minGapRatio;
    const gapOk = now - this.lastSnap >= minGap - 1e-6;
    let due = 0;
    while (due < c.maxPerCall) {
      const n = this.ticks + due + 1;
      const t = this.tickTime(n);
      // The epsilon keeps float sums of 1000/60 from losing a tick.
      if (t <= now + 1e-6) {
        due++;
        continue;
      }
      if (n % c.snapshotEvery === 0 && t - now <= this.leadMs && gapOk && !this.held) due++;
      break;
    }
    const before = Math.floor(this.ticks / c.snapshotEvery);
    this.ticks += due;
    if (Math.floor(this.ticks / c.snapshotEvery) > before) this.held = true;

    let snapshot = false;
    if (this.held && gapOk) {
      snapshot = true;
      this.held = false;
      this.lastSnap = now;
    }

    // The next moment a snapshot should leave: the next snapshot tick's time, or the end of the
    // gap a held one waits for.
    const nextSnapTick = (Math.floor(this.ticks / c.snapshotEvery) + 1) * c.snapshotEvery;
    const target = this.held ? this.lastSnap + minGap : this.tickTime(nextSnapTick);
    const wait = target - now;
    if (wait > 0 && wait <= c.spinMs && due < c.maxPerCall) {
      return { ticks: due, snapshot, spinUntil: target, sleepMs: 0 };
    }
    // Wake early enough that a late timer still lands before the target minus the spin window;
    // never sleep past the next sim step (inputs keep being applied at ~60 Hz).
    const nextTick = this.tickTime(this.ticks + 1) - now;
    const sleep = Math.min(nextTick, wait - c.spinMs / 2 - this.grain);
    const sleepMs = Math.max(1, Math.ceil(sleep));
    this.expected = now + sleepMs;
    return { ticks: due, snapshot, spinUntil: null, sleepMs };
  }
}

/** Timer functions the loop runs on (injected in tests). */
export interface LoopTimers {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: LoopTimers = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Drives a `SnapshotPacer` with real timers: `onStep(ticks, snapshot)` runs at every wake-up
 * (ticks may be 0). Busy-waits only inside the pacer's `spinMs` window. Returns `stop`.
 */
export function startPacedLoop(
  cfg: PacerConfig,
  onStep: (ticks: number, snapshot: boolean) => void,
  timers: LoopTimers = realTimers,
): () => void {
  const pacer = new SnapshotPacer(cfg, timers.now());
  let handle: unknown = null;
  let stopped = false;
  const wake = (): void => {
    handle = null;
    if (stopped) return;
    let plan = pacer.step(timers.now());
    for (let guard = 0; guard < 4; guard++) {
      onStep(plan.ticks, plan.snapshot);
      if (stopped) return;
      if (plan.snapshot) pacer.markSent(timers.now());
      if (plan.spinUntil === null) break;
      const until = plan.spinUntil;
      while (timers.now() < until) {
        // Bounded high-resolution catch-up (≤ spinMs): the coarse timer can't hit this.
      }
      plan = pacer.step(timers.now());
    }
    handle = timers.setTimeout(wake, plan.spinUntil === null ? plan.sleepMs : 1);
  };
  handle = timers.setTimeout(wake, 1);
  return () => {
    stopped = true;
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
}
