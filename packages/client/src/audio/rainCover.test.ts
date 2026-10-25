import { describe, expect, it } from 'vitest';
import { getMap, resolveMap } from '@wd/shared';
import { bakeRainOcclusion, rainShelter } from '../render/rainOcclusion.ts';
import { rainCoverMix } from './rainCover.ts';

describe('rain sound under cover', () => {
  it('is full and bright in the open', () => {
    const m = rainCoverMix({ roof: Infinity, open: 1 });
    expect(m.bed).toBe(1);
    expect(m.drum).toBe(0);
    expect(m.cutoff).toBeGreaterThan(15000);
  });

  it('drums on a low awning, muffles in the hall, all but silences the metro', () => {
    const o = bakeRainOcclusion(resolveMap(getMap('defilad'), 'market'));
    const at = (x: number, y: number, z: number) => rainCoverMix(rainShelter(o, x, y, z));
    const open = at(66, 1.6, 4);
    const stall = at(98, 1.6, -52.8);
    const hall = at(140, 1.6, 21);
    const metro = at(80, -3.4, 0);
    expect(stall.drum).toBeGreaterThan(0.5);
    expect(stall.drum).toBeGreaterThan(hall.drum);
    expect(hall.cutoff).toBeLessThan(open.cutoff / 4);
    expect(hall.bed).toBeLessThan(open.bed);
    expect(metro.bed).toBeLessThanOrEqual(hall.bed);
    expect(metro.cutoff).toBeLessThan(1500);
  });
});
