/** Read-only shipped-rig diagnostic. Run: node --experimental-transform-types tools/assets/probe-soldier-boot-contact.mjs */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../packages/client/node_modules/three/build/three.module.js';
import { GLTFLoader } from '../../packages/client/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../../packages/client/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
import { PLAYER } from '../../packages/shared/src/config/tunables.ts';
import { getMap, resolveMap } from '../../packages/shared/src/maps/registry.ts';
import { initPhysics, PhysicsWorld } from '../../packages/shared/src/physics/world.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'tools/assets/build/soldier-boot-contact-20261006.json');
const modelsDir = resolve(root, 'packages/client/public/models/soldiers');
const manifest = JSON.parse(await readFile(resolve(modelsDir, 'soldiers.json'), 'utf8'));
const stairReport = JSON.parse(
  await readFile(resolve(root, 'tools/assets/build/market-stair-support-20261006.json'), 'utf8'),
);
const stairRoots = stairReport.variants[0].samples;
const tmp = new THREE.Vector3();

const round = (value, places = 6) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(places)) : value;
const vec = (v) => ({ x: round(v.x), y: round(v.y), z: round(v.z) });
const sideName = (side) => (side === 'L' ? 'left' : 'right');
const isSideFootBone = (name, side) =>
  new RegExp(`(^|_)${side}_(Foot|Toe|Toe0|ToeBase|Ball)($|_)`, 'i').test(name);

function dominantFootSide(mesh, vertexIndex) {
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return null;
  let bestWeight = -1;
  let bestBone = -1;
  for (let i = 0; i < 4; i += 1) {
    const weight = skinWeight.getComponent(vertexIndex, i);
    if (weight > bestWeight) {
      bestWeight = weight;
      bestBone = skinIndex.getComponent(vertexIndex, i);
    }
  }
  const bone = mesh.skeleton?.bones?.[bestBone];
  if (!bone || bestWeight <= 0) return null;
  for (const side of ['L', 'R']) {
    if (isSideFootBone(bone.name, side))
      return { side, boneName: bone.name, boneIndex: bestBone, weight: bestWeight };
  }
  return null;
}

function collectFootVertices(model) {
  const vertices = [];
  const boneNames = new Set();
  model.traverse((object) => {
    if (!object.visible || !object.isSkinnedMesh) return;
    object.skeleton?.bones?.forEach((bone) => boneNames.add(bone.name));
    const count = object.geometry.getAttribute('position')?.count ?? 0;
    for (let index = 0; index < count; index += 1) {
      const dominant = dominantFootSide(object, index);
      if (dominant)
        vertices.push({
          side: dominant.side,
          mesh: object,
          meshName: object.name || '(unnamed skinned mesh)',
          vertexIndex: index,
          boneName: dominant.boneName,
          boneIndex: dominant.boneIndex,
          dominantWeight: dominant.weight,
        });
    }
  });
  return { vertices, boneNames: [...boneNames].sort() };
}

function poseModel(model, mixer, clip, time, rootPosition, yaw) {
  mixer.stopAllAction();
  mixer.clipAction(clip).reset().play();
  mixer.setTime(time);
  model.position.copy(rootPosition);
  model.rotation.set(0, yaw, 0);
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (object.isSkinnedMesh) object.skeleton?.update();
  });
}

function skinnedWorldPoint(vertex) {
  vertex.mesh.getVertexPosition(vertex.vertexIndex, tmp);
  return tmp.clone().applyMatrix4(vertex.mesh.matrixWorld);
}

function supportBelow(world, point, lift = 0.35, distance = 1.4) {
  const origin = { x: point.x, y: point.y + lift, z: point.z };
  return world.castVisibleRay(origin, { x: 0, y: -1, z: 0 }, distance);
}

