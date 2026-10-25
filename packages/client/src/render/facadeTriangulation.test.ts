import { describe, expect, it } from 'vitest';
import { triangulateFacadeBoundary } from './facadeTriangulation.ts';

type Point = readonly [number, number];
const cross = (a: Point, b: Point, c: Point): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function check(points: Point[]): void {
  const indices = triangulateFacadeBoundary(points);
  expect(indices.length).toBe((points.length - 2) * 3);
  expect(new Set(indices).size).toBe(points.length);
  const edges = new Map<string, number[]>();
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const tri = indices.slice(i, i + 3);
    const a = cross(points[tri[0]!]!, points[tri[1]!]!, points[tri[2]!]!);
    expect(a).toBeGreaterThan(0);
    area += a;
    for (let j = 0; j < 3; j++) {
      const from = tri[j]!;
      const to = tri[(j + 1) % 3]!;
      const key = [Math.min(from, to), Math.max(from, to)].join(':');
      const signs = edges.get(key) ?? [];
      signs.push(from < to ? 1 : -1);
      edges.set(key, signs);
    }
  }
  // Independent polygon area, using an origin shift to avoid large-coordinate cancellation.
  const polygonArea = points
    .slice(1, -1)
    .reduce((sum, point, i) => sum + cross(points[0]!, point, points[i + 2]!), 0);
  expect(area).toBeCloseTo(polygonArea, 9);
  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length;
    const key = [Math.min(i, next), Math.max(i, next)].join(':');
    expect(edges.get(key)).toEqual([i < next ? 1 : -1]);
    edges.delete(key);
  }
  for (const signs of edges.values()) {
    expect(signs.length).toBe(2);
    expect(signs[0]! + signs[1]!).toBe(0);
  }
}

describe('boundary-preserving facade triangulation', () => {
  it('retains subdivisions concentrated on a single edge', () => {
    check([
      [0, 0],
      ...Array.from({ length: 40 }, (_, i): Point => [(i + 1) / 41, 0]),
      [1, 0],
      [1, 8],
      [0, 8],
    ]);
  });
  it('retains asymmetric course clearances on all four edges', () => {
    check([
      [0, 0],
      [0.025, 0],
      [3.7, 0],
      [5, 0],
      [5, 0.025],
      [5, 4],
      [5, 12],
      [4.975, 12],
      [0.025, 12],
      [0, 12],
      [0, 11.975],
      [0, 0.025],
    ]);
  });
  it('does not strand the sole corner above a subdivided triangle base', () => {
    check([
      [0, 0],
      [0.025, 0],
      [1, 0],
      [3.5, 0],
      [4, 0],
      [1.9, 5],
    ]);
  });
  it('handles narrow profiles and translated local coordinates', () => {
    check([
      [1000, 300],
      [1000.000002, 300],
      [1000.00001, 300],
      [1000.00001, 315],
      [1000.00001, 330],
      [1000, 330],
      [1000, 301],
    ]);
  });
  it('rejects degenerate or incorrectly ordered boundaries explicitly', () => {
    expect(() =>
      triangulateFacadeBoundary([
        [0, 0],
        [1, 0],
      ]),
    ).toThrow();
    expect(() =>
      triangulateFacadeBoundary([
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    ).toThrow();
    expect(() =>
      triangulateFacadeBoundary([
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ]),
    ).toThrow();
  });
});
