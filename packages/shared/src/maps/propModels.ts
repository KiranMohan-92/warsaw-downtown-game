/**
 * Shared placement for both collision and rendering (no three.js).
 *
 * - A tagged box (`MapBox.model`: crates, jersey barriers) defines the exact placement envelope.
 *   Crates use one model per box; the former grid created
 *   thousands of redundant instances. The closer of two crate shapes is fitted to the envelope;
 *   jersey runs are tiled along their length.
 * - A decor piece (`MapDecor`) is its model(s) fitted to the kind's size (shared maps/decor.ts),
 *   which is the processed model's own bounding box, so the scale is ~1.
 *
 * Every model is authored with its footprint centre at the origin, base at y = 0 (the build tool
 * recentres them), so an instance's position is the bottom centre of its cell.
 */
import { CARDBOARD_STACK, DECOR, TYRE_STACK } from './decor.ts';
import { quatFromEulerDeg, rotateByQuat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { Quat } from '../math/quat.ts';
import type { DecorKind, MapBox, MapDecor, PropModelTag } from './types.ts';
import geometry from './propGeometry.gen.json' with { type: 'json' };

/** The processed models in `public/models/` (tools/assets/build_models.py `MODELS`). */
export const PROP_MODEL_IDS = [
  'crate',
  'crate_small',
  'jersey',
  'drum',
  'bin',
  'lamp',
  'trashbag',
  'tyre',
  'utility_box',
  'cardboard_box',
  'car',
] as const;
export type PropModelId = (typeof PROP_MODEL_IDS)[number];

/** Generated from the shipped meshes; shared by client, server, baker and fallback renderer. */
export const PROP_GEOMETRY = geometry.models;
export const PROP_GEOMETRY_HASH = geometry.hash;
export const PROP_SIZES: ModelSizes = Object.fromEntries(
  PROP_MODEL_IDS.map((id) => {
    const [x, y, z] = geometry.models[id].size;
    return [id, { x: x!, y: y!, z: z! }];
  }),
) as Record<PropModelId, Vec3>;

/** Each model's bounding size (from its geometry at run time; the manifest in tests). */
export type ModelSizes = Readonly<Record<PropModelId, Vec3>>;

export interface PropInstance {
  model: PropModelId;
  /** Bottom centre of the instance (world). */
  pos: Vec3;
  quat: Quat;
  /** Scale in the model's own frame. */
  scale: Vec3;
}

/**
 * Models a tagged box may be filled with, and the most cells per horizontal axis (bounds the
 * instance count: one crate per box; a jersey run is one barrier per ~1.5 m).
 */
export const TAG_MODELS: Record<
  PropModelTag,
  { models: readonly PropModelId[]; maxCells: number; maxLayers?: number }
> = {
  crate: { models: ['crate', 'crate_small'], maxCells: 1 },
  jersey: { models: ['jersey'], maxCells: 16 },
  car: { models: ['car'], maxCells: 1 },
  // A pallet load of cartons: a small grid, stacked.
  cartons: { models: ['cardboard_box'], maxCells: 2, maxLayers: 3 },
};

/** Models (and how many, stacked) that make up a decor kind. */
export const DECOR_MODELS: Record<DecorKind, { model: PropModelId; stack: number }> = {
  bin: { model: 'bin', stack: 1 },
  drum: { model: 'drum', stack: 1 },
  lamp: { model: 'lamp', stack: 1 },
  trashbag: { model: 'trashbag', stack: 1 },
  tyres: { model: 'tyre', stack: TYRE_STACK },
  utilityBox: { model: 'utility_box', stack: 1 },
  cardboard: { model: 'cardboard_box', stack: CARDBOARD_STACK },
};
/** Max layers when tiling a box (bounds the instance count). */
const MAX_LAYERS = 4;
/** Cost per extra instance, in units of log-stretch (0.05 ≈ 5 % more stretch to save one). */
const INSTANCE_COST = 0.05;

export interface GridFit {
  model: PropModelId;
  /** 0 = model X along the box's X; 90 = model X along the box's Z. */
  turn: 0 | 90;
  /** Cells along the box's local x, y, z. */
  n: [number, number, number];
  /** Worst stretch of any axis, |ln(cell / model)|. */
  stretch: number;
}

/**
 * Best grid of model `candidates` for a box of size `s` (box local frame): per axis, the cell
 * count that brings the model closest to the cell, then the candidate with the least stretch
 * (plus a small cost per extra instance). Deterministic; `tie` (0..1) breaks near-ties so a map's
 * crates don't all pick the same shape.
 */
export function bestGrid(
  s: Vec3,
  candidates: readonly PropModelId[],
  sizes: ModelSizes,
  tie = 0,
  maxCells = 3,
  maxLayers = MAX_LAYERS,
): GridFit {
  let best: GridFit | null = null;
  let bestCost = Infinity;
  candidates.forEach((model, ci) => {
    for (const turn of [0, 90] as const) {
      const m = sizes[model];
      // The model's extent along the box's x / z (turned 90°: its X runs along the box's Z).
      const mx = turn ? m.z : m.x;
      const mz = turn ? m.x : m.z;
      const count = (len: number, unit: number, max = maxCells): number =>
        Math.min(max, Math.max(1, Math.round(len / unit)));
      const n: [number, number, number] = [
        count(s.x, mx),
        count(s.y, m.y, maxLayers),
        count(s.z, mz),
      ];
      const stretch = Math.max(
        Math.abs(Math.log(s.x / n[0] / mx)),
        Math.abs(Math.log(s.y / n[1] / m.y)),
        Math.abs(Math.log(s.z / n[2] / mz)),
      );
      // Near-ties between shapes: a per-box nudge (±0.015) so a map's crates mix.
      const nudge = candidates.length > 1 ? 0.03 * (((tie + ci * 0.618) % 1) - 0.5) : 0;
      const cost = stretch + INSTANCE_COST * (n[0] * n[1] * n[2] - 1) + nudge + turn * 1e-6;
      if (cost < bestCost) {
        bestCost = cost;
        best = { model, turn, n, stretch };
      }
    }
  });
  return best!;
}

const hash = (x: number, y: number, z: number, salt: number): number => {
  const h = Math.sin(x * 12.9898 + y * 4.1414 + z * 78.233 + salt * 37.719) * 43758.5453;
  return h - Math.floor(h);
};

/** q · r (apply r first, then q). */
export function mulQuat(q: Quat, r: Quat): Quat {
  return {
    x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
    y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
    z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
    w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
  };
}

const yawQuat = (deg: number): Quat => quatFromEulerDeg({ x: 0, y: deg, z: 0 });

/**
 * Model instances that exactly fill tagged box `b`: the union of their (scaled) bounding boxes is
 * the box. Empty for untagged boxes.
 */
export function fitBox(b: MapBox, sizes: ModelSizes): PropInstance[] {
  if (!b.model) return [];
  const s = b.size;
  const h = hash(b.center.x, b.center.y, b.center.z, 1);
  const tag = TAG_MODELS[b.model];
  const fit = bestGrid(s, tag.models, sizes, h, tag.maxCells, tag.maxLayers ?? 1);
  const m = sizes[fit.model];
  const cell = { x: s.x / fit.n[0], y: s.y / fit.n[1], z: s.z / fit.n[2] };
  // Scale in the model's frame: turned 90°, the model's X spans the cell's z.
  const scale = fit.turn
    ? { x: cell.z / m.x, y: cell.y / m.y, z: cell.x / m.z }
    : { x: cell.x / m.x, y: cell.y / m.y, z: cell.z / m.z };
  const boxQ = quatFromEulerDeg(b.rot);
  const out: PropInstance[] = [];
  for (let i = 0; i < fit.n[0]; i++) {
    for (let j = 0; j < fit.n[1]; j++) {
      for (let k = 0; k < fit.n[2]; k++) {
        const local = {
          x: -s.x / 2 + (i + 0.5) * cell.x,
          y: -s.y / 2 + j * cell.y,
          z: -s.z / 2 + (k + 0.5) * cell.z,
        };
        const w = rotateByQuat(local, boxQ);
        // Half-turns keep the cell's bounding box; they vary which face shows.
        const flip = hash(i, j, k, h * 100) < 0.5 ? 180 : 0;
        out.push({
          model: fit.model,
          pos: { x: b.center.x + w.x, y: b.center.y + w.y, z: b.center.z + w.z },
          quat: mulQuat(boxQ, yawQuat(fit.turn + flip)),
          scale,
        });
      }
    }
  }
  return out;
}

/** Model instances of decor piece `d`, fitted to its kind's size (stacks one above another). */
export function fitDecor(d: MapDecor, sizes: ModelSizes): PropInstance[] {
  const def = DECOR[d.kind];
  const { model, stack } = DECOR_MODELS[d.kind];
  const m = sizes[model];
  const layer = def.size.y / stack;
  const scale = { x: def.size.x / m.x, y: layer / m.y, z: def.size.z / m.z };
  const out: PropInstance[] = [];
  for (let k = 0; k < stack; k++) {
    // Stacked pieces alternate by a half-turn (same bounding box, less repetition).
    out.push({
      model,
      pos: { x: d.x, y: (d.y ?? 0) + k * layer, z: d.z },
      quat: yawQuat((d.rot ?? 0) + (k % 2) * 180),
      scale,
    });
  }
  return out;
}

/**
 * The world-space bounding box corners of an instance (for tests and debugging): the model's
 * bounding box (`size`, base at y = 0) scaled, rotated and placed.
 */
export function instanceCorners(inst: PropInstance, size: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-0.5, 0.5]) {
    for (const sy of [0, 1]) {
      for (const sz of [-0.5, 0.5]) {
        const local = {
          x: sx * size.x * inst.scale.x,
          y: sy * size.y * inst.scale.y,
          z: sz * size.z * inst.scale.z,
        };
        const w = rotateByQuat(local, inst.quat);
        out.push({ x: inst.pos.x + w.x, y: inst.pos.y + w.y, z: inst.pos.z + w.z });
      }
    }
  }
  return out;
}

