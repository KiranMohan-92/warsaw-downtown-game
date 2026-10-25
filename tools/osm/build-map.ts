/**
 * OSM → map data for the Plac Defilad block (M2).
 *
 *   node tools/osm/build-map.ts            (Node ≥ 23 runs TypeScript directly)
 *
 * Input:  tools/osm/raw/plac_defilad.json  (Overpass export, git-ignored; see README)
 * Output: packages/shared/src/maps/placDefilad/osm.gen.json  (committed; ODbL — attribution in
 *         ASSETS.md and in-game credits)
 *
 * Frame: metres, origin at the Palace footprint centroid, rotated so the street grid is axis
 * aligned: +X ≈ east along Świętokrzyska, +Z ≈ south along Marszałkowska, Y up.
 * Output is already in engine form (convex prisms, flats, trees) so neither client nor server
 * pays for polygon decomposition at load. No names/brands are carried into the game data.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  area,
  centroid,
  clipConvex,
  convexDecompose,
  pointInPolygon,
  rectPoly,
  segmentQuad,
  simplifyRing,
  subtractAll,
  type Poly,
  type Pt,
} from '../../packages/shared/src/maps/geom.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = resolve(here, 'raw/plac_defilad.json');
const OUT = resolve(here, '../../packages/shared/src/maps/placDefilad/osm.gen.json');

// ---- frame ---------------------------------------------------------------------------------------
const LAT0 = 52.231766195671;
const LON0 = 21.006184837229437;
/** Street-grid rotation (fitted from the four bounding streets and the Palace's edges). */
const ROT_DEG = -19.5;
const R = 6371008.8;
const cosLat = Math.cos((LAT0 * Math.PI) / 180);
const cr = Math.cos((-ROT_DEG * Math.PI) / 180);
const sr = Math.sin((-ROT_DEG * Math.PI) / 180);
const round = (v: number): number => Math.round(v * 100) / 100;
function project(lat: number, lon: number): Pt {
  const x = ((lon - LON0) * cosLat * Math.PI * R) / 180;
  const z = (-(lat - LAT0) * Math.PI * R) / 180;
  return [round(cr * x - sr * z), round(sr * x + cr * z)];
}

// ---- load ----------------------------------------------------------------------------------------
interface El {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}
const raw = JSON.parse(readFileSync(RAW, 'utf8')) as { elements: El[] };
const nodes = new Map<number, Pt>();
const nodeTags = new Map<number, Record<string, string>>();
const ways = new Map<number, El>();
const rels: El[] = [];
for (const e of raw.elements) {
  if (e.type === 'node') {
    nodes.set(e.id, project(e.lat!, e.lon!));
    if (e.tags) nodeTags.set(e.id, e.tags);
  } else if (e.type === 'way') ways.set(e.id, e);
  else rels.push(e);
}
const wayPts = (w: El): Pt[] =>
  (w.nodes ?? []).map((n) => nodes.get(n)).filter((p): p is Pt => !!p);

/** Join way segments into closed rings (multipolygon members are often split). */
function assembleRings(segs: Pt[][]): Poly[] {
  const rings: Poly[] = [];
  const open = segs.map((s) => [...s]);
  const same = (a: Pt, b: Pt): boolean =>
    Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  while (open.length) {
    let cur = open.shift()!;
    let grown = true;
    while (!same(cur[0]!, cur[cur.length - 1]!) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i]!;
        const end = cur[cur.length - 1]!;
        if (same(s[0]!, end)) cur = [...cur, ...s.slice(1)];
        else if (same(s[s.length - 1]!, end)) cur = [...cur, ...[...s].reverse().slice(1)];
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (cur.length >= 4 && same(cur[0]!, cur[cur.length - 1]!)) rings.push(cur);
  }
  return rings;
}

