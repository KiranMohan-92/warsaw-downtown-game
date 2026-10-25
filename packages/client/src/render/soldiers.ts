/**
 * Third-person soldiers: Rocketbox avatars (MIT) animated with retargeted Quaternius UAL clips
 * (CC0), built by tools/assets/build_soldiers.py into public/models/soldiers/. One skinned draw per
 * soldier (2×2 atlas), the weapon in hand (their primary, pistol or knife: +1 draw) mounted on the
 * right hand (the build places marker bones on the rifle hold), a locomotion state picked from the pose (speed, crouch, air, death) with cross-fades, legs
 * turned toward the movement (≤ 60°) while the chest keeps the aim, and aim pitch on the spine.
 * Combat actions (reload, throw, knife strike, guard, stun; shared sim/action.ts) and hit flinches
 * play as upper-body layers over the locomotion, timed by the sim's progress (soldierActions.ts).
 *
 * Scaled so the eye sits at the sim's eye height: the drawn head, torso and legs sit on the
 * humanoid hit volumes (render/soldiers.test.ts checks the head). Presentation only.
 */
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { hurtFlinch, NO_ACTION, PLAYER, type PlayerAction } from '@wd/shared';
import { withTimeout } from './surfaceTextures.ts';
import { aimBoard, buildSkateboard, DECK_HEIGHT } from './skateboard.ts';
import { gltfLoader } from './gltfLoader.ts';
import { FootPlant, type FootSupport } from './footPlant.ts';
import type { HeldModel, HeldWeapon } from './viewGunScans.ts';
import {
  ACTION_CLIPS,
  actionClipTime,
  grenadeInHand,
  LAYER_FADE_IN,
  LAYER_FADE_IN_DEFAULT,
  LAYER_FADE_OUT,
  layerWeight,
  pickActionClip,
  type ActionClip,
  type ClipMarks,
} from './soldierActions.ts';

export const SOLDIER_IDS = ['m01', 'm04'] as const;
export type SoldierId = (typeof SOLDIER_IDS)[number];

export type SoldierClip =
  | 'idle'
  | 'walk'
  | 'jog'
  | 'sprint'
  | 'crouchIdle'
  | 'crouchWalk'
  | 'jumpStart'
  | 'fall'
  | 'land'
  | 'death'
  | 'prone'
  | 'proneCrawl';

interface SoldierInfo {
  eye: number;
  aimYaw: number;
  clips: Record<SoldierClip | ActionClip, number>;
  /** Split action clips: clip time (s) of the release / impact. */
  marks?: ClipMarks;
}

export interface SoldierKit {
  /** Visible floor sampling, shared by local, practice and online figures. */
  footSupport?: FootSupport;
  variants: {
    id: SoldierId;
    gltf: GLTF;
    material: THREE.MeshStandardMaterial;
    info: SoldierInfo;
  }[];
  /** Mask, pack and pouches (the 'gear' mesh of every soldier): shared atlas. */
  gearMaterial: THREE.MeshStandardMaterial;
  /**
   * What soldiers can hold, placed in the rifle hold's gun frame (render/viewGunScans.ts
   * `thirdPersonModels`: the viewmodel's scan geometry + materials, shared by every soldier).
   */
  guns: Partial<Record<HeldWeapon, HeldModel>>;
  /** The frag in hand during a throw (shared by every soldier; world objects only). */
  grenade?: { geometry: THREE.BufferGeometry; material: THREE.Material };
  /** The jetpack worn on the back (jetpack/jetpackModel.ts; shared, hidden until worn). */
  jetpack?: {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    /** Nozzle exits in pack space (the exhaust starts there). */
    nozzles: readonly (readonly [number, number, number])[];
  };
}

/**
 * Where the jetpack sits on a soldier (m, world scale, from the upper chest bone at rest): this
 * far behind it and this far up, so the back plate rests on the soldier's own tech pack.
 */
export const PACK_BACK = 0.2;
export const PACK_UP = -0.02;

/** A small frag: an olive egg body (one draw while in hand, hidden otherwise). */
function buildHandGrenade(): NonNullable<SoldierKit['grenade']> {
  const geometry = new THREE.SphereGeometry(0.034, 14, 10);
  geometry.scale(1, 1.3, 1);
  const material = new THREE.MeshStandardMaterial({
    name: 'soldier:grenade',
    color: '#4a5234',
    roughness: 0.7,
    metalness: 0.2,
  });
  return { geometry, material };
}

/** Clip speeds at timeScale 1 (m/s), for matching the feet to the ground speed. */
const NATIVE_SPEED: Partial<Record<SoldierClip, number>> = {
  walk: 1.6,
  jog: 4.2,
  sprint: 6.6,
  crouchWalk: 1.6,
  proneCrawl: 0.9,
};
const FADE = 0.18;
/** Flinch kick: the chest snaps back this far (rad) at the clip's middle (heavy hit: more). */
const FLINCH_KICK = 0.14;
const FLINCH_KICK_HEAVY = 0.26;
const MAX_LEG_TURN = THREE.MathUtils.degToRad(60);
/**
 * Aim pitch split: the chest leans this share (over Spine1/Spine2), the head looks `HEAD_PITCH`
 * of it, and the arms carry the rest from the clavicles so the rifle still points along the aim.
 * The hit volumes don't pitch, so the head is then pinned back where it was before the pitch.
 */
