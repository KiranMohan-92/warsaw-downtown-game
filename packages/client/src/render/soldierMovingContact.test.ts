import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPlayerState,
  emptyInput,
  getMap,
  initPhysics,
  PhysicsWorld,
  resolveMap,
  SIM_DT,
  stepPlayer,
} from '@wd/shared';
import { gltfLoader } from './gltfLoader.ts';
import { Soldier, SOLDIER_IDS, type SoldierKit, type SoldierPose } from './soldiers.ts';
import { marketStairTestPoses } from './marketStairTestPoses.ts';

const soldierDir = new URL('../../public/models/soldiers/', import.meta.url);
const reportUrl = new URL(
  '../../../../tools/assets/build/soldier-moving-contact-after-20-20261006.json',
  import.meta.url,
);
const manifest = JSON.parse(readFileSync(new URL('soldiers.json', soldierDir), 'utf8')) as {
  soldiers: Record<
    string,
    { eye: number; aimYaw: number; tris: number; clips: Record<string, number> }
  >;
};

type Side = 'L' | 'R';
type Support = (x: number, y: number, z: number) => number | null;

interface FootMetric {
  side: 'left' | 'right';
  ankleY: number;
  ankleAboveRootMetres: number;
  swingByAnkleHeight: boolean;
  lowSoleVertices: number;
  supportHits: number;
  supportMisses: number;
  minGapMetres: number | null;
  medianGapMetres: number | null;
  maxGapMetres: number | null;
  maxPenetrationMetres: number | null;
  nearestContact: {
    vertexIndex: number;
    boneName: string;
    dominantWeight: number;
    world: { x: number; y: number; z: number };
    support: { x: number; y: number; z: number } | null;
    gapMetres: number | null;
  } | null;
}

async function parse(
  id: string,
): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const buf = readFileSync(new URL(`${id}.glb`, soldierDir));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => gltfLoader().parse(ab, '', resolve, reject));
}

function round(value: number | null, places = 6): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

function vec(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: round(v.x)!, y: round(v.y)!, z: round(v.z)! };
}

function sideName(side: Side): 'left' | 'right' {
  return side === 'L' ? 'left' : 'right';
}

function isFiniteMatrix(object: THREE.Object3D): boolean {
  object.updateMatrixWorld(true);
  let finite = true;
  object.traverse((node) => {
    finite &&= node.matrixWorld.elements.every(Number.isFinite);
  });
  return finite;
}

function sourceHash(relative: string): string {
  return createHash('sha256')
    .update(readFileSync(new URL(`../../../../${relative}`, import.meta.url)))
    .digest('hex');
}

