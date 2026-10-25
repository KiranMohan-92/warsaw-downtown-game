import { describe, expect, it } from 'vitest';
import { MATCH_NET } from '@wd/shared';
import {
  PingTracker,
  PoseHistory,
  rewindCapMs,
  rewoundShapes,
  RttEstimate,
  shotViewTime,
  type Pose,
} from './lagComp.ts';

const pose = (ms: number, x: number, extra: Partial<Pose> = {}): Pose => ({
  ms,
  feet: { x, y: 0, z: 0 },
  eye: 1.62,
  life: 0,
  alive: true,
  ...extra,
});

describe('PoseHistory', () => {
  it('blends between the two poses around a time, holds the ends, never extrapolates', () => {
    const h = new PoseHistory(10);
    expect(h.at(0)).toBeNull();
    h.record(pose(100, 0));
    h.record(pose(116, 1));
    h.record(pose(133, 3, { eye: 1.05 }));
    expect(h.at(108)!.feet.x).toBeCloseTo(0.5, 9);
    expect(h.at(124.5)!.feet.x).toBeCloseTo(2, 9);
    expect(h.at(124.5)!.eye).toBeCloseTo((1.62 + 1.05) / 2, 9);
    expect(h.at(50)!.feet.x).toBe(0); // before the oldest: the oldest
    expect(h.at(500)!.feet.x).toBe(3); // after the newest: the newest
  });

  it('never blends across a respawn or a death', () => {
    const h = new PoseHistory(10);
    h.record(pose(100, 0));
    h.record(pose(116, 40, { life: 1 }));
    expect(h.at(104)!.feet.x).toBe(0);
    expect(h.at(112)!.feet.x).toBe(0);
    expect(h.at(116)!.feet.x).toBe(40);
    h.record(pose(133, 41, { life: 1, alive: false }));
    expect(h.at(120)!.alive).toBe(true);
    expect(h.at(130)!.alive).toBe(false);
  });

  it('blends facing along the shortest arc, as clients interpolate it', () => {
    const h = new PoseHistory(10);
    h.record(pose(100, 0, { yaw: 0.2 }));
    h.record(pose(120, 0, { yaw: 1.0 }));
    expect(h.at(110)!.yaw).toBeCloseTo(0.6, 9);
    // Across the ±π seam: 3.0 → -3.0 turns 0.28 rad through π, not 6 rad the long way.
    h.record(pose(140, 0, { yaw: 3.0 }));
    h.record(pose(160, 0, { yaw: -3.0 }));
    const mid = h.at(150)!.yaw!;
    expect(Math.cos(mid)).toBeCloseTo(-1, 3);
    expect(Math.abs(Math.sin(mid))).toBeLessThan(0.01);
  });

  it('keeps a bounded window and replaces a repeated tick', () => {
    const h = new PoseHistory(3);
    for (let i = 0; i < 10; i++) h.record(pose(i * 16, i));
    expect(h.size).toBe(3);
    expect(h.at(0)!.feet.x).toBe(7);
    h.record(pose(9 * 16, 99));
    expect(h.size).toBe(3);
    expect(h.at(1000)!.feet.x).toBe(99);
  });
});

describe('PoseHistory: cab membership is rewound', () => {
  it('in the cab at the view time, whatever the seat is now (and on foot before getting in)', () => {
    const h = new PoseHistory(10);
    h.record(pose(100, 0)); // on foot
    h.record(pose(116, 0, { cab: true })); // got in
    h.record(pose(133, 0, { cab: true }));
    h.record(pose(150, 2)); // got out
    expect(h.at(100)!.cab).toBeFalsy();
    expect(h.at(120)!.cab).toBe(true);
    expect(h.at(138)!.cab).toBe(true); // nearer the seated tick
    expect(h.at(146)!.cab).toBeFalsy();
  });
});

