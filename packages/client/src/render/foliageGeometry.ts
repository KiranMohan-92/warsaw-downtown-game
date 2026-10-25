import * as THREE from 'three';
import { CANOPY_REPEAT_INSET, rng, tileUv, type UvRect } from './foliageAtlas.ts';

/** Deterministic load-time archetypes, fitted to shared map dimensions by foliageMesh.ts. */
// ---- tiny vector helpers (tuples: fast enough for load-time generation) ----------------------

export type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len3(a);
  return l > 1e-9 ? mul(a, 1 / l) : [0, 1, 0];
};
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const randUnit = (rnd: () => number): V3 => {
  const z = rnd() * 2 - 1;
  const a = rnd() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [Math.cos(a) * s, z, Math.sin(a) * s];
};
/** Rotate `v` about unit axis `k` by `a` (Rodrigues). */
const rotAxis = (v: V3, k: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot3(k, v) * (1 - c)));
};

// ---- geometry data -------------------------------------------------------------------------

/** Per-vertex foliage data: sway amplitude (m at wind 1), translucency (0..1), solid (0/1). */
export interface VertexFoliage {
  sway: number;
  trans: number;
  solid: number;
}

/** Growable buffers for one archetype (pure data; `toGeometry` makes the three.js object). */
export class FoliageGeo {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  /** `aFoliage`: sway (m), translucency, solid. */
  readonly fol: number[] = [];
  readonly idx: number[] = [];
  /**
   * Per vertex: the stem point of the leaf it belongs to (unit space; NaN for non-sprig
   * vertices). Load-time only (never uploaded): merged clump meshes scale each leaf about its stem
   * uniformly, so a long hedge's leaves are leaf-sized instead of stretched with the hedge.
   */
  readonly stem: number[] = [];
  get vertexCount(): number {
    return this.pos.length / 3;
  }
  get triangleCount(): number {
    return this.idx.length / 3;
  }
  vertex(p: V3, n: V3, u: number, v: number, ao: number, f: VertexFoliage): number {
    this.pos.push(p[0], p[1], p[2]);
    const nn = norm(n);
    this.nrm.push(nn[0], nn[1], nn[2]);
    this.uv.push(u, v);
    this.col.push(ao, ao, ao);
    this.fol.push(f.sway, f.trans, f.solid);
    this.stem.push(NaN, NaN, NaN);
    return this.vertexCount - 1;
  }
  /** Mark vertex `i` as part of a leaf rooted at `stem`. */
  setStem(i: number, stem: V3): void {
    this.stem[i * 3] = stem[0];
    this.stem[i * 3 + 1] = stem[1];
    this.stem[i * 3 + 2] = stem[2];
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  /** Scale positions per axis (after generation, to fit the gameplay volume exactly). */
  scale(sx: number, sy: number, sz: number, oy = 0): void {
    for (const a of [this.pos, this.stem]) {
      for (let i = 0; i < a.length; i += 3) {
        a[i] = a[i]! * sx;
        a[i + 1] = oy + (a[i + 1]! - oy) * sy;
        a[i + 2] = a[i + 2]! * sz;
      }
    }
  }
  /** Extents: max horizontal radius from the y axis, min/max y. */
  extents(): { radius: number; minY: number; maxY: number } {
    let radius = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.pos.length; i += 3) {
      radius = Math.max(radius, Math.hypot(this.pos[i]!, this.pos[i + 2]!));
      minY = Math.min(minY, this.pos[i + 1]!);
      maxY = Math.max(maxY, this.pos[i + 1]!);
    }
    return { radius, minY, maxY };
  }
  /** Largest sway amplitude (m at full wind) on any vertex. */
  maxSway(): number {
    let m = 0;
    for (let i = 0; i < this.fol.length; i += 3) m = Math.max(m, this.fol[i]!);
    return m;
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFoliage', new THREE.Float32BufferAttribute(this.fol, 3));
    g.setAttribute(
      'aFoliageRoot',
      new THREE.Float32BufferAttribute(
        Array.from({ length: this.vertexCount * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)),
        4,
      ),
    );
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    if (this.stem.some((v) => !Number.isNaN(v))) g.userData.sprigStem = new Float32Array(this.stem);
    return g;
  }
}

const lerpUv = (r: UvRect, s: number, t: number): [number, number] => [
  r.u0 + (r.u1 - r.u0) * s,
  r.v0 + (r.v1 - r.v0) * t,
];

interface CardOpts {
  /** Centre, the card's in-plane axes (unit) and half extents. */
  c: V3;
  right: V3;
  up: V3;
  hw: number;
  hh: number;
  uv: UvRect;
  /** Shading normal and AO for a vertex position. */
  normalAt: (p: V3) => V3;
  aoAt: (p: V3) => number;
  swayAt: (p: V3) => number;
  trans: number;
  /** Rows along `up` (≥ 2): more rows let wind bend a tall card. */
  rows?: number;
  /** Lateral offset of each row along `bend` (0..1 along up → metres), for leaning blades. */
  bend?: (t: number) => V3;
}

function card(g: FoliageGeo, o: CardOpts): void {
  const rows = o.rows ?? 2;
  const ids: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const off = o.bend ? o.bend(t) : ([0, 0, 0] as V3);
    const mid = add(add(o.c, mul(o.up, (t * 2 - 1) * o.hh)), off);
    const row: number[] = [];
    for (const s of [0, 1]) {
      const p = add(mid, mul(o.right, (s * 2 - 1) * o.hw));
      const [u, v] = lerpUv(o.uv, s, t);
      row.push(
        g.vertex(p, o.normalAt(p), u, v, o.aoAt(p), {
          sway: o.swayAt(p),
          trans: o.trans,
          solid: 0,
        }),
      );
    }
    ids.push(row as [number, number]);
  }
  for (let r = 1; r < rows; r++) {
    const [a, b] = ids[r - 1]!;
    const [d, c] = ids[r]!;
    g.quad(a, b, c, d);
  }
}

/** Card corners (for fitting into an envelope before emitting). */
function cardCorners(c: V3, right: V3, up: V3, hw: number, hh: number): V3[] {
  const out: V3[] = [];
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) out.push(add(add(c, mul(right, su * hw)), mul(up, sv * hh)));
  }
  return out;
}

