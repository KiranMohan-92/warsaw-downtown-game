import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addFacadeWeathering } from './facadeWeathering.ts';
import { addPalaceEntranceStone } from './palaceEntranceStone.ts';
import { addWindowInteriors } from './windowInterior.ts';
import { addStallLight } from './marketStallLighting.ts';
import { architectureBudget, setRenderBudget } from './renderBudget.ts';
import { palaceColumnMaterial } from './palaceColumnMaterial.ts';
import { addWetness, type MapMaterials } from './materials.ts';
import { addCourtyardBake } from './courtyardBake.ts';
import { addGroundDetail } from './groundDetail.ts';

/** Select only the tier guard, retaining unrelated Three preprocessor directives verbatim. */
function tierSource(source: string, low: boolean): string {
  const stack: { tier: boolean; active: boolean }[] = [];
  const result: string[] = [];
  for (const line of source.split('\n')) {
    const directive = /^\s*#\s*(if|ifdef|ifndef|else|elif|endif)\b(.*)/.exec(line);
    if (directive) {
      const [, command, condition] = directive;
      if (command === 'if' || command === 'ifdef' || command === 'ifndef') {
        const tier = condition!.trim() === 'TONE_MAPPING';
        stack.push({ tier, active: !tier || (command === 'ifndef' ? !low : low) });
        if (tier) continue;
      } else if (command === 'endif') {
        if (stack.pop()?.tier) continue;
      } else if (stack.at(-1)?.tier) {
        if (command === 'elif') throw new Error('Extend tierSource for a tier #elif');
        stack.at(-1)!.active = !stack.at(-1)!.active;
        continue;
      }
    }
    if (stack.every((frame) => frame.active)) result.push(line);
  }
  expect(stack).toHaveLength(0);
  return result.join('\n');
}

function compiled(material: THREE.MeshStandardMaterial): { vertex: string; fragment: string } {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader };
}

/** Model the shared uniform's Medium branch, without changing the compiled program. */
function withoutHighDetail(source: string): string {
  const guard = 'if ( uArchitectureBudget < 0.5 ) {';
  let start: number;
  while ((start = source.indexOf(guard)) !== -1) {
    let depth = 1;
    let end = start + guard.length;
    for (; depth > 0 && end < source.length; end++) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
    }
    expect(depth).toBe(0);
    source = source.slice(0, start) + source.slice(end);
  }
  return source;
}

