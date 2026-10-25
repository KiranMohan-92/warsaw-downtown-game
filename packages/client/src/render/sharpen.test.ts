import { describe, expect, it } from 'vitest';
import { CAS_FULL_AT, CasEffect, casChannel, casStrength } from './sharpen.ts';

describe('CAS strength curve (follows dynamic resolution)', () => {
  it('is off at native resolution and above', () => {
    expect(casStrength(1)).toBe(0);
    expect(casStrength(1.25)).toBe(0);
    expect(casStrength(Number.NaN)).toBe(0);
  });

  it('ramps linearly to full at CAS_FULL_AT and stays there', () => {
    expect(casStrength(0.75)).toBeCloseTo(0.5);
    expect(casStrength(CAS_FULL_AT)).toBe(1);
    expect(casStrength(0.3)).toBe(1);
    // The reference iGPU settles around 60–65 %: a clear but moderate sharpen.
    expect(casStrength(0.65)).toBeCloseTo(0.7);
  });

  it('never decreases as the resolution drops', () => {
    let prev = -1;
    for (let s = 1.1; s >= 0.2; s -= 0.01) {
      const v = casStrength(s);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('CAS filter maths (mirrors the shader)', () => {
  it('is the identity at strength 0 and on flat areas', () => {
    expect(casChannel(0.3, 0.9, 0.1, 0.5, 0.2, 0)).toBe(0.3);
    expect(casChannel(0.42, 0.42, 0.42, 0.42, 0.42, 1)).toBeCloseTo(0.42, 12);
    expect(casChannel(3.5, 3.5, 3.5, 3.5, 3.5, 1)).toBeCloseTo(3.5, 12); // HDR value
  });

  it('steepens a blurred edge (what the upscale softened)', () => {
    // A horizontal ramp 0.2 → 0.35: the pixel on the dark half is pushed darker…
    const dark = casChannel(0.25, 0.25, 0.25, 0.35, 0.2, 1);
    expect(dark).toBeLessThan(0.25);
    expect(dark).toBeGreaterThanOrEqual(0.2);
    // …the one on the bright half brighter.
    const bright = casChannel(0.3, 0.3, 0.3, 0.35, 0.2, 1);
    expect(bright).toBeGreaterThan(0.3);
    expect(bright).toBeLessThanOrEqual(0.35);
    // Weaker at lower strength.
    const soft = casChannel(0.25, 0.25, 0.25, 0.35, 0.2, 0.5);
    expect(soft).toBeGreaterThan(dark);
    expect(soft).toBeLessThan(0.25);
  });

  it('leaves a hard step alone (a local extreme is never pushed past its neighbours)', () => {
    expect(casChannel(0.2, 0.2, 0.2, 0.35, 0.2, 1)).toBeCloseTo(0.2, 12);
  });

  it('never rings outside the neighbourhood (no halos, no negatives) even next to the sun', () => {
    for (const [c, n, s, e, w] of [
      [0.05, 0.05, 0.05, 40, 0.05],
      [40, 40, 0.05, 40, 40],
      [0, 1, 0, 1, 0],
      [0.5, 0, 1, 0, 1],
    ] as const) {
      const r = casChannel(c, n, s, e, w, 1);
      expect(r).toBeGreaterThanOrEqual(Math.min(c, n, s, e, w) - 1e-9);
      expect(r).toBeLessThanOrEqual(Math.max(c, n, s, e, w) + 1e-9);
      expect(Number.isFinite(r)).toBe(true);
    }
  });

  it('is a convolution effect whose strength is a uniform (no recompiles)', () => {
    const cas = new CasEffect();
    expect(cas.strength).toBe(0);
    cas.strength = 0.8;
    expect(cas.strength).toBe(0.8);
    expect(cas.getFragmentShader()).toContain('uniform float strength;');
    expect(cas.getFragmentShader()).toContain('0.200 * strength');
  });
});
