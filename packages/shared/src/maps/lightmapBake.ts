/**
 * Lightmap texel math, shared by the offline baker (`tools/bake`) and its tests. Pure: the only
 * input from the world is a `WorldRaycaster` (Rapier's `PhysicsWorld` in the baker), and every
 * sample pattern is fixed (Hammersley + a per-texel integer hash), so a bake is reproducible
 * byte for byte.
 *
 * What is baked: **sky visibility** — the cosine-weighted fraction of the hemisphere above a texel
 * that reaches open sky, with a distance falloff (an occluder at distance d blocks d / reach of its
 * ray: contact is black, a wall `reach` metres away barely shades). The client applies it as the
 * materials' `aoMap`, which scales indirect light (hemisphere fill + IBL) and leaves the sun and
 * its realtime shadows alone.
 */
import { hashSeed } from '../math/rng.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { PhysicsWorld } from '../physics/world.ts';
import type { WorldRaycaster } from '../sim/hitscan.ts';
import type { MapDefinition } from './types.ts';
import { rectWorld, type LightmapRect } from './lightmap.ts';
import { voxelCentre, type BakeEmitter, type LampVolumeLayout } from './lampVolume.ts';

/** What a bake needs from the world: rays, plus an optional solid-containment test. */
export interface BakeWorld extends WorldRaycaster {
  /**
   * True if `p` lies inside solid geometry: the texel is buried (under a building, inside a
   * neighbouring convex piece) and casts no rays at all. Also keeps rays from starting inside
   * convex hulls, which can trip a Rapier/parry panic.
   */
  isInside?(p: Vec3): boolean;
}

/** The game's physics world as a bake world (rays + point containment over static colliders). */
export function bakeWorldOf(world: PhysicsWorld): BakeWorld {
  return {
    castRay: (origin, dir, maxDistance) => world.castRay(origin, dir, maxDistance),
    isInside: (p) => world.containsPoint(p),
  };
}

export interface BakeSettings {
  /** Hemisphere rays per texel. */
  samples: number;
  /** Occlusion falloff distance (m); rays are cast this far. */
  reach: number;
  /** Ray origins sit this far off the surface (m) to avoid self-hits. */
  offset: number;
  /** Ground texture: fade to white over this many texels at the border (clamp-to-edge). */
  groundFeather: number;
}

export const BAKE_SETTINGS: BakeSettings = {
  samples: 64,
  reach: 16,
  offset: 0.03,
  groundFeather: 16,
};

/** Van der Corput radical inverse in base 2. */
function radicalInverse(i: number): number {
  let b = i >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
  return b / 4294967296;
}

/**
 * Cosine-weighted hemisphere directions (Hammersley set) in tangent space: triples of
 * (along u, along v, along n). Returned as radius/angle/height so a texel can rotate the pattern.
 */
export function hemispherePattern(samples: number): Float64Array {
  const out = new Float64Array(samples * 3);
  for (let i = 0; i < samples; i++) {
    const a = (i + 0.5) / samples;
    const b = radicalInverse(i);
    out[i * 3] = Math.sqrt(a); // sin θ
    out[i * 3 + 1] = 2 * Math.PI * b; // φ
    out[i * 3 + 2] = Math.sqrt(1 - a); // cos θ
  }
  return out;
}

/** Per-texel rotation of the pattern (turns banding into fine noise the blur removes). */
const texelAngle = (x: number, y: number): number =>
  (hashSeed(x, y, 0x5eed) / 4294967296) * 2 * Math.PI;

export interface RectSamples {
  /** Sky visibility per interior texel (row-major, w × h), 0..1. */
  value: Float32Array;
  /** 1 = the texel centre is in open air; 0 = buried in geometry (filled by dilation). */
  valid: Uint8Array;
}

/**
 * Bake one rect: for every interior texel, cast the hemisphere pattern from the texel centre and
 * average the per-ray visibility. `rows` bakes only rows [j0, j1) (the baker splits the big ground
 * rect into fixed bands for its workers); the texels are bit-identical to a whole-rect bake.
 */
