import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { __testPavingSurfaceTexel, MapMaterials, scannedColor } from './materials.ts';
import { SURFACE_TILE_METRES, TEXTURED_SURFACES } from './surfaceTextures.ts';
import {
  loadPalaceColumnTextures,
  palaceColumnMaterial,
  resetPalaceColumnTextureCacheForTests,
} from './palaceColumnMaterial.ts';
import { addPalaceEntranceStone } from './palaceEntranceStone.ts';
import { stall, type MapDefinition } from '@wd/shared';
import { buildSetDressing } from './setDressing.ts';
import { setRenderBudget } from './renderBudget.ts';
import { palaceReliefMask } from './palaceReliefMask.ts';

// MapMaterials draws its level-design grid on a canvas: a minimal stand-in for node.
const fakeCanvas = {
  width: 0,
  height: 0,
  getContext: () => ({ fillStyle: '', fillRect: () => {} }),
};

function proceduralSample(
  mm: MapMaterials,
  u: number,
  v: number,
): { r: number; g: number; b: number } {
  return sampleTexture(mm.activeMaps('facade').albedo as THREE.DataTexture, u, v);
}

function surfaceSample(
  mm: MapMaterials,
  id: 'sidewalk' | 'paving',
  u: number,
  v: number,
): { r: number; g: number; b: number } {
  return sampleTexture(mm.activeMaps(id).albedo as THREE.DataTexture, u, v);
}

function sampleTexture(
  tex: THREE.DataTexture,
  u: number,
  v: number,
): { r: number; g: number; b: number } {
  const image = tex.image as { data: Uint8Array; width: number; height: number };
  const x = Math.floor((((u % 1) + 1) % 1) * image.width) % image.width;
  const y = Math.floor((((v % 1) + 1) % 1) * image.height) % image.height;
  const i = (y * image.width + x) * 4;
  return { r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]! };
}

const luma = ({ r, g, b }: { r: number; g: number; b: number }): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

type TextureData = { data: Uint8Array; width: number; height: number };
type StoneId = 'sidewalk' | 'paving';

const textureData = (tex: THREE.DataTexture): TextureData =>
  tex.image as { data: Uint8Array; width: number; height: number };

function textureFingerprint(tex: THREE.DataTexture, channels: readonly number[]): number {
  const { data } = textureData(tex);
  let hash = 2166136261;
  for (let i = 0; i < data.length; i += 4) {
    for (const channel of channels) hash = Math.imul(hash ^ data[i + channel]!, 16777619);
  }
  return hash >>> 0;
}

function fullImageMean(tex: THREE.DataTexture): { r: number; g: number; b: number } {
  const image = textureData(tex);
  const mean = { r: 0, g: 0, b: 0 };
  const pixels = image.width * image.height;
  for (let i = 0; i < image.data.length; i += 4) {
    mean.r += image.data[i]!;
    mean.g += image.data[i + 1]!;
    mean.b += image.data[i + 2]!;
  }
  mean.r /= pixels;
  mean.g /= pixels;
  mean.b /= pixels;
  return mean;
}

