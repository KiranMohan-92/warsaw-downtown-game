import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { rectPoly, type MapPrism } from '@wd/shared';
import { skylineStyle, skylineWall } from './skylineFacades.ts';
import type { SkylineGeometry } from './skylineBackdrop.ts';

const geometry = (): SkylineGeometry => ({
  pos: [],
  nrm: [],
  uv: [],
  col: [],
  detail: [],
  idx: [],
});

describe('skyline facade bands', () => {
  it("aligns the structural belts with each building's procedural storeys", () => {
    const prism: MapPrism = {
      pts: rectPoly(0, 0, 24, 12),
      y0: 0,
      y1: 96,
      mat: 'glass',
      backdrop: true,
    };
    const g = geometry();
    const style = { ...skylineStyle(4711, true), storey: 3.7 };
    skylineWall(
      g,
      prism,
      [0, 0],
      [24, 0],
      0,
      [[0, 24]],
      new THREE.Color(style.tint),
      true,
      undefined,
      style,
    );
    const bands: number[] = [];
    for (let i = 0; i < g.pos.length; i += 12) {
      const height = g.pos[i + 7]! - g.pos[i + 1]!;
      if (height > 0.99 && height < 1.01) bands.push(g.pos[i + 1]!);
    }
    expect(bands.length).toBeGreaterThan(4);
    for (const y of bands)
      expect(y / (style.storey * 4)).toBeCloseTo(Math.round(y / (style.storey * 4)), 8);
    expect(g.detail.length).toBe((g.pos.length / 3) * 4);
  });

  it('uses the visible glass rank to force distinct distant-tower tints', () => {
    const [cool, bronze, grey] = [0, 1, 2].map(
      (rank) => new THREE.Color(skylineStyle(1234, true, rank).tint),
    );
    expect(cool!.g).toBeGreaterThan(cool!.r * 2);
    expect(bronze!.r).toBeGreaterThan(bronze!.b * 2);
    expect(grey!.r).toBeGreaterThan(0.7);
    expect(Math.abs(grey!.r - grey!.b)).toBeLessThan(0.1);
    expect(skylineStyle(1234, true)).toEqual(skylineStyle(1234, true));
  });

  it('splits priority glass walls into metre-scale bands and dark corner strips', () => {
    const prism: MapPrism = {
      pts: rectPoly(0, 0, 24, 12),
      y0: 0,
      y1: 96,
      mat: 'glass',
      backdrop: true,
    };
    const g = geometry();
    skylineWall(g, prism, [0, 0], [24, 0], 0, [[0, 24]], new THREE.Color('#83c8c6'), true);
    const quads = g.idx.length / 6;
    expect(quads).toBeGreaterThan(15);
    const widths = [];
    const bands: number[] = [];
    for (let i = 0; i < g.pos.length; i += 12) widths.push(g.pos[i + 3]! - g.pos[i]!);
    for (let i = 0; i < g.pos.length; i += 12) {
      const height = g.pos[i + 7]! - g.pos[i + 1]!;
      if (height >= 0.8 && height <= 1.2 && g.pos[i + 1]! > 4) bands.push(g.pos[i + 1]!);
    }
    const levels = [...new Set(bands)].sort((a, b) => a - b);
    expect(levels.length).toBeGreaterThan(5);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeGreaterThanOrEqual(3 * 3.3);
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(5 * 3.3);
    }
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(0.8);
    expect(Math.min(...widths)).toBeLessThanOrEqual(1.2);
    const colours = new Set<string>();
    for (let i = 0; i < g.col.length; i += 3)
      colours.add(
        `${g.col[i]!.toFixed(3)},${g.col[i + 1]!.toFixed(3)},${g.col[i + 2]!.toFixed(3)}`,
      );
    expect(colours.size).toBeGreaterThanOrEqual(3);
  });

  it('renders light-grey solid panels and glass ribbon windows in the existing two buckets', () => {
    const prism: MapPrism = {
      pts: rectPoly(0, 0, 24, 12),
      y0: 0,
      y1: 96,
      mat: 'glass',
      backdrop: true,
    };
    const glass = geometry(),
      panels = geometry();
    skylineWall(
      glass,
      prism,
      [0, 0],
      [24, 0],
      0,
      [[0, 24]],
      new THREE.Color('#e0e6e8'),
      true,
      panels,
    );
    expect(panels.idx.length).toBeGreaterThan(0);
    expect(glass.idx.length).toBeGreaterThan(0);
    const wallArea = (g: SkylineGeometry): number => {
      let sum = 0;
      for (let i = 0; i < g.pos.length; i += 12)
        sum += (g.pos[i + 3]! - g.pos[i]!) * (g.pos[i + 7]! - g.pos[i + 1]!);
      return sum;
    };
    expect(wallArea(glass) + wallArea(panels)).toBeCloseTo(24 * 96, 5);
  });

  it('keeps metre-scale bands and continuous dark corners on tall glass beyond the priority set', () => {
    const prism: MapPrism = {
      pts: rectPoly(0, 0, 24, 12),
      y0: 0,
      y1: 63,
      mat: 'glass',
      backdrop: true,
    };
    const g = geometry();
    skylineWall(g, prism, [0, 0], [24, 0], 0, [[0, 24]], new THREE.Color('#459fa7'));
    const corners: number[] = [],
      bands: number[] = [];
    for (let i = 0; i < g.pos.length; i += 12) {
      const height = g.pos[i + 7]! - g.pos[i + 1]!;
      const width = g.pos[i + 3]! - g.pos[i]!;
      if (width <= 1.2 && height === 63) corners.push(i);
      if (height >= 0.8 && height <= 1.2) bands.push(g.pos[i + 1]!);
    }
    expect(corners).toHaveLength(2);
    expect(bands.length).toBeGreaterThan(4);
  });
});
