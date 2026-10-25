import * as THREE from 'three';

/** Visible terrain only: hidden stair ramps are not a boot contact surface. */
export type FootSupport = (x: number, y: number, z: number) => number | null;

interface Leg {
  thigh: THREE.Bone;
  calf: THREE.Bone;
  foot: THREE.Bone;
  vertices: { mesh: THREE.SkinnedMesh; index: number; point: THREE.Vector3 }[];
  target: THREE.Vector3 | null;
  refresh: number;
  origin: THREE.Vector3;
  rotation: THREE.Quaternion;
  footRotation: THREE.Quaternion;
  solved: THREE.Quaternion[] | null;
  hip: THREE.Vector3;
}

/** Small terrain adaptation; the animation still owns swing, flight and special stances. */
export class FootPlant {
  private readonly legs: Leg[] = [];

  private lowSole(leg: Leg): THREE.Vector3[] {
    let minimum = Infinity;
    for (const { mesh, index, point } of leg.vertices) {
      mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
      minimum = Math.min(minimum, point.y);
    }
    return leg.vertices.filter(({ point }) => point.y <= minimum + 0.045).map(({ point }) => point);
  }

  private outline(leg: Leg): THREE.Vector3[] {
    const low = this.lowSole(leg);
    const outline = new Set<THREE.Vector3>();
    for (const project of [
      (v: THREE.Vector3) => v.x,
      (v: THREE.Vector3) => v.y,
      (v: THREE.Vector3) => v.z,
      (v: THREE.Vector3) => v.x + v.z,
      (v: THREE.Vector3) => v.x - v.z,
    ]) {
      low.sort((a, b) => project(a) - project(b));
      if (low.length) {
        outline.add(low[0]!);
        outline.add(low[low.length - 1]!);
      }
    }
    // Candidate contact solves resample the sole. Keep this search outline independent
    // of the reused vertex scratch points so those solves cannot move later candidates.
    return [...outline].map((point) => point.clone());
  }

  private contact(leg: Leg, target: THREE.Vector3): boolean {
    for (let i = 0; i < 3; i++) {
      if (!placeLeg(leg.thigh, leg.calf, leg.foot, target)) return false;
      let gap = Infinity;
      for (const point of this.lowSole(leg)) {
        const y = this.support(point.x, point.y + 0.45, point.z);
        if (y !== null) gap = Math.min(gap, point.y - y);
      }
      if (!Number.isFinite(gap)) return false;
      if (gap >= -0.005) return gap <= 0.025;
      // Blended calf weights and toe animation can move the sole after the leg solve.
      target.y += 0.008 - gap;
    }
    return false;
  }

