import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as THREE from '../../packages/client/node_modules/three/build/three.module.js';
import { getMap, resolveMap } from '../../packages/shared/src/index.ts';
import { buildPalaceColumns } from '../../packages/client/src/render/palaceColumns.ts';
import { buildScene, exportColumns, isShadowOnlyMesh } from './export-palace.mjs';

class ExportMaterials {
  mats = new Map();
  get(id) {
    let mat = this.mats.get(id);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ name: id, color: 0xffffff });
      this.mats.set(id, mat);
    }
    return mat;
  }
  variant(id, key, configure) {
    const k = `${id}|${key}`;
    let mat = this.mats.get(k);
    if (!mat) {
      mat = this.get(id).clone();
      mat.name = k;
      configure(mat);
      this.mats.set(k, mat);
    }
    return mat;
  }
  facadeShellVariant(key, configure) {
    return this.variant('facade', `shell|${key}`, configure);
  }
}

function palaceMap() {
  return resolveMap(getMap('defilad'), 'market');
}

test('shadow-only detection also excludes unnamed colour-invisible meshes', () => {
  const geometry = new THREE.BoxGeometry();
  const visible = new THREE.MeshStandardMaterial();
  const shadow = new THREE.MeshStandardMaterial({ colorWrite: false });
  const unnamed = new THREE.Mesh(geometry, shadow);
  const named = new THREE.Mesh(geometry, visible);
  named.name = 'palace-columns:shadow-proxy';
  assert.equal(isShadowOnlyMesh(unnamed), true);
  assert.equal(isShadowOnlyMesh(named), true);
  assert.equal(isShadowOnlyMesh(new THREE.Mesh(geometry, visible)), false);
  assert.equal(isShadowOnlyMesh(new THREE.Group()), false);
  geometry.dispose();
  visible.dispose();
  shadow.dispose();
});

test('Palace exporter skips column shadow proxies before serialization', () => {
  const map = palaceMap();
  const group = buildPalaceColumns(map, new ExportMaterials());
  const proxy = group.getObjectByName('palace-columns:shadow-proxy');
  assert.ok(proxy instanceof THREE.Mesh);
  assert.equal(isShadowOnlyMesh(proxy), true);

  const columns = exportColumns(map);
  assert.ok(columns.some((mesh) => mesh.name === 'palace-columns:stone'));
  assert.ok(!columns.some((mesh) => mesh.name.includes('shadow-proxy')));
}, 20_000); // builds the real Palace columns (~6 s on a loaded laptop)

test('Palace courtyard scene serializes only visible column geometry', () => {
  const scene = buildScene();
  assert.ok(scene.meshes.some((mesh) => mesh.name === 'palace-columns:stone'));
  assert.ok(!scene.meshes.some((mesh) => mesh.name.includes('shadow-proxy')));
}, 20_000); // serializes the whole courtyard scene
