/** Client-only skyline dressing: OSM massing in, merged world-metre geometry out. */
import * as THREE from 'three';
import {
  area,
  centroid,
  clipConvex,
  rectPoly,
  type MapDefinition,
  type MapPrism,
  type MaterialId,
  type Pt,
} from '@wd/shared';
import { skylineStyle, skylineWall } from './skylineFacades.ts';

/** Entire decorated backdrop, including the original extrusions, before any frustum culling. */
export const SKYLINE_TRIANGLE_CAP = 60_000;

export interface SkylineGeometry {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
  /** Per-building bay/storey/seed/surface, zero for opaque roof equipment and bands. */
  detail: number[];
  idx: number[];
}
export interface SkylineBucket {
  mat: MaterialId;
  key: string;
  geometry: SkylineGeometry;
}
export interface RooftopPart {
  kind:
    | 'parapet'
    | 'coping'
    | 'plant'
    | 'hvac'
    | 'mast'
    | 'antenna'
    | 'tank'
    | 'crane'
    | 'step'
    | 'fin'
    | 'slope';
  source: number;
  parent: number | null;
  pts: Pt[];
  y0: number;
  y1: number;
  /** A sloping crown has a planar roof rather than a horizontal cap. */
  topHeights?: number[];
}
export interface SkylineBuilding {
  sources: number[];
  seed: number;
  crown: 'step' | 'fin' | 'slope' | 'plant';
  visibleRank: number;
  visibility: number;
  center: Pt;
  height: number;
  glass: boolean;
  tint: number;
  finish: string;
}
export interface SkylineBackdrop {
  buckets: SkylineBucket[];
  buildings: SkylineBuilding[];
  parts: RooftopPart[];
  sources: number[];
  triangles: number;
}

export interface SkylineVisibility {
  rank: number;
  score: number;
  sources: number[];
  center: Pt;
  /** Projected exterior wall area in steradians, in the largest Market shot. */
  solidAngle: number;
  height: number;
  seed: number;
}

// Eye positions/yaws from tools/_laneShots.mjs. The first two also sample the Market centre.
export const SKYLINE_MARKET_VIEWS = [
  { x: 104, y: 1.7, z: 0, yaw: 0 },
  { x: 104, y: 1.7, z: 0, yaw: -1.571 },
  { x: 150, y: 1.7, z: 40, yaw: -2.3 },
] as const;

interface Roof {
  source: number;
  prism: MapPrism;
  center: Pt;
  bounds: readonly [number, number, number, number];
  edges: Edge[];
}
interface Edge {
  a: Pt;
  b: Pt;
  length: number;
  dx: number;
  dz: number;
  covered: [number, number][];
}
const emptyGeometry = (): SkylineGeometry => ({
  pos: [],
  nrm: [],
  uv: [],
  col: [],
  detail: [],
  idx: [],
});
const WHITE = new THREE.Color(1, 1, 1);
const ROOF = new THREE.Color('#8b9290');
const PLANT = new THREE.Color('#6e7e83');
const DARK = new THREE.Color('#3d4d55');
const SOLID_DETAIL = [0, 0, 0, 0] as const;
export const SKYLINE_PRIORITY_COUNT = 12;
export const SKYLINE_MARKET_CENTER: Pt = [104, 0];
export const SKYLINE_CROWN_MIN_ANGLE_DEG = 0.4;
const boundsOf = (pts: readonly Pt[]): Roof['bounds'] => [
  Math.min(...pts.map((p) => p[0])),
  Math.min(...pts.map((p) => p[1])),
  Math.max(...pts.map((p) => p[0])),
  Math.max(...pts.map((p) => p[1])),
];

/** Seed comes from the physical footprint, independent of map size and prism enumeration. */
function seedFor(roofs: readonly Roof[]): number {
  const points = roofs.flatMap((r) => r.prism.pts.map((p) => `${p[0]},${p[1]}`)).sort();
  let seed = 2166136261;
  for (const c of `${roofs[0]!.prism.y1}|${points.join(';')}`) {
    seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  }
  return seed;
}

