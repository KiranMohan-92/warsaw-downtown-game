import * as THREE from 'three';
import type { PickupState } from '@wd/shared';
import type { HeroModel } from './heroModels.ts';

/** Medkit case width on screen (m); the generated model is scaled to it. */
const MEDKIT_WIDTH = 0.5;

type Item =
  | { kind: 'uplink'; root: THREE.Group; dish: THREE.Group; orb: THREE.Mesh; beam: THREE.Mesh }
  | { kind: 'medkit'; root: THREE.Group; box: THREE.Group; ring: THREE.Mesh };

const viewKind = (p: PickupState): Item['kind'] => (p.kind === 'medkit' ? 'medkit' : 'uplink');

/**
 * Radar uplinks in the world: a low pedestal with a spinning dish and a glowing core. Bright and
 * spinning when ready; dim and still while recharging. Medkits: a case hovering over a soft ring.
 * Visual only (no collider).
 *
 * The drawn set follows the pickup list by id (online, the server's snapshots are the authority:
 * a friend match without radar has no uplinks, medkits arrive with the first snapshot). Items
 * made later share this view's geometry and materials, and one hidden template of each kind
 * lives in the group from the start, so `Game.warmUp` compiles every program a later item uses.
 */
export class PickupView {
  readonly group = new THREE.Group();
  private readonly items = new Map<string, Item>();
  private readonly templates = new THREE.Group();
  private readonly medkitBoxes = new Set<THREE.Group>();
  private medkitModel: HeroModel | null = null;
  private time = 0;

