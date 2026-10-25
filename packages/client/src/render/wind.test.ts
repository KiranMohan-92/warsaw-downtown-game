import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WindGusts, WindMotes } from './wind.ts';

const seq = (): (() => number) => {
  let s = 7;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
};

describe('wind', () => {
  it('gusts stay within 0..1 and move (lulls and gusts)', () => {
    const g = new WindGusts(seq());
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const v = g.update(1 / 60);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(hi - lo).toBeGreaterThan(0.2);
  });

  it('motes blow in a strong wind, vanish in rain, and stay around the camera', () => {
    const m = new WindMotes(seq());
    const cam = new THREE.Vector3(100, 1.7, -40);
    const alpha = (): number => {
      const c = m.points.geometry.getAttribute('color');
      let a = 0;
      for (let i = 0; i < c.count; i++) a += c.getW(i);
      return a;
    };
    for (let i = 0; i < 300; i++) m.update(1 / 60, cam, 0.8, 0, i / 60);
    expect(alpha()).toBeGreaterThan(0);
    const p = m.points.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      expect(Math.abs(p.getX(i) - cam.x)).toBeLessThanOrEqual(9.001);
      expect(Math.abs(p.getZ(i) - cam.z)).toBeLessThanOrEqual(9.001);
    }
    m.update(1 / 60, cam, 0.8, 1, 5);
    expect(alpha()).toBe(0);
  });
});
