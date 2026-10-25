import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMap, resolveMap } from '@wd/shared';
import { addWetness } from './materials.ts';
import { addCourtyardBake } from './courtyardBake.ts';
import { MARKET_NEON_BAKE as bake } from './marketNeonBakeManifest.ts';
import {
  acceptsMarketNeonBake,
  addMarketNeonBake,
  loadMarketNeonBake,
  MARKET_NEON_FRAGMENT,
  marketNeonUv,
  setMarketNeonBakeMap,
  setMarketNeonBakeWeather,
} from './marketNeonBake.ts';

const market = () => resolveMap(getMap('defilad'), 'market');
const texture = () =>
  new THREE.DataTexture(new Uint8Array(bake.width * bake.height * 4), bake.width, bake.height);

describe('night-market Cycles ground illumination', () => {
  afterEach(() => {
    setMarketNeonBakeMap(getMap('range'));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('matches the current map, disables stale obstacle geometry, and preserves row orientation', () => {
    expect(acceptsMarketNeonBake(market())).toBe(true);
    const changed = structuredClone(market());
    changed.boxes[0]!.center.x += 1;
    expect(acceptsMarketNeonBake(changed)).toBe(false);
    expect(acceptsMarketNeonBake(getMap('range'))).toBe(false);
    expect(marketNeonUv(76, 30)).toEqual([0, 0]);
    expect(marketNeonUv(112, 62)).toEqual([1, 1]);
  });

  it('chains existing paving/entrance shading, uploads linear light, and gates it by weather', async () => {
    const material = new THREE.MeshStandardMaterial();
    addWetness(material);
    addCourtyardBake(material);
    addMarketNeonBake(material);
    const key = material.customProgramCacheKey();
    addMarketNeonBake(material);
    expect(material.customProgramCacheKey()).toBe(key);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain(MARKET_NEON_FRAGMENT);
    expect(shader.fragmentShader).toContain('cbIrradiance');
    expect(shader.fragmentShader).toContain('mnNormal.y > 0.75');
    expect(shader.fragmentShader.indexOf(MARKET_NEON_FRAGMENT)).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <aomap_fragment>'),
    );
    setMarketNeonBakeMap(market());
    setMarketNeonBakeWeather('neon', 0.95);
    expect(shader.uniforms.uMnGain!.value).toBe(0);
    const tex = texture();
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(
      tex as unknown as THREE.Texture<HTMLImageElement>,
    );
    const initTexture = vi.fn();
    expect(await loadMarketNeonBake({ initTexture } as unknown as THREE.WebGLRenderer)).toBe(true);
    expect(initTexture).toHaveBeenCalledWith(tex);
    expect(shader.uniforms.uMnGain!.value).toBe(0.95);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    expect(tex.flipY).toBe(false);
    setMarketNeonBakeWeather('sunny', 1);
    expect(shader.uniforms.uMnGain!.value).toBe(0);
    material.dispose();
  });

  it('rejects corrupt dimensions before GPU upload', async () => {
    setMarketNeonBakeMap(market());
    const tex = new THREE.DataTexture(new Uint8Array(16), 2, 2);
    const dispose = vi.spyOn(tex, 'dispose');
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(
      tex as unknown as THREE.Texture<HTMLImageElement>,
    );
    const initTexture = vi.fn();
    await expect(
      loadMarketNeonBake({ initTexture } as unknown as THREE.WebGLRenderer),
    ).rejects.toThrow('dimensions');
    expect(initTexture).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases a texture when GPU upload fails and leaves illumination disabled', async () => {
    setMarketNeonBakeMap(market());
    const tex = texture();
    const dispose = vi.spyOn(tex, 'dispose');
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(
      tex as unknown as THREE.Texture<HTMLImageElement>,
    );
    const renderer = {
      initTexture: () => {
        throw new Error('GPU upload failed');
      },
    };
    await expect(loadMarketNeonBake(renderer as unknown as THREE.WebGLRenderer)).rejects.toThrow(
      'GPU upload failed',
    );
    expect(dispose).toHaveBeenCalledOnce();
    const material = new THREE.MeshStandardMaterial();
    addWetness(material);
    addMarketNeonBake(material);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.uMnGain!.value).toBe(0);
    material.dispose();
  });

  it('disposes a late texture after timeout instead of uploading it into the fallback', async () => {
    vi.useFakeTimers();
    setMarketNeonBakeMap(market());
    let finish!: (tex: THREE.Texture<HTMLImageElement>) => void;
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const initTexture = vi.fn();
    const result = loadMarketNeonBake({ initTexture } as unknown as THREE.WebGLRenderer);
    const rejected = expect(result).rejects.toThrow('Night-market illumination');
    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;
    const tex = texture();
    const dispose = vi.spyOn(tex, 'dispose');
    finish(tex as unknown as THREE.Texture<HTMLImageElement>);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(initTexture).not.toHaveBeenCalled();
  });
});
