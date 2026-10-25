import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap, resolveMap, stall, type MapBox, type MapDefinition } from '@wd/shared';
import { findMarketStallFinishes, type StallFinishPiece } from './marketStallFinish.ts';

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'market-stall-finish-test',
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  boxes,
  spawns: [],
  dummies: [],
});

function localPieceBounds(piece: StallFinishPiece): THREE.Box3 {
  const geo = piece.geo.clone();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(piece.rot ?? [0, 0, 0])));
  geo.applyMatrix4(
    new THREE.Matrix4().compose(new THREE.Vector3(...piece.at), q, new THREE.Vector3(1, 1, 1)),
  );
  geo.computeBoundingBox();
  return geo.boundingBox!;
}

function within(bounds: THREE.Box3, box: THREE.Box3, eps = 1e-6): boolean {
  return (
    bounds.min.x >= box.min.x - eps &&
    bounds.max.x <= box.max.x + eps &&
    bounds.min.y >= box.min.y - eps &&
    bounds.max.y <= box.max.y + eps &&
    bounds.min.z >= box.min.z - eps &&
    bounds.max.z <= box.max.z + eps
  );
}

function triangleCount(pieces: StallFinishPiece[]): number {
  return pieces.reduce((sum, p) => sum + p.geo.index!.count / 3, 0);
}

describe('market stall finish', () => {
  it('covers the actual Market stalls without changing the authored layout', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const before = JSON.stringify(map);
    const stalls = map.boxes.filter((b) => b.dress === 'stallAwning' && b.visible !== false);
    const finishes = findMarketStallFinishes(map);
    expect(stalls.length).toBeGreaterThan(0);
    expect([...finishes.keys()]).toEqual(stalls);
    expect(JSON.stringify(map)).toBe(before);
    console.info(
      `Market finish: ${stalls.length} stalls, ${[...finishes.values()].reduce((n, p) => n + triangleCount(p), 0)} additional triangles`,
    );
  });
  it('finds only complete visible authored stalls across right-angle rotations and raised ground', () => {
    for (const rot of [0, 90, 180, 270]) {
      const boxes = stall({ x: 7, y: 1.75, z: -9, rot });
      const canopy = boxes.find((b) => b.dress === 'stallAwning')!;
      const finishes = findMarketStallFinishes(mapOf(boxes));
      expect([...finishes.keys()]).toEqual([canopy]);
      expect(finishes.get(canopy)).toHaveLength(33);
    }
  });

  it('does not infer finishes from missing, hidden, or mismatched companion boxes', () => {
    const boxes = stall({ x: 0, z: 0, rot: 90 });
    const canopy = boxes.find((b) => b.dress === 'stallAwning')!;
    const counter = boxes.find((b) => b.mat === 'wood' && b.size.y === 1)!;
    const back = boxes.find((b) => b.mat === 'wood' && b.size.y === 2.2)!;

    expect(findMarketStallFinishes(mapOf([canopy, back])).size).toBe(0);
    expect(
      findMarketStallFinishes(mapOf([canopy, { ...counter, visible: false }, back])).size,
    ).toBe(0);
    expect(
      findMarketStallFinishes(
        mapOf([canopy, { ...counter, center: { ...counter.center, x: 9 } }, back]),
      ).size,
    ).toBe(0);
    expect(
      findMarketStallFinishes(mapOf([{ ...canopy, visible: false }, counter, back])).size,
    ).toBe(0);
  });

  it('is deterministic and does not mutate the map', () => {
    const boxes = stall({ x: -3, y: 0.4, z: 5, rot: 180 });
    const before = JSON.stringify(boxes);
    const canopy = boxes.find((b) => b.dress === 'stallAwning')!;
    const a = findMarketStallFinishes(mapOf(boxes)).get(canopy)!;
    const b = findMarketStallFinishes(mapOf(boxes)).get(canopy)!;
    expect(JSON.stringify(boxes)).toBe(before);
    expect(a.map((p) => [p.mat, p.color, p.at, p.rot])).toEqual(
      b.map((p) => [p.mat, p.color, p.at, p.rot]),
    );
    expect(Array.from(a[0]!.geo.getAttribute('position').array)).toEqual(
      Array.from(b[0]!.geo.getAttribute('position').array),
    );
  });

  it('keeps all overlay bounds inside the original counter and back panel with only a 4 mm lip', () => {
    const boxes = stall({ x: 0, z: 0 });
    const canopy = boxes.find((b) => b.dress === 'stallAwning')!;
    const pieces = findMarketStallFinishes(mapOf(boxes)).get(canopy)!;
    const lip = 0.004;
    const counter = new THREE.Box3(
      new THREE.Vector3(-1.5 - lip, -2.33 - lip, 0.25 - lip),
      new THREE.Vector3(1.5 + lip, -1.33 + lip, 0.95 + lip),
    );
    const back = new THREE.Box3(
      new THREE.Vector3(-1.5 - lip, -2.33 - lip, -0.94 - lip),
      new THREE.Vector3(1.5 + lip, -0.13 + lip, -0.86 + lip),
    );
    for (const piece of pieces) {
      const bb = localPieceBounds(piece);
      expect(within(bb, counter) || within(bb, back)).toBe(true);
      if (bb.max.z > 0.25) {
        expect(bb.max.z).toBeLessThanOrEqual(0.954 + 1e-6);
        expect(bb.max.y).toBeLessThanOrEqual(-1.326 + 1e-6);
      }
    }
  });

  it('emits indexed finite geometry with outward normals and stays below the per-stall triangle budget', () => {
    const boxes = stall({ x: 0, z: 0 });
    const canopy = boxes.find((b) => b.dress === 'stallAwning')!;
    const pieces = findMarketStallFinishes(mapOf(boxes)).get(canopy)!;
    expect(triangleCount(pieces)).toBeLessThanOrEqual(1000);
    expect(triangleCount(pieces)).toBe(996);
    for (const piece of pieces) {
      expect(piece.geo.index).toBeTruthy();
      const pos = piece.geo.getAttribute('position');
      const normal = piece.geo.getAttribute('normal');
      const index = piece.geo.index!;
      for (let i = 0; i < normal.count; i++) {
        const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
        expect(Number.isFinite(len)).toBe(true);
        expect(len).toBeCloseTo(1, 5);
      }
      for (let i = 0; i < index.count; i += 3) {
        const ia = index.getX(i);
        const ib = index.getX(i + 1);
        const ic = index.getX(i + 2);
        const a = new THREE.Vector3(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
        const b = new THREE.Vector3(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
        const c = new THREE.Vector3(pos.getX(ic), pos.getY(ic), pos.getZ(ic));
        const face = b
          .sub(a)
          .cross(c.sub(new THREE.Vector3(pos.getX(ia), pos.getY(ia), pos.getZ(ia))));
        const n = new THREE.Vector3(normal.getX(ia), normal.getY(ia), normal.getZ(ia));
        expect(face.dot(n)).toBeGreaterThan(0);
      }
    }
  });
});
