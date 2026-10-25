import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { PickupState } from '@wd/shared';
import { PickupView } from './pickupView.ts';

const uplink = (id: string, x = 0): PickupState => ({
  id,
  pos: { x, y: 0, z: 0 },
  kind: 'radar',
  cooldown: 0,
});
const medkit = (id: string, x = 0): PickupState => ({
  id,
  pos: { x, y: 0, z: 5 },
  kind: 'medkit',
  cooldown: 0,
});

/** Every material and geometry reachable under `root` (hidden objects included). */
function resources(root: THREE.Object3D): { mats: Set<THREE.Material>; geos: Set<unknown> } {
  const mats = new Set<THREE.Material>();
  const geos = new Set<unknown>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    geos.add(m.geometry);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat);
  });
  return { mats, geos };
}

/** Drawn items: pickups whose own visibility and every ancestor's is on. */
function shown(view: PickupView, ids: string[]): string[] {
  return ids.filter((id) => {
    let o: THREE.Object3D | null | undefined = view.item(id);
    if (!o) return false;
    for (; o; o = o.parent) if (!o.visible) return false;
    return true;
  });
}

describe('PickupView follows the authoritative pickup list (review fix)', () => {
  it('drops uplinks the server does not have (friend match with radar off)', () => {
    const view = new PickupView([uplink('r1'), uplink('r2', 4)]);
    expect(shown(view, ['r1', 'r2'])).toEqual(['r1', 'r2']);
    view.update(1 / 60, []);
    expect(view.count).toBe(0);
    expect(shown(view, ['r1', 'r2'])).toEqual([]);
  });

  it('draws medkits that arrive with the snapshots (built from a radar-only list)', () => {
    const view = new PickupView([uplink('r1')]);
    view.update(1 / 60, [uplink('r1'), medkit('m1'), medkit('m2', 3)]);
    expect(view.count).toBe(3);
    expect(shown(view, ['r1', 'm1', 'm2'])).toEqual(['r1', 'm1', 'm2']);
    expect(view.item('m2')!.position.x).toBe(3);
    // Taken: hidden until it respawns, not removed.
    view.update(1 / 60, [uplink('r1'), { ...medkit('m1'), cooldown: 12 }, medkit('m2', 3)]);
    expect(shown(view, ['m1', 'm2'])).toEqual(['m2']);
    expect(view.count).toBe(3);
  });

  it('items made after warm-up reuse only materials and geometry that existed at warm-up', () => {
    // Nothing to draw at construction: the hidden templates still carry every kind.
    const view = new PickupView([]);
    const warm = resources(view.group);
    view.update(1 / 60, [uplink('r1'), medkit('m1')]);
    view.update(1 / 60, [{ ...uplink('r1'), cooldown: 20 }, medkit('m1')]);
    expect(view.count).toBe(2);
    const after = resources(view.group);
    for (const m of after.mats) expect(warm.mats.has(m)).toBe(true);
    for (const g of after.geos) expect(warm.geos.has(g)).toBe(true);
  });

  it('new medkits use the loaded case model', () => {
    const view = new PickupView([medkit('m1')]);
    const model = {
      geometry: new THREE.BoxGeometry(1, 0.5, 0.8),
      far: new THREE.BoxGeometry(1, 0.5, 0.8),
      material: new THREE.MeshStandardMaterial({ name: 'hero:medkit' }),
    };
    view.useMedkitModel(model);
    const warm = resources(view.group);
    expect(warm.mats.has(model.material)).toBe(true);
    view.update(1 / 60, [medkit('m1'), medkit('m9', 8)]);
    const late = resources(view.item('m9')!);
    expect([...late.mats].filter((m) => m instanceof THREE.MeshStandardMaterial)).toEqual([
      model.material,
    ]);
    for (const m of late.mats) expect(warm.mats.has(m)).toBe(true);
  });
});
