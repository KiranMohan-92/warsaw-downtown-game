/**
 * Scanned first-person guns (Kiran-approved Higgsfield/Tripo models, built into gun space by
 * tools/assets/build_viewguns.py). Each replaces its primitive body but keeps the viewmodel's
 * contract (`GunModel`): the model is shifted so its bore, grip and muzzle land where the
 * primitive gun had them (anchors measured from calibrated side views), and the hands, arms,
 * sight glass and muzzle flash sit on the scan's real grip, handguard, optic and muzzle.
 * If loading fails the primitive guns stay.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PrimaryId, Slot } from '@wd/shared';
import { handMesh, armMesh, muzzleFlash, type GunModel } from './viewmodelModels.ts';
import { withTimeout } from './surfaceTextures.ts';
import { gltfLoader } from './gltfLoader.ts';
import type { KnifeModel } from './knifeModel.ts';
import { ArmRig, skinArms, type ArmPivots } from './fpRig.ts';
import { LOW_TEXTURE_SIZE } from './surfaceTextureStats.gen.ts';

export type ScanGunId = 'rifle' | 'pistol' | 'coil' | 'iskra' | 'shotgun' | 'marksman' | 'arc';
export const SCAN_GUN_IDS: readonly ScanGunId[] = [
  'rifle',
  'pistol',
  'coil',
  'iskra',
  'shotgun',
  'marksman',
  'arc',
];

type V3 = [number, number, number];

/** A moving part cut out of a scan (build_viewguns.PARTS), in the scan's own coordinates. */
export interface ScanPart {
  geometry: THREE.BufferGeometry;
  pivot: V3;
  axis: V3;
}

export interface ScanGun {
  /** The body (everything but the moving parts). */
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Magazine, bolt, pump, cell, vent cover… (reload/handling animations, render/fpAnims.ts). */
  parts?: ReadonlyMap<string, ScanPart>;
  /** The soldier's arms posed on this gun (tools/assets/build_fparms.py), else capsule hands. */
  arms?: {
    geometry: THREE.BufferGeometry;
    material: THREE.MeshStandardMaterial;
    /** Posed pivots (arms.json `bones`): the mesh is skinned around them for the arm IK. */
    pivots?: ArmPivots;
  };
}
export type ScanGuns = ReadonlyMap<ScanGunId, ScanGun>;

/** Where a scan sits in gun space and where its hands, sight and muzzle are (metres). */
interface ScanFit {
  /** Added to the scan's (bounding-box centred) coordinates. */
  offset: V3;
  /** Rear (trigger) hand and front hand: position, x/z rotation, capsule length. */
  hands: { at: V3; rx: number; rz: number; len?: number }[];
  /** Upper-arm lines from each hand off-screen. */
  arms: { from: V3; to: V3; r?: number }[];
  flash: { z: number; y: number; size: number; hidden?: boolean };
  sightY: number;
  adsZ: number;
  /** Hip pose (camera space): framed so the trigger glove shows at the bottom-right edge. */
  hip: V3;
  redDot: boolean;
  /** Reflex/holo glass (or scope lens) plane in front of the eye. */
  glass?: { at: V3; w: number; h: number; color: string; opacity: number; round?: boolean };
  /**
   * Our tube red-dot on a riser (the generated rifle came without an optic): tube axis at the
   * sight line, riser down to the rail top `rail` (measured from the mesh), centred at `z`.
   */
  optic?: { rail: number; z: number };
}

