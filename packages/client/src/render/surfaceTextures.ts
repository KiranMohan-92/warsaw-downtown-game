import type { MaterialId } from '@wd/shared';
import { ALBEDO_STATS, LOW_TEXTURE_SIZE, TEXTURE_SIZE } from './surfaceTextureStats.gen.ts';

/**
 * Scanned CC0 surface textures (Poly Haven, built by tools/assets/build_textures.py into
 * public/tex/<surface>_{albedo,normal,rough}.webp, plus _512 copies of the 1024 sets for the Low
 * tier). Pure helpers: tile sizes, URLs, the palette match and the all-or-nothing loader with its
 * procedural fallback. MapMaterials applies them.
 */

/** Surfaces that have a scanned texture set; every other surface stays procedural. */
export type TexturedSurface = keyof typeof ALBEDO_STATS;

/**
 * World metres covered by one texture tile (map UVs are in world metres). Chosen from the pattern
 * each scan shows, so joints and features land at real-world sizes.
 */
export const SURFACE_TILE_METRES: Record<TexturedSurface, number> = {
  asphalt: 4, // aggregate + a crack network: large tile hides repetition on long roads
  sidewalk: 3, // offline scan metadata; active Market sidewalk stays procedural at 3 m
  paving: 5, // offline granite scan metadata; active Market plaza paving stays procedural at 6 m
  concrete: 4, // cast-in-place panels ≈ 1 m with form-tie holes
  plaster: 3, // weathered render with stains and one horizontal joint per tile (≈ per storey)
  wood: 2, // 9 planks ≈ 22 cm
  metal: 1, // diamond plate: 26 bosses per tile ≈ 4 cm pitch
  container: 3, // 16 corrugation ribs ≈ 19 cm pitch
  grass: 3, // leaf litter + blades
  glass: 26.4, // office curtain wall: 8 storeys of ribbon windows (3.3 m) per tile
};

const PROCEDURAL_SURFACES = new Set<TexturedSurface>(['sidewalk', 'paving']);

// Paving and sidewalk keep the procedural stone layout after loadTextures; their offline scan
// metadata remains for asset audits, but they are intentionally not active textured surfaces.
export const TEXTURED_SURFACES = (Object.keys(SURFACE_TILE_METRES) as TexturedSurface[]).filter(
  (id) => !PROCEDURAL_SURFACES.has(id),
);

export function isTextured(id: MaterialId): id is MaterialId & TexturedSurface {
  return (TEXTURED_SURFACES as readonly string[]).includes(id);
}

export interface SurfaceMaps<T> {
  albedo: T;
  normal: T;
  rough: T;
}

/**
 * Texture size (px) surface `id` loads at. Low gets at most LOW_TEXTURE_SIZE: the 512 px procedural
 * maps the scans replaced cost that much memory and bandwidth, and Low must not cost more.
 */
export function textureSize(id: TexturedSurface, lowRes: boolean): number {
  return lowRes ? Math.min(TEXTURE_SIZE[id], LOW_TEXTURE_SIZE) : TEXTURE_SIZE[id];
}

export function surfaceUrls(
  id: TexturedSurface,
  base: string,
  lowRes = false,
): SurfaceMaps<string> {
  const dir = `${base.endsWith('/') ? base : `${base}/`}tex/${id}`;
  const size = textureSize(id, lowRes);
  const suffix = size < TEXTURE_SIZE[id] ? `_${size}` : '';
  return {
    albedo: `${dir}_albedo${suffix}.webp`,
    normal: `${dir}_normal${suffix}.webp`,
    rough: `${dir}_rough${suffix}.webp`,
  };
}

export type Rgb = readonly [number, number, number];

const luminance = (c: readonly number[]): number =>
  0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);

/**
 * One luminance gain (linear) that moves a scan's average brightness onto the surface's
 * art-directed palette colour: the scan supplies detail and structure, the palette keeps the look
 * and the exposure the weather presets were tuned for. Scaled down if the bright end (95th
 * percentile) would pass `ceiling`, so no texel gets a non-physical albedo.
 *
 * A single gain for all three channels: per-channel gains stretched a dark, tinted scan's faint
 * channel (up to 25x) and with it its compression noise. The hue is matched offline instead
 * (build_textures.py re-tints each albedo to the palette and exposes it in float), so this gain
 * is ~1 for the committed textures and only absorbs later palette brightness tweaks; a palette hue
 * change needs a texture rebuild (surfaceTextures.test.ts checks the committed hue).
 */
export function paletteGain(
  target: Rgb,
  stats: { readonly mean: readonly number[]; readonly p95: readonly number[] },
  ceiling = 0.9,
): number {
  const g = luminance(target) / Math.max(luminance(stats.mean), 1e-4);
  const top = Math.max(...stats.p95, 1e-4);
  return top * g > ceiling ? ceiling / top : g;
}

export function albedoStats(id: TexturedSurface): (typeof ALBEDO_STATS)[TexturedSurface] {
  return ALBEDO_STATS[id];
}

/** Rejects after `ms` (a stalled request must not hold the game at the loading screen). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Load every surface's three maps. A set is all-or-nothing: if any map fails, that surface keeps
 * its procedural maps (a scanned normal on a procedural albedo would look wrong) and a warning is
 * logged — a warning, not an error: the game is fully playable on the procedural surfaces.
 */
export async function loadSurfaceSets<T>(
  ids: readonly TexturedSurface[],
  load: (url: string) => Promise<T>,
  base: string,
  warn: (msg: string) => void = (m) => console.warn(m),
  lowRes = false,
): Promise<Map<TexturedSurface, SurfaceMaps<T>>> {
  const out = new Map<TexturedSurface, SurfaceMaps<T>>();
  await Promise.all(
    ids.map(async (id) => {
      const urls = surfaceUrls(id, base, lowRes);
      try {
        const [albedo, normal, rough] = await Promise.all([
          load(urls.albedo),
          load(urls.normal),
          load(urls.rough),
        ]);
        out.set(id, { albedo, normal, rough });
      } catch (e) {
        warn(`surface '${id}': texture load failed, using the procedural surface (${String(e)})`);
      }
    }),
  );
  return out;
}
