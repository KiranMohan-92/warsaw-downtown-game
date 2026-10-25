import { placDefilad } from './placDefilad/index.ts';
import { TEST_STREET } from './testStreet.ts';
import type { PhysicsWorld } from '../physics/world.ts';
import { generateSpawns } from './spawns.ts';
import type { MapDefinition, SpawnPoint } from './types.ts';

/** Playable maps. `range` = the M1 test street (firing range, sparring). */
export type MapId = 'range' | 'defilad';
/** Map-size option (sections of a big map); `full` = the whole map. */
export type MapSize = 'full' | 'north' | 'south' | 'market';

export const MAP_IDS: readonly MapId[] = ['defilad', 'range'];
export const MAP_SIZES: readonly MapSize[] = ['market', 'full', 'north', 'south'];

export function getMap(id: MapId): MapDefinition {
  return id === 'range' ? TEST_STREET : placDefilad();
}

/** Spawn count for a map/size (≥24 for the full block, ≥12 per section). */
export function spawnCountFor(def: MapDefinition, size: MapSize): number {
  if (def.spawns.length) return def.spawns.length;
  const s = def.sections?.find((x) => x.id === size);
  return s ? s.spawnCount : 28;
}

/**
 * Apply a map-size option: the section's bounds and boundary geometry are added; everything else
 * (buildings, props, trees) is shared, so every size stays in sync as the map evolves.
 */
export function resolveMap(def: MapDefinition, size: MapSize): MapDefinition {
  const s = size === 'full' ? undefined : def.sections?.find((x) => x.id === size);
  if (!s) return def;
  const b = s.bounds;
  const inside = (p: { x: number; z: number }): boolean =>
    p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ;
  return {
    ...def,
    name: `${def.name} — ${s.name}`,
    bounds: s.bounds,
    boxes: [...def.boxes, ...s.boxes],
    // Only what's reachable in this size.
    pickups: def.pickups?.filter((p) => inside(p.pos)),
    dummies: def.dummies.filter((d) => inside(d.pos)),
  };
}

/**
 * The generated spawn set of a resolved map, built the one way every caller must (client, server,
 * tests, tools): same count and the same foliage exclusion, so client and server derive the
 * identical set. `base` is the unresolved map (`getMap`), `map` its `resolveMap(base, size)`.
 */
export function spawnsFor(
  physics: PhysicsWorld,
  base: MapDefinition,
  map: MapDefinition,
  size: MapSize,
): SpawnPoint[] {
  return generateSpawns(physics, map.bounds, {
    count: spawnCountFor(base, size),
    foliage: map.foliage,
    // The trucks' spots and the jetpacks' (whether or not the host has them on: the set must
    // not depend on a match setting).
    ...(map.vehicles?.length || map.jetpacks?.length
      ? { avoid: [...(map.vehicles ?? []), ...(map.jetpacks ?? [])] }
      : {}),
  });
}
