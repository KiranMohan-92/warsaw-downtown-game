/**
 * 2D polygon toolkit for maps (XZ plane). Everything the map pipeline builds ends up as *convex*
 * polygons: Rapier convex-hull colliders are solid, fast, and don't snag a sliding capsule on
 * internal triangle edges. Concave OSM footprints (and courtyards) are triangulated, merged back
 * into a few convex pieces, and carved exactly with convex-minus-convex clipping.
 */

/** [x, z] in metres. */
export type Pt = readonly [number, number];
export type Poly = Pt[];

const EPS = 1e-9;

export const cross = (o: Pt, a: Pt, b: Pt): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Signed area (positive = counter-clockwise in a right-handed X-right, Z-up view). */
export function signedArea(p: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    s += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
  }
  return s / 2;
}

export const area = (p: readonly Pt[]): number => Math.abs(signedArea(p));

export function ensureCCW(p: readonly Pt[]): Poly {
  return signedArea(p) < 0 ? [...p].reverse() : [...p];
}

/** Drop the closing duplicate, repeated points, and (near-)collinear points. */
export function cleanRing(ring: readonly Pt[], tol = 0.02): Poly {
  let p: Poly = [];
  for (const q of ring) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > tol) p.push(q);
  }
  if (p.length > 1) {
    const a = p[0]!;
    const b = p[p.length - 1]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol) p.pop();
  }
  // Remove collinear vertices until stable.
  let changed = true;
  while (changed && p.length > 3) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      const prev = p[(i + p.length - 1) % p.length]!;
      const cur = p[i]!;
      const next = p[(i + 1) % p.length]!;
      const len = Math.hypot(next[0] - prev[0], next[1] - prev[1]);
      if (len < EPS || Math.abs(cross(prev, cur, next)) / len < tol) {
        p = p.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return p;
}

/** Douglas–Peucker simplification of a closed ring (keeps shape within `tol` metres). */
export function simplifyRing(ring: readonly Pt[], tol: number): Poly {
  const p = cleanRing(ring);
  if (p.length <= 4 || tol <= 0) return p;
  // Split at the two farthest-apart vertices so the closed ring simplifies symmetrically.
  const ia = 0;
  let ib = 0;
  let best = -1;
  for (let i = 0; i < p.length; i++) {
    const d = Math.hypot(p[i]![0] - p[0]![0], p[i]![1] - p[0]![1]);
    if (d > best) {
      best = d;
      ib = i;
    }
  }
  const dp = (pts: Pt[]): Pt[] => {
    if (pts.length <= 2) return pts;
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let far = 0;
    let idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d =
        len < EPS
          ? Math.hypot(pts[i]![0] - a[0], pts[i]![1] - a[1])
          : Math.abs(cross(a, b, pts[i]!)) / len;
      if (d > far) {
        far = d;
        idx = i;
      }
    }
    if (far <= tol) return [a, b];
    const left = dp(pts.slice(0, idx + 1));
    const right = dp(pts.slice(idx));
    return [...left.slice(0, -1), ...right];
  };
  const first = p.slice(ia, ib + 1);
  const second = [...p.slice(ib), p[ia]!];
  const out = [...dp(first).slice(0, -1), ...dp(second).slice(0, -1)];
  return out.length >= 3 ? cleanRing(out) : p;
}

