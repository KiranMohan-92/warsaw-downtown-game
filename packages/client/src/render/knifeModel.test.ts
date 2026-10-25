import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { KNIFE_ANCHORS, knifeMaterial, type KnifeModel } from './knifeModel.ts';
import { modelDataReady, readAccessor, readModel } from './modelData.testUtil.ts';
import { modelTrailPoints, Viewmodel } from './viewmodel.ts';
import { KNIFE_MODEL_AT } from './viewmodelModels.ts';
import { SCAN_GUN_IDS, thirdPersonModels, type ScanGun, type ScanGunId } from './viewGunScans.ts';
import { PartnerView } from './partnerView.ts';
import type { ArmPivots, ArmRig } from './fpRig.ts';

await modelDataReady;

const dir = new URL('../../public/models/knife/', import.meta.url);
const file = new URL('knife.gltf', dir);
const model = readModel(file);
const json = model.json as unknown as {
  nodes: { name?: string; mesh?: number; translation?: number[] }[];
  meshes: typeof model.json.meshes;
};
const manifest = JSON.parse(readFileSync(new URL('knife.json', dir), 'utf8')) as {
  triangles: number;
  anchors: Record<string, number[]>;
  clipDeg: number;
};
const prim = json.meshes[0]!.primitives[0]!;
const pos = readAccessor(model, prim.attributes.POSITION!).data;
const verts = Array.from(
  { length: pos.length / 3 },
  (_, i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]),
);
const tris = readAccessor(model, prim.indices!).data.length / 3;

/** The shipped knife as a KnifeModel (geometry from disk, blank textures). */
function shipped(): KnifeModel {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(pos), 3));
  const t = new THREE.Texture();
  return {
    geometry: g,
    material: knifeMaterial({ map: t, normalMap: t, arm: t }),
    anchors: KNIFE_ANCHORS,
  };
}

const node = (name: string): number[] =>
  json.nodes.find((n) => n.name === name)?.translation ?? [0, 0, 0];

describe('seax knife model (models/knife)', () => {
  it('exports its anchors where the client expects them (knife.json, glTF nodes, constants)', () => {
    const want = {
      knife_tip: KNIFE_ANCHORS.tip,
      knife_edge: KNIFE_ANCHORS.edge,
      knife_guard: KNIFE_ANCHORS.guard,
      knife_pommel: KNIFE_ANCHORS.pommel,
    };
    for (const [name, p] of Object.entries(want)) {
      for (let k = 0; k < 3; k++) {
        expect(node(name)[k]).toBeCloseTo(p[k]!, 4);
        expect(manifest.anchors[name]![k]).toBeCloseTo(p[k]!, 4);
      }
    }
    // Grip origin = the fist: the empty sits at the origin.
    expect(json.nodes.find((n) => n.name === 'knife_grip')).toBeDefined();
    expect(node('knife_grip')).toEqual([0, 0, 0]);
  });

  it('puts the tip anchor on the mesh tip and the edge anchor on the cutting edge', () => {
    const tip = new THREE.Vector3(...KNIFE_ANCHORS.tip);
    const front = verts.reduce((a, v) => (v.z < a.z ? v : a));
    expect(front.distanceTo(tip)).toBeLessThan(0.001);
    // The edge: the blade's lowest vertices around the anchor's z (between two sections).
    const e = KNIFE_ANCHORS.edge;
    const near = verts.filter((v) => Math.abs(v.z - e[2]) < 0.012 && v.z < -0.07);
    const low = Math.min(...near.map((v) => v.y));
    expect(Math.abs(low - e[1])).toBeLessThan(0.0008);
    expect(near.some((v) => Math.abs(v.x) < 1e-5 && Math.abs(v.y - low) < 1e-5)).toBe(true);
  });

  it('is a seax: broken back with a steep clip, a ~21 cm blade, blade along -Z, edge down', () => {
    expect(manifest.clipDeg).toBeGreaterThan(24);
    expect(manifest.clipDeg).toBeLessThan(31);
    const blade = KNIFE_ANCHORS.guard[2] - KNIFE_ANCHORS.tip[2];
    expect(blade).toBeGreaterThan(0.2);
    expect(blade).toBeLessThan(0.225);
    // Spine (max y) along the blade peaks at the break, not at the guard or the tip.
    const top = (z0: number, z1: number): number =>
      Math.max(...verts.filter((v) => v.z < z0 && v.z > z1).map((v) => v.y));
    const atGuard = top(-0.068, -0.075);
    const atBreak = top(-0.22, -0.228);
    const nearTip = top(-0.26, -0.27);
    expect(atBreak - atGuard).toBeGreaterThan(0.005);
    expect(atBreak - nearTip).toBeGreaterThan(0.012);
  });

  it('stays within its budgets (triangles; one mesh)', () => {
    expect(tris).toBe(manifest.triangles);
    expect(tris).toBeLessThan(2500);
    expect(json.meshes).toHaveLength(1);
  });

  it('uses the gun scans’ material recipe (shares their program)', () => {
    const m = shipped().material;
    expect(m.map && m.normalMap && m.roughnessMap && m.metalnessMap).toBeTruthy();
    expect(m.roughnessMap).toBe(m.metalnessMap);
    expect(m.vertexColors).toBe(false);
    expect(m.transparent).toBe(false);
  });
});

