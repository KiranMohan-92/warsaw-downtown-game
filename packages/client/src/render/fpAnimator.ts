/**
 * Plays render/fpAnims.ts clips on one scanned gun's rig (moving parts + skinned arms): picks the
 * clip from the viewmodel state (reload > overheat vent > shotgun pump > inspect), evaluates it,
 * moves the parts, solves both arms onto their keyed wrist targets (shoulders pinned to the body
 * while the gun turns) and reports the foley cues crossed this frame. Presentation only.
 */
import * as THREE from 'three';
import {
  cuesBetween,
  evalClip,
  inspectClip,
  partMatrix,
  pumpShotClip,
  reloadClip,
  ventClip,
  type Clip,
  type ClipPose,
  type Cue,
  type HandPose,
  type V6,
} from './fpAnims.ts';
import type { GunRig } from './viewGunScans.ts';
import type { ArmTargets } from './fpRig.ts';

export type ClipKind = 'reload' | 'reloadEmpty' | 'vent' | 'pump' | 'inspect';

export interface AnimInput {
  /** Reload progress 0..1, or −1. */
  reload: number;
  reloadEmpty: boolean;
  /** Overheat lockout progress 0..1 (ARC), or −1. */
  vent: number;
  ventLockout: number;
  /** Magazine empty and not reloading: the pistol's slide stays locked back. */
  magEmpty: boolean;
}

export interface AnimOutput {
  /** Gun offset in camera space [x, y, z, pitch, yaw, roll]. */
  gun: V6;
  /** Pin weight for the shoulders (0 = arms ride with the gun). */
  pin: number;
  cues: Cue[];
  active: ClipKind | null;
}

const ZERO6: V6 = [0, 0, 0, 0, 0, 0];

// Frame-loop scratch for falling parts (no per-frame allocation).
const DROP_OFF = new THREE.Matrix4();
const DROP_POS = new THREE.Vector3();
const DROP_Q = new THREE.Quaternion();
const DROP_SPIN = new THREE.Quaternion();
const DROP_E = new THREE.Euler();
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

export class FpAnimator {
  private readonly clips = new Map<ClipKind, Clip | null>();
  private kind: ClipKind | null = null;
  private t = 0;
  /** Self-timed clips (pump after a shot, inspect): elapsed seconds, −1 = off. */
  private pumpT = -1;
  private inspectT = -1;
  private readonly drops: {
    mesh: THREE.Mesh;
    vel: THREE.Vector3;
    spin: THREE.Vector3;
    life: number;
    m: THREE.Matrix4;
  }[] = [];
  private dropped = false;
  private slideKick = 0;
  private time = 0;
  /** Last evaluated pose (tests / debug). */
  pose: ClipPose | null = null;
  /** Debug scrub (proof frames): force a clip at a fixed normalised time. */
  scrub: { kind: ClipKind; t: number } | null = null;

  constructor(readonly rig: GunRig) {}

  clip(kind: ClipKind, lockout = 1.6): Clip | null {
    if (!this.clips.has(kind)) {
      const id = this.rig.id;
      const c =
        kind === 'reload'
          ? reloadClip(id, false)
          : kind === 'reloadEmpty'
            ? reloadClip(id, true)
            : kind === 'vent'
              ? this.rig.parts.has('vent')
                ? ventClip(lockout)
                : null
              : kind === 'pump'
                ? this.rig.parts.has('pump')
                  ? pumpShotClip()
                  : null
                : inspectClip(id);
      this.clips.set(kind, c);
    }
    return this.clips.get(kind) ?? null;
  }

  /** A shot: the pistol's slide cycles, the shotgun racks its pump. */
  fired(): void {
    if (this.rig.parts.has('slide')) this.slideKick = 1;
    if (this.rig.parts.has('pump')) {
      this.pumpT = 0;
      this.inspectT = -1;
    }
  }

  /** Start the inspect (ignored while another clip plays). */
  inspect(): boolean {
    if (this.kind && this.kind !== 'inspect') return false;
    this.inspectT = 0;
    return true;
  }

  /** Stop self-timed clips (switching away, firing, aiming, sprinting interrupt an inspect). */
  cancelInspect(): void {
    this.inspectT = -1;
  }