function summarizeFootprint(world, footVertices, side) {
  const all = footVertices
    .filter((vertex) => vertex.side === side)
    .map((vertex) => ({ vertex, point: skinnedWorldPoint(vertex) }));
  if (!all.length) return { side: sideName(side), error: 'no foot/toe-dominant vertices' };
  const minY = Math.min(...all.map((sample) => sample.point.y));
  let lowBandMetres = 0.045;
  let low = all.filter((sample) => sample.point.y <= minY + lowBandMetres);
  if (low.length < 8) {
    lowBandMetres = 0.08;
    low = all.filter((sample) => sample.point.y <= minY + lowBandMetres);
  }
  const measured = low.map((sample) => {
    const hit = supportBelow(world, sample.point);
    const gap = hit ? sample.point.y - hit.point.y : null;
    return { ...sample, hit, gap, penetration: gap === null ? null : Math.max(0, -gap) };
  });
  const hits = measured.filter((sample) => sample.gap !== null);
  const minGapSample = hits.reduce(
    (best, sample) => (!best || sample.gap < best.gap ? sample : best),
    null,
  );
  const nearestSample = hits.reduce(
    (best, sample) => (!best || Math.abs(sample.gap) < Math.abs(best.gap) ? sample : best),
    null,
  );
  const maxPenetrationSample = hits.reduce(
    (best, sample) => (!best || sample.penetration > best.penetration ? sample : best),
    null,
  );
  const byY = [...measured].sort((a, b) => a.point.y - b.point.y);
  const xs = measured.map((sample) => sample.point.x);
  const zs = measured.map((sample) => sample.point.z);
  const gaps = hits.map((sample) => sample.gap);
  const vertexReport = (sample) =>
    sample
      ? {
          meshName: sample.vertex.meshName,
          vertexIndex: sample.vertex.vertexIndex,
          boneName: sample.vertex.boneName,
          dominantWeight: round(sample.vertex.dominantWeight),
          world: vec(sample.point),
          support: sample.hit ? vec(sample.hit.point) : null,
          supportSurface: sample.hit?.surface ?? null,
          gapMetres: round(sample.gap),
          penetrationMetres: round(sample.penetration),
        }
      : null;
  return {
    side: sideName(side),
    candidateFootToeVertices: all.length,
    measuredLowSoleVertices: measured.length,
    lowBandMetres: round(lowBandMetres),
    footprintXZ: {
      minX: round(Math.min(...xs)),
      maxX: round(Math.max(...xs)),
      minZ: round(Math.min(...zs)),
      maxZ: round(Math.max(...zs)),
    },
    supportHitCount: hits.length,
    supportMissCount: measured.length - hits.length,
    minGapMetres: gaps.length ? round(Math.min(...gaps)) : null,
    medianGapMetres: gaps.length
      ? round([...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)])
      : null,
    maxGapMetres: gaps.length ? round(Math.max(...gaps)) : null,
    maxPenetrationMetres: maxPenetrationSample ? round(maxPenetrationSample.penetration) : null,
    lowestVertices: byY.slice(0, 5).map(vertexReport),
    minGapVertex: vertexReport(minGapSample),
    nearestContactVertex: vertexReport(nearestSample),
    maxPenetrationVertex: vertexReport(maxPenetrationSample),
  };
}

function nearbyHigherSupport(world, foot, yaw) {
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const origin = { x: foot.x, y: foot.y + 0.55, z: foot.z };
  const base = world.castVisibleRay(origin, { x: 0, y: -1, z: 0 }, 1.8);
  return [-0.3, -0.2, -0.1, 0.1, 0.2, 0.3].map((offset) => {
    const p = foot.clone().addScaledVector(forward, offset);
    const hit = world.castVisibleRay({ x: p.x, y: p.y + 0.55, z: p.z }, { x: 0, y: -1, z: 0 }, 1.8);
    return {
      offsetMetres: offset,
      support: hit ? vec(hit.point) : null,
      supportSurface: hit?.surface ?? null,
      supportMinusFootBoneYMetres: hit ? round(hit.point.y - foot.y) : null,
      supportMinusBaseSupportYMetres: hit && base ? round(hit.point.y - base.point.y) : null,
      higherThanBaseSupport: Boolean(hit && base && hit.point.y > base.point.y + 0.025),
    };
  });
}

await initPhysics();
const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
const measurements = [];
const models = {};
try {
  for (const id of ['m01', 'm04']) {
    const bytes = await readFile(resolve(modelsDir, `${id}.glb`));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await new Promise((accept, reject) =>
      loader.parse(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        '',
        accept,
        reject,
      ),
    );
    const model = gltf.scene;
    const scale = PLAYER.standEyeHeight / manifest.soldiers[id].eye;
    model.scale.setScalar(scale);
    const mixer = new THREE.AnimationMixer(model);
    const { vertices, boneNames } = collectFootVertices(model);
    models[id] = {
      scale,
      visibleFootToeDominantVertices: vertices.length,
      footToeBoneNames: boneNames.filter((name) =>
        /_(L|R)_(Foot|Toe|Toe0|ToeBase|Ball)/i.test(name),
      ),
    };
    for (const [clipName, phase] of [
      ['idle', 0.5],
      ['crouchIdle', 0.5],
    ]) {
      const clip = gltf.animations.find((c) => c.name === clipName);
      if (!clip) throw new Error(`${id}: missing ${clipName}`);
      for (const sample of stairRoots) {
        for (const yaw of [0, Math.PI / 2]) {
          const rootPosition = new THREE.Vector3(sample.feet.x, sample.feet.y, sample.feet.z);
          poseModel(model, mixer, clip, phase, rootPosition, yaw);
          const footBones = Object.fromEntries(
            ['L', 'R'].map((side) => {
              const foot = model
                .getObjectByName(`Bip01_${side}_Foot`)
                ?.getWorldPosition(new THREE.Vector3());
              return [
                sideName(side),
                {
                  world: foot ? vec(foot) : null,
                  nearbySupportOffsets: foot ? nearbyHigherSupport(world, foot, yaw) : [],
                },
              ];
            }),
          );
          measurements.push({
            id,
            clip: clipName,
            clipTimeSeconds: phase,
            requestedRootX: sample.requestedX,
            rootFeet: vec(rootPosition),
            yawRadians: round(yaw),
            rootVisibleSupport: sample.visibleSupport?.point ?? null,
            rootGapMetres: round(sample.gapMetres),
            bootFootprints: ['L', 'R'].map((side) => summarizeFootprint(world, vertices, side)),
            footBones,
          });
        }
      }
    }
  }
} finally {
  world.free();
}

