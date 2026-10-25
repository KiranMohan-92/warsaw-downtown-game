/**
 * Procedural foliage atlas: leaf clusters, conifer sprays, grass blades, dense leaf and needle
 * masses and bark, painted in plain JS at load (no canvas, no downloads, nothing to
 * license) and deterministic (a seeded generator), so tests can check it byte for byte.
 *
 * Alpha-tested foliage has a classic failure at distance: box-filtered mip levels average leaf
 * and gap into mid alpha that falls under the cutoff, so canopies thin out and turn see-through
 * far away — a concealment bug, not just a look. Every mip level here is built per tile and its
 * alpha rescaled so the fraction of texels that pass `FOLIAGE_ALPHA_TEST` stays what it is at
 * full resolution (coverage-preserving mipmaps, after Castaño 2010). Opaque tiles stay opaque.
 */

/** The fragment cutoff used by every foliage material (and the mip coverage target). */
export const FOLIAGE_ALPHA_TEST = 0.5;

export const ATLAS_SIZE = 1024;

/**
 * Inset (per side) of the canopy window that repeats seamlessly: the scan bake
 * (packages/client/bake/canopy.html) is periodic every 320 of its 512 px, so bush cores tile
 * this window with no mirroring and no seams (the painted fallback is not periodic).
 */
export const CANOPY_REPEAT_INSET = 96 / 512;

export type AtlasTile = 'leaf' | 'needle' | 'blades' | 'thatch' | 'canopy' | 'bark' | 'needleMass';

/** Texel rectangles (row 0 = v 0). Power-of-two sized and aligned, so each mips on its own. */
export const ATLAS_RECTS: Readonly<
  Record<AtlasTile, { x: number; y: number; w: number; h: number }>
> = {
  leaf: { x: 0, y: 0, w: 256, h: 256 },
  needle: { x: 256, y: 0, w: 256, h: 256 },
  blades: { x: 0, y: 256, w: 256, h: 256 },
  // Big: the scanned canopy (loadCanopyScan) repeats every ~0.8 m on bush cores, seen up close.
  canopy: { x: 512, y: 0, w: 512, h: 512 },
  thatch: { x: 256, y: 384, w: 128, h: 128 },
  bark: { x: 384, y: 256, w: 64, h: 256 },
  needleMass: { x: 448, y: 256, w: 64, h: 256 },
};

/** Tiles painted with transparent gaps (the rest are opaque everywhere). */
export const ALPHA_TILES: readonly AtlasTile[] = ['leaf', 'needle', 'blades', 'thatch'];

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * UV rectangle of a tile, inset by `inset` of its size on every side (cards use a small inset so
 * bilinear filtering never reads the neighbouring tile; solid cores use a large one).
 */
export function tileUv(tile: AtlasTile, inset = 0.01): UvRect {
  const r = ATLAS_RECTS[tile];
  const ix = r.w * inset;
  const iy = r.h * inset;
  return {
    u0: (r.x + ix) / ATLAS_SIZE,
    v0: (r.y + iy) / ATLAS_SIZE,
    u1: (r.x + r.w - ix) / ATLAS_SIZE,
    v1: (r.y + r.h - iy) / ATLAS_SIZE,
  };
}

export interface AtlasLevel {
  width: number;
  height: number;
  /** RGBA8, sRGB colour, straight (not premultiplied) alpha. */
  data: Uint8Array;
}

export interface FoliageAtlas {
  /** Level 0 first, down to 1 × 1. */
  levels: AtlasLevel[];
}

