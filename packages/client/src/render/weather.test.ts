import * as THREE from 'three';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { WeatherId } from '../settings/settings.ts';
import { proceduralSkyMean, type EnvironmentLibrary } from './environment.ts';
import { wetness } from './materials.ts';
import { windowLight } from './windowInterior.ts';
import { SKYLINE_LIGHTS, skylineLights } from './skylineWindows.ts';
import type { Rain } from './rain.ts';
import type { SkyDome } from './sky.ts';
import { WEATHER_PRESETS, WeatherSystem, type WeatherTargets } from './weather.ts';

/** Stub targets: a plain scene, a sky whose bake is a spy, no-op lights/rain/audio. */
function targets() {
  const bake = new THREE.Texture();
  bake.name = 'procedural-bake';
  const sky = {
    set: vi.fn(),
    setExposure: vi.fn(),
    setFlash: vi.fn(),
    setPhoto: vi.fn(),
    bakeEnvironment: vi.fn(() => bake),
  };
  const t: WeatherTargets = {
    scene: new THREE.Scene(),
    sky: sky as unknown as SkyDome,
    sun: new THREE.DirectionalLight(),
    hemi: new THREE.HemisphereLight(),
    rain: {
      setIntensity: vi.fn(),
      setLighting: vi.fn(),
      setFlash: vi.fn(),
      setLowQuality: vi.fn(),
    } as unknown as Rain,
    setBloom: vi.fn(),
    onThunder: vi.fn(),
    setRainAudio: vi.fn(),
  };
  return { t, sky, bake };
}

/** An EnvironmentLibrary with an HDRI for sunny, overcast and rain (none for dusk), as shipped. */
function library(): { lib: EnvironmentLibrary; maps: Map<WeatherId, THREE.Texture> } {
  const maps = new Map<WeatherId, THREE.Texture>();
  for (const id of ['sunny', 'overcast', 'rain'] as const) {
    const tex = new THREE.Texture();
    tex.name = `hdri-${id}`;
    maps.set(id, tex);
  }
  const lib = { get: (id: WeatherId) => maps.get(id) ?? null, size: maps.size };
  return { lib: lib as unknown as EnvironmentLibrary, maps };
}

