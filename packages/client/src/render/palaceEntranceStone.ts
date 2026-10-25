import * as THREE from 'three';
import { getPalaceColumnMaps } from './palaceColumnMaterial.ts';
import { FACADE_WINDOW, STOREY } from './facadeRelief.ts';
import { PALACE_MASONRY_GLSL } from './palaceMasonry.ts';
import { architectureBudget } from './renderBudget.ts';

const MIN_X = 37;
const MAX_X = 54;
const MIN_Z = -22;
const MAX_Z = 20;
const MIN_Y = 0;
const MAX_Y = 22;
const FADE_METRES = 2;
const CACHE_KEY = 'palaceEntranceStone-v8';
const TILE_METRES = new THREE.Vector2(1.35, 2.2);

type EntranceUserData = {
  palaceEntranceStone?: boolean;
  palaceEntranceGrid?: boolean;
};

const entranceStates = new WeakMap<THREE.MeshStandardMaterial, { grid: { value: number } }>();
// Decoded linear-light mean of the shipped albedo; keep in sync with its asset manifest.
const ENTRANCE_STONE_ALBEDO_MEAN = new THREE.Vector3(
  0.7911227296112986,
  0.6858087930381822,
  0.519902574363886,
);
const ENTRANCE_STONE_MEAN_LUMA =
  0.2126 * ENTRANCE_STONE_ALBEDO_MEAN.x +
  0.7152 * ENTRANCE_STONE_ALBEDO_MEAN.y +
  0.0722 * ENTRANCE_STONE_ALBEDO_MEAN.z;

const VERTEX_PARS = /* glsl */ `
varying vec2 vEntranceUv;
varying vec3 vEntrancePos;
`;

const VERTEX = /* glsl */ `
vEntranceUv = uv;
vec4 entranceWorld = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  entranceWorld = batchingMatrix * entranceWorld;
#endif
#ifdef USE_INSTANCING
  entranceWorld = instanceMatrix * entranceWorld;
#endif
vEntrancePos = ( modelMatrix * entranceWorld ).xyz;
`;

const FRAGMENT_PARS = /* glsl */ `
#ifndef TONE_MAPPING
#ifndef WD_ARCHITECTURE_BUDGET
#define WD_ARCHITECTURE_BUDGET
uniform float uArchitectureBudget;
#endif
uniform sampler2D uEntranceStoneAlbedo;
uniform sampler2D uEntranceStoneNormal;
uniform sampler2D uEntranceStoneOrm;
uniform vec2 uEntranceStoneTile;
uniform float uEntranceStoneEnabled;
uniform float uEntranceStoneGrid;
varying vec2 vEntranceUv;
varying vec3 vEntrancePos;
float entranceLuma( vec3 c ) {
  return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
}
float entranceAxisWeight( float v, float lo, float hi ) {
  return smoothstep( lo - ${FADE_METRES.toFixed(1)}, lo, v )
    * ( 1.0 - smoothstep( hi, hi + ${FADE_METRES.toFixed(1)}, v ) );
}
float entranceStoneWeight( vec3 p ) {
  return entranceAxisWeight( p.x, ${MIN_X.toFixed(1)}, ${MAX_X.toFixed(1)} )
    * entranceAxisWeight( p.y, ${MIN_Y.toFixed(1)}, ${MAX_Y.toFixed(1)} )
    * entranceAxisWeight( p.z, ${MIN_Z.toFixed(1)}, ${MAX_Z.toFixed(1)} );
}
${PALACE_MASONRY_GLSL}
#endif
`;

