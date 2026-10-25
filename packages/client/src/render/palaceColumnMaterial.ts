import * as THREE from 'three';
import type { MapMaterials } from './materials.ts';
import { architectureBudget } from './renderBudget.ts';

const TEXTURE_DIR = 'tex/palace-columns-v2';
const PREFIX = 'stone';
const TILE_METRES = 1.35;

type ColumnMaterialUserData = {
  keepNormalOnLow?: boolean;
  preserveFacadeShellMaps?: boolean;
  palacePilotTextures?: boolean;
  palacePilotLoading?: boolean;
};

type PalaceColumnMaps = {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
};

let cachedMaps: PalaceColumnMaps | null = null;
let pendingMaps: Promise<boolean> | null = null;
const materialsUsingPilot = new Set<THREE.MeshStandardMaterial>();

/** Share the preloaded stone set with the entrance; no texture copies or extra downloads. */
export function getPalaceColumnMaps(): Readonly<PalaceColumnMaps> | null {
  return cachedMaps;
}

function baseUrl(): string {
  const meta = import.meta as unknown as { env?: { BASE_URL?: string } };
  return meta.env?.BASE_URL ?? '/';
}

function textureUrl(name: string, root = baseUrl()): string {
  return `${root}${root.endsWith('/') ? '' : '/'}${TEXTURE_DIR}/${PREFIX}_${name}.webp`;
}

function setupTexture(t: THREE.Texture, srgb: boolean): THREE.Texture {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / TILE_METRES, 1 / 2.2);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export function palaceColumnMaterial(
  materials: MapMaterials,
  _options: { loader?: THREE.TextureLoader; root?: string } = {},
): THREE.MeshStandardMaterial {
  const mat = materials.facadeShellVariant('palace-portico-columns', (m) => {
    m.userData.keepNormalOnLow = true;
    m.normalScale.set(0.85, 0.85);
    m.roughness = 1;
    m.metalness = 0;
    m.aoMapIntensity = 0.65;
    const previousHook = m.onBeforeCompile.bind(m);
    const previousKey = m.customProgramCacheKey();
    m.onBeforeCompile = (shader, renderer) => {
      previousHook(shader, renderer);
      shader.uniforms.uArchitectureBudget = architectureBudget;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float columnOcclusion;\nvarying float vColumnOcclusion;',
        )
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvColumnOcclusion = columnOcclusion;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
#ifndef TONE_MAPPING
#ifndef WD_ARCHITECTURE_BUDGET
#define WD_ARCHITECTURE_BUDGET
uniform float uArchitectureBudget;
#endif
varying float vColumnOcclusion;
#endif`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#ifndef TONE_MAPPING
float roughnessFactor = roughness;
if ( uArchitectureBudget < 0.5 ) {
${THREE.ShaderChunk.roughnessmap_fragment.replace('float roughnessFactor = roughness;', '')}
}
#else
#include <roughnessmap_fragment>
#endif`,
        )
        .replace(
          '#include <aomap_fragment>',
          `#ifndef TONE_MAPPING
if ( uArchitectureBudget < 0.5 ) {
  #include <aomap_fragment>
}
reflectedLight.indirectDiffuse *= vColumnOcclusion;
reflectedLight.indirectSpecular *= mix(1.0, vColumnOcclusion, roughnessFactor);
#endif`,
        );
    };
    m.customProgramCacheKey = () => `${previousKey}|column-crevice-v3`;
  });
  const data = mat.userData as ColumnMaterialUserData;
  data.preserveFacadeShellMaps = true;
  if (!materialsUsingPilot.has(mat)) {
    materialsUsingPilot.add(mat);
    mat.addEventListener('dispose', () => materialsUsingPilot.delete(mat));
  }
  if (cachedMaps && !data.palacePilotTextures) {
    applyPalaceColumnMaps(mat, cachedMaps);
  }
  return mat;
}

export function loadPalaceColumnTextures(
  renderer?: THREE.WebGLRenderer,
  scene?: THREE.Scene,
  {
    loader = new THREE.TextureLoader(),
    root = baseUrl(),
    timeoutMs = 20_000,
  }: { loader?: THREE.TextureLoader; root?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  if (scene && !scene.getObjectByName('palace-columns')) return Promise.resolve(false);
  if (cachedMaps) {
    initPalaceColumnTextures(renderer, cachedMaps);
    applyMapsToKnownMaterials(cachedMaps);
    return Promise.resolve(true);
  }
  pendingMaps ??= Promise.all([
    withTimeout(
      loader.loadAsync(textureUrl('albedo', root)),
      timeoutMs,
      'palace column albedo',
    ).then((t) => setupTexture(t, true)),
    withTimeout(
      loader.loadAsync(textureUrl('normal', root)),
      timeoutMs,
      'palace column normal',
    ).then((t) => setupTexture(t, false)),
    withTimeout(
      loader.loadAsync(textureUrl('orm', root)),
      timeoutMs,
      'palace column roughness',
    ).then((t) => setupTexture(t, false)),
  ])
    .then(([albedo, normal, roughness]) => {
      cachedMaps = { albedo, normal, roughness };
      initPalaceColumnTextures(renderer, cachedMaps);
      applyMapsToKnownMaterials(cachedMaps);
      return true;
    })
    .catch(() => {
      for (const mat of materialsUsingPilot) {
        mat.userData.palacePilotLoading = false;
        mat.userData.palacePilotTextures = false;
      }
      return false;
    });
  return pendingMaps;
}

export function resetPalaceColumnTextureCacheForTests(): void {
  cachedMaps = null;
  pendingMaps = null;
  materialsUsingPilot.clear();
}

/** Restore the pilot after toggling the level-design grid; never touches unbaked materials. */
export function restorePalaceColumnMaps(mat: THREE.MeshStandardMaterial): boolean {
  if (!cachedMaps || !mat.userData.preserveFacadeShellMaps) return false;
  applyPalaceColumnMaps(mat, cachedMaps);
  return true;
}

function applyPalaceColumnMaps(mat: THREE.MeshStandardMaterial, maps: PalaceColumnMaps): void {
  mat.map = maps.albedo;
  mat.normalMap = maps.normal;
  mat.roughnessMap = maps.roughness;
  mat.aoMap = maps.roughness;
  mat.color.set('#ffffff');
  mat.userData.keepNormalOnLow = true;
  mat.userData.palacePilotTextures = true;
  mat.needsUpdate = true;
}

function applyMapsToKnownMaterials(maps: PalaceColumnMaps): void {
  for (const mat of materialsUsingPilot) applyPalaceColumnMaps(mat, maps);
}

function initPalaceColumnTextures(
  renderer: THREE.WebGLRenderer | undefined,
  maps: PalaceColumnMaps,
): void {
  if (!renderer) return;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const texture of Object.values(maps)) {
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
  }
  renderer.initTexture(maps.albedo);
  renderer.initTexture(maps.normal);
  renderer.initTexture(maps.roughness);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const palaceColumnTextureUrls = {
  albedo: textureUrl('albedo'),
  normal: textureUrl('normal'),
  roughness: textureUrl('orm'),
};