function channelSpread(tex: THREE.DataTexture, channel: number, stride = 17): number {
  const { data } = textureData(tex);
  let lo = 255;
  let hi = 0;
  for (let i = channel; i < data.length; i += 4 * stride) {
    const value = data[i]!;
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  return hi - lo;
}

function averageAxisDelta(
  tex: THREE.DataTexture,
  axis: 'u' | 'v',
  a: number,
  b: number,
  channels: readonly number[],
): number {
  const { data, width, height } = textureData(tex);
  let sum = 0;
  let n = 0;
  const size = axis === 'u' ? width : height;
  const first = ((a % size) + size) % size;
  const second = ((b % size) + size) % size;
  const count = axis === 'u' ? height : width;
  for (let i = 0; i < count; i++) {
    const ai = axis === 'u' ? (i * width + first) * 4 : (first * width + i) * 4;
    const bi = axis === 'u' ? (i * width + second) * 4 : (second * width + i) * 4;
    for (const channel of channels) {
      sum += Math.abs(data[ai + channel]! - data[bi + channel]!);
      n++;
    }
  }
  return sum / n;
}

function expectMapWrapsLikeInterior(
  tex: THREE.DataTexture,
  channels: readonly number[],
  hardCap: number,
): void {
  const { width, height } = textureData(tex);
  const axes = [
    { axis: 'u' as const, size: width },
    { axis: 'v' as const, size: height },
  ];
  for (const { axis, size } of axes) {
    const seam = averageAxisDelta(tex, axis, 0, size - 1, channels);
    const interior = averageAxisDelta(
      tex,
      axis,
      Math.floor(size * 0.48),
      Math.floor(size * 0.48) - 1,
      channels,
    );
    expect(seam).toBeLessThan(Math.max(hardCap, interior * 2.5 + 4));
  }
}

describe('procedural facade sandstone', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('keeps dressing timber on shared maps during a grid round trip', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    const base = mm.get('wood');
    const map: MapDefinition = {
      name: 'timber-settings',
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      boxes: stall({ x: 0, z: 0 }),
      spawns: [],
      dummies: [],
    };
    const group = buildSetDressing(map, mm);
    const timber = (group.children.find((c) => c.name.startsWith('dressing:wood')) as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(timber).not.toBe(base);
    expect(base.customProgramCacheKey()).not.toContain('stallStripLight');
    const albedo = base.map;
    const normal = base.normalMap;
    const rough = base.roughnessMap;
    expect(timber.map).toBe(albedo);
    expect(timber.normalMap).toBe(normal);
    expect(timber.roughnessMap).toBe(rough);
    setRenderBudget(group, 'low');
    expect(timber.normalMap).toBeNull();
    setRenderBudget(group, 'high');
    expect(timber.normalMap).toBe(normal);
    mm.setGrid(true);
    expect(timber.map).toBe(base.map);
    expect(timber.map).not.toBe(albedo);
    mm.setGrid(false);
    expect(timber.map).toBe(albedo);
    expect(timber.normalMap).toBe(normal);
    expect(timber.roughnessMap).toBe(rough);
  });

  it('grid mode disables entrance stone before and after shader compilation', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    mm.setGrid(true);
    const mat = mm.facadeShellVariant('entrance-grid-test', () => {});
    addPalaceEntranceStone(mat);
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
    const uniform = shader.uniforms.uEntranceStoneGrid!;
    expect(uniform.value).toBe(1);
    mm.setGrid(false);
    expect(uniform.value).toBe(0);
    mm.setGrid(true);
    expect(uniform.value).toBe(1);
  });

  it('retains offline column maps after settings and a round trip through grid mode', async () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    resetPalaceColumnTextureCacheForTests();
    const materials = new MapMaterials(8);
    const mat = palaceColumnMaterial(materials);
    const key = mat.customProgramCacheKey();
    const textures = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
    let n = 0;
    const loader = {
      loadAsync: () => Promise.resolve(textures[n++]! as THREE.Texture<HTMLImageElement>),
    } as unknown as THREE.TextureLoader;
    expect(await loadPalaceColumnTextures(undefined, undefined, { loader })).toBe(true);
    materials.setGrid(false);
    expect(mat.map).toBe(textures[0]);
    expect(mat.normalMap).toBe(textures[1]);
    expect(mat.roughnessMap).toBe(textures[2]);
    materials.setGrid(true);
    expect(mat.map).not.toBe(textures[0]);
    materials.setGrid(false);
    expect(mat.map).toBe(textures[0]);
    expect(mat.customProgramCacheKey()).toBe(key);
    expect(mat.userData.keepNormalOnLow).toBe(true);
    mat.dispose();
    resetPalaceColumnTextureCacheForTests();
  });

  it('reads as warm ashlar with real block variation instead of flat beige wallpaper', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    const face = [
      proceduralSample(mm, 0.12, 0.12),
      proceduralSample(mm, 0.42, 0.18),
      proceduralSample(mm, 0.82, 0.44),
      proceduralSample(mm, 0.18, 0.77),
      proceduralSample(mm, 0.88, 0.82),
    ];
    const tones = face.map(luma);
    expect(tones.reduce((a, b) => a + b, 0) / tones.length).toBeGreaterThan(185);
    expect(Math.max(...tones) - Math.min(...tones)).toBeGreaterThan(10);
    expect(Math.max(...tones) - Math.min(...tones)).toBeLessThan(58);
    expect(face.every((c) => c.r >= c.b && c.g >= c.b)).toBe(true);
    expect(luma(proceduralSample(mm, 0.12, 1 / 3))).toBeLessThan(
      luma(proceduralSample(mm, 0.12, 0.18)),
    );
  });

  it('cuts visible joints and edge chips into facade normal and roughness maps', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    const maps = mm.activeMaps('facade');
    const flatStone = sampleTexture(maps.normal as THREE.DataTexture, 0.16, 0.18);
    const chippedEdge = sampleTexture(maps.normal as THREE.DataTexture, 0.493, 0.18);
    const horizontalJoint = proceduralSample(mm, 0.16, 1 / 3);
    const blockFace = proceduralSample(mm, 0.16, 0.18);
    const jointRough = sampleTexture(maps.rough as THREE.DataTexture, 0.16, 1 / 3);
    const faceRough = sampleTexture(maps.rough as THREE.DataTexture, 0.16, 0.18);
    expect(luma(horizontalJoint)).toBeLessThan(luma(blockFace) - 18);
    expect(
      Math.abs(chippedEdge.r - flatStone.r) + Math.abs(chippedEdge.g - flatStone.g),
    ).toBeGreaterThan(14);
    expect(jointRough.g).toBeGreaterThan(faceRough.g + 8);
    expect(mm.get('facade').normalScale.x).toBeCloseTo(1);
    expect(mm.get('facade').customProgramCacheKey()).toBe('wet');
  });

  it('gives facade shell variants clean sandstone maps without painted windows', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    const shell = mm.facadeShellVariant('test', () => {});
    const facade = mm.get('facade');
    expect(shell.map).not.toBe(facade.map);
    expect(shell.normalMap).not.toBe(facade.normalMap);
    expect(shell.roughnessMap).not.toBe(facade.roughnessMap);
    expect(shell.color.equals(facade.color)).toBe(true);
    mm.setGrid(true);
    expect(shell.map).toBe(facade.map);
    mm.setGrid(false);
    expect(shell.map).not.toBe(facade.map);
  });

  it('packs relief masks in existing facade/shell maps without changing their PBR bytes', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    const materials = [mm.get('facade'), mm.facadeShellVariant('relief-mask-test', () => {})];
    // Baseline 333706f: full albedo/normal RGBA and roughness-G byte fingerprints.
    const fingerprints = [
      [2606282839, 758866014, 3911507231],
      [675902794, 1534605083, 4093089633],
    ];
    materials.forEach((mat, m) => {
      expect(mat.metalnessMap).toBeNull();
      expect(textureFingerprint(mat.map as THREE.DataTexture, [0, 1, 2, 3])).toBe(
        fingerprints[m]![0],
      );
      expect(textureFingerprint(mat.normalMap as THREE.DataTexture, [0, 1, 2, 3])).toBe(
        fingerprints[m]![1],
      );
      expect(textureFingerprint(mat.roughnessMap as THREE.DataTexture, [1])).toBe(
        fingerprints[m]![2],
      );
      const { data, width, height } = textureData(mat.roughnessMap as THREE.DataTexture);
      expect([width, height]).toEqual([512, 512]);
      expect(mat.roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
      let mismatches = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const masks = palaceReliefMask((x + 0.5) / width, (y + 0.5) / height, 1 / width);
          const i = (y * width + x) * 4;
          if (data[i] !== Math.round(masks[0] * 255)) mismatches++;
          if (data[i + 2] !== Math.round(masks[1] * 255)) mismatches++;
          if (data[i + 3] !== Math.round(masks[2] * 255)) mismatches++;
        }
      }
      expect(mismatches).toBe(0);
    });
    // Unrelated map channels retain the existing all-ones data contract.
    const { data } = textureData(mm.activeMaps('concrete').rough as THREE.DataTexture);
    for (let i = 0; i < data.length; i += 4 * 7919) {
      expect([data[i], data[i + 2], data[i + 3]]).toEqual([255, 255, 255]);
    }
  });
});