/** Partial reversed seams count too: OSM convex pieces can meet at a T junction. */
function coverSeam(a: Edge, b: Edge): boolean {
  if (a.dx * b.dx + a.dz * b.dz > -0.99999) return false;
  const distance = (p: Pt): number => Math.abs((p[0] - a.a[0]) * a.dz - (p[1] - a.a[1]) * a.dx);
  if (distance(b.a) > 0.025 || distance(b.b) > 0.025) return false;
  const along = (p: Pt): number => (p[0] - a.a[0]) * a.dx + (p[1] - a.a[1]) * a.dz;
  const lo = Math.max(0, along(b.b));
  const hi = Math.min(a.length, along(b.a));
  if (hi - lo < 0.05) return false;
  a.covered.push([lo, hi]);
  const fromB = (s: number): number =>
    (a.a[0] + a.dx * s - b.a[0]) * b.dx + (a.a[1] + a.dz * s - b.a[1]) * b.dz;
  b.covered.push([Math.max(0, fromB(hi)), Math.min(b.length, fromB(lo))]);
  return true;
}

function exposed(edge: Edge): [number, number][] {
  const spans: [number, number][] = [];
  let lo = 0;
  for (const [a, b] of edge.covered.sort(([a], [b]) => a - b)) {
    if (a > lo + 0.05) spans.push([lo, a]);
    lo = Math.max(lo, b);
  }
  if (lo < edge.length - 0.05) spans.push([lo, edge.length]);
  return spans;
}

function roofsFor(map: MapDefinition): Roof[] {
  const playable = rectPoly(map.bounds.minX, map.bounds.minZ, map.bounds.maxX, map.bounds.maxZ);
  return (map.prisms ?? []).flatMap((prism, source) => {
    if (
      !prism.backdrop ||
      prism.visible === false ||
      prism.pts.length < 3 ||
      area(clipConvex(prism.pts, playable)) > 1e-5
    )
      return [];
    return [
      {
        source,
        prism,
        center: centroid(prism.pts),
        bounds: boundsOf(prism.pts),
        edges: prism.pts.map((a, i) => {
          const b = prism.pts[(i + 1) % prism.pts.length]!;
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          return {
            a,
            b,
            length,
            dx: (b[0] - a[0]) / length,
            dz: (b[1] - a[1]) / length,
            covered: [],
          };
        }),
      },
    ];
  });
}

function buildingsFor(inputRoofs: readonly Roof[]): Roof[][] {
  // Near-collinear OSM seams use a tolerance. Always choose the same reference edge even
  // when a map loader enumerates its convex pieces differently.
  const roofs = [...inputRoofs].sort(
    (a, b) =>
      a.bounds[0] - b.bounds[0] ||
      a.bounds[1] - b.bounds[1] ||
      a.bounds[2] - b.bounds[2] ||
      a.bounds[3] - b.bounds[3] ||
      a.prism.y0 - b.prism.y0 ||
      a.prism.y1 - b.prism.y1 ||
      a.prism.mat.localeCompare(b.prism.mat) ||
      (a.prism.tint ?? 0) - (b.prism.tint ?? 0) ||
      a.prism.pts
        .map((p) => p.join(','))
        .sort()
        .join(';')
        .localeCompare(
          b.prism.pts
            .map((p) => p.join(','))
            .sort()
            .join(';'),
        ),
  );
  const parents = roofs.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) i = parents[i]!;
    return i;
  };
  for (let i = 0; i < roofs.length; i++) {
    const a = roofs[i]!;
    for (let j = i + 1; j < roofs.length; j++) {
      const b = roofs[j]!;
      if (
        a.prism.mat !== b.prism.mat ||
        a.prism.tint !== b.prism.tint ||
        a.prism.y0 !== b.prism.y0 ||
        a.prism.y1 !== b.prism.y1 ||
        a.bounds[0] > b.bounds[2] + 0.03 ||
        b.bounds[0] > a.bounds[2] + 0.03 ||
        a.bounds[1] > b.bounds[3] + 0.03 ||
        b.bounds[1] > a.bounds[3] + 0.03
      )
        continue;
      let joined = false;
      for (const e of a.edges) for (const f of b.edges) joined = coverSeam(e, f) || joined;
      if (joined) parents[root(j)] = root(i);
    }
  }
  const groups = new Map<number, Roof[]>();
  roofs.forEach((roof, i) => {
    const k = root(i);
    const group = groups.get(k) ?? [];
    group.push(roof);
    groups.set(k, group);
  });
  return [...groups.values()];
}