describe('weather image-based lighting', () => {
  it('updates skyline lamps on weather changes while preserving horizon fog on every tier', () => {
    const { t } = targets();
    const weather = new WeatherSystem(t);
    for (const low of [false, true]) {
      weather.setLowQuality(low);
      for (const id of ['sunny', 'golden', 'dusk', 'neon', 'overcast', 'rain'] as const) {
        weather.apply(id);
        expect(skylineLights.occupied.value).toBe(SKYLINE_LIGHTS[id].occupied);
        expect(skylineLights.intensity.value).toBeCloseTo(
          SKYLINE_LIGHTS[id].intensity * WEATHER_PRESETS[id].exposure,
        );
        expect(t.scene.fog!.color.getHex()).toBe(
          new THREE.Color(WEATHER_PRESETS[id].horizon).getHex(),
        );
      }
    }
  });
  it('preserves Palace-range target contrast in neon night without removing near haze', () => {
    const { t } = targets();
    new WeatherSystem(t).apply('neon');
    const fog = t.scene.fog as THREE.FogExp2;
    expect(fog).toBeInstanceOf(THREE.FogExp2);
    expect(Math.exp(-Math.pow(fog.density * 120, 2))).toBeGreaterThan(0.8);
    const nearContrast = Math.exp(-Math.pow(fog.density * 20, 2));
    expect(nearContrast).toBeGreaterThan(0.99);
    expect(nearContrast).toBeLessThan(1);
  });

  it('lights occupied rooms at night and restores their daylight values', () => {
    const { t } = targets();
    const w = new WeatherSystem(t);
    w.apply('sunny');
    const daylight = { interior: windowLight.interior.value, lamps: windowLight.lamps.value };
    w.apply('neon');
    expect(windowLight.interior.value).toBeLessThan(daylight.interior);
    expect(windowLight.lamps.value).toBeGreaterThan(daylight.lamps * 5);
    w.setLowQuality(true);
    expect(windowLight.lamps.value).toBeGreaterThan(1);
    w.apply('sunny');
    expect(windowLight.interior.value).toBe(daylight.interior);
    expect(windowLight.lamps.value).toBe(daylight.lamps);
  });
  it('replaces Low IBL with preset-coloured irradiance and restores Medium lighting', () => {
    const { t } = targets();
    const { lib, maps } = library();
    const w = new WeatherSystem(t);
    w.setEnvironments(lib);
    w.apply('sunny');
    const normalSky = t.hemi.color.clone().multiplyScalar(t.hemi.intensity);
    w.setLowQuality(true);
    expect(t.scene.environment).toBeNull();
    expect(t.scene.fog).toBeInstanceOf(THREE.Fog);
    expect(t.hemi.color.r * t.hemi.intensity).toBeGreaterThan(normalSky.r);
    w.apply('rain');
    expect(t.scene.environment).toBeNull();
    w.update(0.1);
    const rainSky = t.hemi.color.clone().multiplyScalar(t.hemi.intensity);
    w.setLowQuality(false);
    expect(t.scene.environment).toBe(maps.get('rain'));
    expect(t.scene.fog).toBeInstanceOf(THREE.FogExp2);
    const rain = WEATHER_PRESETS.rain;
    expect(t.hemi.intensity).toBeCloseTo(rain.hemiIntensity * rain.exposure);
    expect(rainSky.r).toBeGreaterThan(t.hemi.color.r * t.hemi.intensity);
  });

  it('keeps cheap fog within five percent of the exponential curve at all depths', () => {
    const { t } = targets();
    const w = new WeatherSystem(t);
    w.setLowQuality(true);
    for (const id of Object.keys(WEATHER_PRESETS) as WeatherId[]) {
      w.apply(id);
      const fog = t.scene.fog as THREE.Fog;
      for (let depth = 0; depth <= 1500; depth += 5) {
        const expected = 1 - Math.exp(-Math.pow(WEATHER_PRESETS[id].fogDensity * depth, 2));
        const actual = THREE.MathUtils.smoothstep(depth, fog.near, fog.far);
        expect(Math.abs(expected - actual)).toBeLessThan(0.05);
      }
    }
  });

  it('lights sunny, overcast and rain with their HDRI, scaled to the procedural sky', () => {
    const { t, sky } = targets();
    const { lib, maps } = library();
    const w = new WeatherSystem(t);
    w.setEnvironments(lib);
    for (const id of ['sunny', 'overcast', 'rain'] as const) {
      sky.bakeEnvironment.mockClear();
      w.apply(id);
      const p = WEATHER_PRESETS[id];
      expect(t.scene.environment).toBe(maps.get(id));
      expect(t.scene.environmentIntensity).toBeCloseTo(
        p.envIntensity * p.exposure * proceduralSkyMean(p),
        9,
      );
      // No bake when an HDRI lights the preset (a bake is a render + prefilter).
      expect(sky.bakeEnvironment).not.toHaveBeenCalled();
    }
  });

  it('bakes the procedural sky for dusk (no dusk HDRI), at envIntensity × exposure', () => {
    const { t, sky, bake } = targets();
    const w = new WeatherSystem(t);
    w.setEnvironments(library().lib);
    w.apply('dusk');
    const p = WEATHER_PRESETS.dusk;
    expect(sky.bakeEnvironment).toHaveBeenCalledTimes(1);
    expect(t.scene.environment).toBe(bake);
    expect(t.scene.environmentIntensity).toBeCloseTo(p.envIntensity * p.exposure, 9);
  });

  it('bakes the procedural sky for neon (no new HDRI asset), at envIntensity × exposure', () => {
    const { t, sky, bake } = targets();
    const w = new WeatherSystem(t);
    w.setEnvironments(library().lib);
    w.apply('neon');
    const p = WEATHER_PRESETS.neon;
    expect(sky.bakeEnvironment).toHaveBeenCalledTimes(1);
    expect(t.scene.environment).toBe(bake);
    expect(t.scene.environmentIntensity).toBeCloseTo(p.envIntensity * p.exposure, 9);
  });

  it('keeps the neon preset wet, readable and storm-free', () => {
    const p = WEATHER_PRESETS.neon;
    expect(p.label).toBe('Warsaw 2030 — neon night');
    expect(p.skyPhoto).toBeUndefined();
    expect(p.wetness).toBeGreaterThanOrEqual(0.75);
    expect(p.wetness).toBeLessThanOrEqual(0.9);
    expect(p.rain).toBeGreaterThanOrEqual(0.2);
    expect(p.rain).toBeLessThanOrEqual(0.3);
    expect(p.lightning).toBe(false);
    expect(p.bloom).toBeGreaterThanOrEqual(0.7);
    expect(p.bloom).toBeLessThanOrEqual(0.9);
    expect(p.hemiIntensity * p.exposure).toBeGreaterThan(0.5);
    expect(new THREE.Color(p.horizon).b).toBeGreaterThan(new THREE.Color(p.horizon).r);
  });

  it('re-lights the current preset when the HDRIs arrive after it was applied', () => {
    const { t, sky, bake } = targets();
    const w = new WeatherSystem(t);
    w.apply('sunny'); // before Game.create's load finished: the bake stands in
    expect(t.scene.environment).toBe(bake);
    expect(sky.bakeEnvironment).toHaveBeenCalledTimes(1);
    const { lib, maps } = library();
    w.setEnvironments(lib);
    expect(t.scene.environment).toBe(maps.get('sunny'));
    const p = WEATHER_PRESETS.sunny;
    expect(t.scene.environmentIntensity).toBeCloseTo(
      p.envIntensity * p.exposure * proceduralSkyMean(p),
      9,
    );
  });

  it('keeps the procedural bake everywhere when no HDRI loaded (the Game.create fallback)', () => {
    const { t, sky, bake } = targets();
    const w = new WeatherSystem(t);
    const empty = { get: () => null, size: 0 } as unknown as EnvironmentLibrary;
    w.setEnvironments(empty);
    for (const id of Object.keys(WEATHER_PRESETS) as WeatherId[]) {
      w.apply(id);
      const p = WEATHER_PRESETS[id];
      expect(t.scene.environment).toBe(bake);
      expect(t.scene.environmentIntensity).toBeCloseTo(p.envIntensity * p.exposure, 9);
    }
    expect(sky.bakeEnvironment).toHaveBeenCalledTimes(Object.keys(WEATHER_PRESETS).length);
  });

  it('setEnvironments before any apply does nothing yet', () => {
    const { t, sky } = targets();
    const w = new WeatherSystem(t);
    w.setEnvironments(library().lib);
    expect(t.scene.environment).toBeNull();
    expect(sky.bakeEnvironment).not.toHaveBeenCalled();
  });
});

