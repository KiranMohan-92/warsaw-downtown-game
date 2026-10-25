/**
 * Facade weathering: what makes a stone or plaster wall read as a real, lived-in city wall —
 * splash grime and damp along the base, dirty rain streaks running down from every window sill,
 * and broad low-frequency staining so a long wall is never one flat colour. Colour-only shader
 * math on the facade material (fine stains on High; baked relief masks on every tier).
 * Streaks follow the same painted window grid as the windows (facadeRelief.ts).
 */
import type * as THREE from 'three';
import { BAY, FACADE_WINDOW, FACADE_STYLES, STOREY, WINDOW } from './facadeRelief.ts';
import { architectureBudget } from './renderBudget.ts';
import { PALACE_BLOCK_GLSL, PALACE_STONE_TONE } from './palaceMasonry.ts';
import { PALACE_CAVITY_GLSL, PALACE_RELIEF_SHADE } from './palaceCavity.ts';

const f = (n: number): string => n.toFixed(4);

// Same uniforms as Three's fragment lights, uploaded once by its existing light system.
// Face-constant work belongs here: all facade quads have authored hard normals.
const PALACE_VARYINGS = /* glsl */ `
varying vec3 vPalaceReveal;
varying vec3 vPalaceLight;
varying vec2 vPalaceTone;
`;
const VERTEX_PARS = /* glsl */ `
varying vec2 vWthUv;
varying vec3 vWthPos;
attribute float aFacadeOcclusion;
attribute float aFacadePanel;
varying float vFacadeOcclusion;
#ifndef WD_PALACE_ATTRIBUTE
#define WD_PALACE_ATTRIBUTE
attribute float aPalaceStone;
#endif
varying vec3 vFacadeStone;
${PALACE_VARYINGS}
#if NUM_DIR_LIGHTS > 0
struct DirectionalLight { vec3 direction; vec3 color; };
uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
#endif
${PALACE_CAVITY_GLSL}
`;
const VERTEX = /* glsl */ `
vWthUv = uv;
vWthPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vFacadeOcclusion = aFacadeOcclusion;
// The normal is authored in world-aligned facade geometry; tops stay clean.
vFacadeStone = vec3( aPalaceStone, max( normal.y, 0.0 ), aFacadePanel );
vec3 palaceSun = vec3( 0.0, 1.0, 0.0 );
float palaceSunStrength = 0.0;
#if NUM_DIR_LIGHTS > 0
  palaceSun = inverseTransformDirection( directionalLights[ 0 ].direction, viewMatrix );
  palaceSunStrength = smoothstep( 0.15, 2.0, max( directionalLights[ 0 ].color.r,
    max( directionalLights[ 0 ].color.g, directionalLights[ 0 ].color.b ) ) );
#endif
vec3 palaceNormal = normalize( mat3( modelMatrix ) * normal );
float palaceFacing = dot( palaceNormal, palaceSun );
float palaceAlong = dot( vec3( -palaceNormal.z, 0.0, palaceNormal.x ), palaceSun );
vPalaceReveal = vec3(
  1.0 - palaceRevealRatio( ${PALACE_RELIEF_SHADE.depth}, 0.5 - 0.5 * palaceAlong ),
  1.0 - palaceRevealRatio( ${PALACE_RELIEF_SHADE.depth}, 0.5 + 0.5 * palaceAlong ),
  1.0 - palaceRevealRatio( ${PALACE_RELIEF_SHADE.depth}, step( 0.0, palaceSun.y ) ) );
float palaceSide = clamp( ( 0.82 - aFacadeOcclusion ) * 4.0, 0.0, 1.0 );
vPalaceLight = vec3(
  palaceCourseDrop( ${f(FACADE_STYLES.monumental.course.o - FACADE_STYLES.monumental.field)}, palaceSun.y, palaceFacing ),
  smoothstep( 0.0, 0.3, palaceFacing ) * palaceSunStrength,
  1.0 - 0.76 * palaceSide * ( 0.55 + 0.45 * ( 1.0 - max( 0.0, palaceFacing ) ) ) * ( 1.0 - vFacadeStone.y ) );
// Only face-constant top brightness and the broad distant fade interpolate.
// Low omits base damp: flat LOD panels can span six storeys, smearing a short dirt mask.
vPalaceTone = vec2(
  1.0 + 0.08 * vFacadeStone.y,
  aPalaceStone * ( 1.0 - smoothstep( 180.0, 320.0, distance( vWthPos, cameraPosition ) ) ) );
`;
const FRAGMENT_PARS = /* glsl */ `
varying vec2 vWthUv;
varying vec3 vWthPos;
varying float vFacadeOcclusion;
varying vec3 vFacadeStone;
${PALACE_VARYINGS}
${PALACE_BLOCK_GLSL}
${PALACE_CAVITY_GLSL}
vec3 palaceStoneTone( vec3 albedo, vec2 footprint, vec2 cell, float weight ) {
  float fine = palaceBlockPresence( footprint );
  float block = palaceBlockHash( vWthUv ) - 0.5;
  float tone = 1.0 + block * ${PALACE_STONE_TONE.blockRange} * fine;
#ifndef TONE_MAPPING
  // HDR keeps paired courses and mineral/streak detail; Low has one hash only.
  float broad = palaceBlockPresence( footprint * 0.5 );
  tone += ( palaceBlockHash( vWthUv * 0.5 ) - 0.5 ) * ${PALACE_STONE_TONE.broadRange} * broad;
  float wall = 1.0 - vFacadeStone.y;
  float base = 1.0 - smoothstep( 0.0, 2.4, vWthPos.y );
  float underCourse = palaceBand( cell.y, ${f(FACADE_STYLES.monumental.course.y0 - 0.18)},
    ${f(FACADE_STYLES.monumental.course.y0)}, footprint.y ) * vFacadeStone.z;
  float belowSill = ${f(WINDOW.y0)} - cell.y;
  float streakColumns = max(
    palaceBand( cell.x, ${f(WINDOW.s0)}, ${f(WINDOW.s0 + 0.18)}, footprint.x ),
    palaceBand( cell.x, ${f(WINDOW.s1 - 0.18)}, ${f(WINDOW.s1)}, footprint.x ) );
  float streak = streakColumns * step( 0.0, belowSill )
    * ( 1.0 - smoothstep( 0.0, 0.85, belowSill ) ) * vFacadeStone.z * fine;
  tone *= 1.0 - wall * ( 0.28 * base + 0.18 * underCourse + 0.24 * streak );
  tone *= 1.0 + 0.08 * vFacadeStone.y;
  vec3 mineral = vec3( 1.0 ) + block * fine * vec3( 0.045, 0.0, -0.045 );
  return albedo * mix( vec3( 1.0 ), tone * mineral, weight );
#else
  return albedo * mix( 1.0, tone * vPalaceTone.x, weight );
#endif
}
// x: cavity visibility on all illumination, y: additional directional course shadow.
// Fixed bands reuse R/B/A from the existing roughness fetch; G remains roughness.
vec2 palaceReliefShade( vec2 cell, float pixel, vec3 masks ) {
  float jamb = mix( vPalaceReveal.x, vPalaceReveal.y, step( ${f(BAY * 0.5)}, cell.x ) );
  float cavity = vPalaceLight.z * ( 1.0 - max( masks.x * jamb, masks.y * vPalaceReveal.z ) * vFacadeStone.z );
  // This is the only dynamic band: its length follows the sun, including grazing light.
  float belowCourse = mod( ${f(FACADE_STYLES.monumental.course.y0)} - cell.y + 0.5 * pixel,
    ${f(STOREY)} ) - 0.5 * pixel;
  float course = palaceBand( belowCourse, 0.0, vPalaceLight.x, pixel ) * vPalaceLight.y * vFacadeStone.z;
  float direct = 1.0 - 0.92 * course;
  cavity *= ( 1.0 - 0.28 * course ) * ( 1.0 + 0.18 * masks.z * vPalaceLight.y * vFacadeStone.z );
  return mix( vec2( 1.0 ), vec2( cavity, direct ), vPalaceTone.y );
}
#ifndef TONE_MAPPING
#ifndef WD_ARCHITECTURE_BUDGET
#define WD_ARCHITECTURE_BUDGET
uniform float uArchitectureBudget;
#endif
// Sine-free hash (Hoskins): far cheaper than fract(sin()) on integrated GPUs.
float wthHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float wthNoise( vec2 p ) {
  vec2 i = floor( p ), u = fract( p );
  u = u * u * ( 3.0 - 2.0 * u );
  return mix( mix( wthHash( i ), wthHash( i + vec2( 1, 0 ) ), u.x ),
    mix( wthHash( i + vec2( 0, 1 ) ), wthHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
vec3 weather( vec3 albedo ) {
  // Metres covered by a screen pixel: a five-metre stain remains visible across the Market,
  // while centimetre streak breakup must disappear before it becomes flickering noise.
  // Derivatives precede divergent branches so grazing/edge pixels remain well defined.
  vec2 fw = fwidth( vWthUv );
  float footprint = max( fw.x, fw.y );
  float near = 1.0 - smoothstep( mix( 90.0, 60.0, uArchitectureBudget ),
    mix( 140.0, 100.0, uArchitectureBudget ), distance( vWthPos, cameraPosition ) );
  near *= 1.0 - vFacadeStone.x * vFacadeStone.y;
  if ( near <= 0.0 ) return albedo;
  float macro = 1.0 - smoothstep( 2.0, 5.0, footprint );
  float sillDetail = 1.0 - smoothstep( 0.12, 0.5, footprint );
  float fine = 1.0 - smoothstep( 0.025, 0.08, footprint );
  fine *= 1.0 - uArchitectureBudget;
  float y = vWthPos.y;
  // Broad staining (metres-scale), keeps long walls from reading as one flat colour.
  float stain = mix( 0.5, wthNoise( vWthUv * vec2( 0.19, 0.12 ) ), macro );
  float k = 0.86 + 0.24 * stain;
  // Base: splash grime and damp in the first metre and a half above the street.
  float base = 1.0 - smoothstep( 0.0, 1.6, y );
  base *= 0.75 + 0.5 * stain;
  k *= 1.0 - 0.3 * base;
  // Rain streaks: from each window sill down the bay, fading over ~2 m, broken up.
  vec2 bay = vec2( ${f(BAY)}, ${f(STOREY)} );
  vec2 cell = floor( vWthUv / bay );
  vec2 inBay = vWthUv / bay - cell;
  float under = ${f(FACADE_WINDOW.v0)} - inBay.y; // storey fraction below the sill
  float across = ( inBay.x - ${f(FACADE_WINDOW.u0)} ) / ${f(FACADE_WINDOW.u1 - FACADE_WINDOW.u0)};
  float streak = 0.0;
  if ( sillDetail > 0.0 && under > 0.0 && across > -0.05 && across < 1.05 ) {
    float cols = wthNoise( vec2( vWthUv.x * 1.2, cell.y * 3.1 ) );
    if ( fine > 0.0 ) cols = mix( cols,
      wthNoise( vec2( vWthUv.x * 9.0, cell.y * 3.1 ) ), fine );
    float len = 0.35 + 0.5 * wthHash( cell );
    streak = smoothstep( 0.35, 0.8, cols ) * ( 1.0 - smoothstep( 0.0, len, under ) );
    float breakup = 0.8;
    if ( fine > 0.0 ) breakup = mix( breakup,
      0.6 + 0.4 * wthHash( vec2( floor( vWthUv.x * 30.0 ), cell.y ) ), fine );
    streak *= breakup * sillDetail;
  }
  k *= 1.0 - 0.22 * streak;
  // Dirt changes value, not hue: keep the facade palette/vertex tint intact.
  vec3 dirt = albedo * 0.58;
  vec3 weathered = mix( albedo * k, dirt, 0.35 * max( base, streak ) );
  return mix( albedo, weathered, near );
}
#endif
`;

