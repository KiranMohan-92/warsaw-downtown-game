import assert from 'node:assert/strict';
import { test } from 'vitest';
import { getMap, resolveMap } from '../../packages/shared/src/index.ts';
import { NEON_SIGNS } from '../../packages/client/src/render/neonDistrict.ts';
import {
  BOUNDS,
  buildScene,
  geometryFingerprint,
  relevantEmitters,
} from './export-market-neon.mjs';

test('actual Market staging preserves inputs and exports current visible obstacles and curved awnings', async () => {
  const map = resolveMap(getMap('defilad'), 'market');
  const before = JSON.stringify(map);
  const scene = await buildScene();
  assert.equal(JSON.stringify(resolveMap(getMap('defilad'), 'market')), before);
  assert.deepEqual(scene.bounds, [76, 30, 112, 62]);
  assert.equal(scene.receiverY, 0.02);
  assert.equal(scene.geometryFingerprint, geometryFingerprint(scene.meshes));
  assert.ok(Buffer.byteLength(JSON.stringify(scene)) < 8 * 1024 * 1024);
  assert.ok(scene.meshes.some((m) => m.name.startsWith('dressing:canvas')));
  assert.ok(scene.meshes.some((m) => m.name.startsWith('prop-') || m.name.startsWith('decor-')));
  assert.ok(scene.meshes.some((m) => m.name.startsWith('prism-')));
  for (const mesh of scene.meshes) {
    assert.equal(mesh.positions.length % 3, 0);
    assert.equal(mesh.indices.length % 3, 0);
    assert.ok(mesh.positions.every(Number.isFinite));
    assert.ok(
      mesh.indices.every((i) => Number.isInteger(i) && i >= 0 && i < mesh.positions.length / 3),
    );
    if (mesh.name.startsWith('box-')) {
      const b = map.boxes[Number(mesh.name.split(':')[0].slice(4))];
      assert.notEqual(b.visible, false);
      assert.ok(!b.dress && !b.hero && !b.heroPart && !b.model);
    }
  }
}, 20_000);

test('includes every existing sign within the stated radius and keeps actual yaw/colour', () => {
  const expected = NEON_SIGNS.filter((s) => {
    const dx = Math.max(BOUNDS[0] - s.x, 0, s.x - BOUNDS[2]);
    const dz = Math.max(BOUNDS[1] - s.z, 0, s.z - BOUNDS[3]);
    return Math.hypot(dx, dz) <= 16 + s.w / 2;
  });
  const emitters = relevantEmitters();
  assert.deepEqual(
    emitters.map((e) => e.label),
    expected.map((e) => e.label),
  );
  assert.ok(emitters.some((e) => e.label === 'NOCNY RYNEK'));
  for (const emitter of emitters) {
    const { radiance, ...actual } = emitter;
    assert.deepEqual(
      actual,
      expected.find((e) => e.label === emitter.label),
    );
    assert.equal(radiance, 120);
  }
});

test('geometry fingerprint detects vertex, index and material edits', () => {
  const meshes = [
    {
      name: 'tri',
      positions: [76, 1, 30, 77, 1, 30, 76, 2, 30],
      indices: [0, 1, 2],
      color: [0.5, 0.5, 0.5],
    },
  ];
  const original = geometryFingerprint(meshes);
  for (const field of ['positions', 'indices', 'color']) {
    const edited = structuredClone(meshes);
    edited[0][field][0] += 1;
    assert.notEqual(geometryFingerprint(edited), original);
  }
});
