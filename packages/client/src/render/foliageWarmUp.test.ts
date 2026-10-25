import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { foliageMaterials, warmFoliage } from './foliageMesh.ts';

function fixture(fail = false) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const originalTarget = new THREE.WebGLRenderTarget(2, 2);
  let target: THREE.WebGLRenderTarget | null = originalTarget;
  let face = 2;
  let level = 1;
  let uploads = 0;
  let disposals = 0;
  const error = new Error('compile unavailable');
  const calls: {
    target: THREE.WebGLRenderTarget | null;
    tone: THREE.ToneMapping;
    materials: THREE.Material[];
  }[] = [];
  const renderer = {
    toneMapping: THREE.CineonToneMapping as THREE.ToneMapping,
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => level,
    setRenderTarget(next: THREE.WebGLRenderTarget | null, f = 0, l = 0) {
      target = next;
      face = f;
      level = l;
    },
    initTexture(texture: THREE.Texture) {
      expect(texture).toBe(foliageMaterials().atlas);
      uploads++;
    },
    compileAsync(proxies: THREE.Group, view: THREE.Camera, destination: THREE.Scene) {
      expect(view).toBe(camera);
      expect(destination).toBe(scene);
      const materials = proxies.children.map((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh instanceof THREE.InstancedMesh) {
          expect(mesh.count).toBe(1);
          expect(mesh.instanceColor).not.toBeNull();
        } else {
          expect(mesh.geometry.getAttribute('aFoliageRoot')).toBeDefined();
        }
        expect(mesh.receiveShadow).toBe(true);
        // Count only once even though the same proxies are compiled for both output paths.
        if (calls.length === 0)
          (mesh as THREE.Object3D).addEventListener('dispose', () => disposals++);
        return mesh.material as THREE.Material;
      });
      calls.push({ target, tone: renderer.toneMapping, materials });
      return fail ? Promise.reject(error) : Promise.resolve(new Set(materials));
    },
  };
  return {
    scene,
    camera,
    renderer,
    calls,
    error,
    verifyRestored() {
      expect(target).toBe(originalTarget);
      expect(face).toBe(2);
      expect(level).toBe(1);
      expect(renderer.toneMapping).toBe(THREE.CineonToneMapping);
      expect(uploads).toBe(1);
      expect(disposals).toBe(4);
      expect(scene.children.length).toBe(0);
      originalTarget.dispose();
    },
  };
}

describe('foliage warm-up', () => {
  it('prepares lit and shadow programs for canvas and HDR before play, even offscreen', async () => {
    const f = fixture();
    await warmFoliage(f.renderer as unknown as THREE.WebGLRenderer, f.scene, f.camera);
    expect(f.calls.length).toBe(4);
    expect(f.calls[0]!.target).toBeNull();
    expect(f.calls[0]!.tone).toBe(THREE.AgXToneMapping);
    expect(f.calls[1]!.target!.texture.type).toBe(THREE.HalfFloatType);
    expect(f.calls[1]!.tone).toBe(THREE.NoToneMapping);
    const { lit, depth } = foliageMaterials();
    for (const call of f.calls) expect(call.materials).toEqual([lit, lit, depth, depth]);
    f.verifyRestored();
  });

  it('restores renderer state and releases proxies if compilation fails', async () => {
    const f = fixture(true);
    let thrown: unknown;
    try {
      await warmFoliage(f.renderer as unknown as THREE.WebGLRenderer, f.scene, f.camera);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(f.error);
    f.verifyRestored();
  });
});
