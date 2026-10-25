/**
 * Test helper: read a shipped model's accessors straight from disk (glb or gltf + bin), decoding
 * meshopt-packed buffer views (EXT_meshopt_compression) with three's own decoder. `await
 * modelDataReady` once (the decoder is WASM) before calling `readAccessor`.
 */
import { readFileSync } from 'node:fs';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const modelDataReady: Promise<void> = MeshoptDecoder.ready;

interface Accessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}
interface View {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: {
    EXT_meshopt_compression?: {
      byteOffset?: number;
      byteLength: number;
      byteStride: number;
      count: number;
      mode: string;
      filter?: string;
    };
  };
}
export interface ModelJson {
  nodes?: { name?: string; mesh?: number }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: Accessor[];
  bufferViews: View[];
  buffers: { uri?: string }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

export function readModel(file: URL): { json: ModelJson; bin: Uint8Array } {
  const raw = readFileSync(file);
  if (file.pathname.endsWith('.glb')) {
    const len = raw.readUInt32LE(12);
    const json = JSON.parse(raw.subarray(20, 20 + len).toString('utf8')) as ModelJson;
    const off = 20 + len;
    return { json, bin: new Uint8Array(raw.subarray(off + 8, off + 8 + raw.readUInt32LE(off))) };
  }
  const json = JSON.parse(raw.toString('utf8')) as ModelJson;
  return { json, bin: new Uint8Array(readFileSync(new URL(json.buffers[0]!.uri!, file))) };
}

/** Accessor `index` as a tightly packed typed array (`components` values per element). */
export function readAccessor(
  model: { json: ModelJson; bin: Uint8Array },
  index: number,
): { data: Float32Array | Uint32Array | Uint16Array | Uint8Array; components: number } {
  const { json, bin } = model;
  const acc = json.accessors[index]!;
  const view = json.bufferViews[acc.bufferView]!;
  const Typed = TYPED[acc.componentType as keyof typeof TYPED];
  const components = COMPONENTS[acc.type]!;
  const elem = Typed.BYTES_PER_ELEMENT * components;
  const ext = view.extensions?.EXT_meshopt_compression;
  let bytes: Uint8Array;
  let stride: number;
  if (ext) {
    bytes = new Uint8Array(ext.count * ext.byteStride);
    const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    MeshoptDecoder.decodeGltfBuffer(bytes, ext.count, ext.byteStride, src, ext.mode, ext.filter);
    stride = ext.byteStride;
  } else {
    const start = view.byteOffset ?? 0;
    bytes = bin.slice(start, start + view.byteLength);
    stride = view.byteStride ?? elem;
  }
  const out = new Uint8Array(acc.count * elem);
  for (let i = 0; i < acc.count; i++) {
    const s = (acc.byteOffset ?? 0) + i * stride;
    out.set(bytes.subarray(s, s + elem), i * elem);
  }
  return { data: new Typed(out.buffer), components };
}
