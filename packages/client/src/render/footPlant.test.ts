import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { placeLeg } from './footPlant.ts';

function rig() {
  const root = new THREE.Group();
  root.position.set(4, 2, -3);
  root.rotation.y = 1.2;
  const hip = new THREE.Bone();
  const knee = new THREE.Bone();
  const ankle = new THREE.Bone();
  knee.position.set(0, -0.4, 0.1);
  ankle.position.set(0, -0.4, -0.1);
  root.add(hip);
  hip.add(knee);
  knee.add(ankle);
  root.updateMatrixWorld(true);
  return { root, hip, knee, ankle };
}

describe('terrain leg placement', () => {
  it('reaches a higher tread while preserving segment lengths, hip and boot orientation', () => {
    const { hip, knee, ankle } = rig();
    const originalHip = hip.getWorldPosition(new THREE.Vector3());
    const originalRotation = ankle.getWorldQuaternion(new THREE.Quaternion());
    const target = ankle.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0.2, 0.15, 0));
    const upper = originalHip.distanceTo(knee.getWorldPosition(new THREE.Vector3()));
    const lower = knee
      .getWorldPosition(new THREE.Vector3())
      .distanceTo(ankle.getWorldPosition(new THREE.Vector3()));
    expect(placeLeg(hip, knee, ankle, target)).toBe(true);
    expect(ankle.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(0.00001);
    expect(hip.getWorldPosition(new THREE.Vector3()).distanceTo(originalHip)).toBeLessThan(0.00001);
    expect(originalHip.distanceTo(knee.getWorldPosition(new THREE.Vector3()))).toBeCloseTo(
      upper,
      6,
    );
    expect(
      knee
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(ankle.getWorldPosition(new THREE.Vector3())),
    ).toBeCloseTo(lower, 6);
    expect(ankle.getWorldQuaternion(new THREE.Quaternion()).angleTo(originalRotation)).toBeLessThan(
      0.00001,
    );
  });

  it('rejects unreachable lower terrain without stretching or modifying the rig', () => {
    const { hip, knee, ankle } = rig();
    const rotations = [hip, knee, ankle].map((b) => b.quaternion.clone());
    const target = ankle.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -0.3, 0));
    expect(placeLeg(hip, knee, ankle, target)).toBe(false);
    [hip, knee, ankle].forEach((bone, i) =>
      expect(bone.quaternion.equals(rotations[i]!)).toBe(true),
    );
  });
});
