/**
 * Facade relief: real depth for the walls of 'facade' prisms (the Palace and the OSM blocks)
 * instead of a window grid painted flat on the collision plane. Pure and deterministic (no three,
 * no randomness); `facadeDetail.ts` turns its quads into meshes and picks a level of detail.
 *
 * **Negative relief.** The prism face is the collision plane, and it stays the outermost surface:
 * pilasters, piers, cornice lips and string courses are *flush* with it (offset 0), while the wall
 * field between them, the window reveals and the panes are recessed into the wall (offsets down
 * to `RELIEF_MIN`). Nothing is drawn in front of the plane, so no visual detail ever blocks a shot
 * or a walk that the collision lets through, and silhouettes, corners and roof edges (the cover
 * edges) sit exactly on the collision geometry. Recesses stay within 0.3 m of it.
 *
 * **Grid.** Windows sit on the painted facade texture's grid (materials.ts `FACADE_WINDOW`):
 * bays every `BAY` metres along the wall line, counted from the world origin (so collinear prism
 * pieces continue one rhythm), storeys every `STOREY` metres from y = 0. The painted far LOD
 * therefore shows its windows exactly where the near LOD cuts them: panel rectangles are snapped
 * so that no painted window is ever cut by a panel edge.
 *
 * **Parts** (per face segment; a segment is the LOD unit, ≤ `SEG_BAYS` bays × `SEG_STOREYS`):
 * - `frame` — piers, pilasters, base band, the stepped crown cornice and every step face between
 *   them and the recessed field (level of detail 0 and 1);
 * - `panel` — the recessed window panels: flat with painted windows (LOD 1, facade texture);
 * - `detail` + `glass` — the same panels cut open: reveals, sills, hoods, string courses, panes
 *   (LOD 0);
 * Distant cells reuse `frame` + `panel`: the same structural profile with cheap painted windows.
 * Keeping that profile avoids depth slots and raised seam strips at mixed-LOD boundaries.
 */
import type { MapDefinition, MapPrism } from '@wd/shared';
import {
  EPS,
  K_WALL,
  K_GLASS,
  K_PANEL,
  breaks,
  depthAt,
  relief,
  type Box2,
  type Feature,
  type LocalQuad,
} from './facadeReliefGrid.ts';
import { isPalacePorticoFriezeFace, palacePorticoFriezeFeatures } from './palacePorticoFrieze.ts';
export type { Box2, LocalQuad } from './facadeReliefGrid.ts';

/**
 * Storey height (m): the OSM converter's levels × 3.3 m, and the painted facade texture's tile
 * (materials.ts), which is one storey tall and one window bay wide.
 */
export const STOREY = 3.3;
/**
 * The painted window in a one-storey facade tile (fractions of the tile: u across, v up, 0 = floor
 * line). materials.ts paints it here and the relief cuts its real openings at exactly these
 * spots, so the painted far LOD and the geometric near LOD agree.
 */
export const FACADE_WINDOW = { u0: 0.3, u1: 0.7, v0: 0.28, v1: 0.82 } as const;
/** Window bay width along the wall (m): the facade texture tile is one bay wide. */
export const BAY = STOREY;
/** Window opening within its bay / storey (m from the bay line / storey floor). */
export const WINDOW = {
  s0: FACADE_WINDOW.u0 * BAY,
  s1: FACADE_WINDOW.u1 * BAY,
  y0: FACADE_WINDOW.v0 * STOREY,
  y1: FACADE_WINDOW.v1 * STOREY,
} as const;
/** Relief offsets from the wall plane (m, + = outward). Collision is the plane at 0. */
export const RELIEF_MIN = -0.3;
export const RELIEF_MAX = 0;
/** LOD segments: at most this many bays × storeys (boundaries on bay lines / between storeys). */
export const SEG_BAYS = 6;
export const SEG_STOREYS = 6;
/** Segment boundaries between storeys sit this far above a storey floor (clear of every window). */
const SEG_Y_OFFSET = 0.3;
/** Near-only courses terminate before a vertical LOD border, leaving a shared recessed edge. */
const COURSE_END_CLEARANCE = 0.025;

