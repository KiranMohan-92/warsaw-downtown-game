/** Deterministic rectangular relief tessellator; merges coplanar fronts and closes depth steps. */
/** Cell kinds: 0 = wall (frame/detail), 1 = pane (glass), 2 = panel (LOD-switched window panel). */
export const K_WALL = 0;
export const K_GLASS = 1;
export const K_PANEL = 2;

export interface Box2 {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export interface Feature extends Box2 {
  o: number;
  k: number;
}

/**
 * One emitted quad in face-local coordinates: s along the wall (from the edge start), y up, o out
 * of the wall plane. `axis` is the quad's normal axis: 'o' = a front (x0..x1 × y0..y1 at depth
 * o0 = o1, facing out), 's' = a vertical step face at s = x0 (y0..y1 × o0..o1, facing sign·s),
 * 'y' = a horizontal step face at y = y0 (x0..x1 × o0..o1, facing sign·y).
 */
export interface LocalQuad {
  axis: 'o' | 's' | 'y';
  sign: 1 | -1;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  o0: number;
  o1: number;
  /** K_WALL / K_GLASS / K_PANEL. */
  kind: number;
  /** Segment index within the face. */
  seg: number;
  /** Original grid height for stretched Palace accents; shared by painted and pane LODs. */
  uvY0?: number;
  uvY1?: number;
}

export const EPS = 1e-6;

/** Surround offsets on each side of a relief region (null = no border step faces there). */
export interface Sides {
  x0: number | null;
  x1: number | null;
  y0: number | null;
  y1: number | null;
}

/** Offset at (x, y) after painting `features` over `base` (the last feature covering it wins). */
export function depthAt(features: readonly Feature[], base: number, x: number, y: number): number {
  let o = base;
  for (const f of features) if (x > f.x0 && x < f.x1 && y > f.y0 && y < f.y1) o = f.o;
  return o;
}

/** Sorted unique values (merging values closer than 1e-6). */
export function breaks(values: number[]): number[] {
  values.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of values) if (!out.length || v - out[out.length - 1]! > EPS) out.push(v);
  return out;
}
/** Index of the break equal (within EPS) to v. */
function at(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < v - EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Relief over `region`: cells start at offset `base` (kind K_WALL) and features paint over them in
 * order. Emits merged fronts (greedy rectangles of equal offset, kind and segment), the step
 * faces between neighbouring cells of different offset (each facing the deeper cell, owned by the
 * deeper cell's segment), and, where `outside` gives the surround's offset on a side of the
 * region, step faces along that border for cells standing out of it (null = nothing there).
 */
export function relief(
  region: Box2,
  base: number,
  features: readonly Feature[],
  segX: readonly number[],
  segY: readonly number[],
  emit: (q: LocalQuad) => void,
  outside: Sides | null = null,
): void {
  const clipped: Feature[] = [];
  for (const f of features) {
    const c = {
      x0: Math.max(f.x0, region.x0),
      x1: Math.min(f.x1, region.x1),
      y0: Math.max(f.y0, region.y0),
      y1: Math.min(f.y1, region.y1),
      o: f.o,
      k: f.k,
    };
    if (c.x1 - c.x0 > EPS && c.y1 - c.y0 > EPS) clipped.push(c);
  }
  const inX = (v: number): boolean => v > region.x0 + EPS && v < region.x1 - EPS;
  const inY = (v: number): boolean => v > region.y0 + EPS && v < region.y1 - EPS;
  const xs = breaks([
    region.x0,
    region.x1,
    ...clipped.flatMap((f) => [f.x0, f.x1]),
    ...segX.filter(inX),
  ]);
  const ys = breaks([
    region.y0,
    region.y1,
    ...clipped.flatMap((f) => [f.y0, f.y1]),
    ...segY.filter(inY),
  ]);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const o = new Float64Array(nx * ny).fill(base);
  const k = new Uint8Array(nx * ny).fill(K_WALL);
  for (const f of clipped) {
    const i0 = at(xs, f.x0);
    const i1 = at(xs, f.x1);
    const j0 = at(ys, f.y0);
    const j1 = at(ys, f.y1);
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        o[j * nx + i] = f.o;
        k[j * nx + i] = f.k;
      }
    }
  }
  // Segment of every column / row (segments are the LOD units; nothing merges across them).
  const segOf = (lines: readonly number[], v: number): number => {
    let s = 0;
    for (const l of lines) if (v > l) s++;
    return s;
  };
  const colSeg = new Int32Array(nx);
  for (let i = 0; i < nx; i++) colSeg[i] = segOf(segX, (xs[i]! + xs[i + 1]!) / 2);
  const rowSeg = new Int32Array(ny);
  for (let j = 0; j < ny; j++) rowSeg[j] = segOf(segY, (ys[j]! + ys[j + 1]!) / 2);
  const nSegX = segX.length + 1;
  const segAt = (i: number, j: number): number => rowSeg[j]! * nSegX + colSeg[i]!;

  // Fronts: greedy rectangles of equal cells, grown along rows first or along columns first,
  // whichever gives fewer quads.
  const same = (a: number, b: number): boolean =>
    o[a] === o[b] &&
    k[a] === k[b] &&
    colSeg[a % nx] === colSeg[b % nx] &&
    rowSeg[Math.floor(a / nx)] === rowSeg[Math.floor(b / nx)];
  const greedy = (rowsFirst: boolean): [number, number, number, number][] => {
    const done = new Uint8Array(nx * ny);
    const rects: [number, number, number, number][] = [];
    const cell = (u: number, v: number): number => (rowsFirst ? v * nx + u : u * nx + v);
    const nu = rowsFirst ? nx : ny;
    const nv = rowsFirst ? ny : nx;
    for (let v = 0; v < nv; v++) {
      for (let u = 0; u < nu; u++) {
        const c = cell(u, v);
        if (done[c]) continue;
        let u1 = u + 1;
        while (u1 < nu && !done[cell(u1, v)] && same(c, cell(u1, v))) u1++;
        let v1 = v + 1;
        grow: while (v1 < nv) {
          for (let uu = u; uu < u1; uu++) {
            const cc = cell(uu, v1);
            if (done[cc] || !same(c, cc)) break grow;
          }
          v1++;
        }
        for (let vv = v; vv < v1; vv++) for (let uu = u; uu < u1; uu++) done[cell(uu, vv)] = 1;
        rects.push(rowsFirst ? [u, u1, v, v1] : [v, v1, u, u1]);
      }
    }
    return rects;
  };
  const byRows = greedy(true);
  const byCols = greedy(false);
  for (const [i, i1, j, j1] of byCols.length < byRows.length ? byCols : byRows) {
    const c = j * nx + i;
    emit({
      axis: 'o',
      sign: 1,
      x0: xs[i]!,
      x1: xs[i1]!,
      y0: ys[j]!,
      y1: ys[j1]!,
      o0: o[c]!,
      o1: o[c]!,
      kind: k[c]!,
      seg: segAt(i, j),
    });
  }

  // Vertical step faces (along x lines), merged up the column.
  const stepS = (i: number, j: number): [number, number, number, number] | null => {
    // Between cell (i-1, j) and (i, j); i = 0 / nx are the region border (outside offset).
    const l = i > 0 ? o[j * nx + i - 1]! : (outside?.x0 ?? null);
    const r = i < nx ? o[j * nx + i]! : (outside?.x1 ?? null);
    if (l === null || r === null || l === r) return null;
    if (i === 0 && r < l) return null; // border: only cells standing out of the surround
    if (i === nx && l < r) return null;
    // Faces the deeper side; owned by the deeper cell's segment (the border's own cell otherwise).
    const deeperLeft = l < r;
    const owner =
      i === 0 ? segAt(0, j) : i === nx ? segAt(nx - 1, j) : segAt(deeperLeft ? i - 1 : i, j);
    return [deeperLeft ? -1 : 1, Math.min(l, r), Math.max(l, r), owner];
  };
  for (let i = 0; i <= nx; i++) {
    let j = 0;
    while (j < ny) {
      const s = stepS(i, j);
      if (!s) {
        j++;
        continue;
      }
      let j1 = j + 1;
      while (j1 < ny) {
        const t = stepS(i, j1);
        if (!t || t[0] !== s[0] || t[1] !== s[1] || t[2] !== s[2] || t[3] !== s[3]) break;
        j1++;
      }
      emit({
        axis: 's',
        sign: s[0] as 1 | -1,
        x0: xs[i]!,
        x1: xs[i]!,
        y0: ys[j]!,
        y1: ys[j1]!,
        o0: s[1],
        o1: s[2],
        kind: K_WALL,
        seg: s[3],
      });
      j = j1;
    }
  }

  // Horizontal step faces (along y lines), merged along the row.
  const stepY = (i: number, j: number): [number, number, number, number] | null => {
    // Between cell (i, j-1) below and (i, j) above.
    const b = j > 0 ? o[(j - 1) * nx + i]! : (outside?.y0 ?? null);
    const a = j < ny ? o[j * nx + i]! : (outside?.y1 ?? null);
    if (a === null || b === null || a === b) return null;
    if (j === 0 && a < b) return null;
    if (j === ny && b < a) return null;
    // Lower cell standing out → its top faces up; upper cell standing out → its underside down.
    const up = b > a;
    const owner = j === 0 ? segAt(i, 0) : j === ny ? segAt(i, ny - 1) : segAt(i, up ? j : j - 1);
    return [up ? 1 : -1, Math.min(a, b), Math.max(a, b), owner];
  };
  for (let j = 0; j <= ny; j++) {
    let i = 0;
    while (i < nx) {
      const s = stepY(i, j);
      if (!s) {
        i++;
        continue;
      }
      let i1 = i + 1;
      while (i1 < nx) {
        const t = stepY(i1, j);
        if (!t || t[0] !== s[0] || t[1] !== s[1] || t[2] !== s[2] || t[3] !== s[3]) break;
        i1++;
      }
      emit({
        axis: 'y',
        sign: s[0] as 1 | -1,
        x0: xs[i]!,
        x1: xs[i1]!,
        y0: ys[j]!,
        y1: ys[j]!,
        o0: s[1],
        o1: s[2],
        kind: K_WALL,
        seg: s[3],
      });
      i = i1;
    }
  }
}
