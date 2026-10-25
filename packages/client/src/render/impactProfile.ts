import type { SurfaceKind } from '@wd/shared';

export interface DebrisChipProfile {
  sx: number;
  sy: number;
  sz: number;
  spin: number;
}

export interface DebrisPreset {
  bits: readonly [number, number];
  bitColor: readonly [number, number, number];
  bitSpeed: number;
  bitLife: number;
  chip: Readonly<DebrisChipProfile>;
  sparks: readonly [number, number];
  embers: readonly [number, number];
  sparkColor: readonly [number, number, number];
  sparkSpeed: number;
  sparkLife: number;
  /** Streak length and width (m at the reference scale; trails stretch along their velocity). */
  sparkLength: number;
  sparkWidth: number;
  flashLife: readonly [number, number];
  flashSize: number;
  /** Hot white-yellow core + orange glow (`FLASH`), rather than the spark colour (glass). */
  hotFlash: boolean;
  dust: readonly [number, number];
  dustColor: readonly [number, number, number];
  dustSize: number;
  dustLife: number;
  /**
   * Dense jets thrown straight off the surface for ~0.3 s, darker than the billow: the punch that
   * reads in the first frames, before the slow cloud opens (count; launch speed m/s). Low keeps it.
   */
  kick: number;
  kickSpeed: number;
  /** Glints (embers) twinkle as they tumble: glass shards catching the light. */
  twinkle: boolean;
  decal: boolean;
}

/**
 * Presentation only. Every tier uses these shapes; Low trims puff count/size and spark trail
 * count/length but keeps the flash, the kick and the decal. Hard surfaces (metal, stone) open with
 * a hot flash of 2–3 frames (35–50 ms) and gravity-bent streak sparks; every surface but metal and
 * glass throws a dense kick of its own dust (concrete grey, wood brown, dirt brown) ahead of the
 * slow billow; glass throws glittering shards.
 */
export const DEBRIS: Readonly<Record<SurfaceKind, Readonly<DebrisPreset>>> = {
  stone: {
    bits: [8, 14],
    bitColor: [0.36, 0.34, 0.32],
    bitSpeed: 3.2,
    bitLife: 0.95,
    chip: { sx: 0.041, sy: 0.03, sz: 0.032, spin: 14 },
    sparks: [3, 5],
    embers: [0, 0],
    sparkColor: [4.2, 2.5, 1.1],
    sparkSpeed: 8,
    sparkLife: 0.14,
    sparkLength: 0.24,
    sparkWidth: 0.015,
    flashLife: [0.035, 0.05],
    flashSize: 0.3,
    hotFlash: true,
    dust: [2, 2],
    dustColor: [0.72, 0.7, 0.65],
    dustSize: 0.65,
    dustLife: 0.88,
    kick: 1,
    kickSpeed: 4.2,
    twinkle: false,
    decal: true,
  },
  metal: {
    bits: [1, 2],
    bitColor: [0.55, 0.53, 0.5],
    bitSpeed: 4.4,
    bitLife: 0.5,
    chip: { sx: 0.035, sy: 0.018, sz: 0.018, spin: 20 },
    sparks: [10, 16],
    embers: [1, 2],
    sparkColor: [5, 3, 1.5],
    sparkSpeed: 12,
    sparkLife: 0.35,
    sparkLength: 0.42,
    sparkWidth: 0.018,
    flashLife: [0.035, 0.05],
    flashSize: 0.48,
    hotFlash: true,
    dust: [1, 1],
    dustColor: [0.5, 0.5, 0.5],
    dustSize: 0.38,
    dustLife: 0.35,
    kick: 0,
    kickSpeed: 0,
    twinkle: false,
    decal: true,
  },
  wood: {
    bits: [8, 14],
    bitColor: [0.6, 0.4, 0.2],
    bitSpeed: 3.8,
    bitLife: 0.95,
    chip: { sx: 0.052, sy: 0.008, sz: 0.01, spin: 18 },
    sparks: [0, 0],
    embers: [0, 0],
    sparkColor: [1, 0.8, 0.5],
    sparkSpeed: 4,
    sparkLife: 0.15,
    sparkLength: 0.04,
    sparkWidth: 0.022,
    flashLife: [0.035, 0.05],
    flashSize: 0,
    hotFlash: false,
    dust: [2, 2],
    dustColor: [0.68, 0.46, 0.26],
    dustSize: 0.65,
    dustLife: 0.86,
    kick: 1,
    kickSpeed: 3.6,
    twinkle: false,
    decal: true,
  },
  glass: {
    bits: [6, 10],
    bitColor: [0.8, 0.88, 0.92],
    bitSpeed: 3.8,
    bitLife: 0.7,
    chip: { sx: 0.02, sy: 0.003, sz: 0.014, spin: 22 },
    sparks: [2, 3],
    embers: [3, 5],
    sparkColor: [0.78, 0.93, 1.15],
    sparkSpeed: 3.5,
    sparkLife: 0.12,
    sparkLength: 0.04,
    sparkWidth: 0.022,
    flashLife: [0.035, 0.05],
    flashSize: 0.18,
    hotFlash: false,
    dust: [0, 0],
    dustColor: [0.8, 0.8, 0.8],
    dustSize: 0.3,
    dustLife: 0.35,
    kick: 0,
    kickSpeed: 0,
    twinkle: true,
    decal: true,
  },
  soft: {
    bits: [6, 8],
    bitColor: [0.24, 0.34, 0.16],
    bitSpeed: 2.2,
    bitLife: 0.7,
    chip: { sx: 0.017, sy: 0.008, sz: 0.01, spin: 10 },
    sparks: [0, 0],
    embers: [0, 0],
    sparkColor: [1, 1, 1],
    sparkSpeed: 1,
    sparkLife: 0.15,
    sparkLength: 0.04,
    sparkWidth: 0.022,
    flashLife: [0.035, 0.05],
    flashSize: 0,
    hotFlash: false,
    dust: [2, 2],
    dustColor: [0.56, 0.45, 0.31],
    dustSize: 0.65,
    dustLife: 0.9,
    // Dirt spurts: two jets, the second a little slower (a clod and its spray).
    kick: 2,
    kickSpeed: 4.6,
    twinkle: false,
    // A dark divot in lawn/dirt (ground hits only: see Effects.impact).
    decal: true,
  },
};