/** Street-level stone surround outside the unchanged Palace opening, within its keep-out. */
export const PALACE_WINDOW_TRIM = [{ width: 0.1, offset: -0.07 }] as const;
/** Hand-scale mouldings are authored on the street storeys; upper windows retain room shading. */
export const PALACE_WINDOW_TRIM_MAX_Y = 2 * STOREY;

export type FacadeStyleId = 'monumental' | 'block';

interface Step {
  /** Band height (m), listed from the roof line down. */
  h: number;
  /** Offset (≤ 0). */
  o: number;
}

export interface FacadeStyle {
  /** End piers at both face ends (flush): long faces / short faces. */
  pier: number;
  pierShort: number;
  /** Faces at least this long get the full treatment (big piers, heavy crown). */
  longFace: number;
  /** Faces shorter / lower than this stay a plain flush wall. */
  minLen: number;
  minHeight: number;
  /** Base band (flush) on faces standing on the street / on a lower roof. */
  baseGround: number;
  baseUpper: number;
  /** Crown cornice profile from the roof line down (first step is the flush corona). */
  crown: Step[];
  crownShort: Step[];
  /** Recessed wall field and window pane offsets. */
  field: number;
  pane: number;
  /** Sill lip below each window: height, side overhang, how far it stands out of the field. */
  sill: { h: number; ext: number; out: number };
  /** Window hood on top of each opening (height, side overhang, offset). */
  hood: { h: number; ext: number; o: number } | null;
  /** String course per storey: band [y0, y1] above each storey floor, at offset o. */
  course: { y0: number; y1: number; o: number };
  /** Courses run across the whole field (frame) or only through the window panels (detail). */
  courseInFrame: boolean;
  /** Pilasters on the bay lines: minor width/offset, and every `every`-th bay line major. */
  pilaster: { minor: number; minorO: number; major: number; majorO: number; every: number } | null;
}

/**
 * Two styles: the Palace (1950s monumental: strong ribs grouping three window bays,
 * window hoods, a deep stepped crown on every setback) and the surrounding blocks (plaster
 * render: shallow field, string course per storey, a light crown).
 */
export const FACADE_STYLES: Record<FacadeStyleId, FacadeStyle> = {
  monumental: {
    pier: 1.05,
    pierShort: 0.55,
    longFace: 12,
    minLen: 2.4,
    minHeight: 2.5,
    baseGround: 0.6,
    baseUpper: 0.35,
    crown: [
      { h: 0.55, o: 0 }, // corona
      { h: 0.25, o: -0.045 }, // bed moulding
      { h: 0.3, o: -0.1 }, // frieze
      { h: 0.35, o: -0.15 }, // architrave (pilaster capitals stop under it)
    ],
    crownShort: [
      { h: 0.35, o: 0 },
      { h: 0.25, o: -0.06 },
    ],
    field: -0.22,
    pane: -0.3,
    sill: { h: 0.08, ext: 0, out: 0.1 },
    hood: { h: 0.22, ext: 0, o: -0.07 },
    course: { y0: 0.35, y1: 0.55, o: -0.045 },
    courseInFrame: false,
    pilaster: { minor: 0, minorO: -0.22, major: 1.2, majorO: 0, every: 3 },
  },
  block: {
    pier: 0.5,
    pierShort: 0.35,
    longFace: 8,
    minLen: 1.6,
    minHeight: 2.5,
    baseGround: 0.55,
    baseUpper: 0.3,
    // Fits above the top storey's window and its keep-out (0.59 m) when the roof is on a
    // storey line, as OSM heights (levels × 3.3 m) usually are.
    crown: [
      { h: 0.32, o: 0 },
      { h: 0.2, o: -0.025 },
    ],
    crownShort: [{ h: 0.3, o: 0 }],
    field: -0.06,
    pane: -0.25,
    sill: { h: 0.07, ext: 0, out: 0.03 },
    hood: null,
    course: { y0: 0, y1: 0.22, o: 0 },
    courseInFrame: true,
    pilaster: null,
  },
};

