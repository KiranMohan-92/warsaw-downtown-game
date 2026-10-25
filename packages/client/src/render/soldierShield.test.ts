import { describe, expect, it } from 'vitest';
import { shieldEmissive } from './soldiers.ts';

describe('spawn-protection shimmer (soldier emissive colour, no new program)', () => {
  it('off: exactly the old white hit flash', () => {
    for (const flash of [0, 0.4, 1]) {
      const e = shieldEmissive(0, 3.2, flash);
      expect(e.r).toBeCloseTo(flash * 0.35, 9);
      expect(e.g).toBeCloseTo(flash * 0.35, 9);
      expect(e.b).toBeCloseTo(flash * 0.35, 9);
    }
  });

  it('on: a subtle cyan tint that pulses, never brighter than a hit flash', () => {
    const samples = Array.from({ length: 40 }, (_, i) => shieldEmissive(1, i * 0.02, 0));
    for (const e of samples) {
      expect(e.b).toBeGreaterThan(e.r * 3); // cyan, not white
      expect(e.g).toBeGreaterThan(e.r * 3);
      expect(Math.max(e.r, e.g, e.b)).toBeLessThanOrEqual(0.35);
    }
    const blues = samples.map((e) => e.b);
    expect(Math.max(...blues) - Math.min(...blues)).toBeGreaterThan(0.05); // it shimmers
  });
});
