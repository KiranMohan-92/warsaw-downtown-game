import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bakedLampVolume,
  bakeEmitters,
  buildLightmapLayout,
  lampVolumeLayout,
  lightmapSceneHash,
  getMap,
  resolveMap,
  type BakedLightmap,
  type MapDefinition,
  type MaterialId,
} from '@wd/shared';
import {
  bakedLightingReady,
  buildMapMeshes,
  FLAT_LIFT,
  GeoBuilder,
  setBakedLighting,
  type MapMeshOptions,
} from './mapMesh.ts';
import type { MapMaterials } from './materials.ts';
import { configureLampVolume, LAMP_VOLUME_UNIFORMS } from './lampLight.ts';
import { MARKET_NEON_STATIC_FRAGMENT } from './marketNeonStaticBake.ts';
import type * as Shared from '@wd/shared';

/** Test hook: make the selected bake's layout forget every prism (geometry it doesn't know). */
const hooks = vi.hoisted(() => ({ dropPrismFaces: false }));
vi.mock('@wd/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof Shared>();
  return {
    ...mod,
    selectBakedLightmap: (...args: Parameters<typeof mod.selectBakedLightmap>) => {
      const sel = mod.selectBakedLightmap(...args);
      return hooks.dropPrismFaces && sel.kind === 'use'
        ? { ...sel, layout: { ...sel.layout, prismFaces: [] } }
        : sel;
    },
  };
});

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
    key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    const k = `${id}|${key}`;
    let m = this.mats.get(k);
    if (!m) {
      m = this.get(id).clone();
      m.name = k;
      configure(m);
      this.mats.set(k, m);
    }
    return m;
  }
  facadeShellVariant(
    key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    return this.variant('facade', `shell|${key}`, configure);
  }
}

describe('scene-bound Market surface light', () => {
  it('patches atlas container faces, preserves their UVs and uses plain materials on Low', async () => {
    const group = buildMapMeshes(
      resolveMap(getMap('defilad'), 'market'),
      new FakeMaterials() as unknown as MapMaterials,
      { loadLightmap: greyLoader() },
    );
    const meshes: THREE.Mesh[] = [];
    group.traverse((object) => {
      if (object instanceof THREE.Mesh && object.name.startsWith('map:container|'))
        meshes.push(object as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);
    const count = group.children.length;
    const geometry = meshes.map((mesh) => mesh.geometry);
    setBakedLighting(group, true);
    const patched = meshes.filter((mesh) =>
      (mesh.material as THREE.Material).customProgramCacheKey().includes('market-neon-static-v1'),
    );
    expect(patched.length).toBeGreaterThan(0);
    for (const mesh of patched) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(mesh.geometry.getAttribute('uv1')).toBeDefined();
      expect(material.aoMap?.channel).toBe(1);
      const shader = {
        uniforms: {},
        vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      } as unknown as THREE.WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.fragmentShader).toContain(MARKET_NEON_STATIC_FRAGMENT);
    }
    setBakedLighting(group, false);
    for (const mesh of meshes) {
      expect((mesh.material as THREE.MeshStandardMaterial).aoMap).toBeNull();
      expect((mesh.material as THREE.Material).customProgramCacheKey()).not.toContain(
        'market-neon-static-v1',
      );
    }
    expect(meshes.map((mesh) => mesh.geometry)).toEqual(geometry);
    expect(group.children).toHaveLength(count);
    await bakedLightingReady(group);
  }, 60_000);
});

function tinyMap(): MapDefinition {
  return {
    name: 'tiny',
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    boxes: [{ center: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' }],
    prisms: [
      {
        pts: [
          [-20, -20],
          [20, -20],
          [20, 20],
          [-20, 20],
        ],
        y0: -0.5,
        y1: 0,
        mat: 'concrete',
        top: 'paving',
      },
      {
        pts: [
          [300, 300],
          [320, 300],
          [320, 320],
          [300, 320],
        ],
        y0: 0,
        y1: 80,
        mat: 'facade',
        backdrop: true,
      },
    ],
    flats: [
      {
        pts: [
          [-8, -8],
          [8, -8],
          [8, -7],
          [-8, -7],
        ],
        y: 0,
        mat: 'asphalt',
      },
    ],
    spawns: [],
    dummies: [],
  };
}

function bakeFor(map: MapDefinition): BakedLightmap {
  const layout = buildLightmapLayout(map);
  return {
    map: 'tiny',
    size: 'full',
    mapName: map.name,
    layoutHash: layout.hash,
    sceneHash: lightmapSceneHash(map, layout, 16),
    atlas: { file: 'tiny-atlas.png', width: layout.atlas.width, height: layout.atlas.height },
    ground: { file: 'tiny-ground.png', width: layout.ground.width, height: layout.ground.height },
    bake: { samples: 8, reach: 16 },
  };
}

const meshes = (g: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name.startsWith('map:')) out.push(o as THREE.Mesh);
  });
  return out;
};
const mat = (m: THREE.Mesh): THREE.MeshStandardMaterial => m.material as THREE.MeshStandardMaterial;