const allFeet = measurements.flatMap((measurement) =>
  measurement.bootFootprints.map((foot) => ({
    id: measurement.id,
    clip: measurement.clip,
    requestedRootX: measurement.requestedRootX,
    yawRadians: measurement.yawRadians,
    side: foot.side,
    minGapMetres: foot.minGapMetres,
    maxPenetrationMetres: foot.maxPenetrationMetres,
  })),
);
const validFeet = allFeet.filter((foot) => foot.minGapMetres !== null);
const penetrations = validFeet.filter((foot) => foot.maxPenetrationMetres > 0);
const sources = {};
for (const relative of [
  'tools/assets/probe-soldier-boot-contact.mjs',
  'tools/assets/probe-soldier-stair-reach.mjs',
  'tools/assets/build/market-stair-support-20261006.json',
  'packages/client/public/models/soldiers/soldiers.json',
  'packages/client/public/models/soldiers/m01.glb',
  'packages/client/public/models/soldiers/m04.glb',
  'packages/shared/src/config/tunables.ts',
  'packages/shared/src/maps/registry.ts',
  'packages/shared/src/maps/placDefilad/market.ts',
  'packages/shared/src/physics/world.ts',
])
  sources[relative] = createHash('sha256')
    .update(await readFile(resolve(root, relative)))
    .digest('hex');

const report = {
  version: 1,
  invocation: 'node --experimental-transform-types tools/assets/probe-soldier-boot-contact.mjs',
  purpose:
    'Actual shipped skinned boot-sole contact against visible Market stair support; no presentation/gameplay changes',
  map: 'defilad/market',
  poseSet: {
    soldierIds: ['m01', 'm04'],
    clips: [
      { name: 'idle', timeSeconds: 0.5 },
      { name: 'crouchIdle', timeSeconds: 0.5 },
    ],
    yawRadians: [0, Math.PI / 2],
    stairRoots: stairRoots.map((sample) => ({
      requestedRootX: sample.requestedX,
      feet: sample.feet,
      visibleSupport: sample.visibleSupport?.point ?? null,
      gapMetres: sample.gapMetres,
    })),
  },
  sources,
  models,
  limitations: [
    'This reports actual skinned mesh vertices after animation and skeleton updates, then applies each mesh matrixWorld.',
    'Sole candidates are the lowest posed vertices whose dominant skin weight is on a same-side foot/toe bone; vertices mainly weighted to calf or accessory bones are excluded.',
    'Down rays use PhysicsWorld.castVisibleRay against rendered support, so hidden gameplay-only colliders are excluded.',
    'The nearby-support section is a foot-bone reach hint at fore/aft offsets and is secondary to the vertex contact measurements.',
  ],
  summary: {
    measuredPoses: measurements.length,
    measuredBootFootprints: allFeet.length,
    minimumGapMetres: validFeet.length
      ? round(Math.min(...validFeet.map((foot) => foot.minGapMetres)))
      : null,
    maximumPenetrationMetres: validFeet.length
      ? round(Math.max(...validFeet.map((foot) => foot.maxPenetrationMetres)))
      : null,
    penetrationFootprintCount: penetrations.length,
    worstPenetrations: penetrations
      .sort((a, b) => b.maxPenetrationMetres - a.maxPenetrationMetres)
      .slice(0, 10),
    closestFootprints: [...validFeet]
      .sort((a, b) => Math.abs(a.minGapMetres) - Math.abs(b.minGapMetres))
      .slice(0, 10),
  },
  measurements,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    output,
    measuredPoses: report.summary.measuredPoses,
    measuredBootFootprints: report.summary.measuredBootFootprints,
    minimumGapMetres: report.summary.minimumGapMetres,
    maximumPenetrationMetres: report.summary.maximumPenetrationMetres,
    penetrationFootprintCount: report.summary.penetrationFootprintCount,
  }),
);
