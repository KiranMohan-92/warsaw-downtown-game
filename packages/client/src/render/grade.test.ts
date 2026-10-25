import { describe, expect, it } from 'vitest';
import {
  GRADE,
  GRADE_GLSL,
  gradeDisplayRef,
  gradeLinear,
  linearToSrgb,
  srgbToLinear,
} from './grade.ts';
import { LowFrame } from './lowFrame.ts';

describe('shared colour grade', () => {
  it('pivots contrast on display mid grey (sRGB 0.5), stretching round it', () => {
    const grey = ((0.5 + 0.055) / 1.055) ** 2.4; // linear value of sRGB 0.5
    for (const v of gradeLinear([grey, grey, grey], [0.5, 0.5])) expect(v).toBeCloseTo(grey, 6);
    const dark = gradeLinear([0.05, 0.05, 0.05], [0.5, 0.5])[0];
    const bright = gradeLinear([0.6, 0.6, 0.6], [0.5, 0.5])[0];
    expect(dark).toBeLessThan(0.05);
    expect(dark).toBeGreaterThan(0.03); // darker, never crushed to black
    expect(bright).toBeGreaterThan(0.6);
  });

  it('saturates away from the mean (postprocessing HueSaturation, saturation > 0)', () => {
    const [r, g, b] = gradeLinear([0.6, 0.4, 0.4], [0.5, 0.5]);
    expect(r - g).toBeGreaterThan(0.2);
    expect(g).toBeCloseTo(b, 9);
  });

  it('vignette: untouched in the middle, darker in the corners', () => {
    const mid = gradeLinear([0.3, 0.3, 0.3], [0.5, 0.5])[0];
    const corner = gradeLinear([0.3, 0.3, 0.3], [0, 0])[0];
    const edge = gradeLinear([0.3, 0.3, 0.3], [0.5, 0.1])[0];
    expect(corner).toBeLessThan(mid * 0.85);
    expect(edge).toBeLessThanOrEqual(mid);
    expect(edge).toBeGreaterThan(corner);
  });

  it("Low's display-space grade stays within ~7 % (worst, saturated colours) of the post chain's", () => {
    let worst = 0;
    const steps = [0.02, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.98];
    for (const r of steps)
      for (const g of steps)
        for (const uv of [
          [0.5, 0.5],
          [0.2, 0.3],
          [0.05, 0.05],
        ] as const) {
          const c = [r, g, (r + g) / 2] as const;
          const ref = gradeLinear([srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])], uv);
          const got = gradeDisplayRef(c, uv);
          for (let i = 0; i < 3; i++)
            worst = Math.max(
              worst,
              Math.abs(got[i]! - linearToSrgb(Math.min(1, Math.max(0, ref[i]!)))),
            );
        }
    expect(worst).toBeLessThan(0.07);
  });

  it("Low's present programs (copy and CAS) both apply the same grade constants", () => {
    expect(GRADE_GLSL).toContain((1 - 1 / (1.001 - GRADE.saturation)).toFixed(5));
    expect(GRADE_GLSL).toContain((1 / (1 - GRADE.contrast)).toFixed(5));
    const low = new LowFrame() as unknown as {
      copy: { fragmentShader: string };
      cas: { fragmentShader: string };
    };
    for (const m of [low.copy, low.cas]) {
      expect(m.fragmentShader).toContain('gradeDisplay(');
      expect(m.fragmentShader.match(/gradeDisplay\(/g)!.length).toBe(2); // definition + call
    }
  });
});
