/**
 * Ground detail: what turns a uniform field of paving into a used city square — broad tonal
 * patches, grime collecting against walls, kerbs, crates and planters, oil and gum stains, dried
 * puddle marks (glossy only while it rains), expansion joints, manhole covers out in the open,
 * drain grates along the edges and a little litter. One shader layer on the street-level
 * surfaces (same geometry, no draws, every tier alike), driven by two small textures:
 *
 * - a tileable RGBA noise (`groundNoiseData`, 128 px, sampled at two world scales);
 * - a top-down *edge mask* of the map (`buildGroundMask`, 0.5 m texels): R = nearness to
 *   anything standing on the ground (1 at a wall, 0 beyond `EDGE_REACH`), G = inside it, BA =
 *   signed contact distance/angle for the crisp foot band. Built on the CPU from the map's boxes,
 *   prisms, trees and foliage when the map is built (before warm-up; the sampler exists from the
 *   first compile, so no program is added later).
 *
 * Presentation only: nothing here reaches the sim, and it never changes what hides a player.
 * Cost: the first mask fetch also supplies broad RG; contact texels fetch the second paired plane.
 * The logical grid is unchanged. Medium keeps contact and macro noise; Low/High retain detail.
 * Skipped past ~110 m.
 */
import * as THREE from 'three';
import { rainStop, rainTime } from './rainOcclusion.ts';
import { quatFromEulerDeg, rotateByQuat, type MapDefinition, type MaterialId } from '@wd/shared';
import { architectureBudget } from './renderBudget.ts';
import {
  CONTACT_CORE,
  CONTACT_FEATHER,
  CONTACT_REACH,
  CONTACT_RANGE,
  createContactField,
  decodeContactTexel,
  encodeContactTexel,
  rasterContactPolygon,
  rasterContactDisc,
} from './groundContact.ts';

/** Surfaces that get the detail layer (only on up-facing fragments near street level). */
export const GROUND_DETAIL_SURFACES: readonly MaterialId[] = ['sidewalk', 'paving', 'asphalt'];

/** Metres from an edge over which grime fades out. */
export const EDGE_REACH = 2.5;
/** Mask texel (m); coarser only if the map would need more than `MASK_MAX` texels a side. */
export const MASK_TEXEL = 0.5;
const MASK_MAX = 1400;
/** Margin (m) around the playable bounds (visible ground beyond the edge). */
const MASK_MARGIN = 40;

// ---- noise ---------------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
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
function fbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(u * f, v * f, f, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export const NOISE_SIZE = 128;
export const STONE_CONTACT_ALBEDO = 0.65;

/**
 * Tileable noise, RGBA8 (period = the texture): R broad blotches, G spotty stains, B mid grime,
 * A puddle basins (smooth, so thresholds make round-ish patches).
 */
export function groundNoiseData(size = NOISE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = (y * size + x) * 4;
      out[i] = Math.round(fbm(u, v, 3, 4, 11) * 255);
      out[i + 1] = Math.round(fbm(u, v, 8, 3, 23) * 255);
      out[i + 2] = Math.round(fbm(u, v, 5, 4, 37) * 255);
      out[i + 3] = Math.round(fbm(u, v, 4, 2, 53) * 255);
    }
  }
  return out;
}

// ---- edge mask -----------------------------------------------------------------------------

export interface GroundMask {
  /** RGBA8, row 0 = minZ. Adjacent columns share RG and store the two nearest BA contact planes. */
  data: Uint8Array;
  width: number;
  textureWidth: number;
  height: number;
  minX: number;
  minZ: number;
  /** Metres per texel. */
  texel: number;
}

type P2 = readonly [number, number];

/** Convex hull (monotone chain) of 2D points, CCW. */
function hull(points: P2[]): P2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0)
      upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

/** Squared distance from a point to segment ab. */
function segDist2(px: number, pz: number, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2)) : 0;
  const ex = a[0] + dx * t - px;
  const ez = a[1] + dz * t - pz;
  return ex * ex + ez * ez;
}

/** Street-level footprint test: something standing on the ground between y 0.05 and 0.3. */
const onGround = (y0: number, y1: number): boolean => y0 <= 0.3 && y1 >= 0.05;

/**
 * The edge mask of a map: rasterises every visible thing standing on the street (boxes by their
 * rotated footprint, building/kerb prisms, tree trunks, bush and grass clumps), then a chamfer
 * distance transform. Low prisms (kerbs, raised beds under 0.5 m) mark only their outline: their
 * top is walkable ground and should be clean in the middle, dirty along the kerb.
 */