describe('shotViewTime', () => {
  const now = 10_000;
  it('uses the view time the client reported (what the shooter saw)', () => {
    expect(shotViewTime(now, now - 150, 80)).toBe(now - 150);
    expect(shotViewTime(now, now - 20, null)).toBe(now - 20);
  });

  it('never rewinds more than the cap, nor into the future', () => {
    expect(shotViewTime(now, now - 900, 50)).toBe(now - rewindCapMs(50));
    expect(shotViewTime(now, now - 900, 500)).toBe(now - MATCH_NET.maxRewindMs);
    expect(shotViewTime(now, now + 500, 50)).toBe(now);
    expect(shotViewTime(now, Number.NaN, 0)).toBe(now - MATCH_NET.interpDelayMs);
  });

  it('without one: interpolation delay + the round trip, capped', () => {
    expect(shotViewTime(now, undefined, 60)).toBe(now - MATCH_NET.interpDelayMs - 60);
    expect(shotViewTime(now, undefined, null)).toBe(now - MATCH_NET.interpDelayMs);
    expect(shotViewTime(now, undefined, 1000)).toBe(now - MATCH_NET.maxRewindMs);
  });

  it('what an honest client asks for fits its cap at low, normal and high ping', () => {
    // Asked = interpolation delay + the whole round trip + up to ~12 ms of queueing (measured by
    // the soak harness), on a clean link (100 ms buffer) and after a stall (the buffer at 250).
    for (const rtt of [5, 20, 50, 100, 150]) {
      const clean = MATCH_NET.interpDelayMs + rtt + 12;
      expect(shotViewTime(now, now - clean, rtt), `clean ${rtt}`).toBe(now - clean);
    }
    for (const rtt of [5, 20, 50]) {
      const stalled = MATCH_NET.maxInterpDelayMs + rtt + 12;
      expect(shotViewTime(now, now - stalled, rtt), `stalled ${rtt}`).toBe(now - stalled);
    }
    // 200 ms: a clean buffer still fits under the ceiling; 250 ms has to lead by the excess.
    expect(shotViewTime(now, now - 312, 200)).toBe(now - 312);
    expect(shotViewTime(now, now - 362, 250)).toBe(now - MATCH_NET.maxRewindMs);
  });
});

describe('rewindCapMs (per player: interpolation delay + server-measured RTT + margin)', () => {
  const { maxInterpDelayMs, rewindMarginMs, maxRewindMs } = MATCH_NET;

  it('grows with the measured round trip up to the absolute ceiling', () => {
    expect(rewindCapMs(null)).toBe(maxInterpDelayMs + rewindMarginMs);
    expect(rewindCapMs(0)).toBe(maxInterpDelayMs + rewindMarginMs);
    expect(rewindCapMs(20)).toBe(maxInterpDelayMs + 20 + rewindMarginMs);
    expect(rewindCapMs(59)).toBeLessThan(maxRewindMs);
    for (const rtt of [60, 100, 250, 1000, 1e9]) expect(rewindCapMs(rtt)).toBe(maxRewindMs);
    expect(maxRewindMs).toBe(350);
  });

  it('junk round trips never widen it', () => {
    for (const bad of [Number.NaN, -50, Number.NEGATIVE_INFINITY]) {
      expect(rewindCapMs(bad)).toBe(rewindCapMs(0));
    }
    expect(rewindCapMs(Number.POSITIVE_INFINITY)).toBe(rewindCapMs(0));
  });

  it('a lying view time gains nothing past the cap, whatever it claims', () => {
    const now = 50_000;
    // A 20 ms player claiming it saw the world 2 s ago: its own cap, not the ceiling.
    expect(now - shotViewTime(now, now - 2000, 20)).toBe(rewindCapMs(20));
    // However long the ping (or however late the pongs): never past the ceiling.
    for (const claim of [351, 1000, 1e6, 1e12]) {
      expect(now - shotViewTime(now, now - claim, 4000)).toBe(maxRewindMs);
    }
    // The pose history holds more than the ceiling, so a clamped rewind is always real data.
    expect((MATCH_NET.historyTicks * 1000) / 60).toBeGreaterThan(maxRewindMs);
  });
});