const CHEST_PITCH = 0.12;
const HEAD_PITCH = 0.6;
/**
 * Slide: the whole body tips back this far (rad) over the crouch clip, about the legs' right
 * axis through the crouched head (so the head stays on its hit volume while the feet shoot out
 * ahead), eased in/out at `SLIDE_EASE` (1/s). The aim pitch is taken back off, so the rifle
 * keeps the real aim.
 */
const SLIDE_LEAN = 0.32;
const SLIDE_EASE = 12;
const tmpAxis = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
/** Riding: the body may stand fully across the deck (the chest twists back to the aim). */
const RIDE_TURN = THREE.MathUtils.degToRad(100);

export async function loadSoldiers(
  renderer: THREE.WebGLRenderer | null,
  guns: SoldierKit['guns'],
  opts: { base?: string; timeoutMs?: number } = {},
): Promise<SoldierKit> {
  const base = `${opts.base ?? import.meta.env.BASE_URL}models/soldiers/`;
  const tex = new THREE.TextureLoader();
  const aniso = Math.min(4, renderer?.capabilities.getMaxAnisotropy() ?? 1);
  const load = async (url: string, srgb: boolean): Promise<THREE.Texture> => {
    const t = await tex.loadAsync(url);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    renderer?.initTexture(t);
    return t;
  };
  const work = (async () => {
    const res = await fetch(`${base}soldiers.json`);
    if (!res.ok) throw new Error(`soldiers.json ${res.status}`);
    const manifest = (await res.json()) as { soldiers: Record<SoldierId, SoldierInfo> };
    const variants = await Promise.all(
      SOLDIER_IDS.map(async (id) => {
        const [gltf, map, normalMap] = await Promise.all([
          gltfLoader().loadAsync(`${base}${id}.glb`),
          load(`${base}${id}_albedo.webp`, true),
          load(`${base}${id}_normal.webp`, false),
        ]);
        const material = new THREE.MeshStandardMaterial({
          name: `soldier:${id}`,
          map,
          normalMap,
          roughness: 0.82,
        });
        return { id, gltf, material, info: manifest.soldiers[id] };
      }),
    );
    const [gearMap, gearNormal, gearOrm, gearEmissive] = await Promise.all([
      load(`${base}gear_albedo.webp`, true),
      load(`${base}gear_normal.webp`, false),
      load(`${base}gear_orm.webp`, false),
      load(`${base}gear_emissive.webp`, true),
    ]);
    // Near-future kit: glossy visor, satin shells, cyan status lights (bloom on Medium+).
    const gearMaterial = new THREE.MeshStandardMaterial({
      name: 'soldier:gear',
      map: gearMap,
      normalMap: gearNormal,
      roughnessMap: gearOrm,
      roughness: 1,
      metalness: 0.15,
      emissiveMap: gearEmissive,
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 1.6,
    });
    return { variants, guns, gearMaterial, grenade: buildHandGrenade() };
  })();
  return withTimeout(work, opts.timeoutMs ?? 20_000, 'soldiers');
}

/** What drives a soldier's animation this frame (world units; yaw as the camera's). */
export interface SoldierPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouched: boolean;
  grounded: boolean;
  sprinting: boolean;
  alive: boolean;
  /** On the skateboard: stands on a board under the feet, along the motion. */
  riding?: boolean;
  /** Lying prone (the body lies behind the capsule, along the facing). */
  prone?: boolean;
  /** Sliding: the crouch clip leaned back, feet first. */
  sliding?: boolean;
  /** The weapon in their hands (default: unchanged; a new soldier holds the rifle). */
  weapon?: HeldWeapon;
  /** What their hands are doing (reload, throw, strike, guard, stun): an upper-body layer. */
  action?: PlayerAction;
  /** Authoritative health: a drop flinches them (hit / heavy hit clip). Absent: no flinches. */
  hp?: number;
  /** Spawn-protected (takes no damage): a cyan shimmer over the body. */
  shielded?: boolean;
  /** In a truck seat: carried by the truck, so its motion is not walking (the crouch clip, still). */
  seated?: boolean;
  /** Wearing a jetpack (shown on the back), and flying on it (an upright hover, not a fall). */
  jetpack?: boolean;
  flying?: boolean;
}

/**
 * The spawn-protection shimmer on a soldier's own body material: its emissive colour, a
 * uniform (no new program). `shield` 0..1 is the eased on/off, `t` seconds for the pulse.
 * Returns the emissive RGB added on top of the hit flash (white, `flash` 0..1).
 */
export function shieldEmissive(
  shield: number,
  t: number,
  flash: number,
): { r: number; g: number; b: number } {
  const pulse = 0.5 + 0.5 * Math.sin(t * 9);
  const e = shield * (0.1 + 0.12 * pulse);
  const w = flash * 0.35;
  return { r: w + e * 0.25, g: w + e * 0.85, b: w + e };
}

/** One upper-body layer: a clip held at a time we set, blended over locomotion. */
interface Layer {
  clip: ActionClip | null;
  action: THREE.AnimationAction | null;
  /** Blend 0-1 (eased in while wanted, out after). */
  blend: number;
}

