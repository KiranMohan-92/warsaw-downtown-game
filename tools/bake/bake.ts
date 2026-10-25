/**
 * Offline lightmap baker (no Blender): sky visibility / ambient occlusion for a resolved map,
 * ray-cast against the same Rapier world the game collides with.
 *
 *   pnpm bake                                  # Plac Defilad, Market (the default)
 *   pnpm bake --map defilad --size market --samples 64 --workers 8
 *   pnpm bake --out C:/tmp/trial-bake            # trial: writes everything there, not the repo
 *
 * Output: `packages/client/public/lightmaps/<map>-<size>-{atlas,ground,lamps,lampvol}.png` +
 * `manifest.json`,
 * and the bundled mirror `packages/shared/src/maps/lightmapManifest.ts` the client checks at load.
 * Deterministic: fixed sample pattern, fixed job split (independent of --workers), so the same
 * map re-bakes byte for byte. See tools/bake/README.md.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';
import * as prettier from 'prettier';
import { initPhysics, PhysicsWorld } from '../../packages/shared/src/physics/world.ts';
import type { Vec3 } from '../../packages/shared/src/math/vec3.ts';
import type { WorldHit } from '../../packages/shared/src/sim/hitscan.ts';
import {
  getMap,
  resolveMap,
  type MapId,
  type MapSize,
} from '../../packages/shared/src/maps/registry.ts';
import {
  buildLightmapLayout,
  encodeLamp,
  lightmapSceneHash,
  type BakedLightmap,
  type LightmapLayout,
  type LightmapRect,
} from '../../packages/shared/src/maps/lightmap.ts';
import {
  BAKE_SETTINGS,
  bakeEmitters,
  bakeLampRect,
  bakeLampVolume,
  bakeOccluders,
  bakeRect,
  bakeWorldOf,
  featherBorder,
  finishLampVolume,
  finishRect,
  hemispherePattern,
  writeRect,
  type BakeEmitter,
  type BakeSettings,
  type BakeWorld,
} from '../../packages/shared/src/maps/lightmapBake.ts';
import { encodeGreyPng } from '../../packages/shared/src/maps/lightmapPng.ts';
import {
  bakedLampVolume,
  lampVolumeImageSize,
  lampVolumeLayout,
  lampVolumePlanes,
  type LampVolumeLayout,
} from '../../packages/shared/src/maps/lampVolume.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = resolve(ROOT, 'packages/client/public/lightmaps');
const MANIFEST_TS = resolve(ROOT, 'packages/shared/src/maps/lightmapManifest.ts');
/** Where this run writes (`--out` redirects both). */
let outDir = OUT_DIR;
let manifestTs = MANIFEST_TS;

/** Ground rows per job: a fixed split, so results never depend on the worker count. */
const GROUND_BAND = 32;
/** Small atlas rects are batched into jobs of about this many texels. */
const JOB_TEXELS = 4096;
/** Lamp-volume slices (z) per job: a fixed split, like the ground bands. */
const VOLUME_BAND = 2;

interface Setup {
  map: MapId;
  size: MapSize;
  settings: BakeSettings;
}

/**
 * One unit of work: atlas rects [r0, r1), ground rows [j0, j1) (r0 = −1), or lamp-volume slices
 * [j0, j1) (r0 = −2).
 */
interface Job {
  id: number;
  r0: number;
  r1: number;
  j0: number;
  j1: number;
}

interface JobResult {
  id: number;
  value: Float32Array<ArrayBuffer>;
  valid: Uint8Array<ArrayBuffer>;
  /** Lamp irradiance per texel (atlas jobs; empty for ground bands). */
  lamp: Float32Array<ArrayBuffer>;
  /** Rays in this job that tripped a Rapier panic. */
  traps: number;
}

/**
 * The game's Rapier world over the bake occluders, plus a point-containment test. A ray that still
 * trips a Rapier panic (a WASM trap leaves the world unusable) counts as blocked at distance 0,
 * and the world is rebuilt; the count is reported.
 */
class BakeRaycaster implements BakeWorld {
  private world: PhysicsWorld;
  private view: BakeWorld;
  traps = 0;
  constructor(private readonly make: () => PhysicsWorld) {
    this.world = make();
    this.view = bakeWorldOf(this.world);
  }
  castRay(origin: Vec3, dir: Vec3, maxDistance: number): WorldHit | null {
    try {
      return this.view.castRay(origin, dir, maxDistance);
    } catch {
      this.traps++;
      this.world = this.make();
      this.view = bakeWorldOf(this.world);
      return { distance: 0, point: origin, normal: { x: 0, y: 1, z: 0 }, visible: true };
    }
  }
  isInside(p: Vec3): boolean {
    return this.view.isInside!(p);
  }
  free(): void {
    this.world.free();
  }
}

