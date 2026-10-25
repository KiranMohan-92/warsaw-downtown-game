import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { HERO_BODY, car, foodTruck, kiosk, type MapDefinition } from '@wd/shared';
import {
  alignHeroLodGround,
  BODY_HERO_IDS,
  buildHeroMeshes,
  heroMatrix,
  heroNeedsDetail,
  updateHeroes,
  type HeroModels,
} from './heroModels.ts';

const manifest = JSON.parse(
  readFileSync(new URL('../../public/models/heroes/heroes.json', import.meta.url), 'utf8'),
) as { models: Record<string, { body: number[]; size: number[] }> };

async function shippedGeometry(name: string): Promise<THREE.BufferGeometry> {
  await MeshoptDecoder.ready;
  const base = new URL('../../public/models/heroes/', import.meta.url);
  const gltf = JSON.parse(readFileSync(new URL(`${name}.gltf`, base), 'utf8')) as {
    buffers: { uri?: string }[];
    bufferViews: {
      extensions: {
        EXT_meshopt_compression: {
          buffer: number;
          byteOffset: number;
          byteLength: number;
          byteStride: number;
          count: number;
          mode: string;
          filter?: string;
        };
      };
    }[];
    accessors: { bufferView: number; componentType: number; count: number; type: string }[];
    meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
  };
  const decode = (index: number): THREE.BufferAttribute => {
    const accessor = gltf.accessors[index]!;
    const ext = gltf.bufferViews[accessor.bufferView]!.extensions.EXT_meshopt_compression;
    const source = readFileSync(new URL(gltf.buffers[ext.buffer]!.uri!, base));
    const bytes = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(
      bytes,
      ext.count,
      ext.byteStride,
      source.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength),
      ext.mode,
      ext.filter,
    );
    const array =
      accessor.componentType === 5126
        ? new Float32Array(bytes.buffer)
        : accessor.componentType === 5125
          ? new Uint32Array(bytes.buffer)
          : new Uint16Array(bytes.buffer);
    return new THREE.BufferAttribute(
      array,
      accessor.type === 'VEC3' ? 3 : accessor.type === 'VEC2' ? 2 : 1,
    );
  };
  const primitive = gltf.meshes[0]!.primitives[0]!;
  return new THREE.BufferGeometry()
    .setAttribute('position', decode(primitive.attributes.POSITION!))
    .setAttribute('normal', decode(primitive.attributes.NORMAL!))
    .setAttribute('uv', decode(primitive.attributes.TEXCOORD_0!))
    .setIndex(decode(primitive.indices));
}