// ---- deterministic randomness -------------------------------------------------------------------

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise (period p cells). */
function vnoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const m = (a: number): number => ((a % p) + p) % p;
  const a = hash2(m(xi), m(yi), seed);
  const b = hash2(m(xi + 1), m(yi), seed);
  const c = hash2(m(xi), m(yi + 1), seed);
  const d = hash2(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---- painting (premultiplied float RGBA, colours in sRGB 0..1) ---------------------------------

type Rgb = readonly [number, number, number];

class Canvas {
  /** Premultiplied RGBA. */
  readonly px: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Float32Array(w * h * 4);
  }
  /** Source-over one pixel with coverage `a`. */
  over(x: number, y: number, c: Rgb, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const k = 1 - a;
    const p = this.px;
    p[i] = c[0] * a + p[i]! * k;
    p[i + 1] = c[1] * a + p[i + 1]! * k;
    p[i + 2] = c[2] * a + p[i + 2]! * k;
    p[i + 3] = a + p[i + 3]! * k;
  }
  private scratchBufs: { cov: Float32Array; arc: Float32Array; touched: number[] } | null = null;
  /** Per-stroke scratch (coverage and arc position per pixel, kept zeroed between strokes). */
  scratch(): { cov: Float32Array; arc: Float32Array; touched: number[] } {
    this.scratchBufs ??= {
      cov: new Float32Array(this.w * this.h),
      arc: new Float32Array(this.w * this.h),
      touched: [],
    };
    return this.scratchBufs;
  }
  fill(c: Rgb): void {
    for (let i = 0; i < this.w * this.h; i++) {
      this.px.set([c[0], c[1], c[2], 1], i * 4);
    }
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const shade = (c: Rgb, k: number): Rgb => [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)];
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgb = (r: number, g: number, b: number): Rgb => [r / 255, g / 255, b / 255];

/**
 * A leaf: pointed ellipse from `(x, y)` along `angle`, `len` long, `wid` wide, with a lit edge
 * gradient and a darker midrib. 1-pixel analytic antialiasing.
 */
function paintLeaf(
  cv: Canvas,
  x: number,
  y: number,
  angle: number,
  len: number,
  wid: number,
  c: Rgb,
): void {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const pad = wid / 2 + 2;
  const tx = x + dx * len;
  const ty = y + dy * len;
  const x0 = Math.max(0, Math.floor(Math.min(x, tx) - pad));
  const x1 = Math.min(cv.w - 1, Math.ceil(Math.max(x, tx) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(y, ty) - pad));
  const y1 = Math.min(cv.h - 1, Math.ceil(Math.max(y, ty) + pad));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const ox = px + 0.5 - x;
      const oy = py + 0.5 - y;
      const u = ox * dx + oy * dy;
      const v = -ox * dy + oy * dx;
      if (u < -1 || u > len + 1) continue;
      const t = clamp01(u / len);
      const half = wid * 0.5 * Math.pow(Math.sin(Math.PI * t), 0.75);
      const cov = clamp01(half - Math.abs(v) + 0.5) * clamp01(Math.min(u + 0.5, len - u + 0.5));
      if (cov <= 0) continue;
      const across = half > 0 ? Math.abs(v) / half : 1;
      const rib = across < 0.12 && t > 0.05 && t < 0.9 ? 0.82 : 1;
      const k = (0.8 + 0.28 * (1 - across) + 0.12 * t) * rib;
      cv.over(px, py, shade(c, k), cov);
    }
  }
}

/** A tapered stroke (twig, needle, blade) along a polyline, width `w0` → `w1`. */
function paintStroke(
  cv: Canvas,
  pts: readonly (readonly [number, number])[],
  w0: number,
  w1: number,
  c0: Rgb,
  c1: Rgb,
): void {
  let total = 0;
  const segLen: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    segLen.push(l);
    total += l;
  }
  // Per segment (only its own bounding box), keep each pixel's best coverage, then composite
  // the stroke once: overlapping segments never double-paint a pixel.
  const { cov, arc, touched } = cv.scratch();
  const pad = Math.max(w0, w1) / 2 + 2;
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const ex = bx - ax;
    const ey = by - ay;
    const l2 = ex * ex + ey * ey || 1;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad));
    const x1 = Math.min(cv.w - 1, Math.ceil(Math.max(ax, bx) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad));
    const y1 = Math.min(cv.h - 1, Math.ceil(Math.max(ay, by) + pad));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5;
        const qy = py + 0.5;
        const t = clamp01(((qx - ax) * ex + (qy - ay) * ey) / l2);
        const d = Math.hypot(qx - ax - ex * t, qy - ay - ey * t);
        const s = total > 0 ? (run + segLen[i - 1]! * t) / total : 0;
        const c = clamp01((w0 + (w1 - w0) * s) * 0.5 - d + 0.5);
        const idx = py * cv.w + px;
        if (c > cov[idx]!) {
          if (cov[idx] === 0) touched.push(idx);
          cov[idx] = c;
          arc[idx] = s;
        }
      }
    }
    run += segLen[i - 1]!;
  }
  for (const idx of touched) {
    cv.over(idx % cv.w, Math.floor(idx / cv.w), mixRgb(c0, c1, arc[idx]!), cov[idx]!);
    cov[idx] = 0;
  }
  touched.length = 0;
}

