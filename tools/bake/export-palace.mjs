import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../packages/client/node_modules/three/build/three.module.js';
import {
  buildLightmapLayout,
  getMap,
  lightmapSceneHash,
  resolveMap,
} from '../../packages/shared/src/index.ts';
import {
  buildPalaceColumns,
  isPalacePorticoColumn,
} from '../../packages/client/src/render/palaceColumns.ts';
import { NEON_SIGNS } from '../../packages/client/src/render/neonDistrict.ts';

const BOUNDS = [48, -22, 80, 22];
const RECEIVER_Y = 0.02;
const REACH = 8;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = resolve(ROOT, 'tools/assets/build/palace-courtyard/scene.json');

class ExportMaterials {
  mats = new Map();

  get(id) {
    let mat = this.mats.get(id);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ name: id, color: 0xffffff });
      this.mats.set(id, mat);
    }
    return mat;
  }

  variant(id, key, configure) {
    const k = `${id}|${key}`;
    let mat = this.mats.get(k);
    if (!mat) {
      mat = this.get(id).clone();
      mat.name = k;
      configure(mat);
      this.mats.set(k, mat);
    }
    return mat;
  }

  facadeShellVariant(key, configure) {
    return this.variant('facade', `shell|${key}`, configure);
  }
}

const outsideRegion = (x0, z0, x1, z1, pad = 20) =>
  x1 < BOUNDS[0] - pad || x0 > BOUNDS[2] + pad || z1 < BOUNDS[1] - pad || z0 > BOUNDS[3] + pad;

function pushBox(meshes, b, name) {
  if (b.visible === false || b.dress || b.hero || b.heroPart || b.model) return;
  if (isPalacePorticoColumn(b)) return; // Replaced by its actual grooved visible geometry below.
  const radius = Math.hypot(b.size.x, b.size.y, b.size.z) / 2;
  if (
    outsideRegion(
      b.center.x - radius,
      b.center.z - radius,
      b.center.x + radius,
      b.center.z + radius,
    )
  )
    return;

  const geo = new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z);
  const e = b.rot ?? { x: 0, y: 0, z: 0 };
  geo.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(b.center.x, b.center.y, b.center.z),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(e.x),
          THREE.MathUtils.degToRad(e.y),
          THREE.MathUtils.degToRad(e.z),
          'XYZ',
        ),
      ),
      new THREE.Vector3(1, 1, 1),
    ),
  );
  meshes.push(geometryMesh(name, geo, tintColor(b.tint)));
  geo.dispose();
}

function pushPrism(meshes, p, name) {
  if (p.visible === false || p.backdrop) return;
  const xs = p.pts.map((pt) => pt[0]);
  const zs = p.pts.map((pt) => pt[1]);
  if (outsideRegion(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs))) return;
  if (p.y1 <= RECEIVER_Y + 0.03) return;

  const positions = [];
  const indices = [];
  const top = [];
  const bottom = [];
  for (const [x, z] of p.pts) {
    bottom.push(positions.length / 3);
    positions.push(x, p.y0, z);
    top.push(positions.length / 3);
    positions.push(x, p.y1, z);
  }
  const n = p.pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(bottom[i], bottom[j], top[j], bottom[i], top[j], top[i]);
  }
  for (const tri of THREE.ShapeUtils.triangulateShape(
    p.pts.map(([x, z]) => new THREE.Vector2(x, z)),
    [],
  )) {
    const [a, b, c] = tri;
    indices.push(top[a], top[c], top[b], bottom[a], bottom[b], bottom[c]);
  }
  meshes.push({ name, positions, indices, color: tintColor(p.tint) });
}

function geometryMesh(name, geo, color) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const positions = [];
  const indices = [];
  for (let i = 0; i < pos.count; i++) positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  if (idx) {
    for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i));
  } else {
    for (let i = 0; i < pos.count; i++) indices.push(i);
  }
  return { name, positions, indices, color };
}

export function isShadowOnlyMesh(obj) {
  if (!(obj instanceof THREE.Mesh)) return false;
  if (obj.name.includes(':shadow-proxy')) return true;
  const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
  return materials.some((mat) => mat?.colorWrite === false);
}

function tintColor(tint) {
  if (tint === undefined) return [0.74, 0.72, 0.68];
  const c = new THREE.Color(tint);
  return [round(c.r), round(c.g), round(c.b)];
}

const round = (value) => Math.round(value * 100000) / 100000;

export function exportColumns(map) {
  const group = buildPalaceColumns(map, new ExportMaterials());
  if (!group) return [];
  const meshes = [];
  group.updateMatrixWorld(true);
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (isShadowOnlyMesh(obj)) return;
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);
    meshes.push(geometryMesh(obj.name || 'palace-column', geo, [0.78, 0.74, 0.66]));
    geo.dispose();
  });
  return meshes;
}

export function buildScene() {
  const map = resolveMap(getMap('defilad'), 'market');
  const meshes = [];
  map.boxes.forEach((box, i) => pushBox(meshes, box, `box-${i}:${box.mat}`));
  map.prisms?.forEach((prism, i) => pushPrism(meshes, prism, `prism-${i}:${prism.mat}`));
  meshes.push(...exportColumns(map));

  const layout = buildLightmapLayout(map);
  return {
    version: 1,
    sceneHash: lightmapSceneHash(map, layout, REACH),
    layoutHash: layout.hash,
    map: 'defilad',
    size: 'market',
    mapName: map.name,
    bounds: BOUNDS,
    receiverY: RECEIVER_Y,
    emitter: NEON_SIGNS[0],
    meshes,
    limitations: [
      'Street dressing and hero-model surface meshes are omitted; their greybox/prop colliders are not exported in this pilot.',
      'The receiver is a flat courtyard patch; browser wetness, albedo and moving sun remain live.',
    ],
  };
}

async function main() {
  const out = process.argv.includes('--out')
    ? resolve(ROOT, process.argv[process.argv.indexOf('--out') + 1] ?? OUT)
    : OUT;
  const scene = buildScene();
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
  const meshCount = scene.meshes.length;
  const triCount = scene.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  console.log(JSON.stringify({ out, meshCount, triCount, sceneHash: scene.sceneHash }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
