import * as THREE from 'three';
import { humanoidHitboxes, KNIFE, KNIFE_DEFENSE, type PlayerState } from '@wd/shared';
import type { KnifeModel } from './knifeModel.ts';
import { Soldier, type SoldierKit, type SoldierPose } from './soldiers.ts';

const lerp = THREE.MathUtils.lerp;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (k: number): number => k * k * (3 - 2 * k);

/** A direction in the fighter's facing frame: forward, right (the fighter's own), up. */
export type FacingDir = readonly [f: number, r: number, u: number];

/** Where an arm points: shoulder → elbow and elbow → wrist, in the facing frame. */
export interface ArmPose {
  upper: FacingDir;
  fore: FacingDir;
}

/**
 * Everything the partner's body shows about its knife state (pure: from the PlayerState only).
 * The pose *is* the knife-defense tell — the opening strike's chamber (a big, readable arm raise
 * with a blade glint), the swing, the forearm guard and the stagger after a parry/guard break.
 */
export interface PartnerPose {
  /** Right arm (knife hand). */
  knife: ArmPose;
  /** Left arm (guard hand). */
  off: ArmPose;
  /** Blade glint 0–1: only the opening strike's chamber flashes (follow-ups/counters don't). */
  glint: number;
  /** Forearm guard up (Block held). */
  guard: boolean;
  /** Stagger 0–1 while stunned (parried = shoved, or guard broken). */
  stagger: number;
  /** The current wind-up is the opening chamber (the tell a defender reads). */
  chambering: boolean;
}

// Arm poses (facing frame). Lengths don't matter; the skeleton keeps its own bone lengths.
const READY_R: ArmPose = { upper: [0.35, 0.2, -0.9], fore: [0.85, -0.05, 0.45] };
const READY_L: ArmPose = { upper: [0.45, -0.15, -0.85], fore: [0.8, 0.25, 0.5] };
/** Blocking: the left forearm raised across in front of the face, the knife pulled in. */
const GUARD_L: ArmPose = { upper: [0.7, -0.5, 0.35], fore: [0.2, 0.95, 0.3] };
const GUARD_R: ArmPose = { upper: [0.2, 0.3, -0.9], fore: [0.65, -0.25, 0.6] };
/** Stunned: arms thrown out and down, off balance. */
const FLAIL_R: ArmPose = { upper: [-0.2, 0.6, -0.75], fore: [0.3, 0.6, 0.3] };
const FLAIL_L: ArmPose = { upper: [-0.2, -0.6, -0.75], fore: [0.3, -0.6, 0.3] };

type Move = PlayerState['arsenal']['melee']['move'];
/** Per move: the chamber (drawn back/up), the extension it swings through, and its end. */
const STRIKES: Record<Move, { chamber: ArmPose; extend: ArmPose; end: ArmPose }> = {
  // Right → left: knife cocked high over the right shoulder, cut across and down.
  slash: {
    chamber: { upper: [-0.35, 0.75, 0.45], fore: [-0.15, 0.25, 0.95] },
    extend: { upper: [0.95, 0.1, 0.15], fore: [1, -0.1, 0.1] },
    end: { upper: [0.7, -0.45, -0.4], fore: [0.45, -0.85, -0.25] },
  },
  // Left → right: knife cocked by the left ear, cut back across.
  backhand: {
    chamber: { upper: [0.45, -0.55, 0.35], fore: [-0.2, -0.55, 0.8] },
    extend: { upper: [0.95, -0.05, 0.15], fore: [1, 0.1, 0.1] },
    end: { upper: [0.55, 0.7, -0.2], fore: [0.4, 0.9, 0.05] },
  },
  // Thrust: hand pulled back to the hip, then driven straight out.
  thrust: {
    chamber: { upper: [-0.6, 0.3, -0.75], fore: [0.95, 0, 0.25] },
    extend: { upper: [0.97, 0.05, -0.05], fore: [1, 0, 0.05] },
    end: { upper: [0.97, 0.05, -0.1], fore: [1, 0, 0.05] },
  },
};

