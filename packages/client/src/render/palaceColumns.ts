import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALACE_TINT, type MapBox, type MapDefinition, type Vec3 } from '@wd/shared';
import type { MapMaterials } from './materials.ts';
import { palaceColumnMaterial } from './palaceColumnMaterial.ts';

const COLUMN_X = 51.5;
const COLUMN_Y = 6;
const COLUMN_SIZE = { x: 1.3, y: 12, z: 1.3 } as const;
const COLUMN_Z = new Set([-15, -11, -7, -3, 1, 5, 9, 13]);
const EPS = 1e-5;

const STONE_VERTEX = new THREE.Color(0.98, 0.965, 0.93);
const SHAFT_Y0 = 0.78;
const SHAFT_Y1 = 10.02;
const SHAFT_HALF = 0.515;
const SHAFT_CORNER_RADIUS = 0.09;

type Vec2 = { x: number; z: number };
type ProfilePoint = Vec2 & { nx: number; nz: number; recess: number };
type RingPoint = ProfilePoint & { y: number; shade: number; cavity: number };
type RingLayer = { y: number; half: number; radius: number; shade: number };

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function columnVariation(z: number): number {
  const n = Math.sin((z + 23.17) * 12.9898) * 43758.5453;
  return 0.96 + (n - Math.floor(n)) * 0.045;
}

/** Exact visual replacement target for the eight authored Palace east-portico collision boxes. */
export function isPalacePorticoColumn(b: MapBox): boolean {
  return (
    b.mat === 'facade' &&
    b.tint === PALACE_TINT &&
    b.visible !== false &&
    !b.rot &&
    close(b.center.x, COLUMN_X) &&
    close(b.center.y, COLUMN_Y) &&
    COLUMN_Z.has(Math.round(b.center.z)) &&
    close(b.center.z, Math.round(b.center.z)) &&
    close(b.size.x, COLUMN_SIZE.x) &&
    close(b.size.y, COLUMN_SIZE.y) &&
    close(b.size.z, COLUMN_SIZE.z)
  );
}

class Builder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly cavity: number[] = [];
  readonly idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(p: Vec3, n: Vec3, shade: number, cavity = 1): void {
    const horizontal = Math.abs(n.y) > 0.5 ? p.x : Math.abs(n.x) > Math.abs(n.z) ? p.z : p.x;
    const vertical = Math.abs(n.y) > 0.5 ? p.z : p.y;
    const s = clamp01(shade);
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(horizontal, vertical);
    this.col.push(STONE_VERTEX.r * s, STONE_VERTEX.g * s, STONE_VERTEX.b * s);
    this.cavity.push(cavity);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('columnOcclusion', new THREE.Float32BufferAttribute(this.cavity, 1));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

function addQuad(
  b: Builder,
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  normals: readonly [Vec3, Vec3, Vec3, Vec3],
  shade: readonly [number, number, number, number],
  cavity: readonly [number, number, number, number] = [1, 1, 1, 1],
): void {
  const base = b.vertexCount;
  for (let i = 0; i < 4; i++) b.vertex(corners[i]!, normals[i]!, shade[i]!, cavity[i]);

  const ax = corners[1].x - corners[0].x;
  const ay = corners[1].y - corners[0].y;
  const az = corners[1].z - corners[0].z;
  const bx = corners[2].x - corners[0].x;
  const by = corners[2].y - corners[0].y;
  const bz = corners[2].z - corners[0].z;
  const n = {
    x: normals[0].x + normals[1].x + normals[2].x + normals[3].x,
    y: normals[0].y + normals[1].y + normals[2].y + normals[3].y,
    z: normals[0].z + normals[1].z + normals[2].z + normals[3].z,
  };
  const dot = (ay * bz - az * by) * n.x + (az * bx - ax * bz) * n.y + (ax * by - ay * bx) * n.z;
  if (dot >= 0) b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  else b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

function slopedNormal(point: RingPoint, other: RingPoint): Vec3 {
  const dy = other.y - point.y;
  if (Math.abs(dy) < 1e-6) return { x: point.nx, y: 0, z: point.nz };
  const slope = ((other.x - point.x) * point.nx + (other.z - point.z) * point.nz) / dy;
  const len = Math.hypot(point.nx, slope, point.nz) || 1;
  return { x: point.nx / len, y: -slope / len, z: point.nz / len };
}

function addTriangle(
  b: Builder,
  points: readonly [Vec3, Vec3, Vec3],
  normal: Vec3,
  shade: number,
): void {
  const base = b.vertexCount;
  for (const p of points) b.vertex(p, normal, shade);
  const ax = points[1].x - points[0].x;
  const ay = points[1].y - points[0].y;
  const az = points[1].z - points[0].z;
  const bx = points[2].x - points[0].x;
  const by = points[2].y - points[0].y;
  const bz = points[2].z - points[0].z;
  const dot =
    (ay * bz - az * by) * normal.x +
    (az * bx - ax * bz) * normal.y +
    (ax * by - ay * bx) * normal.z;
  if (dot >= 0) b.idx.push(base, base + 1, base + 2);
  else b.idx.push(base, base + 2, base + 1);
}

function sideShade(localY: number, variation: number, recess = 0, seam = 0): number {
  const bottomGrime = (1 - smoothstep(0.2, 2.2, localY)) * 0.035;
  const underCapOcclusion = smoothstep(9.75, 10.25, localY) * 0.018;
  // Recesses collect slight surface dirt; geometric occlusion is carried separately.
  const fluteOcclusion = recess * 0.025;
  const courseOcclusion = seam * 0.035;
  return variation * (1 - bottomGrime - underCapOcclusion - fluteOcclusion - courseOcclusion);
}

function fluteRecess(t: number): number {
  const centres = [-0.285, 0, 0.285];
  let recess = 0;
  for (const centre of centres) {
    const d = Math.abs(t - centre);
    if (d >= 0.13) continue;
    const bowl = 0.5 + 0.5 * Math.cos((d / 0.13) * Math.PI);
    recess = Math.max(recess, 0.105 * Math.pow(bowl, 0.72));
  }
  return recess;
}

function addPoint(points: Vec2[], x: number, z: number): void {
  const last = points[points.length - 1];
  if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.z - z) < 1e-6) return;
  points.push({ x, z });
}

