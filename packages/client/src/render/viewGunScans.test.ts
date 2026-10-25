import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SCAN_FITS, SCAN_GUN_IDS, armsMaterialFrom } from './viewGunScans.ts';
import { modelDataReady, readAccessor, readModel } from './modelData.testUtil.ts';

await modelDataReady;

const dir = new URL('../../public/models/guns/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('guns.json', dir), 'utf8')) as {
  guns: Record<string, { triangles: number }>;
};

/** A shipped gun's vertex positions (single mesh, float32 POSITION). */
function positions(id: string): [number, number, number][] {
  const model = readModel(new URL(`${id}.gltf`, dir));
  const p = readAccessor(model, model.json.meshes[0]!.primitives[0]!.attributes.POSITION!).data;
  return Array.from({ length: p.length / 3 }, (_, i) => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!]);
}

describe('scanned viewmodel guns', () => {
  it('ships every scan within its triangle budget', () => {
    for (const id of SCAN_GUN_IDS) {
      expect(manifest.guns[id], id).toBeDefined();
      expect(manifest.guns[id]!.triangles).toBeLessThanOrEqual(14000);
    }
  });

  it('ships the moving parts as their own nodes, next to the body (build_viewguns.PARTS)', () => {
    const want: Record<string, string[]> = {
      rifle: ['mag', 'bolt'],
      pistol: ['slide', 'mag'],
      coil: ['cell'],
      iskra: ['mag', 'bolt'],
      shotgun: ['pump'],
      marksman: ['mag', 'bolt'],
      arc: ['vent'],
    };
    const full = manifest as unknown as {
      guns: Record<
        string,
        { generatedTriangles?: number; parts?: Record<string, { pivot: number[] }> }
      >;
    };
    for (const id of SCAN_GUN_IDS) {
      const model = readModel(new URL(`${id}.gltf`, dir));
      const names = (model.json.nodes ?? []).map((n) => n.name);
      // Body first (named after the gun: the loader and soldiers' merge rely on it).
      expect(names[0], id).toBe(id);
      expect(Object.keys(full.guns[id]!.parts ?? {}), id).toEqual(want[id]);
      for (const part of want[id]!) expect(names, `${id}.${part}`).toContain(part);
      expect(full.guns[id]!.generatedTriangles ?? 0).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the rifle's sight line clear of its front post and the optic on its rail", () => {
    const fit = SCAN_FITS.rifle;
    const [, oy, oz] = fit.offset;
    const pts = positions('rifle').map(([x, y, z]) => [x, y + oy, z + oz] as const);
    const ahead = pts.filter(([x, , z]) => Math.abs(x) < 0.012 && z < fit.optic!.z - 0.04);
    expect(Math.max(...ahead.map(([, y]) => y))).toBeLessThan(fit.sightY - 0.005);
    const under = pts.filter(
      ([x, , z]) => Math.abs(x) < 0.012 && Math.abs(z - fit.optic!.z) < 0.02,
    );
    expect(Math.max(...under.map(([, y]) => y))).toBeCloseTo(fit.optic!.rail, 2);
  });
});

describe('first-person arms', () => {
  it('poses arms for every scanned gun, within budget, near its grips', () => {
    const arms = JSON.parse(
      readFileSync(new URL('../../public/models/arms/arms.json', import.meta.url), 'utf8'),
    ) as { poses: Record<string, { triangles: number }> };
    for (const id of SCAN_GUN_IDS) {
      expect(arms.poses[id]?.triangles, id).toBeLessThanOrEqual(3000);
      const g = JSON.parse(
        readFileSync(new URL(`../../public/models/arms/${id}.gltf`, import.meta.url), 'utf8'),
      ) as { accessors: { min?: number[]; max?: number[] }[] };
      // Gun space: the arms reach from behind the eye to the support hand, never past the muzzle.
      const { min, max } = g.accessors[0]!;
      expect(min![2]!).toBeGreaterThan(-0.45);
      expect(max![2]!).toBeLessThan(0.8);
    }
  });

  it("wears the soldiers' forearm plates, textured from the strip under the sleeves", () => {
    const arms = JSON.parse(
      readFileSync(new URL('../../public/models/arms/arms.json', import.meta.url), 'utf8'),
    ) as { poses: Record<string, { triangles: number; guardTriangles: number }> };
    for (const id of SCAN_GUN_IDS) {
      const pose = arms.poses[id]!;
      expect(pose.guardTriangles, id).toBeGreaterThan(0);
      const model = readModel(new URL(`../../public/models/arms/${id}.gltf`, import.meta.url));
      const prim = model.json.meshes[0]!.primitives[0]!;
      const uv = readAccessor(model, prim.attributes.TEXCOORD_0!).data;
      const idx = readAccessor(model, prim.indices!).data;
      // Plate triangles come last (build_fparms.package) and sample only the bottom strip.
      const first = (pose.triangles - pose.guardTriangles) * 3;
      let minPlateV = 1;
      let maxSleeveV = 0;
      for (let i = 0; i < idx.length; i++) {
        const v = uv[idx[i]! * 2 + 1]!;
        if (i >= first) minPlateV = Math.min(minPlateV, v);
        else maxSleeveV = Math.max(maxSleeveV, v);
      }
      expect(minPlateV, id).toBeGreaterThan(maxSleeveV);
    }
  });

  it('gives the arms material its edge light and shell roughness up front', () => {
    const t = (): THREE.Texture => new THREE.Texture();
    const m = armsMaterialFrom({ map: t(), normalMap: t(), roughnessMap: t(), emissiveMap: t() });
    expect(m.emissiveMap).not.toBeNull();
    expect(m.roughnessMap).not.toBeNull();
    expect(m.emissive.getHex()).toBe(0xffffff);
    expect(m.roughness).toBe(1);
  });
});