const mixDir = (a: FacingDir, b: FacingDir, k: number): FacingDir => [
  lerp(a[0], b[0], k),
  lerp(a[1], b[1], k),
  lerp(a[2], b[2], k),
];
export const mixArm = (a: ArmPose, b: ArmPose, k: number): ArmPose => ({
  upper: mixDir(a.upper, b.upper, k),
  fore: mixDir(a.fore, b.fore, k),
});

/** Upper arm and forearm lengths (m, game scale) used by `handOffset` (tests, tuning). */
export const ARM = { upper: 0.29, fore: 0.27 };

/** The hand relative to the shoulder (facing frame, metres) for an arm pose. */
export function handOffset(arm: ArmPose): [number, number, number] {
  const n = (d: FacingDir): number => Math.hypot(d[0], d[1], d[2]) || 1;
  const nu = n(arm.upper);
  const nf = n(arm.fore);
  return [0, 1, 2].map(
    (i) => (arm.upper[i]! / nu) * ARM.upper + (arm.fore[i]! / nf) * ARM.fore,
  ) as [number, number, number];
}

/** The opening strike's wind-up (the chamber tell) is longer than a follow-up's. */
export const isOpeningChamber = (windupTotal: number): boolean => windupTotal > KNIFE.windup + 1e-6;

/** Map the partner's knife state to its body pose (pure; presentation only). */
export function partnerPose(state: PlayerState): PartnerPose {
  const a = state.arsenal;
  const m = a.melee;
  let knife = READY_R;
  let off = READY_L;
  let glint = 0;
  let chambering = false;
  const strike = STRIKES[m.move];
  if (m.phase === 'windup') {
    const k = clamp01(1 - m.timer / Math.max(1e-6, m.windupTotal));
    // The arm is up within ~40 % of the wind-up and held: the tell reads for most of 0.22 s.
    knife = mixArm(READY_R, strike.chamber, smooth(Math.min(1, k * 2.5)));
    chambering = isOpeningChamber(m.windupTotal);
    glint = chambering ? k : 0;
  } else if (m.phase === 'recover') {
    const total = KNIFE.recovery + (m.quick ? KNIFE.quickMeleeExtra : 0);
    const k = clamp01(1 - m.timer / total);
    const swing = Math.min(1, k * 4);
    const back = smooth(clamp01((k - 0.3) / 0.7));
    const cut =
      swing < 0.5
        ? mixArm(strike.chamber, strike.extend, swing * 2)
        : mixArm(strike.extend, strike.end, (swing - 0.5) * 2);
    knife = mixArm(cut, READY_R, back);
  }
  const guard = a.guard.held;
  if (guard) {
    off = GUARD_L;
    if (m.phase === 'idle') knife = GUARD_R;
  }
  const stagger = a.stun > 0 ? clamp01(a.stun / KNIFE_DEFENSE.parryStun) : 0;
  if (stagger > 0) {
    knife = mixArm(knife, FLAIL_R, stagger * 0.7);
    off = mixArm(off, FLAIL_L, stagger * 0.7);
  }
  return { knife, off, glint, guard, stagger, chambering };
}

/** The soldier animation input for the partner, from its PlayerState like a remote player's. */
export function partnerSoldierPose(
  cur: PlayerState,
  prev: PlayerState,
  alpha: number,
): SoldierPose {
  const p = cur.move.pos;
  const o = prev.move.pos;
  const mv = cur.move;
  return {
    x: lerp(o.x, p.x, alpha),
    y: lerp(o.y, p.y, alpha),
    z: lerp(o.z, p.z, alpha),
    yaw: cur.view.yaw,
    pitch: cur.view.pitch,
    crouched: mv.crouched,
    grounded: mv.grounded,
    sprinting: mv.sprinting,
    riding: mv.board,
    prone: mv.prone,
    sliding: mv.sliding,
    alive: cur.health > 0,
    // Flinches on a hit like everyone. Its knife actions stay on the procedural arm overlay (the
    // tuned chamber tells), so no action layer is passed.
    hp: cur.health,
  };
}