/** Loader that serves a constant grey image and records what was asked for. */
function greyLoader(requests: string[] = []): NonNullable<MapMeshOptions['loadLightmap']> {
  return (file, w, h) => {
    requests.push(file);
    return Promise.resolve(new Uint8Array(w * h).fill(100));
  };
}

afterEach(() => vi.restoreAllMocks());

describe('buildMapMeshes flats', () => {
  it('overlapping same-layer flats get distinct draw order, depth offset and lift', () => {
    const square = (h: number): [number, number][] => [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ];
    const map: MapDefinition = {
      ...tinyMap(),
      boxes: [],
      flats: [
        { pts: square(4), y: 0, mat: 'grass', layer: 2 },
        { pts: square(1), y: 0, mat: 'paving', layer: 2 },
      ],
    };
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {});
    const flats = meshes(group).filter((m) => m.renderOrder <= -10); // flats (the slab is -1)
    const lawn = flats.find((m) => m.name.startsWith('map:grass|'))!;
    const path = flats.find((m) => m.name.startsWith('map:paving|'))!;
    expect(lawn && path).toBeTruthy();
    // The path draws over the lawn: earlier (early-Z: top layer first), bigger pull, higher.
    expect(path.renderOrder).toBeLessThan(lawn.renderOrder);
    expect(mat(path).polygonOffsetFactor).toBeLessThan(mat(lawn).polygonOffsetFactor);
    expect(mat(path).polygonOffsetUnits).toBeLessThan(mat(lawn).polygonOffsetUnits);
    const top = (m: THREE.Mesh) => {
      m.geometry.computeBoundingBox();
      return m.geometry.boundingBox!.max.y;
    };
    expect(top(path) - top(lawn)).toBeCloseTo(FLAT_LIFT.perLayer, 6);
  });
});

