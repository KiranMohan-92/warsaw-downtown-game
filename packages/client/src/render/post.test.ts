import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostPipeline, internalScale } from './post.ts';
import { CasEffect, casStrength } from './sharpen.ts';

describe('internal resolution (drives CAS)', () => {
  it('is the pixel ratio relative to the 100 % ratio, min(devicePixelRatio, 1)', () => {
    expect(internalScale(1, 1)).toBe(1);
    expect(internalScale(0.65, 1)).toBeCloseTo(0.65);
    // HiDPI: Game.resize caps the ratio at 1 before scaling, so 0.6 is still 60 %.
    expect(internalScale(0.6, 2)).toBeCloseTo(0.6);
    // A zoomed-out page (devicePixelRatio 0.8): 100 % renders at 0.8.
    expect(internalScale(0.8, 0.8)).toBeCloseTo(1);
    expect(internalScale(0.4, 0.8)).toBeCloseTo(0.5);
    expect(internalScale(0.5, 0)).toBeCloseTo(0.5); // missing devicePixelRatio → 1
  });
});

describe('PostPipeline CAS strength', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A pipeline with a stub renderer and the Medium+ chain's composer + CAS stood in. */
  function pipeline(pixelRatio: number, dpr: number) {
    vi.stubGlobal('window', { devicePixelRatio: dpr });
    const renderer = {
      getPixelRatio: () => pixelRatio,
      getSize: (v: THREE.Vector2) => v.set(1920, 1080),
    };
    const pp = new PostPipeline(
      renderer as unknown as THREE.WebGLRenderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );
    const composerSetSize = vi.fn();
    Object.assign(pp as unknown as Record<string, unknown>, {
      active: { composer: { setSize: composerSetSize }, cas: new CasEffect(), bloom: {}, ao: null },
    });
    return { pp, composerSetSize };
  }

  it('follows the internal resolution on every setSize', () => {
    for (const [ratio, dpr] of [
      [1, 1],
      [0.65, 1],
      [0.5, 1],
      [0.6, 2],
      [0.4, 0.8],
    ] as const) {
      const { pp, composerSetSize } = pipeline(ratio, dpr);
      pp.setSize();
      expect(composerSetSize).toHaveBeenCalledWith(1920, 1080);
      expect(pp.sharpen).toBeCloseTo(casStrength(internalScale(ratio, dpr)), 12);
    }
  });

  it('Low sharpens too (its own present pass), following the internal resolution', () => {
    for (const ratio of [1, 0.85, 0.65, 0.5]) {
      vi.stubGlobal('window', { devicePixelRatio: 1 });
      const low = new PostPipeline(
        { getPixelRatio: () => ratio, toneMapping: 0 } as unknown as THREE.WebGLRenderer,
        new THREE.Scene(),
        new THREE.PerspectiveCamera(),
        new THREE.Scene(),
        new THREE.PerspectiveCamera(),
      );
      low.setQuality('low');
      expect(low.sharpen).toBeCloseTo(casStrength(ratio), 12);
    }
  });

  it('Low draws pre-pass + world unresolved into its MSAA target, the viewmodel last (one resolve), then presents', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const scene = new THREE.Scene();
    const vmScene = new THREE.Scene();
    const log: string[] = [];
    const renderer = {
      getPixelRatio: () => 0.7,
      toneMapping: 0,
      shadowMap: { autoUpdate: true, render: vi.fn() },
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(1120, 630),
      setRenderTarget: vi.fn((t: THREE.WebGLRenderTarget | null) =>
        log.push(t ? `bind ${t.samples}` : 'bind canvas'),
      ),
      clear: () => log.push('clear'),
      clearDepth: () => log.push('clearDepth'),
      render: vi.fn((s: THREE.Scene) => {
        const t = pp.lowTarget;
        const what =
          s === scene
            ? s.overrideMaterial
              ? 'prepass'
              : 'world'
            : s === vmScene
              ? 'vm'
              : 'present';
        log.push(`${what}${what === 'present' ? '' : ` samples ${t.samples}`}`);
      }),
    };
    const pp = new PostPipeline(
      renderer as unknown as THREE.WebGLRenderer,
      scene,
      new THREE.PerspectiveCamera(),
      vmScene,
      new THREE.PerspectiveCamera(),
    );
    const wall = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    wall.name = 'map:wall';
    scene.add(wall);
    pp.refreshWorld();
    pp.setQuality('low');
    const update = vi.spyOn(scene, 'updateMatrixWorld');
    pp.render(0);
    expect(log).toEqual([
      'bind 4',
      'clear',
      'prepass samples 0',
      'world samples 0',
      'clearDepth',
      'vm samples 4',
      'bind canvas',
      'present',
    ]);
    expect(pp.lowTarget.width).toBe(1120);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
  });

  it('frees Low’s MSAA target when leaving Low, and restores its size on the next Low frame', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const renderer = {
      getPixelRatio: () => 1,
      getSize: (v: THREE.Vector2) => v.set(1920, 1080),
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(1920, 1080),
      toneMapping: 0,
      shadowMap: { autoUpdate: true, render: vi.fn() },
      setRenderTarget: vi.fn(),
      clear: vi.fn(),
      clearDepth: vi.fn(),
      render: vi.fn(),
    };
    const pp = new PostPipeline(
      renderer as unknown as THREE.WebGLRenderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );
    const internals = pp as unknown as { chain: (q: string) => unknown };
    internals.chain = () => ({
      composer: {
        setSize: vi.fn(),
        render: vi.fn(),
        inputBuffer: { setSize: vi.fn() },
        outputBuffer: { setSize: vi.fn() },
        depthRenderTarget: null,
        passes: [],
      },
      cas: new CasEffect(),
      bloom: { intensity: 0 },
      ao: null,
    });
    pp.setQuality('low');
    pp.render(0);
    const target = pp.lowTarget;
    const dispose = vi.spyOn(target, 'dispose');
    expect([target.width, target.height]).toEqual([1920, 1080]);
    pp.setQuality('medium');
    expect([target.width, target.height]).toEqual([1, 1]);
    expect(dispose).toHaveBeenCalled(); // three frees the GL buffers on a size change
    pp.setQuality('low');
    pp.render(0);
    expect([target.width, target.height]).toEqual([1920, 1080]);
  });

  it('is zero at full resolution and when no tier sharpens', () => {
    const full = pipeline(1, 1);
    full.pp.setSize();
    expect(full.pp.sharpen).toBe(0);
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const low = new PostPipeline(
      { getPixelRatio: () => 0.5 } as unknown as THREE.WebGLRenderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );
    low.setSize();
    expect(low.sharpen).toBe(0);
  });
});