function normaliseProfile(points: Vec2[], centre: Vec2, fluted = false): ProfilePoint[] {
  return points.map((p, i) => {
    const prev = points[(i - 1 + points.length) % points.length]!;
    const next = points[(i + 1) % points.length]!;
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    let nx = tz;
    let nz = -tx;
    if (nx * (p.x - centre.x) + nz * (p.z - centre.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const len = Math.hypot(nx, nz) || 1;
    const faceDepth = SHAFT_HALF - Math.max(Math.abs(p.x - centre.x), Math.abs(p.z - centre.z));
    const recess = fluted ? clamp01(faceDepth / 0.105) : 0;
    return { x: p.x, z: p.z, nx: nx / len, nz: nz / len, recess };
  });
}

function roundedSquareProfile(half: number, radius: number, faceSamples = 2): ProfilePoint[] {
  const points: Vec2[] = [];
  const straight = half - radius;
  const sideSamples = Math.max(2, faceSamples);
  for (let i = 0; i < sideSamples; i++)
    addPoint(points, -straight + (2 * straight * i) / (sideSamples - 1), half);
  for (let i = 1; i <= 3; i++) {
    const a = Math.PI / 2 - (i * Math.PI) / 8;
    addPoint(points, straight + Math.cos(a) * radius, straight + Math.sin(a) * radius);
  }
  for (let i = 0; i < sideSamples; i++)
    addPoint(points, half, straight - (2 * straight * i) / (sideSamples - 1));
  for (let i = 1; i <= 3; i++) {
    const a = -(i * Math.PI) / 8;
    addPoint(points, straight + Math.cos(a) * radius, -straight + Math.sin(a) * radius);
  }
  for (let i = 0; i < sideSamples; i++)
    addPoint(points, straight - (2 * straight * i) / (sideSamples - 1), -half);
  for (let i = 1; i <= 3; i++) {
    const a = -Math.PI / 2 - (i * Math.PI) / 8;
    addPoint(points, -straight + Math.cos(a) * radius, -straight + Math.sin(a) * radius);
  }
  for (let i = 0; i < sideSamples; i++)
    addPoint(points, -half, -straight + (2 * straight * i) / (sideSamples - 1));
  for (let i = 1; i <= 3; i++) {
    const a = Math.PI - (i * Math.PI) / 8;
    addPoint(points, -straight + Math.cos(a) * radius, straight + Math.sin(a) * radius);
  }
  return normaliseProfile(points, { x: 0, z: 0 });
}

function flutedProfile(): ProfilePoint[] {
  const half = SHAFT_HALF;
  const corner = SHAFT_CORNER_RADIUS;
  const straight = half - corner;
  const points: Vec2[] = [];
  const sideSteps = 13;

  for (let i = 0; i < sideSteps; i++) {
    const x = -straight + (2 * straight * i) / (sideSteps - 1);
    addPoint(points, x, half - fluteRecess(x));
  }
  for (let i = 1; i <= 2; i++) {
    const a = Math.PI / 2 - (i * Math.PI) / 6;
    addPoint(points, straight + Math.cos(a) * corner, straight + Math.sin(a) * corner);
  }
  for (let i = 0; i < sideSteps; i++) {
    const z = straight - (2 * straight * i) / (sideSteps - 1);
    addPoint(points, half - fluteRecess(z), z);
  }
  for (let i = 1; i <= 2; i++) {
    const a = -(i * Math.PI) / 6;
    addPoint(points, straight + Math.cos(a) * corner, -straight + Math.sin(a) * corner);
  }
  for (let i = 0; i < sideSteps; i++) {
    const x = straight - (2 * straight * i) / (sideSteps - 1);
    addPoint(points, x, -half + fluteRecess(x));
  }
  for (let i = 1; i <= 2; i++) {
    const a = -Math.PI / 2 - (i * Math.PI) / 6;
    addPoint(points, -straight + Math.cos(a) * corner, -straight + Math.sin(a) * corner);
  }
  for (let i = 0; i < sideSteps; i++) {
    const z = -straight + (2 * straight * i) / (sideSteps - 1);
    addPoint(points, -half + fluteRecess(z), z);
  }
  for (let i = 1; i <= 2; i++) {
    const a = Math.PI - (i * Math.PI) / 6;
    addPoint(points, -straight + Math.cos(a) * corner, straight + Math.sin(a) * corner);
  }
  return normaliseProfile(points, { x: 0, z: 0 }, true);
}

function buildShaftRows(minY: number): { y: number; seam: number }[] {
  const rows: { y: number; seam: number }[] = [{ y: minY + SHAFT_Y0, seam: 0 }];
  for (let seamY = minY + SHAFT_Y0 + 1.16; seamY < minY + SHAFT_Y1 - 0.55; seamY += 1.28) {
    rows.push({ y: seamY - 0.022, seam: 0 }, { y: seamY, seam: 1 }, { y: seamY + 0.022, seam: 0 });
  }
  rows.push({ y: minY + SHAFT_Y1, seam: 0 });
  rows.sort((a, b) => a.y - b.y);
  return rows;
}

function ringFromProfile(
  profile: ProfilePoint[],
  c: Vec3,
  y: number,
  shade: number,
  inset = 0,
  seam = 0,
): RingPoint[] {
  return profile.map((p) => {
    const radial = Math.hypot(p.x, p.z) || 1;
    const x = p.x - (p.x / radial) * inset;
    const z = p.z - (p.z / radial) * inset;
    return {
      x: c.x + x,
      y,
      z: c.z + z,
      nx: p.nx,
      nz: p.nz,
      recess: p.recess,
      shade: shade * sideShade(y - (c.y - COLUMN_SIZE.y / 2), 1, p.recess, seam),
      cavity: 1 - p.recess * 0.28 - seam * 0.12,
    };
  });
}

function connectRings(b: Builder, lower: RingPoint[], upper: RingPoint[]): void {
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length;
    const a = lower[i]!;
    const b0 = lower[j]!;
    const c = upper[j]!;
    const d = upper[i]!;
    addQuad(
      b,
      [
        { x: a.x, y: a.y, z: a.z },
        { x: b0.x, y: b0.y, z: b0.z },
        { x: c.x, y: c.y, z: c.z },
        { x: d.x, y: d.y, z: d.z },
      ],
      [slopedNormal(a, d), slopedNormal(b0, c), slopedNormal(c, b0), slopedNormal(d, a)],
      [a.shade, b0.shade, c.shade, d.shade],
      [a.cavity, b0.cavity, c.cavity, d.cavity],
    );
  }
}

function addCap(
  b: Builder,
  ring: RingPoint[],
  c: Vec3,
  y: number,
  ySign: -1 | 1,
  shade: number,
): void {
  const centre = { x: c.x, y, z: c.z };
  const normal = { x: 0, y: ySign, z: 0 };
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const a = ring[i]!;
    const p = ring[j]!;
    addTriangle(b, [centre, { x: a.x, y, z: a.z }, { x: p.x, y, z: p.z }], normal, shade);
  }
}