describe('buildMapMeshes baked lighting', () => {
  it('uses window-free sandstone for facade boxes with and without baked lighting', () => {
    const map: MapDefinition = {
      ...tinyMap(),
      boxes: [{ center: { x: 0, y: 6, z: 0 }, size: { x: 1.3, y: 12, z: 1.3 }, mat: 'facade' }],
    };
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [bakeFor(map)],
      loadLightmap: greyLoader(),
    });
    const stone = meshes(group).find((mesh) => mesh.name.includes('|stone|'))!;
    expect(mat(stone).name).toContain('facade|shell|stone');
    setBakedLighting(group, true);
    expect(mat(stone).name).toContain('facade|shell|stone|bake');
  });

  it('adds uv1 + an aoMap variant to every baked bucket, none to the backdrop', async () => {
    const map = tinyMap();
    const requests: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [bakeFor(map)],
      loadLightmap: greyLoader(requests),
    });
    // Built plain, nothing fetched until baked lighting is switched on (Low never loads).
    expect(requests).toEqual([]);
    for (const m of meshes(group)) expect(mat(m).aoMap).toBeNull();
    setBakedLighting(group, true);
    expect(warn).not.toHaveBeenCalled();
    expect(requests.sort()).toEqual(['tiny-atlas.png', 'tiny-ground.png']);
    const all = meshes(group);
    const backdrop = all.filter((m) => m.name.includes('|backdrop|'));
    expect(backdrop.length).toBeGreaterThan(0);
    for (const m of backdrop) {
      expect(m.geometry.getAttribute('uv1')).toBeUndefined();
      expect(mat(m).aoMap).toBeNull();
    }
    const baked = all.filter((m) => !m.name.includes('|backdrop|'));
    expect(baked.length).toBeGreaterThanOrEqual(3); // concrete buckets batch together
    for (const m of baked) {
      const uv1 = m.geometry.getAttribute('uv1');
      expect(uv1.count).toBe(m.geometry.getAttribute('position').count);
      for (let i = 0; i < uv1.count; i++) {
        expect(Number.isFinite(uv1.getX(i)) && Number.isFinite(uv1.getY(i))).toBe(true);
      }
      const ao = mat(m).aoMap;
      expect(ao).toBeInstanceOf(THREE.DataTexture);
      expect(ao!.channel).toBe(1);
    }
    // Slab top and markings sample the ground projection; walls and props the atlas.
    const slabTop = baked.find((m) => m.name.startsWith('map:paving|'))!;
    const flat = baked.find((m) => m.name.startsWith('map:asphalt|'))!;
    const box = baked.find((m) => m.name.startsWith('map:concrete|256:'))!;
    expect(mat(slabTop).aoMap!.name).toBe('lightmap:tiny-ground.png');
    expect(mat(flat).aoMap!.name).toBe('lightmap:tiny-ground.png');
    expect(mat(flat).polygonOffset).toBe(true);
    expect(mat(box).aoMap!.name).toBe('lightmap:tiny-atlas.png');
    // Until the PNG arrives the texture is white (unoccluded); then its pixels are replaced in
    // place — same texture, same size: nothing recompiles.
    const tex = mat(box).aoMap as THREE.DataTexture;
    const data = tex.image.data as Uint8Array;
    expect(data[0]).toBe(255);
    const version = tex.version;
    const ready = await bakedLightingReady(group);
    expect(ready.map((t) => t.name).sort()).toEqual([
      'lightmap:tiny-atlas.png',
      'lightmap:tiny-ground.png',
    ]);
    expect(data[0]).toBe(100);
    expect(tex.image.data).toBe(data);
    expect(tex.version).toBeGreaterThan(version);
  });

  it('maps box vertices into their face rect', () => {
    const map = tinyMap();
    const layout = buildLightmapLayout(map);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [bakeFor(map)],
      loadLightmap: greyLoader(),
    });
    const box = meshes(group).find((m) => m.name.startsWith('map:concrete|256:'))!;
    const uv1 = box.geometry.getAttribute('uv1');
    // The box is emitted first: its 6 faces are vertices 0..23 in BOX_FACES order.
    for (let f = 0; f < 6; f++) {
      const r = layout.atlas.rects[layout.boxFaces[f]!]!;
      for (let k = 0; k < 4; k++) {
        const x = uv1.getX(f * 4 + k) * layout.atlas.width;
        const y = uv1.getY(f * 4 + k) * layout.atlas.height;
        expect([r.x, r.x + r.w].some((e) => Math.abs(e - x) < 1e-3)).toBe(true);
        expect([r.y, r.y + r.h].some((e) => Math.abs(e - y) < 1e-3)).toBe(true);
      }
    }
  });

  it('skips a bake whose layout hash mismatches, with a warning (not an error)', () => {
    const map = tinyMap();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    const requests: string[] = [];
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [{ ...bakeFor(map), layoutHash: '00000000000000' }],
      loadLightmap: greyLoader(requests),
    });
    setBakedLighting(group, true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/skipping baked lighting/);
    expect(error).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    for (const m of meshes(group)) {
      expect(m.geometry.getAttribute('uv1')).toBeUndefined();
      expect(mat(m).aoMap).toBeNull();
    }
  });

  it('renders maps without a bake exactly as before, silently', async () => {
    const warn = vi.spyOn(console, 'warn');
    const group = buildMapMeshes(tinyMap(), new FakeMaterials() as unknown as MapMaterials, {
      bakes: [],
    });
    setBakedLighting(group, true);
    expect(await bakedLightingReady(group)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    for (const m of meshes(group)) expect(m.geometry.getAttribute('uv1')).toBeUndefined();
  });

  it('keeps rendering (unbaked, white) when a lightmap fails to load', async () => {
    const map = tinyMap();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [bakeFor(map)],
      loadLightmap: () => Promise.reject(new Error('404')),
    });
    setBakedLighting(group, true);
    await bakedLightingReady(group);
    expect(warn).toHaveBeenCalledTimes(2);
    const box = meshes(group).find((m) => m.name.startsWith('map:concrete|256:'))!;
    const tex = mat(box).aoMap as THREE.DataTexture;
    expect((tex.image.data as Uint8Array).every((v) => v === 255)).toBe(true);
  });

  it('swaps between the baked and the plain materials (Low tier)', () => {
    const map = tinyMap();
    const materials = new FakeMaterials();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    scene.add(
      buildMapMeshes(map, materials as unknown as MapMaterials, {
        bakes: [bakeFor(map)],
        loadLightmap: greyLoader(),
      }),
    );
    const box = meshes(scene).find((m) => m.name.startsWith('map:concrete|256:'))!;
    expect(box.material).toBe(materials.get('concrete'));
    setBakedLighting(scene, true);
    const baked = box.material;
    expect(mat(box).aoMap).not.toBeNull();
    setBakedLighting(scene, false);
    expect(box.material).toBe(materials.get('concrete'));
    expect(mat(box).aoMap).toBeNull();
    setBakedLighting(scene, true);
    expect(box.material).toBe(baked);
  });

  it('never loads or allocates the lightmaps while baked lighting stays off (Low)', async () => {
    const map = tinyMap();
    const requests: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const materials = new FakeMaterials();
    const scene = new THREE.Scene();
    scene.add(
      buildMapMeshes(map, materials as unknown as MapMaterials, {
        bakes: [bakeFor(map)],
        loadLightmap: greyLoader(requests),
      }),
    );
    setBakedLighting(scene, false);
    expect(await bakedLightingReady(scene)).toEqual([]);
    expect(requests).toEqual([]);
    // The baked variant exists (for a later Medium crossing) but holds no pixels yet.
    const tex = materials.variant(
      'concrete',
      `bake-atlas-${buildLightmapLayout(map).hash}`,
      () => {},
    ).aoMap as THREE.DataTexture;
    expect(tex.image.data).toBeNull();
    // First crossing to Medium: loads once, however often the tier flips afterwards.
    setBakedLighting(scene, true);
    setBakedLighting(scene, false);
    setBakedLighting(scene, true);
    expect(requests).toHaveLength(2);
  });

  it('falls back to white after a bounded wait, and ignores late lightmaps', async () => {
    const map = tinyMap();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signals: AbortSignal[] = [];
    const late: ((px: Uint8Array) => void)[] = [];
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [bakeFor(map)],
      loadLightmap: (_file, w, h, signal) => {
        signals.push(signal);
        return new Promise((resolve) => late.push(() => resolve(new Uint8Array(w * h).fill(7))));
      },
    });
    setBakedLighting(group, true);
    const textures = await bakedLightingReady(group, 5);
    expect(textures).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/not loaded after 5 ms/);
    expect(signals.every((s) => s.aborted)).toBe(true);
    for (const resolve of late) resolve(new Uint8Array(0));
    await new Promise((r) => setTimeout(r, 0));
    for (const t of textures) {
      expect(((t as THREE.DataTexture).image.data as Uint8Array).every((v) => v === 255)).toBe(
        true,
      );
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('renders geometry the layout does not enumerate unbaked, with one warning', () => {
    const map = tinyMap();
    const layout = buildLightmapLayout(map);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hooks.dropPrismFaces = true;
    let group: THREE.Group;
    try {
      group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
        bakes: [bakeFor(map)],
        loadLightmap: greyLoader(),
      });
    } finally {
      hooks.dropPrismFaces = false;
    }
    // The slab prism (4 walls + top + bottom = 24 vertices) now has no lightmap slots.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/24 vertices .* outside the lightmap layout/);
    const white = [
      layout.atlas.white.x / layout.atlas.width,
      layout.atlas.white.y / layout.atlas.height,
    ];
    // Skyline concrete is unbaked; select the foreground box/slab batch explicitly.
    const walls = meshes(group).find((m) => m.name.startsWith('map:concrete|256:'))!;
    expect(walls).toBeDefined();
    const uv1 = walls.geometry.getAttribute('uv1');
    expect(uv1).toBeDefined();
    expect(uv1.count).toBe(walls.geometry.getAttribute('position').count);
    let whiteVertices = 0;
    for (let i = 0; i < uv1.count; i++) {
      if (Math.abs(uv1.getX(i) - white[0]!) < 1e-6 && Math.abs(uv1.getY(i) - white[1]!) < 1e-6)
        whiteVertices++;
    }
    expect(whiteVertices).toBe(20); // concrete walls + bottom; slab top is its ground bucket
    // Street-level buckets fall back to the ground projection: the same uv1 a normal build gives
    // the slab top (clamp-to-edge white wherever it lies outside the projection).
    const normal = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [bakeFor(map)],
      loadLightmap: greyLoader(),
    });
    const uvOf = (g: THREE.Group): number[] =>
      Array.from(
        meshes(g)
          .find((m) => m.name.startsWith('map:paving|'))!
          .geometry.getAttribute('uv1').array,
      );
    expect(uvOf(group)).toEqual(uvOf(normal));
  });
});

