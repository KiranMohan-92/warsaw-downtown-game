import { describe, expect, it } from 'vitest';
import { quatFromEulerDeg, rotateByQuat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import {
  BOX_FACES,
  buildLightmapLayout,
  checkBakedLightmap,
  isSlabPrism,
  lightmapSceneHash,
  MIN_WALL_EDGE,
  prismHasBottom,
  rectTexel,
  selectBakedLightmap,
  type BakedLightmap,
  type LightmapLayout,
  type LightmapRect,
} from './lightmap.ts';
import { BAKED_LIGHTMAPS } from './lightmapManifest.ts';
import { selectLampVolume } from './lampVolume.ts';
import { getMap, resolveMap, type MapId, type MapSize } from './registry.ts';
import type { MapDefinition } from './types.ts';

/** A box on a street slab, a kerb prism, a backdrop tower and a flat: every face kind once. */
function tinyMap(): MapDefinition {
  return {
    name: 'tiny',
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    boxes: [
      { center: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' },
      {
        center: { x: 4, y: 0.5, z: 3 },
        size: { x: 1, y: 1, z: 3 },
        rot: { x: 0, y: 30, z: 0 },
        mat: 'wood',
      },
      // Invisible collision-only bounds: never baked.
      {
        center: { x: 0, y: 5, z: -11 },
        size: { x: 30, y: 10, z: 1 },
        mat: 'concrete',
        visible: false,
      },
      // Far outside the baked region: white.
      { center: { x: 200, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' },
    ],
    prisms: [
      {
        pts: [
          [-20, -20],
          [20, -20],
          [20, 20],
          [-20, 20],
        ],
        y0: -0.5,
        y1: 0,
        mat: 'concrete',
        top: 'paving',
      },
      {
        pts: [
          [-6, -6],
          [-3, -6],
          [-3, -5],
          [-6, -5],
        ],
        y0: 0,
        y1: 0.15,
        mat: 'concrete',
      },
      {
        pts: [
          [-5, 5],
          [-2, 5],
          [-3, 8],
        ],
        y0: 3,
        y1: 3.2,
        mat: 'metal',
      },
      {
        pts: [
          [300, 300],
          [320, 300],
          [320, 320],
          [300, 320],
        ],
        y0: 0,
        y1: 80,
        mat: 'facade',
        backdrop: true,
      },
    ],
    flats: [
      {
        pts: [
          [-8, -8],
          [8, -8],
          [8, -7],
          [-8, -7],
        ],
        y: 0,
        mat: 'asphalt',
      },
    ],
    trees: [],
    spawns: [],
    dummies: [],
  };
}

/** Box face corners exactly as the renderer emits them (`client/render/mapMesh.ts`). */
function rendererBoxCorners(b: MapDefinition['boxes'][number], f: number): Vec3[] {
  const face = BOX_FACES[f]!;
  const q = quatFromEulerDeg(b.rot);
  const half = (a: Vec3): number =>
    Math.abs(a.x) * b.size.x * 0.5 +
    Math.abs(a.y) * b.size.y * 0.5 +
    Math.abs(a.z) * b.size.z * 0.5;
  const hn = half(face.n);
  const hu = half(face.u);
  const hv = half(face.v);
  return (
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const
  ).map(([su, sv]) => {
    const w = rotateByQuat(
      {
        x: face.n.x * hn + face.u.x * hu * su + face.v.x * hv * sv,
        y: face.n.y * hn + face.u.y * hu * su + face.v.y * hv * sv,
        z: face.n.z * hn + face.u.z * hu * su + face.v.z * hv * sv,
      },
      q,
    );
    return { x: b.center.x + w.x, y: b.center.y + w.y, z: b.center.z + w.z };
  });
}

/** The face's world corners land exactly on its rect's interior corners (in some order). */
function expectCornersOnRect(rect: LightmapRect, corners: Vec3[]): void {
  const want = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ];
  for (const c of corners) {
    const [tx, ty] = rectTexel(rect, c);
    const hit = want.some(([x, y]) => Math.abs(tx - x!) < 1e-6 && Math.abs(ty - y!) < 1e-6);
    expect(hit, `corner → (${tx}, ${ty}) not a corner of ${JSON.stringify(rect)}`).toBe(true);
  }
}

/** Every rect (with gutters) inside the atlas and disjoint from every other and the white block. */
function expectPacked(layout: LightmapLayout): void {
  const { width: W, height: H, rects, white } = layout.atlas;
  const g = layout.params.gutter;
  const used = new Uint8Array(W * H);
  const claim = (x0: number, y0: number, x1: number, y1: number, what: string): void => {
    expect(x0 >= 0 && y0 >= 0 && x1 <= W && y1 <= H, `${what} outside the atlas`).toBe(true);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (used[y * W + x]) throw new Error(`${what} overlaps at ${x},${y}`);
        used[y * W + x] = 1;
      }
    }
  };
  claim(white.x - 1 - g, white.y - 1 - g, white.x + 1 + g, white.y + 1 + g, 'white block');
  rects.forEach((r, i) => claim(r.x - g, r.y - g, r.x + r.w + g, r.y + r.h + g, `rect ${i}`));
}

/** Every rendered face inside the region has its own rect; everything else is white/ground. */
function expectCovered(map: MapDefinition, layout: LightmapLayout): void {
  const seen = new Set<number>();
  const own = (idx: number): void => {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(seen.has(idx), `rect ${idx} assigned twice`).toBe(false);
    seen.add(idx);
  };
  const r = layout.region;
  const inRegion = (xs: number[], zs: number[]): boolean =>
    Math.max(...xs) >= r.minX &&
    Math.min(...xs) <= r.maxX &&
    Math.max(...zs) >= r.minZ &&
    Math.min(...zs) <= r.maxZ;
  map.boxes.forEach((b, bi) => {
    for (let f = 0; f < 6; f++) {
      const idx = layout.boxFaces[bi * 6 + f]!;
      const corners = rendererBoxCorners(b, f);
      const inside = inRegion(
        corners.map((c) => c.x),
        corners.map((c) => c.z),
      );
      if (b.visible === false || !inside) {
        expect(idx).toBe(-1);
        continue;
      }
      own(idx);
      expectCornersOnRect(layout.atlas.rects[idx]!, corners);
    }
  });
  (map.prisms ?? []).forEach((p, pi) => {
    const faces = layout.prismFaces[pi];
    if (p.backdrop || p.visible === false) {
      expect(faces).toBeNull();
      return;
    }
    expect(faces).not.toBeNull();
    const n = p.pts.length;
    const inside = inRegion(
      p.pts.map((q) => q[0]),
      p.pts.map((q) => q[1]),
    );
    if (isSlabPrism(p)) expect(faces![n]).toBe(-2);
    if (!inside) return;
    for (let i = 0; i < n; i++) {
      const a = p.pts[i]!;
      const b = p.pts[(i + 1) % n]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_WALL_EDGE) continue;
      if (!inRegion([a[0], b[0]], [a[1], b[1]])) continue;
      own(faces![i]!);
      expectCornersOnRect(layout.atlas.rects[faces![i]!]!, [
        { x: a[0], y: p.y0, z: a[1] },
        { x: b[0], y: p.y0, z: b[1] },
        { x: b[0], y: p.y1, z: b[1] },
        { x: a[0], y: p.y1, z: a[1] },
      ]);
    }
    const caps: [number, number][] = [];
    if (!isSlabPrism(p)) caps.push([n, p.y1]);
    if (prismHasBottom(p)) caps.push([n + 1, p.y0]);
    for (const [slot, y] of caps) {
      own(faces![slot]!);
      const rect = layout.atlas.rects[faces![slot]!]!;
      for (const [x, z] of p.pts) {
        const [tx, ty] = rectTexel(rect, { x, y, z });
        expect(tx).toBeGreaterThanOrEqual(rect.x - 1e-6);
        expect(tx).toBeLessThanOrEqual(rect.x + rect.w + 1e-6);
        expect(ty).toBeGreaterThanOrEqual(rect.y - 1e-6);
        expect(ty).toBeLessThanOrEqual(rect.y + rect.h + 1e-6);
      }
    }
  });
  // Every rect belongs to exactly one face.
  expect(seen.size).toBe(layout.atlas.rects.length);
}

