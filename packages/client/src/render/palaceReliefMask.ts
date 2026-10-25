import { BAY, FACADE_STYLES, STOREY, WINDOW } from './facadeRelief.ts';
import { PALACE_RELIEF_SHADE } from './palaceCavity.ts';

/** Analytic coverage of a band within one texel, expressed around its centre. */
function band(p: number, lo: number, hi: number, pixel: number): number {
  const half = pixel * 0.5;
  return Math.min(1, Math.max(0, (Math.min(half, hi - p) - Math.max(-half, lo - p)) / pixel));
}

/**
 * Fixed Palace masks in one normalized facade tile: jambs, window head, course/sill tops.
 * Baked at texel centres into roughness R/B/A; G stays roughness. The texture's existing
 * linear/mipmap filtering preserves these thin bands without fragment-side grid/mask work.
 */
export function palaceReliefMask(
  u: number,
  v: number,
  texelWidth = 1 / 512,
): readonly [number, number, number] {
  const x = u * BAY;
  const y = v * STOREY;
  const pixelX = texelWidth * BAY;
  const pixelY = texelWidth * STOREY;
  const { jamb, head } = PALACE_RELIEF_SHADE;
  const jambs =
    Math.max(
      band(x, WINDOW.s0 - jamb, WINDOW.s0, pixelX),
      band(x, WINDOW.s1, WINDOW.s1 + jamb, pixelX),
    ) * band(y, WINDOW.y0, WINDOW.y1, pixelY);
  const windowHead =
    band(y, WINDOW.y1, WINDOW.y1 + head, pixelY) *
    band(x, WINDOW.s0 - jamb, WINDOW.s1 + jamb, pixelX);
  const course = FACADE_STYLES.monumental.course;
  const ledge = Math.max(
    band(y, course.y1 - 0.07, course.y1, pixelY),
    band(y, WINDOW.y0 - 0.08, WINDOW.y0, pixelY) * band(x, WINDOW.s0, WINDOW.s1, pixelX),
  );
  return [jambs, windowHead, ledge];
}
