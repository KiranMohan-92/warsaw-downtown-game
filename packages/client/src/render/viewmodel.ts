import * as THREE from 'three';
import { FEEL, type KnifeMove, type PrimaryId, type Slot } from '@wd/shared';
import { damp, Spring } from '../feel/spring.ts';
import { buildScannedGun, PRIMARY_SCANS, type ScanGunId, type ScanGuns } from './viewGunScans.ts';
import {
  buildCoilgun,
  buildGrenade,
  buildIskra,
  buildKnife,
  buildModelKnife,
  buildPistol,
  buildRifle,
  type GunModel,
  KNIFE_MODEL_AT,
  kickFlash,
} from './viewmodelModels.ts';
import type { KnifeAnchors, KnifeArms, KnifeModel } from './knifeModel.ts';
import { ArmRig, type ArmTargets } from './fpRig.ts';
import { BREATH, RECOIL, type Cue } from './fpAnims.ts';
import { FpAnimator, type ClipKind } from './fpAnimator.ts';

/** Overall viewmodel scale. */
const VM_SCALE = 0.85;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = THREE.MathUtils.lerp;
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** A timed hand action (knife swing or grenade throw), derived from the sim's timers. */
export interface HandAction {
  elapsed: number;
  windup: number;
  total: number;
}

export interface ViewmodelState {
  /** Weapon shown (the one being raised during a switch). */
  slot: Slot;
  /** 0 = just started raising, 1 = fully up. */
  switchProgress: number;
  adsAmount: number;
  sprinting: boolean;
  /** Lying prone: the gun rests lower on the elbows; crawling carries it canted away. */
  prone?: boolean;
  /** Sliding: the gun tucks in low and cants with the lean. */
  sliding?: boolean;
  /** 0..1 reload progress, or -1 when not reloading. */
  reload: number;
  /** The reload in progress started from an empty magazine (bolt / slide release at the end). */
  reloadEmpty?: boolean;
  /** Magazine empty (pistol slide locks back). */
  magEmpty?: boolean;
  /** Energy weapon overheat lockout progress 0..1 (vent clip), or -1; and its length (s). */
  vent?: number;
  ventLockout?: number;
  speed: number;
  grounded: boolean;
  lookDx: number;
  lookDy: number;
  bob: boolean;
  melee: (HandAction & { quick: boolean; move: KnifeMove }) | null;
  /** Forearm guard raised. */
  guard: boolean;
  /** Stunned (parried / guard broken): hands shake. */
  stunned: boolean;
  throw: HandAction | null;
}

const KNIFE_IDLE = {
  // Pulled back 1.5 cm for the seax (its tip reaches 3.5 cm further than the old blade's).
  p: new THREE.Vector3(0.13, -0.14, -0.285),
  r: new THREE.Euler(0.35, 0.25, -0.35),
};
/** The knife's held pose as a matrix (camera space of the rig frame at rest: KNIFE_IDLE + scale). */
const KNIFE_HELD = new THREE.Matrix4().compose(
  KNIFE_IDLE.p,
  new THREE.Quaternion().setFromEuler(KNIFE_IDLE.r),
  new THREE.Vector3(VM_SCALE, VM_SCALE, VM_SCALE),
);
/** Block: the left wrist rises here (camera space), the forearm across the face. */
const GUARD_WRIST = new THREE.Vector3(-0.01, -0.06, -0.3);
const FWD_AXIS = new THREE.Vector3(0, 0, -1);
/** The knife's left fist stays up this long after a parry, through the counter (s). */
const OFF_HAND_HOLD = 0.7;
/** Where the knife's left fist goes when it lowers out of view (camera space, per unit drop). */
export const LEFT_DROP = new THREE.Vector3(0.02, -0.4, 0.06);
const SPRINT = { p: new THREE.Vector3(0.1, -0.21, -0.36), r: new THREE.Euler(-0.32, 0.75, 0.35) };
/** Blade points of the primitive knife (knife space): tip and mid-blade (trail ribbon). */
const BLADE_TIP = new THREE.Vector3(0, -0.004, -0.215);
const BLADE_MID = new THREE.Vector3(0, 0.0, -0.1);

/** Trail points for the seax model: its tip and edge anchors, moved to where the fist holds it. */
export function modelTrailPoints(a: KnifeAnchors): { tip: THREE.Vector3; mid: THREE.Vector3 } {
  const at = new THREE.Vector3(...KNIFE_MODEL_AT);
  return {
    tip: new THREE.Vector3(...a.tip).add(at),
    mid: new THREE.Vector3(...a.edge).add(at),
  };
}
const TRAIL_SAMPLES = 14;
/** How long a trail sample lives (s). */
const TRAIL_LIFE = 0.11;

