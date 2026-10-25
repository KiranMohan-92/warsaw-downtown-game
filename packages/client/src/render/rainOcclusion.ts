/**
 * Rain occlusion: a top-down height map of the map — at every texel, the height of the first
 * surface rain falling straight down would hit (roofs, stall awnings, canopies, container and
 * vehicle tops, the hall roof, the street slab over the metro, the helicopter wreck's shell).
 * Baked once at map build from the shared map geometry (boxes by their rotated footprint, prisms,
 * bush/grass clumps), ~0.25 m texels, no ray casts (the Rapier world takes ~13 µs a ray: seconds
 * for the Market).
 *
 * Used by the rain streaks (drops end at that height), the splashes (they land on it, never under
 * cover), the wet materials (sheltered surfaces stay dry) and the rain audio (muffled under cover,
 * drumming on a roof just overhead). R = top height (m), G = 1 where the top is foliage (rain
 * soaks in: no splash). Presentation only.
 */
import * as THREE from 'three';
import { quatFromEulerDeg, rotateByQuat, type MapDefinition } from '@wd/shared';

/** Texel size (m); coarser only if the map would need more than `MAX_TEXELS` a side. */
export const OCCLUSION_TEXEL = 0.25;
const MAX_TEXELS = 2048;
/** Margin round the playable bounds: the rain box reaches ~22 m past where you can stand. */
const MARGIN = 26;
/** "Nothing overhead" (no surface at all in the column). */
export const NO_COVER = -1e4;

export interface RainOcclusion {
  minX: number;
  minZ: number;
  texel: number;
  width: number;
  height: number;
  /** Top height per texel (row-major, z rows). */
  top: Float32Array;
  /** 1 where the top surface is foliage. */
  soft: Uint8Array;
}

type P2 = readonly [number, number];

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

