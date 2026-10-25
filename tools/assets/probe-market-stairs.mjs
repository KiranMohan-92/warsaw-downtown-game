/** Read-only real-map support diagnostic. Run with Node --experimental-transform-types. */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMap, resolveMap } from '../../packages/shared/src/maps/registry.ts';
import { initPhysics, PhysicsWorld } from '../../packages/shared/src/physics/world.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'tools/assets/build/market-stair-support-20261006.json');
const map = resolveMap(getMap('defilad'), 'market');
const samples = [150.6, 150, 149, 148, 147, 146];
const isHallRamp = (box) =>
  box.visible === false &&
  box.mat === 'wood' &&
  box.center.x > 143 &&
  box.center.x < 153 &&
  box.center.z > 26 &&
  box.center.z < 28;
const removed = map.boxes.filter(isHallRamp);
if (removed.length !== 1) throw new Error(`Expected one hall ramp; found ${removed.length}`);
await initPhysics();
const variants = [];
for (const [name, boxes] of [
  ['shipped', map.boxes],
  ['diagnostic_without_hall_ramp', map.boxes.filter((box) => !isHallRamp(box))],
]) {
  const world = new PhysicsWorld({ ...map, boxes });
  const results = [];
  try {
    for (const x of samples) {
      const body = world.createCharacter({ x, y: 4.3, z: 26.7 });
      try {
        let grounded = false;
        // Fixed downward requests settle the actual controller without altering map/runtime data.
        for (let i = 0; i < 360; i++) grounded = body.move({ x: 0, y: -0.05, z: 0 }).grounded;
        const feet = body.position;
        const visible = world.castVisibleRay(
          { x: feet.x, y: feet.y + 0.3, z: feet.z },
          { x: 0, y: -1, z: 0 },
          1,
        );
        results.push({
          requestedX: x,
          feet,
          grounded,
          visibleSupport: visible,
          gapMetres: visible ? feet.y - visible.point.y : null,
        });
      } finally {
        body.free();
      }
    }
  } finally {
    world.free();
  }
  variants.push({ name, samples: results });
}
const sources = {};
for (const relative of [
  'packages/shared/src/physics/world.ts',
  'packages/shared/src/maps/builder.ts',
  'packages/shared/src/maps/placDefilad/market.ts',
  'tools/assets/probe-market-stairs.mjs',
]) {
  sources[relative] = createHash('sha256')
    .update(await readFile(resolve(root, relative)))
    .digest('hex');
}
const shipped = variants[0].samples;
const result = {
  version: 1,
  purpose: 'Capsule root versus rendered stair support; not animated foot placement',
  map: 'defilad/market',
  sources,
  excludedRampCountInDiagnostic: removed.length,
  acceptance: shipped.every(
    (sample) => sample.grounded && sample.gapMetres !== null && Math.abs(sample.gapMetres) <= 0.025,
  )
    ? 'pass'
    : 'fail',
  toleranceMetres: 0.025,
  variants,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify({
    output,
    acceptance: result.acceptance,
    gapsMillimetres: variants.map((variant) => ({
      name: variant.name,
      values: variant.samples.map((sample) =>
        sample.gapMetres === null ? null : +(sample.gapMetres * 1000).toFixed(2),
      ),
    })),
  }),
);