function addLayeredBlock(b: Builder, c: Vec3, layers: RingLayer[], variation: number): void {
  const rings = layers.map((layer) =>
    ringFromProfile(
      roundedSquareProfile(layer.half, layer.radius),
      c,
      layer.y,
      layer.shade * variation,
    ),
  );
  for (let i = 0; i < rings.length - 1; i++) connectRings(b, rings[i]!, rings[i + 1]!);
  addCap(b, rings[0]!, c, layers[0]!.y, -1, layers[0]!.shade * variation * 0.985);
  addCap(
    b,
    rings[rings.length - 1]!,
    c,
    layers[layers.length - 1]!.y,
    1,
    layers[layers.length - 1]!.shade * variation,
  );
}

function addShaft(b: Builder, c: Vec3, variation: number): void {
  const minY = c.y - COLUMN_SIZE.y / 2;
  const profile = flutedProfile();
  const rows = buildShaftRows(minY);
  const rings = rows.map(({ y, seam }) => {
    const inset = seam * 0.015;
    return ringFromProfile(profile, c, y, variation, inset, seam);
  });
  for (let i = 0; i < rings.length - 1; i++) connectRings(b, rings[i]!, rings[i + 1]!);
}

function addColumn(b: Builder, c: Vec3): void {
  const minY = c.y - COLUMN_SIZE.y / 2;
  const maxY = c.y + COLUMN_SIZE.y / 2;
  const variation = columnVariation(c.z);

  addLayeredBlock(
    b,
    c,
    [
      { y: minY, half: 0.65, radius: 0.095, shade: 0.96 },
      { y: minY + 0.08, half: 0.65, radius: 0.095, shade: 0.97 },
      { y: minY + 0.24, half: 0.61, radius: 0.085, shade: 0.985 },
      { y: minY + 0.42, half: 0.56, radius: 0.08, shade: 0.99 },
      { y: minY + 0.62, half: 0.52, radius: 0.075, shade: 1.0 },
      { y: minY + SHAFT_Y0, half: 0.49, radius: 0.075, shade: 0.985 },
    ],
    variation,
  );

  addShaft(b, c, variation);

  addLayeredBlock(
    b,
    c,
    [
      { y: minY + SHAFT_Y1, half: 0.49, radius: 0.075, shade: 0.995 },
      { y: minY + 10.2, half: 0.52, radius: 0.08, shade: 1.0 },
      { y: minY + 10.38, half: 0.59, radius: 0.085, shade: 0.985 },
      { y: minY + 10.58, half: 0.55, radius: 0.08, shade: 0.975 },
      { y: minY + 10.78, half: 0.64, radius: 0.095, shade: 0.97 },
      { y: minY + 11.08, half: 0.65, radius: 0.095, shade: 0.965 },
      { y: maxY, half: 0.65, radius: 0.095, shade: 0.965 },
    ],
    variation,
  );
}