/**
 * First-person weapons, rendered in their own scene/camera pass so they never clip into walls and
 * keep a fixed FOV. The sim decides *what* happens (switch, swing, throw, reload); this only
 * animates it: authored clips for reloads/inspect/vent (render/fpAnims.ts, played on the scans'
 * moving parts and skinned arms by render/fpAnimator.ts) plus procedural springs for handling.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(54, 1, 0.01, 10);
  private readonly root = new THREE.Group(); // pose blend
  private readonly gun = new THREE.Group(); // kick + sway on top of the pose
  private readonly guns: Record<'rifle' | 'sidearm', GunModel>;
  /** Every primary's model (all built up front, so switching loadout never compiles shaders). */
  private readonly primaries: Record<PrimaryId, GunModel>;
  /** Clip players per scanned gun (created with the scans). */
  private readonly animators = new Map<GunModel, FpAnimator>();
  /** Foley at animation keyframes (mag out, slap, bolt…): wired to Audio by the game. */
  onCue: (cue: Cue, gun: ScanGunId) => void = () => {};

  /**
   * Swap in the scanned guns (render/viewGunScans.ts) for the primitive ones. Call before
   * warm-up: the new materials compile there, and the old groups are dropped.
   */
  useScannedGuns(scans: ScanGuns): void {
    const swap = (old: GunModel, id: ScanGunId): GunModel => {
      const scan = scans.get(id);
      if (!scan) return old;
      const next = buildScannedGun(id, scan);
      next.group.visible = old.group.visible;
      this.gun.remove(old.group);
      this.gun.add(next.group);
      if (next.rig) this.animators.set(next, new FpAnimator(next.rig));
      return next;
    };
    const wasRifle = this.guns.rifle;
    for (const p of Object.keys(this.primaries) as PrimaryId[]) {
      const id = PRIMARY_SCANS[p];
      const old = this.primaries[p];
      this.primaries[p] = swap(old, id);
      if (wasRifle === old) this.guns.rifle = this.primaries[p];
    }
    this.guns.sidearm = swap(this.guns.sidearm, 'pistol');
  }

  /**
   * Swap in the seax knife model (render/knifeModel.ts) for the primitive blade, in both the
   * slot knife and the Q quick-knife; the trail follows its tip/edge anchors. Call before warm-up.
   * Every animation (idle, slashes, block tuck, parry) keeps driving the same groups' transforms.
   */
  useKnifeModel(model: KnifeModel, arms: KnifeArms | null = null): void {
    const swap = (old: THREE.Group): THREE.Group => {
      const next = buildModelKnife(model, !arms);
      next.position.copy(old.position);
      next.rotation.copy(old.rotation);
      next.scale.copy(old.scale);
      next.visible = old.visible;
      const parent = old.parent;
      parent?.remove(old);
      parent?.add(next);
      return next;
    };
    this.knife = swap(this.knife);
    this.quickKnife = swap(this.quickKnife);
    if (arms) {
      // The real gloved arms hold the knife: one rig in the gun group (the slot knife lives there
      // at rest), one in a frame at the knife's held pose for the Q quick-knife (its own scene
      // node). Same geometry and material (the guns' arms program), one skinned draw each.
      const rig = (parent: THREE.Object3D): ArmRig => {
        const mesh = new THREE.SkinnedMesh(arms.geometry, arms.material);
        mesh.name = 'knife:arms';
        parent.add(mesh);
        return new ArmRig(mesh, arms.pivots);
      };
      this.knifeArms = rig(this.gun);
      this.quickFrame.position.copy(KNIFE_IDLE.p);
      this.quickFrame.rotation.copy(KNIFE_IDLE.r);
      this.quickFrame.scale.setScalar(VM_SCALE);
      this.scene.add(this.quickFrame);
      this.quickArms = rig(this.quickFrame);
      this.quickArms.mesh.visible = false;
    }
    const t = modelTrailPoints(model.anchors);
    this.bladeTip.copy(t.tip);
    this.bladeMid.copy(t.mid);
  }

  /** The knife's real arms (slot knife, Q quick-knife), when the knife pose loaded. */
  private knifeArms: ArmRig | null = null;
  private quickArms: ArmRig | null = null;
  /** The quick-knife arms' frame: the knife's held pose in the camera (fixed). */
  private readonly quickFrame = new THREE.Group();

  /**
   * Pose a knife arms rig: the right hand rides the knife (`knife`, its transform relative to the
   * rig's frame), shoulders pinned to the body (camera) and leaning into reach only when a cut
   * goes past the straight arm; the left fist holds its guard in the camera (`guard` 0..1 raises
   * it across the face) and lowers out of view by `leftDrop` 0..1 (holstering, a throw); null or
   * a full drop hides it. `toFrame` = camera → rig frame.
   */
  private poseKnifeArms(
    rig: ArmRig,
    knife: THREE.Matrix4,
    toFrame: THREE.Matrix4,
    guard: number,
    leftDrop: number | null,
  ): void {
    const left = leftDrop !== null && leftDrop < 0.999;
    // Bind pose in the camera = the rig frame at the knife's held pose.
    const toHeld = (p: readonly number[]): THREE.Vector3 =>
      new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(KNIFE_HELD).applyMatrix4(toFrame);
    const pv = rig.pivots;
    const kq = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().extractRotation(knife),
    );
    const wristR = new THREE.Vector3(...pv.R[2]).applyMatrix4(knife);
    const shoulder = (side: 'L' | 'R', target: THREE.Vector3): THREE.Vector3 => {
      const sh = toHeld(pv[side][0]);
      const reach = rig.reach(side) * 0.97;
      const d = target.distanceTo(sh);
      if (d > reach) sh.addScaledVector(target.clone().sub(sh).normalize(), d - reach);
      return sh;
    };
    const targets: ArmTargets = {
      R: { wrist: wristR, hand: kq, abs: true },
      L: null,
      shoulders: { L: toHeld(pv.L[0]), R: shoulder('R', wristR) },
    };
    if (left) {
      // The fist keeps its held orientation in the camera (turned across the face on a guard).
      const rest = new THREE.Vector3(...pv.L[2]).applyMatrix4(KNIFE_HELD);
      const wrist = rest
        .lerp(GUARD_WRIST, guard)
        .addScaledVector(LEFT_DROP, leftDrop)
        .applyMatrix4(toFrame);
      const rot = (m: THREE.Matrix4): THREE.Quaternion =>
        new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m));
      const hand = rot(toFrame)
        .multiply(new THREE.Quaternion().setFromAxisAngle(FWD_AXIS, 0.9 * guard))
        .multiply(rot(KNIFE_HELD));
      targets.L = { wrist, hand, abs: true };
      targets.shoulders!.L = shoulder('L', wrist);
    }
    rig.pose(targets);
    if (!left) rig.hide('L');
  }

  /** Trail sample points (knife space): tests. */
  get trailPoints(): { tip: THREE.Vector3; mid: THREE.Vector3 } {
    return { tip: this.bladeTip, mid: this.bladeMid };
  }

  /** The current primary shown in the rifle slot, including a gun taken during this life. */
  setPrimary(primary: PrimaryId): void {
    if (this.guns.rifle === this.primaries[primary]) return;
    this.guns.rifle.group.visible = false;
    this.guns.rifle = this.primaries[primary];
  }
  private knife: THREE.Group;
  /** Separate knife for Q quick-melee while a gun is dropped out of view. */
  private quickKnife: THREE.Group;
  /** Trail sample points in knife space (the primitive's until the seax model loads). */
  private bladeTip = BLADE_TIP.clone();
  private bladeMid = BLADE_MID.clone();
  private readonly grenade: THREE.Group;
  private readonly trail = Viewmodel.buildTrail();
  private readonly trailSamples: { tip: THREE.Vector3; mid: THREE.Vector3; age: number }[] = [];
  /** Left forearm raised across the view while guarding (the 360° outside defense). */
  private readonly guardArm = Viewmodel.buildGuardArm();
  private readonly parryFlash = Viewmodel.buildParryFlash();
  private parryLife = 0;
  /** Seconds the knife's off-hand stays up after a parry (through the counter). */
  private offHandHold = 0;
  private readonly guardSpring = new Spring(22, 0.85);
  private readonly parryKick = new Spring(30, 0.5);
  /** Parry punch-in: a brief FOV squeeze (see `fovScale`). */
  private readonly punch = new Spring(26, 0.55);
  private flashLife = 0;
  private activeFlash: THREE.Mesh | null = null;
  private readonly kickZ = new Spring(28, 0.55);
  private readonly kickPitch = new Spring(24, 0.5);
  private readonly kickRoll = new Spring(24, 0.5);
  private readonly kickYaw = new Spring(24, 0.5);
  private readonly sprint = new Spring(10, 0.78);
  private readonly prone = new Spring(7, 1);
  private readonly slide = new Spring(14, 0.8);
  private readonly crawl = new Spring(9, 1);
  /** Jump / landing weight on the gun (m, then pitch). */
  private readonly landY = new Spring(16, 0.42);
  /** Draw flourish (roll settle after raising) and ADS settle. */
  private readonly draw = new Spring(13, 0.45);
  private readonly adsSettle = new Spring(20, 0.5);
  private prevAds = 0;
  private crawlPhase = 0;
  private sprintPhase = 0;
  private time = 0;
  /** Weapon on screen, and the one being put away during a switch (for a smooth hand-off). */
  private shown: Slot = 'rifle';
  private outgoing: Slot | null = null;
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private inspectQueued = false;

  constructor() {
    // Fill + key; image-based light comes from the world's sky (see setEnvironment).
    this.scene.add(new THREE.HemisphereLight('#dfe8f2', '#3a3530', 0.6));
    const key = new THREE.DirectionalLight('#fff4e0', 1.6);
    key.position.set(-0.5, 1, 0.6);
    this.scene.add(key);

    // New primaries fall back to the closest primitive until their scans load.
    this.primaries = {
      ar7: buildRifle(),
      coil: buildCoilgun(),
      iskra: buildIskra(),
      shotgun: buildRifle(),
      marksman: buildCoilgun(),
      arc: buildIskra(),
    };
    this.guns = { rifle: this.primaries.ar7, sidearm: buildPistol() };
    this.knife = buildKnife();
    this.quickKnife = buildKnife();
    this.grenade = buildGrenade();
    for (const p of Object.values(this.primaries)) {
      p.group.visible = false;
      this.gun.add(p.group);
    }
    for (const g of [this.guns.sidearm.group, this.knife]) this.gun.add(g);
    this.gun.scale.setScalar(VM_SCALE);
    this.root.add(this.gun);
    this.quickKnife.scale.setScalar(VM_SCALE);
    this.grenade.scale.setScalar(VM_SCALE);
    this.scene.add(
      this.root,
      this.quickKnife,
      this.grenade,
      this.trail,
      this.guardArm,
      this.parryFlash,
    );
  }

  /** Reflections on the weapons come from the same baked sky as the world. */
  setEnvironment(env: THREE.Texture | null, intensity: number): void {
    this.scene.environment = env;
    this.scene.environmentIntensity = intensity;
  }

  private static buildGuardArm(): THREE.Group {
    const g = new THREE.Group();
    const sleeve = new THREE.MeshStandardMaterial({ color: '#4d5140', roughness: 0.95 });
    const glove = new THREE.MeshStandardMaterial({ color: '#2b2926', roughness: 0.9 });
    // Forearm across the lower-left of the view, fist toward the centre; the upper arm runs off
    // the bottom edge. Sized for the viewmodel camera (~0.3 m from the eye).
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.2, 14), sleeve);
    forearm.rotation.z = Math.PI / 2;
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.03, 14, 10), glove);
    fist.position.x = -0.11;
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.036, 0.22, 14), sleeve);
    upper.position.set(0.13, -0.08, 0.03);
    upper.rotation.z = -0.9;
    g.add(forearm, fist, upper);
    g.scale.setScalar(0.75);
    g.visible = false;
    return g;
  }

  /** Additive burst where blade meets forearm on a parry. */
  private static buildParryFlash(): THREE.Mesh {
    const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    let map: THREE.Texture | null = null;
    const g = c?.getContext('2d');
    if (c && g) {
      c.width = c.height = 64;
      const r = g.createRadialGradient(32, 32, 1, 32, 32, 31);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.25, 'rgba(255,214,150,0.8)');
      r.addColorStop(1, 'rgba(255,150,60,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
      map = new THREE.CanvasTexture(c);
    }
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 0.16),
      new THREE.MeshBasicMaterial({
        map,
        color: '#ffe2b0',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    m.visible = false;
    return m;
  }

  /** A successful parry: the guard arm drives forward (the "burst"), a flash and a punch-in. */
  parry(): void {
    this.parryKick.kick(-3.2);
    this.punch.kick(9);
    this.parryLife = 0.14;
    this.offHandHold = OFF_HAND_HOLD;
  }

  /** FOV multiplier for the world camera (parry punch-in; 1 = none). Presentation only. */
  get fovScale(): number {
    return 1 - 0.05 * THREE.MathUtils.clamp(this.punch.value, -1, 1.5);
  }

  /** Jump: the gun lifts a touch, then its weight follows. */
  jump(): void {
    this.landY.kick(0.35);
  }

  /** Landing: the gun dips with the impact (m/s) and bounces back. */
  land(impactSpeed: number): void {
    this.landY.kick(-Math.min(1.6, 0.12 * impactSpeed));
  }

  /** Inspect the weapon in hand (Inspect key); ignored mid-reload/switch or aimed. */
  inspect(): void {
    this.inspectQueued = true;
  }

  /** Does the current weapon use the HUD red dot when aimed? */
  redDot(slot: Slot): boolean {
    return slot !== 'knife' && this.guns[slot].redDot;
  }

  /** Does the weapon in `slot` play an authored reload (with its own keyframed foley)? */
  hasReloadClip(slot: Slot): boolean {
    if (slot === 'knife') return false;
    const a = this.animators.get(this.guns[slot]);
    return !!a && a.clip('reload') !== null;
  }

  /** Proof frames / tests: hold the shown gun at a clip's normalised time (null releases). */
  debugScrub(slot: Slot, kind: ClipKind | null, t = 0): void {
    if (slot === 'knife') return;
    const a = this.animators.get(this.guns[slot]);
    if (a) a.scrub = kind ? { kind, t } : null;
  }

  fire(slot: Slot, adsAmount: number, flashes = true): void {
    if (slot === 'knife') return;
    const model = this.guns[slot];
    const id: ScanGunId = model.rig?.id ?? (slot === 'sidearm' ? 'pistol' : 'rifle');
    const r = RECOIL[id];
    const k = 1 - 0.55 * adsAmount;
    for (const s of [this.kickZ, this.kickPitch, this.kickRoll, this.kickYaw]) {
      s.stiffness = r.stiffness;
      s.damping = r.damping;
    }
    this.kickZ.kick(r.back * 22 * k * (FEEL.viewmodelKick / 0.045));
    this.kickPitch.kick(r.climb * 18 * k);
    this.kickRoll.kick((Math.random() - 0.35) * r.roll * 18 * k);
    this.kickYaw.kick((Math.random() * 2 - 1) * r.jitter * 18 * k);
    const anim = this.animators.get(model);
    anim?.fired();
    anim?.cancelInspect();
    if (!flashes) return; // silent (coilgun): kick, no muzzle flash
    const flash = model.flash;
    kickFlash(flash);
    this.activeFlash = flash;
    this.flashLife = 0.035;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Knife strike relative to its held pose. Keyframes per move (position m, rotation rad):
   * wind-up pose → strike end pose → back to rest, with the strike bowed forward through the
   * target (`arc`) and a small follow-through past the end pose. Big arcs sell the Krav Maga-style
   * swipe.
   */
  private static readonly MOVES: Record<
    KnifeMove,
    {
      pull: [number, number, number, number, number, number];
      hit: [number, number, number, number, number, number];
      arc: [number, number, number];
    }
  > = {
    // [px, py, pz, rx, ry, rz]
    slash: {
      pull: [0.13, 0.09, 0.04, 0.1, -0.55, -0.95],
      hit: [-0.34, -0.13, -0.1, -0.35, 0.85, 1.7],
      arc: [0, 0.035, -0.11],
    },
    backhand: {
      pull: [-0.22, -0.07, 0.02, -0.1, 0.65, 1.25],
      hit: [0.28, 0.09, -0.08, 0.15, -0.75, -1.05],
      arc: [0, 0.03, -0.1],
    },
    thrust: {
      pull: [0.02, -0.02, 0.13, 0.2, 0, -0.2],
      hit: [-0.04, 0.03, -0.34, -0.25, 0.05, 0.15],
      arc: [0, 0.02, -0.03],
    },
  };

  private slash(
    obj: THREE.Object3D,
    a: HandAction & { move: KnifeMove },
    base: { p: THREE.Vector3; r: THREE.Euler },
  ): boolean {
    const strikeDur = a.move === 'thrust' ? 0.085 : 0.11;
    const k = Viewmodel.MOVES[a.move];
    const pull = smooth(0, 1, a.elapsed / a.windup);
    // Strike: fast-in (the blade accelerates through), then a follow-through overshoot.
    const sx = clamp01((a.elapsed - a.windup) / strikeDur);
    const strike = 1 - (1 - sx) ** 2.2 + 0.08 * Math.sin(Math.PI * clamp01((sx - 0.7) / 0.3));
    const back = smooth(0, 1, (a.elapsed - a.windup - strikeDur - 0.03) / 0.22);
    const bow = Math.sin(Math.PI * sx) * (1 - back);
    // Blend: rest → pull (wind-up) → hit (strike) → rest (recover).
    const v = (i: number): number => {
      const pulled = k.pull[i]! * pull;
      const struck = pulled + (k.hit[i]! - pulled) * strike;
      return struck * (1 - back);
    };
    obj.position.set(
      base.p.x + v(0) + k.arc[0] * bow,
      base.p.y + v(1) + k.arc[1] * bow,
      base.p.z + v(2) + k.arc[2] * bow,
    );
    obj.rotation.set(base.r.x + v(3), base.r.y + v(4), base.r.z + v(5));
    // Trail while the blade is moving fast.
    return a.elapsed > a.windup && a.elapsed < a.windup + strikeDur + 0.04;
  }

  /** Fading additive ribbon behind the blade (tip → mid of the edge), refilled in place. */
  private static buildTrail(): THREE.Mesh {
    const n = TRAIL_SAMPLES;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.Float32BufferAttribute(new Float32Array(n * 2 * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.Float32BufferAttribute(new Float32Array(n * 2 * 3), 3);
    col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  }

  private updateTrail(dt: number, blade: THREE.Object3D | null, moving: boolean): void {
    const s = this.trailSamples;
    for (const p of s) p.age += dt;
    while (s.length && s[0]!.age > TRAIL_LIFE) s.shift();
    if (blade && moving) {
      blade.updateWorldMatrix(true, false);
      s.push({
        tip: blade.localToWorld(this.bladeTip.clone()),
        mid: blade.localToWorld(this.bladeMid.clone()),
        age: 0,
      });
      while (s.length > TRAIL_SAMPLES) s.shift();
    }
    this.trail.visible = s.length >= 2;
    if (!this.trail.visible) return;
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const p = s[Math.min(i, s.length - 1)]!;
      // Fade with age and toward the tail; the edge side is dimmer than the tip.
      const f = (1 - p.age / TRAIL_LIFE) * (i < s.length ? 1 : 0);
      const tipF = 0.55 * f;
      const midF = 0.12 * f;
      pos.setXYZ(i * 2, p.tip.x, p.tip.y, p.tip.z);
      pos.setXYZ(i * 2 + 1, p.mid.x, p.mid.y, p.mid.z);
      col.setXYZ(i * 2, tipF * 0.92, tipF * 0.95, tipF);
      col.setXYZ(i * 2 + 1, midF, midF, midF);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  update(dt: number, s: ViewmodelState): void {
    this.time += dt;
    // The off-hand's post-parry hold runs out whatever is in hand (a gun's parry never raises
    // the knife's fist later).
    this.offHandHold = Math.max(0, this.offHandHold - dt);
    // Switch hand-off: first 30% of the switch lowers the old weapon (ease-in), the rest raises
    // the new one (ease-out) — no pop from one model to the other.
    if (s.slot !== this.shown) {
      this.outgoing = s.switchProgress < 0.5 ? this.shown : null;
      this.shown = s.slot;
      // Draw flourish: the new weapon comes up canted and rolls level with a little settle.
      this.draw.kick(s.slot === 'sidearm' ? -5 : s.slot === 'knife' ? 0 : 4);
      for (const a of this.animators.values()) a.cancelInspect();
    }
    if (s.switchProgress >= 1) this.outgoing = null;
    const HANDOFF = 0.3;
    const lowering = this.outgoing !== null && s.switchProgress < HANDOFF;
    const slot: Slot = lowering ? this.outgoing! : s.slot;
    const isKnife = slot === 'knife';
    const model = slot === 'knife' ? null : this.guns[slot];
    this.guns.rifle.group.visible = slot === 'rifle';
    this.guns.sidearm.group.visible = slot === 'sidearm';
    this.knife.visible = isKnife;
    const gunId: ScanGunId | null = model
      ? (model.rig?.id ?? (slot === 'sidearm' ? 'pistol' : 'rifle'))
      : null;

    const ads = isKnife ? 0 : s.adsAmount;
    const sprint = this.sprint.update(s.sprinting ? 1 : 0, dt);

    // Base pose for the weapon in hand.
    let pos: THREE.Vector3;
    let rx: number;
    let ry: number;
    let rz: number;
    if (model) {
      const adsP = new THREE.Vector3(0, -model.sightY * VM_SCALE, -model.adsZ);
      pos = model.hip.clone().lerp(adsP, ads).lerp(SPRINT.p, sprint);
      rx = SPRINT.r.x * sprint;
      ry = SPRINT.r.y * sprint;
      rz = SPRINT.r.z * sprint;
    } else {
      pos = KNIFE_IDLE.p.clone();
      rx = KNIFE_IDLE.r.x;
      ry = KNIFE_IDLE.r.y + 0.3 * sprint;
      rz = KNIFE_IDLE.r.z;
      pos.y -= 0.03 * sprint;
    }

    // Sprint cycle: the gun swings in a loose figure-eight with the stride.
    const sprintMove = sprint * Math.min(1, s.speed / 6);
    this.sprintPhase += dt * 8.5 * (sprintMove > 0.05 ? 1 : 0);
    pos.x += Math.sin(this.sprintPhase) * 0.014 * sprintMove;
    pos.y += Math.abs(Math.cos(this.sprintPhase)) * 0.01 * sprintMove;
    rz += Math.sin(this.sprintPhase) * 0.06 * sprintMove;
    rx += Math.cos(this.sprintPhase * 2) * 0.02 * sprintMove;

    // Idle breathing (per gun: heavier guns breathe slower, deeper); a third of it aimed.
    if (gunId) {
      const b = BREATH[gunId];
      const ph = this.time * Math.PI * 2 * b.hz;
      const k = (1 - 0.7 * ads) * (1 - sprint);
      pos.y += Math.sin(ph) * b.amp * k;
      pos.x += Math.sin(ph * 0.5) * b.amp * 0.4 * k;
      rx += Math.cos(ph) * b.amp * 1.6 * k;
    }

    // ADS: a slight roll on the way in (the gun swings up to the cheek) and a settle on arrival.
    const adsRate = (ads - this.prevAds) / Math.max(dt, 1e-4);
    if (this.prevAds < 0.97 && ads >= 0.97) this.adsSettle.kick(-1);
    this.prevAds = ads;
    const settle = this.adsSettle.update(0, dt);
    rz += Math.sin(Math.PI * ads) * 0.09 * Math.sign(adsRate) * Math.min(1, Math.abs(adsRate) / 3);
    pos.y += settle * 0.004;
    rx += settle * 0.01;

    // Prone (at the hip; ADS stays exactly on the sights): lower, a little toward the centre,
    // canted, as if propped on the elbows. Crawling carries it rolled away and dropped, swinging
    // with each pull of the arms.
    const prone = this.prone.update(s.prone ? 1 : 0, dt) * (1 - ads);
    const crawl = this.crawl.update(s.prone && s.speed > 0.2 ? 1 : 0, dt) * (1 - ads);
    pos.x -= 0.035 * prone;
    pos.y -= 0.035 * prone;
    pos.z += 0.02 * prone;
    rx += 0.05 * prone;
    rz += 0.14 * prone;
    this.crawlPhase += dt * (2 + 5.5 * Math.min(1, s.speed / 1.1)) * (crawl > 0.02 ? 1 : 0);
    const swing = Math.sin(this.crawlPhase);
    pos.x += (0.05 + 0.03 * swing) * crawl;
    pos.y -= (0.1 + 0.02 * Math.abs(Math.cos(this.crawlPhase))) * crawl;
    rx -= 0.18 * crawl;
    ry += 0.38 * crawl;
    rz += (0.55 + 0.1 * swing) * crawl;

    // Slide (at the hip): the gun drops and tucks toward the centre, canted with the camera's
    // lean; aiming brings it back onto the sights as usual.
    const slide = this.slide.update(s.sliding ? 1 : 0, dt) * (1 - ads);
    pos.x -= 0.02 * slide;
    pos.y -= 0.03 * slide;
    rx += 0.06 * slide;
    rz += 0.12 * slide;

    // Authored clips (reload, vent, pump, inspect) on the scanned gun in hand.
    const anim = model ? (this.animators.get(model) ?? null) : null;
    if (this.inspectQueued) {
      this.inspectQueued = false;
      if (anim && s.reload < 0 && s.switchProgress >= 1 && ads < 0.1 && !s.sprinting)
        anim.inspect();
    }
    if (anim && (ads > 0.3 || s.sprinting || s.melee || s.throw)) anim.cancelInspect();
    const out = anim?.update(dt, {
      reload: s.reload,
      reloadEmpty: s.reloadEmpty ?? false,
      vent: s.vent ?? -1,
      ventLockout: s.ventLockout ?? 1.6,
      magEmpty: s.magEmpty ?? false,
    });
    // Other guns' clips stop while hidden: magazines return, drops in flight and pending pumps
    // are cleared (a hidden animator gets no updates, so they would resume on the next draw).
    for (const [m, a] of this.animators) if (a !== anim && m.group.visible === false) a.holster();
    const g = out?.gun ?? [0, 0, 0, 0, 0, 0];
    // Aimed, a clip plays at a third of its tilt (you can reload while aimed; the sights stay near).
    const clipK = 1 - 0.65 * ads;
    const animPos = new THREE.Vector3(g[0] * clipK, g[1] * clipK, g[2] * clipK);
    const animRot = [g[3] * clipK, g[4] * clipK, g[5] * clipK] as const;
    if (out) for (const c of out.cues) this.onCue(c, gunId!);

    // Reload without an authored clip (primitive guns): dip and cant, easing in and out.
    if (s.reload >= 0 && !out?.active) {
      const curve = Math.sin(Math.min(1, s.reload) * Math.PI);
      pos.y -= 0.07 * curve;
      rz += 0.55 * curve;
      rx -= 0.25 * curve;
    }

    // Switching: old weapon eases down, new one eases up.
    let lower: number;
    if (lowering) {
      const k = s.switchProgress / HANDOFF;
      lower = k * k; // ease-in going down
    } else if (this.outgoing !== null) {
      const k = Math.min(1, (s.switchProgress - HANDOFF) / (1 - HANDOFF));
      lower = (1 - k) ** 3; // ease-out coming up
    } else {
      lower = (1 - s.switchProgress) ** 2;
    }
    pos.y -= 0.24 * lower;
    rx -= 0.9 * lower;
    const flourish = this.draw.update(0, dt);
    rz += flourish * 0.05;
    ry -= flourish * 0.02;

    // Quick melee / grenade: the gun drops out of the way for the duration.
    const drop = (a: HandAction | null, depth: number): number =>
      a ? depth * smooth(0, 0.08, a.elapsed) * (1 - smooth(a.total - 0.16, a.total, a.elapsed)) : 0;
    const quick = s.melee?.quick ? s.melee : null;
    const gunDrop = drop(quick, 1) + drop(s.throw, 0.55);
    pos.y -= 0.34 * Math.min(1, gunDrop);
    rx -= 0.7 * Math.min(1, gunDrop);

    // Sway lags behind look movement; much smaller when aiming.
    const swayScale = FEEL.swayPerDegree * (1 - 0.8 * ads);
    this.swayX = damp(
      this.swayX,
      THREE.MathUtils.clamp(-s.lookDx * swayScale, -FEEL.swayMax, FEEL.swayMax),
      14,
      dt,
    );
    this.swayY = damp(
      this.swayY,
      THREE.MathUtils.clamp(s.lookDy * swayScale, -FEEL.swayMax, FEEL.swayMax),
      14,
      dt,
    );

    // Bob with movement speed.
    const moving = s.grounded ? Math.min(1.4, s.speed / 4.6) : 0;
    this.bobPhase += dt * (6 + 4 * sprint) * (moving > 0.05 ? 1 : 0);
    const bobAmp = s.bob ? 0.012 * moving * (1 - 0.85 * ads) : 0;
    pos.x += Math.sin(this.bobPhase) * bobAmp;
    pos.y -= Math.abs(Math.cos(this.bobPhase)) * bobAmp;

    // Jump / landing weight (less when aimed).
    const land = this.landY.update(0, dt) * (1 - 0.6 * ads);
    pos.y += land * 0.03;
    rx += land * 0.05;

    // Guard: forearm sweeps up across the face, the weapon drops out of the way.
    const gd = this.guardSpring.update(s.guard ? 1 : 0, dt);
    pos.y -= 0.18 * gd;
    rx -= 0.5 * gd;
    if (s.stunned) {
      const t = performance.now() / 1000;
      pos.x += Math.sin(t * 31) * 0.008;
      rz += Math.sin(t * 23) * 0.05;
    }

    // Base (without the clip) → with the clip: the arms pin their shoulders to the body.
    const baseRoot = new THREE.Matrix4().compose(
      pos,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(1, 1, 1),
    );
    this.root.position.copy(pos).add(animPos);
    this.root.rotation.set(rx + animRot[0], ry + animRot[1], rz + animRot[2]);
    if (out?.active && model?.rig) {
      // Clips turn the gun about the firing hand's grip (the wrist), not the model origin: a
      // long gun turned about its middle swings its stock into the lens.
      const w = model.rig.arms?.pivots.R[2] ?? [0, 0, 0];
      this.gun.updateMatrix();
      const grip = new THREE.Vector3(...w).applyMatrix4(this.gun.matrix);
      const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
      const q1 = this.root.quaternion;
      this.root.position.add(grip.clone().applyQuaternion(q0).sub(grip.applyQuaternion(q1)));
    }
    if (isKnife && s.melee && !s.melee.quick) {
      // Slash animates the knife itself (inside the kick/sway group).
      this.knife.userData.moving = this.slash(this.knife, s.melee, {
        p: new THREE.Vector3(0, 0, 0.04 * gd),
        r: new THREE.Euler(0.3 * gd, 0, 0),
      });
    } else {
      // Block: the knife hand tucks in behind the guard, with a faint tremble of tension.
      const tremble = gd * Math.sin(this.time * 37) * 0.002;
      this.knife.position.set(0.02 * gd + tremble, -0.02 * gd, 0.05 * gd);
      this.knife.rotation.set(0.35 * gd, 0.2 * gd, -0.25 * gd);
      this.knife.userData.moving = false;
    }

    const kz = this.kickZ.update(0, dt);
    const kp = this.kickPitch.update(0, dt);
    const kr = this.kickRoll.update(0, dt);
    const ky = this.kickYaw.update(0, dt);
    this.gun.position.set(0, 0, kz);
    this.gun.rotation.set(
      kp * 0.06 + this.swayY,
      this.swayX + ky * 0.06,
      this.swayX * 0.5 + kr * 0.06,
    );

    const arms = model?.rig?.arms ?? null;
    if (anim && arms) {
      const targets = { ...anim.targets };
      const pin = out?.pin ?? 0;
      if (out?.active && pin > 0) {
        this.root.updateMatrix();
        this.gun.updateMatrix();
        const animW = this.root.matrix.clone().multiply(this.gun.matrix);
        const baseW = baseRoot.multiply(this.gun.matrix);
        const toNew = animW.invert().multiply(baseW);
        const sh = (side: 'L' | 'R'): THREE.Vector3 => {
          const s0 = new THREE.Vector3(...arms.pivots[side][0]);
          return s0.clone().lerp(s0.clone().applyMatrix4(toNew), pin);
        };
        targets.shoulders = { L: sh('L'), R: sh('R') };
      }
      if (out?.active) arms.pose(targets);
      else arms.rest();
    }

    // The knife's real arms: the right hand rides the knife, the left fist keeps (or raises) its
    // guard; shoulders stay with the body.
    if (this.knifeArms) {
      const on = isKnife && this.knife.visible;
      this.knifeArms.mesh.visible = on;
      if (on) {
        this.root.updateMatrix();
        this.gun.updateMatrix();
        this.knife.updateMatrix();
        const toFrame = this.root.matrix.clone().multiply(this.gun.matrix).invert();
        // The off-hand is out of view at idle and through cuts (its pixels are the arms' biggest
        // cost on iGPUs); it rises for Block and stays up after a parry through the counter. It
        // lowers with the knife when it is put away and hands over to the grenade hand for a
        // throw: gone while the frag's hand holds it, then back up as the throw recovers.
        const up = Math.max(gd, smooth(0, 0.15, this.offHandHold));
        const throwDrop = s.throw ? drop(s.throw, 1) : 0;
        const leftDrop = Math.max(1 - up, Math.min(1, lower * 1.15), throwDrop);
        const grenadeUp = s.throw !== null && s.throw.elapsed < s.throw.windup;
        this.poseKnifeArms(
          this.knifeArms,
          this.knife.matrix,
          toFrame,
          gd,
          grenadeUp ? null : leftDrop,
        );
      }
    }

    // Q quick-melee knife (right hand, while the gun is dropped).
    this.quickKnife.visible = quick !== null && gunDrop > 0.25;
    let quickMoving = false;
    if (quick) quickMoving = this.slash(this.quickKnife, quick, KNIFE_IDLE);
    if (this.quickArms) {
      this.quickArms.mesh.visible = this.quickKnife.visible;
      if (this.quickKnife.visible) {
        this.quickKnife.updateMatrix();
        this.quickFrame.updateMatrix();
        const toFrame = this.quickFrame.matrix.clone().invert();
        const rel = toFrame.clone().multiply(this.quickKnife.matrix);
        this.poseKnifeArms(this.quickArms, rel, toFrame, 0, null);
      }
    }
    const blade = quick ? this.quickKnife : isKnife && s.melee ? this.knife : null;
    const bladeMoving =
      s.melee !== null &&
      s.melee.move !== 'thrust' &&
      (quick ? quickMoving : !!this.knife.userData.moving);
    this.updateTrail(dt, blade, bladeMoving);

    // Grenade in the left hand during the wind-up; gone once released.
    const t = s.throw;
    this.grenade.visible = t !== null && t.elapsed < t.windup;
    if (t) {
      const k = smooth(0, 1, t.elapsed / t.windup);
      this.grenade.position.set(-0.13 + 0.06 * k, -0.2 + 0.2 * k, -0.32 + 0.16 * k);
      this.grenade.rotation.set(-0.3 * k, 0, 0.2);
    }

    // Guard arm; the parry burst flashes where the blade meets it and the view punches in.
    const shove = this.parryKick.update(0, dt);
    this.punch.update(0, dt);
    // With the knife's real arms out, its own left forearm raises the guard (no stand-in).
    this.guardArm.visible = gd > 0.02 && !(this.knifeArms && isKnife);
    this.guardArm.position.set(lerp(-0.12, -0.07, gd), lerp(-0.34, -0.13, gd), -0.3 + shove * 0.04);
    this.guardArm.rotation.set(0.15, 0.3, lerp(-0.2, 0.42, gd));
    this.parryLife = Math.max(0, this.parryLife - dt);
    this.parryFlash.visible = this.parryLife > 0;
    if (this.parryFlash.visible) {
      const k = 1 - this.parryLife / 0.14;
      this.parryFlash.position.set(-0.05, -0.08, -0.28);
      this.parryFlash.scale.setScalar(0.6 + 1.6 * k);
      this.parryFlash.rotation.z = k * 0.8;
      (this.parryFlash.material as THREE.MeshBasicMaterial).opacity = (1 - k) ** 1.5;
    }

    this.flashLife -= dt;
    if (this.flashLife <= 0 && this.activeFlash) {
      this.activeFlash.visible = false;
      this.activeFlash = null;
    }
  }
}