// ---- tiles -----------------------------------------------------------------------------------

const LEAF_GREENS: Rgb[] = [
  rgb(92, 140, 40),
  rgb(70, 118, 34),
  rgb(118, 156, 48),
  rgb(58, 102, 34),
];
const TWIG = rgb(84, 66, 48);

/** Broadleaf cluster: twigs fanning up from the bottom centre, leaves along them. */
function leafTile(cv: Canvas, rnd: () => number): void {
  const cx = cv.w / 2;
  const twigs = 6;
  for (let t = 0; t < twigs; t++) {
    const a = Math.PI / 2 + (t / (twigs - 1) - 0.5) * 2.2 + (rnd() - 0.5) * 0.25;
    const L = cv.h * (0.34 + rnd() * 0.12);
    const bx = cx + (rnd() - 0.5) * 10;
    const by = cv.h * 0.1;
    const ex = bx + Math.cos(a) * L;
    const ey = by + Math.sin(a) * L;
    paintStroke(
      cv,
      [
        [cx, 4],
        [bx, by],
        [ex, ey],
      ],
      4,
      1.5,
      TWIG,
      TWIG,
    );
    const n = 7;
    for (let i = 0; i < n; i++) {
      const s = 0.25 + (i / n) * 0.8;
      const px = bx + (ex - bx) * s;
      const py = by + (ey - by) * s;
      for (const side of [-1, 1]) {
        const la = a + side * (0.55 + rnd() * 0.5);
        const len = 30 + rnd() * 22;
        paintLeaf(
          cv,
          px,
          py,
          la,
          len,
          len * (0.42 + rnd() * 0.12),
          LEAF_GREENS[Math.floor(rnd() * 4)]!,
        );
      }
    }
    paintLeaf(cv, ex, ey, a + (rnd() - 0.5) * 0.3, 34 + rnd() * 14, 18, LEAF_GREENS[0]!);
  }
}

const NEEDLE_DARK = rgb(28, 62, 40);
const NEEDLE_LIGHT = rgb(70, 116, 60);

/** Conifer spray: a branch along u (left = trunk side), needles swept towards the tip. */
function needleTile(cv: Canvas, rnd: () => number): void {
  const mid = cv.h / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const x = 4 + (i / 8) * (cv.w - 12);
    pts.push([x, mid + Math.sin(i * 0.7) * 3]);
  }
  paintStroke(cv, pts, 5, 1.5, TWIG, TWIG);
  // Side shoots.
  for (let s = 0; s < 7; s++) {
    const t = 0.12 + s * 0.12;
    const bx = 4 + t * (cv.w - 12);
    const side = s % 2 ? 1 : -1;
    const reach = (1 - t) * cv.h * 0.38 + 18;
    const ex = bx + reach * 0.7;
    const ey = mid + side * reach * 0.7;
    paintStroke(
      cv,
      [
        [bx, mid],
        [ex, ey],
      ],
      2.5,
      1,
      TWIG,
      TWIG,
    );
    for (let k = 0; k < 14; k++) {
      const q = k / 14;
      const nx = bx + (ex - bx) * q;
      const ny = mid + (ey - mid) * q;
      for (const d of [-1, 1]) {
        const a = Math.atan2(ey - mid, ex - bx) + d * (0.8 + rnd() * 0.3);
        const len = (18 + rnd() * 10) * (1 - q * 0.4);
        paintStroke(
          cv,
          [
            [nx, ny],
            [nx + Math.cos(a) * len, ny + Math.sin(a) * len],
          ],
          3.4,
          1.4,
          NEEDLE_DARK,
          NEEDLE_LIGHT,
        );
      }
    }
  }
  // Needles along the main branch.
  for (let k = 0; k < 80; k++) {
    const q = k / 80;
    const nx = 4 + q * (cv.w - 12);
    for (const d of [-1, 1]) {
      const a = d * (0.9 + rnd() * 0.35);
      const len = (30 + rnd() * 12) * (1 - q * 0.5);
      paintStroke(
        cv,
        [
          [nx, mid],
          [nx + Math.cos(a) * len, mid + Math.sin(a) * len],
        ],
        3.6,
        1.4,
        NEEDLE_DARK,
        NEEDLE_LIGHT,
      );
    }
  }
}

const BLADE_ROOT = rgb(46, 66, 28);
const BLADE_TIP = rgb(150, 164, 76);

