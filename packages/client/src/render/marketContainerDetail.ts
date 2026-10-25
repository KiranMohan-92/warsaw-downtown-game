import * as THREE from 'three';
import {
  MARKET_BOUNDS,
  quatFromEulerDeg,
  type MapBox,
  type MapDefinition,
  type MaterialId,
} from '@wd/shared';

export interface MarketContainerPiece {
  geo: THREE.BufferGeometry;
  mat: MaterialId;
  color: number;
  source: MapBox;
}

const DETAIL_BOUNDS = {
  minX: MARKET_BOUNDS.minX,
  maxX: MARKET_BOUNDS.maxX + 4,
  minZ: MARKET_BOUNDS.minZ - 4,
  maxZ: MARKET_BOUNDS.maxZ + 4,
};
const PANEL_MIN_HEIGHT = 0.5;
const PANEL_MIN_WIDTH = 0.9;
const PROUD = 0.012;
const RIB_W = 0.035;
const RIB_TOP = 0.2;
const RIB_BOTTOM = 0.18;
const RIB_PITCH = 0.36;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _c = new THREE.Color();

function inMarket(b: MapBox): boolean {
  return (
    b.mat === 'container' &&
    b.visible !== false &&
    b.center.x >= DETAIL_BOUNDS.minX &&
    b.center.x <= DETAIL_BOUNDS.maxX &&
    b.center.z >= DETAIL_BOUNDS.minZ &&
    b.center.z <= DETAIL_BOUNDS.maxZ &&
    b.center.y >= -6 &&
    b.center.y <= 8
  );
}

function tint(b: MapBox, k = 1): number {
  const base = b.tint ?? 0x7c8084;
  _c.setHex(base, THREE.SRGBColorSpace).multiplyScalar(k);
  return _c.getHex(THREE.SRGBColorSpace);
}

