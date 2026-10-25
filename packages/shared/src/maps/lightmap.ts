import { PROP_GEOMETRY_HASH } from './propModels.ts';
/**
 * Baked-lighting layout (the "COD Mobile trick": static lighting precomputed offline, sampled
 * for free at runtime). Pure and deterministic: the Node baker (`tools/bake`) and the browser
 * (`client/render/mapMesh.ts`, which emits `uv1`) compute the *same* layout from the same map, and
 * a hash of it ties the baked PNGs to the geometry they were baked for.
 *
 * Two textures per baked map:
 * - **Ground** — a top-down planar projection of the street level (the slab tops and every ground
 *   marking/flat that lies on them). Flats overlap the slab, so one shared world-space projection
 *   keeps them seamless; the texture's border is white so anything projected outside the baked
 *   region (clamp-to-edge) reads as unoccluded.
 * - **Atlas** — one rectangle per planar face of every other static prism/box face near the play
 *   area (walls, roofs, box sides, the metro). Faces of convex prisms and boxes are planar
 *   rectangles/convex polygons, so "unwrapping" is just choosing a face frame. Faces outside the
 *   baked region map to a reserved white texel.
 *
 * Texel coordinates: x right, y down (PNG row order); the runtime uploads with `flipY = false`, so
 * uv = (texel x / width, texel y / height).
 */
