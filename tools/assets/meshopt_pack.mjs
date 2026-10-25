// Meshopt-pack glTF models in place (EXT_meshopt_compression): geometry and animation buffer views
// are encoded with the meshopt codecs; floats first go through the exponential filter (still
// floats after decoding, mantissa trimmed per role), so loaders need only `setMeshoptDecoder`.
// Images and anything unusual (shared or interleaved-with-offset views) stay raw. Idempotent:
// already packed files are skipped.
//
//   node tools/assets/meshopt_pack.mjs [--check] <file.glb|file.gltf | dir> ...
//   pnpm assets:pack            # every model under packages/client/public/models
//
// --check: exit 1 if any file is not packed (used by a test so a re-export can't ship raw).
// --unpack [--out <dir>] <file>...: decode packed models to plain glTF under tools/assets/build/unpacked/<path
//   under public/models> (git-ignored) for asset tools that read shipped meshes back
//   (tools/assets/raw_models.py calls this on demand; collision props decode bit-exactly).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const EXT = 'EXT_meshopt_compression';
const FLOAT = 5126;
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
/** Mantissa bits kept per role (exponential filter); absent = lossless. */
const EXP_BITS = {
  POSITION: 20,
  NORMAL: 14,
  TANGENT: 14,
  TEXCOORD_0: 18,
  TEXCOORD_1: 18,
  'anim:rotation': 16,
  'anim:translation': 18,
  'anim:scale': 16,
};

const align4 = (n) => (n + 3) & ~3;

function readModel(file) {
  const raw = readFileSync(file);
  if (extname(file) === '.glb') {
    const jsonLen = raw.readUInt32LE(12);
    const json = JSON.parse(raw.subarray(20, 20 + jsonLen).toString('utf8'));
    const binOff = 20 + jsonLen;
    const bin =
      raw.length > binOff
        ? raw.subarray(binOff + 8, binOff + 8 + raw.readUInt32LE(binOff))
        : Buffer.alloc(0);
    return { json, bin, binFile: null };
  }
  const json = JSON.parse(raw.toString('utf8'));
  const uri = json.buffers?.[0]?.uri;
  const binFile = uri ? join(dirname(file), decodeURIComponent(uri)) : null;
  return { json, bin: binFile ? readFileSync(binFile) : Buffer.alloc(0), binFile };
}

function writeModel(file, json, bin, binFile) {
  if (extname(file) === '.glb') {
    const js = Buffer.from(JSON.stringify(json), 'utf8');
    const jsPad = Buffer.concat([js, Buffer.alloc(align4(js.length) - js.length, 0x20)]);
    const binPad = Buffer.concat([bin, Buffer.alloc(align4(bin.length) - bin.length)]);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(12 + 8 + jsPad.length + 8 + binPad.length, 8);
    const chunk = (type, data) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(data.length, 0);
      h.writeUInt32LE(type, 4);
      return Buffer.concat([h, data]);
    };
    writeFileSync(file, Buffer.concat([head, chunk(0x4e4f534a, jsPad), chunk(0x004e4942, binPad)]));
  } else {
    writeFileSync(binFile, bin);
    writeFileSync(file, JSON.stringify(json));
  }
}

const isPacked = (json) => (json.extensionsUsed ?? []).includes(EXT);

/** Role of every accessor: 'index', an attribute name, 'anim:in', 'anim:<path>' or 'other'. */
function accessorRoles(json) {
  const roles = new Map();
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives) {
      if (p.indices !== undefined)
        roles.set(p.indices, (p.mode ?? 4) === 4 ? 'index:tri' : 'index');
      for (const [name, a] of Object.entries(p.attributes)) roles.set(a, name);
      for (const t of p.targets ?? []) for (const a of Object.values(t)) roles.set(a, 'target');
    }
  }
  for (const anim of json.animations ?? []) {
    for (const s of anim.samplers) roles.set(s.input, 'anim:in');
    for (const c of anim.channels)
      roles.set(anim.samplers[c.sampler].output, `anim:${c.target.path}`);
  }
  return roles;
}

