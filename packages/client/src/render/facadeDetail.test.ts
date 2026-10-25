import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  PALACE_TINT,
  placDefilad,
  getMap,
  resolveMap,
  type MapDefinition,
  type MapPrism,
  type MaterialId,
} from '@wd/shared';
import {
  FACADE_LOD,
  FACADE_LOD_HYSTERESIS,
  buildFacadeDetail,
  findFacadeDetail,
  type FacadeDetail,
} from './facadeDetail.ts';
import { buildMapMeshes, setBakedLighting } from './mapMesh.ts';
import type { MapMaterials } from './materials.ts';
import { RELIEF_MIN, facadeFaces } from './facadeRelief.ts';
import * as reliefSource from './facadeRelief.ts';

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
const fake = (): MapMaterials => new FakeMaterials() as unknown as MapMaterials;

/** A 33 × 33 m block, 6 storeys (CCW in (x, z)). */
const BLOCK: MapPrism = {
  pts: [
    [0, 0],
    [33, 0],
    [33, 33],
    [0, 33],
  ],
  y0: 0,
  y1: 19.8,
  mat: 'facade',
  tint: 0xb0a898,
  top: 'concrete',
};

function mapOf(...prisms: MapPrism[]): MapDefinition {
  return {
    name: 'facade-detail-test',
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    boxes: [],
    prisms,
    spawns: [],
    dummies: [],
  };
}

/** Drawn indices per material mesh. */
function visible(d: FacadeDetail): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [kind, mesh] of Object.entries(d.meshes)) {
    out[kind] = mesh.geometry.drawRange.count;
  }
  return out;
}

const TALL_PALACE_BLOCK: MapPrism = {
  pts: [
    [0, 0],
    [99, 0],
    [99, 33],
    [0, 33],
  ],
  y0: 0,
  y1: 66,
  mat: 'facade',
  tint: PALACE_TINT,
  top: 'concrete',
};

function roundedKey(...values: number[]): string {
  return values.map((v) => Math.round(v * 100_000)).join(',');
}

function addLineValue(lines: Map<string, Set<number>>, key: string, value: number): void {
  const values = lines.get(key);
  if (values) values.add(value);
  else lines.set(key, new Set([value]));
}

function hasInteriorPoint(values: Set<number> | undefined, a: number, b: number): boolean {
  if (!values) return false;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (const v of values) {
    if (v > lo + 1e-5 && v < hi - 1e-5) return true;
  }
  return false;
}

function sourcePlaneKey(
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  nrm: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  i: number,
): string | null {
  const x = pos.getX(i);
  const z = pos.getZ(i);
  const nx = nrm.getX(i);
  const ny = nrm.getY(i);
  const nz = nrm.getZ(i);
  if (Math.abs(ny) > 1e-3) return null;
  // Only source facade planes of TALL_PALACE_BLOCK. Pilaster/reveal side faces have the same
  // normal axes, but they are not same-plane wall fronts and may meet stepped crown depths.
  if (Math.abs(nx) > 0.9 && (x <= 0.31 || x >= 98.69)) {
    return `x:${Math.sign(nx)}:${Math.round(x * 100_000)}`;
  }
  if (Math.abs(nz) > 0.9 && (z <= 0.31 || z >= 32.69)) {
    return `z:${Math.sign(nz)}:${Math.round(z * 100_000)}`;
  }
  return null;
}

function activeIndexCount(mesh: THREE.Mesh): number {
  const count = mesh.geometry.drawRange.count;
  return count === Infinity ? mesh.geometry.getIndex()!.count : count;
}