describe('knife integration', () => {
  it('swaps both viewmodel knives and samples the trail at the model’s tip and edge', () => {
    const vm = new Viewmodel();
    const k = shipped();
    vm.useKnifeModel(k);
    const knives: THREE.Object3D[] = [];
    vm.scene.traverse((o) => {
      if (o.name === 'knife:model') knives.push(o);
    });
    expect(knives).toHaveLength(2); // slot knife + Q quick-knife
    for (const o of knives) expect((o as THREE.Mesh).geometry).toBe(k.geometry);
    const t = vm.trailPoints;
    const want = modelTrailPoints(KNIFE_ANCHORS);
    expect(t.tip.distanceTo(want.tip)).toBeLessThan(1e-9);
    expect(t.mid.distanceTo(want.mid)).toBeLessThan(1e-9);
    // In the knife mesh's own space the trail points are exactly its anchors.
    const at = new THREE.Vector3(...KNIFE_MODEL_AT);
    expect(
      t.tip
        .clone()
        .sub(at)
        .distanceTo(new THREE.Vector3(...KNIFE_ANCHORS.tip)),
    ).toBeLessThan(1e-9);
    expect(
      t.mid
        .clone()
        .sub(at)
        .distanceTo(new THREE.Vector3(...KNIFE_ANCHORS.edge)),
    ).toBeLessThan(1e-9);
    // The ribbon spans the outer blade (tip → 9 cm off the guard, ~12 cm), not the grip.
    expect(t.tip.distanceTo(t.mid)).toBeGreaterThan(0.1);
    expect(t.tip.distanceTo(t.mid)).toBeLessThan(0.14);
  });

  it('gives soldiers the model (shared geometry, own material copy) in the same fist pose', () => {
    const scans = new Map<ScanGunId, ScanGun>(
      SCAN_GUN_IDS.map((id) => [
        id,
        { geometry: new THREE.BufferGeometry(), material: new THREE.MeshStandardMaterial() },
      ]),
    );
    const k = shipped();
    const withModel = thirdPersonModels(scans, k).knife!;
    const primitive = thirdPersonModels(scans).knife!;
    expect(withModel.geometry).toBe(k.geometry);
    expect(withModel.material).not.toBe(k.material);
    expect(withModel.position.toArray()).toEqual(primitive.position.toArray());
    expect(withModel.rotation?.toArray()).toEqual(primitive.rotation?.toArray());
  });

  it('turns the partner’s model blade to +Z (its knife frame) with a glint material', () => {
    const pv = new PartnerView();
    const k = shipped();
    pv.useKnifeModel(k);
    const g = (pv as unknown as { modelKnife(m: KnifeModel): THREE.Group }).modelKnife(k);
    g.updateMatrixWorld(true);
    const mesh = g.children[0] as THREE.Mesh;
    const tip = mesh.localToWorld(new THREE.Vector3(...KNIFE_ANCHORS.tip));
    expect(tip.z).toBeGreaterThan(0.27);
    expect(tip.y).toBeCloseTo(KNIFE_ANCHORS.tip[1], 6); // edge stays down
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat).not.toBe(k.material);
    expect(mat.emissiveIntensity).toBe(0);
  });
});