const MODELS = resolve(import.meta.dirname, '../../packages/client/public/models');
const UNPACKED = resolve(import.meta.dirname, 'build/unpacked');

/**
 * Prop models are validated against the shared collision mesh index by index
 * (`validatePropGeometry`): keep their positions lossless and their index order exact.
 */
function isCollisionProp(file) {
  const manifest = join(MODELS, 'manifest.json');
  if (relative(MODELS, dirname(dirname(file))) !== '') return false;
  try {
    const models = JSON.parse(readFileSync(manifest, 'utf8')).models ?? {};
    return Object.hasOwn(models, basename(dirname(file)));
  } catch {
    return false;
  }
}

function pack(file) {
  const exact = isCollisionProp(file);
  const { json, bin, binFile } = readModel(file);
  if (isPacked(json)) return null;
  if ((json.buffers ?? []).length !== 1) throw new Error(`${file}: expected one buffer`);
  const roles = accessorRoles(json);
  const byView = new Map();
  (json.accessors ?? []).forEach((a, i) => {
    if (a.bufferView === undefined || a.sparse) return;
    byView.set(a.bufferView, [...(byView.get(a.bufferView) ?? []), i]);
  });
  const parts = []; // pieces of the new real buffer
  let size = 0;
  let fallback = 0;
  const push = (data) => {
    const off = size;
    parts.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    size += data.byteLength;
    const pad = align4(size) - size;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      size += pad;
    }
    return off;
  };
  let encoded = 0;
  json.bufferViews.forEach((view, vi) => {
    const src = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const accs = byView.get(vi) ?? [];
    const acc = accs.length === 1 ? json.accessors[accs[0]] : null;
    const role = acc ? roles.get(accs[0]) : undefined;
    const elem = acc ? SIZE[acc.componentType] * COMPONENTS[acc.type] : 0;
    const stride = view.byteStride ?? elem;
    const ok =
      acc &&
      role &&
      role !== 'target' &&
      !(acc.byteOffset > 0) &&
      stride === elem &&
      acc.count * stride === view.byteLength;
    if (!ok) {
      view.byteOffset = push(src);
      view.buffer = 0;
      return;
    }
    let mode, data, filter;
    if (role.startsWith('index')) {
      const tri =
        !exact && role === 'index:tri' && acc.count % 3 === 0 && (stride === 2 || stride === 4);
      mode = tri ? 'TRIANGLES' : 'INDICES';
      if (!tri && stride !== 2 && stride !== 4) {
        view.byteOffset = push(src);
        view.buffer = 0;
        return;
      }
      data = Uint8Array.from(src);
    } else {
      if (stride % 4 !== 0 || stride > 256) {
        view.byteOffset = push(src);
        view.buffer = 0;
        return;
      }
      mode = 'ATTRIBUTES';
      const bits = exact && role === 'POSITION' ? undefined : EXP_BITS[role];
      if (acc.componentType === FLOAT && bits) {
        const f = new Float32Array(Uint8Array.from(src).buffer);
        data = MeshoptEncoder.encodeFilterExp(f, acc.count, stride, bits);
        filter = 'EXPONENTIAL';
      } else data = Uint8Array.from(src);
    }
    const enc = MeshoptEncoder.encodeGltfBuffer(data, acc.count, stride, mode);
    const off = push(enc);
    view.buffer = 1;
    view.byteOffset = fallback;
    fallback = align4(fallback + view.byteLength);
    view.extensions = {
      ...(view.extensions ?? {}),
      [EXT]: {
        buffer: 0,
        byteOffset: off,
        byteLength: enc.byteLength,
        byteStride: stride,
        count: acc.count,
        mode,
        ...(filter ? { filter } : {}),
      },
    };
    encoded++;
  });
  const out = Buffer.concat(parts);
  const b0 = { ...json.buffers[0], byteLength: out.length };
  json.buffers = [
    b0,
    { byteLength: Math.max(4, fallback), extensions: { [EXT]: { fallback: true } } },
  ];
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), EXT])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), EXT])];
  writeModel(file, json, out, binFile);
  return { before: bin.length, after: out.length, encoded, views: json.bufferViews.length, exact };
}