const UP = new THREE.Vector3(0, 1, 0);

/** Facing-frame direction → world direction for a camera-style yaw (yaw 0 faces -Z). */
export function facingToWorld(d: FacingDir, yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return out.set(d[0] * fx + d[1] * rx, d[2], d[0] * fz + d[1] * rz).normalize();
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Quaternion();
const tmpInv = new THREE.Quaternion();
const tmpSQ = new THREE.Quaternion();
const tmpAx = new THREE.Vector3();
const tmpAx2 = new THREE.Vector3();
const tmpH = new THREE.Vector3();
const tmpF = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpFore = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Turn `bone` (in world space) so it points from its head toward `child`'s head along `dir`.
 * Matrices must be current; updates the bone's subtree after.
 */
function pointBone(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3): void {
  bone.getWorldPosition(tmpA);
  child.getWorldPosition(tmpB);
  const cur = tmpB.sub(tmpA);
  if (cur.lengthSq() < 1e-10) return;
  cur.normalize();
  tmpQ.setFromUnitVectors(cur, dir);
  bone.parent!.getWorldQuaternion(tmpP);
  // World-space delta onto the local rotation: Qp⁻¹ · q · Qp · Ql.
  bone.quaternion.premultiply(tmpInv.copy(tmpP).invert().multiply(tmpQ).multiply(tmpP));
  bone.updateMatrixWorld(true);
}

export interface ArmBones {
  upper: THREE.Object3D;
  fore: THREE.Object3D;
  hand: THREE.Object3D;
  /** A finger root: hand → finger gives the palm direction (knife seat). */
  finger: THREE.Object3D;
}

/** The Rocketbox biped's arm chain (`side` 'R' | 'L'); null if the skeleton lacks it. */
export function armBones(model: THREE.Object3D, side: 'R' | 'L'): ArmBones | null {
  const get = (n: string): THREE.Object3D | undefined =>
    model.getObjectByName(`Bip01_${side}_${n}`);
  const upper = get('UpperArm');
  const fore = get('Forearm');
  const hand = get('Hand');
  const finger = get('Finger2');
  return upper && fore && hand && finger ? { upper, fore, hand, finger } : null;
}

/**
 * Procedural overlay: pose an arm (after the clip and the spine aim) toward an ArmPose, blended
 * with what the clip drew by `weight`. Bone lengths come from the skeleton.
 */
function aimBone(
  bone: THREE.Object3D,
  child: THREE.Object3D,
  d: FacingDir,
  yaw: number,
  w: number,
): void {
  facingToWorld(d, yaw, tmpT);
  if (w < 1) {
    bone.getWorldPosition(tmpA);
    child.getWorldPosition(tmpB);
    const cur = tmpB.sub(tmpA).normalize();
    tmpT.lerp(cur, 1 - w).normalize();
  }
  pointBone(bone, child, tmpT); // pointBone uses tmpA/tmpB/tmpQ/tmpP only, never tmpT
}

export function poseArm(bones: ArmBones, arm: ArmPose, yaw: number, weight = 1): void {
  if (weight <= 0) return;
  const w = clamp01(weight);
  aimBone(bones.upper, bones.fore, arm.upper, yaw, w);
  aimBone(bones.fore, bones.hand, arm.fore, yaw, w);
}

/** The procedural combat knife (grip at the origin, blade along +Z). */
function buildKnife(bladeMat: THREE.MeshStandardMaterial): THREE.Group {
  const g = new THREE.Group();
  g.name = 'partner-knife';
  const grip = new THREE.MeshStandardMaterial({ color: '#1b1d20', roughness: 0.7 });
  const steel = new THREE.MeshStandardMaterial({
    color: '#4a4f55',
    roughness: 0.35,
    metalness: 0.9,
  });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.11, 10), grip);
  handle.rotation.x = Math.PI / 2;
  handle.position.z = -0.01;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.06, 0.012), steel);
  guard.position.z = 0.05;
  // Tapered single-edge blade: a box squeezed to a point.
  const bladeGeo = new THREE.BoxGeometry(0.007, 0.038, 0.2, 1, 1, 4);
  const pos = bladeGeo.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = clamp01((z + 0.1) / 0.2); // 0 at the guard → 1 at the tip
    const taper = 1 - t * t * 0.9;
    pos.setY(i, pos.getY(i) * taper + (pos.getY(i) > 0 ? 0 : t * t * 0.012));
  }
  bladeGeo.computeVertexNormals();
  const blade = new THREE.Mesh(bladeGeo, bladeMat);
  blade.position.z = 0.056 + 0.1;
  for (const m of [handle, guard, blade]) m.castShadow = true;
  g.add(handle, guard, blade);
  return g;
}