describe('weather wetness and rain lighting', () => {
  it('starts soaked in a rain match, then dries slowly after a switch to sun', () => {
    const { t } = targets();
    const w = new WeatherSystem(t);
    w.apply('rain');
    expect(wetness.value).toBe(1);
    w.apply('sunny');
    w.update(1);
    expect(wetness.value).toBeGreaterThan(0.9); // the ground doesn't dry in a second
    for (let i = 0; i < 300; i++) w.update(1);
    expect(wetness.value).toBeLessThan(0.01);
    w.apply('rain');
    for (let i = 0; i < 5; i++) w.update(1);
    expect(wetness.value).toBeGreaterThan(0.3);
    expect(wetness.value).toBeLessThan(0.7); // soaking in, not instant
  });

  it('lights the drops from the storm sky and clears the flash on a preset change', () => {
    const { t } = targets();
    const w = new WeatherSystem(t);
    w.apply('rain');
    const rain = t.rain as unknown as { setLighting: Mock; setFlash: Mock };
    const l = rain.setLighting.mock.lastCall![0] as { sky: THREE.Color; fogDensity: number };
    expect(l.fogDensity).toBe(WEATHER_PRESETS.rain.fogDensity);
    expect(l.sky.r + l.sky.g + l.sky.b).toBeGreaterThan(0);
    expect(rain.setFlash).toHaveBeenLastCalledWith(0);
  });
});

describe('golden hour sky (Kiran, 2026-10-14: clouds that read, distant glass that stays glass)', () => {
  const g = WEATHER_PRESETS.golden;
  const hsl = (hex: string) => new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 });
  it('hazes the distance in a near-neutral colour so far glass towers keep their own tint', () => {
    // Fog takes the horizon colour: a cream horizon turned every distant tower beige.
    expect(hsl(g.horizon).s).toBeLessThan(0.15);
  });
  it('lights the clouds well apart from the horizon so they read against it', () => {
    const lit = new THREE.Color(g.cloudLight);
    const horizon = new THREE.Color(g.horizon);
    const distance = Math.hypot(lit.r - horizon.r, lit.g - horizon.g, lit.b - horizon.b);
    expect(distance).toBeGreaterThan(0.25);
    expect(g.cloudCover).toBeGreaterThanOrEqual(0.4);
    // Warm key on the cloud tops, cool shadow underneath.
    expect(hsl(g.cloudLight).h).toBeLessThan(0.12);
    expect(hsl(g.cloudDark).h).toBeGreaterThan(0.55);
  });
});