export class Soldier {
  private readonly footPlant: FootPlant | null;
  readonly root = new THREE.Group();
  private readonly model: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<SoldierClip, THREE.AnimationAction>();
  private current: SoldierClip | null = null;
  private readonly spine: THREE.Bone[];
  private readonly clavicles: THREE.Bone[];
  private readonly head: THREE.Bone;
  /** The head's rest offset (no clip moves it; the aim pin does) and its centre in its frame. */
  private readonly headRest: THREE.Vector3;
  private readonly headCentre: THREE.Vector3;
  /** The clavicles' rest offsets (no clip moves them; the aim pitch swings them about one pivot). */
  private readonly clavicleRest: THREE.Vector3[];
  /**
   * Every bone and the rotation the mixer last wrote to it. Poses are layered over the clip here
   * (layer root, aim) and by callers after `update` (the sparring partner's arm overlay), but
   * three's mixer only writes a value when it changes — and the locomotion clips key the arms
   * constant — so each frame restarts from the clip's pose, else the overlays pile up.
   */
  private readonly posed: THREE.Bone[];
  private readonly clipPose: THREE.Quaternion[];
  private readonly aimYaw: number;
  readonly material: THREE.MeshStandardMaterial;
  private last: THREE.Vector3 | null = null;
  private readonly vel = new THREE.Vector3();
  private legTurn = 0;
  /** Skateboard heading last frame (yaw rate → lean) and the smoothed lean. */
  private boardHeading = 0;
  private boardLean = 0;
  /** Slide lean: the body between root and model, tipped back (identity otherwise); eased 0-1. */
  private readonly tilt = new THREE.Group();
  private slideLean = 0;
  private wasAlive = true;
  private wasGrounded = true;
  private landTimer = 0;
  /** Their skateboard (built up front so warm-up compiles it; shown only while riding). */
  private readonly board = buildSkateboard();

