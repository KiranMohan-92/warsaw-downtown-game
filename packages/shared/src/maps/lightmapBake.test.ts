import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { buildLightmapLayout, type LightmapLayout, type LightmapRect } from './lightmap.ts';
import {
  bakeEmitters,
  bakeLampRect,
  bakeOccluders,
  bakeRect,
  bakeWorldOf,
  featherBorder,
  finishRect,
  hemispherePattern,
  lampStratum,
  writeRect,
  type BakeSettings,
  type BakeWorld,
} from './lightmapBake.ts';
import type { MapDefinition } from './types.ts';

/** A 2 m cube standing on a street slab: the textbook contact-shadow case. */
function boxOnPlane(): MapDefinition {
  return {
    name: 'box on a plane',
    bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 },
    boxes: [{ center: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' }],
    prisms: [
      {
        pts: [
          [-30, -30],
          [30, -30],
          [30, 30],
          [-30, 30],
        ],
        y0: -0.5,
        y1: 0,
        mat: 'concrete',
        top: 'paving',
      },
    ],
    spawns: [],
    dummies: [],
  };
}

const SETTINGS: BakeSettings = { samples: 32, reach: 8, offset: 0.03, groundFeather: 4 };

let layout: LightmapLayout;
let world: BakeWorld;

beforeAll(async () => {
  await initPhysics();
  const map = boxOnPlane();
  layout = buildLightmapLayout(map);
  world = bakeWorldOf(new PhysicsWorld(bakeOccluders(map)));
});

/** Ground texel (i, j) whose centre is nearest world (x, z). */
function groundTexel(x: number, z: number): number {
  const r = layout.ground.rect;
  const i = Math.floor((x - r.o.x) / r.su);
  const j = Math.floor((z - r.o.z) / r.sv);
  return j * r.w + i;
}

const rowMean = (v: Float32Array, rect: LightmapRect, j: number): number => {
  let s = 0;
  for (let i = 0; i < rect.w; i++) s += v[j * rect.w + i]!;
  return s / rect.w;
};

describe('lightmap baking', () => {
  it('darkens the ground at the base of a box and leaves open ground unoccluded', () => {
    const { value, valid } = bakeRect(world, layout.ground.rect, SETTINGS);
    const contact = value[groundTexel(1.1, 0)]!;
    const near = value[groundTexel(2, 0)]!;
    const open = value[groundTexel(7.5, 7.5)]!;
    expect(contact).toBeLessThan(near);
    expect(near).toBeLessThan(open);
    expect(contact).toBeLessThan(0.75);
    expect(open).toBeGreaterThan(0.95);
    // Under the box: buried (no rays), then filled from its neighbours by dilation.
    const under = groundTexel(0, 0);
    expect(valid[under]).toBe(0);
    finishRect(value, valid, layout.ground.rect.w, layout.ground.rect.h);
    expect(value[under]!).toBeGreaterThan(0.2);
    expect(value[under]!).toBeLessThan(1);
  });

  it('darkens a wall towards the ground it stands on', () => {
    const rect = layout.atlas.rects[layout.boxFaces[0]!]!; // +X face of the box
    const { value, valid } = bakeRect(world, rect, SETTINGS);
    expect(valid.every((v) => v === 1)).toBe(true);
    const bottom = rowMean(value, rect, 0); // v runs up the wall: row 0 is at the base
    const top = rowMean(value, rect, rect.h - 1);
    expect(bottom).toBeLessThan(top - 0.1);
    // The top face sees the whole sky.
    const topFace = layout.atlas.rects[layout.boxFaces[2]!]!;
    const up = bakeRect(world, topFace, SETTINGS).value;
    expect(Math.min(...up)).toBeGreaterThan(0.99);
  });

  it('is deterministic, and a banded bake equals the whole-rect bake bit for bit', () => {
    const rect = layout.ground.rect;
    const a = bakeRect(world, rect, SETTINGS);
    const b = bakeRect(world, rect, SETTINGS);
    expect(b.value).toEqual(a.value);
    const band = bakeRect(world, rect, SETTINGS, hemispherePattern(SETTINGS.samples), [10, 20]);
    expect(band.value).toEqual(a.value.slice(10 * rect.w, 20 * rect.w));
    expect(band.valid).toEqual(a.valid.slice(10 * rect.w, 20 * rect.w));
  });

  it('samples a cosine-weighted hemisphere', () => {
    const p = hemispherePattern(256);
    let cosSum = 0;
    for (let i = 0; i < 256; i++) {
      const s = p[i * 3]!;
      const c = p[i * 3 + 2]!;
      expect(s * s + c * c).toBeCloseTo(1, 12);
      expect(c).toBeGreaterThan(0);
      cosSum += c;
    }
    // E[cos θ] = 2/3 for a cosine-weighted hemisphere.
    expect(cosSum / 256).toBeCloseTo(2 / 3, 2);
  });
});

describe('lightmap post-processing', () => {
  it('fills a fully buried rect with white (never "inside the wall" black)', () => {
    const v = new Float32Array(6);
    finishRect(v, new Uint8Array(6), 3, 2);
    expect(Array.from(v)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('dilates valid texels into buried ones', () => {
    const v = Float32Array.from([0.5, 0, 0, 0]);
    finishRect(v, Uint8Array.from([1, 0, 0, 0]), 4, 1);
    expect(Array.from(v)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('feathers the ground border to exactly white', () => {
    const v = new Float32Array(25).fill(0);
    featherBorder(v, 5, 5, 2);
    expect(v[0]).toBe(1);
    expect(v[2]).toBe(1); // top row
    expect(v[6]).toBeCloseTo(0.5, 6); // one texel in: halfway
    expect(v[12]).toBe(0); // centre untouched
  });

  it('repeats edge texels into the gutter', () => {
    const img = new Uint8Array(4 * 4).fill(7);
    const rect = { x: 1, y: 1, w: 2, h: 2 } as LightmapRect;
    writeRect(img, 4, rect, Float32Array.from([0, 1, 0.5, 0.25]), 1);
    expect(Array.from(img)).toEqual([
      0, 0, 255, 255, 0, 0, 255, 255, 128, 128, 64, 64, 128, 128, 64, 64,
    ]);
  });
});

describe('ceiling lamp bake', () => {
  it('lights the floor under a panel, is shadowed by solids, and fades out with distance', () => {
    const map = boxOnPlane();
    // A 1.2 × 0.6 m ceiling panel hanging 3 m up, 5 m east of the 2 m cube.
    map.boxes.push({
      center: { x: 5, y: 3, z: 0 },
      size: { x: 1.2, y: 0.08, z: 0.6 },
      mat: 'metal',
      dress: 'lightPanel',
    });
    const lamps = bakeEmitters(map);
    expect(lamps).toHaveLength(1);
    const lit = buildLightmapLayout(map);
    const w = bakeWorldOf(new PhysicsWorld(bakeOccluders(map)));
    const rect = lit.ground.rect;
    const e = bakeLampRect(w, rect, lamps, SETTINGS);
    const at = (x: number, z: number): number =>
      e[Math.floor((z - rect.o.z) / rect.sv) * rect.w + Math.floor((x - rect.o.x) / rect.su)]!;
    const under = at(5, 0);
    expect(under).toBeGreaterThan(0.2);
    expect(at(8, 0)).toBeLessThan(under * 0.5); // falls off to the side
    expect(at(-1.5, 0)).toBe(0); // behind the cube: shadowed
    expect(at(-1.5, 6)).toBeGreaterThan(0); // same distance, clear line
    // The cube's west face looks away from the lamp; its east face faces it.
    const east = bakeLampRect(w, lit.atlas.rects[lit.boxFaces[0]!]!, lamps, SETTINGS);
    const west = bakeLampRect(w, lit.atlas.rects[lit.boxFaces[1]!]!, lamps, SETTINGS);
    expect(Math.max(...east)).toBeGreaterThan(0);
    expect(Math.max(...west)).toBe(0);
  });
});

describe('lamp sample strata', () => {
  it('jitters every sample over its whole 2 × 2 cell, u and v independently', () => {
    const st = { u: 0, v: 0 };
    const N = 64;
    for (let s = 0; s < 4; s++) {
      const bins = new Uint32Array(8 * 8);
      let su = 0;
      let sv = 0;
      let suv = 0;
      let su2 = 0;
      let sv2 = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          lampStratum(x + 300, y + 700, s, st);
          // Position inside the sample's own cell, in [0, 1).
          const ju = st.u * 2 - (s & 1);
          const jv = st.v * 2 - (s >> 1);
          expect(ju).toBeGreaterThanOrEqual(0);
          expect(ju).toBeLessThan(1);
          expect(jv).toBeGreaterThanOrEqual(0);
          expect(jv).toBeLessThan(1);
          bins[Math.floor(jv * 8) * 8 + Math.floor(ju * 8)]!++;
          su += ju;
          sv += jv;
          suv += ju * jv;
          su2 += ju * ju;
          sv2 += jv * jv;
        }
      }
      const n = N * N;
      // Every 1/8 × 1/8 sub-cell is hit (≈ 64 expected each): no collapsed axis.
      expect(Math.min(...bins), `sample ${s}`).toBeGreaterThan(30);
      expect(Math.abs(su / n - 0.5), `sample ${s} u mean`).toBeLessThan(0.03);
      expect(Math.abs(sv / n - 0.5), `sample ${s} v mean`).toBeLessThan(0.03);
      const cov = suv / n - (su / n) * (sv / n);
      const r = cov / Math.sqrt((su2 / n - (su / n) ** 2) * (sv2 / n - (sv / n) ** 2));
      expect(Math.abs(r), `sample ${s} u/v correlation`).toBeLessThan(0.1);
    }
  });
});
