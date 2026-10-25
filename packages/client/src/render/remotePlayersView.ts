import * as THREE from 'three';
import { humanoidHitboxes, MATCH_NET, SNAP_SLOTS, SnapFlag, snapshotProtected } from '@wd/shared';
import type { RemotePlayer } from '../net/onlineSession.ts';
import { Soldier, type SoldierKit } from './soldiers.ts';
import { heldWeapon } from './viewGunScans.ts';

/** One colour per match slot (torso + name tag), readable against the city palette. */
export const SLOT_COLORS = ['#d9534f', '#4f8ad9', '#e0b43a', '#5cb85c', '#a760d6', '#e07b39'];

const STAND_EYE = 1.62;

interface Figure {
  root: THREE.Group;
  body: THREE.Group;
  tag: THREE.Sprite;
  tagCanvas: HTMLCanvasElement;
  tagTexture: THREE.CanvasTexture;
  name: string;
  slot: number;
  soldier: Soldier | null;
  /** The torso material (own per slot): the capsule figure's protection tint. */
  cloth: THREE.MeshStandardMaterial;
}

/**
 * Other players in an online match (M3a): a humanoid built from the same hit volumes as the
 * dummies and the sparring partner (what you see is where they are), the torso in their slot
 * colour, a short "gun" so facing reads, and a name tag.
 *
 * Every figure is built up front (hidden) so `Game.warmUp` compiles its programs: nothing
 * compiles mid-match. Name tags are depth-tested (walls hide them) and shown only when the
 * caller says the player is in sight, so a tag never gives away someone hiding in foliage.
 */
export class RemotePlayersView {
  readonly group = new THREE.Group();
  private readonly figures: Figure[] = [];

  constructor() {
    this.group.name = 'remote-players';
    const skin = new THREE.MeshStandardMaterial({ color: '#d9b894', roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: '#2a2d31', roughness: 0.85 });
    const metal = new THREE.MeshStandardMaterial({ color: '#23262a', roughness: 0.4 });
    const shapes = humanoidHitboxes({ x: 0, y: 0, z: 0 }, STAND_EYE);
    for (let i = 0; i < MATCH_NET.maxPlayers; i++) {
      const cloth = new THREE.MeshStandardMaterial({
        color: SLOT_COLORS[i % SLOT_COLORS.length],
        roughness: 0.8,
      });
      const body = new THREE.Group();
      for (const s of shapes) {
        const mat = s.zone === 'head' ? skin : s.zone === 'torso' ? cloth : pants;
        const geo =
          s.kind === 'sphere'
            ? new THREE.SphereGeometry(s.r, 16, 12)
            : new THREE.CapsuleGeometry(
                s.r,
                Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z),
                4,
                12,
              );
        const m = new THREE.Mesh(geo, mat);
        m.position.set((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, (s.a.z + s.b.z) / 2);
        m.castShadow = true;
        body.add(m);
      }
      // A carried rifle pointing along the facing (-Z), at chest height.
      const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.7), metal);
      gun.position.set(0.18, 1.3, -0.35);
      gun.castShadow = true;
      body.add(gun);