describe('MapMaterials with scanned textures', () => {
  let mm: MapMaterials;
  let preVariant: THREE.MeshStandardMaterial;
  let loaded: string[];
  // Captured inside beforeAll: mock call logs may be cleared between tests.
  let warnings: string[] = [];
  let errors = 0;
  let uploads = 0;

  beforeAll(async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const renderer = { initTexture: vi.fn() };
    vi.stubGlobal('console', { ...console, warn, error });
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    // One scan is "missing": that surface must fall back to procedural as a whole.
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation((url: string) => {
      if (url.includes('concrete_normal')) return Promise.reject(new Error('404'));
      const t = new THREE.Texture<HTMLImageElement>();
      t.name = url;
      return Promise.resolve(t);
    });
    mm = new MapMaterials(8);
    // A variant made before loading (the map is built before textures load) holds the
    // procedural maps by reference and must be updated too.
    preVariant = mm.variant('asphalt', 'flat0', (m) => (m.polygonOffset = true));
    loaded = await mm.loadTextures(renderer as unknown as THREE.WebGLRenderer, {
      base: '/',
      timeoutMs: 1000,
    });
    warnings = warn.mock.calls.map((c) => String(c[0]));
    errors = error.mock.calls.length;
    uploads = renderer.initTexture.mock.calls.length;
  }, 60_000);

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('swaps every loadable set and keeps the rest procedural, with a warning (not an error)', () => {
    expect(loaded.sort()).toEqual(TEXTURED_SURFACES.filter((s) => s !== 'concrete').sort());
    expect(mm.activeMaps('paving').normal).toBeInstanceOf(THREE.DataTexture);
    expect(mm.activeMaps('paving').albedo).toBeInstanceOf(THREE.DataTexture);
    expect(mm.activeMaps('sidewalk').albedo).toBeInstanceOf(THREE.DataTexture);
    expect(mm.activeMaps('concrete').albedo).toBeInstanceOf(THREE.DataTexture);
    expect(mm.activeMaps('facade').albedo).toBeInstanceOf(THREE.DataTexture);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'concrete'");
    expect(errors).toBe(0);
    // Uploaded before warm-up: three maps per loaded set.
    expect(uploads).toBe(3 * loaded.length);
  });

  it('points base materials at the scans with metre tiling and the right colour spaces', () => {
    const m = mm.get('asphalt');
    expect((m.map as THREE.Texture).name).toBe('/tex/asphalt_albedo.webp');
    expect(m.normalMap!.name).toBe('/tex/asphalt_normal.webp');
    expect(m.roughnessMap!.name).toBe('/tex/asphalt_rough.webp');
    expect(m.map!.repeat.x).toBeCloseTo(1 / SURFACE_TILE_METRES.asphalt);
    expect(m.normalMap!.repeat.y).toBeCloseTo(1 / SURFACE_TILE_METRES.asphalt);
    expect(m.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(m.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(m.map!.wrapS).toBe(THREE.RepeatWrapping);
    expect(m.color.equals(scannedColor('asphalt'))).toBe(true);
  });

  it('keeps the shader-relevant material state (no new programs)', () => {
    const m = mm.get('grass');
    expect(m.vertexColors).toBe(true);
    expect(m.customProgramCacheKey()).toBe('wet|market-neon-v1');
    expect(m.map && m.normalMap && m.roughnessMap).toBeTruthy();
  });

  it('updates variants cloned before the load and makes new ones from the scans', () => {
    expect(preVariant.map).toBe(mm.get('asphalt').map);
    expect(preVariant.normalMap).toBe(mm.get('asphalt').normalMap);
    expect(preVariant.roughnessMap).toBe(mm.get('asphalt').roughnessMap);
    expect(preVariant.polygonOffset).toBe(true);
    const later = mm.variant('grass', 'double', (m) => (m.side = THREE.DoubleSide));
    expect(later.normalMap).toBe(mm.get('grass').normalMap);
    expect(later.color.equals(scannedColor('grass'))).toBe(true);
  });

  it('grid mode swaps whichever albedo is active and restores it', () => {
    mm.setGrid(true);
    const base = mm.get('asphalt');
    expect(base.map).not.toBe(mm.activeMaps('asphalt').albedo);
    expect(preVariant.map).toBe(base.map);
    expect(base.color.getHexString()).toBe('3d3f43');
    mm.setGrid(false);
    expect(base.map).toBe(mm.activeMaps('asphalt').albedo);
    expect(preVariant.map).toBe(mm.activeMaps('asphalt').albedo);
    expect(base.color.equals(scannedColor('asphalt'))).toBe(true);
  });

  it('keeps plaza paving and sidewalk on the procedural stone maps after scans load', () => {
    expect(TEXTURED_SURFACES).not.toContain('paving');
    expect(TEXTURED_SURFACES).not.toContain('sidewalk');
    expect(mm.scanned.has('paving')).toBe(false);
    expect(mm.scanned.has('sidewalk')).toBe(false);
    expect(mm.get('paving').map).toBe(mm.activeMaps('paving').albedo);
    expect(mm.get('sidewalk').normalMap).toBe(mm.activeMaps('sidewalk').normal);
    expect((mm.get('paving').map as THREE.Texture).repeat.x).toBeCloseTo(1 / 6);
    expect((mm.get('sidewalk').map as THREE.Texture).repeat.x).toBeCloseTo(1 / 3);
  });
});

describe('MapMaterials on the Low tier', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the 512 px copies of the 1024 px sets (Low costs no more than procedural)', async () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const urls: string[] = [];
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation((url: string) => {
      urls.push(url);
      const t = new THREE.Texture<HTMLImageElement>();
      t.name = url;
      return Promise.resolve(t);
    });
    const mm = new MapMaterials(8);
    const renderer = { initTexture: vi.fn() } as unknown as THREE.WebGLRenderer;
    await mm.loadTextures(renderer, { lowRes: true, base: '/', timeoutMs: 1000 });
    expect(urls).toHaveLength(3 * TEXTURED_SURFACES.length);
    expect(mm.get('asphalt').map!.name).toBe('/tex/asphalt_albedo_512.webp');
    expect(mm.get('plaster').normalMap!.name).toBe('/tex/plaster_normal_512.webp');
    // Sets that are 512 px already load as they are.
    expect(mm.get('metal').map!.name).toBe('/tex/metal_albedo.webp');
  });
});

