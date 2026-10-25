import { describe, expect, it } from 'vitest';
import { BAY, FACADE_STYLES, STOREY, WINDOW } from './facadeRelief.ts';
import { PALACE_RELIEF_SHADE } from './palaceCavity.ts';
import { palaceReliefMask } from './palaceReliefMask.ts';

const sample = (x: number, y: number): readonly [number, number, number] =>
  palaceReliefMask(x / BAY, y / STOREY);

describe('baked Palace relief masks', () => {
  it('pins jambs, head, course/sill highlights, and background independently', () => {
    const middleY = (WINDOW.y0 + WINDOW.y1) / 2;
    expect(sample(WINDOW.s0 - PALACE_RELIEF_SHADE.jamb / 2, middleY)).toEqual([1, 0, 0]);
    expect(sample(WINDOW.s1 + PALACE_RELIEF_SHADE.jamb / 2, middleY)).toEqual([1, 0, 0]);
    expect(sample(BAY / 2, WINDOW.y1 + PALACE_RELIEF_SHADE.head / 2)).toEqual([0, 1, 0]);
    expect(sample(0.1, FACADE_STYLES.monumental.course.y1 - 0.035)).toEqual([0, 0, 1]);
    expect(sample(BAY / 2, WINDOW.y0 - 0.04)).toEqual([0, 0, 1]);
    expect(sample(0.1, STOREY - 0.1)).toEqual([0, 0, 0]);
  });

  it('leaves window panes clear away from filtered boundaries', () => {
    for (const u of [0.32, 0.4, 0.5, 0.6, 0.68]) {
      for (const v of [0.3, 0.4, 0.55, 0.7, 0.8]) {
        expect(palaceReliefMask(u, v)).toEqual([0, 0, 0]);
      }
    }
  });

  it('box-filters edges, including a footprint wider than a thin ledge', () => {
    expect(sample(WINDOW.s0, (WINDOW.y0 + WINDOW.y1) / 2)[0]).toBeCloseTo(0.5, 12);
    expect(sample(BAY / 2, WINDOW.y1)[1]).toBeCloseTo(0.5, 12);
    expect(sample(BAY / 2, WINDOW.y0)[2]).toBeCloseTo(0.5, 12);
    const course = FACADE_STYLES.monumental.course;
    expect(palaceReliefMask(0.05, (course.y1 - 0.035) / STOREY, 0.1)[2]).toBeCloseTo(
      0.07 / (STOREY * 0.1),
      12,
    );
  });

  it('conserves coverage on the 512px grid and stays bounded', () => {
    const size = 512;
    const totals = [0, 0, 0];
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const masks = palaceReliefMask((x + 0.5) / size, (y + 0.5) / size, 1 / size);
        for (let c = 0; c < 3; c++) {
          totals[c]! += masks[c]!;
          min = Math.min(min, masks[c]!);
          max = Math.max(max, masks[c]!);
        }
      }
    }
    const windowWidth = WINDOW.s1 - WINDOW.s0;
    const expectedAreas = [
      2 * PALACE_RELIEF_SHADE.jamb * (WINDOW.y1 - WINDOW.y0),
      (windowWidth + 2 * PALACE_RELIEF_SHADE.jamb) * PALACE_RELIEF_SHADE.head,
      0.07 * BAY + 0.08 * windowWidth,
    ];
    expect(min).toBe(0);
    expect(max).toBe(1);
    expectedAreas.forEach((area, c) => {
      expect(totals[c]! / (size * size)).toBeCloseTo(area / (BAY * STOREY), 10);
    });
  });
});
