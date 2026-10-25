/** Small, scene-checked Cycles entrance bake. Color is illumination, never painted albedo. */
import * as THREE from 'three';
import { lightmapSceneHash, tryBuildLightmapLayout, type MapDefinition } from '@wd/shared';
import type { WeatherId } from '../settings/settings.ts';
import { NEON_SIGNS } from './neonDistrict.ts';
import { PALACE_BAKE as manifest } from './palaceBakeManifest.ts';
import { withTimeout } from './surfaceTextures.ts';
import { architectureBudget } from './renderBudget.ts';

const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
black.needsUpdate = true;
const [x0, z0, x1, z1] = manifest.bounds;
const state = {
  texture: { value: black as THREE.Texture },
  gain: { value: 0 },
  rect: { value: new THREE.Vector4(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0)) },
};
let compatible = false;
let weatherGain = 0;
let generation = 0;
let loaded: THREE.Texture | null = null;

/** Pure projection, shared by the shader contract tests. PNG row zero is minimum world Z. */
export function courtyardUv(x: number, z: number): [number, number] {
  return [(x - x0) / (x1 - x0), (z - z0) / (z1 - z0)];
}

export function acceptsCourtyardBake(map: MapDefinition): boolean {
  if (!manifest.sceneHash || JSON.stringify(manifest.emitter) !== JSON.stringify(NEON_SIGNS[0]))
    return false;
  const layout = tryBuildLightmapLayout(map);
  return layout !== null && lightmapSceneHash(map, layout, 8) === manifest.sceneHash;
}

/** Called before map construction/warm-up. Incompatible maps retain the black fallback. */
export function setCourtyardBakeMap(map: MapDefinition): void {
  generation++;
  loaded?.dispose();
  loaded = null;
  state.texture.value = black;
  compatible = acceptsCourtyardBake(map);
  state.gain.value = 0;
}

export function setCourtyardBakeWeather(id: WeatherId, exposure: number): void {
  weatherGain = id === 'neon' ? exposure : 0;
  state.gain.value = compatible && loaded ? weatherGain : 0;
}

/** Both Low and High upload this bounded pilot before play; no mid-frame texture upload. */
export async function loadCourtyardBake(renderer: THREE.WebGLRenderer): Promise<boolean> {
  if (!compatible) return false;
  const request = generation;
  const tex = await withTimeout(
    new THREE.TextureLoader().loadAsync(
      `${import.meta.env.BASE_URL}lightmaps/palace-pilot/${manifest.file}?v=${manifest.textureHash}`,
    ),
    15_000,
    'Palace entrance illumination',
  );
  if (generation !== request) {
    tex.dispose();
    return false;
  }
  const image = tex.image as { width: number; height: number };
  if (image.width !== manifest.width || image.height !== manifest.height) {
    tex.dispose();
    throw new Error('Palace bake dimensions do not match its manifest');
  }
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  renderer.initTexture(tex);
  loaded?.dispose();
  loaded = tex;
  state.texture.value = tex;
  state.gain.value = weatherGain;
  return true;
}

// The Cycles bake is outgoing diffuse radiance for a white Lambertian receiver (E / PI).
// Restore irradiance, then let the existing material's Lambert BRDF apply the actual paving.
// Add after sky AO: its occluders were already integrated by Cycles. Do not darken it twice.
export const COURTYARD_FRAGMENT = /* glsl */ `
#ifndef TONE_MAPPING
if ( uArchitectureBudget < 0.5 ) {
if ( uCbGain > 0.0 && abs( vWetPos.y - ${manifest.receiverY.toFixed(3)} ) < 0.28 ) {
  vec3 cbNormal = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz );
  vec2 cbUv = ( vWetPos.xz - uCbRect.xy ) * uCbRect.zw;
  if ( cbNormal.y > 0.75 && all( greaterThanEqual( cbUv, vec2( 0.0 ) ) )
      && all( lessThanEqual( cbUv, vec2( 1.0 ) ) ) ) {
    vec2 cbEdge = min( cbUv, 1.0 - cbUv ) / uCbRect.zw;
    float cbFade = smoothstep( 0.0, 1.5, min( cbEdge.x, cbEdge.y ) );
    vec3 cbIrradiance = texture2D( uCbMap, cbUv ).rgb * ${(manifest.radianceScale * Math.PI).toFixed(8)};
    reflectedLight.indirectDiffuse += BRDF_Lambert( material.diffuseColor )
      * cbIrradiance * uCbGain * cbFade;
  }
}
}
#endif
`;

/** Chain after addWetness/groundDetail. Cloned material hooks retain these shared uniforms. */
export function addCourtyardBake(material: THREE.MeshStandardMaterial): void {
  if (material.userData.courtyardBake) return;
  material.userData.courtyardBake = true;
  const prev = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uArchitectureBudget = architectureBudget;
    shader.uniforms.uCbMap = state.texture;
    shader.uniforms.uCbGain = state.gain;
    shader.uniforms.uCbRect = state.rect;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
#ifndef TONE_MAPPING
#ifndef WD_ARCHITECTURE_BUDGET
#define WD_ARCHITECTURE_BUDGET
uniform float uArchitectureBudget;
#endif
uniform sampler2D uCbMap;
uniform float uCbGain;
uniform vec4 uCbRect;
#endif`,
      )
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${COURTYARD_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => `${key}|courtyard-v2`;
  material.needsUpdate = true;
}
