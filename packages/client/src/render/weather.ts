import * as THREE from 'three';
import { windowLight } from './windowInterior.ts';
import { setSkylineWeather } from './skylineWindows.ts';
import type { WeatherId } from '../settings/settings.ts';
import { proceduralSkyMean, type EnvironmentLibrary } from './environment.ts';
import { advanceFoliageWind, setFoliageWind, windStrengthFor } from './foliageMesh.ts';
import { wetness } from './materials.ts';
import type { Rain } from './rain.ts';
import { WetnessRamp } from './rainPhysics.ts';
import type { SkyDome } from './sky.ts';
import { setCourtyardBakeWeather } from './courtyardBake.ts';
import { setMarketNeonBakeWeather } from './marketNeonBake.ts';
import { setMarketNeonStaticBakeWeather } from './marketNeonStaticBake.ts';

/** Art-direction knobs per weather. Presentation only: never affects the simulation. */
export interface WeatherPreset {
  label: string;
  /**
   * Photographed sky (render/sky.ts `loadPhoto`, one per build): brightness relative to the
   * procedural sky's mean. Absent = procedural sky. The sun direction must match the photo's
   * (env/sky.json), so shadows and sky agree.
   */
  skyPhoto?: number;
  /** Sun elevation and azimuth (degrees). Azimuth 0 = north (-Z), clockwise. */
  sunElevation: number;
  sunAzimuth: number;
  sunColor: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  /**
   * Image-based lighting strength, relative to the procedural sky's brightness. An HDRI-lit
   * preset (environment.ts) is scaled to the same irradiance, so this stays the one knob.
   */
  envIntensity: number;
  exposure: number;
  fogDensity: number;
  zenith: string;
  horizon: string;
  ground: string;
  sunStrength: number;
  cloudCover: number;
  cloudLight: string;
  cloudDark: string;
  wetness: number;
  rain: number;
  lightning: boolean;
  bloom: number;
}