describe('lightmap layout', () => {
  it('covers every rendered face once, packs without overlaps, and maps corners exactly', () => {
    const map = tinyMap();
    const layout = buildLightmapLayout(map);
    expectPacked(layout);
    expectCovered(map, layout);
    // The ground projection covers the play area (+ margin) on the texel grid.
    const gb = layout.ground.bounds;
    expect(gb.minX).toBeLessThanOrEqual(map.bounds.minX - layout.params.groundMargin);
    expect(gb.maxZ).toBeGreaterThanOrEqual(map.bounds.maxZ + layout.params.groundMargin);
    expect(layout.ground.rect.w * layout.ground.rect.su).toBeCloseTo(gb.maxX - gb.minX, 9);
  });

  it('is deterministic and sensitive to geometry that moves a face', () => {
    const a = buildLightmapLayout(tinyMap());
    const b = buildLightmapLayout(tinyMap());
    expect(b.hash).toBe(a.hash);
    expect(b.atlas.rects).toEqual(a.atlas.rects);
    const moved = tinyMap();
    moved.boxes[0]!.size = { x: 2, y: 3, z: 2 };
    expect(buildLightmapLayout(moved).hash).not.toBe(a.hash);
  });

  it('lays out the Market map: every face, no overlaps, deterministic, within texture limits', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const layout = buildLightmapLayout(map);
    expect(buildLightmapLayout(map).hash).toBe(layout.hash);
    expectPacked(layout);
    expectCovered(map, layout);
    expect(layout.atlas.width).toBeLessThanOrEqual(4096);
    expect(layout.atlas.height).toBeLessThanOrEqual(layout.params.maxAtlasHeight);
    // Density: no face coarser than 0.5 m per texel.
    for (const r of layout.atlas.rects) expect(Math.max(r.su, r.sv)).toBeLessThanOrEqual(0.5);
  }, 30_000); // builds the whole Market world twice: ~5 s, more under CPU load
});