export function buildGroundMask(map: MapDefinition): GroundMask {
  const b = map.bounds;
  const minX = b.minX - MASK_MARGIN;
  const minZ = b.minZ - MASK_MARGIN;
  const spanX = b.maxX - b.minX + 2 * MASK_MARGIN;
  const spanZ = b.maxZ - b.minZ + 2 * MASK_MARGIN;
  const texel = Math.max(MASK_TEXEL, Math.max(spanX, spanZ) / MASK_MAX);
  const width = Math.ceil(spanX / texel);
  const height = Math.ceil(spanZ / texel);
  const inside = new Uint8Array(width * height);
  const solid = new Uint8Array(width * height); // obstacle texels (distance 0)
  const contact = createContactField();
  const grid = { width, height, minX, minZ, texel };

  const raster = (poly: P2[], outlineOnly: boolean, withContact = true): void => {
    if (poly.length < 3) return;
    if (withContact) rasterContactPolygon(grid, contact, poly);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of poly) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const i0 = Math.max(0, Math.floor((x0 - minX) / texel));
    const i1 = Math.min(width - 1, Math.floor((x1 - minX) / texel));
    const j0 = Math.max(0, Math.floor((z0 - minZ) / texel));
    const j1 = Math.min(height - 1, Math.floor((z1 - minZ) / texel));
    if (i0 > i1 || j0 > j1) return;
    // Winding-independent convex test: every edge cross product has the same sign.
    let area = 0;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!;
      const c = poly[(k + 1) % poly.length]!;
      area += a[0] * c[1] - c[0] * a[1];
    }
    const sgn = area >= 0 ? 1 : -1;
    const band2 = (texel * 0.75) ** 2;
    for (let j = j0; j <= j1; j++) {
      const pz = minZ + (j + 0.5) * texel;
      for (let i = i0; i <= i1; i++) {
        const px = minX + (i + 0.5) * texel;
        let inPoly = true;
        for (let k = 0; k < poly.length && inPoly; k++) {
          const a = poly[k]!;
          const c = poly[(k + 1) % poly.length]!;
          const cr = (c[0] - a[0]) * (pz - a[1]) - (c[1] - a[1]) * (px - a[0]);
          if (cr * sgn < 0) inPoly = false;
        }
        const idx = j * width + i;
        if (!outlineOnly) {
          if (inPoly) {
            solid[idx] = 1;
            inside[idx] = 1;
          }
          continue;
        }
        let near = false;
        for (let k = 0; k < poly.length && !near; k++) {
          near = segDist2(px, pz, poly[k]!, poly[(k + 1) % poly.length]!) <= band2;
        }
        if (near) solid[idx] = 1;
      }
    }
  };
  const disc = (x: number, z: number, r: number): void => {
    const n = 10;
    raster(
      Array.from({ length: n }, (_, k): P2 => {
        const a = (k / n) * Math.PI * 2;
        return [x + Math.cos(a) * r, z + Math.sin(a) * r];
      }),
      false,
      false,
    );
    // Circular footprints keep their true radius (the decagon only marks the solid mask).
    rasterContactDisc(grid, contact, x, z, r);
  };

  for (const box of map.boxes) {
    if (box.visible === false) continue;
    const y0 = box.center.y - box.size.y / 2;
    const y1 = box.center.y + box.size.y / 2;
    // Tilted pieces (a wreck's shell) reach the ground at some corner: use the rotated extent.
    const q = quatFromEulerDeg(box.rot);
    const pts: P2[] = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const w = rotateByQuat(
            { x: (sx * box.size.x) / 2, y: (sy * box.size.y) / 2, z: (sz * box.size.z) / 2 },
            q,
          );
          pts.push([box.center.x + w.x, box.center.z + w.z]);
          lo = Math.min(lo, box.center.y + w.y);
          hi = Math.max(hi, box.center.y + w.y);
        }
      }
    }
    if (!onGround(box.rot ? lo : y0, box.rot ? hi : y1)) continue;
    // Low walkable boxes (sidewalks, kerbs, plinths under 0.5 m) are ground you stand on: only
    // their edge is a kerb that collects grime, like the prism branch below.
    raster(hull(pts), (box.rot ? hi : y1) < 0.5);
  }
  for (const p of map.prisms ?? []) {
    if (p.visible === false || !onGround(p.y0, p.y1)) continue;
    raster([...p.pts], p.y1 < 0.5);
  }
  for (const t of map.trees ?? []) if ((t.y ?? 0) < 0.3) disc(t.x, t.z, 0.35);
  // The visible hedge core is 1.06 r at ground level (not the smaller gameplay cylinder).
  for (const f of map.foliage ?? [])
    if ((f.y ?? 0) < 0.3) disc(f.x, f.z, f.r * (f.kind === 'bush' ? 1.06 : 1.02));

  // Chamfer distance (texels), two passes, 1 / √2 weights.
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = solid[i] ? 0 : INF;
  const D = Math.SQRT2;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      let v = d[k]!;
      if (i > 0) v = Math.min(v, d[k - 1]! + 1);
      if (j > 0) {
        v = Math.min(v, d[k - width]! + 1);
        if (i > 0) v = Math.min(v, d[k - width - 1]! + D);
        if (i < width - 1) v = Math.min(v, d[k - width + 1]! + D);
      }
      d[k] = v;
    }
  }
  for (let j = height - 1; j >= 0; j--) {
    for (let i = width - 1; i >= 0; i--) {
      const k = j * width + i;
      let v = d[k]!;
      if (i < width - 1) v = Math.min(v, d[k + 1]! + 1);
      if (j < height - 1) {
        v = Math.min(v, d[k + width]! + 1);
        if (i < width - 1) v = Math.min(v, d[k + width + 1]! + D);
        if (i > 0) v = Math.min(v, d[k + width - 1]! + D);
      }
      d[k] = v;
    }
  }
  const textureWidth = width * 2;
  const data = new Uint8Array(textureWidth * height * 4);
  for (let k = 0; k < d.length; k++) {
    const metres = d[k]! * texel;
    const i = k % width;
    const j = Math.floor(k / width);
    const dst = (j * textureWidth + i * 2) * 4;
    const edge = Math.round(255 * Math.max(0, 1 - metres / EDGE_REACH));
    const insideValue = inside[k] ? 255 : 0;
    data[dst] = edge;
    data[dst + 1] = insideValue;
    data[dst + 4] = edge;
    data[dst + 5] = insideValue;
    // The encoding that best matches every footprint near this texel (see encodeContactTexel).
    const [b0, a0, b1, a1] = encodeContactTexel(
      contact.get(k),
      minX + (i + 0.5) * texel,
      minZ + (j + 0.5) * texel,
      texel,
    );
    data[dst + 2] = b0;
    data[dst + 3] = a0;
    data[dst + 6] = b1;
    data[dst + 7] = a1;
  }
  return { data, width, textureWidth, height, minX, minZ, texel };
}