async function prepare(setup: Setup): Promise<{
  layout: LightmapLayout;
  world: BakeRaycaster;
  sceneHash: string;
  mapName: string;
  emitters: BakeEmitter[];
  volume: LampVolumeLayout | null;
}> {
  await initPhysics();
  const map = resolveMap(getMap(setup.map), setup.size);
  const layout = buildLightmapLayout(map);
  const emitters = bakeEmitters(map);
  const occluders = bakeOccluders(map);
  const world = new BakeRaycaster(() => {
    const w = new PhysicsWorld(occluders);
    if (w.skippedHulls) throw new Error(`bake: ${w.skippedHulls} prisms could not be hulled`);
    return w;
  });
  return {
    layout,
    world,
    sceneHash: lightmapSceneHash(map, layout, setup.settings.reach),
    mapName: map.name,
    emitters,
    volume: lampVolumeLayout(emitters),
  };
}

function jobRects(layout: LightmapLayout, job: Job): LightmapRect[] {
  return job.r0 < 0 ? [layout.ground.rect] : layout.atlas.rects.slice(job.r0, job.r1);
}

function runJob(
  layout: LightmapLayout,
  volume: LampVolumeLayout | null,
  world: BakeWorld,
  settings: BakeSettings,
  pattern: Float64Array,
  emitters: readonly BakeEmitter[],
  job: Job,
): JobResult {
  if (job.r0 === -2) {
    const v = bakeLampVolume(world, volume!, emitters, [job.j0, job.j1]);
    return { id: job.id, value: v.value, valid: v.valid, lamp: new Float32Array(0), traps: 0 };
  }
  const rects = jobRects(layout, job);
  const parts = rects.map((r) =>
    bakeRect(world, r, settings, pattern, job.r0 < 0 ? [job.j0, job.j1] : [0, r.h]),
  );
  const n = parts.reduce((a, p) => a + p.value.length, 0);
  const value = new Float32Array(n);
  const valid = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    value.set(p.value, o);
    valid.set(p.valid, o);
    o += p.value.length;
  }
  const lamp = new Float32Array(job.r0 < 0 ? 0 : n);
  if (job.r0 >= 0) {
    let q = 0;
    for (const r of rects) {
      lamp.set(bakeLampRect(world, r, emitters, settings), q);
      q += r.w * r.h;
    }
  }
  return { id: job.id, value, valid, lamp, traps: 0 };
}

function makeJobs(layout: LightmapLayout, volume: LampVolumeLayout | null): Job[] {
  const jobs: Job[] = [];
  const { rects } = layout.atlas;
  let r0 = 0;
  let texels = 0;
  for (let r = 0; r < rects.length; r++) {
    texels += rects[r]!.w * rects[r]!.h;
    if (texels >= JOB_TEXELS || r === rects.length - 1) {
      jobs.push({ id: jobs.length, r0, r1: r + 1, j0: 0, j1: 0 });
      r0 = r + 1;
      texels = 0;
    }
  }
  for (let j = 0; j < layout.ground.height; j += GROUND_BAND) {
    const j1 = Math.min(layout.ground.height, j + GROUND_BAND);
    jobs.push({ id: jobs.length, r0: -1, r1: -1, j0: j, j1 });
  }
  for (let k = 0; volume && k < volume.nz; k += VOLUME_BAND) {
    const k1 = Math.min(volume.nz, k + VOLUME_BAND);
    jobs.push({ id: jobs.length, r0: -2, r1: -2, j0: k, j1: k1 });
  }
  return jobs;
}

// ---- worker ------------------------------------------------------------------------------------

if (!isMainThread) {
  const setup = workerData as Setup;
  const { layout, world, emitters, volume } = await prepare(setup);
  const pattern = hemispherePattern(setup.settings.samples);
  parentPort!.on('message', (job: Job | null) => {
    if (!job) {
      world.free();
      parentPort!.close();
      return;
    }
    const before = world.traps;
    const res = runJob(layout, volume, world, setup.settings, pattern, emitters, job);
    res.traps = world.traps - before;
    parentPort!.postMessage(res, [res.value.buffer, res.valid.buffer, res.lamp.buffer]);
  });
  parentPort!.postMessage({ ready: layout.hash });
} else {
  await main();
}

// ---- main --------------------------------------------------------------------------------------

