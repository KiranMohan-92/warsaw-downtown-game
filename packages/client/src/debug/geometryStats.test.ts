import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { trackShadowGeometry } from './geometryStats.ts';

describe('shadow geometry counters', () => {
  it('accumulates shadow work across passes, excluding earlier colour draws, and resets', () => {
    const info = { render: { calls: 5, triangles: 80 } };
    const shadowMap: Pick<THREE.WebGLShadowMap, 'render'> = {
      render: () => {
        info.render.calls += 2;
        info.render.triangles += 30;
      },
    };
    const stats = trackShadowGeometry({ info, shadowMap });
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    shadowMap.render([], scene, camera);
    info.render.triangles += 100;
    shadowMap.render([], scene, camera);
    expect(stats.calls).toBe(4);
    expect(stats.triangles).toBe(60);
    stats.reset();
    expect(stats.calls).toBe(0);
    expect(stats.triangles).toBe(0);
  });
});
