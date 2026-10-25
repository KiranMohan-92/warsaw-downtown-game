import * as THREE from 'three';
import type { MapBox, MapDefinition, MaterialId, Vec3 } from '@wd/shared';
import { buildMarketHallPieces, type HallPieceKind } from './marketHallInterior.ts';

export interface MarketInteriorPiece {
  geo: THREE.BufferGeometry;
  mat: MaterialId;
  color: number;
  source?: MapBox;
  /** Index of `source` in the map's boxes (−1: hall dressing, built from many boxes). */
  sourceIndex: number;
  kind: 'wall-trim' | 'opening-frame' | 'ceiling-bracket' | HallPieceKind;
}

const HALL = { x0: 128, z0: 14, x1: 152, z1: 28 } as const;
const METRO = { x0: 60, z0: -36, x1: 158, z1: 36 } as const;
const METRO_Y0 = -5.05;
const METRO_Y1 = -0.45;
const SOURCE_TOLERANCE = 0.012;
const MIN_TRIM_LENGTH = 0.42;
const DETAIL_DEPTH = 0.012;
const FRAME_WIDTH = 0.09;
const BASE_HEIGHT = 0.13;
const CAP_HEIGHT = 0.1;
const BRACKET_THICKNESS = 0.045;

type Bounds = { min: Vec3; max: Vec3 };
type Axis = 'x' | 'z';
type Side = -1 | 1;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function minMax(b: MapBox): Bounds {
  return {
    min: {
      x: b.center.x - b.size.x / 2,
      y: b.center.y - b.size.y / 2,
      z: b.center.z - b.size.z / 2,
    },
    max: {
      x: b.center.x + b.size.x / 2,
      y: b.center.y + b.size.y / 2,
      z: b.center.z + b.size.z / 2,
    },
  };
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && a1 > b0;
}

function inRect(b: Bounds, r: { x0: number; z0: number; x1: number; z1: number }): boolean {
  return b.max.x >= r.x0 && b.min.x <= r.x1 && b.max.z >= r.z0 && b.min.z <= r.z1;
}

function isAxisAligned(b: MapBox): boolean {
  const r = b.rot;
  return !r || (Math.abs(r.x) < 1e-6 && Math.abs(r.y) < 1e-6 && Math.abs(r.z) < 1e-6);
}