import { quatFromEulerDeg, rotateByQuat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { Pt } from './geom.ts';
import type { BakedLampVolume } from './lampVolume.ts';
import type { Bounds, MapBox, MapDefinition, MapPrism } from './types.ts';

/** Bump when the layout algorithm changes (invalidates every bake). */
export const LIGHTMAP_LAYOUT_VERSION = 1;

export interface LightmapParams {
  /** Atlas faces: metres per texel (finest). */
  texel: number;
  /** Ground projection: metres per texel. */
  groundTexel: number;
  /** Largest atlas rect side in texels: bigger faces get proportionally coarser texels. */
  maxRect: number;
  /** Padding texels on every side of an atlas rect (filled by dilation; bilinear-safe). */
  gutter: number;
  /** Atlas faces are baked when they touch the play bounds grown by this much (m). */
  margin: number;
  /** The ground projection covers the play bounds grown by this much (m). */
  groundMargin: number;
  /** Atlas width in texels (height grows to fit, rounded up to a multiple of 4). */
  atlasWidth: number;
  /** Refuse layouts taller than this (texture size limit on weak GPUs). */
  maxAtlasHeight: number;
}

export const LIGHTMAP_PARAMS: LightmapParams = {
  texel: 0.25,
  groundTexel: 0.25,
  maxRect: 256,
  gutter: 1,
  margin: 6,
  groundMargin: 8,
  atlasWidth: 2048,
  maxAtlasHeight: 4096,
};

/**
 * One baked face: an affine frame from texel space to the world. World point of texel coordinate
 * (x + i, y + j) (continuous, interior rect) is `o + u * i * su + v * j * sv`; its outward normal is
 * `n`. The face spans exactly the interior rect (per-axis texel sizes fit it exactly).
 */
export interface LightmapRect {
  o: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
  /** Metres per texel along u / v. */
  su: number;
  sv: number;
  /** Interior rect in texels (gutters lie outside it). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LightmapLayout {
  params: LightmapParams;
  /** Baked region (play bounds + margin). */
  region: Bounds;
  atlas: {
    width: number;
    height: number;
    rects: LightmapRect[];
    /** Texel-space centre of the reserved white block (unbaked faces). */
    white: { x: number; y: number };
  };
  /** Ground projection: one rect covering the whole ground texture (x = y = 0). */
  ground: { width: number; height: number; rect: LightmapRect; bounds: Bounds };
  /** Per box: 6 atlas rect indices in `BOX_FACES` order, −1 = unbaked (white). */
  boxFaces: Int32Array;
  /**
   * Per prism: `pts.length` walls (edge i → i+1), then top, then bottom. −1 = unbaked, −2 = the
   * ground projection (street-slab tops). Null = prism not baked at all (backdrop, invisible).
   */
  prismFaces: (Int32Array | null)[];
  /** Hash of everything above: the PNGs are valid only for a layout with this hash. */
  hash: string;
}

/** Box faces: normal, u, v in box space (the renderer's face order and winding). */
export const BOX_FACES: readonly { n: Vec3; u: Vec3; v: Vec3 }[] = [
  { n: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 } },
  { n: { x: 0, y: -1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  { n: { x: 0, y: 0, z: 1 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 0, z: -1 }, u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
];

/** Wall edges shorter than this get no geometry (mirrors the renderer). */
export const MIN_WALL_EDGE = 1e-4;

/** Street-slab pieces: top at street level, body below (their top is the ground projection). */
export const isSlabPrism = (p: MapPrism): boolean => p.y1 <= 0.001 && p.y0 < 0;

/** Whether the renderer draws a prism's bottom cap (overhangs, tunnel ceilings). */
export const prismHasBottom = (p: MapPrism): boolean => p.y0 > 0.05 || isSlabPrism(p);

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const halfAlong = (size: Vec3, axis: Vec3): number =>
  Math.abs(axis.x) * size.x * 0.5 +
  Math.abs(axis.y) * size.y * 0.5 +
  Math.abs(axis.z) * size.z * 0.5;

/** Continuous texel coordinate of world point `p` on `rect`. */
export function rectTexel(rect: LightmapRect, p: Vec3): [number, number] {
  const d = { x: p.x - rect.o.x, y: p.y - rect.o.y, z: p.z - rect.o.z };
  return [rect.x + dot(d, rect.u) / rect.su, rect.y + dot(d, rect.v) / rect.sv];
}

/** Texture uv (flipY = false) of world point `p` on `rect` in a `width × height` texture. */
export function rectUv(
  rect: LightmapRect,
  p: Vec3,
  width: number,
  height: number,
): [number, number] {
  const [tx, ty] = rectTexel(rect, p);
  return [tx / width, ty / height];
}

/** World point at continuous interior texel coordinate (i, j) of `rect` (0..w, 0..h). */
export function rectWorld(rect: LightmapRect, i: number, j: number): Vec3 {
  const a = i * rect.su;
  const b = j * rect.sv;
  return {
    x: rect.o.x + rect.u.x * a + rect.v.x * b,
    y: rect.o.y + rect.u.y * a + rect.v.y * b,
    z: rect.o.z + rect.u.z * a + rect.v.z * b,
  };
}

/** Quantise before rounding up so float noise (1e-12) never flips a texel count. */
const texels = (metres: number, perTexel: number): number =>
  Math.max(1, Math.ceil(Math.round((metres / perTexel) * 1e4) / 1e4));

/** A face frame before packing (w/h chosen from the face size). */
interface Pending {
  frame: Omit<LightmapRect, 'x' | 'y'>;
  /** Stable key for ordering ties (the order faces were enumerated). */
  seq: number;
  assign: (rectIndex: number) => void;
}

function sizeFace(
  params: LightmapParams,
  o: Vec3,
  u: Vec3,
  v: Vec3,
  n: Vec3,
  lu: number,
  lv: number,
): Omit<LightmapRect, 'x' | 'y'> {
  const s = Math.max(params.texel, Math.max(lu, lv) / params.maxRect);
  const w = Math.min(params.maxRect, texels(lu, s));
  const h = Math.min(params.maxRect, texels(lv, s));
  return { o, u, v, n, su: lu / w, sv: lv / h, w, h };
}

const intersects = (a: Bounds, x0: number, x1: number, z0: number, z1: number): boolean =>
  x1 >= a.minX && x0 <= a.maxX && z1 >= a.minZ && z0 <= a.maxZ;

const grow = (b: Bounds, m: number): Bounds => ({
  minX: b.minX - m,
  maxX: b.maxX + m,
  minZ: b.minZ - m,
  maxZ: b.maxZ + m,
});

/** Box faces as frames (corners of face f = o + u·[0, lu] + v·[0, lv]). */
export function boxFaceFrame(
  b: MapBox,
  f: number,
): { o: Vec3; u: Vec3; v: Vec3; n: Vec3; lu: number; lv: number } {
  const face = BOX_FACES[f]!;
  const q = quatFromEulerDeg(b.rot);
  const hn = halfAlong(b.size, face.n);
  const hu = halfAlong(b.size, face.u);
  const hv = halfAlong(b.size, face.v);
  const n = rotateByQuat(face.n, q);
  const u = rotateByQuat(face.u, q);
  const v = rotateByQuat(face.v, q);
  const o = {
    x: b.center.x + n.x * hn - u.x * hu - v.x * hv,
    y: b.center.y + n.y * hn - u.y * hu - v.y * hv,
    z: b.center.z + n.z * hn - u.z * hu - v.z * hv,
  };
  return { o, u, v, n, lu: 2 * hu, lv: 2 * hv };
}

/**
 * Horizontal convex cap: the minimum-area rectangle aligned with one of its edges (rotating
 * calipers over edges), so slanted footprints don't waste half their texels.
 */
function capFrame(
  pts: readonly Pt[],
  y: number,
  up: boolean,
): { o: Vec3; u: Vec3; v: Vec3; n: Vec3; lu: number; lv: number } | null {
  let best: { ux: number; uz: number; area: number } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < MIN_WALL_EDGE) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, z] of pts) {
      const pu = x * ux + z * uz;
      const pv = x * uz - z * ux;
      u0 = Math.min(u0, pu);
      u1 = Math.max(u1, pu);
      v0 = Math.min(v0, pv);
      v1 = Math.max(v1, pv);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) best = { ux, uz, area };
  }
  if (!best) return null;
  const n = { x: 0, y: up ? 1 : -1, z: 0 };
  const u = { x: best.ux, y: 0, z: best.uz };
  // v = n × u keeps (u, v, n) right-handed for either cap.
  const v = up ? { x: best.uz, y: 0, z: -best.ux } : { x: -best.uz, y: 0, z: best.ux };
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [x, z] of pts) {
    const pu = x * u.x + z * u.z;
    const pv = x * v.x + z * v.z;
    u0 = Math.min(u0, pu);
    u1 = Math.max(u1, pu);
    v0 = Math.min(v0, pv);
    v1 = Math.max(v1, pv);
  }
  if (u1 - u0 < 1e-6 || v1 - v0 < 1e-6) return null;
  const o = { x: u.x * u0 + v.x * v0, y, z: u.z * u0 + v.z * v0 };
  return { o, u, v, n, lu: u1 - u0, lv: v1 - v0 };
}

