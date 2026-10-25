/** Client-only Palace roof ornaments. Never add these to the shared map or bake layout. */
import { PALACE_TINT, type MapPrism } from '@wd/shared';
import * as THREE from 'three';
import type { FacadeFace } from './facadeRelief.ts';
import { triangulateFacadeBoundary } from './facadeTriangulation.ts';

export interface PalaceStoneGeometry {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
  idx: number[];
}

export interface PalaceCrown {
  face: FacadeFace;
  /** Original faces supporting this continuous roof line (convex decomposition is invisible). */
  sources: FacadeFace[];
  s0: number;
  s1: number;
  pinnacles: number[];
  corner0: boolean;
  corner1: boolean;
  /** Along-coordinate shift per metre of depth at a shared roof corner. */
  miter0?: number;
  miter1?: number;
  /** Shared ends whose neighbour uses the other (tapered/stepped) attic profile. */
  transition0?: boolean;
  transition1?: boolean;
  /** Earlier coplanar bands partition narrow notches where non-incident miters meet. */
  clipBands?: BandBoundary[];
}

type BandBoundary = Pick<PalaceCrown, 'face' | 's0' | 's1' | 'miter0' | 'miter1'>;

type Point = readonly [number, number, number];
const STONE = new THREE.Color().setHex(PALACE_TINT, THREE.SRGBColorSpace);
const CLOCK = new THREE.Color().setHex(0x323936, THREE.SRGBColorSpace);
const empty = (): PalaceStoneGeometry => ({ pos: [], nrm: [], uv: [], col: [], idx: [] });
const EPS = 1e-5;
/** Finials repeat with the three-window pilaster rhythm. */
export const PALACE_ATTIC_PITCH = 9.9;
const PITCH = PALACE_ATTIC_PITCH;
const RUN = 33;
/** Short footprint connectors get a continuous band; ornaments need a full window bay. */
export const PALACE_ATTIC_MIN_RUN = 3.3;
const atticHeight = (y: number): number => (y < 62 ? 1.35 : y <= 188 ? 2.1 : 1.25);

/** Match only the authored final tier; its collision stays a box, its visual becomes a needle. */
export const isPalaceSpire = (p: MapPrism): boolean =>
  p.mat === 'facade' &&
  p.tint === PALACE_TINT &&
  p.y0 === 220 &&
  p.y1 === 237 &&
  p.pts.length === 4 &&
  p.pts.every(([x, z]) => Math.abs(x) === 1.2 && Math.abs(z) === 1.2);

/** Clip the roof boundary itself and test its infinitesimal outward side. A fixed
 * wall-cover probe can jump over arbitrarily thin convex-decomposition slivers.
 */
export function palaceCrownSpans(f: FacadeFace, roofs: readonly MapPrism[]): [number, number][] {
  if (f.style !== 'monumental' || f.y1 < 16 || f.y1 >= 237) return [];
  const covered: [number, number][] = [];
  for (const [pi, p] of roofs.entries()) {
    if (pi === f.prism || p.visible === false || p.y1 < f.y1 - EPS || p.y0 > f.y1 + EPS) continue;
    let lo = 0;
    let hi = f.len;
    for (let i = 0; i < p.pts.length && hi - lo > EPS; i++) {
      const a = p.pts[i]!;
      const b = p.pts[(i + 1) % p.pts.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-12) continue;
      const nx = (b[1] - a[1]) / len;
      const nz = (a[0] - b[0]) / len;
      const distance = (f.ax - a[0]) * nx + (f.az - a[1]) * nz;
      const along = f.dx * nx + f.dz * nz;
      if (Math.abs(along) < 1e-10) {
        // On a coincident boundary this roof covers the edge only when it extends outward.
        const outward = f.dz * nx - f.dx * nz;
        if (distance > 1e-7 || (Math.abs(distance) <= 1e-7 && outward > 0)) hi = -1;
      } else if (along > 0) hi = Math.min(hi, -distance / along);
      else lo = Math.max(lo, -distance / along);
    }
    if (hi - lo > EPS) covered.push([lo, hi]);
  }
  const cuts = [...new Set([0, f.len, ...covered.flat()])].sort((a, b) => a - b);
  return cuts.slice(1).flatMap((hi, i) => {
    const lo = cuts[i]!;
    const s = (lo + hi) / 2;
    return hi - lo > EPS && !covered.some(([a, b]) => a <= s && b >= s)
      ? [[lo, hi] as [number, number]]
      : [];
  });
}

