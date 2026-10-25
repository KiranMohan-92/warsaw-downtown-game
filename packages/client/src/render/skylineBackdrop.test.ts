import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clipConvex, area, getMap, rectPoly, resolveMap, type MapDefinition } from '@wd/shared';
import {
  buildSkylineBackdrop,
  SKYLINE_CROWN_MIN_ANGLE_DEG,
  SKYLINE_MARKET_CENTER,
  SKYLINE_PRIORITY_COUNT,
  SKYLINE_TRIANGLE_CAP,
  rankSkylineBuildings,
} from './skylineBackdrop.ts';
import { buildLightmapLayout } from '@wd/shared';

const market = (): MapDefinition => resolveMap(getMap('defilad'), 'market');

describe('merged skyline silhouettes', () => {
  it('ranks apparent size in the Market shots deterministically, rather than roof seed', () => {
    const map = market();
    const ranking = rankSkylineBuildings(map);
    expect(ranking).toEqual(rankSkylineBuildings(map));
    const reversed = rankSkylineBuildings({ ...map, prisms: [...map.prisms!].reverse() });
    expect(reversed.map((b) => b.seed)).toEqual(ranking.map((b) => b.seed));
    for (const [i, b] of ranking.entries())
      expect(reversed[i]!.solidAngle).toBeCloseTo(b.solidAngle, 10);
    expect(ranking.every((b, i) => i === 0 || b.solidAngle <= ranking[i - 1]!.solidAngle)).toBe(
      true,
    );
    const selected = new Set(ranking.slice(0, SKYLINE_PRIORITY_COUNT).flatMap((b) => b.sources));
    for (const source of [4, 580, 762, 789]) expect(selected.has(source)).toBe(true);
    const fixture: MapDefinition = {
      name: 'apparent size',
      bounds: map.bounds,
      boxes: [],
      spawns: [],
      dummies: [],
      prisms: [
        { pts: rectPoly(320, -30, 380, 30), y0: 0, y1: 100, mat: 'glass', backdrop: true },
        { pts: rectPoly(520, -5, 530, 5), y0: 0, y1: 100, mat: 'glass', backdrop: true },
        { pts: rectPoly(-400, -20, -360, 20), y0: 0, y1: 150, mat: 'glass', backdrop: true },
      ],
    };
    const sizes = rankSkylineBuildings(fixture);
    expect(sizes[0]!.sources).toEqual([0]);
    expect(sizes[0]!.solidAngle).toBeGreaterThan(sizes[1]!.solidAngle * 3);
    expect(sizes.find((b) => b.sources.includes(2))!.solidAngle).toBe(0);
  });

  it('gives every top-12 building a varied crown reading at least 0.4 degrees from the Market', () => {
    const map = market();
    const skyline = buildSkylineBackdrop(map);
    const ranking = rankSkylineBuildings(map).slice(0, SKYLINE_PRIORITY_COUNT);
    const kinds = new Set<string>();
    for (const b of ranking) {
      const crowns = skyline.parts.filter(
        (p) => b.sources.includes(p.source) && ['step', 'slope', 'plant', 'fin'].includes(p.kind),
      );
      expect(crowns.length).toBeGreaterThan(0);
      const roof = Math.max(...b.sources.map((source) => map.prisms![source]!.y1));
      const top = Math.max(...crowns.map((p) => (p.topHeights ? Math.max(...p.topHeights) : p.y1)));
      const distance = Math.hypot(
        b.center[0] - SKYLINE_MARKET_CENTER[0],
        b.center[1] - SKYLINE_MARKET_CENTER[1],
      );
      const angle =
        ((Math.atan2(top - 1.7, distance) - Math.atan2(roof - 1.7, distance)) * 180) / Math.PI;
      expect(top - roof).toBeGreaterThanOrEqual(6);
      expect(angle).toBeGreaterThanOrEqual(SKYLINE_CROWN_MIN_ANGLE_DEG);
      kinds.add(
        skyline.buildings.find((building) => building.sources.includes(b.sources[0]!))!.crown,
      );
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it('sizes tall-building equipment and coping for distant views without changing the bake layout', () => {
    const map = market();
    const hash = buildLightmapLayout(map).hash;
    const skyline = buildSkylineBackdrop(map);
    for (const part of skyline.parts) {
      const roof = map.prisms![part.source]!;
      if (roof.y1 - roof.y0 <= 60) continue;
      if (part.kind === 'plant') expect(part.y1 - part.y0).toBeGreaterThanOrEqual(5);
      if (part.kind === 'mast') {
        expect(part.y1 - part.y0).toBeGreaterThanOrEqual(10);
        expect(part.y1 - part.y0).toBeLessThanOrEqual(25);
      }
      if (part.kind === 'parapet') {
        expect(part.y1 - part.y0).toBeGreaterThanOrEqual(1.2);
        expect(part.y1 - part.y0).toBeLessThanOrEqual(1.8);
      }
    }
    expect(skyline.parts.some((p) => p.kind === 'coping')).toBe(true);
    const width = (pts: readonly (readonly [number, number])[]): number =>
      Math.max(
        Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
        Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
      );
    for (const building of skyline.buildings.filter((b) => b.height > 60)) {
      const plants = skyline.parts.filter(
        (p) => p.kind === 'plant' && building.sources.includes(p.source),
      );
      if (plants.length === 0) continue;
      const roof = building.sources.flatMap((source) => map.prisms![source]!.pts);
      expect(width(plants.flatMap((p) => p.pts))).toBeGreaterThanOrEqual(width(roof) * 0.3);
    }
    expect(buildLightmapLayout(map).hash).toBe(hash);
  });

  it('dresses prominent flat crowns with sparse, varied roof equipment', () => {
    const map = market();
    const skyline = buildSkylineBackdrop(map);
    const prioritySources = new Set(
      rankSkylineBuildings(map)
        .slice(0, SKYLINE_PRIORITY_COUNT)
        .flatMap((b) => b.sources),
    );
    const equipment = skyline.parts.filter((part) =>
      ['hvac', 'mast', 'tank', 'crane'].includes(part.kind),
    );
    const prominent = equipment.filter((part) => prioritySources.has(part.source));
    expect(prominent.length).toBeGreaterThanOrEqual(4);
    expect(new Set(prominent.map((part) => part.kind)).size).toBeGreaterThanOrEqual(3);
    for (const kind of ['tank', 'crane']) {
      const pieces = equipment.filter((part) => part.kind === kind);
      expect(pieces.length).toBeGreaterThan(0);
      expect(pieces.every((part) => part.y1 - part.y0 >= 2)).toBe(true);
    }
    for (const part of prominent) {
      expect(part.parent).not.toBeNull();
      expect(skyline.parts[part.parent!]!.topHeights).toBeUndefined();
    }
    expect(
      equipment.filter((part) => part.kind === 'tank').every((part) => part.pts.length === 6),
    ).toBe(true);
    // Sub-pixel clutter should stay a small supplement to the existing silhouettes.
    expect(equipment.length).toBeLessThan(skyline.buildings.length * 2);
  });

  it('gives the actual southeast trio three strong finishes rather than nearby seed colours', () => {
    const skyline = buildSkylineBackdrop(market());
    const colours = [580, 762, 4].map(
      (source) => new THREE.Color(skyline.buildings.find((b) => b.sources.includes(source))!.tint),
    );
    expect(colours[0]!.r).toBeGreaterThan(colours[0]!.b * 2);
    expect(colours[1]!.r).toBeGreaterThan(0.7);
    expect(colours[2]!.g).toBeGreaterThan(colours[2]!.r * 2);
  });
  it('generates the same mesh from the same map without changing OSM geometry', () => {
    const map = market();
    const before = JSON.stringify(map);
    expect(buildSkylineBackdrop(map)).toEqual(buildSkylineBackdrop(map));
    expect(JSON.stringify(map)).toBe(before);
  });

  it('roots every rooftop part on its roof or on its parent part, inside the OSM footprint', () => {
    const map = market();
    const skyline = buildSkylineBackdrop(map);
    expect(skyline.parts.length).toBeGreaterThan(100);
    for (const [i, part] of skyline.parts.entries()) {
      const roof = map.prisms![part.source]!;
      const support = part.parent === null ? roof : skyline.parts[part.parent]!;
      expect(part.y0, `part ${i}`).toBe(support.y1);
      expect(part.y1).toBeGreaterThan(part.y0);
      expect(area(clipConvex(part.pts, support.pts))).toBeCloseTo(area(part.pts), 4);
      expect(area(clipConvex(part.pts, roof.pts))).toBeCloseTo(area(part.pts), 4);
    }
  });

  it('keeps the whole backdrop below its fixed pre-culling triangle cap', () => {
    for (const size of ['full', 'north', 'south', 'market'] as const) {
      const skyline = buildSkylineBackdrop(resolveMap(getMap('defilad'), size));
      const triangles = skyline.buckets.reduce((sum, b) => sum + b.geometry.idx.length / 3, 0);
      expect(triangles).toBe(skyline.triangles);
      expect(triangles).toBeLessThanOrEqual(SKYLINE_TRIANGLE_CAP);
      expect(SKYLINE_TRIANGLE_CAP).toBe(60_000);
    }
  });

  it('adds at most one shaded batch and one depth batch to the existing backdrop draws', () => {
    const map = market();
    const skyline = buildSkylineBackdrop(map);
    const original = new Set(
      skyline.sources.flatMap((i) => {
        const p = map.prisms![i]!;
        return [p.mat, p.top ?? p.mat];
      }),
    );
    expect(skyline.buckets.every((b) => original.has(b.mat))).toBe(true);
    expect((skyline.buckets.length - original.size) * 2).toBeLessThanOrEqual(2);
    expect(skyline.buckets.filter((b) => b.key !== 'backdrop')).toHaveLength(1);
  });

  it('varies building tint, glass reflectivity and crown style, with one identity per footprint', () => {
    const map = market();
    const skyline = buildSkylineBackdrop(map);
    expect(new Set(skyline.buildings.map((b) => b.tint)).size).toBeGreaterThan(4);
    const towers = skyline.buildings.filter((b) => b.glass);
    expect(new Set(towers.map((b) => b.finish)).size).toBe(2);
    expect(new Set(towers.map((b) => b.crown)).size).toBeGreaterThan(2);
    for (const building of towers) {
      const bucket = skyline.buckets.find((b) => b.mat === 'glass' && b.key === building.finish)!;
      expect(bucket.geometry.col.length).toBeGreaterThan(0);
    }
    const key = (r: number, g: number, b: number): string =>
      `${r.toFixed(6)},${g.toFixed(6)},${b.toFixed(6)}`;
    const colours = new Map(
      skyline.buckets.map((bucket) => {
        const set = new Set<string>();
        for (let i = 0; i < bucket.geometry.col.length; i += 3) {
          set.add(
            key(bucket.geometry.col[i]!, bucket.geometry.col[i + 1]!, bucket.geometry.col[i + 2]!),
          );
        }
        return [`${bucket.mat}|${bucket.key}`, set];
      }),
    );
    for (const building of skyline.buildings) {
      const mat = map.prisms![building.sources[0]!]!.mat;
      if (mat !== 'glass' && mat !== 'facade') continue;
      const c = new THREE.Color().setHex(building.tint, THREE.SRGBColorSpace);
      expect(colours.get(`${mat}|${building.finish}`)!.has(key(c.r, c.g, c.b))).toBe(true);
    }
  });

  it('keeps silhouette geometry identical across map sizes', () => {
    const base = getMap('defilad');
    const full = buildSkylineBackdrop(base);
    for (const size of ['north', 'south', 'market'] as const) {
      const skyline = buildSkylineBackdrop(resolveMap(base, size));
      expect(skyline.parts).toEqual(full.parts);
      expect(skyline.buckets).toEqual(full.buckets);
    }
  });

  it('adds nothing inside any playable map bounds, including a crossing-footprint fixture', () => {
    const map = market();
    const bounds = rectPoly(map.bounds.minX, map.bounds.minZ, map.bounds.maxX, map.bounds.maxZ);
    for (const part of buildSkylineBackdrop(map).parts) {
      expect(area(clipConvex(part.pts, bounds))).toBe(0);
    }
    const unsafe: MapDefinition = {
      name: 'crossing backdrop',
      bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
      boxes: [],
      spawns: [],
      dummies: [],
      prisms: [{ pts: rectPoly(-2, -2, 2, 2), y0: 0, y1: 90, mat: 'glass', backdrop: true }],
    };
    expect(buildSkylineBackdrop(unsafe).parts).toEqual([]);
    expect(buildSkylineBackdrop(unsafe).buckets).toEqual([]);
  });

  it('does not crown convex-decomposition seams or put equipment on every fragment', () => {
    const map: MapDefinition = {
      name: 'split roof',
      bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
      boxes: [],
      spawns: [],
      dummies: [],
      prisms: [
        { pts: rectPoly(20, 0, 30, 20), y0: 0, y1: 30, mat: 'facade', backdrop: true },
        { pts: rectPoly(30, 0, 40, 10), y0: 0, y1: 30, mat: 'facade', backdrop: true },
        { pts: rectPoly(30, 10, 40, 20), y0: 0, y1: 30, mat: 'facade', backdrop: true },
      ],
    };
    const skyline = buildSkylineBackdrop(map);
    expect(skyline.buildings).toHaveLength(1);
    const parapets = skyline.parts.filter((p) => p.kind === 'parapet');
    expect(
      parapets.every((p) => p.pts.some(([x, z]) => x === 20 || x === 40 || z === 0 || z === 20)),
    ).toBe(true);
    expect(skyline.parts.filter((p) => p.kind === 'plant')).toHaveLength(1);
  });
});