/** Bake the occlusion height map of `map` (its playable bounds plus the rain's reach). */
export function bakeRainOcclusion(map: MapDefinition): RainOcclusion {
  const b = map.bounds;
  const minX = b.minX - MARGIN;
  const minZ = b.minZ - MARGIN;
  const spanX = b.maxX - b.minX + 2 * MARGIN;
  const spanZ = b.maxZ - b.minZ + 2 * MARGIN;
  const texel = Math.max(OCCLUSION_TEXEL, Math.max(spanX, spanZ) / MAX_TEXELS);
  const width = Math.ceil(spanX / texel);
  const height = Math.ceil(spanZ / texel);
  const top = new Float32Array(width * height).fill(NO_COVER);
  const soft = new Uint8Array(width * height);

  /** Raise every texel whose centre is inside the convex polygon to `y` (max). */
  const raster = (poly: readonly P2[], y: number, isSoft: boolean): void => {
    if (poly.length < 3) return;
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
    const i0 = Math.max(0, Math.ceil((x0 - minX) / texel - 0.5));
    const i1 = Math.min(width - 1, Math.floor((x1 - minX) / texel - 0.5));
    const j0 = Math.max(0, Math.ceil((z0 - minZ) / texel - 0.5));
    const j1 = Math.min(height - 1, Math.floor((z1 - minZ) / texel - 0.5));
    if (i0 > i1 || j0 > j1) return;
    let area = 0;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!;
      const c = poly[(k + 1) % poly.length]!;
      area += a[0] * c[1] - c[0] * a[1];
    }
    const sgn = area >= 0 ? 1 : -1;
    const n = poly.length;
    for (let j = j0; j <= j1; j++) {
      const pz = minZ + (j + 0.5) * texel;
      // The polygon is convex: find the row's x span once, then fill it.
      let lo = x0;
      let hi = x1;
      for (let k = 0; k < n; k++) {
        const a = poly[k]!;
        const c = poly[(k + 1) % n]!;
        // Inside: sgn * ((c.x - a.x)(pz - a.z) - (c.z - a.z)(px - a.x)) >= 0, linear in px.
        const ex = c[0] - a[0];
        const ez = c[1] - a[1];
        const k0 = sgn * (ex * (pz - a[1]) + ez * a[0]); // constant part
        const k1 = -sgn * ez; // px coefficient
        if (Math.abs(k1) < 1e-12) {
          if (k0 < 0) {
            lo = Infinity;
            break;
          }
        } else if (k1 > 0) lo = Math.max(lo, -k0 / k1);
        else hi = Math.min(hi, -k0 / k1);
      }
      if (!(lo <= hi)) continue;
      const a0 = Math.max(i0, Math.ceil((lo - minX) / texel - 0.5));
      const a1 = Math.min(i1, Math.floor((hi - minX) / texel - 0.5));
      const row = j * width;
      for (let i = a0; i <= a1; i++) {
        const idx = row + i;
        if (y > top[idx]!) {
          top[idx] = y;
          soft[idx] = isSoft ? 1 : 0;
        }
      }
    }
  };

  const inRect = (x0: number, z0: number, x1: number, z1: number): boolean =>
    x1 >= minX && z1 >= minZ && x0 <= minX + width * texel && z0 <= minZ + height * texel;

  for (const box of map.boxes) {
    // Invisible collide-only boxes (bounds, stair ramps) don't stop rain; a hero's hidden cabin
    // collider does (the model covers it).
    if (box.visible === false && !box.heroPart) continue;
    const r = Math.hypot(box.size.x, box.size.z) / 2;
    if (!inRect(box.center.x - r, box.center.z - r, box.center.x + r, box.center.z + r)) continue;
    // The rotated footprint, topped by its highest corner (exact for upright boxes; a tilted
    // piece such as a wreck's shell plate is covered up to its top edge).
    if (!box.rot) {
      const hx = box.size.x / 2;
      const hz = box.size.z / 2;
      const { x, z } = box.center;
      const rect: P2[] = [
        [x - hx, z - hz],
        [x + hx, z - hz],
        [x + hx, z + hz],
        [x - hx, z + hz],
      ];
      raster(rect, box.center.y + box.size.y / 2, false);
      continue;
    }
    const q = quatFromEulerDeg(box.rot);
    const pts: P2[] = [];
    let hi = -Infinity;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const w = rotateByQuat(
            { x: (sx * box.size.x) / 2, y: (sy * box.size.y) / 2, z: (sz * box.size.z) / 2 },
            q,
          );
          pts.push([box.center.x + w.x, box.center.z + w.z]);
          hi = Math.max(hi, box.center.y + w.y);
        }
    raster(hull(pts), hi, false);
  }
  for (const p of map.prisms ?? []) {
    if (p.visible === false) continue;
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
    if (inRect(x0, z0, x1, z1)) raster(p.pts, p.y1, false);
  }
  // Bushes and tall grass: the rain ends in the leaves (no splash there).
  for (const f of map.foliage ?? []) {
    const n = 12;
    const poly = Array.from({ length: n }, (_, k): P2 => {
      const a = (k / n) * Math.PI * 2;
      return [f.x + Math.cos(a) * f.r * 0.9, f.z + Math.sin(a) * f.r * 0.9];
    });
    raster(poly, (f.y ?? 0) + f.h * 0.9, true);
  }
  return { minX, minZ, texel, width, height, top, soft };
}

/** Top height (m) over a world point, nearest texel (`NO_COVER` outside the map). */
export function occlusionTop(o: RainOcclusion, x: number, z: number): number {
  const i = Math.floor((x - o.minX) / o.texel);
  const j = Math.floor((z - o.minZ) / o.texel);
  if (i < 0 || j < 0 || i >= o.width || j >= o.height) return NO_COVER;
  return o.top[j * o.width + i]!;
}

/** True if something stands over `(x, y, z)` (more than `margin` m above it): no rain there. */
export function isSheltered(
  o: RainOcclusion,
  x: number,
  y: number,
  z: number,
  margin = 0.1,
): boolean {
  return occlusionTop(o, x, z) > y + margin;
}

export interface RainShelter {
  /** Height of the cover over the point (m above it), Infinity in the open. */
  roof: number;
  /** Share of the surroundings (rings 2.5 m and 6 m round the point) open to the rain, 0..1. */
  open: number;
}

const RING = Array.from({ length: 16 }, (_, k) => {
  const a = ((k % 8) / 8) * Math.PI * 2 + (k >= 8 ? Math.PI / 8 : 0);
  const r = k >= 8 ? 6 : 2.5;
  return [Math.cos(a) * r, Math.sin(a) * r] as const;
});