describe('knife arms (the real gloved arms hold the seax)', () => {
  const armsDir = new URL('../../public/models/arms/', import.meta.url);
  const pivots = (
    JSON.parse(readFileSync(new URL('arms.json', armsDir), 'utf8')) as {
      poses: Record<string, { bones: ArmPivots }>;
    }
  ).poses.knife!.bones;
  const arms = () => ({
    geometry: new THREE.BoxGeometry(0.1, 0.1, 0.1),
    material: new THREE.MeshStandardMaterial(),
    pivots,
  });

  it('ships a knife pose whose fist holds the handle', () => {
    const [, , wrist, knuckle] = pivots.R.map((p) => new THREE.Vector3(...p));
    const grip = new THREE.Vector3(...KNIFE_MODEL_AT);
    // The handle sits a hand's breadth past the wrist, toward the knuckles (not in the forearm).
    expect(wrist!.distanceTo(grip)).toBeGreaterThan(0.03);
    expect(wrist!.distanceTo(grip)).toBeLessThan(0.11);
    expect(knuckle!.clone().sub(wrist!).dot(grip.clone().sub(wrist!))).toBeGreaterThan(0);
  });

  it('replaces the primitive fist and keeps the hand on the knife through a cut', () => {
    const vm = new Viewmodel();
    vm.useKnifeModel(shipped(), arms());
    const names: string[] = [];
    vm.scene.traverse((o) => names.push(o.name));
    expect(names.filter((n) => n === 'knife:arms')).toHaveLength(2);
    expect(names.filter((n) => n === 'knife:model')).toHaveLength(2);
    const p = vm as unknown as {
      knifeArms: ArmRig;
      poseKnifeArms(
        r: ArmRig,
        k: THREE.Matrix4,
        toFrame: THREE.Matrix4,
        guard: number,
        leftDrop: number | null,
      ): void;
    };
    const rig = p.knifeArms;
    const held = new THREE.Matrix4().compose(
      new THREE.Vector3(0.13, -0.14, -0.285),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0.25, -0.35)),
      new THREE.Vector3(0.85, 0.85, 0.85),
    );
    const toFrame = held.clone().invert();
    // A slash keyframe: the knife moved and turned in the gun frame.
    const knife = new THREE.Matrix4().compose(
      new THREE.Vector3(-0.12, 0.05, -0.04),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.5, 0.9)),
      new THREE.Vector3(1, 1, 1),
    );
    p.poseKnifeArms(rig, knife, toFrame, 0, 0);
    // The hand bone moves the bind hand exactly as the knife moved: the grip stays in the fist.
    const hand = rig.bones[5]!.matrix;
    for (const q of [pivots.R[2], pivots.R[3], KNIFE_MODEL_AT]) {
      const a = new THREE.Vector3(...q).applyMatrix4(hand);
      const b = new THREE.Vector3(...q).applyMatrix4(knife);
      expect(a.distanceTo(b)).toBeLessThan(1e-6);
    }
    // The left fist stays where it was held (camera-steady guard), shoulders on the body.
    const lw = new THREE.Vector3(...pivots.L[2]).applyMatrix4(rig.bones[2]!.matrix);
    expect(lw.distanceTo(new THREE.Vector3(...pivots.L[2]))).toBeLessThan(1e-6);
    const ls = new THREE.Vector3(...pivots.L[0]).applyMatrix4(rig.bones[0]!.matrix);
    expect(ls.distanceTo(new THREE.Vector3(...pivots.L[0]))).toBeLessThan(1e-6);
    // The guard raises the left wrist (camera up), and the quick rig hides the left arm.
    p.poseKnifeArms(rig, new THREE.Matrix4(), toFrame, 1, 0);
    const up = new THREE.Vector3(...pivots.L[2])
      .applyMatrix4(rig.bones[2]!.matrix)
      .applyMatrix4(held);
    const rest = new THREE.Vector3(...pivots.L[2]).applyMatrix4(held);
    expect(up.y - rest.y).toBeGreaterThan(0.05);
    p.poseKnifeArms(rig, new THREE.Matrix4(), toFrame, 0, null);
    expect(rig.bones[0]!.matrix.determinant()).toBe(0);
  });
});

