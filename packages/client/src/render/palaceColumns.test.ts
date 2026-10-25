import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { PALACE_TINT, placDefilad, type MaterialId } from '@wd/shared';
import { buildMapMeshes } from './mapMesh.ts';
import type { MapMaterials } from './materials.ts';
import {
  loadPalaceColumnTextures,
  palaceColumnMaterial,
  resetPalaceColumnTextureCacheForTests,
} from './palaceColumnMaterial.ts';
import { buildPalaceColumns, isPalacePorticoColumn } from './palaceColumns.ts';

class FakeMaterials {
  typicalRoughness(): number {
    return 0.12;
  }
  onActiveMaps(): void {}
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();
  get(id: MaterialId): THREE.MeshStandardMaterial {
    let m = this.mats.get(id);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ name: id, vertexColors: true });
      this.mats.set(id, m);
    }
    return m;
  }
  variant(
    id: MaterialId,
    key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    const k = `${id}|${key}`;
    let m = this.mats.get(k);
    if (!m) {
      m = this.get(id).clone();
      m.name = k;
      configure(m);
      this.mats.set(k, m);
    }
    return m;
  }
  facadeShellVariant(
    key: string,
    configure: (m: THREE.MeshStandardMaterial) => void,
  ): THREE.MeshStandardMaterial {
    return this.variant('facade', `shell|${key}`, configure);
  }
}

const fake = (): MapMaterials => new FakeMaterials() as unknown as MapMaterials;

function columnMesh(root: THREE.Object3D): THREE.Mesh {
  const mesh = root.getObjectByName('palace-columns:stone');
  expect(mesh).toBeInstanceOf(THREE.Mesh);
  return mesh as THREE.Mesh;
}

