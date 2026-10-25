import { describe, expect, it } from 'vitest';
import { getMap, PALACE_TINT, resolveMap } from '@wd/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { facadeFaces, faceRelief, type FaceSegment, type LocalQuad } from './facadeRelief.ts';

interface Edge {
  near: LocalQuad[];
  coarse: LocalQuad[];
  axis: 's' | 'y';
  sign: -1 | 1;
  fixed: number;
  lo: number;
  hi: number;
}

function profile(quads: LocalQuad[], edge: Edge): { lo: number; hi: number; depth: number }[] {
  return quads
    .filter((q) => q.axis === 'o')
    .flatMap((q) => {
      const [a, b, lo, hi] =
        edge.axis === 's' ? [q.x0, q.x1, q.y0, q.y1] : [q.y0, q.y1, q.x0, q.x1];
      if (edge.fixed < a - 1e-6 || edge.fixed > b + 1e-6) return [];
      return [{ lo: Math.max(lo, edge.lo), hi: Math.min(hi, edge.hi), depth: q.o0 }];
    });
}

function edges(segment: FaceSegment): Edge[] {
  const b = segment.box;
  const near = [...segment.parts.frame, ...segment.parts.detail, ...segment.parts.glass];
  const coarse = [...segment.parts.frame, ...segment.parts.panel];
  return [
    { axis: 's', sign: -1, fixed: b.x0, lo: b.y0, hi: b.y1, near, coarse },
    { axis: 's', sign: 1, fixed: b.x1, lo: b.y0, hi: b.y1, near, coarse },
    { axis: 'y', sign: -1, fixed: b.y0, lo: b.x0, hi: b.x1, near, coarse },
    { axis: 'y', sign: 1, fixed: b.y1, lo: b.x0, hi: b.x1, near, coarse },
  ];
}

describe('Market facade LOD continuity', () => {
  it('closes shared edges for every near/coarse pairing, including authored crown steps', () => {
    const faces = facadeFaces(resolveMap(getMap('defilad'), 'market'), PALACE_TINT);
    const failures: string[] = [];
    let intervals = 0;
    let closedStructuralSteps = 0;
    let nearQuads = 0;
    let coarseQuads = 0;
    let glassPanes = 0;
    for (const face of faces) {
      const pending = new Map<string, Edge>();
      for (const segment of faceRelief(face)) {
        const p = segment.parts;
        nearQuads += p.frame.length + p.detail.length + p.glass.length;
        coarseQuads += p.frame.length + p.panel.length;
        glassPanes += p.glass.length;
        for (const edge of edges(segment)) {
          const key = `${edge.axis}:${[edge.fixed, edge.lo, edge.hi].map((n) => n.toFixed(6)).join(':')}`;
          const other = pending.get(key);
          if (!other) {
            pending.set(key, edge);
            continue;
          }
          pending.delete(key);
          const profiles = [
            profile(edge.near, edge),
            profile(edge.coarse, edge),
            profile(other.near, other),
            profile(other.coarse, other),
          ];
          const cuts = [
            ...new Set([
              edge.lo,
              edge.hi,
              ...profiles.flatMap((p) => p.flatMap((span) => [span.lo, span.hi])),
            ]),
          ].sort((a, b) => a - b);
          for (let i = 1; i < cuts.length; i++) {
            if (cuts[i]! - cuts[i - 1]! < 1e-6) continue;
            const at = (cuts[i]! + cuts[i - 1]!) / 2;
            const depths = profiles.map(
              (p) => p.find((span) => span.lo < at && span.hi > at)?.depth,
            );
            intervals++;
            const complete = depths.every((depth) => depth !== undefined);
            const stable =
              complete &&
              Math.abs(depths[0]! - depths[1]!) < 1e-6 &&
              Math.abs(depths[2]! - depths[3]!) < 1e-6;
            const level = complete && Math.abs(depths[0]! - depths[2]!) < 1e-6;
            // An authored crown can step at a cell border. Its always-present frame
            // must bridge the two depths with the normal facing the recessed side.
            const bridge =
              stable &&
              !level &&
              [...edge.coarse, ...other.coarse].some((q) => {
                if (q.axis !== edge.axis) return false;
                const fixed = edge.axis === 's' ? q.x0 : q.y0;
                const lo = edge.axis === 's' ? q.y0 : q.x0;
                const hi = edge.axis === 's' ? q.y1 : q.x1;
                const sign = depths[0]! > depths[2]! ? edge.sign : -edge.sign;
                return (
                  Math.abs(fixed - edge.fixed) < 1e-6 &&
                  lo < at &&
                  hi > at &&
                  q.o0 <= Math.min(depths[0]!, depths[2]!) + 1e-6 &&
                  q.o1 >= Math.max(depths[0]!, depths[2]!) - 1e-6 &&
                  q.sign === sign
                );
              });
            if (bridge) closedStructuralSteps++;
            if (!stable || (!level && !bridge)) {
              failures.push(
                `prism ${face.prism} edge ${face.edge} ${key} at ${at}: ${depths.join(',')}`,
              );
            }
          }
        }
      }
    }
    const receipt = {
      scope: 'Actual Market source quads and all shared segment front profiles',
      faces: faces.length,
      intervals,
      closedStructuralSteps,
      failures: failures.length,
      failureExamples: failures.slice(0, 8),
      nearQuads,
      coarseQuads,
      glassPanes,
    };
    const output = new URL(
      '../../../../tools/assets/build/market-facade-lod-continuity-20261008.json',
      import.meta.url,
    );
    mkdirSync(new URL('.', output), { recursive: true });
    writeFileSync(output, JSON.stringify(receipt, null, 2));
    // Three-window groups remove minor rib edges; still audit every remaining pairing.
    expect(intervals).toBeGreaterThan(6_000);
    expect(closedStructuralSteps).toBe(8);
    expect(failures.slice(0, 8)).toEqual([]);
    // Budget the actual geometry rather than requiring the previous raised seam design.
    expect(nearQuads).toBeLessThan(162_000);
    expect(coarseQuads).toBeLessThan(40_000);
    expect(glassPanes).toBe(6284);
  });
});