/** One exposed wall face of a relief prism (edge `edge` of prism `prism`, CCW → outward). */
export interface FacadeFace {
  prism: number;
  edge: number;
  /** Edge start (x, z), unit direction along the edge, length. */
  ax: number;
  az: number;
  dx: number;
  dz: number;
  len: number;
  y0: number;
  y1: number;
  /** Global along-line coordinate of the edge start (dot(start, dir)): the bay grid's origin. */
  sa: number;
  style: FacadeStyleId;
  tint: number | undefined;
  /**
   * The face continues straight into another exposed face (same line and heights) at its start /
   * end: a seam between convex pieces of one wall, which gets no end pier.
   */
  seam0: boolean;
  seam1: boolean;
  /**
   * Parts of the face with another solid right outside (a lower neighbour's block, a wing against
   * the tower), in face coordinates. They are hidden anyway and stay flush, so where the
   * neighbour's roof or wall meets this face there is no recess slot next to the collision.
   */
  cover: Box2[];
  /** Length of the same-height, collinear seam-connected wall run that contains this face. */
  runLen?: number;
}

/** Walls of these prisms are drawn by the facade relief instead of the flat map mesh. */
export const isReliefPrism = (p: MapPrism): boolean =>
  p.mat === 'facade' && !p.backdrop && p.visible !== false && p.y1 - p.y0 > 0.01;

/** Palace prisms are recognised by their sandstone tint (shared `PALACE_TINT`). */
export const styleOf = (p: MapPrism, palaceTint: number): FacadeStyleId =>
  p.tint === palaceTint ? 'monumental' : 'block';

// ---- exposure ------------------------------------------------------------------------------------

const INDEX_CELL = 32;

