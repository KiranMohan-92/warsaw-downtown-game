/**
 * Baked ceiling-lamp light for *dynamic* objects (soldiers, the first-person arms and guns,
 * pickups, the skateboard, hero models): a coarse 3D grid of irradiance from the same emitters as
 * the static lamp atlas (`lightmapBake.bakeLampRect`), with shadow rays. Pure layout, encoding and
 * validation live here (baker, client and tests share them); the bake itself is
 * `lightmapBake.bakeLampVolume`.
 *
 * Each voxel stores the L1 (order-1 spherical-harmonic) irradiance of the lamps it sees: a light
 * of weight w from unit direction l contributes max(0, n·l)·w ≈ w·(1/4 + n·l/2) for a surface
 * normal n, so a voxel keeps a = Σ w/4 and v = Σ w·l/2 and a surface reads
 * E(n) = clamp(a + v·n, 0, 3a) — tops of heads lit, undersides dark, one texture fetch.
 */
import type { Vec3 } from '../math/vec3.ts';
import { hashString, LAMP_SCALE, type BakedLightmap } from './lightmap.ts';
import type { MapDefinition } from './types.ts';

// ---- emitters ----------------------------------------------------------------------------------

/** A baked light: the downward-facing emitting face of a `lightPanel` / `pendant` dress box. */
export interface BakeEmitter {
  /** Centre of the emitting (bottom) face, a hair below it. */
  at: Vec3;
  /** Half extents of the face along x / z (a pendant's bulb is a disc of radius `hx`). */
  hx: number;
  hz: number;
  disc: boolean;
  /** Radiance (arbitrary units; `LAMP_SCALE` maps irradiance to the stored byte). */
  radiance: number;
}

/**
 * Radiance per fixture kind. A pendant's bulb is small and hangs high, so it is far brighter per
 * square metre than a diffuser panel; both land at ~0.4–0.9 of `LAMP_SCALE` on the floor below.
 */
const EMITTER_RADIANCE = { lightPanel: 9, pendant: 70 } as const;
const PENDANT_BULB = 0.2;

/** Every ceiling fixture on the map as a baked emitter (axis-aligned dress boxes). */
export function bakeEmitters(map: MapDefinition): BakeEmitter[] {
  const out: BakeEmitter[] = [];
  for (const b of map.boxes) {
    if (b.dress !== 'lightPanel' && b.dress !== 'pendant') continue;
    const pendant = b.dress === 'pendant';
    out.push({
      at: { x: b.center.x, y: b.center.y - b.size.y / 2 - 0.02, z: b.center.z },
      hx: pendant ? PENDANT_BULB : b.size.x / 2 - 0.025,
      hz: pendant ? PENDANT_BULB : b.size.z / 2 - 0.025,
      disc: pendant,
      radiance: EMITTER_RADIANCE[b.dress],
    });
  }
  return out;
}

// ---- layout ------------------------------------------------------------------------------------

/** Bump when the voxel maths or encoding changes (old bakes then fail validation). */
export const LAMP_VOLUME_VERSION = 1;
/** Voxel edge lengths tried in order (m): the finest whose grid fits the budgets below wins. */
export const LAMP_VOLUME_CELLS: readonly number[] = [0.5, 0.75, 1];
/** Voxel budget (4 bytes each on the GPU: 1.5 MiB; the Market fits at 0.75 m). */
export const LAMP_VOLUME_MAX_VOXELS = 3 << 17;
/** WebGL2 guarantees 3D textures up to 256 texels a side. */
export const LAMP_VOLUME_MAX_DIM = 256;
/** The grid covers each fixture ± this far sideways (m)… */
export const LAMP_VOLUME_REACH = 8;
/** …and this far below it (floors sit 3–5 m under the lamps). */
export const LAMP_VOLUME_DEPTH = 6;

/** The grid: voxel (i, j, k) is centred at min + (i + ½, j + ½, k + ½)·cell. */
export interface LampVolumeLayout {
  min: Vec3;
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  /** Hash of the grid and the emitters (the voxels are only valid for exactly these). */
  hash: string;
}

const qmm = (v: number): number => Math.round(v * 1000);

/**
 * One box over every fixture's reach (± `LAMP_VOLUME_REACH` sideways, `LAMP_VOLUME_DEPTH` below,
 * one voxel above), padded by a voxel of darkness on every side so clamp-to-edge sampling outside
 * the box reads zero. Null when the map has no fixtures. Deterministic.
 */