export function bakeRect(
  world: BakeWorld,
  rect: LightmapRect,
  settings: BakeSettings = BAKE_SETTINGS,
  pattern: Float64Array = hemispherePattern(settings.samples),
  rows: readonly [number, number] = [0, rect.h],
): RectSamples {
  const w = rect.w;
  const [j0, j1] = rows;
  const value = new Float32Array(w * (j1 - j0));
  const valid = new Uint8Array(w * (j1 - j0));
  const n = rect.n;
  // Tangent frame: u, and b = n × u (u, v and n are orthonormal for every face frame).
  const u = rect.u;
  const b: Vec3 = {
    x: n.y * u.z - n.z * u.y,
    y: n.z * u.x - n.x * u.z,
    z: n.x * u.y - n.y * u.x,
  };
  const samples = pattern.length / 3;
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: 0 };
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < w; i++) {
      const p = rectWorld(rect, i + 0.5, j + 0.5);
      origin.x = p.x + n.x * settings.offset;
      origin.y = p.y + n.y * settings.offset;
      origin.z = p.z + n.z * settings.offset;
      const k = (j - j0) * w + i;
      if (world.isInside?.(origin)) continue; // buried: value 0, invalid (dilation fills it)
      const rot = texelAngle(rect.x + i, rect.y + j);
      let sum = 0;
      let buried = 0;
      for (let s = 0; s < samples; s++) {
        const r = pattern[s * 3]!;
        const phi = pattern[s * 3 + 1]! + rot;
        const cz = pattern[s * 3 + 2]!;
        const cu = r * Math.cos(phi);
        const cv = r * Math.sin(phi);
        dir.x = u.x * cu + b.x * cv + n.x * cz;
        dir.y = u.y * cu + b.y * cv + n.y * cz;
        dir.z = u.z * cu + b.z * cv + n.z * cz;
        const hit = world.castRay(origin, dir, settings.reach);
        if (!hit) {
          sum += 1;
          continue;
        }
        if (hit.distance < 1e-4) buried++;
        sum += hit.distance / settings.reach;
      }
      value[k] = sum / samples;
      valid[k] = buried * 4 <= samples ? 1 : 0;
    }
  }
  return { value, valid };
}

/**
 * Clean a baked rect in place: a 3×3 blur over valid texels (denoise), then dilate valid values
 * into buried texels (so bilinear filtering at face edges never pulls in "inside the wall"
 * darkness). A rect with no valid texel at all (a face fully buried in other geometry) is white.
 */
export function finishRect(value: Float32Array, valid: Uint8Array, w: number, h: number): void {
  const src = value.slice();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!valid[j * w + i]) continue;
      let sum = 0;
      let wsum = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const x = i + di;
          const y = j + dj;
          if (x < 0 || y < 0 || x >= w || y >= h || !valid[y * w + x]) continue;
          const k = (di === 0 ? 2 : 1) * (dj === 0 ? 2 : 1);
          sum += src[y * w + x]! * k;
          wsum += k;
        }
      }
      value[j * w + i] = sum / wsum;
    }
  }
  const ok = valid.slice();
  let pending = ok.reduce((a, v) => a + (v ? 0 : 1), 0);
  if (pending === w * h) {
    value.fill(1);
    return;
  }
  while (pending > 0) {
    const next = ok.slice();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (ok[j * w + i]) continue;
        let sum = 0;
        let cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const x = i + di;
            const y = j + dj;
            if (x < 0 || y < 0 || x >= w || y >= h || !ok[y * w + x]) continue;
            sum += value[y * w + x]!;
            cnt++;
          }
        }
        if (cnt) {
          value[j * w + i] = sum / cnt;
          next[j * w + i] = 1;
          pending--;
        }
      }
    }
    ok.set(next);
  }
}

/** Fade a ground texture to white towards its border (the outermost ring is exactly white). */
export function featherBorder(value: Float32Array, w: number, h: number, texels: number): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const d = Math.min(i, j, w - 1 - i, h - 1 - j);
      if (d >= texels) continue;
      const t = d / texels;
      const k = j * w + i;
      value[k] = 1 + (value[k]! - 1) * t;
    }
  }
}

const toByte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);

/**
 * Write a finished rect into an 8-bit single-channel image, including its gutter (edge texels
 * repeated outwards, so bilinear filtering at the face edge stays inside the face's values).
 */