/**
 * The layout, or null when the map's surfaces don't fit the atlas (the whole Plac Defilad block
 * and its halves are far larger than the baked Market). For "does this bake apply here?" checks:
 * a map that can't have a layout simply has no bake, it must still load (unbaked).
 */
export function tryBuildLightmapLayout(
  map: MapDefinition,
  params: LightmapParams = LIGHTMAP_PARAMS,
): LightmapLayout | null {
  try {
    return buildLightmapLayout(map, params);
  } catch {
    return null;
  }
}

/**
 * Deterministic lightmap layout for a resolved map. Same input → identical output (and hash) in
 * Node and the browser: only IEEE arithmetic, stable sorts, and quantised sizes.
 */
export function buildLightmapLayout(
  map: MapDefinition,
  params: LightmapParams = LIGHTMAP_PARAMS,
): LightmapLayout {
  const region = grow(map.bounds, params.margin);
  const pending: Pending[] = [];
  let seq = 0;

  const boxFaces = new Int32Array(map.boxes.length * 6).fill(-1);
  map.boxes.forEach((b, bi) => {
    if (b.visible === false) return;
    for (let f = 0; f < 6; f++) {
      const fr = boxFaceFrame(b, f);
      if (fr.lu < 1e-6 || fr.lv < 1e-6) continue;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const [a, c] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const x = fr.o.x + fr.u.x * fr.lu * a + fr.v.x * fr.lv * c;
        const z = fr.o.z + fr.u.z * fr.lu * a + fr.v.z * fr.lv * c;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      if (!intersects(region, x0, x1, z0, z1)) continue;
      const slot = bi * 6 + f;
      pending.push({
        frame: sizeFace(params, fr.o, fr.u, fr.v, fr.n, fr.lu, fr.lv),
        seq: seq++,
        assign: (r) => {
          boxFaces[slot] = r;
        },
      });
    }
  });

  const prisms = map.prisms ?? [];
  const prismFaces: (Int32Array | null)[] = prisms.map((p) => {
    if (p.backdrop || p.visible === false) return null;
    const n = p.pts.length;
    const faces = new Int32Array(n + 2).fill(-1);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of p.pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    // Slab tops are the ground projection wherever they are (outside the region it reads white).
    if (isSlabPrism(p)) faces[n] = -2;
    if (!intersects(region, x0, x1, z0, z1)) return faces;
    const h = p.y1 - p.y0;
    for (let i = 0; i < n; i++) {
      const a = p.pts[i]!;
      const b = p.pts[(i + 1) % n]!;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < MIN_WALL_EDGE || h < 1e-6) continue;
      if (
        !intersects(
          region,
          Math.min(a[0], b[0]),
          Math.max(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[1], b[1]),
        )
      )
        continue;
      const u = { x: dx / len, y: 0, z: dz / len };
      const nn = { x: dz / len, y: 0, z: -dx / len };
      const slot = i;
      pending.push({
        frame: sizeFace(params, { x: a[0], y: p.y0, z: a[1] }, u, { x: 0, y: 1, z: 0 }, nn, len, h),
        seq: seq++,
        assign: (r) => {
          faces[slot] = r;
        },
      });
    }
    const caps: [number, number, boolean][] = [];
    if (!isSlabPrism(p)) caps.push([n, p.y1, true]);
    if (prismHasBottom(p)) caps.push([n + 1, p.y0, false]);
    for (const [slot, y, up] of caps) {
      const fr = capFrame(p.pts, y, up);
      if (!fr) continue;
      pending.push({
        frame: sizeFace(params, fr.o, fr.u, fr.v, fr.n, fr.lu, fr.lv),
        seq: seq++,
        assign: (r) => {
          faces[slot] = r;
        },
      });
    }
    return faces;
  });

  // ---- shelf packing: tallest first, stable ------------------------------------------------------
  const g = params.gutter;
  const W = params.atlasWidth;
  pending.sort((a, b) => b.frame.h - a.frame.h || b.frame.w - a.frame.w || a.seq - b.seq);
  const rects: LightmapRect[] = [];
  const WHITE = 2;
  const white = { x: g + WHITE / 2, y: g + WHITE / 2 };
  let cx = WHITE + 2 * g;
  let cy = 0;
  let shelf = WHITE + 2 * g;
  for (const p of pending) {
    const fw = p.frame.w + 2 * g;
    const fh = p.frame.h + 2 * g;
    if (fw > W) throw new Error(`lightmap: face ${fw} texels wide exceeds the atlas width ${W}`);
    if (cx + fw > W) {
      cy += shelf;
      cx = 0;
      shelf = 0;
    }
    const r: LightmapRect = { ...p.frame, x: cx + g, y: cy + g };
    p.assign(rects.length);
    rects.push(r);
    cx += fw;
    shelf = Math.max(shelf, fh);
  }
  const height = Math.max(4, Math.ceil((cy + shelf) / 4) * 4);
  if (height > params.maxAtlasHeight) {
    throw new Error(`lightmap: atlas ${W}×${height} exceeds ${params.maxAtlasHeight} rows`);
  }

  // ---- ground projection ---------------------------------------------------------------------------
  const gt = params.groundTexel;
  const gb0 = grow(map.bounds, params.groundMargin);
  // Snap to the texel grid so the projection is stable under tiny bounds changes.
  const gb: Bounds = {
    minX: Math.floor(gb0.minX / gt) * gt,
    maxX: Math.ceil(gb0.maxX / gt) * gt,
    minZ: Math.floor(gb0.minZ / gt) * gt,
    maxZ: Math.ceil(gb0.maxZ / gt) * gt,
  };
  const gw = texels(gb.maxX - gb.minX, gt);
  const gh = texels(gb.maxZ - gb.minZ, gt);
  const groundRect: LightmapRect = {
    o: { x: gb.minX, y: 0, z: gb.minZ },
    u: { x: 1, y: 0, z: 0 },
    v: { x: 0, y: 0, z: 1 },
    n: { x: 0, y: 1, z: 0 },
    su: (gb.maxX - gb.minX) / gw,
    sv: (gb.maxZ - gb.minZ) / gh,
    x: 0,
    y: 0,
    w: gw,
    h: gh,
  };

  const layout: Omit<LightmapLayout, 'hash'> = {
    params,
    region,
    atlas: { width: W, height, rects, white },
    ground: { width: gw, height: gh, rect: groundRect, bounds: gb },
    boxFaces,
    prismFaces,
  };
  return { ...layout, hash: layoutHash(layout) };
}

