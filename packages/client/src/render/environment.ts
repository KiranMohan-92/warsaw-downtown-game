import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { WeatherId } from '../settings/settings.ts';
import { ENV_CUBE_SIZE } from './sky.ts';
import { withTimeout } from './surfaceTextures.ts';
import type { WeatherPreset } from './weather.ts';

/**
 * Image-based lighting from real skies: Poly Haven HDRIs (CC0) prepared by
 * tools/assets/build_env.py into public/env/<id>.hdr (512 × 256 RGBE, sun inpainted, rotated so
 * the sun sits at the preset's azimuth, upper hemisphere normalised to mean luminance 1) and
 * listed in public/env/manifest.json with the weather presets they light.
 *
 * Every map is prefiltered (PMREM) at load, before `Game.warmUp`, at the same cube size as the
 * procedural sky bake, so a weather change only swaps a texture: no compile, no bake in play.
 * The visible sky dome stays procedural; presets without an HDRI (dusk), and any map that fails
 * to load, keep the procedural bake.
 */

export interface EnvManifestEntry {
  file: string;
  width: number;
  height: number;
  presets: readonly WeatherId[];
}
export type EnvManifest = Record<string, EnvManifestEntry>;

/** PMREM cube size three derives from an equirect map (PMREMGenerator: width / 4, power of 2). */
export function pmremCubeSize(equirectWidth: number): number {
  return 2 ** Math.floor(Math.log2(equirectWidth / 4));
}

/** Manifest entries usable as-is: known presets, and the cube size every material compiled for. */
export function usableEntries(
  manifest: EnvManifest,
  known: readonly WeatherId[],
  warn: (msg: string) => void = (m) => console.warn(m),
): [string, EnvManifestEntry][] {
  const out: [string, EnvManifestEntry][] = [];
  for (const [id, e] of Object.entries(manifest)) {
    if (pmremCubeSize(e.width) !== ENV_CUBE_SIZE) {
      warn(
        `env '${id}': ${e.width} px wide gives a cube of ${pmremCubeSize(e.width)}, need ${ENV_CUBE_SIZE}`,
      );
      continue;
    }
    const presets = e.presets.filter((p) => known.includes(p));
    if (presets.length) out.push([id, { ...e, presets }]);
  }
  return out;
}

const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Cosine-weighted mean luminance (linear) of the procedural sky's upper hemisphere at exposure 1:
 * irradiance on an up-facing surface / π, the quantity the HDRIs are normalised to. Mirrors the
 * sky shader (sky.ts) with its noise replaced by expectations: the cloud mask averaged over the
 * fBm's typical range, cloud colour = the mean of its light and dark tones. An HDRI lit preset
 * is scaled by this, so it keeps the brightness the preset was tuned with.
 */
export function proceduralSkyMean(p: WeatherPreset, steps = 48): number {
  const zenith = new THREE.Color(p.zenith);
  const horizon = new THREE.Color(p.horizon);
  const sunColor = new THREE.Color(p.sunColor);
  const cloud = new THREE.Color(p.cloudLight).lerp(new THREE.Color(p.cloudDark), 0.5);
  const el0 = THREE.MathUtils.degToRad(p.sunElevation);
  const az0 = THREE.MathUtils.degToRad(p.sunAzimuth);
  const sun = new THREE.Vector3(
    Math.sin(az0) * Math.cos(el0),
    Math.sin(el0),
    -Math.cos(az0) * Math.cos(el0),
  );
  // Expected cloud mask for the deck's noise value n ≈ uniform over fBm's usual 0.3–0.67.
  const thresh = 1 - p.cloudCover;
  let cover = 0;
  for (let i = 0; i < 16; i++) {
    const n = 0.3 + (0.37 * (i + 0.5)) / 16;
    cover += smoothstep(thresh - 0.05, thresh + 0.25, n) / 16;
  }
  const d = new THREE.Vector3();
  const col = new THREE.Color();
  let total = 0;
  let weight = 0;
  for (let i = 0; i < steps; i++) {
    const el = ((i + 0.5) / steps) * (Math.PI / 2);
    const h = Math.sin(el);
    const w = Math.sin(el) * Math.cos(el);
    const mask = cover * smoothstep(0, 0.18, h);
    for (let j = 0; j < steps * 2; j++) {
      const az = ((j + 0.5) / (steps * 2)) * Math.PI * 2;
      d.set(Math.sin(az) * Math.cos(el), h, -Math.cos(az) * Math.cos(el));
      const sd = Math.max(d.dot(sun), 0);
      col.copy(horizon).lerp(zenith, Math.pow(h, 0.45));
      const glow = (Math.pow(sd, 6) * 0.35 + Math.pow(sd, 64) * 0.6) * p.sunStrength;
      const sky = lum(col) + lum(sunColor) * glow;
      const clouds = lum(cloud) + lum(sunColor) * Math.pow(sd, 8) * 0.4 * p.sunStrength;
      total += (sky * (1 - mask) + clouds * mask) * w;
      weight += w;
    }
  }
  return total / weight;
}

/** Prefiltered HDRI environment maps by weather preset. */
export class EnvironmentLibrary {
  private readonly byPreset = new Map<WeatherId, THREE.Texture>();

  get(id: WeatherId): THREE.Texture | null {
    return this.byPreset.get(id) ?? null;
  }

  get size(): number {
    return this.byPreset.size;
  }

  /**
   * Fetch the manifest and every HDRI, prefilter them. Never rejects: whatever fails is logged as
   * a warning and those presets keep the procedural bake. `timeoutMs` bounds the whole load (the
   * manifest and the maps share one deadline), so a stalled server holds the loading screen for
   * at most that long.
   */
  static async load(
    renderer: THREE.WebGLRenderer,
    known: readonly WeatherId[],
    base: string = import.meta.env.BASE_URL,
    timeoutMs = 20_000,
  ): Promise<EnvironmentLibrary> {
    const lib = new EnvironmentLibrary();
    const dir = `${base.endsWith('/') ? base : `${base}/`}env/`;
    const deadline = Date.now() + timeoutMs;
    const left = (): number => Math.max(0, deadline - Date.now());
    let manifest: EnvManifest;
    try {
      const res = await withTimeout(fetch(`${dir}manifest.json`), left(), 'env manifest');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = (await withTimeout(res.json(), left(), 'env manifest')) as EnvManifest;
    } catch (e) {
      console.warn(`environment maps unavailable, using the procedural sky (${String(e)})`);
      return lib;
    }
    const loader = new HDRLoader();
    const pmrem = new THREE.PMREMGenerator(renderer);
    try {
      await Promise.all(
        usableEntries(manifest, known).map(async ([id, e]) => {
          try {
            const url = `${dir}${e.file}`;
            const eq = await withTimeout(loader.loadAsync(url), left(), url);
            eq.mapping = THREE.EquirectangularReflectionMapping;
            const target = pmrem.fromEquirectangular(eq);
            eq.dispose();
            for (const p of e.presets) lib.byPreset.set(p, target.texture);
          } catch (err) {
            console.warn(`env '${id}': load failed, using the procedural sky (${String(err)})`);
          }
        }),
      );
    } finally {
      pmrem.dispose();
    }
    return lib;
  }
}