export const WEATHER_PRESETS: Record<WeatherId, WeatherPreset> = {
  sunny: {
    label: 'Sunny',
    skyPhoto: 1,
    // The photographed sky's sun (env/sky.json): shadows fall where the sky says they should.
    sunElevation: 47.9,
    sunAzimuth: 215,
    sunColor: '#fff2df',
    // A harder, warmer sun and less flat fill: the contrast of a real midday.
    sunIntensity: 3.4,
    hemiSky: '#bcd4ee',
    hemiGround: '#5d5246',
    hemiIntensity: 0.26,
    // Sky light fills the shade (real midday shade is ~15-25 % of sun): dark paint and sacks in
    // the Palace's shadow read as surfaces, not holes.
    envIntensity: 1.0,
    exposure: 0.95,
    // Clear day: the towers a kilometre out still read (light aerial haze, not fog).
    fogDensity: 0.0012,
    zenith: '#3b73bd',
    horizon: '#c6dbee',
    ground: '#a4adb3',
    sunStrength: 1,
    cloudCover: 0.3,
    cloudLight: '#ffffff',
    cloudDark: '#a9b4c2',
    wetness: 0,
    rain: 0,
    lightning: false,
    bloom: 0.35,
  },
  overcast: {
    label: 'Overcast',
    sunElevation: 40,
    sunAzimuth: 200,
    sunColor: '#e6eaef',
    sunIntensity: 0.9,
    hemiSky: '#c5ccd4',
    hemiGround: '#5a5650',
    hemiIntensity: 0.55,
    envIntensity: 1.0,
    exposure: 0.92,
    fogDensity: 0.006,
    zenith: '#7d8893',
    horizon: '#b4bcc4',
    ground: '#8e959b',
    sunStrength: 0.1,
    cloudCover: 0.93,
    cloudLight: '#c9cfd6',
    cloudDark: '#7a838d',
    wetness: 0.12,
    rain: 0,
    lightning: false,
    bloom: 0.25,
  },
  rain: {
    label: 'Rain (storm)',
    sunElevation: 32,
    sunAzimuth: 190,
    sunColor: '#9fb0c4',
    sunIntensity: 0.35,
    hemiSky: '#6b7784',
    hemiGround: '#2a2a2c',
    hemiIntensity: 0.55,
    envIntensity: 0.75,
    exposure: 1.0,
    fogDensity: 0.013,
    zenith: '#2a3139',
    horizon: '#4f5963',
    ground: '#383e44',
    sunStrength: 0,
    cloudCover: 1,
    cloudLight: '#5b6570',
    cloudDark: '#232930',
    wetness: 1,
    rain: 1,
    lightning: true,
    bloom: 0.5,
  },
  dusk: {
    label: 'Dusk',
    sunElevation: 5,
    sunAzimuth: 255,
    sunColor: '#ffae6b',
    sunIntensity: 2.6,
    hemiSky: '#8fa0c8',
    hemiGround: '#4a3a34',
    hemiIntensity: 0.35,
    envIntensity: 0.85,
    exposure: 1.05,
    fogDensity: 0.004,
    zenith: '#2b3d6e',
    horizon: '#f09c6a',
    ground: '#6a5550',
    sunStrength: 1.3,
    cloudCover: 0.38,
    cloudLight: '#ffc59b',
    cloudDark: '#665670',
    wetness: 0,
    rain: 0,
    lightning: false,
    bloom: 0.6,
  },
  golden: {
    label: 'Golden hour',
    // Low morning sun from the south-east: it clears the Market's open south-east side and lights
    // the Palace's east face (the one the Market looks at); long shadows rake the rows. From the
    // west it sat behind the Palace and left the whole Market in shade.
    sunElevation: 18,
    sunAzimuth: 135,
    sunColor: '#ffc27a',
    sunIntensity: 3.3,
    // A cool sky fill against the warm key: shade reads blue-grey, never black.
    hemiSky: '#9cb8de',
    hemiGround: '#5e4c3f',
    hemiIntensity: 0.3,
    envIntensity: 0.95,
    exposure: 0.96,
    // A light, near-neutral haze (Kiran, 2026-10-14): fog takes the horizon colour, and a cream
    // horizon turned every distant glass tower into a beige slab; neutral, they read as glass.
    fogDensity: 0.0009,
    zenith: '#1f4ea8',
    horizon: '#dad6cf',
    ground: '#8c8073',
    sunStrength: 1.2,
    // Golden-lit cloud tops with cool blue undersides, apart from the horizon so they read (warm
    // cream clouds on a cream horizon vanished).
    cloudCover: 0.48,
    cloudLight: '#ffb27a',
    cloudDark: '#55627f',
    wetness: 0,
    rain: 0,
    lightning: false,
    bloom: 0.45,
  },
  neon: {
    label: 'Warsaw 2030 — neon night',
    sunElevation: 18,
    sunAzimuth: 35,
    sunColor: '#bfd5ef',
    sunIntensity: 0.85,
    hemiSky: '#7a8da6',
    hemiGround: '#302a28',
    hemiIntensity: 0.58,
    envIntensity: 0.82,
    exposure: 0.95,
    // Preserve target contrast across Market/Palace sightlines (120 m retains >80%).
    fogDensity: 0.0035,
    zenith: '#090e1b',
    horizon: '#243349',
    ground: '#151c27',
    sunStrength: 0.14,
    cloudCover: 0.72,
    cloudLight: '#344258',
    cloudDark: '#111625',
    wetness: 0.82,
    rain: 0.25,
    lightning: false,
    bloom: 0.82,
  },
};

