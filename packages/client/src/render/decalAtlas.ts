/**
 * Bullet-hole decals at their physical size (Kiran, 2026-10-16: "unnatural and too big"): one
 * procedural atlas of `DECAL_VARIANTS` irregular variants per surface, a fixed world size per
 * surface (±20 % per hit, random roll), no screen-space growth. They read at 20–40 m by contrast
 * — a near-black hole core inside a lighter broken spall / bright bare-metal ring / pale torn
 * fibres — not by size: a 40 m hole may be a few pixels, as it is in life.
 *
 * Pure texel maths (tested); `impactDecalAtlasTexture` packs it into one row of tiles that the
 * decal shader indexes with its per-instance `decalTile`, as multiply factors (`decalModulate`):
 * the decal darkens and lightens the surface it lies on rather than painting a colour over it.
 */
import * as THREE from 'three';
import type { SurfaceKind } from '@wd/shared';

export const DECAL_TILE_PX = 64;
export const DECAL_VARIANTS = 4;
/** Surfaces in atlas order (each owns `DECAL_VARIANTS` consecutive tiles). */
export const DECAL_MATERIALS = [
  'stone',
  'metal',
  'wood',
  'glass',
  'soft',
] as const satisfies readonly SurfaceKind[];
export const DECAL_TILE_COUNT = DECAL_MATERIALS.length * DECAL_VARIANTS;

/**
 * World size of a decal quad per surface (m, its side; ±`jitter`/2 per hit), and what that holds
 * for a rifle round (diameters):
 * - stone/concrete/brick: a ~1.3 cm hole in a ~6–12 cm irregular spall crater, dust/soot halo;
 * - metal: a ~1.1 cm hole, a ~2–2.5 cm bright bare-metal ring, slight dent shading;
 * - wood: a ~1.1 cm hole, splintered fibres ~3–5 cm along the grain;
 * - glass: a small hole, a frosted crush ring, radial cracks ~8–15 cm;
 * - soft (lawn, dirt, sandbags): a ~4–6 cm dark divot.
 */
export const DECAL_SIZE: Readonly<Record<(typeof DECAL_MATERIALS)[number], number>> = {
  stone: 0.13,
  metal: 0.045,
  wood: 0.065,
  glass: 0.14,
  soft: 0.08,
};
/** Per-hit size spread: 1 ± jitter/2 (±20 %). */
export const DECAL_JITTER = 0.4;

/** Atlas tile for a surface's variant. */
export function decalTile(surface: (typeof DECAL_MATERIALS)[number], variant: number): number {
  const v = Math.min(DECAL_VARIANTS - 1, Math.max(0, Math.floor(variant)));
  return DECAL_MATERIALS.indexOf(surface) * DECAL_VARIANTS + v;
}

/** A hit's world quad size: the surface size × 1 ± jitter/2. */
export function decalWorldSize(
  surface: (typeof DECAL_MATERIALS)[number],
  rnd: () => number = Math.random,
): number {
  return DECAL_SIZE[surface] * (1 - DECAL_JITTER * 0.5 + rnd() * DECAL_JITTER);
}

/**
 * One texel (u, v in 0–1 across the tile) of a surface's variant: [r, g, b, a] in 0–255,
 * straight alpha, sRGB colour.
 */
