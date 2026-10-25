import { describe, expect, it } from 'vitest';
import { SKYLINE_LIGHTS, skylineHaze, skylineWindowCoverage } from './skylineWindows.ts';
import { skylineStyle } from './skylineFacades.ts';

describe('distant skyline windows', () => {
  it('keeps a few golden-hour rooms lit and increases occupancy after sunset', () => {
    expect(SKYLINE_LIGHTS.golden.occupied).toBeGreaterThan(0.02);
    expect(SKYLINE_LIGHTS.golden.occupied).toBeLessThan(0.1);
    for (const id of ['dusk', 'neon'] as const) {
      expect(SKYLINE_LIGHTS[id].occupied).toBeGreaterThan(SKYLINE_LIGHTS.golden.occupied * 3);
      expect(SKYLINE_LIGHTS[id].intensity).toBeGreaterThan(SKYLINE_LIGHTS.golden.intensity);
    }
    for (const id of ['sunny', 'overcast', 'rain'] as const)
      expect(SKYLINE_LIGHTS[id].occupied).toBeLessThan(SKYLINE_LIGHTS.dusk.occupied);
  });

  it('filters the repeating grid to its area at distance without a moire floor', () => {
    expect(skylineWindowCoverage(0.5, 0.001, 0.12, 0.86)).toBeCloseTo(1);
    expect(skylineWindowCoverage(0.02, 0.001, 0.12, 0.86)).toBeCloseTo(0);
    for (const width of [1, 4, 10])
      for (const center of [-31.2, -0.01, 0.2, 1.4, 153.8])
        expect(skylineWindowCoverage(center, width, 0.12, 0.86)).toBeCloseTo(0.74, 8);
  });

  it('adds only restrained horizon-coloured haze beyond the near band', () => {
    expect(skylineHaze(0)).toBe(0);
    expect(skylineHaze(160)).toBe(0);
    expect(skylineHaze(420)).toBeCloseTo(0.04);
    expect(skylineHaze(850)).toBeCloseTo(0.12);
    let previous = 0;
    for (let distance = 0; distance <= 2000; distance += 10) {
      const haze = skylineHaze(distance);
      expect(haze).toBeGreaterThanOrEqual(previous);
      expect(haze).toBeLessThanOrEqual(0.12);
      previous = haze;
    }
  });

  it('varies grid and room identity per building without changing program recipes', () => {
    const styles = Array.from({ length: 32 }, (_, seed) => skylineStyle(seed * 7919, true));
    expect(new Set(styles.map((s) => `${s.bay}/${s.storey}/${s.roomSeed}`)).size).toBe(32);
    for (const style of styles) {
      expect(style.bay).toBeGreaterThanOrEqual(2.4);
      expect(style.bay).toBeLessThanOrEqual(4.2);
      expect(style.storey).toBeGreaterThanOrEqual(3.1);
      expect(style.storey).toBeLessThanOrEqual(3.8);
    }
  });
});