function columnShadowProxy(columns: readonly MapBox[]): THREE.Mesh {
  // Preserve the structural silhouette without rendering flutes and mouldings into the sun map.
  const parts = columns.flatMap(({ center }) => {
    const floor = center.y - COLUMN_SIZE.y / 2;
    const sections: readonly [number, number, number][] = [
      [0, SHAFT_Y0, COLUMN_SIZE.x],
      [SHAFT_Y0, SHAFT_Y1, SHAFT_HALF * 2],
      [SHAFT_Y1, COLUMN_SIZE.y, COLUMN_SIZE.x],
    ];
    return sections.map(([bottom, top, width]) =>
      new THREE.BoxGeometry(width, top - bottom, width).translate(
        center.x,
        floor + (bottom + top) / 2,
        center.z,
      ),
    );
  });
  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error('Palace column shadow geometry is incompatible');
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const proxy = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  );
  proxy.name = 'palace-columns:shadow-proxy';
  proxy.castShadow = true;
  // Same non-instanced depth program as facade:shadow-proxy, explicitly compiled in facade warm-up.
  proxy.customDepthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.BackSide,
  });
  proxy.matrixAutoUpdate = false;
  return proxy;
}

export function buildPalaceColumns(
  map: Pick<MapDefinition, 'boxes'>,
  materials: MapMaterials,
): THREE.Group | null {
  const columns = map.boxes.filter(isPalacePorticoColumn);
  if (columns.length === 0) return null;

  const builder = new Builder();
  for (const col of columns) addColumn(builder, col.center);
  const mesh = new THREE.Mesh(builder.build(), palaceColumnMaterial(materials));
  mesh.name = 'palace-columns:stone';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;

  const group = new THREE.Group();
  group.name = 'palace-columns';
  group.add(mesh, columnShadowProxy(columns));
  return group;
}
