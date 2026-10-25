import { describe, expect, it } from 'vitest';
import { PALACE_TINT, getMap, resolveMap } from '@wd/shared';
import {
  FACADE_STYLES,
  RELIEF_MAX,
  RELIEF_MIN,
  facadeFaces,
  faceRelief,
  type FaceSegment,
  type FacadePart,
  type LocalQuad,
} from './facadeRelief.ts';
import {
  isPalacePorticoFriezeFace,
  palacePorticoColumnPositions,
  palacePorticoFriezeFeatures,
} from './palacePorticoFrieze.ts';

const allQuads = (segs: FaceSegment[]): LocalQuad[] =>
  segs.flatMap((s) => Object.values(s.parts).flat());
const partQuads = (segs: FaceSegment[], part: FacadePart): LocalQuad[] =>
  segs.flatMap((s) => s.parts[part]);
const fronts = (qs: LocalQuad[]): LocalQuad[] => qs.filter((q) => q.axis === 'o');

describe('Palace portico frieze relief', () => {
  const market = resolveMap(getMap('defilad'), 'market');
  const faces = facadeFaces(market, PALACE_TINT);
  const targets = faces.filter(isPalacePorticoFriezeFace);

  it('selects the single east-facing beam over the authored Palace portico', () => {
    expect(targets).toHaveLength(1);
    const f = targets[0]!;
    expect(f.style).toBe('monumental');
    expect(f.y0).toBeCloseTo(12, 6);
    expect(f.y1).toBeCloseTo(16, 6);
    expect(f.len).toBeGreaterThan(33);
    expect(f.len).toBeLessThan(35);
    expect(f.dz).toBeGreaterThan(0.99);
    expect(f.cover).toEqual([]);
  });

  it('replaces the generic painted panel with frame-owned bosses and a dentil row', () => {
    const f = targets[0]!;
    const segs = faceRelief(f);
    expect(partQuads(segs, 'panel')).toHaveLength(0);
    expect(partQuads(segs, 'glass')).toHaveLength(0);
    expect(
      palacePorticoFriezeFeatures(f, { x0: 1.05, x1: f.len - 1.05, y0: 12.35, y1: 14.55 }),
    ).toHaveLength(33);
    const frontDepths = new Set(fronts(partQuads(segs, 'frame')).map((q) => q.o0));
    expect(frontDepths.has(-0.045)).toBe(true);
    expect(frontDepths.has(-0.115)).toBe(true);
    expect(frontDepths.has(-0.035)).toBe(true);
  });

  it('aligns every shallow boss to a modeled portico column', () => {
    const f = targets[0]!;
    const columns = palacePorticoColumnPositions(f);
    expect(columns).toHaveLength(8);
    for (const x of columns) {
      const boss = fronts(partQuads(faceRelief(f), 'frame')).find(
        (q) => q.o0 === -0.115 && q.x0 < x && q.x1 > x && q.y0 > 12.9 && q.y1 < 14.1,
      );
      expect(boss, `column at local ${x}`).toBeDefined();
      expect((boss!.x0 + boss!.x1) / 2).toBeCloseTo(x, 6);
    }
  });

  it('keeps the full actual Palace window count and relief envelope unchanged', () => {
    const beforeGlass = faces.reduce(
      (n, f) => n + partQuads(faceRelief(f, false), 'glass').length,
      0,
    );
    const afterGlass = faces.reduce((n, f) => n + partQuads(faceRelief(f), 'glass').length, 0);
    expect(beforeGlass).toBe(6284);
    expect(afterGlass).toBe(6284);
    let deepest = 0;
    let highest = -Infinity;
    for (const f of faces) {
      for (const q of allQuads(faceRelief(f))) {
        deepest = Math.min(deepest, q.o0, q.o1);
        highest = Math.max(highest, q.o0, q.o1);
      }
    }
    expect(deepest).toBeGreaterThanOrEqual(RELIEF_MIN);
    expect(highest).toBeLessThanOrEqual(RELIEF_MAX);
    expect(FACADE_STYLES.monumental.field).toBe(-0.22);
  });
});
