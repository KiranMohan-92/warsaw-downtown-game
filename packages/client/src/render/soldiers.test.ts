import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { humanoidHitboxes, PLAYER, proneHitboxes, SLIDE } from '@wd/shared';
import { legHeading, Soldier, SOLDIER_IDS, type SoldierKit } from './soldiers.ts';
import { gltfLoader } from './gltfLoader.ts';
import { initPhysics, PhysicsWorld, getMap, resolveMap } from '@wd/shared';
import { marketStairTestPoses } from './marketStairTestPoses.ts';

const dir = new URL('../../public/models/soldiers/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('soldiers.json', dir), 'utf8')) as {
  soldiers: Record<
    string,
    { eye: number; aimYaw: number; tris: number; clips: Record<string, number> }
  >;
};

async function parse(
  id: string,
): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const buf = readFileSync(new URL(`${id}.glb`, dir));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => gltfLoader().parse(ab, '', resolve, reject));
}

/** Eye height (m, at the game's scale) in `clip` at time t. */
function headHeight(
  gltf: Awaited<ReturnType<typeof parse>>,
  eye: number,
  clip: string,
  t: number,
): number {
  const root = gltf.scene;
  root.scale.setScalar(PLAYER.standEyeHeight / eye);
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(gltf.animations.find((c) => c.name === clip)!).play();
  mixer.setTime(t);
  root.updateMatrixWorld(true);
  // The eye point the build scales by (tools/assets/build_soldiers.py): head bone + 7.5 cm up.
  const k = PLAYER.standEyeHeight / eye;
  return root.getObjectByName('Bip01_Head')!.getWorldPosition(new THREE.Vector3()).y + 0.075 * k;
}

/** Visual bounds for the rendered meshes only, ignoring hidden warm-up/alternate attachments. */
function visibleMeshBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.visible) return;
    if ((o as THREE.Mesh).isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) {
      box.expandByObject(o);
    }
  });
  return box;
}

describe('soldiers', () => {
  it('ship every clip the view plays, within budget', () => {
    for (const id of SOLDIER_IDS) {
      const s = manifest.soldiers[id]!;
      expect(s.tris).toBeLessThan(16000);
      for (const c of [
        'idle',
        'walk',
        'jog',
        'sprint',
        'crouchIdle',
        'crouchWalk',
        'fall',
        'death',
        'prone',
        'proneCrawl',
      ])
        expect(s.clips[c], `${id} ${c}`).toBeGreaterThan(0);
    }
  });

  it('draw the head inside the head hit volume, standing and crouched', async () => {
    const stand = humanoidHitboxes({ x: 0, y: 0, z: 0 }, PLAYER.standEyeHeight)[0]!;
    const crouch = humanoidHitboxes({ x: 0, y: 0, z: 0 }, PLAYER.crouchEyeHeight)[0]!;
    for (const id of SOLDIER_IDS) {
      const g = await parse(id);
      const eye = manifest.soldiers[id]!.eye;
      const standing = headHeight(g, eye, 'idle', 0.5);
      expect(Math.abs(standing - stand.a.y), `${id} idle`).toBeLessThan(stand.r);
      const crouched = headHeight(g, eye, 'crouchIdle', 0.5);
      expect(Math.abs(crouched - crouch.a.y), `${id} crouch (${crouched.toFixed(2)})`).toBeLessThan(
        crouch.r * 1.5,
      );
    }
  });

  it('keeps shipped standing and crouched visual boot bounds on the root ground anchor', async () => {
    for (const id of SOLDIER_IDS) {
      const g = await parse(id);
      const eye = manifest.soldiers[id]!.eye;
      const root = g.scene;
      root.scale.setScalar(PLAYER.standEyeHeight / eye);
      const mixer = new THREE.AnimationMixer(root);
      for (const clipName of ['idle', 'walk', 'jog', 'crouchIdle', 'crouchWalk'] as const) {
        mixer.stopAllAction();
        mixer.clipAction(g.animations.find((c) => c.name === clipName)!).play();
        mixer.setTime(0.5);
        const minY = visibleMeshBounds(root).min.y;
        expect(minY, `${id} ${clipName} minY`).toBeLessThanOrEqual(0.025);
        expect(minY, `${id} ${clipName} minY`).toBeGreaterThanOrEqual(-0.08);
      }
    }
  });

  it('lies prone on the prone hit volumes (head over the capsule, body behind)', async () => {
    const shapes = proneHitboxes({ x: 0, y: 0, z: 0 }, 0);
    const head = shapes[0]!;
    const legs = shapes.find((s) => s.zone === 'legs')!;
    for (const id of SOLDIER_IDS) {
      const g = await parse(id);
      const root = g.scene;
      const eye = manifest.soldiers[id]!.eye;
      root.scale.setScalar(PLAYER.standEyeHeight / eye);
      root.rotation.y = Math.PI; // the game turns the model to face -Z (yaw 0, prone: no blade)
      const mixer = new THREE.AnimationMixer(root);
      mixer.clipAction(g.animations.find((c) => c.name === 'prone')!).play();
      mixer.setTime(0);
      root.updateMatrixWorld(true);
      const at = (n: string) => root.getObjectByName(n)!.getWorldPosition(new THREE.Vector3());
      const h = at('Bip01_Head');
      expect(
        h.distanceTo(new THREE.Vector3(head.a.x, head.a.y, head.a.z)),
        `${id} head`,
      ).toBeLessThan(head.r + 0.06);
      // Feet behind, along the leg volume's line (within its radius, near its far end).
      for (const foot of ['Bip01_L_Foot', 'Bip01_R_Foot']) {
        const f = at(foot);
        expect(f.z, `${id} ${foot} behind`).toBeGreaterThan(legs.a.z);
        expect(Math.abs(f.x), `${id} ${foot} lateral`).toBeLessThan(legs.r + 0.12);
        expect(f.y, `${id} ${foot} low`).toBeLessThan(0.35);
      }
    }
  });
});