const MAP_FRAGMENT = /* glsl */ `
#ifndef TONE_MAPPING
// Architectural texture layers use the existing warmed Medium/High program only.
float entranceStone = 0.0;
vec2 entranceDx = vec2( 0.0 ), entranceDy = vec2( 0.0 );
float entranceJointMask = 0.0;
float entranceBlock = 0.5;
float entranceBlockPresence = 0.0;
vec3 entranceOrm = vec3( 1.0 );
// Medium keeps the original surface albedo/normal, even beside the Palace.
// This uniform branch is coherent across the draw; no new program or texture swap.
if ( uArchitectureBudget < 0.5 ) {
  entranceStone = uEntranceStoneEnabled * ( 1.0 - uEntranceStoneGrid )
    * entranceStoneWeight( vEntrancePos );
  // Continuous metre UV derivatives precede the Palace/window mask branch.
  vec2 entranceFootprint = max( fwidth( vEntranceUv ), vec2( 1e-6 ) );
  entranceDx = dFdx( vEntranceUv / uEntranceStoneTile );
  entranceDy = dFdy( vEntranceUv / uEntranceStoneTile );
  entranceStone *= 1.0 - smoothstep( mix( 90.0, 60.0, uArchitectureBudget ),
    mix( 140.0, 100.0, uArchitectureBudget ), distance( vEntrancePos, cameraPosition ) );
  if ( entranceStone > 0.001 ) {
    entranceJointMask = palaceMortar( vEntranceUv, entranceFootprint );
    entranceBlock = palaceBlockHash( vEntranceUv );
    entranceBlockPresence = palaceBlockPresence( entranceFootprint );
    vec2 entranceTileUv = vEntranceUv / uEntranceStoneTile;
    vec3 entranceAlbedo = textureGrad( uEntranceStoneAlbedo, entranceTileUv, entranceDx, entranceDy ).rgb;
    entranceOrm = textureGrad( uEntranceStoneOrm, entranceTileUv, entranceDx, entranceDy ).rgb;
    float entranceBlockTone = mix( 1.0, mix( 0.88, 1.12, entranceBlock ), entranceBlockPresence );
    entranceAlbedo *= entranceBlockTone * ( 1.0 - 0.32 * entranceJointMask );
    // Keep the base map/material colour; Three applies the building vertex tint next.
    float entranceDetail = clamp( entranceLuma( entranceAlbedo ) / ${ENTRANCE_STONE_MEAN_LUMA.toFixed(8)}, 0.72, 1.28 );
    diffuseColor.rgb *= mix( 1.0, entranceDetail, entranceStone );
  }
}
#endif
`;

const NORMAL_FRAGMENT = /* glsl */ `
#ifndef TONE_MAPPING
if ( uArchitectureBudget < 0.5 ) {
if ( entranceStone > 0.001 ) {
  vec3 entranceBaseNormal = nonPerturbedNormal;
  vec3 entranceMapN = textureGrad( uEntranceStoneNormal, vEntranceUv / uEntranceStoneTile, entranceDx, entranceDy ).xyz * 2.0 - 1.0;
  #if defined( USE_NORMALMAP_TANGENTSPACE )
    entranceMapN.xy *= normalScale * 0.75;
    vec3 entranceDetailNormal = normalize( tbn * entranceMapN );
  #else
    vec3 entranceDetailNormal = entranceBaseNormal;
  #endif
  normal = normalize( mix( normal, entranceDetailNormal, entranceStone * 0.72 ) );
}
}
#endif
`;

const ROUGHNESS_FRAGMENT = /* glsl */ `
#ifndef TONE_MAPPING
if ( entranceStone > 0.001 ) {
  float entranceRough = clamp( entranceOrm.g
    + ( entranceBlock - 0.5 ) * 0.10 * entranceBlockPresence
    + 0.12 * entranceJointMask, 0.65, 1.0 );
  roughnessFactor = mix( roughnessFactor, max( entranceRough, 0.65 ), entranceStone );
}
#endif
`;

const AO_FRAGMENT = /* glsl */ `
#ifndef TONE_MAPPING
if ( entranceStone > 0.001 ) {
  float entrancePoreAO = entranceOrm.r;
  float entranceJointAO = 1.0 - 0.18 * entranceJointMask;
  float entranceAO = mix( 1.0, entrancePoreAO * entranceJointAO, entranceStone * 0.55 );
  reflectedLight.indirectDiffuse *= entranceAO;
  reflectedLight.indirectSpecular *= mix( 1.0, entranceAO, roughnessFactor );
}
#endif
`;

