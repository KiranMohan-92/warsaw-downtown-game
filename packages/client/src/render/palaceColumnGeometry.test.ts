import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { placDefilad, type MaterialId } from '@wd/shared';
import type { MapMaterials } from './materials.ts';
import { buildPalaceColumns } from './palaceColumns.ts';

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

function columnMesh(): THREE.Mesh {
  const group = buildPalaceColumns(placDefilad(), fake());
  expect(group).not.toBeNull();
  const mesh = group!.getObjectByName('palace-columns:stone');
  expect(mesh).toBeInstanceOf(THREE.Mesh);
  return mesh as THREE.Mesh;
}

describe('Palace column sculpt geometry', () => {
  it('keeps the visible mesh inside the authored collision boxes with a controlled triangle budget', () => {
    const mesh = columnMesh();
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex()!;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;

    expect(mesh.parent!.children).toHaveLength(2);
    expect(index.count / 3).toBeGreaterThan(20_000);
    expect(index.count / 3).toBeLessThanOrEqual(25_000);
    expect(bb.min.x).toBeGreaterThanOrEqual(51.5 - 0.65 - 1e-5);
    expect(bb.max.x).toBeLessThanOrEqual(51.5 + 0.65 + 1e-5);
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(12, 5);
    expect(bb.min.z).toBeGreaterThanOrEqual(-15 - 0.65 - 1e-5);
    expect(bb.max.z).toBeLessThanOrEqual(13 + 0.65 + 1e-5);

    for (let i = 0; i < pos.count; i++) {
      const nearestColumnZ = Math.round((pos.getZ(i) + 15) / 4) * 4 - 15;
      expect(Math.abs(pos.getZ(i) - nearestColumnZ)).toBeLessThanOrEqual(0.65 + 1e-5);
    }
  });

  it('raycasts rounded concave flute bowls on the visible front face', () => {
    const mesh = columnMesh();
    const raycaster = new THREE.Raycaster();
    const hitZ = (x: number): number => {
      raycaster.set(new THREE.Vector3(x, 6, -13.7), new THREE.Vector3(0, 0, -1));
      const hit = raycaster.intersectObject(mesh, false)[0];
      expect(hit).toBeDefined();
      return hit!.point.z;
    };

    const leftRidge = hitZ(51.5 - 0.42);
    const leftBowl = hitZ(51.5 - 0.285);
    const centreRidge = hitZ(51.5 - 0.15);
    const centreBowl = hitZ(51.5);

    expect(leftRidge - leftBowl).toBeGreaterThan(0.07);
    expect(centreRidge - centreBowl).toBeGreaterThan(0.07);
    expect(Math.abs(leftBowl - centreBowl)).toBeLessThan(0.025);
  });

  it('uses bevel and flute normals instead of fixed black face shading', () => {
    const mesh = columnMesh();
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    const col = mesh.geometry.getAttribute('color');
    let bevelNormals = 0;
    let fluteShoulderNormals = 0;
    let minColor = 1;
    let maxColor = 0;

    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nrm.getX(i));
      const nz = Math.abs(nrm.getZ(i));
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const x = pos.getX(i);
      const color = (col.getX(i) + col.getY(i) + col.getZ(i)) / 3;
      minColor = Math.min(minColor, color);
      maxColor = Math.max(maxColor, color);
      if ((y < 0.8 || y > 10) && nx > 0.25 && nz > 0.25) bevelNormals++;
      if (Math.abs(z + 14.58) < 0.09 && Math.abs(y - 6) < 4 && nx > 0.18 && nz > 0.78) {
        if (Math.abs(x - 51.5) < 0.42) fluteShoulderNormals++;
      }
    }

    expect(bevelNormals).toBeGreaterThan(80);
    expect(fluteShoulderNormals).toBeGreaterThan(40);
    expect(minColor).toBeGreaterThan(0.78);
    expect(maxColor).toBeLessThanOrEqual(0.98);
    expect(maxColor - minColor).toBeGreaterThan(0.035);
  });

  it('tilts normals on sloped mouldings while keeping every normal unit length', () => {
    const mesh = columnMesh();
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    let slopedPlinthNormals = 0;
    let slopedCapitalNormals = 0;
    let courseNotchNormals = 0;
    let maxUnitError = 0;

    for (let i = 0; i < nrm.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const nx = nrm.getX(i);
      const ny = nrm.getY(i);
      const nz = nrm.getZ(i);
      maxUnitError = Math.max(maxUnitError, Math.abs(Math.hypot(nx, ny, nz) - 1));
      if (Math.abs(ny) <= 0.03) continue;

      const nearColumnEdge = Math.abs(x - 51.5) > 0.49 || Math.abs(z + 15) > 0.49;
      if (nearColumnEdge && y > 0.08 && y < 0.72) slopedPlinthNormals++;
      if (nearColumnEdge && y > 10.2 && y < 10.8) slopedCapitalNormals++;
      if (Math.abs(y - 1.94) < 0.03 && Math.abs(z + 14.58) < 0.13) courseNotchNormals++;
    }

    expect(maxUnitError).toBeLessThan(1e-5);
    expect(slopedPlinthNormals).toBeGreaterThan(40);
    expect(slopedCapitalNormals).toBeGreaterThan(40);
    expect(courseNotchNormals).toBeGreaterThan(8);
  });

  it('keeps world-metre UV projection and outward triangle winding', () => {
    const mesh = columnMesh();
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    const uv = mesh.geometry.getAttribute('uv');
    const index = mesh.geometry.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const face = new THREE.Vector3();
    const normal = new THREE.Vector3();

    let checkedFront = false;
    let checkedSide = false;
    let checkedCap = false;
    for (let i = 0; i < pos.count; i++) {
      const nx = nrm.getX(i);
      const ny = nrm.getY(i);
      const nz = nrm.getZ(i);
      if (!checkedFront && Math.abs(nz) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(pos.getX(i), 5);
        expect(uv.getY(i)).toBeCloseTo(pos.getY(i), 5);
        checkedFront = true;
      }
      if (!checkedSide && Math.abs(nx) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(pos.getZ(i), 5);
        expect(uv.getY(i)).toBeCloseTo(pos.getY(i), 5);
        checkedSide = true;
      }
      if (!checkedCap && Math.abs(ny) > 0.9) {
        expect(uv.getX(i)).toBeCloseTo(pos.getX(i), 5);
        expect(uv.getY(i)).toBeCloseTo(pos.getZ(i), 5);
        checkedCap = true;
      }
    }
    expect(checkedFront && checkedSide && checkedCap).toBe(true);

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
      expect(face.dot(normal)).toBeGreaterThan(0.7);
    }
  });
});