export function writeRect(
  image: Uint8Array,
  imageWidth: number,
  rect: LightmapRect,
  value: Float32Array,
  gutter: number,
): void {
  const { w, h } = rect;
  for (let j = -gutter; j < h + gutter; j++) {
    const sj = Math.min(h - 1, Math.max(0, j));
    for (let i = -gutter; i < w + gutter; i++) {
      const si = Math.min(w - 1, Math.max(0, i));
      image[(rect.y + j) * imageWidth + rect.x + i] = toByte(value[sj * w + si]!);
    }
  }
}

/**
 * The occluders a bake sees: every *rendered* static solid, colliding or not (an awning shades
 * even if you can walk through it), and none of the invisible collision-only geometry (bounds,
 * stair ramps) that would shade surfaces nobody sees as covered. Tree trunks stay; crowns and
 * foliage are soft and are not baked.
 */
export function bakeOccluders(map: MapDefinition): MapDefinition {
  return {
    ...map,
    boxes: map.boxes.filter((b) => b.visible !== false).map((b) => ({ ...b, collide: true })),
    prisms: (map.prisms ?? [])
      .filter((p) => p.visible !== false && !p.backdrop)
      .map((p) => ({ ...p, collide: true })),
  };
}

// ---- ceiling lamps -----------------------------------------------------------------------------

// Emitters live beside the lamp volume (the client validates the volume against them).
export { bakeEmitters, type BakeEmitter } from './lampVolume.ts';

/** Lamps are gathered within this distance (m); beyond it a fixture adds < 1 % of full scale. */
export const LAMP_REACH = 14;
/** Points sampled on each emitter face (a 2 × 2 jittered grid: soft shadow edges). */
const LAMP_POINTS = 4;

/** Emitters that can reach any texel of the rect (bounding-box distance < `LAMP_REACH`). */
export function emittersNear(rect: LightmapRect, emitters: readonly BakeEmitter[]): BakeEmitter[] {
  const corners = [
    rectWorld(rect, 0, 0),
    rectWorld(rect, rect.w, 0),
    rectWorld(rect, 0, rect.h),
    rectWorld(rect, rect.w, rect.h),
  ];
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const c of corners) {
    lo.x = Math.min(lo.x, c.x);
    lo.y = Math.min(lo.y, c.y);
    lo.z = Math.min(lo.z, c.z);
    hi.x = Math.max(hi.x, c.x);
    hi.y = Math.max(hi.y, c.y);
    hi.z = Math.max(hi.z, c.z);
  }
  return emitters.filter((e) => {
    // Faces entirely above the fixture never see its downward light.
    if (lo.y > e.at.y) return false;
    const dx = Math.max(lo.x - e.at.x, 0, e.at.x - hi.x);
    const dy = Math.max(lo.y - e.at.y, 0, e.at.y - hi.y);
    const dz = Math.max(lo.z - e.at.z, 0, e.at.z - hi.z);
    return dx * dx + dy * dy + dz * dz < LAMP_REACH * LAMP_REACH;
  });
}

/**
 * The point at stratum coordinates (su, sv) ∈ [0, 1)² on an emitter's face: the rectangle, or
 * mapped area-uniformly onto the disc (writes x/z into `out`; the face lies at `em.at.y`).
 */
function emitterPoint(em: BakeEmitter, su: number, sv: number, out: { x: number; z: number }) {
  if (em.disc) {
    const r = Math.sqrt(su) * em.hx;
    const phi = 2 * Math.PI * sv;
    out.x = em.at.x + r * Math.cos(phi);
    out.z = em.at.z + r * Math.sin(phi);
  } else {
    out.x = em.at.x + (su * 2 - 1) * em.hx;
    out.z = em.at.z + (sv * 2 - 1) * em.hz;
  }
}

/**
 * Stratum coordinates (u, v) ∈ [0, 1)² of lamp sample `s` (< `LAMP_POINTS`) for atlas texel
 * (x, y): cell (s & 1, s >> 1) of the 2 × 2 grid, jittered within it (writes into `out`). One
 * full 32-bit hash per sample, split 16/16 (slicing one per-texel hash left the last sample only
 * 4 bits of v: it always sat near the emitter's midline).
 */