export function pointInPolygon(pt: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    // The straddle test guarantees b[1] !== a[1], so the division is safe.
    if (
      a[1] > pt[1] !== b[1] > pt[1] &&
      pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function isConvex(p: readonly Pt[]): boolean {
  if (p.length < 3) return false;
  for (let i = 0; i < p.length; i++) {
    if (cross(p[i]!, p[(i + 1) % p.length]!, p[(i + 2) % p.length]!) < -1e-7) return false;
  }
  return true;
}

/** Ear-clipping triangulation of a simple CCW polygon (no holes). */
export function triangulate(poly: readonly Pt[]): Poly[] {
  const p = ensureCCW(poly);
  const idx = p.map((_, i) => i);
  const tris: Poly[] = [];
  const inTri = (q: Pt, a: Pt, b: Pt, c: Pt): boolean =>
    cross(a, b, q) >= -EPS && cross(b, c, q) >= -EPS && cross(c, a, q) >= -EPS;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length]!;
      const i1 = idx[k]!;
      const i2 = idx[(k + 1) % idx.length]!;
      const a = p[i0]!;
      const b = p[i1]!;
      const c = p[i2]!;
      if (cross(a, b, c) <= EPS) continue; // reflex or degenerate
      let ear = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const q = p[j]!;
        // Coincident vertices (bridged holes) don't block an ear.
        if ((q[0] === a[0] && q[1] === a[1]) || (q[0] === c[0] && q[1] === c[1])) continue;
        if (inTri(q, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Numerically stuck (self-touching input): drop the flattest vertex and carry on.
      let worst = 0;
      let worstA = Infinity;
      for (let k = 0; k < idx.length; k++) {
        const a = p[idx[(k + idx.length - 1) % idx.length]!]!;
        const b = p[idx[k]!]!;
        const c = p[idx[(k + 1) % idx.length]!]!;
        const ar = Math.abs(cross(a, b, c));
        if (ar < worstA) {
          worstA = ar;
          worst = k;
        }
      }
      idx.splice(worst, 1);
    }
  }
  if (idx.length === 3) {
    const [a, b, c] = idx.map((i) => p[i]!) as [Pt, Pt, Pt];
    if (cross(a, b, c) > EPS) tris.push([a, b, c]);
  }
  return tris;
}

const key = (q: Pt): string => `${q[0].toFixed(4)},${q[1].toFixed(4)}`;

/**
 * Greedily merge adjacent convex pieces while the union stays convex (Hertel–Mehlhorn-style):
 * a triangulation of an n-gon collapses to a handful of convex pieces.
 */
export function mergeConvex(pieces: readonly Poly[]): Poly[] {
  const out = pieces.map((p) => ensureCCW(p));
  let merged = true;
  while (merged) {
    merged = false;
    // Index edges → owning piece.
    const edges = new Map<string, number>();
    for (let i = 0; i < out.length; i++) {
      const p = out[i]!;
      for (let k = 0; k < p.length; k++) {
        edges.set(`${key(p[k]!)}|${key(p[(k + 1) % p.length]!)}`, i);
      }
    }
    outer: for (let i = 0; i < out.length; i++) {
      const p = out[i]!;
      for (let k = 0; k < p.length; k++) {
        const a = p[k]!;
        const b = p[(k + 1) % p.length]!;
        const j = edges.get(`${key(b)}|${key(a)}`); // the neighbour walks the edge reversed
        if (j === undefined || j === i) continue;
        const q = out[j]!;
        const m = q.findIndex((v) => key(v) === key(b));
        if (m < 0) continue;
        // Union ring: p from b around to a, then q from a around to b (excluding shared edge).
        const ring: Pt[] = [];
        for (let s = 0; s < p.length; s++) ring.push(p[(k + 1 + s) % p.length]!);
        // ring = b ... a (all of p, starting after a)
        for (let s = 2; s < q.length; s++) ring.push(q[(m + s) % q.length]!);
        const clean = cleanRing(ring, 1e-6);
        if (!isConvex(clean)) continue;
        out[i] = clean;
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
}

/**
 * Keep the part of convex polygon `p` on the left of the directed line a→b (inside for a CCW
 * clip polygon). Sutherland–Hodgman against one half-plane.
 */
export function clipHalfPlane(p: readonly Pt[], a: Pt, b: Pt): Poly {
  const out: Pt[] = [];
  for (let i = 0; i < p.length; i++) {
    const cur = p[i]!;
    const nxt = p[(i + 1) % p.length]!;
    const dc = cross(a, b, cur);
    const dn = cross(a, b, nxt);
    if (dc >= 0) out.push(cur);
    if (dc >= 0 !== dn >= 0) {
      const t = dc / (dc - dn);
      out.push([cur[0] + (nxt[0] - cur[0]) * t, cur[1] + (nxt[1] - cur[1]) * t]);
    }
  }
  return out.length >= 3 ? cleanRing(out, 1e-4) : [];
}

/** Intersection of a convex polygon with a convex CCW clip polygon. */
export function clipConvex(p: readonly Pt[], clip: readonly Pt[]): Poly {
  let cur: Poly = [...p];
  const c = ensureCCW(clip);
  for (let i = 0; i < c.length && cur.length >= 3; i++) {
    cur = clipHalfPlane(cur, c[i]!, c[(i + 1) % c.length]!);
  }
  return cur.length >= 3 && area(cur) > 1e-4 ? cur : [];
}

/** Convex `p` minus convex `hole` → convex fragments (exact, no booleans library needed). */
export function subtractConvex(p: readonly Pt[], hole: readonly Pt[]): Poly[] {
  const h = ensureCCW(hole);
  const out: Poly[] = [];
  let rest: Poly = [...p];
  for (let i = 0; i < h.length && rest.length >= 3; i++) {
    const a = h[i]!;
    const b = h[(i + 1) % h.length]!;
    const outside = clipHalfPlane(rest, b, a); // right of a→b = outside the hole
    if (outside.length >= 3 && area(outside) > 1e-4) out.push(outside);
    rest = clipHalfPlane(rest, a, b);
  }
  // `rest` is now p ∩ hole: discarded.
  return out;
}

/** Subtract convex holes from a set of convex pieces. */
export function subtractAll(pieces: readonly Poly[], holes: readonly Poly[]): Poly[] {
  let cur: Poly[] = [...pieces];
  for (const hole of holes) {
    const next: Poly[] = [];
    for (const p of cur) next.push(...subtractConvex(p, hole));
    cur = next;
  }
  return cur;
}

/**
 * Convex decomposition of a (possibly concave) polygon with optional holes. Holes are
 * decomposed too and subtracted piece by piece, then the result is re-merged.
 */
export function convexDecompose(
  outer: readonly Pt[],
  holes: readonly (readonly Pt[])[] = [],
): Poly[] {
  const ring = cleanRing(outer);
  if (ring.length < 3) return [];
  let pieces = isConvex(ensureCCW(ring)) ? [ensureCCW(ring)] : mergeConvex(triangulate(ring));
  for (const hole of holes) {
    const hr = cleanRing(hole);
    if (hr.length < 3) continue;
    const hp = isConvex(ensureCCW(hr)) ? [ensureCCW(hr)] : mergeConvex(triangulate(hr));
    pieces = subtractAll(pieces, hp);
  }
  return holes.length ? mergeConvex(pieces) : pieces;
}

/** Axis-aligned rectangle as a CCW polygon. */
export const rectPoly = (x0: number, z0: number, x1: number, z1: number): Poly => [
  [Math.min(x0, x1), Math.min(z0, z1)],
  [Math.max(x0, x1), Math.min(z0, z1)],
  [Math.max(x0, x1), Math.max(z0, z1)],
  [Math.min(x0, x1), Math.max(z0, z1)],
];

/** Thick segment a→b of width w as a convex quad (roads, rails, paths). */
export function segmentQuad(a: Pt, b: Pt, w: number): Poly {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = (-dz / len) * (w / 2);
  const nz = (dx / len) * (w / 2);
  return ensureCCW([
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
    [a[0] - nx, a[1] - nz],
  ]);
}

export function centroid(p: readonly Pt[]): Pt {
  let cx = 0;
  let cz = 0;
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const f = p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
    cx += (p[j]![0] + p[i]![0]) * f;
    cz += (p[j]![1] + p[i]![1]) * f;
    a += f;
  }
  if (Math.abs(a) < EPS) {
    const n = p.length || 1;
    return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}
