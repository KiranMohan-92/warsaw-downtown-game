import * as THREE from 'three';

/**
 * Finite-colour guard for every built-in material (Basic, Lambert, Standard, Physical, …): their
 * last chunk, `dithering_fragment`, gets a NaN/Inf → 0 clamp on the output colour. One non-finite
 * pixel from any shader path (e.g. `normalize(0)`, which NVIDIA returns as NaN and Intel as 0)
 * otherwise spreads through bloom's blur and turns the whole frame black on Medium+. With the
 * guard it can at worst be a black pixel. A few ALU ops per fragment, no extra pass; installed at
 * import, before any program compiles (so it never adds a recompile after warm-up).
 */
export const NAN_GUARD_GLSL = /* glsl */ `
  {
    // Non-finite test on the bit pattern (exponent all ones), not isnan()/isinf(): the D3D
    // compiler behind ANGLE may assume IEEE-finite floats and fold isnan() away (warning X3577).
    uvec3 wdBits = floatBitsToUint( gl_FragColor.rgb ) & uvec3( 0x7fffffffu );
    bvec3 wdBad = greaterThanEqual( wdBits, uvec3( 0x7f800000u ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( 0.0 ), wdBad ); // bvec mix = select (no NaN*0)
  }
  // The composer's HalfFloat target stores anything above 65504 as +Inf (after this runs): cap
  // finite HDR highlights (a blast light on glossy glass) below it.
  gl_FragColor.rgb = min( gl_FragColor.rgb, vec3( 60000.0 ) );`;

const MARK = '// wd:nan-guard';

export function installNanGuard(): void {
  const chunk = THREE.ShaderChunk.dithering_fragment;
  if (chunk.includes(MARK)) return;
  THREE.ShaderChunk.dithering_fragment = `${chunk}\n${MARK}${NAN_GUARD_GLSL}\n`;
}

installNanGuard();