/** Patch a facade material with weathering. Idempotent; before its first compile. */
export function addFacadeWeathering(
  mat: THREE.MeshStandardMaterial,
  { windows = false }: { windows?: boolean } = {},
): void {
  if (mat.userData.facadeWeathering) return;
  mat.userData.facadeWeathering = true;
  const prev = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uArchitectureBudget = architectureBudget;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
// Continuous derivatives before classification/window branches, on both LOD materials.
vec2 stoneFootprint = max( fwidth( vWthUv ), vec2( 1e-6 ) );
vec2 stoneCell = mod( vWthUv, vec2( ${f(BAY)}, ${f(STOREY)} ) );
float stoneWeight = vPalaceTone.y;
${
  windows
    ? `vec2 stoneBay = stoneCell / vec2( ${f(BAY)}, ${f(STOREY)} );
float stoneWindow = step( ${f(FACADE_WINDOW.u0)}, stoneBay.x ) * step( stoneBay.x, ${f(FACADE_WINDOW.u1)} )
  * step( ${f(FACADE_WINDOW.v0)}, stoneBay.y ) * step( stoneBay.y, ${f(FACADE_WINDOW.v1)} );
stoneWeight *= 1.0 - stoneWindow;`
    : ''
}
// The building tag is constant over each primitive; no per-window divergent branch.
if ( vFacadeStone.x > 0.0 )
  diffuseColor.rgb = palaceStoneTone( diffuseColor.rgb, stoneFootprint, stoneCell, stoneWeight );
#ifndef TONE_MAPPING
if ( uArchitectureBudget < 0.5 ) {
  diffuseColor.rgb = weather( diffuseColor.rgb );
}
#endif`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        // Cavity visibility affects indirect light, preserving direct sun and shadows.
        float facadeAO = clamp( vFacadeOcclusion, 0.35, 1.0 );
        #ifdef TONE_MAPPING
        facadeAO = mix( 1.0, facadeAO, vFacadeStone.x );
        #endif
        reflectedLight.indirectDiffuse *= facadeAO;
        #ifndef TONE_MAPPING
        #if defined( USE_ENVMAP ) && defined( STANDARD )
          reflectedLight.indirectSpecular *= computeSpecularOcclusion(
            saturate( dot( geometryNormal, geometryViewDir ) ), facadeAO, material.roughness );
        #endif
        #endif
        // Coherent building classification keeps the extra work off ordinary OSM facades.
        if ( vFacadeStone.x > 0.0 ) {
        vec3 palaceMasks = vec3( 0.0 );
        #ifdef USE_ROUGHNESSMAP
          palaceMasks = texelRoughness.rba;
        #endif
        vec2 palaceShade = palaceReliefShade( stoneCell, stoneFootprint.y, palaceMasks );
        reflectedLight.directDiffuse *= palaceShade.x * palaceShade.y;
        reflectedLight.directSpecular *= palaceShade.x * palaceShade.y;
        reflectedLight.indirectDiffuse *= palaceShade.x;
        reflectedLight.indirectSpecular *= palaceShade.x;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `${key}|weathered|palace-depth-v8|windows:${windows}`;
  mat.needsUpdate = true;
}
