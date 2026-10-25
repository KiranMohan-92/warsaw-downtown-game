import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JetpackFx } from './jetpackFx.ts';

const down = new THREE.Vector3(0, -1, 0);

describe('jetpack effects', () => {
  it('lights a flame per nozzle, hides the unused ones, and kicks up dust only when low', () => {
    const fx = new JetpackFx();
    // Every flame, glow and the particle draw exist up front (warm-up compiles them hidden).
    const meshes = fx.group.children.length;
    expect(meshes).toBeGreaterThanOrEqual(12 * 3 + 1);
    const at = new THREE.Vector3(0, 4, 0);
    for (let i = 0; i < 120; i++) {
      fx.begin(1 / 60);
      fx.nozzle(at, down, 1, 1 / 60, 3.9);
      fx.nozzle(at, down, 1, 1 / 60, 3.9);
      fx.end(1 / 60);
    }
    expect(fx.stats.flames).toBe(2);
    const high = fx.stats.particles; // smoke only: the ground is beyond the dust reach
    for (let i = 0; i < 120; i++) {
      fx.begin(1 / 60);
      fx.nozzle(at, down, 1, 1 / 60, 0.8);
      fx.end(1 / 60);
    }
    expect(fx.stats.flames).toBe(1);
    expect(fx.stats.particles).toBeGreaterThan(high);
    fx.begin(1 / 60);
    fx.end(1 / 60);
    expect(fx.stats.flames).toBe(0);
    expect(fx.group.children.length).toBe(meshes); // pooled: nothing added per frame
  });

  it('the landing puff spawns a dust ring that fades', () => {
    const fx = new JetpackFx();
    fx.landPuff(new THREE.Vector3(1, 0, 2));
    fx.begin(0.016);
    fx.end(0.016);
    expect(fx.stats.particles).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < 200; i++) {
      fx.begin(0.016);
      fx.end(0.016);
    }
    expect(fx.stats.particles).toBe(0);
  });
});