describe('knife off-hand follows throws and holstering', () => {
  const armsDir = new URL('../../public/models/arms/', import.meta.url);
  const pivots = (
    JSON.parse(readFileSync(new URL('arms.json', armsDir), 'utf8')) as {
      poses: Record<string, { bones: ArmPivots }>;
    }
  ).poses.knife!.bones;
  const base = {
    slot: 'knife' as const,
    switchProgress: 1,
    adsAmount: 0,
    sprinting: false,
    reload: -1,
    speed: 0,
    grounded: true,
    lookDx: 0,
    lookDy: 0,
    bob: false,
    melee: null,
    guard: false,
    stunned: false,
    throw: null,
  };
  const setup = () => {
    const vm = new Viewmodel();
    vm.useKnifeModel(shipped(), {
      geometry: new THREE.BoxGeometry(0.1, 0.1, 0.1),
      material: new THREE.MeshStandardMaterial(),
      pivots,
    });
    const rig = (vm as unknown as { knifeArms: ArmRig }).knifeArms;
    // The left wrist in the camera (the scene's root space).
    const leftWrist = (): THREE.Vector3 | null => {
      const m = rig.bones[2]!.matrix;
      if (m.determinant() === 0) return null;
      rig.mesh.updateWorldMatrix(true, false);
      return new THREE.Vector3(...pivots.L[2]).applyMatrix4(m).applyMatrix4(rig.mesh.matrixWorld);
    };
    return { vm, leftWrist };
  };

  it('keeps the fist out of view at idle and in a cut; it rises for Block and after a parry', () => {
    const { vm, leftWrist } = setup();
    for (let i = 0; i < 30; i++) vm.update(1 / 60, base);
    expect(leftWrist()).toBeNull();
    const slash = { elapsed: 0.25, windup: 0.22, total: 0.6, quick: false, move: 'slash' as const };
    vm.update(1 / 60, { ...base, melee: slash });
    expect(leftWrist()).toBeNull();
    for (let i = 0; i < 40; i++) vm.update(1 / 60, { ...base, guard: true });
    const up = leftWrist()!;
    expect(up).not.toBeNull();
    // A parry keeps it up through the counter, then it drops away again.
    vm.parry();
    for (let i = 0; i < 30; i++) vm.update(1 / 60, base);
    expect(leftWrist()).not.toBeNull();
    for (let i = 0; i < 90; i++) vm.update(1 / 60, base);
    expect(leftWrist()).toBeNull();
  });

  it('lets a parry with a gun expire: drawing the knife later keeps the fist down', () => {
    const { vm, leftWrist } = setup();
    const rifle = { ...base, slot: 'rifle' as const };
    for (let i = 0; i < 30; i++) vm.update(1 / 60, rifle);
    vm.parry();
    for (let i = 0; i < 600; i++) vm.update(1 / 60, rifle);
    // Check from the very first knife frame: a frozen 0.7 s hold would raise the fist right away
    // (and expire on its own within the draw, so a check only at the end would miss it).
    for (let i = 0; i < 60; i++) {
      vm.update(1 / 60, base);
      expect(leftWrist()).toBeNull();
    }
  });

  it('hides the fist while the grenade hand holds the frag, and brings it back up after', () => {
    const { vm, leftWrist } = setup();
    const guarding = { ...base, guard: true };
    for (let i = 0; i < 40; i++) vm.update(1 / 60, guarding);
    const idle = leftWrist()!;
    expect(idle).not.toBeNull();
    const windup = 0.3;
    const total = 0.9;
    vm.update(1 / 60, { ...guarding, throw: { elapsed: 0.1, windup, total } });
    expect(leftWrist()).toBeNull(); // one left hand: the grenade's
    // Released: the fist stays down out of view (hidden) through the follow-through…
    vm.update(1 / 60, { ...guarding, throw: { elapsed: windup + 0.05, windup, total } });
    expect(leftWrist()).toBeNull();
    // …and rises back from below as the throw recovers.
    vm.update(1 / 60, { ...guarding, throw: { elapsed: total - 0.1, windup, total } });
    const after = leftWrist()!;
    expect(after.y).toBeLessThan(idle.y - 0.2);
    vm.update(1 / 60, { ...guarding, throw: { elapsed: total - 0.02, windup, total } });
    expect(leftWrist()!.y).toBeGreaterThan(after.y);
  });

  it('lowers the fist with the knife when it is put away (no pop at the hand-off)', () => {
    const { vm, leftWrist } = setup();
    const guarding = { ...base, guard: true };
    for (let i = 0; i < 40; i++) vm.update(1 / 60, guarding);
    const ys: number[] = [leftWrist()!.y];
    // Switching to the rifle: the knife is lowered for the first part of the switch.
    for (const p of [0.05, 0.12, 0.2, 0.26]) {
      vm.update(1 / 60, { ...guarding, slot: 'rifle', switchProgress: p });
      const w = leftWrist();
      ys.push(w ? w.y : -Infinity);
    }
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThan(ys[i - 1]! + 1e-9);
    // By the hand-off it is out of the bottom of the view (or already hidden).
    expect(ys[ys.length - 1]!).toBeLessThan(ys[0]! - 0.25);
  });
});