/**
 * Kick jets: life (s), size (× the surface's dust size), shade (× its dust colour: dark, so the
 * cone silhouettes against a sunlit wall of the same material), peak alpha. Drawn stretched along
 * their motion (a jet, not a ball).
 */
export const KICK = { life: 0.32, size: 0.55, shade: 0.3, alpha: 0.95 } as const;

export const MAX_POINT_PX = 198;
export const DUST_TARGET_PX = 72;
export const IMPACT_NOMINAL_METERS = 0.42;
export const puffScreenLimit = (low: boolean, viewportHeight = 900): number => {
  const cap = Math.min(MAX_POINT_PX, viewportHeight * 0.22);
  return low ? cap * 0.8 : cap;
};

/** A 48 px reference makes the billow peak at ~85 px before outward separation from its surface. */
export function impactScale(distance: number, viewportHeight: number, fov: number): number {
  const focal = Math.max(1, viewportHeight) / (2 * Math.tan((fov * Math.PI) / 360));
  const projected = (IMPACT_NOMINAL_METERS * focal) / Math.max(0.1, distance);
  const target = Math.min(DUST_TARGET_PX, Math.max(48, projected));
  return Math.min(6, Math.max(0.08, target / projected));
}

/** Readability targets are authored at this view height (px) and scale with the real one. */
export const READ_VIEW_HEIGHT = 720;
/**
 * Minimum on-screen sizes (px at 720p) so a hit reads at fight distance (20–40 m) whatever its
 * world size: the flash's hot disc (HDR saturates most of it to white), its rays and its orange
 * glow, a spark streak's length and width, the dark kick jet's length and width, and a flying chip
 * (it eases back to its real size as it lands). Transient effects only: bullet holes and settled
 * debris keep their physical size (Kiran, 2026-10-16). Minimums only: up close the world sizes win.
 */
export const READ_PX = {
  flashCore: 22,
  flashRay: 44,
  flashRayWidth: 2.5,
  flashGlow: 34,
  sparkLength: 16,
  sparkWidth: 3,
  kickLength: 40,
  kickWidth: 22,
  chip: 6,
} as const;
/** Far caps (× the world size) so a minimum never turns a 60 m hit into a wall-sized sprite. */
export const READ_MAX_GROWTH = { sprite: 6, chip: 3 } as const;

/** Pixels per metre at view depth `depth` (m) for a view `viewportHeight` px tall, vertical fov. */
export function pixelsPerMeter(depth: number, viewportHeight: number, fov: number): number {
  const focal = Math.max(1, viewportHeight) / (2 * Math.tan((fov * Math.PI) / 360));
  return focal / Math.max(0.1, Number.isFinite(depth) ? depth : 0.1);
}

/**
 * `size` (m), grown if needed until it projects to `minPx` (at 720p, scaled to the view height),
 * but never past `size × maxGrowth`.
 */
export function readableSize(
  size: number,
  minPx: number,
  pxPerMeter: number,
  viewportHeight: number,
  maxGrowth: number,
): number {
  if (!(pxPerMeter > 0) || !(size > 0)) return size;
  const need = (minPx * (Math.max(1, viewportHeight) / READ_VIEW_HEIGHT)) / pxPerMeter;
  return Math.min(Math.max(size, need), size * maxGrowth);
}

/**
 * The hot flash: a sharp star (an HDR white-yellow disc that pops on a sunlit wall + two thin
 * crossed rays) and a tight orange glow.
 */
export const FLASH = {
  core: [9, 7.6, 5.2] as const,
  glow: [3.4, 1.35, 0.34] as const,
  /** Disc and ray length (× the surface's flash size) and ray width (× its length). */
  disc: 0.55,
  /** The disc follows the far-distance impact scale only up to this (then its px floor rules). */
  discScaleMax: 2.5,
  ray: 1.4,
  rayWidth: 0.06,
  /** The glow lives ~2 frames at this share of the core's alpha, 1.5× the disc (≤ 1.6×). */
  glowLife: 0.03,
  glowAlpha: 0.75,
  glowSize: 1.5,
  glowMax: 1.6,
};
