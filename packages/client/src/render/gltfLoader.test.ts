import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { gltfLoader } from './gltfLoader.ts';

const MODELS = fileURLToPath(new URL('../../public/models/', import.meta.url));
const models = (d: string): string[] =>
  readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? models(p) : /\.(glb|gltf)$/.test(e) ? [p] : [];
  });

function gltfJson(file: string): { extensionsUsed?: string[] } {
  const raw = readFileSync(file);
  if (file.endsWith('.gltf'))
    return JSON.parse(raw.toString('utf8')) as { extensionsUsed?: string[] };
  const len = raw.readUInt32LE(12);
  return JSON.parse(raw.subarray(20, 20 + len).toString('utf8')) as { extensionsUsed?: string[] };
}

describe('shipped models', () => {
  it('are all meshopt-packed (re-exported a model? run `pnpm assets:pack`)', () => {
    const files = models(MODELS);
    expect(files.length).toBeGreaterThan(30);
    const raw = files.filter(
      (f) => !(gltfJson(f).extensionsUsed ?? []).includes('EXT_meshopt_compression'),
    );
    expect(raw).toEqual([]);
  });

  // The real loader path for a packed .gltf + external .bin (fallback buffer, byte offsets, the
  // meshopt extension). Node has no fetch for file URLs, so the .bin goes in as a GLB BIN chunk:
  // same JSON, same buffer views. Textures are stripped (not what this checks).
  it.each(['crate/crate', 'guns/rifle', 'heroes/kiosk', 'arms/rifle'])(
    '%s.gltf parses through GLTFLoader with its accessor counts',
    async (id) => {
      const file = join(MODELS, `${id}.gltf`);
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        buffers: { uri?: string }[];
        accessors: { count: number; min?: number[]; max?: number[] }[];
        meshes: { primitives: { attributes: { POSITION: number }; indices: number }[] }[];
        materials?: object[];
        images?: unknown;
        textures?: unknown;
        samplers?: unknown;
      };
      const bin = readFileSync(join(MODELS, id.split('/')[0]!, json.buffers[0]!.uri!));
      delete json.buffers[0]!.uri;
      delete json.images;
      delete json.textures;
      delete json.samplers;
      json.materials = json.materials?.map(() => ({}));
      const glb = (text: string, data: Buffer): ArrayBuffer => {
        const js = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
        const bp = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
        const head = Buffer.alloc(20);
        head.writeUInt32LE(0x46546c67, 0);
        head.writeUInt32LE(2, 4);
        head.writeUInt32LE(28 + js.length + bp.length, 8);
        head.writeUInt32LE(js.length, 12);
        head.writeUInt32LE(0x4e4f534a, 16);
        const binHead = Buffer.alloc(8);
        binHead.writeUInt32LE(bp.length, 0);
        binHead.writeUInt32LE(0x004e4942, 4);
        const all = Buffer.concat([head, js, binHead, bp]);
        return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
      };
      const gltf = await gltfLoader().parseAsync(glb(JSON.stringify(json), bin), '');
      const prim = json.meshes[0]!.primitives[0]!;
      let mesh: THREE.Mesh | undefined;
      gltf.scene.traverse((o) => {
        if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
      });
      const pos = mesh!.geometry.getAttribute('position');
      expect(pos.count).toBe(json.accessors[prim.attributes.POSITION]!.count);
      expect(mesh!.geometry.getIndex()!.count).toBe(json.accessors[prim.indices]!.count);
      // Decoded data must be the model, not garbage that happens to be finite: every position lies
      // inside the accessor's recorded bounds (a dropped filter or wrong stride fails this).
      const { min, max } = json.accessors[prim.attributes.POSITION]!;
      for (let i = 0; i < pos.count; i++) {
        for (let k = 0; k < 3; k++) {
          const v = pos.getComponent(i, k);
          expect(v).toBeGreaterThanOrEqual(min![k]! - 1e-4);
          expect(v).toBeLessThanOrEqual(max![k]! + 1e-4);
        }
      }
    },
  );
});
