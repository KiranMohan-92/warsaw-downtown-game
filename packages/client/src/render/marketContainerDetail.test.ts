import * as THREE from 'three';
import { container, getMap, resolveMap, type MapBox, type MapDefinition } from '@wd/shared';
import { describe, expect, it } from 'vitest';
import { buildMarketContainerPieces } from './marketContainerDetail.ts';

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'container-detail-test',
  bounds: { minX: 38, maxX: 174, minZ: -66, maxZ: 68 },
  boxes,
  spawns: [],
  dummies: [],
});

function triangleCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
}

describe('market container detail', () => {
  it('covers the authored Market containers with finite indexed geometry under budget', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const original = JSON.stringify(map.boxes);
    const containerBoxes = map.boxes.filter((b) => b.mat === 'container' && b.visible !== false);
    const pieces = buildMarketContainerPieces(map);
    expect(containerBoxes.length).toBeGreaterThan(20);
    expect(pieces.length).toBeGreaterThan(1000);
    expect(JSON.stringify(map.boxes)).toBe(original);

    const bySource = new Map<MapBox, number>();
    for (const p of pieces) {
      bySource.set(p.source, (bySource.get(p.source) ?? 0) + triangleCount(p.geo));
      expect(p.geo.index).toBeTruthy();
      for (const name of ['position', 'normal', 'uv', 'color', 'aFace']) {
        expect(p.geo.getAttribute(name), name).toBeTruthy();
      }
      const pos = p.geo.getAttribute('position');
      const normal = p.geo.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) {
        if (
          !Number.isFinite(pos.getX(i)) ||
          !Number.isFinite(pos.getY(i)) ||
          !Number.isFinite(pos.getZ(i))
        )
          throw new Error('container detail emitted a non-finite position');
        const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
        if (len < 0.99 || len > 1.01) throw new Error('container detail emitted a bad normal');
      }
    }
    expect(bySource.size).toBeGreaterThan(100);
    expect(Math.max(...bySource.values())).toBeLessThanOrEqual(2000);
  });

  it('keeps open container ends clear and only adds shallow raised detail', () => {
    const boxes = container({ x: 100, z: 0, rot: 30 }, 'ends');
    const pieces = buildMarketContainerPieces(mapOf(boxes));
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.some((p) => p.source.size.x > 5 && p.source.size.z < 0.2)).toBe(true);
    expect(pieces.some((p) => p.source.size.x < 0.2 && p.source.size.z > 1.8)).toBe(false);

    const src = boxes.find((b) => b.size.x > 5 && b.size.z < 0.2)!;
    const srcBox = new THREE.Box3();
    const detailBox = new THREE.Box3();
    for (const p of pieces.filter((p) => p.source === src))
      detailBox.union(
        new THREE.Box3().setFromBufferAttribute(
          p.geo.getAttribute('position') as THREE.BufferAttribute,
        ),
      );
    const frame = new THREE.Matrix4();
    const srcGeo = new THREE.BoxGeometry(src.size.x, src.size.y, src.size.z);
    srcGeo.applyMatrix4(
      frame
        .makeRotationY(((src.rot?.y ?? 0) * Math.PI) / 180)
        .setPosition(src.center.x, src.center.y, src.center.z),
    );
    srcBox.setFromBufferAttribute(srcGeo.getAttribute('position') as THREE.BufferAttribute);
    expect(detailBox.max.x - srcBox.max.x).toBeLessThan(0.02);
    expect(srcBox.min.x - detailBox.min.x).toBeLessThan(0.02);
    expect(detailBox.max.z - srcBox.max.z).toBeLessThan(0.02);
    expect(srcBox.min.z - detailBox.min.z).toBeLessThan(0.02);
  });

  it('adds door rods only when a closed end panel exists', () => {
    const sideOpen = buildMarketContainerPieces(mapOf(container({ x: 110, z: 0, rot: 0 }, 'side')));
    const closed = buildMarketContainerPieces(mapOf(container({ x: 120, z: 0, rot: 0 }, 'closed')));
    expect(sideOpen.some((p) => p.mat === 'metal' && p.source.size.x < 0.2)).toBe(true);
    expect(sideOpen.some((p) => p.mat === 'metal' && p.source.size.x > 5)).toBe(false);
    expect(closed.some((p) => p.mat === 'metal')).toBe(true);
  });

  it('keeps fitting textures at metre scale rather than stretching a tile over every strip', () => {
    const pieces = buildMarketContainerPieces(mapOf(container({ x: 100, z: 0 }, 'closed')));
    for (const { geo } of pieces) {
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv');
      // Each BoxGeometry face has four vertices; its U/V spans match its physical edge lengths.
      for (let i = 0; i < pos.count; i += 4) {
        const edge = (a: number, b: number) =>
          Math.hypot(
            pos.getX(a) - pos.getX(b),
            pos.getY(a) - pos.getY(b),
            pos.getZ(a) - pos.getZ(b),
          );
        expect(Math.abs(uv.getX(i) - uv.getX(i + 1))).toBeCloseTo(edge(i, i + 1), 4);
        expect(Math.abs(uv.getY(i) - uv.getY(i + 2))).toBeCloseTo(edge(i, i + 2), 4);
      }
    }
  });
});