export const SCAN_FITS: Record<ScanGunId, ScanFit> = {
  // Scan: scope axis ~0.17 (eyepiece z +0.25), muzzle z -0.55 (bore ~0.063), grip (0.21, -0.06),
  // handguard z -0.35..-0.02 (y 0.02..0.11). Full ADS shows the scope overlay.
  marksman: {
    offset: [0, 0, 0],
    hands: [
      { at: [0.012, -0.08, 0.21], rx: -0.32, rz: 0.25 },
      { at: [-0.02, 0.01, -0.2], rx: 0.1, rz: -0.35 },
    ],
    arms: [
      { from: [0.02, -0.11, 0.24], to: [0.12, -0.32, 0.55] },
      { from: [-0.035, -0.02, -0.18], to: [-0.22, -0.3, 0.15], r: 0.04 },
    ],
    flash: { z: -0.56, y: 0.063, size: 0.2 },
    sightY: 0.17,
    adsZ: 0.36,
    hip: [0.15, -0.14, -0.5],
    redDot: false,
    glass: { at: [0, 0.17, 0.26], w: 0.036, h: 0.036, color: '#9fd8ff', opacity: 0.3, round: true },
  },
  // Scan: holo window ~0.16–0.2 over z -0.02..0.08, a muzzle device to 0.189 on the centreline at
  // z -0.42 (the dot rides just over it), barrel/handguard y 0.05..0.16, grip (0.25, -0.05).
  arc: {
    offset: [0, 0, 0],
    hands: [
      { at: [0.012, -0.07, 0.25], rx: -0.32, rz: 0.25 },
      { at: [-0.03, 0.06, -0.2], rx: 0.1, rz: -0.35 },
    ],
    arms: [
      { from: [0.02, -0.1, 0.28], to: [0.12, -0.32, 0.58] },
      { from: [-0.045, 0.03, -0.18], to: [-0.22, -0.3, 0.15], r: 0.04 },
    ],
    flash: { z: -0.44, y: 0.1, size: 0.14 },
    sightY: 0.192,
    adsZ: 0.3,
    hip: [0.15, -0.15, -0.46],
    redDot: true,
    glass: { at: [0, 0.184, 0.04], w: 0.036, h: 0.036, color: '#9ff0ff', opacity: 0.16 },
  },
  // Scan: rib top 0.09–0.10 (front bead 0.101 at the muzzle z -0.49), bore ~0.065, pump z -0.25
  // to -0.05 (y ~0.03), pistol grip (0.22, -0.03). Bead sight: the dot rides just over the rib.
  shotgun: {
    offset: [0, 0, 0],
    hands: [
      { at: [0.012, -0.06, 0.22], rx: -0.32, rz: 0.25 },
      { at: [-0.02, 0.0, -0.15], rx: 0.1, rz: -0.35 },
    ],
    arms: [
      { from: [0.02, -0.09, 0.25], to: [0.12, -0.3, 0.55] },
      { from: [-0.035, -0.03, -0.13], to: [-0.22, -0.3, 0.15], r: 0.04 },
    ],
    flash: { z: -0.5, y: 0.065, size: 0.22 },
    sightY: 0.105,
    // Aimed further out than the rifles: the fat receiver would fill the view up close.
    adsZ: 0.45,
    hip: [0.15, -0.13, -0.47],
    redDot: false,
  },
  // Scan (after offset): rail top 0.053 over z -0.28..0.16, front sight post to 0.102 at z -0.3,
  // so the dot rides 1 cm over the post (lower-third co-witness).
  rifle: {
    offset: [0, -0.078, -0.015],
    hands: [
      { at: [0.012, -0.12, 0.12], rx: -0.32, rz: 0.25 },
      { at: [-0.02, -0.045, -0.2], rx: 0.1, rz: -0.35 },
    ],
    arms: [
      { from: [0.02, -0.15, 0.15], to: [0.12, -0.36, 0.45] },
      { from: [-0.035, -0.075, -0.18], to: [-0.22, -0.32, 0.1], r: 0.04 },
    ],
    flash: { z: -0.45, y: 0.012, size: 0.16 },
    sightY: 0.112,
    adsZ: 0.3,
    hip: [0.15, -0.13, -0.47],
    redDot: true,
    glass: {
      at: [0, 0.112, -0.046],
      w: 0.034,
      h: 0.034,
      color: '#b9e3ff',
      opacity: 0.12,
      round: true,
    },
    optic: { rail: 0.053, z: -0.02 },
  },
  // Scan: bore y 0.035, muzzle z -0.095, grip (0.06, -0.04), slide top 0.06.
  pistol: {
    offset: [0, -0.021, -0.025],
    hands: [
      { at: [0.004, -0.07, 0.04], rx: -0.22, rz: 0.05, len: 0.06 },
      { at: [-0.018, -0.075, 0.03], rx: -0.1, rz: -0.5, len: 0.05 },
    ],
    arms: [
      { from: [0.01, -0.1, 0.07], to: [0.14, -0.33, 0.42] },
      { from: [-0.03, -0.1, 0.06], to: [-0.2, -0.33, 0.4], r: 0.04 },
    ],
    flash: { z: -0.13, y: 0.014, size: 0.11 },
    sightY: 0.042,
    // Arm's length: closer made the two-hand grip fill the lower screen.
    adsZ: 0.44,
    hip: [0.11, -0.095, -0.42],
    redDot: false,
  },
  // Scan: bore y 0.10, muzzle z -0.51, grip (0.19, -0.1), scope centre (0.12, 0.175).
  coil: {
    offset: [0, -0.088, -0.07],
    hands: [
      { at: [0.012, -0.12, 0.13], rx: -0.32, rz: 0.25 },
      { at: [-0.02, -0.045, -0.32], rx: 0.1, rz: -0.35 },
    ],
    arms: [
      { from: [0.02, -0.15, 0.16], to: [0.12, -0.36, 0.46] },
      { from: [-0.035, -0.075, -0.3], to: [-0.22, -0.32, 0.1], r: 0.04 },
    ],
    flash: { z: -0.58, y: 0.012, size: 0.01, hidden: true },
    sightY: 0.087,
    adsZ: 0.36,
    hip: [0.15, -0.13, -0.5],
    redDot: false,
    glass: {
      at: [0, 0.087, 0.18],
      w: 0.032,
      h: 0.032,
      color: '#7fd9ff',
      opacity: 0.3,
      round: true,
    },
  },
  // Scan: bore y 0.095, muzzle z -0.31, grip (0.10, -0.03), magwell (-0.14, -0.05), holo (0.07, 0.155).
  iskra: {
    offset: [0, -0.083, -0.01],
    hands: [
      { at: [0.012, -0.1, 0.1], rx: -0.32, rz: 0.25 },
      { at: [-0.02, -0.12, -0.15], rx: 0.2, rz: -0.4 },
    ],
    arms: [
      { from: [0.02, -0.13, 0.13], to: [0.12, -0.34, 0.44] },
      { from: [-0.035, -0.14, -0.13], to: [-0.22, -0.32, 0.18], r: 0.04 },
    ],
    flash: { z: -0.33, y: 0.012, size: 0.11 },
    sightY: 0.072,
    adsZ: 0.3,
    hip: [0.14, -0.12, -0.45],
    redDot: true,
    glass: { at: [0, 0.072, 0.05], w: 0.03, h: 0.032, color: '#ffd2a8', opacity: 0.14 },
  },
};