// ---- streets & bounds ------------------------------------------------------------------------------
/** Fit a street's centreline coordinate (X for N–S streets, Z for E–W) near the block. */
function streetAxis(name: string, axis: 0 | 1, near: [number, number]): number {
  const vals: number[] = [];
  for (const w of ways.values()) {
    const t = w.tags ?? {};
    if (t.name !== name || !t.highway) continue;
    for (const p of wayPts(w)) {
      const along = p[axis === 0 ? 1 : 0];
      if (along > near[0] && along < near[1]) vals.push(p[axis]);
    }
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)] ?? NaN;
}
const X_MARSZ = streetAxis('Marszałkowska', 0, [-300, 320]);
const X_PLATER = streetAxis('Emilii Plater', 0, [-300, 320]);
const Z_SWIETO = streetAxis('Świętokrzyska', 1, [-150, 270]);
const Z_JEROZ = streetAxis('Aleje Jerozolimskie', 1, [-150, 270]);
const Z_ZLOTA = streetAxis('Złota', 1, [0, 260]); // pedestrian line through the block (section cut)

/** Carriageway widths (m), both directions, from the real street profiles. */
const WIDTH: Record<string, number> = {
  primary: 22,
  secondary: 20,
  tertiary: 13,
  residential: 7,
  living_street: 6,
  unclassified: 7,
  service: 5,
};
const NAMED_WIDTH: Record<string, number> = {
  Marszałkowska: 34, // dual carriageway + central tram corridor
  'Aleje Jerozolimskie': 36,
  'Emilii Plater': 16,
  Świętokrzyska: 22,
};
const FAR_SIDEWALK = 6;
const half = (n: string): number => NAMED_WIDTH[n]! / 2 + FAR_SIDEWALK;
const bounds = {
  minX: Math.round(X_PLATER - half('Emilii Plater')),
  maxX: Math.round(X_MARSZ + half('Marszałkowska')),
  minZ: Math.round(Z_SWIETO - half('Świętokrzyska')),
  maxZ: Math.round(Z_JEROZ + half('Aleje Jerozolimskie')),
};
const inBounds = (p: Pt, pad = 0): boolean =>
  p[0] >= bounds.minX - pad &&
  p[0] <= bounds.maxX + pad &&
  p[1] >= bounds.minZ - pad &&
  p[1] <= bounds.maxZ + pad;
const BACKDROP_PAD = 260;
const SKYLINE_RADIUS = 1300;
const SKYLINE_MIN_H = 70;

// ---- buildings ---------------------------------------------------------------------------------------
interface Building {
  outer: Poly;
  holes: Poly[];
  h: number;
  minH: number;
  kind: string;
  tags: Record<string, string>;
}
const num = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};
function heightOf(t: Record<string, string>): { h: number; minH: number } {
  const levels = num(t['building:levels']);
  const kind = t.building ?? t['building:part'] ?? 'yes';
  const defaults: Record<string, number> = {
    apartments: 22,
    residential: 18,
    office: 30,
    commercial: 14,
    retail: 6,
    hotel: 40,
    service: 4,
    kiosk: 3,
    roof: 5,
    transportation: 5,
    train_station: 7,
    outbuilding: 4,
    public: 20,
    yes: 12,
  };
  const h = num(t.height) ?? (levels !== undefined ? levels * 3.3 + 1.5 : (defaults[kind] ?? 12));
  const minLevel = num(t['building:min_level']);
  const minH = num(t.min_height) ?? (minLevel !== undefined ? minLevel * 3.3 : 0);
  return { h, minH };
}
const buildings: Building[] = [];
const isUnderground = (t: Record<string, string>): boolean =>
  (num(t.layer) ?? 0) < 0 || t.location === 'underground' || t.building === 'underground';
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (!t.building || isUnderground(t)) continue;
  const ring = wayPts(w);
  if (ring.length < 4) continue;
  buildings.push({ outer: ring, holes: [], ...heightOf(t), kind: t.building, tags: t });
}
let palace: Building | null = null;
for (const r of rels) {
  const t = r.tags ?? {};
  if (!t.building || t.type !== 'multipolygon' || isUnderground(t)) continue;
  const segs = (role: string): Pt[][] =>
    (r.members ?? [])
      .filter((m) => m.type === 'way' && m.role === role)
      .map((m) => ways.get(m.ref))
      .filter((w): w is El => !!w)
      .map(wayPts);
  const outers = assembleRings(segs('outer'));
  const inners = assembleRings(segs('inner'));
  for (const o of outers) {
    const holes = inners.filter((h) => pointInPolygon(h[0]!, o));
    const b: Building = { outer: o, holes, ...heightOf(t), kind: t.building, tags: t };
    if (r.id === 1319250)
      palace = b; // Palace of Culture and Science — authored massing in TS
    else buildings.push(b);
  }
}
if (!palace) throw new Error('Palace relation 1319250 missing from the raw export');

