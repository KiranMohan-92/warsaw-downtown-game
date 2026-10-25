import { describe, expect, it } from 'vitest';
import { OnlineSession } from './onlineSession.ts';

describe('remote draw time', () => {
  it('never goes back when the clock estimate slews back faster than the delay rises', () => {
    const s = new OnlineSession();
    // Stub the clock and the jitter buffer: after a stall, a burst of late snapshots pulls the
    // server-clock estimate back 25 ms while the adaptive delay still rises.
    let clockNow = 10_000;
    let delay = 100;
    const internals = s as unknown as {
      clock: { now: (local: number) => number | null };
      jitter: { delayMs: (local: number) => number };
    };
    internals.clock = { now: () => clockNow };
    internals.jitter = { delayMs: () => delay };
    const seen: number[] = [];
    for (let frame = 0; frame < 20; frame++) {
      clockNow += 16.7;
      if (frame === 8) clockNow -= 25; // the slew: more than a frame back
      if (frame >= 8) delay += 0.5; // the delay rising
      s.remotePlayers(frame * 16.7);
      seen.push(s.viewTime(frame * 16.7)!);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    // It still tracks the clock once the estimate catches up (a hold, not a freeze).
    expect(seen.at(-1)!).toBeCloseTo(clockNow - delay, 6);
  });

  it('rebases after a hard clock resync instead of holding a future time', () => {
    const s = new OnlineSession();
    let clockNow = 3_750;
    const internals = s as unknown as {
      clock: { now: (local: number) => number | null };
      jitter: { delayMs: (local: number) => number };
    };
    internals.clock = { now: () => clockNow };
    internals.jitter = { delayMs: () => 100 };
    expect(s.viewTime(0)).toBe(3_650);
    clockNow = 2_000; // the server skipped a 3 s stall: the estimate corrects back by seconds
    expect(s.viewTime(16)).toBe(1_900);
    clockNow += 16.7;
    expect(s.viewTime(33)).toBeCloseTo(1_916.7, 6); // and advances from there
  });
});