  constructor(
    private readonly model: THREE.Object3D,
    private readonly support: FootSupport,
  ) {
    model.updateWorldMatrix(true, false);
    model.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const thigh = model.getObjectByName(`Bip01_${side}_Thigh`) as THREE.Bone;
      const calf = model.getObjectByName(`Bip01_${side}_Calf`) as THREE.Bone;
      const foot = model.getObjectByName(`Bip01_${side}_Foot`) as THREE.Bone;
      if (!thigh || !calf || !foot) continue;
      const vertices: Leg['vertices'] = [];
      const seen = new Set<string>();
      model.traverse((object) => {
        const mesh = object as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        const indices = mesh.geometry.getAttribute('skinIndex');
        const weights = mesh.geometry.getAttribute('skinWeight');
        mesh.skeleton.update();
        for (let i = 0; i < indices.count; i++) {
          let weight = 0;
          for (let j = 0; j < 4; j++) {
            const bone = mesh.skeleton.bones[indices.getComponent(i, j)];
            if (bone === foot || bone?.name.startsWith(`Bip01_${side}_Toe`))
              weight += weights.getComponent(i, j);
          }
          if (weight < 0.95) continue;
          const positions = mesh.geometry.getAttribute('position');
          const key = [
            positions.getX(i),
            positions.getY(i),
            positions.getZ(i),
            ...Array.from(
              { length: 4 },
              (_, j) => `${indices.getComponent(i, j)}:${weights.getComponent(i, j)}`,
            ),
          ].join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          vertices.push({ mesh, index: i, point: new THREE.Vector3() });
        }
      });
      if (vertices.length)
        this.legs.push({
          thigh,
          calf,
          foot,
          vertices,
          target: null,
          refresh: 0,
          origin: new THREE.Vector3(),
          rotation: new THREE.Quaternion(),
          footRotation: new THREE.Quaternion(),
          solved: null,
          hip: new THREE.Vector3(),
        });
    }
  }

  update(rootY: number, dt: number, moving: boolean): void {
    this.model.updateWorldMatrix(true, false);
    this.model.updateMatrixWorld(true);
    const origin = this.model.getWorldPosition(new THREE.Vector3());
    const rotation = this.model.getWorldQuaternion(new THREE.Quaternion());
    const ordered = this.legs
      .map((leg) => {
        const ankle = leg.foot.getWorldPosition(new THREE.Vector3());
        const height = this.support(ankle.x, ankle.y + 0.3, ankle.z);
        return { leg, gap: height === null ? 0 : ankle.y - height };
      })
      .sort((a, b) => b.gap - a.gap);
    // Give the unsupported foot first choice; a planted foot can keep its existing tread.
    for (const { leg } of ordered) {
      const ankle = leg.foot.getWorldPosition(new THREE.Vector3());
      const hip = leg.thigh.getWorldPosition(new THREE.Vector3());
      const knee = leg.calf.getWorldPosition(new THREE.Vector3());
      const reach = hip.distanceTo(knee) + knee.distanceTo(ankle) - 0.0001;
      const footRotation = leg.foot.getWorldQuaternion(new THREE.Quaternion());
      const pose = [leg.thigh, leg.calf, leg.foot].map((b) => b.quaternion.clone());
      const restore = () => {
        [leg.thigh, leg.calf, leg.foot].forEach((b, i) => b.quaternion.copy(pose[i]!));
        leg.thigh.updateWorldMatrix(false, true);
      };
      // A raised ankle can still have a toe below terrain. Clear only actual
      // penetration, keeping the swing's horizontal path and boot orientation.
      // Clean swing poses remain untouched and never acquire a plant target.
      if (moving && ankle.y > rootY + 0.16) {
        leg.target = null;
        leg.refresh = 0;
        let gap = Infinity;
        for (const point of this.lowSole(leg)) {
          const height = this.support(point.x, point.y + 0.45, point.z);
          if (height !== null) gap = Math.min(gap, point.y - height);
        }
        if (gap < -0.005) {
          const target = ankle.clone();
          target.y += 0.008 - gap;
          if (!this.contact(leg, target)) restore();
        }
        continue;
      }
      leg.refresh -= dt;
      // Terrain search is 10 Hz; the two-bone solve keeps the planted boot still between probes.
      if (
        leg.refresh > 0 &&
        origin.distanceToSquared(leg.origin) < 0.16 &&
        rotation.angleTo(leg.rotation) < 0.15 &&
        footRotation.angleTo(leg.footRotation) < 0.01
      ) {
        if (!moving && leg.solved && hip.distanceToSquared(leg.hip) < 0.0001) {
          // Idle breathing need not repeat terrain casts or move a planted foot every frame.
          [leg.thigh, leg.calf, leg.foot].forEach((bone, i) =>
            bone.quaternion.copy(leg.solved![i]!),
          );
          leg.thigh.updateWorldMatrix(false, true);
          continue;
        }
        if (!leg.target || this.contact(leg, leg.target)) continue;
        restore();
      }
      // Revalidate an existing stationary plant before searching for another tread.
      if (
        !moving &&
        leg.target &&
        origin.distanceToSquared(leg.origin) < 0.0001 &&
        rotation.angleTo(leg.rotation) < 0.01 &&
        hip.distanceToSquared(leg.hip) < 0.0025
      ) {
        if (this.contact(leg, leg.target)) {
          leg.refresh = 0.1;
          leg.solved = [leg.thigh, leg.calf, leg.foot].map((b) => b.quaternion.clone());
          leg.footRotation.copy(footRotation);
          leg.hip.copy(hip);
          continue;
        }
        restore();
      }
      let target: THREE.Vector3 | null = null;
      let best = Infinity;
      // The outline comes from this animated boot, including toe deformation.
      const sole = this.outline(leg);
      for (const radius of [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.48, 0.56, 0.64]) {
        for (let i = 0; i < (radius === 0 ? 1 : 16); i++) {
          const x = radius * Math.cos((i * Math.PI) / 8);
          const z = radius * Math.sin((i * Math.PI) / 8);
          let raise = -Infinity;
          let rejected = false;
          for (const point of sole) {
            const y = this.support(point.x + x, point.y + 0.45, point.z + z);
            if (y === null) continue;
            raise = Math.max(raise, y + 0.012 - point.y);
            // Raise is a running maximum: later points cannot restore an excessive
            // lift or reduce a nonnegative score that already cannot beat the best.
            if (raise > 0.4 || (raise >= 0 && radius * radius + raise * raise >= best)) {
              rejected = true;
              break;
            }
          }
          if (rejected || !Number.isFinite(raise) || Math.abs(raise) > 0.4) continue;
          const candidate = ankle.clone().add(new THREE.Vector3(x, raise, z));
          if (candidate.distanceTo(hip) > reach) continue;
          const separated = () =>
            !this.legs.some(
              (other) =>
                other !== leg &&
                candidate.distanceTo(other.foot.getWorldPosition(new THREE.Vector3())) < 0.12,
            );
          if (!separated()) continue;
          const cost = radius * radius + raise * raise;
          if (cost < best) {
            restore();
            if (this.contact(leg, candidate) && separated()) {
              target = candidate;
              best = cost;
            }
            restore();
          }
        }
        if (target) break;
      }
      if (target) this.contact(leg, target);
      leg.target = target;
      leg.refresh = 0.1;
      leg.origin.copy(origin);
      leg.rotation.copy(rotation);
      leg.footRotation.copy(footRotation);
      leg.solved = target ? [leg.thigh, leg.calf, leg.foot].map((b) => b.quaternion.clone()) : null;
      leg.hip.copy(hip);
    }
  }
}

