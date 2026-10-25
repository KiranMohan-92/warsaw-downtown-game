import * as THREE from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cratePile, jersey, PROP_GEOMETRY, type MapDefinition, type MaterialId } from '@wd/shared';
import { buildMapMeshes, PROP_GREYBOX } from './mapMesh.ts';
import type { MapMaterials } from './materials.ts';
import { PROP_MODEL_IDS } from './propFit.ts';
import {
  buildPropMeshes,
  installPropModels,
  loadPropModels,
  propEntries,
  propInstances,
  PROP_CHUNK_SIZE,
  PROP_LOD_DISTANCE,
  PROP_LOD_HYSTERESIS,
  EXACT_PROP_COVER,
  propNeedsDetail,
  type PropLoadOptions,
} from './propModels.ts';

afterEach(() => vi.restoreAllMocks());

describe('prop detail distance budget', () => {
  it('bounds detail at 45 m with 6 m hysteresis regardless of size, zoom or resolution', () => {
    for (const projection of [0, 1600, 10_000, -1, NaN, Infinity]) {
      expect(propNeedsDetail(45, 200, projection, false)).toBe(true);
      expect(propNeedsDetail(46, 200, projection, false)).toBe(false);
      expect(propNeedsDetail(51, 200, projection, true)).toBe(true);
      expect(propNeedsDetail(52, 2, projection, true)).toBe(false);
      expect(propNeedsDetail(100, 200, projection, false)).toBe(false);
    }
  });
});

/** Preserve default geometry/material types when narrowing the generic three.js class. */
const isInstanced = (object: THREE.Object3D | undefined): object is THREE.InstancedMesh =>
  object instanceof THREE.InstancedMesh;

/** `MapMaterials` without the procedural textures (they need a DOM canvas). */
class FakeMaterials {
  typicalRoughness(): number {
    return 0.12;
  }
  onActiveMaps(): void {}
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();
  get(id: MaterialId): THREE.MeshStandardMaterial {
    let m = this.mats.get(id);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ name: id });
      this.mats.set(id, m);
    }
    return m;
  }
  variant(
    id: MaterialId,
    _key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    const mat = this.get(id).clone();
    configure(mat);
    return mat;
  }
  facadeShellVariant(
    key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    return this.variant('facade', `shell|${key}`, configure);
  }
}