function expectNoAxisAlignedEdgeTJunctions(mesh: THREE.Mesh): void {
  const pos = mesh.geometry.getAttribute('position');
  const nrm = mesh.geometry.getAttribute('normal');
  const index = mesh.geometry.getIndex()!;
  const start = mesh.geometry.drawRange.start;
  const count = activeIndexCount(mesh);
  const xByYZ = new Map<string, Set<number>>();
  const zByXY = new Map<string, Set<number>>();
  const yByXZ = new Map<string, Set<number>>();
  const frontTriangles: [readonly [number, number, number], string][] = [];
  for (let i = start; i < start + count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)] as const;
    const plane = sourcePlaneKey(pos, nrm, tri[0]);
    if (!plane || tri.some((j) => sourcePlaneKey(pos, nrm, j) !== plane)) continue;
    frontTriangles.push([tri, plane]);
    for (const j of tri) {
      const x = pos.getX(j);
      const y = pos.getY(j);
      const z = pos.getZ(j);
      addLineValue(xByYZ, `${plane}:${roundedKey(y, z)}`, x);
      addLineValue(zByXY, `${plane}:${roundedKey(x, y)}`, z);
      addLineValue(yByXZ, `${plane}:${roundedKey(x, z)}`, y);
    }
  }
  for (const [tri, plane] of frontTriangles) {
    for (const [a, b] of [
      [tri[0], tri[1]],
      [tri[1], tri[2]],
      [tri[2], tri[0]],
    ] as const) {
      const ax = pos.getX(a);
      const ay = pos.getY(a);
      const az = pos.getZ(a);
      const bx = pos.getX(b);
      const by = pos.getY(b);
      const bz = pos.getZ(b);
      if (Math.abs(ay - by) <= 1e-5 && Math.abs(az - bz) <= 1e-5) {
        expect(hasInteriorPoint(xByYZ.get(`${plane}:${roundedKey(ay, az)}`), ax, bx)).toBe(false);
      }
      if (Math.abs(ax - bx) <= 1e-5 && Math.abs(ay - by) <= 1e-5) {
        expect(hasInteriorPoint(zByXY.get(`${plane}:${roundedKey(ax, ay)}`), az, bz)).toBe(false);
      }
      if (Math.abs(ax - bx) <= 1e-5 && Math.abs(az - bz) <= 1e-5) {
        expect(hasInteriorPoint(yByXZ.get(`${plane}:${roundedKey(ax, az)}`), ay, by)).toBe(false);
      }
    }
  }
}

