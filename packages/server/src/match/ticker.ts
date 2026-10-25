/**
 * Turns irregular timer callbacks into whole fixed ticks of measured real time.
 *
 * Node's `setInterval(16.67)` really fires every 16 ms, and every ~31 ms on Windows (15.6 ms
 * timer granularity); event-loop stalls skip callbacks. Counting callbacks as ticks would make
 * server time (and the snapshot timestamps clients interpolate on) run at the timer's speed, not
 * the clock's. Here each callback runs as many ticks as real time has passed: never ahead of the
 * clock, at most `maxPerCall` per callback (the rest carries over), and after a stall longer than
 * `maxBacklogMs` the excess is skipped rather than simulated in one go. Time is injected (pure).
 */
export class FixedTicker {
  private acc = 0;
  private last: number;

  constructor(
    readonly stepMs: number,
    private readonly maxPerCall: number,
    private readonly maxBacklogMs: number,
    nowMs: number,
  ) {
    this.last = nowMs;
  }

  /** Ticks to run now (0 when the callback came early). */
  advance(nowMs: number): number {
    this.acc = Math.min(this.maxBacklogMs, this.acc + Math.max(0, nowMs - this.last));
    this.last = Math.max(this.last, nowMs);
    // The epsilon keeps float sums of 1000/60 from losing a tick (49.99999… ms is 3 ticks).
    const due = Math.min(this.maxPerCall, Math.floor((this.acc + 1e-6) / this.stepMs));
    this.acc = Math.max(0, this.acc - due * this.stepMs);
    return due;
  }
}