/** How sheltered a listener at `(x, y, z)` is: drives the rain sound (muffle, roof drumming). */
export function rainShelter(o: RainOcclusion, x: number, y: number, z: number): RainShelter {
  const t = occlusionTop(o, x, z);
  const roof = t > y + 0.1 ? t - y : Infinity;
  let open = 0;
  for (const [dx, dz] of RING) if (!isSheltered(o, x + dx, y, z + dz, 0.3)) open++;
  return { roof, open: open / RING.length };
}

// ---- GPU side ------------------------------------------------------------------------------

function emptyTexture(): THREE.DataTexture {
  const d = new Uint16Array([THREE.DataUtils.toHalfFloat(NO_COVER), 0]);
  const t = new THREE.DataTexture(d, 1, 1, THREE.RGFormat, THREE.HalfFloatType);
  t.name = 'rain-occlusion';
  t.needsUpdate = true;
  return t;
}

/** Shared uniforms of every shader that reads the occlusion (like `wetness`). */
export const rainOcclusion = {
  map: { value: emptyTexture() },
  /** minX, minZ, 1 / (width m), 1 / (height m). */
  rect: { value: new THREE.Vector4(0, 0, 1, 1) },
};

/** Rain clock (s) shared by the puddle ripples; advanced by render/rain.ts while it rains. */
export const rainTime = { value: 0 };
/** Rain clock time the rain stopped (no new puddle impacts after it); `RAINING` while it rains. */
export const RAINING = 1e9;
export const rainStop = { value: RAINING };

let current: RainOcclusion | null = null;

/** The baked occlusion of the current map (null before the map is built). */
export function currentRainOcclusion(): RainOcclusion | null {
  return current;
}

/**
 * Bake the occlusion for `map` and point the shared sampler at it. Call when the map is built,
 * before `Game.warmUp` (the texture uploads on the warm-up draw; no program changes).
 */
export function setRainOcclusionMap(map: MapDefinition): RainOcclusion {
  const o = bakeRainOcclusion(map);
  const data = new Uint16Array(o.width * o.height * 2);
  for (let k = 0; k < o.top.length; k++) {
    data[k * 2] = THREE.DataUtils.toHalfFloat(o.top[k]!);
    data[k * 2 + 1] = o.soft[k] ? 0x3c00 : 0; // 1.0 / 0.0
  }
  const t = new THREE.DataTexture(data, o.width, o.height, THREE.RGFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'rain-occlusion';
  t.needsUpdate = true;
  rainOcclusion.map.value.dispose();
  rainOcclusion.map.value = t;
  rainOcclusion.rect.value.set(o.minX, o.minZ, 1 / (o.width * o.texel), 1 / (o.height * o.texel));
  current = o;
  return o;
}

/**
 * GLSL (vertex or fragment): `rainTopAt(xz)` = nearest texel's top (exact edges: drops and
 * splashes), `rainExposure(p)` = 0 sheltered .. 1 open, bilinear (soft dry/wet edges).
 */
export const RAIN_OCCLUSION_GLSL = /* glsl */ `
uniform sampler2D uRainOcc;
uniform vec4 uRainOccRect;
vec2 rainOccUv( vec2 xz ) { return ( xz - uRainOccRect.xy ) * uRainOccRect.zw; }
bool rainOccInside( vec2 uv ) { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x < 1.0 && uv.y < 1.0; }
vec2 rainTopAt( vec2 xz ) {
  vec2 uv = rainOccUv( xz );
  if ( !rainOccInside( uv ) ) return vec2( -1e4, 0.0 );
  vec2 size = vec2( textureSize( uRainOcc, 0 ) );
  return texelFetch( uRainOcc, ivec2( uv * size ), 0 ).rg;
}
float rainExposure( vec3 p ) {
  vec2 uv = rainOccUv( p.xz );
  if ( !rainOccInside( uv ) ) return 1.0;
  float top = textureLod( uRainOcc, uv, 0.0 ).r;
  return 1.0 - smoothstep( 0.04, 0.3, top - p.y );
}
`;