/** Merge collinear convex-piece seams before placing finials, then split into bounded LOD runs. */
export function palaceCrowns(
  faces: readonly FacadeFace[],
  roofs: readonly MapPrism[],
): PalaceCrown[] {
  const lines = new Map<string, { f: FacadeFace; lo: number; hi: number }[]>();
  const key = (v: number): number => Math.round(v * 100_000);
  for (const f of faces) {
    const k = `${f.y1}:${key(f.dx)}:${key(f.dz)}:${key(f.ax * f.dz - f.az * f.dx)}`;
    for (const [lo, hi] of palaceCrownSpans(f, roofs)) {
      const list = lines.get(k) ?? [];
      list.push({ f, lo: f.sa + lo, hi: f.sa + hi });
      lines.set(k, list);
    }
  }
  const crowns: PalaceCrown[] = [];
  for (const spans of lines.values()) {
    spans.sort((a, b) => a.lo - b.lo);
    const merged: { f: FacadeFace; lo: number; hi: number; sources: FacadeFace[] }[] = [];
    for (const s of spans) {
      const last = merged.at(-1);
      if (last && s.lo <= last.hi + EPS) {
        last.hi = Math.max(last.hi, s.hi);
        last.sources.push(s.f);
      } else merged.push({ ...s, sources: [s.f] });
    }
    for (const span of merged) {
      const len = span.hi - span.lo;
      const start = span.lo - span.f.sa;
      const f = {
        ...span.f,
        ax: span.f.ax + span.f.dx * start,
        az: span.f.az + span.f.dz * start,
        sa: span.lo,
        len,
      };
      const inset = Math.min(0.45, len / 2);
      const n = Math.max(1, Math.ceil((len - 2 * inset) / PITCH));
      // Continue the attic across OSM/carve slivers without crowning every tiny junction.
      const pins =
        len < PALACE_ATTIC_MIN_RUN
          ? []
          : Array.from({ length: n + 1 }, (_, i) => inset + ((len - 2 * inset) * i) / n);
      const count = Math.ceil(len / RUN);
      for (let i = 0; i < count; i++) {
        const s0 = (len * i) / count;
        const s1 = (len * (i + 1)) / count;
        crowns.push({
          face: f,
          sources: span.sources,
          s0,
          s1,
          corner0: i === 0,
          corner1: i === count - 1,
          pinnacles: [...new Set(pins.filter((s) => s >= s0 && (s < s1 || i === count - 1)))],
        });
      }
    }
  }
  // Incident bands share the corner bisector at every depth, including non-right angles.
  const endpoint = (f: FacadeFace, s: number): string =>
    `${f.y1}:${key(f.ax + f.dx * s)}:${key(f.az + f.dz * s)}`;
  const starts = new Map(crowns.filter((c) => c.corner0).map((c) => [endpoint(c.face, 0), c.face]));
  const ends = new Map(
    crowns.filter((c) => c.corner1).map((c) => [endpoint(c.face, c.face.len), c.face]),
  );
  const miter = (f: FacadeFace, neighbour: FacadeFace | undefined): number => {
    if (!neighbour) return 0;
    const denominator = f.dx * neighbour.dz - f.dz * neighbour.dx;
    return Math.abs(denominator) < EPS
      ? 0
      : (1 - f.dx * neighbour.dx - f.dz * neighbour.dz) / denominator;
  };
  for (const c of crowns) {
    const neighbour0 = c.corner0 ? ends.get(endpoint(c.face, 0)) : undefined;
    const neighbour1 = c.corner1 ? starts.get(endpoint(c.face, c.face.len)) : undefined;
    c.miter0 = miter(c.face, neighbour0);
    c.miter1 = miter(c.face, neighbour1);
    const short = c.face.len < PALACE_ATTIC_MIN_RUN;
    c.transition0 = !!neighbour0 && neighbour0.len < PALACE_ATTIC_MIN_RUN !== short;
    c.transition1 = !!neighbour1 && neighbour1.len < PALACE_ATTIC_MIN_RUN !== short;
  }
  const priorBands = new Map<number, BandBoundary[]>();
  for (const c of crowns) {
    if (c.face.len < PALACE_ATTIC_MIN_RUN) continue;
    const prior = priorBands.get(c.face.y1) ?? [];
    c.clipBands = [...prior];
    prior.push({ face: c.face, s0: c.s0, s1: c.s1, miter0: c.miter0, miter1: c.miter1 });
    priorBands.set(c.face.y1, prior);
  }
  // Adjacent roof edges describe the same corner twice. Keep one solid pinnacle there.
  const corners: { x: number; z: number; y: number }[] = [];
  for (const c of crowns) {
    c.pinnacles = c.pinnacles.filter((s) => {
      if (!((c.corner0 && s < 0.46) || (c.corner1 && s > c.face.len - 0.46))) return true;
      const [x, y, z] = world(c.face, [s, c.face.y1, -0.42]);
      if (corners.some((p) => p.y === y && Math.hypot(p.x - x, p.z - z) < 0.12)) return false;
      corners.push({ x, y, z });
      return true;
    });
  }
  return crowns;
}