function axisWeight(v: number, lo: number, hi: number): number {
  if (v <= lo - FADE_METRES || v >= hi + FADE_METRES) return 0;
  if (v < lo) return smoothstep((v - (lo - FADE_METRES)) / FADE_METRES);
  if (v > hi) return smoothstep((hi + FADE_METRES - v) / FADE_METRES);
  return 1;
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

export function entranceStoneWeight(x: number, y: number, z: number): number {
  return axisWeight(x, MIN_X, MAX_X) * axisWeight(y, MIN_Y, MAX_Y) * axisWeight(z, MIN_Z, MAX_Z);
}

export function setPalaceEntranceGrid(mat: THREE.MeshStandardMaterial, on: boolean): void {
  const data = mat.userData as EntranceUserData;
  data.palaceEntranceGrid = on;
  const state = entranceStates.get(mat);
  if (state) state.grid.value = on ? 1 : 0;
}

export function addPalaceEntranceStone(
  mat: THREE.MeshStandardMaterial,
  { facade = false, windows = false }: { facade?: boolean; windows?: boolean } = {},
): void {
  const data = mat.userData as EntranceUserData;
  if (data.palaceEntranceStone) return;
  data.palaceEntranceStone = true;
  const state = { grid: { value: data.palaceEntranceGrid ? 1 : 0 } };
  entranceStates.set(mat, state);
  const prev = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    const maps = getPalaceColumnMaps();
    shader.uniforms.uArchitectureBudget = architectureBudget;
    shader.uniforms.uEntranceStoneAlbedo = { value: maps?.albedo ?? null };
    shader.uniforms.uEntranceStoneNormal = { value: maps?.normal ?? null };
    shader.uniforms.uEntranceStoneOrm = { value: maps?.roughness ?? null };
    shader.uniforms.uEntranceStoneTile = { value: TILE_METRES };
    shader.uniforms.uEntranceStoneEnabled = { value: maps ? 1 : 0 };
    shader.uniforms.uEntranceStoneGrid = state.grid;
    const palacePars = facade
      ? '#ifndef WD_PALACE_ATTRIBUTE\n#define WD_PALACE_ATTRIBUTE\nattribute float aPalaceStone;\n#endif\nvarying float vPalaceStone;'
      : '';
    const palaceVertex = facade ? 'vPalaceStone = aPalaceStone;' : '';
    const palaceFragment = facade
      ? '#ifndef TONE_MAPPING\nvarying float vPalaceStone;\n#endif'
      : '';
    // Painted panels retain their window pixels at medium/far LOD. The shell has no windows.
    const palaceMask = facade ? 'vPalaceStone' : '0.0';
    const wallPixels = windows
      ? `* ( 1.0 - step( ${FACADE_WINDOW.u0}, fract( vEntranceUv.x / ${STOREY} ) )
        * step( fract( vEntranceUv.x / ${STOREY} ), ${FACADE_WINDOW.u1} )
        * step( ${FACADE_WINDOW.v0}, fract( vEntranceUv.y / ${STOREY} ) )
        * step( fract( vEntranceUv.y / ${STOREY} ), ${FACADE_WINDOW.v1} ) )`
      : '';
    let mapFragment = MAP_FRAGMENT.replace(
      '* entranceStoneWeight( vEntrancePos )',
      `* max( entranceStoneWeight( vEntrancePos ), ${palaceMask} ) ${wallPixels}`,
    );
    // Facades already receive the all-tier block tone. Retain the scan's grain,
    // pores and mortar without doubling that same block hash on High.
    if (facade)
      mapFragment = mapFragment.replace(
        'entranceAlbedo *= entranceBlockTone',
        'entranceAlbedo *= mix( entranceBlockTone, 1.0, vPalaceStone )',
      );
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}\n${palacePars}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>\n${VERTEX}\n${palaceVertex}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}\n${palaceFragment}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${mapFragment}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${NORMAL_FRAGMENT}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${ROUGHNESS_FRAGMENT}`,
      )
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${AO_FRAGMENT}`);
  };
  mat.customProgramCacheKey = () => `${key}|${CACHE_KEY}|facade:${facade}|windows:${windows}`;
  mat.needsUpdate = true;
}