      const tagCanvas = document.createElement('canvas');
      tagCanvas.width = 256;
      tagCanvas.height = 64;
      const tagTexture = new THREE.CanvasTexture(tagCanvas);
      tagTexture.colorSpace = THREE.SRGBColorSpace;
      const tag = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tagTexture, depthTest: true, transparent: true }),
      );
      tag.scale.set(1.2, 0.3, 1);
      tag.position.y = STAND_EYE + 0.55;
      tag.visible = false;

      const root = new THREE.Group();
      root.add(body, tag);
      root.visible = false;
      this.group.add(root);
      this.figures.push({
        root,
        body,
        tag,
        tagCanvas,
        tagTexture,
        name: '',
        slot: -1,
        soldier: null,
        cloth,
      });
    }
  }

  /** Draw realistic soldiers (render/soldiers.ts) instead of the hit-volume figures. */
  useSoldiers(kit: SoldierKit): void {
    this.figures.forEach((f, i) => {
      f.soldier = new Soldier(kit, i);
      f.soldier.root.visible = false;
      f.body.visible = false;
      this.group.add(f.soldier.root);
    });
  }

  private drawTag(f: Figure, name: string, slot: number): void {
    f.name = name;
    f.slot = slot;
    const ctx = f.tagCanvas.getContext('2d');
    if (!ctx) return;
    const { width: w, height: h } = f.tagCanvas;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '600 34px system-ui, sans-serif';
    const text = name.length > 16 ? `${name.slice(0, 15)}…` : name;
    const tw = Math.min(w - 8, ctx.measureText(text).width + 28);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.6)';
    ctx.fillRect((w - tw) / 2, 8, tw, h - 16);
    ctx.fillStyle = SLOT_COLORS[slot % SLOT_COLORS.length]!;
    ctx.fillRect((w - tw) / 2, h - 12, tw, 4);
    ctx.fillStyle = '#f2f4f7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 - 2);
    f.tagTexture.needsUpdate = true;
  }

  /**
   * Place every remote player. Figures are per match slot (0–5, unique in a match), so a
   * player's colour and tag stay put while they play. `tagVisible(p)` decides whether their
   * name tag shows (in sight).
   */
  /** The soldier drawing this player this frame (null: none / capsule figures). */
  soldierOf(id: string): Soldier | null {
    const slot = this.slotOf.get(id);
    const f = slot === undefined ? undefined : this.figures[slot];
    return f?.soldier?.root.visible ? f.soldier : null;
  }

  private readonly slotOf = new Map<string, number>();

  update(
    players: readonly RemotePlayer[],
    tagVisible: (p: RemotePlayer) => boolean,
    dt = 1 / 60,
  ): void {
    const shown = new Set<Figure>();
    this.slotOf.clear();
    for (const p of players) {
      this.slotOf.set(p.id, p.slot);
      const f = this.figures[p.slot];
      if (!f || shown.has(f)) continue;
      shown.add(f);
      if (f.name !== p.name || f.slot !== p.slot) this.drawTag(f, p.name, p.slot);
      const alive = p.pose.hp > 0;
      if (f.soldier) {
        // Soldiers stay while dead: the death clip plays until the respawn.
        f.soldier.root.visible = true;
        f.soldier.update(
          {
            x: p.pose.x,
            y: p.pose.y,
            z: p.pose.z,
            yaw: p.pose.yaw,
            pitch: p.pose.pitch,
            // In a truck: seated (the crouch clip, still, on the seat).
            crouched: (p.pose.f & SnapFlag.Crouched) !== 0 || p.pose.vh !== undefined,
            seated: p.pose.vh !== undefined,
            grounded: (p.pose.f & SnapFlag.Grounded) !== 0,
            sprinting: (p.pose.f & SnapFlag.Sprinting) !== 0,
            riding: (p.pose.f & SnapFlag.Board) !== 0,
            prone: (p.pose.f & SnapFlag.Prone) !== 0,
            sliding: (p.pose.f & SnapFlag.Sliding) !== 0,
            jetpack: (p.pose.f & SnapFlag.Jetpack) !== 0,
            flying: (p.pose.f & SnapFlag.JetFlight) !== 0,
            alive,
            weapon: heldWeapon(SNAP_SLOTS[p.pose.sl] ?? 'rifle', p.pose.primary),
            action: p.pose.action,
            hp: p.pose.hp,
            shielded: snapshotProtected(p.pose),
          },
          dt,
        );
      }
      f.root.visible = alive;
      // Fallback figures: a steady cyan glow on the torso while spawn-protected (a uniform).
      f.cloth.emissive.setRGB(0, 0, 0);
      if (alive && snapshotProtected(p.pose)) f.cloth.emissive.setRGB(0.05, 0.2, 0.25);
      if (!alive) continue;
      f.root.position.set(p.pose.x, p.pose.y, p.pose.z);
      f.root.rotation.y = p.pose.yaw;
      // Crouch squash, like the hit volumes (eye height scales the humanoid).
      f.body.scale.y = p.pose.eye / STAND_EYE;
      f.tag.position.y = p.pose.eye + 0.55;
      f.tag.visible = tagVisible(p);
      // A sprinting player leans forward a touch, a sliding one back (reads at distance).
      f.body.rotation.x =
        (p.pose.f & SnapFlag.Sprinting) !== 0
          ? -0.12
          : (p.pose.f & SnapFlag.Sliding) !== 0
            ? 0.3
            : 0;
    }
    for (const f of this.figures) {
      if (shown.has(f)) continue;
      f.root.visible = false;
      if (f.soldier) f.soldier.root.visible = false;
    }
  }

  /** Figures currently drawn (tests, debug). */
  get visibleCount(): number {
    return this.figures.filter((f) => f.root.visible).length;
  }
}