function blade(cv: Canvas, rnd: () => number, x: number, y0: number, top: number, w: number): void {
  const lean = (rnd() - 0.5) * cv.w * 0.35;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push([x + lean * t * t, y0 + (top - y0) * t]);
  }
  const tip = mixRgb(BLADE_TIP, rgb(120, 150, 60), rnd());
  paintStroke(cv, pts, w, 0.8, BLADE_ROOT, tip);
}

/**
 * Tall grass card: a dense tuft (near-solid low down, where it hides a crouched body) thinning
 * into separate blade tips, 45–100 % of the height.
 */
function bladesTile(cv: Canvas, rnd: () => number): void {
  const n = 64;
  for (let i = 0; i < n; i++) {
    const x = cv.w * (0.04 + 0.92 * ((i + rnd()) / n));
    blade(cv, rnd, x, 0, cv.h * (0.45 + rnd() * 0.53), 7 + rnd() * 5);
  }
}

/**
 * Grass thatch (tall-grass clump wall): a dense tuft, opaque over the lower ~70 % (where the
 * clump's solid core sits) and breaking into ragged blade tips above it.
 */
function thatchTile(cv: Canvas, rnd: () => number): void {
  const base = cv.h * 0.72;
  for (let y = 0; y < Math.ceil(base); y++) {
    for (let x = 0; x < cv.w; x++) {
      const v = y / base;
      const u = x / cv.w;
      const blade = vnoise(u * 52, v * 1.4, 52, 9);
      const fine = vnoise(u * 96, v * 7, 96, 11);
      const groove = blade > 0.58 ? 1.16 : blade < 0.26 ? 0.72 : 0.95;
      const k = (0.5 + 0.5 * Math.pow(v, 0.8) + 0.18 * fine) * groove;
      const straw = mixRgb(BLADE_ROOT, BLADE_TIP, 0.12 + 0.58 * Math.pow(v, 1.15));
      cv.over(x, y, shade(straw, k), 1);
    }
  }
  const n = 72;
  for (let i = 0; i < n; i++) {
    const x = cv.w * ((i + rnd()) / n);
    blade(cv, rnd, x, cv.h * (0.2 + rnd() * 0.3), cv.h * (0.76 + rnd() * 0.23), 4 + rnd() * 3);
  }
}

/** Dense canopy (opaque): dark leaf mass with overlapping lit leaves. */
function canopyTile(cv: Canvas, rnd: () => number): void {
  // Fallback for the scanned canopy (loadCanopyScan): painted at 128 px and upscaled, so the
  // big tile costs no more to build than it used to.
  const small = new Canvas(128, 128);
  small.fill(rgb(30, 54, 20));
  for (let i = 0; i < 700; i++) {
    const c = shade(LEAF_GREENS[Math.floor(rnd() * 4)]!, 0.6 + rnd() * 0.55);
    const len = 11 + rnd() * 9;
    paintLeaf(small, rnd() * small.w, rnd() * small.h, rnd() * Math.PI * 2, len, len * 0.5, c);
  }
  upscale(small, cv);
}

/** Bilinear upscale of a (premultiplied, wrapping) canvas into a larger one. */
function upscale(src: Canvas, dst: Canvas): void {
  for (let y = 0; y < dst.h; y++) {
    const fy = ((y + 0.5) * src.h) / dst.h - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < dst.w; x++) {
      const fx = ((x + 0.5) * src.w) / dst.w - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const o = (y * dst.w + x) * 4;
      const xa = (x0 + src.w) % src.w;
      const xb = (x0 + 1) % src.w;
      const ra = ((y0 + src.h) % src.h) * src.w;
      const rb = ((y0 + 1) % src.h) * src.w;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      for (let c = 0; c < 4; c++) {
        dst.px[o + c] =
          src.px[(ra + xa) * 4 + c]! * w00 +
          src.px[(ra + xb) * 4 + c]! * w10 +
          src.px[(rb + xa) * 4 + c]! * w01 +
          src.px[(rb + xb) * 4 + c]! * w11;
      }
    }
  }
}

