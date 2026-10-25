import { describe, expect, it } from 'vitest';
import {
  area,
  clipConvex,
  convexDecompose,
  isConvex,
  pointInPolygon,
  rectPoly,
  simplifyRing,
  subtractConvex,
  triangulate,
  type Pt,
} from './geom.ts';

const sumArea = (ps: Pt[][]): number => ps.reduce((s, p) => s + area(p), 0);
/** An L-shaped building (concave), 20×20 minus a 10×10 corner = 300 m². */
const L: Pt[] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [10, 10],
  [10, 20],
  [0, 20],
];

describe('map polygon toolkit', () => {
  it('triangulates a concave polygon, preserving area', () => {
    const t = triangulate(L);
    expect(t).toHaveLength(4);
    expect(sumArea(t)).toBeCloseTo(300, 6);
  });

  it('decomposes concave footprints into few convex pieces with the same area', () => {
    const pieces = convexDecompose(L);
    expect(pieces.length).toBeLessThanOrEqual(3);
    expect(pieces.every(isConvex)).toBe(true);
    expect(sumArea(pieces)).toBeCloseTo(300, 6);
  });

  it('carves courtyards (holes) out exactly', () => {
    const outer = rectPoly(0, 0, 30, 30);
    const court = rectPoly(10, 10, 20, 20);
    const pieces = convexDecompose(outer, [court]);
    expect(pieces.every(isConvex)).toBe(true);
    expect(sumArea(pieces)).toBeCloseTo(900 - 100, 6);
    // Nothing covers the courtyard centre; the ring around it is covered.
    expect(pieces.some((p) => pointInPolygon([15, 15], p))).toBe(false);
    expect(pieces.some((p) => pointInPolygon([5, 15], p))).toBe(true);
  });

  it('subtracts a doorway/passage rectangle from a convex piece', () => {
    const wing = rectPoly(0, 0, 40, 12);
    const passage = rectPoly(18, -1, 22, 13); // cuts straight through
    const parts = subtractConvex(wing, passage);
    expect(sumArea(parts)).toBeCloseTo(480 - 48, 6);
    expect(parts.some((p) => pointInPolygon([20, 6], p))).toBe(false);
  });

  it('clips to a convex window (map sections)', () => {
    const c = clipConvex(rectPoly(0, 0, 10, 10), rectPoly(5, -5, 15, 5));
    expect(area(c)).toBeCloseTo(25, 6);
  });

  it('simplifies noisy OSM rings without losing the shape', () => {
    const noisy: Pt[] = [];
    for (let i = 0; i <= 40; i++) noisy.push([i, (i % 2) * 0.05]); // jittery bottom edge
    noisy.push([40, 10], [0, 10]);
    const s = simplifyRing(noisy, 0.2);
    expect(s.length).toBe(4);
    expect(area(s)).toBeGreaterThan(395);
  });
});
