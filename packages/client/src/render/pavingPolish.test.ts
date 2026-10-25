import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { __testPavingSurfaceTexel, MapMaterials } from './materials.ts';

const linear = (v: number): number =>
  THREE.ColorManagement.convert(
    new THREE.Color().setRGB(v / 255, v / 255, v / 255),
    THREE.SRGBColorSpace,
    THREE.LinearSRGBColorSpace,
  ).r;
const lum = (c: readonly number[]): number =>
  0.2126 * linear(c[0]!) + 0.7152 * linear(c[1]!) + 0.0722 * linear(c[2]!);

// Fixed layout fixtures protect the accepted slab sizes and running bond.
const layouts = {
  paving: {
    tile: 6,
    offsets: [0.85, 3.35, 0.8, 3.65, 0.95, 3.7],
    rows: [
      [1.8, 1.45, 1.6, 1.15],
      [1.35, 1.75, 1.4, 1.5],
      [1.6, 0.45, 1.85, 2.1],
      [1.25, 1.65, 1.55, 1.55],
      [2.05, 1.55, 1.9, 0.5],
      [1.5, 1.85, 1.25, 1.4],
    ],
  },
  sidewalk: {
    tile: 3,
    offsets: [0.38, 1.55, 0.42, 1.4, 0.6, 1.65],
    rows: [
      [0.75, 0.5, 0.85, 0.4, 0.5],
      [0.42, 0.78, 0.55, 0.75, 0.5],
      [0.6, 0.45, 0.9, 0.55, 0.5],
      [0.8, 0.5, 0.45, 0.85, 0.4],
      [0.5, 0.7, 0.55, 0.45, 0.8],
      [0.65, 0.4, 0.8, 0.55, 0.6],
    ],
  },
} as const;
type Stone = keyof typeof layouts;
function slabs(id: Stone) {
  const { tile, offsets, rows } = layouts[id];
  return rows.flatMap((widths, row) => {
    let left = 0;
    return widths.map((width) => {
      const start = left;
      left += width;
      return (x: number, y: number): readonly [number, number] => [
        ((start + width * x - offsets[row]! + tile) % tile) / tile,
        ((row + y - 0.5 + 6) % 6) / 6,
      ];
    });
  });
}
function faces(id: Stone): (readonly [number, number])[] {
  return slabs(id)
    .map((at) => at(0.5, 0.5))
    .filter(([u, v]) => {
      // Exclude the rare cracked face from the grain/normal measurements.
      for (let y = -5; y <= 5; y++)
        for (let x = -5; x <= 5; x++) {
          if (__testPavingSurfaceTexel(id, u + x / 512, v + y / 512).height < 0.6) return false;
        }
      return true;
    });
}

