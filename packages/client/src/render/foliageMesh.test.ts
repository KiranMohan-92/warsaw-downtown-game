import * as THREE from 'three';
import {
  GRASS_BLADES,
  SWAY,
  TRUNK_PROFILE,
  bushArchetype,
  canopyArchetype,
  coniferArchetype,
  grassArchetype,
  trunkArchetype,
  type FoliageGeo,
} from './foliageGeometry.ts';
import { describe, expect, it } from 'vitest';
import {
  FoliageIndex,
  PLAYER,
  getMap,
  resolveMap,
  treeTrunkHeight,
  treeTrunkRadiusOf,
  type MapDefinition,
  type MapFoliage,
  type MapTree,
} from '@wd/shared';
import { FOLIAGE_ALPHA_TEST, tileUv, type AtlasTile } from './foliageAtlas.ts';
import {
  FOLIAGE_CHUNK,
  TREE_FOLIAGE_CHUNK,
  FOLIAGE_TREE_SHADOW_DISTANCE,
  FOLIAGE_CARD_FADE,
  FOLIAGE_TREE_NEAR_DISTANCE,
  FOLIAGE_LOD_HYSTERESIS,
  advanceFoliageWind,
  buildFoliageLayer,
  buildTrees,
  clumpInstance,
  crownBase,
  crownHeight,
  crownInstance,
  foliageArchetypes,
  grassBladeGeometry,
  foliageMaterials,
  foliageDetail,
  foliageWind,
  instanceMatrix,
  setFoliageQuality,
  setFoliageWind,
  trunkInstance,
  updateFoliage,
  windStrengthFor,
  type FoliageInstance,
} from './foliageMesh.ts';

const map = resolveMap(getMap('defilad'), 'full');
const trees = map.trees ?? [];
const clumps = map.foliage ?? [];

/** World-space extents of an archetype placed by `inst`, relative to the item's axis. */
function worldExtents(
  g: FoliageGeo,
  inst: FoliageInstance,
  ax: number,
  az: number,
): { radius: number; minY: number; maxY: number } {
  const m = instanceMatrix(inst);
  const v = new THREE.Vector3();
  let radius = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < g.pos.length; i += 3) {
    v.set(g.pos[i]!, g.pos[i + 1]!, g.pos[i + 2]).applyMatrix4(m);
    radius = Math.max(radius, Math.hypot(v.x - ax, v.z - az));
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  return { radius, minY, maxY };
}

/** Typed guard (`instanceof` on the generic class widens to `any` type arguments). */
const isInstanced = (o: THREE.Object3D): o is THREE.InstancedMesh =>
  (o as Partial<THREE.InstancedMesh>).isInstancedMesh === true;
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => o instanceof THREE.Mesh;

interface FoliageCounts {
  bush?: number;
  grass?: number;
}

function bakedFoliageCounts(mesh: THREE.Mesh): FoliageCounts {
  const counts: unknown = mesh.userData.foliageCounts;
  return typeof counts === 'object' && counts !== null ? counts : {};
}

function solidCoreSignature(geometry: THREE.BufferGeometry): string {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const color = geometry.getAttribute('color');
  const foliage = geometry.getAttribute('aFoliage');
  const root = geometry.getAttribute('aFoliageRoot');
  const sourceIndex = (i: number): number => (index ? index.getX(i) : i);
  const out: number[] = [];
  const triCount = (index?.count ?? position.count) / 3;
  for (let tri = 0; tri < triCount; tri++) {
    const triIndices = [sourceIndex(tri * 3), sourceIndex(tri * 3 + 1), sourceIndex(tri * 3 + 2)];
    if (triIndices.some((v) => foliage.getZ(v) !== 1)) {
      continue;
    }
    for (const v of triIndices) {
      out.push(
        position.getX(v),
        position.getY(v),
        position.getZ(v),
        normal.getX(v),
        normal.getY(v),
        normal.getZ(v),
        uv.getX(v),
        uv.getY(v),
        color.getX(v),
        color.getY(v),
        color.getZ(v),
        foliage.getX(v),
        foliage.getY(v),
        foliage.getZ(v),
        root.getX(v),
        root.getY(v),
        root.getZ(v),
        root.getW(v),
      );
    }
  }
  return out.map((v) => Number(v).toFixed(6)).join(',');
}

const sameArrays = (a: FoliageGeo, b: FoliageGeo): boolean =>
  (['pos', 'nrm', 'uv', 'col', 'fol', 'idx'] as const).every(
    (k) => a[k].length === b[k].length && a[k].every((x, i) => x === b[k][i]),
  );