/**
 * Sparring partner body. With the soldier kit loaded it is a Rocketbox soldier (like dummies and
 * remote players) driven from its PlayerState, holding a knife, its arms posed procedurally over
 * the clips by `partnerPose` (the chamber, swing, guard and stagger tells). Before that — or if
 * the soldiers fail to load — it is the capsule figure built from the same humanoid hit volumes.
 * Either way the hit volumes stay the shared ones: render never decides outcomes.
 */
export class PartnerView {
  readonly group = new THREE.Group();
  /** Capsule fallback figure (positioned at the partner). */
  private readonly figure = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly shoulder = new THREE.Group();
  private readonly blade: THREE.Mesh;
  private readonly bladeMat: THREE.MeshStandardMaterial;
  private readonly guardArm: THREE.Mesh;
  private flash = 0;
  private readonly parts: THREE.Mesh[] = [];
  // Soldier path.
  private soldier: Soldier | null = null;
  private arms: { r: ArmBones; l: ArmBones } | null = null;
  private knife: THREE.Group | null = null;
  /** The seax model (render/knifeModel.ts), if loaded before the soldiers. */
  private knifeModel: KnifeModel | null = null;
  private knifeMat = new THREE.MeshStandardMaterial({
    name: 'partner:blade',
    color: '#e2e7eb',
    // Satin steel: pure mirror metal went dark against the sky/IBL and hid the knife.
    roughness: 0.3,
    metalness: 0.6,
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0,
  });
  /** Guard blend (eased so the forearm rises, not pops). */
  private guardW = 0;
  /** The last pose drawn (tests, debug). */
  lastPose: PartnerPose | null = null;

