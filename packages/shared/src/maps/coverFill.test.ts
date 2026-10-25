import { describe, expect, it } from 'vitest';
import { coverFill } from './coverFill.ts';
import { R } from './solids.ts';
import type { MapBox } from './types.ts';

const footprint = (b: MapBox): { x0: number; z0: number; x1: number; z1: number } => {
  const yaw = ((b.rot?.y ?? 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (b.size.x * c + b.size.z * s) / 2;
  const hz = (b.size.x * s + b.size.z * c) / 2;
  return { x0: b.center.x - hx, z0: b.center.z - hz, x1: b.center.x + hx, z1: b.center.z + hz };
};

describe('cover fill: truck lanes (keep open, still measured)', () => {
  it('puts cover beside a lane, never in it, and the lane still counts toward the gap', () => {
    const lane = R(-40, -3, 40, 3); // a 6 m clear lane straight across
    const fill = coverFill({
      bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      boxes: [],
      prisms: [],
      trees: [],
      foliage: [],
      keepClear: [],
      keepOpen: [lane],
      maxGap: 4,
      seed: 3,
    });
    expect(fill.placed).toBeGreaterThan(10);
    for (const b of fill.boxes) {
      if (b.collide === false) continue;
      const f = footprint(b);
      const inLane =
        f.x0 < lane.x1 && f.x1 > lane.x0 && f.z0 < lane.z1 - 0.6 && f.z1 > lane.z0 + 0.6;
      expect(inLane, `${JSON.stringify(b.center)} stands in the lane`).toBe(false);
    }
    // Measured everywhere, the lane included (a protected rect would not be): within a grid
    // diagonal of the target on an empty lot (the Market's own fill holds 4 m: placDefilad.test).
    expect(fill.maxGap).toBeLessThanOrEqual(4 + 2 * (Math.SQRT2 - 1) + 1e-6);
    const asProtected = coverFill({
      bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      boxes: [],
      prisms: [],
      trees: [],
      foliage: [],
      keepClear: [lane],
      maxGap: 4,
      seed: 3,
    });
    // Protected, the lane's own cells don't count, so the fill does less beside it.
    expect(fill.placed).toBeGreaterThanOrEqual(asProtected.placed);
    // Something was placed hard by each side of the lane.
    const near = (side: number): boolean =>
      fill.boxes.some((b) => {
        const f = footprint(b);
        return side > 0 ? f.z0 >= 2.4 && f.z0 < 6 : f.z1 <= -2.4 && f.z1 > -6;
      });
    expect(near(1) && near(-1)).toBe(true);
  });
});