function world(f: FacadeFace, [s, y, o]: Point): Point {
  return [f.ax + f.dx * s + f.dz * o, y, f.az + f.dz * s - f.dx * o];
}

function triangle(
  g: PalaceStoneGeometry,
  f: FacadeFace,
  a: Point,
  b: Point,
  c: Point,
  colour = STONE,
): void {
  const points = [world(f, a), world(f, b), world(f, c)];
  const p = points[0]!;
  const u = points[1]!.map((v, i) => v - p[i]!);
  const v = points[2]!.map((v, i) => v - p[i]!);
  const normal = [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ];
  const length = Math.hypot(...normal);
  if (length < 1e-10) return;
  const base = g.pos.length / 3;
  const ax = Math.abs(normal[0]!);
  const ay = Math.abs(normal[1]!);
  const az = Math.abs(normal[2]!);
  for (let i = 0; i < 3; i++) {
    g.pos.push(...points[i]!);
    g.nrm.push(...normal.map((n) => n / length));
    const p = points[i]!;
    if (ay >= ax && ay >= az) g.uv.push(p[0], p[2]);
    else if (ax >= az) g.uv.push(p[2], p[1]);
    else g.uv.push(p[0], p[1]);
    g.col.push(colour.r, colour.g, colour.b);
  }
  g.idx.push(base, base + 1, base + 2);
}

/** CCW outline in along/up coordinates, extruded into the roof; omit buried bottom faces. */
function extrude(
  g: PalaceStoneGeometry,
  f: FacadeFace,
  outline: readonly (readonly [number, number])[],
  back: number,
  front: number,
  endCaps: readonly [boolean, boolean] = [true, true],
  capCuts: readonly [readonly number[], readonly number[]] = [[], []],
  bottomBack?: number,
  topCap = true,
): void {
  const points = outline.map(([s, y]): [number, number, number] => [s, y, 0]);
  const indices = triangulateFacadeBoundary(points);
  for (let i = 0; i < indices.length; i += 3) {
    const a = outline[indices[i]!]!;
    const b = outline[indices[i + 1]!]!;
    const c = outline[indices[i + 2]!]!;
    triangle(g, f, [...a, front], [...c, front], [...b, front]);
    triangle(g, f, [...a, back], [...b, back], [...c, back]);
  }
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    if (a[1] === b[1] && b[0] > a[0]) {
      if (bottomBack !== undefined) {
        triangle(g, f, [...a, bottomBack], [...a, front], [...b, front]);
        triangle(g, f, [...a, bottomBack], [...b, front], [...b, bottomBack]);
      }
      continue;
    }
    if (!topCap && a[1] === b[1] && b[0] < a[0]) continue;
    if (a[0] === b[0]) {
      if (!(b[1] > a[1] ? endCaps[1] : endCaps[0])) continue;
      const depths = capCuts.map((cuts) =>
        [back, ...cuts.filter((o) => o > back && o < front), front].sort((a, b) => a - b),
      );
      const upward = b[1] > a[1];
      const lo = Math.min(a[1], b[1]);
      const hi = Math.max(a[1], b[1]);
      const cap = [
        ...depths[0]!.map((o): [number, number] => [o, lo]),
        ...[...depths[1]!].reverse().map((o): [number, number] => [o, hi]),
      ];
      const indices = triangulateFacadeBoundary(cap);
      for (let j = 0; j < indices.length; j += 3) {
        const points = indices
          .slice(j, j + 3)
          .map((index): Point => [a[0], cap[index]![1], cap[index]![0]]);
        triangle(g, f, points[0]!, points[upward ? 1 : 2]!, points[upward ? 2 : 1]!);
      }
      continue;
    }
    triangle(g, f, [...a, back], [...a, front], [...b, front]);
    triangle(g, f, [...a, back], [...b, front], [...b, back]);
  }
}