/** The scan each loadout primary is drawn with (first person and on soldiers). */
export const PRIMARY_SCANS: Record<PrimaryId, ScanGunId> = {
  ar7: 'rifle',
  coil: 'coil',
  iskra: 'iskra',
  shotgun: 'shotgun',
  marksman: 'marksman',
  arc: 'arc',
};

/** What a third-person soldier holds: a scanned gun, or the knife. */
export type HeldWeapon = ScanGunId | 'knife';

/** The model for the weapon in hand (`slot`) of a life carrying `primary`. */
export function heldWeapon(slot: Slot, primary: PrimaryId): HeldWeapon {
  return slot === 'knife' ? 'knife' : slot === 'sidearm' ? 'pistol' : PRIMARY_SCANS[primary];
}

/**
 * Where a scan sits in a soldier's gun frame. The soldiers' arms are posed once, on the rifle
 * (tools/assets/build_soldiers.py: the `gun_o/f/u` markers are the rifle's gun space), so every
 * other gun is moved until its measured grip anchor (`hands[0].at`) lands on the rifle's grip,
 * i.e. in the right hand. Every scan is built bore-along -Z in gun space
 * (tools/assets/build_viewguns.py), so no rotation is needed: the barrel follows the aim.
 */
export function thirdPersonOffset(id: ScanGunId): V3 {
  const fit = SCAN_FITS[id];
  const grip = fit.hands[0]!.at;
  const rifleGrip = SCAN_FITS.rifle.hands[0]!.at;
  return [0, 1, 2].map((i) => fit.offset[i]! + rifleGrip[i]! - grip[i]!) as V3;
}

