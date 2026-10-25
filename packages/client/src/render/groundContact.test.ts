import { describe, expect, it } from 'vitest';
import {
  contactBand,
  cornerDistance,
  decodedContactDistance,
  footprintDistance,
  CONTACT_RANGE,
} from './groundContact.ts';

const square = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

describe('ground contact distance', () => {
  it('keeps empty contact texels clean without decoding a normal', () => {
    for (const offset of [-0.25, 0, 0.25]) {
      expect(decodedContactDistance(255, 0, offset, offset)).toBe(CONTACT_RANGE);
      expect(contactBand(decodedContactDistance(255, 0, offset, offset))).toBe(0);
    }
  });

  it('decodes two half-planes as their intersection: edges, the vertex, slabs, the inside', () => {
    // Square corner at the origin, normals +x and +z (c = 0).
    expect(cornerDistance(0.3, -0.5, 0)).toBeCloseTo(0.3); // beside edge 1
    expect(cornerDistance(-0.5, 0.2, 0)).toBeCloseTo(0.2); // beside edge 2
    expect(cornerDistance(0.3, 0.4, 0)).toBeCloseTo(0.5); // round the vertex
    expect(cornerDistance(-0.1, -0.4, 0)).toBeCloseTo(0.1); // inside: the nearer edge
    // A 60° wedge's vertex region: |X − P| from the line distances.
    const c = Math.cos((2 * Math.PI) / 3);
    const n1 = [1, 0];
    const n2 = [Math.cos((2 * Math.PI) / 3), Math.sin((2 * Math.PI) / 3)];
    const p = [0.2, 0.5];
    expect(cornerDistance(p[0]! * n1[0]!, p[0]! * n2[0]! + p[1]! * n2[1]!, c)).toBeCloseTo(
      Math.hypot(p[0]!, p[1]!),
    );
    // Opposite parallel lines (a thin box): the nearer face, never the far one.
    expect(cornerDistance(0.1, -0.4, -1)).toBeCloseTo(0.1);
  });

  it('measures straight edges, round corners and the signed interior of a footprint', () => {
    expect(footprintDistance(square, 1.1, 0).distance).toBeCloseTo(0.1);
    expect(footprintDistance(square, 1.3, 1.4).distance).toBeCloseTo(0.5);
    expect(footprintDistance(square, 0, 0).distance).toBe(-1);
    expect(footprintDistance([...square].reverse(), 1.1, 0).distance).toBeCloseTo(0.1);
    const corner = footprintDistance(square, 1.3, 1.4);
    expect(Math.cos(corner.angle)).toBeCloseTo(0.6);
    expect(Math.sin(corner.angle)).toBeCloseTo(0.8);
  });

  it('keeps a stronger 8 cm dark core, then fades the settled dirt within 85 cm', () => {
    expect(contactBand(-0.1)).toBe(contactBand(0));
    expect(contactBand(0)).toBeCloseTo(1);
    expect(contactBand(0.05)).toBeGreaterThan(0.95);
    expect(contactBand(0.08)).toBeGreaterThan(0.9);
    expect(contactBand(0.1)).toBeGreaterThan(0.7);
    expect(contactBand(0.2)).toBeLessThan(0.5);
    expect(contactBand(0.5)).toBeLessThan(0.15);
    expect(contactBand(0.85)).toBe(0);
    let previous = 1;
    for (let d = 0; d <= 1; d += 0.01) {
      const band = contactBand(d);
      expect(band).toBeLessThanOrEqual(previous);
      previous = band;
    }
  });
});
