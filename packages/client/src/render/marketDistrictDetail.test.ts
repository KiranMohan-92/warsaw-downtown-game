import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { getMap, resolveMap, type MaterialId } from '@wd/shared';
import { MapMaterials } from './materials.ts';
import {
  buildMarketDistrictDetail,
  marketDetailDecalLift,
  updateMarketDistrictDetail,
} from './marketDistrictDetail.ts';
import { setRenderBudget } from './renderBudget.ts';

function materialLibrary(): MapMaterials {
  const base = new Map<string, THREE.MeshStandardMaterial>();
  const variants = new Map<string, THREE.MeshStandardMaterial>();
  const get = (id: MaterialId): THREE.MeshStandardMaterial => {
    if (!base.has(id))
      base.set(
        id,
        new THREE.MeshStandardMaterial({ normalMap: new THREE.Texture(), vertexColors: true }),
      );
    return base.get(id)!;
  };
  return {
    get,
    variant: (id: MaterialId, key: string, configure: (m: THREE.MeshStandardMaterial) => void) => {
      const k = `${id}|${key}`;
      if (!variants.has(k)) {
        const mat = get(id).clone();
        configure(mat);
        variants.set(k, mat);
      }
      return variants.get(k)!;
    },
  } as unknown as MapMaterials;
}