  constructor(kit: SoldierKit, variant: number) {
    const v = kit.variants[variant % kit.variants.length]!;
    this.aimYaw = v.info.aimYaw;
    this.model = cloneSkinned(v.gltf.scene);
    // Own material per soldier (same program): hit flash without touching the others.
    this.material = v.material.clone();
    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const m = o as THREE.SkinnedMesh;
        m.material = m.name.startsWith('gear') ? kit.gearMaterial : this.material;
        m.castShadow = true;
        // Bind-pose bounds miss a lying body or a long rifle: generous sphere, cheap test.
        m.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
      }
    });
    const k = PLAYER.standEyeHeight / v.info.eye;
    this.model.scale.setScalar(k);
    this.root.add(this.tilt);
    this.tilt.add(this.model);
    this.board.visible = false;
    this.root.add(this.board);
    const bone = (n: string): THREE.Bone =>
      this.model.getObjectByName(n.replaceAll(' ', '_')) as THREE.Bone;
    this.spine = [bone('Bip01 Spine1'), bone('Bip01 Spine2')];
    this.clavicles = [bone('Bip01 L Clavicle'), bone('Bip01 R Clavicle')];
    this.head = bone('Bip01 Head');
    this.headRest = this.head.position.clone();
    this.clavicleRest = this.clavicles.map((b) => b.position.clone());
    this.posed = [];
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.posed.push(o as THREE.Bone);
    });
    this.clipPose = this.posed.map((b) => b.quaternion.clone());
    // The eye point the build scales by (head bone + 7.5 cm up at rest), in the head's frame.
    this.model.updateMatrixWorld(true);
    this.headCentre = this.head.worldToLocal(
      this.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.075 * k, 0)),
    );
    this.footPlant = kit.footSupport ? new FootPlant(this.model, kit.footSupport) : null;
    this.mountGuns(kit.guns, bone('Bip01 R Hand'));
    if (kit.grenade) this.mountGrenade(kit.grenade, bone('Bip01 R Hand'));
    if (kit.jetpack) this.mountJetpack(kit.jetpack, this.spine[1]!);
    this.marks = v.info.marks ?? {};
    this.mixer = new THREE.AnimationMixer(this.model);
    const upper = upperBones(this.model);
    this.layerRoot = bone(LAYER_ROOT);
    this.model.updateMatrixWorld(true);
    this.layerRootRest = this.model
      .getWorldQuaternion(new THREE.Quaternion())
      .invert()
      .multiply(this.layerRoot.parent!.getWorldQuaternion(new THREE.Quaternion()));
    for (const clip of v.gltf.animations) {
      if ((ACTION_CLIPS as readonly string[]).includes(clip.name)) {
        // Upper-body layer: the chest, head and arm tracks (the build keeps only those); the
        // root's rotation is applied in model space after the mixer (`applyLayerRoot`).
        const { clip: layerClip, root } = upperBodyClip(clip, upper, this.layerRoot.name);
        const layer = this.mixer.clipAction(layerClip);
        layer.setLoop(THREE.LoopOnce, 1);
        layer.clampWhenFinished = true;
        this.layerActions.set(clip.name as ActionClip, layer);
        if (root) {
          const interp = new THREE.QuaternionLinearInterpolant(
            root.times,
            root.values,
            4,
            new Float32Array(4),
          );
          this.layerRoots.set(clip.name as ActionClip, interp);
        }
        continue;
      }
      const a = this.mixer.clipAction(clip);
      const name = clip.name as SoldierClip;
      if (name === 'death' || name === 'jumpStart' || name === 'land') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.actions.set(name, a);
    }
    this.play('idle', 0);
  }

  private readonly marks: ClipMarks;
  private readonly layerActions = new Map<ActionClip, THREE.AnimationAction>();
  /** Layer root (Spine1): its clip rotation, and its parent's rest rotation in model space. */
  private readonly layerRoot: THREE.Bone;
  private readonly layerRootRest: THREE.Quaternion;
  private readonly layerRoots = new Map<ActionClip, THREE.Interpolant>();
  /** Combat action (reload, throw, strike, guard, stun) and the flinch on top of it. */
  private readonly actionLayer: Layer = { clip: null, action: null, blend: 0 };
  private readonly flinchLayer: Layer = { clip: null, action: null, blend: 0 };
  private flinchTime = 0;
  private lastHp: number | null = null;
  private grenade: THREE.Mesh | null = null;

  /** The action clip being shown (tests, debug). */
  get actionClip(): ActionClip | null {
    return this.actionLayer.blend > 0 ? this.actionLayer.clip : null;
  }

  /** The flinch clip being shown (tests, debug). */
  get flinchClip(): ActionClip | null {
    return this.flinchLayer.blend > 0 ? this.flinchLayer.clip : null;
  }

  /** The frag in hand (tests, debug). */
  get grenadeMesh(): THREE.Mesh | null {
    return this.grenade;
  }

  /** The worn jetpack (hidden unless worn) and its nozzle exits in its own space. */
  private pack: THREE.Mesh | null = null;
  private packNozzles: THREE.Vector3[] = [];

  /** The jetpack mesh on the back (tests, probes). */
  get jetpackMesh(): THREE.Mesh | null {
    return this.pack;
  }

  /**
   * Mount the jetpack on the upper chest bone, behind the body: the pack's -Z along the soldier's
   * forward (the rifle's bore at rest, flattened), +Y up, so it rides the spine's animation.
   */
  private mountJetpack(kit: NonNullable<SoldierKit['jetpack']>, chest: THREE.Bone): void {
    this.model.updateMatrixWorld(true);
    const at = (n: string): THREE.Vector3 | null =>
      this.model.getObjectByName(n)?.getWorldPosition(new THREE.Vector3()) ?? null;
    // The body's own facing from its hips (the rifle's bore is turned off it by the aim hold).
    const l = at('Bip01_L_Thigh');
    const r = at('Bip01_R_Thigh');
    const up = new THREE.Vector3(0, 1, 0);
    const right = l && r ? r.sub(l) : new THREE.Vector3(1, 0, 0);
    right.y = 0;
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const back = right.clone().cross(up).normalize();
    const pos = chest
      .getWorldPosition(new THREE.Vector3())
      .addScaledVector(back, PACK_BACK)
      .addScaledVector(up, PACK_UP);
    const world = new THREE.Matrix4().makeBasis(right, up, back).setPosition(pos);
    const local = chest.matrixWorld.clone().invert().multiply(world);
    const mesh = new THREE.Mesh(kit.geometry, kit.material);
    mesh.name = 'worn:jetpack';
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(local);
    mesh.castShadow = true;
    mesh.visible = false;
    chest.add(mesh);
    this.pack = mesh;
    this.packNozzles = kit.nozzles.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  }

  /**
   * World positions of the worn pack's nozzle exits (into `out`), and the exhaust direction
   * (world, into `dir`). False when no pack is worn.
   */
  nozzles(out: THREE.Vector3[], dir: THREE.Vector3): boolean {
    const pack = this.pack;
    if (!pack?.visible || !this.root.visible) return false;
    pack.updateWorldMatrix(true, false);
    for (let i = 0; i < this.packNozzles.length; i++)
      (out[i] ??= new THREE.Vector3()).copy(this.packNozzles[i]!).applyMatrix4(pack.matrixWorld);
    dir.set(0, -1, 0).transformDirection(pack.matrixWorld);
    return true;
  }

  /** The frag, seated in the right palm (between the wrist and the middle knuckle). */
  private mountGrenade(g: NonNullable<SoldierKit['grenade']>, hand: THREE.Bone): void {
    const f = (n: string): THREE.Vector3 | null => {
      const b = this.model.getObjectByName(n);
      return b && b.parent === hand ? b.position.clone() : null;
    };
    const mid = f('Bip01_R_Finger2');
    const index = f('Bip01_R_Finger1');
    const pinky = f('Bip01_R_Finger4');
    if (!mid) return;
    const at = mid.clone().multiplyScalar(0.6);
    if (index && pinky) {
      // Into the palm: lateral x finger direction (the first-person solver's palm side, right hand).
      const palm = index.sub(pinky).cross(mid.clone().normalize()).normalize();
      at.addScaledVector(palm, 0.035 / this.model.scale.x);
    }
    const mesh = new THREE.Mesh(g.geometry, g.material);
    mesh.name = 'held:grenade';
    mesh.position.copy(at);
    // Bone space is in model units (the model is scaled to the sim eye): keep the frag's size.
    mesh.scale.setScalar(1 / this.model.scale.x);
    mesh.castShadow = true;
    mesh.visible = false;
    hand.add(mesh);
    this.grenade = mesh;
  }

  /**
   * Every holdable weapon on the right hand, in the gun frame the build's marker bones give (the
   * rifle hold), all hidden but the one in hand: one draw per soldier, geometry and materials
   * shared by all soldiers, and every mesh exists before `Game.warmUp` (which shows hidden
   * objects for the compile), so switching weapons never compiles a program.
   */
  private mountGuns(guns: SoldierKit['guns'], hand: THREE.Bone): void {
    const models = Object.entries(guns) as [HeldWeapon, HeldModel][];
    if (!models.length) return;
    this.model.updateMatrixWorld(true);
    const at = (n: string): THREE.Vector3 =>
      this.model.getObjectByName(n)!.getWorldPosition(new THREE.Vector3());
    const o = at('gun_o');
    const back = o.clone().sub(at('gun_f')).normalize();
    const up = at('gun_u').sub(o).normalize();
    const right = up.clone().cross(back).normalize();
    up.copy(back).cross(right);
    // World gun frame (scaled with the model) relative to the hand.
    const scale = this.model.scale.x;
    const world = new THREE.Matrix4()
      .makeBasis(right.multiplyScalar(scale), up.multiplyScalar(scale), back.multiplyScalar(scale))
      .setPosition(o);
    const local = hand.matrixWorld.clone().invert().multiply(world);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(local);
    group.name = 'soldier:guns';
    for (const [id, m] of models) {
      const mesh = new THREE.Mesh(m.geometry, m.material);
      mesh.name = `held:${id}`;
      mesh.position.copy(m.position);
      if (m.rotation) mesh.rotation.copy(m.rotation);
      mesh.castShadow = true;
      mesh.visible = false;
      group.add(mesh);
      this.held.set(id, mesh);
    }
    hand.add(group);
    this.setWeapon('rifle');
  }

  private readonly held = new Map<HeldWeapon, THREE.Mesh>();
  private holding: HeldWeapon | null = null;

  /** The weapon they hold (a missing model falls back to the rifle; none: bare hands). */
  get weapon(): HeldWeapon | null {
    return this.holding;
  }

  setWeapon(w: HeldWeapon): void {
    const id = this.held.has(w) ? w : this.held.has('rifle') ? 'rifle' : null;
    if (id === this.holding) return;
    this.holding = id;
    this.showHeld(id);
  }

  /** Draw one held model (an action may swap it: knife for a strike, none for a throw). */
  private showHeld(id: HeldWeapon | null): void {
    for (const [k, mesh] of this.held) mesh.visible = k === id;
  }

  /** The mesh drawn for the weapon in hand (tests, debug). */
  heldMesh(): THREE.Mesh | null {
    return this.holding ? (this.held.get(this.holding) ?? null) : null;
  }

  private play(name: SoldierClip, fade = FADE): THREE.AnimationAction | undefined {
    const next = this.actions.get(name);
    if (!next || name === this.current) return next;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset().setEffectiveWeight(1).play();
    if (prev && fade > 0) next.crossFadeFrom(prev, fade, false);
    else prev?.stop();
    this.current = name;
    return next;
  }

  /** Brief flinch (e.g. a dummy hit): emissive pulse. */
  flash = 0;
  /** Spawn-protection shimmer, eased 0..1, and its pulse clock. */
  private shield = 0;
  private shieldT = 0;

  update(p: SoldierPose, dt: number): void {
    const pos = new THREE.Vector3(p.x, p.y, p.z);
    if (this.last && dt > 0) {
      const v = pos.clone().sub(this.last).divideScalar(dt);
      // Teleports (respawn) aren't movement.
      if (v.lengthSq() < 20 * 20) this.vel.lerp(v, Math.min(1, dt * 12));
    }
    this.last = pos;
    this.root.position.copy(pos);
    if (p.weapon) this.setWeapon(p.weapon);
    // A seated soldier rides: the truck's speed is not its legs'.
    const speed = p.seated ? 0 : Math.hypot(this.vel.x, this.vel.z);

    // Locomotion state.
    if (p.alive && !this.wasAlive) {
      // Respawn: drop the clamped death pose and start clean.
      this.mixer.stopAllAction();
      this.current = null;
      this.vel.set(0, 0, 0);
    }
    this.wasAlive = p.alive;
    if (p.grounded && !this.wasGrounded) this.landTimer = 0.25;
    this.landTimer = Math.max(0, this.landTimer - dt);
    let clip: SoldierClip;
    if (this.pack) this.pack.visible = (p.jetpack ?? false) && p.alive;
    if (!p.alive) clip = 'death';
    // On the pack: the airborne loop (legs bent and trailing), never the jump's take-off.
    else if (!p.grounded && p.flying) clip = 'fall';
    else if (!p.grounded) {
      const start = this.actions.get('jumpStart');
      const starting = this.current === 'jumpStart' && (start?.time ?? 1) < 0.35;
      clip = this.wasGrounded || starting ? 'jumpStart' : 'fall';
    } else if (this.landTimer > 0 && speed < 0.4 && !p.crouched) clip = 'land';
    else if (p.riding)
      clip = 'idle'; // standing on the deck, the board rolls
    else if (p.prone) clip = speed > 0.2 ? 'proneCrawl' : 'prone';
    else if (p.sliding)
      clip = 'crouchIdle'; // feet planted on the slide (leaned back below)
    else if (p.crouched) clip = speed > 0.4 ? 'crouchWalk' : 'crouchIdle';
    else if (speed < 0.4) clip = 'idle';
    else if (p.sprinting) clip = 'sprint';
    else clip = speed < 2.6 ? 'walk' : 'jog';
    this.wasGrounded = p.grounded;
    this.play(clip, clip === 'death' ? 0.1 : FADE);

    // Legs toward the movement (backwards: reversed clip), chest on the aim.
    const facing = p.yaw;
    let turn = 0;
    let reverse = false;
    const riding = (p.riding ?? false) && p.alive;
    this.board.visible = riding;
    this.model.position.y = riding ? DECK_HEIGHT : 0;
    if (riding) {
      aimBoard(this.board, this.vel.x, this.vel.z, p.yaw + Math.PI);
      // Lean into the carve: roll by the sideways force (yaw rate × speed / g), smoothed.
      const h = this.board.rotation.y;
      const rate =
        dt > 0
          ? Math.atan2(Math.sin(h - this.boardHeading), Math.cos(h - this.boardHeading)) / dt
          : 0;
      this.boardHeading = h;
      const lean = THREE.MathUtils.clamp((-rate * speed) / 9.8, -0.35, 0.35);
      this.boardLean += (lean - this.boardLean) * Math.min(1, dt * 8);
      this.board.rotation.order = 'YXZ';
      this.board.rotation.z = this.boardLean;
      if (speed > 0.4) {
        // Side-on stance: feet along the deck — the body stands 90° across it, regular or
        // goofy, whichever side needs less twist to keep the aim (the chest counter-turns).
        const travel = Math.atan2(-this.vel.x, -this.vel.z);
        const wrap = (a: number): number =>
          THREE.MathUtils.euclideanModulo(a + Math.PI, Math.PI * 2) - Math.PI;
        const a = wrap(travel + Math.PI / 2 - facing);
        const b = wrap(travel - Math.PI / 2 - facing);
        const d = Math.abs(a) < Math.abs(b) ? a : b;
        turn = THREE.MathUtils.clamp(d, -RIDE_TURN, RIDE_TURN);
      }
    }
    const prone = (p.prone ?? false) && p.alive;
    if (speed > 0.4 && p.alive && !riding && !prone) {
      // Movement heading in the camera's yaw convention (forward = -Z rotated by yaw).
      ({ turn, reverse } = legHeading(Math.atan2(-this.vel.x, -this.vel.z), facing));
    }
    this.legTurn += (turn - this.legTurn) * Math.min(1, dt * 10);
    // The model faces +Z; the bladed stance points the rifle aimYaw left of the body.
    // Prone lies straight along the facing (its rifle hold has no blade), on its hit volumes.
    this.model.rotation.y = facing + Math.PI - (prone ? 0 : this.aimYaw) + this.legTurn;
    // Slide: tip the body back about the legs' right axis through the crouched head, which
    // stays put (on its hit volume) while the feet swing out ahead (and drop back to the ground).
    const sliding = (p.sliding ?? false) && p.alive && p.grounded && !riding && !prone;
    this.slideLean += ((sliding ? 1 : 0) - this.slideLean) * Math.min(1, dt * SLIDE_EASE);
    if (this.slideLean < 1e-3) this.slideLean = 0;
    const lean = this.slideLean * SLIDE_LEAN;
    if (lean > 0) {
      // About the legs' right axis (facing + legTurn): the chest's counter-turn (−legTurn about
      // world up, in `aim`) then carries it onto the facing's right axis, so the rifle ends up
      // pitched by exactly `lean` about the same axis the aim pitch uses (taken off below).
      // About the facing's axis instead, the counter-turn would skew it (rotations don't
      // commute): ~9° of drift when looking away from the travel.
      const heading = facing + this.legTurn;
      tmpAxis.set(Math.cos(heading), 0, -Math.sin(heading));
      this.tilt.quaternion.setFromAxisAngle(tmpAxis, lean);
      tmpUp.set(0, PLAYER.crouchEyeHeight, 0).applyQuaternion(this.tilt.quaternion);
      this.tilt.position.set(-tmpUp.x, 0, -tmpUp.z);
    } else {
      this.tilt.quaternion.identity();
      this.tilt.position.set(0, 0, 0);
    }
    const act = this.current ? this.actions.get(this.current) : undefined;
    const native = this.current ? NATIVE_SPEED[this.current] : undefined;
    if (act) {
      const rate = native ? THREE.MathUtils.clamp(speed / native, 0.6, 1.5) : 1;
      act.timeScale = reverse && native ? -rate : rate;
    }

    this.updateLayers(p, speed, dt);
    this.head.position.copy(this.headRest);
    this.clavicles.forEach((b, i) => b.position.copy(this.clavicleRest[i]!));
    this.posed.forEach((b, i) => b.quaternion.copy(this.clipPose[i]!));
    this.mixer.update(dt);
    this.posed.forEach((b, i) => this.clipPose[i]!.copy(b.quaternion));
    this.applyLayerRoot();
    // (The slide lean tipped the rifle up with the body: aim that much lower.)
    if (p.alive) this.aim(-this.legTurn, prone ? p.pitch * 0.5 : p.pitch - lean, facing);
    if (p.alive && p.grounded && !prone && !p.sliding && !riding && !p.seated)
      this.footPlant?.update(p.y, dt, speed > 0.4);
    this.flash = Math.max(0, this.flash - dt * 6);
    const shielded = (p.shielded ?? false) && p.alive;
    this.shield = THREE.MathUtils.clamp(this.shield + (shielded ? dt : -dt) * 7, 0, 1);
    this.shieldT = this.shield > 0 ? this.shieldT + dt : 0;
    const e = shieldEmissive(this.shield, this.shieldT, this.flash);
    this.material.emissive.setRGB(e.r, e.g, e.b);
  }

  /**
   * Upper-body layers: the combat action (clip picked by stance/speed, time from the sim's
   * progress) and a flinch on a health drop, each eased in/out over locomotion. Held models
   * follow the action: the knife comes out for a strike, the frag replaces the gun until release.
   */
  private updateLayers(p: SoldierPose, speed: number, dt: number): void {
    const action = p.action ?? NO_ACTION;
    const prone = (p.prone ?? false) && p.alive;
    const want = pickActionClip(action, { crouched: p.crouched, speed, prone, alive: p.alive });
    const L = this.actionLayer;
    if (want && want !== L.clip) {
      // A new action: start it (the blend carries over, so a switch between variants is smooth).
      // One AnimationAction per clip: if the flinch is playing this clip (a stun that lands
      // mid-flinch plays the same chest hit), the flinch lets go of it, else it would overwrite
      // the action's time and weight and stop it under the stun.
      const F0 = this.flinchLayer;
      if (F0.clip === want) {
        F0.action = null;
        F0.clip = null;
        F0.blend = 0;
      }
      L.action?.stop();
      L.clip = want;
      L.action = this.layerActions.get(want) ?? null;
      L.action?.reset().play();
      if (L.action) L.action.paused = true;
    }
    const fadeIn = (want && LAYER_FADE_IN[want]) ?? LAYER_FADE_IN_DEFAULT;
    L.blend = want
      ? Math.min(1, L.blend + dt / fadeIn)
      : Math.max(0, L.blend - dt / LAYER_FADE_OUT);
    if (L.action && L.clip) {
      // Hold the last pose while fading out (reload ends on the grip, throw/strike on the return).
      if (want) {
        L.action.time = actionClipTime(action, L.clip, L.action.getClip().duration, this.marks);
      }
      L.action.setEffectiveWeight(layerWeight(L.blend));
      if (L.blend <= 0) {
        L.action.stop();
        L.action = null;
        L.clip = null;
      }
    }
    // Flinch: on any health drop within a life (the authoritative hp), over everything.
    const F = this.flinchLayer;
    if (p.hp !== undefined) {
      const kick = p.alive && this.lastHp !== null ? hurtFlinch(this.lastHp, p.hp) : 0;
      this.lastHp = p.hp;
      if (kick && !prone) {
        F.action?.stop();
        // (A stunned body already plays the chest flinch as its action: one action per clip.)
        F.clip = kick === 2 || L.clip === 'hit' ? 'hitHead' : 'hit';
        F.action = this.layerActions.get(F.clip) ?? null;
        F.action?.reset().play();
        if (F.action) F.action.paused = true;
        this.flinchTime = 0;
      }
    }
    if (F.action) {
      const dur = F.action.getClip().duration;
      this.flinchTime += dt;
      const on = this.flinchTime < dur && p.alive;
      F.blend = on ? Math.min(1, F.blend + dt / 0.04) : Math.max(0, F.blend - dt / 0.12);
      F.action.time = Math.min(dur, this.flinchTime);
      F.action.setEffectiveWeight(layerWeight(F.blend * 0.85, 1 + layerWeight(L.blend)));
      if (F.blend <= 0 && !on) {
        F.action.stop();
        F.action = null;
        F.clip = null;
      }
    }
    // What is in hand.
    const busy = L.blend > 0 ? action : NO_ACTION;
    const knife = busy.kind === 'strike' && this.held.has('knife');
    const away = busy.kind === 'throw';
    this.showHeld(knife ? 'knife' : away ? null : this.holding);
    if (this.grenade) this.grenade.visible = p.alive && grenadeInHand(busy);
  }

  /**
   * The layers' root (Spine1) in model space: the clip's chest orientation relative to the body's
   * facing, whatever the legs underneath are doing (a kneeling reload over the crouch clip, a
   * reload while running), blended in by each layer's weight. The build folds the source's
   * pelvis/spine into this bone as if its parents were at rest (build_soldiers.bake_actions).
   */
  private applyLayerRoot(): void {
    const layers = [
      { l: this.actionLayer, k: 1 },
      { l: this.flinchLayer, k: 0.85 },
    ].filter(({ l }) => l.blend > 0 && l.clip && l.action && this.layerRoots.has(l.clip));
    if (!layers.length) return;
    const root = this.layerRoot;
    this.model.updateMatrixWorld(true);
    const model = this.model.getWorldQuaternion(new THREE.Quaternion());
    const parent = root.parent!.getWorldQuaternion(new THREE.Quaternion());
    const q = parent.clone().multiply(root.quaternion);
    const local = new THREE.Quaternion();
    for (const { l, k } of layers) {
      const v = this.layerRoots.get(l.clip!)!.evaluate(l.action!.time) as unknown as number[];
      local.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize();
      const want = model.clone().multiply(this.layerRootRest).multiply(local);
      q.slerp(want, Math.min(1, l.blend * k));
    }
    if (this.flinchLayer.blend > 0 && this.flinchLayer.action) {
      // Procedural kick on top of the flinch clip (its motion is small): the chest snaps back
      // and recovers over the clip, harder for a heavy hit.
      const dur = this.flinchLayer.action.getClip().duration;
      const s = Math.sin(Math.PI * Math.min(1, this.flinchTime / Math.max(dur, 1e-3)));
      const kick = (this.flinchLayer.clip === 'hitHead' ? FLINCH_KICK_HEAVY : FLINCH_KICK) * s;
      // The model faces +Z: about its +X axis a negative angle tips the chest backwards.
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(model);
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(side, -kick * this.flinchLayer.blend));
    }
    root.quaternion.copy(parent.invert().multiply(q));
  }

  /**
   * Counter-turn the chest onto the aim (split over two spine bones) and pitch: a little in the
   * chest, the look in the head, the rest in the arms (clavicles: the rifle keeps the full aim).
   * The hit volumes are pitch-independent, so the head centre is pinned where the yaw left it.
   */
  private aim(yaw: number, pitch: number, facing: number): void {
    this.model.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3(Math.cos(facing), 0, -Math.sin(facing));
    const turn = new THREE.Quaternion().setFromAxisAngle(up, yaw / 2);
    for (const b of this.spine) rotateBone(b, turn);
    const pinned = this.head.localToWorld(this.headCentre.clone());
    const chest = new THREE.Quaternion().setFromAxisAngle(right, (pitch * CHEST_PITCH) / 2);
    for (const b of this.spine) rotateBone(b, chest);
    const look = pitch * (HEAD_PITCH - CHEST_PITCH);
    rotateBone(this.head, new THREE.Quaternion().setFromAxisAngle(right, look));
    // Both arms swing as one about a shared pivot (between the clavicles), so the support hand
    // keeps its grip on the rifle the right hand carries: the bladed stance puts the two
    // clavicles at different depths along the aim, and turning each about its own origin would
    // slide one hand along the gun.
    const arms = new THREE.Quaternion().setFromAxisAngle(right, pitch * (1 - CHEST_PITCH));
    const origins = this.clavicles.map((b) => b.getWorldPosition(new THREE.Vector3()));
    const pivot = origins
      .reduce((a, o) => a.add(o), new THREE.Vector3())
      .divideScalar(origins.length);
    this.clavicles.forEach((b, i) => {
      const to = origins[i]!.sub(pivot).applyQuaternion(arms).add(pivot);
      b.position.copy(b.parent!.worldToLocal(to));
      rotateBone(b, arms);
    });
    // Pin: shift the head (in its parent's frame) by however far the pitch moved its centre.
    const drift = pinned.sub(this.head.localToWorld(this.headCentre.clone()));
    const at = this.head.getWorldPosition(new THREE.Vector3()).add(drift);
    this.head.position.copy(this.head.parent!.worldToLocal(at));
    this.head.updateMatrixWorld(true);
  }
}