describe('Market polish surfaces', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const texels = (mm: MapMaterials, id: 'wreck' | 'sandbag'): Uint8Array =>
    (mm.activeMaps(id).albedo.image as { data: Uint8Array }).data;

  it('keeps the paving sampler periodic and deterministic across memo interference', () => {
    const points = [
      ['paving', 0.115, 0.18],
      ['paving', 0.385, 0.18],
      ['paving', 0.68, 0.515],
      ['sidewalk', 0.314, 0.271],
      ['sidewalk', 0.72, 0.655],
    ] as const;
    const first = points.map(([id, u, v]) => __testPavingSurfaceTexel(id, u, v));
    expect(__testPavingSurfaceTexel('paving', 0.9985, 0.502)).toBeTruthy();
    expect(__testPavingSurfaceTexel('sidewalk', 0.041, 0.913)).toBeTruthy();
    expect(points.map(([id, u, v]) => __testPavingSurfaceTexel(id, u, v))).toEqual(first);

    const roughFaces = [
      __testPavingSurfaceTexel('paving', 0.115, 0.18).rough,
      __testPavingSurfaceTexel('paving', 0.385, 0.18).rough,
      __testPavingSurfaceTexel('paving', 0.68, 0.515).rough,
    ];
    expect(Math.max(...roughFaces) - Math.min(...roughFaces)).toBeGreaterThan(0.03);

    const seamLeft = __testPavingSurfaceTexel('paving', 0.0005, 0.502);
    const seamRight = __testPavingSurfaceTexel('paving', 0.9985, 0.502);
    expect(Math.abs(seamLeft.height - seamRight.height)).toBeLessThan(0.12);
    expect(Math.abs(seamLeft.rough - seamRight.rough)).toBeLessThan(0.08);
  });

  it('paving and sidewalk generate deterministic warm urban stone maps', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const a = new MapMaterials(8);
    const b = new MapMaterials(8);

    for (const id of ['paving', 'sidewalk'] as const satisfies readonly StoneId[]) {
      const am = a.activeMaps(id);
      const bm = b.activeMaps(id);
      for (const channel of ['albedo', 'normal', 'rough'] as const) {
        // Compare every byte without constructing a million-element matcher diff on success.
        const a = textureData(am[channel] as THREE.DataTexture).data;
        const b = textureData(bm[channel] as THREE.DataTexture).data;
        expect(Buffer.from(a).equals(Buffer.from(b)), `${id} ${channel}`).toBe(true);
      }
      const mean = fullImageMean(am.albedo as THREE.DataTexture);
      expect(mean.r).toBeGreaterThan(mean.b + 5);
      expect(mean.g).toBeGreaterThan(mean.b);
    }

    const samples = [
      surfaceSample(a, 'paving', 0.08, 0.13),
      surfaceSample(a, 'paving', 0.27, 0.22),
      surfaceSample(a, 'paving', 0.49, 0.44),
      surfaceSample(a, 'paving', 0.68, 0.58),
      surfaceSample(a, 'paving', 0.86, 0.81),
      surfaceSample(a, 'paving', 0.18, 0.92),
    ];
    const tones = samples.map(luma);
    expect(Math.max(...tones) - Math.min(...tones)).toBeGreaterThan(28);
    const joint = surfaceSample(a, 'paving', 0.5, 0.25);
    const face = surfaceSample(a, 'paving', 0.5, 1 / 3);
    expect(luma(joint)).toBeLessThan(luma(face) - 26);
  });

  it('keeps paving maps seam-safe while roughness and normals carry slab relief', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);

    for (const id of ['paving', 'sidewalk'] as const satisfies readonly StoneId[]) {
      const maps = mm.activeMaps(id);
      expect(textureData(maps.albedo as THREE.DataTexture).width).toBe(512);
      expectMapWrapsLikeInterior(maps.albedo as THREE.DataTexture, [0, 1, 2], 22);
      expectMapWrapsLikeInterior(maps.normal as THREE.DataTexture, [0, 1], 42);
      expectMapWrapsLikeInterior(maps.rough as THREE.DataTexture, [1], 18);
      expect(channelSpread(maps.rough as THREE.DataTexture, 1)).toBeGreaterThan(35);
      expect(channelSpread(maps.normal as THREE.DataTexture, 0)).toBeGreaterThan(35);
      expect(channelSpread(maps.normal as THREE.DataTexture, 1)).toBeGreaterThan(35);
    }
  });

  it('wreck metal is soot, rust and paint scraps, not one flat grey', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    const d = texels(mm, 'wreck');
    let rusty = 0;
    let sooty = 0;
    for (let i = 0; i < d.length; i += 4 * 37) {
      if (d[i]! > d[i + 2]! * 1.25) rusty++;
      if (d[i]! + d[i + 1]! + d[i + 2]! < 120) sooty++;
    }
    const n = d.length / (4 * 37);
    expect(rusty / n).toBeGreaterThan(0.05);
    expect(sooty / n).toBeGreaterThan(0.05);
    expect(mm.get('wreck').customProgramCacheKey()).toBe('wet|wear');
  });

  it('sandbags have dark gaps between pillowed bags; ground surfaces get the detail layer', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    const mm = new MapMaterials(8);
    const d = texels(mm, 'sandbag');
    // Lower half: the wall of courses a far sandbag box shows; upper half: plain burlap for the
    // near bags (no seams, no dark gaps).
    const half = d.length / 2;
    const darkShare = (from: number, to: number): number => {
      let dark = 0;
      let n = 0;
      for (let i = from; i < to; i += 4 * 13) {
        n++;
        if (d[i + 1]! < 70) dark++;
      }
      return dark / n;
    };
    expect(darkShare(0, half)).toBeGreaterThan(0.01);
    expect(darkShare(0, half)).toBeLessThan(0.35);
    expect(darkShare(half, d.length)).toBeLessThan(0.002);
    for (const id of ['sidewalk', 'paving', 'asphalt'] as const)
      expect(mm.get(id).customProgramCacheKey()).toBe('wet|ground-v3|courtyard-v2|market-neon-v1');
    const grass = mm.get('grass');
    expect(grass.customProgramCacheKey()).toBe('wet|market-neon-v1');
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    grass.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('mnIrradiance');
    expect(shader.fragmentShader).not.toContain('cbIrradiance');
    expect(shader.fragmentShader).toContain('abs( vWetPos.y - 0.020 ) < 0.12');
    expect(shader.fragmentShader).toContain('mnNormal.y > 0.75');
    expect(shader.uniforms.uMnMap).toBeDefined();
    expect(mm.get('concrete').customProgramCacheKey()).toBe('wet');
    expect(mm.get('container').normalScale.x).toBeGreaterThan(1.5);
  });
});