/** A model a soldier can hold: shared geometry + material, placed in the soldier's gun frame. */
export interface HeldModel {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  position: THREE.Vector3;
  rotation?: THREE.Euler;
}

/** The third-person knife: one merged mesh (one draw), handle in the fist, blade forward. */
export function thirdPersonKnife(): HeldModel {
  const part = (
    w: number,
    h: number,
    d: number,
    y: number,
    z: number,
    color: string,
  ): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(w, h, d).translate(0, y, z);
    const c = new THREE.Color(color);
    const n = g.getAttribute('position').count;
    g.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(Array(n).fill([c.r, c.g, c.b]).flat(), 3),
    );
    return g;
  };
  // Knife space: handle centred on the origin (the fist), blade along -Z. Parts are told apart
  // by vertex colour (dark grip and guard, bright blade) so the knife stays one draw.
  const geometry = mergeGeometries([
    part(0.026, 0.03, 0.12, 0, 0.015, '#26272a'),
    part(0.052, 0.036, 0.01, 0, -0.05, '#3a3d40'),
    part(0.006, 0.032, 0.15, 0.002, -0.13, '#c3cacf'),
    part(0.006, 0.02, 0.03, -0.004, -0.215, '#c3cacf'),
  ]);
  if (!geometry) throw new Error('knife geometry');
  const material = new THREE.MeshStandardMaterial({
    name: 'soldier:knife',
    vertexColors: true,
    roughness: 0.3,
    metalness: 0.7,
  });
  return { geometry, material, ...knifeInFist() };
}

/** The rifle hold's fist: the handle runs through it, the blade tipped up toward the aim. */
function knifeInFist(): { position: THREE.Vector3; rotation: THREE.Euler } {
  const g = SCAN_FITS.rifle.hands[0]!.at;
  return {
    position: new THREE.Vector3(g[0], g[1] + 0.02, g[2]),
    rotation: new THREE.Euler(0.35, 0, 0),
  };
}

/** Body + parts as one geometry (soldiers hold the gun whole, one draw), cached per scan. */
const whole = new WeakMap<ScanGun, THREE.BufferGeometry>();
export function wholeGun(scan: ScanGun): THREE.BufferGeometry {
  if (!scan.parts?.size) return scan.geometry;
  let g = whole.get(scan);
  if (!g) {
    const pieces = [scan.geometry, ...[...scan.parts.values()].map((p) => p.geometry)];
    g = mergeGeometries(pieces) ?? scan.geometry;
    whole.set(scan, g);
  }
  return g;
}

/**
 * The seax model in a soldier's fist: same placement as the primitive (grip origin on the rifle
 * hold's fist, blade tipped up toward the aim), its own material copy (soldiers sample the lamp
 * volume at their position, the viewmodel at the camera: one material can be patched one way).
 */
export function thirdPersonModelKnife(model: KnifeModel): HeldModel {
  return { geometry: model.geometry, material: model.material.clone(), ...knifeInFist() };
}

