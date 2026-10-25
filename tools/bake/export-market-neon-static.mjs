/** Offline staging: NOCNY RYNEK neon illumination for actual static box atlas faces. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boxFaceFrame,
  buildLightmapLayout,
  getMap,
  lightmapSceneHash,
  rectUv,
  resolveMap,
} from '../../packages/shared/src/index.ts';
import { BOUNDS, RECEIVER_Y, buildScene, geometryFingerprint } from './export-market-neon.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const SOURCE_FILES = [
  'tools/bake/export-market-neon-static.mjs',
  'tools/bake/market_neon_static_bake.py',
  'tools/bake/install_market_neon_static.py',
  'tools/bake/export-market-neon.mjs',
  'tools/bake/market_neon_bake.py',
  'tools/bake/courtyard_bake.py',
  'packages/client/src/render/marketNeonStaticBake.ts',
  'packages/client/src/render/neonDistrict.ts',
  'packages/client/src/render/setDressing.ts',
  'packages/shared/src/maps/lightmap.ts',
  'packages/shared/src/maps/registry.ts',
  'packages/shared/src/maps/builder.ts',
  'packages/shared/src/maps/geom.ts',
  'packages/shared/src/maps/props.ts',
  'packages/shared/src/maps/solids.ts',
  'packages/shared/src/maps/placDefilad/index.ts',
  'packages/shared/src/maps/placDefilad/market.ts',
];

const round = (n) => Math.round(n * 100000) / 100000 || 0;

function boxBounds(b) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let f = 0; f < 6; f++) {
    const fr = boxFaceFrame(b, f);
    for (const [u, v] of [
      [0, 0],
      [fr.lu, 0],
      [fr.lu, fr.lv],
      [0, fr.lv],
    ]) {
      const x = fr.o.x + fr.u.x * u + fr.v.x * v;
      const z = fr.o.z + fr.u.z * u + fr.v.z * v;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
  }
  return { x0, x1, z0, z1 };
}

function intersectsBounds(b) {
  const { x0, x1, z0, z1 } = boxBounds(b);
  return x1 >= BOUNDS[0] && x0 <= BOUNDS[2] && z1 >= BOUNDS[1] && z0 <= BOUNDS[3];
}

function receiverEligible(b) {
  return (
    b.visible !== false &&
    !b.model &&
    !b.dress &&
    !b.hero &&
    !b.heroPart &&
    b.mat !== 'facade' &&
    b.mat !== 'sandbag'
  );
}

function receiverGeometry(map, layout) {
  const positions = [];
  const indices = [];
  const uvs = [];
  const receivers = [];
  const materials = new Set();
  for (let bi = 0; bi < map.boxes.length; bi++) {
    const box = map.boxes[bi];
    if (!receiverEligible(box) || !intersectsBounds(box)) continue;
    const faceRects = [];
    for (let f = 0; f < 6; f++) {
      const rectIndex = layout.boxFaces[bi * 6 + f];
      if (rectIndex < 0) continue;
      const rect = layout.atlas.rects[rectIndex];
      const fr = boxFaceFrame(box, f);
      const corners = [
        [0, 0],
        [fr.lu, 0],
        [fr.lu, fr.lv],
        [0, fr.lv],
      ].map(([u, v]) => ({
        x: round(fr.o.x + fr.u.x * u + fr.v.x * v),
        y: round(fr.o.y + fr.u.y * u + fr.v.y * v),
        z: round(fr.o.z + fr.u.z * u + fr.v.z * v),
      }));
      const base = positions.length / 3;
      for (const p of corners) {
        positions.push(p.x, p.y, p.z);
        uvs.push(rectUv(rect, p, layout.atlas.width, layout.atlas.height).map(round));
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      faceRects.push(rectIndex);
    }
    if (!faceRects.length) continue;
    materials.add(box.mat);
    receivers.push({ boxIndex: bi, material: box.mat, faceRects });
  }
  return { positions, indices, uvs, receivers, receiverMaterials: [...materials].sort() };
}

function floorOccluder() {
  const [x0, z0, x1, z1] = BOUNDS;
  return {
    name: 'floor-receiver-occluder:white',
    positions: [x0, RECEIVER_Y, z0, x1, RECEIVER_Y, z0, x1, RECEIVER_Y, z1, x0, RECEIVER_Y, z1].map(
      round,
    ),
    indices: [0, 2, 1, 0, 3, 2],
    color: [1, 1, 1],
  };
}

function emitterHousing(emitter) {
  const angle = (emitter.yaw * Math.PI) / 180;
  const right = { x: Math.cos(angle), z: -Math.sin(angle) };
  const normal = { x: Math.sin(angle), z: Math.cos(angle) };
  const hw = (emitter.w + 0.22) / 2;
  const hh = (emitter.h + 0.18) / 2;
  const positions = [];
  for (const [sx, sy, sz] of [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ]) {
    const depth = sz * 0.04 - 0.055;
    positions.push(
      round(emitter.x + sx * hw * right.x + depth * normal.x),
      round(emitter.y + sy * hh),
      round(emitter.z + sx * hw * right.z + depth * normal.z),
    );
  }
  return {
    name: `emitter-housing:${emitter.label}`,
    positions,
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ],
    color: [0.025, 0.03, 0.035],
  };
}

function receiverFingerprint(receiver) {
  const hash = createHash('sha256');
  for (const values of [receiver.positions, receiver.indices, receiver.uvs.flat()]) {
    const bytes = Buffer.alloc(values.length * 8);
    values.forEach((value, i) => bytes.writeDoubleLE(value === 0 ? 0 : value, i * 8));
    hash.update(bytes);
  }
  for (const r of receiver.receivers)
    hash.update(`${r.boxIndex}:${r.material}:${r.faceRects.join(',')}\n`);
  return hash.digest('hex');
}

export async function buildStaticScene() {
  const map = resolveMap(getMap('defilad'), 'market');
  const layout = buildLightmapLayout(map);
  const base = await buildScene();
  const receiver = receiverGeometry(map, layout);
  if (!receiver.receivers.length) throw new Error('No eligible static receivers near NOCNY RYNEK');
  const selected = new Set(receiver.receivers.map((r) => r.boxIndex));
  const meshes = base.meshes.filter((m) => {
    const match = /^box-(\d+):/.exec(m.name);
    return !match || !selected.has(Number(match[1]));
  });
  for (const emitter of base.emitters) meshes.push(emitterHousing(emitter));
  meshes.push(floorOccluder());
  const sourceFingerprints = Object.fromEntries(
    await Promise.all(
      SOURCE_FILES.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(resolve(ROOT, path)))
          .digest('hex'),
      ]),
    ),
  );
  return {
    version: 1,
    kind: 'market-neon-static-atlas',
    map: 'defilad',
    size: 'market',
    sceneHash: lightmapSceneHash(map, layout, 8),
    layoutHash: layout.hash,
    bounds: BOUNDS,
    receiverY: RECEIVER_Y,
    occlusionPadding: base.occlusionPadding,
    atlas: { width: layout.atlas.width, height: layout.atlas.height },
    meshes,
    receiver,
    emitters: base.emitters,
    geometryFingerprint: geometryFingerprint(meshes),
    lightingFingerprint: base.lightingFingerprint,
    receiverFingerprint: receiverFingerprint(receiver),
    receiverMaterials: receiver.receiverMaterials,
    sourceFingerprints,
    limitations: [
      'Static box-face atlas only; ground, props, dress, facade, hero and sandbag special renderers are excluded.',
      'Only selected current map box faces near NOCNY RYNEK receive light; all other atlas slots stay black.',
      'Receiver material is white Lambert for irradiance; material albedo remains a runtime material concern.',
    ],
  };
}

async function main() {
  const arg = process.argv.indexOf('--out');
  const out = resolve(
    ROOT,
    arg >= 0 ? process.argv[arg + 1] : 'tools/assets/build/market-neon-static/scene.json',
  );
  const scene = await buildStaticScene();
  const payload = `${JSON.stringify(scene)}\n`;
  if (Buffer.byteLength(payload) > MAX_INPUT_BYTES)
    throw new Error('Market neon static scene exceeds 8 MiB; do not launch');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, payload);
  console.log(
    JSON.stringify({
      out,
      bytes: Buffer.byteLength(payload),
      atlas: [scene.atlas.width, scene.atlas.height],
      receivers: scene.receiver.receivers.length,
      receiverMaterials: scene.receiverMaterials,
      emitters: scene.emitters.map((e) => e.label),
      receiverFingerprint: scene.receiverFingerprint,
      inputSha256: createHash('sha256').update(payload).digest('hex'),
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