function footMetric(root: THREE.Object3D, support: Support, side: Side, rootY: number): FootMetric {
  root.updateMatrixWorld(true);
  const ankle = root.getObjectByName(`Bip01_${side}_Foot`)!.getWorldPosition(new THREE.Vector3());
  const vertices: {
    index: number;
    point: THREE.Vector3;
    boneName: string;
    dominantWeight: number;
  }[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.visible || !mesh.isSkinnedMesh) return;
    mesh.skeleton.update();
    const indices = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    for (let i = 0; i < indices.count; i++) {
      let sameSideFootWeight = 0;
      let dominantWeight = -1;
      let dominantBone = '';
      for (let j = 0; j < 4; j++) {
        const weight = weights.getComponent(i, j);
        const bone = mesh.skeleton.bones[indices.getComponent(i, j)];
        if (weight > dominantWeight) {
          dominantWeight = weight;
          dominantBone = bone?.name ?? '';
        }
        if (bone?.name.startsWith(`Bip01_${side}_`) && /Foot|Toe/.test(bone.name))
          sameSideFootWeight += weight;
      }
      if (sameSideFootWeight < 0.95) continue;
      vertices.push({
        index: i,
        point: mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld),
        boneName: dominantBone,
        dominantWeight,
      });
    }
  });
  const minY = Math.min(...vertices.map((vertex) => vertex.point.y));
  let low = vertices.filter((vertex) => vertex.point.y <= minY + 0.045);
  if (low.length < 8) low = vertices.filter((vertex) => vertex.point.y <= minY + 0.08);
  const measured = low.map((vertex) => {
    const y = support(vertex.point.x, vertex.point.y + 0.45, vertex.point.z);
    const gap = y === null ? null : vertex.point.y - y;
    return { ...vertex, gap, supportY: y };
  });
  const hits = measured.filter((sample) => sample.gap !== null);
  const gaps = hits.map((sample) => sample.gap!);
  const sorted = [...gaps].sort((a, b) => a - b);
  const nearest =
    hits.length > 0
      ? hits.reduce((best, sample) => (Math.abs(sample.gap!) < Math.abs(best.gap!) ? sample : best))
      : null;
  return {
    side: sideName(side),
    ankleY: round(ankle.y)!,
    ankleAboveRootMetres: round(ankle.y - rootY)!,
    swingByAnkleHeight: ankle.y > rootY + 0.16,
    lowSoleVertices: low.length,
    supportHits: hits.length,
    supportMisses: measured.length - hits.length,
    minGapMetres: sorted.length ? round(sorted[0]!) : null,
    medianGapMetres: sorted.length ? round(sorted[Math.floor(sorted.length / 2)]!) : null,
    maxGapMetres: sorted.length ? round(sorted[sorted.length - 1]!) : null,
    maxPenetrationMetres: sorted.length ? round(Math.max(0, -sorted[0]!)) : null,
    nearestContact: nearest
      ? {
          vertexIndex: nearest.index,
          boneName: nearest.boneName,
          dominantWeight: round(nearest.dominantWeight)!,
          world: vec(nearest.point),
          support:
            nearest.supportY === null
              ? null
              : vec(new THREE.Vector3(nearest.point.x, nearest.supportY, nearest.point.z)),
          gapMetres: round(nearest.gap),
        }
      : null,
  };
}

function head(root: THREE.Object3D): THREE.Vector3 {
  return root.getObjectByName('Bip01_Head')!.getWorldPosition(new THREE.Vector3());
}

function held(soldier: Soldier): {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
} {
  const mesh = soldier.heldMesh()!;
  return {
    position: mesh.getWorldPosition(new THREE.Vector3()),
    quaternion: mesh.getWorldQuaternion(new THREE.Quaternion()).normalize(),
  };
}

function scenarioPoses(stairSamples: { feet: { x: number; y: number; z: number } }[]): {
  name: string;
  terrain: 'flat' | 'marketStairs';
  aimYawRadians: number;
  poses: SoldierPose[];
}[] {
  const flat = { x: 154.00000825708608, y: 0.019974880987137844, z: 26.700005798938783 };
  const pose = (
    p: { x: number; y: number; z: number },
    yaw: number,
    sprinting: boolean,
  ): SoldierPose => ({
    ...p,
    yaw,
    pitch: 0.16,
    crouched: false,
    grounded: true,
    sprinting,
    alive: true,
  });
  return [
    {
      name: 'flat-idle-to-run-to-idle-aim-forward',
      terrain: 'flat',
      aimYawRadians: 0,
      poses: [
        ...Array.from({ length: 12 }, () => pose(flat, 0, false)),
        ...Array.from({ length: 24 }, (_, i) =>
          pose({ ...flat, x: flat.x - (i + 1) * 0.09 }, 0, true),
        ),
        ...Array.from({ length: 18 }, () => pose({ ...flat, x: flat.x - 2.16 }, 0, false)),
      ],
    },
    {
      name: 'market-stairs-run-up-aim-right',
      terrain: 'marketStairs',
      aimYawRadians: Math.PI / 2,
      poses: stairSamples.slice(0, 5).map((sample) => pose(sample.feet, Math.PI / 2, true)),
    },
    {
      name: 'market-stairs-run-up-aim-diagonal',
      terrain: 'marketStairs',
      aimYawRadians: Math.PI / 4,
      poses: stairSamples.slice(1, 6).map((sample) => pose(sample.feet, Math.PI / 4, true)),
    },
  ];
}

