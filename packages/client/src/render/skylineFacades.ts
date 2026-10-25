/** Metre-scale facade identity shared by all pieces of a physical backdrop building. */
import type * as THREE from 'three';
import type { MapPrism, Pt } from '@wd/shared';
import { STOREY } from './facadeRelief.ts';
import type { SkylineGeometry } from './skylineBackdrop.ts';

export const SKYLINE_SATIN_KEY = 'backdrop-satin';
const GLASS_TINTS = [0x459fa7, 0xb88449, 0xe0e6e8, 0x88b7d7, 0xbac0bd, 0xd8a67c];
const WALL_TINTS = [0xd8ddd9, 0xc99672, 0x94bfc1, 0xe0d2b7, 0xb5bdc1, 0xc4bca8, 0xb0b6a1];

export interface SkylineStyle {
  tint: number;
  finish: string;
  ribbon: boolean;
  bay: number;
  storey: number;
  roomSeed: number;
}

export function skylineStyle(seed: number, glass: boolean, visibleRank?: number): SkylineStyle {
  const palette = glass ? GLASS_TINTS : WALL_TINTS;
  const index = visibleRank === undefined ? (seed >>> 3) % palette.length : visibleRank % 3;
  return {
    tint: palette[index]!,
    finish: glass && (seed & 1) !== 0 ? SKYLINE_SATIN_KEY : 'backdrop',
    ribbon: glass && visibleRank !== undefined && index === 2,
    bay: 2.4 + ((seed >>> 8) % 7) * 0.3,
    storey: 3.1 + ((seed >>> 16) % 5) * 0.15,
    roomSeed: seed % 65521,
  };
}

/** One wall patch, sharing the original plane (no overlays, depth offsets or z-fighting). */
function patch(
  g: SkylineGeometry,
  a: Pt,
  b: Pt,
  lo: number,
  hi: number,
  y0: number,
  y1: number,
  run: number,
  tint: THREE.Color,
  detail: readonly number[],
): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-5 || hi - lo < 1e-5 || y1 - y0 < 1e-5) return;
  const dx = (b[0] - a[0]) / len;
  const dz = (b[1] - a[1]) / len;
  const base = g.pos.length / 3;
  for (const [s, y] of [
    [lo, y0],
    [hi, y0],
    [hi, y1],
    [lo, y1],
  ]) {
    g.pos.push(a[0] + dx * s!, y!, a[1] + dz * s!);
    g.nrm.push(dz, 0, -dx);
    // Metre UVs keep every patch on the building's shared window grid.
    g.uv.push(run + s!, y!);
    g.col.push(tint.r, tint.g, tint.b);
    g.detail.push(...detail);
  }
  g.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/**
 * Split colours into actual wall patches, so Low retains the bands without normals/interiors.
 * The filtered backdrop shader supplies finer window rows and mullions on every tier.
 * Only exposed tower walls get floor spandrels; convex-decomposition walls stay one quad.
 */
export function skylineWall(
  g: SkylineGeometry,
  prism: MapPrism,
  a: Pt,
  b: Pt,
  run: number,
  exposed: readonly (readonly [number, number])[],
  tint: THREE.Color,
  priority = false,
  panels?: SkylineGeometry,
  style?: SkylineStyle,
): void {
  const solid = [0, 0, 0, 0];
  // Surface kinds: clear glass, satin glass, punched facade, pale ribbon facade.
  const detail = style
    ? [
        style.bay,
        style.storey,
        style.roomSeed,
        prism.mat === 'glass' ? (style.ribbon ? 4 : style.finish === SKYLINE_SATIN_KEY ? 2 : 1) : 3,
      ]
    : solid;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const treated = priority || prism.y1 - prism.y0 > 60;
  const corner =
    treated && len > 7 && ['glass', 'facade'].includes(prism.mat) ? Math.min(1.2, len * 0.08) : 0;
  const cuts = [...new Set([0, len, corner, len - corner, ...exposed.flat()])].sort(
    (a, b) => a - b,
  );
  const dark = tint.clone().multiplyScalar(prism.mat === 'glass' ? 0.58 : 0.48);
  const cornerTint = tint.clone().multiplyScalar(prism.mat === 'glass' ? 0.38 : 0.34);
  const cornice = tint.clone().multiplyScalar(1.08);
  for (let i = 1; i < cuts.length; i++) {
    const lo = cuts[i - 1]!;
    const hi = cuts[i]!;
    const exterior = exposed.some(([a, b]) => a <= (lo + hi) / 2 && b >= (lo + hi) / 2);
    if (!exterior || !['glass', 'facade'].includes(prism.mat) || prism.y1 - prism.y0 < 6) {
      patch(g, a, b, lo, hi, prism.y0, prism.y1, run, tint, solid);
      continue;
    }
    const ground = Math.min(prism.y1, prism.y0 + 3.6);
    const cap = Math.max(ground, prism.y1 - 0.45);
    const isCorner = treated && (hi <= corner + 1e-4 || lo >= len - corner - 1e-4);
    if (isCorner) {
      patch(panels ?? g, a, b, lo, hi, prism.y0, prism.y1, run, cornerTint, solid);
      continue;
    }
    const wallTint = tint;
    const bandTint = dark;
    patch(g, a, b, lo, hi, prism.y0, ground, run, bandTint, solid);
    let y = ground;
    if (prism.mat === 'glass' && (priority || prism.y1 - prism.y0 > 60)) {
      // Coarse spandrels keep their silhouette-free geometry; the shader fills every storey.
      const pitch = (style?.storey ?? STOREY) * (priority ? 4 : 3);
      for (let floor = Math.ceil(ground / pitch) * pitch; floor < cap; floor += pitch) {
        patch(panels ?? g, a, b, lo, hi, y, floor, run, wallTint, detail);
        const top = Math.min(cap, floor + (priority ? 1 : 0.85));
        patch(g, a, b, lo, hi, floor, top, run, bandTint, solid);
        y = top;
      }
    } else if (priority && prism.mat === 'facade') {
      const pitch = (style?.storey ?? STOREY) * 3;
      for (let floor = Math.ceil(ground / pitch) * pitch; floor < cap; floor += pitch) {
        patch(panels ?? g, a, b, lo, hi, y, floor, run, wallTint, detail);
        const top = Math.min(cap, floor + 0.9);
        patch(g, a, b, lo, hi, floor, top, run, bandTint, solid);
        y = top;
      }
    }
    patch(panels ?? g, a, b, lo, hi, y, cap, run, wallTint, detail);
    patch(panels ?? g, a, b, lo, hi, cap, prism.y1, run, cornice, solid);
  }
}
