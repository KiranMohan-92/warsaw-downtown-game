import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PRIMARY_IDS } from '@wd/shared';
import { Viewmodel, type ViewmodelState } from './viewmodel.ts';
import { gunTextureSize, PRIMARY_SCANS, SCAN_GUN_IDS, type ScanGun } from './viewGunScans.ts';

const state: ViewmodelState = {
  slot: 'rifle',
  switchProgress: 0,
  adsAmount: 0,
  sprinting: false,
  reload: -1,
  speed: 0,
  grounded: true,
  lookDx: 0,
  lookDy: 0,
  bob: false,
  melee: null,
  guard: false,
  stunned: false,
  throw: null,
};

describe('picked-up primary viewmodels', () => {
  it('prebuilds every scanned primary and selects it without allocating render resources', () => {
    const scans = new Map(
      SCAN_GUN_IDS.map((id) => [
        id,
        {
          geometry: new THREE.BoxGeometry(0.1, 0.2, 0.8),
          material: new THREE.MeshStandardMaterial({ name: id }),
        } satisfies ScanGun,
      ]),
    );
    const view = new Viewmodel();
    view.useScannedGuns(scans);
    const objects = new Set<THREE.Object3D>();
    const warmed = new Set<THREE.BufferGeometry>();
    view.scene.traverse((o) => {
      objects.add(o);
      if (o instanceof THREE.Mesh) warmed.add(o.geometry as THREE.BufferGeometry);
    });
    for (const primary of PRIMARY_IDS) {
      const geometry = scans.get(PRIMARY_SCANS[primary])!.geometry;
      expect(warmed.has(geometry)).toBe(true);
      view.setPrimary(primary);
      view.update(1 / 60, state);
      const shown: THREE.BufferGeometry[] = [];
      view.scene.traverseVisible((o) => {
        if (o instanceof THREE.Mesh) shown.push(o.geometry as THREE.BufferGeometry);
      });
      expect(shown.filter((g) => [...scans.values()].some((scan) => scan.geometry === g))).toEqual([
        geometry,
      ]);
      view.scene.traverse((o) => expect(objects.has(o)).toBe(true));
    }
  });

  it('uses the Low texture tier for guns and shared arms while keeping their aspect ratio', () => {
    expect(gunTextureSize(1024, 1024, true)).toEqual([512, 512]);
    expect(gunTextureSize(2048, 1355, true)).toEqual([512, 339]);
    expect(gunTextureSize(1024, 677, true)).toEqual([512, 339]);
    expect(gunTextureSize(256, 128, true)).toEqual([256, 128]);
    expect(gunTextureSize(2048, 1355, false)).toEqual([2048, 1355]);
  });
});