/** Rotate a two-bone leg without translating joints or moving the torso. */
export function placeLeg(
  thigh: THREE.Bone,
  calf: THREE.Bone,
  foot: THREE.Bone,
  target: THREE.Vector3,
): boolean {
  const hip = thigh.getWorldPosition(new THREE.Vector3());
  const knee = calf.getWorldPosition(new THREE.Vector3());
  const ankle = foot.getWorldPosition(new THREE.Vector3());
  const upper = hip.distanceTo(knee);
  const lower = knee.distanceTo(ankle);
  const distance = hip.distanceTo(target);
  if (distance > upper + lower - 0.0001 || distance < Math.abs(upper - lower) + 0.0001)
    return false;
  const direction = target.clone().sub(hip).normalize();
  const bend = knee.clone().sub(hip);
  bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 1e-8) {
    bend.set(0, 0, 1).transformDirection(thigh.parent!.matrixWorld);
    bend.addScaledVector(direction, -bend.dot(direction));
    if (bend.lengthSq() < 1e-8) return false;
  }
  bend.normalize();
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const desiredKnee = hip
    .clone()
    .addScaledVector(direction, along)
    .addScaledVector(bend, Math.sqrt(Math.max(0, upper * upper - along * along)));
  const footRotation = foot.getWorldQuaternion(new THREE.Quaternion());
  const rotate = (bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3): void => {
    const rotation = new THREE.Quaternion()
      .setFromUnitVectors(from.normalize(), to.normalize())
      .multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    bone.quaternion
      .copy(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert())
      .multiply(rotation);
    bone.updateWorldMatrix(false, true);
  };
  rotate(thigh, knee.clone().sub(hip), desiredKnee.clone().sub(hip));
  const movedKnee = calf.getWorldPosition(new THREE.Vector3());
  const movedAnkle = foot.getWorldPosition(new THREE.Vector3());
  rotate(calf, movedAnkle.sub(movedKnee), target.clone().sub(movedKnee));
  // Keep the animated boot orientation; changing the calf must not tip a sole through a tread.
  foot.quaternion
    .copy(foot.parent!.getWorldQuaternion(new THREE.Quaternion()).invert())
    .multiply(footRotation);
  foot.updateWorldMatrix(false, true);
  return true;
}