/** Exact spherical area of a triangle, rather than footprint area / distance squared. */
function solidTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  return 2 * Math.atan2(Math.abs(a.dot(b.clone().cross(c))), 1 + a.dot(b) + b.dot(c) + c.dot(a));
}

function rankGroups(groups: readonly Roof[][]): SkylineVisibility[] {
  return groups
    .map((group) => {
      const total = group.reduce((sum, roof) => sum + area(roof.prism.pts), 0);
      const center: Pt = [
        group.reduce((sum, r) => sum + r.center[0] * area(r.prism.pts), 0) / total,
        group.reduce((sum, r) => sum + r.center[1] * area(r.prism.pts), 0) / total,
      ];
      const scores = SKYLINE_MARKET_VIEWS.map((eye) => {
        let score = 0;
        for (const roof of group)
          for (const e of roof.edges) {
            // Back-facing and internal convex-decomposition walls have no apparent area.
            if ((eye.x - e.a[0]) * e.dz - (eye.z - e.a[1]) * e.dx <= 0) continue;
            for (const [lo, hi] of exposed(e)) {
              const x = e.a[0] + (e.dx * (lo + hi)) / 2;
              const z = e.a[1] + (e.dz * (lo + hi)) / 2;
              const distance = Math.hypot(x - eye.x, z - eye.z);
              const bearing = Math.atan2(-(x - eye.x), -(z - eye.z));
              const offset = Math.abs(
                Math.atan2(Math.sin(bearing - eye.yaw), Math.cos(bearing - eye.yaw)),
              );
              const halfSpan = Math.atan2((hi - lo) / 2, distance);
              const halfView = (47.5 * Math.PI) / 180;
              if (offset - halfSpan > halfView || distance > 600) continue;
              const weight = Math.min(
                1,
                Math.max(0, (halfView - offset + halfSpan) / Math.max(2 * halfSpan, 1e-6)),
              );
              const ray = (s: number, y: number): THREE.Vector3 =>
                new THREE.Vector3(
                  e.a[0] + e.dx * s - eye.x,
                  y - eye.y,
                  e.a[1] + e.dz * s - eye.z,
                ).normalize();
              const a = ray(lo, roof.prism.y0);
              const b = ray(hi, roof.prism.y0);
              const c = ray(hi, roof.prism.y1);
              const d = ray(lo, roof.prism.y1);
              score += weight * (solidTriangle(a, b, c) + solidTriangle(a, c, d));
            }
          }
        return score;
      });
      const solidAngle = Math.max(...scores);
      return {
        rank: 0,
        score: solidAngle,
        sources: group.map((r) => r.source).sort((a, b) => a - b),
        center,
        solidAngle,
        height: Math.max(...group.map((r) => r.prism.y1 - r.prism.y0)),
        seed: seedFor(group),
      };
    })
    .sort((a, b) => b.solidAngle - a.solidAngle || b.height - a.height || a.seed - b.seed)
    .map((entry, rank) => ({ ...entry, rank }));
}

/** Stable physical ranking, independent of prism enumeration or quality tier. */
export function rankSkylineBuildings(map: MapDefinition): SkylineVisibility[] {
  return rankGroups(buildingsFor(roofsFor(map)));
}

export function skylineVisibilityRanking(map: MapDefinition): SkylineVisibility[] {
  return rankSkylineBuildings(map);
}

function unionBounds(group: readonly Roof[]): Roof['bounds'] {
  return [
    Math.min(...group.map((r) => r.bounds[0])),
    Math.min(...group.map((r) => r.bounds[1])),
    Math.max(...group.map((r) => r.bounds[2])),
    Math.max(...group.map((r) => r.bounds[3])),
  ];
}

function scaled(pts: readonly Pt[], center: Pt, scale: number): Pt[] {
  return pts.map(([x, z]) => [
    center[0] + (x - center[0]) * scale,
    center[1] + (z - center[1]) * scale,
  ]);
}