describe('buildFacadeDetail', () => {
  it('keeps subdivided triangles outward-facing on rotated and reversed world walls', () => {
    for (const angle of [0, 0.37, -0.61]) {
      const rotated: MapPrism = {
        ...TALL_PALACE_BLOCK,
        pts: TALL_PALACE_BLOCK.pts.map(([x, z]) => [
          x * Math.cos(angle) - z * Math.sin(angle),
          x * Math.sin(angle) + z * Math.cos(angle),
        ]),
      };
      const d = buildFacadeDetail(mapOf(rotated), fake())!;
      d.setQuality('ultra');
      let checked = 0;
      let invalid = 0;
      for (const z of [0, -1000]) {
        d.update({ x: 0, y: 33, z });
        for (const mesh of Object.values(d.meshes)) {
          const g = mesh.geometry;
          const p = g.getAttribute('position');
          const n = g.getAttribute('normal');
          const index = g.getIndex()!;
          for (let i = 0; i < g.drawRange.count; i += 3) {
            const a = index.getX(i),
              b = index.getX(i + 1),
              c = index.getX(i + 2);
            const ux = p.getX(b) - p.getX(a),
              uy = p.getY(b) - p.getY(a),
              uz = p.getZ(b) - p.getZ(a);
            const vx = p.getX(c) - p.getX(a),
              vy = p.getY(c) - p.getY(a),
              vz = p.getZ(c) - p.getZ(a);
            const facing =
              (uy * vz - uz * vy) * n.getX(a) +
              (uz * vx - ux * vz) * n.getY(a) +
              (ux * vy - uy * vx) * n.getZ(a);
            checked++;
            if (facing <= 0) invalid++;
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
      expect(invalid).toBe(0);
    }
  });

  it('tags Palace stone at every LOD without applying it to surrounding blocks', () => {
    for (const prism of [BLOCK, { ...BLOCK, tint: PALACE_TINT }]) {
      const detail = buildFacadeDetail(mapOf(prism), fake())!;
      for (const mesh of Object.values(detail.meshes)) {
        if (!mesh) continue;
        const stone = mesh.geometry.getAttribute('aPalaceStone');
        expect(stone.count).toBe(mesh.geometry.getAttribute('position').count);
        for (let i = 0; i < stone.count; i++)
          expect(stone.getX(i)).toBe(prism.tint === PALACE_TINT ? 1 : 0);
      }
    }
  });

  it('limits analytic window bands to panel fronts at every LOD, with one byte per vertex', () => {
    const detail = buildFacadeDetail(mapOf({ ...BLOCK, tint: PALACE_TINT }), fake())!;
    for (const [kind, mesh] of Object.entries(detail.meshes)) {
      const g = mesh.geometry;
      const panel = g.getAttribute('aFacadePanel');
      const normal = g.getAttribute('normal');
      expect(panel.count).toBe(g.getAttribute('position').count);
      expect(panel.array).toBeInstanceOf(Uint8Array);
      expect(panel.itemSize).toBe(1);
      expect(panel.normalized).toBe(true);
      let marked = 0;
      for (let i = 0; i < panel.count; i++) {
        expect([0, 1]).toContain(panel.getX(i));
        if (panel.getX(i) === 1) {
          marked++;
          expect(normal.getY(i)).toBe(0);
        }
      }
      if (kind === 'paint') expect(marked).toBe(panel.count);
      if (kind === 'glass') expect(marked).toBe(0);
      if (kind === 'shell') {
        expect(marked).toBeGreaterThan(0);
        expect(marked).toBeLessThan(panel.count);
        // Flush pier/rib faces never acquire a phantom window grid.
        const pos = g.getAttribute('position');
        for (let i = 0; i < panel.count; i++) {
          const onPlane =
            (normal.getX(i) === -1 && pos.getX(i) === 0) ||
            (normal.getX(i) === 1 && pos.getX(i) === 33) ||
            (normal.getZ(i) === -1 && pos.getZ(i) === 0) ||
            (normal.getZ(i) === 1 && pos.getZ(i) === 33);
          if (onPlane) expect(panel.getX(i)).toBe(0);
        }
      }
    }
  });

  it('omits cells behind the view while retaining their closed shadow proxy', () => {
    const detail = buildFacadeDetail(mapOf(BLOCK), fake())!;
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    camera.position.set(16, 10, 60);
    camera.lookAt(16, 10, 0);
    detail.update(camera.position, camera);
    expect(Object.values(visible(detail)).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    const shadowIndices = detail.shadowMesh.geometry.getIndex()!.count;
    camera.lookAt(16, 10, 120);
    detail.update(camera.position, camera);
    expect(Object.values(visible(detail)).every((count) => count === 0)).toBe(true);
    expect(detail.shadowMesh.castShadow).toBe(true);
    expect(detail.shadowMesh.geometry.getIndex()!.count).toBe(shadowIndices);
    camera.lookAt(16, 10, 0);
    detail.update(camera.position, camera);
    expect(Object.values(visible(detail)).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
  });

  it('builds nothing for a map without relief walls', () => {
    expect(buildFacadeDetail(mapOf({ ...BLOCK, mat: 'concrete' }), fake())).toBeNull();
    expect(buildFacadeDetail(mapOf({ ...BLOCK, backdrop: true }), fake())).toBeNull();
  });

  it('draws with three visible merged meshes plus one flat shadow proxy', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    expect(d.children).toHaveLength(4);
    expect(Object.keys(d.meshes).sort()).toEqual(['glass', 'paint', 'shell']);
    for (const m of Object.values(d.meshes)) {
      expect(m).toBeInstanceOf(THREE.Mesh);
      expect(m).not.toBeInstanceOf(THREE.BatchedMesh);
      expect(m.geometry.groups).toHaveLength(0);
      expect(m.castShadow).toBe(false);
    }
    expect((d.meshes.shell!.material as THREE.Material).name).toBe('facade|shell|facadeDetail');
    expect((d.meshes.glass!.material as THREE.Material).name).toBe('glass|facadeDetail');
    expect((d.meshes.paint!.material as THREE.Material).name).toBe('facade|facadeDetail');
    expect(d.shadowMesh.name).toBe('facade:shadow-proxy');
    expect(d.shadowMesh.castShadow).toBe(true);
    expect(d.shadowMesh.receiveShadow).toBe(false);
    expect(d.shadowMesh.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
  });

  it('keeps every vertex on or behind the wall plane, within the relief band', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    for (const mesh of Object.values(d.meshes)) {
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const y = pos.getY(i);
        // Inside (or on) the footprint: nothing stands out of the collision.
        expect(x).toBeGreaterThanOrEqual(-1e-4);
        expect(x).toBeLessThanOrEqual(33 + 1e-4);
        expect(z).toBeGreaterThanOrEqual(-1e-4);
        expect(z).toBeLessThanOrEqual(33 + 1e-4);
        expect(y).toBeGreaterThanOrEqual(-1e-4);
        expect(y).toBeLessThanOrEqual(19.8 + 1e-4);
        // …and no deeper than the relief band behind the nearest wall.
        const depth = Math.min(x, z, 33 - x, 33 - z);
        expect(depth).toBeLessThanOrEqual(-RELIEF_MIN + 1e-4);
      }
    }
  });

  it('switches cells between the three levels of detail by distance, with hysteresis', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    d.setQuality('high');
    const { near, mid } = FACADE_LOD.high;
    // Built far (LOD 2): only the flat parts draw.
    expect(d.lodCounts()[2]).toBe(d.cells.length);
    expect(visible(d).glass).toBe(0);
    // Next to the south wall: every cell within `near` gets windows.
    d.update({ x: 16.5, y: 1.7, z: -5 });
    expect(d.lodCounts()[0]).toBe(d.cells.length);
    expect(visible(d).glass).toBeGreaterThan(0);
    // Mid distance: frame + painted panels, no panes.
    d.update({ x: 16.5, y: 1.7, z: -(near + FACADE_LOD_HYSTERESIS + 1) });
    expect(d.lodCounts()[1]).toBe(d.cells.length);
    expect(visible(d).glass).toBe(0);
    // Just inside the threshold again: it stays at LOD 1 until well past it.
    d.update({ x: 16.5, y: 1.7, z: -(near - 1) });
    expect(d.lodCounts()[0]).toBe(d.cells.length);
    d.update({ x: 16.5, y: 1.7, z: -(near + FACADE_LOD_HYSTERESIS / 2) });
    expect(d.lodCounts()[0]).toBe(d.cells.length);
    d.update({ x: 16.5, y: 1.7, z: -(mid + FACADE_LOD_HYSTERESIS + 1) });
    expect(d.lodCounts()[2]).toBe(d.cells.length);
  });

  it('gives Low a shorter reach for the full detail', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    const at = { x: 16.5, y: 1.7, z: -(FACADE_LOD.low.near + 10) };
    d.setQuality('medium');
    d.update(at);
    expect(d.lodCounts()[0]).toBe(d.cells.length);
    d.setQuality('low');
    d.update(at);
    expect(d.lodCounts()[0]).toBe(0);
    expect(FACADE_LOD.low.near).toBeLessThan(FACADE_LOD.medium.near);
    expect(FACADE_LOD.low.mid).toBeLessThan(FACADE_LOD.medium.mid);
  });

  it('retains the same structural shell and recessed painted panels at middle and far distances', () => {
    const d = buildFacadeDetail(mapOf(TALL_PALACE_BLOCK), fake())!;
    d.setQuality('high');
    d.update({ x: 49, y: 33, z: -150 });
    expect(d.lodCounts()[1]).toBe(d.cells.length);
    const middle = visible(d);
    d.update({ x: 49, y: 33, z: -500 });
    expect(d.lodCounts()[2]).toBe(d.cells.length);
    expect(visible(d)).toEqual(middle);
    expect(middle.glass).toBe(0);
    expect(middle.shell).toBeGreaterThan(0);
    expect(middle.paint).toBeGreaterThan(0);
  });

  it('keeps actual window panes across a street on Low, with three facade draws', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    d.setQuality('low');
    d.update({ x: 16.5, y: 1.7, z: -43 });
    expect(d.lodCounts()[0]).toBe(d.cells.length);
    expect(visible(d).glass).toBeGreaterThan(0);
    expect(Object.keys(d.meshes)).toHaveLength(3);
  });

  it('keeps glass reflections when Low removes the world environment without recompiling swaps', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    const mat = d.meshes.glass!.material as THREE.MeshStandardMaterial;
    const sky = new THREE.Texture();
    d.setEnvironment(sky, 0.8);
    expect(mat.envMap).toBe(sky);
    expect(mat.envMapIntensity).toBe(0.8);
    const version = mat.version;
    d.setQuality('low');
    d.setEnvironment(new THREE.Texture(), 0.6);
    expect(mat.version).toBe(version);
    expect(mat.envMapIntensity).toBe(0.6);
    const shell = d.meshes.shell!.material as THREE.MeshStandardMaterial;
    expect(shell.envMap).toBeNull();
  });

  it('stores cavity visibility in geometry, darkest under recessed hoods', () => {
    const d = buildFacadeDetail(mapOf(TALL_PALACE_BLOCK), fake())!;
    const g = d.meshes.shell!.geometry;
    const visibility = g.getAttribute('aFacadeOcclusion');
    const normals = g.getAttribute('normal');
    expect(visibility.count).toBe(g.getAttribute('position').count);
    let lowestUnderHood = 1;
    let highestExterior = 0;
    for (let i = 0; i < visibility.count; i++) {
      const v = visibility.getX(i);
      expect(v).toBeGreaterThanOrEqual(0.35);
      expect(v).toBeLessThanOrEqual(1);
      if (normals.getY(i) < -0.9) lowestUnderHood = Math.min(lowestUnderHood, v);
      if (Math.abs(normals.getY(i)) < 0.1) highestExterior = Math.max(highestExterior, v);
    }
    expect(lowestUnderHood).toBeLessThan(0.75);
    expect(highestExterior).toBe(1);
  });

  it('strengthens Palace recesses while retaining the surrounding blocks cavity values', () => {
    for (const [tint, field, expectedField, expectedJamb, expectedUnder] of [
      [PALACE_TINT, 0.22, 208, 115, 92],
      [BLOCK.tint!, 0.06, 246, 162, 123],
    ] as const) {
      const d = buildFacadeDetail(mapOf({ ...BLOCK, y1: 13.2, tint }), fake())!;
      const g = d.meshes.shell!.geometry;
      const visibility = g.getAttribute('aFacadeOcclusion');
      const normals = g.getAttribute('normal');
      const positions = g.getAttribute('position');
      let fieldVertices = 0;
      let darkestJamb = 1;
      let darkestUnder = 1;
      for (let i = 0; i < visibility.count; i++) {
        const v = visibility.getX(i);
        if (normals.getZ(i) < -0.9 && Math.abs(positions.getZ(i) - field) < 1e-6) {
          expect(v).toBeCloseTo(expectedField / 255, 6);
          fieldVertices++;
        }
        if (Math.abs(normals.getY(i)) < 0.1) darkestJamb = Math.min(darkestJamb, v);
        if (normals.getY(i) < -0.9) darkestUnder = Math.min(darkestUnder, v);
      }
      expect(fieldVertices).toBeGreaterThan(0);
      expect(darkestJamb).toBeCloseTo(expectedJamb / 255, 6);
      expect(darkestUnder).toBeCloseTo(expectedUnder / 255, 6);
    }
  });

  it('gives crown undersides cavity shading while leaving exposed tops and vertical faces clean', () => {
    const d = buildFacadeDetail(mapOf(TALL_PALACE_BLOCK), fake())!;
    const g = d.meshes.shell!.geometry;
    const visibility = g.getAttribute('aFacadeOcclusion');
    const positions = g.getAttribute('position');
    const normals = g.getAttribute('normal');
    let undersides = 0;
    let tops = 0;
    for (let i = 0; i < visibility.count; i++) {
      if (positions.getY(i) <= TALL_PALACE_BLOCK.y1 + 1e-5) continue;
      const v = visibility.getX(i);
      const up = normals.getY(i);
      expect(v).toBeGreaterThanOrEqual(0.72);
      expect(v).toBeLessThanOrEqual(1);
      if (up < -0.99) {
        expect(v).toBeCloseTo(184 / 255, 6);
        undersides++;
      } else if (up >= 0) {
        expect(v).toBe(1);
        if (up > 0.99) tops++;
      }
    }
    expect(undersides).toBeGreaterThan(0);
    expect(tops).toBeGreaterThan(0);
  });

  it('splits front quad edges at adjacent vertices instead of overlapping seam coplanes', () => {
    const d = buildFacadeDetail(mapOf(TALL_PALACE_BLOCK), fake())!;
    for (const [quality, camera] of [
      ['low', { x: 49, y: 1.7, z: -5 }],
      ['medium', { x: 49, y: 1.7, z: -70 }],
      ['high', { x: 49, y: 1.7, z: -500 }],
    ] as const) {
      d.setQuality(quality);
      d.update(camera);
      expectNoAxisAlignedEdgeTJunctions(d.meshes.shell!);
      expectNoAxisAlignedEdgeTJunctions(d.meshes.paint!);
    }
  });

  it('uses a stable flat proxy for facade shadows at every visual LOD', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    const proxy = d.shadowMesh.geometry.getIndex()!;
    const proxyCount = proxy.count;
    const proxyPositions = d.shadowMesh.geometry.getAttribute('position');
    expect(proxyCount).toBe(24);
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      d.setQuality(q);
      for (const z of [-4, -35, -120, -500]) {
        d.update({ x: 16.5, y: 1.7, z });
        expect(d.shadowMesh.geometry.getIndex()).toBe(proxy);
        expect(d.shadowMesh.geometry.getAttribute('position')).toBe(proxyPositions);
        expect(d.shadowMesh.geometry.drawRange.count).toBe(Infinity);
        expect(proxy.count).toBe(proxyCount);
        for (const m of Object.values(d.meshes)) expect(m.castShadow).toBe(false);
      }
    }
  });

  it('is deterministic', () => {
    const a = buildFacadeDetail(mapOf(BLOCK), fake())!;
    const b = buildFacadeDetail(mapOf(BLOCK), fake())!;
    for (const k of ['shell', 'glass', 'paint'] as const) {
      const pa = a.meshes[k]!.geometry.getAttribute('position').array;
      const pb = b.meshes[k]!.geometry.getAttribute('position').array;
      expect(Array.from(pb)).toEqual(Array.from(pa));
    }
  });

  it('only changes index ranges at LOD transitions and reuses warmed materials and buffers', () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    const snapshot = Object.values(d.meshes).map((m) => ({
      mesh: m,
      material: m.material,
      geometry: m.geometry,
      positions: m.geometry.getAttribute('position'),
      index: m.geometry.getIndex()!,
    }));
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      d.setQuality(q);
      for (const z of [-5, -55, -220, -1200]) {
        d.update({ x: 16.5, y: 1.7, z });
        for (const s of snapshot) {
          expect(s.mesh.material).toBe(s.material);
          expect(s.mesh.geometry).toBe(s.geometry);
          expect(s.geometry.getAttribute('position')).toBe(s.positions);
          expect(s.geometry.getIndex()).toBe(s.index);
          expect(s.geometry.drawRange.count % 3).toBe(0);
          expect(s.geometry.drawRange.count).toBeLessThanOrEqual(s.index.count);
          for (let i = 0; i < s.geometry.drawRange.count; i++) {
            expect(s.index.getX(i)).toBeLessThan(s.positions.count);
          }
        }
        const versions = snapshot.map((s) => s.index.version);
        d.update({ x: 16.5, y: 1.7, z });
        expect(snapshot.map((s) => s.index.version)).toEqual(versions);
      }
    }
  });
});

