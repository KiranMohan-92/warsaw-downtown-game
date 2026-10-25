import * as THREE from 'three';
import type { ResolvedQuality } from './post.ts';

/** One hardware bilinear PCF lookup on Low/Medium; full disk filtering on High/Ultra. */
export const budgetShadows = { value: 0 };
/** Medium-only trim; Low keeps legacy windows and compiles added detail out, High/Ultra keep detail. */
export const architectureBudget = { value: 0 };
const patched = new WeakSet<THREE.Material>();
const normals = new WeakMap<THREE.MeshStandardMaterial, THREE.Texture>();

const PCF_START = 'float getShadow( sampler2DShadow shadowMap,';
const PCF_END = '#elif defined( SHADOWMAP_TYPE_VSM )';
const MARK = '// wd:shadow-budget';

/**
 * three's PCF `getShadow`, rewritten (installed into `ShaderChunk` at import, before any program
 * compiles, like the NaN guard):
 *
 * - **Low** programs (the only ones that tone-map in the material: `TONE_MAPPING` is defined
 *   only there, Medium+ tone-map in the post chain) contain just one hardware-bilinear compare
 *   (2×2 PCF), the exact look Low had; the unused 5-tap Vogel disk is no longer compiled into
 *   them. (Measured with GPU timer queries on Intel UHD, the Low shadow lookup itself is ~1 ms
 *   of the Market frame and the shadow pass ~0.8 ms: an earlier estimate of ~15 ms from
 *   uncapped frame intervals was noise. The big Low costs were overdraw and an unlit point
 *   light: see depthPrepass.ts and pointLightSkipChunk.)
 * - **Medium** keeps the uniform budget branch (`WD_BUDGET_SHADOWS`, patched per material) so
 *   it shares High's programs: a tier change compiles nothing.
 * - Every tap is `textureLod(…, 0.0)` (a shadow map has no mips): FXC flattens a branch that
 *   holds gradient-based `texture()` compares, so the budget branch ran 1 tap *and* all 5.
 */
export function budgetShadowChunk(chunk: string): string {
  if (chunk.includes(MARK)) return chunk;
  const start = chunk.indexOf(PCF_START);
  const end = chunk.indexOf(PCF_END, start);
  if (start < 0 || end < 0 || !chunk.slice(start, end).includes('vogelDiskSample( 4, 5, phi )')) {
    throw new Error('three shadowmap_pars_fragment changed: re-check budgetShadowChunk');
  }
  const fn = /* glsl */ `${MARK}
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
			#if defined( TONE_MAPPING )
				shadow = textureLod( shadowMap, shadowCoord.xyz, 0.0 );
			#else
				#ifdef WD_BUDGET_SHADOWS
				if ( uBudgetShadows > 0.5 ) {
					shadow = textureLod( shadowMap, shadowCoord.xyz, 0.0 );
				} else
				#endif
				{
					vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
					float radius = shadowRadius * texelSize.x;
					float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
					shadow = (
						textureLod( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ), 0.0 ) +
						textureLod( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ), 0.0 ) +
						textureLod( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ), 0.0 ) +
						textureLod( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ), 0.0 ) +
						textureLod( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ), 0.0 )
					) * 0.2;
				}
			#endif
			}
			return mix( 1.0, shadow, shadowIntensity );
		}

	`;
  return chunk.slice(0, start) + fn + chunk.slice(end);
}

const POINT_START = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
const POINT_END = '#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )';
const RE_DIRECT =
  'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const POINT_MARK = '/* wd:point-light-skip */';

/**
 * Point lights only shade where they reach: the scene keeps one permanent blast light (toggling
 * lights recompiles every program), dark (intensity 0) except for 0.18 s after a frag. three
 * still ran its full GGX `RE_Direct` for it on every lit fragment: ~2 ms of a ~23 ms Low frame
 * on Intel UHD (Market, 1600×900, GPU timer queries). The branch tests the light's uniform
 * colour (three uploads colour × intensity: zero while off), so it is the same for every
 * fragment and FXC keeps it a real branch; a per-fragment test (`directLight.visible`, out of
 * range) saved only a quarter of that. The lit result is unchanged.
 */
export function pointLightSkipChunk(chunk: string): string {
  if (chunk.includes(POINT_MARK)) return chunk;
  const start = chunk.indexOf(POINT_START);
  const end = chunk.indexOf(POINT_END, start);
  const block = start < 0 || end < 0 ? '' : chunk.slice(start, end);
  if (!block.includes(RE_DIRECT) || !block.includes('getPointLightInfo( pointLight')) {
    throw new Error('three lights_fragment_begin changed: re-check pointLightSkipChunk');
  }
  return (
    chunk.slice(0, start) +
    block
      .replace(
        'pointLight = pointLights[ i ];',
        `pointLight = pointLights[ i ];\n\t\t${POINT_MARK} if ( pointLight.color != vec3( 0.0 ) ) {`,
      )
      .replace(RE_DIRECT, `${RE_DIRECT}\n\t\t}`) +
    chunk.slice(end)
  );
}