function box(
  g: PalaceStoneGeometry,
  f: FacadeFace,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  back: number,
  front: number,
  endCaps: readonly [boolean, boolean] = [true, true],
  capCuts: readonly [readonly number[], readonly number[]] = [[], []],
  bottomBack?: number,
  topCap = true,
): void {
  extrude(
    g,
    f,
    [
      [s0, y0],
      [s1, y0],
      [s1, y1],
      [s0, y1],
    ],
    back,
    front,
    endCaps,
    capCuts,
    bottomBack,
    topCap,
  );
}

function finial(
  g: PalaceStoneGeometry,
  f: FacadeFace,
  s: number,
  base: number,
  height: number,
  width: number,
): void {
  const o = -0.42;
  const corners: Point[] = [
    [s - width / 2, base, o - width / 2],
    [s + width / 2, base, o - width / 2],
    [s + width / 2, base, o + width / 2],
    [s - width / 2, base, o + width / 2],
  ];
  const tip: Point = [s, base + height, o];
  for (let i = 0; i < 4; i++) triangle(g, f, corners[i]!, corners[(i + 1) % 4]!, tip);
}

type Footprint = readonly [number, number];

/** Convex footprint clipping keeps thin/acute roof connectors from inverting their miters. */
function clipFootprint(
  points: readonly Footprint[],
  distance: (p: Footprint) => number,
): Footprint[] {
  const out: Footprint[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const da = distance(a);
    const db = distance(b);
    if (da >= 0) out.push(a);
    if (da < 0 !== db < 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out.filter((p, i) => {
    const previous = out[(i + out.length - 1) % out.length]!;
    return Math.hypot(p[0] - previous[0], p[1] - previous[1]) > 1e-9;
  });
}

function bandFootprint(c: BandBoundary, back: number, front: number, inset: number): Footprint[] {
  const start = c.s0 + inset;
  const end = c.s1 - inset;
  const m0 = c.miter0 ?? 0;
  const m1 = c.miter1 ?? 0;
  const lo = start + Math.min(0, m0 * back, m0 * front);
  const hi = end + Math.max(0, m1 * back, m1 * front);
  let footprint: Footprint[] = [
    [lo, back],
    [hi, back],
    [hi, front],
    [lo, front],
  ];
  footprint = clipFootprint(footprint, ([s, o]) => s - start - m0 * o);
  return clipFootprint(footprint, ([s, o]) => end + m1 * o - s);
}

const footprintArea = (polygon: readonly Footprint[]): number =>
  Math.abs(
    polygon.reduce((area, p, i) => {
      const q = polygon[(i + 1) % polygon.length]!;
      return area + p[0] * q[1] - p[1] * q[0];
    }, 0),
  ) / 2;

/** Subtract a convex neighbour, retaining disjoint convex pieces for the existing triangulator. */
function subtractFootprint(subject: Footprint[], cutter: Footprint[]): Footprint[][] {
  if (cutter.length < 3 || footprintArea(cutter) < 1e-10) return [subject];
  const pieces: Footprint[][] = [];
  let inside = subject;
  for (let i = 0; i < cutter.length && inside.length >= 3; i++) {
    const a = cutter[i]!;
    const b = cutter[(i + 1) % cutter.length]!;
    const distance = ([s, o]: Footprint): number =>
      (b[0] - a[0]) * (o - a[1]) - (b[1] - a[1]) * (s - a[0]);
    const outside = clipFootprint(inside, (p) => -distance(p));
    if (outside.length >= 3 && footprintArea(outside) > 1e-10) pieces.push(outside);
    inside = clipFootprint(inside, distance);
  }
  return pieces;
}

/** Close only the profile difference on a shared miter plane; covered caps stay omitted. */
function crownTransition(
  g: PalaceStoneGeometry,
  c: PalaceCrown,
  a: Footprint,
  b: Footprint,
  y0: number,
  top: (p: Footprint) => Point,
  start: boolean,
): void {
  const [lo, hi] = a[1] < b[1] ? [a, b] : [b, a];
  const cap: Footprint[] = [
    [lo[1], y0],
    [hi[1], y0],
  ];
  if (top(hi)[1] > y0 + 1e-10) cap.push([hi[1], top(hi)[1]]);
  if (top(lo)[1] > y0 + 1e-10) cap.push([lo[1], top(lo)[1]]);
  if (cap.length < 3) return;
  const y = c.face.y1;
  const band = atticHeight(y) * 0.55;
  // Depth agrees on both sides of the corner bisector, even for non-right angles.
  const neighbour: Footprint[][] =
    c.face.len < PALACE_ATTIC_MIN_RUN
      ? [
          [
            [-0.9, y],
            [0.04, y],
            [0.04, y + 0.18],
            [-0.9, y + 0.18],
          ],
          [
            [-0.65, y + 0.18],
            [-0.08, y + 0.18],
            [-0.08, y + band],
            [-0.65, y + band],
          ],
        ]
      : [
          [
            [-0.65, y],
            [0.04, y],
            [0.04, y + band],
          ],
        ];
  let pieces = [cap];
  for (const profile of neighbour)
    pieces = pieces.flatMap((piece) => subtractFootprint(piece, profile));
  const s = start ? c.s0 : c.s1;
  const miter = (start ? c.miter0 : c.miter1) ?? 0;
  for (const piece of pieces) {
    const indices = triangulateFacadeBoundary(piece);
    const points = piece.map(([o, y]): Point => [s + miter * o, y, o]);
    for (let i = 0; i < indices.length; i += 3)
      triangle(
        g,
        c.face,
        points[indices[i]!]!,
        points[indices[i + (start ? 2 : 1)]!]!,
        points[indices[i + (start ? 1 : 2)]!]!,
      );
  }
}

/** Continuous band with shared, closed corner footprints; no duplicate coplanar top caps. */
function crownBand(
  g: PalaceStoneGeometry,
  c: PalaceCrown,
  y0: number,
  y1: number,
  back: number,
  front: number,
  inset = 0,
  bottomBack?: number,
  taper = false,
): void {
  const f = c.face;
  const start = c.s0 + inset;
  const end = c.s1 - inset;
  const m0 = c.miter0 ?? 0;
  const m1 = c.miter1 ?? 0;
  let pieces = [bandFootprint(c, back, front, inset)];
  // A short concave notch can bring two non-incident bands together. Partition their entire
  // footprints, rather than deleting top faces and leaving an open cornice.
  for (const neighbour of c.clipBands ?? []) {
    const cutter = bandFootprint(neighbour, back, front, inset).map(([s, o]): Footprint => {
      const [x, , z] = world(neighbour.face, [s, 0, o]);
      return [(x - f.ax) * f.dx + (z - f.az) * f.dz, (x - f.ax) * f.dz - (z - f.az) * f.dx];
    });
    if (!cutter.length) continue;
    const sx0 = Math.min(...cutter.map((p) => p[0]));
    const sx1 = Math.max(...cutter.map((p) => p[0]));
    const ox0 = Math.min(...cutter.map((p) => p[1]));
    const ox1 = Math.max(...cutter.map((p) => p[1]));
    pieces = pieces.flatMap((piece) =>
      piece.every(([s]) => s >= sx1 - 1e-8) ||
      piece.every(([s]) => s <= sx0 + 1e-8) ||
      piece.every(([, o]) => o >= ox1 - 1e-8) ||
      piece.every(([, o]) => o <= ox0 + 1e-8)
        ? [piece]
        : subtractFootprint(piece, cutter),
    );
  }
  for (const footprint of pieces) {
    if (footprint.length < 3 || footprintArea(footprint) < 1e-10) continue;
    const top = ([s, o]: Footprint): Point => [
      s,
      taper ? y0 + ((y1 - y0) * (o - back)) / (front - back) : y1,
      o,
    ];
    const bottom = ([s, o]: Footprint): Point => [s, y0, o];
    const indices = triangulateFacadeBoundary(footprint);
    for (let i = 0; i < indices.length; i += 3) {
      triangle(
        g,
        f,
        top(footprint[indices[i]!]!),
        top(footprint[indices[i + 1]!]!),
        top(footprint[indices[i + 2]!]!),
      );
    }
    if (bottomBack !== undefined) {
      const underside = clipFootprint(footprint, ([, o]) => o - bottomBack);
      if (underside.length >= 3) {
        const indices = triangulateFacadeBoundary(underside);
        for (let i = 0; i < indices.length; i += 3) {
          triangle(
            g,
            f,
            bottom(underside[indices[i]!]!),
            bottom(underside[indices[i + 2]!]!),
            bottom(underside[indices[i + 1]!]!),
          );
        }
      }
    }
    for (let i = 0; i < footprint.length; i++) {
      const a = footprint[i]!;
      const b = footprint[(i + 1) % footprint.length]!;
      const atStart = [a, b].every(([s, o]) => Math.abs(s - start - m0 * o) < EPS);
      const atEnd = [a, b].every(([s, o]) => Math.abs(s - end - m1 * o) < EPS);
      if (atStart && inset === 0 && (!c.corner0 || m0 !== 0)) {
        if (c.transition0) crownTransition(g, c, a, b, y0, top, true);
        continue;
      }
      if (atEnd && inset === 0 && (!c.corner1 || m1 !== 0)) {
        if (c.transition1) crownTransition(g, c, a, b, y0, top, false);
        continue;
      }
      triangle(g, f, bottom(a), bottom(b), top(b));
      triangle(g, f, bottom(a), top(b), top(a));
    }
  }
}

/** Low/far keeps the full crenellated outline and all tapered finials; near adds small mouldings. */
export function palaceCrownGeometry(c: PalaceCrown): {
  frame: PalaceStoneGeometry;
  detail: PalaceStoneGeometry;
} {
  const frame = empty();
  const detail = empty();
  const f = c.face;
  const y = f.y1;
  const height = atticHeight(y);
  const band = height * 0.55;
  // A 4 cm cornice overhang seats across the roof edge without sharing the wall's triangles.
  // Continuous bands omit internal run caps, retaining closed ends at real roof corners.
  if (f.len < PALACE_ATTIC_MIN_RUN) {
    // Tiny footprint connectors keep a seated, closed triangular band rather than a full
    // rectangular cornice stack. The front skyline height is identical at every LOD.
    crownBand(frame, c, y, y + band, -0.65, 0.04, 0, 0, true);
    return { frame, detail };
  }
  crownBand(frame, c, y, y + 0.18, -0.9, 0.04, 0, 0);
  crownBand(frame, c, y + 0.18, y + band, -0.65, -0.08);
  // Dovetail merlons, the Polish-Renaissance attic rhythm, remain genuine sky-cutting solids.
  const step = f.len / Math.max(1, Math.ceil(f.len / PITCH));
  for (let centre = step / 2; centre < f.len; centre += step) {
    // Keep a complete merlon in its centre's cell instead of clipping its profile at LOD seams.
    if (centre < c.s0 || centre >= c.s1) continue;
    const lo = centre - 0.85;
    const hi = centre + 0.85;
    const inset = 0.22;
    extrude(
      frame,
      f,
      [
        [lo + inset, y + band],
        [hi - inset, y + band],
        [hi, y + height],
        [lo, y + height],
      ],
      -0.65,
      -0.035,
      [true, true],
      [[], []],
      -0.08,
    );
  }
  for (const s of c.pinnacles) {
    const corner = (c.corner0 && s < 0.46) || (c.corner1 && s > f.len - 0.46);
    const shaftTop = y + height + (corner ? 0.5 : 0.15);
    const w = Math.min(0.65, f.len);
    box(
      frame,
      f,
      s - w / 2,
      s + w / 2,
      y + 0.18,
      shaftTop,
      -0.42 - w / 2,
      -0.42 + w / 2,
      [true, true],
      [[], []],
      undefined,
      false,
    );
    finial(frame, f, s, shaftTop, corner ? 0.85 : 0.6, w);
  }
  // Each near-only moulding closes independently when its neighbor drops to far LOD.
  crownBand(detail, c, y + 0.25, y + 0.37, -0.65, -0.035, 0.01, -0.08);
  return { frame, detail };
}

/** Four geometric dial faces on the authored clock tier: stone rim, dark dial, ticks and hands. */
export function palaceClockGeometry(faces: readonly FacadeFace[]): PalaceStoneGeometry[] {
  return faces
    .filter(
      (f) => f.style === 'monumental' && f.y0 === 165 && f.y1 === 188 && Math.abs(f.len - 20) < EPS,
    )
    .map((f) => {
      const g = empty();
      const s = f.len / 2;
      const y = 177.5;
      const at = (angle: number, r: number, o: number): Point => [
        s + Math.cos(angle) * r,
        y + Math.sin(angle) * r,
        o,
      ];
      for (let i = 0; i < 32; i++) {
        const a = (i * Math.PI) / 16;
        const b = ((i + 1) * Math.PI) / 16;
        triangle(g, f, [s, y, 0.025], at(b, 3.25, 0.025), at(a, 3.25, 0.025), CLOCK);
        triangle(g, f, at(a, 3.25, 0.07), at(b, 3.65, 0.07), at(a, 3.65, 0.07));
        triangle(g, f, at(a, 3.25, 0.07), at(b, 3.25, 0.07), at(b, 3.65, 0.07));
      }
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const da = 0.025;
        triangle(g, f, at(a - da, 2.72, 0.055), at(a + da, 3.03, 0.055), at(a - da, 3.03, 0.055));
        triangle(g, f, at(a - da, 2.72, 0.055), at(a + da, 2.72, 0.055), at(a + da, 3.03, 0.055));
      }
      const hand = (angle: number, length: number, width: number): void => {
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const a: Point = [s - dy * width, y + dx * width, 0.09];
        const b: Point = [s + dy * width, y - dx * width, 0.09];
        const c: Point = [s + dx * length + dy * width, y + dy * length - dx * width, 0.09];
        const d: Point = [s + dx * length - dy * width, y + dy * length + dx * width, 0.09];
        triangle(g, f, a, d, c);
        triangle(g, f, a, c, b);
      };
      hand(Math.PI / 2, 2.5, 0.1);
      hand(Math.PI / 6, 1.8, 0.13);
      return g;
    });
}

/** Tapered 17 m needle, staying within the original final-tier collision volume. */
export function palaceSpireGeometry(faces: readonly FacadeFace[]): PalaceStoneGeometry | null {
  const f = faces.find(
    (f) => f.style === 'monumental' && f.y0 === 220 && f.y1 === 237 && Math.abs(f.len - 2.4) < EPS,
  );
  if (!f) return null;
  const g = empty();
  const corners: Point[] = [
    [0, 220, 0],
    [2.4, 220, 0],
    [2.4, 220, -2.4],
    [0, 220, -2.4],
  ];
  const tip: Point = [1.2, 237, -1.2];
  for (let i = 0; i < 4; i++) triangle(g, f, corners[i]!, tip, corners[(i + 1) % 4]!);
  return g;
}