describe('entire Market detail integration', () => {
  it('keeps long room edges close, then hides distant detail without boundary flicker', () => {
    const geo = new THREE.BoxGeometry(100, 10, 8);
    geo.translate(100, 8, 0);
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    const group = new THREE.Group();
    group.add(mesh);
    const camera = new THREE.Vector3(152, 8, 0);
    updateMarketDistrictDetail(group, camera, 'low');
    expect(mesh.visible).toBe(true); // 2 m from the edge, 52 m from the centre
    camera.x = 187;
    updateMarketDistrictDetail(group, camera, 'low');
    expect(mesh.visible).toBe(true);
    camera.x = 193;
    updateMarketDistrictDetail(group, camera, 'low');
    expect(mesh.visible).toBe(false);
    camera.x = 187;
    updateMarketDistrictDetail(group, camera, 'low');
    expect(mesh.visible).toBe(false);
    camera.x = 179;
    updateMarketDistrictDetail(group, camera, 'low');
    expect(mesh.visible).toBe(true);
    camera.set(100, 70, 0);
    updateMarketDistrictDetail(group, camera, 'low');
    expect(mesh.visible).toBe(false); // vertical separation matters for raised rooms
    updateMarketDistrictDetail(group, camera, 'high');
    expect(mesh.visible).toBe(false);
    expect(camera.toArray()).toEqual([100, 70, 0]);
    expect(mesh.frustumCulled).toBe(true);
    geo.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  it('keeps real Market fittings identical on every tier without changing cover', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const original = JSON.stringify(map);
    const group = buildMarketDistrictDetail(map, materialLibrary());
    const camera = new THREE.Vector3(99, 1.6, 0);
    updateMarketDistrictDetail(group, camera, 'low');
    const hidden = group.children.filter((o) => !o.visible);
    expect(hidden.length).toBeGreaterThan(0);
    const visibility = group.children.map((o) => o.visible);
    for (const quality of ['medium', 'high', 'ultra', 'low'] as const) {
      updateMarketDistrictDetail(group, camera, quality);
      expect(group.children.map((o) => o.visible)).toEqual(visibility);
    }
    (hidden[0] as THREE.Mesh).geometry.boundingBox!.getCenter(camera);
    updateMarketDistrictDetail(group, camera, 'low');
    expect(hidden.some((o) => o.visible)).toBe(true);
    expect(JSON.stringify(map)).toBe(original);
    expect(group.children.every((o) => !o.castShadow)).toBe(true);
  });
  it('merges every district area without changing cover/layout or adding shadow passes', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const original = JSON.stringify(map);
    const group = buildMarketDistrictDetail(map, materialLibrary());
    expect(group.children.some((o) => o.name.includes('containers'))).toBe(true);
    expect(group.children.some((o) => o.name.includes('interiors'))).toBe(true);
    expect(group.children.length).toBeLessThanOrEqual(60);
    expect(group.userData.triangles).toBeGreaterThan(1000);
    expect(group.userData.triangles).toBeLessThanOrEqual(250_000);
    expect(JSON.stringify(map)).toBe(original);
    let invalidPositions = 0;
    let maxNormalError = 0;
    for (const object of group.children) {
      const mesh = object as THREE.Mesh;
      expect(mesh.castShadow).toBe(false);
      // Metal trim outdoors carries its own dirt; everything indoors takes the sun's shadow.
      expect(mesh.receiveShadow).toBe(
        !mesh.name.includes('|metal|') || mesh.name.includes('interiors'),
      );
      expect(mesh.geometry.index).toBeTruthy();
      const p = mesh.geometry.getAttribute('position');
      const normal = mesh.geometry.getAttribute('normal');
      expect(mesh.geometry.getAttribute('color').count).toBe(p.count);
      expect(mesh.geometry.getAttribute('aFace').count).toBe(p.count);
      for (let i = 0; i < p.count; i++) {
        if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) invalidPositions++;
        maxNormalError = Math.max(
          maxNormalError,
          Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1),
        );
      }
    }
    expect(invalidPositions).toBe(0);
    expect(maxNormalError).toBeLessThan(1e-4);
  });

  it('retains original maps through a Low/High change and confines room-lamp shading to interiors', () => {
    const materials = materialLibrary();
    const group = buildMarketDistrictDetail(resolveMap(getMap('defilad'), 'market'), materials);
    const maps = new Map<THREE.MeshStandardMaterial, THREE.Texture | null>();
    for (const object of group.children) {
      const mesh = object as THREE.Mesh;
      const m = mesh.material as THREE.MeshStandardMaterial;
      maps.set(m, m.normalMap);
      expect(m.customProgramCacheKey().includes('lampVolume:world')).toBe(
        mesh.name.includes('interiors'),
      );
    }
    setRenderBudget(group, 'low');
    for (const m of maps.keys()) expect(m.normalMap).toBeNull();
    setRenderBudget(group, 'high');
    for (const [m, normal] of maps) expect(m.normalMap).toBe(normal);
    expect(materials.get('metal').customProgramCacheKey()).not.toContain('lampVolume:world');
  });

  it('adds the market hall in one draw per material, one shared program, drawn before the walls', () => {
    const group = buildMarketDistrictDetail(
      resolveMap(getMap('defilad'), 'market'),
      materialLibrary(),
    );
    const interiors = group.children.filter((o) => o.name.includes('interiors')) as THREE.Mesh[];
    // The hall is one 32 m chunk: before its dressing it drew one (metal trim) mesh there.
    const hall = interiors.filter((m) => m.name.endsWith('|4,0'));
    expect(hall.map((m) => m.name.split('|')[1]).sort()).toEqual(
      ['metal', 'paint', 'plaster', 'sandbag', 'terrazzo', 'tile', 'trim', 'wood'].sort(),
    );
    expect(hall.length - 1).toBeLessThanOrEqual(12); // the brief's Low budget: +12 draws
    // The hall's metal (zinc counter tops, thresholds, duct) sits under a floor: no direct sun.
    expect(hall.find((m) => m.name.split('|')[1] === 'metal')!.receiveShadow).toBe(true);
    // Bullet holes land on the cladding: a hit on the floor and on a counter top.
    const lift = marketDetailDecalLift(group);
    expect(lift({ x: 140, y: 0.05, z: 16 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(0.004, 3);
    expect(lift({ x: 137, y: 1.0, z: 20 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(0.012, 3);
    expect(lift({ x: 100, y: 0.05, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0);
    // Every interior surface shares one program (same base key, same variant patches).
    const keys = new Set(
      interiors.map((m) => (m.material as THREE.MeshStandardMaterial).customProgramCacheKey()),
    );
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/hallSky-v1\|lampVolume:world$/);
    for (const m of interiors) {
      expect(m.renderOrder).toBe(-1);
      expect(m.geometry.getAttribute('aHallSky').count).toBe(
        m.geometry.getAttribute('position').count,
      );
    }
  });

  it('compiles no new program with the real map materials: one key for every interior surface', () => {
    // MapMaterials draws its level-design grid on a canvas: a minimal stand-in for node.
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', fillRect: () => {} }),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    const materials = new MapMaterials(8);
    vi.unstubAllGlobals();
    const group = buildMarketDistrictDetail(resolveMap(getMap('defilad'), 'market'), materials);
    const keys = new Set(
      group.children
        .filter((o) => o.name.includes('interiors'))
        .map((o) =>
          ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).customProgramCacheKey(),
        ),
    );
    // Before the hall dressing the interiors drew metal only, with this key minus hallSky-v1:
    // one program replaced by one.
    expect([...keys]).toEqual(['wet|market-interior-detail|hallSky-v1|lampVolume:world']);
  });

  it('leaves the range untouched', () => {
    expect(buildMarketDistrictDetail(getMap('range'), materialLibrary()).children).toHaveLength(0);
  });
});
