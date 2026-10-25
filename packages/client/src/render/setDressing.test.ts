import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap, resolveMap, stall, type MapBox, type MapDefinition } from '@wd/shared';
import {
  CANVAS_TEX,
  CANVAS_TILE,
  FRUIT_DISTANCE,
  STALL_DETAIL_DISTANCE,
  buildSetDressing,
  canvasMaps,
  hemDrop,
  updateSetDressing,
  weaveHeight,
  setDressingMaterials,
} from './setDressing.ts';
import type { MapMaterials } from './materials.ts';

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'dressing-test',
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  boxes,
  spawns: [],
  dummies: [],
});

type BatchedMultiDrawState = {
  _multiDrawCount: number;
  _multiDrawStarts: ArrayLike<number>;
  _multiDrawCounts: ArrayLike<number>;
};

function prepareBatch(batch: THREE.BatchedMesh, camera: THREE.Camera): BatchedMultiDrawState {
  camera.updateMatrixWorld(true);
  batch.updateMatrixWorld(true);
  batch.onBeforeRender(
    {} as THREE.WebGLRenderer,
    new THREE.Scene(),
    camera,
    batch.geometry,
    batch.material,
    null as unknown as THREE.Group,
  );
  return batch as unknown as BatchedMultiDrawState;
}

function casterRanges(batch: THREE.BatchedMesh, camera: THREE.Camera): number {
  return prepareBatch(batch, camera)._multiDrawCount;
}

function selectedBatchedIndexRanges(
  batch: THREE.BatchedMesh,
  camera: THREE.Camera,
): { start: number; count: number }[] {
  const state = prepareBatch(batch, camera);
  const index = batch.geometry.getIndex()!;
  const indexBytes = index.array.BYTES_PER_ELEMENT;
  const ranges: { start: number; count: number }[] = [];
  for (let i = 0; i < state._multiDrawCount; i++)
    ranges.push({
      start: state._multiDrawStarts[i]! / indexBytes,
      count: state._multiDrawCounts[i]!,
    });
  return ranges;
}