/**
 * How far the legs turn from the facing toward a movement heading (both in the camera's yaw
 * convention), ≤ 60°: moving backwards (more than 108° off the facing) the legs turn toward the
 * reversed heading and the clip plays backwards, so walking straight back keeps the hips square.
 */
export function legHeading(heading: number, facing: number): { turn: number; reverse: boolean } {
  const wrap = (a: number): number =>
    THREE.MathUtils.euclideanModulo(a + Math.PI, Math.PI * 2) - Math.PI;
  let d = wrap(heading - facing);
  const reverse = Math.abs(d) > Math.PI * 0.6;
  if (reverse) d = wrap(d + Math.PI);
  return { turn: THREE.MathUtils.clamp(d, -MAX_LEG_TURN, MAX_LEG_TURN), reverse };
}

/** Apply a world-space rotation to a bone's local rotation: Qp⁻¹ · q · Qp · Ql. */
function rotateBone(b: THREE.Bone, q: THREE.Quaternion): void {
  const parentQ = b.parent!.getWorldQuaternion(new THREE.Quaternion());
  b.quaternion.premultiply(parentQ.clone().invert().multiply(q).multiply(parentQ));
  b.updateMatrixWorld(true);
}

/** Action layers' root bone (tools/assets/build_soldiers.py LAYER_ROOT; three's node name). */
export const LAYER_ROOT = 'Bip01 Spine1';