// Building passages (tunnel=building_passage): cut real walk-through routes.
const passages: Poly[] = [];
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (t.tunnel !== 'building_passage') continue;
  const pts = wayPts(w);
  for (let i = 0; i + 1 < pts.length; i++) {
    const q = segmentQuad(pts[i]!, pts[i + 1]!, num(t.width) ?? 4);
    if (inBounds(centroid(q))) passages.push(q);
  }
}

// ---- output assembly -------------------------------------------------------------------------------
interface OutPrism {
  pts: Pt[];
  y0: number;
  y1: number;
  mat: string;
  top?: string;
  tint?: number;
  backdrop?: boolean;
}
interface OutFlat {
  pts: Pt[];
  y: number;
  mat: string;
  layer: number;
}
const prisms: OutPrism[] = [];
const flats: OutFlat[] = [];
const trees: { x: number; z: number; height: number; crown: number; kind: string }[] = [];
const roundPoly = (p: Poly): Pt[] => p.map(([x, z]) => [round(x), round(z)] as Pt);

/** Deterministic hash → [0,1) so re-running the converter gives identical output. */
function hash01(x: number, z: number, salt = 0): number {
  let h = Math.imul((x * 73856093) ^ (z * 19349663) ^ (salt * 83492791), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}
/** Muted plaster/concrete/stone palette for greybox facades (varied, never branded). */
const FACADE_TINTS = [
  0xc9c2b4, 0xb9b3a8, 0xd2c7b0, 0xa8a9a6, 0xbfb6a0, 0x9fa3a6, 0xc4bba9, 0xb0a48f,
];
const tintFor = (c: Pt): number =>
  FACADE_TINTS[Math.floor(hash01(Math.round(c[0]), Math.round(c[1]), 7) * FACADE_TINTS.length)]!;

let skipped = 0;
for (const b of buildings) {
  const c = centroid(b.outer);
  // Playable (colliding) if any part of the footprint is inside the bounds — a facade that
  // straddles the edge must stop players and bullets on the inside.
  const [bx0, bz0, bx1, bz1] = bbox(b.outer);
  const playable =
    bx1 >= bounds.minX && bx0 <= bounds.maxX && bz1 >= bounds.minZ && bz0 <= bounds.maxZ;
  const nearBackdrop = inBounds(c, BACKDROP_PAD);
  const skyline = Math.hypot(c[0], c[1]) < SKYLINE_RADIUS && b.h >= SKYLINE_MIN_H;
  if (!nearBackdrop && !skyline) continue;
  const tol = playable ? 0.25 : nearBackdrop ? 0.8 : 2;
  const outer = simplifyRing(b.outer, tol);
  if (outer.length < 3 || area(outer) < 4) {
    skipped++;
    continue;
  }
  const holes = b.holes.map((h) => simplifyRing(h, tol)).filter((h) => h.length >= 3);
  let pieces = convexDecompose(outer, holes);
  const glassy = b.kind === 'office' || b.kind === 'hotel' || b.h > 60;
  const mat = glassy ? 'glass' : 'facade';
  const tint = glassy ? undefined : tintFor(c);
  // Canopies ("roof"): a slab you can walk under.
  if (b.kind === 'roof') {
    for (const p of pieces) {
      prisms.push({
        pts: roundPoly(p),
        y0: Math.max(2.6, b.h - 0.5),
        y1: Math.max(3.1, b.h),
        mat: 'concrete',
        ...(playable ? {} : { backdrop: true }),
      });
    }
    continue;
  }
  if (playable) {
    const cut = passages.filter((q) => area(clipConvex(q, rectPoly(...bbox(outer)))) > 0.5);
    if (cut.length) {
      const under = pieces.flatMap((p) =>
        cut.map((q) => clipConvex(p, q)).filter((x) => x.length >= 3),
      );
      pieces = subtractAll(pieces, cut);
      for (const p of under) {
        prisms.push({ pts: roundPoly(p), y0: 4.2, y1: round(b.h), mat, tint });
      }
    }
  }
  for (const p of pieces) {
    prisms.push({
      pts: roundPoly(p),
      y0: round(b.minH),
      y1: round(b.h),
      mat,
      top: 'concrete',
      ...(tint !== undefined ? { tint } : {}),
      ...(playable ? {} : { backdrop: true }),
    });
  }
}
function bbox(p: Poly): [number, number, number, number] {
  const xs = p.map((q) => q[0]);
  const zs = p.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

// ---- ground surfaces ---------------------------------------------------------------------------------
const ROAD_PAD = 30; // include road surfaces a little past the bounds (seen over the barriers)
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (!t.highway || t.area === 'yes' || isUnderground(t) || t.tunnel) continue;
  const width: number | undefined = (t.name ? NAMED_WIDTH[t.name] : undefined) ?? WIDTH[t.highway];
  const paved = t.highway === 'pedestrian' || t.highway === 'footway' || t.highway === 'cycleway';
  if (!width && !paved) continue;
  const pts = wayPts(w);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (!inBounds(a, ROAD_PAD) && !inBounds(b, ROAD_PAD)) continue;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.3) continue;
    // Named dual carriageways are drawn once per mapped way: halve their width per way.
    const dual = !!(t.name && NAMED_WIDTH[t.name]) && t.oneway === 'yes';
    const wdt = paved ? (t.highway === 'cycleway' ? 2 : 3) : dual ? width! / 2 : width!;
    // Extend each segment slightly so consecutive quads overlap at joints (no gaps).
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    const ext = Math.min(wdt / 2, 3) / L;
    const a2: Pt = [a[0] - dx * ext, a[1] - dz * ext];
    const b2: Pt = [b[0] + dx * ext, b[1] + dz * ext];
    flats.push({
      pts: roundPoly(segmentQuad(a2, b2, wdt)),
      y: 0,
      mat: paved ? 'paving' : 'asphalt',
      layer: paved ? 2 : 3,
    });
  }
}
// Pedestrian areas / squares → paving; grass, parks, gardens, flowerbeds → grass.
const AREA_MATS: [(t: Record<string, string>) => boolean, string, number][] = [
  [
    (t) => t.highway === 'pedestrian' || t['area:highway'] === 'pedestrian' || t.place === 'square',
    'paving',
    1,
  ],
  [
    (t) =>
      t.landuse === 'grass' ||
      t.leisure === 'park' ||
      t.leisure === 'garden' ||
      t.landuse === 'flowerbed' ||
      t.landuse === 'village_green',
    'grass',
    2,
  ],
];
const areaEls: { rings: Poly[]; holes: Poly[]; tags: Record<string, string> }[] = [];
for (const w of ways.values()) {
  const t = w.tags ?? {};
  const pts = wayPts(w);
  if (
    pts.length >= 4 &&
    pts[0]![0] === pts[pts.length - 1]![0] &&
    pts[0]![1] === pts[pts.length - 1]![1]
  ) {
    areaEls.push({ rings: [pts], holes: [], tags: t });
  }
}
for (const r of rels) {
  const t = r.tags ?? {};
  if (t.type !== 'multipolygon') continue;
  const segs = (role: string): Pt[][] =>
    (r.members ?? [])
      .filter((m) => m.type === 'way' && m.role === role)
      .map((m) => ways.get(m.ref))
      .filter((w): w is El => !!w)
      .map(wayPts);
  areaEls.push({
    rings: assembleRings(segs('outer')),
    holes: assembleRings(segs('inner')),
    tags: t,
  });
}
const parkPolys: Poly[] = [];
for (const a of areaEls) {
  if (isUnderground(a.tags)) continue;
  const rule = AREA_MATS.find(([f]) => f(a.tags));
  if (!rule) continue;
  for (const ring of a.rings) {
    const c = centroid(ring);
    if (!inBounds(c, ROAD_PAD)) continue;
    const outer = simplifyRing(ring, 0.3);
    if (outer.length < 3 || area(outer) < 3) continue;
    const holes = a.holes
      .filter((h) => pointInPolygon(h[0]!, ring))
      .map((h) => simplifyRing(h, 0.3));
    for (const p of convexDecompose(outer, holes)) {
      flats.push({ pts: roundPoly(p), y: 0, mat: rule[1], layer: rule[2] });
    }
    if (rule[1] === 'grass' && (a.tags.leisure === 'park' || area(outer) > 400))
      parkPolys.push(outer);
  }
}

