import { describe, expect, it } from 'vitest';
import { getMap, resolveMap, type MapFlat } from '@wd/shared';
import { flatDrawLayer } from './mapMesh.ts';

type P = readonly [number, number];
const inPoly = (x: number, z: number, pts: readonly P[]): boolean => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]!;
    const [xj, zj] = pts[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const bbox = (f: MapFlat) => {
  const xs = f.pts.map((p) => p[0]);
  const zs = f.pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
};

describe('flat draw layers', () => {
  it(
    'overlapping flats of different materials never share a depth (no grass/paving z-fight)',
    { timeout: 60_000 },
    () => {
      const map = resolveMap(getMap('defilad'), 'market');
      const flats = map.flats ?? [];
      const boxes = flats.map(bbox);
      const clashes: string[] = [];
      for (let i = 0; i < flats.length; i++) {
        for (let j = i + 1; j < flats.length; j++) {
          const A = flats[i]!;
          const B = flats[j]!;
          if (A.mat === B.mat || flatDrawLayer(A) !== flatDrawLayer(B) || A.y !== B.y) continue;
          const a = boxes[i]!;
          const b = boxes[j]!;
          if (a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0) continue;
          // Overlap test: a vertex (or the centroid, nudged inward) of one inside the other.
          const probe = (F: MapFlat, G: MapFlat) => {
            const cx = F.pts.reduce((s, p) => s + p[0], 0) / F.pts.length;
            const cz = F.pts.reduce((s, p) => s + p[1], 0) / F.pts.length;
            return [
              ...F.pts.map((p) => [p[0] * 0.98 + cx * 0.02, p[1] * 0.98 + cz * 0.02] as const),
              [cx, cz] as const,
            ].some(([x, z]) => inPoly(x, z, F.pts) && inPoly(x, z, G.pts));
          };
          if (probe(A, B) || probe(B, A))
            clashes.push(`${A.mat}/${B.mat} L${A.layer ?? 0} near ${A.pts[0]!.join(',')}`);
        }
      }
      expect(clashes.slice(0, 5)).toEqual([]);
    },
  );

  it('a footpath sharing a lawn layer draws over it; higher map layers stay above both', () => {
    const path = flatDrawLayer({ layer: 2, mat: 'paving' });
    const lawn = flatDrawLayer({ layer: 2, mat: 'grass' });
    expect(path).not.toBe(lawn);
    expect(path).toBeGreaterThan(lawn);
    // Map layer order is preserved: every draw layer of layer 2 < any of layer 3, > any of layer 1.
    for (const mat of ['grass', 'paving', 'asphalt'] as const) {
      expect(flatDrawLayer({ layer: 3, mat })).toBeGreaterThan(Math.max(path, lawn));
      expect(flatDrawLayer({ layer: 1, mat })).toBeLessThan(Math.min(path, lawn));
    }
  });
});
