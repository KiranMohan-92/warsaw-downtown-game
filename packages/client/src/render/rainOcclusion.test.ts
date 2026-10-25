import { describe, expect, it } from 'vitest';
import { getMap, resolveMap, type MapDefinition } from '@wd/shared';
import {
  NO_COVER,
  bakeRainOcclusion,
  isSheltered,
  occlusionTop,
  rainOcclusion,
  rainShelter,
  setRainOcclusionMap,
} from './rainOcclusion.ts';

const empty = (over: Partial<MapDefinition>): MapDefinition => ({
  name: 't',
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  boxes: [],
  spawns: [],
  dummies: [],
  ...over,
});

describe('rain occlusion bake', () => {
  it('records the highest surface over each column, rotated footprints included', () => {
    const map = empty({
      boxes: [
        { center: { x: 0, y: -0.25, z: 0 }, size: { x: 40, y: 0.5, z: 40 }, mat: 'concrete' },
        // A canopy at 2.3 m over a 3 × 2 m patch, turned 90°: 2 m along x, 3 m along z.
        {
          center: { x: 5, y: 2.3, z: 5 },
          size: { x: 3, y: 0.06, z: 2 },
          rot: { x: 0, y: 90, z: 0 },
          mat: 'paint',
        },
        // Invisible bounds never stop rain.
        {
          center: { x: -10, y: 50, z: 0 },
          size: { x: 1, y: 100, z: 40 },
          mat: 'concrete',
          visible: false,
        },
      ],
      prisms: [
        {
          pts: [
            [10, -10],
            [14, -10],
            [14, -6],
            [10, -6],
          ],
          y0: 0,
          y1: 7,
          mat: 'plaster',
        },
      ],
    });
    const o = bakeRainOcclusion(map);
    expect(occlusionTop(o, 1, 1)).toBeCloseTo(0, 5);
    expect(occlusionTop(o, 5, 6.3)).toBeCloseTo(2.33, 5);
    expect(occlusionTop(o, 5.8, 5)).toBeCloseTo(2.33, 5);
    expect(occlusionTop(o, 6.3, 5)).toBeCloseTo(0, 5); // outside the turned canopy
    expect(occlusionTop(o, 12, -8)).toBe(7);
    expect(occlusionTop(o, -10, 0)).toBeCloseTo(0, 5);
    expect(occlusionTop(o, 500, 0)).toBe(NO_COVER);
    expect(isSheltered(o, 5, 0, 5)).toBe(true);
    expect(isSheltered(o, 5, 2.33, 5)).toBe(false); // standing on it
    expect(isSheltered(o, 1, 0, 1)).toBe(false);
  });

  it('lets rain end in foliage (soft) and flags it', () => {
    const o = bakeRainOcclusion(empty({ foliage: [{ x: 3, z: 3, r: 1.5, h: 1.6, kind: 'bush' }] }));
    const i = Math.floor((3 - o.minX) / o.texel);
    const j = Math.floor((3 - o.minZ) / o.texel);
    expect(o.soft[j * o.width + i]).toBe(1);
    expect(occlusionTop(o, 3, 3)).toBeGreaterThan(1.2);
  });
});

describe('rain occlusion on the Market', () => {
  const map = resolveMap(getMap('defilad'), 'market');
  const o = bakeRainOcclusion(map);

  it('is open on the plaza and over the streets', () => {
    expect(isSheltered(o, 66, 0.05, 4)).toBe(false);
    expect(Math.abs(occlusionTop(o, 66, 4))).toBeLessThan(0.1);
    expect(isSheltered(o, 70, 0.05, -12)).toBe(false);
  });

  it('keeps rain off under a stall awning, in the hall, the metro and the helicopter wreck', () => {
    // Behind the counter of the stall at (98, -53.1), under its awning (2.3 m).
    expect(isSheltered(o, 98, 0.05, -52.8)).toBe(true);
    expect(occlusionTop(o, 98, -52.8)).toBeGreaterThan(2.2);
    // Both floors of the market hall (roof 7.5 m).
    expect(occlusionTop(o, 140, 24)).toBeGreaterThan(7.2);
    expect(isSheltered(o, 140, 3.6, 24)).toBe(true);
    // The metro passage: the street over it.
    expect(isSheltered(o, 80, -5, 0)).toBe(true);
    // Inside the helicopter wreck's hull.
    expect(isSheltered(o, 74, 0.4, 32)).toBe(true);
  });

  it('bakes in well under a second on the Market', () => {
    const t = performance.now();
    bakeRainOcclusion(map);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('tells the audio how sheltered the listener is', () => {
    const open = rainShelter(o, 66, 1.6, 4);
    expect(open.roof).toBe(Infinity);
    expect(open.open).toBeGreaterThan(0.8);
    const hall = rainShelter(o, 140, 1.6, 21);
    // The rain drums on the hall roof (7.5 m), the topmost cover, not the floor between.
    expect(hall.roof).toBeGreaterThan(5);
    expect(hall.roof).toBeLessThan(6.5);
    expect(hall.open).toBeLessThan(0.3);
    const stall = rainShelter(o, 98, 1.6, -52.8);
    expect(stall.roof).toBeLessThan(1);
  });

  it('feeds the shared sampler (half-float top + soft flag) and its rect', () => {
    const baked = setRainOcclusionMap(map);
    const t = rainOcclusion.map.value;
    expect(t.image.width).toBe(baked.width);
    expect(t.image.height).toBe(baked.height);
    const r = rainOcclusion.rect.value;
    expect(r.x).toBe(baked.minX);
    expect(1 / r.z).toBeCloseTo(baked.width * baked.texel, 5);
  });
});