describe('soldier aim pitch', () => {
  // The soldier's skateboard draws its grip tape on a canvas: a minimal stand-in for node.
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

  it('plants actual skinned soles on Market stairs without moving the head or stretching legs', async () => {
    await initPhysics();
    const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
    const footSupport = (x: number, y: number, z: number) => {
      const hit = world.castVisibleRay({ x, y, z }, { x: 0, y: -1, z: 0 }, 1.2);
      return hit && hit.normal.y > 0.65 ? hit.point.y : null;
    };
    try {
      const roots = marketStairTestPoses(world);
      for (const crouched of [false, true])
        for (const variant of [0, 1])
          for (const yaw of [0, Math.PI / 4, Math.PI / 2, (Math.PI * 3) / 4])
            for (const { feet } of roots) {
              const plain = new Soldier(kit, variant);
              const planted = new Soldier({ ...kit, footSupport }, variant);
              const pose = {
                ...feet,
                yaw,
                pitch: 0,
                crouched,
                grounded: true,
                sprinting: false,
                alive: true,
              };
              for (let i = 0; i < 60; i++) {
                plain.update(pose, 1 / 60);
                planted.update(pose, 1 / 60);
              }
              plain.root.updateMatrixWorld(true);
              planted.root.updateMatrixWorld(true);
              expect(
                planted.root
                  .getObjectByName('Bip01_Head')!
                  .getWorldPosition(new THREE.Vector3())
                  .distanceTo(
                    plain.root.getObjectByName('Bip01_Head')!.getWorldPosition(new THREE.Vector3()),
                  ),
              ).toBeLessThan(0.00001);
              const gunA = plain.heldMesh()!;
              const gunB = planted.heldMesh()!;
              expect(
                gunA
                  .getWorldPosition(new THREE.Vector3())
                  .distanceTo(gunB.getWorldPosition(new THREE.Vector3())),
              ).toBeLessThan(0.00001);
              expect(
                gunA
                  .getWorldQuaternion(new THREE.Quaternion())
                  .normalize()
                  .angleTo(gunB.getWorldQuaternion(new THREE.Quaternion()).normalize()),
              ).toBeLessThan(0.00001);
              expect(
                planted.root
                  .getObjectByName('Bip01_L_Foot')!
                  .getWorldPosition(new THREE.Vector3())
                  .distanceTo(
                    planted.root
                      .getObjectByName('Bip01_R_Foot')!
                      .getWorldPosition(new THREE.Vector3()),
                  ),
                'planted boots remain separated',
              ).toBeGreaterThan(0.1);
              for (const side of ['L', 'R']) {
                const vertices: THREE.Vector3[] = [];
                planted.root.traverse((o) => {
                  const mesh = o as THREE.SkinnedMesh;
                  if (!mesh.isSkinnedMesh) return;
                  mesh.skeleton.update();
                  const indices = mesh.geometry.getAttribute('skinIndex');
                  const weights = mesh.geometry.getAttribute('skinWeight');
                  for (let i = 0; i < indices.count; i++) {
                    let weight = 0;
                    for (let j = 0; j < 4; j++)
                      if (
                        /Foot|Toe/.test(mesh.skeleton.bones[indices.getComponent(i, j)]!.name) &&
                        mesh.skeleton.bones[indices.getComponent(i, j)]!.name.startsWith(
                          `Bip01_${side}_`,
                        )
                      )
                        weight += weights.getComponent(i, j);
                    if (weight >= 0.95)
                      vertices.push(
                        mesh
                          .getVertexPosition(i, new THREE.Vector3())
                          .applyMatrix4(mesh.matrixWorld),
                      );
                  }
                });
                const minimum = Math.min(...vertices.map((v) => v.y));
                const gaps = vertices
                  .filter((v) => v.y <= minimum + 0.045)
                  .map((v) => {
                    const height = footSupport(v.x, v.y + 0.45, v.z);
                    return height === null ? Infinity : v.y - height;
                  });
                const gap = Math.min(...gaps);
                expect(gap, `${variant} ${yaw} root ${feet.x} ${side} sole`).toBeLessThanOrEqual(
                  0.025,
                );
                expect(
                  gap,
                  `${variant} ${yaw} root ${feet.x} ${side} penetration`,
                ).toBeGreaterThanOrEqual(-0.015);
                for (const [a, b] of [
                  ['Thigh', 'Calf'],
                  ['Calf', 'Foot'],
                ]) {
                  const length = (s: Soldier) =>
                    s.root
                      .getObjectByName(`Bip01_${side}_${a}`)!
                      .getWorldPosition(new THREE.Vector3())
                      .distanceTo(
                        s.root
                          .getObjectByName(`Bip01_${side}_${b}`)!
                          .getWorldPosition(new THREE.Vector3()),
                      );
                  expect(length(planted)).toBeCloseTo(length(plain), 6);
                }
              }
            }
    } finally {
      world.free();
    }
  }, 60_000);

  it('leaves airborne, prone, sliding, riding, seated and dead animation untouched', () => {
    for (const override of [
      { grounded: false },
      { prone: true },
      { sliding: true, crouched: true },
      { riding: true },
      { seated: true, crouched: true },
      { alive: false },
    ]) {
      const support = vi.fn(() => 0);
      const plain = new Soldier(kit, 0);
      const planted = new Soldier({ ...kit, footSupport: support }, 0);
      const pose = {
        x: 0,
        y: 0.02,
        z: 0,
        yaw: 1.2,
        pitch: 0.3,
        crouched: false,
        grounded: true,
        sprinting: false,
        alive: true,
        ...override,
      };
      for (let i = 0; i < 30; i++) {
        plain.update(pose, 1 / 60);
        planted.update(pose, 1 / 60);
      }
      plain.root.updateMatrixWorld(true);
      planted.root.updateMatrixWorld(true);
      expect(support).not.toHaveBeenCalled();
      for (const name of ['Bip01_Head', 'Bip01_L_Foot', 'Bip01_R_Foot'])
        expect(
          plain.root
            .getObjectByName(name)!
            .getWorldPosition(new THREE.Vector3())
            .distanceTo(planted.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3())),
        ).toBeLessThan(0.00001);
    }
  });

  type Stance = 'stand' | 'crouch' | 'prone' | 'slide';
  /** A soldier held `s` seconds at a pose; its head centre (the eye point, carried rigidly by
   * the head bone), head bone and rifle bore direction. */
  function posed(
    variant: number,
    stance: Stance,
    yaw: number,
    pitch: number,
    /** Moving at this world velocity (m/s) the whole time (legs turn toward it). */
    vel = { x: 0, z: 0 },
  ) {
    const s = new Soldier(kit, variant);
    const bone = (n: string) => s.root.getObjectByName(n)!;
    const head = bone('Bip01_Head');
    s.root.updateMatrixWorld(true);
    const k = PLAYER.standEyeHeight / manifest.soldiers[SOLDIER_IDS[variant]!]!.eye;
    const local = head.worldToLocal(
      head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.075 * k, 0)),
    );
    const p = {
      x: 0,
      y: 0,
      z: 0,
      yaw,
      pitch,
      crouched: stance === 'crouch' || stance === 'slide',
      prone: stance === 'prone',
      sliding: stance === 'slide',
      grounded: true,
      sprinting: false,
      alive: true,
    };
    for (let t = 0; t < 0.5; t += 1 / 60) s.update({ ...p, x: vel.x * t, z: vel.z * t }, 1 / 60);
    s.root.updateMatrixWorld(true);
    const at = (n: string) => bone(n).getWorldPosition(new THREE.Vector3());
    return {
      centre: head.localToWorld(local.clone()),
      head: at('Bip01_Head'),
      bore: at('gun_f').sub(at('gun_o')).normalize(),
      feet: at('Bip01_L_Foot').add(at('Bip01_R_Foot')).multiplyScalar(0.5),
      // The support wrist in the rifle's frame (the rifle rides on the right hand).
      grip: at('Bip01_L_Hand')
        .sub(at('Bip01_R_Hand'))
        .applyQuaternion(bone('Bip01_R_Hand').getWorldQuaternion(new THREE.Quaternion()).invert()),
    };
  }

  function updatedSoldierBounds(
    variant: number,
    pos: { x: number; y: number; z: number },
    stance: Stance = 'stand',
  ): THREE.Box3 {
    const s = new Soldier(kit, variant);
    const p = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      yaw: 0,
      pitch: 0,
      crouched: stance === 'crouch' || stance === 'slide',
      prone: stance === 'prone',
      sliding: stance === 'slide',
      grounded: true,
      sprinting: false,
      alive: true,
    };
    for (let i = 0; i < 30; i++) s.update(p, 1 / 60);
    return visibleMeshBounds(s.root);
  }
  const deg = THREE.MathUtils.degToRad;
  const PITCHES = [-60, -45, -30, -15, 0, 15, 30, 45, 60].map(deg);

  it('keeps the visual ground contact on the pose anchor at near and far positions', () => {
    for (const [v, id] of SOLDIER_IDS.entries()) {
      const near = updatedSoldierBounds(v, { x: 0, y: 0, z: 0 });
      const far = updatedSoldierBounds(v, { x: 140, y: 3.25, z: -180 });
      const nearGround = near.min.y;
      const farGround = far.min.y - 3.25;
      expect(nearGround, `${id} near contact`).toBeLessThanOrEqual(0.03);
      expect(nearGround, `${id} near contact`).toBeGreaterThanOrEqual(-0.08);
      expect(farGround, `${id} far contact`).toBeCloseTo(nearGround, 5);
    }
  });

  it('keeps the drawn head in the (pitch-independent) head hit volume, standing and crouched', () => {
    for (const [v, id] of SOLDIER_IDS.entries())
      for (const stance of ['stand', 'crouch'] as const)
        for (const yaw of [0, 1.2]) {
          const eye = stance === 'stand' ? PLAYER.standEyeHeight : PLAYER.crouchEyeHeight;
          const sphere = humanoidHitboxes({ x: 0, y: 0, z: 0 }, eye)[0]!;
          const c = new THREE.Vector3(sphere.a.x, sphere.a.y, sphere.a.z);
          const level = posed(v, stance, yaw, 0);
          for (const pitch of PITCHES) {
            const r = posed(v, stance, yaw, pitch);
            const what = `${id} ${stance} yaw ${yaw} pitch ${THREE.MathUtils.radToDeg(pitch)}`;
            expect(r.centre.distanceTo(c), what).toBeLessThan(sphere.r);
            // Pinned: aiming up/down doesn't move the head at all.
            expect(r.centre.distanceTo(level.centre), what).toBeLessThan(0.01);
            // The rifle still follows the aim: pitch on top of the clip's own, yaw on the facing.
            const bp = Math.asin(r.bore.y) - Math.asin(level.bore.y);
            expect(Math.abs(bp - pitch), `${what} rifle pitch`).toBeLessThan(deg(3));
            const by = Math.atan2(-r.bore.x, -r.bore.z) - yaw;
            expect(
              Math.abs(Math.atan2(Math.sin(by), Math.cos(by))),
              `${what} rifle yaw`,
            ).toBeLessThan(deg(6));
          }
        }
  });

  it('keeps the head on the prone head volume at any pitch (prone pitches half)', () => {
    for (const [v, id] of SOLDIER_IDS.entries())
      for (const yaw of [0, 1.2]) {
        const sphere = proneHitboxes({ x: 0, y: 0, z: 0 }, yaw)[0]!;
        const c = new THREE.Vector3(sphere.a.x, sphere.a.y, sphere.a.z);
        const level = posed(v, 'prone', yaw, 0);
        for (const pitch of PITCHES) {
          const r = posed(v, 'prone', yaw, pitch);
          const what = `${id} prone yaw ${yaw} pitch ${THREE.MathUtils.radToDeg(pitch)}`;
          expect(r.head.distanceTo(c), what).toBeLessThan(sphere.r + 0.06);
          expect(r.centre.distanceTo(level.centre), what).toBeLessThan(0.01);
          const bp = Math.asin(r.bore.y) - Math.asin(level.bore.y);
          expect(Math.abs(bp - pitch * 0.5), `${what} rifle pitch`).toBeLessThan(deg(3));
        }
      }
  });

  it('slides leaned back, feet first: head on the slide hit volume, rifle on the aim', () => {
    const sphere = humanoidHitboxes({ x: 0, y: 0, z: 0 }, SLIDE.eyeHeight)[0]!;
    const c = new THREE.Vector3(sphere.a.x, sphere.a.y, sphere.a.z);
    for (const [v, id] of SOLDIER_IDS.entries())
      for (const yaw of [0, 1.2]) {
        const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const crouch = posed(v, 'crouch', yaw, 0);
        for (const pitch of [-0.5, 0, 0.5]) {
          const r = posed(v, 'slide', yaw, pitch);
          const what = `${id} slide yaw ${yaw} pitch ${pitch}`;
          expect(r.centre.distanceTo(c), what).toBeLessThan(sphere.r * 1.5);
          const crouchAt = posed(v, 'crouch', yaw, pitch);
          const bp = Math.asin(r.bore.y) - Math.asin(crouchAt.bore.y);
          expect(Math.abs(bp), `${what} rifle pitch`).toBeLessThan(deg(3));
        }
        const r = posed(v, 'slide', yaw, 0);
        // The feet swing out ahead of the crouch's, the head stays over the capsule.
        expect(r.feet.clone().sub(crouch.feet).dot(fwd), `${id} feet`).toBeGreaterThan(0.2);
        expect(r.feet.y, `${id} feet on the ground`).toBeLessThan(crouch.feet.y + 0.12);
      }
  });

  it('a slide looking away from the travel keeps the rifle on the aim (legs turned)', () => {
    for (const [v, id] of SOLDIER_IDS.entries())
      for (const yaw of [0, 1.2])
        for (const off of [-45, 45]) {
          // Travelling `off` degrees from the facing at slide speed: the legs turn toward it.
          const h = yaw + deg(off);
          const vel = { x: -Math.sin(h) * 8, z: -Math.cos(h) * 8 };
          for (const pitch of [-0.5, 0, 0.5]) {
            const r = posed(v, 'slide', yaw, pitch, vel);
            const still = posed(v, 'slide', yaw, pitch);
            const crouchAt = posed(v, 'crouch', yaw, pitch);
            const what = `${id} slide yaw ${yaw} off ${off} pitch ${pitch}`;
            const bp = Math.asin(r.bore.y) - Math.asin(crouchAt.bore.y);
            expect(Math.abs(bp), `${what} rifle pitch`).toBeLessThan(deg(3));
            const by = Math.atan2(-r.bore.x, -r.bore.z) - Math.atan2(-still.bore.x, -still.bore.z);
            expect(
              Math.abs(Math.atan2(Math.sin(by), Math.cos(by))),
              `${what} rifle yaw`,
            ).toBeLessThan(deg(6));
          }
        }
  });

  it('keeps the support hand on the rifle at any pitch (both arms pitch as one)', () => {
    for (const [v, id] of SOLDIER_IDS.entries())
      for (const stance of ['stand', 'crouch', 'prone'] as const)
        for (const yaw of [0, 1.2]) {
          const level = posed(v, stance, yaw, 0).grip;
          for (const pitch of PITCHES) {
            const d = posed(v, stance, yaw, pitch).grip.distanceTo(level);
            const what = `${id} ${stance} yaw ${yaw} pitch ${THREE.MathUtils.radToDeg(pitch)}`;
            expect(d, what).toBeLessThan(0.01);
          }
        }
  });
});

describe('soldier leg heading', () => {
  const deg = THREE.MathUtils.degToRad;
  it('walks straight back with square hips (reversed clip), clamps sideways at 60°', () => {
    for (const facing of [0, 1, -2.5, 3.1]) {
      const at = (offDeg: number) => legHeading(facing + deg(offDeg), facing);
      const back = at(180);
      expect(back.reverse).toBe(true);
      expect(back.turn).toBeCloseTo(0, 6);
      expect(at(-180).turn).toBeCloseTo(0, 6);
      // Back-left / back-right: the legs turn toward the reversed heading, not away from it.
      expect(at(150).turn).toBeCloseTo(deg(-30), 6);
      expect(at(-160).turn).toBeCloseTo(deg(20), 6);
      expect(at(150).reverse && at(-160).reverse).toBe(true);
      expect(at(30)).toEqual({ turn: expect.closeTo(deg(30), 6) as number, reverse: false });
      expect(at(90).turn).toBeCloseTo(deg(60), 6);
      expect(at(-90).turn).toBeCloseTo(deg(-60), 6);
      expect(at(90).reverse).toBe(false);
    }
  });
});
