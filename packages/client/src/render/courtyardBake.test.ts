import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMap, resolveMap } from '@wd/shared';
import {
  acceptsCourtyardBake,
  addCourtyardBake,
  COURTYARD_FRAGMENT,
  courtyardUv,
  loadCourtyardBake,
  setCourtyardBakeMap,
  setCourtyardBakeWeather,
} from './courtyardBake.ts';
import { addWetness } from './materials.ts';
import { addGroundDetail } from './groundDetail.ts';

describe('scene-bound entrance illumination', () => {
  afterEach(() => vi.restoreAllMocks());
  it('projects minimum Z to PNG row zero, independently of the color texture UVs', () => {
    expect(courtyardUv(48, -22)).toEqual([0, 0]);
    expect(courtyardUv(80, 22)).toEqual([1, 1]);
    expect(courtyardUv(64, 0)).toEqual([0.5, 0.5]);
    expect(courtyardUv(100, 0)[0]).toBeGreaterThan(1);
  });

  it('accepts the baked map but rejects a moved entrance occluder and other maps', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    expect(acceptsCourtyardBake(map)).toBe(true);
    const changed = structuredClone(map);
    const column = changed.boxes.find((b) => b.center.x === 51.5 && b.size.y === 12)!;
    column.center.x += 1;
    expect(acceptsCourtyardBake(changed)).toBe(false);
    expect(acceptsCourtyardBake(resolveMap(getMap('range'), 'full'))).toBe(false);
  });

  it('chains wetness and paving hooks, gates the uploaded map by weather', async () => {
    const mat = new THREE.MeshStandardMaterial();
    addWetness(mat);
    addGroundDetail(mat);
    addCourtyardBake(mat);
    const key = mat.customProgramCacheKey();
    addCourtyardBake(mat);
    expect(mat.customProgramCacheKey()).toBe(key);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('varying vec3 vWetPos;');
    expect(shader.fragmentShader).toContain('rainExposure');
    expect(shader.fragmentShader).toContain('groundDetail( diffuseColor.rgb');
    expect(shader.fragmentShader).toContain(COURTYARD_FRAGMENT);
    expect(shader.fragmentShader.indexOf(COURTYARD_FRAGMENT)).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <aomap_fragment>'),
    );
    setCourtyardBakeMap(resolveMap(getMap('defilad'), 'market'));
    setCourtyardBakeWeather('neon', 1.1);
    expect(shader.uniforms.uCbGain?.value).toBe(0); // unloaded fallback is dark
    const tex = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(
      tex as unknown as THREE.Texture<HTMLImageElement>,
    );
    const renderer = { initTexture: vi.fn() } as unknown as THREE.WebGLRenderer;
    expect(await loadCourtyardBake(renderer)).toBe(true);
    expect(shader.uniforms.uCbGain?.value).toBe(1.1);
    expect(tex.flipY).toBe(false);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    setCourtyardBakeWeather('sunny', 1);
    expect(shader.uniforms.uCbGain?.value).toBe(0);
    expect(shader.fragmentShader).toContain('material.diffuseColor');
    expect(shader.fragmentShader).toContain('cbNormal.y > 0.75');
    mat.dispose();
  });

  it('rejects a wrong-size texture before uploading it', async () => {
    setCourtyardBakeMap(resolveMap(getMap('defilad'), 'market'));
    const tex = new THREE.DataTexture(new Uint8Array(16), 2, 2);
    const disposed = vi.spyOn(tex, 'dispose');
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(
      tex as unknown as THREE.Texture<HTMLImageElement>,
    );
    const initTexture = vi.fn();
    const renderer = { initTexture } as unknown as THREE.WebGLRenderer;
    await expect(loadCourtyardBake(renderer)).rejects.toThrow('dimensions');
    expect(initTexture).not.toHaveBeenCalled();
    expect(disposed).toHaveBeenCalled();
  });

  it('discards an old map request instead of lighting a newly selected map', async () => {
    setCourtyardBakeMap(resolveMap(getMap('defilad'), 'market'));
    let finish!: (texture: THREE.Texture<HTMLImageElement>) => void;
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const initTexture = vi.fn();
    const renderer = { initTexture } as unknown as THREE.WebGLRenderer;
    const pending = loadCourtyardBake(renderer);
    setCourtyardBakeMap(resolveMap(getMap('range'), 'full'));
    const tex = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
    const disposed = vi.spyOn(tex, 'dispose');
    finish(tex as unknown as THREE.Texture<HTMLImageElement>);
    expect(await pending).toBe(false);
    expect(initTexture).not.toHaveBeenCalled();
    expect(disposed).toHaveBeenCalled();
  });
});
