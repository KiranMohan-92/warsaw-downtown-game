import { describe, expect, it } from 'vitest';
import { encodeAction, type SnapshotPlayer } from '@wd/shared';
import { lerpAngle, ServerClock, SnapshotBuffer } from './interpolation.ts';

const snap = (x: number, extra: Partial<SnapshotPlayer> = {}): SnapshotPlayer => ({
  id: 'r',
  x,
  y: 0,
  z: -x,
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

describe('SnapshotBuffer', () => {
  it('blends between the two snapshots around the render time', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap(0));
    b.push(1033, snap(1));
    b.push(1066, snap(2));
    const mid = b.sample(1049.5)!;
    expect(mid.x).toBeCloseTo(1.5, 9);
    expect(mid.z).toBeCloseTo(-1.5, 9);
    expect(b.sample(1033)!.x).toBeCloseTo(1, 9);
    // Crouch (eye height) blends too.
    const c = new SnapshotBuffer();
    c.push(0, snap(0, { eye: 1.6 }));
    c.push(100, snap(0, { eye: 1.0 }));
    expect(c.sample(50)!.eye).toBeCloseTo(1.3, 9);
  });

  it('holds the ends: never extrapolates past the newest or before the oldest', () => {
    const b = new SnapshotBuffer();
    expect(b.sample(0)).toBeNull();
    b.push(1000, snap(0));
    b.push(1033, snap(1));
    expect(b.sample(500)!.x).toBe(0);
    expect(b.sample(5000)!.x).toBe(1);
  });

  it('turns the short way round (yaw across ±π)', () => {
    const b = new SnapshotBuffer();
    b.push(0, snap(0, { yaw: Math.PI - 0.1 }));
    b.push(100, snap(0, { yaw: -Math.PI + 0.1 }));
    const y = b.sample(50)!.yaw;
    // Halfway along the 0.2 rad short arc = ±π, not 0 (the long way).
    expect(Math.abs(Math.cos(y) + 1)).toBeLessThan(1e-9);
    expect(lerpAngle(0.1, -0.1, 0.5)).toBeCloseTo(0, 12);
    expect(lerpAngle(6.2, 0.1, 0.5)).toBeCloseTo(6.2 + (0.1 + 2 * Math.PI - 6.2) / 2, 9);
  });

  it('never blends across a respawn (life changes): old life, then a snap', () => {
    const b = new SnapshotBuffer();
    b.push(0, snap(0, { life: 0 }));
    b.push(100, snap(50, { life: 1 }));
    expect(b.sample(40)!.x).toBe(0);
    expect(b.sample(99)!.x).toBe(0);
    expect(b.sample(100)!.x).toBe(50);
    expect(b.sample(100)!.life).toBe(1);
  });

  it('ignores out-of-order and duplicate snapshots, and prunes what is no longer needed', () => {
    const b = new SnapshotBuffer(4);
    b.push(100, snap(1));
    b.push(50, snap(9)); // late packet
    b.push(100, snap(9)); // duplicate
    expect(b.size).toBe(1);
    for (let i = 2; i <= 6; i++) b.push(i * 100, snap(i));
    expect(b.size).toBe(4); // capacity
    b.prune(450);
    expect(b.size).toBe(3); // keeps 400 (just before 450), 500, 600
    expect(b.sample(450)!.x).toBeCloseTo(4.5, 9);
  });

  it('discrete state (flags, health) comes from the nearer snapshot', () => {
    const b = new SnapshotBuffer();
    b.push(0, snap(0, { f: 0, hp: 100 }));
    b.push(100, snap(0, { f: 2, hp: 80 }));
    expect(b.sample(30)!.f).toBe(0);
    expect(b.sample(70)!.f).toBe(2);
    expect(b.sample(70)!.hp).toBe(80);
  });

  it('carries the weapon in hand (nearer sample) and the life’s primary to the renderer', () => {
    const b = new SnapshotBuffer();
    b.push(0, snap(0, { sl: 0, pr: 3 }));
    b.push(100, snap(0, { sl: 1, pr: 3 }));
    expect(b.sample(30)).toMatchObject({ sl: 0, primary: 'shotgun' });
    expect(b.sample(70)).toMatchObject({ sl: 1, primary: 'shotgun' });
    // An index this client doesn't know draws the AR-7 rather than nothing.
    const c = new SnapshotBuffer();
    c.push(0, snap(0, { pr: 99 }));
    expect(c.sample(0)!.primary).toBe('ar7');
  });

  it('blends a running action by progress; idle entries (no `ac`) are no action', () => {
    const b = new SnapshotBuffer();
    b.push(0, snap(0, { ac: encodeAction({ kind: 'reload', v: 0, t: 0.2 }) }));
    b.push(100, snap(0, { ac: encodeAction({ kind: 'reload', v: 0, t: 0.4 }) }));
    b.push(200, snap(0));
    const mid = b.sample(50)!.action;
    expect(mid.kind).toBe('reload');
    expect(mid.t).toBeCloseTo(0.3, 1);
    expect(b.sample(160)!.action.kind).toBe('none');
    expect(b.sample(0)!.action.kind).toBe('reload');
  });
});

describe('ServerClock', () => {
  it('locks onto the fastest arrival and ignores jitter that only makes packets later', () => {
    const c = new ServerClock();
    expect(c.now(0)).toBeNull();
    // Server time runs 5000 ms ahead of local; packets take 20–60 ms.
    const delays = [40, 20, 60, 35, 55, 25, 45];
    delays.forEach((d, i) => c.observe(i * 33, i * 33 - 5000 + d));
    const est = c.now(1000)! - 1000;
    // Tracks the minimum delay (20 ms): offset ≈ 5000 − 20, drifting only slowly towards later.
    expect(est).toBeGreaterThan(4970);
    expect(est).toBeLessThanOrEqual(4980);
  });

  it('resynchronises after a large jump (tab was hidden, server restarted)', () => {
    const c = new ServerClock();
    c.observe(10_000, 0);
    c.observe(10_033, 33);
    c.observe(100, 66); // server restarted: time went back by ~10 s
    expect(c.now(66)).toBe(100);
  });
});