  /**
   * The gun went away (switched out): clear everything self-timed or in flight. A hidden
   * animator gets no updates, so a dropped magazine would otherwise freeze mid-air and fall again
   * when the gun comes back, and a pending pump would rack on the next draw.
   */
  holster(): void {
    this.inspectT = -1;
    this.pumpT = -1;
    for (const d of this.drops) d.mesh.visible = false;
    this.drops.length = 0;
  }

  get inspecting(): boolean {
    return this.inspectT >= 0;
  }

  update(dt: number, s: AnimInput): AnimOutput {
    this.time += dt;
    let kind: ClipKind | null = null;
    let t = 0;
    if (this.scrub) {
      kind = this.scrub.kind;
      t = this.scrub.t;
    } else if (s.reload >= 0) {
      kind = s.reloadEmpty ? 'reloadEmpty' : 'reload';
      t = s.reload;
      this.inspectT = -1;
      // An empty reload racks the pump itself: a pump still pending from the last shot is
      // consumed, else it would rack a second time afterwards. A tactical reload never racks, so
      // the shot's pending pump is kept and plays when the reload is done.
      if (s.reloadEmpty) this.pumpT = -1;
    } else if (s.vent >= 0 && this.clip('vent', s.ventLockout)) {
      kind = 'vent';
      t = s.vent;
    } else if (this.pumpT >= 0) {
      this.pumpT += dt;
      const c = this.clip('pump');
      if (!c || this.pumpT >= c.duration) this.pumpT = -1;
      else {
        kind = 'pump';
        t = this.pumpT / c.duration;
      }
    } else if (this.inspectT >= 0) {
      this.inspectT += dt;
      const c = this.clip('inspect');
      if (!c || this.inspectT >= c.duration) this.inspectT = -1;
      else {
        kind = 'inspect';
        t = this.inspectT / c.duration;
      }
    }
    const clip = kind ? this.clip(kind, s.ventLockout) : null;
    const cues: Cue[] = [];
    if (clip && kind === this.kind && !this.scrub) cues.push(...cuesBetween(clip, this.t, t));
    if (kind !== this.kind || t < this.t) this.dropped = false;
    this.kind = clip ? kind : null;
    this.t = t;
    const pose = clip ? evalClip(clip, t) : null;
    this.pose = pose;
    if (clip?.drop && t >= clip.drop.t && !this.dropped && !this.scrub) {
      this.dropped = true;
      this.spawnDrop(clip.drop.part, pose);
    }
    this.applyParts(pose, s, dt);
    this.stepDrops(dt);
    this.stepSteam(pose, dt);
    return {
      gun: pose?.gun ?? ZERO6,
      pin: clip?.pin ?? 0,
      cues,
      active: this.kind,
    };
  }

  private partMatrix(name: string, pose: ClipPose | null, out: THREE.Matrix4): THREE.Matrix4 {
    const part = this.rig.parts.get(name);
    if (!part) return out.identity();
    return partMatrix(pose?.parts[name], part.pivot, part.axis, out);
  }

