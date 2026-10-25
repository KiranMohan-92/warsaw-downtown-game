import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import {
  bakedLampVolume,
  bakeEmitters,
  lampVolumeImageSize,
  lampVolumeLayout,
  lampVolumePlanes,
  lampVolumeRgba,
  LAMP_VOLUME_MAX_DIM,
  LAMP_VOLUME_MAX_VOXELS,
  LAMP_VOLUME_SCALE,
  sampleLampVolume,
  selectLampVolume,
  voxelCentre,
  type BakeEmitter,
  type LampVolumeLayout,
} from './lampVolume.ts';
import { buildLightmapLayout, lightmapSceneHash, type BakedLightmap } from './lightmap.ts';
import {
  bakeLampVolume,
  bakeOccluders,
  bakeWorldOf,
  finishLampVolume,
  type BakeWorld,
  type VolumeSamples,
} from './lightmapBake.ts';
import type { MapDefinition } from './types.ts';

/**
 * The synthetic test room: a slab floor, a 2 m cube at the origin and one 1.2 × 0.6 m ceiling
 * panel hanging 3 m up, 5 m east of it (the same scene as the atlas lamp test).
 */
function litRoom(): MapDefinition {
  return {
    name: 'lit room',
    bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 },
    boxes: [
      { center: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' },
      {
        center: { x: 5, y: 3, z: 0 },
        size: { x: 1.2, y: 0.08, z: 0.6 },
        mat: 'metal',
        dress: 'lightPanel',
      },
    ],
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

let map: MapDefinition;
let emitters: BakeEmitter[];
let layout: LampVolumeLayout;
let world: BakeWorld;
let baked: VolumeSamples;
let rgba: Uint8Array;

/** How many bytes of two same-sized typed arrays differ (0 = bit-identical). */
function bytesDiffer(x: ArrayBufferView, y: ArrayBufferView): number {
  const a = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  const b = new Uint8Array(y.buffer, y.byteOffset, y.byteLength);
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

const UP = { x: 0, y: 1, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };

beforeAll(async () => {
  await initPhysics();
  map = litRoom();
  emitters = bakeEmitters(map);
  layout = lampVolumeLayout(emitters)!;
  world = bakeWorldOf(new PhysicsWorld(bakeOccluders(map)));
  baked = bakeLampVolume(world, layout, emitters);
  finishLampVolume(layout, baked);
  rgba = lampVolumeRgba(lampVolumePlanes(layout, baked.value));
});

describe('lamp volume layout', () => {
  it('covers every fixture’s reach with a dark padding voxel, at the finest cell that fits', () => {
    expect(layout.cell).toBe(0.5);
    const e = emitters[0]!;
    const max = {
      x: layout.min.x + layout.nx * layout.cell,
      y: layout.min.y + layout.ny * layout.cell,
      z: layout.min.z + layout.nz * layout.cell,
    };
    expect(layout.min.x).toBeLessThan(e.at.x - 8);
    expect(max.x).toBeGreaterThan(e.at.x + 8);
    expect(layout.min.y).toBeLessThan(e.at.y - 6);
    expect(max.y).toBeGreaterThan(e.at.y);
    expect(layout.min.z).toBeLessThan(e.at.z - 8);
    expect(max.z).toBeGreaterThan(e.at.z + 8);
    expect(lampVolumeLayout([])).toBeNull();
  });

  it('coarsens the cell for widely spread fixtures and stays inside the GPU budgets', () => {
    const spread: BakeEmitter[] = [];
    for (let i = 0; i < 12; i++) {
      spread.push({ ...emitters[0]!, at: { x: i * 30, y: 3 + (i % 3) * 4, z: (i % 4) * 25 } });
    }
    const l = lampVolumeLayout(spread)!;
    expect(l.cell).toBeGreaterThan(0.5);
    expect(l.nx * l.ny * l.nz).toBeLessThanOrEqual(LAMP_VOLUME_MAX_VOXELS);
    expect(Math.max(l.nx, l.ny, l.nz)).toBeLessThanOrEqual(LAMP_VOLUME_MAX_DIM);
  });

  it('hashes the fixtures: moving a lamp changes the hash', () => {
    const moved = [{ ...emitters[0]!, at: { ...emitters[0]!.at, x: emitters[0]!.at.x + 0.01 } }];
    expect(lampVolumeLayout(moved)!.hash).not.toBe(layout.hash);
    expect(lampVolumeLayout(bakeEmitters(litRoom()))!.hash).toBe(layout.hash);
  });
});

describe('lamp volume bake (synthetic room)', () => {
  const at = (x: number, y: number, z: number, n = UP): number =>
    sampleLampVolume(layout, rgba, { x, y, z }, n);

  it('lights a head-height point under the panel, from above', () => {
    const top = at(5, 1.6, 0, UP);
    expect(top).toBeGreaterThan(0.2);
    // An upward-facing surface there matches the direct irradiance within the L1 approximation.
    expect(at(5, 1.6, 0, DOWN)).toBeLessThan(top * 0.2);
    // Beside the lamp, a face turned towards it is brighter than one turned away.
    expect(at(7, 1.2, 0, { x: -1, y: 0, z: 0 })).toBeGreaterThan(
      at(7, 1.2, 0, { x: 1, y: 0, z: 0 }),
    );
    // Falls off with distance.
    expect(at(10, 1.2, 0)).toBeLessThan(top * 0.3);
  });

  it('is shadowed by solids, and dark above the fixture and outside the grid', () => {
    expect(at(-1.5, 0.5, 0)).toBe(0); // behind the cube, seen from the lamp
    expect(at(-1.5, 0.5, 5)).toBeGreaterThan(0); // same distance, clear line
    expect(at(5, 4.2, 0)).toBe(0); // above the panel: it shines down only
    expect(at(40, 1, 0)).toBe(0);
    expect(at(5, -20, 0)).toBe(0);
  });

  it('keeps floor-level light (buried slab voxels are filled from the air above)', () => {
    // Voxel centres at y = −0.25 are inside the slab; a foot at y = 0.05 filters with them.
    expect(at(5, 0.05, 0)).toBeGreaterThan(at(5, 0.25, 0) * 0.8);
  });

  it('is deterministic, and slices bake bit-identically to the whole volume', () => {
    const again = bakeLampVolume(world, layout, emitters);
    finishLampVolume(layout, again);
    expect(
      bytesDiffer(lampVolumePlanes(layout, again.value), lampVolumePlanes(layout, baked.value)),
    ).toBe(0);
    const whole = bakeLampVolume(world, layout, emitters);
    const k = 7;
    const a = bakeLampVolume(world, layout, emitters, [0, k]);
    const b = bakeLampVolume(world, layout, emitters, [k, layout.nz]);
    const joined = new Float32Array(whole.value.length);
    joined.set(a.value, 0);
    joined.set(b.value, a.value.length);
    expect(bytesDiffer(joined, whole.value)).toBe(0);
    expect(joined.some((v) => v > 0)).toBe(true);
    expect([...a.valid, ...b.valid]).toEqual([...whole.valid]);
  });
});

describe('lamp volume encoding', () => {
  const one: LampVolumeLayout = {
    min: { x: 0, y: 0, z: 0 },
    cell: 1,
    nx: 2,
    ny: 1,
    nz: 1,
    hash: 'x',
  };

  it('stores planes (a, vx, vy, vz) and interleaves them into RGBA voxels', () => {
    const s = LAMP_VOLUME_SCALE;
    const value = Float32Array.from([s, 0, 2 * s, 0, 0, 0, 0, 0]);
    const planes = lampVolumePlanes(one, value);
    expect(lampVolumeImageSize(one)).toEqual([2, 4]);
    expect([...planes]).toEqual([255, 0, 128, 128, 255, 128, 128, 128]);
    expect([...lampVolumeRgba(planes)]).toEqual([255, 128, 255, 128, 0, 128, 128, 128]);
  });

  it('decodes E(n) = clamp(a + v·n, 0, 3a): an empty voxel is exactly dark', () => {
    const s = LAMP_VOLUME_SCALE;
    const rgba = lampVolumeRgba(
      lampVolumePlanes(one, Float32Array.from([s / 2, 0, s, 0, 0, 0, 0, 0])),
    );
    const c = voxelCentre(one, 0, 0, 0);
    expect(sampleLampVolume(one, rgba, c, UP)).toBeCloseTo(1.5 * s, 1);
    expect(sampleLampVolume(one, rgba, c, DOWN)).toBe(0);
    expect(sampleLampVolume(one, rgba, voxelCentre(one, 1, 0, 0), UP)).toBe(0);
  });
});

describe('lamp volume validation', () => {
  const entry = (m: MapDefinition, volume?: BakedLightmap['volume']): BakedLightmap => {
    const l = buildLightmapLayout(m);
    return {
      map: 'tiny',
      size: 'full',
      mapName: m.name,
      layoutHash: l.hash,
      sceneHash: lightmapSceneHash(m, l, 16),
      atlas: { file: 'a.png', width: l.atlas.width, height: l.atlas.height },
      ground: { file: 'g.png', width: l.ground.width, height: l.ground.height },
      ...(volume ? { volume } : {}),
      bake: { samples: 8, reach: 16 },
    };
  };

  it('uses a matching volume, and treats a bake without one (older bakes) as none', () => {
    const sel = selectLampVolume(map, entry(map, bakedLampVolume('v.png', layout)));
    expect(sel.kind).toBe('use');
    if (sel.kind === 'use') {
      expect(sel.file).toBe('v.png');
      expect(sel.layout).toEqual(layout);
    }
    expect(selectLampVolume(map, entry(map)).kind).toBe('none');
  });

  it('survives the manifest’s JSON round trip', () => {
    const json = JSON.parse(
      JSON.stringify(entry(map, bakedLampVolume('v.png', layout))),
    ) as BakedLightmap;
    expect(selectLampVolume(map, json).kind).toBe('use');
  });

  it('skips a volume whose lamps moved, whose grid differs, or whose map lost its lamps', () => {
    const v = bakedLampVolume('v.png', layout);
    const moved = litRoom();
    moved.boxes[1]!.center.x += 1;
    const skipMoved = selectLampVolume(moved, entry(map, v));
    expect(skipMoved.kind).toBe('skip');
    if (skipMoved.kind === 'skip') expect(skipMoved.message).toMatch(/re-run `pnpm bake`/);
    expect(selectLampVolume(map, entry(map, { ...v, nx: v.nx + 1 })).kind).toBe('skip');
    expect(
      selectLampVolume(map, entry(map, { ...v, min: { ...v.min, y: v.min.y + 0.5 } })).kind,
    ).toBe('skip');
    const dark = litRoom();
    dark.boxes.pop();
    expect(selectLampVolume(dark, entry(map, v)).kind).toBe('skip');
  });
});