const DIR_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const DIR_END = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
const DIR_SHADOW = '( directLight.visible && receiveShadow ) ? getShadow(';
const DIR_MARK = '/* wd:sun-skip */';

/**
 * The sun's direct light only where it lands: every term of three's direct lighting (GGX
 * specular, diffuse; sheen too) is scaled by `irradiance = saturate(N·L) × colour`, so a
 * fragment facing away from the sun (N·L ≤ 0) or fully in shadow (colour 0) adds exactly
 * nothing. Those fragments now skip the BRDF, and N·L ≤ 0 skips the shadow lookup as well.
 * Not with a clearcoat (its own normal can face the sun) or toon shading (gradient map of N·L).
 * Shadowed alleys and walls turned from the sun are a large share of the Market's pixels
 * (~0.5–1 ms of the Intel UHD Low frame).
 */
export function sunSkipChunk(chunk: string): string {
  if (chunk.includes(DIR_MARK)) return chunk;
  const start = chunk.indexOf(DIR_START);
  const end = chunk.indexOf(DIR_END, start);
  const block = start < 0 || end < 0 ? '' : chunk.slice(start, end);
  if (!block.includes(RE_DIRECT) || !block.includes(DIR_SHADOW)) {
    throw new Error('three lights_fragment_begin changed: re-check sunSkipChunk');
  }
  const facing = 'dot( geometryNormal, directLight.direction ) > 0.0';
  return (
    chunk.slice(0, start) +
    block
      .replace(
        DIR_SHADOW,
        `\n\t\t#if defined( USE_CLEARCOAT ) || defined( TOON )\n\t\t${DIR_SHADOW}\n\t\t#else\n\t\t( directLight.visible && receiveShadow && ${facing} ) ? getShadow(\n\t\t#endif\n\t\t`,
      )
      .replace(
        RE_DIRECT,
        `${DIR_MARK}\n\t\t#if !defined( USE_CLEARCOAT ) && !defined( TOON )\n\t\tif ( directLight.color != vec3( 0.0 ) && ${facing} )\n\t\t#endif\n\t\t${RE_DIRECT}`,
      ) +
    chunk.slice(end)
  );
}

/** Installed at import, before any program compiles (so warm-up compiles exactly these). */
export function installShaderBudget(): void {
  THREE.ShaderChunk.shadowmap_pars_fragment = budgetShadowChunk(
    THREE.ShaderChunk.shadowmap_pars_fragment,
  );
  THREE.ShaderChunk.lights_fragment_begin = sunSkipChunk(
    pointLightSkipChunk(THREE.ShaderChunk.lights_fragment_begin),
  );
}

installShaderBudget();

/** Preserve foliage/wetness hooks and the same shader program across Medium/High. */
export function patchBudgetShadows(material: THREE.MeshStandardMaterial): void {
  if (patched.has(material)) return;
  patched.add(material);
  const hook = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    hook(shader, renderer);
    // Map variants delegate to their base material, which may already have patched the shader.
    if (shader.uniforms.uBudgetShadows) return;
    shader.uniforms.uBudgetShadows = budgetShadows;
    shader.uniforms.uArchitectureBudget = architectureBudget;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
#define WD_BUDGET_SHADOWS
uniform float uBudgetShadows;
#ifndef TONE_MAPPING
#ifndef WD_ARCHITECTURE_BUDGET
#define WD_ARCHITECTURE_BUDGET
uniform float uArchitectureBudget;
#endif
#endif`,
    );
  };
  material.customProgramCacheKey = () => `${key}|budget-pcf-3`;
  material.needsUpdate = true;
}

/** Called at tier changes and after assets load, never from the frame loop. */
export function setRenderBudget(scene: THREE.Object3D, quality: ResolvedQuality): void {
  budgetShadows.value = quality === 'low' || quality === 'medium' ? 1 : 0;
  architectureBudget.value = quality === 'medium' ? 1 : 0;
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      patchBudgetShadows(material);
      // The three facade draws retain stone grain; stripping every normal made the main
      // architectural landmark uniformly smooth. Other world surfaces keep the Low budget.
      if (quality === 'low' && material.normalMap && !material.userData.keepNormalOnLow) {
        normals.set(material, material.normalMap);
        material.normalMap = null;
        material.needsUpdate = true;
      } else if (quality !== 'low' && normals.has(material)) {
        material.normalMap = normals.get(material)!;
        normals.delete(material);
        material.needsUpdate = true;
      }
    }
  });
}