/** A map with one plain box, a tagged crate pile, a jersey run and two decor pieces. */
function propMap(): MapDefinition {
  return {
    name: 'props-test',
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    boxes: [
      { center: { x: 0, y: 1, z: 8 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' },
      ...cratePile({ x: 4, z: 0 }),
      ...jersey({ x: -5, z: -3, rot: 30 }, 6),
    ],
    decor: [
      { kind: 'bin', x: 1, z: 1, rot: 20 },
      { kind: 'lamp', x: -8, z: 6 },
    ],
    spawns: [],
    dummies: [],
  };
}

/** Loaders that serve a unit box for every model and blank textures, recording the urls. */
function fakeLoaders(
  urls: string[] = [],
): Required<Pick<PropLoadOptions, 'loadGeometry' | 'loadTexture' | 'base'>> {
  return {
    base: '/',
    loadGeometry: (url) => {
      urls.push(url);
      return Promise.resolve(new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(0, 0.25, 0));
    },
    loadTexture: (url) => {
      urls.push(url);
      return Promise.resolve(new THREE.Texture());
    },
  };
}

describe('loadPropModels', () => {
  it('loads every model and the shared atlas into ONE material (Low: the half-size atlas)', async () => {
    const urls: string[] = [];
    const models = await loadPropModels(null, { lowRes: true, ...fakeLoaders(urls) });
    expect([...models.geometries.keys()].sort()).toEqual([...PROP_MODEL_IDS].sort());
    for (const id of PROP_MODEL_IDS) {
      expect(urls).toContain(`/models/${id}/${id}.gltf`);
      expect(models.sizes[id]).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
    }
    for (const m of ['albedo', 'normal', 'arm'])
      expect(urls).toContain(`/models/atlas_${m}_low.webp`);
    expect(models.material.map).not.toBeNull();
    expect(models.material.normalMap).not.toBeNull();
    expect(models.material.roughnessMap).toBe(models.material.metalnessMap);
    expect(models.material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(models.material.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('rejects when any model fails (all or nothing)', async () => {
    const loaders = fakeLoaders();
    await expect(
      loadPropModels(null, {
        ...loaders,
        loadGeometry: (url) =>
          url.includes('drum') ? Promise.reject(new Error('404')) : loaders.loadGeometry(url),
      }),
    ).rejects.toThrow('404');
  });

  it('prebuilds smaller far meshes with the same shader attributes and bounded silhouettes', async () => {
    const models = await loadPropModels(null, {
      ...fakeLoaders(),
      loadGeometry: () =>
        Promise.resolve(new THREE.CylinderGeometry(0.3, 0.3, 0.8, 32, 8).translate(0, 0.4, 0)),
    });
    for (const id of PROP_MODEL_IDS) {
      const near = models.geometries.get(id)!;
      const far = models.farGeometries.get(id)!;
      if (EXACT_PROP_COVER.has(id)) {
        // Exact identity protects all existing collision/slat ray tests at every distance.
        expect(far).toBe(near);
        continue;
      }
      expect(far).not.toBe(near);
      expect(far.getIndex()!.count).toBeLessThan(near.getIndex()!.count * 0.4);
      expect(Object.keys(far.attributes).sort()).toEqual(Object.keys(near.attributes).sort());
      far.computeBoundingBox();
      expect(near.boundingBox!.containsBox(far.boundingBox!)).toBe(true);
      expect(far.boundingBox!.min.y).toBeCloseTo(near.boundingBox!.min.y, 5);
      expect(far.boundingBox!.max.y).toBeCloseTo(near.boundingBox!.max.y, 5);
    }
  });

  it('releases resources that finish after the timeout', async () => {
    const texture = new THREE.Texture();
    const dispose = vi.spyOn(texture, 'dispose');
    let finish!: (value: THREE.Texture) => void;
    const pending = new Promise<THREE.Texture>((resolve) => {
      finish = resolve;
    });
    await expect(
      loadPropModels(null, { ...fakeLoaders(), loadTexture: () => pending, timeoutMs: 5 }),
    ).rejects.toThrow(/timed out/);
    finish(texture);
    await pending;
    await Promise.resolve();
    expect(dispose).toHaveBeenCalled();
  });

  it('bounds simplifier readiness by the same deadline and releases late LOD geometry', async () => {
    const far = new THREE.BoxGeometry();
    const dispose = vi.spyOn(far, 'dispose');
    let finish!: (value: THREE.BufferGeometry) => void;
    const pending = new Promise<THREE.BufferGeometry>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(SimplifyModifier.prototype, 'modify').mockReturnValue(pending);
    await expect(loadPropModels(null, { ...fakeLoaders(), timeoutMs: 5 })).rejects.toThrow(
      /timed out/,
    );
    finish(far);
    await pending;
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects invalid bounds before trying to fit models', async () => {
    await expect(
      loadPropModels(null, {
        ...fakeLoaders(),
        loadGeometry: () => Promise.resolve(new THREE.BoxGeometry(1, 0, 1)),
      }),
    ).rejects.toThrow(/invalid bounds/);
  });

  it('rejects a model without uvs', async () => {
    const loaders = fakeLoaders();
    await expect(
      loadPropModels(null, {
        ...loaders,
        loadGeometry: async (url) => {
          const g = await loaders.loadGeometry(url);
          if (url.includes('tyre')) g.deleteAttribute('uv');
          return g;
        },
      }),
    ).rejects.toThrow(/tyre: no uv/);
  });

  it('gives up after the timeout', async () => {
    await expect(
      loadPropModels(null, {
        ...fakeLoaders(),
        loadTexture: () => new Promise<THREE.Texture>(() => {}),
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('installPropModels', () => {
  const greyboxOf = (scene: THREE.Object3D): THREE.Object3D | undefined =>
    scene.getObjectByName(PROP_GREYBOX);

  it('draws tagged boxes and decor as greybox in their own group, other boxes as before', () => {
    const map = propMap();
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [],
    });
    const grey = greyboxOf(group)!;
    expect(grey).toBeDefined();
    let tris = 0;
    grey.traverse((o) => {
      if (o instanceof THREE.Mesh) tris += (o.geometry as THREE.BufferGeometry).index!.count / 3;
    });
    // Fallback preserves the actual cover silhouettes, including gaps (no invisible box walls).
    expect(tris).toBeGreaterThan(100);
    expect(PROP_GEOMETRY.lamp.indices.length).toBeGreaterThan(0);
    // The untagged box stays in the map proper.
    const outside: THREE.Mesh[] = [];
    group.traverse((o) => {
      if (o instanceof THREE.Mesh && !grey.getObjectById(o.id)) outside.push(o as THREE.Mesh);
    });
    expect(outside.some((m) => m.name.startsWith('map:concrete'))).toBe(true);
  });

  it('swaps the fallback for spatially culled instanced models without requiring multi-draw', async () => {
    const map = propMap();
    const scene = new THREE.Scene();
    scene.add(buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, { bakes: [] }));
    const models = await loadPropModels(null, fakeLoaders());
    const mesh = installPropModels(scene, map, models);
    expect(mesh).toBeInstanceOf(THREE.Group);
    expect(mesh!.parent).toBe(scene);
    expect(greyboxOf(scene)).toBeUndefined();
    const batches = mesh!.children.filter(
      (m) => !m.name.startsWith('props:shadow:'),
    ) as THREE.InstancedMesh[];
    expect(batches.every((m) => m instanceof THREE.InstancedMesh)).toBe(true);
    expect(batches.reduce((n, m) => n + m.count, 0)).toBe(propInstances(map, models.sizes).length);
    expect(batches.every((m) => m.receiveShadow && m.frustumCulled)).toBe(true);
    expect(batches.some((m) => m.castShadow)).toBe(true);
    expect(batches.every((m) => m.material === models.material)).toBe(true);
  });

  it('draws props a truck moved in their own slots: no new meshes, materials or programs', async () => {
    const map = propMap();
    const models = await loadPropModels(null, fakeLoaders());
    const detail = buildPropMeshes(map, models)!;
    const entries = propEntries(map, models.sizes);
    const objects = (): THREE.Object3D[] => {
      const out: THREE.Object3D[] = [];
      detail.traverse((o) => out.push(o));
      return out;
    };
    const before = objects();
    const materials = before.map((o) => (o as THREE.Mesh).material);
    // A jersey (exact cover: it has a shadow proxy too) knocked 3 m aside and turned.
    const jerseyAt = entries.findIndex((e) => e.inst.model === 'jersey' && e.id !== null);
    const { id, inst } = entries[jerseyAt]!;
    const batch = before.find(
      (o): o is THREE.InstancedMesh => isInstanced(o) && o.name.startsWith('props:jersey'),
    )!;
    const pose = {
      pos: { x: inst.pos.x + 3, y: inst.pos.y, z: inst.pos.z },
      quat: { x: 0, y: Math.sin(0.4), z: 0, w: Math.cos(0.4) },
    };
    detail.setPose(id!, pose);
    detail.update({ x: 0, y: 2, z: 0 });
    const after = objects();
    expect(after).toEqual(before);
    expect(after.map((o) => (o as THREE.Mesh).material)).toEqual(materials);
    // Its slot holds the new pose, and the batch's bounds (culling) cover it.
    const slot = new THREE.Matrix4();
    const found = Array.from({ length: batch.count }, (_, i) => {
      batch.getMatrixAt(i, slot);
      return new THREE.Vector3().setFromMatrixPosition(slot);
    }).some((p) => p.distanceTo(new THREE.Vector3(pose.pos.x, pose.pos.y, pose.pos.z)) < 1e-5);
    expect(found).toBe(true);
    expect(batch.boundingBox!.containsPoint(new THREE.Vector3(pose.pos.x, 0.5, pose.pos.z))).toBe(
      true,
    );
    // Smashed: zero scale (drawn nowhere). A new match: home again.
    detail.setPose(id!, null);
    detail.resetPoses();
    detail.update({ x: 0, y: 2, z: 0 });
    const home = Array.from({ length: batch.count }, (_, i) => {
      batch.getMatrixAt(i, slot);
      return new THREE.Vector3().setFromMatrixPosition(slot);
    }).some((p) => p.distanceTo(new THREE.Vector3(inst.pos.x, inst.pos.y, inst.pos.z)) < 1e-5);
    expect(home).toBe(true);
    // Ids follow the physics world's order (boxes that don't collide have none).
    expect(entries.filter((e) => e.id !== null).map((e) => e.id)).toEqual(
      entries.filter((e) => e.id !== null).map((_, i) => i),
    );
  });

  it('keeps drawing the greybox when the models failed (null)', () => {
    const map = propMap();
    const scene = new THREE.Scene();
    scene.add(buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, { bakes: [] }));
    expect(installPropModels(scene, map, null)).toBeNull();
    expect(greyboxOf(scene)).toBeDefined();
    expect(scene.getObjectByName('props')).toBeUndefined();
  });

  it('builds nothing for a map without props', async () => {
    const models = await loadPropModels(null, fakeLoaders());
    const map: MapDefinition = { ...propMap(), boxes: [], decor: [] };
    expect(buildPropMeshes(map, models)).toBeNull();
  });

  it('bounds separate street blocks independently, including negative coordinates', async () => {
    const models = await loadPropModels(null, fakeLoaders());
    const map: MapDefinition = {
      ...propMap(),
      boxes: [],
      decor: [-2, 0, 2].map((cell) => ({ kind: 'bin', x: cell * PROP_CHUNK_SIZE, z: 0 })),
    };
    const group = buildPropMeshes(map, models)!;
    expect(group.children).toHaveLength(3);
    for (const mesh of group.children) {
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      if (!isInstanced(mesh)) continue;
      expect(mesh.count).toBe(1);
      expect(mesh.boundingSphere!.radius).toBeLessThan(2);
    }
  });

  it('switches prebuilt geometry with hysteresis, retains cover and never changes material', async () => {
    const models = await loadPropModels(null, fakeLoaders());
    const group = buildPropMeshes(mapWithBin(), models)!;
    const mesh = group.children[0];
    if (!isInstanced(mesh)) throw new Error('missing bin');
    const near = mesh.geometry;
    const material = mesh.material;
    const version = models.material.version;
    const edge = mesh.boundingBox!.max.x;
    group.update({ x: edge + PROP_LOD_DISTANCE + PROP_LOD_HYSTERESIS + 1, y: 0, z: 0 });
    expect(mesh.geometry).toBe(models.farGeometries.get('bin'));
    expect(mesh.castShadow).toBe(false);
    expect(mesh.visible && mesh.count === 1).toBe(true);
    group.update({ x: edge + PROP_LOD_DISTANCE + 1, y: 0, z: 0 });
    expect(mesh.geometry).not.toBe(near);
    group.update({ x: edge, y: 0, z: 0 });
    expect(mesh.geometry).toBe(near);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.material).toBe(material);
    expect(models.material.version).toBe(version);
  });

  it('keeps distant meshes and casters within their distance budget even while zoomed', async () => {
    const models = await loadPropModels(null, fakeLoaders());
    const group = buildPropMeshes(mapWithBin(), models)!;
    const mesh = group.children[0];
    if (!isInstanced(mesh)) throw new Error('missing bin');
    const material = mesh.material;
    const transforms = new Float32Array(mesh.instanceMatrix.array);
    const version = models.material.version;
    const children = group.children.length;
    const eye = { x: mesh.boundingBox!.max.x + 90, y: 4, z: 0 };
    group.update(eye);
    expect(mesh.geometry).toBe(models.farGeometries.get('bin'));
    for (const projection of [100, 1600, 10_000]) {
      group.update(eye, projection);
      expect(mesh.geometry).toBe(models.farGeometries.get('bin'));
      expect(mesh.castShadow).toBe(false);
    }
    expect(mesh.material).toBe(material);
    expect(mesh.instanceMatrix.array).toEqual(transforms);
    expect(models.material.version).toBe(version);
    expect(group.children).toHaveLength(children);
  });

  it('keeps small dressing out of the shadow pass even close up', async () => {
    const models = await loadPropModels(null, fakeLoaders());
    const group = buildPropMeshes(
      {
        ...mapWithBin(),
        decor: [
          { kind: 'trashbag', x: 0, z: 0 },
          { kind: 'tyres', x: 1, z: 0 },
        ],
      },
      models,
    )!;
    group.update({ x: 0, y: 0, z: 0 });
    expect(group.children.every((mesh) => !mesh.castShadow)).toBe(true);
  });

  it('uses bounded twelve-triangle cover shadows without changing visible cover meshes', async () => {
    const models = await loadPropModels(null, fakeLoaders());
    const group = buildPropMeshes({ ...propMap(), decor: [] }, models)!;
    const proxies = group.children.filter((mesh) => mesh.name.startsWith('props:shadow:'));
    expect(proxies.length).toBeGreaterThan(0);
    for (const mesh of proxies) {
      if (!isInstanced(mesh)) throw new Error('missing shadow instance');
      expect(mesh.geometry.getIndex()!.count / 3).toBe(12);
      expect(mesh.castShadow).toBe(true);
      expect(mesh.boundingBox!.isEmpty()).toBe(false);
      expect(mesh.material).toMatchObject({ colorWrite: false, depthWrite: false });
    }
    for (const mesh of group.children.filter((mesh) => !proxies.includes(mesh))) {
      expect(mesh.castShadow).toBe(false);
      expect(mesh).toMatchObject({ material: models.material });
    }
    const geometries = group.children.map((mesh) => (mesh as THREE.InstancedMesh).geometry);
    group.update({ x: 1000, y: 0, z: 1000 }, 1_000_000);
    expect(proxies.every((mesh) => !mesh.visible)).toBe(true);
    expect(group.children.map((mesh) => (mesh as THREE.InstancedMesh).geometry)).toEqual(
      geometries,
    );
    group.update({ x: 0, y: 0, z: 0 });
    expect(proxies.every((mesh) => mesh.visible)).toBe(true);
  });

  it('warms the proxy depth shader even offscreen and restores the renderer on failure', async () => {
    const models = await loadPropModels(null, fakeLoaders());
    const group = buildPropMeshes(propMap(), models)!;
    const shadow = group.children.find((mesh) => mesh.name.startsWith('props:shadow:'));
    if (!isInstanced(shadow)) throw new Error('missing shadow proxy');
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const original = new THREE.WebGLRenderTarget(2, 2);
    let target: THREE.WebGLRenderTarget | null = original;
    const renderer = {
      toneMapping: THREE.AgXToneMapping as THREE.ToneMapping,
      getRenderTarget: () => target,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      setRenderTarget(next: THREE.WebGLRenderTarget | null) {
        target = next;
      },
      compileAsync: (root: THREE.Group) => {
        const mesh = root.children[0];
        expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
        expect(mesh).toMatchObject({ material: shadow.customDepthMaterial });
        expect(target).not.toBe(original);
        expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
        return Promise.reject(new Error('compile failed'));
      },
    };
    await expect(
      group.warmUp(renderer as unknown as THREE.WebGLRenderer, camera, scene),
    ).rejects.toThrow('compile failed');
    expect(target).toBe(original);
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);
    original.dispose();
  });
});

function mapWithBin(): MapDefinition {
  return { ...propMap(), boxes: [], decor: [{ kind: 'bin', x: 0, z: 0 }] };
}
