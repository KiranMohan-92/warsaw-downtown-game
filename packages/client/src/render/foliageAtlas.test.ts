import { describe, expect, it } from 'vitest';
import {
  ALPHA_TILES,
  ATLAS_RECTS,
  ATLAS_SIZE,
  buildFoliageAtlas,
  tileCoverage,
  tileUv,
  writeOpaqueTile,
  type AtlasTile,
} from './foliageAtlas.ts';

const atlas = buildFoliageAtlas();

/** Mip levels at which a tile is still at least `min` texels on its short side. */
const levelsOf = (tile: AtlasTile, min: number): number[] => {
  const r = ATLAS_RECTS[tile];
  const out: number[] = [];
  for (let k = 0; Math.min(r.w, r.h) >> k >= min; k++) out.push(k);
  return out;
};

describe('foliage atlas', () => {
  it('is deterministic for a seed and changes with it', () => {
    const again = buildFoliageAtlas();
    expect(again.levels.length).toBe(atlas.levels.length);
    const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
    atlas.levels.forEach((l, k) =>
      expect(same(again.levels[k]!.data, l.data), `level ${k}`).toBe(true),
    );
    const other = buildFoliageAtlas(2);
    expect(same(other.levels[0]!.data, atlas.levels[0]!.data)).toBe(false);
  });

  it('carries a full mip chain down to 1 × 1', () => {
    expect(atlas.levels.map((l) => l.width)).toEqual(
      Array.from({ length: Math.log2(ATLAS_SIZE) + 1 }, (_, k) => ATLAS_SIZE >> k),
    );
    for (const l of atlas.levels) expect(l.data.length).toBe(l.width * l.height * 4);
  });

  it('tiles are aligned so each one mips on its own, inside the atlas', () => {
    for (const r of Object.values(ATLAS_RECTS)) {
      expect(r.x % r.w).toBe(0);
      expect(r.y % r.h).toBe(0);
      expect(r.x + r.w).toBeLessThanOrEqual(ATLAS_SIZE);
      expect(r.y + r.h).toBeLessThanOrEqual(ATLAS_SIZE);
    }
    const uv = tileUv('leaf', 0.25);
    expect(uv.u0).toBeCloseTo(64 / ATLAS_SIZE);
    expect(uv.u1).toBeCloseTo(192 / ATLAS_SIZE);
  });

  it('opaque tiles stay opaque at every level', () => {
    for (const tile of ['canopy', 'bark'] as const) {
      for (const k of levelsOf(tile, 1))
        expect(tileCoverage(atlas, tile, k), `${tile}@${k}`).toBe(1);
    }
  });

  it('card tiles have real gaps and real leaves', () => {
    for (const tile of ALPHA_TILES) {
      const c = tileCoverage(atlas, tile, 0);
      expect(c, tile).toBeGreaterThan(0.2);
      expect(c, tile).toBeLessThan(0.9);
    }
  });

  it('preserves alpha-test coverage down the mip chain (leaves never thin out at distance)', () => {
    for (const tile of ALPHA_TILES) {
      const c0 = tileCoverage(atlas, tile, 0);
      for (const k of levelsOf(tile, 4)) {
        const ck = tileCoverage(atlas, tile, k);
        // Never thinner than at full resolution (a small overshoot is the safe side).
        expect(ck, `${tile}@${k}`).toBeGreaterThanOrEqual(c0 - 0.02);
        expect(ck, `${tile}@${k}`).toBeLessThanOrEqual(c0 + 0.15);
      }
    }
  });

  it('writes a scanned opaque tile and its mips in place, leaving other tiles alone', () => {
    const a = buildFoliageAtlas();
    const leafBefore = Buffer.from(a.levels[0]!.data).toString('base64');
    const r = ATLAS_RECTS.canopy;
    const img = new Uint8Array(r.w * r.h * 4);
    for (let i = 0; i < r.w * r.h; i++) img.set([40, 120, 30, 255], i * 4);
    writeOpaqueTile(a.levels, 'canopy', img, r.w, r.h);
    // Tiles mip on their own down to the smallest tile's last level (bark, 64 px wide).
    for (const k of levelsOf('bark', 1)) {
      const L = a.levels[k]!;
      const o = (((r.y >> k) + 1) * L.width + (r.x >> k)) * 4;
      expect([...L.data.subarray(o, o + 4)], `level ${k}`).toEqual([40, 120, 30, 255]);
      expect(tileCoverage(a, 'canopy', k)).toBe(1);
    }
    // The leaf tile (outside the canopy rect) is unchanged at level 0.
    const leaf = ATLAS_RECTS.leaf;
    const at = (d: Uint8Array) => [
      ...d.subarray(
        (leaf.y + 100) * ATLAS_SIZE * 4,
        (leaf.y + 101) * ATLAS_SIZE * 4 - (ATLAS_SIZE - leaf.w) * 4,
      ),
    ];
    expect(at(a.levels[0]!.data)).toEqual(at(Buffer.from(leafBefore, 'base64')));
    expect(() => writeOpaqueTile(a.levels, 'canopy', img, 8, 8)).toThrow();
    expect(() => writeOpaqueTile(a.levels, 'leaf', img, r.w, r.h)).toThrow();
  });
});
