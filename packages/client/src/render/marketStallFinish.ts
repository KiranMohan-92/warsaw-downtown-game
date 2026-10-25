import * as THREE from 'three';
import {
  quatFromEulerDeg,
  rotateByQuat,
  type MapBox,
  type MapDefinition,
  type Vec3,
} from '@wd/shared';

export interface StallFinishPiece {
  geo: THREE.BufferGeometry;
  mat: 'wood' | 'metal';
  color: number;
  at: [number, number, number];
  rot?: [number, number, number];
}

const COUNTER_SIZE = { x: 3, y: 1, z: 0.7 };
const BACK_SIZE = { x: 3, y: 2.2, z: 0.08 };
const COUNTER_REL = { x: 0, y: -1.83, z: 0.6 };
const BACK_REL = { x: 0, y: -1.23, z: -0.9 };
const MATCH_EPS = 1e-4;
const BEVEL = 0.003;
const PLANK_THICKNESS = 0.0072;

const almost = (a: number, b: number, eps = MATCH_EPS): boolean => Math.abs(a - b) <= eps;

function sameSize(a: Vec3, b: Vec3): boolean {
  return almost(a.x, b.x) && almost(a.y, b.y) && almost(a.z, b.z);
}

function sameRot(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
  const ar = a ?? { x: 0, y: 0, z: 0 };
  const br = b ?? { x: 0, y: 0, z: 0 };
  return almost(ar.x, br.x) && almost(ar.y, br.y) && almost(ar.z, br.z);
}

function expectedCenter(canopy: MapBox, local: Vec3): Vec3 {
  const r = rotateByQuat(local, quatFromEulerDeg(canopy.rot));
  return {
    x: canopy.center.x + r.x,
    y: canopy.center.y + r.y,
    z: canopy.center.z + r.z,
  };
}

function sameCenter(a: Vec3, b: Vec3): boolean {
  return almost(a.x, b.x) && almost(a.y, b.y) && almost(a.z, b.z);
}

function hasCompanion(map: MapDefinition, canopy: MapBox, size: Vec3, rel: Vec3): boolean {
  const center = expectedCenter(canopy, rel);
  return map.boxes.some(
    (b) =>
      b !== canopy &&
      b.visible !== false &&
      b.mat === 'wood' &&
      sameSize(b.size, size) &&
      sameRot(b.rot, canopy.rot) &&
      sameCenter(b.center, center),
  );
}