async function main(): Promise<void> {
  // `pnpm bake -- --map …` (npm habit): pnpm passes the `--` through; strict parseArgs would
  // treat it as the end of options and reject what follows.
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      map: { type: 'string', default: 'defilad' },
      size: { type: 'string', default: 'market' },
      samples: { type: 'string', default: String(BAKE_SETTINGS.samples) },
      workers: { type: 'string', default: String(Math.max(1, availableParallelism() - 2)) },
      // Write everything (PNGs, manifest.json, the TS mirror) into this directory instead of the
      // repo: a trial bake that leaves the committed lightmaps untouched.
      out: { type: 'string' },
    },
  });
  if (values.out) {
    outDir = resolve(values.out);
    manifestTs = resolve(outDir, 'lightmapManifest.ts');
  }
  const setup: Setup = {
    map: values.map as MapId,
    size: values.size as MapSize,
    settings: { ...BAKE_SETTINGS, samples: Number(values.samples) },
  };
  const t0 = performance.now();
  const { layout, world, sceneHash, mapName, emitters, volume } = await prepare(setup);
  const emitterCount = emitters.length;
  world.free();
  const jobs = makeJobs(layout, volume);
  const texels =
    layout.atlas.rects.reduce((a, r) => a + r.w * r.h, 0) +
    layout.ground.width * layout.ground.height;
  const workers = Math.max(1, Math.min(Number(values.workers), jobs.length));
  console.log(
    `bake ${mapName}: layout ${layout.hash}, atlas ${layout.atlas.width}×${layout.atlas.height} ` +
      `(${layout.atlas.rects.length} faces), ground ${layout.ground.width}×${layout.ground.height}, ` +
      `${texels} texels × ${setup.settings.samples} rays, lamp volume ` +
      (volume ? `${volume.nx}×${volume.ny}×${volume.nz} @ ${volume.cell} m` : 'none') +
      `, ${jobs.length} jobs on ${workers} workers`,
  );

  const results = new Map<number, JobResult>();
  let traps = 0;
  // Big jobs first so the tail is short (results are keyed by id: order doesn't matter).
  const queue = [...jobs].sort((a, b) => jobCost(layout, b) - jobCost(layout, a) || a.id - b.id);
  let lastLog = performance.now();
  await Promise.all(
    Array.from(
      { length: workers },
      () =>
        new Promise<void>((done, fail) => {
          const w = new Worker(new URL(import.meta.url), { workerData: setup });
          const next = (): void => {
            const job = queue.shift();
            w.postMessage(job ?? null);
            if (!job) done();
          };
          w.on('message', (msg: JobResult | { ready: string }) => {
            if ('ready' in msg) {
              if (msg.ready !== layout.hash) fail(new Error('bake: worker layout differs'));
              else next();
              return;
            }
            results.set(msg.id, msg);
            traps += msg.traps;
            if (performance.now() - lastLog > 5000) {
              lastLog = performance.now();
              console.log(`  ${Math.round((results.size / jobs.length) * 100)}%`);
            }
            next();
          });
          w.on('error', fail);
        }),
    ),
  );

  // Assemble, denoise, dilate, write.
  const atlas = new Uint8Array(layout.atlas.width * layout.atlas.height).fill(255);
  const lamps = new Uint8Array(layout.atlas.width * layout.atlas.height);
  let lampTexels = 0;
  let aoSum = 0;
  let aoCount = 0;
  for (const job of jobs) {
    if (job.r0 < 0) continue;
    const res = results.get(job.id)!;
    let o = 0;
    for (const rect of jobRects(layout, job)) {
      const n = rect.w * rect.h;
      const value = res.value.slice(o, o + n);
      const valid = res.valid.slice(o, o + n);
      const lamp = res.lamp.slice(o, o + n);
      if (lamp.some((e) => e > 0)) {
        finishRect(lamp, valid, rect.w, rect.h);
        for (let k = 0; k < n; k++) lamp[k] = encodeLamp(lamp[k]!);
        writeRect(lamps, layout.atlas.width, rect, lamp, layout.params.gutter);
        lampTexels += n;
      }
      finishRect(value, valid, rect.w, rect.h);
      writeRect(atlas, layout.atlas.width, rect, value, layout.params.gutter);
      for (const v of value) aoSum += v;
      aoCount += n;
      o += n;
    }
  }
  const gw = layout.ground.width;
  const gh = layout.ground.height;
  const ground = new Float32Array(gw * gh);
  const groundValid = new Uint8Array(gw * gh);
  for (const job of jobs) {
    if (job.r0 !== -1) continue;
    const res = results.get(job.id)!;
    ground.set(res.value, job.j0 * gw);
    groundValid.set(res.valid, job.j0 * gw);
  }
  finishRect(ground, groundValid, gw, gh);
  featherBorder(ground, gw, gh, setup.settings.groundFeather);
  const groundImg = new Uint8Array(gw * gh);
  writeRect(groundImg, gw, layout.ground.rect, ground, 0);

  const base = `${setup.map}-${setup.size}`;
  const deflate = (d: Uint8Array): Uint8Array => deflateSync(d, { level: 9, memLevel: 9 });
  const atlasPng = encodeGreyPng(atlas, layout.atlas.width, layout.atlas.height, deflate);
  const groundPng = encodeGreyPng(groundImg, gw, gh, deflate);
  const lampsPng = encodeGreyPng(lamps, layout.atlas.width, layout.atlas.height, deflate);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, `${base}-atlas.png`), atlasPng);
  writeFileSync(resolve(outDir, `${base}-ground.png`), groundPng);
  writeFileSync(resolve(outDir, `${base}-lamps.png`), lampsPng);
  let volumePng: Uint8Array | null = null;
  if (volume) {
    const n = volume.nx * volume.ny;
    const samples = {
      value: new Float32Array(n * volume.nz * 4),
      valid: new Uint8Array(n * volume.nz),
    };
    for (const job of jobs) {
      if (job.r0 !== -2) continue;
      const res = results.get(job.id)!;
      samples.value.set(res.value, job.j0 * n * 4);
      samples.valid.set(res.valid, job.j0 * n);
    }
    finishLampVolume(volume, samples);
    const [vw, vh] = lampVolumeImageSize(volume);
    volumePng = encodeGreyPng(lampVolumePlanes(volume, samples.value), vw, vh, deflate);
    writeFileSync(resolve(outDir, `${base}-lampvol.png`), volumePng);
  }

  const entry: BakedLightmap = {
    map: setup.map,
    size: setup.size,
    mapName,
    layoutHash: layout.hash,
    sceneHash,
    atlas: { file: `${base}-atlas.png`, width: layout.atlas.width, height: layout.atlas.height },
    ground: { file: `${base}-ground.png`, width: gw, height: gh },
    lamps: { file: `${base}-lamps.png`, width: layout.atlas.width, height: layout.atlas.height },
    ...(volume ? { volume: bakedLampVolume(`${base}-lampvol.png`, volume) } : {}),
    bake: { samples: setup.settings.samples, reach: setup.settings.reach },
  };
  await writeManifests(entry);
  const s = (performance.now() - t0) / 1000;
  console.log(
    `done in ${s.toFixed(1)} s: atlas ${(atlasPng.length / 1024).toFixed(0)} KiB, ground ` +
      `${(groundPng.length / 1024).toFixed(0)} KiB, mean face AO ${(aoSum / aoCount).toFixed(3)}, ` +
      `${traps} trapped rays; lamps ${(lampsPng.length / 1024).toFixed(0)} KiB (${lampTexels} lit ` +
      `texels, ${emitterCount} fixtures)` +
      (volumePng ? `; lamp volume ${(volumePng.length / 1024).toFixed(0)} KiB` : ''),
  );
}

