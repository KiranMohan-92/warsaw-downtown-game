import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FpAnimator } from './fpAnimator.ts';
import type { GunRig } from './viewGunScans.ts';

const part = (drop = false) => ({
  mesh: new THREE.Mesh(),
  pivot: new THREE.Vector3(),
  axis: new THREE.Vector3(0, -1, 0),
  drop: drop ? new THREE.Mesh() : null,
});
const rig = (id: GunRig['id'], parts: Record<string, ReturnType<typeof part>>): GunRig => ({
  id,
  offset: new THREE.Vector3(),
  parts: new Map(Object.entries(parts)),
  arms: null,
  shell: null,
  steam: [],
});
const idle = { reload: -1, reloadEmpty: false, vent: -1, ventLockout: 1.6, magEmpty: false };
type Private = { pumpT: number; drops: unknown[]; spawnDrop(n: string, p: null): void };

describe('first-person animator lifecycle', () => {
  it('a reload started right after a shotgun shot consumes the pending pump (no second rack)', () => {
    const a = new FpAnimator(rig('shotgun', { pump: part() }));
    a.fired();
    a.update(1 / 60, idle);
    expect((a as unknown as Private).pumpT).toBeGreaterThanOrEqual(0); // the shot's pump runs
    for (let t = 0; t <= 1; t += 0.05) a.update(1 / 60, { ...idle, reload: t, reloadEmpty: true });
    a.update(1 / 60, idle);
    expect((a as unknown as Private).pumpT).toBe(-1);
  });

  it('a tactical shotgun reload keeps the pending pump of the shot (it never racks itself)', () => {
    const a = new FpAnimator(rig('shotgun', { pump: part() }));
    a.fired();
    a.update(1 / 60, idle);
    for (let t = 0; t <= 1; t += 0.05) a.update(1 / 60, { ...idle, reload: t, reloadEmpty: false });
    expect((a as unknown as Private).pumpT).toBeGreaterThanOrEqual(0); // still owed after the reload
  });

  it('holstering clears a magazine in flight, so it never falls again on the next draw', () => {
    const mag = part(true);
    const a = new FpAnimator(rig('rifle', { mag }));
    (a as unknown as Private).spawnDrop('mag', null);
    expect(mag.drop!.visible).toBe(true);
    expect((a as unknown as Private).drops).toHaveLength(1);
    a.holster();
    expect((a as unknown as Private).drops).toHaveLength(0);
    expect(mag.drop!.visible).toBe(false);
    a.update(1 / 60, idle); // drawn again much later: nothing resumes
    expect(mag.drop!.visible).toBe(false);
  });
});