/** Everything a soldier can hold, sharing the scans' (and the knife model's) geometry. */
export function thirdPersonModels(
  scans: ScanGuns,
  knife: KnifeModel | null = null,
): Partial<Record<HeldWeapon, HeldModel>> {
  const out: Partial<Record<HeldWeapon, HeldModel>> = {
    knife: knife ? thirdPersonModelKnife(knife) : thirdPersonKnife(),
  };
  for (const id of SCAN_GUN_IDS) {
    const scan = scans.get(id);
    if (scan)
      out[id] = {
        geometry: wholeGun(scan),
        // Own copy (textures shared): the viewmodel's material samples the lamp volume at the
        // world camera ('camera' mode), soldiers' at their own position ('world' mode). One
        // material can only be patched one way (lampLight.patchLampVolume throws otherwise).
        material: scan.material.clone(),
        position: new THREE.Vector3(...thirdPersonOffset(id)),
      };
  }
  return out;
}

/** Dark anodised optic; double-sided so the tube's inside shows through the glass. */
const OPTIC_MAT = new THREE.MeshStandardMaterial({
  color: '#1f2224',
  roughness: 0.55,
  metalness: 0.6,
  side: THREE.DoubleSide,
});

/** Build the viewmodel gun for a scan (same contract as the primitive builders). */
export function buildScannedGun(id: ScanGunId, scan: ScanGun): GunModel {
  const fit = SCAN_FITS[id];
  const group = new THREE.Group();
  const body = new THREE.Mesh(scan.geometry, scan.material);
  body.position.set(...fit.offset);
  group.add(body);
  const offset = new THREE.Vector3(...fit.offset);
  const rig: GunRig = { id, offset, parts: new Map(), arms: null, shell: null, steam: [] };
  for (const [name, part] of scan.parts ?? []) {
    // Same material as the body (no new program); moved by render/fpAnims.ts clips.
    const mesh = new THREE.Mesh(part.geometry, scan.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeTranslation(offset);
    group.add(mesh);
    const droppable = name === 'mag' || name === 'cell';
    const drop = droppable ? new THREE.Mesh(part.geometry, scan.material) : null;
    if (drop) {
      drop.matrixAutoUpdate = false;
      drop.visible = false;
      group.add(drop);
    }
    rig.parts.set(name, {
      mesh,
      pivot: new THREE.Vector3(...part.pivot).add(offset),
      axis: new THREE.Vector3(...part.axis).normalize(),
      drop,
    });
  }
  if (scan.arms) {
    // Exported in gun space (scan offset included): no transform.
    if (scan.arms.pivots) {
      const mesh = new THREE.SkinnedMesh(scan.arms.geometry, scan.arms.material);
      rig.arms = new ArmRig(mesh, scan.arms.pivots);
      group.add(mesh);
      if (id === 'shotgun') rig.shell = shotgunShell(rig.arms);
    } else group.add(new THREE.Mesh(scan.arms.geometry, scan.arms.material));
  } else {
    for (const h of fit.hands) group.add(handMesh(h.at, h.rx, h.rz, h.len));
    for (const a of fit.arms) group.add(armMesh(a.from, a.to, a.r));
  }
  if (fit.optic) {
    // Tube red-dot (Aimpoint-like): open tube (inside visible through the glass), end rings,
    // adjustment turrets, riser and rail clamp.
    const { rail, z } = fit.optic;
    const y = fit.sightY;
    const r = 0.019;
    const len = 0.058;
    const add = (geo: THREE.BufferGeometry, px: number, py: number, pz: number, rx = 0): void => {
      const m = new THREE.Mesh(geo, OPTIC_MAT);
      m.position.set(px, py, pz);
      m.rotation.x = rx;
      group.add(m);
    };
    add(new THREE.CylinderGeometry(r, r, len, 28, 1, true), 0, y, z, Math.PI / 2);
    for (const end of [-1, 1])
      add(new THREE.TorusGeometry(r + 0.001, 0.0025, 8, 28), 0, y, z + (end * len) / 2);
    add(new THREE.CylinderGeometry(0.0065, 0.0065, 0.012, 16), 0, y + r + 0.004, z);
    const side = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.012, 16), OPTIC_MAT);
    side.position.set(r + 0.004, y, z);
    side.rotation.z = Math.PI / 2;
    group.add(side);
    const riserTop = y - r + 0.002;
    add(new THREE.BoxGeometry(0.022, riserTop - rail, 0.04), 0, (riserTop + rail) / 2, z);
    add(new THREE.BoxGeometry(0.034, 0.008, 0.05), 0, rail + 0.004, z);
  }
  if (fit.glass) {
    const g = fit.glass;
    const lens = new THREE.Mesh(
      g.round ? new THREE.CircleGeometry(g.w / 2, 20) : new THREE.PlaneGeometry(g.w, g.h),
      new THREE.MeshPhysicalMaterial({
        color: g.color,
        transparent: true,
        opacity: g.opacity,
        roughness: 0.05,
        depthWrite: false,
      }),
    );
    lens.position.set(...g.at);
    group.add(lens);
  }
  const flash = muzzleFlash(fit.flash.z, fit.flash.y, fit.flash.size);
  if (fit.flash.hidden) flash.visible = false;
  group.add(flash);
  const vent = rig.parts.get('vent');
  if (vent) rig.steam = ventSteam(group, vent.pivot);
  return {
    group,
    flash,
    sightY: fit.sightY,
    adsZ: fit.adsZ,
    hip: new THREE.Vector3(...fit.hip),
    redDot: fit.redDot,
    rig,
  };
}