export function lampStratum(x: number, y: number, s: number, out: { u: number; v: number }) {
  const h = hashSeed(x, y, s, 0x1a4b);
  const ju = ((h & 0xffff) + 0.5) / 65536;
  const jv = ((h >>> 16) + 0.5) / 65536;
  out.u = ((s & 1) + ju) / 2;
  out.v = ((s >> 1) + jv) / 2;
}

/**
 * Direct light from the ceiling fixtures onto one rect (irradiance, not yet scaled): each emitter
 * face is a Lambertian area light facing down, sampled at `LAMP_POINTS` jittered points with a
 * shadow ray each — E = Σ L·A·cosθ_surface·cosθ_lamp / (d² + A/π) (the A/π term keeps texels
 * right under a panel finite). Same texel order and `rows` contract as `bakeRect`.
 */
export function bakeLampRect(
  world: BakeWorld,
  rect: LightmapRect,
  emitters: readonly BakeEmitter[],
  settings: BakeSettings = BAKE_SETTINGS,
  rows: readonly [number, number] = [0, rect.h],
): Float32Array {
  const w = rect.w;
  const [j0, j1] = rows;
  const value = new Float32Array(w * (j1 - j0));
  const near = emittersNear(rect, emitters);
  if (!near.length) return value;
  const n = rect.n;
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: 0 };
  const q = { x: 0, z: 0 };
  const st = { u: 0, v: 0 };
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < w; i++) {
      const p = rectWorld(rect, i + 0.5, j + 0.5);
      origin.x = p.x + n.x * settings.offset;
      origin.y = p.y + n.y * settings.offset;
      origin.z = p.z + n.z * settings.offset;
      if (world.isInside?.(origin)) continue;
      let e = 0;
      for (const em of near) {
        const area = em.disc ? Math.PI * em.hx * em.hx : 4 * em.hx * em.hz;
        const a = area / LAMP_POINTS;
        for (let s = 0; s < LAMP_POINTS; s++) {
          // Jittered stratum (per-texel hash), on the rectangle or mapped onto the disc.
          lampStratum(rect.x + i, rect.y + j, s, st);
          emitterPoint(em, st.u, st.v, q);
          const dx = q.x - origin.x;
          const dy = em.at.y - origin.y;
          const dz = q.z - origin.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > LAMP_REACH * LAMP_REACH || dy <= 0) continue;
          const d = Math.sqrt(d2);
          dir.x = dx / d;
          dir.y = dy / d;
          dir.z = dz / d;
          const cosS = dir.x * n.x + dir.y * n.y + dir.z * n.z;
          if (cosS <= 0) continue;
          const cosL = dir.y; // the face points down: cos to its normal (0, −1, 0) is dir.y
          if (world.castRay(origin, dir, d - 0.01)) continue; // shadowed
          e += (em.radiance * a * cosS * cosL) / (d2 + a / Math.PI);
        }
      }
      value[(j - j0) * w + i] = e;
    }
  }
  return value;
}

// ---- lamp volume (dynamic objects) -------------------------------------------------------------

/** Points per emitter per voxel: a 4 × 4 jittered grid (a voxel has no blur pass to hide noise). */
export const LAMP_VOLUME_GRID = 4;
/** Rings of buried voxels filled from their open neighbours (so filtering at floors stays lit). */
export const LAMP_VOLUME_DILATE = 2;

export interface VolumeSamples {
  /** Per voxel (a, vx, vy, vz): the L1 irradiance terms (see `lampVolume.ts`). */
  value: Float32Array<ArrayBuffer>;
  /** 1 = voxel centre in open air; 0 = buried in geometry (filled by `finishLampVolume`). */
  valid: Uint8Array<ArrayBuffer>;
}

/**
 * Bake the lamp volume (or slices [k0, k1) of it — the baker's fixed jobs; the voxels are
 * bit-identical to a whole-volume bake). Same emitter maths as `bakeLampRect` — each fixture a
 * downward Lambertian area light with a shadow ray per sample point — but accumulated as L1
 * irradiance (no surface normal yet): a light of weight w = L·A·cosθ_lamp / (d² + A/π) from
 * direction l adds w/4 to a and w·l/2 to v.
 */
