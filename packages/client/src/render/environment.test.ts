import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeatherId } from '../settings/settings.ts';
import {
  EnvironmentLibrary,
  pmremCubeSize,
  proceduralSkyMean,
  usableEntries,
  type EnvManifest,
} from './environment.ts';
import { ENV_CUBE_SIZE } from './sky.ts';
import { WEATHER_PRESETS, type WeatherPreset } from './weather.ts';

const ENV_DIR = fileURLToPath(new URL('../../public/env/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${ENV_DIR}manifest.json`, 'utf8')) as EnvManifest;
const PRESETS = Object.keys(WEATHER_PRESETS) as WeatherId[];

describe('HDRI environment maps', () => {
  it('matches the procedural bake cube size (no shader recompiles on a weather change)', () => {
    expect(pmremCubeSize(512)).toBe(ENV_CUBE_SIZE);
    for (const e of Object.values(manifest)) expect(pmremCubeSize(e.width)).toBe(ENV_CUBE_SIZE);
  });

  it('ships usable RGBE files for known presets, at most one map per preset', () => {
    const entries = usableEntries(manifest, PRESETS);
    expect(entries.length).toBe(Object.keys(manifest).length);
    const lit = entries.flatMap(([, e]) => e.presets);
    expect(new Set(lit).size).toBe(lit.length);
    // Dusk and neon have no HDRI asset: they keep the procedural bake.
    expect([...lit].sort()).toEqual(['overcast', 'rain', 'sunny']);
    for (const [, e] of entries) {
      const head = readFileSync(`${ENV_DIR}${e.file}`).subarray(0, 200).toString('latin1');
      expect(head.startsWith('#?RADIANCE\n')).toBe(true);
      expect(head).toContain('FORMAT=32-bit_rle_rgbe');
      expect(head).toContain(`-Y ${e.height} +X ${e.width}`);
    }
  });

  it('skips (with a warning) maps of the wrong size and presets that do not exist', () => {
    const warn = vi.fn();
    const out = usableEntries(
      {
        big: { file: 'big.hdr', width: 1024, height: 512, presets: ['sunny'] },
        ghost: { file: 'g.hdr', width: 512, height: 256, presets: ['night' as WeatherId] },
        ok: { file: 'ok.hdr', width: 512, height: 256, presets: ['rain', 'night' as WeatherId] },
      },
      PRESETS,
      warn,
    );
    expect(out.map(([id, e]) => [id, e.presets])).toEqual([['ok', ['rain']]]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('agrees with build_env.py on where the sun is (preset azimuth)', () => {
    for (const e of Object.values(manifest) as (EnvManifest[string] & { sunAzimuth: number })[]) {
      const preset = WEATHER_PRESETS[e.presets[0]!];
      const delta = Math.abs(((e.sunAzimuth - preset.sunAzimuth + 540) % 360) - 180);
      expect(delta).toBeLessThanOrEqual(1);
    }
  });
});

describe('procedural sky brightness (what an HDRI is scaled to)', () => {
  const flat = (hex: string): WeatherPreset => ({
    ...WEATHER_PRESETS.sunny,
    zenith: hex,
    horizon: hex,
    cloudCover: 0,
    sunStrength: 0,
  });

  it('equals the radiance of a uniform sky', () => {
    const c = new THREE.Color('#808080');
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(proceduralSkyMean(flat('#808080'))).toBeCloseTo(lum, 4);
  });

  it('grows with the sun glow and follows the cloud deck', () => {
    const base = flat('#6080a0');
    expect(proceduralSkyMean({ ...base, sunStrength: 1 })).toBeGreaterThan(proceduralSkyMean(base));
    const dark = { ...base, cloudLight: '#202020', cloudDark: '#202020' };
    expect(proceduralSkyMean({ ...dark, cloudCover: 1 })).toBeLessThan(proceduralSkyMean(dark));
    // A solid deck is all cloud: it matches a uniform sky of the cloud colour.
    const deck = { ...dark, cloudCover: 1, zenith: '#202020', horizon: '#202020' };
    expect(proceduralSkyMean(deck)).toBeCloseTo(proceduralSkyMean(flat('#202020')), 3);
  });

  it('ranks the presets like the art direction (storm darkest)', () => {
    const m = Object.fromEntries(PRESETS.map((p) => [p, proceduralSkyMean(WEATHER_PRESETS[p])]));
    for (const p of PRESETS) expect(m[p]).toBeGreaterThan(0.01);
    expect(m.rain).toBeLessThan(m.overcast!);
    expect(m.rain).toBeLessThan(m.sunny!);
  });
});

describe('loading (one deadline for the whole library)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('gives up on a stalled server after timeoutMs in total, not per request', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    vi.stubGlobal('console', { ...console, warn });
    // The manifest arrives after 15 s, then every HDRI stalls forever.
    vi.stubGlobal('fetch', () => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(manifest) }), 15_000);
      });
    });
    vi.spyOn(HDRLoader.prototype, 'loadAsync').mockImplementation(() => new Promise(() => {}));
    let done: EnvironmentLibrary | null = null;
    void EnvironmentLibrary.load({} as THREE.WebGLRenderer, PRESETS, '/', 20_000).then(
      (lib) => (done = lib),
    );
    await vi.advanceTimersByTimeAsync(19_900);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(done).not.toBeNull();
    expect(done!.size).toBe(0); // every preset keeps the procedural bake
    expect(warn).toHaveBeenCalledTimes(Object.keys(manifest).length);
  });
});