// Tram rails: two rails per track at standard gauge.
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (t.railway !== 'tram' || isUnderground(t) || t.tunnel) continue;
  const pts = wayPts(w);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (!inBounds(a, ROAD_PAD) && !inBounds(b, ROAD_PAD)) continue;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (L < 0.3) continue;
    const nx = (-dz / L) * 0.7175;
    const nz = (dx / L) * 0.7175;
    for (const s of [-1, 1]) {
      flats.push({
        pts: roundPoly(
          segmentQuad([a[0] + nx * s, a[1] + nz * s], [b[0] + nx * s, b[1] + nz * s], 0.08),
        ),
        y: 0,
        mat: 'metal',
        layer: 5,
      });
    }
  }
}

// ---- trees -------------------------------------------------------------------------------------------
const buildingPieces = prisms.filter((p) => !p.backdrop);
const insideBuilding = (x: number, z: number): boolean =>
  buildingPieces.some((p) => p.y0 < 2 && pointInPolygon([x, z], p.pts));
const palaceOuter = simplifyRing(palace.outer, 0.3);
const addTree = (x: number, z: number, salt: number): void => {
  if (!inBounds([x, z])) return;
  if (insideBuilding(x, z) || pointInPolygon([x, z], palaceOuter)) return;
  if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 3)) return;
  const r = hash01(Math.round(x * 10), Math.round(z * 10), salt);
  const conifer = r < 0.12;
  const height = round(conifer ? 9 + r * 40 : 8 + r * 14); // tall trees for concealment
  trees.push({
    x: round(x),
    z: round(z),
    height,
    crown: round(conifer ? 2.2 : 2.6 + r * 2.4),
    kind: conifer ? 'conifer' : 'broadleaf',
  });
};
for (const [id, t] of nodeTags) {
  if (t.natural === 'tree') {
    const p = nodes.get(id)!;
    addTree(p[0], p[1], 1);
  }
}
for (const w of ways.values()) {
  if (w.tags?.natural !== 'tree_row') continue;
  const pts = wayPts(w);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 0; s < L; s += 8)
      addTree(a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L, 2);
  }
}
const mappedTrees = trees.length;
// Parks mapped without individual trees get a seeded scatter (≈ one per 120 m²).
for (const park of parkPolys) {
  const [x0, z0, x1, z1] = bbox(park);
  for (let x = x0; x < x1; x += 11) {
    for (let z = z0; z < z1; z += 11) {
      const jx = x + hash01(Math.round(x), Math.round(z), 3) * 9;
      const jz = z + hash01(Math.round(x), Math.round(z), 4) * 9;
      if (pointInPolygon([jx, jz], park) && hash01(Math.round(jx), Math.round(jz), 5) < 0.85)
        addTree(jx, jz, 6);
    }
  }
}

