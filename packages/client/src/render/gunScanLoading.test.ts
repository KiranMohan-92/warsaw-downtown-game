import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunScanLoadStats, loadGunScans, SCAN_GUN_IDS } from './viewGunScans.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('all-primary scan loading', () => {
  it('loads every gun and shares the arms textures, resizing before the first Low upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              url.endsWith('arms.json')
                ? { poses: Object.fromEntries(SCAN_GUN_IDS.map((id) => [id, {}])) }
                : { guns: {} },
            ),
        }),
      ),
    );
    const drawImage = vi.fn();
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage }) }),
    });
    const textures = vi
      .spyOn(THREE.TextureLoader.prototype, 'loadAsync')
      .mockImplementation(() =>
        Promise.resolve(new THREE.Texture({ width: 1024, height: 1024 } as HTMLImageElement)),
      );
    const models = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(() => {
      const scene = new THREE.Group();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.8)));
      return Promise.resolve({ scene } as GLTF);
    });
    const uploaded: [number, number][] = [];
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4 },
      initTexture: (texture: THREE.Texture) => {
        const image = texture.image as HTMLCanvasElement;
        uploaded.push([image.width, image.height]);
      },
    } as unknown as THREE.WebGLRenderer;
    const scans = await loadGunScans(renderer, { lowRes: true, base: '/' });
    expect([...scans.keys()]).toEqual(SCAN_GUN_IDS);
    expect(textures).toHaveBeenCalledTimes(25); // Seven gun triplets + one shared arms set.
    expect(models).toHaveBeenCalledTimes(14);
    expect(drawImage).toHaveBeenCalledTimes(25);
    expect(uploaded).toEqual(Array.from({ length: 25 }, () => [512, 512]));
    expect(new Set([...scans.values()].map((scan) => scan.arms!.material)).size).toBe(1);
    const stats = gunScanLoadStats(scans)!;
    expect(stats.gunCount).toBe(7);
    expect(stats.lowRes).toBe(true);
    expect(stats.textureBytes).toBe(25 * 1_398_100);
    expect(stats.geometryBytes).toBeGreaterThan(0);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
