import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  crate,
  cratePile,
  crateSteps,
  DECOR,
  DECOR_KINDS,
  getMap,
  jersey,
  resolveMap,
  type MapBox,
  type Vec3,
} from '@wd/shared';
import {
  bestGrid,
  DECOR_MODELS,
  fitBox,
  fitDecor,
  instanceCorners,
  PROP_MODEL_IDS,
  TAG_MODELS,
  type ModelSizes,
  type PropInstance,
} from './propFit.ts';

const MODELS = fileURLToPath(new URL('../../public/models/', import.meta.url));

type Manifest = { models: Record<string, { size: [number, number, number]; triangles: number }> };
const manifest = JSON.parse(readFileSync(`${MODELS}manifest.json`, 'utf8')) as Manifest;

/** Model sizes as the build tool measured them (the runtime measures the same geometry). */
const SIZES = Object.fromEntries(
  PROP_MODEL_IDS.map((id) => {
    const [x, y, z] = manifest.models[id]!.size;
    return [id, { x, y, z }];
  }),
) as unknown as ModelSizes;

/** World-space AABB of a set of points. */
function aabb(pts: Vec3[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pts) {
    for (const k of ['x', 'y', 'z'] as const) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

/** Box corners (world) — the collision box. */
function boxCorners(b: MapBox): Vec3[] {
  const yaw = ((b.rot?.y ?? 0) * Math.PI) / 180;
  const out: Vec3[] = [];
  for (const sx of [-0.5, 0.5]) {
    for (const sy of [-0.5, 0.5]) {
      for (const sz of [-0.5, 0.5]) {
        const x = sx * b.size.x;
        const z = sz * b.size.z;
        out.push({
          x: b.center.x + x * Math.cos(yaw) + z * Math.sin(yaw),
          y: b.center.y + sy * b.size.y,
          z: b.center.z - x * Math.sin(yaw) + z * Math.cos(yaw),
        });
      }
    }
  }
  return out;
}

/** Point in box `b`'s local frame (yaw-only boxes). */
function toLocal(b: MapBox, p: Vec3): Vec3 {
  const yaw = ((b.rot?.y ?? 0) * Math.PI) / 180;
  const dx = p.x - b.center.x;
  const dz = p.z - b.center.z;
  return {
    x: dx * Math.cos(yaw) - dz * Math.sin(yaw),
    y: p.y - b.center.y,
    z: dx * Math.sin(yaw) + dz * Math.cos(yaw),
  };
}

const cornersOf = (inst: PropInstance): Vec3[] => instanceCorners(inst, SIZES[inst.model]);

/** Every instance lies inside the box, and together they reach every face of it. */
function expectFills(b: MapBox, insts: PropInstance[], tol = 1e-6): void {
  expect(insts.length).toBeGreaterThan(0);
  let volume = 0;
  for (const inst of insts) {
    const local = cornersOf(inst).map((p) => toLocal(b, p));
    const { min, max } = aabb(local);
    for (const k of ['x', 'y', 'z'] as const) {
      expect(min[k]).toBeGreaterThanOrEqual(-b.size[k] / 2 - tol);
      expect(max[k]).toBeLessThanOrEqual(b.size[k] / 2 + tol);
    }
    volume += (max.x - min.x) * (max.y - min.y) * (max.z - min.z);
  }
  // Cells don't overlap and leave no gaps: their volumes add up to the box's.
  expect(volume).toBeCloseTo(b.size.x * b.size.y * b.size.z, 6);
  const all = aabb(insts.flatMap(cornersOf));
  const want = aabb(boxCorners(b));
  for (const k of ['x', 'y', 'z'] as const) {
    expect(all.min[k]).toBeCloseTo(want.min[k], 6);
    expect(all.max[k]).toBeCloseTo(want.max[k], 6);
  }
}

describe('fitBox (model-to-box fit)', () => {
  it('fills a crate exactly: footprint and height, at any yaw', () => {
    for (const rot of [0, 30, 90, -135]) {
      for (const size of [0.9, 1.1, 1.2]) {
        const [b] = crate({ x: 3, z: -7, rot }, size);
        expectFills(b!, fitBox(b!, SIZES));
      }
    }
  });

  it('fills every part of crate piles and crate steps (stacked parts too)', () => {
    for (const b of [...cratePile({ x: 10, z: 4, rot: 17 }), ...crateSteps({ x: -2, z: 1 })]) {
      expectFills(b, fitBox(b, SIZES));
    }
  });

  it('tiles a jersey run along its length, one barrier per ~1.5 m', () => {
    for (const length of [3, 4, 6, 8]) {
      const [b] = jersey({ x: 0, z: 0, rot: 60 }, length);
      const insts = fitBox(b!, SIZES);
      expectFills(b!, insts);
      expect(insts.every((i) => i.model === 'jersey')).toBe(true);
      expect(insts.length).toBe(Math.round(length / SIZES.jersey.x));
    }
  });

  it('keeps stretch small for every tagged box on the maps', () => {
    for (const map of [resolveMap(getMap('defilad'), 'market'), getMap('range')]) {
      const tagged = map.boxes.filter((b) => b.model);
      expect(tagged.length).toBeGreaterThan(0);
      for (const b of tagged) {
        const t = TAG_MODELS[b.model!];
        const fit = bestGrid(b.size, t.models, SIZES, 0, t.maxCells, 1);
        // One crate per collision envelope bounds vertex work; elongated barriers are tiled.
        expect(fit.stretch).toBeLessThan(1.8);
        if (b.model === 'crate') expect(fitBox(b, SIZES)).toHaveLength(1);
        expectFills(b, fitBox(b, SIZES), 1e-5);
      }
    }
  }, 30_000); // builds the whole map

  it('is deterministic and draws nothing for untagged boxes', () => {
    const [b] = cratePile({ x: 1, z: 2 });
    expect(fitBox(b!, SIZES)).toEqual(fitBox(b!, SIZES));
    const { model: _model, ...plain } = b!;
    expect(fitBox(plain, SIZES)).toEqual([]);
  });

  it('prefers the grid that stretches the model least', () => {
    const s = SIZES.crate;
    // A box exactly two crates long (along x, turned) and one high: two unstretched crates.
    const fit = bestGrid({ x: 2 * s.z, y: s.y, z: s.x }, ['crate'], SIZES);
    expect(fit.turn).toBe(90);
    expect(fit.n).toEqual([2, 1, 1]);
    expect(fit.stretch).toBeCloseTo(0, 9);
  });
});

describe('fitDecor', () => {
  it('fits every decor kind to its size (≈ the model, scale ~1), stacked where it stacks', () => {
    for (const kind of DECOR_KINDS) {
      const d = { kind, x: 5, z: -3, rot: 40 };
      const insts = fitDecor(d, SIZES);
      const { model, stack } = DECOR_MODELS[kind];
      expect(insts).toHaveLength(stack);
      for (const i of insts) {
        expect(i.model).toBe(model);
        for (const k of ['x', 'y', 'z'] as const) expect(i.scale[k]).toBeCloseTo(1, 1);
      }
      const all = aabb(insts.flatMap(cornersOf));
      expect(all.min.y).toBeCloseTo(0, 9);
      expect(all.max.y).toBeCloseTo(DECOR[kind].size.y, 6);
    }
  });

  it("decor sizes match the processed models (the fitter doesn't distort them)", () => {
    for (const kind of DECOR_KINDS) {
      const { model, stack } = DECOR_MODELS[kind];
      const m = SIZES[model];
      const s = DECOR[kind].size;
      expect(s.x).toBeCloseTo(m.x, 2);
      expect(s.y).toBeCloseTo(m.y * stack, 2);
      expect(s.z).toBeCloseTo(m.z, 2);
    }
  });
});

describe('processed models', () => {
  it('ships every model the fitter uses, with sizes matching the glTF bounds', () => {
    for (const id of PROP_MODEL_IDS) {
      const gltf = JSON.parse(readFileSync(`${MODELS}${id}/${id}.gltf`, 'utf8')) as {
        accessors: { min?: number[]; max?: number[] }[];
      };
      const pos = gltf.accessors[0]!;
      const size = pos.max!.map((v, k) => v - pos.min![k]!);
      manifest.models[id]!.size.forEach((v, k) => expect(size[k]).toBeCloseTo(v, 3));
      // Recentred: footprint centre at the origin, base at y = 0.
      expect(pos.min![1]).toBeCloseTo(0, 4);
      expect(pos.min![0]! + pos.max![0]!).toBeCloseTo(0, 4);
      expect(pos.min![2]! + pos.max![2]!).toBeCloseTo(0, 4);
      // Small props ≤ 1.5k; the covered car keeps its cabin shape only at ~4k (a few per street).
      expect(manifest.models[id]!.triangles).toBeLessThanOrEqual(id === 'car' ? 4000 : 1500);
    }
  });
});