export function lampVolumeLayout(emitters: readonly BakeEmitter[]): LampVolumeLayout | null {
  if (!emitters.length) return null;
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const e of emitters) {
    lo.x = Math.min(lo.x, e.at.x - LAMP_VOLUME_REACH);
    hi.x = Math.max(hi.x, e.at.x + LAMP_VOLUME_REACH);
    lo.z = Math.min(lo.z, e.at.z - LAMP_VOLUME_REACH);
    hi.z = Math.max(hi.z, e.at.z + LAMP_VOLUME_REACH);
    lo.y = Math.min(lo.y, e.at.y - LAMP_VOLUME_DEPTH);
    hi.y = Math.max(hi.y, e.at.y);
  }
  const grid = (cell: number): Omit<LampVolumeLayout, 'hash'> => {
    const min = {
      x: (Math.floor(lo.x / cell) - 1) * cell,
      y: (Math.floor(lo.y / cell) - 1) * cell,
      z: (Math.floor(lo.z / cell) - 1) * cell,
    };
    const n = (a: number, h: number): number => Math.ceil((h - a) / cell - 1e-9) + 1;
    return { min, cell, nx: n(min.x, hi.x), ny: n(min.y, hi.y), nz: n(min.z, hi.z) };
  };
  const fits = (g: Omit<LampVolumeLayout, 'hash'>): boolean =>
    g.nx * g.ny * g.nz <= LAMP_VOLUME_MAX_VOXELS &&
    Math.max(g.nx, g.ny, g.nz) <= LAMP_VOLUME_MAX_DIM;
  let g = LAMP_VOLUME_CELLS.map(grid).find(fits);
  // A lamp-heavy map beyond the budgets: coarsen in 0.25 m steps until it fits.
  for (let cell = LAMP_VOLUME_CELLS.at(-1)! + 0.25; !g; cell += 0.25) {
    const c = grid(cell);
    if (fits(c)) g = c;
  }
  const hash = hashString(
    [
      `lampvol${LAMP_VOLUME_VERSION}`,
      qmm(g.cell),
      qmm(g.min.x),
      qmm(g.min.y),
      qmm(g.min.z),
      g.nx,
      g.ny,
      g.nz,
      ...emitters.map(
        (e) =>
          `${qmm(e.at.x)},${qmm(e.at.y)},${qmm(e.at.z)},${qmm(e.hx)},${qmm(e.hz)},${e.disc ? 1 : 0},${e.radiance}`,
      ),
    ].join('|'),
  );
  return { ...g, hash };
}

/** World centre of voxel (i, j, k). */
export function voxelCentre(l: LampVolumeLayout, i: number, j: number, k: number): Vec3 {
  return {
    x: l.min.x + (i + 0.5) * l.cell,
    y: l.min.y + (j + 0.5) * l.cell,
    z: l.min.z + (k + 0.5) * l.cell,
  };
}

// ---- encoding ----------------------------------------------------------------------------------

/**
 * Scale of the stored ambient term a (byte 255 = `LAMP_VOLUME_SCALE`); the direction vector v is
 * stored signed over ±2·`LAMP_VOLUME_SCALE` (|v| ≤ 2a for any set of lights). Linear, not √ like
 * the atlas: the shader combines a and v, so they must interpolate linearly.
 */
export const LAMP_VOLUME_SCALE = LAMP_SCALE / 2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Voxel (a, vx, vy, vz) → 4 bytes: a unsigned, v signed around 128 (128 = exactly zero). */
export function encodeLampVoxel(value: ArrayLike<number>, o: number, out: Uint8Array, k: number) {
  const s = LAMP_VOLUME_SCALE;
  out[k] = Math.round(clamp(value[o]! / s, 0, 1) * 255);
  for (let c = 1; c < 4; c++)
    out[k + c] = 128 + Math.round(clamp(value[o + c]! / (2 * s), -1, 1) * 127);
}

/**
 * The volume as one greyscale image (compressed as a PNG like the other lightmaps): four planes
 * (a, vx, vy, vz) stacked vertically, each `nz` slices of `ny` rows of `nx` bytes, i.e.
 * row (c·nz + k)·ny + j, column i. `value` holds 4 floats per voxel, index (k·ny + j)·nx + i.
 */
export function lampVolumePlanes(l: LampVolumeLayout, value: Float32Array): Uint8Array {
  const n = l.nx * l.ny * l.nz;
  const out = new Uint8Array(n * 4);
  const px = new Uint8Array(4);
  for (let v = 0; v < n; v++) {
    encodeLampVoxel(value, v * 4, px, 0);
    for (let c = 0; c < 4; c++) out[c * n + v] = px[c]!;
  }
  return out;
}

/** Image size of `lampVolumePlanes` (width, height). */
export const lampVolumeImageSize = (l: LampVolumeLayout): [number, number] => [
  l.nx,
  4 * l.ny * l.nz,
];

