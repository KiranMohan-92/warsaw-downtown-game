import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER } from '../../config/tunables.ts';
import { initPhysics, PhysicsWorld } from '../../physics/world.ts';
import { isConvex } from '../geom.ts';
import { resolveMap, spawnsFor, type MapSize } from '../registry.ts';
import { FOLIAGE_SPAWN_CLEARANCE } from '../spawns.ts';
import type { MapDefinition, SpawnPoint } from '../types.ts';
import { COVER_GAP, DEFILAD_CUT_Z, MARKET_COVER_GAP, placDefilad } from './index.ts';

let base: MapDefinition;
const worlds = new Map<
  MapSize,
  { map: MapDefinition; physics: PhysicsWorld; spawns: SpawnPoint[] }
>();

beforeAll(async () => {
  await initPhysics();
  base = placDefilad();
  for (const size of ['full', 'north', 'south', 'market'] as const) {
    const map = resolveMap(base, size);
    const physics = new PhysicsWorld(map);
    const spawns = spawnsFor(physics, base, map, size);
    worlds.set(size, { map, physics, spawns });
  }
}, 120_000);

describe('Plac Defilad map', () => {
  it('is the real block at 1:1: ~480 × 690 m, OSM-attributed, Palace + tower present', () => {
    const b = base.bounds;
    expect(b.maxX - b.minX).toBeGreaterThan(450);
    expect(b.maxZ - b.minZ).toBeGreaterThan(650);
    expect(base.attribution).toMatch(/OpenStreetMap/);
    const playable = (base.prisms ?? []).filter((p) => !p.backdrop);
    const tallest = Math.max(...playable.map((p) => p.y1));
    expect(tallest).toBeCloseTo(237, 0); // the Palace spire
    // Skyline backdrop includes the real towers around the block (not walkable, not colliding).
    expect((base.prisms ?? []).some((p) => p.backdrop && p.y1 > 150)).toBe(true);
  });

  it('has soft concealment everywhere people fight: bushes and tall grass, plus trees', () => {
    const f = base.foliage ?? [];
    expect(f.filter((x) => x.kind === 'bush').length).toBeGreaterThan(800);
    expect(f.filter((x) => x.kind === 'grass').length).toBeGreaterThan(400);
    expect((base.trees ?? []).length).toBeGreaterThan(900);
    // Bushes hide a standing player; tall grass only a crouched one.
    expect(Math.min(...f.filter((x) => x.kind === 'bush').map((x) => x.h))).toBeGreaterThanOrEqual(
      1.3,
    );
    expect(Math.max(...f.filter((x) => x.kind === 'grass').map((x) => x.h))).toBeLessThanOrEqual(
      1.3,
    );
  });

  it('no non-colliding (backdrop) building reaches into the playable area', () => {
    const b = base.bounds;
    const inside = (base.prisms ?? []).filter(
      (p) =>
        p.backdrop &&
        p.pts.some(
          ([x, z]) => x > b.minX + 0.5 && x < b.maxX - 0.5 && z > b.minZ + 0.5 && z < b.maxZ - 0.5,
        ),
    );
    expect(inside.length).toBe(0);
  });

  it('Market size: compact close-quarters map with spawns and radar uplinks', () => {
    const w = worlds.get('market')!;
    const b = w.map.bounds;
    expect((b.maxX - b.minX) * (b.maxZ - b.minZ)).toBeLessThan(140 * 140);
    expect(w.spawns.length).toBeGreaterThanOrEqual(8);
    expect(w.map.pickups?.length).toBeGreaterThanOrEqual(2);
    for (const s of w.spawns) {
      expect(s.pos.x).toBeGreaterThan(b.minX);
      expect(s.pos.x).toBeLessThan(b.maxX);
    }
  });

  it('cover everywhere: after the fill no street spot is more than COVER_GAP m from cover', () => {
    expect(base.stats!.coverPlaced).toBeGreaterThan(50);
    expect(base.stats!.coverGap).toBeLessThanOrEqual(COVER_GAP);
    // The compact Market: dense, cover within 4 m.
    expect(base.stats!.marketPlaced).toBeGreaterThan(20);
    expect(base.stats!.marketGap).toBeLessThanOrEqual(MARKET_COVER_GAP);
  });

  it('radar uplinks are spread over the map and every size keeps the ones inside it', () => {
    expect(base.pickups?.length).toBeGreaterThanOrEqual(6);
    for (const [, w] of worlds) {
      for (const p of w.map.pickups ?? []) {
        expect(p.pos.x).toBeGreaterThan(w.map.bounds.minX);
        expect(p.pos.z).toBeLessThan(w.map.bounds.maxZ);
      }
    }
  });

  it('every prism is convex (solid colliders) and non-degenerate', () => {
    const bad = (base.prisms ?? []).filter((p) => !isConvex(p.pts) || p.y1 <= p.y0);
    expect(bad.length).toBe(0);
    for (const [, w] of worlds) expect(w.physics.skippedHulls).toBe(0);
  });

  it('generates ≥24 spawns for the full block and ≥12 per half, inside the right half', () => {
    const full = worlds.get('full')!;
    expect(full.spawns.length).toBeGreaterThanOrEqual(24);
    for (const size of ['north', 'south'] as const) {
      const w = worlds.get(size)!;
      expect(w.spawns.length).toBeGreaterThanOrEqual(12);
      for (const s of w.spawns) {
        if (size === 'north') expect(s.pos.z).toBeLessThan(DEFILAD_CUT_Z);
        else expect(s.pos.z).toBeGreaterThan(DEFILAD_CUT_Z);
      }
    }
  });

  it('spawns are spread out, standable, and clear of geometry', () => {
    for (const [size, w] of worlds) {
      let minPair = Infinity;
      for (let i = 0; i < w.spawns.length; i++) {
        const a = w.spawns[i]!.pos;
        expect(w.physics.overlapsStatic(a, PLAYER.standHeight)).toBe(false);
        const down = w.physics.castRay({ x: a.x, y: a.y + 0.5, z: a.z }, { x: 0, y: -1, z: 0 }, 1);
        expect(down, `${size} spawn ${i} has ground`).not.toBeNull();
        for (let j = i + 1; j < w.spawns.length; j++) {
          const b = w.spawns[j]!.pos;
          minPair = Math.min(minPair, Math.hypot(a.x - b.x, a.z - b.z));
        }
      }
      expect(minPair, `${size}: closest spawn pair`).toBeGreaterThan(30);
    }
  });

  it('spawn generation is deterministic (client and server agree)', () => {
    const w = worlds.get('full')!;
    // The same builder Game.ts and MatchSim.ts call (one options source: they can't drift).
    const again = spawnsFor(w.physics, base, w.map, 'full');
    expect(again).toEqual(w.spawns);
  });

  it('never spawns anyone inside or nose-deep in a bush or tall grass', () => {
    for (const [size, w] of worlds) {
      for (const s of w.spawns) {
        for (const f of w.map.foliage ?? []) {
          const d = Math.hypot(f.x - s.pos.x, f.z - s.pos.z);
          expect(d, `${size}: spawn ${s.pos.x.toFixed(1)},${s.pos.z.toFixed(1)}`).toBeGreaterThan(
            f.r + FOLIAGE_SPAWN_CLEARANCE - 1e-9,
          );
        }
      }
    }
  });
});
