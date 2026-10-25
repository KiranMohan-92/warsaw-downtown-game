/**
 * Dump the assembled map's authored layer + generated spawns for tools/osm/plot.py:
 *   node tools/osm/dump-layout.ts && python tools/osm/plot.py tools/osm/preview/layout.json
 */
import { writeFileSync } from 'node:fs';
import { initPhysics, PhysicsWorld } from '../../packages/shared/src/physics/world.ts';
import { placDefilad } from '../../packages/shared/src/maps/placDefilad/index.ts';
import { resolveMap, spawnsFor } from '../../packages/shared/src/maps/registry.ts';

await initPhysics();
const base = placDefilad();
const out: {
  spawns: number[][];
  boxes: number[][][];
  under: number[][][];
  sectionSpawns: Record<string, number[][]>;
} = {
  spawns: [],
  boxes: [],
  under: [],
  sectionSpawns: {},
};
for (const size of ['full', 'north', 'south'] as const) {
  const m = resolveMap(base, size);
  const ph = new PhysicsWorld(m);
  const sp = spawnsFor(ph, base, m, size);
  const pts = sp.map((s) => [s.pos.x, s.pos.z, s.yaw]);
  if (size === 'full') out.spawns = pts;
  else out.sectionSpawns[size] = pts;
}
for (const b of base.boxes) {
  if (b.visible === false) continue;
  const yaw = ((b.rot?.y ?? 0) * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hx = b.size.x / 2;
  const hz = b.size.z / 2;
  const corners = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ].map(([x, z]) => [b.center.x + x! * c + z! * s, b.center.z - x! * s + z! * c]);
  (b.center.y < -0.5 ? out.under : out.boxes).push(corners);
}
writeFileSync('tools/osm/preview/layout.json', JSON.stringify(out));
console.log(
  `boxes ${out.boxes.length}, underground ${out.under.length}, spawns ${out.spawns.length}`,
);
