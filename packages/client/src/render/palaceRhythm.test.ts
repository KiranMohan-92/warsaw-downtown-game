import { describe, expect, it } from 'vitest';
import { getMap, PALACE_TINT, resolveMap } from '@wd/shared';
import { BAY, FACADE_STYLES, WINDOW, facadeFaces, faceRelief } from './facadeRelief.ts';

describe('Palace tier rhythm', () => {
  const faces = facadeFaces(resolveMap(getMap('defilad'), 'market'), PALACE_TINT);

  it('gives sills and courses substantial top/under faces without extending past the wall', () => {
    const face = faces.find((f) => f.style === 'monumental' && f.y0 === 62 && f.dz === 1)!;
    const horizontal = faceRelief(face)
      .flatMap((s) => s.parts.detail)
      .filter((q) => q.axis === 'y');
    const sill = horizontal.filter((q) => {
      const phase = ((q.y0 % 3.3) + 3.3) % 3.3;
      return Math.abs(phase - WINDOW.y0) < 1e-6;
    });
    expect(sill.length).toBeGreaterThan(0);
    for (const q of sill) {
      expect(Math.abs(q.o1 - q.o0)).toBeGreaterThanOrEqual(0.179);
      expect(Math.max(q.o0, q.o1)).toBeLessThanOrEqual(0);
    }
    const courses = horizontal.filter((q) =>
      [0.35, 0.55].some((phase) => Math.abs((((q.y0 % 3.3) + 3.3) % 3.3) - phase) < 1e-6),
    );
    expect(courses.some((q) => Math.abs(q.o1 - q.o0) >= 0.174)).toBe(true);
    expect(courses.some((q) => q.sign > 0)).toBe(true);
    expect(courses.some((q) => q.sign < 0)).toBe(true);
  });

  it('groups three windows between full-height stone ribs', () => {
    const f = faces.find((f) => f.style === 'monumental' && f.y0 === 62 && f.dz === 1)!;
    const fronts = faceRelief(f)
      .flatMap((s) => s.parts.frame)
      .filter((q) => q.axis === 'o' && q.o0 === 0 && q.y0 <= 70 && q.y1 >= 70)
      .sort((a, b) => a.x0 - b.x0);
    // Cell boundaries can split the centre rib into two halves; check the joined stone run.
    const runs: [number, number][] = [];
    for (const q of fronts) {
      const last = runs.at(-1);
      if (last && Math.abs(last[1] - q.x0) < 1e-6) last[1] = q.x1;
      else runs.push([q.x0, q.x1]);
    }
    const centres = runs
      .filter(([lo, hi]) => Math.abs(hi - lo - FACADE_STYLES.monumental.pilaster!.major) < 1e-6)
      .map(([lo, hi]) => (lo + hi) / 2);
    expect(centres.length).toBeGreaterThan(2);
    for (let i = 1; i < centres.length; i++)
      expect(centres[i]! - centres[i - 1]!).toBeCloseTo(3 * BAY);
    expect(FACADE_STYLES.monumental.field).toBe(-0.22);
  });

  it('keeps window counts and grid UVs while making tier-base accent windows taller', () => {
    const quads = faces.flatMap((f) => faceRelief(f).flatMap((s) => s.parts.glass));
    expect(quads).toHaveLength(6284);
    const tall = quads.filter((q) => q.uvY0 !== undefined);
    expect(tall.length).toBeGreaterThan(20);
    for (const q of tall) {
      expect(q.y1 - q.y0).toBeCloseTo(WINDOW.y1 - WINDOW.y0 + 0.5);
      expect(q.uvY1! - q.uvY0!).toBeCloseTo(WINDOW.y1 - WINDOW.y0);
    }
    for (const f of faces.filter((f) => f.style === 'block')) {
      expect(
        faceRelief(f)
          .flatMap((s) => s.parts.panel)
          .every((q) => q.uvY0 === undefined),
      ).toBe(true);
    }
    for (const f of faces.filter((f) => f.style === 'monumental')) {
      const segments = faceRelief(f);
      const panels = segments.flatMap((s) => s.parts.panel);
      for (const pane of segments
        .flatMap((s) => s.parts.glass)
        .filter((q) => q.uvY0 !== undefined)) {
        const x = (pane.x0 + pane.x1) / 2;
        for (const t of [0.15, 0.5, 0.85]) {
          const y = pane.y0 + t * (pane.y1 - pane.y0);
          const covering = panels.filter((q) => q.x0 < x && q.x1 > x && q.y0 <= y && q.y1 >= y);
          expect(covering).toHaveLength(1);
          const panel = covering[0]!;
          const panelUvY =
            panel.uvY0 === undefined
              ? y
              : panel.uvY0 + ((y - panel.y0) / (panel.y1 - panel.y0)) * (panel.uvY1! - panel.uvY0);
          expect(panelUvY).toBeCloseTo(pane.uvY0! + t * (pane.uvY1! - pane.uvY0!), 6);
        }
      }
    }
  });

  it('keeps accent height continuous across the 34-62 m east wall run seams', () => {
    const runFaces = [1354, 1355, 1356, 1358, 1359].map((prism) => {
      const face = faces.find((f) => f.prism === prism && f.edge === 1)!;
      expect(face.seam0 || prism === 1354).toBe(true);
      expect(face.seam1 || prism === 1359).toBe(true);
      return face;
    });
    const firstStoreyPanes = runFaces.flatMap((face) =>
      faceRelief(face)
        .flatMap((segment) => segment.parts.glass)
        .filter((pane) => pane.y0 >= 34 && pane.y0 < 40),
    );
    expect(firstStoreyPanes.length).toBeGreaterThan(0);
    expect(new Set(firstStoreyPanes.map((pane) => Number((pane.y1 - pane.y0).toFixed(3))))).toEqual(
      new Set([Number((WINDOW.y1 - WINDOW.y0 + 0.5).toFixed(3))]),
    );
    expect(firstStoreyPanes.every((pane) => pane.uvY0 !== undefined)).toBe(true);
  });
});
