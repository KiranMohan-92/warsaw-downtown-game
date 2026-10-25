import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { boxMinMax } from './builder.ts';
import { surfaceOfMaterial } from './surfaces.ts';
import type { MapDefinition } from './types.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('impact surfaces (presentation only)', () => {
  it('maps materials to what they sound like', () => {
    expect(surfaceOfMaterial('container')).toBe('metal');
    expect(surfaceOfMaterial('wood')).toBe('wood');
    expect(surfaceOfMaterial('glass')).toBe('glass');
    expect(surfaceOfMaterial('concrete')).toBe('stone');
    expect(surfaceOfMaterial('foliage')).toBe('soft');
  });

  it('a world raycast reports the surface of the collider it hit', () => {
    const map: MapDefinition = {
      name: 'surfaces',
      bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      boxes: [
        boxMinMax({ x: -20, y: -1, z: -20 }, { x: 20, y: 0, z: 20 }, 'asphalt'),
        boxMinMax({ x: -1, y: 0, z: -6 }, { x: 1, y: 2, z: -5 }, 'container'),
      ],
      spawns: [],
      dummies: [],
    };
    const world = new PhysicsWorld(map);
    expect(world.castRay({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 20)?.surface).toBe('metal');
    expect(world.castRay({ x: 5, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, 5)?.surface).toBe('stone');
    world.free();
  });
});