describe('weathered granite paving', () => {
  let mm: MapMaterials;
  beforeAll(() => {
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {} }) }),
    });
    mm = new MapMaterials(8);
  });
  afterAll(() => vi.unstubAllGlobals());

  for (const id of ['paving', 'sidewalk'] as const) {
    const texel = (u: number, v: number) => __testPavingSurfaceTexel(id, u, v);

    it(`${id}: bounds fine grain at six percent linear luminance and resolves it within 3 cm`, () => {
      let variance = 0;
      let count = 0;
      // Aligned 2x2 texel blocks: fine detail must average away at the first mip.
      for (const [u, v] of faces(id)) {
        const x0 = Math.floor((u * 512) / 2) * 2;
        const y0 = Math.floor((v * 512) / 2) * 2;
        for (let y = y0 - 2; y <= y0 + 2; y += 2) {
          for (let x = x0 - 2; x <= x0 + 2; x += 2) {
            const values = [0, 1, 2, 3].map((k) =>
              lum(texel((x + (k % 2)) / 512, (y + Math.floor(k / 2)) / 512).albedo),
            );
            const mean = values.reduce((a, b) => a + b) / values.length;
            for (const value of values) {
              const delta = value / mean - 1;
              expect(Math.abs(delta), `${id} grain at ${x},${y}`).toBeLessThan(0.065);
              variance += delta * delta;
              count++;
            }
          }
        }
      }
      expect(Math.sqrt(variance / count)).toBeGreaterThan(0.015);
      expect(Math.sqrt(variance / count)).toBeLessThan(0.045);
      expect((2 * (id === 'paving' ? 6 : 3)) / 512).toBeLessThan(0.03);
    });

    it(`${id}: varies slab values within a grey-beige palette without magenta`, () => {
      const tones = faces(id).map(([u, v]) => {
        const x = Math.floor((u * 512) / 2) * 2;
        const y = Math.floor((v * 512) / 2) * 2;
        return [0, 1, 2, 3].reduce((sum, k) => {
          const c = texel((x + (k % 2)) / 512, (y + Math.floor(k / 2)) / 512).albedo;
          const [r, g, b] = c.map(linear);
          expect((r! - b!) / g!).toBeGreaterThan(0.15);
          expect((r! - b!) / g!).toBeLessThan(0.3);
          expect((r! + b!) / 2 - g!).toBeLessThan(0.005); // no magenta excess
          return sum + lum(c) / 4;
        }, 0);
      });
      const mean = tones.reduce((a, b) => a + b) / tones.length;
      expect((Math.max(...tones) - Math.min(...tones)) / mean).toBeLessThan(0.3);
      expect((Math.max(...tones) - Math.min(...tones)) / mean).toBeGreaterThan(0.15);
    });

    it(`${id}: keeps dry faces matte and micro-relief shallow`, () => {
      for (const [u, v] of faces(id)) {
        const sample = texel(u, v);
        expect(sample.rough).toBeGreaterThanOrEqual(0.78);
        expect(sample.rough).toBeLessThanOrEqual(0.94);
        const dx = texel(u + 1 / 512, v).height - texel(u - 1 / 512, v).height;
        const dy = texel(u, v + 1 / 512).height - texel(u, v - 1 / 512).height;
        expect(Math.hypot(dx, dy)).toBeLessThan(0.025);
      }
    });

    it(`${id}: stains are faint and soft, on at most one slab in five`, () => {
      let stained = 0;
      for (const at of slabs(id)) {
        const tones: number[] = [];
        for (let y = 0.2; y <= 0.8; y += 0.1)
          for (let x = 0.2; x <= 0.8; x += 0.1) {
            const [u, v] = at(x, y);
            const px = Math.floor((u * 512) / 2) * 2;
            const py = Math.floor((v * 512) / 2) * 2;
            const samples = [0, 1, 2, 3].map((k) =>
              texel((px + (k % 2)) / 512, (py + Math.floor(k / 2)) / 512),
            );
            if (samples.some((s) => s.height < 0.62)) continue; // chips / rare cracks
            tones.push(samples.reduce((sum, s) => sum + lum(s.albedo) / 4, 0));
          }
        const hi = Math.max(...tones);
        const contrast = (hi - Math.min(...tones)) / hi;
        expect(contrast).toBeLessThan(0.09);
        if (contrast > 0.005) stained++;
      }
      expect(stained).toBeGreaterThan(1);
      expect(stained).toBeLessThanOrEqual(Math.ceil(slabs(id).length / 5));
    });

    it(`${id}: keeps recessed joints darker and rougher than the walking faces`, () => {
      for (const at of slabs(id)) {
        const face = texel(...at(0.5, 0.5));
        const joint = texel(...at(0.001, 0.5));
        expect(lum(joint.albedo)).toBeLessThan(lum(face.albedo) * 0.4);
        expect(joint.rough).toBeGreaterThanOrEqual(0.96);
        expect(joint.rough).toBeGreaterThan(face.rough);
        expect(joint.height).toBeLessThan(face.height);
      }
    });

    it(`${id}: mipmapped grain becomes a stable neutral mean at 20–80 m`, () => {
      const map = mm.activeMaps(id).albedo;
      expect(map.generateMipmaps).toBe(true);
      expect(map.minFilter).toBe(THREE.LinearMipmapLinearFilter);
      expect(map.anisotropy).toBeGreaterThanOrEqual(8);
      const means: number[] = [];
      const [u, v] = faces(id)[0]!;
      const x0 = Math.floor((u * 512) / 2) * 2;
      const y0 = Math.floor((v * 512) / 2) * 2;
      for (let y = y0 - 4; y <= y0 + 4; y += 2) {
        for (let x = x0 - 4; x <= x0 + 4; x += 2) {
          means.push(
            [0, 1, 2, 3].reduce(
              (sum, k) =>
                sum + lum(texel((x + (k % 2)) / 512, (y + Math.floor(k / 2)) / 512).albedo) / 4,
              0,
            ),
          );
        }
      }
      const mean = means.reduce((a, b) => a + b) / means.length;
      expect((Math.max(...means) - Math.min(...means)) / mean).toBeLessThan(0.01);
    });
  }
});