// ---- soft concealment: bushes and tall grass (Kiran: trees, bushes, tall grass are where players
// and bots hide). Only on real planted ground — never on roads or paving. ---------------------------
const FCELL = 10;
const flatGrid = new Map<string, OutFlat[]>();
for (const f of flats) {
  const xs = f.pts.map((q) => q[0]);
  const zs = f.pts.map((q) => q[1]);
  for (let x = Math.floor(Math.min(...xs) / FCELL); x <= Math.floor(Math.max(...xs) / FCELL); x++) {
    for (
      let z = Math.floor(Math.min(...zs) / FCELL);
      z <= Math.floor(Math.max(...zs) / FCELL);
      z++
    ) {
      const k = `${x},${z}`;
      const list = flatGrid.get(k) ?? [];
      list.push(f);
      flatGrid.set(k, list);
    }
  }
}
/** Ground type at a point: the top-most flat covering it ('grass', 'paving', 'asphalt') or 'bare'. */
function groundAt(x: number, z: number): string {
  let best: OutFlat | null = null;
  for (const f of flatGrid.get(`${Math.floor(x / FCELL)},${Math.floor(z / FCELL)}`) ?? []) {
    if ((!best || f.layer > best.layer) && pointInPolygon([x, z], f.pts)) best = f;
  }
  return best ? best.mat : 'bare';
}
const foliage: { x: number; z: number; r: number; h: number; kind: 'bush' | 'grass' }[] = [];
const plantable = (x: number, z: number, margin = 2): boolean =>
  inBounds([x, z]) &&
  x > bounds.minX + margin &&
  x < bounds.maxX - margin &&
  !insideBuilding(x, z) &&
  !pointInPolygon([x, z], palaceOuter);