/** Card axes facing `n`, rolled by `roll` about it. */
function cardAxes(n: V3, roll: number): { right: V3; up: V3 } {
  const ref: V3 = Math.abs(n[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  let right = norm(cross(ref, n));
  let up = norm(cross(n, right));
  right = rotAxis(right, n, roll);
  up = rotAxis(up, n, roll);
  return { right, up };
}

// ---- archetypes ----------------------------------------------------------------------------

const UV_LEAF = tileUv('leaf', 0.01);
const UV_NEEDLE = tileUv('needle', 0.01);
const UV_THATCH = tileUv('thatch', 0.04);
/** Solid cores sample the middle of their tiles: far mips never reach a neighbouring tile. */
const UV_CANOPY = tileUv('canopy', 0.2);
/** The seamlessly repeating canopy window (bush cores tile it). */
const UV_CANOPY_REPEAT = tileUv('canopy', CANOPY_REPEAT_INSET);
const UV_BARK = tileUv('bark', 0.2);
const UV_NEEDLE_MASS = tileUv('needleMass', 0.2);

/**
 * `solid` flag of bush leaf sprigs: opaque (never alpha-discarded) and static like the core, but
 * not concealment core — drawn up close on every tier (foliageMesh `fringe` LOD), dropped far.
 */
export const FRINGE_SOLID = 0.75;

/** Sway amplitudes (m at wind strength 1): small, so visuals never leave their volume by much. */
export const SWAY = { bush: 0.04, canopy: 0.06, conifer: 0.04, grass: 0.08 } as const;

/** Opaque cores sit in the shade of their own leaves: darker, so the lit cards read on top. */
const CORE_SHADE = 0.72;

/** Fit horizontal radius to exactly 1 and the top to exactly 1 (base stays at 0). */
function fitUnitCylinder(g: FoliageGeo): void {
  // Fit only cards. Concealment cores circumscribe the analytic FoliageIndex cylinder; scaling
  // them to accommodate an overhanging blade would silently shrink gameplay cover.
  for (let i = 0; i < g.pos.length; i += 3) {
    if (g.fol[i + 2]! >= FRINGE_SOLID) continue; // cores and sprigs keep their shape
    const radius = Math.hypot(g.pos[i]!, g.pos[i + 2]!);
    const scale = Math.min(1, 1 / radius);
    g.pos[i] = g.pos[i]! * scale;
    g.pos[i + 1] = clamp01(g.pos[i + 1]!);
    g.pos[i + 2] = g.pos[i + 2]! * scale;
  }
}

/** A lathe hull (rings of radius `rad(ring, seg)` at heights `ys`), closed by a top pole. */
function lathe(
  g: FoliageGeo,
  segs: number,
  ys: readonly number[],
  rad: (ring: number, seg: number) => number,
  pole: V3 | null,
  uv: UvRect,
  uvRepeats: number,
  shade: { normalAt: (p: V3) => V3; aoAt: (p: V3) => number; swayAt: (p: V3) => number },
  trans: number,
  solid: (ring: number) => number = () => 1,
): void {
  const yMax = pole ? pole[1] : ys[ys.length - 1]!;
  const at = (ring: number, seg: number): V3 => {
    const a = ((seg % segs) / segs) * Math.PI * 2;
    const r = rad(ring, seg % segs);
    return [Math.cos(a) * r, ys[ring]!, Math.sin(a) * r];
  };
  const per = segs / uvRepeats;
  const vert = (ring: number, seg: number, sLocal: number, sol: number): number => {
    const p = at(ring, seg);
    const [u, v] = lerpUv(uv, sLocal, clamp01(ys[ring]! / yMax));
    return g.vertex(p, shade.normalAt(p), u, v, shade.aoAt(p), {
      sway: shade.swayAt(p),
      trans,
      solid: sol,
    });
  };
  // Each run of `per` segments spans the tile once: a shared vertex grid per run (vertices are
  // duplicated only at run seams, where the uv jumps back).
  for (let run = 0; run < uvRepeats; run++) {
    const grid: number[][] = [];
    for (let r = 0; r < ys.length; r++) {
      const row: number[] = [];
      for (let k = 0; k <= per; k++) row.push(vert(r, run * per + k, k / per, solid(r)));
      grid.push(row);
    }
    for (let r = 0; r + 1 < ys.length; r++) {
      for (let k = 0; k < per; k++) {
        g.quad(grid[r]![k]!, grid[r + 1]![k]!, grid[r + 1]![k + 1]!, grid[r]![k + 1]!);
      }
    }
    if (pole) {
      const last = ys.length - 1;
      const flat = pole[1] - ys[last]! < yMax * 0.05;
      const [u, v] = lerpUv(uv, 0.5, flat ? 0.5 : 1);
      const c = g.vertex(pole, shade.normalAt(pole), u, v, shade.aoAt(pole), {
        sway: shade.swayAt(pole),
        trans,
        solid: solid(last),
      });
      const cap = (k: number): number => {
        if (!flat) return grid[last]![k]!;
        const p = at(last, run * per + k);
        return g.vertex(
          p,
          shade.normalAt(p),
          ...lerpUv(uv, 0.5 + p[0] * 0.5, 0.5 + p[2] * 0.5),
          shade.aoAt(p),
          { sway: shade.swayAt(p), trans, solid: solid(last) },
        );
      };
      for (let k = 0; k < per; k++) g.tri(cap(k), c, cap(k + 1));
    }
  }
}

/** Tall-grass core layout: segments around, thatch repeats around, rings, opaque thatch band. */
export const GRASS_CORE = {
  segs: 24,
  /** The thatch tile repeats this often round the clump (≈1.2 m per repeat at r = 2.3 m). */
  around: 12,
  ys: [0, 0.34, 0.67, 1],
  /** Tile rows used: the opaque tuft band only (the ragged tips above are alpha, not wall). */
  v0: 0.04,
  v1: 0.68,
  /** Outward-only radial jitter (unit radius): a tufted outline, never inside the cylinder. */
  jitter: 0.022,
  /**
   * Soft crown over the flat top (unit height above 1, never below it): the rim ring rises by up
   * to `rimLift`, an inner ring at `crownRho` and the centre by `crownPeakLift` — a tufted
   * dome instead of a cut drum, still circumscribing the concealment cylinder.
   */
  rimLift: 0.095,
  crownRho: 0.68,
  crownLift: 0.16,
  crownPeakLift: 0.18,
} as const;

/**
 * The grass core is the shaded depth between the blades. Darker than Round 1 so the solid wall
 * recedes behind the dense skirt/rim blade sleeve; opaque either way, concealment unchanged.
 */
const GRASS_DEPTH_SHADE = 0.62;

/**
 * Opaque grass blades breaking the clump's outline (geometry, not alpha: Low draws exactly what
 * High draws, like the bush sprigs — `FRINGE_SOLID`, near LOD on every tier). Tufts of tapered
 * blades: over the crown (irregular tip heights well above the top), round the rim (hiding the
 * top edge) and out of the wall (breaking the side). Unit space; tufts per clump.
 */
export const GRASS_BLADES = {
  crownTufts: 104,
  rimTufts: 118,
  sleeveAround: 48,
  skirtTufts: 109,
  wallTufts: 100,
  /** Highest blade tip (unit height): the visual envelope above the concealment top. */
  maxTip: 1.35,
  /** Farthest blade tip from the axis (unit radius). */
  maxReach: 1.16,
} as const;

/**
 * Closed opaque thatch core that circumscribes the analytic concealment cylinder: the thatch
 * band tiled round it (not one tile stretched over the whole clump), an irregular tufted outline,
 * outward-leaning shading normals with per-tuft variation (so the sides don't light like a
 * plastic drum) and a planar-mapped cap.
 */
function grassConcealmentCore(
  g: FoliageGeo,
  uv: UvRect,
  normalAt: (p: V3) => V3,
  aoAt: (p: V3) => number,
  trans: number,
): void {
  const C = GRASS_CORE;
  const segs = C.segs;
  const per = segs / C.around;
  const base = 1.002 / Math.cos(Math.PI / segs);
  const rnd = rng(9173);
  const jit = Array.from({ length: C.ys.length }, () =>
    Array.from({ length: segs }, () => rnd() * C.jitter),
  );
  const tuft = Array.from({ length: segs }, () => rnd());
  const top = C.ys.length - 1;
  // Uneven rim: smooth bumps (two harmonics + noise), only ever upwards.
  const ph = rnd() * Math.PI * 2;
  const lift = Array.from({ length: segs }, (_, k) => {
    const a = (k / segs) * Math.PI * 2;
    const w = 0.5 + 0.3 * Math.sin(a * 3 + ph) + 0.2 * Math.sin(a * 5 - ph * 1.7);
    return C.rimLift * clamp01(0.7 * w + 0.3 * rnd());
  });
  const at = (ring: number, seg: number): V3 => {
    const k = seg % segs;
    const a = (k / segs) * Math.PI * 2;
    // Side rings at the cylinder radius + jitter; the base stays exact (0) and the top ring only
    // rises above 1 (soft, uneven rim), so the core still circumscribes the cylinder.
    const r = base + jit[ring]![k]!;
    return [Math.cos(a) * r, C.ys[ring]! + (ring === top ? lift[k]! : 0), Math.sin(a) * r];
  };
  const sideNormal = (p: V3, seg: number): V3 => {
    const t = (tuft[seg % segs]! - 0.5) * 0.5;
    const a = (seg / segs) * Math.PI * 2 + t;
    const up = 0.35 + 0.5 * p[1];
    return norm(add(mul([Math.cos(a), up, Math.sin(a)], 0.7), mul(normalAt(p), 0.3)));
  };
  const sideAo = (p: V3, seg: number): number => {
    const y = clamp01(p[1]);
    const bladeRun = 0.84 + 0.16 * Math.sin(seg * 2.7 + y * 11.0 + tuft[seg % segs]! * 5.0);
    const baseToTip = 0.66 + 0.42 * smooth(0.02, 0.95, y);
    return aoAt(p) * GRASS_DEPTH_SHADE * bladeRun * baseToTip;
  };
  const vOf = (y: number): number => C.v0 + (C.v1 - C.v0) * y;
  const f = { sway: 0, trans, solid: 1 };
  for (let run = 0; run < C.around; run++) {
    const grid: number[][] = [];
    for (let r = 0; r < C.ys.length; r++) {
      const row: number[] = [];
      for (let k = 0; k <= per; k++) {
        const seg = run * per + k;
        const p = at(r, seg);
        // Odd runs mirror the tile: seams stay continuous and slanted blades don't line up into
        // diagonal stripes round the clump.
        const [u, v] = lerpUv(uv, run % 2 ? 1 - k / per : k / per, vOf(C.ys[r]!));
        row.push(g.vertex(p, sideNormal(p, seg), u, v, sideAo(p, seg), f));
      }
      grid.push(row);
    }
    for (let r = 0; r + 1 < C.ys.length; r++) {
      for (let k = 0; k < per; k++) {
        g.quad(grid[r]![k]!, grid[r + 1]![k]!, grid[r + 1]![k + 1]!, grid[r]![k + 1]!);
      }
    }
  }
  // Cap: a low dome of planar thatch (x, z → the tile), its own rings so the side uvs stay
  // untouched. Rim normals lean outwards (no hard lit edge where the wall meets the top).
  const capUv = (p: V3): [number, number] =>
    lerpUv(uv, clamp01(0.5 + p[0] * 0.45), vOf(clamp01(0.5 + p[2] * 0.45)));
  const centre: V3 = [0, 1 + C.crownPeakLift * (0.9 + 0.08 * tuft[0]!), 0];
  const c = g.vertex(centre, [0, 1, 0], ...capUv(centre), aoAt(centre) * GRASS_DEPTH_SHADE, f);
  const cap = Array.from({ length: segs }, (_, k) => {
    const p = at(top, k);
    const out: V3 = norm([p[0], 0, p[2]]);
    return g.vertex(
      p,
      norm(add(mul(out, 0.55), [0, 1, 0])),
      ...capUv(p),
      aoAt(p) * GRASS_DEPTH_SHADE,
      f,
    );
  });
  const crown = Array.from({ length: segs }, (_, k) => {
    const a = (k / segs) * Math.PI * 2;
    const rho = C.crownRho * (0.92 + 0.16 * tuft[k]!);
    const p: V3 = [
      Math.cos(a) * rho,
      1 + C.crownLift * (0.62 + 0.28 * tuft[(k + 7) % segs]!) + lift[k]! * 0.22,
      Math.sin(a) * rho,
    ];
    const out: V3 = [Math.cos(a), 0, Math.sin(a)];
    return g.vertex(
      p,
      norm(add(mul(out, 0.3), [0, 1, 0])),
      ...capUv(p),
      aoAt(p) * GRASS_DEPTH_SHADE,
      f,
    );
  });
  const baseC = g.vertex([0, 0, 0], [0, -1, 0], ...lerpUv(uv, 0.5, vOf(0.5)), aoAt([0, 0, 0]), {
    ...f,
    trans: 0,
  });
  const ring0 = Array.from({ length: segs }, (_, k) => {
    const p = at(0, k);
    return g.vertex(p, [0, -1, 0], ...lerpUv(uv, 0.5, vOf(0.5)), aoAt(p) * CORE_SHADE, {
      ...f,
      trans: 0,
    });
  });
  for (let k = 0; k < segs; k++) {
    const next = (k + 1) % segs;
    g.quad(cap[k]!, crown[k]!, crown[next]!, cap[next]!);
    g.tri(crown[k]!, c, crown[next]!);
    g.tri(baseC, ring0[next]!, ring0[k]!);
  }
}

/** UV column (in the thatch tile's opaque band) per blade: a real blade's colour run. */
const bladeUv = (uv: UvRect, k: number, s: number, t: number): [number, number] => {
  const u0 = 0.06 + ((k * 0.618034) % 0.86);
  const v = GRASS_CORE.v0 + (GRASS_CORE.v1 - GRASS_CORE.v0) * (0.2 + 0.75 * t);
  return lerpUv(uv, u0 + 0.03 * s, v);
};

/**
 * One opaque blade from `root` along `dir` (unit) for `len`, `width` across `side`, the tip pushed
 * by `arch` (droop / lean). `arched`: two segments and a tip (3 triangles); otherwise one tapered
 * triangle (short wall blades).
 */
function grassBlade(
  g: FoliageGeo,
  uv: UvRect,
  k: number,
  root: V3,
  dir: V3,
  side: V3,
  len: number,
  width: number,
  arch: V3,
  arched: boolean,
  shade: { normalAt: (p: V3) => V3; ao: number },
): void {
  const f = { sway: 0, trans: 0.55, solid: FRINGE_SOLID };
  const tip = add(add(root, mul(dir, len)), arch);
  const lean: V3 = norm([dir[0], 0, dir[2]]);
  // Soft, mostly-up foliage normal, a little towards the blade's outward lean.
  const n = (p: V3, t: number): V3 => norm(add(shade.normalAt(p), mul(lean, 0.25 + 0.25 * t)));
  const v = (q: V3, s: number, t: number, ao: number): number => {
    // Keep every blade inside the clump's visual envelope (a few cm-tens of cm past the core).
    const r = Math.hypot(q[0], q[2]);
    const k2 = r > GRASS_BLADES.maxReach ? GRASS_BLADES.maxReach / r : 1;
    const p: V3 = [q[0] * k2, Math.min(GRASS_BLADES.maxTip, Math.max(0, q[1])), q[2] * k2];
    return g.vertex(p, n(p, t), ...bladeUv(uv, k, s, t), ao, f);
  };
  const a0 = v(add(root, mul(side, -width / 2)), 0, 0, shade.ao * 0.6);
  const a1 = v(add(root, mul(side, width / 2)), 1, 0, shade.ao * 0.6);
  const c = v(tip, 0.5, 1, shade.ao * 1.12);
  if (!arched) {
    g.tri(a0, a1, c);
    return;
  }
  const mid = add(add(root, mul(dir, len * 0.55)), mul(arch, 0.3));
  const b0 = v(add(mid, mul(side, -width * 0.36)), 0.15, 0.55, shade.ao * 0.92);
  const b1 = v(add(mid, mul(side, width * 0.36)), 0.85, 0.55, shade.ao * 0.92);
  g.quad(a0, a1, b1, b0);
  g.tri(b0, b1, c);
}

interface TuftOpts {
  blades: number;
  len: [number, number];
  /** Outward lean (horizontal unit per unit up) and random fan spread. */
  lean: number;
  spread: number;
  ao: number;
  width: [number, number];
  arched: (blade: number) => boolean;
}

/**
 * The visible grass of a tall-grass clump: tufts of opaque blades over the crown, round the rim
 * and out of the wall (`GRASS_BLADES`). Roots sit inside the core, so a blade only ever adds to
 * the outline; nothing here is concealment (the core is).
 */
function grassBladeTufts(g: FoliageGeo, uv: UvRect, normalAt: (p: V3) => V3, seed: number): void {
  const B = GRASS_BLADES;
  const rnd = rng(seed * 4931 + 7);
  let k = 0;
  const tuft = (root: V3, out: V3, o: TuftOpts): void => {
    const ph = rnd() * Math.PI * 2;
    for (let b = 0; b < o.blades; b++) {
      // Fan round the tuft: each blade leans its own way, most of them outwards.
      const az = ph + (b / o.blades) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      const fan: V3 = [Math.cos(az), 0, Math.sin(az)];
      const spread = o.spread * (0.5 + rnd() * 0.5);
      const horiz = add(mul(out, o.lean * (0.7 + 0.6 * rnd())), mul(fan, spread));
      // Unit space is stretched (r, h, r) with r ≈ 2 h: a horizontal unit lean reads ~2× wider.
      const dir = norm(add([0, 1, 0], horiz));
      const side = norm(cross(dir, fan));
      const l = o.len[0] + (o.len[1] - o.len[0]) * Math.pow(rnd(), 0.8);
      const curved = o.arched(b);
      // Long blades arch over and droop at the tip.
      const droop = curved ? l * (0.12 + 0.25 * rnd()) : 0;
      const arch = add(mul(norm([horiz[0], 0, horiz[2]]), droop * 0.5), [0, -droop * 0.35, 0]);
      const width = o.width[0] + (o.width[1] - o.width[0]) * rnd();
      grassBlade(g, uv, k++, root, dir, side, l, width, arch, curved, {
        normalAt,
        ao: o.ao * (0.85 + 0.3 * rnd()),
      });
    }
  };
  // Crown: tufts spread over the top (sunflower spiral), rooted above the opaque cap so
  // the measured height variation is visible, not buried inside the dome.
  for (let i = 0; i < B.crownTufts; i++) {
    const rho = 0.94 * Math.sqrt((i + 0.5) / B.crownTufts);
    const th = i * 2.39996 + rnd() * 0.5;
    const out: V3 = [Math.cos(th), 0, Math.sin(th)];
    const capClearance = 1.18 - 0.075 * rho + 0.012 * Math.sin(th * 4.0 + rho * 3.0);
    const root: V3 = [out[0] * rho, capClearance, out[2] * rho];
    const tall = rnd() < 0.32 ? 1.12 : 0.9;
    tuft(root, out, {
      blades: 6,
      len: [0.035, 0.17 * tall],
      lean: 0.05 + 0.14 * rho,
      spread: 0.16,
      ao: 1,
      width: [0.008, 0.013],
      arched: (b) => b % 2 === 0,
    });
  }
  // Rim: tufts on the top edge leaning out over it (hides the wall/top corner).
  for (let i = 0; i < B.rimTufts; i++) {
    const th = ((i + rnd() * 0.7) / B.rimTufts) * Math.PI * 2;
    const out: V3 = [Math.cos(th), 0, Math.sin(th)];
    const root: V3 = [out[0] * 0.985, 0.88 + rnd() * 0.12, out[2] * 0.985];
    tuft(root, out, {
      blades: 5,
      len: [0.2, 0.45],
      lean: 0.8,
      spread: 0.1,
      ao: 0.95,
      width: [0.008, 0.012],
      arched: () => true,
    });
  }
  // Sleeve: short overlapping blades pinned just inside the core and leaning out. The regular
  // rings deliberately fill every angular slice from base to crown so close views see blades
  // rather than the shaded wall.
  const ribbon = (th: number, width: number, top: number, shade: number): void => {
    const out: V3 = [Math.cos(th), 0, Math.sin(th)];
    const side: V3 = [-out[2], 0, out[0]];
    const n = norm(add([0, 1, 0], mul(out, 0.45)));
    const f = { sway: 0, trans: 0.55, solid: FRINGE_SOLID };
    const bladeIndex = k++;
    const v = (p: V3, s: number, t: number, ao: number): number => {
      const r = Math.hypot(p[0], p[2]);
      const k2 = r > B.maxReach ? B.maxReach / r : 1;
      return g.vertex(
        [p[0] * k2, Math.min(B.maxTip, p[1]), p[2] * k2],
        n,
        ...bladeUv(uv, bladeIndex, s, t),
        ao,
        f,
      );
    };
    const bottom: V3 = [out[0] * 1.025, 0, out[2] * 1.025];
    const mid: V3 = [out[0] * 1.13, 0.72 + 0.04 * Math.sin(th * 3.0), out[2] * 1.13];
    const tip: V3 = [out[0] * 1.14, top, out[2] * 1.14];
    const b0 = v(add(bottom, mul(side, -width * 0.58)), 0, 0, shade * 0.68);
    const b1 = v(add(bottom, mul(side, width * 0.58)), 1, 0, shade * 0.68);
    const m0 = v(add(mid, mul(side, -width * 0.48)), 0.08, 0.62, shade * 0.94);
    const m1 = v(add(mid, mul(side, width * 0.48)), 0.92, 0.62, shade * 0.94);
    const t = v(tip, 0.5, 1, shade * 1.08);
    g.quad(b0, b1, m1, m0);
    g.tri(m0, m1, t);
  };
  for (let i = 0; i < B.sleeveAround; i++) {
    for (const offset of [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]) {
      const wobble = 0.04 * Math.sin(i * 1.7 + offset * 5.0);
      const th = ((i + offset + wobble) / B.sleeveAround) * Math.PI * 2;
      const width = 0.033 + 0.005 * ((i + Math.round(offset * 10)) % 3);
      const top = 1.28 + (0.06 * ((i * 5 + Math.round(offset * 10)) % 7)) / 6;
      ribbon(th, width, top, 0.74 + 0.18 * ((i + offset) % 1));
    }
  }
  // Skirt: tall blades standing on the ground just outside the wall (breaks the base line and
  // the smooth side; the tallest overtop the rim at their own heights).
  for (let i = 0; i < B.skirtTufts; i++) {
    const th = ((i + rnd() * 0.8) / B.skirtTufts) * Math.PI * 2;
    const out: V3 = [Math.cos(th), 0, Math.sin(th)];
    const rho = 1.01 + rnd() * 0.04;
    tuft([out[0] * rho, 0, out[2] * rho], out, {
      blades: 3,
      len: [0.45, rnd() < 0.4 ? 1.32 : 1.05],
      lean: 0.07,
      spread: 0.05,
      ao: 0.95,
      width: [0.012, 0.02],
      arched: () => true,
    });
  }
  // Wall: blades arching out of the side at mid height (a fountain, not a drum).
  for (let i = 0; i < B.wallTufts; i++) {
    const th = ((i + rnd()) / B.wallTufts) * Math.PI * 2 * 5;
    const y = 0.25 + 0.7 * Math.sqrt((i + rnd()) / B.wallTufts);
    const out: V3 = [Math.cos(th), 0, Math.sin(th)];
    tuft([out[0] * 0.99, y, out[2] * 0.99], out, {
      blades: 3,
      len: [0.12, 0.24],
      lean: 0.8,
      spread: 0.2,
      ao: 0.7 + 0.35 * y,
      width: [0.012, 0.018],
      arched: () => true,
    });
  }
}

function ellipsoidLobe(
  g: FoliageGeo,
  center: V3,
  scale: V3,
  uv: UvRect,
  aoBase: number,
  trans: number,
  sway = 0,
  segs = 12,
): void {
  const phis = [-0.52, 0, 0.52];
  const vertex = (v: V3, s: number, t: number): number => {
    const q: V3 = [
      center[0] + v[0] * scale[0],
      center[1] + v[1] * scale[1],
      center[2] + v[2] * scale[2],
    ];
    return g.vertex(
      q,
      norm([v[0] / scale[0], v[1] / scale[1], v[2] / scale[2]]),
      ...lerpUv(uv, s, t),
      aoBase,
      { sway, trans, solid: 1 },
    );
  };
  const bottom = vertex([0, -1, 0], 0.5, 0);
  const top = vertex([0, 1, 0], 0.5, 1);
  const rows = phis.map((phi) => {
    const y = Math.sin(phi);
    const r = Math.cos(phi);
    return Array.from({ length: segs }, (_, seg) => {
      const a = (seg / segs) * Math.PI * 2;
      const v: V3 = [Math.cos(a) * r, y, Math.sin(a) * r];
      return vertex(v, seg / segs, 0.5 + y * 0.5);
    });
  });
  for (let seg = 0; seg < segs; seg++) {
    const next = (seg + 1) % segs;
    g.tri(bottom, rows[0]![seg]!, rows[0]![next]!);
    g.quad(rows[0]![seg]!, rows[1]![seg]!, rows[1]![next]!, rows[0]![next]!);
    g.quad(rows[1]![seg]!, rows[2]![seg]!, rows[2]![next]!, rows[1]![next]!);
    g.tri(rows[2]![seg]!, top, rows[2]![next]!);
  }
}

/**
 * Opaque bush core: one continuous lumpy leaf mass (belly, domed crown, a dozen soft clumps)
 * instead of a drum with lobes. Every point sits on or outside a radius-1.06 lathe for y ≤ 1, so
 * it circumscribes the gameplay cylinder with margin; lumps only ever push outwards. The leaf
 * tile's seamless window repeats every three quads (≈0.8 m on a typical bush), so leaves read at
 * real size instead of one tile stretched round the whole bush.
 */
export const BUSH_CORE = {
  /** Around (a multiple of `uvSpan`, so the tile wraps seamlessly). */
  segs: 30,
  /** Profile parameter per ring: 0..1 = side (t = y), 1..2 = crown (quarter ellipse). */
  rings: [0, 0.25, 0.5, 0.75, 1, 1.3, 1.6, 1.85, 2],
  radius: 1.06,
  belly: 0.06,
  crown: 0.14,
  lumps: 12,
  lumpMax: 0.1,
  /** Quads per repeat of the leaf tile (both ways): ≈0.67 × radius, as before at 20 × 2. */
  uvSpan: 3,
  /** Leaf sprigs breaking the silhouette (opaque six-point leaf outlines, every tier). */
  sprigs: 60,
  leavesPerSprig: 3,
  /** How far a sprig reaches beyond the core surface (unit space). */
  sprigReach: 0.13,
} as const;

function bushConcealmentCore(
  g: FoliageGeo,
  normalAt: (p: V3) => V3,
  aoAt: (p: V3) => number,
  seed: number,
): void {
  const C = BUSH_CORE;
  const rnd = rng(seed * 7919 + 13);
  // Base surface (before lumps) and its outward push direction.
  const base = (th: number, t: number): { p: V3; n: V3 } => {
    if (t <= 1) {
      const r = C.radius + C.belly * Math.sin(Math.PI * t);
      return { p: [Math.cos(th) * r, t, Math.sin(th) * r], n: [Math.cos(th), 0, Math.sin(th)] };
    }
    const phi = Math.min(1, t - 1) * (Math.PI / 2);
    const r = C.radius * Math.cos(phi);
    return {
      p: [Math.cos(th) * r, 1 + C.crown * Math.sin(phi), Math.sin(th) * r],
      n: norm([Math.cos(th) * Math.cos(phi), Math.sin(phi), Math.sin(th) * Math.cos(phi)]),
    };
  };
  // Soft clumps: 3D gaussians around points on the base surface (so the crown pole stays whole).
  const lumps = Array.from({ length: C.lumps }, () => {
    const c = base(rnd() * Math.PI * 2, 0.25 + rnd() * 1.55).p;
    return { c, a: 0.05 + rnd() * 0.05, s2: (0.38 + rnd() * 0.2) ** 2 };
  });
  const lumpAt = (p: V3): number => {
    let d = 0;
    for (const l of lumps) {
      const q = sub(p, l.c);
      d += l.a * Math.exp(-dot3(q, q) / l.s2);
    }
    return Math.min(C.lumpMax, d);
  };
  const surf = (th: number, t: number): { p: V3; lump: number } => {
    const b = base(th, t);
    const lump = lumpAt(b.p);
    return { p: add(b.p, mul(b.n, lump)), lump };
  };
  const segs = C.segs;
  const rings = C.rings;
  const vert = (seg: number, ring: number, s: number, tt: number): number => {
    const th = (seg / segs) * Math.PI * 2;
    const t = rings[ring]!;
    const { p, lump } = surf(th, t);
    // Geometric normal (finite differences) blended with the soft "puffy" foliage normal.
    const e = 1e-3;
    const dth = sub(surf(th + e, t).p, surf(th - e, t).p);
    const t0 = Math.max(0, t - e);
    const t1 = Math.min(2 - 1e-6, t + e);
    const dt = sub(surf(th, t1).p, surf(th, t0).p);
    let n = norm(cross(dth, dt));
    const puffy = normalAt(p);
    if (t >= 2 - 1e-6 || dot3(n, puffy) < 0) n = t >= 2 - 1e-6 ? [0, 1, 0] : mul(n, -1);
    const ao = aoAt(p) * CORE_SHADE * (0.82 + 0.35 * (lump / C.lumpMax));
    return g.vertex(
      p,
      norm(add(mul(n, 0.6), mul(puffy, 0.4))),
      ...lerpUv(UV_CANOPY_REPEAT, s, tt),
      ao,
      {
        sway: 0,
        trans: t > 1 ? 0.12 : 0.18,
        solid: 1,
      },
    );
  };
  const span = C.uvSpan;
  for (let s0 = 0; s0 < segs; s0 += span) {
    for (let r0 = 0; r0 + 1 < rings.length; r0 += span) {
      // One block of span × span quads shares a vertex grid spanning the tile once.
      const ks = Math.min(span, segs - s0);
      const rs = Math.min(span, rings.length - 1 - r0);
      const grid: number[][] = [];
      for (let r = 0; r <= rs; r++) {
        const row: number[] = [];
        for (let k = 0; k <= ks; k++) {
          row.push(vert(s0 + k, r0 + r, k / span, r / span));
        }
        grid.push(row);
      }
      for (let r = 0; r < rs; r++) {
        for (let k = 0; k < ks; k++) {
          if (r0 + r + 1 === rings.length - 1) {
            g.tri(grid[r]![k]!, grid[r + 1]![k]!, grid[r]![k + 1]!); // crown pole
          } else {
            g.quad(grid[r]![k]!, grid[r + 1]![k]!, grid[r + 1]![k + 1]!, grid[r]![k + 1]!);
          }
        }
      }
    }
  }
  // Leaf sprigs: short twigs of three leaves poking out of the mass, so the outline reads as
  // leaves, not a clipped shell. Real leaf-shaped geometry (no alpha test), so Low draws exactly
  // what High draws (concealment parity); static, like the core. Drawn within the near-LOD
  // distance on every tier (FRINGE_SOLID).
  const leafUv = (k: number): [number, number, number, number] => {
    // A small patch of the leaf tile per leaf: colour and texture of a real leaf.
    const u0 = 0.1 + ((k * 0.618034) % 0.7);
    const v0 = 0.1 + ((k * 0.414214) % 0.7);
    return [u0, v0, u0 + 0.12, v0 + 0.12];
  };
  let leafIndex = 0;
  for (let i = 0; i < C.sprigs; i++) {
    // Golden-angle spiral over the profile: even cover, so every outline catches sprigs.
    const th = i * 2.399963 + rnd() * 0.3;
    const t = 0.12 + ((i + 0.5) / C.sprigs) * 1.7;
    const { p: anchor } = surf(th, t);
    const out = normalAt(anchor);
    // Mostly outwards, leaning up and sideways like a growing shoot.
    const side: V3 = [-Math.sin(th), 0, Math.cos(th)];
    const dir = norm(add(add(mul(out, 0.75), mul(side, (rnd() - 0.5) * 1.2)), [0, 0.35, 0]));
    const base = sub(anchor, mul(out, 0.04)); // rooted just inside the mass
    for (let k = 0; k < C.leavesPerSprig; k++) {
      const along = (0.25 + (k / C.leavesPerSprig) * 0.75) * C.sprigReach;
      const stem = add(base, mul(dir, along));
      const sideways = norm(cross(dir, out));
      const flip = k % 2 ? 1 : -1;
      // Leaf axis: forward along the shoot, splayed to alternate sides.
      const axis = norm(add(mul(dir, 0.8), mul(sideways, flip * (0.5 + rnd() * 0.3))));
      const len = 0.07 + rnd() * 0.05;
      const wid = len * (0.42 + rnd() * 0.12);
      const across = norm(cross(axis, out));
      const lift = mul(out, 0.012 * (rnd() - 0.3)); // slight cup, not a flat sticker
      // Six-point outline: narrow at the stalk, widest just below the middle, a pointed tip.
      const at = (t: number, w: number): V3 =>
        add(add(add(stem, mul(axis, len * t)), mul(across, (w * wid) / 2)), mul(lift, 1 - t));
      const tip = add(stem, mul(axis, len));
      const [u0, v0, u1, v1] = leafUv(leafIndex++);
      const uvAt = (t: number, w: number): [number, number] =>
        lerpUv(UV_CANOPY_REPEAT, u0 + (u1 - u0) * t, v0 + ((v1 - v0) * (1 + w)) / 2);
      const n = norm(add(mul(out, 0.7), mul(norm(cross(across, axis)), 0.3)));
      const ao = aoAt(anchor) * CORE_SHADE * 1.18; // outer leaves catch more light
      const f = { sway: 0, trans: 0.3, solid: FRINGE_SOLID };
      const pts: [V3, number, number, number][] = [
        [stem, 0, 0, 0.85],
        [at(0.3, 0.92), 0.3, 0.92, 0.95],
        [at(0.66, 0.72), 0.66, 0.72, 1],
        [tip, 1, 0, 1.05],
        [at(0.66, -0.72), 0.66, -0.72, 1],
        [at(0.3, -0.92), 0.3, -0.92, 0.95],
      ];
      const [vs, l1, l2, vt, r2, r1] = pts.map(([p, t, w, k]) => {
        const vi = g.vertex(p, n, ...uvAt(t, w), ao * k, f);
        g.setStem(vi, stem);
        return vi;
      }) as [number, number, number, number, number, number];
      g.tri(vs, l1, r1);
      g.tri(l1, l2, r2);
      g.tri(l1, r2, r1);
      g.tri(l2, vt, r2);
    }
  }

  // Underside cap (never seen from street level; closes the hull for downward views).
  const bottom = g.vertex([0, 0, 0], [0, -1, 0], ...lerpUv(UV_CANOPY, 0.5, 0.5), 0.34, {
    sway: 0,
    trans: 0,
    solid: 1,
  });
  const ring0 = Array.from({ length: segs }, (_, k) =>
    g.vertex(
      surf((k / segs) * Math.PI * 2, 0).p,
      [0, -1, 0],
      ...lerpUv(UV_CANOPY, 0.5, 0.5),
      0.34,
      {
        sway: 0,
        trans: 0,
        solid: 1,
      },
    ),
  );
  for (let k = 0; k < segs; k++) g.tri(bottom, ring0[(k + 1) % segs]!, ring0[k]!);
}

/**
 * Bush: a rounded opaque leaf volume filling the concealment cylinder, with irregular leaf-cluster
 * cards along the sides and across the crown. Unit space: radius 1, y 0..1.
 */
export function bushArchetype(seed = 11): FoliageGeo {
  const rnd = rng(seed);
  const g = new FoliageGeo();
  const normalAt = (p: V3): V3 => norm([p[0], (p[1] - 0.25) * 1.3, p[2]]);
  const aoAt = (p: V3): number =>
    (0.5 + 0.5 * smooth(0, 0.9, p[1])) * (0.78 + 0.22 * clamp01(Math.hypot(p[0], p[2])));
  bushConcealmentCore(g, normalAt, aoAt, seed);

  const SIDE = 8;
  const TOP = 4;
  for (let i = 0; i < SIDE + TOP; i++) {
    const top = i >= SIDE;
    const th = top
      ? ((i - SIDE + rnd() * 0.5) / TOP) * Math.PI * 2
      : ((i + rnd() * 0.8) / SIDE) * Math.PI * 2;
    const y = top ? 0.9 + rnd() * 0.09 : 0.05 + 0.84 * ((i * 0.618034 + rnd() * 0.12) % 1);
    const rho = top ? 0.72 * Math.sqrt(rnd()) : 0.92 + rnd() * 0.08;
    const c: V3 = [Math.cos(th) * rho, y, Math.sin(th) * rho];
    const out = top
      ? norm([Math.cos(th) * 0.4, 1, Math.sin(th) * 0.4])
      : norm([Math.cos(th), 0.5 * (y - 0.45) + (y > 0.8 ? 0.9 : 0), Math.sin(th)]);
    const n = norm(add(out, mul(randUnit(rnd), top ? 0.35 : 0.55)));
    const { right, up } = cardAxes(n, (rnd() - 0.5) * 1.6);
    const hs = top ? 0.28 + rnd() * 0.1 : 0.25 + rnd() * 0.09;
    card(g, {
      c,
      right,
      up,
      hw: hs,
      hh: hs,
      uv: UV_LEAF,
      normalAt: (p) => norm(add(normalAt(p), mul(out, 0.3))),
      aoAt,
      swayAt: (p) => SWAY.bush * (0.4 + 0.6 * clamp01(p[1])),
      trans: 1,
    });
  }
  fitUnitCylinder(g);
  return g;
}

/**
 * Tall grass clump: a closed opaque thatch core (the fixed concealment silhouette, softly domed)
 * under tufts of opaque blades that break its outline — over the crown, round the rim and out of
 * the wall. Unit space: the core spans radius 1 × height 1 (plus its crown); blades reach a little
 * beyond (`GRASS_BLADES.maxTip` / `maxReach`), roots always inside the core.
 */
export function grassArchetype(seed = 23): FoliageGeo {
  const g = new FoliageGeo();
  const normalAt = (p: V3): V3 => norm([p[0] * 0.55, 1, p[2] * 0.55]);
  const aoAt = (p: V3): number => 0.5 + 0.5 * smooth(0, 1, p[1]);
  grassConcealmentCore(g, UV_THATCH, normalAt, aoAt, 0.45);
  for (let i = 0; i < g.vertexCount; i++) {
    if (g.fol[i * 3 + 2] !== 1 || g.pos[i * 3 + 1]! > 1) continue;
    g.col[i * 3] = g.col[i * 3]! * 0.82;
    g.col[i * 3 + 1] = g.col[i * 3 + 1]! * 0.95;
    g.col[i * 3 + 2] = g.col[i * 3 + 2]! * 0.76;
  }
  grassBladeTufts(g, UV_THATCH, normalAt, seed);
  return g;
}

/** Leaf-cluster cards per crown lobe. */
const CANOPY_CARDS = 8;

/**
 * Broadleaf crown: five leaf lobes (opaque low-poly cores wrapped in leaf-cluster cards) and the
 * thin decorative twigs that carry them. Unit space: radius 1, y 0..1 = crown bottom..top (instanced at
 * (crown, crownHeight, crown)); built in a normalised space where the crown is a unit sphere.
 */
export function canopyArchetype(seed = 37): FoliageGeo {
  const rnd = rng(seed);
  const g = new FoliageGeo();
  // Normalised space N: crown = unit sphere at the origin; unit space y = 0.5 + 0.5 · yN.
  const toUnit = (p: V3): V3 => [p[0], 0.5 + 0.5 * p[1], p[2]];
  const fromUnit = (p: V3): V3 => [p[0], (p[1] - 0.5) * 2, p[2]];
  const lobes: { c: V3; r: number }[] = [{ c: [0, 0.38, 0], r: 0.55 }];
  const th0 = rnd() * Math.PI * 2;
  for (let k = 0; k < 4; k++) {
    const th = th0 + (k / 4) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
    const rho = 0.4 + rnd() * 0.08;
    const c: V3 = [Math.cos(th) * rho, -0.12 + rnd() * 0.24, Math.sin(th) * rho];
    lobes.push({ c, r: Math.min(0.52, 0.97 - len3(c)) });
  }
  const aoAtN = (q: V3): number =>
    (0.55 + 0.45 * clamp01(len3(q))) * (0.78 + 0.22 * clamp01((q[1] + 1) / 2));
  // Thin decorative twigs start at the collider-backed trunk top, inside the crown.
  const branch = (a: V3, b: V3, r0: number, r1: number): void => {
    const axis = norm(sub(b, a));
    const { right, up } = cardAxes(axis, 0);
    const sides = 5;
    const ring = (p: V3, r: number, t: number): number[] => {
      const ids: number[] = [];
      for (let s = 0; s <= sides; s++) {
        const ang = (s / sides) * Math.PI * 2;
        const dir = add(mul(right, Math.cos(ang)), mul(up, Math.sin(ang)));
        const q = add(p, mul(dir, r));
        const [u, v] = lerpUv(UV_BARK, s / sides, t);
        ids.push(
          g.vertex(toUnit(q), dir, u, v, 0.55 + 0.25 * t, { sway: 0.01 * t, trans: 0, solid: 1 }),
        );
      }
      return ids;
    };
    const r0i = ring(a, r0, 0);
    const r1i = ring(b, r1, 1);
    for (let s = 0; s < sides; s++) g.quad(r0i[s]!, r0i[s + 1]!, r1i[s + 1]!, r1i[s]!);
  };
  for (const l of lobes) {
    const start: V3 = [0, -0.8, 0];
    branch(start, mul(l.c, 0.8), 0.009, 0.004);
  }
  for (const l of lobes) {
    const normalN = (q: V3): V3 => norm(add(norm(sub(q, l.c)), mul(norm(q), 0.7)));
    ellipsoidLobe(
      g,
      toUnit(l.c),
      [l.r * 0.86, l.r * 0.43, l.r * 0.86],
      UV_CANOPY,
      aoAtN(l.c) * CORE_SHADE,
      0.3,
      SWAY.canopy * 0.3,
      10,
    );
    // Leaf-cluster cards on the lobe's surface, facing out of it.
    const outward = len3(l.c) > 1e-3 ? norm(l.c) : ([0, 1, 0] as V3);
    // Two shells: an inner one hiding the faceted core, an outer one breaking the silhouette.
    for (let i = 0; i < CANOPY_CARDS; i++) {
      const d = norm(add(randUnit(rnd), mul(outward, 0.7)));
      const shell = i % 2 ? 0.66 + rnd() * 0.12 : 0.86 + rnd() * 0.14;
      let c = add(l.c, mul(d, l.r * shell));
      const n = norm(add(d, mul(randUnit(rnd), 0.5)));
      const { right, up } = cardAxes(n, rnd() * Math.PI * 2);
      const hs = 0.24 + rnd() * 0.08;
      // Pull inside the crown sphere if a corner pokes out.
      for (let k = 0; k < 12; k++) {
        const over = Math.max(...cardCorners(c, right, up, hs, hs).map(len3));
        if (over <= 1) break;
        c = mul(c, 0.95);
      }
      const cu = toUnit(c);
      // Emit in unit space: map the axes (y halves) so the card stays planar.
      card(g, {
        c: cu,
        right: [right[0], right[1] * 0.5, right[2]],
        up: [up[0], up[1] * 0.5, up[2]],
        hw: hs,
        hh: hs,
        uv: UV_LEAF,
        normalAt: (q) => norm(add(normalN(fromUnit(q)), mul(n, 0.25))),
        aoAt: (q) => aoAtN(fromUnit(q)),
        swayAt: (q) => SWAY.canopy * (0.5 + 0.5 * clamp01(len3(fromUnit(q)))),
        trans: 1,
      });
    }
  }
  // Fit: horizontal radius exactly 1, vertical span inside 0..1 touching top or bottom.
  const e = g.extents();
  const half = Math.max(e.maxY - 0.5, 0.5 - e.minY);
  g.scale(1 / e.radius, 0.5 / half, 1 / e.radius, 0.5);
  return g;
}

/** Conifer core radius at the base (of 1): the needle tiers stand well clear of it. */
const CONIFER_CORE = 0.88;

/**
 * Conifer: an opaque cone core and tiers of drooping needle sprays, tip cards on top. Unit
 * space: radius 1 at the base, y 0..1 (instanced from 0.2 × height to the top).
 */
export function coniferArchetype(seed = 41): FoliageGeo {
  const rnd = rng(seed);
  const g = new FoliageGeo();
  const normalAt = (p: V3): V3 => norm([p[0], 0.45 + (p[1] - 0.3) * 0.6, p[2]]);
  const aoAt = (p: V3): number =>
    (0.5 + 0.5 * smooth(0, 1, p[1])) *
    (0.75 + 0.25 * clamp01(Math.hypot(p[0], p[2]) / Math.max(0.05, 1 - p[1])));
  const coniferSegs = 12;
  const jitter = Array.from({ length: 72 }, () => 0.92 + rnd() * 0.16);
  const ys = [0.03, 0.24, 0.46, 0.68, 0.86];
  lathe(
    g,
    coniferSegs,
    ys,
    (ring, seg) => CONIFER_CORE * (1 - ys[ring]!) * jitter[ring * coniferSegs + seg]!,
    [0, 0.97, 0],
    UV_NEEDLE_MASS,
    2,
    { normalAt, aoAt: (p) => aoAt(p) * CORE_SHADE, swayAt: (p) => SWAY.conifer * 0.3 * p[1] },
    0.2,
  );
  // Underside disc closes the cone seen from below.
  {
    const c = g.vertex([0, 0.03, 0], [0, -1, 0], ...lerpUv(UV_NEEDLE_MASS, 0.5, 0.5), 0.4, {
      sway: 0,
      trans: 0,
      solid: 1,
    });
    const ring: number[] = [];
    for (let s = 0; s <= coniferSegs; s++) {
      const a = (s / coniferSegs) * Math.PI * 2;
      const r = CONIFER_CORE * 0.97 * jitter[s % coniferSegs]!;
      ring.push(
        g.vertex(
          [Math.cos(a) * r, 0.03, Math.sin(a) * r],
          [0, -1, 0],
          ...lerpUv(UV_NEEDLE_MASS, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)),
          0.4,
          { sway: 0, trans: 0, solid: 1 },
        ),
      );
    }
    for (let s = 0; s < coniferSegs; s++) g.tri(c, ring[s]!, ring[s + 1]!);
  }
  const tiers = [8, 8, 8, 7, 7, 6, 5];
  tiers.forEach((n, t) => {
    const y = 0.06 + t * 0.12;
    const off = rnd() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const th = off + ((i + rnd() * 0.4) / n) * Math.PI * 2;
      const dir: V3 = [Math.cos(th), 0, Math.sin(th)];
      const rIn = 0.12 * (1 - y);
      const rOut = 0.98 * (1 - y);
      const droop = 0.05 + 0.04 * rnd();
      const a: V3 = [dir[0] * rIn, y + droop * 0.3, dir[2] * rIn];
      const b: V3 = [dir[0] * rOut, y - droop, dir[2] * rOut];
      const right = norm(sub(b, a));
      // Tilted about its length so it reads from the side as well as from above.
      const side = norm(cross([0, 1, 0], right));
      const up = norm(rotAxis(side, right, 0.75 + rnd() * 0.3));
      const hw = len3(sub(b, a)) / 2;
      const hh = 0.05 + 0.11 * (1 - y);
      card(g, {
        c: mul(add(a, b), 0.5),
        right,
        up,
        hw,
        hh,
        uv: UV_NEEDLE,
        normalAt: (p) => normalAt(p),
        aoAt,
        swayAt: (p) => SWAY.conifer * clamp01(Math.hypot(p[0], p[2]) / Math.max(0.1, 1 - y)),
        trans: 0.8,
      });
    }
  });
  // Leader: two crossed sprays standing up at the tip.
  for (const a of [0, Math.PI / 2]) {
    card(g, {
      c: [0, 0.86, 0],
      right: [0, 1, 0],
      up: [Math.cos(a), 0, Math.sin(a)],
      hw: 0.14,
      hh: 0.1,
      uv: UV_NEEDLE,
      normalAt,
      aoAt,
      swayAt: (p) => SWAY.conifer * p[1],
      trans: 0.8,
    });
  }
  // Clamp the lowest droop above the base, then fit radius and top to exactly 1.
  for (let i = 1; i < g.pos.length; i += 3) g.pos[i] = Math.max(0, g.pos[i]!);
  const e = g.extents();
  g.scale(1 / e.radius, 1 / e.maxY, 1 / e.radius);
  return g;
}

