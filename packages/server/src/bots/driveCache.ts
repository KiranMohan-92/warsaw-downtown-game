import {
  buildDriveGraph,
  type DriveGraph,
  type MapDefinition,
  type VehicleWorld,
} from '@wd/shared';

/** How far around the trucks' spawns their drive graph reaches (m). */
const REACH = 70;
const cache = new WeakMap<MapDefinition, Map<string, DriveGraph>>();

/**
 * The drive graph bots plan truck routes on, built once per map (it only depends on the static
 * collision) over the area around the given truck spawns (the whole Market; on the full block a
 * box round the Market, not 0.3 km² of streets nobody drives). Null without spawns.
 */
export function getDriveGraph(
  map: MapDefinition,
  world: VehicleWorld,
  spawns: readonly { x: number; z: number }[],
): DriveGraph | null {
  if (!spawns.length) return null;
  const b = map.bounds;
  const bounds = {
    minX: Math.max(b.minX, Math.min(...spawns.map((s) => s.x)) - REACH),
    maxX: Math.min(b.maxX, Math.max(...spawns.map((s) => s.x)) + REACH),
    minZ: Math.max(b.minZ, Math.min(...spawns.map((s) => s.z)) - REACH),
    maxZ: Math.min(b.maxZ, Math.max(...spawns.map((s) => s.z)) + REACH),
  };
  const key = `${bounds.minX},${bounds.maxX},${bounds.minZ},${bounds.maxZ}`;
  let byKey = cache.get(map);
  if (!byKey) cache.set(map, (byKey = new Map<string, DriveGraph>()));
  let g = byKey.get(key);
  if (!g) byKey.set(key, (g = buildDriveGraph(world, bounds)));
  return g;
}
