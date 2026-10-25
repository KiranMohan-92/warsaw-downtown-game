import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCanopyScan } from './foliageMesh.ts';
import { HERO_TIMEOUT_MS, loadHeroModel } from './heroModels.ts';
import { SKY_PHOTO_TIMEOUT_MS, SkyDome } from './sky.ts';

// Game.create awaits these before warm-up: a server that never answers must not hang startup
// (review fix). Each rejects after its timeout, so the caller keeps the procedural fallback.

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const initTexture = vi.fn();
const renderer = {
  initTexture,
  capabilities: { getMaxAnisotropy: () => 1 },
} as unknown as THREE.WebGLRenderer;

/** Settle `p` into a result without letting a rejection go unhandled while timers advance. */
function track(p: Promise<unknown>): { state: () => 'pending' | 'resolved' | Error } {
  let state: 'pending' | 'resolved' | Error = 'pending';
  p.then(
    () => (state = 'resolved'),
    (e: unknown) => (state = e instanceof Error ? e : new Error(String(e))),
  );
  return { state: () => state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  initTexture.mockClear();
});

describe('startup loads are bounded', () => {
  it('the sky photo gives up and keeps the procedural sky', async () => {
    vi.useFakeTimers();
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(() => never());
    const sky = new SkyDome(renderer);
    const load = track(sky.loadPhoto(renderer, '/env/sky_sunny.webp', 4));
    await vi.advanceTimersByTimeAsync(SKY_PHOTO_TIMEOUT_MS - 1);
    expect(load.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(String(load.state())).toMatch(/timed out/);
    sky.setPhoto(1, 1);
    const u = sky.mesh.material as THREE.ShaderMaterial;
    expect((u.uniforms.uPhotoMix as THREE.IUniform<number>).value).toBe(0);
    expect(initTexture).not.toHaveBeenCalled();
  });

  it('the canopy scan gives up (the painted tile stays)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => never()),
    );
    const load = track(loadCanopyScan(renderer, '/tex/canopy_albedo.webp', 5000));
    await vi.advanceTimersByTimeAsync(4999);
    expect(load.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(String(load.state())).toMatch(/timed out/);
    expect(initTexture).not.toHaveBeenCalled();
  });

  it('the standalone medkit model gives up like the other hero models', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => never()),
    );
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(() => never());
    const load = track(loadHeroModel(renderer, 'medkit', { base: 'http://localhost/' }));
    await vi.advanceTimersByTimeAsync(HERO_TIMEOUT_MS - 1);
    expect(load.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(String(load.state())).toMatch(/timed out/);
    expect(initTexture).not.toHaveBeenCalled();
  });
});
