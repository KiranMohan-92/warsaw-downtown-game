/** Physical limestone courses. Shared by the shipped material and the GPU coverage probe. */
export const PALACE_MASONRY = { width: 1.65, height: 0.55, jointX: 0.012, jointY: 0.014 } as const;

export const PALACE_STONE_TONE = { blockRange: 0.24, broadRange: 0.12 } as const;

/** Shared by the cheap all-tier stone variation and High's scanned entrance layer. */
export const PALACE_BLOCK_GLSL = /* glsl */ `
#ifndef WD_PALACE_BLOCK
#define WD_PALACE_BLOCK
float palaceBlockHash( vec2 metresUv ) {
  float row = floor( metresUv.y / ${PALACE_MASONRY.height} );
  vec2 id = vec2( floor( metresUv.x / ${PALACE_MASONRY.width} + 0.5 * mod( row, 2.0 ) ), row );
  vec3 p = fract( vec3( id.xyx ) * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
float palaceBlockPresence( vec2 footprint ) {
  return 1.0 - smoothstep( 0.12, 0.55, max( footprint.x, footprint.y ) );
}
#endif
`;

export const PALACE_MASONRY_GLSL = /* glsl */ `
${PALACE_BLOCK_GLSL}
float masonryIntegral( float x, float duty ) {
  return floor( x ) * duty + min( fract( x ), duty );
}
float masonryCoverage( float centre, float pixel, float duty ) {
  // Reduce the phase before subtracting integrals, avoiding cancellation at tall walls.
  centre = fract( centre );
  pixel = max( pixel, 1e-6 );
  float shifted = centre + 0.5 * duty;
  return clamp( ( masonryIntegral( shifted + 0.5 * pixel, duty )
    - masonryIntegral( shifted - 0.5 * pixel, duty ) ) / pixel, 0.0, 1.0 );
}
float palaceMortar( vec2 metresUv, vec2 footprint ) {
  vec2 course = vec2( ${PALACE_MASONRY.width}, ${PALACE_MASONRY.height} );
  vec2 cell = metresUv / course;
  vec2 pixel = max( footprint / course, vec2( 1e-6 ) );
  float horizontal = masonryCoverage( cell.y, pixel.y, ${PALACE_MASONRY.jointY / PALACE_MASONRY.height} );
  // Integrate the solid portion of each alternating row separately. This keeps
  // horizontal/vertical intersections exact when a pixel spans a course boundary.
  float solidRow = 0.5 - 0.5 * ${PALACE_MASONRY.jointY / PALACE_MASONRY.height};
  float evenSolid = masonryCoverage( cell.y * 0.5 - 0.25, pixel.y * 0.5, solidRow );
  float oddSolid = masonryCoverage( cell.y * 0.5 - 0.75, pixel.y * 0.5, solidRow );
  float evenJoint = masonryCoverage( cell.x, pixel.x, ${PALACE_MASONRY.jointX / PALACE_MASONRY.width} );
  float oddJoint = masonryCoverage( cell.x + 0.5, pixel.x, ${PALACE_MASONRY.jointX / PALACE_MASONRY.width} );
  return clamp( horizontal + evenSolid * evenJoint + oddSolid * oddJoint, 0.0, 1.0 );
}
`;
