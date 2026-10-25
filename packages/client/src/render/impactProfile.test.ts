import { describe, expect, it } from 'vitest';
import { DEBRIS, MAX_POINT_PX, impactScale, puffScreenLimit } from './impactProfile.ts';

function projectedPx(worldSize: number, distance: number, viewportHeight = 900, fov = 75): number {
  const focal = viewportHeight / (2 * Math.tan((fov * Math.PI) / 360));
  return (worldSize * impactScale(distance, viewportHeight, fov) * focal) / distance;
}

describe('surface impact profiles', () => {
  it('keeps each surface recognisable, soft ground with only a divot', () => {
    expect(Object.keys(DEBRIS)).toEqual(['stone', 'metal', 'wood', 'glass', 'soft']);
    expect(DEBRIS.stone.dust[0]).toBeGreaterThan(0);
    expect(DEBRIS.metal.sparks[0]).toBeGreaterThan(DEBRIS.stone.sparks[1]);
    expect(DEBRIS.metal.sparks).toEqual([10, 16]);
    expect(DEBRIS.metal.sparkLife).toBeGreaterThanOrEqual(0.3);
    expect(DEBRIS.metal.embers).toEqual([1, 2]);
    // Hard surfaces flash hot for 2–3 frames at 60 fps, then throw streak sparks.
    for (const surface of ['metal', 'stone'] as const) {
      const p = DEBRIS[surface];
      expect(p.flashSize).toBeGreaterThan(0);
      expect(p.flashLife[0]).toBeGreaterThanOrEqual(2 / 60 - 1e-9);
      expect(p.flashLife[1]).toBeLessThanOrEqual(3 / 60 + 1e-9);
      expect(p.sparks[0]).toBeGreaterThan(0);
      expect(p.sparkLength / p.sparkWidth).toBeGreaterThan(8);
      expect(Math.max(...p.sparkColor)).toBeGreaterThan(1); // hot, past tone mapping
    }
    expect(DEBRIS.wood.flashSize).toBe(0);
    expect(DEBRIS.soft.flashSize).toBe(0);
    // Every dusty surface punches a kick of its own colour; dirt the most; metal stays sparks.
    for (const surface of ['stone', 'wood', 'soft'] as const) {
      expect(DEBRIS[surface].kick).toBeGreaterThan(0);
      expect(DEBRIS[surface].kickSpeed).toBeGreaterThan(3);
    }
    expect(DEBRIS.soft.kick).toBeGreaterThan(DEBRIS.stone.kick);
    expect(DEBRIS.metal.kick).toBe(0);
    expect(DEBRIS.soft.dustColor[0]).toBeGreaterThan(DEBRIS.soft.dustColor[2] * 1.5); // brown
    expect(DEBRIS.wood.dustColor[0]).toBeGreaterThan(DEBRIS.wood.dustColor[2] * 2); // wood
    expect(DEBRIS.stone.dustColor[0] / DEBRIS.stone.dustColor[2]).toBeLessThan(1.15); // grey
    expect(DEBRIS.glass.twinkle).toBe(true);
    expect(DEBRIS.glass.embers[0]).toBeGreaterThan(0);
    expect(DEBRIS.wood.chip.sx / DEBRIS.wood.chip.sy).toBeGreaterThan(4);
    expect(DEBRIS.glass.flashSize).toBeGreaterThan(0);
    expect(DEBRIS.soft.dust[0]).toBeGreaterThan(0);
    expect(DEBRIS.soft.decal).toBe(true); // a divot, ground hits only (Effects.impact)
    for (const p of Object.values(DEBRIS)) {
      expect(p.bitLife).toBeGreaterThan(0);
      expect(p.dustLife).toBeGreaterThan(0);
      expect(p.dustSize).toBeGreaterThan(0);
    }
  });

  it('scales dust billows to the new mid-range screen targets with a hard point-blank cap', () => {
    expect(impactScale(40, 900, 75)).toBeGreaterThan(impactScale(5, 900, 75));
    expect(impactScale(1e6, 900, 75)).toBe(6);
    expect(impactScale(0, 900, 75)).toBeGreaterThanOrEqual(0.08);
    expect(impactScale(40, 1800, 75)).toBeLessThan(impactScale(40, 900, 75));
    expect(impactScale(40, 900, 35)).toBeLessThan(impactScale(40, 900, 75));
    for (const d of [0, 5, 40, 1000]) expect(Number.isFinite(impactScale(d, 900, 75))).toBe(true);

    for (const surface of ['stone', 'wood', 'soft'] as const) {
      const p = DEBRIS[surface];
      expect(p.dust).toEqual([2, 2]);
      expect(p.dustLife * 0.8).toBeGreaterThanOrEqual(0.6);
      expect(p.dustLife * 1.2).toBeLessThanOrEqual(1.1);
      for (const distance of [10, 15, 25, 40]) {
        const peak = projectedPx(p.dustSize, distance) * 1.15;
        expect(peak * 0.9).toBeGreaterThanOrEqual(distance === 40 ? 40 : 70);
        if (distance !== 40) expect(peak * 1.1 * 1.1).toBeLessThanOrEqual(120);
      }
    }
    expect(MAX_POINT_PX).toBeGreaterThan(64);
    expect(puffScreenLimit(true)).toBeLessThan(puffScreenLimit(false));
    expect(puffScreenLimit(false, 900)).toBeLessThanOrEqual(900 * 0.22);
    expect(puffScreenLimit(true, 900)).toBeCloseTo(puffScreenLimit(false, 900) * 0.8);
  });

  it('sizes sparks, chips, and decals for visible hits without changing draw counts', () => {
    expect(projectedPx(DEBRIS.metal.flashSize, 15)).toBeGreaterThanOrEqual(40);
    expect(projectedPx(DEBRIS.metal.flashSize, 15)).toBeLessThanOrEqual(70);
    const minMetalTrail = projectedPx(0.42 * 0.75, 15);
    const maxMetalTrail = projectedPx(0.42 * 1.25, 15);
    expect(minMetalTrail).toBeGreaterThanOrEqual(30);
    expect(maxMetalTrail).toBeLessThanOrEqual(80);
    for (const surface of ['stone', 'wood'] as const) {
      // Tetrahedron span in its longest local axis; pieces tumble through this silhouette.
      const span = DEBRIS[surface].chip.sx * (2 / Math.sqrt(3));
      for (const distance of [10, 15]) {
        expect(projectedPx(span, distance)).toBeGreaterThanOrEqual(4);
        expect(projectedPx(span, distance)).toBeLessThanOrEqual(10);
      }
    }
  });
});
