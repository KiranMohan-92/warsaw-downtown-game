import { describe, expect, it } from 'vitest';
import { buildLightmapLayout, getMap, resolveMap, tryBuildLightmapLayout } from '@wd/shared';
import { acceptsCourtyardBake } from './courtyardBake.ts';
import { acceptsMarketNeonBake } from './marketNeonBake.ts';
import { acceptsMarketNeonStaticBake } from './marketNeonStaticBake.ts';

/**
 * The whole Plac Defilad block and its halves are too large for a lightmap atlas: the bake
 * compatibility checks used to call `buildLightmapLayout` directly, so its throw ("atlas
 * 2048×10040 exceeds 4096 rows") stopped every non-Market load at the loading screen.
 */
describe('bake checks on maps too large for an atlas', () => {
  for (const size of ['full', 'north', 'south'] as const) {
    it(`Plac Defilad ${size}: no layout, every bake declines, nothing throws`, () => {
      const map = resolveMap(getMap('defilad'), size);
      expect(() => buildLightmapLayout(map)).toThrow(/exceeds/);
      expect(tryBuildLightmapLayout(map)).toBeNull();
      expect(acceptsCourtyardBake(map)).toBe(false);
      expect(acceptsMarketNeonBake(map)).toBe(false);
      expect(acceptsMarketNeonStaticBake(map)).toBe(false);
    });
  }

  it('the Market still gets its layout (the baked map is unaffected)', () => {
    const market = resolveMap(getMap('defilad'), 'market');
    expect(tryBuildLightmapLayout(market)?.hash).toBe(buildLightmapLayout(market).hash);
  });
});