const addBush = (x: number, z: number, salt: number): void => {
  if (!plantable(x, z) || groundAt(x, z) === 'asphalt' || groundAt(x, z) === 'paving') return;
  const r = hash01(Math.round(x * 10), Math.round(z * 10), salt);
  foliage.push({
    x: round(x),
    z: round(z),
    r: round(1.1 + r * 1.1),
    h: round(1.3 + r * 0.8),
    kind: 'bush',
  });
};
// Shrubs at the foot of about half the trees.
for (const t of trees) {
  const r = hash01(Math.round(t.x * 10), Math.round(t.z * 10), 21);
  if (r > 0.5) continue;
  const n = 1 + Math.floor(r * 6); // 1..3
  for (let k = 0; k < n; k++) {
    const a = hash01(Math.round(t.x * 10), k, 22) * Math.PI * 2;
    const d = 2.2 + hash01(Math.round(t.z * 10), k, 23) * 2;
    addBush(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 24 + k);
  }
}
// Shrub clumps through the parks.
for (const park of parkPolys) {
  const [x0, z0, x1, z1] = bbox(park);
  for (let x = x0; x < x1; x += 9) {
    for (let z = z0; z < z1; z += 9) {
      const jx = x + hash01(Math.round(x), Math.round(z), 31) * 7;
      const jz = z + hash01(Math.round(x), Math.round(z), 32) * 7;
      if (pointInPolygon([jx, jz], park) && hash01(Math.round(jx), Math.round(jz), 33) < 0.3)
        addBush(jx, jz, 34);
    }
  }
}
// Tall grass patches in the lawns (hide a crouched player; a standing one shows).
for (const f of flats) {
  if (f.mat !== 'grass') continue;
  const [x0, z0, x1, z1] = bbox(f.pts);
  for (let x = x0 + 1; x < x1 - 1; x += 5) {
    for (let z = z0 + 1; z < z1 - 1; z += 5) {
      const jx = x + hash01(Math.round(x * 3), Math.round(z * 3), 41) * 3;
      const jz = z + hash01(Math.round(x * 3), Math.round(z * 3), 42) * 3;
      if (hash01(Math.round(jx * 3), Math.round(jz * 3), 43) > 0.28) continue;
      if (!pointInPolygon([jx, jz], f.pts) || !plantable(jx, jz) || groundAt(jx, jz) !== 'grass')
        continue;
      if (foliage.some((o) => Math.abs(o.x - jx) < 2.5 && Math.abs(o.z - jz) < 2.5)) continue;
      const r = hash01(Math.round(jx * 10), Math.round(jz * 10), 44);
      foliage.push({
        x: round(jx),
        z: round(jz),
        r: round(1.6 + r * 1.2),
        h: round(1.0 + r * 0.3),
        kind: 'grass',
      });
    }
  }
}