  private applyParts(pose: ClipPose | null, s: AnimInput, dt: number): void {
    const m = new THREE.Matrix4();
    const off = new THREE.Matrix4().makeTranslation(this.rig.offset);
    this.slideKick = Math.max(0, this.slideKick - dt / 0.07);
    for (const [name, part] of this.rig.parts) {
      const pp = pose?.parts[name];
      let a = pp?.a ?? 0;
      // Pistol: slide blowback on each shot; locked back on an empty magazine.
      if (name === 'slide' && !pp)
        a = s.magEmpty ? 0.022 : 0.024 * Math.sin(Math.PI * this.slideKick);
      const p = pp
        ? { ...pp, a }
        : a
          ? {
              a,
              p: [0, 0, 0] as [number, number, number],
              r: [0, 0, 0] as [number, number, number],
              hide: false,
            }
          : undefined;
      partMatrix(p, part.pivot, part.axis, m);
      part.mesh.matrix.multiplyMatrices(m, off);
      part.mesh.visible = !(pp?.hide ?? false);
    }
    const arms = this.rig.arms;
    if (!arms) return;
    if (!pose) {
      arms.rest();
      if (this.rig.shell) this.rig.shell.visible = false;
      return;
    }
    const resolve = (
      side: 'L' | 'R',
      key: { space: string; p: [number, number, number]; r: [number, number, number] },
    ): { wrist: THREE.Vector3; hand: THREE.Quaternion } => {
      const bind = arms.pivots[side][2];
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(key.r[0], key.r[1], key.r[2]));
      if (key.space === 'bind')
        return {
          wrist: new THREE.Vector3(bind[0] + key.p[0], bind[1] + key.p[1], bind[2] + key.p[2]),
          hand: q,
        };
      if (key.space === 'gun') return { wrist: new THREE.Vector3(...key.p), hand: q };
      const part = this.rig.parts.get(key.space);
      if (!part) return { wrist: new THREE.Vector3(...bind), hand: q };
      const pm = this.partMatrix(key.space, pose, new THREE.Matrix4());
      const wrist = part.pivot
        .clone()
        .add(new THREE.Vector3(...key.p))
        .applyMatrix4(pm);
      return { wrist, hand: new THREE.Quaternion().setFromRotationMatrix(pm).multiply(q) };
    };
    const hand = (side: 'L' | 'R', h: HandPose | null): ArmTargets['L'] => {
      if (!h) return null;
      const to = resolve(side, h);
      if (!h.from || h.k >= 1) return to;
      const from = resolve(side, h.from);
      return {
        wrist: from.wrist.lerp(to.wrist, h.k),
        hand: from.hand.slerp(to.hand, h.k),
      };
    };
    this.targets = { L: hand('L', pose.L), R: hand('R', pose.R) };
    // Shotgun: a shell in the support hand between the belt and the port.
    if (this.rig.shell) {
      const L = pose.L;
      this.rig.shell.visible =
        this.kind === 'reload' || this.kind === 'reloadEmpty'
          ? L !== null && L.space === 'pump' && L.p[1] < -0.04
          : false;
    }
  }

  /** Arm targets of the current pose (the viewmodel adds the pinned shoulders and poses). */
  targets: ArmTargets = { L: null, R: null };

  private spawnDrop(name: string, pose: ClipPose | null): void {
    const part = this.rig.parts.get(name);
    if (!part?.drop) return;
    const m = this.partMatrix(name, pose, new THREE.Matrix4());
    this.drops.push({
      mesh: part.drop,
      m: m.clone(),
      // Out of the well and down (gun space; gravity pulls it off screen in ~0.4 s).
      vel: part.axis
        .clone()
        .multiplyScalar(0.9)
        .add(new THREE.Vector3(0.05, -0.2, 0.1)),
      spin: new THREE.Vector3(2.5, 0.8, 1.6),
      life: 0.7,
    });
    part.drop.visible = true;
  }

  private stepDrops(dt: number): void {
    if (!this.drops.length) return;
    const off = DROP_OFF.makeTranslation(this.rig.offset);
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i]!;
      d.life -= dt;
      d.vel.y -= 7 * dt;
      const pos = DROP_POS.setFromMatrixPosition(d.m);
      const q = DROP_Q.setFromRotationMatrix(d.m);
      q.premultiply(
        DROP_SPIN.setFromEuler(DROP_E.set(d.spin.x * dt, d.spin.y * dt, d.spin.z * dt)),
      );
      pos.addScaledVector(d.vel, dt);
      d.m.compose(pos, q, UNIT_SCALE);
      d.mesh.matrix.multiplyMatrices(d.m, off);
      if (d.life <= 0) {
        d.mesh.visible = false;
        this.drops.splice(i, 1);
      }
    }
  }

  private stepSteam(pose: ClipPose | null, dt: number): void {
    const steam = this.rig.steam;
    if (!steam.length) return;
    const vent = this.rig.parts.get('vent');
    const open =
      this.kind === 'vent' ? Math.min(1, Math.abs(pose?.parts.vent?.r[2] ?? 0) / 1.1) : 0;
    void dt;
    for (const m of steam) {
      const seed = (m.userData.seed as number) ?? 0;
      const phase = (this.time * 1.6 + seed / steam.length) % 1;
      m.visible = open > 0.05;
      if (!m.visible || !vent) continue;
      m.position
        .copy(vent.pivot)
        .add(new THREE.Vector3(0.02 + phase * 0.07, -0.02 + phase * 0.1, (seed - 2.5) * 0.02));
      m.scale.setScalar(0.5 + phase * 1.8);
      m.rotation.set(0, Math.PI / 2, seed + phase * 2);
      (m.material as THREE.MeshBasicMaterial).opacity =
        open * 0.3 * (1 - phase) * Math.min(1, phase * 6);
    }
  }
}
