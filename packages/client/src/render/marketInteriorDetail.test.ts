import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap, resolveMap, type MapBox } from '@wd/shared';
import {
  buildMarketInteriorPieces,
  interiorSourceBounds,
  type MarketInteriorPiece,
} from './marketInteriorDetail.ts';

type Bounds = { min: THREE.Vector3; max: THREE.Vector3 };

function boundsOf(piece: MarketInteriorPiece): Bounds {
  piece.geo.computeBoundingBox();
  const box = piece.geo.boundingBox!;
  return { min: box.min.clone(), max: box.max.clone() };
}

function expandedSource(source: MapBox): Bounds {
  const s = interiorSourceBounds(source);
  return {
    min: new THREE.Vector3(s.min.x, s.min.y, s.min.z),
    max: new THREE.Vector3(s.max.x, s.max.y, s.max.z),
  };
}

function inside(a: Bounds, b: Bounds, eps = 1e-5): boolean {
  return (
    a.min.x >= b.min.x - eps &&
    a.max.x <= b.max.x + eps &&
    a.min.y >= b.min.y - eps &&
    a.max.y <= b.max.y + eps &&
    a.min.z >= b.min.z - eps &&
    a.max.z <= b.max.z + eps
  );
}

function intersects(a: Bounds, b: Bounds): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

function aperture(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Bounds {
  return {
    min: new THREE.Vector3(x0, y0, z0),
    max: new THREE.Vector3(x1, y1, z1),
  };
}

function hallOpenings(): Bounds[] {
  const yDoor = [0.1, 2.3] as const;
  const yWin = [4.6, 5.7] as const;
  return [
    aperture(132.12, 134.08, yDoor[0], yDoor[1], 13.93, 14.07),
    aperture(144.12, 146.08, yDoor[0], yDoor[1], 13.93, 14.07),
    aperture(130.12, 132.08, yWin[0], yWin[1], 13.93, 14.07),
    aperture(137.12, 139.08, yWin[0], yWin[1], 13.93, 14.07),
    aperture(146.12, 148.08, yWin[0], yWin[1], 13.93, 14.07),
    aperture(138.12, 140.08, yDoor[0], yDoor[1], 27.93, 28.07),
    aperture(132.12, 134.08, yWin[0], yWin[1], 27.93, 28.07),
    aperture(142.12, 144.08, yWin[0], yWin[1], 27.93, 28.07),
    aperture(148.12, 150.08, yWin[0], yWin[1], 27.93, 28.07),
    aperture(127.93, 128.07, yDoor[0], yDoor[1], 20.12, 22.08),
    aperture(127.93, 128.07, yWin[0], yWin[1], 17.12, 19.08),
    aperture(127.93, 128.07, yWin[0], yWin[1], 23.12, 25.08),
    aperture(151.93, 152.07, yDoor[0], yDoor[1], 19.12, 21.08),
    aperture(151.93, 152.07, yWin[0], yWin[1], 22.12, 24.08),
  ];
}

describe('market interior architectural detail', () => {
  const map = resolveMap(getMap('defilad'), 'market');

  it('builds deterministic hall, metro and ceiling pieces from existing boxes', () => {
    const first = buildMarketInteriorPieces(map);
    const second = buildMarketInteriorPieces(map);
    expect(first.length).toBeGreaterThan(250);
    expect(first.some((p) => p.source?.mat === 'plaster')).toBe(true);
    expect(first.some((p) => p.source?.mat === 'tile')).toBe(true);
    expect(first.some((p) => p.kind === 'ceiling-bracket')).toBe(true);
    expect(first.map((p) => [p.kind, p.mat, p.color, p.sourceIndex, boundsOf(p)])).toEqual(
      second.map((p) => [p.kind, p.mat, p.color, p.sourceIndex, boundsOf(p)]),
    );
  });

  it('does not mutate the map or create unindexed/non-finite geometry', () => {
    const before = JSON.stringify(map.boxes);
    const pieces = buildMarketInteriorPieces(map);
    expect(JSON.stringify(map.boxes)).toBe(before);

    let tris = 0;
    for (const piece of pieces) {
      expect(piece.geo.index).not.toBeNull();
      tris += piece.geo.index!.count / 3;
      const pos = piece.geo.getAttribute('position');
      const nrm = piece.geo.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) {
        expect(Number.isFinite(pos.getX(i))).toBe(true);
        expect(Number.isFinite(pos.getY(i))).toBe(true);
        expect(Number.isFinite(pos.getZ(i))).toBe(true);
        expect(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))).toBeCloseTo(1, 5);
      }
    }
    expect(tris).toBeLessThanOrEqual(35000);
  });

  it('keeps wall trims inside the 12 mm source envelope and preserves authored openings', () => {
    // The hall's own dressing has its own checks (marketHallInterior.test.ts).
    const pieces = buildMarketInteriorPieces(map).filter(
      (p) => p.kind === 'wall-trim' || p.kind === 'opening-frame',
    );
    expect(pieces.length).toBeGreaterThan(100);
    for (const piece of pieces) {
      expect(piece.source).toBeDefined();
      const b = boundsOf(piece);
      expect(
        inside(b, expandedSource(piece.source!)),
        JSON.stringify({
          kind: piece.kind,
          mat: piece.mat,
          sourceIndex: piece.sourceIndex,
          source: piece.source,
          bounds: { min: b.min.toArray(), max: b.max.toArray() },
          expanded: expandedSource(piece.source!),
        }),
      ).toBe(true);
    }

    const trimBounds = pieces.map(boundsOf);
    for (const open of hallOpenings()) {
      expect(trimBounds.some((b) => intersects(b, open))).toBe(false);
    }
  });

  it('does not draw floor-like detail across underground stair shafts', () => {
    // Fittings on existing solids; the hall's own dressing (floor, ceiling panels) is checked
    // against the hall in marketHallInterior.test.ts.
    const pieces = buildMarketInteriorPieces(map).filter((p) => p.sourceIndex >= 0);
    for (const piece of pieces) {
      expect(piece.source?.mat).not.toBe('paving');
      expect(piece.source?.mat).not.toBe('terrazzo');
      const b = boundsOf(piece);
      const flat = b.max.y - b.min.y < 0.025 && (b.max.x - b.min.x > 1 || b.max.z - b.min.z > 1);
      expect(flat).toBe(false);
    }
  });
});