/** Names of the upper-body nodes: the layer root and everything under it (chest, head, arms). */
export function upperBones(model: THREE.Object3D): Set<string> {
  const out = new Set<string>();
  model.getObjectByName(LAYER_ROOT.replaceAll(' ', '_'))?.traverse((o) => out.add(o.name));
  return out;
}

const layerClips = new WeakMap<
  THREE.AnimationClip,
  { clip: THREE.AnimationClip; root: THREE.KeyframeTrack | null }
>();

/**
 * The clip restricted to upper-body tracks below the root, plus the root's rotation track
 * (applied in model space by the soldier). Shared by every soldier of a variant.
 */
export function upperBodyClip(
  clip: THREE.AnimationClip,
  upper: Set<string>,
  root: string,
): { clip: THREE.AnimationClip; root: THREE.KeyframeTrack | null } {
  let out = layerClips.get(clip);
  if (!out) {
    const node = (t: THREE.KeyframeTrack): string => t.name.slice(0, t.name.lastIndexOf('.'));
    const tracks = clip.tracks.filter((t) => upper.has(node(t)) && node(t) !== root);
    const rootTrack = clip.tracks.find((t) => node(t) === root && t.name.endsWith('.quaternion'));
    out = {
      clip: new THREE.AnimationClip(clip.name, clip.duration, tracks),
      root: rootTrack ?? null,
    };
    layerClips.set(clip, out);
  }
  return out;
}