describe('bundled bakes', () => {
  // Hard check: a layout mismatch means the game silently drops the bake. A scene-hash-only
  // mismatch (occluders moved, faces didn't) is only stale, and the game keeps it with a warning,
  // so this test only annotates (a warning in the test report) instead of failing: lanes that
  // change Market props don't re-bake (only the lead does, on main, after merging; see
  // tools/bake/README.md).
  it.for(BAKED_LIGHTMAPS.map((b) => [`${b.map}/${b.size}`, b] as const))(
    '%s layout still matches its map (else the lead re-runs `pnpm bake` on main)',
    async ([, baked], { annotate }) => {
      const map = resolveMap(getMap(baked.map as MapId), baked.size as MapSize);
      expect(map.name).toBe(baked.mapName);
      const sel = selectBakedLightmap(map, [baked]);
      expect(sel.kind === 'skip' ? sel.message : sel.kind).toBe('use');
      if (sel.kind === 'use' && sel.warning) await annotate(sel.warning, 'warning');
      // The lamp volume is optional (older bakes lack it), but a shipped one must still fit.
      const vol = selectLampVolume(map, baked);
      expect(vol.kind === 'skip' ? vol.message : 'ok').toBe('ok');
    },
  );
});

describe('baked lightmap validation', () => {
  const entryFor = (map: MapDefinition, layout: LightmapLayout): BakedLightmap => ({
    map: 'tiny',
    size: 'full',
    mapName: map.name,
    layoutHash: layout.hash,
    sceneHash: lightmapSceneHash(map, layout, 16),
    atlas: { file: 'a.png', width: layout.atlas.width, height: layout.atlas.height },
    ground: { file: 'g.png', width: layout.ground.width, height: layout.ground.height },
    bake: { samples: 8, reach: 16 },
  });

  it('uses a matching bake, and ignores maps without one', () => {
    const map = tinyMap();
    const layout = buildLightmapLayout(map);
    const sel = selectBakedLightmap(map, [entryFor(map, layout)]);
    expect(sel.kind).toBe('use');
    if (sel.kind === 'use') {
      expect(sel.layout.hash).toBe(layout.hash);
      expect(sel.warning).toBeUndefined();
    }
    expect(selectBakedLightmap({ ...map, name: 'other' }, [entryFor(map, layout)]).kind).toBe(
      'none',
    );
  });

  it('skips a bake whose layout hash no longer matches the map (map changed, not re-baked)', () => {
    const map = tinyMap();
    const entry = entryFor(map, buildLightmapLayout(map));
    const changed = tinyMap();
    changed.boxes.push({ center: { x: -4, y: 1, z: 4 }, size: { x: 1, y: 2, z: 1 }, mat: 'wood' });
    const sel = selectBakedLightmap(changed, [entry]);
    expect(sel.kind).toBe('skip');
    if (sel.kind === 'skip') expect(sel.message).toMatch(/pnpm bake/);
    const check = checkBakedLightmap(
      { ...entry, layoutHash: 'deadbeef' },
      buildLightmapLayout(map),
      entry.sceneHash,
    );
    expect(check.ok).toBe(false);
  });

  it('skips a bake whose texture sizes differ from the layout', () => {
    const map = tinyMap();
    const layout = buildLightmapLayout(map);
    const entry = entryFor(map, layout);
    const bad = { ...entry, atlas: { ...entry.atlas, height: entry.atlas.height + 4 } };
    expect(checkBakedLightmap(bad, layout, entry.sceneHash).ok).toBe(false);
  });

  it('keeps an aligned but stale bake (occluders changed, layout did not) with a warning', () => {
    const map = tinyMap();
    const entry = entryFor(map, buildLightmapLayout(map));
    const withTree = tinyMap();
    withTree.trees = [{ x: 5, z: -5, height: 8, crown: 2, kind: 'broadleaf' }];
    const sel = selectBakedLightmap(withTree, [entry]);
    expect(sel.kind).toBe('use');
    if (sel.kind === 'use') expect(sel.warning).toMatch(/predates geometry changes/);
  });
});