/** Mask value (R, G in 0..1) at a world point, nearest texel (tests, debugging). */
export function sampleGroundMask(m: GroundMask, x: number, z: number): [number, number] {
  const i = Math.floor((x - m.minX) / m.texel);
  const j = Math.floor((z - m.minZ) / m.texel);
  if (i < 0 || j < 0 || i >= m.width || j >= m.height) return [0, 0];
  const k = (j * m.textureWidth + i * 2) * 4;
  return [m.data[k]! / 255, m.data[k + 1]! / 255];
}

/** Analytic sub-texel distance from the texel's two stored edge lines (mirrors the shader). */
export function sampleGroundContact(m: GroundMask, x: number, z: number): number {
  const i = Math.floor((x - m.minX) / m.texel);
  const j = Math.floor((z - m.minZ) / m.texel);
  if (i < 0 || j < 0 || i >= m.width || j >= m.height) return CONTACT_RANGE;
  const k = (j * m.textureWidth + i * 2) * 4;
  const dx = x - (m.minX + (i + 0.5) * m.texel);
  const dz = z - (m.minZ + (j + 0.5) * m.texel);
  const d = m.data;
  return decodeContactTexel(d[k + 2]!, d[k + 3]!, d[k + 6]!, d[k + 7]!, dx, dz);
}

// ---- shared uniforms / textures ------------------------------------------------------------

function noiseTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(groundNoiseData(), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'ground-noise';
  t.needsUpdate = true;
  return t;
}

function emptyMask(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 255, 0]), 1, 1, THREE.RGBAFormat);
  t.unpackAlignment = 1;
  t.name = 'ground-mask';
  t.needsUpdate = true;
  return t;
}

/** Uniforms shared by every ground material (like `wetness`). */
export const groundDetail = {
  noise: { value: null as THREE.DataTexture | null },
  mask: { value: emptyMask() },
  /** minX, minZ, 1 / (width m), 1 / (height m). */
  rect: { value: new THREE.Vector4(0, 0, 1, 1) },
  /** Width/height in texels, texel size in metres. */
  grid: { value: new THREE.Vector3(1, 1, 1) },
};

/**
 * Build the edge mask for `map` and point the shared sampler at it. Call when the map is built,
 * before `Game.warmUp` (the texture uploads on the warm-up draw; no program changes).
 */
