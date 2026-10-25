import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { JammerFx } from './tacticalFx.ts';

describe('jammer pulse', () => {
  it('reuses a fixed pool: never disposes (a freed program would recompile mid-game)', () => {
    const fx = new JammerFx();
    const meshes = fx.group.children as THREE.Mesh[];
    const disposed = meshes.map((m) => vi.spyOn(m.material as THREE.Material, 'dispose'));
    const geoDispose = vi.spyOn(meshes[0]!.geometry, 'dispose');
    for (let i = 0; i < 10; i++) {
      fx.pulse({ x: i, y: 0, z: 0 });
      fx.update(0.2);
    }
    fx.update(5);
    expect(fx.group.children).toHaveLength(meshes.length); // nothing added or removed
    expect(fx.active).toBe(0);
    for (const d of disposed) expect(d).not.toHaveBeenCalled();
    expect(geoDispose).not.toHaveBeenCalled();
  });

  it('a pulse expands to the jammer radius and fades out in 0.6 s', () => {
    const fx = new JammerFx();
    fx.pulse({ x: 0, y: 0, z: 0 });
    expect(fx.active).toBe(1);
    fx.update(0.3);
    const ring = (fx.group.children as THREE.Mesh[]).find((m) => m.visible)!;
    expect(ring.scale.x).toBeGreaterThan(1);
    fx.update(0.31);
    expect(fx.active).toBe(0);
  });
});