  private readonly geo = {
    ped: new THREE.CylinderGeometry(0.45, 0.55, 0.9, 12),
    bowl: new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3),
    mast: new THREE.CylinderGeometry(0.04, 0.04, 0.4, 6),
    orb: new THREE.IcosahedronGeometry(0.14, 1),
    // Faint vertical beam so uplinks read from a distance.
    beam: new THREE.CylinderGeometry(0.12, 0.12, 12, 8, 1, true),
    body: new THREE.BoxGeometry(0.5, 0.34, 0.42),
    bar1: new THREE.BoxGeometry(0.22, 0.012, 0.06),
    bar2: new THREE.BoxGeometry(0.06, 0.012, 0.22),
    ring: new THREE.RingGeometry(0.34, 0.5, 32),
  };
  private readonly mat = {
    base: new THREE.MeshStandardMaterial({ color: '#2b3036', roughness: 0.5, metalness: 0.6 }),
    dish: new THREE.MeshStandardMaterial({ color: '#c9d2da', roughness: 0.3, metalness: 0.8 }),
    // Ready / recharging cores: one program, swapped per uplink (not a material per uplink).
    coreReady: new THREE.MeshStandardMaterial({
      color: '#1b3a44',
      emissive: new THREE.Color('#5fe3ff'),
      emissiveIntensity: 2.5,
    }),
    coreSpent: new THREE.MeshStandardMaterial({
      color: '#1b3a44',
      emissive: new THREE.Color('#5fe3ff'),
      emissiveIntensity: 0.15,
    }),
    beam: new THREE.MeshBasicMaterial({
      color: '#5fe3ff',
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    ring: new THREE.MeshBasicMaterial({
      color: '#39e0ff',
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    // Until the generated case loads: a graphite case with a cyan plus on the lid.
    case: new THREE.MeshStandardMaterial({ color: '#2c3136', roughness: 0.45, metalness: 0.4 }),
    plus: new THREE.MeshStandardMaterial({
      color: '#39e0ff',
      emissive: new THREE.Color('#39e0ff'),
      emissiveIntensity: 2,
    }),
  };

  constructor(pickups: readonly PickupState[]) {
    this.group.name = 'pickups';
    // Never shown: they carry every material into warm-up (and the lamp-volume patch).
    this.templates.name = 'pickups:templates';
    this.templates.visible = false;
    const uplink = this.makeUplink();
    const spent = new THREE.Mesh(this.geo.orb, this.mat.coreSpent);
    this.templates.add(uplink.root, spent, this.makeMedkit().root);
    this.group.add(this.templates);
    this.sync(pickups);
  }

  /** The generated medkit (Higgsfield, tools/assets/build_heroes.py) replaces the stand-in. */
  useMedkitModel(model: HeroModel): void {
    this.medkitModel = model;
    for (const box of this.medkitBoxes) this.fillMedkitBox(box);
  }

  /** How many pickups are drawn (templates excluded). */
  get count(): number {
    return this.items.size;
  }

  /** The drawn item for a pickup id (tests, probes). */
  item(id: string): THREE.Object3D | undefined {
    return this.items.get(id)?.root;
  }

  update(dt: number, pickups: readonly PickupState[]): void {
    this.time += dt;
    this.sync(pickups);
    pickups.forEach((p, i) => {
      const it = this.items.get(p.id);
      if (!it) return;
      const ready = p.cooldown <= 0;
      if (it.kind === 'medkit') {
        // Ready: hovering and turning over a soft ring; taken: gone until it respawns.
        it.root.visible = ready;
        it.box.rotation.y += dt * 0.8;
        it.box.position.y = 0.42 + Math.sin(this.time * 2 + i) * 0.04;
        return;
      }
      if (ready) it.dish.rotation.y += dt * 2.2;
      it.orb.material = ready ? this.mat.coreReady : this.mat.coreSpent;
      it.beam.visible = ready;
    });
  }

  /** Match the drawn items to the list: new ids get an item, missing ones are removed. */
  private sync(pickups: readonly PickupState[]): void {
    const seen = new Set<string>();
    for (const p of pickups) {
      seen.add(p.id);
      let it = this.items.get(p.id);
      if (it && it.kind !== viewKind(p)) {
        this.remove(p.id, it);
        it = undefined;
      }
      if (!it) {
        it = viewKind(p) === 'medkit' ? this.makeMedkit() : this.makeUplink();
        this.items.set(p.id, it);
        this.group.add(it.root);
      }
      it.root.position.set(p.pos.x, p.pos.y, p.pos.z);
    }
    for (const [id, it] of this.items) if (!seen.has(id)) this.remove(id, it);
  }

  private remove(id: string, it: Item): void {
    it.root.removeFromParent();
    if (it.kind === 'medkit') this.medkitBoxes.delete(it.box);
    this.items.delete(id);
  }

  private makeUplink(): Extract<Item, { kind: 'uplink' }> {
    const root = new THREE.Group();
    const ped = new THREE.Mesh(this.geo.ped, this.mat.base);
    ped.position.y = 0.45;
    const dish = new THREE.Group();
    dish.position.y = 1.15;
    const bowl = new THREE.Mesh(this.geo.bowl, this.mat.dish);
    bowl.rotation.x = Math.PI / 2.4;
    const mast = new THREE.Mesh(this.geo.mast, this.mat.dish);
    mast.position.y = -0.2;
    dish.add(bowl, mast);
    const orb = new THREE.Mesh(this.geo.orb, this.mat.coreReady);
    orb.position.y = 1.2;
    const beam = new THREE.Mesh(this.geo.beam, this.mat.beam);
    beam.position.y = 7;
    for (const m of [ped, bowl, mast]) m.castShadow = true;
    root.add(ped, dish, orb, beam);
    return { kind: 'uplink', root, dish, orb, beam };
  }

  private makeMedkit(): Extract<Item, { kind: 'medkit' }> {
    const root = new THREE.Group();
    const box = new THREE.Group();
    box.position.y = 0.42;
    this.fillMedkitBox(box);
    this.medkitBoxes.add(box);
    const ring = new THREE.Mesh(this.geo.ring, this.mat.ring);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    root.add(box, ring);
    return { kind: 'medkit', root, box, ring };
  }

  /** The loaded case if there is one, else the stand-in (both from shared geometry/materials). */
  private fillMedkitBox(box: THREE.Group): void {
    box.clear();
    const model = this.medkitModel;
    if (model) {
      model.geometry.computeBoundingBox();
      const bb = model.geometry.boundingBox!;
      const k = MEDKIT_WIDTH / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
      const m = new THREE.Mesh(model.geometry, model.material);
      m.scale.setScalar(k);
      m.position.y = -((bb.min.y + bb.max.y) / 2) * k;
      m.castShadow = true;
      box.add(m);
      return;
    }
    const body = new THREE.Mesh(this.geo.body, this.mat.case);
    const bar1 = new THREE.Mesh(this.geo.bar1, this.mat.plus);
    const bar2 = new THREE.Mesh(this.geo.bar2, this.mat.plus);
    bar1.position.y = bar2.position.y = 0.176;
    body.castShadow = true;
    box.add(body, bar1, bar2);
  }
}