// ---- points of interest for the authored layer -----------------------------------------------------
const subwayEntrances: Pt[] = [];
for (const [id, t] of nodeTags) {
  if (t.railway === 'subway_entrance' || (t.entrance && t.railway)) {
    const p = nodes.get(id)!;
    if (inBounds(p, 10)) subwayEntrances.push(p);
  }
}

// ---- write ---------------------------------------------------------------------------------------------
const out = {
  generated: 'tools/osm/build-map.ts — do not edit by hand',
  attribution: 'Map data © OpenStreetMap contributors (ODbL 1.0)',
  frame: { lat0: LAT0, lon0: LON0, rotationDeg: ROT_DEG },
  streets: {
    marszalkowskaX: round(X_MARSZ),
    platerX: round(X_PLATER),
    swietokrzyskaZ: round(Z_SWIETO),
    jerozolimskieZ: round(Z_JEROZ),
    zlotaZ: round(Z_ZLOTA),
    widths: NAMED_WIDTH,
  },
  bounds,
  palace: {
    outer: roundPoly(simplifyRing(palace.outer, 0.3)),
    holes: palace.holes.map((h) => roundPoly(simplifyRing(h, 0.3))),
  },
  prisms,
  flats,
  trees,
  foliage,
  subwayEntrances: subwayEntrances.map(roundPoly1),
};
function roundPoly1(p: Pt): Pt {
  return [round(p[0]), round(p[1])];
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const playablePrisms = prisms.filter((p) => !p.backdrop).length;
console.log(
  [
    `streets: Marszałkowska x=${X_MARSZ.toFixed(1)}, Plater x=${X_PLATER.toFixed(1)}, Świętokrzyska z=${Z_SWIETO.toFixed(1)}, Jerozolimskie z=${Z_JEROZ.toFixed(1)}, Złota z=${Z_ZLOTA.toFixed(1)}`,
    `bounds: x ${bounds.minX}..${bounds.maxX} (${bounds.maxX - bounds.minX} m), z ${bounds.minZ}..${bounds.maxZ} (${bounds.maxZ - bounds.minZ} m)`,
    `prisms: ${prisms.length} (${playablePrisms} playable, ${prisms.length - playablePrisms} backdrop/skyline), skipped ${skipped}`,
    `flats: ${flats.length}, trees: ${trees.length} (${mappedTrees} mapped), passages: ${passages.length}, subway entrances: ${subwayEntrances.length}`,
    `foliage: ${foliage.filter((f) => f.kind === 'bush').length} bushes, ${foliage.filter((f) => f.kind === 'grass').length} tall-grass patches`,
    `palace: ${palace.outer.length} pts, ${palace.holes.length} courtyards`,
    `→ ${OUT} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`,
  ].join('\n'),
);
