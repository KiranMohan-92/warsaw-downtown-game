import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMap, resolveMap } from '@wd/shared';
import { addWetness } from './materials.ts';
import { MARKET_NEON_STATIC_BAKE as bake } from './marketNeonStaticManifest.ts';
import {
  acceptsMarketNeonStaticBake,
  addMarketNeonStaticBake,
  loadMarketNeonStaticBake,
  MARKET_NEON_STATIC_FRAGMENT,
  marketNeonStaticMaterial,
  setMarketNeonStaticBakeMap,
  setMarketNeonStaticBakeWeather,
} from './marketNeonStaticBake.ts';

const market = () => resolveMap(getMap('defilad'), 'market');
const texture = () =>
  new THREE.DataTexture(new Uint8Array(bake.width * bake.height * 4), bake.width, bake.height);
const compiled = (material: THREE.MeshStandardMaterial) => {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
};

describe('night-market static receiver illumination', () => {
  afterEach(() => {
    setMarketNeonStaticBakeMap(getMap('range'));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('matches exact layout/obstacles and excludes incompatible maps and unselected materials', () => {
    expect(acceptsMarketNeonStaticBake(market())).toBe(true);
    const changed = structuredClone(market());
    changed.boxes[0]!.center.x += 1;
    expect(acceptsMarketNeonStaticBake(changed)).toBe(false);
    expect(acceptsMarketNeonStaticBake(getMap('range'))).toBe(false);
    expect(marketNeonStaticMaterial('container')).toBe(true);
    expect(marketNeonStaticMaterial('grass')).toBe(false);
    expect(bake.width * bake.height * 4).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it('preserves wetness and earlier lighting, adds one atlas fetch after AO, and excludes Low', () => {
    const mat = new THREE.MeshStandardMaterial();
    addWetness(mat);
    const old = mat.onBeforeCompile.bind(mat);
    mat.onBeforeCompile = (shader, renderer) => {
      old(shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\n// existing ceiling lamp',
      );
    };
    const base = mat.customProgramCacheKey();
    addMarketNeonStaticBake(mat);
    const key = mat.customProgramCacheKey();
    addMarketNeonStaticBake(mat);
    expect(mat.customProgramCacheKey()).toBe(key);
    expect(key).toBe(`${base}|market-neon-static-v1`);
    const shader = compiled(mat);
    expect(shader.vertexShader).toContain('instanceMatrix * wetWorld');
    expect(shader.fragmentShader).toContain('roughnessFactor = mix');
    expect(shader.fragmentShader).toContain('// existing ceiling lamp');
    expect(shader.fragmentShader).toContain(MARKET_NEON_STATIC_FRAGMENT);
    expect(shader.fragmentShader.indexOf(MARKET_NEON_STATIC_FRAGMENT)).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <aomap_fragment>'),
    );
    expect(shader.fragmentShader.match(/texture2D\( uMnsMap/g)).toHaveLength(1);
    expect(shader.fragmentShader).toContain('defined( USE_AOMAP ) && !defined( TONE_MAPPING )');
    expect(shader.fragmentShader).not.toContain('vWetPos.xz');
    mat.dispose();
  });

  it('uploads linear, unmipped UV1 light before enabling its weather gain', async () => {
    setMarketNeonStaticBakeMap(market());
    setMarketNeonStaticBakeWeather('neon', 0.95);
    const mat = new THREE.MeshStandardMaterial();
    addMarketNeonStaticBake(mat);
    const shader = compiled(mat);
    expect(shader.uniforms.uMnsGain!.value).toBe(0);
    const tex = texture();
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(
      tex as unknown as THREE.Texture<HTMLImageElement>,
    );
    const initTexture = vi.fn(() => expect(shader.uniforms.uMnsGain!.value).toBe(0));
    expect(await loadMarketNeonStaticBake({ initTexture } as unknown as THREE.WebGLRenderer)).toBe(
      true,
    );
    expect(initTexture).toHaveBeenCalledWith(tex);
    expect(shader.uniforms.uMnsMap!.value).toBe(tex);
    expect(shader.uniforms.uMnsGain!.value).toBe(0.95);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    expect(tex.flipY).toBe(false);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.minFilter).toBe(THREE.LinearFilter);
    setMarketNeonStaticBakeWeather('sunny', 1);
    expect(shader.uniforms.uMnsGain!.value).toBe(0);
    setMarketNeonStaticBakeWeather('neon', Number.NaN);
    expect(shader.uniforms.uMnsGain!.value).toBe(0);
    const dispose = vi.spyOn(tex, 'dispose');
    setMarketNeonStaticBakeMap(getMap('range'));
    expect(dispose).toHaveBeenCalledOnce();
    expect(shader.uniforms.uMnsGain!.value).toBe(0);
    mat.dispose();
  });

  it('rejects wrong dimensions and failed GPU uploads without activating a surface bake', async () => {
    setMarketNeonStaticBakeMap(market());
    const tex = new THREE.DataTexture(new Uint8Array(16), 2, 2);
    const dispose = vi.spyOn(tex, 'dispose');
    const loader = vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync');
    loader.mockResolvedValue(tex as unknown as THREE.Texture<HTMLImageElement>);
    const initTexture = vi.fn();
    await expect(
      loadMarketNeonStaticBake({ initTexture } as unknown as THREE.WebGLRenderer),
    ).rejects.toThrow('dimensions');
    expect(initTexture).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    const valid = texture();
    const disposeValid = vi.spyOn(valid, 'dispose');
    loader.mockResolvedValue(valid as unknown as THREE.Texture<HTMLImageElement>);
    await expect(
      loadMarketNeonStaticBake({
        initTexture: () => {
          throw new Error('GPU upload failed');
        },
      } as unknown as THREE.WebGLRenderer),
    ).rejects.toThrow('GPU upload failed');
    expect(disposeValid).toHaveBeenCalledOnce();
    const mat = new THREE.MeshStandardMaterial();
    addMarketNeonStaticBake(mat);
    expect(compiled(mat).uniforms.uMnsGain!.value).toBe(0);
    mat.dispose();
  });

  it.each(['timeout', 'map change'] as const)('releases a late decode after %s', async (reason) => {
    vi.useFakeTimers();
    setMarketNeonStaticBakeMap(market());
    let finish!: (tex: THREE.Texture<HTMLImageElement>) => void;
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const initTexture = vi.fn();
    const result = loadMarketNeonStaticBake({ initTexture } as unknown as THREE.WebGLRenderer);
    if (reason === 'timeout') {
      const rejected = expect(result).rejects.toThrow('surface illumination');
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
    } else setMarketNeonStaticBakeMap(getMap('range'));
    const tex = texture();
    const dispose = vi.spyOn(tex, 'dispose');
    finish(tex as unknown as THREE.Texture<HTMLImageElement>);
    if (reason === 'map change') expect(await result).toBe(false);
    else await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(initTexture).not.toHaveBeenCalled();
  });
});
