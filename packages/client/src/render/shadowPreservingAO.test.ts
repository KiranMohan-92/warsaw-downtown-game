import * as THREE from 'three';
import { N8AOPostPass } from 'n8ao';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShadowPreservingAOPass } from './shadowPreservingAO.ts';

describe('AO shadow preservation', () => {
  afterEach(() => vi.restoreAllMocks());

  // No WebGL constructor needed: exercise the real override with the parent render stubbed.
  const pass = () => Object.create(ShadowPreservingAOPass.prototype) as ShadowPreservingAOPass;
  const renderer = (autoUpdate: boolean, needsUpdate: boolean) => {
    const shadowMap = { autoUpdate, needsUpdate, enabled: true };
    return { shadowMap } as unknown as THREE.WebGLRenderer;
  };

  it('keeps the complete main shadow map through two filtered transparency draws', () => {
    const r = renderer(true, false);
    let visibleCaster = 'whole world';
    let shadowContents = '';
    let refreshes = 0;
    const sceneDraw = () => {
      if (r.shadowMap.autoUpdate || r.shadowMap.needsUpdate) {
        shadowContents = visibleCaster;
        r.shadowMap.needsUpdate = false;
        refreshes++;
      }
    };
    sceneDraw(); // Main shaded pass refreshes current moving actors and world.
    vi.spyOn(N8AOPostPass.prototype, 'render').mockImplementation(() => {
      visibleCaster = 'transparent without depth write';
      sceneDraw();
      visibleCaster = 'transparent with depth write';
      sceneDraw();
    });
    pass().render(r, null, null, 1 / 60, false);
    expect(refreshes).toBe(1);
    expect(shadowContents).toBe('whole world');
    expect(r.shadowMap.autoUpdate).toBe(true);
    visibleCaster = 'next frame moving actors';
    sceneDraw();
    expect(refreshes).toBe(2);
    expect(shadowContents).toBe('next frame moving actors');
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('preserves autoUpdate=%s and needsUpdate=%s with the same pass arguments', (auto, pending) => {
    const r = renderer(auto, pending);
    const input = new THREE.WebGLRenderTarget(1, 1);
    const output = new THREE.WebGLRenderTarget(1, 1);
    const parent = vi.spyOn(N8AOPostPass.prototype, 'render').mockImplementation(() => {
      expect(r.shadowMap.autoUpdate).toBe(false);
      expect(r.shadowMap.needsUpdate).toBe(false);
      expect(r.shadowMap.enabled).toBe(true);
    });
    const p = pass();
    p.render(r, input, output, 0.02, true);
    expect(parent).toHaveBeenCalledExactlyOnceWith(r, input, output, 0.02, true);
    expect(parent.mock.instances[0]).toBe(p);
    expect(r.shadowMap.autoUpdate).toBe(auto);
    expect(r.shadowMap.needsUpdate).toBe(pending);
    input.dispose();
    output.dispose();
  });

  it('restores shadow update state when AO throws', () => {
    const r = renderer(true, true);
    vi.spyOn(N8AOPostPass.prototype, 'render').mockImplementation(() => {
      throw new Error('AO draw failed');
    });
    expect(() => pass().render(r, null, null)).toThrow('AO draw failed');
    expect(r.shadowMap.autoUpdate).toBe(true);
    expect(r.shadowMap.needsUpdate).toBe(true);
    expect(r.shadowMap.enabled).toBe(true);
  });
});