// ---- hashing -----------------------------------------------------------------------------------------

/** cyrb53: fast, well-mixed 53-bit string hash (hex). Deterministic across engines. */
export function hashString(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Millimetre quantisation: engines may differ in the last bits of sin/cos, never by 0.5 mm. */
const q = (x: number): string => (Math.round(x * 1000) / 1000).toString();
const qv = (v: Vec3): string => `${q(v.x)},${q(v.y)},${q(v.z)}`;
const qr = (r: LightmapRect): string =>
  `${r.x},${r.y},${r.w},${r.h}|${qv(r.o)}|${qv(r.u)}|${qv(r.v)}|${q(r.su * 1000)},${q(r.sv * 1000)}`;

function layoutHash(l: Omit<LightmapLayout, 'hash'>): string {
  const parts: string[] = [
    `v${LIGHTMAP_LAYOUT_VERSION}`,
    JSON.stringify(l.params),
    `${l.atlas.width}x${l.atlas.height}`,
    `${l.ground.width}x${l.ground.height}`,
    qr(l.ground.rect),
  ];
  for (const r of l.atlas.rects) parts.push(qr(r));
  parts.push(Array.from(l.boxFaces).join(','));
  for (const f of l.prismFaces) parts.push(f ? Array.from(f).join(',') : '-');
  return hashString(parts.join('\n'));
}

/**
 * Hash of the static occluders that can shade the baked region (everything within `reach` of
 * it). Changes when geometry moves even if the layout doesn't (e.g. a new tree trunk): the bake
 * is then stale but still aligned, so the runtime keeps it and warns.
 */
export function lightmapSceneHash(
  map: MapDefinition,
  layout: LightmapLayout,
  reach: number,
): string {
  const r = grow(layout.region, reach);
  const parts: string[] = [];
  for (const b of map.boxes) {
    if (b.visible === false) continue;
    const e = Math.hypot(b.size.x, b.size.y, b.size.z) / 2;
    if (!intersects(r, b.center.x - e, b.center.x + e, b.center.z - e, b.center.z + e)) continue;
    parts.push(
      `b${qv(b.center)}|${qv(b.size)}|${b.rot ? qv(b.rot) : ''}${b.model ? `|${b.model}:${PROP_GEOMETRY_HASH}` : ''}`,
    );
  }
  for (const p of map.prisms ?? []) {
    if (p.backdrop || p.visible === false) continue;
    const xs = p.pts.map((pt) => pt[0]);
    const zs = p.pts.map((pt) => pt[1]);
    if (!intersects(r, Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)))
      continue;
    parts.push(`p${q(p.y0)},${q(p.y1)}|${p.pts.map((pt) => `${q(pt[0])},${q(pt[1])}`).join(';')}`);
  }
  for (const t of map.trees ?? []) {
    if (!intersects(r, t.x, t.x, t.z, t.z)) continue;
    parts.push(`t${q(t.x)},${q(t.z)},${q(t.y ?? 0)},${q(t.height)},${t.kind}`);
  }
  // Street dressing shades like any solid (its colliders are in the bake's physics world).
  for (const d of map.decor ?? []) {
    if (!intersects(r, d.x, d.x, d.z, d.z)) continue;
    parts.push(
      `d${PROP_GEOMETRY_HASH}:${d.kind},${q(d.x)},${q(d.z)},${q(d.y ?? 0)},${q(d.rot ?? 0)}`,
    );
  }
  return hashString(parts.join('\n'));
}