describe('architecture pixel budget', () => {
  it('keeps contact and macro paving on every tier while skipping fine detail on Medium', () => {
    const material = new THREE.MeshStandardMaterial();
    addWetness(material);
    addGroundDetail(material);
    addCourtyardBake(material);
    setRenderBudget(new THREE.Mesh(new THREE.PlaneGeometry(), material), 'medium');
    const fragment = compiled(material).fragment;
    const low = tierSource(fragment, true);
    expect(low).not.toContain('uArchitectureBudget');
    expect(low).toContain('vec4 broad = texture2D( uGdNoise');
    expect(low).toContain('vec4 mid = texture2D( uGdNoise');
    expect(low).toContain('gdContactDistance( xz, m )');
    expect(low).not.toContain('gdMaskAt( xz )');
    const higher = tierSource(fragment, false);
    const mediumGuard = higher.indexOf('if ( uArchitectureBudget > 0.5 ) return mix');
    expect(higher.indexOf('float contactDistance = gdContactDistance( xz, m );')).toBeLessThan(
      mediumGuard,
    );
    expect(higher.indexOf('vec4 broad = texture2D( uGdNoise')).toBeLessThan(mediumGuard);
    expect(mediumGuard).toBeLessThan(higher.indexOf('vec4 mid = texture2D( uGdNoise'));
    expect(higher).toContain('#ifndef WD_ARCHITECTURE_BUDGET');
  });

  it('uses only the existing surface maps on Medium even in the near entrance', () => {
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const roughnessMap = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap });
    addWetness(material);
    addFacadeWeathering(material);
    addPalaceEntranceStone(material, { facade: true, windows: true });
    addCourtyardBake(material);
    addWindowInteriors(material);
    const high = tierSource(compiled(material).fragment, false);
    expect(high).toContain('if ( uArchitectureBudget < 0.5 ) {');
    const medium = withoutHighDetail(high);
    const main = medium.slice(medium.indexOf('void main()'));
    for (const expensive of [
      'textureGrad( uEntranceStone',
      'texture2D( uCbMap',
      'palaceMortar( vEntranceUv',
      'palaceBlockHash( vEntranceUv',
      'fwidth( vEntranceUv )',
      'dFdx( vEntranceUv / uEntranceStoneTile )',
      'dFdy( vEntranceUv / uEntranceStoneTile )',
      'weather( diffuseColor.rgb )',
      'windowInterior();',
    ]) {
      expect(main).not.toContain(expensive);
      expect(high).toContain(expensive);
    }
    expect(main).toContain('float entranceStone = 0.0;');
    expect(main).toContain('winMask = 0.0;');
    for (const chunk of ['map_fragment', 'normal_fragment_maps', 'roughnessmap_fragment']) {
      expect(main).toContain(`#include <${chunk}>`);
    }
    expect(material.map).toBe(map);
    expect(material.normalMap).toBe(normalMap);
    expect(material.roughnessMap).toBe(roughnessMap);
  });

  it('removes the entrance bake sampler and projection from Low even when its gain is zero', () => {
    const material = new THREE.MeshStandardMaterial();
    addWetness(material);
    addCourtyardBake(material);
    const source = compiled(material);
    const low = tierSource(source.fragment, true);
    const higher = tierSource(source.fragment, false);
    for (const detail of ['uCbMap', 'uCbGain', 'uCbRect', 'cbIrradiance', 'cbNormal']) {
      expect(low).not.toContain(detail);
      expect(higher).toContain(detail);
    }
    expect(low).toContain('#include <aomap_fragment>');
    expect(higher).toContain('texture2D( uCbMap, cbUv )');
    expect(tierSource(source.vertex, true)).toBe(tierSource(source.vertex, false));
  });

  it('keeps cheap Palace tone and cavity on Low without the scan or fine weathering', () => {
    const material = new THREE.MeshStandardMaterial();
    addFacadeWeathering(material);
    addPalaceEntranceStone(material, { facade: true, windows: true });
    addWindowInteriors(material);
    addStallLight(material);
    const source = compiled(material);
    // Three defines TONE_MAPPING only in the fragment prefix. The linker drops
    // unconsumed vertex outputs; keep the vertex source shared across tiers.
    expect(tierSource(source.vertex, true)).toBe(tierSource(source.vertex, false));
    for (const stage of [source.fragment]) {
      const low = tierSource(stage, true);
      const higher = tierSource(stage, false);
      for (const detail of ['Entrance', 'vPalaceStone', 'StallLight']) {
        expect(low).not.toContain(detail);
        expect(higher).toContain(detail);
      }
      expect(low).toContain('#include <common>');
      expect(low).toContain('void main()');
    }
    const low = tierSource(source.fragment, true);
    expect(low).not.toContain('textureGrad(');
    expect(low).not.toContain('uArchitectureBudget');
    expect(low).not.toContain('palaceMortar');
    expect(low).not.toContain('weather(');
    expect(low).toContain(
      'palaceStoneTone( diffuseColor.rgb, stoneFootprint, stoneCell, stoneWeight )',
    );
    expect(low).toContain('reflectedLight.indirectDiffuse *= facadeAO;');
    expect(low).not.toContain('computeSpecularOcclusion(');
    expect(low).not.toContain('if ( weight <= 0.0 ) return albedo;');
    expect(low).not.toContain('smoothstep( 180.0, 320.0');
    expect(source.vertex).toContain('smoothstep( 180.0, 320.0');
    expect(low).toContain('texelRoughness.rba');
    expect(low).not.toContain('palaceBlockHash( vWthUv * 0.5 )');
    expect(low).not.toContain('float streakColumns');
    expect(low).toContain('void windowInterior()');
    expect(low).toContain('windowInterior();');
    expect(low).toContain('winRadiance = col;');
    expect(low).toContain('if ( h.x > 0.45 )');
    expect(low).toContain('if ( h.y > 0.62 )');
    expect(low).toContain('winMask = 2.0; return;');
    for (const extra of ['clusterId', 'stableCentreXZ', 'winDetail', 'wSlatIntegral', 'winFrame']) {
      expect(low).not.toContain(extra);
    }
    for (const chunk of ['map', 'normal', 'roughnessmap', 'metalnessmap', 'emissivemap', 'aomap']) {
      const name = chunk === 'normal' ? 'normal_fragment_maps' : `${chunk}_fragment`;
      expect(low).toContain(`#include <${name}>`);
    }
  });

  it('omits column cavity shading and its extra AO tap on Low', () => {
    const materials = {
      facadeShellVariant: (_key: string, configure: (m: THREE.MeshStandardMaterial) => void) => {
        const material = new THREE.MeshStandardMaterial();
        configure(material);
        return material;
      },
    } as unknown as MapMaterials;
    const source = compiled(palaceColumnMaterial(materials)).fragment;
    const low = tierSource(source, true);
    const higher = tierSource(source, false);
    expect(low).not.toContain('vColumnOcclusion');
    expect(low).not.toContain('#include <aomap_fragment>');
    expect(higher).toContain('reflectedLight.indirectDiffuse *= vColumnOcclusion');
    expect(higher).toContain('#include <aomap_fragment>');
    const medium = withoutHighDetail(higher);
    expect(medium).not.toContain('#include <aomap_fragment>');
    expect(medium).not.toContain('#include <roughnessmap_fragment>');
    expect(medium).toContain('float roughnessFactor = roughness;');
    expect(medium).not.toContain('texture2D( roughnessMap');
    expect(medium).toContain('#include <map_fragment>');
    expect(medium).toContain('#include <normal_fragment_maps>');
    expect(medium).toContain('reflectedLight.indirectDiffuse *= vColumnOcclusion');
    expect(low).toContain('#include <roughnessmap_fragment>');
  });

  it('keeps Medium/High programs identical and uses the existing warmed Low variant', () => {
    const material = new THREE.MeshStandardMaterial();
    addFacadeWeathering(material);
    addPalaceEntranceStone(material);
    addWindowInteriors(material);
    addStallLight(material);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    setRenderBudget(scene, 'low');
    const key = material.customProgramCacheKey();
    setRenderBudget(scene, 'medium');
    const medium = compiled(material);
    expect(architectureBudget.value).toBe(1);
    expect(medium.fragment).toContain('uniform float uArchitectureBudget;');
    expect(medium.fragment).toContain('#ifndef WD_ARCHITECTURE_BUDGET');
    expect(medium.fragment).toContain('mix( 90.0, 60.0, uArchitectureBudget )');
    expect(medium.fragment).toContain('mix( 140.0, 100.0, uArchitectureBudget )');
    expect(medium.fragment).toContain('if ( uArchitectureBudget < 0.5 ) {');
    expect(medium.fragment).toContain('vec3 h2 = vec3( 0.5 );');
    expect(medium.fragment).toContain('h2 = mix( h2, wHash3(');
    expect(medium.fragment).toContain('if ( winDetail > 0.0 ) {');
    const version = material.version;
    setRenderBudget(scene, 'high');
    expect(architectureBudget.value).toBe(0);
    expect(compiled(material)).toEqual(medium);
    expect(material.version).toBe(version);
    expect(material.customProgramCacheKey()).toBe(key);
    setRenderBudget(scene, 'low');
    expect(material.customProgramCacheKey()).toBe(key);
  });
});