export function bakeLampVolume(
  world: BakeWorld,
  layout: LampVolumeLayout,
  emitters: readonly BakeEmitter[],
  slices: readonly [number, number] = [0, layout.nz],
): VolumeSamples {
  const { nx, ny } = layout;
  const [k0, k1] = slices;
  const value = new Float32Array(nx * ny * (k1 - k0) * 4);
  const valid = new Uint8Array(nx * ny * (k1 - k0));
  const g = LAMP_VOLUME_GRID;
  const dir = { x: 0, y: 0, z: 0 };
  const q = { x: 0, z: 0 };
  const r2 = LAMP_REACH * LAMP_REACH;
  for (let k = k0; k < k1; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = ((k - k0) * ny + j) * nx + i;
        const p = voxelCentre(layout, i, j, k);
        if (world.isInside?.(p)) continue;
        valid[v] = 1;
        let a = 0;
        let vx = 0;
        let vy = 0;
        let vz = 0;
        for (let e = 0; e < emitters.length; e++) {
          const em = emitters[e]!;
          if (em.at.y <= p.y) continue; // the fixture shines down only
          const bx = Math.max(Math.abs(p.x - em.at.x) - em.hx, 0);
          const bz = Math.max(Math.abs(p.z - em.at.z) - em.hz, 0);
          const by = em.at.y - p.y;
          if (bx * bx + by * by + bz * bz >= r2) continue;
          const area = (em.disc ? Math.PI * em.hx * em.hx : 4 * em.hx * em.hz) / (g * g);
          for (let s = 0; s < g * g; s++) {
            const h = hashSeed(i, j, k, e, s, 0x1a4c);
            const ju = ((h & 0xffff) + 0.5) / 65536;
            const jv = ((h >>> 16) + 0.5) / 65536;
            emitterPoint(em, ((s % g) + ju) / g, (Math.floor(s / g) + jv) / g, q);
            const dx = q.x - p.x;
            const dy = em.at.y - p.y;
            const dz = q.z - p.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r2 || dy <= 0) continue;
            const d = Math.sqrt(d2);
            dir.x = dx / d;
            dir.y = dy / d;
            dir.z = dz / d;
            if (world.castRay(p, dir, d - 0.01)) continue; // shadowed
            const w = (em.radiance * area * dir.y) / (d2 + area / Math.PI);
            a += w / 4;
            vx += (w / 2) * dir.x;
            vy += (w / 2) * dir.y;
            vz += (w / 2) * dir.z;
          }
        }
        value[v * 4] = a;
        value[v * 4 + 1] = vx;
        value[v * 4 + 2] = vy;
        value[v * 4 + 3] = vz;
      }
    }
  }
  return { value, valid };
}

/**
 * Finish a baked volume in place: fill `LAMP_VOLUME_DILATE` rings of buried voxels with the mean
 * of their open face neighbours (a soldier's feet sit between the floor's buried voxels and the air
 * above; without this, filtering would halve the light at floor level), leave deeper ones dark,
 * and zero the outer shell so clamp-to-edge sampling outside the grid adds nothing.
 */
export function finishLampVolume(layout: LampVolumeLayout, s: VolumeSamples): void {
  const { nx, ny, nz } = layout;
  const { value } = s;
  const ok = s.valid.slice();
  const nb = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const;
  for (let ring = 0; ring < LAMP_VOLUME_DILATE; ring++) {
    const next = ok.slice();
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const v = (k * ny + j) * nx + i;
          if (ok[v]) continue;
          const sum = [0, 0, 0, 0];
          let cnt = 0;
          for (const [di, dj, dk] of nb) {
            const x = i + di;
            const y = j + dj;
            const z = k + dk;
            if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
            const u = (z * ny + y) * nx + x;
            if (!ok[u]) continue;
            for (let c = 0; c < 4; c++) sum[c]! += value[u * 4 + c]!;
            cnt++;
          }
          if (!cnt) continue;
          for (let c = 0; c < 4; c++) value[v * 4 + c] = sum[c]! / cnt;
          next[v] = 1;
        }
      }
    }
    ok.set(next);
  }
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i && j && k && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
        value.fill(0, ((k * ny + j) * nx + i) * 4, ((k * ny + j) * nx + i) * 4 + 4);
      }
    }
  }
}