function boxGeometry(size: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const uv = g.getAttribute('uv');
  const normal = g.getAttribute('normal');
  for (let i = 0; i < uv.count; i++) {
    const axis = Math.abs(normal.getX(i)) > 0.5 ? 0 : Math.abs(normal.getY(i)) > 0.5 ? 1 : 2;
    const width = axis === 0 ? size[2] : size[0];
    const height = axis === 1 ? size[2] : size[1];
    uv.setXY(i, uv.getX(i) * width, uv.getY(i) * height);
  }
  const n = g.getAttribute('position').count;
  if (!g.index) g.setIndex([...Array(n).keys()]);
  g.setAttribute('aFace', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  return g;
}

function colorGeometry(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  _c.setHex(color, THREE.SRGBColorSpace);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([_c.r, _c.g, _c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.getAttribute('uv'))
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

function frameOf(b: MapBox): THREE.Matrix4 {
  const r = quatFromEulerDeg(b.rot);
  return new THREE.Matrix4().compose(
    _p.set(b.center.x, b.center.y, b.center.z),
    _q.set(r.x, r.y, r.z, r.w),
    _s,
  );
}

function addBox(
  out: MarketContainerPiece[],
  source: MapBox,
  frame: THREE.Matrix4,
  mat: MaterialId,
  color: number,
  size: [number, number, number],
  at: [number, number, number],
): void {
  const g = colorGeometry(boxGeometry(size), color);
  _m.makeTranslation(at[0], at[1], at[2]);
  g.applyMatrix4(_m);
  g.applyMatrix4(frame);
  out.push({ geo: g, mat, color, source });
}

function addPanelFace(
  out: MarketContainerPiece[],
  b: MapBox,
  frame: THREE.Matrix4,
  axis: 'x' | 'z',
  sign: -1 | 1,
): void {
  const along = axis === 'z' ? b.size.x : b.size.z;
  const height = b.size.y;
  if (along < PANEL_MIN_WIDTH || height < PANEL_MIN_HEIGHT) return;

  const halfN = (axis === 'z' ? b.size.z : b.size.x) / 2;
  const face = sign * (halfN + PROUD / 2);
  const usableH = Math.max(0.2, height - RIB_TOP - RIB_BOTTOM);
  const y = -height / 2 + RIB_BOTTOM + usableH / 2;
  const ribs = Math.max(2, Math.floor((along - 0.42) / RIB_PITCH));
  const first = -((ribs - 1) * RIB_PITCH) / 2;
  const ribSize: [number, number, number] =
    axis === 'z' ? [RIB_W, usableH, PROUD] : [PROUD, usableH, RIB_W];
  const railLong: [number, number, number] =
    axis === 'z' ? [along - 0.12, 0.055, PROUD] : [PROUD, 0.055, along - 0.12];
  const railShort: [number, number, number] =
    axis === 'z' ? [0.065, height - 0.12, PROUD] : [PROUD, height - 0.12, 0.065];
  const muted = tint(b, 0.92);
  for (let i = 0; i < ribs; i++) {
    const u = first + i * RIB_PITCH;
    addBox(out, b, frame, 'container', muted, ribSize, axis === 'z' ? [u, y, face] : [face, y, u]);
  }
  for (const yy of [-height / 2 + 0.11, height / 2 - 0.11]) {
    addBox(
      out,
      b,
      frame,
      'container',
      tint(b, yy > 0 ? 1.02 : 0.82),
      railLong,
      axis === 'z' ? [0, yy, face] : [face, yy, 0],
    );
  }
  const side = along / 2 - 0.055;
  for (const u of [-side, side]) {
    addBox(
      out,
      b,
      frame,
      'container',
      tint(b, 0.76),
      railShort,
      axis === 'z' ? [u, 0, face] : [face, 0, u],
    );
  }
}

function addEndHardware(
  out: MarketContainerPiece[],
  b: MapBox,
  frame: THREE.Matrix4,
  sign: -1 | 1,
): void {
  if (b.size.z < 1.8 || b.size.y < 1.6) return;
  const face = sign * (b.size.x / 2 + PROUD / 2);
  const width = b.size.z;
  const height = b.size.y;
  const rodSize: [number, number, number] = [PROUD, height - 0.38, 0.026];
  const seamSize: [number, number, number] = [PROUD, height - 0.2, 0.018];
  const hingeSize: [number, number, number] = [PROUD, 0.16, 0.08];
  addBox(out, b, frame, 'metal', 0x1f2224, seamSize, [face, 0, 0]);
  for (const z of [-width * 0.27, width * 0.27]) {
    addBox(out, b, frame, 'metal', 0x24282a, rodSize, [face, 0, z]);
    for (const y of [-height * 0.28, 0, height * 0.28]) {
      addBox(out, b, frame, 'metal', 0x17191b, hingeSize, [face, y, z + Math.sign(z) * 0.13]);
    }
  }
}

function addRoofFace(out: MarketContainerPiece[], b: MapBox, frame: THREE.Matrix4): void {
  if (b.size.x < 2 || b.size.z < 1) return;
  if (b.size.y <= 0.2 && b.center.y < 1.5) return;
  const y = b.size.y / 2 + PROUD / 2;
  const usableZ = Math.max(0.25, b.size.z - 0.14);
  const ribs = Math.max(2, Math.floor((b.size.x - 0.42) / RIB_PITCH));
  const first = -((ribs - 1) * RIB_PITCH) / 2;
  for (let i = 0; i < ribs; i++) {
    addBox(
      out,
      b,
      frame,
      'container',
      tint(b, 0.84),
      [RIB_W, PROUD, usableZ],
      [first + i * RIB_PITCH, y, 0],
    );
  }
  for (const z of [-(b.size.z / 2 - 0.055), b.size.z / 2 - 0.055]) {
    addBox(out, b, frame, 'container', tint(b, 0.72), [b.size.x - 0.12, PROUD, 0.055], [0, y, z]);
  }
}

/** Presentation-only corrugation, rails and door hardware for every authored Market container. */
export function buildMarketContainerPieces(map: MapDefinition): MarketContainerPiece[] {
  const out: MarketContainerPiece[] = [];
  for (const b of map.boxes) {
    if (!inMarket(b)) continue;
    const frame = frameOf(b);
    const verticalAxes: ('x' | 'z')[] = [];
    if (b.size.z <= 0.2 && b.size.x >= PANEL_MIN_WIDTH) verticalAxes.push('z');
    if (b.size.x <= 0.2 && b.size.z >= PANEL_MIN_WIDTH) verticalAxes.push('x');
    if (!verticalAxes.length && b.size.x >= 2 && b.size.z >= 1.5 && b.size.y >= 1.5) {
      verticalAxes.push('z', 'x');
    }
    for (const axis of verticalAxes) {
      addPanelFace(out, b, frame, axis, -1);
      addPanelFace(out, b, frame, axis, 1);
    }
    if (b.size.x <= 0.2 || (b.size.x >= 2 && b.size.z >= 1.5)) {
      addEndHardware(out, b, frame, -1);
      addEndHardware(out, b, frame, 1);
    }
    if (b.size.x >= 2 && b.size.z >= 1) addRoofFace(out, b, frame);
  }
  return out;
}