describe('foliage archetypes', () => {
  const makers = {
    bush: bushArchetype,
    grass: grassArchetype,
    canopy: canopyArchetype,
    conifer: coniferArchetype,
  };

  it('are deterministic for a seed and vary with it', () => {
    for (const [name, make] of Object.entries(makers)) {
      expect(sameArrays(make(), make()), name).toBe(true);
      expect(sameArrays(make(), make(999)), name).toBe(false);
    }
    expect(sameArrays(trunkArchetype(), trunkArchetype())).toBe(true);
  });

  it('keep exact gameplay cores and bounded decorative bush lobes', () => {
    for (const [name, make] of Object.entries(makers)) {
      const e = make().extents();
      if (name === 'bush') {
        expect(e.radius, name).toBeGreaterThan(1);
        // Core ≤ 1.22 plus leaf sprigs poking out of it.
        expect(e.radius, name).toBeLessThanOrEqual(1.35);
        expect(e.maxY, name).toBeGreaterThan(1);
        expect(e.maxY, name).toBeLessThanOrEqual(1.35);
      } else if (name === 'grass') {
        // Core ≤ 1.04 plus opaque blades breaking the outline (bounded envelope).
        expect(e.radius, name).toBeGreaterThan(1.04);
        expect(e.radius, name).toBeLessThanOrEqual(GRASS_BLADES.maxReach + 1e-9);
        expect(e.maxY, name).toBeGreaterThan(1.15);
        expect(e.maxY, name).toBeLessThanOrEqual(GRASS_BLADES.maxTip + 1e-9);
      } else {
        expect(e.radius, name).toBeCloseTo(1, 9);
        expect(e.maxY, name).toBeLessThanOrEqual(1 + 1e-6);
      }
      expect(e.minY, name).toBeGreaterThanOrEqual(-1e-6);
    }
    // Grass and conifers stand on their base and reach the top; bush has a larger decorative
    // envelope but still stands on its base and keeps its exact gameplay core (ray tests below).
    expect(coniferArchetype().extents().maxY).toBeCloseTo(1, 9);
    for (const make of [grassArchetype, coniferArchetype]) {
      expect(make().extents().minY).toBeCloseTo(0, 9);
    }
    expect(bushArchetype().extents().minY).toBeCloseTo(0, 9);
    expect(canopyArchetype().extents().maxY).toBeCloseTo(1, 9);
  });

  it('sway only a few centimetres', () => {
    expect(bushArchetype().maxSway()).toBeLessThanOrEqual(SWAY.bush);
    expect(grassArchetype().maxSway()).toBeLessThanOrEqual(SWAY.grass);
    expect(canopyArchetype().maxSway()).toBeLessThanOrEqual(SWAY.canopy);
    expect(coniferArchetype().maxSway()).toBeLessThanOrEqual(SWAY.conifer);
    expect(trunkArchetype().maxSway()).toBe(0);
    for (const a of Object.values(SWAY)) expect(a).toBeLessThanOrEqual(0.08);
  });

  it('keeps the concealment hull stationary in every weather', () => {
    for (const make of [bushArchetype, grassArchetype]) {
      const g = make();
      for (let i = 0; i < g.fol.length; i += 3) {
        if (g.fol[i + 2] === 1) expect(g.fol[i]).toBe(0);
      }
    }
  });

  it('stay cheap (per-instance triangle budget)', () => {
    // Core ≈ 480 + hidden cards + 60 sprigs × 3 six-point leaves (4 triangles; drawn up close
    // only, every tier). Grass Round 2: baseline 5139 triangles, allowed +30% for denser skirt,
    // rim and crown blades that hide the close-up drum without adding draws or programs.
    expect(bushArchetype().triangleCount).toBeLessThanOrEqual(1250);
    expect(grassArchetype().triangleCount).toBeLessThanOrEqual(Math.floor(5139 * 1.3));
    expect(canopyArchetype().triangleCount).toBeLessThanOrEqual(500);
    expect(coniferArchetype().triangleCount).toBeLessThanOrEqual(260);
    expect(trunkArchetype().triangleCount).toBeLessThanOrEqual(60);
  });
});

