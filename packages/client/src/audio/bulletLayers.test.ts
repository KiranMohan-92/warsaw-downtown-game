import { describe, expect, it } from 'vitest';
import type { SurfaceKind } from '@wd/shared';
import {
  BULLET_LAYER_GAP,
  BULLET_LAYER_RANGE,
  BulletLayerGate,
  RICOCHET_CHANCE,
  bulletLayer,
} from './bulletLayers.ts';

const SURFACES: SurfaceKind[] = ['stone', 'metal', 'wood', 'glass', 'soft'];
const fixed = (x: number) => (): number => x;

describe('bullet layers (synthesized crack + material + ricochet)', () => {
  it('every surface cracks first, then its own material answer', () => {
    for (const s of SURFACES) {
      const v = bulletLayer(s, 10, 0.5, fixed(0.5));
      expect(v.length).toBeGreaterThanOrEqual(2);
      // The crack is the first voice, immediate and very short.
      const crack = v[0]!;
      expect(crack.kind).toBe('noise');
      expect(crack.delay).toBe(0);
      if (crack.kind === 'noise') expect(crack.decay).toBeLessThanOrEqual(0.015);
    }
    // Materials differ: glass tinkles (tones), metal rings (a tone), soft thuds (low noise).
    expect(
      bulletLayer('glass', 10, 0.5, fixed(0.5)).filter((x) => x.kind === 'tone').length,
    ).toBeGreaterThanOrEqual(3);
    expect(bulletLayer('metal', 10, 0.5, fixed(0.5)).some((x) => x.kind === 'tone')).toBe(true);
    const soft = bulletLayer('soft', 10, 0.5, fixed(0.5));
    expect(soft.some((x) => x.kind === 'noise' && x.filter === 'lowpass' && x.freq < 400)).toBe(
      true,
    );
  });

  it('far hits lose their top end and stop layering past the range', () => {
    const near = bulletLayer('stone', 5, 0.5, fixed(0.5))[0]!;
    const far = bulletLayer('stone', 30, 0.5, fixed(0.5))[0]!;
    if (near.kind !== 'noise' || far.kind !== 'noise') throw new Error('crack is noise');
    expect(far.freq).toBeLessThan(near.freq);
    expect(bulletLayer('stone', BULLET_LAYER_RANGE + 1, 0.5, fixed(0.5))).toEqual([]);
    expect(bulletLayer('stone', 5, 0, fixed(0.5))).toEqual([]);
  });

  it('ricochets: only hard surfaces, only near, and at their chance', () => {
    for (const s of SURFACES) {
      const sings = bulletLayer(s, 10, 0.5, fixed(0)).some((x) => x.kind === 'sweep');
      expect(sings).toBe(RICOCHET_CHANCE[s] > 0);
      // Above the chance threshold: no whine.
      expect(bulletLayer(s, 10, 0.5, fixed(0.99)).some((x) => x.kind === 'sweep')).toBe(false);
    }
    expect(bulletLayer('metal', 30, 0.5, fixed(0)).some((x) => x.kind === 'sweep')).toBe(false);
  });

  it('never louder than the hit level it was given', () => {
    for (const s of SURFACES)
      for (const v of bulletLayer(s, 8, 0.4, fixed(0))) expect(v.gain).toBeLessThanOrEqual(0.4);
  });

  it('the gate lets one layer through per gap (a shotgun volley is one layer, not nine)', () => {
    const gate = new BulletLayerGate();
    let opened = 0;
    for (let i = 0; i < 9; i++) if (gate.open(1 + i * 0.001)) opened++;
    expect(opened).toBe(1);
    expect(gate.open(1 + BULLET_LAYER_GAP + 0.001)).toBe(true);
    // Full auto at 750 rpm (80 ms apart): every round gets its layer.
    const auto = new BulletLayerGate();
    let n = 0;
    for (let i = 0; i < 10; i++) if (auto.open(i * 0.08)) n++;
    expect(n).toBe(10);
  });
});
