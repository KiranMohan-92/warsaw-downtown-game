import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Depth pre-pass for the static opaque world: draw its depth first with a colour-less material,
 * then shade. Each visible pixel of the world then runs its (heavy) lit fragment shader once
 * instead of once per overlapping surface: the Market's walls, stalls, crates and facades
 * overlap a lot, and three sorts opaque draws by material, not depth. Measured on Intel UHD
 * (Market, Low, 1600×900, GPU timer queries): 4–7.5 ms saved of a ~23 ms frame, after paying
 * for the extra depth draws.
 *
 * Only geometry whose depth the pre-pass reproduces exactly is drawn in it (`prepassEligible`):
 * static, opaque, no alpha test or discard, no vertex displacement. Everything else (foliage,
 * trees, soldiers, effects, anything added later) is drawn as before and still benefits from
 * the world's depth. The pre-pass is pushed back by a polygon offset, so the shaded pass of the
 * same surface always passes `LessEqual` even if its program rounds the position differently;
 * a surface that sits within that offset behind another only shades again (never a hole).
 */
export const PREPASS_LAYER = 30;

/**
 * Mesh groups (first segment of the nearest name, as the perf probes group them) drawn in the
 * pre-pass: the map's merged buckets and the facades, the big occluders with the heaviest
 * shaders (interior-mapped windows, weathering, ground detail). They keep three's standard vertex
 * transform. Props, heroes and set dressing measured cheaper without it (many triangles, little
 * screen area hidden behind them: their extra depth draws cost more than they cull); foliage and
 * trees displace vertices and discard; soldiers are skinned. An allowlist, so a new kind of mesh
 * is never pre-passed by accident.
 */
export const PREPASS_GROUPS: ReadonlySet<string> = new Set(['map', 'facade']);

/** The group of an object: first `:` segment of its own name, else of the nearest named parent. */
export function prepassGroup(object: THREE.Object3D): string {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    if (o.name) return o.name.split(':')[0]!;
  }
  return '';
}

function materialEligible(m: THREE.Material): boolean {
  if (!(
    m instanceof THREE.MeshStandardMaterial ||
    m instanceof THREE.MeshLambertMaterial ||
    m instanceof THREE.MeshPhongMaterial ||
    m instanceof THREE.MeshBasicMaterial
  )) {
    return false;
  }
  if (!m.visible || m.transparent || m.alphaTest > 0 || m.alphaHash || m.alphaToCoverage)
    return false;
  if (!m.colorWrite || !m.depthWrite || !m.depthTest) return false;
  if (m.depthFunc !== THREE.LessEqualDepth || m.side === THREE.BackSide || m.wireframe)
    return false;
  // Pushed back further than the pre-pass offset: the shaded draw would fail the depth test.
  if (m.polygonOffset && (m.polygonOffsetFactor > 0 || m.polygonOffsetUnits > 0)) return false;
  if ('displacementMap' in m && m.displacementMap) return false;
  return true;
}

/** True when `object` can be drawn in the depth pre-pass (see the module comment). */
export function prepassEligible(
  object: THREE.Object3D,
  groups: ReadonlySet<string> = PREPASS_GROUPS,
): boolean {
  if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return false;
  if (!groups.has(prepassGroup(object))) return false;
  const geometry = object.geometry as THREE.BufferGeometry;
  if (Object.keys(geometry.morphAttributes).length > 0) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  // Multi-material meshes are pre-passed whole (one override draw), so every group must qualify.
  return materials.length > 0 && materials.every(materialEligible);
}

export class DepthPrepass {
  readonly material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  /** Objects tagged by the last `refresh`. */
  count = 0;
  enabled = true;

  /** (Re)tag eligible meshes with the pre-pass layer. Call after the world is built/changes. */
  refresh(scene: THREE.Object3D, groups: ReadonlySet<string> = PREPASS_GROUPS): number {
    let n = 0;
    scene.traverse((o) => {
      if (prepassEligible(o, groups)) {
        o.layers.enable(PREPASS_LAYER);
        n++;
      } else {
        o.layers.disable(PREPASS_LAYER);
      }
    });
    this.count = n;
    return n;
  }

  /** Low path: draw the pre-pass into the current target (already cleared). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled || this.count === 0) return;
    const mask = camera.layers.mask;
    const override = scene.overrideMaterial;
    const background = scene.background;
    const autoUpdate = renderer.shadowMap.autoUpdate;
    camera.layers.set(PREPASS_LAYER);
    scene.overrideMaterial = this.material;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false; // the shaded pass right after updates the shadows
    try {
      renderer.render(scene, camera);
    } finally {
      camera.layers.mask = mask;
      scene.overrideMaterial = override;
      scene.background = background;
      renderer.shadowMap.autoUpdate = autoUpdate;
    }
  }

  /** Compile the pre-pass programs for the current target (warm-up): every tagged mesh, unculled. */
  warm(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const culled: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.frustumCulled && o.layers.isEnabled(PREPASS_LAYER)) {
        culled.push(o);
        o.frustumCulled = false;
      }
    });
    try {
      this.render(renderer, scene, camera);
    } finally {
      for (const o of culled) o.frustumCulled = true;
    }
  }

  /**
   * Composer path (Medium+): a pass that clears the input buffer (as the world's RenderPass
   * did) and draws the pre-pass into it; the world RenderPass after it must not clear.
   */
  pass(scene: THREE.Scene, camera: THREE.Camera): Pass {
    return new PrepassPass(this, scene, camera);
  }
}

class PrepassPass extends Pass {
  constructor(
    private readonly prepass: DepthPrepass,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    super('DepthPrepass', scene, camera);
    this.needsSwap = false;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
  ): void {
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.clear();
    this.prepass.render(renderer, this.scene, this.camera);
  }
}