describe('buildMapMeshes lamp volume', () => {
  /** The tiny map with one ceiling panel (an emitter; drawn by setDressing, not here). */
  const litMap = (): MapDefinition => {
    const map = tinyMap();
    map.boxes.push({
      center: { x: 4, y: 3, z: 0 },
      size: { x: 1.2, y: 0.08, z: 0.6 },
      mat: 'metal',
      dress: 'lightPanel',
    });
    return map;
  };
  const withVolume = (map: MapDefinition): BakedLightmap => ({
    ...bakeFor(map),
    volume: bakedLampVolume('tiny-lampvol.png', lampVolumeLayout(bakeEmitters(map))!),
  });
  /** Serves the volume PNG as planes whose bytes count up (so interleaving is checkable). */
  const loader =
    (requests: string[]): NonNullable<MapMeshOptions['loadLightmap']> =>
    (file, w, h) => {
      requests.push(file);
      const px = new Uint8Array(w * h);
      if (file === 'tiny-lampvol.png') for (let i = 0; i < px.length; i++) px[i] = i % 251;
      else px.fill(100);
      return Promise.resolve(px);
    };

  afterEach(() => configureLampVolume(null));

  it('loads with the other lightmaps and fills the shared 3D texture in place', async () => {
    const map = litMap();
    const layout = lampVolumeLayout(bakeEmitters(map))!;
    const requests: string[] = [];
    const warn = vi.spyOn(console, 'warn');
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [withVolume(map)],
      loadLightmap: loader(requests),
    });
    // Sized at map build (before any compile), empty, nothing fetched yet (Low never loads).
    const tex = LAMP_VOLUME_UNIFORMS.lampVolume.value;
    expect([tex.image.width, tex.image.height, tex.image.depth]).toEqual([
      layout.nx,
      layout.ny,
      layout.nz,
    ]);
    const data = tex.image.data as Uint8Array;
    expect(data.every((v) => v === 0)).toBe(true);
    expect(requests).toEqual([]);
    setBakedLighting(group, true);
    expect(requests.sort()).toEqual(['tiny-atlas.png', 'tiny-ground.png', 'tiny-lampvol.png']);
    const version = tex.version;
    const ready = await bakedLightingReady(group);
    expect(ready).toContain(tex); // uploaded before warm-up with the others
    expect(warn).not.toHaveBeenCalled();
    expect(tex.image.data).toBe(data); // same array: no reallocation, no recompile
    expect(tex.version).toBeGreaterThan(version);
    // Planes (a, vx, vy, vz) → RGBA voxels: voxel v's channel c is plane byte c·n + v.
    const n = layout.nx * layout.ny * layout.nz;
    for (const v of [0, 1, n - 1]) {
      for (let c = 0; c < 4; c++) expect(data[v * 4 + c]).toBe((c * n + v) % 251);
    }
  });

  it('drops a stale volume with one warning, keeping the rest of the bake', async () => {
    const map = litMap();
    const bake = withVolume(map);
    const requests: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = litMap();
    moved.boxes[1]!.center.z += 2; // the lamp moved after the bake (not re-baked)
    const group = buildMapMeshes(moved, new FakeMaterials() as unknown as MapMaterials, {
      // Atlas/ground still match (so only the volume is stale).
      bakes: [{ ...bakeFor(moved), volume: bake.volume! }],
      loadLightmap: loader(requests),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/lamp volume.*re-run `pnpm bake`/);
    const tex = LAMP_VOLUME_UNIFORMS.lampVolume.value;
    expect([tex.image.width, tex.image.height, tex.image.depth]).toEqual([1, 1, 1]);
    setBakedLighting(group, true);
    await bakedLightingReady(group);
    expect(requests.sort()).toEqual(['tiny-atlas.png', 'tiny-ground.png']);
  });

  it('keeps an old bake without a volume working, with an empty volume', async () => {
    const map = litMap();
    const requests: string[] = [];
    const warn = vi.spyOn(console, 'warn');
    configureLampVolume(lampVolumeLayout(bakeEmitters(map))); // left over from another map
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials, {
      bakes: [bakeFor(map)],
      loadLightmap: loader(requests),
    });
    const tex = LAMP_VOLUME_UNIFORMS.lampVolume.value;
    expect([tex.image.width, tex.image.height, tex.image.depth]).toEqual([1, 1, 1]);
    setBakedLighting(group, true);
    await bakedLightingReady(group);
    expect(requests.sort()).toEqual(['tiny-atlas.png', 'tiny-ground.png']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('GeoBuilder', () => {
  const c = new THREE.Color(1, 1, 1);
  const p = { x: 1, y: 2, z: 3 };
  const n = { x: 0, y: 1, z: 0 };

  it('gives a baked vertex without a lightmap uv the fallback uv1 instead of throwing', () => {
    const g = new GeoBuilder(() => [0.5, 0.25]);
    g.vertex(p, n, 0, 0, c, () => [0.1, 0.2]);
    expect(() => g.vertex(p, n, 0, 0, c)).not.toThrow();
    expect(g.unbaked).toBe(1);
    expect(g.uv1).toEqual([0.1, 0.2, 0.5, 0.25]);
  });

  it('writes no uv1 at all for an unbaked bucket', () => {
    const g = new GeoBuilder();
    g.vertex(p, n, 0, 0, c, () => [0.1, 0.2]);
    expect(g.uv1).toBeNull();
    expect(g.unbaked).toBe(0);
    expect(g.build().getAttribute('uv1')).toBeUndefined();
  });

  it('writes face-local coords only for wear buckets (zeros for non-box vertices)', () => {
    const plain = new GeoBuilder();
    plain.vertex(p, n, 0, 0, c, null, [1, 2, 3, 4]);
    expect(plain.build().getAttribute('aFace')).toBeUndefined();
    const worn = new GeoBuilder(null, true);
    worn.vertex(p, n, 0, 0, c, null, [1, 2, 3, 4]);
    worn.vertex(p, n, 0, 0, c);
    expect([...(worn.build().getAttribute('aFace').array as Float32Array)]).toEqual([
      1, 2, 3, 4, 0, 0, 0, 0,
    ]);
  });
});

describe('box faces for edge wear (containers, the wreck)', () => {
  it('gives container faces their size and each corner its face-local position', () => {
    const map: MapDefinition = {
      name: 'wear',
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      boxes: [
        { center: { x: 1, y: 1.3, z: 0 }, size: { x: 6, y: 2.6, z: 2.4 }, mat: 'container' },
        { center: { x: 5, y: 1, z: 5 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' },
      ],
      spawns: [],
      dummies: [],
    };
    const group = buildMapMeshes(map, new FakeMaterials() as unknown as MapMaterials);
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name.startsWith('map:')) meshes.push(o as THREE.Mesh);
    });
    const container = meshes.find((m) => m.name.startsWith('map:container'))!;
    const concrete = meshes.find((m) => m.name.startsWith('map:concrete'))!;
    expect(concrete.geometry.getAttribute('aFace')).toBeUndefined();
    const face = container.geometry.getAttribute('aFace');
    const pos = container.geometry.getAttribute('position');
    expect(face.count).toBe(24);
    // Face 4 (+z side): 6 m wide, 2.6 m tall; t is the height above the box's bottom.
    for (let i = 16; i < 20; i++) {
      expect(face.getZ(i)).toBeCloseTo(6);
      expect(face.getW(i)).toBeCloseTo(2.6);
      expect(face.getY(i)).toBeCloseTo(pos.getY(i));
      expect(face.getX(i)).toBeCloseTo(pos.getX(i) + 2); // x from the face's left edge (−2)
    }
  });
});