export function decalTexel(
  surface: (typeof DECAL_MATERIALS)[number],
  variant: number,
  u: number,
  v: number,
): [number, number, number, number] {
  const dx = u * 2 - 1;
  const dy = v * 2 - 1;
  const d = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx);
  const seed = variant * 7.31 + DECAL_MATERIALS.indexOf(surface) * 3.17;
  // An irregular outline: low lobes plus finer breaks, different per variant (never a circle).
  const lobes = (amp: number): number =>
    1 +
    amp *
      (0.55 * Math.sin(3 * a + hash(seed, 1) * 6.28) +
        0.3 * Math.sin(5 * a + hash(seed, 2) * 6.28) +
        0.15 * Math.sin(9 * a + hash(seed, 3) * 6.28));
  const grain = hash2(u * 61 + seed, v * 59 - seed); // 0–1 texel noise
  let r = 0;
  let g = 0;
  let b = 0;
  let alpha = 0;
  // Composite layers back to front: `put(colour, coverage)`.
  const put = (cr: number, cg: number, cb: number, cover: number): void => {
    const k = Math.max(0, Math.min(1, cover));
    const out = k + alpha * (1 - k);
    if (out <= 1e-6) return;
    r = (cr * k + r * alpha * (1 - k)) / out;
    g = (cg * k + g * alpha * (1 - k)) / out;
    b = (cb * k + b * alpha * (1 - k)) / out;
    alpha = out;
  };
  if (surface === 'stone') {
    const dr = d / lobes(0.22);
    // Dust/soot halo, the chipped flakes thrown round the crater, the crater, its broken rim,
    // the hole.
    put(52, 50, 47, 0.22 * smoothstep(0.98, 0.66, dr));
    if (dr > 0.62 && dr < 0.86 && grain > 0.84) put(196, 190, 178, 0.7);
    const crater = smoothstep(0.66 + (grain - 0.5) * 0.08, 0.58, dr);
    const depth = Math.min(1, dr / 0.6);
    put(98 + depth * 70, 95 + depth * 66, 89 + depth * 60, crater * 0.88);
    const rim = smoothstep(0.5, 0.6, dr) * crater;
    put(204, 198, 186, rim * 0.75);
    put(10, 10, 9, smoothstep(0.14, 0.08, d / lobes(0.1)));
  } else if (surface === 'metal') {
    const dr = d / lobes(0.1);
    // Dent shading (lit on one side), bright bare-metal ring with radial scratches, the hole.
    const side = (dx * Math.cos(seed) + dy * Math.sin(seed)) / Math.max(d, 1e-6);
    put(40 + side * 30, 40 + side * 30, 42 + side * 30, 0.4 * smoothstep(0.92, 0.5, dr));
    const streak = 0.75 + 0.25 * Math.sin(a * 23 + hash(seed, 4) * 9);
    const ring = smoothstep(0.24, 0.3, dr) * smoothstep(0.56, 0.46, dr);
    put(206 * streak, 204 * streak, 198 * streak, ring * 0.92);
    put(14, 14, 15, smoothstep(0.27, 0.21, dr));
  } else if (surface === 'wood') {
    // Grain along u: an elongated, jagged tear of pale fibres round a punched hole.
    const ex = dx * 0.62;
    const ey = dy * 1.55;
    const e = Math.hypot(ex, ey) / lobes(0.25);
    const fibre = Math.abs(Math.sin(dy * 38 + Math.sin(dx * 6 + seed) * 2 + seed));
    const tear = smoothstep(0.46 + (fibre - 0.5) * 0.18, 0.36, e);
    put(64, 40, 20, 0.5 * smoothstep(0.7, 0.4, e));
    put(232 * (0.85 + fibre * 0.15), 206 * (0.85 + fibre * 0.15), 168, tear * (0.55 + fibre * 0.4));
    put(18, 11, 6, smoothstep(0.2, 0.13, d / lobes(0.12)));
  } else if (surface === 'glass') {
    // Radial cracks of random length, a partial concentric crack, a frosted crush ring, the hole.
    let crack = 0;
    for (let k = 0; k < 9; k++) {
      const at = hash(seed, 10 + k) * 6.28;
      const len = 0.45 + hash(seed, 30 + k) * 0.5;
      const off = Math.abs(Math.atan2(Math.sin(a - at), Math.cos(a - at))) * d;
      crack = Math.max(crack, Math.exp(-((off / 0.012) ** 2)) * smoothstep(len, len - 0.15, d));
    }
    const arcR = 0.32 + hash(seed, 5) * 0.12;
    const arc =
      Math.exp(-(((d - arcR) / 0.012) ** 2)) * (Math.sin(a * 2 + hash(seed, 6) * 6.28) > 0 ? 1 : 0);
    put(232, 240, 246, Math.max(crack, arc * 0.8) * 0.85);
    put(236, 242, 248, smoothstep(0.24, 0.12, d / lobes(0.2)) * 0.8);
    put(28, 32, 36, smoothstep(0.075, 0.045, d));
  } else {
    // A torn divot: dark earth with an irregular soft edge and a few clods round it.
    const dr = d / lobes(0.3);
    if (dr > 0.6 && dr < 0.9 && grain > 0.8) put(42, 32, 22, 0.6);
    put(38, 30, 21, smoothstep(0.7 + (grain - 0.5) * 0.12, 0.5, dr) * 0.9);
    put(18, 14, 10, smoothstep(0.32, 0.16, dr));
  }
  // Nothing reaches the tile edge: the quad never shows its square, whatever the outline.
  alpha *= smoothstep(0.98, 0.82, d);
  return [
    Math.round(Math.max(0, Math.min(255, r))),
    Math.round(Math.max(0, Math.min(255, g))),
    Math.round(Math.max(0, Math.min(255, b))),
    Math.round(Math.max(0, Math.min(1, alpha)) * 255),
  ];
}

