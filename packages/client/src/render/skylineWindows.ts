/** Far facade shading: no room rays, texture reads, lights or per-frame work. */
import * as THREE from 'three';
import type { WeatherId } from '../settings/settings.ts';

export const SKYLINE_LIGHTS: Record<WeatherId, { occupied: number; intensity: number }> = {
  sunny: { occupied: 0.012, intensity: 0.22 },
  overcast: { occupied: 0.035, intensity: 0.32 },
  rain: { occupied: 0.065, intensity: 0.45 },
  golden: { occupied: 0.055, intensity: 0.65 },
  dusk: { occupied: 0.28, intensity: 1.25 },
  neon: { occupied: 0.46, intensity: 1.8 },
};
export const skylineLights = {
  occupied: { value: SKYLINE_LIGHTS.golden.occupied },
  intensity: { value: SKYLINE_LIGHTS.golden.intensity },
};

/** Called only on weather changes; every tier shares the same warmed program recipe. */
export function setSkylineWeather(id: WeatherId, exposure: number): void {
  skylineLights.occupied.value = SKYLINE_LIGHTS[id].occupied;
  skylineLights.intensity.value = SKYLINE_LIGHTS[id].intensity * exposure;
}

/** Box-filtered periodic opening; mirrors skylineOpening in GLSL. */
export function skylineWindowCoverage(
  center: number,
  width: number,
  lo: number,
  hi: number,
): number {
  const integral = (x: number): number =>
    Math.floor(x) * (hi - lo) + Math.min(hi - lo, Math.max(0, x - Math.floor(x) - lo));
  const footprint = Math.max(width, 1e-4);
  return Math.min(
    1,
    Math.max(
      0,
      (integral(center + footprint * 0.5) - integral(center - footprint * 0.5)) / footprint,
    ),
  );
}

const HAZE_NEAR = 160;
const HAZE_MIDDLE = 420;
const HAZE_FAR = 850;
export function skylineHaze(distance: number): number {
  return (
    0.04 * THREE.MathUtils.smoothstep(distance, HAZE_NEAR, HAZE_MIDDLE) +
    0.08 * THREE.MathUtils.smoothstep(distance, HAZE_MIDDLE, HAZE_FAR)
  );
}

const PARS = /* glsl */ `
varying vec2 vSkylineUv;
varying vec4 vSkyline;
uniform float uSkylineOccupied;
uniform float uSkylineIntensity;
float skylinePane = 0.0;
float skylineRoughness = 0.8;
vec3 skylineEmission = vec3( 0.0 );
float skylineIntegral( float x, float lo, float hi ) {
  return floor( x ) * ( hi - lo ) + clamp( fract( x ) - lo, 0.0, hi - lo );
}
float skylineOpening( float x, float width, float lo, float hi ) {
  return clamp( ( skylineIntegral( x + width * 0.5, lo, hi )
    - skylineIntegral( x - width * 0.5, lo, hi ) ) / width, 0.0, 1.0 );
}
vec3 skylineRoom( vec2 cell, float seed ) {
  vec3 p = fract( vec3( cell, seed ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yzz ) * p.zyx );
}
`;
const WINDOWS = /* glsl */ `
// Derivatives are evaluated outside the surface branch, including solid roof triangles.
vec2 skylineCell = vSkylineUv / max( vSkyline.xy, vec2( 1.0 ) );
vec2 skylineFootprint = max( fwidth( skylineCell ), vec2( 0.0001 ) );
if ( vSkyline.w > 0.5 ) {
  bool skylinePunched = vSkyline.w > 2.5 && vSkyline.w < 3.5;
  bool skylineRibbon = vSkyline.w > 3.5;
  vec2 lo = skylinePunched ? vec2( 0.22, 0.22 ) : vec2( 0.045, 0.16 );
  vec2 hi = skylinePunched ? vec2( 0.78, 0.86 ) : vec2( 0.955, 0.9 );
  if ( skylineRibbon ) lo.y = 0.4;
  skylinePane = skylineOpening( skylineCell.x, skylineFootprint.x, lo.x, hi.x )
    * skylineOpening( skylineCell.y, skylineFootprint.y, lo.y, hi.y );
  // Average unresolved rooms instead of flickering random lights as the camera moves.
  float resolved = 1.0 - smoothstep( 0.35, 1.25, max( skylineFootprint.x, skylineFootprint.y ) );
  vec3 room = skylineRoom( floor( skylineCell ), vSkyline.z );
  vec3 tones = mix( vec3( 0.48, 0.62, 0.68 ), vec3( 0.76, 0.65, 0.49 ), room.y );
  vec3 paneColour = diffuseColor.rgb * mix( vec3( 0.56, 0.6, 0.63 ), tones, resolved )
    * mix( 0.65, 0.38 + room.x * 0.54, resolved );
  vec3 frameColour = diffuseColor.rgb * ( skylinePunched || skylineRibbon ? 0.9 : 0.42 );
  diffuseColor.rgb = mix( frameColour, paneColour, skylinePane );
  skylineRoughness = mix( 0.8, vSkyline.w > 1.5 ? 0.38 : 0.22, skylinePane );
  float occupied = mix( uSkylineOccupied, 1.0 - step( uSkylineOccupied, room.z ), resolved );
  vec3 lamp = mix( vec3( 1.0, 0.64, 0.32 ), vec3( 0.66, 0.8, 1.0 ), step( 0.72, room.y ) );
  lamp = mix( vec3( 0.905, 0.685, 0.51 ), lamp, resolved );
  skylineEmission = lamp * occupied * uSkylineIntensity * skylinePane;
}
`;

/** One shader for concrete, glass, satin glass and roofs: identity is in vertex attributes. */
export function addSkylineWindows(material: THREE.MeshStandardMaterial): void {
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uSkylineOccupied = skylineLights.occupied;
    shader.uniforms.uSkylineIntensity = skylineLights.intensity;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute vec4 aSkyline;\nvarying vec4 vSkyline;\nvarying vec2 vSkylineUv;`,
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSkyline = aSkyline;\nvSkylineUv = uv;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${WINDOWS}`)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = skylineRoughness;',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = skylinePane * 0.12;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skylineEmission;',
      )
      .replace(
        '#include <fog_fragment>',
        THREE.ShaderChunk.fog_fragment.replace(
          'gl_FragColor.rgb = mix(',
          `fogFactor = 1.0 - ( 1.0 - fogFactor ) * ( 1.0
          - 0.04 * smoothstep( ${HAZE_NEAR.toFixed(1)}, ${HAZE_MIDDLE.toFixed(1)}, vFogDepth )
          - 0.08 * smoothstep( ${HAZE_MIDDLE.toFixed(1)}, ${HAZE_FAR.toFixed(1)}, vFogDepth ) );
        gl_FragColor.rgb = mix(`,
        ),
      );
  };
  material.customProgramCacheKey = () => `${key}|skyline-windows-v1`;
}
