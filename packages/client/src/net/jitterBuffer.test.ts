import { describe, expect, it } from 'vitest';
import { MATCH_NET, type SnapshotPlayer } from '@wd/shared';
import {
  JITTER_DEFAULTS,
  JitterBuffer,
  RemoteTrack,
  ServerClock,
  SnapshotBuffer,
} from './interpolation.ts';

const snap = (x: number, extra: Partial<SnapshotPlayer> = {}): SnapshotPlayer => ({
  id: 'r',
  x,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  pitch: 0,
  eye: 1.62,
  f: 0,
  tt: -1,
  hp: 100,
  sl: 0,
  tg: 0,
  sw: 0,
  pr: 0,
  ack: 0,
  life: 0,
  ...extra,
});

const IV = JITTER_DEFAULTS.intervalMs;

/** Feed a link: snapshot i (server time i × 33.3) arrives at i × 33.3 + delay(i). */
function feed(
  j: JitterBuffer,
  clock: ServerClock,
  from: number,
  to: number,
  delay: (i: number) => number,
) {
  for (let i = from; i < to; i++) {
    const server = i * IV;
    const local = server + delay(i);
    clock.observe(server, local);
    j.observe(server, local, clock.lateness(server, local));
  }
}

describe('JitterBuffer', () => {
  it('stays at the 100 ms floor on a clean link and adapts only within [base, 250 ms]', () => {
    const j = new JitterBuffer();
    const c = new ServerClock();
    // ±8 ms of coarse-timer jitter: the floor already covers it.
    feed(j, c, 0, 300, (i) => 20 + ((i * 7) % 16));
    expect(j.delayMs(300 * IV + 20)).toBe(MATCH_NET.interpDelayMs);
    expect(j.targetMs).toBeLessThanOrEqual(MATCH_NET.interpDelayMs);
    expect(j.jitterMs).toBeLessThan(12);
    expect(j.cfg.maxMs).toBe(MATCH_NET.maxInterpDelayMs);
  });

  it('target = interval + 1.5 × the lateness peak, clamped to the ceiling', () => {
    const j = new JitterBuffer();
    j.observe(0, 0, 0);
    j.observe(IV, IV + 80, 80); // one snapshot 80 ms late
    expect(j.targetMs).toBeCloseTo(IV + 1.5 * 80, 6);
    j.observe(2 * IV, 2 * IV + 900, 900); // a long stall
    expect(j.targetMs).toBe(MATCH_NET.maxInterpDelayMs);
  });

  it('rises during a stall (from the silence itself), at most ½ ms per ms, never jumping', () => {
    const j = new JitterBuffer();
    feed(j, new ServerClock(), 0, 30, () => 20);
    const last = 29 * IV + 20;
    expect(j.delayMs(last)).toBe(100);
    // 300 ms of silence: the next snapshot is already ~270 ms late → target at the ceiling.
    let prev = j.delayMs(last);
    for (let t = last + 16; t <= last + 300; t += 16) {
      const d = j.delayMs(t);
      expect(d - prev).toBeLessThanOrEqual(0.5 * 16 + 1e-9); // render time keeps moving forward
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    expect(prev).toBeGreaterThan(200);
    expect(prev).toBeLessThanOrEqual(MATCH_NET.maxInterpDelayMs);
    expect(j.silenceMs(last + 300)).toBeCloseTo(300, 6);
  });

  it('decays slowly after the link recovers (seconds, not frames), back to the floor', () => {
    const j = new JitterBuffer();
    const c = new ServerClock();
    feed(j, c, 0, 30, () => 20);
    feed(j, c, 30, 31, () => 20 + 400); // one 400 ms stall
    let t = 30 * IV + 420;
    for (; t < 30 * IV + 1500; t += 16) j.delayMs(t);
    const high = j.delayMs(t);
    expect(high).toBeGreaterThan(200);
    // Clean again: one second later it has barely moved, after ~20 s it is back at 100.
    feed(j, c, 45, 75, () => 20);
    const oneSecond = j.delayMs(75 * IV + 20);
    expect(high - oneSecond).toBeLessThan(40);
    feed(j, c, 75, 700, () => 20);
    expect(j.delayMs(700 * IV + 20)).toBeCloseTo(MATCH_NET.interpDelayMs, 0);
  });

  it('counts stalls (gaps > 150 ms) in the last 10 s, and resets', () => {
    const j = new JitterBuffer();
    j.observe(0, 0, 0);
    j.observe(IV, 200, 160);
    j.observe(2 * IV, 400, 150);
    expect(j.recentStalls(400)).toBe(2);
    expect(j.recentStalls(12_000)).toBe(0);
    j.reset();
    expect(j.delayMs(20_000)).toBe(100);
    expect(j.silenceMs(20_000)).toBe(0);
  });
});

describe('SnapshotBuffer extrapolation', () => {
  it('moves along the newest velocity for at most the cap, then holds; never the dead', () => {
    const b = new SnapshotBuffer(32, 150);
    b.push(0, snap(0, { vx: 6 }));
    b.push(100, snap(0.6, { vx: 6, vz: -3 }));
    expect(b.sample(150)!.x).toBeCloseTo(0.6 + 0.3, 9);
    expect(b.sample(150)!.z).toBeCloseTo(-0.15, 9);
    expect(b.sample(250)!.x).toBeCloseTo(0.6 + 0.9, 9); // capped at 150 ms
    expect(b.sample(900)!.x).toBeCloseTo(0.6 + 0.9, 9); // then holds
    const info = { pastNewestMs: 0 };
    b.sample(130, info);
    expect(info.pastNewestMs).toBeCloseTo(30, 9);
    // Falling isn't guessed (the ground stays put), jumping up is.
    const f = new SnapshotBuffer(32, 150);
    f.push(0, snap(0, { vy: -8 }));
    expect(f.sample(100)!.y).toBe(0);
    const d = new SnapshotBuffer(32, 150);
    d.push(0, snap(0, { vx: 6, hp: 0 }));
    expect(d.sample(100)!.x).toBe(0);
  });
});

describe('RemoteTrack', () => {
  it('after a stall, blends from the extrapolated pose back to the real one (no snap)', () => {
    const r = new RemoteTrack(MATCH_NET.maxExtrapolateMs);
    // Running +x at 6 m/s, snapshots every 33 ms…
    for (let i = 0; i <= 10; i++) r.push(i * IV, snap(0.2 * i, { vx: 6 }));
    let t = 10 * IV;
    let x = r.sample(t)!.x;
    // …then silence: drawn 200 ms past the newest (extrapolated 150 ms, then held).
    for (t = 10 * IV + 16; t <= 10 * IV + 200; t += 16) {
      const nx = r.sample(t)!.x;
      expect(nx).toBeGreaterThanOrEqual(x - 1e-9); // never runs backwards…
      x = nx;
    }
    expect(x).toBeCloseTo(2 + 0.9, 6); // …held after 150 ms of extrapolation
    // Data resumes: the player had actually turned back (x = 1.6 at the stalled instant).
    const drawnBefore = r.sample(t)!.x;
    r.push(10 * IV + 200 + 16, snap(1.6, { vx: 0 }));
    const drawnAfter = r.sample(t)!.x;
    expect(Math.abs(drawnAfter - drawnBefore)).toBeLessThan(0.02); // no snap
    expect(Math.abs(r.offset.x)).toBeGreaterThan(1);
    // The offset is gone within ~200 ms of render time.
    for (let k = 0; k < 13; k++) r.sample((t += 16));
    expect(Math.abs(r.offset.x)).toBeLessThan(0.05);
  });

  it('snaps on a respawn or a teleport instead of gliding across the map', () => {
    const r = new RemoteTrack(150);
    r.push(0, snap(0));
    r.push(IV, snap(0));
    r.sample(IV + 100); // past the newest
    r.push(IV + 150, snap(40)); // 40 m away: a teleport
    expect(r.offset.x).toBe(0);
    const s = new RemoteTrack(150);
    s.push(0, snap(0, { life: 0 }));
    s.sample(100);
    s.push(120, snap(1, { life: 1 }));
    expect(s.sample(120)!.x).toBe(1);
    expect(s.offset.x).toBe(0);
  });

  it('interpolating normally (no stall), pushes never create an offset', () => {
    const r = new RemoteTrack(150);
    for (let i = 0; i < 20; i++) {
      r.push(i * IV, snap(0.2 * i));
      r.sample(i * IV - 100);
    }
    expect(r.offset.x).toBe(0);
  });
});