describe('PostPipeline tier chains', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('switching tiers selects cached chains: nothing is disposed or rebuilt mid-game', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const renderer = {
      getPixelRatio: () => 1,
      getSize: (v: THREE.Vector2) => v.set(1920, 1080),
      toneMapping: THREE.NoToneMapping,
    };
    const pp = new PostPipeline(
      renderer as unknown as THREE.WebGLRenderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );
    // Stand-in chains (a real EffectComposer needs a WebGL context); `chain` memoises by tier.
    const built: Record<
      string,
      {
        composer: {
          setSize: ReturnType<typeof vi.fn>;
          dispose: ReturnType<typeof vi.fn>;
          inputBuffer: { setSize: ReturnType<typeof vi.fn> };
          passes: { setSize: ReturnType<typeof vi.fn> }[];
        };
      }
    > = {};
    const internals = pp as unknown as {
      chains: Map<string, unknown>;
      chain: (q: string) => unknown;
    };
    internals.chain = (q: string) => {
      const hit = internals.chains.get(q);
      if (hit) return hit;
      const c = {
        composer: {
          setSize: vi.fn(),
          dispose: vi.fn(),
          render: vi.fn(),
          inputBuffer: { setSize: vi.fn() },
          outputBuffer: { setSize: vi.fn() },
          depthRenderTarget: null,
          passes: [{ setSize: vi.fn() }],
        },
        cas: new CasEffect(),
        bloom: { intensity: 0 },
        ao: null,
      };
      built[q] = c;
      internals.chains.set(q, c);
      return c;
    };
    for (const q of ['high', 'medium', 'high', 'low', 'medium', 'high'] as const) pp.setQuality(q);
    expect(Object.keys(built).sort()).toEqual(['high', 'medium']); // each built once
    for (const c of Object.values(built)) expect(c.composer.dispose).not.toHaveBeenCalled();
    // Leaving a tier parks its own targets at 1×1, never through composer.setSize (which also
    // resizes the shared renderer + canvas); the active chain gets the full size.
    expect(built.medium!.composer.inputBuffer.setSize).toHaveBeenCalledWith(1, 1);
    expect(built.medium!.composer.passes[0]!.setSize).toHaveBeenCalledWith(1, 1);
    for (const c of Object.values(built))
      for (const call of c.composer.setSize.mock.calls) expect(call).toEqual([1920, 1080]);
    expect(built.high!.composer.setSize).toHaveBeenLastCalledWith(1920, 1080);
    pp.dispose();
    for (const c of Object.values(built)) expect(c.composer.dispose).toHaveBeenCalled();
  });
});

