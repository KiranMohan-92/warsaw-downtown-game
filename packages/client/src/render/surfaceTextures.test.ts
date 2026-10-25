import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MaterialId } from '@wd/shared';
import { scannedColor, surfacePalette, tileMetres } from './materials.ts';
import {
  SURFACE_TILE_METRES,
  TEXTURED_SURFACES,
  albedoStats,
  isTextured,
  loadSurfaceSets,
  paletteGain,
  surfaceUrls,
  textureSize,
  withTimeout,
} from './surfaceTextures.ts';
import { LOW_TEXTURE_SIZE, TEXTURE_SIZE } from './surfaceTextureStats.gen.ts';
import { webpInfo } from './webpInfo.testUtil.ts';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

describe('scanned surface sets', () => {
  it('covers the eight actively scanned surfaces, each with its three committed maps (both tiers)', () => {
    expect([...TEXTURED_SURFACES].sort()).toEqual(
      ['asphalt', 'concrete', 'plaster', 'wood', 'metal', 'container', 'grass', 'glass'].sort(),
    );
    for (const id of TEXTURED_SURFACES) {
      for (const lowRes of [false, true]) {
        const u = surfaceUrls(id, '/', lowRes);
        const size = textureSize(id, lowRes);
        for (const url of [u.albedo, u.normal, u.rough]) {
          const file = `${PUBLIC}${url.slice(1)}`;
          expect(existsSync(file), file).toBe(true);
          const buf = readFileSync(file);
          // Real WebPs (not an LFS pointer or an HTML error page) of the advertised size.
          const info = webpInfo(buf);
          expect([info.width, info.height], file).toEqual([size, size]);
        }
      }
    }
  });

  it('never loads more than 512 px on Low (no more than the procedural maps it replaced)', () => {
    expect(LOW_TEXTURE_SIZE).toBe(512);
    for (const id of TEXTURED_SURFACES) {
      expect(textureSize(id, true)).toBeLessThanOrEqual(512);
      expect(textureSize(id, false)).toBe(TEXTURE_SIZE[id]);
    }
    expect(surfaceUrls('asphalt', '/', true).albedo).toBe('/tex/asphalt_albedo_512.webp');
    expect(surfaceUrls('asphalt', '/', false).rough).toBe('/tex/asphalt_rough.webp');
    // A set that is 512 already has no separate Low copy.
    expect(surfaceUrls('metal', '/', true).normal).toBe('/tex/metal_normal.webp');
  });

  it('builds URLs under the deploy base', () => {
    expect(surfaceUrls('asphalt', '/').albedo).toBe('/tex/asphalt_albedo.webp');
    expect(surfaceUrls('grass', '/wd/').normal).toBe('/wd/tex/grass_normal.webp');
    expect(surfaceUrls('wood', './').rough).toBe('./tex/wood_rough.webp');
    expect(surfaceUrls('metal', '/game').albedo).toBe('/game/tex/metal_albedo.webp');
  });
});

describe('tile sizes (world metres per texture tile)', () => {
  it('keeps every scanned tile in a plausible range', () => {
    for (const id of TEXTURED_SURFACES) {
      expect(SURFACE_TILE_METRES[id]).toBeGreaterThanOrEqual(1);
      // Surfaces tile at material scale (≤ 6 m); curtain-wall glass tiles by storeys (8 × 3.3 m).
      expect(SURFACE_TILE_METRES[id]).toBeLessThanOrEqual(id === 'glass' ? 26.4 : 6);
    }
  });

  it('puts features at real-world sizes', () => {
    // The offline paving scan metadata stays available, but Market paving is intentionally procedural.
    expect(SURFACE_TILE_METRES.paving / 5).toBeCloseTo(1);
    // wood_planks has 9 planks per tile: 15–30 cm boards.
    expect(SURFACE_TILE_METRES.wood / 9).toBeGreaterThan(0.15);
    expect(SURFACE_TILE_METRES.wood / 9).toBeLessThan(0.3);
    // worn_corrugated_iron has 16 ribs per tile: container corrugation is ~15–30 cm.
    expect(SURFACE_TILE_METRES.container / 16).toBeGreaterThan(0.15);
    expect(SURFACE_TILE_METRES.container / 16).toBeLessThan(0.3);
  });

  it('uses the scan tile only when the scan is loaded (fallback keeps the procedural tile)', () => {
    // Paving and sidewalk keep the new procedural stone maps even when scanned loading is active.
    expect(isTextured('paving')).toBe(false);
    expect(isTextured('sidewalk')).toBe(false);
    expect(tileMetres('paving', true)).toBe(6);
    expect(tileMetres('paving', false)).toBe(6);
    expect(tileMetres('sidewalk', true)).toBe(3);
    expect(tileMetres('sidewalk', false)).toBe(3);
    // Surfaces without an active scan are procedural either way (facades tile per 3.3 m storey).
    expect(isTextured('facade')).toBe(false);
    expect(tileMetres('facade', true)).toBe(3.3);
    expect(tileMetres('trim', true)).toBe(2);
  });
});