function tint(canopy: MapBox, salt: number): number {
  const h =
    Math.sin(
      Math.round(canopy.center.x * 10) * 12.9898 +
        Math.round(canopy.center.z * 10) * 78.233 +
        Math.round(canopy.center.y * 10) * 37.719 +
        salt,
    ) * 43758.5453;
  const t = h - Math.floor(h);
  const v = 0xe0d6c2;
  const k = 0.88 + t * 0.18;
  const r = Math.min(255, Math.round(((v >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((v >> 8) & 255) * k));
  const b = Math.min(255, Math.round((v & 255) * k));
  return (r << 16) | (g << 8) | b;
}

type V = [number, number, number];

function pushFace(
  pos: number[],
  normal: number[],
  uv: number[],
  index: number[],
  verts: V[],
): void {
  const center = verts.reduce((p, v) => [p[0] + v[0], p[1] + v[1], p[2] + v[2]] as V, [0, 0, 0]);
  center[0] /= verts.length;
  center[1] /= verts.length;
  center[2] /= verts.length;
  const a = new THREE.Vector3(...verts[0]!);
  const b = new THREE.Vector3(...verts[1]!);
  const c = new THREE.Vector3(...verts[2]!);
  const n = b
    .sub(a)
    .cross(c.sub(new THREE.Vector3(...verts[0]!)))
    .normalize();
  if (n.dot(new THREE.Vector3(...center)) < 0) {
    verts = [...verts].reverse();
    n.negate();
  }
  const first = pos.length / 3;
  let ax = 0;
  let ay = 1;
  if (Math.abs(n.x) > Math.abs(n.y) && Math.abs(n.x) > Math.abs(n.z)) {
    ax = 2;
    ay = 1;
  } else if (Math.abs(n.y) > Math.abs(n.z)) {
    ax = 0;
    ay = 2;
  }
  for (const v of verts) {
    pos.push(v[0], v[1], v[2]);
    normal.push(n.x, n.y, n.z);
    uv.push(v[ax]!, v[ay]!);
  }
  if (verts.length === 3) index.push(first, first + 1, first + 2);
  else index.push(first, first + 1, first + 2, first, first + 2, first + 3);
}

/**
 * Indexed chamfered timber cuboid with UVs in local metres. The tiny bevel catches specular
 * highlights without changing the stall's cover silhouette.
 */
function woodBox(
  w: number,
  h: number,
  d: number,
  bevel = BEVEL,
  uvOffset: [number, number] = [0, 0],
): THREE.BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const b = Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45);
  const pos: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (const sx of [-1, 1] as const)
    pushFace(pos, normal, uv, index, [
      [sx * hx, -hy + b, -hz + b],
      [sx * hx, hy - b, -hz + b],
      [sx * hx, hy - b, hz - b],
      [sx * hx, -hy + b, hz - b],
    ]);
  for (const sy of [-1, 1] as const)
    pushFace(pos, normal, uv, index, [
      [-hx + b, sy * hy, -hz + b],
      [hx - b, sy * hy, -hz + b],
      [hx - b, sy * hy, hz - b],
      [-hx + b, sy * hy, hz - b],
    ]);
  for (const sz of [-1, 1] as const)
    pushFace(pos, normal, uv, index, [
      [-hx + b, -hy + b, sz * hz],
      [hx - b, -hy + b, sz * hz],
      [hx - b, hy - b, sz * hz],
      [-hx + b, hy - b, sz * hz],
    ]);
  for (const sx of [-1, 1] as const)
    for (const sy of [-1, 1] as const)
      pushFace(pos, normal, uv, index, [
        [sx * hx, sy * (hy - b), -hz + b],
        [sx * (hx - b), sy * hy, -hz + b],
        [sx * (hx - b), sy * hy, hz - b],
        [sx * hx, sy * (hy - b), hz - b],
      ]);
  for (const sx of [-1, 1] as const)
    for (const sz of [-1, 1] as const)
      pushFace(pos, normal, uv, index, [
        [sx * hx, -hy + b, sz * (hz - b)],
        [sx * (hx - b), -hy + b, sz * hz],
        [sx * (hx - b), hy - b, sz * hz],
        [sx * hx, hy - b, sz * (hz - b)],
      ]);
  for (const sy of [-1, 1] as const)
    for (const sz of [-1, 1] as const)
      pushFace(pos, normal, uv, index, [
        [-hx + b, sy * hy, sz * (hz - b)],
        [hx - b, sy * hy, sz * (hz - b)],
        [hx - b, sy * (hy - b), sz * hz],
        [-hx + b, sy * (hy - b), sz * hz],
      ]);
  for (const sx of [-1, 1] as const)
    for (const sy of [-1, 1] as const)
      for (const sz of [-1, 1] as const)
        pushFace(pos, normal, uv, index, [
          [sx * hx, sy * (hy - b), sz * (hz - b)],
          [sx * (hx - b), sy * hy, sz * (hz - b)],
          [sx * (hx - b), sy * (hy - b), sz * hz],
        ]);

  for (let i = 0; i < uv.length; i += 2) {
    uv[i] = uv[i]! + uvOffset[0];
    uv[i + 1] = uv[i + 1]! + uvOffset[1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

function fastener(): THREE.BufferGeometry {
  return new THREE.CircleGeometry(0.018, 6);
}

function pieces(canopy: MapBox): StallFinishPiece[] {
  const out: StallFinishPiece[] = [];
  const wood = (salt: number): number => tint(canopy, salt);
  for (let i = 0; i < 10; i++) {
    const x = -1.35 + i * 0.3;
    const geo = woodBox(0.288, 0.82, PLANK_THICKNESS, BEVEL, [i * 0.17, 0.31]);
    // The scan's grain runs along U: these face planks stand vertically.
    const uv = geo.getAttribute('uv');
    for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getY(j), uv.getX(j));
    out.push({
      geo,
      mat: 'wood',
      color: wood(i),
      at: [x, -1.81, 0.95],
    });
  }
  for (let i = 0; i < 4; i++) {
    const z = 0.34 + i * 0.17;
    out.push({
      geo: woodBox(2.96, PLANK_THICKNESS, 0.15, BEVEL, [0.11, i * 0.29]),
      mat: 'wood',
      color: wood(10 + i),
      at: [0, -1.33, z],
    });
  }
  for (let i = 0; i < 7; i++) {
    const y = -2.1775 + i * 0.313;
    out.push({
      geo: woodBox(2.96, 0.305, PLANK_THICKNESS, BEVEL, [i * 0.23, 0.67]),
      mat: 'wood',
      color: wood(20 + i),
      at: [0, y, -0.86],
    });
  }
  for (const x of [-1.125, -0.375, 0.375, 1.125]) {
    out.push({ geo: fastener(), mat: 'metal', color: 0x3b3833, at: [x, -1.76, 0.954] });
  }
  for (const y of [-2.05, -1.19, -0.33]) {
    for (const x of [-1.22, 1.22])
      out.push({ geo: fastener(), mat: 'metal', color: 0x343434, at: [x, y, -0.856] });
  }
  for (const x of [-1.3, 1.3])
    out.push({
      geo: fastener(),
      mat: 'metal',
      color: 0x3f3f3f,
      at: [x, -1.326, 0.34],
      rot: [-Math.PI / 2, 0, 0],
    });
  return out;
}

export function findMarketStallFinishes(map: MapDefinition): Map<MapBox, StallFinishPiece[]> {
  const result = new Map<MapBox, StallFinishPiece[]>();
  for (const canopy of map.boxes) {
    if (canopy.visible === false || canopy.dress !== 'stallAwning') continue;
    if (!hasCompanion(map, canopy, COUNTER_SIZE, COUNTER_REL)) continue;
    if (!hasCompanion(map, canopy, BACK_SIZE, BACK_REL)) continue;
    result.set(canopy, pieces(canopy));
  }
  return result;
}
