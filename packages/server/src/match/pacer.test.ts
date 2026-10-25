import { describe, expect, it } from 'vitest';
import { MATCH_NET, SIM } from '@wd/shared';
import { SnapshotPacer, startPacedLoop, type LoopTimers, type PacerConfig } from './pacer.ts';

const STEP = 1000 / SIM.tickHz;
const PERIOD = STEP * MATCH_NET.snapshotEvery;

const CFG: PacerConfig = {
  stepMs: STEP,
  snapshotEvery: MATCH_NET.snapshotEvery,
  maxPerCall: MATCH_NET.maxCatchUpTicks,
  maxBacklogMs: MATCH_NET.maxCatchUpMs,
  spinMs: MATCH_NET.snapshotSpinMs,
  maxLeadMs: MATCH_NET.snapshotMaxLeadMs,
  minGapRatio: MATCH_NET.snapshotMinGapRatio,
};

/**
 * A fake event loop whose timers fire on a grid (Windows: 15.625 ms; Linux-ish: 1 ms), with a
 * cost per sim tick; busy-waiting advances the clock (it reads `now()` in a loop).
 */
function fakeTimers(grainMs: number, phase: number, tickCostMs = 0.2) {
  let now = 1000;
  let pending: { at: number; cb: () => void } | null = null;
  let spun = 0;
  let spinning = false;
  const timers: LoopTimers = {
    now: () => {
      // Each read inside a busy-wait costs a little time (the wait ends).
      if (spinning) {
        now += 0.05;
        spun += 0.05;
      }
      return now;
    },
    setTimeout: (cb, ms) => {
      const earliest = now + Math.max(1, ms);
      // The first grid point at or after the requested time.
      const at = Math.ceil((earliest - phase) / grainMs) * grainMs + phase;
      pending = { at, cb };
      return pending;
    },
    clearTimeout: () => {
      pending = null;
    },
  };
  return {
    timers,
    get now() {
      return now;
    },
    get spunMs() {
      return spun;
    },
    cost(ticks: number) {
      now += ticks * tickCostMs;
    },
    /** Run the loop until `untilMs`. */
    run(untilMs: number) {
      while (pending && pending.at <= untilMs) {
        const p = pending;
        pending = null;
        now = Math.max(now, p.at);
        spinning = true;
        p.cb();
        spinning = false;
      }
    },
    set spinning(v: boolean) {
      spinning = v;
    },
  };
}