describe('concealment: visuals match the shared gameplay volumes', () => {
  it('grass and bush visuals stay near their FoliageIndex cylinders', () => {
    const geo = { bush: bushArchetype(), grass: grassArchetype() };
    expect(clumps.length).toBeGreaterThan(1000);
    for (const f of clumps) {
      const e = worldExtents(geo[f.kind], clumpInstance(f), f.x, f.z);
      const base = f.y ?? 0;
      if (f.kind === 'bush') {
        expect(e.radius).toBeGreaterThan(f.r);
        expect(e.radius).toBeLessThanOrEqual(f.r * 1.35 + 1e-6);
        expect(e.maxY).toBeGreaterThan(base + f.h);
        expect(e.maxY).toBeLessThanOrEqual(base + f.h * 1.35 + 1e-6);
      } else {
        expect(e.radius).toBeGreaterThan(f.r);
        expect(e.radius).toBeLessThanOrEqual(f.r * GRASS_BLADES.maxReach + 1e-6);
        expect(e.maxY).toBeGreaterThan(base + f.h);
        expect(e.maxY).toBeLessThanOrEqual(base + f.h * GRASS_BLADES.maxTip + 1e-6);
      }
      expect(Math.abs(e.minY - base)).toBeLessThan(1e-6);
    }
  });

  /** Ray vs the archetype mesh: the solid flag interpolated at the nearest hit (null = miss). */
  function solidHit(g: FoliageGeo, from: THREE.Vector3, to: THREE.Vector3): number | null {
    const mesh = new THREE.Mesh(
      g.toGeometry(),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    const dir = to.clone().sub(from);
    const ray = new THREE.Raycaster(from, dir.clone().normalize(), 0, dir.length());
    const hits = ray.intersectObject(mesh);
    // Opaque triangles only (cards are alpha-tested: a leaf may or may not be there).
    const solid = mesh.geometry.getAttribute('aFoliage');
    let result: number | null = null;
    for (const h of hits) {
      const f = h.face!;
      const s =
        solid.getZ(f.a) * h.barycoord!.x +
        solid.getZ(f.b) * h.barycoord!.y +
        solid.getZ(f.c) * h.barycoord!.z;
      if (s >= 0.5) {
        result = s;
        break;
      }
    }
    mesh.geometry.dispose();
    mesh.material.dispose();
    return result;
  }

  it('bush opaque core keeps old dense-card coverage through the crown', () => {
    const geo = bushArchetype();
    for (const angle of [0, Math.PI / 6, Math.PI / 3, Math.PI / 2]) {
      const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      for (const off of [-0.955, -0.8, 0, 0.8, 0.955]) {
        for (const y of [0.1, 0.5, 0.9, 0.98]) {
          const lateral = side.clone().multiplyScalar(off);
          const from = dir.clone().multiplyScalar(-3).add(lateral).setY(y);
          const to = dir.clone().multiplyScalar(3).add(lateral).setY(y);
          expect(solidHit(geo, from, to), `angle ${angle} off ${off} y ${y}`).not.toBeNull();
        }
      }
    }
  });

  it('where FoliageIndex hides a target, an opaque core blocks the line on screen too', () => {
    const cases: { item: MapFoliage; geo: FoliageGeo; maxH: number }[] = [
      { item: { x: 0, z: 0, r: 1.1, h: 1.3, kind: 'bush' }, geo: bushArchetype(), maxH: 0.99 },
      { item: { x: 0, z: 0, r: 2.2, h: 2.1, kind: 'bush' }, geo: bushArchetype(), maxH: 0.99 },
      { item: { x: 0, z: 0, r: 1.6, h: 1.0, kind: 'grass' }, geo: grassArchetype(), maxH: 0.99 },
      { item: { x: 0, z: 0, r: 2.8, h: 1.3, kind: 'grass' }, geo: grassArchetype(), maxH: 0.99 },
    ];
    for (const { item, geo, maxH } of cases) {
      const idx = new FoliageIndex([item]);
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        for (const off of [-0.955, -0.93, -0.9, -0.7, -0.4, 0, 0.4, 0.7, 0.9, 0.93, 0.955]) {
          for (const hk of [0.01, 0.1, maxH / 2, maxH]) {
            const y = hk * item.h;
            const lateral = side.clone().multiplyScalar(off * item.r);
            const from = dir.clone().multiplyScalar(-10).add(lateral).setY(y);
            const to = dir.clone().multiplyScalar(10).add(lateral).setY(y);
            if (idx.visibility(from, to) > 0) continue;
            // Archetype space: undo the instance scale (r, h, r).
            const s = new THREE.Vector3(1 / item.r, 1 / item.h, 1 / item.r);
            expect(
              solidHit(geo, from.clone().multiply(s), to.clone().multiply(s)),
              `${item.kind} r${item.r} off ${off} h ${hk}`,
            ).not.toBeNull();
          }
        }
      }
    }
  });

  it('trunks match their colliders within a few centimetres', () => {
    const rMax = Math.max(...trees.map((t) => treeTrunkRadiusOf(t)));
    const poly = 2 / (1 + Math.cos(Math.PI / 8));
    // Collider span: the vertex radius and the face (apothem) radius both stay within 5 cm.
    for (const [y, k] of TRUNK_PROFILE) {
      if (y < 0.06 || y > 1) continue;
      expect(Math.abs(k * poly - 1) * rMax).toBeLessThan(0.05);
      expect(Math.abs(k * poly * Math.cos(Math.PI / 8) - 1) * rMax).toBeLessThan(0.05);
    }
    // The root flare stays within a few cm; bark stops at the collider top.
    expect((TRUNK_PROFILE[0]![1] * poly - 1) * rMax).toBeLessThan(0.05);
    expect(TRUNK_PROFILE[TRUNK_PROFILE.length - 1]![0]).toBe(1);
    const g = trunkArchetype();
    for (const t of trees.slice(0, 200)) {
      const inst = trunkInstance(t);
      expect(inst.sx).toBe(treeTrunkRadiusOf(t));
      expect(inst.sy).toBe(treeTrunkHeight(t));
      const e = worldExtents(g, inst, t.x, t.z);
      expect(e.minY).toBeCloseTo(t.y ?? 0, 9);
    }
  });

  it('crowns stay in the old crown volume, well above player height', () => {
    const geo = { broadleaf: canopyArchetype(), conifer: coniferArchetype() };
    for (const t of trees) {
      const base = t.y ?? 0;
      const e = worldExtents(geo[t.kind], crownInstance(t), t.x, t.z);
      expect(e.radius).toBeLessThanOrEqual(t.crown + 1e-6);
      expect(e.maxY).toBeLessThanOrEqual(base + t.height + 1e-6);
      expect(e.minY).toBeGreaterThanOrEqual(base + crownBase(t) - 1e-6);
      // Crowns are not in FoliageIndex: they must never hang where they could hide a player
      // standing next to the tree (head at PLAYER.standHeight).
      expect(e.minY - base, `${t.kind} ${t.height}`).toBeGreaterThan(PLAYER.standHeight + 0.3);
    }
    const t: MapTree = { x: 0, z: 0, height: 10, crown: 3, kind: 'broadleaf' };
    expect(crownBase(t) + crownHeight(t)).toBe(10);
  });
});

