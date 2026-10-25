/**
 * Ray meshes of the re-baked wrecks (tools/assets/build_wreck_collision.py): every ray query —
 * bullets, knife, frag flight and blast line of sight, sight/perception, camera collision, the
 * lightmap baker — hits these, built from the visible mesh; the wrecks' boxes are for movement
 * only. Positions are int16 steps about each mesh's centre, indices uint16 (or uint32), both
 * little-endian base64, so client and server decode identical arrays.
 */
import geometry from './wreckGeometry.gen.json' with { type: 'json' };
import type { WreckHeroId } from './types.ts';

interface EncodedRayMesh {
  triangles: number;
  vertices: number;
  origin: number[];
  step: number;
  indexBytes: number;
  positions: string;
  indices: string;
}

export interface RayMesh {
  /** Prop-local (x, y, z) per vertex: the frame the hero model is drawn in. */
  positions: Float32Array;
  indices: Uint32Array;
}

export const WRECK_RAY_MESH_HASH: string = geometry.hash;
const ENCODED = geometry.models as Partial<Record<WreckHeroId, EncodedRayMesh>>;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64_VALUE[B64.charCodeAt(i)] = i;

/** Standard base64 → bytes (no `atob`: shared runs without DOM types on the server too). */
function bytes(b64: string): Uint8Array {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < b64.length; i += 4) {
    const n =
      (B64_VALUE[b64.charCodeAt(i)]! << 18) |
      (B64_VALUE[b64.charCodeAt(i + 1)]! << 12) |
      (B64_VALUE[b64.charCodeAt(i + 2)]! << 6) |
      B64_VALUE[b64.charCodeAt(i + 3)]!;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

const cache = new Map<WreckHeroId, RayMesh | null>();

/** The decoded ray mesh of a wreck hero, or null if it has none (it then keeps box rays). */
export function wreckRayMesh(id: WreckHeroId): RayMesh | null {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const m = ENCODED[id];
  let mesh: RayMesh | null = null;
  if (m) {
    const p = bytes(m.positions);
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const positions = new Float32Array(m.vertices * 3);
    for (let i = 0; i < positions.length; i++)
      positions[i] = m.origin[i % 3]! + view.getInt16(i * 2, true) * m.step;
    const q = bytes(m.indices);
    const iv = new DataView(q.buffer, q.byteOffset, q.byteLength);
    const indices = new Uint32Array(m.triangles * 3);
    for (let i = 0; i < indices.length; i++)
      indices[i] = m.indexBytes === 4 ? iv.getUint32(i * 4, true) : iv.getUint16(i * 2, true);
    mesh = { positions, indices };
  }
  cache.set(id, mesh);
  return mesh;
}

/** A ray mesh placed like its hero: the anchor box's centre and rotation (MapBox.hero). */
export function placeRayMesh(
  mesh: RayMesh,
  at: { x: number; y: number; z: number },
  rot: (v: { x: number; y: number; z: number }) => { x: number; y: number; z: number },
): Float32Array {
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < out.length; i += 3) {
    const r = rot({ x: mesh.positions[i]!, y: mesh.positions[i + 1]!, z: mesh.positions[i + 2]! });
    out[i] = at.x + r.x;
    out[i + 1] = at.y + r.y;
    out[i + 2] = at.z + r.z;
  }
  return out;
}
