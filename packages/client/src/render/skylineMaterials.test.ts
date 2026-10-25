import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MapMaterials, medianChannel, WET_FRAGMENT } from './materials.ts';
import {
  SATIN_GLASS_ROUGHNESS,
  skylineBackdropMaterial,
  skylineSatinMaterial,
} from './skylineMaterials.ts';
import { setSkylineWeather, skylineLights } from './skylineWindows.ts';
import { WEATHER_PRESETS } from './weather.ts';
import { setRenderBudget } from './renderBudget.ts';
import { buildMapMeshes, setBakedLighting } from './mapMesh.ts';
import {
  buildLightmapLayout,
  getMap,
  lightmapSceneHash,
  resolveMap,
  type MapDefinition,
} from '@wd/shared';
import { prepassEligible } from './depthPrepass.ts';
import { buildSkylineBackdrop } from './skylineBackdrop.ts';

let materials: MapMaterials;
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', fillRect: () => {} }),
    }),
  });
  materials = new MapMaterials(1);
});
afterAll(() => vi.unstubAllGlobals());

function shaderFor(material: THREE.MeshStandardMaterial): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('skyline glass and draw compatibility', () => {
  it('uses one texture-free skyline recipe through every weather and tier before drawing', () => {
    const material = skylineBackdropMaterial(materials);
    expect(skylineBackdropMaterial(materials)).toBe(material);
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
    const key = material.customProgramCacheKey();
    const version = material.version;
    const shader = shaderFor(material);
    for (const tier of ['low', 'medium', 'high', 'ultra', 'low'] as const) {
      setRenderBudget(scene, tier);
      for (const weather of ['golden', 'sunny', 'overcast', 'rain', 'dusk', 'neon'] as const) {
        setSkylineWeather(weather, WEATHER_PRESETS[weather].exposure);
        expect(material.customProgramCacheKey()).toBe(key);
        expect(material.version).toBe(version);
        expect(shaderFor(material).vertexShader).toBe(shader.vertexShader);
        expect(shaderFor(material).fragmentShader).toBe(shader.fragmentShader);
        expect(shader.uniforms.uSkylineOccupied).toBe(skylineLights.occupied);
        expect(shader.uniforms.uSkylineIntensity).toBe(skylineLights.intensity);
      }
    }
    expect(material.map).toBeNull();
    expect(material.normalMap).toBeNull();
    expect(material.roughnessMap).toBeNull();
    expect(shader.fragmentShader).toContain('fogColor, fogFactor');
    expect(shader.fragmentShader).toContain('#ifdef FOG_EXP2');
    expect(shader.fragmentShader).toContain('smoothstep( fogNear, fogFar, vFogDepth )');
    expect(shader.fragmentShader).toContain('if ( uWetness > 0.0 )');
    expect(shader.fragmentShader).toContain('#define WD_BUDGET_SHADOWS');
    expect(shader.fragmentShader.indexOf('roughnessFactor = skylineRoughness;')).toBeLessThan(
      shader.fragmentShader.indexOf('if ( uWetness > 0.0 )'),
    );
    setSkylineWeather('golden', WEATHER_PRESETS.golden.exposure);
  });
  it('shares the base glass shader through tier and grid switches while varying only uniforms', () => {
    const base = materials.get('glass');
    const satin = skylineSatinMaterial(materials);
    const scene = new THREE.Group();
    for (const material of [base, satin])
      scene.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
    const key = base.customProgramCacheKey();
    for (const tier of ['low', 'medium', 'high', 'ultra', 'low', 'high'] as const) {
      setRenderBudget(scene, tier);
      expect(satin.customProgramCacheKey()).toBe(key);
      expect(base.customProgramCacheKey()).toBe(key);
      expect(satin.map).toBe(base.map);
      expect(satin.normalMap).toBe(base.normalMap);
      expect(satin.roughnessMap).toBe(base.roughnessMap);
      expect(satin.fog).toBe(true);
      expect(satin.vertexColors).toBe(base.vertexColors);
      expect(satin.defines).toEqual(base.defines);
      expect(shaderFor(satin)).toEqual(shaderFor(base));
    }
    // Effective pane roughness = material roughness × the map's pane value: satin is broader.
    const pane = materials.typicalRoughness('glass');
    expect(satin.roughness * pane).toBeCloseTo(SATIN_GLASS_ROUGHNESS, 5);
    expect(satin.roughness * pane).toBeGreaterThan(base.roughness * pane * 2);
    expect(satin.roughnessMap).toBe(base.roughnessMap);
    expect(satin.metalness === base.metalness).toBe(false);
    // Reflection strength is the shared scene environment's (a per-material gain would be ignored).
    expect(satin.envMapIntensity).toBe(base.envMapIntensity);
    for (const grid of [true, false]) {
      materials.setGrid(grid);
      expect(satin.map).toBe(base.map);
      expect(satin.customProgramCacheKey()).toBe(base.customProgramCacheKey());
    }
    expect(skylineSatinMaterial(materials)).toBe(satin);
  });

  it('re-tunes the satin glass to the scanned roughness map that replaces the procedural one', () => {
    const own = new MapMaterials(1);
    const satin = skylineSatinMaterial(own);
    expect(satin.roughness * own.typicalRoughness('glass')).toBeCloseTo(SATIN_GLASS_ROUGHNESS, 5);
    // The shipped glass_rough.webp: two thirds of its texels are panes at 5-16/255, median 10.
    const texels = new Uint8Array(4 * 1000);
    for (let i = 0; i < 1000; i++) texels[4 * i + 1] = i < 670 ? 5 + (i % 12) : 68;
    const median = medianChannel(texels, 1) / 255;
    expect(median).toBeLessThan(0.06); // far below the procedural panes (0.12)
    own.noteActiveRoughness('glass', median);
    // Without re-tuning, the panes would read ~0.12 (3.2 x 0.039): still sharp glass.
    expect(satin.roughness * median).toBeCloseTo(SATIN_GLASS_ROUGHNESS, 5);
    expect(skylineSatinMaterial(own)).toBe(satin);
  });

  it('lets rain gloss the satin slab bands (mapped roughness above 1 is saturated first)', () => {
    const satin = skylineSatinMaterial(materials);
    // Slab bands carry 0.6 in the glass roughness map: the satin multiplier takes them past 1.
    expect(satin.roughness * 0.6).toBeGreaterThan(1);
    const saturate = WET_FRAGMENT.indexOf('roughnessFactor = min( roughnessFactor, 1.0 );');
    const film = WET_FRAGMENT.indexOf('roughnessFactor = mix( roughnessFactor, min(');
    expect(saturate).toBeGreaterThan(0);
    expect(saturate).toBeLessThan(film);
    // The film blend on a wall at full rain (wet 0.4): 1 → ~0.73 (unsaturated 1.9 → 1.27 → 1).
    const wall = (r: number): number => Math.min(1, r * 0.6 + Math.min(r, 0.32) * 0.4);
    expect(wall(Math.min(satin.roughness * 0.6, 1))).toBeLessThan(0.8);
  });

  it('batches all backdrop finishes with one unbaked non-casting material and no extra draws', () => {
    const world = resolveMap(getMap('defilad'), 'market');
    // All real backdrop prisms with a small baked foreground receiver: avoid building the
    // unrelated Palace relief/foliage in this CPU test, while still exercising bake exclusion.
    const map: MapDefinition = {
      name: 'skyline integration',
      bounds: world.bounds,
      prisms: world.prisms!.filter((p) => p.backdrop),
      boxes: [{ center: { x: 160, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, mat: 'concrete' }],
      spawns: [],
      dummies: [],
    };
    const layout = buildLightmapLayout(map);
    const skyline = buildSkylineBackdrop(map);
    const group = buildMapMeshes(map, materials, {
      bakes: [
        {
          map: 'tiny',
          size: 'full',
          mapName: map.name,
          layoutHash: layout.hash,
          sceneHash: lightmapSceneHash(map, layout, 16),
          atlas: {
            file: 'fixture-atlas.png',
            width: layout.atlas.width,
            height: layout.atlas.height,
          },
          ground: {
            file: 'fixture-ground.png',
            width: layout.ground.width,
            height: layout.ground.height,
          },
          bake: { samples: 8, reach: 16 },
        },
      ],
      loadLightmap: (_file, w, h) => Promise.resolve(new Uint8Array(w * h).fill(255)),
    });
    const backdrop: THREE.Mesh[] = [];
    group.traverse((object) => {
      if (object instanceof THREE.Mesh && object.name.includes('|backdrop'))
        backdrop.push(object as THREE.Mesh);
    });
    expect(backdrop).toHaveLength(1);
    expect(backdrop[0]).toBeInstanceOf(THREE.BatchedMesh);
    expect(backdrop[0]!.material).toBe(skylineBackdropMaterial(materials));
    const detail = backdrop[0]!.geometry.getAttribute('aSkyline');
    expect(detail.itemSize).toBe(4);
    expect(detail.count).toBe(backdrop[0]!.geometry.getAttribute('position').count);
    const surfaceKinds = new Set<number>();
    for (let i = 0; i < detail.count; i++) surfaceKinds.add(detail.getW(i));
    expect([...surfaceKinds].sort()).toEqual([0, 1, 2, 3, 4]);
    const colour = backdrop[0]!.geometry.getAttribute('color');
    const normal = backdrop[0]!.geometry.getAttribute('normal');
    for (let i = 0; i < detail.count; i++) {
      // Concrete roofs used white as a texture multiplier; the procedural material needs grey albedo.
      if (normal.getY(i) > 0.9) {
        expect(detail.getW(i)).toBe(0);
        expect(Math.max(colour.getX(i), colour.getY(i), colour.getZ(i))).toBeLessThan(0.8);
      }
    }
    expect(
      backdrop.every((mesh) => !mesh.castShadow && mesh.receiveShadow && prepassEligible(mesh)),
    ).toBe(true);
    const triangles = backdrop.reduce((sum, mesh) => sum + mesh.geometry.index!.count / 3, 0);
    expect(triangles).toBe(skyline.triangles);
    expect(backdrop.every((mesh) => mesh.geometry.getAttribute('uv1') === undefined)).toBe(true);
    const previous = backdrop.map((mesh) => mesh.material);
    setBakedLighting(group, true);
    expect(backdrop.map((mesh) => mesh.material)).toEqual(previous);
    setBakedLighting(group, false);
    const previousDraws = new Set(
      map
        .prisms!.filter((p) => p.backdrop && p.visible !== false)
        .flatMap((p) => [p.mat, p.top ?? p.mat]),
    ).size;
    expect((backdrop.length - previousDraws) * 2).toBeLessThanOrEqual(2);
  });
});