/** A scan's animatable pieces (parts, skinned arms, props), driven by the viewmodel. */
export interface GunRig {
  id: ScanGunId;
  /** The scan's SCAN_FITS offset (gun space). */
  offset: THREE.Vector3;
  parts: Map<
    string,
    { mesh: THREE.Mesh; pivot: THREE.Vector3; axis: THREE.Vector3; drop: THREE.Mesh | null }
  >;
  arms: ArmRig | null;
  /** Shotgun shell carried by the support hand while loading (child of its hand bone). */
  shell: THREE.Object3D | null;
  /** ARC vent steam puffs (additive quads, gun space). */
  steam: THREE.Mesh[];
}

const SHELL_HULL = new THREE.MeshStandardMaterial({
  name: 'shell:hull',
  color: '#7c1d16',
  roughness: 0.55,
});
const SHELL_BRASS = new THREE.MeshStandardMaterial({
  name: 'shell:brass',
  color: '#b08a45',
  roughness: 0.35,
  metalness: 0.9,
});

/** A 12-gauge shell pinched in the support hand (rides its hand bone; hidden until loading). */
function shotgunShell(arms: ArmRig): THREE.Object3D {
  const [w, k] = [arms.pivots.L[2], arms.pivots.L[3]];
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0095, 0.0095, 0.055, 12), SHELL_HULL);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.012, 12), SHELL_BRASS);
  head.position.y = -0.031;
  g.add(hull, head);
  // Between thumb and fingers, just past the knuckles, lying across the palm.
  g.position.set(
    w[0] + (k[0] - w[0]) * 1.5,
    w[1] + (k[1] - w[1]) * 1.5 + 0.012,
    w[2] + (k[2] - w[2]) * 1.5,
  );
  g.rotation.set(Math.PI / 2, 0, 0.3);
  g.visible = false;
  arms.bones[2]!.add(g);
  return g;
}

let steamTexture: THREE.Texture | null = null;
/** Soft puff sprite (canvas radial gradient), shared. */
function puffTexture(): THREE.Texture | null {
  if (steamTexture || typeof document === 'undefined') return steamTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  const r = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  r.addColorStop(0, 'rgba(255,255,255,0.9)');
  r.addColorStop(0.5, 'rgba(230,238,245,0.35)');
  r.addColorStop(1, 'rgba(220,230,240,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  steamTexture = new THREE.CanvasTexture(c);
  return steamTexture;
}

const STEAM_MAT = new THREE.MeshBasicMaterial({
  color: '#dfe8f0',
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});

/** Six steam puffs at the ARC's vent (animated by the viewmodel on an overheat). */
function ventSteam(group: THREE.Group, pivot: THREE.Vector3): THREE.Mesh[] {
  STEAM_MAT.map = puffTexture();
  const out: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), STEAM_MAT.clone());
    m.position.copy(pivot);
    m.visible = false;
    m.userData.seed = i;
    group.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Arms material over the arms atlas (tools/assets/build_fparms.py: sleeves + gloves over a strip
 * holding the soldiers' forearm plate; roughness in G, fabric 0.85 / satin shell; emissive = the
 * plate's cyan edge light, ×1.6 like the soldiers' gear). Every map is set at load, so warm-up
 * compiles its one program and nothing toggles a map later.
 */