function geometryFromBounds(bounds: Bounds): THREE.BufferGeometry {
  const sx = bounds.max.x - bounds.min.x;
  const sy = bounds.max.y - bounds.min.y;
  const sz = bounds.max.z - bounds.min.z;
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const uv = geo.getAttribute('uv');
  const normal = geo.getAttribute('normal');
  for (let i = 0; i < uv.count; i++) {
    const axis = Math.abs(normal.getX(i)) > 0.5 ? 0 : Math.abs(normal.getY(i)) > 0.5 ? 1 : 2;
    uv.setXY(i, uv.getX(i) * (axis === 0 ? sz : sx), uv.getY(i) * (axis === 1 ? sz : sy));
  }
  geo.translate(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2,
  );
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function pushPiece(
  out: MarketInteriorPiece[],
  bounds: Bounds,
  mat: MaterialId,
  color: number,
  source: MapBox,
  sourceIndex: number,
  kind: MarketInteriorPiece['kind'],
): void {
  if (
    bounds.max.x - bounds.min.x < 0.01 ||
    bounds.max.y - bounds.min.y < 0.01 ||
    bounds.max.z - bounds.min.z < 0.01
  ) {
    return;
  }
  out.push({ geo: geometryFromBounds(bounds), mat, color, source, sourceIndex, kind });
}

function faceBounds(
  source: Bounds,
  axis: Axis,
  side: Side,
  along0: number,
  along1: number,
  y0: number,
  y1: number,
  depth = DETAIL_DEPTH,
): Bounds {
  const face = source[side < 0 ? 'min' : 'max'];
  const cross0 = side < 0 ? -depth : 0;
  const cross1 = side < 0 ? 0 : depth;
  const x0 = axis === 'x' ? along0 : face.x + cross0;
  const x1 = axis === 'x' ? along1 : face.x + cross1;
  const z0 = axis === 'z' ? along0 : face.z + cross0;
  const z1 = axis === 'z' ? along1 : face.z + cross1;
  return {
    min: { x: Math.min(x0, x1), y: y0, z: Math.min(z0, z1) },
    max: { x: Math.max(x0, x1), y: y1, z: Math.max(z0, z1) },
  };
}

function addWallTrims(
  out: MarketInteriorPiece[],
  b: MapBox,
  sourceIndex: number,
  color: number,
  sides: readonly Side[] = [-1, 1],
): void {
  const s = minMax(b);
  const axis: Axis = b.size.x >= b.size.z ? 'x' : 'z';
  const alongMin = axis === 'x' ? s.min.x : s.min.z;
  const alongMax = axis === 'x' ? s.max.x : s.max.z;
  const len = alongMax - alongMin;
  if (len < MIN_TRIM_LENGTH || b.size.y < 0.28) return;

  for (const side of sides) {
    pushPiece(
      out,
      faceBounds(s, axis, side, alongMin, alongMax, s.min.y + 0.025, s.min.y + BASE_HEIGHT),
      'metal',
      color,
      b,
      sourceIndex,
      'wall-trim',
    );
    if (b.size.y > 1.2) {
      pushPiece(
        out,
        faceBounds(s, axis, side, alongMin, alongMax, s.max.y - CAP_HEIGHT, s.max.y - 0.025),
        'metal',
        color,
        b,
        sourceIndex,
        'wall-trim',
      );
    }

    const verticalY0 = s.min.y + 0.06;
    const verticalY1 = s.max.y - 0.06;
    if (verticalY1 - verticalY0 < 0.24) continue;
    const left1 = Math.min(alongMax, alongMin + FRAME_WIDTH);
    const right0 = Math.max(alongMin, alongMax - FRAME_WIDTH);
    pushPiece(
      out,
      faceBounds(s, axis, side, alongMin, left1, verticalY0, verticalY1),
      'metal',
      color,
      b,
      sourceIndex,
      'opening-frame',
    );
    if (right0 - alongMin > FRAME_WIDTH * 1.5) {
      pushPiece(
        out,
        faceBounds(s, axis, side, right0, alongMax, verticalY0, verticalY1),
        'metal',
        color,
        b,
        sourceIndex,
        'opening-frame',
      );
    }
  }
}

function addMetroTileBands(out: MarketInteriorPiece[], b: MapBox, sourceIndex: number): void {
  const s = minMax(b);
  const axis: Axis = b.size.x >= b.size.z ? 'x' : 'z';
  const alongMin = axis === 'x' ? s.min.x : s.min.z;
  const alongMax = axis === 'x' ? s.max.x : s.max.z;
  if (alongMax - alongMin < 0.65 || b.size.y < 1.0) return;

  for (const side of [-1, 1] as const) {
    for (const y of [-4.12, -2.62, -1.12]) {
      const y0 = clamp(y, s.min.y + 0.08, s.max.y - 0.14);
      pushPiece(
        out,
        faceBounds(s, axis, side, alongMin, alongMax, y0, y0 + 0.045, SOURCE_TOLERANCE),
        'metal',
        0xb7c2c9,
        b,
        sourceIndex,
        'wall-trim',
      );
    }
  }
}

function addBeamBrackets(out: MarketInteriorPiece[], b: MapBox, sourceIndex: number): void {
  const s = minMax(b);
  const longAxis: Axis = b.size.x >= b.size.z ? 'x' : 'z';
  const long = longAxis === 'x' ? b.size.x : b.size.z;
  if (long < 4 || b.size.y > 0.45) return;

  const alongMin = longAxis === 'x' ? s.min.x : s.min.z;
  const alongMax = longAxis === 'x' ? s.max.x : s.max.z;
  const crossMin = longAxis === 'x' ? s.min.z : s.min.x;
  const crossMax = longAxis === 'x' ? s.max.z : s.max.x;
  const ys = [s.min.y - BRACKET_THICKNESS, s.min.y + 0.01] as const;
  const endDepth = 0.16;
  for (const side of [-1, 1] as const) {
    const a0 = side < 0 ? alongMin - 0.01 : alongMax - endDepth + 0.01;
    const a1 = side < 0 ? alongMin + endDepth - 0.01 : alongMax + 0.01;
    const bounds =
      longAxis === 'x'
        ? {
            min: { x: a0, y: ys[0], z: crossMin - 0.055 },
            max: { x: a1, y: ys[1], z: crossMax + 0.055 },
          }
        : {
            min: { x: crossMin - 0.055, y: ys[0], z: a0 },
            max: { x: crossMax + 0.055, y: ys[1], z: a1 },
          };
    pushPiece(out, bounds, 'metal', 0x30343a, b, sourceIndex, 'ceiling-bracket');
  }
}

/**
 * The outward side of a hall perimeter wall (the inside is dressed by marketHallInterior.ts), or
 * null for an upstairs partition (dressed there on every face).
 */
function hallExterior(b: MapBox): Side | null {
  const cx = (HALL.x0 + HALL.x1) / 2;
  const cz = (HALL.z0 + HALL.z1) / 2;
  if (Math.abs(b.center.z - HALL.z0) < 0.05 || Math.abs(b.center.z - HALL.z1) < 0.05)
    return b.center.z < cz ? -1 : 1;
  if (Math.abs(b.center.x - HALL.x0) < 0.05 || Math.abs(b.center.x - HALL.x1) < 0.05)
    return b.center.x < cx ? -1 : 1;
  return null;
}

function isHallWall(b: MapBox): boolean {
  const s = minMax(b);
  return (
    b.visible !== false &&
    b.mat === 'plaster' &&
    isAxisAligned(b) &&
    inRect(s, HALL) &&
    overlaps(s.min.y, s.max.y, -0.01, 7.25) &&
    (b.size.x <= 0.31 || b.size.z <= 0.31)
  );
}

function isMetroWall(b: MapBox): boolean {
  const s = minMax(b);
  return (
    b.visible !== false &&
    b.mat === 'tile' &&
    isAxisAligned(b) &&
    inRect(s, METRO) &&
    overlaps(s.min.y, s.max.y, METRO_Y0, METRO_Y1) &&
    (b.size.x <= 0.42 || b.size.z <= 0.42)
  );
}

function isHallCeilingBeam(b: MapBox): boolean {
  const s = minMax(b);
  return (
    b.visible !== false &&
    (b.mat === 'wood' || b.mat === 'trim') &&
    isAxisAligned(b) &&
    inRect(s, HALL) &&
    overlaps(s.min.y, s.max.y, 3.0, 7.25) &&
    Math.max(b.size.x, b.size.z) >= 4 &&
    Math.min(b.size.x, b.size.z) <= 0.35
  );
}

export function interiorSourceBounds(source: MapBox): Bounds {
  const b = minMax(source);
  return {
    min: {
      x: b.min.x - SOURCE_TOLERANCE,
      y: b.min.y - SOURCE_TOLERANCE,
      z: b.min.z - SOURCE_TOLERANCE,
    },
    max: {
      x: b.max.x + SOURCE_TOLERANCE,
      y: b.max.y + SOURCE_TOLERANCE,
      z: b.max.z + SOURCE_TOLERANCE,
    },
  };
}

export function buildMarketInteriorPieces(
  map: Pick<MapDefinition, 'boxes'>,
): MarketInteriorPiece[] {
  const pieces: MarketInteriorPiece[] = [];
  map.boxes.forEach((b, sourceIndex) => {
    if (isHallWall(b)) {
      const out = hallExterior(b);
      if (out !== null) addWallTrims(pieces, b, sourceIndex, 0x909ca3, [out]);
    } else if (isMetroWall(b)) {
      addWallTrims(pieces, b, sourceIndex, 0x9ca7af);
      addMetroTileBands(pieces, b, sourceIndex);
    } else if (isHallCeilingBeam(b)) {
      addBeamBrackets(pieces, b, sourceIndex);
    }
  });
  for (const p of buildMarketHallPieces(map))
    pieces.push({ geo: p.geo, mat: p.mat, color: 0xffffff, sourceIndex: -1, kind: p.kind });
  return pieces;
}
