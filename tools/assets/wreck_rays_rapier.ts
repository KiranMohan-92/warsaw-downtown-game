// Casts rays at a wreck in Rapier and prints each ray's hit distance or null.
//   node tools/assets/wreck_rays_rapier.ts <tank|heli> <rays.json>       gameplay PhysicsWorld
//   node tools/assets/wreck_rays_rapier.ts box-<tank|heli> <rays.json>   direct box colliders
//   node tools/assets/wreck_rays_rapier.ts decode   sha-256 of each decoded ray mesh's arrays
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { wreckRayMesh } from '../../packages/shared/src/maps/wreckGeometry.ts';
import { helicopterWreck, tankWreck } from '../../packages/shared/src/maps/props.ts';
import type { MapDefinition } from '../../packages/shared/src/maps/types.ts';
import { initPhysics, PhysicsWorld } from '../../packages/shared/src/physics/world.ts';

const [kind, raysPath] = process.argv.slice(2);
if (kind === 'decode') {
  const sha = (a: ArrayBufferView) =>
    createHash('sha256')
      .update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
      .digest('hex');
  const out: Record<string, { positions: string; indices: string }> = {};
  for (const id of ['tank_wreck', 'heli_wreck'] as const) {
    const m = wreckRayMesh(id);
    if (m) out[id] = { positions: sha(m.positions), indices: sha(m.indices) };
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
const boxOnly = kind === 'box-tank' || kind === 'box-heli';
const wreck = boxOnly ? kind.slice(4) : kind;
if ((wreck !== 'tank' && wreck !== 'heli') || !raysPath) {
  console.error('usage: node tools/assets/wreck_rays_rapier.ts [box-]<tank|heli> <rays.json>');
  process.exit(2);
}
await initPhysics();
const boxes = (wreck === 'tank' ? tankWreck : helicopterWreck)({ x: 0, z: 0 });
const rays = JSON.parse(readFileSync(raysPath, 'utf8')) as number[][];
const map: MapDefinition = {
  name: `wreck-${wreck}`,
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  // Remove only the mesh tags for the box baseline; both paths use the game's real query code
  // and Rapier version through shared, without a second tooling dependency on Rapier.
  boxes: boxOnly
    ? boxes.map((b) => {
        const box = { ...b };
        delete box.hero;
        delete box.heroPart;
        return box;
      })
    : boxes,
  spawns: [],
  dummies: [],
};
const world = new PhysicsWorld(map);
const out = rays.map(([ox, oy, oz, dx, dy, dz]) => {
  const hit = world.castRay({ x: ox!, y: oy!, z: oz! }, { x: dx!, y: dy!, z: dz! }, 60);
  return hit ? Math.round(hit.distance * 1e5) / 1e5 : null;
});
world.free();
process.stdout.write(
  JSON.stringify({ boxes: boxes.filter((b) => b.collide !== false).length, hits: out }),
);