export function armsMaterialFrom(maps: {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  emissiveMap: THREE.Texture;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'arms',
    ...maps,
    roughness: 1,
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 1.6,
  });
}

function firstGeometry(scene: THREE.Object3D, what: string): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry | null = null;
  scene.traverse((o) => {
    if (!geometry && o instanceof THREE.Mesh) geometry = o.geometry as THREE.BufferGeometry;
  });
  if (!geometry) throw new Error(`${what}: no mesh`);
  return geometry;
}

interface GunsManifest {
  guns: Record<string, { parts?: Record<string, { pivot: V3; axis: V3 }> } | undefined>;
}

/** The geometry of the mesh named `name` (glTF node/mesh name), if any. */
function namedGeometry(scene: THREE.Object3D, name: string): THREE.BufferGeometry | null {
  let geometry: THREE.BufferGeometry | null = null;
  scene.traverse((o) => {
    if (!geometry && o instanceof THREE.Mesh && o.name === name)
      geometry = o.geometry as THREE.BufferGeometry;
  });
  return geometry;
}

export interface GunScanLoadStats {
  elapsedMs: number;
  lowRes: boolean;
  /** Estimated RGBA8 texture storage including mipmaps, shared arms counted once. */
  textureBytes: number;
  /** Decoded vertex/index buffers, shared/interleaved buffers counted once. */
  geometryBytes: number;
  gunCount: number;
}

const loadStats = new WeakMap<ScanGuns, GunScanLoadStats>();

/** Startup measurements for the autotest/performance probe (no render-loop work). */
export function gunScanLoadStats(scans: ScanGuns): GunScanLoadStats | undefined {
  return loadStats.get(scans);
}