/**
 * Decals multiply the surface under them (the material blends dst × src), so a hole is relative
 * to whatever it sits on: a lighter spall on blue-grey paving is lighter blue-grey, not a white
 * sticker. Factors run 0 (black) … 1 (unchanged) … `DECAL_GAIN` (that much lighter; the HDR
 * targets of Medium+ keep it, Low's 8-bit target clamps it to unchanged).
 */
export const DECAL_GAIN = 1.3;
/** The surface value the authored decal colours are relative to (sRGB 0–255, a mid stone). */
const DECAL_REFERENCE = 150;

/**
 * An authored texel ([r, g, b, a] sRGB, straight alpha) as the multiply factor it applies to the
 * surface (linear, per channel): its colour relative to a mid surface, faded to 1 by its alpha.
 */
export function decalModulate(texel: readonly number[]): [number, number, number] {
  const ref = srgbToLinear(DECAL_REFERENCE / 255);
  const a = (texel[3] ?? 0) / 255;
  const out: [number, number, number] = [1, 1, 1];
  for (let k = 0; k < 3; k++) {
    const f = Math.min(DECAL_GAIN, srgbToLinear((texel[k] ?? 0) / 255) / ref);
    out[k] = 1 + (f - 1) * a;
  }
  return out;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c: number): number {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

let atlas: THREE.DataTexture | undefined;
/** The whole atlas: one row of `DECAL_TILE_COUNT` tiles, `DECAL_TILE_PX` square. */
export function impactDecalAtlasTexture(): THREE.DataTexture {
  if (atlas) return atlas;
  const tile = DECAL_TILE_PX;
  const width = tile * DECAL_TILE_COUNT;
  const data = new Uint8Array(width * tile * 4);
  DECAL_MATERIALS.forEach((surface, m) => {
    for (let variant = 0; variant < DECAL_VARIANTS; variant++) {
      const t = m * DECAL_VARIANTS + variant;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const f = decalModulate(decalTexel(surface, variant, (x + 0.5) / tile, (y + 0.5) / tile));
          const i = (y * width + t * tile + x) * 4;
          // Stored ÷ the gain (the material's colour multiplies it back), sRGB-encoded for
          // precision in the darks; alpha unused (the factor already fades to neutral).
          for (let k = 0; k < 3; k++)
            data[i + k] = Math.round(linearToSrgb(f[k]! / DECAL_GAIN) * 255);
          data[i + 3] = 255;
        }
      }
    }
  });
  const tex = new THREE.DataTexture(data, width, tile, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  atlas = tex;
  return tex;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Deterministic 0–1 hash of a seed and an index. */
function hash(seed: number, k: number): number {
  const h = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
