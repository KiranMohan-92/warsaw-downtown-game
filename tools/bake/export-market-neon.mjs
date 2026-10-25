/** Offline staging only: exact current Market solids and authored dressing around NOCNY RYNEK. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../packages/client/node_modules/three/build/three.module.js';
import {
  buildLightmapLayout,
  fitBox,
  fitDecor,
  getMap,
  lightmapSceneHash,
  PROP_SIZES,
  propSurface,
  resolveMap,
} from '../../packages/shared/src/index.ts';
import { buildSetDressing } from '../../packages/client/src/render/setDressing.ts';
import { NEON_SIGNS } from '../../packages/client/src/render/neonDistrict.ts';

export const BOUNDS = [76, 30, 112, 62];
export const RECEIVER_Y = 0.02;
export const OCCLUSION_PADDING = 16;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const SOURCE_FILES = [
  'tools/bake/export-market-neon.mjs',
  'tools/bake/market_neon_bake.py',
  'tools/bake/courtyard_bake.py',
  'packages/client/src/render/neonDistrict.ts',
  'packages/client/src/render/setDressing.ts',
  'packages/client/src/render/marketStallFinish.ts',
  'packages/client/src/render/marketStallProps.ts',
  'packages/shared/src/maps/propGeometry.gen.json',
  'packages/shared/src/maps/propModels.ts',
  'packages/shared/src/maps/lightmap.ts',
  'packages/shared/src/maps/registry.ts',
  'packages/shared/src/maps/builder.ts',
  'packages/shared/src/maps/geom.ts',
  'packages/shared/src/maps/props.ts',
  'packages/shared/src/maps/solids.ts',
  'packages/shared/src/maps/coverFill.ts',
  'packages/shared/src/maps/decor.ts',
  'packages/shared/src/maps/placDefilad/index.ts',
  'packages/shared/src/maps/placDefilad/market.ts',
  'packages/shared/src/maps/placDefilad/palace.ts',
  'packages/shared/src/maps/placDefilad/osm.gen.json',
  'packages/shared/src/math/quat.ts',
];
const round = (n) => Math.round(n * 100000) / 100000 || 0;

function intersects(positions) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    x0 = Math.min(x0, positions[i]);
    x1 = Math.max(x1, positions[i]);
    y1 = Math.max(y1, positions[i + 1]);
    z0 = Math.min(z0, positions[i + 2]);
    z1 = Math.max(z1, positions[i + 2]);
  }
  return (
    y1 > RECEIVER_Y + 0.03 &&
    x1 >= BOUNDS[0] - OCCLUSION_PADDING &&
    x0 <= BOUNDS[2] + OCCLUSION_PADDING &&
    z1 >= BOUNDS[1] - OCCLUSION_PADDING &&
    z0 <= BOUNDS[3] + OCCLUSION_PADDING
  );
}

function colour(tint) {
  const c = new THREE.Color(tint ?? 0xbdb8ad);
  return [c.r, c.g, c.b].map((v) => round(Math.max(0, Math.min(1, v))));
}

function geometryRecord(name, geo, color) {
  const pos = geo.getAttribute('position');
  const positions = [];
  for (let i = 0; i < pos.count; i++)
    positions.push(round(pos.getX(i)), round(pos.getY(i)), round(pos.getZ(i)));
  if (!intersects(positions)) return null;
  const indices = geo.index
    ? Array.from(geo.index.array)
    : Array.from({ length: pos.count }, (_, i) => i);
  return { name, positions, indices, color };
}

function boxGeometry(b) {
  const geo = new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z);
  const r = b.rot ?? { x: 0, y: 0, z: 0 };
  geo.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(b.center.x, b.center.y, b.center.z),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(...[r.x, r.y, r.z].map(THREE.MathUtils.degToRad), 'XYZ'),
      ),
      new THREE.Vector3(1, 1, 1),
    ),
  );
  return geo;
}

export function geometryFingerprint(meshes) {
  const hash = createHash('sha256');
  for (const mesh of meshes) {
    hash.update(`${mesh.name}\n${mesh.positions.length}/${mesh.indices.length}\n`);
    for (const values of [mesh.positions, mesh.color]) {
      const bytes = Buffer.alloc(values.length * 8);
      values.forEach((value, i) => bytes.writeDoubleLE(value === 0 ? 0 : value, i * 8));
      hash.update(bytes);
    }
    const bytes = Buffer.alloc(mesh.indices.length * 4);
    mesh.indices.forEach((value, i) => bytes.writeUInt32LE(value, i * 4));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function lightingFingerprint(emitters) {
  const hash = createHash('sha256');
  for (const e of emitters) {
    hash.update(`${e.label}\n`);
    const bytes = Buffer.alloc(8 * 8);
    [e.x, e.y, e.z, e.yaw, e.w, e.h, e.color, e.radiance].forEach((v, i) =>
      bytes.writeDoubleLE(v, i * 8),
    );
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function relevantEmitters(signs = NEON_SIGNS) {
  return signs
    .filter((s) => {
      const dx = Math.max(BOUNDS[0] - s.x, 0, s.x - BOUNDS[2]);
      const dz = Math.max(BOUNDS[1] - s.z, 0, s.z - BOUNDS[3]);
      return Math.hypot(dx, dz) <= OCCLUSION_PADDING + s.w * 0.5;
    })
    .map((s) => ({ ...s, radiance: 120 }));
}

export async function buildScene() {
  const map = resolveMap(getMap('defilad'), 'market');
  const meshes = [];
  const add = (record) => {
    if (record) meshes.push(record);
  };
  const selected = [];
  map.boxes.forEach((b, i) => {
    if (b.visible === false || b.hero || b.heroPart) return;
    const geo = boxGeometry(b);
    const record = geometryRecord(`box-${i}:${b.mat}`, geo, colour(b.tint));
    geo.dispose();
    if (!record) return;
    selected.push(b);
    if (b.model) {
      fitBox(b, PROP_SIZES).forEach((inst, j) => {
        const surface = propSurface(inst);
        const positions = Array.from(surface.positions, round);
        if (intersects(positions))
          add({
            name: `prop-${i}-${j}:${inst.model}`,
            positions,
            indices: Array.from(surface.indices),
            color: colour(b.tint),
          });
      });
    } else if (!b.dress) add(record);
  });
  (map.prisms ?? []).forEach((p, i) => {
    if (p.visible === false || p.backdrop) return;
    const positions = [];
    const indices = [];
    p.pts.forEach(([x, z]) =>
      positions.push(round(x), round(p.y0), round(z), round(x), round(p.y1), round(z)),
    );
    for (let k = 0; k < p.pts.length; k++) {
      const j = (k + 1) % p.pts.length;
      indices.push(k * 2, j * 2, j * 2 + 1, k * 2, j * 2 + 1, k * 2 + 1);
    }
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(
      p.pts.map(([x, z]) => new THREE.Vector2(x, z)),
      [],
    ))
      indices.push(a * 2 + 1, c * 2 + 1, b * 2 + 1, a * 2, b * 2, c * 2);
    if (intersects(positions))
      add({ name: `prism-${i}:${p.mat}`, positions, indices, color: colour(p.tint) });
  });
  (map.decor ?? []).forEach((d, i) => {
    fitDecor(d, PROP_SIZES).forEach((inst, j) => {
      const surface = propSurface(inst);
      const positions = Array.from(surface.positions, round);
      if (intersects(positions))
        add({
          name: `decor-${i}-${j}:${inst.model}`,
          positions,
          indices: Array.from(surface.indices),
          color: colour(),
        });
    });
  });
  // Actual curved canvas/posts/trays, not their dress-tagged placeholder boxes.
  const dressing = buildSetDressing({ ...map, boxes: selected });
  dressing.updateMatrixWorld(true);
  dressing.traverse((obj) => {
    if (
      !(obj instanceof THREE.Mesh) ||
      obj instanceof THREE.InstancedMesh ||
      obj.material.name === 'dress:lamp'
    )
      return;
    const geo = obj.geometry.clone().applyMatrix4(obj.matrixWorld);
    const color = obj.material.color
      ? [obj.material.color.r, obj.material.color.g, obj.material.color.b].map(round)
      : colour();
    add(geometryRecord(obj.name, geo, color));
    geo.dispose();
  });
  dressing.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
  const emitters = relevantEmitters();
  const sourceFingerprints = Object.fromEntries(
    await Promise.all(
      SOURCE_FILES.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(resolve(ROOT, path)))
          .digest('hex'),
      ]),
    ),
  );
  const layout = buildLightmapLayout(map);
  const scene = {
    version: 1,
    kind: 'market-neon-ground',
    map: 'defilad',
    size: 'market',
    sceneHash: lightmapSceneHash(map, layout, 8),
    layoutHash: layout.hash,
    bounds: BOUNDS,
    receiverY: RECEIVER_Y,
    occlusionPadding: OCCLUSION_PADDING,
    meshes,
    emitters,
    geometryFingerprint: geometryFingerprint(meshes),
    lightingFingerprint: lightingFingerprint(emitters),
    sourceFingerprints,
    limitations: [
      'Landmark ground only; receiver does not represent raised floors, walls, actors or underground surfaces.',
      'Occluders and emitters are selected within 16 m of the tile; more distant illumination and bounces are omitted.',
      'Hero/wreck models, tree crowns, soft foliage cards, centimetre-sized produce and district trims are omitted; authored solid hedge boxes, main solids, scanned static props and actual stall awnings/posts/trays are exported.',
      'Occluders use flat approximate diffuse colours, not their browser textures, metallic BRDFs or translucent cloth.',
      'Only selected neon panels emit: stall strips, sun, sky, hall lamps, moving actors and wet reflections stay outside this bake.',
      'Uniform panel radiance is an artistic calibration, not measured photometric signage; actual sign lettering/alpha is not baked.',
      'Existing additive neon ground decals must be reviewed when integrating this illumination to avoid double lighting.',
    ],
  };
  const text = `${JSON.stringify(scene)}\n`;
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES)
    throw new Error('Market neon scene exceeds 8 MiB; do not launch');
  return scene;
}

async function main() {
  const arg = process.argv.indexOf('--out');
  const out = resolve(
    ROOT,
    arg >= 0 ? process.argv[arg + 1] : 'tools/assets/build/market-neon-staging/scene.json',
  );
  const scene = await buildScene();
  const payload = `${JSON.stringify(scene)}\n`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, payload);
  console.log(
    JSON.stringify({
      out,
      bytes: Buffer.byteLength(payload),
      meshes: scene.meshes.length,
      triangles: scene.meshes.reduce((n, m) => n + m.indices.length / 3, 0),
      emitters: scene.emitters.map((e) => e.label),
      geometryFingerprint: scene.geometryFingerprint,
      inputSha256: createHash('sha256').update(payload).digest('hex'),
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