// ---- baked outputs -------------------------------------------------------------------------------

/** One baked map (written by `pnpm bake`; mirrored in `lightmapManifest.ts` for the client). */
export interface BakedLightmap {
  /** Map id and size the bake is for (`resolveMap(getMap(map), size)`). */
  map: string;
  size: string;
  /** Resolved map name (how the client recognises the map it is rendering). */
  mapName: string;
  layoutHash: string;
  sceneHash: string;
  /** Files under `client/public/lightmaps/`. */
  atlas: { file: string; width: number; height: number };
  ground: { file: string; width: number; height: number };
  /** Ceiling-lamp light in the atlas layout (`encodeLamp`); absent in bakes that predate it. */
  lamps?: { file: string; width: number; height: number };
  /**
   * Ceiling-lamp irradiance volume for dynamic objects (`lampVolume.ts`); absent in bakes that
   * predate it. Validated separately (`selectLampVolume`): a stale volume is dropped on its own.
   */
  volume?: BakedLampVolume;
  bake: { samples: number; reach: number };
}

/**
 * Lamp irradiance stored per byte: t = √(E / LAMP_SCALE) (the square root spends the 8 bits on
 * the dim falloff, where banding shows). The client decodes E = t² · LAMP_SCALE.
 */
export const LAMP_SCALE = 3;
export const encodeLamp = (e: number): number =>
  Math.sqrt(Math.min(1, Math.max(0, e / LAMP_SCALE)));