const models = (p) =>
  statSync(p).isDirectory()
    ? readdirSync(p).flatMap((e) => models(join(p, e)))
    : /\.(glb|gltf)$/.test(p)
      ? [p]
      : [];

/** Decode a packed model to plain glTF (one buffer, no extension) under UNPACKED. */
function unpack(file, outDir = UNPACKED) {
  const { json, bin } = readModel(file);
  const rel = relative(MODELS, file);
  if (rel.startsWith('..')) throw new Error(`${file}: not under ${MODELS}`);
  const to = join(outDir, rel);
  mkdirSync(dirname(to), { recursive: true });
  if (!isPacked(json)) {
    const { binFile } = readModel(file);
    writeFileSync(to, readFileSync(file));
    if (binFile) writeFileSync(join(dirname(to), basename(binFile)), readFileSync(binFile));
    return to;
  }
  const parts = [];
  let size = 0;
  for (const view of json.bufferViews) {
    const ext = view.extensions?.[EXT];
    let data;
    if (ext) {
      data = new Uint8Array(ext.count * ext.byteStride);
      const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
      MeshoptDecoder.decodeGltfBuffer(data, ext.count, ext.byteStride, src, ext.mode, ext.filter);
      delete view.extensions[EXT];
      if (!Object.keys(view.extensions).length) delete view.extensions;
    } else {
      data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    }
    view.buffer = 0;
    view.byteOffset = size;
    view.byteLength = data.byteLength;
    parts.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    size += data.byteLength;
    const pad = align4(size) - size;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      size += pad;
    }
  }
  const out = Buffer.concat(parts);
  json.buffers = [{ ...json.buffers[0], byteLength: out.length }];
  json.extensionsUsed = (json.extensionsUsed ?? []).filter((e) => e !== EXT);
  json.extensionsRequired = (json.extensionsRequired ?? []).filter((e) => e !== EXT);
  if (!json.extensionsUsed.length) delete json.extensionsUsed;
  if (!json.extensionsRequired.length) delete json.extensionsRequired;
  const binTo = json.buffers[0].uri
    ? join(dirname(to), decodeURIComponent(json.buffers[0].uri))
    : null;
  writeModel(to, json, out, binTo);
  return to;
}

const args = process.argv.slice(2);
if (args[0] === '--unpack') {
  // --unpack [--out <dir>] <file>...  (default dir: tools/assets/build/unpacked)
  const o = args.indexOf('--out');
  const outDir = o > 0 ? resolve(args[o + 1]) : UNPACKED;
  const files = args.slice(1).filter((_, i) => o < 0 || (i + 1 !== o && i + 1 !== o + 1));
  await MeshoptDecoder.ready;
  for (const f of files.map((a) => resolve(a)).flatMap(models)) console.log(unpack(f, outDir));
  process.exit(0);
}
const check = args[0] === '--check';
const targets = (check ? args.slice(1) : args).map((a) => resolve(a)).flatMap(models);
if (check) {
  const raw = targets.filter((f) => !isPacked(readModel(f).json));
  for (const f of raw) console.error(`not meshopt-packed: ${f} (run pnpm assets:pack)`);
  process.exit(raw.length ? 1 : 0);
}
await MeshoptEncoder.ready;
let before = 0;
let after = 0;
for (const f of targets) {
  const r = pack(f);
  if (!r) continue;
  before += r.before;
  after += r.after;
  console.log(
    `${f}: ${(r.before / 1024).toFixed(0)} → ${(r.after / 1024).toFixed(0)} KiB (${r.encoded}/${r.views} views${r.exact ? ', exact' : ''})`,
  );
}
console.log(`total ${(before / 1048576).toFixed(2)} → ${(after / 1048576).toFixed(2)} MiB`);