/** Dense needle mass (opaque; conifer core): short needle strokes over dark shade. */
function needleMassTile(cv: Canvas, rnd: () => number): void {
  cv.fill(rgb(22, 44, 30));
  for (let i = 0; i < 900; i++) {
    const x = rnd() * cv.w;
    const y = rnd() * cv.h;
    // Needles droop: mostly downward-sloping strokes.
    const a = -Math.PI / 2 + (rnd() - 0.5) * 1.6;
    const len = 6 + rnd() * 8;
    const k = 0.55 + rnd() * 0.6;
    paintStroke(
      cv,
      [
        [x, y],
        [x + Math.cos(a) * len, y + Math.sin(a) * len],
      ],
      2,
      1,
      shade(NEEDLE_DARK, k),
      shade(NEEDLE_LIGHT, k),
    );
  }
}

/** Bark (opaque): vertical furrows. */
function barkTile(cv: Canvas): void {
  const base = rgb(98, 80, 62);
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const u = x / cv.w;
      const v = y / cv.h;
      const furrow = vnoise(u * 12, v * 3, 12, 7) * 0.65 + vnoise(u * 24, v * 10, 24, 8) * 0.35;
      const k = 0.55 + 0.6 * Math.pow(furrow, 1.4);
      const c = shade(base, k);
      const i = (y * cv.w + x) * 4;
      cv.px.set([c[0], c[1], c[2], 1], i);
    }
  }
}

// ---- mips ------------------------------------------------------------------------------------

interface FloatLevel {
  w: number;
  h: number;
  /** Premultiplied RGBA, alpha unscaled (true box-filtered coverage). */
  px: Float32Array;
}

function downsample(src: FloatLevel): FloatLevel {
  const w = Math.max(1, src.w >> 1);
  const h = Math.max(1, src.h >> 1);
  const px = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(src.w - 1, x * 2 + dx);
          const sy = Math.min(src.h - 1, y * 2 + dy);
          const i = (sy * src.w + sx) * 4;
          for (let c = 0; c < 4; c++) px[o + c] = px[o + c]! + src.px[i + c]!;
          n++;
        }
      }
      for (let c = 0; c < 4; c++) px[o + c] = px[o + c]! / n;
    }
  }
  return { w, h, px };
}

/** Fraction of texels whose alpha × `scale` passes the cutoff. */
function coverage(lv: FloatLevel, scale: number): number {
  let n = 0;
  const count = lv.w * lv.h;
  for (let i = 0; i < count; i++) if (lv.px[i * 4 + 3]! * scale >= FOLIAGE_ALPHA_TEST) n++;
  return n / count;
}

