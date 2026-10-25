import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildLightmapLayout,
  getMap,
  rectUv,
  resolveMap,
} from '../../packages/shared/src/index.ts';
import { BOUNDS } from './export-market-neon.mjs';
import { buildStaticScene } from './export-market-neon-static.mjs';

test('static scene selects only real box receivers and preserves atlas dimensions', async () => {
  const map = resolveMap(getMap('defilad'), 'market');
  const layout = buildLightmapLayout(map);
  const scene = await buildStaticScene();
  assert.equal(scene.kind, 'market-neon-static-atlas');
  assert.deepEqual(scene.bounds, BOUNDS);
  assert.deepEqual(scene.atlas, { width: layout.atlas.width, height: layout.atlas.height });
  assert.equal(scene.layoutHash, layout.hash);
  assert.ok(scene.receiver.receivers.length > 0);
  assert.equal(
    new Set(scene.receiver.receivers.map((r) => r.boxIndex)).size,
    scene.receiver.receivers.length,
  );
  assert.ok(scene.receiverMaterials.includes('container'));
  assert.ok(!scene.receiverMaterials.includes('facade'));
  assert.ok(!scene.receiverMaterials.includes('sandbag'));
  for (const receiver of scene.receiver.receivers) {
    const box = map.boxes[receiver.boxIndex];
    assert.notEqual(box.visible, false);
    assert.ok(!box.model && !box.dress && !box.hero && !box.heroPart);
    assert.notEqual(box.mat, 'facade');
    assert.notEqual(box.mat, 'sandbag');
    for (const rect of receiver.faceRects) assert.ok(rect >= 0);
  }
}, 20_000);

test('receiver UVs match buildLightmapLayout rectUv for actual box corners', async () => {
  const scene = await buildStaticScene();
  const map = resolveMap(getMap('defilad'), 'market');
  const layout = buildLightmapLayout(map);
  const first = scene.receiver.receivers[0];
  const offset = scene.receiver.receivers
    .slice(0, scene.receiver.receivers.indexOf(first))
    .reduce((n, r) => n + r.faceRects.length * 4, 0);
  const rect = layout.atlas.rects[first.faceRects[0]];
  for (let i = 0; i < 4; i++) {
    const p = {
      x: scene.receiver.positions[(offset + i) * 3],
      y: scene.receiver.positions[(offset + i) * 3 + 1],
      z: scene.receiver.positions[(offset + i) * 3 + 2],
    };
    const expected = rectUv(rect, p, layout.atlas.width, layout.atlas.height);
    assert.ok(Math.abs(scene.receiver.uvs[offset + i][0] - expected[0]) < 0.00001);
    assert.ok(Math.abs(scene.receiver.uvs[offset + i][1] - expected[1]) < 0.00001);
  }
}, 20_000);

test('selected receiver boxes replace their original box occluders and keep floor bounce occluder', async () => {
  const scene = await buildStaticScene();
  const selected = new Set(scene.receiver.receivers.map((r) => r.boxIndex));
  for (const mesh of scene.meshes) {
    const match = /^box-(\d+):/.exec(mesh.name);
    assert.ok(!match || !selected.has(Number(match[1])));
  }
  assert.ok(scene.meshes.some((m) => m.name === 'floor-receiver-occluder:white'));
}, 20_000);

test('static scene exports an opaque housing behind every emitter', async () => {
  const scene = await buildStaticScene();
  for (const emitter of scene.emitters) {
    const housing = scene.meshes.find((m) => m.name === `emitter-housing:${emitter.label}`);
    assert.ok(housing, `missing housing for ${emitter.label}`);
    assert.deepEqual(housing.color, [0.025, 0.03, 0.035]);
    assert.equal(housing.positions.length, 24);
    assert.equal(housing.indices.length, 36);
    const yaw = (emitter.yaw * Math.PI) / 180;
    const depths = [];
    for (let i = 0; i < housing.positions.length; i += 3) {
      const dx = housing.positions[i] - emitter.x;
      const dy = housing.positions[i + 1] - emitter.y;
      const dz = housing.positions[i + 2] - emitter.z;
      depths.push(dx * Math.sin(yaw) + dz * Math.cos(yaw));
      assert.ok(
        Math.abs(Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw)) - (emitter.w + 0.22) / 2) <
          0.00001,
      );
      assert.ok(Math.abs(Math.abs(dy) - (emitter.h + 0.18) / 2) < 0.00001);
    }
    assert.ok(Math.abs(Math.min(...depths) + 0.095) < 0.00001);
    assert.ok(Math.abs(Math.max(...depths) + 0.015) < 0.00001);
  }
}, 20_000);
