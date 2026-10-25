import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildLightmapLayout,
  getMap,
  lightmapSceneHash,
  PALACE_TINT,
  placDefilad,
  resolveMap,
  type MapDefinition,
  type MaterialId,
} from '@wd/shared';
import { buildFacadeDetail, type FacadeBake, type FacadeDetail } from './facadeDetail.ts';
import { facadeFaces } from './facadeRelief.ts';
import type { MapMaterials } from './materials.ts';
import {
  palaceClockGeometry,
  palaceCrownGeometry,
  palaceCrowns,
  palaceSpireGeometry,
  type PalaceStoneGeometry,
} from './palaceSilhouette.ts';

/** Real material identity/cache behavior without procedural textures or a browser canvas. */
class FakeMaterials {
  typicalRoughness(): number {
    return 0.12;
  }
  onActiveMaps(): void {}
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();

  get(id: MaterialId): THREE.MeshStandardMaterial {
    let material = this.mats.get(id);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ name: id });
      this.mats.set(id, material);
    }
    return material;
  }

  variant(
    id: MaterialId,
    key: string,
    configure: (material: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    const cacheKey = `${id}|${key}`;
    let material = this.mats.get(cacheKey);
    if (!material) {
      material = this.get(id).clone();
      material.name = cacheKey;
      configure(material);
      this.mats.set(cacheKey, material);
    }
    return material;
  }

  facadeShellVariant(
    key: string,
    configure: (material: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    return this.variant('facade', `shell|${key}`, configure);
  }
}

const fake = (): MapMaterials => new FakeMaterials() as unknown as MapMaterials;
const market = resolveMap(getMap('defilad'), 'market');
const qualities = ['low', 'medium', 'high', 'ultra'] as const;
const plaza = new THREE.Vector3(120, 1.7, 0);

function visibleDraws(detail: FacadeDetail): number {
  return Object.values(detail.meshes).filter((mesh) => mesh.geometry.drawRange.count > 0).length;
}

function plazaView(detail: FacadeDetail): void {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
  camera.position.copy(plaza);
  camera.lookAt(0, 1.7, 0);
  detail.setQuality('low');
  // Clear previous near-LOD hysteresis before evaluating this independently authored pose.
  detail.update({ x: 1200, y: 1.7, z: 0 });
  detail.update(plaza, camera);
}

function triangleKey(points: readonly (readonly number[])[]): string {
  // Source doubles become Float32 positions in the merged facade buffers.
  return points
    .map((point) => point.map((coordinate) => Math.fround(coordinate)).join(','))
    .sort()
    .join('|');
}

function counts(keys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of keys) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

function stoneTriangles(geometries: readonly PalaceStoneGeometry[]): Map<string, number> {
  const keys: string[] = [];
  for (const geometry of geometries) {
    for (let i = 0; i < geometry.idx.length; i += 3) {
      keys.push(
        triangleKey(
          geometry.idx
            .slice(i, i + 3)
            .map((vertex) => geometry.pos.slice(vertex * 3, vertex * 3 + 3)),
        ),
      );
    }
  }
  return counts(keys);
}

function drawnTriangles(mesh: THREE.Mesh): Map<string, number> {
  const positions = mesh.geometry.getAttribute('position');
  const indices = mesh.geometry.getIndex()!;
  const { start, count } = mesh.geometry.drawRange;
  const keys: string[] = [];
  for (let i = start; i < start + count; i += 3) {
    const vertices = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
    keys.push(
      triangleKey(
        vertices.map((vertex) => [
          positions.getX(vertex),
          positions.getY(vertex),
          positions.getZ(vertex),
        ]),
      ),
    );
  }
  return counts(keys);
}

describe('Palace render budgets and bake isolation', () => {
  it('keeps three existing facade meshes, their materials and the unchanged flat shadow proxy', () => {
    const detail = buildFacadeDetail(market, fake())!;
    const meshes = Object.values(detail.meshes);
    const snapshots = meshes.map((mesh) => ({
      mesh,
      material: mesh.material,
      geometry: mesh.geometry,
    }));
    const proxy = detail.shadowMesh.geometry;
    const proxyIndices = proxy.getIndex()!;
    const proxyPositions = proxy.getAttribute('position');
    const expectedProxyTriangles = facadeFaces(market, PALACE_TINT).length * 2;
    expect(meshes).toHaveLength(3);
    expect(detail.children).toHaveLength(4);
    expect(detail.shadowMesh.name).toBe('facade:shadow-proxy');
    expect(proxyIndices.count / 3).toBe(expectedProxyTriangles);

    for (const quality of qualities) {
      detail.setQuality(quality);
      for (const pose of [
        { x: 76, y: 1.62, z: 0 },
        { x: 120, y: 1.7, z: 0 },
        { x: 1200, y: 180, z: 0 },
      ]) {
        detail.update(pose);
        expect(visibleDraws(detail)).toBeLessThanOrEqual(3);
        expect(detail.children).toHaveLength(4);
        for (const snapshot of snapshots) {
          expect(snapshot.mesh.material).toBe(snapshot.material);
          expect(snapshot.mesh.geometry).toBe(snapshot.geometry);
          expect(snapshot.mesh.castShadow).toBe(false);
        }
        expect(detail.children.filter((child) => child.castShadow)).toEqual([detail.shadowMesh]);
        expect(detail.shadowMesh.geometry).toBe(proxy);
        expect(proxy.getIndex()).toBe(proxyIndices);
        expect(proxy.getAttribute('position')).toBe(proxyPositions);
        expect(proxyIndices.count / 3).toBe(expectedProxyTriangles);
      }
    }
    plazaView(detail);
    expect(visibleDraws(detail)).toBe(2);
  }, 30_000);

  it('retains every Market crown triangle at far LOD while omitting near mouldings', () => {
    const faces = facadeFaces(market, PALACE_TINT);
    const crowns = palaceCrowns(faces, market.prisms ?? []).map(palaceCrownGeometry);
    const frame = stoneTriangles(crowns.map((crown) => crown.frame));
    const mouldings = stoneTriangles(crowns.map((crown) => crown.detail));
    const detail = buildFacadeDetail(market, fake())!;
    expect(frame.size).toBeGreaterThan(0);
    expect(mouldings.size).toBeGreaterThan(0);
    for (const quality of qualities) {
      detail.setQuality(quality);
      // No frustum: prove that LOD selection preserves every tier, including offscreen roofs.
      detail.update({ x: 1200, y: 180, z: 0 });
      const [near, mid] = detail.lodCounts();
      expect(near).toBe(0);
      expect(mid).toBe(0);
      const drawn = drawnTriangles(detail.meshes.shell!);
      for (const [key, count] of frame) expect(drawn.get(key) ?? 0).toBeGreaterThanOrEqual(count);
      for (const key of mouldings.keys()) expect(drawn.has(key)).toBe(false);
    }
  }, 30_000);

  it('selects the same roof outline plus small mouldings at near LOD', () => {
    const map: MapDefinition = {
      name: 'palace-crown-lod',
      bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
      boxes: [],
      prisms: [
        {
          pts: [
            [0, 0],
            [12, 0],
            [12, 12],
            [0, 12],
          ],
          y0: 0,
          y1: 16,
          mat: 'facade',
          tint: PALACE_TINT,
          top: 'concrete',
        },
      ],
      spawns: [],
      dummies: [],
    };
    const crowns = palaceCrowns(facadeFaces(map, PALACE_TINT), map.prisms ?? []).map(
      palaceCrownGeometry,
    );
    const frame = stoneTriangles(crowns.map((crown) => crown.frame));
    const mouldings = stoneTriangles(crowns.map((crown) => crown.detail));
    const detail = buildFacadeDetail(map, fake())!;
    expect(mouldings.size).toBeGreaterThan(0);
    for (const quality of qualities) {
      detail.setQuality(quality);
      detail.update({ x: 18, y: 16, z: 6 });
      expect(detail.lodCounts()[0]).toBe(detail.cells.length);
      const drawn = drawnTriangles(detail.meshes.shell!);
      for (const [key, count] of [...frame, ...mouldings])
        expect(drawn.get(key) ?? 0).toBeGreaterThanOrEqual(count);
    }
  });

  it('maps every ornament vertex to the reserved white texel without changing either bake hash', () => {
    const before = JSON.stringify(market);
    const layout = buildLightmapLayout(market);
    const white = [
      layout.atlas.white.x / layout.atlas.width,
      layout.atlas.white.y / layout.atlas.height,
    ] as const;
    const wallUv = [0.6, 0.8] as const;
    const bake: FacadeBake = {
      uvFor: () => () => wallUv,
      unbakedUv: () => white,
      tex: new THREE.Texture(),
      key: 'palace-test-existing-atlas',
      intensity: 1,
    };
    const faces = facadeFaces(market, PALACE_TINT);
    const ornaments = [
      ...palaceCrowns(faces, market.prisms ?? []).flatMap((crown) =>
        Object.values(palaceCrownGeometry(crown)),
      ),
      ...palaceClockGeometry(faces),
      palaceSpireGeometry(faces)!,
    ];
    const expectedWhiteVertices = ornaments.reduce((n, geometry) => n + geometry.pos.length / 3, 0);
    const detail = buildFacadeDetail(market, fake(), bake)!;
    const uv1 = detail.meshes.shell!.geometry.getAttribute('uv1');
    const quantized = white.map((coordinate) => Math.round(coordinate * 65535) / 65535);
    let whiteVertices = 0;
    let wallVertices = 0;
    for (let i = 0; i < uv1.count; i++) {
      if (
        Math.abs(uv1.getX(i) - quantized[0]!) < 1e-8 &&
        Math.abs(uv1.getY(i) - quantized[1]!) < 1e-8
      )
        whiteVertices++;
      else {
        expect(uv1.getX(i)).toBeCloseTo(wallUv[0], 4);
        expect(uv1.getY(i)).toBeCloseTo(wallUv[1], 4);
        wallVertices++;
      }
    }
    expect(whiteVertices).toBe(expectedWhiteVertices);
    expect(wallVertices).toBeGreaterThan(0);
    expect(layout.hash).toBe('1f8605625ccbab');
    expect(lightmapSceneHash(market, layout, 16)).toBe('10a65919c6a0f5');
    expect(JSON.stringify(market)).toBe(before);
    expect(buildLightmapLayout(market).hash).toBe(layout.hash);
  }, 30_000);

  it('keeps both full-map and Market Low plaza frusta below 65,000 facade triangles', () => {
    for (const map of [placDefilad(), market]) {
      const detail = buildFacadeDetail(map, fake())!;
      plazaView(detail);
      const triangles = Object.values(detail.meshes).reduce(
        (n, mesh) => n + mesh.geometry.drawRange.count / 3,
        0,
      );
      expect(triangles).toBeGreaterThan(0);
      expect(triangles).toBeLessThan(65_000);
      expect(visibleDraws(detail)).toBe(2);
    }
  }, 30_000);
});
