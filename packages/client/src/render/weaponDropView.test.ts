import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PRIMARY_IDS, WEAPON_DROP, type WeaponDropState } from '@wd/shared';
import { WeaponDropView } from './weaponDropView.ts';
import { PRIMARY_SCANS, type ScanGun, type ScanGunId } from './viewGunScans.ts';

const drop = (id: string, primary = PRIMARY_IDS[0]!, ttl = 30): WeaponDropState => ({
  id,
  primary,
  pos: { x: 2, y: 3, z: 4 },
  ammoFraction: 0.5,
  ttl,
});

const scans = new Map<ScanGunId, ScanGun>(
  PRIMARY_IDS.map((primary) => [
    PRIMARY_SCANS[primary],
    {
      geometry: new THREE.BoxGeometry(0.08, 0.25, 0.8),
      material: new THREE.MeshStandardMaterial({ name: `gun:${primary}` }),
    },
  ]),
);

function drawn(
  view: WeaponDropView,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] {
  const out: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
  view.group.traverseVisible((o) => {
    if (o instanceof THREE.Mesh) out.push(o as (typeof out)[number]);
  });
  return out;
}

describe('weapon drop rendering', () => {
  it('preallocates the capped pool and draws every primary during warm-up', () => {
    const view = new WeaponDropView();
    view.useScannedGuns(scans);
    expect(drawn(view)).toHaveLength(0);
    const restore = view.beginWarmUp();
    const warm = drawn(view);
    expect(warm).toHaveLength(WEAPON_DROP.cap * PRIMARY_IDS.length);
    for (const primary of PRIMARY_IDS)
      expect(warm.some((m) => m.geometry === scans.get(PRIMARY_SCANS[primary])!.geometry)).toBe(
        true,
      );
    const materials = new Set(warm.map((m) => m.material));
    const geometry = new Set(warm.map((m) => m.geometry));
    const keys = new Set(warm.map((m) => m.material.customProgramCacheKey()));
    const objects = new Set<THREE.Object3D>();
    view.group.traverse((o) => objects.add(o));
    restore();
    expect(drawn(view)).toHaveLength(0);
    for (const primary of PRIMARY_IDS) {
      view.update(
        1 / 60,
        Array.from({ length: WEAPON_DROP.cap + 1 }, (_, i) => drop(`${i}`, primary)),
      );
      expect(drawn(view)).toHaveLength(WEAPON_DROP.cap);
      for (const m of drawn(view)) {
        expect(materials.has(m.material)).toBe(true);
        expect(geometry.has(m.geometry)).toBe(true);
        expect(keys.has(m.material.customProgramCacheKey())).toBe(true);
      }
      view.group.traverse((o) => expect(objects.has(o)).toBe(true));
    }
  });

  it('lays the whole gun on its side above the ground and fades during its last two seconds', () => {
    const view = new WeaponDropView();
    view.useScannedGuns(scans);
    view.update(0, [drop('a', 'arc', 1)]);
    const mesh = drawn(view)[0]!;
    view.group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(mesh);
    expect(bounds.min.y).toBeCloseTo(3.025);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(0.08);
    expect(mesh.material.opacity).toBeCloseTo(0.5);
    const version = mesh.material.version;
    view.update(1, [drop('a', 'arc', 0.5)]);
    expect(mesh.material.opacity).toBeCloseTo(0.25);
    expect(mesh.material.emissiveIntensity).toBeGreaterThan(0);
    expect(mesh.material.version).toBe(version);
    view.update(0, []);
    expect(drawn(view)).toHaveLength(0);
  });

  it('keeps an ammo-depleted gun visible and restores live selections after warm-up', () => {
    const view = new WeaponDropView();
    view.useScannedGuns(scans);
    view.update(0, [{ ...drop('a', 'coil'), ammoFraction: 0 }]);
    const before = drawn(view);
    const restore = view.beginWarmUp();
    expect(drawn(view).length).toBeGreaterThan(before.length);
    restore();
    expect(drawn(view)).toEqual(before);
    expect(before[0]!.geometry).toBe(scans.get('coil')!.geometry);
  });
});
