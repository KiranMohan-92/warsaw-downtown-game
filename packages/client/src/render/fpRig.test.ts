import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { armSides, ArmRig, BONE, skinArms, solveArm, type ArmPivots } from './fpRig.ts';
import { SCAN_GUN_IDS } from './viewGunScans.ts';
import { modelDataReady, readAccessor, readModel } from './modelData.testUtil.ts';

await modelDataReady;

const arms = JSON.parse(
  readFileSync(new URL('../../public/models/arms/arms.json', import.meta.url), 'utf8'),
) as { poses: Record<string, { bones: ArmPivots }> };

/** A shipped arms pose as a geometry (positions + index). */
function armsGeometry(id: string): THREE.BufferGeometry {
  const model = readModel(new URL(`../../public/models/arms/${id}.gltf`, import.meta.url));
  const prim = model.json.meshes[0]!.primitives[0]!;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(readAccessor(model, prim.attributes.POSITION!).data, 3),
  );
  g.setIndex(new THREE.BufferAttribute(readAccessor(model, prim.indices!).data, 1));
  return g;
}

const V = (a: [number, number, number]): THREE.Vector3 => new THREE.Vector3(...a);

describe('first-person arm rig', () => {
  it('exports rigid bones: every pose has the same upper-arm and forearm lengths', () => {
    const len = (id: string, side: 'L' | 'R', a: number, b: number): number =>
      V(arms.poses[id]!.bones[side][a]!).distanceTo(V(arms.poses[id]!.bones[side][b]!));
    for (const side of ['L', 'R'] as const) {
      const upper = len('rifle', side, 0, 1);
      const fore = len('rifle', side, 1, 2);
      expect(upper).toBeGreaterThan(0.2);
      expect(fore).toBeGreaterThan(0.2);
      for (const id of SCAN_GUN_IDS) {
        expect(len(id, side, 0, 1), `${id} ${side}`).toBeCloseTo(upper, 2);
        expect(len(id, side, 1, 2), `${id} ${side}`).toBeCloseTo(fore, 2);
      }
    }
  });

  it('puts the wrist pivots on the baked hands (the mesh is where the pivots say)', () => {
    for (const id of SCAN_GUN_IDS) {
      const pos = armsGeometry(id).getAttribute('position');
      for (const side of ['L', 'R'] as const) {
        const w = V(arms.poses[id]!.bones[side][2]);
        let near = Infinity;
        for (let i = 0; i < pos.count; i++)
          near = Math.min(near, new THREE.Vector3().fromBufferAttribute(pos, i).distanceTo(w));
        expect(near, `${id} ${side}`).toBeLessThan(0.035);
      }
    }
  });

  it('solves the two-bone IK: reaches the target, keeps the bone lengths and the elbow side', () => {
    const chain = arms.poses.rifle!.bones.L;
    const s = V(chain[0]);
    const t = V(chain[2]).add(new THREE.Vector3(0.02, -0.08, 0.05));
    const sol = solveArm(chain, s, t, new THREE.Quaternion());
    expect(sol.wrist.distanceTo(t)).toBeLessThan(1e-6);
    expect(sol.elbow.distanceTo(s)).toBeCloseTo(V(chain[1]).distanceTo(s), 6);
    expect(sol.wrist.distanceTo(sol.elbow)).toBeCloseTo(V(chain[2]).distanceTo(V(chain[1])), 6);
    // The elbow stays on its baked side of the shoulder→wrist line.
    const line = t.clone().sub(s).normalize();
    const off = sol.elbow.clone().sub(s);
    off.addScaledVector(line, -off.dot(line));
    const f0 = V(chain[2]).sub(s).normalize();
    const pole0 = V(chain[1]).sub(s);
    pole0.addScaledVector(f0, -pole0.dot(f0));
    expect(off.dot(pole0)).toBeGreaterThan(0);
    // Bind target: identity rotations.
    const bind = solveArm(chain, s, V(chain[2]), new THREE.Quaternion());
    expect(bind.upper.angleTo(new THREE.Quaternion())).toBeLessThan(2e-3); // mm-rounded pivots
    expect(bind.fore.angleTo(new THREE.Quaternion())).toBeLessThan(2e-3); // mm-rounded pivots
    // Out of reach: clamped along the line, never NaN.
    const far = solveArm(
      chain,
      s,
      s.clone().add(new THREE.Vector3(0, 0, -5)),
      new THREE.Quaternion(),
    );
    expect(Number.isFinite(far.elbow.x + far.wrist.z)).toBe(true);
  });

  it('skins each arm to its own side, weights summing to one (pistol: overlapping hands)', () => {
    for (const id of ['pistol', 'rifle']) {
      const g = armsGeometry(id);
      const pivots = arms.poses[id]!.bones;
      const sides = armSides(g, pivots);
      skinArms(g, pivots);
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      const pos = g.getAttribute('position');
      let handL = 0;
      for (let i = 0; i < pos.count; i++) {
        const sum = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
        expect(sum).toBeCloseTo(1, 5);
        const bones = BONE[sides[i]!];
        expect(bones).toContain(si.getX(i));
        const p = new THREE.Vector3().fromBufferAttribute(pos, i);
        // Near the left wrist, on the left arm: mostly the hand/forearm, never the upper arm.
        if (sides[i] === 'L' && p.distanceTo(V(pivots.L[2])) < 0.03) {
          expect(sw.getX(i)).toBeLessThan(0.05);
          handL++;
        }
      }
      expect(handL, id).toBeGreaterThan(5);
      // Both arms present.
      expect(sides.filter((s) => s === 'L').length).toBeGreaterThan(pos.count * 0.3);
      expect(sides.filter((s) => s === 'R').length).toBeGreaterThan(pos.count * 0.3);
    }
  });

  it('moves the skinned wrist to the target (bone matrices = bind→pose deltas)', () => {
    const g = armsGeometry('rifle');
    const pivots = arms.poses.rifle!.bones;
    skinArms(g, pivots);
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
    const rig = new ArmRig(mesh, pivots);
    const w0 = V(pivots.L[2]);
    const target = w0.clone().add(new THREE.Vector3(0, -0.1, 0.05));
    rig.pose({ L: { wrist: target, hand: new THREE.Quaternion() }, R: null });
    mesh.updateMatrixWorld(true);
    rig.skeleton.update();
    // A vertex at the wrist, fully on the hand bone, lands at the target.
    const hand = rig.bones[BONE.L[2]]!;
    const moved = w0.clone().applyMatrix4(hand.matrix);
    expect(moved.distanceTo(target)).toBeLessThan(1e-6);
    rig.rest();
    expect(hand.matrix.equals(new THREE.Matrix4())).toBe(true);
  });
});