  constructor() {
    this.group.name = 'sparring-partner';
    const cloth = new THREE.MeshStandardMaterial({ color: '#27364a', roughness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: '#d9b894', roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: '#2a2d31', roughness: 0.85 });
    for (const s of humanoidHitboxes({ x: 0, y: 0, z: 0 }, 1.62)) {
      const mat = s.zone === 'head' ? skin : s.zone === 'torso' ? cloth : pants;
      const geo =
        s.kind === 'sphere'
          ? new THREE.SphereGeometry(s.r, 20, 14)
          : new THREE.CapsuleGeometry(
              s.r,
              Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z),
              6,
              14,
            );
      const m = new THREE.Mesh(geo, mat.clone());
      m.position.set((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, (s.a.z + s.b.z) / 2);
      m.castShadow = true;
      this.body.add(m);
      this.parts.push(m);
    }
    // Knife arm, pivoting at the right shoulder. Local -Z is "forward" for the body.
    this.shoulder.position.set(0.27, 1.38, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.5, 4, 10), cloth);
    upper.rotation.x = Math.PI / 2;
    upper.position.set(0, 0, -0.28);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), skin);
    hand.position.set(0, 0, -0.58);
    this.bladeMat = new THREE.MeshStandardMaterial({
      color: '#aeb6bd',
      roughness: 0.2,
      metalness: 0.95,
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 0,
    });
    this.blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.035, 0.2), this.bladeMat);
    this.blade.position.set(0, 0.02, -0.72);
    for (const m of [upper, hand, this.blade]) m.castShadow = true;
    this.shoulder.add(upper, hand, this.blade);
    // Guard forearm (left arm raised across the face) — shown only while guarding.
    this.guardArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.42, 4, 10), cloth);
    this.guardArm.position.set(-0.05, 1.55, -0.3);
    this.guardArm.rotation.set(0, 0, 1.2);
    this.guardArm.visible = false;
    this.body.add(this.shoulder, this.guardArm);
    this.figure.add(this.body);
    this.group.add(this.figure);
    this.group.visible = false; // only shown while a partner exists (see Game)
  }

  /** Whether the soldier model is drawn (false = capsule fallback). */
  get usesSoldier(): boolean {
    return this.soldier !== null;
  }

  /**
   * Draw a Rocketbox soldier (render/soldiers.ts) instead of the capsule figure. Called before
   * warm-up, so its programs compile with everything else. Its rifle is left off (knife only).
   */
  useSoldiers(kit: SoldierKit): void {
    const soldier = new Soldier({ ...kit, guns: {} }, 1); // its own knife, no mounted weapons
    const r = armBones(soldier.root, 'R');
    const l = armBones(soldier.root, 'L');
    if (!r || !l) {
      console.warn('partner: soldier skeleton lacks arm bones, keeping the capsule figure');
      return;
    }
    this.soldier = soldier;
    this.arms = { r, l };
    this.knife = this.knifeModel ? this.modelKnife(this.knifeModel) : buildKnife(this.knifeMat);
    this.figure.visible = false;
    this.group.add(soldier.root, this.knife);
  }

  /** Hold the seax model instead of the procedural knife (call before `useSoldiers`). */
  useKnifeModel(model: KnifeModel): void {
    this.knifeModel = model;
  }

  /** The model in the partner's knife frame (grip at the origin, blade along +Z), with its own
   * material copy for the chamber glint (emissive, intensity driven per frame). */
  private modelKnife(model: KnifeModel): THREE.Group {
    const g = new THREE.Group();
    g.name = 'partner-knife';
    const mat = model.material.clone();
    mat.name = 'partner:knife';
    mat.emissive.set('#ffffff');
    mat.emissiveIntensity = 0;
    this.knifeMat = mat;
    const mesh = new THREE.Mesh(model.geometry, mat);
    mesh.rotation.y = Math.PI; // model blade -Z -> +Z, edge stays down
    mesh.castShadow = true;
    g.add(mesh);
    return g;
  }

  hitFlash(): void {
    this.flash = 1;
    if (this.soldier) this.soldier.flash = 1;
  }

  update(dt: number, cur: PlayerState, prev: PlayerState, alpha: number, time: number): void {
    const alive = cur.health > 0;
    const pose = partnerPose(cur);
    this.lastPose = pose;
    if (this.soldier) {
      this.updateSoldier(dt, cur, prev, alpha, time, pose);
      return;
    }
    this.group.visible = alive;
    if (!alive) return;
    const p = cur.move.pos;
    const o = prev.move.pos;
    this.figure.position.set(lerp(o.x, p.x, alpha), lerp(o.y, p.y, alpha), lerp(o.z, p.z, alpha));
    this.figure.rotation.y = cur.view.yaw;
    // Crouch squash, like the hit volumes.
    this.body.scale.y = cur.move.eyeHeight / 1.62;

    const a = cur.arsenal;
    const m = a.melee;
    // Arm pose: rest → chamber (drawn back + up) → swing across → rest.
    let pitch = -0.25; // arm slightly lowered at rest
    let yaw = 0.15;
    if (m.phase === 'windup') {
      const k = clamp01(1 - m.timer / m.windupTotal);
      if (m.move === 'thrust') {
        pitch = lerp(-0.25, 0.05, k);
        this.shoulder.position.z = lerp(0, 0.18, k); // pull the elbow back
      } else {
        pitch = lerp(-0.25, 0.9, k); // raise
        yaw = lerp(0.15, m.move === 'slash' ? 0.9 : -0.6, k); // cock to the side
      }
    } else if (m.phase === 'recover') {
      const total = KNIFE.recovery + (m.quick ? KNIFE.quickMeleeExtra : 0);
      const k = clamp01(1 - m.timer / total);
      const swing = Math.min(1, k * 4);
      const back = clamp01((k - 0.3) / 0.7);
      if (m.move === 'thrust') {
        pitch = 0;
        this.shoulder.position.z = lerp(-0.2 * swing, 0, back);
      } else {
        pitch = lerp(lerp(0.9, -0.3, swing), -0.25, back);
        yaw = lerp(
          lerp(m.move === 'slash' ? 0.9 : -0.6, m.move === 'slash' ? -0.9 : 0.8, swing),
          0.15,
          back,
        );
      }
    } else {
      this.shoulder.position.z = 0;
    }
    this.shoulder.rotation.set(pitch, yaw, 0);
    this.guardArm.visible = pose.guard;
    this.bladeMat.emissiveIntensity = pose.glint * 1.5; // the opening chamber flashes

    // Stunned: stagger / wobble.
    this.body.rotation.z = pose.stagger > 0 ? Math.sin(time * 18) * 0.12 * pose.stagger : 0;

    this.flash = Math.max(0, this.flash - dt * 8);
    for (const part of this.parts) {
      (part.material as THREE.MeshStandardMaterial).emissive.setScalar(this.flash * 0.6);
    }
  }

  private updateSoldier(
    dt: number,
    cur: PlayerState,
    prev: PlayerState,
    alpha: number,
    time: number,
    pose: PartnerPose,
  ): void {
    const soldier = this.soldier!;
    const arms = this.arms!;
    const knife = this.knife!;
    // Soldiers stay while dead: the death clip plays until the respawn (like remote players).
    this.group.visible = true;
    const sp = partnerSoldierPose(cur, prev, alpha);
    // Stagger: a wobbling roll plus a lean back (the shove after a parry reads from the sim's
    // pushback velocity itself). Rolled/tilted on the root, about the feet.
    soldier.root.rotation.set(0, 0, 0);
    if (sp.alive && pose.stagger > 0) {
      const yaw = sp.yaw;
      const wobble = Math.sin(time * 18) * 0.1 * pose.stagger;
      const back = -0.14 * pose.stagger;
      // Tilt about the facing's right axis (lean back) and forward axis (wobble).
      soldier.root.quaternion
        .setFromAxisAngle(tmpAx.set(Math.cos(yaw), 0, -Math.sin(yaw)), back)
        .multiply(tmpSQ.setFromAxisAngle(facingToWorld([1, 0, 0], yaw, tmpAx2), wobble));
    }
    soldier.update(sp, dt);
    knife.visible = sp.alive;
    if (!sp.alive) return;
    soldier.root.updateWorldMatrix(true, true);
    this.guardW += ((pose.guard ? 1 : 0) - this.guardW) * Math.min(1, dt * 30);
    const off = mixArm(READY_L, pose.off, pose.guard ? this.guardW : 1);
    // Riding / prone keep the clip's arms (the partner does neither today; stay safe).
    const overlay = sp.riding || sp.prone ? 0 : 1;
    poseArm(arms.r, pose.knife, sp.yaw, overlay);
    poseArm(arms.l, off, sp.yaw, overlay);
    this.seatKnife(knife, arms.r, facingToWorld(pose.knife.fore, sp.yaw, tmpFore));
    // Glint: the opening chamber flashes the blade (bloom picks it up on Medium+).
    this.knifeMat.emissiveIntensity = pose.glint * 3;
  }

  /** Knife in the right fist (forward grip): grip at the palm, blade tipped up off the forearm. */
  private seatKnife(knife: THREE.Group, r: ArmBones, fore: THREE.Vector3): void {
    const hand = r.hand.getWorldPosition(tmpH);
    const palm = r.finger.getWorldPosition(tmpF).sub(hand);
    knife.position.copy(hand).addScaledVector(palm, 0.6);
    const dir = tmpD.copy(fore).addScaledVector(UP, 0.9).normalize();
    knife.quaternion.setFromUnitVectors(Z_AXIS, dir);
  }
}
