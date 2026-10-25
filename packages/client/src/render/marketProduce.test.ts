import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  installProduceDetail,
  updateProduceDetail,
  PRODUCE_DETAIL_LIMIT,
  showProduceDetailForWarmup,
} from './marketProduce.ts';

function fixture(count = 3): {
  group: THREE.Group;
  coarse: THREE.InstancedMesh;
  material: THREE.Material;
} {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  const geo = new THREE.SphereGeometry(1, 6, 4);
  const light = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
  geo.setAttribute('aStallLight', light);
  const coarse = new THREE.InstancedMesh(geo, material, count);
  for (let i = 0; i < count; i++) {
    coarse.setMatrixAt(
      i,
      new THREE.Matrix4().compose(
        new THREE.Vector3(i * 0.002, 1, 0),
        new THREE.Quaternion(),
        new THREE.Vector3(0.04, 0.035, 0.04),
      ),
    );
    coarse.setColorAt(i, new THREE.Color(i % 2 ? 0xffaa22 : 0x881122));
    light.setXYZW(i, 0.7, 0.01 * i, 0.7, 0.1);
  }
  coarse.computeBoundingBox();
  coarse.computeBoundingSphere();
  coarse.userData.fruit = true;
  const group = new THREE.Group();
  group.add(coarse);
  return { group, coarse, material };
}

describe('bounded near produce', () => {
  it('draws a fine instance during warm-up and restores selection, visibility and resources', () => {
    const { group, coarse, material } = fixture();
    const fine = installProduceDetail(group, material);
    const matrix = new Float32Array(coarse.instanceMatrix.array);
    const resources = [fine.geometry, fine.material, fine.instanceMatrix, fine.instanceColor];
    expect(fine.count).toBe(0);
    const restore = showProduceDetailForWarmup(group);
    expect(fine.count).toBe(1);
    expect(fine.visible).toBe(true);
    restore();
    expect(fine.count).toBe(0);
    expect(fine.visible).toBe(false);
    expect(Array.from(coarse.instanceMatrix.array)).toEqual(Array.from(matrix));
    updateProduceDetail(group, new THREE.Vector3(0, 1, 0));
    const count = fine.count;
    const restoreSelected = showProduceDetailForWarmup(group);
    restoreSelected();
    expect(fine.count).toBe(count);
    expect(fine.visible).toBe(true);
    expect([fine.geometry, fine.material, fine.instanceMatrix, fine.instanceColor]).toEqual(
      resources,
    );
  });

  it('caps a single smooth draw and selects the nearest fruit', () => {
    const { group, coarse, material } = fixture(PRODUCE_DETAIL_LIMIT + 30);
    const fine = installProduceDetail(group, material);
    expect(installProduceDetail(group, material)).toBe(fine);
    updateProduceDetail(group, new THREE.Vector3(0, 1, 0));
    expect(fine.count).toBe(PRODUCE_DETAIL_LIMIT);
    expect(fine.material).toBe(coarse.material);
    expect((fine.geometry.index!.count / 3) * fine.count).toBe(32768);
    expect(fine.castShadow).toBe(false);
    expect(fine.receiveShadow).toBe(false);
    expect(group.children.filter((o) => o.name === 'dressing:produce-detail')).toHaveLength(1);
    // The first omitted instance remains full size, rather than disappearing with the chunk.
    expect(coarse.instanceMatrix.array[PRODUCE_DETAIL_LIMIT * 16]).toBeCloseTo(0.04, 5);
    expect(coarse.instanceMatrix.array[0]).toBeLessThan(0.000001);
    expect(coarse.instanceMatrix.array[0]).toBeGreaterThan(0);
  });

  it('copies exact near transforms, colours and lighting, then restores every coarse transform on teleport', () => {
    const { group, coarse, material } = fixture();
    const original = new Float32Array(coarse.instanceMatrix.array);
    const fine = installProduceDetail(group, material);
    updateProduceDetail(group, new THREE.Vector3(0, 1, 0));
    expect(Array.from(fine.instanceMatrix.array.slice(0, 16))).toEqual(
      Array.from(original.slice(0, 16)),
    );
    expect(Array.from(fine.instanceColor!.array.slice(0, 9))).toEqual(
      Array.from(coarse.instanceColor!.array),
    );
    expect(Array.from(fine.geometry.getAttribute('aStallLight').array.slice(0, 12))).toEqual(
      Array.from(coarse.geometry.getAttribute('aStallLight').array),
    );
    const version = coarse.instanceMatrix.version;
    updateProduceDetail(group, new THREE.Vector3(0.01, 1, 0));
    expect(coarse.instanceMatrix.version).toBe(version);
    updateProduceDetail(group, new THREE.Vector3(100, 1, 100));
    expect(fine.count).toBe(0);
    expect(fine.visible).toBe(false);
    expect(Array.from(coarse.instanceMatrix.array)).toEqual(Array.from(original));
  });

  it('does not resurrect a culled chunk or exceed the detail radius', () => {
    const { group, coarse, material } = fixture();
    const fine = installProduceDetail(group, material);
    coarse.visible = false;
    updateProduceDetail(group, new THREE.Vector3(0, 1, 0));
    expect(fine.count).toBe(0);
    coarse.visible = true;
    updateProduceDetail(group, new THREE.Vector3(0, 1, 4));
    expect(fine.count).toBe(0);
    updateProduceDetail(group, new THREE.Vector3(0, 1, 0.2));
    expect(fine.count).toBe(3);
    const normals = fine.geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++)
      expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))).toBeCloseTo(1, 5);
  });
});
