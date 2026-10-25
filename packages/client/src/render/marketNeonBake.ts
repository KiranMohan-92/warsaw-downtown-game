/** Scene-bound Cycles light for the night-market ground. Assets contain illumination only. */
import * as THREE from 'three';
import { lightmapSceneHash, tryBuildLightmapLayout, type MapDefinition } from '@wd/shared';
import type { WeatherId } from '../settings/settings.ts';
import { NEON_SIGNS } from './neonDistrict.ts';
import { MARKET_NEON_BAKE as bake } from './marketNeonBakeManifest.ts';
import { withTimeout } from './surfaceTextures.ts';

const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
black.needsUpdate = true;
const [x0, z0, x1, z1] = bake.bounds;
const state = {
  map: { value: black as THREE.Texture },
  gain: { value: 0 },
  rect: { value: new THREE.Vector4(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0)) },
};
let compatible = false;
let weatherGain = 0;
let request = 0;
let loaded: THREE.Texture | null = null;

export function marketNeonUv(x: number, z: number): [number, number] {
  return [(x - x0) / (x1 - x0), (z - z0) / (z1 - z0)];
}

export function acceptsMarketNeonBake(map: MapDefinition): boolean {
  // A map too large for an atlas has no bake (it loads unbaked instead of failing).
  const layout = tryBuildLightmapLayout(map);
  if (!layout) return false;
  const signs = NEON_SIGNS.filter((sign) => {
    const dx = Math.max(x0 - sign.x, 0, sign.x - x1);
    const dz = Math.max(z0 - sign.z, 0, sign.z - z1);
    return Math.hypot(dx, dz) <= 16 + sign.w * 0.5;
  });
  return (
    layout.hash === bake.layoutHash &&
    lightmapSceneHash(map, layout, 8) === bake.sceneHash &&
    signs.length === bake.emitters.length &&
    bake.emitters.every((emitter) =>
      signs.some((sign) =>
        Object.entries(sign).every(
          ([key, value]) => (emitter as unknown as Record<string, unknown>)[key] === value,
        ),
      ),
    )
  );
}

export function setMarketNeonBakeMap(map: MapDefinition): void {
  request++;
  loaded?.dispose();
  loaded = null;
  state.map.value = black;
  state.gain.value = 0;
  compatible = acceptsMarketNeonBake(map);
}

/** Exposure is folded into lights by WeatherSystem, rather than applied a second time in post. */
export function setMarketNeonBakeWeather(id: WeatherId, exposure: number): void {
  weatherGain = id === 'neon' ? exposure : 0;
  state.gain.value = compatible && loaded ? weatherGain : 0;
}

export async function loadMarketNeonBake(renderer: THREE.WebGLRenderer): Promise<boolean> {
  if (!compatible) return false;
  const token = ++request;
  let texture: THREE.Texture;
  try {
    texture = await withTimeout(
      new THREE.TextureLoader()
        .loadAsync(
          `${import.meta.env.BASE_URL}lightmaps/market-neon-pilot/${bake.file}?v=${bake.textureHash}`,
        )
        .then((tex) => {
          if (token !== request) tex.dispose();
          return tex;
        }),
      15_000,
      'Night-market illumination',
    );
  } catch (error) {
    if (token === request) request++; // late completion releases its GPU allocation
    throw error;
  }
  if (token !== request) return false;
  const image = texture.image as { width: number; height: number };
  if (image.width !== bake.width || image.height !== bake.height) {
    texture.dispose();
    throw new Error('Market bake dimensions do not match its manifest');
  }
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
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

export const MARKET_NEON_FRAGMENT = /* glsl */ `
if ( uMnGain > 0.0 && abs( vWetPos.y - ${bake.receiverY.toFixed(3)} ) < 0.12 ) {
  vec3 mnNormal = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz );
  vec2 mnUv = ( vWetPos.xz - uMnRect.xy ) * uMnRect.zw;
  if ( mnNormal.y > 0.75 && all( greaterThanEqual( mnUv, vec2( 0.0 ) ) )
      && all( lessThanEqual( mnUv, vec2( 1.0 ) ) ) ) {
    vec2 mnEdge = min( mnUv, 1.0 - mnUv ) / uMnRect.zw;
    float mnFade = smoothstep( 0.0, 1.0, min( mnEdge.x, mnEdge.y ) );
    vec3 mnIrradiance = texture2D( uMnMap, mnUv ).rgb * ${(bake.radianceScale * Math.PI).toFixed(8)};
    reflectedLight.indirectDiffuse += BRDF_Lambert( material.diffuseColor )
      * mnIrradiance * uMnGain * mnFade;
  }
}
`;

/** Chain after wetness/paving and AO: Cycles has already integrated its own occluders. */
export function addMarketNeonBake(material: THREE.MeshStandardMaterial): void {
  if (material.userData.marketNeonBake) return;
  material.userData.marketNeonBake = true;
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uMnMap = state.map;
    shader.uniforms.uMnGain = state.gain;
    shader.uniforms.uMnRect = state.rect;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uMnMap;\nuniform float uMnGain;\nuniform vec4 uMnRect;',
      )
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${MARKET_NEON_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => `${key}|market-neon-v1`;
  material.needsUpdate = true;
}