/** Visible prisms bucketed by XZ bounding box: "is this point inside some other solid?" */
class PrismIndex {
  private readonly cells = new Map<string, number[]>();
  private readonly boxes: [number, number, number, number][] = [];
  private readonly prisms: readonly MapPrism[];
  constructor(prisms: readonly MapPrism[]) {
    this.prisms = prisms;
    prisms.forEach((p, i) => {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (const [x, z] of p.pts) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      this.boxes.push([x0, z0, x1, z1]);
      if (p.visible === false) return;
      for (let cx = Math.floor(x0 / INDEX_CELL); cx <= Math.floor(x1 / INDEX_CELL); cx++) {
        for (let cz = Math.floor(z0 / INDEX_CELL); cz <= Math.floor(z1 / INDEX_CELL); cz++) {
          const k = `${cx},${cz}`;
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
      }
    });
  }

  /** Visible prisms (other than `self`) whose bounding box overlaps the XZ box. */
  near(x0: number, z0: number, x1: number, z1: number, self: number): number[] {
    const out = new Set<number>();
    for (let cx = Math.floor(x0 / INDEX_CELL); cx <= Math.floor(x1 / INDEX_CELL); cx++) {
      for (let cz = Math.floor(z0 / INDEX_CELL); cz <= Math.floor(z1 / INDEX_CELL); cz++) {
        for (const i of this.cells.get(`${cx},${cz}`) ?? []) {
          const b = this.boxes[i]!;
          if (i !== self && b[0] <= x1 && b[2] >= x0 && b[1] <= z1 && b[3] >= z0) out.add(i);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  prism(i: number): MapPrism {
    return this.prisms[i]!;
  }
}

/**
 * Only discard a wall when the union of neighbour rectangles covers its entire face. Point
 * samples can miss a narrow exposed strip and remove the only visual for a solid collider.
 */
function buried(f: FacadeFace): boolean {
  const xs = breaks([0, f.len, ...f.cover.flatMap((c) => [c.x0, c.x1])]);
  for (let i = 1; i < xs.length; i++) {
    const x = (xs[i - 1]! + xs[i]!) / 2;
    const spans = f.cover.filter((c) => c.x0 <= x && c.x1 >= x).sort((a, b) => a.y0 - b.y0);
    let top = f.y0;
    for (const c of spans) {
      if (c.y0 > top + EPS) return false;
      top = Math.max(top, c.y1);
    }
    if (top < f.y1 - EPS) return false;
  }
  return true;
}

/** How far outside the wall plane a neighbour must reach to count as covering it (m). */
const COVER_PROBE = 0.05;
/** Cover rectangles smaller than this (m) are ignored. */
const COVER_MIN = 0.05;

/**
 * The parts of face `f` that other solids cover from outside: the wall line, moved `COVER_PROBE`
 * out, clipped against every nearby convex prism (Cyrus–Beck), times the prism's height span.
 */
function coverOf(f: FacadeFace, index: PrismIndex): Box2[] {
  const nx = f.dz;
  const nz = -f.dx;
  const ax = f.ax + nx * COVER_PROBE;
  const az = f.az + nz * COVER_PROBE;
  const bx = ax + f.dx * f.len;
  const bz = az + f.dz * f.len;
  const out: Box2[] = [];
  const near = index.near(
    Math.min(ax, bx),
    Math.min(az, bz),
    Math.max(ax, bx),
    Math.max(az, bz),
    f.prism,
  );
  for (const i of near) {
    const p = index.prism(i);
    const y0 = Math.max(p.y0, f.y0);
    const y1 = Math.min(p.y1, f.y1);
    if (y1 - y0 < COVER_MIN) continue;
    let t0 = 0;
    let t1 = f.len;
    const n = p.pts.length;
    for (let e = 0; e < n && t0 < t1; e++) {
      const a = p.pts[e]!;
      const b = p.pts[(e + 1) % n]!;
      // CCW in (x, z): outward normal (dz, -dx); inside ⇔ dot(P - a, n) ≤ 0.
      const ex = b[1] - a[1];
      const ez = -(b[0] - a[0]);
      const num = (ax - a[0]) * ex + (az - a[1]) * ez;
      const den = f.dx * ex + f.dz * ez;
      if (Math.abs(den) < 1e-12) {
        if (num > 0) t1 = -1;
      } else if (den > 0) t1 = Math.min(t1, -num / den);
      else t0 = Math.max(t0, -num / den);
    }
    if (t1 - t0 >= COVER_MIN) out.push({ x0: t0, x1: t1, y0, y1 });
  }
  return out;
}

/** Every exposed wall face of the map's relief prisms, in prism/edge order. */
export function facadeFaces(map: MapDefinition, palaceTint: number): FacadeFace[] {
  const prisms = map.prisms ?? [];
  const index = new PrismIndex(prisms);
  const out: FacadeFace[] = [];
  prisms.forEach((p, pi) => {
    if (!isReliefPrism(p)) return;
    const n = p.pts.length;
    for (let i = 0; i < n; i++) {
      const a = p.pts[i]!;
      const b = p.pts[(i + 1) % n]!;
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const len = Math.hypot(ex, ez);
      if (len < 1e-4) continue; // the flat map mesh skipped these too
      const dx = ex / len;
      const dz = ez / len;
      const f: FacadeFace = {
        prism: pi,
        edge: i,
        ax: a[0],
        az: a[1],
        dx,
        dz,
        len,
        y0: p.y0,
        y1: p.y1,
        sa: a[0] * dx + a[1] * dz,
        style: styleOf(p, palaceTint),
        tint: p.tint,
        seam0: false,
        seam1: false,
        cover: [],
      };
      f.cover = coverOf(f, index);
      if (buried(f)) continue;
      out.push(f);
    }
  });
  // Seams: a face whose end is another face's start on the same line (and the same heights).
  const key = (x: number, z: number, f: FacadeFace): string =>
    `${Math.round(x * 50)},${Math.round(z * 50)},${f.y0},${f.y1}`;
  const starts = new Map<string, FacadeFace[]>();
  for (const f of out) {
    const k = key(f.ax, f.az, f);
    const list = starts.get(k);
    if (list) list.push(f);
    else starts.set(k, [f]);
  }
  for (const f of out) {
    const next = starts.get(key(f.ax + f.dx * f.len, f.az + f.dz * f.len, f)) ?? [];
    for (const g of next) {
      if (g === f || f.dx * g.dx + f.dz * g.dz < 0.9999) continue;
      f.seam1 = true;
      g.seam0 = true;
    }
  }
  const seamKey = (f: FacadeFace): string =>
    `${Math.round(f.dx * 100_000)},${Math.round(f.dz * 100_000)},${Math.round((f.ax * f.dz - f.az * f.dx) * 100_000)},${f.y0},${f.y1},${f.style}`;
  const runs = new Map<string, FacadeFace[]>();
  for (const f of out) {
    const list = runs.get(seamKey(f));
    if (list) list.push(f);
    else runs.set(seamKey(f), [f]);
  }
  for (const list of runs.values()) {
    list.sort((a, b) => a.sa - b.sa);
    let run: FacadeFace[] = [];
    const flush = (a: FacadeFace, b: FacadeFace): boolean =>
      a.seam1 &&
      b.seam0 &&
      Math.abs(a.ax + a.dx * a.len - b.ax) < 0.02 &&
      Math.abs(a.az + a.dz * a.len - b.az) < 0.02;
    const finish = (): void => {
      const len = run.reduce((sum, f) => sum + f.len, 0);
      for (const f of run) f.runLen = len;
    };
    for (const f of list) {
      const last = run.at(-1);
      if (last && !flush(last, f)) {
        finish();
        run = [];
      }
      run.push(f);
    }
    if (run.length > 0) finish();
  }
  return out;
}

// ---- facade composition ----------------------------------------------------------------------------

/** Parts of a face segment (see the module comment). */
export type FacadePart = 'frame' | 'panel' | 'detail' | 'glass';

export interface FaceSegment {
  /** Segment rectangle in face coordinates. */
  box: Box2;
  /** Quads per part. */
  parts: Record<FacadePart, LocalQuad[]>;
}

/** Spans [a, b] (global along-line coordinate or height) that panel edges must not cut. */
function keepOuts(
  lo: number,
  hi: number,
  period: number,
  a: number,
  b: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let n = Math.floor((lo - b) / period); n <= Math.ceil((hi - a) / period); n++) {
    out.push([n * period + a, n * period + b]);
  }
  return out;
}
/** Move v up (dir = 1) or down (-1) until it lies outside every span. */
function snapOut(v: number, spans: readonly [number, number][], dir: 1 | -1): number {
  for (let guard = 0; guard < 4; guard++) {
    const hit = spans.find(([a, b]) => v > a && v < b);
    if (!hit) return v;
    v = dir > 0 ? hit[1] : hit[0];
  }
  return v;
}

/**
 * Keep-out around each window (reveal margins at the sides, the sill below, the hood above):
 * panel edges never cut it, so every window in a panel has its whole surround.
 */
export function keepOut(st: FacadeStyle): Box2 {
  return {
    x0: WINDOW.s0 - 0.16,
    x1: WINDOW.s1 + 0.16,
    y0: WINDOW.y0 - st.sill.h - 0.04,
    y1: WINDOW.y1 + (st.hood ? st.hood.h + 0.1 : 0.06),
  };
}

/**
 * The relief of one face, split into LOD segments. Local coordinates: s ∈ [0, len] from the edge
 * start, y ∈ [y0, y1] (world heights), o ≤ 0 into the wall.
 */
export function faceRelief(f: FacadeFace, palaceTrim = true): FaceSegment[] {
  const st = FACADE_STYLES[f.style];
  const { x0: KS0, x1: KS1, y0: KY0, y1: KY1 } = keepOut(st);
  const L = f.len;
  const Y0 = f.y0;
  const Y1 = f.y1;
  // Segment lines: bay lines every SEG_BAYS bays, and between storeys every SEG_STOREYS storeys,
  // kept ≥ 1 m from the face's ends.
  const segX: number[] = [];
  const period = BAY * SEG_BAYS;
  for (let n = Math.ceil((f.sa + 1) / period); n * period < f.sa + L - 1; n++) {
    segX.push(n * period - f.sa);
  }
  const segY: number[] = [];
  const pY = STOREY * SEG_STOREYS;
  for (let n = Math.ceil((Y0 + 1 - SEG_Y_OFFSET) / pY); n * pY + SEG_Y_OFFSET < Y1 - 1; n++) {
    segY.push(n * pY + SEG_Y_OFFSET);
  }
  const xb = [0, ...segX, L];
  const yb = [Y0, ...segY, Y1];
  const segs: FaceSegment[] = [];
  for (let j = 0; j + 1 < yb.length; j++) {
    for (let i = 0; i + 1 < xb.length; i++) {
      segs.push({
        box: { x0: xb[i]!, x1: xb[i + 1]!, y0: yb[j]!, y1: yb[j + 1]! },
        parts: { frame: [], panel: [], detail: [], glass: [] },
      });
    }
  }
  const segIndex = (q: LocalQuad): FaceSegment => segs[q.seg]!;

  const long = L >= st.longFace;
  const pier = long ? st.pier : st.pierShort;
  const base = Y0 < 0.3 ? st.baseGround : st.baseUpper;
  const crown = long ? st.crown : st.crownShort;
  const crownH = crown.reduce((a, c) => a + c.h, 0);
  const field: Box2 = {
    x0: f.seam0 ? 0.025 : pier,
    x1: f.seam1 ? L - 0.025 : L - pier,
    y0: Y0 + base,
    y1: Y1 - crownH,
  };
  const plain =
    L < st.minLen ||
    Y1 - Y0 < st.minHeight ||
    field.x1 - field.x0 < 0.8 ||
    field.y1 - field.y0 < 0.8;
  const features: Feature[] = [];
  let panel: Box2 | null = null;
  if (!plain) {
    const porticoFrieze = isPalacePorticoFriezeFace(f);
    features.push({ ...field, o: st.field, k: K_WALL });
    // Window panels: snapped so no painted window is cut (and every window keeps its margins).
    const sSpans = keepOuts(f.sa + field.x0, f.sa + field.x1, BAY, KS0, KS1);
    const ySpans = keepOuts(field.y0, field.y1, STOREY, KY0, KY1);
    const p = {
      x0: snapOut(f.sa + field.x0, sSpans, 1) - f.sa,
      x1: snapOut(f.sa + field.x1, sSpans, -1) - f.sa,
      y0: snapOut(field.y0, ySpans, 1),
      y1: snapOut(field.y1, ySpans, -1),
    };
    if (!porticoFrieze && p.x1 - p.x0 > 0.5 && p.y1 - p.y0 > 0.5) {
      panel = p;
      features.push({ ...p, o: st.field, k: K_PANEL });
    }
    // String courses: one band per storey across the field (splits the panels by storey). The
    // Palace's run between its pilasters instead, with the window detail (a band cut into every
    // bay would cost the always-on frame five faces per bay and storey).
    const c = st.course;
    const n0 = Math.ceil((field.y0 - c.y1) / STOREY);
    for (let n = n0; st.courseInFrame && n * STOREY + c.y0 < field.y1; n++) {
      features.push({
        x0: field.x0,
        x1: field.x1,
        y0: n * STOREY + c.y0,
        y1: n * STOREY + c.y1,
        o: c.o,
        k: K_WALL,
      });
    }
    // Pilasters on the bay lines inside the field (clear of its ends).
    if (st.pilaster && !porticoFrieze) {
      const pl = st.pilaster;
      const reach = pl.major / 2;
      const n0 = Math.ceil((f.sa + field.x0 - reach) / BAY);
      for (let n = n0; n * BAY < f.sa + field.x1 + reach; n++) {
        const major = n % pl.every === 0;
        const w = major ? pl.major : pl.minor;
        if (w <= EPS) continue;
        const s = n * BAY - f.sa;
        // Clear of the end piers; across a seam the next face draws the other half.
        if (!f.seam0 && s - w / 2 < field.x0 + 0.3) continue;
        if (!f.seam1 && s + w / 2 > field.x1 - 0.3) continue;
        features.push({
          x0: Math.max(0, s - w / 2),
          x1: Math.min(L, s + w / 2),
          y0: field.y0,
          y1: field.y1,
          o: major ? pl.majorO : pl.minorO,
          k: K_WALL,
        });
      }
    }
    features.push(...palacePorticoFriezeFeatures(f, field));
    // Crown steps below the corona, between the piers.
    let top = Y1;
    for (const c of crown) {
      if (c.o !== 0) {
        features.push({ x0: field.x0, x1: field.x1, y0: top - c.h, y1: top, o: c.o, k: K_WALL });
      }
      top -= c.h;
    }
    // Covered parts stay flush (last: they override everything above).
    for (const c of f.cover) features.push({ ...c, o: 0, k: K_WALL });
  }

  // Neighbours and convex-piece seams can split panels through a window. Trim each remaining
  // painted panel to whole window surrounds; the leftover area stays unpainted wall at the
  // same depth. This also makes the geometric and painted LODs agree beside arbitrary cuts.
  const rawPanels: LocalQuad[] = [];
  const whole: Box2 = { x0: 0, x1: L, y0: Y0, y1: Y1 };
  relief(whole, 0, features, segX, segY, (q) => {
    if (q.axis === 'o' && q.kind === K_PANEL) rawPanels.push(q);
  });
  for (const p of rawPanels) {
    const sSpans = keepOuts(f.sa + p.x0, f.sa + p.x1, BAY, KS0, KS1);
    const ySpans = keepOuts(p.y0, p.y1, STOREY, KY0, KY1);
    const trimmed = {
      x0: snapOut(f.sa + p.x0, sSpans, 1) - f.sa,
      x1: snapOut(f.sa + p.x1, sSpans, -1) - f.sa,
      y0: snapOut(p.y0, ySpans, 1),
      y1: snapOut(p.y1, ySpans, -1),
    };
    features.push({ ...p, o: st.field, k: K_WALL });
    if (trimmed.x1 > trimmed.x0 && trimmed.y1 > trimmed.y0) {
      features.push({ ...trimmed, o: st.field, k: K_PANEL });
    }
  }

  // Frame (and the panel rectangles, per segment).
  const panels: { seg: number; box: Box2 }[] = [];
  // Stretch only the first complete storey on upper tiers. Retain the original texture-grid
  // coordinates on both painted panels and panes, so interiors and LOD windows still agree.
  const accentFloor =
    f.style === 'monumental' && Y0 >= 34 && (f.runLen ?? L) >= 12
      ? Math.ceil(field.y0 / STOREY) * STOREY
      : Infinity;
  const accentCuts = [
    accentFloor,
    accentFloor + WINDOW.y0,
    accentFloor + WINDOW.y1,
    accentFloor + STOREY,
  ];
  const accentY = (y: number): number => {
    if (y <= accentFloor || y >= accentFloor + STOREY) return y;
    const target = [
      accentFloor,
      accentFloor + WINDOW.y0 - 0.15,
      accentFloor + WINDOW.y1 + 0.35,
      accentFloor + STOREY,
    ];
    for (let i = 1; i < accentCuts.length; i++) {
      if (y <= accentCuts[i]!) {
        const t = (y - accentCuts[i - 1]!) / (accentCuts[i]! - accentCuts[i - 1]!);
        return target[i - 1]! + t * (target[i]! - target[i - 1]!);
      }
    }
    return y;
  };
  const accentQuads = (q: LocalQuad): LocalQuad[] => {
    if (q.y1 < accentFloor || q.y0 > accentFloor + STOREY) return [q];
    const cuts =
      q.axis === 'y'
        ? [q.y0, q.y1]
        : breaks([q.y0, q.y1, ...accentCuts.filter((y) => y > q.y0 && y < q.y1)]);
    const out: LocalQuad[] = [];
    for (let i = 1; i < cuts.length; i++) {
      const y0 = cuts[i - 1]!;
      const y1 = cuts[i]!;
      out.push({ ...q, y0: accentY(y0), y1: accentY(y1), uvY0: y0, uvY1: y1 });
    }
    return out;
  };
  relief(whole, 0, features, segX, segY, (q) => {
    if (q.axis === 'o' && q.kind === K_PANEL) {
      panels.push({ seg: q.seg, box: { x0: q.x0, x1: q.x1, y0: q.y0, y1: q.y1 } });
      segIndex(q).parts.panel.push(...accentQuads(q));
    } else segIndex(q).parts.frame.push(q);
  });
  if (!panel) return segs;

  // Detail: each panel rectangle cut open (window reveals, sills, hoods, panes).
  for (const { seg, box } of panels) {
    const feats: Feature[] = [];
    const c = st.course;
    // Most boundaries lie inside a pilaster. Short Palace faces can omit that pilaster;
    // end their near-only course just inside the cell so either neighbouring LOD meets
    // at the shared field depth. The relief tessellator supplies the course end cap.
    const courseBorderX0 = segX.some((x) => Math.abs(x - box.x0) <= EPS);
    const courseBorderX1 = segX.some((x) => Math.abs(x - box.x1) <= EPS);
    const n0 = Math.ceil((box.y0 - c.y1) / STOREY);
    for (let n = n0; !st.courseInFrame && n * STOREY + c.y0 < box.y1; n++) {
      const courseY = n * STOREY + (c.y0 + c.y1) / 2;
      const courseX0 =
        box.x0 +
        (courseBorderX0 && depthAt(features, 0, box.x0 - 0.01, courseY) < c.o
          ? COURSE_END_CLEARANCE
          : 0);
      const courseX1 =
        box.x1 -
        (courseBorderX1 && depthAt(features, 0, box.x1 + 0.01, courseY) < c.o
          ? COURSE_END_CLEARANCE
          : 0);
      feats.push({
        x0: courseX0,
        x1: courseX1,
        y0: n * STOREY + c.y0,
        y1: n * STOREY + c.y1,
        o: c.o,
        k: K_WALL,
      });
    }
    for (
      let m = Math.ceil((f.sa + box.x0 - KS0) / BAY);
      m * BAY + KS1 <= f.sa + box.x1 + EPS;
      m++
    ) {
      const s0 = m * BAY + WINDOW.s0 - f.sa;
      const s1 = m * BAY + WINDOW.s1 - f.sa;
      for (let n = Math.ceil((box.y0 - KY0) / STOREY); n * STOREY + KY1 <= box.y1 + EPS; n++) {
        const y0 = n * STOREY + WINDOW.y0;
        const y1 = n * STOREY + WINDOW.y1;
        if (palaceTrim && f.style === 'monumental' && y1 <= PALACE_WINDOW_TRIM_MAX_Y) {
          for (const trim of PALACE_WINDOW_TRIM) {
            feats.push({
              x0: s0 - trim.width,
              x1: s1 + trim.width,
              y0: y0 - Math.min(trim.width, 0.1),
              y1: y1 + trim.width,
              o: trim.offset,
              k: K_WALL,
            });
          }
        }
        const sill = st.sill;
        feats.push({
          x0: s0 - sill.ext,
          x1: s1 + sill.ext,
          y0: y0 - sill.h,
          y1: y0,
          o: st.field + sill.out,
          k: K_WALL,
        });
        if (st.hood) {
          const h = st.hood;
          feats.push({
            x0: s0 - h.ext,
            x1: s1 + h.ext,
            y0: y1,
            y1: y1 + h.h,
            o: h.o,
            k: K_WALL,
          });
        }
        feats.push({ x0: s0, x1: s1, y0, y1, o: st.pane, k: K_GLASS });
      }
    }
    const target = segs[seg]!.parts;
    relief(
      box,
      st.field,
      feats,
      [],
      [],
      (q) => {
        const out = { ...q, seg };
        if (q.axis === 'o' && q.kind === K_GLASS) target.glass.push(...accentQuads(out));
        else target.detail.push(...accentQuads(out));
      },
      {
        x0: depthAt(features, 0, box.x0 - 0.01, (box.y0 + box.y1) / 2),
        x1: depthAt(features, 0, box.x1 + 0.01, (box.y0 + box.y1) / 2),
        // The frame owns the step into a raised joint or cornice. Sampling the real surround
        // avoids emitting an opposing course underside on that same plane.
        y0: depthAt(features, 0, (box.x0 + box.x1) / 2, box.y0 - 0.01),
        y1: depthAt(features, 0, (box.x0 + box.x1) / 2, box.y1 + 0.01),
      },
    );
  }
  return segs;
}
