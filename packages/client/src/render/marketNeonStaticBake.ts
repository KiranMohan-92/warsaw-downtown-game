/** Scene-bound colored light on static box faces, using the map's existing UV1 atlas. */
import * as THREE from 'three';
import {
  lightmapSceneHash,
  tryBuildLightmapLayout,
  type MapDefinition,
  type MaterialId,
} from '@wd/shared';
import type { WeatherId } from '../settings/settings.ts';
import { NEON_SIGNS } from './neonDistrict.ts';
import { MARKET_NEON_STATIC_BAKE as bake } from './marketNeonStaticManifest.ts';
import { withTimeout } from './surfaceTextures.ts';

const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
black.needsUpdate = true;
const state = { map: { value: black as THREE.Texture }, gain: { value: 0 } };
let compatible = false;
let weatherGain = 0;
let request = 0;
let loaded: THREE.Texture | null = null;

export function acceptsMarketNeonStaticBake(map: MapDefinition): boolean {
  // A map too large for an atlas has no bake (it loads unbaked instead of failing).
  const layout = tryBuildLightmapLayout(map);
  if (!layout) return false;
  return (
    layout.hash === bake.layoutHash &&
    lightmapSceneHash(map, layout, 8) === bake.sceneHash &&
    layout.atlas.width === bake.width &&
    layout.atlas.height === bake.height &&
    bake.width * bake.height * 4 <= 32 * 1024 * 1024 &&
    bake.emitters.every((emitter) =>
      NEON_SIGNS.some((sign) =>
        Object.entries(sign).every(
          ([key, value]) => (emitter as unknown as Record<string, unknown>)[key] === value,
        ),
      ),
    )
  );
}

/** Detailed props/dressing have unrelated UVs; only selected static map surfaces are eligible. */
export function marketNeonStaticMaterial(id: MaterialId): boolean {
  return (bake.receiverMaterials as readonly string[]).includes(id);
}

export function setMarketNeonStaticBakeMap(map: MapDefinition): void {
  request++;
  loaded?.dispose();
  loaded = null;
  state.map.value = black;
  state.gain.value = 0;
  compatible = acceptsMarketNeonStaticBake(map);
}

export function setMarketNeonStaticBakeWeather(id: WeatherId, exposure: number): void {
  weatherGain = id === 'neon' && Number.isFinite(exposure) ? Math.max(0, exposure) : 0;
  state.gain.value = compatible && loaded ? weatherGain : 0;
}

/** Decode and upload at loading time; failures/late results keep the shared black fallback. */
export async function loadMarketNeonStaticBake(renderer: THREE.WebGLRenderer): Promise<boolean> {
  if (!compatible) return false;
  const token = ++request;
  state.gain.value = 0;
  let texture: THREE.Texture;
  try {
    texture = await withTimeout(
      new THREE.TextureLoader()
        .loadAsync(
          `${import.meta.env.BASE_URL}lightmaps/market-neon-static/${bake.file}?v=${bake.textureHash}`,
        )
        .then((tex) => {
          if (token !== request) tex.dispose();
          return tex;
        }),
      15_000,
      'Night-market surface illumination',
    );
  } catch (error) {
    if (token === request) request++;
    throw error;
  }
  if (token !== request) return false;
  const image = texture.image as { width: number; height: number };
  if (image.width !== bake.width || image.height !== bake.height) {
    texture.dispose();
    throw new Error('Market surface bake dimensions do not match its atlas');
  }
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  // One-texel gutters cannot survive mip reduction; preserve the existing atlas's filtering.
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  try {
    renderer.initTexture(texture);
  } catch (error) {
    texture.dispose();
    throw error;
  }
  loaded?.dispose();
  loaded = texture;
  state.map.value = texture;
  state.gain.value = weatherGain;
  return true;
}

export const MARKET_NEON_STATIC_FRAGMENT = /* glsl */ `
#if defined( USE_AOMAP ) && !defined( TONE_MAPPING )
if ( uMnsGain > 0.0 ) {
  vec3 mnsIrradiance = texture2D( uMnsMap, vAoMapUv ).rgb * ${(bake.radianceScale * Math.PI).toFixed(8)};
  reflectedLight.indirectDiffuse += BRDF_Lambert( material.diffuseColor ) * mnsIrradiance * uMnsGain;
}
#endif
`;

/** Called only for compatible static atlas variants; AO/lamp/wetness hooks remain chained. */
export function addMarketNeonStaticBake(material: THREE.MeshStandardMaterial): void {
  if (material.userData.marketNeonStaticBake) return;
  material.userData.marketNeonStaticBake = true;
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uMnsMap = state.map;
    shader.uniforms.uMnsGain = state.gain;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uMnsMap;\nuniform float uMnsGain;',
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>\n${MARKET_NEON_STATIC_FRAGMENT}`,
      );
  };
  material.customProgramCacheKey = () => `${key}|market-neon-static-v1`;
  material.needsUpdate = true;
}
