import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  architectureBudget,
  budgetShadowChunk,
  budgetShadows,
  patchBudgetShadows,
  pointLightSkipChunk,
  setRenderBudget,
  sunSkipChunk,
} from './renderBudget.ts';

/** The PCF `getShadow` as installed (from the PCF start to the VSM branch). */
function pcfGetShadow(chunk: string): string {
  const start = chunk.indexOf('float getShadow( sampler2DShadow shadowMap,');
  return chunk.slice(start, chunk.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )', start));
}

/** Text between `#if defined( TONE_MAPPING )` and its `#else`: what a Low program compiles. */
function lowBranch(fn: string): string {
  const start = fn.indexOf('#if defined( TONE_MAPPING )');
  return fn.slice(start, fn.indexOf('#else', start));
}

describe('world fill-rate budget', () => {
  it('retains normals on explicitly budgeted architectural materials across quality changes', () => {
    const normal = new THREE.Texture();
    const stone = new THREE.MeshStandardMaterial({ normalMap: normal });
    stone.userData.keepNormalOnLow = true;
    const generic = new THREE.MeshStandardMaterial({ normalMap: normal });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [stone, generic]));
    for (const q of ['low', 'medium', 'high', 'low'] as const) {
      setRenderBudget(scene, q);
      expect(stone.normalMap).toBe(normal);
      expect(generic.normalMap).toBe(q === 'low' ? null : normal);
    }
  });
  it('removes Low normal fetches and restores the exact maps without recompiling higher tiers', () => {
    const normal = new THREE.Texture();
    const mat = new THREE.MeshStandardMaterial({ normalMap: normal });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [mat, mat]));
    setRenderBudget(scene, 'low');
    expect(mat.normalMap).toBeNull();
    expect(budgetShadows.value).toBe(1);
    expect(architectureBudget.value).toBe(0);
    setRenderBudget(scene, 'medium');
    expect(mat.normalMap).toBe(normal);
    expect(architectureBudget.value).toBe(1);
    const version = mat.version;
    setRenderBudget(scene, 'high');
    expect(mat.version).toBe(version);
    expect(budgetShadows.value).toBe(0);
    expect(architectureBudget.value).toBe(0);
  });

  it('retains existing hooks and enables the uniform budget branch per material', () => {
    const material = new THREE.MeshStandardMaterial();
    material.onBeforeCompile = (shader) => {
      shader.uniforms.existing = { value: 7 };
    };
    material.customProgramCacheKey = () => 'existing';
    patchBudgetShadows(material);
    patchBudgetShadows(material);
    const shader = {
      uniforms: {},
      vertexShader: '',
      fragmentShader: '#include <common>\n#include <shadowmap_pars_fragment>',
    } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.existing!.value).toBe(7);
    expect(shader.uniforms.uBudgetShadows).toBe(budgetShadows);
    expect(shader.fragmentShader).toContain(
      '#define WD_BUDGET_SHADOWS\nuniform float uBudgetShadows;',
    );
    // The chunk itself is global (installed at import), not replaced per material.
    expect(shader.fragmentShader).toContain('#include <shadowmap_pars_fragment>');
    expect(material.customProgramCacheKey()).toBe('existing|budget-pcf-3');
  });
});

describe('shadow lookup chunk (installed into three at import)', () => {
  const installed = THREE.ShaderChunk.shadowmap_pars_fragment;
  const fn = pcfGetShadow(installed);

  it('is installed and idempotent', () => {
    expect(installed).toContain('wd:shadow-budget');
    expect(budgetShadowChunk(installed)).toBe(installed);
  });

  it('compiles only one explicit-LOD hardware PCF tap into Low programs', () => {
    const low = lowBranch(fn);
    expect(low.match(/textureLod\( shadowMap/g)).toHaveLength(1);
    expect(low).not.toContain('vogelDiskSample');
    expect(low).not.toMatch(/\btexture\( shadowMap/);
  });

  it('keeps the 5-tap disk for High/Ultra and a uniform budget tap for Medium, all explicit-LOD', () => {
    const higher = fn.slice(fn.indexOf('#else'));
    expect(higher).toContain('if ( uBudgetShadows > 0.5 )');
    for (let i = 0; i < 5; i++) expect(higher).toContain(`vogelDiskSample( ${i}, 5, phi )`);
    expect(fn).not.toMatch(/\btexture\( shadowMap/); // gradient compares make FXC flatten branches
  });

  it('throws if three changes the chunk (instead of silently not patching)', () => {
    expect(() => budgetShadowChunk('float getShadow( sampler2D shadowMap )')).toThrow();
  });
});

describe('light-skip chunks (installed into three at import)', () => {
  const installed = THREE.ShaderChunk.lights_fragment_begin;
  const block = (from: string, to: string): string =>
    installed.slice(installed.indexOf(from), installed.indexOf(to));
  const re =
    'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

  it('skips a point light while its uniform colour is zero (the dark blast light)', () => {
    const point = block('#if ( NUM_POINT_LIGHTS > 0 )', '#if ( NUM_SPOT_LIGHTS > 0 )');
    const guard = point.indexOf('if ( pointLight.color != vec3( 0.0 ) ) {');
    expect(guard).toBeGreaterThan(point.indexOf('pointLight = pointLights[ i ];'));
    expect(point.indexOf('getPointLightInfo( pointLight')).toBeGreaterThan(guard);
    expect(point.indexOf(re)).toBeGreaterThan(guard);
    expect(pointLightSkipChunk(installed)).toBe(installed);
  });

  it('skips the sun where it adds nothing (facing away or fully shadowed), except clearcoat/toon', () => {
    const dir = block('#if ( NUM_DIR_LIGHTS > 0 )', '#if ( NUM_RECT_AREA_LIGHTS > 0 )');
    expect(dir).toContain(
      '( directLight.visible && receiveShadow && dot( geometryNormal, directLight.direction ) > 0.0 ) ? getShadow(',
    );
    expect(dir).toContain(
      'if ( directLight.color != vec3( 0.0 ) && dot( geometryNormal, directLight.direction ) > 0.0 )',
    );
    expect(dir).toContain('#if !defined( USE_CLEARCOAT ) && !defined( TOON )');
    // The unguarded shadow condition survives for clearcoat/toon programs.
    expect(dir).toContain('#if defined( USE_CLEARCOAT ) || defined( TOON )');
    expect(dir.indexOf(re)).toBeGreaterThan(dir.indexOf('wd:sun-skip'));
    expect(sunSkipChunk(installed)).toBe(installed);
  });

  it('preprocessor structure stays balanced', () => {
    const opens = (installed.match(/^\s*#if/gm) ?? []).length;
    const ends = (installed.match(/^\s*#endif/gm) ?? []).length;
    expect(opens).toBe(ends);
  });

  it('throws if three changes the chunk', () => {
    expect(() => pointLightSkipChunk('nothing here')).toThrow();
    expect(() => sunSkipChunk('nothing here')).toThrow();
  });
});