export type LightmapCheck =
  { ok: true; stale: boolean; message?: string } | { ok: false; message: string };

/**
 * Can a bake be used with this layout? The layout hash must match exactly (otherwise uv1 would
 * point at the wrong texels); a scene-hash mismatch only means the lighting is out of date.
 */
export function checkBakedLightmap(
  baked: BakedLightmap,
  layout: LightmapLayout,
  sceneHash: string,
): LightmapCheck {
  if (baked.layoutHash !== layout.hash) {
    return {
      ok: false,
      message: `baked lightmap for "${baked.mapName}" is for layout ${baked.layoutHash}, the map now lays out as ${layout.hash}: skipping baked lighting (re-run \`pnpm bake\`)`,
    };
  }
  if (
    baked.atlas.width !== layout.atlas.width ||
    baked.atlas.height !== layout.atlas.height ||
    baked.ground.width !== layout.ground.width ||
    baked.ground.height !== layout.ground.height
  ) {
    return {
      ok: false,
      message: `baked lightmap for "${baked.mapName}": texture sizes differ from the layout, skipping`,
    };
  }
  if (baked.sceneHash !== sceneHash) {
    return {
      ok: true,
      stale: true,
      message: `baked lightmap for "${baked.mapName}" predates geometry changes (scene ${baked.sceneHash} → ${sceneHash}); lighting may be off near them (re-run \`pnpm bake\`)`,
    };
  }
  return { ok: true, stale: false };
}

export type BakedSelection =
  /** The map has no bake (every other map/size): render as before, silently. */
  | { kind: 'none' }
  /** A bake exists but no longer fits the map: render unbaked and warn. */
  | { kind: 'skip'; message: string }
  /** Use the bake (`warning` = usable but stale). */
  | { kind: 'use'; baked: BakedLightmap; layout: LightmapLayout; warning?: string };

/**
 * Pick the bake for a resolved map (by name) and validate it against the layout the map produces
 * *now*. The renderer calls this once at load, before shaders are compiled, so the decision never
 * causes a recompile in play.
 */
export function selectBakedLightmap(
  map: MapDefinition,
  bakes: readonly BakedLightmap[],
): BakedSelection {
  const baked = bakes.find((b) => b.mapName === map.name);
  if (!baked) return { kind: 'none' };
  let layout: LightmapLayout;
  try {
    layout = buildLightmapLayout(map);
  } catch (e) {
    return { kind: 'skip', message: `baked lightmap for "${map.name}": ${String(e)}` };
  }
  const check = checkBakedLightmap(baked, layout, lightmapSceneHash(map, layout, baked.bake.reach));
  if (!check.ok) return { kind: 'skip', message: check.message };
  return check.message
    ? { kind: 'use', baked, layout, warning: check.message }
    : { kind: 'use', baked, layout };
}
