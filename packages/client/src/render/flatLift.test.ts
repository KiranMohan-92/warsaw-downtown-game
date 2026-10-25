import { describe, expect, it } from 'vitest';
import type { MapFlat } from '@wd/shared';
import { createFlatLift } from './flatLift.ts';
import { FLAT_LIFT, flatDrawLayer } from './mapMesh.ts';

const square = (x0: number, z0: number, x1: number, z1: number, layer: number, y = 0): MapFlat => ({
  pts: [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ],
  y,
  mat: 'paving',
  layer,
});

describe('rendered ground lift over the collision (map flats)', () => {
  it('returns the highest flat drawn over a point at that height, else 0', () => {
    const low = square(0, 0, 20, 20, 0);
    const high = square(5, 5, 10, 10, 3);
    const lift = createFlatLift([low, high]);
    const liftOf = (f: MapFlat): number => FLAT_LIFT.base + flatDrawLayer(f) * FLAT_LIFT.perLayer;
    expect(lift(2, 0, 2)).toBeCloseTo(liftOf(low));
    expect(lift(7, 0, 7)).toBeCloseTo(liftOf(high));
    expect(lift(30, 0, 30)).toBe(0); // no flat
    expect(lift(7, 3, 7)).toBe(0); // a roof 3 m up is not this paving
    // Not a box test: a triangle's far corner is outside it.
    const tri: MapFlat = {
      pts: [
        [40, 0],
        [48, 0],
        [40, 8],
      ],
      y: 0,
      mat: 'grass',
      layer: 1,
    };
    const t = createFlatLift([tri]);
    expect(t(41, 0, 1)).toBeGreaterThan(0);
    expect(t(47, 0, 7)).toBe(0);
    // Across grid cells.
    expect(createFlatLift([square(-30, -30, 30, 30, 2)])(-25, 0, 25)).toBeGreaterThan(0);
  });
});