/** Alpha scale that keeps `target` coverage (binary search; ≥ 1, so gaps never widen). */
function coverageScale(lv: FloatLevel, target: number): number {
  if (coverage(lv, 1) >= target) return 1;
  let lo = 1;
  let hi = 64;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (coverage(lv, mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Straight-alpha sRGB bytes; fully transparent texels take `fillColour` (no dark fringes). */
function toBytes(
  lv: FloatLevel,
  scale: number,
  fillColour: Rgb,
  out: Uint8Array,
  outW: number,
  ox: number,
  oy: number,
): void {
  for (let y = 0; y < lv.h; y++) {
    for (let x = 0; x < lv.w; x++) {
      const i = (y * lv.w + x) * 4;
      const a = lv.px[i + 3]!;
      const o = ((oy + y) * outW + ox + x) * 4;
      for (let c = 0; c < 3; c++) {
        const straight = a > 1e-4 ? lv.px[i + c]! / a : fillColour[c]!;
        // Blend faint edge texels towards the tile colour: their straight colour is noisy.
        const t = clamp01(a * 4);
        out[o + c] = Math.round(clamp01(fillColour[c]! + (straight - fillColour[c]!) * t) * 255);
      }
      out[o + 3] = Math.round(clamp01(a * scale) * 255);
    }
  }
}

/** Mean straight colour of the covered texels (fill for gaps). */
function meanColour(lv: FloatLevel): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < lv.w * lv.h; i++) {
    r += lv.px[i * 4]!;
    g += lv.px[i * 4 + 1]!;
    b += lv.px[i * 4 + 2]!;
    a += lv.px[i * 4 + 3]!;
  }
  return a > 0 ? [r / a, g / a, b / a] : [0.3, 0.4, 0.2];
}

/** Paint every tile and build the coverage-preserving mip chain (deterministic for a seed). */
export function buildFoliageAtlas(seed = 1): FoliageAtlas {
  const paint: Record<AtlasTile, (cv: Canvas, rnd: () => number) => void> = {
    leaf: leafTile,
    needle: needleTile,
    blades: bladesTile,
    thatch: thatchTile,
    canopy: canopyTile,
    bark: (cv) => barkTile(cv),
    needleMass: needleMassTile,
  };
  const levelCount = Math.log2(ATLAS_SIZE) + 1;
  const levels: AtlasLevel[] = [];
  for (let k = 0; k < levelCount; k++) {
    const s = ATLAS_SIZE >> k;
    levels.push({ width: s, height: s, data: new Uint8Array(s * s * 4) });
  }
  const tileLevels = atlasTileLevels();
  (Object.keys(ATLAS_RECTS) as AtlasTile[]).forEach((tile, ti) => {
    const r = ATLAS_RECTS[tile];
    const cv = new Canvas(r.w, r.h);
    paint[tile](cv, rng(seed * 1000 + ti * 97 + 13));
    let lv: FloatLevel = { w: r.w, h: r.h, px: cv.px };
    const fill = meanColour(lv);
    const target = coverage(lv, 1);
    for (let k = 0; k < tileLevels; k++) {
      if (k > 0) lv = downsample(lv);
      const scale = k === 0 ? 1 : coverageScale(lv, target);
      const L = levels[k]!;
      toBytes(lv, scale, fill, L.data, L.width, r.x >> k, r.y >> k);
    }
  });
  finishAtlasMips(levels, tileLevels);
  return { levels };
}

/** Tiles mip on their own while they are at least 1 texel; below that, the whole atlas does. */
function atlasTileLevels(): number {
  let n = Math.log2(ATLAS_SIZE) + 1;
  for (const r of Object.values(ATLAS_RECTS)) n = Math.min(n, Math.log2(Math.min(r.w, r.h)) + 1);
  return n;
}

/** Whole-atlas mips from `from` down to 1 × 1 (each from the level above). */
function finishAtlasMips(levels: AtlasLevel[], from: number): void {
  for (let k = from; k < levels.length; k++) {
    const prev = levels[k - 1]!;
    const src: FloatLevel = {
      w: prev.width,
      h: prev.height,
      px: new Float32Array(prev.data.length),
    };
    for (let i = 0; i < prev.data.length; i += 4) {
      const a = prev.data[i + 3]! / 255;
      for (let c = 0; c < 3; c++) src.px[i + c] = (prev.data[i + c]! / 255) * a;
      src.px[i + 3] = a;
    }
    const lv = downsample(src);
    toBytes(lv, 1, meanColour(lv), levels[k]!.data, levels[k]!.width, 0, 0);
  }
}

/**
 * Replace an opaque tile (and its mips) with an image, e.g. the scanned canopy. `rgba` is
 * sRGB RGBA8 exactly the tile's size. Mutates `levels` in place (the texture just re-uploads).
 */
export function writeOpaqueTile(
  levels: AtlasLevel[],
  tile: AtlasTile,
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const r = ATLAS_RECTS[tile];
  if (ALPHA_TILES.includes(tile)) throw new Error(`${tile} is alpha-tested, not opaque`);
  if (width !== r.w || height !== r.h || rgba.length !== width * height * 4) {
    throw new Error(`${tile} needs ${r.w}×${r.h} RGBA, got ${width}×${height}`);
  }
  let lv: FloatLevel = { w: width, h: height, px: new Float32Array(width * height * 4) };
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) lv.px[i * 4 + c] = rgba[i * 4 + c]! / 255;
    lv.px[i * 4 + 3] = 1;
  }
  const fill = meanColour(lv);
  const tileLevels = atlasTileLevels();
  for (let k = 0; k < tileLevels; k++) {
    if (k > 0) lv = downsample(lv);
    toBytes(lv, 1, fill, levels[k]!.data, levels[k]!.width, r.x >> k, r.y >> k);
  }
  finishAtlasMips(levels, tileLevels);
}

/** Fraction of a tile's texels at mip `level` that pass the alpha test (tests, tuning). */
export function tileCoverage(atlas: FoliageAtlas, tile: AtlasTile, level: number): number {
  const r = ATLAS_RECTS[tile];
  const L = atlas.levels[level]!;
  const w = Math.max(1, r.w >> level);
  const h = Math.max(1, r.h >> level);
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = L.data[(((r.y >> level) + y) * L.width + (r.x >> level) + x) * 4 + 3]! / 255;
      if (a >= FOLIAGE_ALPHA_TEST) n++;
    }
  }
  return n / (w * h);
}