describe('facade detail in the map meshes', () => {
  it('replaces the flat walls of relief prisms and keeps their roofs', () => {
    const map = mapOf(BLOCK);
    const group = buildMapMeshes(map, fake());
    const d = findFacadeDetail(group);
    expect(d).not.toBeNull();
    let wallVerts = 0;
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && o.name.startsWith('map:facade|')) {
        const n = m.geometry.getAttribute('normal');
        for (let i = 0; i < n.count; i++) if (Math.abs(n.getY(i)) < 0.5) wallVerts++;
      }
    });
    expect(wallVerts).toBe(0);
    expect(group.children.some((o) => o.name.startsWith('map:concrete|'))).toBe(true);
  });

  it('swaps the facade detail to its baked variant with the rest of the map', async () => {
    const { buildLightmapLayout, lightmapSceneHash } = await import('@wd/shared');
    const map = mapOf(BLOCK);
    const layout = buildLightmapLayout(map);
    const group = buildMapMeshes(map, fake(), {
      bakes: [
        {
          map: 'facade-detail-test',
          size: 'full',
          mapName: map.name,
          layoutHash: layout.hash,
          sceneHash: lightmapSceneHash(map, layout, 16),
          atlas: { file: 'a.png', width: layout.atlas.width, height: layout.atlas.height },
          ground: { file: 'g.png', width: layout.ground.width, height: layout.ground.height },
          bake: { samples: 8, reach: 16 },
        },
      ],
      loadLightmap: (_f, w, h) => Promise.resolve(new Uint8Array(w * h).fill(200)),
    });
    const d = findFacadeDetail(group)!;
    const shell = d.meshes.shell!;
    expect((shell.material as THREE.MeshStandardMaterial).userData.palaceEntranceStone).toBe(true);
    expect(
      (d.meshes.glass!.material as THREE.MeshStandardMaterial).userData.palaceEntranceStone,
    ).toBeUndefined();
    expect(
      (d.meshes.paint!.material as THREE.MeshStandardMaterial).userData.palaceEntranceStone,
    ).toBe(true);
    expect(shell.geometry.getAttribute('uv1')).toBeDefined();
    const plain = shell.material;
    setBakedLighting(group, true);
    expect(shell.material).not.toBe(plain);
    expect((shell.material as THREE.MeshStandardMaterial).aoMap).not.toBeNull();
    expect((shell.material as THREE.MeshStandardMaterial).aoMap!.channel).toBe(1);
    expect((shell.material as THREE.MeshStandardMaterial).userData.palaceEntranceStone).toBe(true);
    setBakedLighting(group, false);
    expect(shell.material).toBe(plain);
    const scene = new THREE.Scene();
    scene.add(group);
    const camera = new THREE.PerspectiveCamera();
    const warmed: { root: string; mode: THREE.ToneMapping; baked: boolean }[] = [];
    const renderer = {
      toneMapping: THREE.AgXToneMapping as THREE.ToneMapping,
      outputColorSpace: THREE.SRGBColorSpace,
      target: null as THREE.WebGLRenderTarget | null,
      getRenderTarget() {
        return this.target;
      },
      getActiveCubeFace() {
        return 0;
      },
      getActiveMipmapLevel() {
        return 0;
      },
      setRenderTarget(target: THREE.WebGLRenderTarget | null) {
        this.target = target;
      },
      compileAsync: (root: THREE.Object3D, cam: THREE.Camera, target: THREE.Scene) => {
        expect(cam).toBe(camera);
        expect(target).toBe(scene);
        if (root.name === 'facade:shadow-warmup') {
          const proxy = root.children[0];
          expect(proxy).toBeInstanceOf(THREE.Mesh);
          expect((proxy as THREE.Mesh).material).toBe(d.shadowMesh.customDepthMaterial);
          expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
          expect(renderer.outputColorSpace).toBe(THREE.LinearSRGBColorSpace);
          warmed.push({ root: 'shadow', mode: renderer.toneMapping, baked: false });
          return Promise.resolve();
        }
        expect(root).toBe(d);
        expect(renderer.outputColorSpace).toBe(
          renderer.toneMapping === THREE.NoToneMapping
            ? THREE.LinearSRGBColorSpace
            : THREE.SRGBColorSpace,
        );
        warmed.push({
          root: 'facade',
          mode: renderer.toneMapping,
          baked: shell.material !== plain,
        });
        return Promise.resolve();
      },
    };
    await d.warmUp(renderer as unknown as THREE.WebGLRenderer, camera, scene);
    expect(warmed).toEqual([
      { root: 'shadow', mode: THREE.NoToneMapping, baked: false },
      { root: 'facade', mode: THREE.NoToneMapping, baked: false },
      { root: 'facade', mode: THREE.NoToneMapping, baked: true },
      { root: 'facade', mode: THREE.AgXToneMapping, baked: false },
      { root: 'facade', mode: THREE.AgXToneMapping, baked: true },
    ]);
    expect(shell.material).toBe(plain);
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);
    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(renderer.target).toBeNull();
  });

  it('restores render state when warm-up fails', async () => {
    const d = buildFacadeDetail(mapOf(BLOCK), fake())!;
    const originalTarget = new THREE.WebGLRenderTarget(2, 2);
    const renderer = {
      toneMapping: THREE.AgXToneMapping,
      outputColorSpace: THREE.SRGBColorSpace,
      target: originalTarget as THREE.WebGLRenderTarget | null,
      getRenderTarget() {
        return this.target;
      },
      getActiveCubeFace() {
        return 0;
      },
      getActiveMipmapLevel() {
        return 0;
      },
      setRenderTarget(target: THREE.WebGLRenderTarget | null) {
        this.target = target;
      },
      compileAsync: () => Promise.reject(new Error('test')),
    };
    let failed = false;
    try {
      await d.warmUp(
        renderer as unknown as THREE.WebGLRenderer,
        new THREE.PerspectiveCamera(),
        new THREE.Scene(),
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);
    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(renderer.target).toBe(originalTarget);
    originalTarget.dispose();
  });
});

