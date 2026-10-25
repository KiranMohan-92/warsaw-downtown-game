/** Read-only shipped-rig diagnostic. Run: node --experimental-transform-types tools/assets/probe-soldier-stair-reach.mjs */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../packages/client/node_modules/three/build/three.module.js';
import { GLTFLoader } from '../../packages/client/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../../packages/client/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
import { PLAYER } from '../../packages/shared/src/config/tunables.ts';
import { humanoidHitboxes } from '../../packages/shared/src/sim/hitbox.ts';
import { getMap, resolveMap } from '../../packages/shared/src/maps/registry.ts';
import { initPhysics, PhysicsWorld } from '../../packages/shared/src/physics/world.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'tools/assets/build/soldier-stair-reach-20261006.json');
const modelsDir = resolve(root, 'packages/client/public/models/soldiers');
const manifest = JSON.parse(await readFile(resolve(modelsDir, 'soldiers.json'), 'utf8'));
const stairRoots = JSON.parse(
  await readFile(resolve(root, 'tools/assets/build/market-stair-support-20261006.json'), 'utf8'),
).variants[0].samples;
await initPhysics();
const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
const measurements = [];
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
    const boneAt = (name) => {
      const bone = model.getObjectByName(name);
      if (!bone) throw new Error(`${id}: missing ${name}`);
      return bone.getWorldPosition(new THREE.Vector3());
    };
    for (const [clipName, phase] of [
      ['idle', 0.5],
      ['crouchIdle', 0.5],
      ['walk', 0.25],
      ['walk', 0.5],
      ['walk', 0.75],
    ]) {
      const clip = gltf.animations.find((c) => c.name === clipName);
      if (!clip) throw new Error(`${id}: missing ${clipName}`);
      mixer.stopAllAction();
      mixer.clipAction(clip).play();
      mixer.setTime(phase);
      model.position.set(0, 0, 0);
      model.rotation.set(0, 0, 0);
      model.updateMatrixWorld(true);
      const legs = ['L', 'R'].map((side) => {
        const hip = boneAt(`Bip01_${side}_Thigh`);
        const knee = boneAt(`Bip01_${side}_Calf`);
        const foot = boneAt(`Bip01_${side}_Foot`);
        const thighLength = hip.distanceTo(knee);
        const calfLength = knee.distanceTo(foot);
        const chainLength = thighLength + calfLength;
        const targets = [0.1, 0.2, 0.28].map((drop) => {
          const target = foot.clone().add(new THREE.Vector3(0, -drop, 0));
          const horizontalSq = (hip.x - target.x) ** 2 + (hip.z - target.z) ** 2;
          const reachableVertical = Math.sqrt(Math.max(0, chainLength ** 2 - horizontalSq));
          return {
            dropMetres: drop,
            overreachMetres: Math.max(0, hip.distanceTo(target) - chainLength),
            minimumVerticalHipLoweringMetres:
              horizontalSq > chainLength ** 2
                ? null
                : Math.max(0, hip.y - target.y - reachableVertical),
          };
        });
        return {
          side,
          hip: hip.toArray(),
          knee: knee.toArray(),
          foot: foot.toArray(),
          thighLength,
          calfLength,
          chainLength,
          targets,
        };
      });
      const eyeHeight = clipName === 'crouchIdle' ? PLAYER.crouchEyeHeight : PLAYER.standEyeHeight;
      const hitbox = humanoidHitboxes({ x: 0, y: 0, z: 0 }, eyeHeight)[0];
      const headBone = boneAt('Bip01_Head');
      const hitCentre = new THREE.Vector3(hitbox.a.x, hitbox.a.y, hitbox.a.z);
      const headBoneDistance = headBone.distanceTo(hitCentre);
      // Eye is the loader/build convention used by existing soldier tests, not full skull bounds.
      const eyePointDistance = headBone
        .clone()
        .add(new THREE.Vector3(0, 0.075 * scale, 0))
        .distanceTo(hitCentre);
      const stairContacts = [];
      if (clipName === 'idle')
        for (const sample of stairRoots)
          for (const yaw of [0, Math.PI / 2]) {
            model.position.copy(new THREE.Vector3(sample.feet.x, sample.feet.y, sample.feet.z));
            model.rotation.y = yaw;
            model.updateMatrixWorld(true);
            for (const side of ['L', 'R']) {
              const foot = boneAt(`Bip01_${side}_Foot`);
              const support = world.castVisibleRay(
                { x: foot.x, y: foot.y + 0.3, z: foot.z },
                { x: 0, y: -1, z: 0 },
                1.2,
              );
              stairContacts.push({
                requestedRootX: sample.requestedX,
                yaw,
                side,
                footBone: foot.toArray(),
                visibleSupport: support?.point ?? null,
                footBoneToSurfaceMetres: support ? foot.y - support.point.y : null,
              });
            }
          }
      measurements.push({
        id,
        clip: clipName,
        clipTimeSeconds: phase,
        scale,
        legs,
        head: {
          radius: hitbox.r,
          headBoneDistanceMetres: headBoneDistance,
          headBoneClearanceMetres: hitbox.r - headBoneDistance,
          eyePointDistanceMetres: eyePointDistance,
        },
        stairContacts,
      });
    }
  }
} finally {
  world.free();
}
const sources = {};
for (const relative of [
  'tools/assets/probe-soldier-stair-reach.mjs',
  'packages/client/src/render/soldiers.ts',
  'packages/client/public/models/soldiers/soldiers.json',
  'packages/client/public/models/soldiers/m01.glb',
  'packages/client/public/models/soldiers/m04.glb',
  'packages/shared/src/config/tunables.ts',
  'packages/shared/src/sim/hitbox.ts',
  'packages/shared/src/physics/world.ts',
  'tools/assets/build/market-stair-support-20261006.json',
])
  sources[relative] = createHash('sha256')
    .update(await readFile(resolve(root, relative)))
    .digest('hex');
const report = {
  version: 1,
  invocation: 'node --experimental-transform-types tools/assets/probe-soldier-stair-reach.mjs',
  purpose:
    'Actual shipped leg reach and foot-bone positions on real Market treads; no presentation/gameplay changes',
  sources,
  limitations: [
    'Foot bones are ankle anchors, not boot soles; footBoneToSurface is not boot clearance.',
    'Hypothetical lower targets preserve ankle XZ and fixed hip; actual IK and pelvis/body compensation are not implemented.',
    'Head bone/eye proxy is not a full skull geometry containment test.',
    'Two sampled idle headings do not establish moving-foot contact.',
  ],
  measurements,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    output,
    poses: measurements.length,
    stairFootBoneSamples: measurements.reduce((n, m) => n + m.stairContacts.length, 0),
    idle: measurements
      .filter((m) => m.clip === 'idle')
      .map((m) => ({
        id: m.id,
        legs: m.legs.map((leg) => ({
          side: leg.side,
          chainLength: leg.chainLength,
          targets: leg.targets,
        })),
        head: m.head,
      })),
  }),
);
