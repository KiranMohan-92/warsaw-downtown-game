import * as THREE from 'three';

export interface MaterialSwap {
  mesh: THREE.Mesh;
  plain: THREE.Material;
  baked: THREE.Material;
}

const identity = new THREE.Matrix4();

function schema(geometry: THREE.BufferGeometry): string {
  return Object.entries(geometry.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, a]) => `${name}:${a.array.constructor.name}:${a.itemSize}:${a.normalized}`)
    .join('|');
}

/**
 * Combine world-space map chunks without changing vertices, materials or culling spheres.
 * Original chunks stay separately culled ranges in a WEBGL_multi_draw submission. Three's
 * fallback renders those ranges individually when the extension is unavailable.
 * Only complete opaque buffers with identity world transforms qualify, so custom world-space
 * shader hooks keep receiving the original positions, with no matrix quantization.
 */
export function batchStaticChunks(
  root: THREE.Group,
  chunks: readonly THREE.Mesh[],
  swaps: readonly MaterialSwap[],
): MaterialSwap[] {
  root.updateMatrixWorld(true);
  const swapByMesh = new Map(swaps.map((swap) => [swap.mesh, swap]));
  const buckets = new Map<string, THREE.Mesh[]>();
  for (const mesh of chunks) {
    const g = mesh.geometry;
    const m = mesh.material;
    if (
      Array.isArray(m) ||
      m.transparent ||
      !mesh.parent ||
      !mesh.matrixWorld.equals(root.matrixWorld) ||
      !g.index ||
      g.drawRange.start !== 0 ||
      g.drawRange.count !== Infinity
    )
      continue;
    const lod = mesh.parent instanceof THREE.LOD ? mesh.parent : null;
    const parent = lod ? lod.parent : mesh.parent;
    const level = lod ? lod.levels.findIndex((l) => l.object === mesh) : -1;
    const baked = swapByMesh.get(mesh)?.baked;
    const key = [
      parent!.id,
      m.uuid,
      baked?.uuid ?? '',
      mesh.renderOrder,
      mesh.castShadow,
      mesh.receiveShadow,
      mesh.layers.mask,
      level,
      schema(g),
    ].join('/');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(mesh);
    else buckets.set(key, [mesh]);
  }
  const replacements = new Map<THREE.Mesh, THREE.BatchedMesh>();
  for (const sources of buckets.values()) {
    if (sources.length < 2) continue;
    const first = sources[0]!;
    const vertices = sources.reduce((n, m) => n + m.geometry.getAttribute('position').count, 0);
    const indices = sources.reduce((n, m) => n + m.geometry.index!.count, 0);
    const batch = new THREE.BatchedMesh(
      sources.length,
      vertices,
      indices,
      first.material as THREE.Material,
    );
    batch.name = first.name;
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    batch.renderOrder = first.renderOrder;
    batch.layers.mask = first.layers.mask;
    batch.matrixAutoUpdate = false;
    const parent = first.parent instanceof THREE.LOD ? first.parent.parent! : first.parent!;
    const members: { instance: number; visibility: THREE.Object3D | null }[] = [];
    const order = new Map<number, { sphere: THREE.Sphere; id: number; z: number }>();
    let start = 0;
    for (const source of sources) {
      const geometry = source.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const geometryId = batch.addGeometry(geometry);
      const instance = batch.addInstance(geometryId);
      batch.setMatrixAt(instance, identity);
      order.set(start, { sphere: geometry.boundingSphere!.clone(), id: source.id, z: 0 });
      start += geometry.index!.count;
      let visibility: THREE.Object3D | null = null;
      if (source.parent instanceof THREE.LOD) {
        // Keep the original LOD centre, reach and hysteresis. Its non-rendering level markers
        // retain visibility; the batch reads those decisions for the world and shadow draws.
        const lod = source.parent;
        visibility = new THREE.Object3D();
        visibility.name = source.name;
        visibility.visible = source.visible;
        visibility.matrix.copy(source.matrix);
        visibility.matrixAutoUpdate = false;
        const level = lod.levels.find((l) => l.object === source)!;
        level.object = visibility;
        lod.remove(source);
        lod.add(visibility);
      } else {
        source.removeFromParent();
      }
      members.push({ instance, visibility });
      replacements.set(source, batch);
      geometry.dispose();
    }
    const projection = new THREE.Matrix4();
    const centre = new THREE.Vector3();
    batch.setCustomSort((list, camera) => {
      // Match Three's opaque projected-sphere-depth sort and original object-id ties.
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      projection.multiply(batch.matrixWorld);
      for (const item of list) {
        const original = order.get(item.start)!;
        original.z = centre.copy(original.sphere.center).applyMatrix4(projection).z;
      }
      list.sort((a, b) => {
        const x = order.get(a.start)!;
        const y = order.get(b.start)!;
        return x.z - y.z || x.id - y.id;
      });
    });
    const prepare = batch.onBeforeRender.bind(batch);
    batch.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
      for (const { instance, visibility } of members) {
        let shown = true;
        for (let o = visibility; o; o = o.parent) {
          if (!o.visible) {
            shown = false;
            break;
          }
        }
        this.setVisibleAt(instance, shown);
      }
      // Honor Game.uploadAllGeometry/DepthPrepass.warm's existing culling override internally.
      const cull = this.perObjectFrustumCulled;
      if (!this.frustumCulled) this.perObjectFrustumCulled = false;
      try {
        prepare(renderer, scene, camera, geometry, material, group);
      } finally {
        this.perObjectFrustumCulled = cull;
      }
    };
    // Built-in onBeforeShadow calls our preparation hook with the independent shadow camera.
    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    parent.add(batch);
  }
  const seen = new Set<THREE.Mesh>();
  return swaps.flatMap((swap) => {
    const mesh = replacements.get(swap.mesh) ?? swap.mesh;
    if (seen.has(mesh)) return [];
    seen.add(mesh);
    return [{ ...swap, mesh }];
  });
}