describe('facade detail on Plac Defilad', () => {
  it('bounds the real Market surround buffers and draws from the same camera poses', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const original = reliefSource.faceRelief;
    const spy = vi
      .spyOn(reliefSource, 'faceRelief')
      .mockImplementation((face) => original(face, false));
    let before: FacadeDetail;
    try {
      before = buildFacadeDetail(map, fake())!;
    } finally {
      spy.mockRestore();
    }
    const after = buildFacadeDetail(map, fake())!;
    const buffers = (detail: FacadeDetail) =>
      Object.values(detail.meshes).reduce(
        (total, mesh) =>
          total +
          Object.values(mesh.geometry.attributes).reduce(
            (n, attribute) => n + attribute.array.byteLength,
            0,
          ) +
          mesh.geometry.getIndex()!.array.byteLength,
        0,
      );
    const views = [];
    for (const [name, x, y, z] of [
      ['hall', 128.7, 5.2401, 18.1],
      ['forecourt', 76, 1.6201, 0],
    ] as const) {
      const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
      camera.position.set(x, y, z);
      camera.lookAt(0, y + x * Math.tan(0.04), z);
      const snapshot = (detail: FacadeDetail) => {
        detail.setQuality('high');
        detail.update(camera.position, camera);
        return {
          draws: Object.values(detail.meshes).filter((mesh) => mesh.geometry.drawRange.count > 0)
            .length,
          triangles: Object.values(detail.meshes).reduce(
            (total, mesh) => total + mesh.geometry.drawRange.count / 3,
            0,
          ),
          shadowTriangles: detail.shadowMesh.geometry.getIndex()!.count / 3,
        };
      };
      const a = snapshot(before!);
      const b = snapshot(after);
      views.push({ name, before: a, after: b, triangleRatio: b.triangles / a.triangles });
    }
    const receipt = {
      scope: 'Actual Market facade buffers; same High-tier model camera poses, no GPU timing claim',
      beforeBytes: buffers(before!),
      afterBytes: buffers(after),
      views,
    };
    const output = new URL(
      '../../../../tools/assets/build/market-window-trim-buffers-20261006.json',
      import.meta.url,
    );
    mkdirSync(new URL('.', output), { recursive: true });
    writeFileSync(output, JSON.stringify(receipt, null, 2));
    for (const view of views) {
      expect(view.after.draws).toBe(view.before.draws);
      expect(view.after.shadowTriangles).toBe(view.before.shadowTriangles);
      expect(view.triangleRatio).toBeLessThanOrEqual(1.15);
    }
  }, 60_000);

  it('keeps the full map within three material draws and a bounded Low triangle budget', () => {
    const d = buildFacadeDetail(placDefilad(), fake())!;
    expect(d.children).toHaveLength(4);
    expect(d.cells.length).toBeGreaterThan(50);
    expect(d.cells.length).toBeLessThan(1000);
    // Medium keeps some physical openings across the plaza, with progressively cheaper
    // painted panels in the middle distance and the same coarse shell on the distant city.
    d.setQuality('medium');
    d.update({ x: 120, y: 1.7, z: 0 });
    const [near, mid, far] = d.lodCounts();
    expect(near).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(mid);
    d.setQuality('low');
    const plaza = { x: 120, y: 1.7, z: 0 };
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
    camera.position.set(plaza.x, plaza.y, plaza.z);
    camera.lookAt(0, 1.7, 0);
    d.update(plaza, camera);
    const triangles = Object.values(d.meshes).reduce(
      (n, m) => n + m.geometry.drawRange.count / 3,
      0,
    );
    const shadowTriangles = d.shadowMesh.geometry.getIndex()!.count / 3;
    const output = new URL(
      '../../../../tools/assets/build/facade-low-budget-20261008.json',
      import.meta.url,
    );
    mkdirSync(new URL('.', output), { recursive: true });
    writeFileSync(
      output,
      JSON.stringify(
        {
          scope: 'Full-map facade only, Low plaza camera; not whole-game GPU cost',
          triangles,
          limit: 65000,
          shadowTriangles,
          draws: Object.values(d.meshes).filter((mesh) => mesh.geometry.drawRange.count > 0).length,
        },
        null,
        2,
      ),
    );
    expect(triangles).toBeLessThan(65_000);
    expect(shadowTriangles).toBe(facadeFaces(placDefilad(), PALACE_TINT).length * 2);
  }, 30_000);
});