describe('world transforms shared by frame passes', () => {
  afterEach(() => vi.restoreAllMocks());
  function setup(draw: (scene: THREE.Scene) => void) {
    const scene = new THREE.Scene();
    const parent = new THREE.Group();
    const actor = new THREE.Object3D();
    parent.position.set(10, 0, 0);
    parent.add(actor);
    scene.add(parent);
    const vmScene = new THREE.Scene();
    const pipeline = new PostPipeline(
      {} as THREE.WebGLRenderer,
      scene,
      new THREE.PerspectiveCamera(),
      vmScene,
      new THREE.PerspectiveCamera(),
    );
    // Match the real renderer's scene-update contract for depth, world and both AO masks.
    Object.assign(pipeline, {
      active: {
        composer: {
          render: () => {
            for (let pass = 0; pass < 4; pass++) {
              if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
              draw(scene);
            }
          },
        },
      },
    });
    return { pipeline, scene, parent, actor, vmScene };
  }

  it('updates moving descendants once per frame, with identical transforms in all four passes', () => {
    const positions: number[] = [];
    const { pipeline, scene, parent, actor, vmScene } = setup(() => {
      positions.push(actor.matrixWorld.elements[12]);
    });
    const update = vi.spyOn(scene, 'updateMatrixWorld');
    actor.position.x = 2;
    pipeline.render(1 / 60);
    parent.position.x = 20;
    actor.position.x = 3;
    pipeline.render(1 / 60);
    expect(positions).toEqual([12, 12, 12, 12, 23, 23, 23, 23]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
    expect(vmScene.matrixWorldAutoUpdate).toBe(true);
  });

  it('honors manually managed world transforms', () => {
    const { pipeline, scene } = setup(() => {});
    scene.matrixWorldAutoUpdate = false;
    const update = vi.spyOn(scene, 'updateMatrixWorld');
    pipeline.render(1 / 60);
    expect(update).not.toHaveBeenCalled();
    expect(scene.matrixWorldAutoUpdate).toBe(false);
  });

  it('restores automatic updates if a render pass fails', () => {
    const { pipeline, scene } = setup(() => {
      expect(scene.matrixWorldAutoUpdate).toBe(false);
      throw new Error('failed pass');
    });
    expect(() => pipeline.render(1 / 60)).toThrow('failed pass');
    expect(scene.matrixWorldAutoUpdate).toBe(true);
  });
});
