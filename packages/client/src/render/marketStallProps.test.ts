import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap, resolveMap, stall } from '@wd/shared';
import {
  buildMarketStallProps,
  createMarketSignTexture,
  MARKET_SIGN_ATLAS_SIZE,
  type StallPropPiece,
} from './marketStallProps.ts';

function localPieceBounds(piece: StallPropPiece): THREE.Box3 {
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

function triangleCount(pieces: readonly StallPropPiece[]): number {
  return pieces.reduce((sum, p) => sum + (p.geo.index ? p.geo.index.count / 3 : 0), 0);
}

function signature(pieces: readonly StallPropPiece[]): unknown[] {
  return pieces.map((p) => [p.mat, p.color, p.at, p.rot, p.geo.index?.count ?? 0]);
}

describe('market stall props', () => {
  it('covers every authored Market stall with deterministic varied props', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const before = JSON.stringify(map);
    const stalls = map.boxes.filter((b) => b.visible !== false && b.dress === 'stallAwning');
    const all = stalls.map((canopy) => buildMarketStallProps(canopy));
    expect(stalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(map)).toBe(before);
    expect(all.every((pieces) => pieces.length >= 12)).toBe(true);
    expect(new Set(all.map((pieces) => JSON.stringify(signature(pieces)))).size).toBeGreaterThan(
      Math.floor(stalls.length * 0.75),
    );
    console.info(
      `Market stall props: ${stalls.length} stalls, ${all.reduce(
        (sum, pieces) => sum + triangleCount(pieces),
        0,
      )} additional triangles`,
    );
  });

  it('is deterministic for the same canopy and changes with stall position', () => {
    const [a] = stall({ x: 10, z: -8, rot: 90 }).filter((b) => b.dress === 'stallAwning');
    const [b] = stall({ x: 13, z: -8, rot: 90 }).filter((box) => box.dress === 'stallAwning');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(signature(buildMarketStallProps(a!))).toEqual(signature(buildMarketStallProps(a!)));
    expect(signature(buildMarketStallProps(a!))).not.toEqual(signature(buildMarketStallProps(b!)));
  });

  it('keeps the visible labels above the counter and all props inside the cover envelope', () => {
    const [canopy] = stall({ x: 0, z: 0 }).filter((b) => b.dress === 'stallAwning');
    const pieces = buildMarketStallProps(canopy!);
    const cover = new THREE.Box3(
      new THREE.Vector3(-1.7, -2.33, -1.15),
      new THREE.Vector3(1.7, 0.04, 1.15),
    );
    for (const piece of pieces) {
      const bb = localPieceBounds(piece);
      expect(within(bb, cover)).toBe(true);
    }
    const priceCards = pieces.filter(
      (p) => p.mat === 'sign' && p.at[1] < -1.02 && p.at[1] > -1.18 && p.at[2] > 0.25,
    );
    expect(priceCards).toHaveLength(3);
    for (const card of priceCards) expect(localPieceBounds(card).min.y).toBeGreaterThan(-1.33);
    const receipts = pieces.filter(
      (p) => p.mat === 'sign' && p.rot?.[0] === -Math.PI / 2 && p.at[2] >= 0.27 && p.at[2] <= 0.32,
    );
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    for (const receipt of receipts) expect(localPieceBounds(receipt).max.y).toBeGreaterThan(-1.33);
  });

  it('emits finite indexed geometry and stays below the per-stall triangle budget', () => {
    const [canopy] = stall({ x: 0, z: 0 }).filter((b) => b.dress === 'stallAwning');
    const pieces = buildMarketStallProps(canopy!);
    expect(triangleCount(pieces)).toBeLessThanOrEqual(120);
    expect(pieces.some((p) => p.mat === 'sign')).toBe(true);
    for (const piece of pieces) {
      expect(piece.geo.index).toBeTruthy();
      const pos = piece.geo.getAttribute('position');
      const normal = piece.geo.getAttribute('normal');
      for (const attr of [pos, normal]) {
        for (let i = 0; i < attr.count; i++) {
          expect(Number.isFinite(attr.getX(i))).toBe(true);
          expect(Number.isFinite(attr.getY(i))).toBe(true);
          expect(Number.isFinite(attr.getZ(i))).toBe(true);
        }
      }
      for (let i = 0; i < normal.count; i++) {
        expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 5);
      }
    }
  });

  it('uses one shared 512 square sign atlas', () => {
    const tex = createMarketSignTexture();
    expect(createMarketSignTexture()).toBe(tex);
    expect(tex.image.width).toBe(MARKET_SIGN_ATLAS_SIZE);
    expect(tex.image.height).toBe(MARKET_SIGN_ATLAS_SIZE);
    const data = tex.image.data;
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data!.length).toBe(MARKET_SIGN_ATLAS_SIZE * MARKET_SIGN_ATLAS_SIZE * 4);
    const darkPixels = Array.from(data!).filter((v, i) => i % 4 !== 3 && v < 60).length;
    expect(darkPixels).toBeGreaterThan(8000);
  });
});
