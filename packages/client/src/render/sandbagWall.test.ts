import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { quatFromEulerDeg, rotateByQuat, sandbags, type MapDefinition } from '@wd/shared';
import {
  SANDBAG_COURSES,
  SANDBAG_LOD_DISTANCE,
  SANDBAG_BAG_TRIS,
  SANDBAG_OVERHANG,
  emitSandbagWall,
  sandbagLayout,
  type BagVertex,
} from './sandbagWall.ts';
import { buildMapMeshes, showAllLodLevels } from './mapMesh.ts';
import { MapMaterials } from './materials.ts';

const wall = sandbags({ x: 12, z: -4, rot: 37 }, 4)[0]!;

describe('sandbag walls as bags', () => {
  it('lays half-bond courses of two rows, half bags at the ends of alternate courses', () => {
    const bags = sandbagLayout(wall);
    const n = Math.round(wall.size.x / 0.6);
    // Even courses: n bags per row; odd: n − 1 whole + 2 halves.
    let expected = 0;
    for (let c = 0; c < SANDBAG_COURSES; c++) {
      for (let r = 0; r < 2; r++) expected += (c + r) % 2 ? n + 1 : n;
    }
    expect(bags.length).toBe(expected);
    const short = bags.filter((b) => b.len < (wall.size.x / n) * 0.7);
    expect(short.length).toBeGreaterThanOrEqual(SANDBAG_COURSES * 2 - 2);
    // Deterministic per wall: every client lays the same bags.
    expect(sandbagLayout(wall)).toEqual(bags);
  });

  it('stays within a few cm of the collision box, with an uneven top line', () => {
    const q = quatFromEulerDeg(wall.rot);
    const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const verts: BagVertex[] = [];
    let tris = 0;
    const bags = emitSandbagWall(
      wall,
      (v) => verts.push(v) - 1,
      () => tris++,
    );
    expect(tris).toBe(bags * SANDBAG_BAG_TRIS);
    const tops = new Map<number, number>();
    for (const v of verts) {
      const l = rotateByQuat(
        { x: v.p.x - wall.center.x, y: v.p.y - wall.center.y, z: v.p.z - wall.center.z },
        inv,
      );
      expect(Math.abs(l.x)).toBeLessThanOrEqual(wall.size.x / 2 + SANDBAG_OVERHANG + 0.03);
      expect(Math.abs(l.z)).toBeLessThanOrEqual(wall.size.z / 2 + SANDBAG_OVERHANG);
      expect(l.y).toBeLessThanOrEqual(wall.size.y / 2 + SANDBAG_OVERHANG);
      expect(l.y).toBeGreaterThanOrEqual(-wall.size.y / 2 - SANDBAG_OVERHANG);
      // One lightmap face per bag (its row's side): never interpolated across atlas rects.
      expect([4, 5]).toContain(v.lmFace);
      const slot = Math.round(l.x * 4);
      tops.set(slot, Math.max(tops.get(slot) ?? -1, l.y));
    }
    const top = [...tops.values()];
    expect(Math.max(...top) - Math.min(...top)).toBeGreaterThan(0.03);
    expect(Math.max(...top)).toBeGreaterThan(wall.size.y / 2 - 0.03);
  });

  it('draws bags up close and the box beyond, one material, in the map mesh', () => {
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect: () => {} }),
      }),
    });
    const map: MapDefinition = {
      name: 'sandbag-test',
      bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      boxes: [wall],
      spawns: [],
      dummies: [],
    };
    const mats = new MapMaterials(1);
    const group = buildMapMeshes(map, mats, { bakes: [] });
    const lod = group.children.find((c) => c instanceof THREE.LOD) as THREE.LOD;
    expect(lod).toBeDefined();
    expect(lod.levels.map((l) => l.distance)).toEqual([0, SANDBAG_LOD_DISTANCE]);
    const [near, far] = lod.levels.map((l) => l.object as THREE.Mesh);
    expect(near!.material).toBe(mats.get('sandbag'));
    expect(far!.material).toBe(mats.get('sandbag'));
    expect(near!.geometry.getIndex()!.count).toBeGreaterThan(far!.geometry.getIndex()!.count * 20);
    // World-space geometry under an LOD at the wall: the meshes sit back at the origin.
    lod.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(far!);
    expect(
      box.getCenter(new THREE.Vector3()).distanceTo(new THREE.Vector3(12, 0.475, -4)),
    ).toBeLessThan(0.01);
    // Back faces cast the sandbags' shadow (rounded bags never shade themselves in stripes).
    expect(mats.get('sandbag').shadowSide).toBe(THREE.BackSide);
    vi.unstubAllGlobals();
  });

  it('warm-up draws both sandbag levels, then hands level choice back to the renderer', () => {
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect: () => {} }),
      }),
    });
    const map: MapDefinition = {
      name: 'sandbag-warm',
      bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      boxes: [wall],
      spawns: [],
      dummies: [],
    };
    const group = buildMapMeshes(map, new MapMaterials(1), { bakes: [] });
    group.updateMatrixWorld(true);
    const lod = group.children.find((c) => c instanceof THREE.LOD) as THREE.LOD;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(12, 1.6, -2); // right by the wall: the renderer would draw only the bags
    camera.updateMatrixWorld();
    lod.update(camera);
    expect(lod.levels.map((l) => l.object.visible)).toEqual([true, false]);
    const restore = showAllLodLevels(group);
    expect(lod.autoUpdate).toBe(false);
    expect(lod.levels.every((l) => l.object.visible)).toBe(true);
    restore();
    expect(lod.autoUpdate).toBe(true);
    camera.position.set(500, 1.6, 500);
    camera.updateMatrixWorld();
    lod.update(camera);
    expect(lod.levels.map((l) => l.object.visible)).toEqual([false, true]);
    vi.unstubAllGlobals();
  });
});

describe('sandbag bags only within reach of the playable area', () => {
  it('keeps far-off walls as plain boxes in the map chunk (no bags, no LOD)', () => {
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect: () => {} }),
      }),
    });
    const farWall = sandbags({ x: 400, z: 400, rot: 0 }, 4)[0]!;
    const map: MapDefinition = {
      name: 'sandbag-reach',
      bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      boxes: [wall, farWall],
      spawns: [],
      dummies: [],
    };
    const group = buildMapMeshes(map, new MapMaterials(1), { bakes: [] });
    const lods = group.children.filter((c) => c instanceof THREE.LOD);
    expect(lods.length).toBe(1);
    const box = group.children.find(
      (c) => c instanceof THREE.Mesh && c.name.startsWith('map:sandbag|256:'),
    ) as THREE.Mesh;
    expect(box.geometry.getIndex()!.count).toBe(36);
    vi.unstubAllGlobals();
  });
});
