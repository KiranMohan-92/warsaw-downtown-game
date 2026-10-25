import type * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * A glTF loader that reads meshopt-packed models (`tools/assets/meshopt_pack.mjs`,
 * EXT_meshopt_compression): every model in `public/models` is packed, so load them through this.
 * The decoder is ~20 KiB of inline WASM (no extra download) and decodes on the main thread before
 * the model is handed over — all before warm-up.
 */
export function gltfLoader(manager?: THREE.LoadingManager): GLTFLoader {
  return new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
}
