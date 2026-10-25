import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addFacadeWeathering } from './facadeWeathering.ts';
import { addPalaceEntranceStone } from './palaceEntranceStone.ts';
import { addWetness, WET_FRAGMENT } from './materials.ts';
import { addWindowInteriors, windowLight } from './windowInterior.ts';

/** Run a material's onBeforeCompile on three's real standard shader source. */
function compiled(mat: THREE.MeshStandardMaterial): THREE.WebGLProgramParametersWithUniforms {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  return shader;
}

describe('facade shader patches', () => {
  it('keeps Palace tone in the existing materials, outside painted windows and before wetness', () => {
    const shell = new THREE.MeshStandardMaterial();
    const paint = new THREE.MeshStandardMaterial();
    addWetness(paint);
    addFacadeWeathering(shell);
    addFacadeWeathering(paint, { windows: true });
    addPalaceEntranceStone(paint, { facade: true, windows: true });
    const s = compiled(shell);
    const p = compiled(paint);
    expect(s.fragmentShader).not.toContain('float stoneWindow');
    expect(p.fragmentShader).toContain('stoneWeight *= 1.0 - stoneWindow;');
    expect(p.vertexShader).toContain(
      'vFacadeStone = vec3( aPalaceStone, max( normal.y, 0.0 ), aFacadePanel );',
    );
    const main = p.fragmentShader.slice(p.fragmentShader.indexOf('void main()'));
    expect(main.indexOf('fwidth( vWthUv )')).toBeLessThan(
      main.indexOf('stoneWeight *= 1.0 - stoneWindow;'),
    );
    expect(main.indexOf('palaceStoneTone( diffuseColor.rgb')).toBeLessThan(
      main.indexOf('#include <color_fragment>'),
    );
    expect(main.indexOf('palaceStoneTone( diffuseColor.rgb')).toBeLessThan(
      main.indexOf('#include <normal_fragment_maps>'),
    );
    expect(main).toContain(WET_FRAGMENT);
    for (const stone of [
      'palaceStoneTone( diffuseColor.rgb',
      'max( entranceRough, 0.65 )',
      'normal = normalize( mix( normal, entranceDetailNormal',
    ]) {
      expect(main.indexOf(stone)).toBeGreaterThan(-1);
      expect(main.indexOf(stone)).toBeLessThan(main.indexOf(WET_FRAGMENT));
    }
    expect(p.fragmentShader).toContain('palaceBlockPresence( footprint * 0.5 )');
    expect(p.fragmentShader).toContain('float wall = 1.0 - vFacadeStone.y;');
    expect(p.fragmentShader).toContain('albedo * mix( vec3( 1.0 ), tone * mineral, weight )');
    expect(shell.customProgramCacheKey()).toContain('palace-depth-v8|windows:false');
    expect(paint.customProgramCacheKey()).toContain('palace-depth-v8|windows:true');
  });

  it('shares analytic relief across Low/HDR without new samplers or weather-dependent keys', () => {
    const keys = new Set<string>();
    for (const windows of [false, true]) {
      const mat = new THREE.MeshStandardMaterial();
      addFacadeWeathering(mat, { windows });
      const firstKey = mat.customProgramCacheKey();
      addFacadeWeathering(mat, { windows });
      expect(mat.customProgramCacheKey()).toBe(firstKey);
      keys.add(firstKey);
      const source = compiled(mat).fragmentShader;
      const relief = source.slice(
        source.indexOf('vec2 palaceReliefShade'),
        source.indexOf('float wthHash'),
      );
      expect(relief).not.toContain('inverseTransformDirection');
      expect(relief).not.toContain('texture');
      expect(relief).not.toContain('for (');
      expect(compiled(mat).vertexShader).toContain('directionalLights[ 0 ].direction');
      expect(source).toContain('reflectedLight.directDiffuse *= palaceShade.x * palaceShade.y;');
      expect(source).toContain('reflectedLight.indirectDiffuse *= palaceShade.x;');
      expect(relief).not.toContain('if (');
      expect(source).toContain('texelRoughness.rba');
      expect(source).toContain('float streak = streakColumns');
      expect(source).toContain('block * 0.24 * fine');
      expect(
        Object.keys(compiled(mat).uniforms).filter((key) => key.startsWith('uPalace')),
      ).toHaveLength(0);
    }
    expect(keys.size).toBe(2);
  });

  it('keeps Low to one hash, one dynamic band and the existing roughness sample', () => {
    const mat = new THREE.MeshStandardMaterial();
    addFacadeWeathering(mat, { windows: true });
    const s = compiled(mat);
    const tone = s.fragmentShader
      .slice(
        s.fragmentShader.indexOf('vec3 palaceStoneTone'),
        s.fragmentShader.indexOf('// x: cavity'),
      )
      .replace(/#ifndef TONE_MAPPING[\s\S]*?#else/g, '')
      .replace(/#endif/g, '');
    const relief = s.fragmentShader.slice(
      s.fragmentShader.indexOf('vec2 palaceReliefShade'),
      s.fragmentShader.indexOf(
        '#ifndef TONE_MAPPING',
        s.fragmentShader.indexOf('vec2 palaceReliefShade'),
      ),
    );
    expect(tone.match(/palaceBlockHash\(/g)).toHaveLength(1);
    expect(relief.match(/palaceBand\(/g)).toHaveLength(1);
    for (const hot of [tone, relief]) {
      expect(hot).not.toMatch(
        /\b(?:if|pow|exp|texture2D|texture|distance|inverseTransformDirection)\s*\(/,
      );
    }
    expect(s.vertexShader).toContain('palaceCourseDrop(');
    expect(s.vertexShader).toContain('palaceRevealRatio(');
    // Flat LOD panels span six storeys: a 2.4m dirt mask cannot interpolate across them.
    expect(s.vertexShader).not.toContain('palaceBase');
    expect(s.fragmentShader.match(/vec2 stoneCell = mod\(/g)).toHaveLength(1);
    expect(s.fragmentShader).not.toContain('vec2 p = mod( vWthUv');
  });

  it('window interiors hook every chunk they need (a renamed chunk fails here)', () => {
    const mat = new THREE.MeshStandardMaterial();
    addWindowInteriors(mat);
    const s = compiled(mat);
    expect(s.vertexShader).toContain('vWinUv = uv;');
    for (const needle of [
      'void windowInterior()',
      'windowInterior();',
      'roughnessFactor = mix( 0.05, 0.75, winFrame )',
      'metalnessFactor = 0.0',
      'totalEmissiveRadiance += winRadiance',
    ])
      expect(s.fragmentShader, needle).toContain(needle);
    // Degenerate screen derivatives must fall back to the plain wall, never normalize(0) (NaN on
    // NVIDIA; it blacked the whole frame through bloom).
    expect(s.fragmentShader).toContain('if ( !( cl > 1e-24 ) ) { winMask = 0.0; return; }');
    expect(s.fragmentShader).not.toContain('normalize( cross( dp1, dp2 ) )');
    expect(s.uniforms.uWinInterior).toBe(windowLight.interior);
    expect(mat.customProgramCacheKey()).toContain('windowInteriors');
  });

  it('evaluates High pixel footprints before divergent returns and guards parallel room rays', () => {
    const mat = new THREE.MeshStandardMaterial();
    addWindowInteriors(mat);
    const source = compiled(mat).fragmentShader;
    // Low intentionally restores main's exact legacy path; the filtered room is
    // the higher-tier function following its slat integration helper.
    const start = source.indexOf('void windowInterior()', source.indexOf('float wSlatIntegral'));
    const end = source.indexOf('winRadiance = col * ( 1.0 - winFrame );', start);
    const room = source.slice(start, end);
    const firstReturn = room.indexOf('if ( winMask < 0.5 ) return;');
    for (const derivative of ['fwidth(', 'dFdx(', 'dFdy(']) {
      expect(room.lastIndexOf(derivative)).toBeLessThan(firstReturn);
      expect(room.indexOf(derivative)).toBeGreaterThan(-1);
    }
    expect(room).toContain('abs( d.x ) > 1e-6');
    expect(room).toContain('abs( d.y ) > 1e-6');
    expect(room).not.toContain('normalize( vWinPos - cameraPosition )');
    expect(room).toContain('wSlatIntegral( slatCentre + 0.5 * slatWidth )');
    expect(room).not.toContain('step( 0.5, fract( win.y * 26.0 ) )');
    expect(room).not.toContain('winMask = 2.0');
    expect(mat.customProgramCacheKey()).toContain('windowInteriors-footprint-v5-clusters-v2');
  });

  it('weathering hooks the albedo and stacks with interiors without clashing', () => {
    const mat = new THREE.MeshStandardMaterial();
    addFacadeWeathering(mat);
    addWindowInteriors(mat);
    addFacadeWeathering(mat); // idempotent
    const s = compiled(mat);
    expect(s.fragmentShader).toContain('diffuseColor.rgb = weather( diffuseColor.rgb );');
    expect(s.fragmentShader.match(/vec3 weather\(/g)).toHaveLength(1);
    // Distinct varyings: both patches can share a material.
    expect(s.vertexShader).toContain('vWthPos');
    expect(s.vertexShader).toContain('attribute float aFacadeOcclusion;');
    expect(s.fragmentShader).toContain('reflectedLight.indirectDiffuse *= facadeAO;');
    expect(s.fragmentShader).toContain('computeSpecularOcclusion(');
    expect(s.fragmentShader).toContain('vec2 fw = fwidth( vWthUv );');
    expect(s.fragmentShader).toContain('smoothstep( 2.0, 5.0, footprint )');
    expect(s.fragmentShader).toContain('mix( 90.0, 60.0, uArchitectureBudget )');
    expect(s.fragmentShader).toContain('mix( 140.0, 100.0, uArchitectureBudget )');
    expect(s.fragmentShader).toContain('fine *= 1.0 - uArchitectureBudget;');
    expect(s.vertexShader).toContain('vWinPos');
    expect(mat.customProgramCacheKey()).toMatch(/weathered.*windowInteriors/);
  });
});