describe('palette match', () => {
  const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

  it("moves the scan's mean luminance onto the palette colour's, with one gain", () => {
    const stats = { mean: [0.1, 0.2, 0.05], p95: [0.15, 0.25, 0.08] };
    const g = paletteGain([0.3, 0.3, 0.3], stats);
    expect(lum(stats.mean.map((v) => v * g))).toBeCloseTo(0.3, 6);
  });

  it('scales down when the bright end would pass the ceiling', () => {
    const stats = { mean: [0.2, 0.2, 0.2], p95: [0.4, 0.3, 0.3] };
    const g = paletteGain([0.8, 0.8, 0.8], stats);
    expect(0.4 * g).toBeCloseTo(0.9);
  });

  // The review that motivated the single gain: per-channel gains reached R 5.2 / G 8.4 / B 25 on
  // metal_plate and blew up the blue channel's JPEG noise. The hue is now baked offline.
  it('gives every committed scan a grey gain between 1/3 and 3 (no noise blow-up)', () => {
    for (const id of TEXTURED_SURFACES) {
      const c = scannedColor(id);
      expect(c.r).toBe(c.g);
      expect(c.g).toBe(c.b);
      expect(c.r).toBeGreaterThan(1 / 3);
      expect(c.r).toBeLessThanOrEqual(3);
      for (const v of albedoStats(id).p95) expect(v * c.r).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });

  it('draws every scan at its palette hue and brightness (rebuild textures after a hue change)', () => {
    for (const id of TEXTURED_SURFACES) {
      const s = albedoStats(id);
      const g = scannedColor(id).r;
      const p = new THREE.Color(surfacePalette(id));
      const palette = [p.r, p.g, p.b];
      const drawn = s.mean.map((v) => v * g);
      // Brightness: on the palette, unless the ceiling scaled it down (container's white).
      const ratio = lum(drawn) / lum(palette);
      expect(ratio, id).toBeLessThanOrEqual(1 + 1e-6);
      if (Math.max(...s.p95) * g < 0.9 - 1e-6) expect(ratio, id).toBeCloseTo(1, 6);
      // Hue: each channel relative to luminance within 0.03 of the palette's (JPEG drift).
      for (let c = 0; c < 3; c++) {
        const delta = drawn[c]! / lum(drawn) - palette[c]! / lum(palette);
        expect(Math.abs(delta), `${id} channel ${c}`).toBeLessThan(0.03);
      }
    }
  });
});

describe('loading with procedural fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads whole sets and drops a set when any of its maps fails (with a warning)', async () => {
    const warn = vi.fn();
    const load = (url: string): Promise<string> =>
      url.includes('metal_normal') ? Promise.reject(new Error('404')) : Promise.resolve(url);
    const sets = await loadSurfaceSets(['asphalt', 'metal', 'grass'], load, '/', warn);
    expect([...sets.keys()].sort()).toEqual(['asphalt', 'grass']);
    expect(sets.get('asphalt')).toEqual({
      albedo: '/tex/asphalt_albedo.webp',
      normal: '/tex/asphalt_normal.webp',
      rough: '/tex/asphalt_rough.webp',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("'metal'");
  });

  it('never rejects, even when everything fails', async () => {
    const warn = vi.fn();
    const sets = await loadSurfaceSets(
      TEXTURED_SURFACES,
      () => Promise.reject(new Error('offline')),
      '/',
      warn,
    );
    expect(sets.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(TEXTURED_SURFACES.length);
  });

  it('times out a stalled request', async () => {
    vi.useFakeTimers();
    const stalled = withTimeout(new Promise<never>(() => {}), 1000, 'x.jpg');
    const check = expect(stalled).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1001);
    await check;
    await expect(withTimeout(Promise.resolve(7), 1000, 'y')).resolves.toBe(7);
  });

  it('marks exactly the scanned surfaces as textured', () => {
    const all: MaterialId[] = ['asphalt', 'facade', 'glass', 'grass', 'foliage', 'bark'];
    expect(all.filter(isTextured)).toEqual(['asphalt', 'glass', 'grass']);
  });
});
