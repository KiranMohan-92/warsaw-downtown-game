/** Sub-texel contact shading in B/A of the ground mask, expanded from RG8 to RGBA8. */
export const CONTACT_CORE = 0.08;
export const CONTACT_FEATHER = 0.25;
export const CONTACT_REACH = 0.85;
/** Signed distance range (m), quantised at ~1 cm in B (see the byte layout below). */
export const CONTACT_RANGE = 1.25;

type P2 = readonly [number, number];

export interface ContactGrid {
  width: number;
  height: number;
  minX: number;
  minZ: number;
  texel: number;
}

export function contactBand(distance: number): number {
  const smooth = (a: number, b: number): number => {
    const t = Math.max(0, Math.min(1, (distance - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return 0.8 * (1 - smooth(CONTACT_CORE, CONTACT_FEATHER)) + 0.2 * (1 - smooth(0, CONTACT_REACH));
}

function closestPoint(a: P2, b: P2, x: number, z: number): P2 {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
  return [a[0] + t * dx, a[1] + t * dz];
}

/** Exact signed distance and outward normal to a convex footprint, either winding. */
export function footprintDistance(
  poly: readonly P2[],
  x: number,
  z: number,
): {
  distance: number;
  angle: number;
} {
  let positive = false;
  let negative = false;
  let d2 = Infinity;
  let nearest: P2 = [x, z];
  let edge: P2 = [1, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    positive ||= cross > 0;
    negative ||= cross < 0;
    const q = closestPoint(a, b, x, z);
    const dd = (q[0] - x) ** 2 + (q[1] - z) ** 2;
    if (dd < d2) {
      d2 = dd;
      nearest = q;
      edge = [b[0] - a[0], b[1] - a[1]];
    }
  }
  const sign = positive && negative ? 1 : -1;
  const distance = sign * Math.sqrt(d2);
  const angle =
    d2 > 1e-12
      ? Math.atan2(sign * (z - nearest[1]), sign * (x - nearest[0]))
      : Math.atan2(positive ? -edge[0] : edge[0], positive ? edge[1] : -edge[1]);
  return { distance, angle };
}

/**
 * Distance to the intersection of two half-planes from the signed distances `a`, `b` to their
 * lines and the cosine `c` between their outward normals: one footprint's corner, exact on
 * both edges and round the vertex (and across a thin box: two opposite lines). Inside, the
 * distance to the nearer line (|max|), like a single line's |d|. Mirrored in GLSL.
 */
export function cornerDistance(a: number, b: number, c: number): number {
  if (a <= 0 && b <= 0) return -Math.max(a, b);
  if (a > 0 && b - a * c <= 0) return a;
  if (b > 0 && a - b * c <= 0) return b;
  const s = 1 - c * c;
  if (s < 1e-4) return Math.max(a, b);
  return Math.sqrt(Math.max(0, (a * a + b * b - 2 * a * b * c) / s));
}

/**
 * A stored line: signed distance at the texel centre + outward normal angle. A `vertex` line is
 * anchored on the footprint's point P nearest the texel centre and decodes radially, |X − P|.
 */
interface StoredLine {
  distance: number;
  angle: number;
  vertex: number;
}

/**
 * One footprint as seen from one texel: every representation the encoder may choose from.
 * `exact` is its true signed distance (the reference every choice is scored against).
 */
interface ContactEntry {
  /** Distance from the texel centre to the footprint (nearest first). */
  priority: number;
  exact: (x: number, z: number) => number;
  /** Nearest edge line (polygons) or tangent (discs): exact where the nearest point is on it. */
  line: StoredLine;
  /** Radial line on the nearest point: never reads nearer than the footprint. */
  radial: StoredLine;
  /** The two nearest edges (exact intersection near a corner). */
  pair?: [StoredLine, StoredLine];
  /** A disc's radius (exact circle with `line` as its tangent). */
  circle?: number;
  /**
   * Geometric proofs over the whole texel (rounding aside): `line` / `pair` equal the footprint's
   * distance there. Unproven, they are only lower bounds and may draw spurs, so they are never
   * stored: every stored component is then at least its footprint's distance everywhere in the
   * texel, and so is their minimum: no spur by construction.
   */
  lineExact?: boolean;
  pairExact?: boolean;
}

/** Footprints touching each contact texel (sparse: only texels within reach of one). */
export type ContactField = Map<number, ContactEntry[]>;

export function createContactField(): ContactField {
  return new Map();
}

function addEntry(field: ContactField, k: number, e: ContactEntry): void {
  const list = field.get(k);
  if (list) list.push(e);
  else field.set(k, [e]);
}

/**
 * sin² of the angle between a pair's normals from which byte rounding moves the decoded vertex
 * by at most ~1.4 rounding steps (45°). Sharper corners (an acute wedge's tip) amplify rounding
 * between the probes, so they take the radial line, which never reads nearer.
 */
const WELL_CONDITIONED = 0.5;
/** Largest disc radius stored exactly (m); B quantises it in 1.6 cm steps. */
const CIRCLE_MAX = 4;

function texelRange(
  grid: ContactGrid,
  bounds: readonly [number, number, number, number],
): [number, number, number, number, number] {
  const reach = CONTACT_REACH + grid.texel * Math.SQRT1_2;
  return [
    Math.max(0, Math.floor((bounds[0] - reach - grid.minX) / grid.texel)),
    Math.min(grid.width - 1, Math.floor((bounds[1] + reach - grid.minX) / grid.texel)),
    Math.max(0, Math.floor((bounds[2] - reach - grid.minZ) / grid.texel)),
    Math.min(grid.height - 1, Math.floor((bounds[3] + reach - grid.minZ) / grid.texel)),
    reach,
  ];
}

/** Rasterise only edge bands, rather than the whole area of a large building. */
export function rasterContactPolygon(
  grid: ContactGrid,
  field: ContactField,
  poly: readonly P2[],
): void {
  let area = 0;
  for (let e = 0; e < poly.length; e++) {
    const a = poly[e]!;
    const b = poly[(e + 1) % poly.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  // Outward normal of edge a→b in (x, z): (dz, −dx) for a positive-area winding.
  const out = area >= 0 ? 1 : -1;
  const lines = poly.map((a, e) => {
    const b = poly[(e + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return {
      a,
      b,
      nx: (out * (b[1] - a[1])) / len,
      nz: (out * -(b[0] - a[0])) / len,
      tx: (b[0] - a[0]) / len,
      tz: (b[1] - a[1]) / len,
      len,
    };
  });
  const exact = (x: number, z: number): number => footprintDistance(poly, x, z).distance;
  const done = new Set<number>();
  const seg = new Float64Array(lines.length);
  const signed = new Float64Array(lines.length);
  const h = grid.texel / 2;
  for (const edge of lines) {
    const [i0, i1, j0, j1, reach] = texelRange(grid, [
      Math.min(edge.a[0], edge.b[0]),
      Math.max(edge.a[0], edge.b[0]),
      Math.min(edge.a[1], edge.b[1]),
      Math.max(edge.a[1], edge.b[1]),
    ]);
    for (let j = j0; j <= j1; j++) {
      const z = grid.minZ + (j + 0.5) * grid.texel;
      for (let i = i0; i <= i1; i++) {
        const k = j * grid.width + i;
        if (done.has(k)) continue;
        done.add(k);
        const x = grid.minX + (i + 0.5) * grid.texel;
        let first = 0;
        for (let e = 0; e < lines.length; e++) {
          const l = lines[e]!;
          const q = closestPoint(l.a, l.b, x, z);
          seg[e] = Math.hypot(q[0] - x, q[1] - z);
          signed[e] = l.nx * (x - l.a[0]) + l.nz * (z - l.a[1]);
          if (seg[e]! < seg[first]!) first = e;
        }
        const priority = seg[first]!;
        if (priority > reach) continue;
        let second = -1;
        for (let e = 0; e < lines.length; e++) {
          if (e !== first && (second < 0 || seg[e]! < seg[second]!)) second = e;
        }
        const line = (e: number): StoredLine => ({
          distance: signed[e]!,
          angle: Math.atan2(lines[e]!.nz, lines[e]!.nx),
          vertex: 0,
        });
        const corners = (test: (cx: number, cz: number) => boolean): boolean =>
          test(x - h, z - h) && test(x + h, z - h) && test(x - h, z + h) && test(x + h, z + h);
        const nearest = footprintDistance(poly, x, z);
        const entry: ContactEntry = {
          priority,
          exact,
          line: line(first),
          radial: { distance: nearest.distance, angle: nearest.angle, vertex: 1 },
        };
        // A single edge line is exact wherever the point projects onto its segment.
        const lf = lines[first]!;
        if (
          corners((cx, cz) => {
            const p = (cx - lf.a[0]) * lf.tx + (cz - lf.a[1]) * lf.tz;
            return p >= 0 && p <= lf.len;
          })
        )
          entry.lineExact = true;
        if (second >= 0) {
          entry.pair = [entry.line, line(second)];
          // Adjacent edges A→V→B, well conditioned: exact past A along the first and before B
          // along the second (every other edge's region is excluded).
          const n = lines.length;
          const [p, q] =
            (first + 1) % n === second
              ? [first, second]
              : (second + 1) % n === first
                ? [second, first]
                : [-1, -1];
          const c = lines[first]!.nx * lines[second]!.nx + lines[first]!.nz * lines[second]!.nz;
          if (p >= 0 && 1 - c * c >= WELL_CONDITIONED) {
            const lp = lines[p]!;
            const lq = lines[q]!;
            if (
              corners(
                (cx, cz) =>
                  (cx - lp.a[0]) * lp.tx + (cz - lp.a[1]) * lp.tz >= 0 &&
                  (cx - lq.b[0]) * lq.tx + (cz - lq.b[1]) * lq.tz <= 0,
              )
            )
              entry.pairExact = true;
          }
        }
        addEntry(field, k, entry);
      }
    }
  }
}

/** A round footprint: its tangent at each texel centre and its radius (an exact circle). */
export function rasterContactDisc(
  grid: ContactGrid,
  field: ContactField,
  x: number,
  z: number,
  radius: number,
): void {
  const [i0, i1, j0, j1, reach] = texelRange(grid, [
    x - radius,
    x + radius,
    z - radius,
    z + radius,
  ]);
  const exact = (px: number, pz: number): number => Math.hypot(px - x, pz - z) - radius;
  for (let j = j0; j <= j1; j++) {
    const pz = grid.minZ + (j + 0.5) * grid.texel;
    for (let i = i0; i <= i1; i++) {
      const px = grid.minX + (i + 0.5) * grid.texel;
      const distance = exact(px, pz);
      if (Math.abs(distance) > reach) continue;
      const tangent: StoredLine = { distance, angle: Math.atan2(pz - z, px - x), vertex: 0 };
      const entry: ContactEntry = {
        priority: Math.abs(distance),
        exact,
        line: tangent,
        radial: { ...tangent, vertex: 1 },
      };
      if (radius <= CIRCLE_MAX) {
        entry.circle = radius;
      }
      addEntry(field, j * grid.width + i, entry);
    }
  }
}

// ---- bytes ---------------------------------------------------------------------------------
//
// Per texel, two RGBA8 columns; B = signed distance at the texel centre (255 = none), A:
// - A0 and A1 odd: a disc. Slot 0 = its tangent (A0 = 2 × angle + 1), B1 = radius / CIRCLE_MAX.
// - A0 odd, A1 even: one footprint's two edge lines (2 × angle + flag, 127 steps), intersected.
// - A0 even: one line per footprint (union). Slot 0: A0 = 4 × angle (64 steps) + 2 × vertex;
//   slot 1: A1 = 2 × angle (127 steps) + vertex.

type Bytes = [number, number, number, number];

function distanceByte(distance: number): number {
  return Math.round(255 * (0.5 + 0.5 * Math.max(-1, Math.min(1, distance / CONTACT_RANGE))));
}

function angleSteps(angle: number, steps: number): number {
  return Math.round(steps * ((angle / (Math.PI * 2) + 1) % 1)) % steps;
}

function circleBytes(tangent: StoredLine, radius: number): Bytes {
  return [
    distanceByte(tangent.distance),
    2 * angleSteps(tangent.angle, 127) + 1,
    Math.min(254, Math.round((255 * radius) / CIRCLE_MAX)),
    1,
  ];
}

function pairBytes([a, b]: [StoredLine, StoredLine]): Bytes {
  return [
    distanceByte(a.distance),
    2 * angleSteps(a.angle, 127) + 1,
    distanceByte(b.distance),
    2 * angleSteps(b.angle, 127),
  ];
}

function unionBytes(first: StoredLine, second?: StoredLine): Bytes {
  return [
    distanceByte(first.distance),
    4 * angleSteps(first.angle, 64) + 2 * first.vertex,
    second ? distanceByte(second.distance) : 255,
    second ? 2 * angleSteps(second.angle, 127) + second.vertex : 0,
  ];
}

/** Decoded line: signed distance at the centre + unit normal + radial flag. */
interface Decoded {
  d: number;
  nx: number;
  nz: number;
  vertex: boolean;
}

function decodedLine(b: number, step: number, steps: number, vertex: number): Decoded {
  const angle = (step / steps) * Math.PI * 2;
  return {
    d: ((b / 255) * 2 - 1) * CONTACT_RANGE,
    nx: Math.cos(angle),
    nz: Math.sin(angle),
    vertex: vertex === 1,
  };
}

function singleAt(l: Decoded, dx: number, dz: number): number {
  const along = l.nx * dx + l.nz * dz;
  const d = l.d + along;
  return l.vertex ? Math.hypot(d, dx - l.nx * along, dz - l.nz * along) : Math.abs(d);
}

/** The texel's decoder from its bytes: (dx, dz) from the texel centre → distance. Mirrors GLSL. */
function texelDecoder([b0, a0, b1, a1]: Bytes): (dx: number, dz: number) => number {
  if (b0 === 255) return () => CONTACT_RANGE;
  if (a0 % 2 === 1 && a1 % 2 === 1) {
    // Circle: centre C = texel centre − n (d + r); distance |X − C| − r (|·| inside).
    const t = decodedLine(b0, Math.floor(a0 / 2), 127, 0);
    const r = (b1 / 255) * CIRCLE_MAX;
    const toCentre = t.d + r;
    return (dx, dz) => Math.abs(Math.hypot(dx + t.nx * toCentre, dz + t.nz * toCentre) - r);
  }
  if (a0 % 2 === 1) {
    const p = decodedLine(b0, Math.floor(a0 / 2), 127, 0);
    const q = decodedLine(b1, Math.floor(a1 / 2), 127, 0);
    const c = p.nx * q.nx + p.nz * q.nz;
    return (dx, dz) => cornerDistance(p.d + p.nx * dx + p.nz * dz, q.d + q.nx * dx + q.nz * dz, c);
  }
  const first = decodedLine(b0, Math.floor(a0 / 4), 64, Math.floor(a0 / 2) % 2);
  if (b1 === 255) return (dx, dz) => singleAt(first, dx, dz);
  const second = decodedLine(b1, Math.floor(a1 / 2), 127, a1 % 2);
  return (dx, dz) => Math.min(singleAt(first, dx, dz), singleAt(second, dx, dz));
}

/** A texel's contact distance from its bytes, (dx, dz) from its centre; mirrors GLSL. */
export function decodeContactTexel(
  b0: number,
  a0: number,
  b1: number,
  a1: number,
  dx: number,
  dz: number,
): number {
  return texelDecoder([b0, a0, b1, a1])(dx, dz);
}

/** One slot-1 style line's distance (tests): B, A = 2 × angle + vertex. */
export function decodedContactDistance(
  distanceByte: number,
  angleByte: number,
  dx: number,
  dz: number,
): number {
  if (distanceByte === 255) return CONTACT_RANGE;
  return singleAt(decodedLine(distanceByte, Math.floor(angleByte / 2), 127, angleByte % 2), dx, dz);
}

/** Probe offsets (fractions of a texel) for scoring a texel's candidate encodings. */
const PROBES = [-0.5, -0.25, 0, 0.25, 0.5];
/**
 * Darker than the footprints by more than byte rounding can explain (band units) = a spur: a
 * visible bug. Lighter reads as softer dirt. Spur-free encodings always exist (radial lines are
 * upper bounds), so the encoder never trades one in.
 */
const SPUR_BAND = 0.08;
/** Footprints considered for the texel's two slots (the rest still count in the reference). */
const SLOT_CANDIDATES = 3;

/**
 * Choose the texel's bytes. Every candidate is built only from components that are never nearer
 * than their own footprint anywhere in the texel (exact circles, geometrically proven edge lines
 * and corner pairs, radial lines), so whatever is chosen draws no spur: the minimum of such
 * components is never nearer than the nearest footprint. Among them, each candidate is decoded
 * from its own bytes and the one losing the least dirt against the true distance to all
 * footprints (5 × 5 probes, contact-band units) wins. Two RGBA slots hold at most two lines, a
 * corner pair or a circle, so where more matter at once (two corners, a slab's end) it reads
 * lighter, never darker.
 */
export function encodeContactTexel(
  entries: readonly ContactEntry[] | undefined,
  x: number,
  z: number,
  texel: number,
): Bytes {
  if (!entries?.length) return [255, 0, 255, 0];
  const sorted = [...entries].sort((a, b) => a.priority - b.priority);
  const e0 = sorted[0]!;
  const truth = new Float64Array(PROBES.length * PROBES.length);
  let n = 0;
  for (const fz of PROBES) {
    for (const fx of PROBES) {
      let t = Infinity;
      for (const e of sorted) t = Math.min(t, Math.abs(e.exact(x + fx * texel, z + fz * texel)));
      truth[n++] = contactBand(t);
    }
  }
  // A geometric proof covers the exact lines; byte rounding can still shift a decode (most near
  // the conditioning limit), so every stored choice is also checked on its own bytes.
  const spurFree = (bytes: Bytes): boolean => {
    const decode = texelDecoder(bytes);
    let m = 0;
    for (const fz of PROBES)
      for (const fx of PROBES)
        if (contactBand(decode(fx * texel, fz * texel)) - truth[m++]! > SPUR_BAND) return false;
    return true;
  };
  if (sorted.length === 1) {
    const proven: Bytes[] = [];
    if (e0.circle !== undefined) proven.push(circleBytes(e0.line, e0.circle));
    if (e0.pairExact) proven.push(pairBytes(e0.pair!));
    // A pair of identical lines decodes as that line, at the pair's full angle precision.
    if (e0.lineExact) proven.push(pairBytes([e0.line, e0.line]));
    for (const bytes of proven) if (spurFree(bytes)) return bytes;
  }
  const candidates: Bytes[] = [];
  if (e0.circle !== undefined) candidates.push(circleBytes(e0.line, e0.circle));
  if (e0.pairExact) candidates.push(pairBytes(e0.pair!));
  if (e0.lineExact) candidates.push(pairBytes([e0.line, e0.line]));
  // Only components that never read nearer than their own footprint anywhere in the texel.
  const safe = (e: ContactEntry): StoredLine[] => (e.lineExact ? [e.line, e.radial] : [e.radial]);
  const top = sorted.slice(0, SLOT_CANDIDATES);
  for (const a of top) for (const la of safe(a)) candidates.push(unionBytes(la));
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      for (const la of safe(top[i]!))
        for (const lb of safe(top[j]!)) candidates.push(unionBytes(la, lb));
    }
  }
  let best = candidates[0]!;
  let bestCost = Infinity;
  for (const bytes of candidates) {
    const decode = texelDecoder(bytes);
    // No spur first, then the least missing dirt: any spur costs more than any lighter error.
    let cost = 0;
    let m = 0;
    for (const fz of PROBES) {
      for (const fx of PROBES) {
        const err = contactBand(decode(fx * texel, fz * texel)) - truth[m++]!;
        cost = Math.max(cost, err > SPUR_BAND ? 2 + err : -err);
        if (cost >= bestCost) break;
      }
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = bytes;
    }
  }
  return best;
}