/** Rectangle sized and oriented on the actual convex roof, shrinking until every corner fits. */
function equipmentFootprint(roof: Roof, width: number, depth: number, offset = 0): Pt[] {
  const edge = roof.edges.reduce((a, b) => (a.length > b.length ? a : b));
  const center = [roof.center[0] + edge.dx * offset, roof.center[1] + edge.dz * offset] as const;
  for (let scale = 1; scale > 0.04; scale *= 0.75) {
    const pts: Pt[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([u, v]) => [
      center[0] + (edge.dx * u! * width * scale) / 2 - (edge.dz * v! * depth * scale) / 2,
      center[1] + (edge.dz * u! * width * scale) / 2 + (edge.dx * v! * depth * scale) / 2,
    ]);
    if (Math.abs(area(clipConvex(pts, roof.prism.pts)) - area(pts)) < 1e-5) return pts;
  }
  return [];
}

function vertex(
  g: SkylineGeometry,
  p: THREE.Vector3,
  normal: THREE.Vector3,
  u: number,
  v: number,
  c: THREE.Color,
  detail: readonly number[] = SOLID_DETAIL,
): number {
  const i = g.pos.length / 3;
  g.pos.push(p.x, p.y, p.z);
  g.nrm.push(normal.x, normal.y, normal.z);
  g.uv.push(u, v);
  g.col.push(c.r, c.g, c.b);
  g.detail.push(...detail);
  return i;
}

function prismGeometry(
  g: SkylineGeometry,
  cap: SkylineGeometry,
  pts: readonly Pt[],
  y0: number,
  y1: number,
  colour: THREE.Color,
  capColour: THREE.Color,
  heights?: readonly number[],
  detail?: readonly number[],
): void {
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-5) continue;
    const normal = new THREE.Vector3((b[1] - a[1]) / len, 0, (a[0] - b[0]) / len);
    const base = g.pos.length / 3;
    vertex(g, new THREE.Vector3(a[0], y0, a[1]), normal, run, y0, colour, detail);
    vertex(g, new THREE.Vector3(b[0], y0, b[1]), normal, run + len, y0, colour, detail);
    const by = heights?.[(i + 1) % pts.length] ?? y1;
    const ay = heights?.[i] ?? y1;
    vertex(g, new THREE.Vector3(b[0], by, b[1]), normal, run + len, by, colour, detail);
    vertex(g, new THREE.Vector3(a[0], ay, a[1]), normal, run, ay, colour, detail);
    g.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    run += len;
  }
  polygonCap(cap, pts, y1, capColour, true, heights);
}

function polygonCap(
  g: SkylineGeometry,
  pts: readonly Pt[],
  y: number,
  c: THREE.Color,
  up: boolean,
  heights?: readonly number[],
): void {
  if (pts.length < 3) return;
  const at = (i: number): THREE.Vector3 =>
    new THREE.Vector3(pts[i]![0], heights?.[i] ?? y, pts[i]![1]);
  const normal = at(2)
    .sub(at(0))
    .cross(at(1).sub(at(0)))
    .normalize()
    .multiplyScalar(up ? 1 : -1);
  const base = g.pos.length / 3;
  pts.forEach(([x, z], i) => vertex(g, at(i), normal, x, -z, c));
  for (let i = 1; i + 1 < pts.length; i++) {
    g.idx.push(base, base + (up ? i + 1 : i), base + (up ? i : i + 1));
  }
}