describe('foliage meshes', () => {
  const groups = buildFoliageLayer(map);
  const meshes: THREE.Mesh[] = [];
  for (const g of groups) g.traverse((o) => isMesh(o) && meshes.push(o));
  const count = (prefix: string): number => {
    if (prefix === 'foliage:bushes')
      return meshes
        .filter((m) => m.name === 'foliage:clumps')
        .reduce((n, m) => n + (bakedFoliageCounts(m).bush ?? 0), 0);
    if (prefix === 'foliage:grass')
      return meshes
        .filter((m) => m.name === 'foliage:clumps')
        .reduce((n, m) => n + (bakedFoliageCounts(m).grass ?? 0), 0);
    return meshes
      .filter((m): m is THREE.InstancedMesh => isInstanced(m) && m.name === prefix)
      .reduce((n, m) => n + m.count, 0);
  };

  it('instances every tree, bush and grass clump exactly once', () => {
    expect(count('trees:trunks')).toBe(trees.length);
    expect(count('trees:crowns')).toBe(trees.filter((t) => t.kind === 'broadleaf').length);
    expect(count('trees:conifers')).toBe(trees.filter((t) => t.kind === 'conifer').length);
    expect(count('foliage:bushes')).toBe(clumps.filter((f) => f.kind === 'bush').length);
    expect(count('foliage:grass')).toBe(clumps.filter((f) => f.kind === 'grass').length);
  });

  it('uses supported positive instance scales', () => {
    for (const inst of [...trees.map(crownInstance), ...clumps.map(clumpInstance)]) {
      expect(instanceMatrix(inst).determinant()).toBeGreaterThan(0);
    }
  });

  it('uses Market-sized chunks so instanced batches can leave the frustum', () => {
    expect(FOLIAGE_CHUNK).toBeLessThanOrEqual(96);
    expect(FOLIAGE_CHUNK).toBeGreaterThanOrEqual(48);
    expect(groups.length).toBeGreaterThan(20);
  });

  it('shares one material and warmed geometry paths across resident LOD meshes', () => {
    for (const g of groups) expect(g.children.length).toBeLessThanOrEqual(5);
    const mats = foliageMaterials();
    const arch = new Set([...Object.values(foliageArchetypes()), grassBladeGeometry()]);
    for (const m of meshes) {
      expect(m.material).toBe(mats.lit);
      expect(m.customDepthMaterial).toBe(mats.depth);
      if (isInstanced(m)) {
        if (!m.name.endsWith(':far')) expect(arch.has(m.geometry)).toBe(true);
        else expect(m.geometry.getAttribute('aFoliage')).toBeDefined();
        expect(m.instanceColor).not.toBeNull();
      } else {
        expect(['foliage:clumps', 'foliage:clumps:far', 'foliage:fringe']).toContain(m.name);
        expect(m.geometry.getAttribute('aFoliage')).toBeDefined();
        expect(m.geometry.getAttribute('aFoliageRoot')).toBeDefined();
        expect(m.geometry.getAttribute('color')).toBeDefined();
      }
    }
    expect(
      meshes.filter((m) => m.name.startsWith('foliage:clumps')).every((m) => !m.castShadow),
    ).toBe(true);
    expect(
      meshes
        .filter((m) => m.name.startsWith('trees:') && !m.name.endsWith(':far'))
        .every((m) => m.castShadow),
    ).toBe(true);
  });

  it('submits at most three tree draws and three clump draws (cores + sprigs + grass blades) per chunk', () => {
    const chunkCount = (items: readonly { x: number; z: number }[], size: number): number =>
      new Set(items.map((i) => `${Math.floor(i.x / size)},${Math.floor(i.z / size)}`)).size;
    const treeChunks = chunkCount(trees, TREE_FOLIAGE_CHUNK);
    const clumpChunks = chunkCount(clumps, FOLIAGE_CHUNK);
    // Resident pairs cost memory, but only one member submits a draw. Keep separate budgets
    // for tree and clump cells: they may use different chunk sizes or occupy different cells.
    expect(meshes.length).toBeLessThanOrEqual(treeChunks * 5 + clumpChunks * 4);
    const root = new THREE.Group();
    root.add(...buildFoliageLayer(map));
    root.updateWorldMatrix(true, true);
    const initial = root.children.reduce(
      (n, chunk) => n + chunk.children.filter((m) => m.visible).length,
      0,
    );
    const checkDraws = (): void => {
      let draws = 0;
      let fringes = 0;
      for (const chunk of root.children) {
        const visible = chunk.children.filter((m) => m.visible);
        expect(visible.length).toBeLessThanOrEqual(3);
        // Grass blades: up close on every tier, with whichever core mesh is drawn.
        const blades = chunk.getObjectByName('foliage:grassBlades');
        if (blades?.visible) fringes++;
        // Low's sprig mesh only ever accompanies its far cores (High's near mesh has sprigs).
        const fringe = chunk.getObjectByName('foliage:fringe');
        if (fringe?.visible) {
          fringes++;
          expect(chunk.getObjectByName('foliage:clumps:far')!.visible).toBe(true);
        }
        const paired = chunk.children.filter(
          (m) =>
            !m.name.endsWith(':far') &&
            m.name !== 'foliage:fringe' &&
            m.name !== 'foliage:grassBlades',
        );
        for (const near of paired) {
          const far = chunk.getObjectByName(`${near.name}:far`);
          expect(Number(near.visible) + Number(far?.visible ?? false)).toBe(1);
        }
        draws += visible.length;
      }
      // An upper bound before frustum culling, per colour pass (shadows are budgeted separately).
      // Constant apart from the up-close sprig (Low) and grass-blade (every tier) draws.
      expect(draws - fringes).toBe(initial);
      expect(draws).toBeLessThanOrEqual(treeChunks * 3 + clumpChunks * 3);
    };
    checkDraws();
    try {
      for (const low of [false, true]) {
        setFoliageQuality(low);
        for (const x of [0, 44, 52, 72, 118, 5000, 118, 72, 52, 44, 0]) {
          updateFoliage(root, new THREE.Vector3(x, 1.7, 0));
          checkDraws();
        }
      }
    } finally {
      setFoliageQuality(false);
    }
  });

  it('runtime update trims shadow cost without distance-culling foliage', () => {
    const sample: MapDefinition = {
      name: 'foliage-runtime',
      bounds: { minX: -8, maxX: 160, minZ: -8, maxZ: 8 },
      boxes: [],
      spawns: [],
      dummies: [],
      trees: [
        {
          x: FOLIAGE_TREE_SHADOW_DISTANCE + 80,
          z: 0,
          height: 9,
          crown: 2.5,
          kind: 'broadleaf',
        },
      ],
      foliage: [
        {
          x: FOLIAGE_TREE_SHADOW_DISTANCE + 80,
          z: 2,
          r: 1.4,
          h: 1.6,
          kind: 'bush',
        },
        {
          x: FOLIAGE_TREE_SHADOW_DISTANCE + 85,
          z: -2,
          r: 1.4,
          h: 1.1,
          kind: 'grass',
        },
      ],
    };
    const root = new THREE.Group();
    root.add(...buildFoliageLayer(sample));
    root.updateWorldMatrix(true, true);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.7, 0);
    camera.updateWorldMatrix(true, false);

    updateFoliage(root, camera);

    const runtimeMeshes: THREE.Mesh[] = [];
    root.traverse((o) => isMesh(o) && runtimeMeshes.push(o));
    const broadNear = root.getObjectByName('trees:crowns') as THREE.Mesh;
    const broadFar = root.getObjectByName('trees:crowns:far') as THREE.Mesh;
    const clumpNear = root.getObjectByName('foliage:clumps') as THREE.Mesh;
    const clumpFar = root.getObjectByName('foliage:clumps:far') as THREE.Mesh;
    expect(
      runtimeMeshes
        .filter((m) => m.name.endsWith(':far') || m.name === 'trees:trunks')
        .every((m) => m.visible),
    ).toBe(true);
    expect(
      runtimeMeshes
        .filter((m) => !m.name.endsWith(':far') && m.name !== 'trees:trunks')
        .every((m) => !m.visible),
    ).toBe(true);
    expect(runtimeMeshes.every((m) => !m.castShadow)).toBe(true); // all beyond shadow range
    expect(broadNear.visible).toBe(false);
    expect(broadFar.visible).toBe(true);
    expect(clumpNear.visible).toBe(false);
    expect(clumpFar.visible).toBe(true);

    camera.position.set(FOLIAGE_TREE_SHADOW_DISTANCE + 80, 1.7, 0);
    camera.updateWorldMatrix(true, false);
    updateFoliage(root, camera);
    expect(
      runtimeMeshes
        .filter((m) => m.name.startsWith('trees:') && !m.name.endsWith(':far'))
        .every((m) => m.visible && m.castShadow),
    ).toBe(true);
    expect(
      runtimeMeshes
        .filter((m) => m.name === 'foliage:clumps')
        .every((m) => m.visible && !m.castShadow),
    ).toBe(true);
    expect(runtimeMeshes.filter((m) => m.name.endsWith(':far')).every((m) => !m.visible)).toBe(
      true,
    );
    expect(broadNear.visible).toBe(true);
    expect(broadFar.visible).toBe(false);
    expect(clumpNear.visible).toBe(true);
    expect(clumpFar.visible).toBe(false);
    expect(root.getObjectByName('trees:trunks')!.visible).toBe(true);
  });

  it('Low submits only opaque solid crown and clump LODs', () => {
    const sample: MapDefinition = {
      name: 'foliage-low-solid-lod',
      bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 },
      boxes: [],
      spawns: [],
      dummies: [],
      trees: [{ x: 0, z: 0, height: 9, crown: 2.5, kind: 'broadleaf' }],
      foliage: [{ x: 0, z: 3, r: 1.5, h: 1.5, kind: 'bush' }],
    };
    const root = new THREE.Group();
    root.add(...buildFoliageLayer(sample));
    root.updateWorldMatrix(true, true);
    const trunk = root.getObjectByName('trees:trunks') as THREE.Mesh;
    const crownNear = root.getObjectByName('trees:crowns') as THREE.Mesh;
    const crownFar = root.getObjectByName('trees:crowns:far') as THREE.Mesh;
    const clumpNear = root.getObjectByName('foliage:clumps') as THREE.Mesh;
    const clumpFar = root.getObjectByName('foliage:clumps:far') as THREE.Mesh;
    const onlySolid = (mesh: THREE.Mesh): boolean => {
      const fol = mesh.geometry.getAttribute('aFoliage');
      for (let i = 0; i < fol.count; i++) if (fol.getZ(i) !== 1) return false;
      return true;
    };

    try {
      setFoliageQuality('low');
      updateFoliage(root, new THREE.Vector3(0, 1.7, 0));
      expect(trunk.visible).toBe(true);
      expect(crownNear.visible).toBe(false);
      expect(crownFar.visible).toBe(true);
      expect(clumpNear.visible).toBe(false);
      expect(clumpFar.visible).toBe(true);
      expect(crownFar.castShadow).toBe(true); // same shade under the tree as on High
      expect(clumpFar.castShadow).toBe(false);
      expect(onlySolid(crownFar)).toBe(true);
      expect(onlySolid(clumpFar)).toBe(true);
    } finally {
      setFoliageQuality(false);
    }
  });

  it('runtime update keeps trunks visible and makes paired LODs exclusive across distance', () => {
    const sample: MapDefinition = {
      name: 'foliage-lod-sweep',
      bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 },
      boxes: [],
      spawns: [],
      dummies: [],
      trees: [{ x: 0, z: 0, height: 9, crown: 2.5, kind: 'broadleaf' }],
      foliage: [{ x: 0, z: 3, r: 1.5, h: 1.5, kind: 'bush' }],
    };
    const root = new THREE.Group();
    root.add(...buildFoliageLayer(sample));
    root.updateWorldMatrix(true, true);
    const trunk = root.getObjectByName('trees:trunks') as THREE.Mesh;
    const crownNear = root.getObjectByName('trees:crowns') as THREE.Mesh;
    const crownFar = root.getObjectByName('trees:crowns:far') as THREE.Mesh;
    const clumpNear = root.getObjectByName('foliage:clumps') as THREE.Mesh;
    const clumpFar = root.getObjectByName('foliage:clumps:far') as THREE.Mesh;

    for (const x of [-120, -72, -52, -44, -12, 0, 12, 44, 52, 72, 120]) {
      updateFoliage(root, new THREE.Vector3(x, 1.7, 0));
      expect(trunk.visible).toBe(true);
      expect(Number(crownNear.visible) + Number(crownFar.visible)).toBe(1);
      expect(Number(clumpNear.visible) + Number(clumpFar.visible)).toBe(1);
    }
  });

  it('far clump LOD keeps the same opaque concealment roots without decorative cards', () => {
    const sample: MapDefinition = {
      name: 'foliage-far-core',
      bounds: { minX: -4, maxX: 8, minZ: -4, maxZ: 8 },
      boxes: [],
      spawns: [],
      dummies: [],
      foliage: [
        { x: 3, z: 4, y: 0.2, r: 1.7, h: 1.6, kind: 'bush' },
        { x: -2, z: 1, r: 1.4, h: 1.1, kind: 'grass' },
      ],
    };
    const root = new THREE.Group();
    root.add(...buildFoliageLayer(sample));
    // Negative and positive X occupy different chunks; getObjectByName only finds the first.
    expect(root.children.length).toBe(2);
    const seen = new Set<string>();
    const opaqueTriangles = (geo: THREE.BufferGeometry): number[] => {
      const indices = geo.getIndex()!;
      const fol = geo.getAttribute('aFoliage');
      const values: number[] = [];
      for (let i = 0; i < indices.count; i += 3) {
        const triangle = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
        if (triangle.some((v) => fol.getZ(v) !== 1)) continue;
        for (const v of triangle) {
          for (const name of ['position', 'normal', 'uv', 'color', 'aFoliage', 'aFoliageRoot']) {
            const attr = geo.getAttribute(name);
            for (let c = 0; c < attr.itemSize; c++) values.push(attr.getComponent(v, c));
          }
        }
      }
      return values;
    };
    for (const chunk of root.children) {
      const near = chunk.getObjectByName('foliage:clumps') as THREE.Mesh;
      const far = chunk.getObjectByName('foliage:clumps:far') as THREE.Mesh;
      // A grass-only chunk's near mesh is its core too (the blades are instanced separately).
      expect(far.geometry.getIndex()!.count).toBeLessThanOrEqual(near.geometry.getIndex()!.count);
      const fol = far.geometry.getAttribute('aFoliage');
      expect(fol.count).toBeLessThanOrEqual(near.geometry.getAttribute('aFoliage').count);
      expect(new Set(far.geometry.getIndex()!.array).size).toBe(fol.count);
      for (let i = 0; i < fol.count; i++) expect(fol.getZ(i)).toBe(1);
      const triangles = opaqueTriangles(near.geometry);
      expect(triangles.length).toBeGreaterThan(0);
      expect(opaqueTriangles(far.geometry)).toEqual(triangles);
      const roots = far.geometry.getAttribute('aFoliageRoot');
      for (let i = 0; i < roots.count; i++) {
        seen.add(
          `${roots.getX(i).toFixed(1)},${roots.getY(i).toFixed(1)},${roots.getZ(i).toFixed(1)},${roots
            .getW(i)
            .toFixed(1)}`,
        );
      }
    }
    expect(seen).toEqual(new Set(['3.0,0.2,4.0,1.7', '-2.0,0.0,1.0,1.4']));
  });

  it('opaque clumps block gameplay sight lines in both LODs and quality shader paths', () => {
    const sample: MapDefinition = {
      name: 'foliage-visible-core',
      bounds: { minX: -4, maxX: 8, minZ: -4, maxZ: 8 },
      boxes: [],
      spawns: [],
      dummies: [],
    };
    const ray = new THREE.Raycaster();
    try {
      for (const kind of ['bush', 'grass'] as const) {
        const item: MapFoliage = { x: 3, z: -2, y: 0.2, r: 1.7, h: 1.6, kind };
        const index = new FoliageIndex([item]);
        const root = new THREE.Group();
        root.add(...buildFoliageLayer({ ...sample, foliage: [item] }));
        root.updateWorldMatrix(true, true);
        for (const low of [false, true]) {
          setFoliageQuality(low);
          for (const distance of [10, 500, 10]) {
            let hiddenRays = 0;
            for (let a = 0; a < 12; a++) {
              const angle = (a / 12) * Math.PI * 2;
              const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
              const side = new THREE.Vector3(-dir.z, 0, dir.x);
              for (const offset of [-0.955, -0.7, 0, 0.7, 0.955]) {
                for (const height of [0.01, 0.5, 0.99]) {
                  const center = new THREE.Vector3(item.x, item.y! + height * item.h, item.z);
                  center.addScaledVector(side, offset * item.r);
                  const from = center.clone().addScaledVector(dir, -distance);
                  const to = center.clone().addScaledVector(dir, 10);
                  if (index.visibility(from, to) > 0) continue;
                  hiddenRays++;
                  updateFoliage(root, from);
                  const visible: THREE.Mesh[] = [];
                  root.traverseVisible((o) => isMesh(o) && visible.push(o));
                  // Low up close also draws the sprig mesh; exactly one core mesh either way.
                  const cores = visible.filter(
                    (m) => m.name !== 'foliage:fringe' && m.name !== 'foliage:grassBlades',
                  );
                  expect(cores.length).toBe(1);
                  expect(cores[0]!.name).toBe(
                    low || distance === 500 ? 'foliage:clumps:far' : 'foliage:clumps',
                  );
                  ray.set(from, dir);
                  ray.far = distance + 10;
                  const opaque = ray.intersectObjects(visible).some((hit) => {
                    const solid = (hit.object as THREE.Mesh).geometry.getAttribute('aFoliage');
                    return [hit.face!.a, hit.face!.b, hit.face!.c].every(
                      (v) => solid.getZ(v) === 1 && solid.getX(v) === 0,
                    );
                  });
                  expect(opaque, `${kind} low=${low} distance=${distance} a=${a}`).toBe(true);
                }
              }
            }
            expect(hiddenRays).toBeGreaterThan(0);
          }
        }
      }
    } finally {
      setFoliageQuality(false);
    }
  });

  it('fades decorative tree cards before either crown LOD transition', () => {
    expect(FOLIAGE_CARD_FADE[1]).toBeLessThanOrEqual(
      FOLIAGE_TREE_NEAR_DISTANCE - FOLIAGE_LOD_HYSTERESIS,
    );
  });

  it('Low disables alpha discard and uses the opaque shader key prepared by warmup', () => {
    const groups = buildFoliageLayer(map);
    const { lit, depth } = foliageMaterials();
    for (const q of [true, 'low', 'medium', 'high', 'ultra'] as const) {
      setFoliageQuality(q);
      const low = q === true || q === 'low';
      expect(foliageDetail.value).toBe(low ? 0 : 1);
      expect(lit.alphaTest).toBe(low ? 0 : FOLIAGE_ALPHA_TEST);
      expect(depth.alphaTest).toBe(lit.alphaTest);
      expect(lit.customProgramCacheKey()).toContain(low ? 'opaque' : 'alpha');
      expect(depth.customProgramCacheKey()).toContain(low ? 'opaque' : 'alpha');
      for (const g of groups)
        g.traverse((o) => {
          if (!isMesh(o)) return;
          expect(o.material).toBe(lit);
          expect(o.customDepthMaterial).toBe(depth);
        });
    }
    setFoliageQuality(false);
  });

  it('far crown LODs reuse the exact smooth opaque near crown core', () => {
    const root = buildTrees([
      { x: 0, z: 0, height: 9, crown: 2.5, kind: 'broadleaf' },
      { x: 5, z: 0, height: 9, crown: 2.5, kind: 'conifer' },
    ]);
    const arches = foliageArchetypes();
    expect(
      solidCoreSignature((root.getObjectByName('trees:crowns:far') as THREE.Mesh).geometry),
    ).toBe(solidCoreSignature(arches.canopy));
    expect(
      solidCoreSignature((root.getObjectByName('trees:conifers:far') as THREE.Mesh).geometry),
    ).toBe(solidCoreSignature(arches.conifer));
  });

  it('far crown LODs keep atlas UVs on crown core tiles, not the whole atlas', () => {
    const root = buildTrees([
      { x: 0, z: 0, height: 9, crown: 2.5, kind: 'broadleaf' },
      { x: 5, z: 0, height: 9, crown: 2.5, kind: 'conifer' },
    ]);
    const cases: [string, AtlasTile[]][] = [
      ['trees:crowns:far', ['canopy', 'bark']],
      ['trees:conifers:far', ['needleMass', 'bark']],
    ];
    for (const [name, tiles] of cases) {
      const mesh = root.getObjectByName(name) as THREE.Mesh;
      const uv = mesh.geometry.getAttribute('uv');
      const rects = tiles.map((tile) => tileUv(tile, 0.16));
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        expect(
          rects.some(
            (r) => u >= r.u0 - 1e-6 && u <= r.u1 + 1e-6 && v >= r.v0 - 1e-6 && v <= r.v1 + 1e-6,
          ),
          name,
        ).toBe(true);
      }
    }
  });

  it('patches every shader anchor it relies on (three upgrades must not drop them silently)', () => {
    const { lit: material, depth } = foliageMaterials();
    const lit = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: {},
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(lit, null as unknown as THREE.WebGLRenderer);
    expect(lit.vertexShader).toContain('foliageSway( foliageRoot');
    expect(lit.vertexShader).toContain('attribute vec4 aFoliageRoot');
    expect(lit.vertexShader).toContain('#ifdef USE_INSTANCING');
    expect(lit.vertexShader).toContain('foliageLocalRoot = vec3( 0.0 )');
    expect(lit.vertexShader).toContain('foliageLocalRoot.xz + foliageFromRoot');
    expect(lit.vertexShader).toContain('uFoliageEye');
    expect(lit.vertexShader).not.toContain('FOLIAGE_LOW');
    expect(lit.vertexShader).toContain('#include <project_vertex>');
    expect(lit.fragmentShader).toContain('max( diffuseColor.a, min( vFoliage.y, 1.0 ) )');
    expect(lit.fragmentShader).toContain('#ifdef USE_ALPHATEST');
    expect(lit.fragmentShader).toContain('cardNoise');
    expect(lit.fragmentShader).toContain('52.9829189');
    expect(lit.fragmentShader).toContain('if ( vFoliage.z <= 0.0 ) discard');
    expect(lit.fragmentShader).toContain('if ( cardNoise > vFoliage.z ) discard');
    expect(lit.fragmentShader).toContain('normal = normalize( vNormal )');
    expect(lit.fragmentShader).toContain('directionalLights[ 0 ].direction');
    expect(lit.fragmentShader).toContain('roughnessFactor = mix(');
    expect(lit.fragmentShader).toContain('iblIrradiance += getIBLIrradiance');
    expect(lit.fragmentShader).toContain('if ( uFoliageDetail > 0.0 && vFoliage.x > 0.0 )');
    expect(lit.vertexShader).toContain(
      `smoothstep( ${FOLIAGE_CARD_FADE[0].toFixed(1)}, ${FOLIAGE_CARD_FADE[1].toFixed(1)}`,
    );
    expect(lit.fragmentShader).toContain('radiance += getIBLRadiance');
    const d = {
      vertexShader: THREE.ShaderLib.depth.vertexShader,
      fragmentShader: THREE.ShaderLib.depth.fragmentShader,
      uniforms: {},
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    depth.onBeforeCompile(d, null as unknown as THREE.WebGLRenderer);
    expect(d.vertexShader).toContain('foliageSway(');
    expect(d.fragmentShader).toContain('max( diffuseColor.a, min( vFoliage.y, 1.0 ) )');
    expect(d.fragmentShader).toContain('if ( cardNoise > vFoliage.z ) discard');
    expect(d.uniforms.uFoliageEye).toBe(lit.uniforms.uFoliageEye);
    expect(depth.map).toBe(material.map);
    expect(depth.alphaTest).toBe(material.alphaTest);
    expect(depth.side).toBe(material.side);
  });
});

describe('foliage wind', () => {
  it('follows the weather: breeze when clear, gusts in rain', () => {
    const sunny = windStrengthFor({ cloudCover: 0.3, rain: 0 });
    const overcast = windStrengthFor({ cloudCover: 0.93, rain: 0 });
    const rain = windStrengthFor({ cloudCover: 1, rain: 1 });
    expect(sunny).toBeGreaterThan(0.2);
    expect(overcast).toBeGreaterThan(sunny);
    expect(rain).toBe(1);
  });

  it('eases towards a new strength and advances its clock (uniforms only)', () => {
    const t0 = foliageWind.time.value;
    setFoliageWind(1);
    const s0 = foliageWind.strength.value;
    advanceFoliageWind(0.5);
    expect(foliageWind.time.value).toBeCloseTo(t0 + 0.5);
    expect(foliageWind.strength.value).toBeGreaterThan(s0);
    for (let i = 0; i < 200; i++) advanceFoliageWind(0.1);
    expect(foliageWind.strength.value).toBeCloseTo(1, 3);
  });
});