/** Low caps the longest texture edge at 512, including the shared rectangular arms atlas. */
export function gunTextureSize(width: number, height: number, lowRes: boolean): [number, number] {
  const scale = lowRes ? Math.min(1, LOW_TEXTURE_SIZE / Math.max(width, height)) : 1;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

function textureStorage(width: number, height: number): number {
  let bytes = 0;
  for (;;) {
    bytes += width * height * 4;
    if (width === 1 && height === 1) return bytes;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

function geometryStorage(scans: ScanGuns): number {
  const buffers = new Set<ArrayBufferLike>();
  const add = (geometry: THREE.BufferGeometry): void => {
    if (geometry.index) buffers.add(geometry.index.array.buffer);
    for (const attribute of Object.values(geometry.attributes))
      buffers.add(
        attribute instanceof THREE.InterleavedBufferAttribute
          ? attribute.data.array.buffer
          : attribute.array.buffer,
      );
  };
  for (const scan of scans.values()) {
    add(scan.geometry);
    for (const part of scan.parts?.values() ?? []) add(part.geometry);
    if (scan.arms) add(scan.arms.geometry);
  }
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

/** Load every primary and the sidearm before warm-up; Low uploads at most 512 px textures. */
export async function loadGunScans(
  renderer: THREE.WebGLRenderer | null,
  opts: { lowRes?: boolean; base?: string; timeoutMs?: number } = {},
): Promise<ScanGuns> {
  const started = performance.now();
  let textureBytes = 0;
  const base = `${opts.base ?? import.meta.env.BASE_URL}models/guns/`;
  const tex = new THREE.TextureLoader();
  const aniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  const load = async (url: string, srgb: boolean): Promise<THREE.Texture> => {
    const t: THREE.Texture = await tex.loadAsync(url);
    const image = t.image as HTMLImageElement;
    const [width, height] = gunTextureSize(image.width, image.height, opts.lowRes ?? false);
    if (width !== image.width || height !== image.height) {
      // Existing files remain the source; resize before upload so Low never makes a 1k/2k GPU
      // allocation. The original decoded image can be collected once the loader releases it.
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('gun texture resize unavailable');
      context.drawImage(image, 0, 0, width, height);
      t.image = canvas;
    }
    textureBytes += textureStorage(width, height);
    t.flipY = false; // glTF uv convention
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    renderer?.initTexture(t);
    return t;
  };
  const armsBase = `${opts.base ?? import.meta.env.BASE_URL}models/arms/`;
  const armPoses = fetch(`${armsBase}arms.json`)
    .then((r) =>
      r.ok
        ? (r.json() as Promise<{ poses: Record<string, { bones?: ArmPivots } | undefined> }>)
        : null,
    )
    .catch(() => null);
  const gunManifest = fetch(`${base}guns.json`)
    .then((r) => (r.ok ? (r.json() as Promise<GunsManifest>) : null))
    .catch(() => null);
  let armsMaterial: Promise<THREE.MeshStandardMaterial> | null = null;
  const loadArms = async (id: ScanGunId): Promise<ScanGun['arms']> => {
    if (!(await armPoses)?.poses[id]) return undefined;
    armsMaterial ??= Promise.all([
      load(`${armsBase}arms_albedo.webp`, true),
      load(`${armsBase}arms_normal.webp`, false),
      load(`${armsBase}arms_rough.webp`, false),
      load(`${armsBase}arms_emissive.webp`, true),
    ]).then(([map, normalMap, roughnessMap, emissiveMap]) =>
      armsMaterialFrom({ map, normalMap, roughnessMap, emissiveMap }),
    );
    const [gltf, material] = await Promise.all([
      gltfLoader().loadAsync(`${armsBase}${id}.gltf`),
      armsMaterial,
    ]);
    const geometry = firstGeometry(gltf.scene, `arms ${id}`);
    const pivots = (await armPoses)?.poses[id]?.bones;
    if (pivots) skinArms(geometry, pivots);
    return { geometry, material, pivots };
  };
  const work = Promise.all(
    SCAN_GUN_IDS.map(async (id) => {
      const [gltf, albedo, normal, arm, arms] = await Promise.all([
        gltfLoader().loadAsync(`${base}${id}.gltf`),
        load(`${base}${id}_albedo.webp`, true),
        load(`${base}${id}_normal.webp`, false),
        load(`${base}${id}_arm.webp`, false),
        loadArms(id),
      ]);
      const geometry = namedGeometry(gltf.scene, id) ?? firstGeometry(gltf.scene, `gun ${id}`);
      const specs = (await gunManifest)?.guns[id]?.parts ?? {};
      const parts = new Map<string, ScanPart>();
      for (const [name, spec] of Object.entries(specs)) {
        const g = namedGeometry(gltf.scene, name);
        if (g) parts.set(name, { geometry: g, pivot: spec.pivot, axis: spec.axis });
      }
      const material = new THREE.MeshStandardMaterial({
        name: `gun:${id}`,
        map: albedo,
        normalMap: normal,
        roughnessMap: arm,
        metalnessMap: arm,
        roughness: 1,
        metalness: 1,
      });
      return [id, { geometry, material, arms, parts }] as const;
    }),
  );
  const scans = new Map(await withTimeout(work, opts.timeoutMs ?? 15_000, 'gun scans'));
  loadStats.set(scans, {
    elapsedMs: performance.now() - started,
    lowRes: opts.lowRes ?? false,
    textureBytes,
    geometryBytes: geometryStorage(scans),
    gunCount: scans.size,
  });
  return scans;
}