/** Mesh in world coordinates. Kept in shared data so simulation never imports client assets. */
export function propSurface(inst: PropInstance): { positions: Float32Array; indices: Uint32Array } {
  const g = PROP_GEOMETRY[inst.model];
  const positions = new Float32Array(g.positions.length * 3);
  g.positions.forEach((p, i) => {
    const w = rotateByQuat(
      { x: p[0]! * inst.scale.x, y: p[1]! * inst.scale.y, z: p[2]! * inst.scale.z },
      inst.quat,
    );
    positions.set([w.x + inst.pos.x, w.y + inst.pos.y, w.z + inst.pos.z], i * 3);
  });
  return { positions, indices: new Uint32Array(g.indices) };
}

/**
 * Crates need an interior volume as well as a surface, so fully contained capsules are rejected
 * by spawn/traversal overlap tests. This core is ONLY an overlap query volume: bullets and
 * character sweeps use the scanned boards, preserving visible slat gaps. Other props cannot contain a
 * player capsule, or are intentionally hollow (bins/tyres).
 */
export function propInterior(inst: PropInstance): { center: Vec3; size: Vec3; quat: Quat } | null {
  if (inst.model !== 'crate' && inst.model !== 'crate_small') return null;
  const source = PROP_SIZES[inst.model];
  const size = {
    x: source.x * inst.scale.x,
    y: source.y * inst.scale.y,
    z: source.z * inst.scale.z,
  };
  const offset = rotateByQuat({ x: 0, y: size.y / 2, z: 0 }, inst.quat);
  return {
    center: { x: inst.pos.x + offset.x, y: inst.pos.y + offset.y, z: inst.pos.z + offset.z },
    size: { x: size.x * 0.7, y: size.y * 0.7, z: size.z * 0.7 },
    quat: inst.quat,
  };
}
