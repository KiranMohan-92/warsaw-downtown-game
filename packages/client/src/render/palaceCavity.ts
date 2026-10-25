const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Sky access across existing Palace relief; inset is depth divided by the relief limit. */
export function palaceReliefVisibility(axis: 'o' | 's' | 'y', sign: 1 | -1, inset: number): number {
  const shelter = axis === 'o' ? 0.25 : axis === 'y' ? (sign < 0 ? 0.64 : 0.09) : 0.55;
  return 1 - shelter * clamp01(inset);
}

/** Crown ledges shelter their undersides; vertical clock faces and spire slopes stay open. */
export function palaceOrnamentVisibility(normalY: number): number {
  return 1 - 0.28 * clamp01(-normalY);
}

/** Optical depth stays independent of the collision-safe 30 cm mesh envelope. */
export const PALACE_RELIEF_SHADE = {
  depth: 0.34,
  jamb: 0.26,
  head: 0.2,
  cavity: 0.62,
  away: 0.22,
  courseMax: 0.65,
} as const;

/** Linear luminance relative to adjacent stone; mirrored exactly by palaceRevealRatio GLSL. */
export function palaceRevealLuminanceRatio(depth: number, awayFromSun: number): number {
  return (
    1 -
    clamp01(depth / PALACE_RELIEF_SHADE.depth) *
      (PALACE_RELIEF_SHADE.cavity + PALACE_RELIEF_SHADE.away * clamp01(awayFromSun))
  );
}

/** Vertical drop = projection * tan(elevation) / cos(sun azimuth relative to the wall).
 * This is a WALL receiver, not a ground receiver (which would use inverse tan).
 */
export function palaceCourseShadowLength(
  projection: number,
  sunUp: number,
  sunFacing: number,
): number {
  if (sunUp <= 0 || sunFacing <= 0) return 0;
  return Math.min(
    PALACE_RELIEF_SHADE.courseMax,
    (Math.max(0, projection) * sunUp) / Math.max(0.12, sunFacing),
  );
}

export const PALACE_CAVITY_GLSL = /* glsl */ `
float palaceRevealRatio( float depth, float away ) {
  return 1.0 - clamp( depth / ${PALACE_RELIEF_SHADE.depth}, 0.0, 1.0 )
    * ( ${PALACE_RELIEF_SHADE.cavity} + ${PALACE_RELIEF_SHADE.away} * clamp( away, 0.0, 1.0 ) );
}
float palaceCourseDrop( float projection, float sunUp, float facing ) {
  if ( sunUp <= 0.0 || facing <= 0.0 ) return 0.0;
  return min( ${PALACE_RELIEF_SHADE.courseMax}, max( 0.0, projection ) * sunUp / max( 0.12, facing ) );
}
// Analytically box-filtered band: a subpixel course fades instead of shimmering.
float palaceBand( float p, float lo, float hi, float pixel ) {
  return clamp( ( min( p + pixel * 0.5, hi ) - max( p - pixel * 0.5, lo ) ) / pixel, 0.0, 1.0 );
}
`;
