import * as THREE from 'three';
import {
  BloomEffect,
  BrightnessContrastEffect,
  ClearPass,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import type { N8AOPostPass } from 'n8ao';
import { ShadowPreservingAOPass } from './shadowPreservingAO.ts';
import { CasEffect, casStrength } from './sharpen.ts';
import { LowFrame } from './lowFrame.ts';
import { DepthPrepass } from './depthPrepass.ts';
import { GRADE } from './grade.ts';

export type ResolvedQuality = 'low' | 'medium' | 'high' | 'ultra';

/**
 * Internal resolution relative to what the game would render at 100 % (Game.resize sets the
 * pixel ratio to min(devicePixelRatio, 1) × resolution scale).
 */
export function internalScale(pixelRatio: number, devicePixelRatio: number): number {
  return pixelRatio / Math.min(devicePixelRatio || 1, 1);
}

/**
 * Frame pipeline. Exposure is baked into light/sky intensities by the weather system, so
 * every quality path matches.
 * Low: direct render with renderer tone mapping (cheapest, integrated GPUs).
 * Medium+: HDR composer → [AO on the world only] → viewmodel on top → CAS sharpen + bloom +
 * AgX tone map + vignette (one pass) → SMAA. The viewmodel is drawn after AO (no AO halos on the
 * gun) but before bloom (muzzle flash glows). CAS strength follows the internal resolution
 * (sharpen.ts): zero at 100 %, so it costs nothing until dynamic resolution drops.
 */
/**
 * Resize one composer's buffers and passes (drawing-buffer pixels) without touching the renderer.
 * `EffectComposer.setSize` also calls `renderer.setSize`, which would shrink the shared canvas
 * (and its CSS) when a cached chain is parked or warmed at a tiny size.
 */
function resizeTargets(composer: EffectComposer, w: number, h: number): void {
  composer.inputBuffer.setSize(w, h);
  composer.outputBuffer.setSize(w, h);
  (
    composer as unknown as { depthRenderTarget: THREE.WebGLRenderTarget | null }
  ).depthRenderTarget?.setSize(w, h);
  for (const pass of composer.passes) pass.setSize(w, h);
}

/** One tier's post chain (Medium, High, Ultra). */
interface TierChain {
  composer: EffectComposer;
  ao: N8AOPostPass | null;
  bloom: BloomEffect;
  cas: CasEffect;
}

export class PostPipeline {
  /**
   * One chain per tier, built once and never disposed while the game runs: a tier change used
   * to dispose the composer and build a new one, recompiling every post shader (N8AO, bloom,
   * SMAA, the effect pass) mid-game: 0.5-1 s frames whenever Auto moved a tier. Inactive chains
   * shrink their render targets to 1x1 (resizeTargets, never the renderer) (their programs stay compiled; memory stays small).
   */
  private readonly chains = new Map<ResolvedQuality, TierChain>();
  private active: TierChain | null = null;
  private bloomIntensity = 0.35;
  /** Depth pre-pass of the static world, on every tier (depthPrepass.ts). */
  readonly prepass = new DepthPrepass();
  /** Low's MSAA frame target + present pass (copy, or CAS below 100 %): lowFrame.ts. */
  private readonly low = new LowFrame();
  quality: ResolvedQuality = 'high';

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly vmScene: THREE.Scene,
    private readonly vmCamera: THREE.PerspectiveCamera,
  ) {}

  private get composer(): EffectComposer | null {
    return this.active?.composer ?? null;
  }
  private get bloom(): BloomEffect | null {
    return this.active?.bloom ?? null;
  }
  private get cas(): CasEffect | null {
    return this.active?.cas ?? null;
  }

  setQuality(q: ResolvedQuality): void {
    this.quality = q;
    if (this.active) resizeTargets(this.active.composer, 1, 1);
    this.active = null;
    // Leaving Low frees its MSAA target (lowFrame.ts `park`); re-entry re-creates it in the first
    // Low frame. Auto crosses Low↔Medium rarely (3 s at the resolution floor down; ≥ 60 s of
    // headroom up), and the re-allocation was lost in the tier switch's own noise: Intel UHD,
    // 1920×1080, Low→Medium→Low ×2 with and without parking, the first Low frames took 15–65 ms
    // either way (GPU 34.6–36.0 vs 33.5–35.7 ms), the switch call 1.5–2.3 vs 1.5–4.3 ms CPU.
    if (q !== 'low') this.low.park();
    if (q === 'low') {
      this.renderer.toneMapping = THREE.AgXToneMapping;
      this.setSize(); // Low's sharpen strength
      return;
    }
    // Tone mapping moves into the post chain.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.active = this.chain(q);
    this.active.bloom.intensity = this.bloomIntensity;
    this.setSize();
  }

  /**
   * Build (once) and draw every tier's chain, so all post programs compile during warm-up and a
   * later tier change only selects a chain. Restores the active tier.
   */
  warmTiers(tiers: readonly ResolvedQuality[] = ['medium', 'high', 'ultra']): void {
    const keep = this.active;
    for (const q of tiers) {
      if (q === 'low') continue;
      const c = this.chain(q);
      resizeTargets(c.composer, 64, 36);
      c.composer.render(0);
      if (c !== keep) resizeTargets(c.composer, 1, 1);
    }
    this.active = keep;
    this.setSize();
  }

  /** Compile the Low path's sharpen program (warm-up, while rendering to the canvas). */
  warmLowPresent(): void {
    this.low.warm(this.renderer);
  }

  /** Low's frame target: warm-up compiles Low programs with it bound (exactly what play draws). */
  get lowTarget(): THREE.WebGLRenderTarget {
    return this.low.target;
  }

  /** Re-tag the world's pre-pass meshes after it changed (assets loaded, tier change). */
  refreshWorld(): void {
    this.prepass.refresh(this.scene);
  }

  /** Free every chain (the game is going away). */
  dispose(): void {
    this.low.dispose();
    for (const c of this.chains.values()) c.composer.dispose();
    this.chains.clear();
    this.active = null;
  }

  /** Chains built so far (tests). */
  get builtTiers(): ResolvedQuality[] {
    return [...this.chains.keys()];
  }

  private chain(q: ResolvedQuality): TierChain {
    const hit = this.chains.get(q);
    if (hit) return hit;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(this.prepass.pass(this.scene, this.camera));
    const world = new RenderPass(this.scene, this.camera);
    world.clear = false; // the pre-pass cleared the buffer
    composer.addPass(world);
    let ao: N8AOPostPass | null = null;
    if (q === 'high' || q === 'ultra') {
      ao = new ShadowPreservingAOPass(this.scene, this.camera, size.x, size.y);
      ao.configuration.aoRadius = 1.6;
      ao.configuration.distanceFalloff = 0.6;
      ao.configuration.intensity = 2.2;
      ao.configuration.halfRes = q === 'high';
      ao.configuration.gammaCorrection = false;
      ao.setQualityMode(q === 'ultra' ? 'High' : 'Medium');
      composer.addPass(ao);
    }
    composer.addPass(new ClearPass(false, true, false));
    const vm = new RenderPass(this.vmScene, this.vmCamera);
    vm.clear = false;
    composer.addPass(vm);
    const bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.2,
      intensity: this.bloomIntensity,
      radius: 0.7,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    const vignette = new VignetteEffect({
      offset: GRADE.vignetteOffset,
      darkness: GRADE.vignetteDarkness,
    });
    // AgX is faithful but flat: a "punchy" grade (a little saturation and contrast) after it,
    // in the same pass (free), for the crisp midday look of modern shooters. Low applies the same
    // grade in its present pass (grade.ts).
    const grade = [
      new HueSaturationEffect({ saturation: GRADE.saturation }),
      new BrightnessContrastEffect({ contrast: GRADE.contrast }),
    ];
    // CAS reads its neighbours from this pass's input (pre-bloom HDR) and runs first in it.
    const cas = new CasEffect();
    composer.addPass(new EffectPass(this.camera, cas, bloom, tone, ...grade, vignette));
    composer.addPass(
      new EffectPass(
        this.camera,
        new SMAAEffect({ preset: q === 'ultra' ? SMAAPreset.ULTRA : SMAAPreset.HIGH }),
      ),
    );
    const c: TierChain = { composer, ao, bloom, cas };
    this.chains.set(q, c);
    return c;
  }

  setBloom(v: number): void {
    this.bloomIntensity = v;
    if (this.bloom) this.bloom.intensity = v;
  }

  setSize(): void {
    this.low.strength = this.quality === 'low' ? casStrength(this.internalScale()) : 0;
    if (!this.composer) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
    if (this.cas) this.cas.strength = casStrength(this.internalScale());
  }

  private internalScale(): number {
    return internalScale(this.renderer.getPixelRatio(), window.devicePixelRatio);
  }

  /** Current CAS strength (0 on Low or at full resolution); for tests and the perf overlay. */
  get sharpen(): number {
    return this.cas?.strength ?? this.low.strength;
  }

  render(dt: number): void {
    // Depth, shaded world and AO's two transparency masks all draw the same transforms.
    // Update animated descendants once, then share those matrices across the frame passes.
    // Camera/viewmodel updates remain owned by their renderers. A manually managed scene
    // stays manually managed; restore the flag even if a pass throws.
    const autoUpdate = this.scene.matrixWorldAutoUpdate;
    if (autoUpdate) this.scene.updateMatrixWorld();
    this.scene.matrixWorldAutoUpdate = false;
    try {
      if (this.composer) {
        this.composer.render(dt);
        return;
      }
      const r = this.renderer;
      this.low.begin(r);
      this.low.drawWithoutResolve(r, () => {
        this.prepass.render(r, this.scene, this.camera);
        r.render(this.scene, this.camera);
      });
      r.clearDepth();
      r.render(this.vmScene, this.vmCamera); // the frame's one resolve
      this.low.present(r);
    } finally {
      this.scene.matrixWorldAutoUpdate = autoUpdate;
    }
  }
}