function quantile(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

/** Drive the real loop on fake timers; returns snapshot send times, ticks run, and spin time. */
function simulate(grainMs: number, phase: number, seconds = 20) {
  const clock = fakeTimers(grainMs, phase);
  const sends: { at: number; tick: number }[] = [];
  let ticks = 0;
  const stop = startPacedLoop(
    CFG,
    (n, snapshot) => {
      ticks += n;
      // Sim work happens outside the busy-wait (it costs real time, not spin time).
      clock.spinning = false;
      clock.cost(n);
      if (snapshot) sends.push({ at: clock.now, tick: ticks });
      clock.spinning = true;
    },
    clock.timers,
  );
  clock.run(1000 + seconds * 1000);
  stop();
  // The first second learns the timer's granularity (it starts at the coarse guess).
  const settled = sends.filter((s) => s.at >= 2000);
  const iv = settled.slice(1).map((s, i) => s.at - settled[i]!.at);
  return { sends, iv, ticks, spunMs: clock.spunMs, elapsed: clock.now - 1000 };
}

describe('SnapshotPacer', () => {
  it('runs whole ticks of real time, never more than one tick ahead, and skips long stalls', () => {
    const p = new SnapshotPacer({ ...CFG, maxLeadMs: 0 }, 0);
    expect(p.step(10).ticks).toBe(0);
    expect(p.step(STEP).ticks).toBe(1);
    expect(p.step(STEP * 3).ticks).toBe(2);
    // A 5 s freeze catches up on at most 1 s (60 ticks, 8 per call), then follows the clock.
    let n = 0;
    for (let i = 0; i < 20; i++) n += p.step(5000).ticks;
    expect(n).toBe(60);
    expect(p.step(5000 + STEP).ticks).toBe(1);
  });

  it('asks for a short busy-wait only when a snapshot is due within the spin window', () => {
    const p = new SnapshotPacer(CFG, 0, 1);
    // Tick 2 (a snapshot tick) is due at 33.3 ms.
    const far = p.step(PERIOD - 10);
    expect(far.spinUntil).toBeNull();
    expect(far.sleepMs).toBeGreaterThanOrEqual(1);
    const near = p.step(PERIOD - CFG.spinMs / 2);
    expect(near.spinUntil).toBeCloseTo(PERIOD, 6);
    const now = p.step(PERIOD);
    expect(now.snapshot).toBe(true);
    expect(now.ticks).toBe(1);
  });

  it('holds a snapshot back after a late one instead of bunching two together', () => {
    const p = new SnapshotPacer(CFG, 0, 1);
    // A stall: tick 2's snapshot leaves 30 ms late (at 63 ms), tick 4 is due at 66.7 ms.
    const late = p.step(PERIOD + 30);
    expect(late.snapshot).toBe(true);
    const next = p.step(2 * PERIOD + 0.1);
    expect(next.snapshot).toBe(false); // only 3.8 ms after the last one
    const gapEnd = PERIOD + 30 + PERIOD * CFG.minGapRatio;
    expect(p.step(gapEnd).snapshot).toBe(true);
  });

  it('learns the timer granularity from late wake-ups', () => {
    const fine = simulate(1, 0.3, 5);
    const coarse = simulate(15.625, 3.1, 5);
    expect(fine.sends.length).toBeGreaterThan(140);
    expect(coarse.sends.length).toBeGreaterThan(140);
  });
});

describe('startPacedLoop on fake timers', () => {
  it('paces snapshots within ~1 ms of 33.3 ms on a fine-grained (1 ms) timer', () => {
    const r = simulate(1, 0.37);
    expect(r.sends.length).toBeGreaterThanOrEqual(598);
    expect(r.iv.length).toBeGreaterThanOrEqual(565);
    expect(quantile(r.iv, 0.5)).toBeCloseTo(PERIOD, 0);
    expect(Math.max(...r.iv)).toBeLessThan(PERIOD + 1.5);
    expect(Math.min(...r.iv)).toBeGreaterThan(PERIOD - 1.5);
    // Sim time follows the wall clock exactly (60 Hz of real time).
    expect(Math.abs(r.ticks - r.elapsed / STEP)).toBeLessThanOrEqual(2);
    // Busy-waiting stays bounded: under 2 ms per snapshot on average, ~5% of one core.
    expect(r.spunMs / r.sends.length).toBeLessThan(CFG.spinMs);
  });

  it('on the 15.6 ms Windows timer grid: no 62 ms gaps, no bunching, bounded spin', () => {
    for (const phase of [0, 2.2, 7.9, 13.4]) {
      const r = simulate(15.625, phase);
      // ~30 Hz of real time: every snapshot tick is sent.
      expect(r.sends.length).toBeGreaterThanOrEqual(595);
      expect(quantile(r.iv, 0.5)).toBeGreaterThan(29);
      expect(quantile(r.iv, 0.5)).toBeLessThan(38);
      // The old loop: p95 ≈ 58–62 ms, max ≈ 70 ms, min ≈ 5 ms (two nearly together).
      expect(Math.max(...r.iv)).toBeLessThan(50);
      expect(Math.min(...r.iv)).toBeGreaterThanOrEqual(PERIOD * CFG.minGapRatio - 0.5);
      expect(r.spunMs / r.sends.length).toBeLessThan(CFG.spinMs);
      // A snapshot never leaves more than half a grid step ahead of its tick's nominal time.
      expect(Math.abs(r.ticks - r.elapsed / STEP)).toBeLessThanOrEqual(2);
    }
  });
});

describe('startPacedLoop after a slow tick', () => {
  it('counts the minimum gap from when a snapshot actually left, so a slow tick never bunches', () => {
    const clock = fakeTimers(1, 0.37);
    const sends: number[] = [];
    let slowDone = false;
    const stop = startPacedLoop(
      CFG,
      (n, snapshot) => {
        clock.spinning = false;
        clock.cost(n);
        // One snapshot tick whose sim + serialisation takes 30 ms (a hitch).
        if (snapshot && !slowDone && clock.now > 5000) {
          slowDone = true;
          clock.cost(30 / 0.2); // cost() charges 0.2 ms per tick: 30 ms
        }
        if (snapshot) sends.push(clock.now);
        clock.spinning = true;
      },
      clock.timers,
    );
    clock.run(9000);
    stop();
    expect(slowDone).toBe(true);
    const iv = sends.slice(1).map((t, i) => t - sends[i]!);
    expect(Math.min(...iv)).toBeGreaterThanOrEqual(PERIOD * CFG.minGapRatio - 0.5);
  });
});
