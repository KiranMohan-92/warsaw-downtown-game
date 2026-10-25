import * as THREE from 'three';
import { Soldier, type SoldierKit } from './soldiers.ts';
import {
  dummyEyeHeight,
  humanoidHitboxes,
  type DummyState,
  type HitShape,
  type PlayerAction,
} from '@wd/shared';
import type { HeldWeapon } from './viewGunScans.ts';

/** What the practice dummies hold, in dummy order (they cycle through the whole arsenal). */
export const DUMMY_WEAPONS: readonly HeldWeapon[] = [
  'rifle',
  'shotgun',
  // Early in the cycle so the range's six dummies show the knife too.
  'knife',
  'marksman',
  'pistol',
  'coil',
  'iskra',
  'arc',
];

/**
 * Renders dummies exactly as their hit volumes (what you see is what you can hit).
 * Shared geometries/materials; ~3 draw calls per dummy.
 */
export class DummyView {
  readonly group = new THREE.Group();
  private readonly views = new Map<
    string,
    { root: THREE.Group; parts: THREE.Mesh[]; flash: number; soldier: Soldier | null }
  >();
  private readonly bodyMat = new THREE.MeshStandardMaterial({ color: '#c8573a', roughness: 0.7 });
  private readonly headMat = new THREE.MeshStandardMaterial({ color: '#e8c9a6', roughness: 0.6 });
  private readonly legMat = new THREE.MeshStandardMaterial({ color: '#3d4750', roughness: 0.8 });

  constructor(dummies: readonly DummyState[]) {
    this.group.name = 'dummies';
    for (const d of dummies) {
      const root = new THREE.Group();
      const parts = humanoidHitboxes({ x: 0, y: 0, z: 0 }, dummyEyeHeight(d)).map((s) =>
        this.meshFor(s),
      );
      root.add(...parts);
      this.group.add(root);
      this.views.set(d.def.id, { root, parts, flash: 0, soldier: null });
    }
  }

  private meshFor(s: HitShape): THREE.Mesh {
    const mat =
      s.zone === 'head'
        ? this.headMat.clone()
        : s.zone === 'torso'
          ? this.bodyMat.clone()
          : this.legMat.clone();
    const geo =
      s.kind === 'sphere'
        ? new THREE.SphereGeometry(s.r, 20, 14)
        : new THREE.CapsuleGeometry(
            s.r,
            Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z),
            6,
            14,
          );
    const m = new THREE.Mesh(geo, mat);
    m.position.set((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, (s.a.z + s.b.z) / 2);
    m.castShadow = true;
    return m;
  }

  /** Draw realistic soldiers (render/soldiers.ts) instead of the hit-volume figures. */
  useSoldiers(kit: SoldierKit): void {
    let i = 0;
    for (const v of this.views.values()) {
      v.soldier = new Soldier(kit, i);
      // Dummies never fire: they show the arsenal off instead, one weapon each (presentation).
      v.soldier.setWeapon(DUMMY_WEAPONS[i++ % DUMMY_WEAPONS.length]!);
      for (const p of v.parts) p.visible = false;
      this.group.add(v.soldier.root);
    }
  }

  /**
   * Presentation override: make a dummy's soldier perform an action (reload, throw, strike,
   * guard, stun: the same layers remote players show). Dummies have no hands in the sim, so this
   * is for probes and demos only; null clears it. Hits flinch them on their own (health drops).
   */
  setAction(id: string, action: PlayerAction | null): void {
    if (action) this.actions.set(id, action);
    else this.actions.delete(id);
  }

  private readonly actions = new Map<string, PlayerAction>();

  flash(id: string): void {
    const v = this.views.get(id);
    if (v) v.flash = 1;
    if (v?.soldier) v.soldier.flash = 1;
  }

  /** `viewer`: where the dummies turn to face (the local player), like training targets. */
  update(dummies: readonly DummyState[], dt: number, viewer?: { x: number; z: number }): void {
    for (const d of dummies) {
      const v = this.views.get(d.def.id);
      if (!v) continue;
      // The hit-volume figure keeps its place even when hidden (debug overlays use it).
      v.root.position.set(d.pos.x, d.pos.y, d.pos.z);
      if (v.soldier) {
        const yaw = viewer ? Math.atan2(-(viewer.x - d.pos.x), -(viewer.z - d.pos.z)) : 0;
        v.soldier.update(
          {
            x: d.pos.x,
            y: d.pos.y,
            z: d.pos.z,
            yaw,
            pitch: 0,
            crouched: dummyEyeHeight(d) < 1.3,
            grounded: true,
            sprinting: false,
            alive: d.health > 0,
            hp: d.health,
            action: this.actions.get(d.def.id),
          },
          dt,
        );
        continue;
      }
      v.root.visible = d.health > 0;
      v.root.position.set(d.pos.x, d.pos.y, d.pos.z);
      v.flash = Math.max(0, v.flash - dt * 8);
      for (const p of v.parts) {
        (p.material as THREE.MeshStandardMaterial).emissive.setScalar(v.flash * 0.6);
      }
    }
  }
}