describe('RttEstimate (server-measured round trip for the rewind cap)', () => {
  it('follows a steady ping, low or high', () => {
    for (const ping of [8, 50, 180]) {
      const r = new RttEstimate();
      for (let i = 0; i < 12; i++) r.observe(ping + (i % 3));
      expect(r.forRewind).toBeGreaterThanOrEqual(ping);
      expect(r.forRewind).toBeLessThanOrEqual(ping + 2);
      expect(r.smoothed).toBeCloseTo(ping + 1, 0);
    }
  });

  it('is null until measured, then the first sample', () => {
    const r = new RttEstimate();
    expect(r.forRewind).toBeNull();
    r.observe(70);
    expect(r.forRewind).toBe(70);
  });

  it('one spike in the window never widens the cap (the EWMA would leak a quarter of it)', () => {
    const r = new RttEstimate();
    for (let i = 0; i < 6; i++) r.observe(40);
    r.observe(1200); // a hiccup, or a client sitting on one pong
    expect(r.forRewind).toBe(40);
    expect(r.smoothed).toBeGreaterThan(300);
    expect(rewindCapMs(r.forRewind)).toBe(rewindCapMs(40));
    for (let i = 0; i < 4; i++) r.observe(40);
    expect(r.forRewind).toBe(40);
    // A spike as the very first sample is dropped as soon as there is a second one.
    const early = new RttEstimate();
    early.observe(900);
    early.observe(30);
    expect(early.forRewind).toBe(30);
  });

  it('a real rise in ping shows within two samples; a fall once the old ones age out', () => {
    const r = new RttEstimate();
    for (let i = 0; i < 10; i++) r.observe(30);
    r.observe(150);
    expect(r.forRewind).toBe(30);
    r.observe(150);
    expect(r.forRewind).toBe(150);
    for (let i = 0; i < MATCH_NET.rttWindow; i++) r.observe(30);
    expect(r.forRewind).toBe(30);
  });

  it('ignores implausible samples', () => {
    const r = new RttEstimate();
    for (const bad of [-1, Number.NaN, 1e9, Number.POSITIVE_INFINITY]) r.observe(bad);
    expect(r.forRewind).toBeNull();
    expect(r.smoothed).toBeNull();
  });
});

describe('rewoundShapes', () => {
  it('builds the hit volumes where the player was, unless dead or respawned since', () => {
    const h = new PoseHistory(10);
    h.record(pose(100, 5));
    const shapes = rewoundShapes(h, 100, { life: 0, alive: true })!;
    expect(shapes.find((s) => s.zone === 'head')!.a.x).toBe(5);
    expect(rewoundShapes(h, 100, { life: 0, alive: false })).toBeNull(); // dead now
    expect(rewoundShapes(h, 100, { life: 1, alive: true })).toBeNull(); // another life now
    h.record(pose(116, 5, { alive: false }));
    expect(rewoundShapes(h, 116, { life: 0, alive: true })).toBeNull(); // dead then
  });
});

describe('PingTracker (only the echo of an outstanding server ping is a round-trip sample)', () => {
  it('an honest echo gives the round trip, once', () => {
    const p = new PingTracker();
    p.issue(1000);
    expect(p.consume(1000, 1042)).toBe(42);
    expect(p.outstanding).toBe(0);
  });

  it('forged stamps (never issued, or guessed ahead) are ignored', () => {
    const p = new PingTracker();
    p.issue(1000);
    for (const forged of [999.999, 1000.001, 700, 0, -5, 2000, Number.NaN]) {
      expect(p.consume(forged, 1010)).toBeNull();
    }
    expect(p.outstanding).toBe(1); // the real one is still waiting for its echo
    expect(p.consume(1000, 1010)).toBe(10);
  });

  it('a replayed echo counts once', () => {
    const p = new PingTracker();
    p.issue(1000);
    expect(p.consume(1000, 1300)).toBe(300);
    expect(p.consume(1000, 1300)).toBeNull();
    expect(p.consume(1000, 1350)).toBeNull();
  });

  it('echoes may arrive out of order; each is measured against its own ping', () => {
    const p = new PingTracker();
    p.issue(1000);
    p.issue(2000);
    p.issue(3000);
    expect(p.consume(3000, 3050)).toBe(50);
    expect(p.consume(1000, 3060)).toBe(2060);
    expect(p.consume(2000, 3070)).toBe(1070);
  });

  it('a stale echo is dropped, and the outstanding set is bounded', () => {
    const p = new PingTracker();
    p.issue(1000);
    expect(p.consume(1000, 1000 + MATCH_NET.pongTimeoutMs + 1)).toBeNull();
    expect(p.outstanding).toBe(0); // spent either way
    for (let i = 0; i < 100; i++) p.issue(10_000 + i * 1000);
    expect(p.outstanding).toBe(MATCH_NET.maxOutstandingPings);
    // The oldest were forgotten: their echoes no longer count.
    expect(p.consume(10_000, 10_050)).toBeNull();
    expect(p.consume(10_000 + 99 * 1000, 109_040)).toBe(40);
  });
});
