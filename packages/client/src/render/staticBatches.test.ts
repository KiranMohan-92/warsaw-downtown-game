import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DepthPrepass, PREPASS_LAYER } from './depthPrepass.ts';
import { showAllLodLevels } from './mapMesh.ts';
import { batchStaticChunks, type MaterialSwap } from './staticBatches.ts';

const material = new THREE.MeshStandardMaterial();

function chunk(x: number, m = material): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(2, 2, 2).translate(x, 1, -10);
  geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
  geometry.setAttribute('aFace', new THREE.Float32BufferAttribute(new Float32Array(96), 4));
  const mesh = new THREE.Mesh(geometry, m);
  mesh.name = `map:container|${x}`;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function ranges(batch: THREE.BatchedMesh, camera: THREE.Camera): number {
  camera.updateMatrixWorld(true);
  batch.updateMatrixWorld(true);
  batch.onBeforeRender(
    {} as THREE.WebGLRenderer,
    new THREE.Scene(),
    camera,
    batch.geometry,
    batch.material,
    null as unknown as THREE.Group,
  );
  return (batch as unknown as { _multiDrawCount: number })._multiDrawCount;
}

describe('static chunk submissions', () => {
  it('copies every attribute/index exactly and keeps the original chunk spheres and material swaps', () => {
    const root = new THREE.Group();
    const sources = [chunk(0), chunk(1000)];
    root.add(...sources);
    const baked = material.clone();
    const swaps: MaterialSwap[] = sources.map((mesh) => ({ mesh, plain: material, baked }));
    const result = batchStaticChunks(root, sources, swaps);
    expect(root.children).toHaveLength(1);
    const batch = root.children[0] as THREE.BatchedMesh;
    expect(batch).toBeInstanceOf(THREE.BatchedMesh);
    expect(batch.material).toBe(material);
    expect(batch.castShadow && batch.receiveShadow).toBe(true);
    expect(result).toEqual([{ mesh: batch, plain: material, baked }]);
    let vertex = 0;
    let index = 0;
    for (const [id, source] of sources.entries()) {
      const sphere = new THREE.Sphere();
      batch.getBoundingSphereAt(id, sphere);
      expect(sphere).toEqual(source.geometry.boundingSphere);
      batch.getMatrixAt(id, new THREE.Matrix4());
      for (const name of Object.keys(source.geometry.attributes)) {
        const attribute = source.geometry.getAttribute(name);
        const packed = batch.geometry.getAttribute(name);
        expect(
          Array.from(packed.array).slice(
            vertex * attribute.itemSize,
            (vertex + attribute.count) * attribute.itemSize,
          ),
        ).toEqual(Array.from(attribute.array));
      }
      const count = source.geometry.index!.count;
      expect(Array.from(batch.geometry.index!.array).slice(index, index + count)).toEqual(
        Array.from(source.geometry.index!.array, (i) => i + vertex),
      );
      index += count;
      vertex += source.geometry.getAttribute('position').count;
    }
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    expect(ranges(batch, camera)).toBe(1);
    batch.frustumCulled = false;
    expect(ranges(batch, camera)).toBe(2);
    expect(batch.perObjectFrustumCulled).toBe(true);
    batch.frustumCulled = true;
    expect(ranges(batch, camera)).toBe(1);
  });

  it('keeps early-Z order, caster flags and attribute schemas in separate submissions', () => {
    const root = new THREE.Group();
    const sources = [chunk(0), chunk(2), chunk(4), chunk(6), chunk(8)];
    sources[2]!.renderOrder = -1;
    sources[3]!.castShadow = false;
    sources[4]!.geometry.deleteAttribute('aFace');
    root.add(...sources);
    batchStaticChunks(root, sources, []);
    expect(root.children).toHaveLength(4);
    expect(root.children.filter((o) => o instanceof THREE.BatchedMesh)).toHaveLength(1);
    expect(sources[2]!.parent).toBe(root);
    expect(sources[3]!.parent).toBe(root);
    expect(sources[4]!.parent).toBe(root);
    const prepass = new DepthPrepass();
    expect(prepass.refresh(root)).toBe(4);
    expect(root.children.every((o) => o.layers.isEnabled(PREPASS_LAYER))).toBe(true);
  });

  it('prepares shadow ranges with the light camera instead of the view frustum', () => {
    const root = new THREE.Group();
    root.add(chunk(0), chunk(1000));
    batchStaticChunks(root, root.children as THREE.Mesh[], []);
    const batch = root.children[0] as THREE.BatchedMesh;
    const view = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    const shadow = view.clone();
    shadow.position.x = 1000;
    shadow.updateMatrixWorld(true);
    expect(ranges(batch, view)).toBe(1);
    batch.onBeforeShadow(
      {} as THREE.WebGLRenderer,
      new THREE.Scene(),
      view,
      shadow,
      batch.geometry,
      new THREE.MeshDepthMaterial(),
      null as unknown as THREE.Group,
    );
    // The selected range changes even though both cameras see exactly one chunk.
    const internals = batch as unknown as { _multiDrawCount: number; _multiDrawStarts: Int32Array };
    expect(internals._multiDrawCount).toBe(1);
    expect(internals._multiDrawStarts[0]).toBe(36 * batch.geometry.index!.array.BYTES_PER_ELEMENT);
    expect(ranges(batch, view)).toBe(1);
    expect(internals._multiDrawStarts[0]).toBe(0);
  });

  it('sorts ranges by original projected depth and object-id ties', () => {
    const root = new THREE.Group();
    const near = chunk(0);
    const far = chunk(0);
    far.geometry.translate(0, 0, -20);
    const tied = chunk(0);
    // Insertion order differs from creation order: object-id ties still choose near first.
    const sources = [far, tied, near];
    root.add(...sources);
    batchStaticChunks(root, sources, []);
    const batch = root.children[0] as THREE.BatchedMesh;
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    expect(ranges(batch, camera)).toBe(3);
    const internals = batch as unknown as { _multiDrawStarts: Int32Array };
    const stride = 36 * batch.geometry.index!.array.BYTES_PER_ELEMENT;
    expect(Array.from(internals._multiDrawStarts).slice(0, 3)).toEqual([2 * stride, stride, 0]);
  });

  it('retains independent LOD visibility, hysteresis and show-all warm-up in combined batches', () => {
    const root = new THREE.Group();
    const sources: THREE.Mesh[] = [];
    for (const x of [0, 100]) {
      const lod = new THREE.LOD();
      lod.position.set(x, 0, 0);
      for (const distance of [0, 40]) {
        const mesh = chunk(x);
        mesh.position.x = -x;
        mesh.updateMatrix();
        lod.addLevel(mesh, distance, 0.08);
        sources.push(mesh);
      }
      root.add(lod);
    }
    batchStaticChunks(root, sources, []);
    const batches = root.children.filter(
      (o): o is THREE.BatchedMesh => o instanceof THREE.BatchedMesh,
    );
    expect(batches).toHaveLength(2);
    const camera = new THREE.PerspectiveCamera(100, 16 / 9, 0.1, 2000);
    for (const o of root.children) if (o instanceof THREE.LOD) o.update(camera);
    for (const batch of batches) batch.frustumCulled = false;
    expect(batches.map((batch) => ranges(batch, camera))).toEqual([1, 1]);
    const restore = showAllLodLevels(root);
    expect(batches.map((batch) => ranges(batch, camera))).toEqual([2, 2]);
    restore();
    expect(batches.map((batch) => ranges(batch, camera))).toEqual([1, 1]);
    camera.position.set(100, 0, 0);
    camera.updateMatrixWorld(true);
    for (const o of root.children) if (o instanceof THREE.LOD) o.update(camera);
    expect(batches.map((batch) => ranges(batch, camera))).toEqual([1, 1]);
  });

  it('leaves partial draws, transformed meshes and material arrays on their existing path', () => {
    const root = new THREE.Group();
    const sources = [chunk(0), chunk(2), chunk(4)];
    sources[0]!.geometry.setDrawRange(0, 3);
    sources[1]!.position.y = 1;
    sources[2]!.material = [material];
    root.add(...sources);
    expect(batchStaticChunks(root, sources, [])).toEqual([]);
    expect(root.children).toEqual(sources);
  });
});