/** No tiers/LOD: every silhouette is present on Low and stays stable when quality changes. */
export function buildSkylineBackdrop(map: MapDefinition): SkylineBackdrop {
  const roofs = roofsFor(map);
  const groups = buildingsFor(roofs);
  const ranking = rankGroups(groups);
  const priorities = new Map(
    ranking
      .filter((b) => b.solidAngle > 0)
      .slice(0, SKYLINE_PRIORITY_COUNT)
      .map((b, i) => [b.seed, i]),
  );
  const priorityGlassRanks = new Map(
    ranking
      .filter((b) => b.solidAngle > 0)
      .slice(0, SKYLINE_PRIORITY_COUNT)
      .filter((b) => roofs.find((r) => r.source === b.sources[0])!.prism.mat === 'glass')
      .sort(
        (a, b) =>
          Math.atan2(a.center[1], a.center[0] - 104) - Math.atan2(b.center[1], b.center[0] - 104),
      )
      .map((b, i) => [b.seed, i]),
  );
  const crownTypes = ['step', 'slope', 'fin', 'plant'] as const;
  const crownBySeed = new Map(
    ranking
      .filter((b) => b.solidAngle > 0)
      .slice(0, SKYLINE_PRIORITY_COUNT)
      .sort(
        (a, b) =>
          Math.atan2(a.center[1], a.center[0] - 104) - Math.atan2(b.center[1], b.center[0] - 104),
      )
      .map((b, i) => [b.seed, crownTypes[i % crownTypes.length]!]),
  );
  const parts: RooftopPart[] = [];
  const buildings: SkylineBuilding[] = [];
  const buckets = new Map<string, SkylineBucket>();
  const bucket = (mat: MaterialId, finish = 'backdrop'): SkylineGeometry => {
    const key = `${mat}|${finish}`;
    let b = buckets.get(key);
    if (!b) {
      b = { mat, key: finish, geometry: emptyGeometry() };
      buckets.set(key, b);
    }
    return b.geometry;
  };
  let glassTint = WHITE;
  let glassFinish = 'backdrop';
  let glassDetail: readonly number[] = [0, 0, 0, 0];
  const addPart = (
    roof: Roof,
    kind: RooftopPart['kind'],
    pts: Pt[],
    height: number,
    parent: number | null = null,
    glass = false,
    topHeights?: number[],
  ): number | null => {
    if (pts.length < 3 || area(pts) < 0.005) return null;
    const y0 = parent === null ? roof.prism.y1 : parts[parent]!.y1;
    const part: RooftopPart = {
      kind,
      source: roof.source,
      parent,
      pts,
      y0,
      y1: y0 + height,
      ...(topHeights ? { topHeights } : {}),
    };
    const index = parts.length;
    parts.push(part);
    const c =
      kind === 'parapet'
        ? ROOF
        : ['coping', 'mast', 'antenna', 'crane'].includes(kind)
          ? DARK
          : PLANT;
    prismGeometry(
      bucket(glass ? 'glass' : 'concrete', glass ? glassFinish : 'backdrop'),
      bucket('concrete'),
      pts,
      y0,
      part.y1,
      glass ? glassTint : c,
      kind === 'coping' ? DARK : ROOF,
      topHeights,
      glass ? glassDetail : undefined,
    );
    return index;
  };
  const addEquipment = (roof: Roof, parent: number | null, variant: number): void => {
    const support = parent === null ? roof.prism : parts[parent]!;
    const center = centroid(support.pts);
    const radius = Math.min(
      ...support.pts.map((a, i) => {
        const b = support.pts[(i + 1) % support.pts.length]!;
        return (
          Math.abs((center[0] - a[0]) * (b[1] - a[1]) - (center[1] - a[1]) * (b[0] - a[0])) /
          Math.hypot(b[0] - a[0], b[1] - a[1])
        );
      }),
    );
    if (radius < 0.5) return;
    const rectangle = (width: number, depth: number): Pt[] =>
      clipConvex(
        rectPoly(
          center[0] - width / 2,
          center[1] - depth / 2,
          center[0] + width / 2,
          center[1] + depth / 2,
        ),
        support.pts,
      );
    const tall = roof.prism.y1 - roof.prism.y0 > 60;
    if (variant % 4 === 0) {
      const pts = rectangle(0.8, 0.8);
      const mast = addPart(roof, 'mast', pts, tall ? 12 : 4.5, parent);
      if (mast !== null) addPart(roof, 'antenna', scaled(pts, centroid(pts), 0.75), 0.6, mast);
    } else if (variant % 4 === 1) {
      const r = Math.min(2.2, radius * 0.7);
      const pts: Pt[] = Array.from({ length: 6 }, (_, i) => [
        center[0] + Math.cos((i * Math.PI) / 3) * r,
        center[1] + Math.sin((i * Math.PI) / 3) * r,
      ]);
      const tank = addPart(roof, 'tank', pts, tall ? 3.2 : 2.1, parent);
      if (tank !== null) addPart(roof, 'coping', scaled(pts, center, 0.94), 0.25, tank);
    } else if (variant % 4 === 2) {
      // A capped crane mast stub keeps the industrial silhouette without a distant lattice.
      const pts = rectangle(1.6, 1.6);
      const crane = addPart(roof, 'crane', pts, tall ? 8 : 5, parent);
      if (crane !== null) addPart(roof, 'antenna', scaled(pts, centroid(pts), 0.65), 0.7, crane);
    } else {
      addPart(roof, 'hvac', rectangle(3.8, 2.4), tall ? 2.4 : 1.5, parent);
    }
  };
  for (const group of groups) {
    const seed = seedFor(group);
    const main = group.reduce((a, b) => (area(a.prism.pts) > area(b.prism.pts) ? a : b));
    const visibleRank = priorities.get(seed);
    const priority = visibleRank !== undefined;
    const visible = ranking.find((b) => b.seed === seed)!;
    const crown =
      crownBySeed.get(seed) ??
      (main.prism.y1 - main.prism.y0 > 60
        ? (['step', 'fin', 'slope'] as const)[seed % 3]!
        : 'plant');
    const glass = main.prism.mat === 'glass';
    const style = skylineStyle(
      seed,
      glass,
      priority ? (priorityGlassRanks.get(seed) ?? visibleRank) : undefined,
    );
    const tint = new THREE.Color().setHex(style.tint, THREE.SRGBColorSpace);
    glassTint = tint;
    glassFinish = style.finish;
    glassDetail = [style.bay, style.storey, style.roomSeed, style.finish === 'backdrop' ? 1 : 2];
    buildings.push({
      sources: group.map((r) => r.source),
      seed,
      crown,
      visibleRank: visibleRank ?? ranking.indexOf(visible),
      visibility: visible.solidAngle,
      center: visible.center,
      height: main.prism.y1 - main.prism.y0,
      glass,
      ...style,
    });
    for (const roof of group) {
      const p = roof.prism;
      const c = ['glass', 'facade'].includes(p.mat)
        ? tint
        : p.tint === undefined
          ? p.mat === 'concrete'
            ? ROOF
            : WHITE
          : new THREE.Color().setHex(p.tint, THREE.SRGBColorSpace);
      const walls = bucket(p.mat, glass ? style.finish : 'backdrop');
      let run = 0;
      for (const e of roof.edges) {
        skylineWall(
          walls,
          p,
          e.a,
          e.b,
          run,
          exposed(e),
          c,
          priority,
          style.ribbon ? bucket('concrete') : undefined,
          style,
        );
        run += e.length;
      }
      polygonCap(
        bucket(p.top ?? p.mat, !p.top && glass ? style.finish : 'backdrop'),
        p.pts,
        p.y1,
        // The shared texture-free material needs roof albedo, not the old texture multiplier.
        p.top === 'concrete' ? ROOF : p.top ? WHITE : c,
        true,
      );
      if (p.y0 > 0.05) polygonCap(walls, p.pts, p.y0, c, false);
      if (!['glass', 'facade'].includes(p.mat) || p.y1 - p.y0 < 6) continue;
      // Homothetic inset gives mitred, non-overlapping corners even on acute convex pieces.
      const radius = Math.min(
        ...roof.edges.map((e) =>
          Math.abs((roof.center[0] - e.a[0]) * e.dz - (roof.center[1] - e.a[1]) * e.dx),
        ),
      );
      const inset = 1 - Math.min(0.12, 0.42 / Math.max(radius, 0.42));
      for (const e of roof.edges)
        for (const [lo, hi] of exposed(e)) {
          const a: Pt = [e.a[0] + e.dx * lo, e.a[1] + e.dz * lo];
          const b: Pt = [e.a[0] + e.dx * hi, e.a[1] + e.dz * hi];
          const [ia, ib] = scaled([a, b], roof.center, inset);
          const tall = p.y1 - p.y0 > 60;
          const strip = [a, b, ib!, ia!];
          const parapet = addPart(
            roof,
            'parapet',
            strip,
            tall ? 1.3 : p.mat === 'glass' ? 0.85 : 0.65,
          );
          if (tall && parapet !== null) addPart(roof, 'coping', strip, 0.2, parapet);
        }
    }
    if (
      !['glass', 'facade'].includes(main.prism.mat) ||
      main.prism.y1 - main.prism.y0 < 6 ||
      area(main.prism.pts) < 35
    )
      continue;
    const p = main.prism;
    if (priority) {
      const [x0, z0, x1, z1] = unionBounds(group);
      const center: Pt = [(x0 + x1) / 2, (z0 + z1) / 2];
      const distance = Math.hypot(visible.center[0] - 104, visible.center[1]);
      // Solve elevation-angle difference at the actual roof, with a 6 m minimum.
      const readingHeight = Math.max(
        6,
        distance *
          Math.tan(
            Math.atan2(p.y1 - 1.7, distance) + (SKYLINE_CROWN_MIN_ANGLE_DEG * Math.PI) / 180,
          ) -
          (p.y1 - 1.7),
      );
      const footprint = (scaleX: number, scaleZ = scaleX): Pt[] =>
        rectPoly(
          center[0] - ((x1 - x0) * scaleX) / 2,
          center[1] - ((z1 - z0) * scaleZ) / 2,
          center[0] + ((x1 - x0) * scaleX) / 2,
          center[1] + ((z1 - z0) * scaleZ) / 2,
        );
      const crownStart = parts.length;
      // One crown envelope across the OSM pieces, each portion clipped to real roof support.
      for (const roof of group) {
        const scale = crown === 'plant' ? 0.55 : crown === 'step' ? 0.76 : 0.9;
        const envelope = footprint(scale, crown === 'fin' ? 0.12 : scale);
        const pts = clipConvex(envelope, roof.prism.pts);
        if (crown === 'step') {
          const lower = addPart(roof, 'step', pts, 6, null, glass);
          if (lower !== null)
            addPart(roof, 'step', clipConvex(footprint(0.48), pts), 6, lower, glass);
        } else if (crown === 'slope') {
          const height = Math.max(12, readingHeight + 1);
          addPart(
            roof,
            'slope',
            pts,
            height,
            null,
            glass,
            pts.map(
              ([x]) =>
                p.y1 + 3 + ((height - 3) * (x - envelope[0]![0])) / Math.max(1, (x1 - x0) * scale),
            ),
          );
        } else {
          addPart(
            roof,
            crown,
            pts,
            crown === 'fin' ? 22 : Math.max(12, readingHeight + 1),
            null,
            crown === 'fin' && glass,
          );
        }
      }
      // One equipment silhouette per building, mounted on the highest flat crown portion.
      let support: number | null = null;
      for (let i = crownStart; i < parts.length; i++) {
        const part = parts[i]!;
        if (part.kind !== 'step' && part.kind !== 'plant') continue;
        if (
          support === null ||
          part.y1 > parts[support]!.y1 ||
          (part.y1 === parts[support]!.y1 && area(part.pts) > area(parts[support]!.pts))
        )
          support = i;
      }
      if (support !== null)
        addEquipment(
          group.find((roof) => roof.source === parts[support]!.source)!,
          support,
          seed >>> 8,
        );
      continue;
    }
    const tall = p.y1 - p.y0 > 60;
    const width = Math.min(12, Math.sqrt(area(p.pts)) * 0.28);
    let plant: number | null = null;
    if (crown === 'step') {
      const step = addPart(
        main,
        'step',
        scaled(p.pts, main.center, 0.7),
        tall ? 6 : 4.5,
        null,
        true,
      );
      if (step !== null)
        plant = addPart(main, 'step', scaled(p.pts, main.center, 0.42), tall ? 6 : 3.5, step, true);
    } else if (crown === 'slope') {
      const pts = scaled(p.pts, main.center, 0.8);
      const [x0, , x1] = boundsOf(pts);
      addPart(
        main,
        'slope',
        pts,
        tall ? 12 : 8,
        null,
        true,
        pts.map(([x]) => p.y1 + 1.8 + ((tall ? 10.2 : 6.2) * (x - x0)) / Math.max(1, x1 - x0)),
      );
    } else {
      plant = addPart(
        main,
        'plant',
        tall ? scaled(p.pts, main.center, 0.55) : equipmentFootprint(main, width, width * 0.65),
        tall ? 7 : 2.3 + (seed % 3) * 0.4,
      );
      if (crown === 'fin')
        addPart(
          main,
          'fin',
          equipmentFootprint(main, width * 1.8, tall ? 2.4 : 0.8),
          tall ? 22 : 8,
          null,
          true,
        );
    }
    if (plant !== null) addEquipment(main, plant, seed >>> 8);
  }
  const list = [...buckets.values()];
  return {
    buckets: list,
    buildings,
    parts,
    sources: roofs.map((r) => r.source),
    triangles: list.reduce((sum, b) => sum + b.geometry.idx.length / 3, 0),
  };
}