describe('soldier moving foot contact', () => {
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: () => {} }),
  };
  let kit: SoldierKit;

  beforeAll(async () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const variants = await Promise.all(
      SOLDIER_IDS.map(async (id) => ({
        id,
        gltf: (await parse(id)) as SoldierKit['variants'][number]['gltf'],
        material: new THREE.MeshStandardMaterial(),
        info: manifest.soldiers[id] as unknown as SoldierKit['variants'][number]['info'],
      })),
    );
    kit = {
      variants,
      gearMaterial: new THREE.MeshStandardMaterial(),
      guns: {
        rifle: {
          geometry: new THREE.BoxGeometry(0.05, 0.1, 0.6),
          material: new THREE.MeshStandardMaterial(),
          position: new THREE.Vector3(),
        },
      },
    };
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('records continuous actual Market stair traversal and presentation query cost', async () => {
    await initPhysics();
    const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
    let queries = 0;
    const rawSupport: Support = (x, y, z) => {
      const hit = world.castVisibleRay({ x, y, z }, { x: 0, y: -1, z: 0 }, 1.2);
      return hit && hit.normal.y > 0.65 ? hit.point.y : null;
    };
    const countedSupport: Support = (x, y, z) => {
      queries++;
      return rawSupport(x, y, z);
    };
    const rows: Record<string, unknown>[] = [];
    try {
      for (const variant of [0, 1])
        for (const renderHz of [30, 60]) {
          for (const ascending of [true, false]) {
            const start = { x: ascending ? 151.3 : 144.5, y: ascending ? 0.06 : 3.62, z: 26.7 };
            const player = createPlayerState(start);
            const body = world.createCharacter(start);
            const planted = new Soldier({ ...kit, footSupport: countedSupport }, variant);
            const plain = new Soldier(kit, variant);
            try {
              for (let tick = 0; tick < 144; tick++) {
                stepPlayer(
                  player,
                  {
                    ...emptyInput(tick),
                    yaw: ascending ? Math.PI / 2 : -Math.PI / 2,
                    moveZ: tick >= 12 ? 1 : 0,
                  },
                  SIM_DT,
                  body,
                );
                if ((tick + 1) % (60 / renderHz) !== 0) continue;
                const pose: SoldierPose = {
                  ...player.move.pos,
                  yaw: player.view.yaw,
                  pitch: 0.16,
                  grounded: player.move.grounded,
                  crouched: false,
                  sprinting: false,
                  alive: true,
                };
                queries = 0;
                const started = performance.now();
                planted.update(pose, 1 / renderHz);
                const updateMs = performance.now() - started;
                const updateQueries = queries;
                plain.update(pose, 1 / renderHz);
                planted.root.updateMatrixWorld(true);
                plain.root.updateMatrixWorld(true);
                const feet = (['L', 'R'] as const).map((side) =>
                  footMetric(planted.root, rawSupport, side, pose.y),
                );
                for (const foot of feet)
                  if (foot.maxPenetrationMetres !== null)
                    expect(
                      foot.maxPenetrationMetres,
                      `${variant} ${renderHz} Hz ${ascending ? 'up' : 'down'} tick ${tick} ${foot.side}`,
                    ).toBeLessThanOrEqual(0.008);
                if (pose.grounded) expect(feet.some((foot) => foot.supportHits > 0)).toBe(true);
                const headDelta = head(plain.root).distanceTo(head(planted.root));
                const plainGun = held(plain);
                const plantedGun = held(planted);
                expect(isFiniteMatrix(planted.root)).toBe(true);
                expect(headDelta).toBeLessThan(1e-5);
                expect(plainGun.position.distanceTo(plantedGun.position)).toBeLessThan(1e-5);
                expect(plainGun.quaternion.angleTo(plantedGun.quaternion)).toBeLessThan(1e-5);
                expect(planted.root.position.distanceTo(plain.root.position)).toBeLessThan(1e-5);
                const bones = ['L', 'R'].flatMap((side) =>
                  ['Thigh', 'Calf', 'Foot'].map((joint) => {
                    const bone = planted.root.getObjectByName(`Bip01_${side}_${joint}`)!;
                    return {
                      name: bone.name,
                      position: vec(bone.getWorldPosition(new THREE.Vector3())),
                      quaternion: bone.getWorldQuaternion(new THREE.Quaternion()).toArray(),
                    };
                  }),
                );
                rows.push({
                  variant: SOLDIER_IDS[variant],
                  renderHz,
                  route: ascending ? 'up' : 'down',
                  tick,
                  root: vec(planted.root.position),
                  grounded: pose.grounded,
                  updateQueries,
                  updateMs,
                  feet,
                  bones,
                });
              }
            } finally {
              body.free();
            }
          }
        }
    } finally {
      world.free();
    }
    const output = new URL(
      `../../../../tools/assets/build/soldier-traversal-${process.env.WD_FOOT_PROBE_LABEL ?? 'current'}-20261007.json`,
      import.meta.url,
    );
    mkdirSync(new URL('.', output), { recursive: true });
    writeFileSync(
      output,
      JSON.stringify(
        {
          scope: 'Actual KCC + shipped rigs on Market stairs; CPU probe, not browser frame timing',
          footPlantSha256: sourceHash('packages/client/src/render/footPlant.ts'),
          mapSha256: sourceHash('packages/shared/src/maps/placDefilad/market.ts'),
          testSha256: sourceHash('packages/client/src/render/soldierMovingContact.test.ts'),
          supportRayMetres: 1.2,
          frames: rows.length,
          rows,
        },
        null,
        2,
      ),
    );
    expect(rows).toHaveLength(864);
  }, 60000);

  it('reports shipped moving sole contact on flat ground and Market stairs', async () => {
    await initPhysics();
    const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
    const support: Support = (x, y, z) => {
      const hit = world.castVisibleRay({ x, y, z }, { x: 0, y: -1, z: 0 }, 1.4);
      return hit && hit.normal.y > 0.65 ? hit.point.y : null;
    };
    const rows = [];
    const comparisons = [];
    let scenarios: ReturnType<typeof scenarioPoses>;
    try {
      const stairSamples = marketStairTestPoses(world);
      scenarios = scenarioPoses(stairSamples);
      for (const variant of [0, 1]) {
        for (const scenario of scenarios) {
          const plain = new Soldier(kit, variant);
          const planted = new Soldier({ ...kit, footSupport: support }, variant);
          for (let frame = 0; frame < scenario.poses.length; frame++) {
            const pose = scenario.poses[frame]!;
            plain.update(pose, 1 / 60);
            planted.update(pose, 1 / 60);
            plain.root.updateMatrixWorld(true);
            planted.root.updateMatrixWorld(true);
            expect(isFiniteMatrix(plain.root), `${scenario.name} plain frame ${frame}`).toBe(true);
            expect(isFiniteMatrix(planted.root), `${scenario.name} planted frame ${frame}`).toBe(
              true,
            );
            const headDelta = head(plain.root).distanceTo(head(planted.root));
            const plainHeld = held(plain);
            const plantedHeld = held(planted);
            const gunPositionDelta = plainHeld.position.distanceTo(plantedHeld.position);
            const gunAngleDelta = plainHeld.quaternion.angleTo(plantedHeld.quaternion);
            expect(headDelta, `${scenario.name} head frame ${frame}`).toBeLessThan(0.00001);
            expect(gunPositionDelta, `${scenario.name} gun frame ${frame}`).toBeLessThan(0.00001);
            expect(gunAngleDelta, `${scenario.name} gun rotation frame ${frame}`).toBeLessThan(
              0.00001,
            );
            for (const side of ['L', 'R']) {
              const boneName = `Bip01_${side}_Thigh`;
              const hipDelta = plain.root
                .getObjectByName(boneName)!
                .getWorldPosition(new THREE.Vector3())
                .distanceTo(
                  planted.root.getObjectByName(boneName)!.getWorldPosition(new THREE.Vector3()),
                );
              expect(hipDelta, `${scenario.name} ${side} hip frame ${frame}`).toBeLessThan(0.00001);
            }
            expect(plain.root.position.distanceTo(planted.root.position)).toBeLessThan(0.00001);
            const plainFeet = (['L', 'R'] as const).map((side) =>
              footMetric(plain.root, support, side, pose.y),
            );
            const plantedFeet = (['L', 'R'] as const).map((side) =>
              footMetric(planted.root, support, side, pose.y),
            );
            for (const foot of [...plainFeet, ...plantedFeet]) {
              expect(
                foot.lowSoleVertices,
                `${scenario.name} ${foot.side} vertices`,
              ).toBeGreaterThan(0);
            }
            rows.push({
              variant: SOLDIER_IDS[variant],
              scenario: scenario.name,
              terrain: scenario.terrain,
              frame,
              aimYawRadians: round(scenario.aimYawRadians),
              root: { x: round(pose.x), y: round(pose.y), z: round(pose.z) },
              moving: frame > 0,
              plain: { feet: plainFeet },
              withFootSupport: { feet: plantedFeet },
              unchangedByFootSupport: {
                headDeltaMetres: round(headDelta),
                gunPositionDeltaMetres: round(gunPositionDelta),
                gunQuaternionAngleRadians: round(gunAngleDelta),
                rootPositionDeltaMetres: round(
                  plain.root.position.distanceTo(planted.root.position),
                ),
              },
            });
            for (let i = 0; i < 2; i++) {
              const a = plainFeet[i]!;
              const b = plantedFeet[i]!;
              if (b.supportHits > 0) {
                expect(
                  b.maxPenetrationMetres,
                  `${SOLDIER_IDS[variant]} ${scenario.name} ${b.side} toe clearance frame ${frame}`,
                ).toBeLessThanOrEqual(0.008);
              }
              if (a.swingByAnkleHeight && a.minGapMetres !== null && a.minGapMetres > 0.02) {
                expect(b.minGapMetres, `${scenario.name} clean swing frame ${frame}`).toBeCloseTo(
                  a.minGapMetres,
                  5,
                );
                const name = `Bip01_${i === 0 ? 'L' : 'R'}_Foot`;
                expect(
                  plain.root
                    .getObjectByName(name)!
                    .getWorldPosition(new THREE.Vector3())
                    .distanceTo(
                      planted.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()),
                    ),
                ).toBeLessThan(0.00001);
              }
              comparisons.push({
                scenario: scenario.name,
                variant: SOLDIER_IDS[variant],
                frame,
                side: b.side,
                plainGapMetres: a.minGapMetres,
                withFootSupportGapMetres: b.minGapMetres,
                swingByAnkleHeight: b.swingByAnkleHeight,
                plantedCandidate: !b.swingByAnkleHeight && b.supportHits > 0,
                improvementMetres:
                  a.minGapMetres === null || b.minGapMetres === null
                    ? null
                    : round(Math.abs(a.minGapMetres) - Math.abs(b.minGapMetres)),
              });
            }
          }
        }
      }
    } finally {
      world.free();
    }
    const plantedCandidates = comparisons.filter((row) => row.plantedCandidate);
    const swingCandidates = comparisons.filter((row) => row.swingByAnkleHeight);
    const improved = plantedCandidates.filter(
      (row) => row.improvementMetres !== null && row.improvementMetres > 0.005,
    );
    const worsened = plantedCandidates.filter(
      (row) => row.improvementMetres !== null && row.improvementMetres < -0.005,
    );
    expect(plantedCandidates.length, 'planted stance candidates').toBeGreaterThan(0);
    expect(swingCandidates.length, 'legitimate swing-foot candidates').toBeGreaterThan(0);
    expect(improved.length, 'foot-support/no-callback comparison samples').toBeGreaterThan(0);
    const report = {
      version: 2,
      invocation:
        'node node_modules/vitest/vitest.mjs run packages/client/src/render/soldierMovingContact.test.ts --maxWorkers=1',
      purpose:
        'Actual shipped Soldier.update moving/standing transitions, measured on deformed foot/toe vertices against visible Market/flat support.',
      limitations: [
        'This verifies sampled shipped-rig contact and clean swing preservation after the penetration-only swing correction.',
        'Planted versus swing is classified with the same ankle-height threshold FootPlant uses for moving poses; sole vertices remain the contact measurement.',
        'The flat-ground sequence uses one settled Market flat point; the stair sequences use existing settled Market stair capsule roots.',
        'Some stair roots are already above rendered treads because the gameplay capsule sits on collision support; the report keeps those cases instead of normalizing them away.',
      ],
      sources: {
        'packages/client/src/render/soldierMovingContact.test.ts': sourceHash(
          'packages/client/src/render/soldierMovingContact.test.ts',
        ),
        'packages/client/src/render/footPlant.ts': sourceHash(
          'packages/client/src/render/footPlant.ts',
        ),
        'packages/client/src/render/soldiers.ts': sourceHash(
          'packages/client/src/render/soldiers.ts',
        ),
        'packages/client/public/models/soldiers/soldiers.json': sourceHash(
          'packages/client/public/models/soldiers/soldiers.json',
        ),
        'packages/client/public/models/soldiers/m01.glb': sourceHash(
          'packages/client/public/models/soldiers/m01.glb',
        ),
        'packages/client/public/models/soldiers/m04.glb': sourceHash(
          'packages/client/public/models/soldiers/m04.glb',
        ),
        'packages/shared/src/physics/world.ts': sourceHash('packages/shared/src/physics/world.ts'),
        'packages/shared/src/maps/placDefilad/market.ts': sourceHash(
          'packages/shared/src/maps/placDefilad/market.ts',
        ),
        'packages/client/src/render/marketStairTestPoses.ts': sourceHash(
          'packages/client/src/render/marketStairTestPoses.ts',
        ),
      },
      summary: {
        measuredFrames: rows.length,
        measuredFootComparisons: comparisons.length,
        plantedCandidateComparisons: plantedCandidates.length,
        swingCandidateComparisons: swingCandidates.length,
        improvedPlantedComparisons: improved.length,
        worsenedPlantedComparisons: worsened.length,
        maxHeadDeltaMetres: round(
          Math.max(...rows.map((row) => row.unchangedByFootSupport.headDeltaMetres ?? 0)),
        ),
        maxGunPositionDeltaMetres: round(
          Math.max(...rows.map((row) => row.unchangedByFootSupport.gunPositionDeltaMetres ?? 0)),
        ),
        worstWorsenedPlantedComparisons: worsened
          .sort((a, b) => a.improvementMetres! - b.improvementMetres!)
          .slice(0, 8),
        bestImprovedPlantedComparisons: improved
          .sort((a, b) => b.improvementMetres! - a.improvementMetres!)
          .slice(0, 8),
      },
      scenarios: scenarios.map((scenario) => ({
        name: scenario.name,
        terrain: scenario.terrain,
        aimYawRadians: round(scenario.aimYawRadians),
        frames: scenario.poses.length,
      })),
      comparisons,
      rows,
    };
    mkdirSync(new URL('.', reportUrl), { recursive: true });
    writeFileSync(reportUrl, `${JSON.stringify(report, null, 2)}\n`);
  }, 60_000);
});