function jobCost(layout: LightmapLayout, job: Job): number {
  // A voxel casts ~16 shadow rays per nearby fixture: a slice band weighs like a big atlas job.
  if (job.r0 === -2) return (job.j1 - job.j0) * JOB_TEXELS * 4;
  return job.r0 < 0
    ? (job.j1 - job.j0) * layout.ground.width
    : jobRects(layout, job).reduce((a, r) => a + r.w * r.h, 0);
}

/** Merge the entry into `manifest.json` (public) and its bundled TS mirror (shared). */
async function writeManifests(entry: BakedLightmap): Promise<void> {
  const jsonPath = resolve(outDir, 'manifest.json');
  const prev = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as { lightmaps: BakedLightmap[] }).lightmaps
    : [];
  const lightmaps = [
    ...prev.filter((e) => !(e.map === entry.map && e.size === entry.size)),
    entry,
  ].sort((a, b) => `${a.map}-${a.size}`.localeCompare(`${b.map}-${b.size}`));
  const fmt = async (src: string, file: string): Promise<string> =>
    prettier.format(src, { ...(await prettier.resolveConfig(file)), filepath: file });
  writeFileSync(
    jsonPath,
    await fmt(
      JSON.stringify({ generated: 'tools/bake/bake.ts (pnpm bake) — do not edit', lightmaps }),
      jsonPath,
    ),
  );
  writeFileSync(
    manifestTs,
    await fmt(
      `// Generated by \`pnpm bake\` (tools/bake/bake.ts) — do not edit by hand. Mirrors
// packages/client/public/lightmaps/manifest.json so the client can validate a bake synchronously
// at load (before shaders compile).
import type { BakedLightmap } from './lightmap.ts';

export const BAKED_LIGHTMAPS: readonly BakedLightmap[] = ${JSON.stringify(lightmaps)};
`,
      manifestTs,
    ),
  );
}