describe('Palace portico columns', () => {
  beforeEach(() => resetPalaceColumnTextureCacheForTests());

  it('recognises only the eight authored Palace east-portico boxes', () => {
    const columns = placDefilad().boxes.filter(isPalacePorticoColumn);
    expect(columns).toHaveLength(8);
    expect(columns.map((b) => b.center.z)).toEqual([-15, -11, -7, -3, 1, 5, 9, 13]);
    for (const b of columns) {
      expect(b.center.x).toBe(51.5);
      expect(b.center.y).toBe(6);
      expect(b.size).toEqual({ x: 1.3, y: 12, z: 1.3 });
      expect(b.mat).toBe('facade');
      expect(b.tint).toBe(PALACE_TINT);
    }
    expect(
      isPalacePorticoColumn({ ...columns[0]!, center: { ...columns[0]!.center, z: -15.5 } }),
    ).toBe(false);
    expect(isPalacePorticoColumn({ ...columns[0]!, size: { x: 1.31, y: 12, z: 1.3 } })).toBe(false);
    expect(isPalacePorticoColumn({ ...columns[0]!, visible: false })).toBe(false);
  });

  it('builds modeled stone columns inside the original collision boxes', () => {
    const group = buildPalaceColumns(placDefilad(), fake());
    expect(group).not.toBeNull();
    expect(group!.children).toHaveLength(2);
    const mesh = columnMesh(group!);
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex()!;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;

    expect(bb.min.x).toBeGreaterThanOrEqual(51.5 - 0.65 - 1e-5);
    expect(bb.max.x).toBeLessThanOrEqual(51.5 + 0.65 + 1e-5);
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(12, 5);
    expect(bb.min.z).toBeGreaterThanOrEqual(-15 - 0.65 - 1e-5);
    expect(bb.max.z).toBeLessThanOrEqual(13 + 0.65 + 1e-5);
    expect(index.count / 3).toBeLessThanOrEqual(25_000);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      expect(x).toBeGreaterThanOrEqual(51.5 - 0.65 - 1e-5);
      expect(x).toBeLessThanOrEqual(51.5 + 0.65 + 1e-5);
      expect(y).toBeGreaterThanOrEqual(-1e-5);
      expect(y).toBeLessThanOrEqual(12 + 1e-5);
      const nearestColumnZ = Math.round((z + 15) / 4) * 4 - 15;
      expect(Math.abs(z - nearestColumnZ)).toBeLessThanOrEqual(0.65 + 1e-5);
    }
    expect((mesh.material as THREE.Material).name).toBe('facade|shell|palace-portico-columns');
    expect((mesh.material as THREE.Material).userData.keepNormalOnLow).toBe(true);
    expect((mesh.material as THREE.Material).userData.palacePilotLoading).toBeUndefined();
    expect((mesh.material as THREE.Material).userData.preserveFacadeShellMaps).toBe(true);
  });

  it('casts only a fixed coarse column silhouette using the warmed facade depth program', () => {
    const map = placDefilad();
    const original = JSON.stringify(map);
    const group = buildPalaceColumns(map, fake())!;
    const stone = columnMesh(group);
    const proxy = group.getObjectByName('palace-columns:shadow-proxy') as THREE.Mesh;
    expect(proxy).toBeInstanceOf(THREE.Mesh);
    expect(stone.castShadow).toBe(false);
    expect(stone.receiveShadow).toBe(false);
    expect(group.children.filter((o) => o.castShadow)).toEqual([proxy]);
    expect(proxy.geometry.getIndex()!.count / 3).toBe(8 * 3 * 12);
    expect(proxy.receiveShadow).toBe(false);
    expect(proxy.visible).toBe(true);
    expect(proxy.matrixAutoUpdate).toBe(false);
    expect(proxy.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((proxy.material as THREE.Material).colorWrite).toBe(false);
    expect((proxy.material as THREE.Material).depthWrite).toBe(false);
    const depth = proxy.customDepthMaterial as THREE.MeshDepthMaterial;
    expect(depth).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(depth.depthPacking).toBe(THREE.RGBADepthPacking);
    expect(depth.side).toBe(THREE.BackSide);
    expect(depth.map).toBeNull();
    expect(depth.alphaTest).toBe(0);
    expect(proxy).not.toBeInstanceOf(THREE.InstancedMesh);
    expect(depth.customProgramCacheKey()).toBe(
      new THREE.MeshDepthMaterial().customProgramCacheKey(),
    );
    const box = proxy.geometry.boundingBox!;
    expect(box.min.x).toBeCloseTo(50.85, 4);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(box.min.z).toBeCloseTo(-15.65, 4);
    expect(box.max.x).toBeCloseTo(52.15, 4);
    expect(box.max.y).toBe(12);
    expect(box.max.z).toBeCloseTo(13.65, 4);
    expect(JSON.stringify(map)).toBe(original);
  });

  it('constructs the pilot material synchronously without starting texture loads', () => {
    let loads = 0;
    const loader = {
      loadAsync: (url: string) => {
        loads++;
        const t = new THREE.Texture();
        t.name = url;
        return Promise.resolve(t);
      },
    } as unknown as THREE.TextureLoader;
    const material = palaceColumnMaterial(fake(), { loader, root: '/pilot/' });

    expect(material.name).toBe('facade|shell|palace-portico-columns');
    expect(material.userData.keepNormalOnLow).toBe(true);
    expect(material.userData.preserveFacadeShellMaps).toBe(true);
    expect(typeof material.onBeforeCompile).toBe('function');
    expect(loads).toBe(0);
  });

  it('exposes a cached preload path for warmup and already-built materials', async () => {
    let loads = 0;
    const loader = {
      loadAsync: (url: string) => {
        loads++;
        const t = new THREE.Texture();
        t.name = url;
        return Promise.resolve(t);
      },
    } as unknown as THREE.TextureLoader;
    const material = palaceColumnMaterial(fake(), { loader, root: '/ignored/' });
    const loaded = await loadPalaceColumnTextures(undefined, undefined, {
      loader,
      root: '/pilot-cache/',
    });

    expect(loaded).toBe(true);
    expect(loads).toBe(3);
    expect(material.map!.name).toBe('/pilot-cache/tex/palace-columns-v2/stone_albedo.webp');
    expect(material.normalMap!.name).toBe('/pilot-cache/tex/palace-columns-v2/stone_normal.webp');
    expect(material.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.roughnessMap!.repeat.x).toBeCloseTo(1 / 1.35);
    expect(material.aoMap).toBe(material.roughnessMap);
    expect(material.roughness).toBe(1);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.userData.palacePilotTextures).toBe(true);
  });

  it('exposes visible recessed flutes with front-facing winding', () => {
    const group = buildPalaceColumns(placDefilad(), fake())!;
    const mesh = columnMesh(group);
    const raycaster = new THREE.Raycaster();
    const hitZ = (x: number): number => {
      raycaster.set(new THREE.Vector3(x, 6, -13), new THREE.Vector3(0, 0, -1));
      const hit = raycaster.intersectObject(mesh, false)[0];
      expect(hit).toBeDefined();
      return hit!.point.z;
    };

    const raised = hitZ(51.5 - 0.42);
    const groove = hitZ(51.5 - 0.285);
    expect(raised).toBeGreaterThan(-14.51);
    expect(groove).toBeLessThan(-14.56);
    expect(raised - groove).toBeGreaterThan(0.07);
  });

  it('shares packed roughness/cavity data and warms anisotropic maps before play', async () => {
    const mat = palaceColumnMaterial(fake());
    const uploaded: THREE.Texture[] = [];
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4 },
      initTexture: (texture: THREE.Texture) => uploaded.push(texture),
    } as unknown as THREE.WebGLRenderer;
    const loader = {
      loadAsync: () => Promise.resolve(new THREE.Texture()),
    } as unknown as THREE.TextureLoader;
    expect(await loadPalaceColumnTextures(renderer, undefined, { loader })).toBe(true);
    expect(uploaded).toHaveLength(3);
    expect(uploaded.every((texture) => texture.anisotropy === 4)).toBe(true);
    expect(mat.aoMap).toBe(mat.roughnessMap);
    expect(mat.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(mat.aoMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(mat.metalness).toBe(0);
    expect(mat.metalnessMap).toBeNull();
  });

  it('keeps the fallback material usable when the asset preload fails', async () => {
    const mat = palaceColumnMaterial(fake());
    const fallback = mat.map;
    const loader = {
      loadAsync: () => Promise.reject(new Error('Unavailable texture')),
    } as unknown as THREE.TextureLoader;
    expect(await loadPalaceColumnTextures(undefined, undefined, { loader })).toBe(false);
    expect(mat.map).toBe(fallback);
    expect(mat.userData.palacePilotTextures).toBe(false);
  });

  it('occludes sheltered flute light without darkening the direct sunlight term', () => {
    const material = palaceColumnMaterial(fake());
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <project_vertex>',
      fragmentShader: '#include <common>\n#include <aomap_fragment>',
    } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute float columnOcclusion;');
    expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse *= vColumnOcclusion;');
    expect(shader.fragmentShader).not.toContain('reflectedLight.directDiffuse *=');
    const mesh = columnMesh(buildPalaceColumns(placDefilad(), fake())!);
    const cavity = mesh.geometry.getAttribute('columnOcclusion');
    const values = Array.from(cavity.array);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.59);
    expect(Math.min(...values)).toBeLessThan(0.75);
    expect(Math.max(...values)).toBe(1);
  });

  it('projects the baked column tile in world metres on each face axis', () => {
    const group = buildPalaceColumns(placDefilad(), fake())!;
    const mesh = columnMesh(group);
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    const uv = mesh.geometry.getAttribute('uv');

    let checkedFront = false;
    let checkedSide = false;
    let checkedCap = false;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const nx = nrm.getX(i);
      const ny = nrm.getY(i);
      const nz = nrm.getZ(i);
      if (!checkedFront && Math.abs(nz) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(x, 5);
        expect(uv.getY(i)).toBeCloseTo(y, 5);
        checkedFront = true;
      }
      if (!checkedSide && Math.abs(nx) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(z, 5);
        expect(uv.getY(i)).toBeCloseTo(y, 5);
        checkedSide = true;
      }
      if (!checkedCap && Math.abs(ny) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(x, 5);
        expect(uv.getY(i)).toBeCloseTo(z, 5);
        checkedCap = true;
      }
    }
    expect(checkedFront && checkedSide && checkedCap).toBe(true);
  });

  it('winds every triangle toward its authored vertex normal', () => {
    const group = buildPalaceColumns(placDefilad(), fake())!;
    const mesh = columnMesh(group);
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    const index = mesh.geometry.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const face = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i);
      const ib = index.getX(i + 1);
      const ic = index.getX(i + 2);
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      face.subVectors(b, a).cross(ab.subVectors(c, a)).normalize();
      normal
        .set(
          nrm.getX(ia) + nrm.getX(ib) + nrm.getX(ic),
          nrm.getY(ia) + nrm.getY(ib) + nrm.getY(ic),
          nrm.getZ(ia) + nrm.getZ(ib) + nrm.getZ(ic),
        )
        .normalize();
      // Smoothed curved flutes interpolate the analytic surface normal across each facet.
      expect(face.dot(normal)).toBeGreaterThan(0.7);
    }
  });

  it('replaces the old flat visual boxes in the built map', () => {
    const root = buildMapMeshes(placDefilad(), fake());
    expect(root.getObjectByName('palace-columns')).not.toBeNull();
    const mesh = columnMesh(root);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);

    let oldColumnCornerVertices = 0;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.name.startsWith('map:facade|')) return;
      const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const oldColumnCorner =
          (Math.abs(x - 50.85) < 1e-5 || Math.abs(x - 52.15) < 1e-5) &&
          (Math.abs(y) < 1e-5 || Math.abs(y - 12) < 1e-5) &&
          (Math.abs(z + 15.65) < 1e-5 || Math.abs(z + 14.35) < 1e-5);
        if (oldColumnCorner) oldColumnCornerVertices++;
      }
    });
    expect(oldColumnCornerVertices).toBe(0);
  });
});
