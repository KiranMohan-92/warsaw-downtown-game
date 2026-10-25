import { describe, expect, it } from 'vitest';
import type { RemotePose } from '../net/interpolation.ts';
import { CINE } from './cameraDirector.ts';
import {
  blankPose,
  PoseRing,
  REPLAY_CAPACITY,
  REPLAY_INTERVAL_MS,
  ReplayRecorder,
} from './poseRing.ts';

const pose = (x: number, over: Partial<RemotePose> = {}): RemotePose => ({
  ...blankPose(),
  x,
  ...over,
  action: { kind: 'none', v: 0, t: 0, ...over.action },
});

describe('PoseRing', () => {
  it('blends between the two poses around a time', () => {
    const r = new PoseRing(16, 25);
    r.push(1000, pose(0, { y: 0, eye: 1.6, pitch: 0 }));
    r.push(1100, pose(10, { y: 2, eye: 1.2, pitch: 0.4 }));
    const out = blankPose();
    expect(r.sample(1025, out)).toBe(true);
    expect(out.x).toBeCloseTo(2.5, 9);
    expect(out.y).toBeCloseTo(0.5, 9);
    expect(out.eye).toBeCloseTo(1.5, 9);
    expect(out.pitch).toBeCloseTo(0.1, 9);
  });

  it('turns yaw by the short arc across ±π', () => {
    const r = new PoseRing(16, 25);
    r.push(0, pose(0, { yaw: Math.PI - 0.1 }));
    r.push(100, pose(0, { yaw: -Math.PI + 0.1 }));
    const out = blankPose();
    r.sample(50, out);
    expect(Math.abs(Math.cos(out.yaw) + 1)).toBeLessThan(1e-9); // ≈ ±π, not 0
  });

  it('takes discrete fields from the nearer pose and blends one action', () => {
    const r = new PoseRing(16, 25);
    r.push(0, pose(0, { f: 1, sl: 0, hp: 100, action: { kind: 'reload', v: 0, t: 0.2 } }));
    r.push(100, pose(0, { f: 2, sl: 2, hp: 40, action: { kind: 'reload', v: 0, t: 0.4 } }));
    const out = blankPose();
    r.sample(30, out);
    expect([out.f, out.sl, out.hp]).toEqual([1, 0, 100]);
    expect(out.action.t).toBeCloseTo(0.26, 9);
    r.sample(70, out);
    expect([out.f, out.sl, out.hp]).toEqual([2, 2, 40]);
  });

  it('never blends across a respawn: the old life holds until the new pose', () => {
    const r = new PoseRing(16, 25);
    r.push(0, pose(0, { life: 1, hp: 0 }));
    r.push(100, pose(80, { life: 2, hp: 100, y: 3 }));
    r.push(200, pose(82, { life: 2, hp: 100, y: 3 }));
    const out = blankPose();
    for (const t of [1, 50, 99]) {
      r.sample(t, out);
      // The corpse stays where it fell (no slide through the map toward the spawn).
      expect([out.x, out.y, out.life, out.hp]).toEqual([0, 0, 1, 0]);
    }
    r.sample(100, out);
    expect([out.x, out.life]).toEqual([80, 2]);
    r.sample(150, out);
    expect(out.x).toBeCloseTo(81, 9); // within one life it blends as usual
  });

  it('holds the end poses outside the recording, and reports empty', () => {
    const r = new PoseRing(16, 25);
    const out = blankPose();
    expect(r.sample(0, out)).toBe(false);
    r.push(100, pose(1));
    r.push(200, pose(2));
    r.sample(-50, out);
    expect(out.x).toBe(1);
    r.sample(900, out);
    expect(out.x).toBe(2);
  });

  it('thins poses closer than the interval and ignores time going back', () => {
    const r = new PoseRing(16, 25);
    expect(r.push(0, pose(0))).toBe(true);
    expect(r.push(10, pose(1))).toBe(false);
    expect(r.push(-100, pose(2))).toBe(false);
    expect(r.push(25, pose(3))).toBe(true);
    expect(r.push(Number.NaN, pose(4))).toBe(false);
    expect(r.count).toBe(2);
  });

  it('is a fixed ring: the oldest poses are overwritten in place', () => {
    const r = new PoseRing(8, 1);
    for (let i = 0; i < 20; i++) r.push(i * 10, pose(i));
    expect(r.count).toBe(8);
    expect(r.oldest).toBe(120);
    expect(r.newest).toBe(190);
    const out = blankPose();
    r.sample(155, out);
    expect(out.x).toBeCloseTo(15.5, 9);
    // Sampling across the wrap point.
    r.sample(125, out);
    expect(out.x).toBeCloseTo(12.5, 9);
  });

  it('copies poses in (the caller may reuse its object)', () => {
    const r = new PoseRing(4, 1);
    const p = pose(5);
    r.push(0, p);
    p.x = 99;
    const out = blankPose();
    r.sample(0, out);
    expect(out.x).toBe(5);
  });

  it('freeze keeps the replay window: nothing newer is recorded until unfreeze', () => {
    const r = new PoseRing(16, 1);
    r.push(0, pose(0));
    r.freeze(100);
    expect(r.push(100, pose(1))).toBe(true);
    expect(r.push(150, pose(2))).toBe(false);
    r.unfreeze();
    expect(r.push(150, pose(2))).toBe(true);
  });

  it('holds more than a kill cam replays at the default rate', () => {
    // The whole window, plus the pull-out it keeps recording through, fits in a ring.
    const needMs = (CINE.killcamLength + CINE.deathPull + 0.5) * 1000;
    expect(REPLAY_CAPACITY * REPLAY_INTERVAL_MS).toBeGreaterThanOrEqual(needMs);
  });
});

describe('ReplayRecorder', () => {
  it('keeps one ring per slot and restarts it for a new occupant', () => {
    const rec = new ReplayRecorder(6);
    rec.recordRemote(2, 'a', 0, pose(1));
    rec.recordRemote(2, 'a', 50, pose(2));
    expect(rec.ringOf('a')?.count).toBe(2);
    rec.recordRemote(2, 'b', 100, pose(3));
    expect(rec.ringOf('a')).toBeNull();
    expect(rec.ringOf('b')?.count).toBe(1);
    rec.recordRemote(9, 'c', 0, pose(0)); // no such slot: ignored
    expect(rec.ringOf('c')).toBeNull();
  });

  it('freezes every ring, the local one too', () => {
    const rec = new ReplayRecorder(2);
    rec.freeze(10);
    rec.recordRemote(0, 'a', 20, pose(0));
    expect(rec.self.push(20, pose(0))).toBe(false);
    expect(rec.ringOf('a')).toBeNull();
    rec.unfreeze();
    expect(rec.self.push(20, pose(0))).toBe(true);
  });
});