describe('set dressing', () => {
  it('keeps the authored Market dressing inside the Medium draw-call budget', () => {
    const g = buildSetDressing(resolveMap(getMap('defilad'), 'market'));
    const detailDraws = g.children.filter((o) => o.userData.stallDetail);
    expect(detailDraws).toHaveLength(4); // one draw per existing material across all stalls
    const camera = new THREE.PerspectiveCamera(
      (2 * Math.atan(Math.tan((95 * Math.PI) / 360) / (16 / 9)) * 180) / Math.PI,
      16 / 9,
      0.05,
      500,
    );
    camera.position.set(100, 1.7, 0);
    camera.rotation.set(-0.03, 3.14, 0, 'YXZ');
    updateSetDressing(g, camera.position, camera);
    camera.updateMatrixWorld();
    g.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    let draws = 0;
    let triangles = 0;
    for (const object of g.children) {
      if (
        !(object instanceof THREE.Mesh) ||
        !object.visible ||
        (object.frustumCulled && !frustum.intersectsObject(object))
      )
        continue;
      if (object instanceof THREE.BatchedMesh) {
        const ranges = selectedBatchedIndexRanges(object, camera);
        if (ranges.length > 0) draws++;
        triangles += ranges.reduce((sum, range) => sum + range.count / 3, 0);
        continue;
      }
      draws++;
      const mesh = object as THREE.Mesh<THREE.BufferGeometry>;
      const index = mesh.geometry.getIndex()!;
      triangles +=
        (Math.min(index.count, mesh.geometry.drawRange.count) / 3) *
        (object instanceof THREE.InstancedMesh ? object.count : 1);
    }
    expect(draws).toBeLessThanOrEqual(22);
    expect(triangles).toBeLessThanOrEqual(301296); // same view before Round 3
  });

  it('retains original cell frustum culling when the camera turns in place', () => {
    const stalls = [stall({ x: 2, z: 2 }), stall({ x: 80, z: 2 })];
    const merged = buildSetDressing(mapOf(stalls.flat()));
    const separate = stalls.map((boxes) => buildSetDressing(mapOf(boxes)));
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 500);
    camera.position.set(40, 1.7, 2);
    const frustum = new THREE.Frustum();
    const drawn = (groups: THREE.Group[]): Map<string, number[]> => {
      const result = new Map<string, number[]>();
      for (const group of groups) {
        group.updateMatrixWorld();
        for (const object of group.children) {
          if (
            !(object instanceof THREE.Mesh) ||
            object instanceof THREE.InstancedMesh ||
            !object.visible ||
            !frustum.intersectsObject(object)
          )
            continue;
          const geometry = (object as THREE.Mesh<THREE.BufferGeometry>).geometry;
          const index = geometry.getIndex()!;
          const position = geometry.getAttribute('position');
          const key = object.name.split('|')[0]!;
          const vertices = result.get(key) ?? [];
          const ranges =
            object instanceof THREE.BatchedMesh
              ? selectedBatchedIndexRanges(object, camera)
              : [{ start: 0, count: Math.min(index.count, geometry.drawRange.count) }];
          let added = false;
          for (const { start, count } of ranges) {
            for (let i = start; i < start + count; i++) {
              const vertex = index.getX(i);
              vertices.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
              added = true;
            }
          }
          if (added) result.set(key, vertices);
        }
      }
      return result;
    };
    for (const [x, yaw] of [
      [40, -Math.PI / 2],
      [40, Math.PI / 2],
      [40, 0],
      [10, -Math.PI / 2],
      [10, Math.PI / 2],
      [72, Math.PI / 2],
      [72, -Math.PI / 2],
      [40, -Math.PI / 2],
    ] as const) {
      camera.position.x = x;
      camera.rotation.set(0, yaw, 0, 'YXZ');
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      for (const group of [...separate, merged]) updateSetDressing(group, camera.position, camera);
      expect(drawn([merged])).toEqual(drawn(separate));
    }
  });

  it('merges draws while retaining each original 16 m cell and its independent hysteresis', () => {
    const first = stall({ x: 2, z: 2 });
    const second = stall({ x: 24, z: 2 });
    const merged = buildSetDressing(mapOf([...first, ...second]));
    const separate = [buildSetDressing(mapOf(first)), buildSetDressing(mapOf(second))];
    const drawnIndices = (groups: THREE.Group[]): Map<string, number[]> => {
      const result = new Map<string, number[]>();
      for (const group of groups) {
        for (const object of group.children) {
          if (!(object instanceof THREE.Mesh) || !object.userData.stallDetail || !object.visible)
            continue;
          const geometry = (object as THREE.Mesh<THREE.BufferGeometry>).geometry;
          const index = geometry.getIndex()!;
          const position = geometry.getAttribute('position');
          const key = object.name.split('|')[0]!;
          const values = result.get(key) ?? [];
          const count = Math.min(index.count, geometry.drawRange.count);
          for (let i = 0; i < count; i++) {
            const vertex = index.getX(i);
            values.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
          }
          result.set(key, values);
        }
      }
      return result;
    };
    const meshes = merged.children.filter((o) => o.userData.stallDetail) as THREE.Mesh[];
    const indices = meshes.map((mesh) => mesh.geometry.getIndex());
    // One cell hidden while its merged neighbour remains in view, then each hysteresis edge.
    for (const x of [-22, -18, -24, -18, -16, 48, 52, 48, 44, 100, 2, 24]) {
      const eye = new THREE.Vector3(x, 1.7, 2);
      for (const group of [...separate, merged]) updateSetDressing(group, eye);
      expect(drawnIndices([merged])).toEqual(drawnIndices(separate));
      expect(meshes.map((mesh) => mesh.geometry.getIndex())).toEqual(indices);
    }
    expect(meshes).toHaveLength(separate[0]!.children.filter((o) => o.userData.stallDetail).length);
  });

  it('never lets fittings, fruit, produce or trims enter the shadow pass', () => {
    const group = buildSetDressing(mapOf(stall({ x: 3, z: 4 })));
    const detail = group.children.filter((o) => o.userData.stallDetail);
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.every((o) => !o.castShadow)).toBe(true);
    expect(detail.every((o) => !o.receiveShadow)).toBe(true);
    expect(
      group.children
        .filter((o) => o instanceof THREE.InstancedMesh && o.userData.fruit === true)
        .every((o) => !o.receiveShadow),
    ).toBe(true);
    const casters = group.children.filter((o) => o.castShadow);
    expect(casters.length).toBeGreaterThan(0);
    expect(casters.every((o) => o.name.startsWith('dressing:canvas|'))).toBe(true);
    for (const camera of [new THREE.Vector3(3, 1.7, 5), new THREE.Vector3(200, 1.7, 200)]) {
      updateSetDressing(group, camera);
      expect(group.children.filter((o) => o.castShadow)).toEqual(casters);
      expect(detail.every((o) => !o.castShadow)).toBe(true);
      expect(detail.every((o) => !o.receiveShadow)).toBe(true);
    }
  });

  it('batches static canvas casters without changing chunk bytes or independent culling', () => {
    const stalls = [stall({ x: 2, z: 2 }), stall({ x: 80, z: 2 })];
    const separateCasters = stalls.map((boxes) => {
      const group = buildSetDressing(mapOf(boxes));
      const mesh = group.children.find(
        (o): o is THREE.Mesh<THREE.BufferGeometry> => o instanceof THREE.Mesh && o.castShadow,
      );
      if (!mesh) throw new Error('missing separate canvas caster');
      return mesh;
    });
    const merged = buildSetDressing(mapOf(stalls.flat()));
    const casters = merged.children.filter((o) => o.castShadow);
    expect(casters).toHaveLength(1);
    const batch = casters[0] as THREE.BatchedMesh;
    expect(batch).toBeInstanceOf(THREE.BatchedMesh);
    expect(batch.name).toBe('dressing:canvas|0,0');
    expect(batch.castShadow && batch.receiveShadow).toBe(true);
    expect(batch.matrixAutoUpdate).toBe(false);
    expect(batch.material).toBeInstanceOf(THREE.MeshStandardMaterial);

    let vertex = 0;
    let index = 0;
    for (const [id, source] of separateCasters.entries()) {
      const sphere = new THREE.Sphere();
      batch.getBoundingSphereAt(id, sphere);
      expect(sphere).toEqual(source.geometry.boundingSphere);
      for (const name of Object.keys(source.geometry.attributes)) {
        const attribute = source.geometry.getAttribute(name);
        const packed = batch.geometry.getAttribute(name);
        expect(
          Array.from(packed.array).slice(
            vertex * attribute.itemSize,
            (vertex + attribute.count) * attribute.itemSize,
          ),
        ).toEqual(Array.from(attribute.array));
      }
      const count = source.geometry.index!.count;
      expect(Array.from(batch.geometry.index!.array).slice(index, index + count)).toEqual(
        Array.from(source.geometry.index!.array, (i) => i + vertex),
      );
      index += count;
      vertex += source.geometry.getAttribute('position').count;
    }

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 60);
    camera.position.set(2, 5, 40);
    camera.lookAt(2, 1, 2);
    expect(casterRanges(batch, camera)).toBe(1);
    const shadowCamera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 60);
    shadowCamera.position.set(80, 5, 40);
    shadowCamera.lookAt(80, 1, 2);
    expect(casterRanges(batch, shadowCamera)).toBe(1);
    batch.frustumCulled = false;
    expect(casterRanges(batch, camera)).toBe(2);
    expect(batch.perObjectFrustumCulled).toBe(true);
  });

  it('bounds new fittings on every tier while keeping the original canopy, trays and cover', () => {
    const map = mapOf(stall({ x: 3, z: 4 }));
    const original = JSON.stringify(map);
    const group = buildSetDressing(map);
    const details = group.children.filter((o) => o.userData.stallDetail);
    const structure = group.children.filter(
      (o) => !o.userData.stallDetail && !(o instanceof THREE.InstancedMesh),
    );
    expect(details.length).toBeGreaterThan(0);
    const resources = details.map((o) => [(o as THREE.Mesh).geometry, (o as THREE.Mesh).material]);
    updateSetDressing(group, new THREE.Vector3(3, 1.7, 5));
    expect(details.every((o) => o.visible)).toBe(true);
    const mesh = details[0] as THREE.Mesh;
    const box = mesh.geometry.boundingBox!;
    const eye = box.getCenter(new THREE.Vector3());
    eye.x = box.max.x + STALL_DETAIL_DISTANCE + 3;
    updateSetDressing(group, eye);
    expect(mesh.visible).toBe(true); // retain within the six-metre hysteresis band
    eye.x += 4;
    updateSetDressing(group, eye);
    expect(mesh.visible).toBe(false);
    eye.x -= 4;
    updateSetDressing(group, eye);
    expect(mesh.visible).toBe(false);
    updateSetDressing(group, new THREE.Vector3(200, 1.7, 200));
    expect(details.every((o) => !o.visible)).toBe(true);
    expect(structure.every((o) => o.visible)).toBe(true);
    updateSetDressing(group, new THREE.Vector3(3, 1.7, 5));
    expect(details.every((o) => o.visible)).toBe(true);
    expect(details.map((o) => [(o as THREE.Mesh).geometry, (o as THREE.Mesh).material])).toEqual(
      resources,
    );
    expect(JSON.stringify(map)).toBe(original);
  });

  it('dresses stall canopies, keeping every other box', () => {
    const s = stall({ x: 0, z: 0 });
    expect(s.filter((b) => b.dress === 'stallAwning')).toHaveLength(1);
    expect(s.filter((b) => !b.dress)).toHaveLength(2); // counter + back panel still drawn as boxes
    const g = buildSetDressing(mapOf(s));
    const names = g.children.map((c) => c.name.split('|')[0]);
    for (const m of ['dressing:canvas', 'dressing:produce', 'dressing:metal', 'dressing:fruit'])
      expect(names).toContain(m);
  });

  it('keeps the awning on its canopy box, down to the counter', () => {
    const s = stall({ x: 3, z: -2, rot: 90 });
    const canopy = s.find((b) => b.dress)!;
    const g = buildSetDressing(mapOf([canopy]));
    const bb = new THREE.Box3();
    for (const c of g.children) if (!c.name.startsWith('dressing:fruit')) bb.expandByObject(c);
    // Rotated 90°: the 3.4 m width runs along world z.
    expect(bb.max.y).toBeLessThan(canopy.center.y + 0.1);
    expect(bb.min.y).toBeCloseTo(canopy.center.y - 2.33, 1); // posts stand on the floor
    expect(bb.max.z - bb.min.z).toBeLessThan(3.5);
    expect(bb.max.x - bb.min.x).toBeLessThan(2.45);
  });

  it('maps the canvas in cloth metres and gives it weave/normal/roughness maps', () => {
    const canopy = stall({ x: 0, z: 0 }).find((b) => b.dress)!;
    const g = buildSetDressing(mapOf([canopy]));
    const canvas = g.children.find((c) => c.name.startsWith('dressing:canvas')) as THREE.Mesh;
    const mat = canvas.material as THREE.MeshStandardMaterial;
    expect(mat.map).toBe(canvasMaps().map);
    expect(mat.normalMap).toBe(canvasMaps().normalMap);
    expect(mat.roughnessMap).toBe(canvasMaps().roughnessMap);
    // The 3.4 m wide awning spans ≈ 3.4 / CANVAS_TILE repeats of the weave across.
    const uv = canvas.geometry.getAttribute('uv');
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      lo = Math.min(lo, uv.getX(i));
      hi = Math.max(hi, uv.getX(i));
    }
    expect((hi - lo) * CANVAS_TILE).toBeCloseTo(canopy.size.x, 1);
  });

  it('weaves a seamless tile and a finer two-scallop hem', () => {
    const n = 64;
    let seam = 0;
    let inner = 0;
    for (let k = 0; k < n; k++) {
      const v = k / n;
      seam += Math.abs(weaveHeight(1 - 1 / CANVAS_TEX, v) - weaveHeight(0, v));
      inner += Math.abs(weaveHeight(0.5, v) - weaveHeight(0.5 - 1 / CANVAS_TEX, v));
    }
    expect(seam).toBeLessThan(inner * 1.5 + 0.5);
    // Cusps at 0, ½, 1; deepest in each half.
    expect(hemDrop(0)).toBeCloseTo(hemDrop(0.5));
    expect(hemDrop(0.25)).toBeGreaterThan(hemDrop(0) + 0.07);
    expect(hemDrop(0.75)).toBeCloseTo(hemDrop(0.25));
  });

  it('stands each post in a dark weight plate on the floor (contact grounding)', () => {
    const canopy = stall({ x: 0, z: 0 }).find((b) => b.dress)!;
    const g = buildSetDressing(mapOf([canopy]));
    const matte = g.children.find((c) => c.name.startsWith('dressing:matte')) as THREE.Mesh;
    matte.geometry.computeBoundingBox();
    expect(matte.geometry.boundingBox!.min.y).toBeCloseTo(canopy.center.y - 2.33, 2);
  });

  it('draws produce only up close, whatever the tier', () => {
    const g = buildSetDressing(mapOf(stall({ x: 0, z: 0 })));
    const fruit = g.children.filter((c) => c.name.startsWith('dressing:fruit'));
    expect(fruit.length).toBeGreaterThan(0);
    updateSetDressing(g, new THREE.Vector3(0, 1.7, 3));
    expect(fruit.every((f) => f.visible)).toBe(true);
    updateSetDressing(g, new THREE.Vector3(0, 1.7, FRUIT_DISTANCE + 5));
    expect(fruit.every((f) => !f.visible)).toBe(true);
  });

  it('shares loaded timber maps between original dressing and near fittings', () => {
    const base = new THREE.MeshStandardMaterial({
      map: new THREE.Texture(),
      normalMap: new THREE.Texture(),
      roughnessMap: new THREE.Texture(),
      vertexColors: true,
    });
    let variant: THREE.MeshStandardMaterial | undefined;
    const materials = {
      variant: (id: string, key: string, configure: (m: THREE.MeshStandardMaterial) => void) => {
        expect(id).toBe('wood');
        expect(key).toBe('market-strip-light');
        if (!variant) {
          variant = base.clone();
          configure(variant);
        }
        return variant;
      },
    } as unknown as MapMaterials;
    const map = mapOf([...stall({ x: 3, z: 4 }), ...stall({ x: 7, z: 4 })]);
    const original = JSON.stringify(map);
    const dressing = buildSetDressing(map, materials);
    const timber = dressing.children.filter((c) => c.name.startsWith('dressing:wood'));
    expect(timber).toHaveLength(1); // two stalls, one shared chunk/material draw
    const mat = (timber[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat).not.toBe(base);
    expect(mat.map).toBe(base.map);
    expect(mat.normalMap).toBe(base.normalMap);
    expect(mat.roughnessMap).toBe(base.roughnessMap);
    expect((timber[0] as THREE.Mesh).castShadow).toBe(false);
    expect(mat.vertexColors).toBe(true);
    expect(JSON.stringify(map)).toBe(original);
    const again = buildSetDressing(map, materials);
    expect(
      (again.children.find((c) => c.name.startsWith('dressing:wood')) as THREE.Mesh).material,
    ).toBe(mat);
    // Fruit stays unmapped, sharing one material across coarse and close-up batches.
    const fruit = dressing.children.find((c) => c.name.startsWith('dressing:fruit')) as THREE.Mesh;
    expect(fruit.material).toBe(setDressingMaterials().fruit);
    expect((fruit.material as THREE.MeshStandardMaterial).map).toBeNull();
    const detail = dressing.getObjectByName('dressing:produce-detail') as THREE.InstancedMesh;
    expect(detail.material).toBe(fruit.material);
    expect(detail.receiveShadow).toBe(false);
    updateSetDressing(dressing, new THREE.Vector3(3, 1.7, 5.5));
    expect(detail.count).toBeGreaterThan(0);
    expect(detail.count).toBeLessThanOrEqual(512);
    updateSetDressing(dressing, new THREE.Vector3(100, 1.7, 100));
    expect(detail.visible).toBe(false);
  });

  it('maps tray faces in metres without collapsing end-grain UVs', () => {
    const canopy = stall({ x: 0, z: 0 }).find((b) => b.dress)!;
    const g = buildSetDressing(mapOf([canopy]));
    const wood = g.children.find((c) => c.name.startsWith('dressing:wood')) as THREE.Mesh;
    const p = wood.geometry.getAttribute('position');
    const uv = wood.geometry.getAttribute('uv');
    const index = wood.geometry.index!;
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const area = Math.abs(
        (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) -
          (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a)),
      );
      expect(area).toBeGreaterThan(0);
      const worldArea = new THREE.Vector3()
        .fromBufferAttribute(p, b)
        .sub(new THREE.Vector3().fromBufferAttribute(p, a))
        .cross(
          new THREE.Vector3()
            .fromBufferAttribute(p, c)
            .sub(new THREE.Vector3().fromBufferAttribute(p, a)),
        )
        .length();
      expect(area).toBeCloseTo(worldArea, 5);
    }
  });
});
