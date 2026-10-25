import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  addPalaceEntranceStone,
  entranceStoneWeight,
  setPalaceEntranceGrid,
} from './palaceEntranceStone.ts';
import {
  getPalaceColumnMaps,
  loadPalaceColumnTextures,
  resetPalaceColumnTextureCacheForTests,
} from './palaceColumnMaterial.ts';

function texture(name: string): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.name = name;
  t.needsUpdate = true;
  return t;
}

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

function uniform(shader: THREE.WebGLProgramParametersWithUniforms, name: string): THREE.IUniform {
  const value = shader.uniforms[name];
  expect(value).toBeDefined();
  return value!;
}

describe('palace entrance stone', () => {
  it('mirrors the shader spatial mask at the inside, outside, and fade band', () => {
    expect(entranceStoneWeight(45, 8, 0)).toBe(1);
    expect(entranceStoneWeight(34.99, 8, 0)).toBe(0);
    expect(entranceStoneWeight(45, 24.01, 0)).toBe(0);
    expect(entranceStoneWeight(36, 8, 0)).toBeCloseTo(0.5);
    expect(entranceStoneWeight(45, 8, 21)).toBeCloseTo(0.5);
    expect(entranceStoneWeight(35.5, 8, 0)).toBeCloseTo(0.15625);
  });

  it('preserves existing maps and disables the shader fallback when shared maps are absent', () => {
    const map = texture('base-albedo');
    const rough = texture('base-rough');
    const ao = texture('baked-ao');
    const mat = new THREE.MeshStandardMaterial({ map, roughnessMap: rough, aoMap: ao });
    addPalaceEntranceStone(mat);
    const shader = compiled(mat);
    expect(mat.map).toBe(map);
    expect(mat.roughnessMap).toBe(rough);
    expect(mat.aoMap).toBe(ao);
    expect(uniform(shader, 'uEntranceStoneEnabled').value).toBe(0);
    expect(uniform(shader, 'uEntranceStoneAlbedo').value).toBeNull();
    expect(shader.fragmentShader).toContain('roughnessFactor = mix( roughnessFactor');
    expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse *= entranceAO;');
  });

  it('reuses the loaded column textures by identity', async () => {
    resetPalaceColumnTextureCacheForTests();
    const textures = [texture('shared-albedo'), texture('shared-normal'), texture('shared-orm')];
    let next = 0;
    const loader = {
      loadAsync: () => Promise.resolve(textures[next++]!),
    } as unknown as THREE.TextureLoader;
    await loadPalaceColumnTextures(undefined, undefined, { loader });
    try {
      const maps = getPalaceColumnMaps();
      const mat = new THREE.MeshStandardMaterial();
      addPalaceEntranceStone(mat);
      const shader = compiled(mat);
      expect(uniform(shader, 'uEntranceStoneEnabled').value).toBe(1);
      expect(maps?.albedo).toBe(textures[0]);
      expect(uniform(shader, 'uEntranceStoneAlbedo').value).toBe(textures[0]);
      expect(uniform(shader, 'uEntranceStoneNormal').value).toBe(textures[1]);
      expect(uniform(shader, 'uEntranceStoneOrm').value).toBe(textures[2]);
    } finally {
      resetPalaceColumnTextureCacheForTests();
    }
  });

  it('compiles against Three standard shader chunks and keeps wetness after entrance roughness', () => {
    const mat = new THREE.MeshStandardMaterial();
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWetness = { value: 0 };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nroughnessFactor = mix( roughnessFactor, 0.14, uWetness );',
      );
    };
    mat.customProgramCacheKey = () => 'wet';
    addPalaceEntranceStone(mat);
    addPalaceEntranceStone(mat);
    const shader = compiled(mat);
    expect(shader.vertexShader).toContain('vEntrancePos = ( modelMatrix * entranceWorld ).xyz;');
    expect(shader.fragmentShader).toContain('float entranceStoneWeight( vec3 p )');
    expect(shader.fragmentShader).toContain('vec3 entranceBaseNormal = nonPerturbedNormal;');
    expect(shader.fragmentShader).toContain(
      'vec3 entranceDetailNormal = normalize( tbn * entranceMapN );',
    );
    expect(shader.fragmentShader.match(/float entranceStoneWeight/g)).toHaveLength(1);
    expect(shader.fragmentShader.match(/textureGrad\( uEntranceStoneAlbedo/g)).toHaveLength(1);
    expect(shader.fragmentShader.match(/textureGrad\( uEntranceStoneNormal/g)).toHaveLength(1);
    expect(shader.fragmentShader.match(/textureGrad\( uEntranceStoneOrm/g)).toHaveLength(1);
    expect(shader.fragmentShader.indexOf('max( entranceRough, 0.65 )')).toBeLessThan(
      shader.fragmentShader.indexOf('0.14, uWetness'),
    );
    expect(mat.customProgramCacheKey()).toBe(
      'wet|palaceEntranceStone-v8|facade:false|windows:false',
    );
  });

  it('uses authored Palace classification on shells and preserves painted window pixels', () => {
    const shell = new THREE.MeshStandardMaterial();
    const paint = new THREE.MeshStandardMaterial();
    addPalaceEntranceStone(shell, { facade: true });
    addPalaceEntranceStone(paint, { facade: true, windows: true });
    const shellShader = compiled(shell);
    const paintShader = compiled(paint);
    expect(shellShader.vertexShader).toContain('vPalaceStone = aPalaceStone;');
    expect(shellShader.fragmentShader).toContain('mix( entranceBlockTone, 1.0, vPalaceStone )');
    expect(shellShader.fragmentShader).toContain(
      'max( entranceStoneWeight( vEntrancePos ), vPalaceStone )',
    );
    expect(paintShader.fragmentShader).toContain('1.0 - step( 0.3, fract( vEntranceUv.x / 3.3 ) )');
    expect(shell.customProgramCacheKey()).not.toBe(paint.customProgramCacheKey());
  });

  it('multiplies stone detail without replacing the base map or cancelling vertex tint', () => {
    const material = new THREE.MeshStandardMaterial();
    addPalaceEntranceStone(material, { facade: true });
    const shader = compiled(material);
    expect(shader.fragmentShader).not.toContain('vec3( 1.0, 0.96, 0.88 )');
    expect(shader.fragmentShader).not.toContain('entranceAlbedo * uEntranceTintInv');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= mix( 1.0, entranceDetail');
  });

  it('filters continuous stone footprints before divergent window/Palace masks', () => {
    const mat = new THREE.MeshStandardMaterial();
    addPalaceEntranceStone(mat, { facade: true, windows: true });
    const source = compiled(mat).fragmentShader;
    const main = source.slice(source.indexOf('void main()'));
    expect(main.indexOf('fwidth( vEntranceUv )')).toBeGreaterThan(-1);
    expect(main.indexOf('fwidth( vEntranceUv )')).toBeLessThan(
      main.indexOf('if ( entranceStone > 0.001 )'),
    );
    for (const derivative of [
      'dFdx( vEntranceUv / uEntranceStoneTile )',
      'dFdy( vEntranceUv / uEntranceStoneTile )',
    ]) {
      expect(main.indexOf(derivative)).toBeGreaterThan(-1);
      expect(main.indexOf(derivative)).toBeLessThan(main.indexOf('if ( entranceStone > 0.001 )'));
    }
    expect(source).toContain('centre = fract( centre );');
    expect(source).toContain('entranceBlockPresence');
    expect(source).toContain('mix( 90.0, 60.0, uArchitectureBudget )');
    expect(source).toContain('mix( 140.0, 100.0, uArchitectureBudget )');
    expect(source).not.toContain('fwidth( metresUv )');
    expect(source.match(/textureGrad\( uEntranceStoneAlbedo/g)).toHaveLength(1);
    expect(source.match(/textureGrad\( uEntranceStoneNormal/g)).toHaveLength(1);
    expect(source.match(/textureGrad\( uEntranceStoneOrm/g)).toHaveLength(1);
  });

  it('keeps grid state per material and updates compiled uniforms', () => {
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    addPalaceEntranceStone(a);
    addPalaceEntranceStone(b);
    setPalaceEntranceGrid(a, true);
    const shaderA = compiled(a);
    const shaderAAgain = compiled(a);
    const shaderB = compiled(b);
    expect(uniform(shaderAAgain, 'uEntranceStoneGrid')).toBe(
      uniform(shaderA, 'uEntranceStoneGrid'),
    );
    expect(uniform(shaderA, 'uEntranceStoneGrid').value).toBe(1);
    expect(uniform(shaderB, 'uEntranceStoneGrid').value).toBe(0);
    setPalaceEntranceGrid(a, false);
    expect(uniform(shaderA, 'uEntranceStoneGrid').value).toBe(0);
    expect(uniform(shaderB, 'uEntranceStoneGrid').value).toBe(0);
  });

  it('remembers grid state set before the entrance hook exists', () => {
    const mat = new THREE.MeshStandardMaterial();
    setPalaceEntranceGrid(mat, true);
    addPalaceEntranceStone(mat);
    const shader = compiled(mat);
    expect(uniform(shader, 'uEntranceStoneGrid').value).toBe(1);
    expect(mat.userData.palaceEntranceShaders).toBeUndefined();
  });
});