/** Planes (as decoded from the PNG) → interleaved RGBA voxels for a 3D texture (x fastest). */
export function lampVolumeRgba(
  planes: Uint8Array,
  out: Uint8Array = new Uint8Array(planes.length),
): Uint8Array {
  const n = planes.length / 4;
  for (let v = 0; v < n; v++) {
    for (let c = 0; c < 4; c++) out[v * 4 + c] = planes[c * n + v]!;
  }
  return out;
}

/**
 * Irradiance at world point `p` for a surface with unit normal `n`, trilinear over the RGBA
 * voxels exactly as the client shader does (texel centres at voxel centres, clamp to edge).
 */
export function sampleLampVolume(l: LampVolumeLayout, rgba: Uint8Array, p: Vec3, n: Vec3): number {
  const f = (v: number, lo: number, cells: number): [number, number, number] => {
    const t = clamp((v - lo) / l.cell - 0.5, 0, cells - 1);
    const i0 = Math.min(cells - 1, Math.floor(t));
    return [i0, Math.min(cells - 1, i0 + 1), t - i0];
  };
  const [x0, x1, fx] = f(p.x, l.min.x, l.nx);
  const [y0, y1, fy] = f(p.y, l.min.y, l.ny);
  const [z0, z1, fz] = f(p.z, l.min.z, l.nz);
  const t = [0, 0, 0, 0];
  for (const [z, wz] of [
    [z0, 1 - fz],
    [z1, fz],
  ] as const) {
    for (const [y, wy] of [
      [y0, 1 - fy],
      [y1, fy],
    ] as const) {
      for (const [x, wx] of [
        [x0, 1 - fx],
        [x1, fx],
      ] as const) {
        const k = ((z * l.ny + y) * l.nx + x) * 4;
        const w = wx * wy * wz;
        for (let c = 0; c < 4; c++) t[c]! += (rgba[k + c]! / 255) * w;
      }
    }
  }
  const s = LAMP_VOLUME_SCALE;
  const a = t[0]! * s;
  const sv = (b: number): number => ((b * 255 - 128) / 127) * 2 * s;
  const e = a + sv(t[1]!) * n.x + sv(t[2]!) * n.y + sv(t[3]!) * n.z;
  return clamp(e, 0, 3 * a);
}

// ---- manifest ----------------------------------------------------------------------------------

/** A bake's lamp volume, as recorded in the manifest (`BakedLightmap.volume`). */
export interface BakedLampVolume {
  /** Greyscale PNG under `client/public/lightmaps/` (`lampVolumePlanes`). */
  file: string;
  hash: string;
  cell: number;
  min: Vec3;
  nx: number;
  ny: number;
  nz: number;
}

/** The manifest entry for a baked volume. */
export const bakedLampVolume = (file: string, l: LampVolumeLayout): BakedLampVolume => ({
  file,
  hash: l.hash,
  cell: l.cell,
  min: { ...l.min },
  nx: l.nx,
  ny: l.ny,
  nz: l.nz,
});

export type LampVolumeSelection =
  /** The bake has no volume (it predates it): dynamic objects get no lamp light, silently. */
  | { kind: 'none' }
  /** A volume exists but no longer fits the map's lamps: skip it and warn. */
  | { kind: 'skip'; message: string }
  | { kind: 'use'; file: string; layout: LampVolumeLayout };

/**
 * Validate a bake's optional volume against the map's fixtures *now* (same contract as
 * `selectBakedLightmap`: an exact layout match, else it is skipped with a warning; the rest of the
 * bake is unaffected). Occluder-only changes are covered by the bake's scene hash (stale warning).
 */
export function selectLampVolume(map: MapDefinition, baked: BakedLightmap): LampVolumeSelection {
  const v = baked.volume;
  if (!v) return { kind: 'none' };
  const layout = lampVolumeLayout(bakeEmitters(map));
  const skip = (why: string): LampVolumeSelection => ({
    kind: 'skip',
    message: `baked lamp volume for "${baked.mapName}": ${why}; dynamic objects get no lamp light (re-run \`pnpm bake\`)`,
  });
  if (!layout) return skip('the map has no ceiling lamps any more');
  if (v.hash !== layout.hash)
    return skip(`baked for ${v.hash}, the lamps now lay out as ${layout.hash}`);
  if (
    v.nx !== layout.nx ||
    v.ny !== layout.ny ||
    v.nz !== layout.nz ||
    v.cell !== layout.cell ||
    v.min.x !== layout.min.x ||
    v.min.y !== layout.min.y ||
    v.min.z !== layout.min.z
  ) {
    return skip('grid differs from the layout');
  }
  return { kind: 'use', file: v.file, layout };
}