describe('hero models', () => {
  it('grounds decoded shipped distant body models without changing their shape, UVs or near geometry', async () => {
    for (const id of BODY_HERO_IDS) {
      const near = await shippedGeometry(id);
      const far = await shippedGeometry(`${id}_far`);
      near.computeBoundingBox();
      far.computeBoundingBox();
      const nearPositions = new Float32Array(near.getAttribute('position').array);
      const farPositions = new Float32Array(far.getAttribute('position').array);
      const normals = new Float32Array(far.getAttribute('normal').array);
      const uvs = new Float32Array(far.getAttribute('uv').array);
      const indices = Array.from(far.index!.array);
      const size = far.boundingBox!.getSize(new THREE.Vector3());
      const before = far.boundingBox!.min.y - near.boundingBox!.min.y;
      expect(before, `${id} has measured ground drift`).toBeGreaterThan(0.001);
      expect(before).toBeLessThan(0.05);
      alignHeroLodGround(id, near, far);
      expect(far.boundingBox!.min.y).toBeCloseTo(near.boundingBox!.min.y, 6);
      expect(far.boundingBox!.getSize(new THREE.Vector3()).distanceTo(size)).toBeLessThan(1e-6);
      expect(near.getAttribute('position').array).toEqual(nearPositions);
      expect(far.getAttribute('normal').array).toEqual(normals);
      expect(far.getAttribute('uv').array).toEqual(uvs);
      expect(Array.from(far.index!.array)).toEqual(indices);
      const after = far.getAttribute('position');
      for (let i = 0; i < after.count; i++) {
        expect(after.getX(i)).toBe(farPositions[i * 3]);
        expect(after.getZ(i)).toBe(farPositions[i * 3 + 2]);
        expect(after.getY(i)).toBeCloseTo(farPositions[i * 3 + 1]! - before, 6);
      }
      near.dispose();
      far.dispose();
    }
  });

  it('rejects excessive or invalid drift and leaves wrecks and shared geometry untouched', () => {
    const near = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const far = near.clone().translate(0, 0.2, 0);
    const positions = new Float32Array(far.getAttribute('position').array);
    expect(() => alignHeroLodGround('burnt_car', near, far)).toThrow('5 cm');
    expect(far.getAttribute('position').array).toEqual(positions);
    alignHeroLodGround('tank_wreck', near, far);
    expect(far.getAttribute('position').array).toEqual(positions);
    alignHeroLodGround('burnt_car', near, near);
    expect(() => alignHeroLodGround('kiosk', near, new THREE.BufferGeometry())).toThrow('bounds');
    const invalid = near.clone();
    invalid.getAttribute('position').setY(0, Infinity);
    expect(() => alignHeroLodGround('kiosk', near, invalid)).toThrow('bounds');
  });

  it('bounds detail at 40 m with 6 m hysteresis regardless of size, zoom or resolution', () => {
    for (const projection of [0, 1000, 10_000, NaN, Infinity, -1]) {
      expect(heroNeedsDetail(40, 200, projection, false)).toBe(true);
      expect(heroNeedsDetail(41, 2, projection, false)).toBe(false);
      expect(heroNeedsDetail(41, 2, projection, true)).toBe(true);
      expect(heroNeedsDetail(46, 200, projection, true)).toBe(true);
      expect(heroNeedsDetail(47, 200, projection, true)).toBe(false);
      expect(heroNeedsDetail(100, 200, projection, false)).toBe(false);
    }
  });

  it('bounds prebuilt LODs and casters by distance without changing transforms or resources', () => {
    const near = new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0);
    const far = new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0);
    const material = new THREE.MeshStandardMaterial();
    const map: MapDefinition = {
      name: 'hero distance budget',
      bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
      boxes: foodTruck({ x: 100, z: 0, rot: 90 }),
      spawns: [],
      dummies: [],
    };
    const group = buildHeroMeshes(
      map,
      new Map([['food_truck', { geometry: near, far, material }]]),
    );
    const mesh = group.children[0] as THREE.InstancedMesh;
    const transforms = new Float32Array(mesh.instanceMatrix.array);
    updateHeroes(group, new THREE.Vector3());
    expect(mesh.geometry).toBe(far);
    for (const projection of [500, 2000, 10_000]) {
      updateHeroes(group, new THREE.Vector3(), projection);
      expect(mesh.geometry).toBe(far);
      expect(mesh.castShadow).toBe(false);
    }
    const edge = mesh.boundingBox!.min.x;
    updateHeroes(group, new THREE.Vector3(edge - 40, 0, 0), 10_000);
    expect(mesh.geometry).toBe(near);
    expect(mesh.castShadow).toBe(true);
    updateHeroes(group, new THREE.Vector3(edge - 46, 0, 0), 10_000);
    expect(mesh.geometry).toBe(near);
    updateHeroes(group, new THREE.Vector3(edge - 47, 0, 0), 10_000);
    expect(mesh.geometry).toBe(far);
    expect(mesh.castShadow).toBe(false);
    updateHeroes(group, new THREE.Vector3(edge - 41, 0, 0), 10_000);
    expect(mesh.geometry).toBe(far);
    expect(mesh.instanceMatrix.array).toEqual(transforms);
    expect(mesh.material).toBe(material);
    expect(group.children).toHaveLength(1);
  });
  it('collision boxes match each built model body (within 3 cm)', () => {
    for (const id of BODY_HERO_IDS) {
      const [x, y, z] = manifest.models[id]!.body;
      const b = HERO_BODY[id];
      expect(Math.abs(b.x - x!), `${id} x`).toBeLessThan(0.03);
      expect(Math.abs(b.y - y!), `${id} y`).toBeLessThan(0.03);
      expect(Math.abs(b.z - z!), `${id} z`).toBeLessThan(0.03);
    }
  });

  it('tags wrecks, food trucks and kiosks; the wreck keeps a cabin collider', () => {
    const w = car({ x: 0, z: 0 }, true);
    expect(w.filter((b) => b.hero === 'burnt_car')).toHaveLength(1);
    expect(w.filter((b) => b.visible === false && b.collide !== false)).toHaveLength(1);
    expect(foodTruck({ x: 0, z: 0 })[0]!.hero).toBe('food_truck');
    expect(kiosk({ x: 0, z: 0 })[0]!.hero).toBe('kiosk');
    expect(car({ x: 0, z: 0 }).some((b) => b.hero)).toBe(false); // parked cars stay scans
  });

  it('stands each model on the floor of its box, and falls back to the boxes', () => {
    const [t] = foodTruck({ x: 5, y: 1, z: -3, rot: 90 });
    const p = new THREE.Vector3().setFromMatrixPosition(heroMatrix(t!));
    expect(p.y).toBeCloseTo(1, 5);
    expect(p.x).toBeCloseTo(5, 5);
    const map: MapDefinition = {
      name: 'heroes',
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      boxes: [t!, ...kiosk({ x: -4, z: 4 })],
      spawns: [],
      dummies: [],
    };
    const g = buildHeroMeshes(map, null);
    expect(g.children).toHaveLength(2);
    const bb = new THREE.Box3().setFromObject(g.children[0]!);
    expect(bb.min.y).toBeCloseTo(1, 3);
  });

  it('the fallback draws the wreck cabin too (drawn = collision); the model covers it', () => {
    const wreck = car({ x: 2, z: 1, rot: 30 }, true);
    const map: MapDefinition = {
      name: 'wreck',
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      boxes: wreck,
      spawns: [],
      dummies: [],
    };
    const solid = new THREE.Box3();
    for (const b of wreck.filter((b) => b.collide !== false)) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z));
      m.position.set(b.center.x, b.center.y, b.center.z);
      m.setRotationFromMatrix(heroMatrix(b));
      solid.expandByObject(m);
    }
    const g = buildHeroMeshes(map, null);
    g.updateMatrixWorld(true);
    const drawn = g.children.reduce(
      (n, o) => n + (o instanceof THREE.InstancedMesh ? o.count : 0),
      0,
    );
    expect(drawn).toBe(2); // body + cabin
    const bb = new THREE.Box3().setFromObject(g);
    expect(bb.min.distanceTo(solid.min)).toBeLessThan(1e-3);
    expect(bb.max.distanceTo(solid.max)).toBeLessThan(1e-3);
    // With the model loaded only the body instance is drawn (the model covers the cabin).
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const models: HeroModels = new Map([
      ['burnt_car', { geometry, far: geometry, material: new THREE.MeshStandardMaterial() }],
    ]);
    const withModel = buildHeroMeshes(map, models);
    expect(withModel.children.map((o) => (o as THREE.InstancedMesh).count)).toEqual([1]);
  });
});