export function setGroundDetailMap(map: MapDefinition): GroundMask {
  const m = buildGroundMask(map);
  const t = new THREE.DataTexture(m.data, m.textureWidth, m.height, THREE.RGBAFormat);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.unpackAlignment = 1;
  t.name = 'ground-mask';
  t.needsUpdate = true;
  groundDetail.mask.value.dispose();
  groundDetail.mask.value = t;
  groundDetail.rect.value.set(m.minX, m.minZ, 1 / (m.width * m.texel), 1 / (m.height * m.texel));
  groundDetail.grid.value.set(m.width, m.height, m.texel);
  return m;
}

// ---- shader --------------------------------------------------------------------------------

const VERTEX_PARS = /* glsl */ `
varying vec3 vGdPos;
`;
const VERTEX = /* glsl */ `
vGdPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

/** Exported for the shader-source tests. */
export const GROUND_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uGdNoise;
uniform sampler2D uGdMask;
uniform vec4 uGdRect;
uniform vec3 uGdGrid;
uniform float uGdStone;
uniform float uRainTime;
uniform float uRainStop;
#ifndef TONE_MAPPING
#ifndef WD_ARCHITECTURE_BUDGET
#define WD_ARCHITECTURE_BUDGET
uniform float uArchitectureBudget;
#endif
#endif
varying vec3 vGdPos;
float gdRough = 0.0;
float gdPuddle = 0.0;
float gdRippleFade = 0.0;
float gdEdge = 0.0;
float gdStone = 0.0;
float gdWear = 0.0;
// The approved blue sky + warm key made neutral slabs lavender even at roughness 0.85.
// Keep some cool shade, but limit its chroma on dry granite, preserving irradiance/luminance.
// This affects hemi fill on Low and PMREM diffuse on Medium+, never direct sun or local bakes.
vec3 gdStoneFill( vec3 light, float weight ) {
  float luminance = dot( light, vec3( 0.2126, 0.7152, 0.0722 ) );
  return mix( light, vec3( luminance ), 0.7 * weight );
}
float gdHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 gdMaskAt( vec2 xz ) {
  vec2 uv = ( xz - uGdRect.xy ) * uGdRect.zw;
  if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return vec2( 0.0 );
  return texture2D( uGdMask, uv ).rg;
}
vec2 gdContactTexCoord( vec2 cell, float slot ) {
  return vec2( ( ( cell.x - 0.5 ) * 2.0 + slot + 0.5 ) / ( uGdGrid.x * 2.0 ), cell.y / uGdGrid.y );
}
// Byte layout: groundContact.ts. B = signed distance at the texel centre (255: none).
vec2 gdContactNormal( float steps, float count ) {
  float angle = steps * ( 6.2831853 / count );
  return vec2( cos( angle ), sin( angle ) );
}
// Signed distance to a stored edge line at offset o from the texel centre.
float gdContactLine( vec2 o, vec2 plane, vec2 n ) {
  return ( plane.x * 2.0 - 1.0 ) * ${CONTACT_RANGE} + dot( o, n );
}
// A line's distance; a vertex line decodes radially from the footprint point it rests on.
float gdContactSingle( vec2 o, vec2 plane, vec2 n, float vertex ) {
  float d = gdContactLine( o, plane, n );
  if ( vertex < 0.5 ) return abs( d );
  return length( vec2( d, length( o - n * dot( o, n ) ) ) );
}
// Distance to the intersection of two half-planes (one footprint's corner): see cornerDistance.
float gdCornerDistance( float a, float b, float c ) {
  if ( a <= 0.0 && b <= 0.0 ) return -max( a, b );
  if ( a > 0.0 && b - a * c <= 0.0 ) return a;
  if ( b > 0.0 && a - b * c <= 0.0 ) return b;
  float s = 1.0 - c * c;
  if ( s < 1e-4 ) return max( a, b );
  return sqrt( max( 0.0, ( a * a + b * b - 2.0 * a * b * c ) / s ) );
}
// Snap before sampling so encoded normal angles never interpolate across their wrap.
// BA stores the two nearest tangent planes per logical texel in adjacent texture columns.
float gdContactDistance( vec2 xz, out vec2 broadMask ) {
  vec2 uv = ( xz - uGdRect.xy ) * uGdRect.zw;
  broadMask = vec2( 0.0 );
  if ( uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0 ) return ${CONTACT_RANGE};
  vec2 cell = floor( uv * uGdGrid.xy ) + 0.5;
  vec4 maskSample = texture2D( uGdMask, gdContactTexCoord( cell, 0.0 ) );
  broadMask = maskSample.rg;
  if ( maskSample.b > 0.999 ) return ${CONTACT_RANGE};
  vec2 second = texture2D( uGdMask, gdContactTexCoord( cell, 1.0 ) ).ba;
  vec2 o = xz - ( uGdRect.xy + cell * uGdGrid.z );
  float code0 = floor( maskSample.a * 255.0 + 0.5 );
  float code1 = floor( second.y * 255.0 + 0.5 );
  vec2 n1 = gdContactNormal( floor( code1 * 0.5 ), 127.0 );
  // A0 and A1 odd: a disc. Slot 0 = its tangent at the texel centre, B1 = radius / 4 m.
  if ( mod( code0, 2.0 ) > 0.5 && mod( code1, 2.0 ) > 0.5 ) {
    vec2 n = gdContactNormal( floor( code0 * 0.5 ), 127.0 );
    float r = second.x * 4.0;
    float toCentre = ( maskSample.b * 2.0 - 1.0 ) * ${CONTACT_RANGE} + r;
    return abs( length( o + n * toCentre ) - r );
  }
  // A0 odd: both lines are one footprint's edges (exact intersection).
  if ( mod( code0, 2.0 ) > 0.5 ) {
    vec2 n0 = gdContactNormal( floor( code0 * 0.5 ), 127.0 );
    return gdCornerDistance( gdContactLine( o, maskSample.ba, n0 ), gdContactLine( o, second, n1 ), dot( n0, n1 ) );
  }
  // Else one line per footprint (union): slot 0 = 4 x angle (64) + 2 x vertex.
  float d = gdContactSingle( o, maskSample.ba, gdContactNormal( floor( code0 * 0.25 ), 64.0 ), mod( floor( code0 * 0.5 ), 2.0 ) );
  if ( second.x > 0.999 ) return d;
  return min( d, gdContactSingle( o, second, n1, mod( code1, 2.0 ) ) );
}
float gdContactBand( float d ) {
  return 0.8 * ( 1.0 - smoothstep( ${CONTACT_CORE}, ${CONTACT_FEATHER}, d ) )
    + 0.2 * ( 1.0 - smoothstep( 0.0, ${CONTACT_REACH}, d ) );
}
// Anti-aliased thin line: coverage of a band of half-width w at distance d (aa = pixel size).
float gdLine( float d, float w, float aa ) {
  return ( 1.0 - smoothstep( w, w + aa, d ) ) * clamp( 2.0 * w / aa, 0.0, 1.0 );
}
// Rain ripples on standing water (slope of the surface, world xz): every impact sends out a short
// train of capillary rings (wavelength ~1.6 cm, front spreading ~0.12 m/s, gone in under a
// second). Two staggered layers of cells, one impact per cell per cycle.
vec2 gdRipples( vec2 xz, float t ) {
  vec2 slope = vec2( 0.0 );
  for ( int L = 0; L < 2; L++ ) {
    float cell = L == 0 ? 0.31 : 0.23;
    vec2 p = xz / cell + ( L == 0 ? vec2( 0.0 ) : vec2( 0.47, 0.13 ) );
    vec2 id = floor( p ) + float( L ) * 17.0;
    vec2 c = ( vec2( gdHash( id + 3.1 ), gdHash( id + 7.7 ) ) - 0.5 ) * 0.3;
    vec2 d = ( fract( p ) - 0.5 - c ) * cell;
    float h = gdHash( id );
    float period = 0.6 + 0.5 * h;
    float age = fract( t / period + h * 3.7 );
    // No impacts after the rain stopped: the last rings play out and fade.
    if ( t - age * period > uRainStop ) continue;
    float r = length( d );
    float x = ( r - age * 0.09 ) / 0.016;
    float env = smoothstep( -3.0, -0.6, x ) * ( 1.0 - smoothstep( -0.6, 0.0, x ) ) * ( 1.0 - age ) * ( 1.0 - age );
    slope += cos( x * 6.2832 ) * env * d / max( r, 1e-4 );
  }
  return slope * 1.1;
}
vec3 groundDetail( vec3 albedo, vec3 viewNormal ) {
  gdRough = 0.0;
  gdPuddle = 0.0;
  gdEdge = 0.0;
  gdRippleFade = 0.0;
  gdStone = 0.0;
  gdWear = 0.0;
  vec3 upView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  if ( dot( viewNormal, upView ) < 0.85 || vGdPos.y > 0.6 || vGdPos.y < -0.4 ) return albedo;
  gdStone = uGdStone;
  float dist = distance( vGdPos, cameraPosition );
  float fade = 1.0 - smoothstep( 70.0, 110.0, dist );
  if ( fade <= 0.0 ) return albedo;
  vec2 xz = vGdPos.xz;
  vec2 aa = max( fwidth( xz ), vec2( 1e-4 ) );
  // Contact and macro breakup are shared by every tier, in the existing material.
  vec2 m;
  float contactDistance = gdContactDistance( xz, m );
  float edge = gdContactBand( contactDistance );
  vec4 broad = texture2D( uGdNoise, xz * ( 1.0 / 31.0 ) );
  // Foot traffic follows the clear strip beside walls/stalls. Use the reconstructed distance,
  // not snapped mask R (0.5 m steps); fade within CONTACT_REACH, the field's supported radius.
  gdWear = 0.09 * smoothstep( 0.45, 0.7, contactDistance ) * ( 1.0 - smoothstep( 0.7, ${CONTACT_REACH}, contactDistance ) )
    * ( 0.65 + 0.35 * broad.g ) * ( 1.0 - edge ) * fade * gdStone;
  vec3 asphaltDetail = albedo * ( 0.74 + 0.44 * smoothstep( 0.25, 0.75, broad.r ) );
  asphaltDetail *= mix( vec3( 1.0, 1.0, 0.99 ), vec3( 1.04, 1.0, 0.94 ), broad.b );
  float stoneMacro = ( broad.r - 0.5 ) * 0.08 + ( broad.b - 0.5 ) * 0.035;
  vec3 stoneDetail = albedo * ( 1.0 + stoneMacro - 0.35 * gdWear );
  stoneDetail *= mix( vec3( 0.995, 1.0, 1.005 ), vec3( 1.01, 1.0, 0.992 ), broad.b );
  vec3 a = mix( asphaltDetail, stoneDetail, uGdStone );
  vec3 contactTint = mix( vec3( 0.3, 0.255, 0.18 ), vec3( ${STONE_CONTACT_ALBEDO} ), uGdStone );
  a = mix( a, a * contactTint, edge );
  gdRough += 0.16 * edge;
  gdEdge = smoothstep( 0.35, 0.8, edge ) * fade;
  // All tiers retain porous stone and the existing rain-filled basin channel.
  float basin = smoothstep( 0.64, 0.69, broad.a );
  float tide = basin * ( 1.0 - smoothstep( 0.69, 0.715, broad.a ) );
  a *= 1.0 - ( 1.0 - uGdStone ) * ( 0.14 * basin + 0.2 * tide );
  gdPuddle = basin;
  #ifndef TONE_MAPPING
  // Medium retains contact and macro breakup, skipping the expensive fine detail.
  if ( uArchitectureBudget > 0.5 ) return mix( albedo, a, fade );
  #endif
  vec4 macro = broad;
  vec4 mid = texture2D( uGdNoise, xz * ( 1.0 / 6.7 ) + vec2( 0.37, 0.61 ) );
  vec3 asphaltMid = mix( a, a * vec3( 0.72, 0.68, 0.61 ), 0.65 * smoothstep( 0.48, 0.76, mid.r ) );
  float stoneMid = 1.0 + ( mid.r - 0.5 ) * 0.035;
  a = mix( asphaltMid, a * stoneMid, uGdStone );
  // Fine settled dirt in drifts, inside the 85 cm halo, beside the crisp core.
  if ( contactDistance < ${CONTACT_REACH} ) {
    vec4 fine = texture2D( uGdNoise, xz * ( 1.0 / 1.9 ) + vec2( 0.11, 0.83 ) );
    float halo = 1.0 - smoothstep( 0.0, ${CONTACT_REACH}, contactDistance );
    float patchy = smoothstep( 0.42, 0.8, 0.5 * fine.b + 0.3 * mid.b + 0.2 * fine.r );
    float drift = halo * patchy;
    a = mix( a, a * vec3( 0.55, 0.46, 0.32 ), 0.12 * drift );
    gdRough += 0.04 * drift;
  }
  // Oil and gum stains (small, dark, slightly satin).
  float stain = smoothstep( 0.64, 0.7, mid.g ) * smoothstep( 0.38, 0.6, macro.g );
  a *= 1.0 - mix( 0.5, 0.0, uGdStone ) * stain;
  gdRough -= 0.1 * stain * ( 1.0 - uGdStone );
  // Ripples only where they resolve (pixels under ~1 cm) and near enough to be seen.
  gdRippleFade = ( 1.0 - smoothstep( 0.005, 0.016, max( aa.x, aa.y ) ) ) * ( 1.0 - smoothstep( 16.0, 24.0, dist ) ) * fade;
  // Expansion joints every 10 m (sealant), both ways.
  vec2 jd = abs( fract( xz / 10.0 + 0.5 ) - 0.5 ) * 10.0;
  float joint = max( gdLine( jd.x, 0.012, aa.x ), gdLine( jd.y, 0.012, aa.y ) );
  a = mix( a, albedo * 0.22, joint * 0.85 );
  gdRough += 0.1 * joint;
  // Litter within 30 m: paper scraps, cigarette ends, dead leaves (one per ~35 cells).
  if ( dist < 30.0 ) {
    vec2 cell = floor( xz / 1.3 );
    float h = gdHash( cell );
    if ( h > 0.94 && m.y < 0.5 ) {
      vec2 c = ( cell + 0.2 + 0.6 * vec2( gdHash( cell + 7.1 ), gdHash( cell + 3.7 ) ) ) * 1.3;
      float ang = gdHash( cell + 1.9 ) * 6.2832;
      vec2 q = mat2( cos( ang ), -sin( ang ), sin( ang ), cos( ang ) ) * ( xz - c );
      float kind = fract( h * 37.0 );
      vec2 hs = kind < 0.4 ? vec2( 0.05, 0.035 ) : kind < 0.7 ? vec2( 0.014, 0.004 ) : vec2( 0.035, 0.02 );
      vec2 e = abs( q ) - hs;
      float px = max( aa.x, aa.y );
      float ins = kind < 0.7
        ? 1.0 - smoothstep( 0.0, px, max( e.x, e.y ) )
        : 1.0 - smoothstep( 1.0 - px / hs.y, 1.0, length( q / hs ) );
      vec3 col = kind < 0.4 ? vec3( 0.62, 0.61, 0.58 ) : kind < 0.7
        ? ( q.x > hs.x * 0.4 ? vec3( 0.45, 0.25, 0.1 ) : vec3( 0.7, 0.68, 0.62 ) )
        : vec3( 0.2, 0.12, 0.05 );
      a = mix( a, col, ins * ( 1.0 - smoothstep( 20.0, 30.0, dist ) ) );
    }
  }
  // Manhole covers out in the open (13 m cells, where nothing stands within 2 m).
  {
    vec2 cell = floor( xz / 13.0 );
    vec2 c = ( cell + 0.3 + 0.4 * vec2( gdHash( cell + 5.3 ), gdHash( cell + 9.1 ) ) ) * 13.0;
    vec2 q = xz - c;
    float r = length( q );
    if ( r < 0.42 && gdHash( cell + 2.2 ) > 0.3 && gdMaskAt( c ).x < 0.2 ) {
      float px = max( aa.x, aa.y );
      float lid = 1.0 - smoothstep( 0.33 - px, 0.33, r );
      float frame = ( 1.0 - smoothstep( 0.4 - px, 0.4, r ) ) - lid;
      float gap = gdLine( abs( r - 0.335 ), 0.006, px );
      // Raised diamond tread on the lid, worn bright in the middle.
      vec2 t = abs( fract( mat2( 0.7071, -0.7071, 0.7071, 0.7071 ) * q * 16.0 ) - 0.5 );
      float tread = smoothstep( 0.18, 0.28, max( t.x, t.y ) ) * clamp( 0.06 / px, 0.0, 1.0 );
      vec3 iron = vec3( 0.055, 0.05, 0.045 ) * ( 1.0 + 0.9 * tread * ( 1.0 - r * 2.0 ) );
      iron = mix( iron, vec3( 0.16, 0.08, 0.04 ), 0.35 * smoothstep( 0.55, 0.75, mid.r ) );
      a = mix( a, iron, lid );
      a = mix( a, vec3( 0.07, 0.066, 0.06 ), frame );
      a *= 1.0 - 0.8 * gap;
      a *= 1.0 - 0.25 * smoothstep( 0.55, 0.4, r ) * ( 1.0 - lid - frame );
      gdRough += ( -0.25 + 0.15 * tread ) * lid - 0.15 * frame;
    }
  }
  // Drain grates along walls and kerbs (9 m cells, 0.5–1.5 m from an edge).
  {
    vec2 cell = floor( xz / 9.0 );
    vec2 c = ( cell + 0.2 + 0.6 * vec2( gdHash( cell + 4.4 ), gdHash( cell + 8.8 ) ) ) * 9.0;
    vec2 q = xz - c;
    if ( abs( q.x ) < 0.26 && abs( q.y ) < 0.2 && gdHash( cell + 6.6 ) > 0.25 ) {
      vec2 mc = gdMaskAt( c );
      if ( mc.x > 0.4 && mc.x < 0.85 && mc.y < 0.5 ) {
        float px = max( aa.x, aa.y );
        vec2 e = abs( q ) - vec2( 0.26, 0.2 );
        float body = 1.0 - smoothstep( -px, 0.0, max( e.x, e.y ) );
        float inner = 1.0 - smoothstep( -px, 0.0, max( e.x + 0.03, e.y + 0.03 ) );
        float slot = smoothstep( 0.35, 0.45, abs( fract( q.x * 22.0 ) - 0.5 ) ) * clamp( 0.03 / px, 0.0, 1.0 );
        vec3 iron = vec3( 0.06, 0.055, 0.05 );
        a = mix( a, iron, body );
        a = mix( a, vec3( 0.008 ), inner * slot );
        a *= 1.0 - 0.3 * ( 1.0 - smoothstep( 0.2, 0.5, length( q ) ) ) * ( 1.0 - body );
        gdRough -= 0.2 * body * ( 1.0 - slot );
      }
    }
  }
  return mix( albedo, a, fade );
}
`;

