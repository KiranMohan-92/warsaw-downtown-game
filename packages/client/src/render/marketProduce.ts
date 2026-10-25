import * as THREE from 'three';

export const PRODUCE_DETAIL_LIMIT = 512;
export const PRODUCE_DETAIL_DISTANCE = 2.75;
const MOVE_THRESHOLD_SQ = 0.15 ** 2;

interface Batch {
  mesh: THREE.InstancedMesh;
  original: Float32Array;
}
interface Pick {
  batch: Batch;
  index: number;
  distanceSq: number;
}
interface Detail {
  batches: Batch[];
  near: THREE.InstancedMesh;
  selected: Pick[];
  eye: THREE.Vector3;
}
const details = new WeakMap<THREE.Object3D, Detail>();
const matrix = new THREE.Matrix4();
const colour = new THREE.Color();

/** A single additional draw, capped independently of how many stalls the map contains. */
export function installProduceDetail(
  group: THREE.Group,
  material: THREE.Material,
): THREE.InstancedMesh {
  const existing = details.get(group);
  if (existing) return existing.near;
  const batches = group.children
    .filter(
      (o): o is THREE.InstancedMesh =>
        o instanceof THREE.InstancedMesh && o.userData.fruit === true,
    )
    .map((mesh) => ({ mesh, original: new Float32Array(mesh.instanceMatrix.array) }));
  const geo = new THREE.SphereGeometry(1, 8, 5);
  geo.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      new Float32Array(geo.attributes.position!.count * 3).fill(1),
      3,
    ),
  );
  const bakedLights = new THREE.InstancedBufferAttribute(
    new Float32Array(PRODUCE_DETAIL_LIMIT * 4),
    4,
  );
  bakedLights.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aStallLight', bakedLights);
  const near = new THREE.InstancedMesh(geo, material, PRODUCE_DETAIL_LIMIT);
  near.name = 'dressing:produce-detail';
  near.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(PRODUCE_DETAIL_LIMIT * 3).fill(1),
    3,
  );
  near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  near.instanceColor.setUsage(THREE.DynamicDrawUsage);
  near.castShadow = false;
  near.receiveShadow = false;
  near.count = 0;
  near.visible = false;
  // Selection is camera-distance bounded. Avoid stale instance bounds after a teleport.
  near.frustumCulled = false;
  group.add(near);
  details.set(group, {
    batches,
    near,
    selected: [],
    eye: new THREE.Vector3(Infinity, Infinity, Infinity),
  });
  return near;
}

/** A zero-count instance never uploads through a real draw; expose one during loading only. */
export function showProduceDetailForWarmup(group: THREE.Object3D): () => void {
  const near = details.get(group)?.near;
  if (!near) return () => {};
  const count = near.count;
  const visible = near.visible;
  near.count = Math.max(1, count);
  near.visible = true;
  return () => {
    near.count = count;
    near.visible = visible;
  };
}

/** Repack only after meaningful movement; restore coarse transforms before changing selection. */
export function updateProduceDetail(group: THREE.Object3D, eye: THREE.Vector3): void {
  const state = details.get(group);
  if (!state || state.eye.distanceToSquared(eye) < MOVE_THRESHOLD_SQ) return;
  state.eye.copy(eye);
  const changed = new Set<Batch>();
  for (const pick of state.selected) {
    const at = pick.index * 16;
    pick.batch.mesh.instanceMatrix.array.set(pick.batch.original.subarray(at, at + 16), at);
    changed.add(pick.batch);
  }
  const candidates: Pick[] = [];
  for (const batch of state.batches) {
    if (
      !batch.mesh.visible ||
      batch.mesh.boundingBox!.distanceToPoint(eye) > PRODUCE_DETAIL_DISTANCE
    )
      continue;
    for (let i = 0; i < batch.mesh.count; i++) {
      const at = i * 16;
      const x = batch.original[at + 12]! - eye.x;
      const y = batch.original[at + 13]! - eye.y;
      const z = batch.original[at + 14]! - eye.z;
      const distanceSq = x * x + y * y + z * z;
      if (distanceSq <= PRODUCE_DETAIL_DISTANCE ** 2)
        candidates.push({ batch, index: i, distanceSq });
    }
  }
  candidates.sort((a, b) => a.distanceSq - b.distanceSq);
  state.selected = candidates.slice(0, PRODUCE_DETAIL_LIMIT);
  const lights = state.near.geometry.getAttribute('aStallLight');
  for (let slot = 0; slot < state.selected.length; slot++) {
    const { batch, index } = state.selected[slot]!;
    const at = index * 16;
    matrix.fromArray(batch.original, at);
    state.near.setMatrixAt(slot, matrix);
    batch.mesh.getColorAt(index, colour);
    state.near.setColorAt(slot, colour);
    const source = batch.mesh.geometry.getAttribute('aStallLight');
    if (source)
      lights.setXYZW(
        slot,
        source.getX(index),
        source.getY(index),
        source.getZ(index),
        source.getW(index),
      );
    else lights.setXYZW(slot, 0, 0, 0, 0);
    // Subpixel scale retains finite normal transforms; original culling bounds remain valid.
    const array = batch.mesh.instanceMatrix.array;
    for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) array[at + k] = batch.original[at + k]! * 1e-6;
    changed.add(batch);
  }
  for (const batch of changed) batch.mesh.instanceMatrix.needsUpdate = true;
  state.near.count = state.selected.length;
  state.near.visible = state.near.count > 0;
  state.near.instanceMatrix.needsUpdate = true;
  state.near.instanceColor!.needsUpdate = true;
  lights.needsUpdate = true;
}