/** Trunk sides (the collider is a true cylinder: polygon radius splits the error both ways). */
const TRUNK_SIDES = 8;
const TRUNK_POLY = 2 / (1 + Math.cos(Math.PI / TRUNK_SIDES));
/**
 * Trunk profile in collider units (radius 1 = `treeTrunkRadiusOf`, y 1 = `treeTrunkHeight`): root
 * flare and a gentle taper within a few cm of the collider. Stops exactly at its top.
 */
export const TRUNK_PROFILE: readonly (readonly [number, number])[] = [
  [0, 1.06],
  [0.06, 1.0],
  [1.0, 0.95],
];

export function trunkArchetype(): FoliageGeo {
  const g = new FoliageGeo();
  const ids: number[][] = [];
  TRUNK_PROFILE.forEach(([y, r], ri) => {
    const row: number[] = [];
    for (let s = 0; s <= TRUNK_SIDES; s++) {
      const a = (s / TRUNK_SIDES) * Math.PI * 2;
      const n: V3 = [Math.cos(a), 0.1, Math.sin(a)];
      const [u, v] = lerpUv(UV_BARK, s / TRUNK_SIDES, y);
      row.push(
        g.vertex(
          [Math.cos(a) * r * TRUNK_POLY, y, Math.sin(a) * r * TRUNK_POLY],
          n,
          u,
          v,
          0.6 + 0.4 * smooth(0, 0.5, y),
          { sway: 0, trans: 0, solid: 1 },
        ),
      );
    }
    ids.push(row);
    if (ri === TRUNK_PROFILE.length - 1) {
      const top = g.vertex([0, y, 0], [0, 1, 0], ...lerpUv(UV_BARK, 0.5, 1), 0.6, {
        sway: 0,
        trans: 0,
        solid: 1,
      });
      for (let s = 0; s < TRUNK_SIDES; s++) g.tri(row[s]!, top, row[s + 1]!);
    }
  });
  for (let r = 1; r < ids.length; r++) {
    for (let s = 0; s < TRUNK_SIDES; s++) {
      g.quad(ids[r - 1]![s]!, ids[r]![s]!, ids[r]![s + 1]!, ids[r - 1]![s + 1]!);
    }
  }
  return g;
}