/** Patch a ground material with the detail layer. Call after `addWetness` (which replaces the hook). */
export function addGroundDetail(mat: THREE.MeshStandardMaterial, stone = false): void {
  if (mat.userData.groundDetailStone) {
    (mat.userData.groundDetailStone as THREE.IUniform<number>).value = stone ? 1 : 0;
  }
  if (mat.userData.groundDetail) return;
  mat.userData.groundDetail = true;
  mat.userData.groundDetailStone = { value: stone ? 1 : 0 };
  groundDetail.noise.value ??= noiseTexture();
  const prev = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uGdNoise = groundDetail.noise;
    shader.uniforms.uGdMask = groundDetail.mask;
    shader.uniforms.uGdRect = groundDetail.rect;
    shader.uniforms.uGdGrid = groundDetail.grid;
    shader.uniforms.uGdStone = mat.userData.groundDetailStone as THREE.IUniform<number>;
    shader.uniforms.uRainTime = rainTime;
    shader.uniforms.uRainStop = rainStop;
    shader.uniforms.uArchitectureBudget = architectureBudget;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND_FRAGMENT_PARS}`)
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.rgb = groundDetail( diffuseColor.rgb, normalize( vNormal ) );',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp( roughnessFactor + gdRough, 0.08, 1.0 );
// Preserve matte joints and settled grime; only walking faces take the shallow polish.
float faceWear = 1.0 - smoothstep( 0.92, 0.96, roughnessFactor );
roughnessFactor = mix( roughnessFactor, clamp( roughnessFactor - gdWear * faceWear, 0.72, 0.98 ), gdStone );`,
      )
      // After the wetness hook (lighting setup reads both): dried basins hold water in the rain (and only then shine).
      .replace(
        '#include <lights_physical_fragment>',
        `// Standing water: basins fill once the ground is saturated, only where rain reaches.
        float gdWater = smoothstep( 0.4, 1.0, uWetness ) * gdPuddle * wetExposed;
        // Not a mirror for the sun: under a storm deck the "sun" is a bright patch of cloud, so
        // its highlight on the water stays broad (the sky reflection barely blurs at this roughness).
        roughnessFactor = mix( roughnessFactor, 0.11, gdWater );
        diffuseColor.rgb *= 1.0 - 0.3 * gdWater;
        if ( gdWater > 0.01 ) {
          // The water surface is flat (it hides the paving's relief), rippled by the impacts.
          vec2 rs = vec2( 0.0 );
          #ifndef TONE_MAPPING
          // Ripple normals on Medium+ only (Low: flat water; ripples hide nothing).
          if ( gdRippleFade > 0.0 ) rs = gdRipples( vGdPos.xz, uRainTime ) * gdRippleFade;
          #endif
          vec3 wn = normalize( ( viewMatrix * vec4( -rs.x, 1.0, -rs.y, 0.0 ) ).xyz );
          normal = normalize( mix( normal, wn, gdWater ) );
        }
        #include <lights_physical_fragment>
        // Settled dirt is dull: it loses most of the grazing sky sheen that otherwise washes the
        // grime out in sun (unless it is wet).
        material.specularColorBlended *= 1.0 - 0.75 * gdEdge * ( 1.0 - uWetness );
        material.specularF90 *= 1.0 - 0.75 * gdEdge * ( 1.0 - uWetness );`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#if defined( RE_IndirectDiffuse )
        if ( gdStone > 0.0 ) {
          float stoneDry = gdStone * ( 1.0 - uWetness * wetExposed );
          irradiance = gdStoneFill( irradiance, stoneDry );
          iblIrradiance = gdStoneFill( iblIrradiance, stoneDry );
        }
        #endif
        #include <lights_fragment_end>`,
      );
  };
  mat.customProgramCacheKey = () => `${key}|ground-v3`;
  mat.needsUpdate = true;
}