export function sunDirection(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export interface WeatherTargets {
  scene: THREE.Scene;
  sky: SkyDome;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  rain: Rain;
  setBloom: (v: number) => void;
  onThunder: (distance: number) => void;
  setRainAudio: (v: number) => void;
}

/** Applies a preset to lights, sky, fog, environment, wetness, rain; runs lightning. */
export class WeatherSystem {
  preset: WeatherPreset = WEATHER_PRESETS.sunny;
  readonly sunDir = new THREE.Vector3();
  private lightningTimer = 8;
  private flashTime = -1;
  private thunderDelay = -1;
  private thunderDistance = 0;

  private env: EnvironmentLibrary | null = null;
  private applied: WeatherId | null = null;
  private lowQuality = false;
  private environment: THREE.Texture | null = null;
  private environmentGain = 0;
  /** Surfaces soak in over seconds when rain starts, dry over a minute when it stops. */
  private readonly wet = new WetnessRamp();

  constructor(private readonly t: WeatherTargets) {}

  /** The weapon keeps its reflection response even when the Low world uses hemisphere fill. */
  get environmentMap(): THREE.Texture | null {
    return this.environment;
  }

  /** Low trades PMREM and exponential fog for preset-matched hemispherical fill and depth fog. */
  setLowQuality(low: boolean): void {
    if (this.lowQuality === low) return;
    this.lowQuality = low;
    this.t.rain.setLowQuality(low);
    this.t.scene.environment = low ? null : this.environment;
    if (this.applied) {
      this.applyFill();
      this.applyFog();
    }
  }

  private applyFog(): void {
    const p = this.preset;
    // A smoothstep fit to 1-exp(-x²): < 3.6 percentage points error at any depth.
    // Evaluate per fragment: vertex fog over-fogs the map's large floor triangles.
    this.t.scene.fog = this.lowQuality
      ? new THREE.Fog(p.horizon, -0.135 / p.fogDensity, 1.875 / p.fogDensity)
      : new THREE.FogExp2(p.horizon, p.fogDensity);
  }

  private applyFill(flash = 0): void {
    const p = this.preset;
    this.t.hemi.color.set(p.hemiSky);
    this.t.hemi.groundColor.set(p.hemiGround);
    this.t.hemi.intensity = (p.hemiIntensity + flash * 2.5) * p.exposure;
    if (!this.lowQuality) return;
    // MeshStandard's environment diffuse is PI * sky radiance. Fold that constant into the
    // existing hemisphere light, retaining the preset's tint without a per-pixel PMREM lookup.
    const fill = (color: string, gain: number): THREE.Color => {
      const c = new THREE.Color(color);
      const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      return c.multiplyScalar(gain / Math.max(luminance, 0.001));
    };
    const gain = Math.PI * this.environmentGain;
    this.t.hemi.color.multiplyScalar(this.t.hemi.intensity).add(fill(p.hemiSky, gain));
    this.t.hemi.groundColor
      .multiplyScalar(this.t.hemi.intensity)
      .add(fill(p.hemiGround, gain * 0.35));
    this.t.hemi.intensity = 1;
  }

  /** The sky photo has loaded (before warm-up): re-apply the preset so it shows and lights. */
  skyPhotoReady(): void {
    if (this.applied) this.apply(this.applied);
  }

  /** HDRI environment maps (loaded before warm-up); re-lights the current preset with them. */
  setEnvironments(env: EnvironmentLibrary): void {
    this.env = env;
    if (this.applied) this.applyEnvironment(this.applied, this.preset);
  }

  /** The HDRI for `id` if there is one, else a bake of the procedural sky (already `set`). */
  private applyEnvironment(id: WeatherId, p: WeatherPreset): void {
    const hdri = this.env?.get(id) ?? null;
    // Exposure is folded in here too; an HDRI is normalised to mean 1, so it is scaled to the
    // procedural sky's brightness to keep the preset's tuning.
    const scale = hdri ? proceduralSkyMean(p) : 1;
    this.environment = hdri ?? this.t.sky.bakeEnvironment();
    this.environmentGain = p.envIntensity * p.exposure * proceduralSkyMean(p);
    this.t.scene.environment = this.lowQuality ? null : this.environment;
    this.t.scene.environmentIntensity = p.envIntensity * p.exposure * scale;
    this.applyFill();
  }

  apply(id: WeatherId): void {
    const p = WEATHER_PRESETS[id];
    setCourtyardBakeWeather(id, p.exposure);
    setMarketNeonBakeWeather(id, p.exposure);
    setMarketNeonStaticBakeWeather(id, p.exposure);
    // Independent room lamps reveal occupied interiors after dark rather than painting
    // every opening with the same daylight value. Uniform changes require no recompilation.
    windowLight.interior.value = id === 'neon' ? 0.16 : 0.32;
    windowLight.lamps.value = id === 'neon' ? 2.4 : 0.18;
    setSkylineWeather(id, p.exposure);
    this.preset = p;
    this.applied = id;
    this.sunDir.copy(sunDirection(p.sunElevation, p.sunAzimuth));
    const c = (s: string): THREE.Color => new THREE.Color(s);
    this.t.sky.set({
      zenith: c(p.zenith),
      horizon: c(p.horizon),
      ground: c(p.ground),
      sunDir: this.sunDir,
      sunColor: c(p.sunColor),
      sunStrength: p.sunStrength,
      cloudCover: p.cloudCover,
      cloudLight: c(p.cloudLight),
      cloudDark: c(p.cloudDark),
      flash: 0,
    });
    this.t.sky.setPhoto(p.skyPhoto ? 1 : 0, (p.skyPhoto ?? 0) * proceduralSkyMean(p));
    this.t.sun.color.set(p.sunColor);
    // Exposure is folded into every light source (sun, sky fill, IBL, sky dome).
    this.t.sun.intensity = p.sunIntensity * p.exposure;
    this.applyFog();
    this.applyEnvironment(id, p);
    this.t.sky.setExposure(p.exposure);
    this.t.setBloom(p.bloom);
    this.wet.set(p.wetness);
    wetness.value = this.wet.value;
    // Drops refract the sky above them (the storm's cloud deck) and glint toward the sun.
    const sky = c(p.cloudLight)
      .lerp(c(p.zenith), 1 - p.cloudCover)
      .multiplyScalar(p.exposure);
    this.t.rain.setLighting({
      sky,
      sunColor: c(p.sunColor).multiplyScalar(p.sunIntensity * p.exposure * 0.5),
      sunDir: this.sunDir,
      fogDensity: p.fogDensity,
    });
    this.t.rain.setFlash(0);
    setFoliageWind(windStrengthFor(p));
    this.t.rain.setIntensity(p.rain);
    this.t.setRainAudio(p.rain);
    this.lightningTimer = 4 + Math.random() * 6;
  }

  update(dt: number): void {
    advanceFoliageWind(dt);
    wetness.value = this.wet.update(dt);
    const p = this.preset;
    if (!p.lightning) return;
    this.lightningTimer -= dt;
    if (this.lightningTimer <= 0) {
      this.flashTime = 0;
      this.thunderDistance = 0.5 + Math.random() * 2.5; // km-ish: sets the delay and rumble
      this.thunderDelay = this.thunderDistance * 0.9;
      this.lightningTimer = 7 + Math.random() * 12;
    }
    let flash = 0;
    if (this.flashTime >= 0) {
      this.flashTime += dt;
      const f = this.flashTime;
      // Double strike: bright pulse, gap, second pulse, decay.
      flash = Math.max(0, 1 - f / 0.07) + (f > 0.12 ? Math.max(0, 0.8 - (f - 0.12) / 0.18) : 0);
      if (f > 0.5) this.flashTime = -1;
    }
    if (this.thunderDelay >= 0) {
      this.thunderDelay -= dt;
      if (this.thunderDelay < 0) this.t.onThunder(this.thunderDistance);
    }
    this.t.sky.setFlash(flash * 0.6);
    this.t.rain.setFlash(flash * 0.35);
    this.applyFill(flash);
  }
}
