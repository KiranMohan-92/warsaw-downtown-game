import { describe, expect, it } from 'vitest';
import { coverageMips, coverageWeightsForSize, normalMips } from './treeTextureMips.ts';

describe('tree texture filtering', () => {
  it('uses full-resolution colour coverage for a smaller normal atlas', () => {
    const color = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) color[(y * 4 + x) * 4 + 3] = x < 2 && y < 2 ? 255 : 0;
    const weights = coverageWeightsForSize(color, 4, 4, 2, 2);
    expect([...weights.filter((_, i) => i % 4 === 3)]).toEqual([255, 0, 0, 0]);

    const normals = new Uint8Array([
      255, 128, 128, 255, 128, 255, 128, 255, 128, 128, 255, 255, 255, 0, 0, 255,
    ]);
    const levels = normalMips(normals, weights, 2, 2, true);
    expect(levels[0]!.data).toEqual(normals);
    expect(levels.map((l) => [l.width, l.height])).toEqual([
      [2, 2],
      [1, 1],
    ]);
    expect([...levels[1]!.data.slice(0, 3)]).toEqual([255, 128, 128]);
  });

  it('reduces packed AO with colour coverage while retaining the original vector weights', () => {
    const color = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0]);
    const normals = new Uint8Array([
      255, 128, 128, 166, 128, 255, 128, 255, 0, 0, 255, 0, 0, 0, 255, 0,
    ]);
    const legacy = normalMips(normals, color, 2, 2);
    const packed = normalMips(normals, color, 2, 2, true);
    expect(packed[0]!.data).toEqual(normals);
    expect(packed[1]!.data.slice(0, 3)).toEqual(legacy[1]!.data.slice(0, 3));
    expect(packed[1]!.data[3]).toBe(Math.round((166 * 255 + 255 * 128) / 383));
    expect(legacy[1]!.data[3]).toBe(96);
    expect([...normalMips(normals, new Uint8Array(16), 2, 2, true)[1]!.data]).toEqual([
      128, 255, 128, 255,
    ]);
    expect(packed.map((l) => l.data.length)).toEqual(legacy.map((l) => l.data.length));
  });
  it('keeps sparse views when a denser neighbouring frame already meets global coverage', () => {
    const width = 64;
    const height = 32;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sparse = x < 32;
        const on = sparse ? x % 4 < 2 && x % 2 === 0 && y % 2 === 0 : x % 2 !== 0 || y % 2 !== 0;
        data.set([40, 120, 30, on ? 255 : 0], (y * width + x) * 4);
      }
    const global = coverageMips(data, width, height);
    const framed = coverageMips(data, width, height, 2);
    expect(framed[0]!.data).toEqual(data);
    const first = (level: (typeof framed)[number]) => {
      let covered = 0;
      for (let y = 0; y < level.height; y++)
        for (let x = 0; x < level.width / 2; x++)
          if (level.data[(y * level.width + x) * 4 + 3]! >= 128) covered++;
      return covered;
    };
    expect(first(global[1]!)).toBe(0);
    expect(first(framed[1]!)).toBeGreaterThan(0);
    expect(framed.map((l) => [l.width, l.height])).toEqual(global.map((l) => [l.width, l.height]));
    expect(framed.reduce((s, l) => s + l.data.length, 0)).toBe(
      global.reduce((s, l) => s + l.data.length, 0),
    );
    expect(framed.at(-1)!.width).toBe(1);
    expect(framed.at(-1)!.height).toBe(1);
  });

  it('does not fill an empty frame or alter level-zero pixels', () => {
    const data = new Uint8Array(8 * 4 * 4);
    for (let y = 0; y < 4; y++)
      for (let x = 4; x < 8; x++) data.set([90, 140, 60, 255], (y * 8 + x) * 4);
    const levels = coverageMips(data, 8, 4, 2);
    expect(levels[0]!.data).toEqual(data);
    for (const level of levels.filter((l) => l.width >= 2))
      for (let y = 0; y < level.height; y++)
        for (let x = 0; x < level.width / 2; x++)
          expect(level.data[(y * level.width + x) * 4 + 3]).toBe(0);
    expect(() => coverageMips(data, 8, 4, 3)).toThrow(/frames/);
  });

  it('excludes transparent background normals and preserves the original normal pixels', () => {
    const color = new Uint8Array(16);
    color[3] = 255;
    const normals = new Uint8Array([
      255, 128, 128, 255, 0, 128, 128, 0, 0, 128, 128, 0, 0, 128, 128, 0,
    ]);
    const levels = normalMips(normals, color, 2, 2);
    expect(levels[0]!.data).toEqual(normals);
    expect([...levels[1]!.data]).toEqual([255, 128, 128, 64]);
  });

  it('uses coverage weights and produces a unit normal, including empty/cancelling regions', () => {
    const normals = new Uint8Array([
      255, 128, 128, 255, 128, 255, 128, 255, 128, 128, 255, 255, 255, 0, 0, 0,
    ]);
    const color = new Uint8Array(16);
    color[3] = 255;
    color[7] = 128;
    const level = normalMips(normals, color, 2, 2)[1]!.data;
    const n = [...level.slice(0, 3)].map((v) => (v / 255) * 2 - 1);
    expect(Math.hypot(...n)).toBeCloseTo(1, 2);
    expect(n[0]).toBeGreaterThan(n[1]!);
    expect(n[2]).toBeLessThan(0.02);
    expect([...normalMips(normals, new Uint8Array(16), 2, 2)[1]!.data]).toEqual([128, 255, 128, 0]);
  });
});
