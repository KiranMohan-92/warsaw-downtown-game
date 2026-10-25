import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GunRig } from './viewGunScans.ts';

/**
 * Greybox first-person weapon models built from primitives (replaced by CC0 models in M5).
 * Each model is authored in "gun space": bore along -Z, origin at the receiver, metres.
 */

export const MAT = {
  steel: new THREE.MeshStandardMaterial({ color: '#2e3134', roughness: 0.42, metalness: 0.85 }),
  alu: new THREE.MeshStandardMaterial({ color: '#3d4247', roughness: 0.5, metalness: 0.7 }),
  polymer: new THREE.MeshStandardMaterial({ color: '#3b372f', roughness: 0.78, metalness: 0 }),
  tan: new THREE.MeshStandardMaterial({ color: '#8b7a5c', roughness: 0.7, metalness: 0.05 }),
  blade: new THREE.MeshStandardMaterial({ color: '#9aa2a8', roughness: 0.22, metalness: 0.95 }),
  olive: new THREE.MeshStandardMaterial({ color: '#4e5536', roughness: 0.8, metalness: 0.1 }),
  glove: new THREE.MeshStandardMaterial({ color: '#2b2926', roughness: 0.9 }),
  sleeve: new THREE.MeshStandardMaterial({ color: '#4d5140', roughness: 0.95 }),
};

/** A gloved hand (capsule) at `at`, rotated about x and z. */
export function handMesh(
  at: [number, number, number],
  rx: number,
  rz: number,
  len = 0.05,
): THREE.Mesh {
  const palm = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, len, 6, 12), MAT.glove);
  palm.position.set(...at);
  palm.rotation.set(rx, 0, rz);
  return palm;
}

/** A sleeved forearm/upper-arm segment from `from` to `to`. */
export function armMesh(
  from: [number, number, number],
  to: [number, number, number],
  r = 0.042,
): THREE.Mesh {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 1.15, a.distanceTo(b), 16),
    MAT.sleeve,
  );
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

class Builder {
  readonly group = new THREE.Group();
  box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    m: THREE.Material,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.22), m);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    return mesh;
  }
  cyl(
    r: number,
    len: number,
    x: number,
    y: number,
    z: number,
    m: THREE.Material,
    r2 = r,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, 18), m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    return mesh;
  }
  hand(x: number, y: number, z: number, rx: number, rz: number, len = 0.05): void {
    this.group.add(handMesh([x, y, z], rx, rz, len));
  }
  arm(from: [number, number, number], to: [number, number, number], r = 0.042): void {
    this.group.add(armMesh(from, to, r));
  }
  /** Collapse opaque parts into one mesh per material (dozens of parts → a few draws). */
  finish(): THREE.Group {
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const child of [...this.group.children]) {
      if (!(child instanceof THREE.Mesh) || (child.material as THREE.Material).transparent)
        continue;
      child.updateMatrix();
      const geo = (child.geometry as THREE.BufferGeometry).clone().applyMatrix4(child.matrix);
      const flat = geo.index ? geo.toNonIndexed() : geo;
      for (const name of Object.keys(flat.attributes)) {
        if (!['position', 'normal', 'uv'].includes(name)) flat.deleteAttribute(name);
      }
      const mat = child.material as THREE.Material;
      buckets.set(mat, [...(buckets.get(mat) ?? []), flat]);
      this.group.remove(child);
    }
    for (const [mat, geos] of buckets) {
      const geo = mergeGeometries(geos);
      if (geo) this.group.add(new THREE.Mesh(geo, mat));
    }
    return this.group;
  }
}

/**
 * Muzzle flash texture layout (pixels): star in x 0..64, a black gutter, side plume in x 80..144.
 * The gutter keeps linear/trilinear sampling at the star's edge from picking up the plume's bright
 * base (Codex P2: with the halves touching, the star grew a detached bright strip, worse in mips);
 * 16 px stays at least one black texel wide down to mip 4.
 */
export const FLASH_TEX = { w: 144, h: 64, star: [0, 64], plume: [80, 144] } as const;
/** UV ranges (u0, u1) of the star and plume rectangles in the texture. */
export const FLASH_UV = {
  star: [FLASH_TEX.star[0] / FLASH_TEX.w, FLASH_TEX.star[1] / FLASH_TEX.w],
  plume: [FLASH_TEX.plume[0] / FLASH_TEX.w, FLASH_TEX.plume[1] / FLASH_TEX.w],
} as const;

/**
 * Brightness of the flash texture at (u, v) in [0, 1]² of its half: the star is a hot core with
 * five tapered petals (`petals` phase-shifted per half so the two layers never line up), the
 * plume a cone of flame from the muzzle (u = 0) to its ragged tip (u = 1), across v.
 */
export function flashIntensity(kind: 'star' | 'plume', u: number, v: number): number {
  if (kind === 'star') {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const r = Math.hypot(x, y);
    if (r >= 1) return 0;
    const a = Math.atan2(y, x);
    const core = Math.exp(-((r / 0.2) ** 2));
    // Petals: |cos(2.5a)| peaks five times round; sharpened so each is a narrow spike.
    const petal = Math.abs(Math.cos(2.5 * a)) ** 9 * (1 - r) ** 1.6;
    const glow = 0.35 * (1 - r) ** 3;
    return Math.min(1, core + 0.85 * petal + glow);
  }
  // Plume: widest a third of the way out, tapering to the tip; ragged lobes along its length.
  const half = 0.42 * Math.sin(Math.PI * Math.min(1, 0.25 + u * 0.95)) * (1 - 0.55 * u);
  const d = Math.abs(v - 0.5);
  if (half <= 0 || d >= half) return 0;
  const across = 1 - (d / half) ** 2;
  const lobes = 0.75 + 0.25 * Math.cos(u * 23 + Math.sin(u * 9) * 2);
  return Math.min(1, across ** 1.5 * (1 - u) ** 1.1 * lobes * 1.25);
}

let flashTexture: THREE.DataTexture | null = null;

/** RGBA8 texels of the flash texture (exported for tests). */
export function muzzleFlashTexels(): Uint8Array {
  const { w, h, star, plume } = FLASH_TEX;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o + 3] = 255;
      const inStar = x >= star[0] && x < star[1];
      const inPlume = x >= plume[0] && x < plume[1];
      if (!inStar && !inPlume) continue; // gutter: black
      const [x0, x1] = inStar ? star : plume;
      const u = (x - x0 + 0.5) / (x1 - x0);
      const v = (y + 0.5) / h;
      const i = flashIntensity(inStar ? 'star' : 'plume', u, v);
      // Hot white core, orange edges; premultiplied (additive: alpha only scales).
      const hot = i * i;
      data[o] = Math.round(255 * i);
      data[o + 1] = Math.round(255 * i * (0.55 + 0.4 * hot));
      data[o + 2] = Math.round(255 * i * (0.18 + 0.6 * hot * hot));
    }
  }
  return data;
}

/** One shared texture for every gun's flash (built in plain JS: no DOM, works in tests). */
function muzzleFlashTexture(): THREE.DataTexture {
  if (flashTexture) return flashTexture;
  const tex = new THREE.DataTexture(muzzleFlashTexels(), FLASH_TEX.w, FLASH_TEX.h);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  flashTexture = tex;
  return tex;
}

/**
 * Muzzle flash in gun space (bore along −Z) at the muzzle: a five-point star facing down the bore
 * plus two crossed flame plumes along it, so it reads as a burst of flame from any angle instead
 * of a flat square. One mesh, one draw; front faces only, every quad doubled with reversed
 * winding (no double-sided program). `kickFlash` varies it per shot.
 */
export function muzzleFlash(z: number, y: number, size: number, color = '#ffffff'): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const quad = (p: [number, number, number][], t: [number, number][]): void => {
    for (const order of [
      [0, 1, 2, 0, 2, 3],
      [0, 2, 1, 0, 3, 2],
    ]) {
      for (const k of order) {
        pos.push(...p[k]!);
        uv.push(...t[k]!);
      }
    }
  };
  const s = size * 0.65;
  // Star facing down the bore (the texture's star rectangle).
  quad(
    [
      [-s, -s, -0.01 * size],
      [s, -s, -0.01 * size],
      [s, s, -0.01 * size],
      [-s, s, -0.01 * size],
    ],
    [
      [FLASH_UV.star[0], 0],
      [FLASH_UV.star[1], 0],
      [FLASH_UV.star[1], 1],
      [FLASH_UV.star[0], 1],
    ],
  );
  // Plumes: two crossed quads from just behind the muzzle out along −Z (the plume rectangle).
  const len = size * 1.9;
  const w = size * 0.7;
  const z0 = size * 0.08;
  const plumeUv: [number, number][] = [
    [FLASH_UV.plume[0], 0],
    [FLASH_UV.plume[1], 0],
    [FLASH_UV.plume[1], 1],
    [FLASH_UV.plume[0], 1],
  ];
  quad(
    [
      [0, -w, z0],
      [0, -w, z0 - len],
      [0, w, z0 - len],
      [0, w, z0],
    ],
    plumeUv,
  );
  quad(
    [
      [-w, 0, z0],
      [-w, 0, z0 - len],
      [w, 0, z0 - len],
      [w, 0, z0],
    ],
    plumeUv,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const flash = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      map: muzzleFlashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  flash.name = 'muzzleFlash';
  flash.renderOrder = 2;
  flash.position.set(0, y, z);
  flash.visible = false;
  return flash;
}

/** Show a flash for one shot: random roll about the bore, size and plume length (`rnd` 0..1). */
export function kickFlash(flash: THREE.Object3D, rnd: () => number = Math.random): void {
  flash.visible = true;
  flash.rotation.set(0, 0, rnd() * Math.PI * 2);
  const s = 0.75 + rnd() * 0.5;
  flash.scale.set(s, s, s * (0.65 + rnd() * 0.7));
}

export interface GunModel {
  group: THREE.Group;
  flash: THREE.Mesh;
  /** Height of the sight line above the model origin (ADS aligns it with the view axis). */
  sightY: number;
  /** Distance of the sight from the eye when aimed (m, before scale). */
  adsZ: number;
  hip: THREE.Vector3;
  /** Rifle shows a HUD red dot; the pistol uses its iron sights. */
  redDot: boolean;
  /** Scanned guns: moving parts + skinned arms for the authored clips (render/fpAnims.ts). */
  rig?: GunRig;
}

/** Sight window centre height above the bore for the rifle's reflex sight. */
const RIFLE_SIGHT_Y = 0.086;

export function buildRifle(): GunModel {
  const b = new Builder();
  const { steel, alu, polymer, tan, glove } = MAT;
  b.box(0.05, 0.042, 0.34, 0, 0.012, 0, alu); // upper
  b.box(0.046, 0.04, 0.2, 0, -0.026, 0.02, alu); // lower
  b.box(0.004, 0.018, 0.07, 0.026, 0.012, -0.01, steel); // ejection port
  b.box(0.03, 0.01, 0.03, 0, 0.034, 0.16, steel); // charging handle
  b.box(0.058, 0.056, 0.27, 0, 0.004, -0.29, tan); // handguard
  for (let i = 0; i < 26; i++) b.box(0.017, 0.005, 0.006, 0, 0.036, -0.43 + i * 0.02, steel);
  for (let i = 0; i < 4; i++) b.box(0.061, 0.01, 0.03, 0, -0.012, -0.21 - i * 0.055, polymer);
  b.box(0.03, 0.07, 0.034, 0, -0.058, -0.33, polymer).rotation.x = 0.1; // foregrip
  b.cyl(0.0095, 0.2, 0, 0.012, -0.52, steel);
  b.box(0.022, 0.024, 0.026, 0, 0.012, -0.44, steel);
  b.cyl(0.014, 0.06, 0, 0.012, -0.64, steel);
  for (let i = 0; i < 3; i++) b.box(0.03, 0.004, 0.008, 0, 0.026, -0.62 - i * 0.016, steel);
  b.box(0.046, 0.05, 0.08, 0, -0.058, -0.05, alu);
  b.box(0.032, 0.09, 0.07, 0, -0.115, -0.052, polymer).rotation.x = 0.12;
  b.box(0.032, 0.07, 0.066, 0, -0.19, -0.042, polymer).rotation.x = 0.28;
  b.box(0.012, 0.006, 0.07, 0, -0.058, 0.055, steel);
  b.box(0.034, 0.1, 0.045, 0, -0.085, 0.115, polymer).rotation.x = -0.32;
  b.cyl(0.015, 0.14, 0, 0, 0.23, alu);
  b.box(0.042, 0.075, 0.13, 0, -0.012, 0.3, polymer);
  b.box(0.046, 0.085, 0.02, 0, -0.012, 0.37, glove);
  const sy = RIFLE_SIGHT_Y;
  b.box(0.05, 0.01, 0.064, 0, sy + 0.027, -0.02, alu);
  b.box(0.01, 0.056, 0.064, -0.025, sy, -0.02, alu);
  b.box(0.01, 0.056, 0.064, 0.025, sy, -0.02, alu);
  b.box(0.044, 0.014, 0.08, 0, sy - 0.031, -0.02, alu);
  b.box(0.012, 0.014, 0.02, 0.031, sy + 0.01, -0.01, steel);
  b.hand(0.012, -0.09, 0.125, -0.32, 0.25);
  b.hand(-0.02, -0.055, -0.33, 0.1, -0.35);
  b.arm([0.02, -0.12, 0.16], [0.12, -0.35, 0.45]);
  b.arm([-0.035, -0.085, -0.3], [-0.22, -0.32, 0.1], 0.04);
  const group = b.finish();
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.04, 0.044),
    new THREE.MeshPhysicalMaterial({
      color: '#b9e3ff',
      transparent: true,
      opacity: 0.12,
      roughness: 0.05,
      depthWrite: false,
    }),
  );
  glass.position.set(0, sy, -0.04);
  group.add(glass);
  const flash = muzzleFlash(-0.69, 0.012, 0.16);
  group.add(flash);
  return {
    group,
    flash,
    sightY: sy,
    adsZ: 0.28,
    hip: new THREE.Vector3(0.16, -0.17, -0.4),
    redDot: true,
  };
}

/** Glowing parts of the near-future guns (emissive: they read in shadow and at night). */
const GLOW = {
  coil: new THREE.MeshStandardMaterial({
    color: '#0e2a33',
    emissive: '#35e0ff',
    emissiveIntensity: 1.6,
    roughness: 0.35,
    metalness: 0.6,
  }),
  smart: new THREE.MeshStandardMaterial({
    color: '#2a1606',
    emissive: '#ff8a2a',
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.3,
  }),
};

const COIL_SIGHT_Y = 0.1;

/**
 * KS-9 "Cewka" coilgun: long slim receiver, an exposed barrel wrapped in glowing coil rings, a
 * marksman scope. No muzzle flash (it is silent): its `flash` is a hidden stand-in.
 */
export function buildCoilgun(): GunModel {
  const b = new Builder();
  const { steel, alu, polymer, olive } = MAT;
  b.box(0.052, 0.05, 0.4, 0, 0.012, -0.02, olive); // receiver shell
  b.box(0.046, 0.036, 0.2, 0, -0.03, 0.05, alu); // lower
  b.cyl(0.011, 0.44, 0, 0.012, -0.44, steel); // rail barrel
  for (let i = 0; i < 6; i++) b.cyl(0.024, 0.018, 0, 0.012, -0.28 - i * 0.055, GLOW.coil); // coils
  for (let i = 0; i < 5; i++) b.cyl(0.02, 0.012, 0, 0.012, -0.305 - i * 0.055, alu); // spacers
  b.box(0.06, 0.012, 0.28, 0, -0.026, -0.4, alu); // lower rail under the coils
  b.box(0.034, 0.1, 0.045, 0, -0.085, 0.12, polymer).rotation.x = -0.32; // grip
  b.box(0.04, 0.04, 0.09, 0, -0.06, -0.02, polymer); // capacitor pack
  b.box(0.042, 0.08, 0.16, 0, -0.01, 0.3, polymer); // stock
  b.box(0.046, 0.09, 0.02, 0, -0.01, 0.39, MAT.glove);
  // Scope: tube, bell, rings.
  const sy = COIL_SIGHT_Y;
  b.cyl(0.018, 0.2, 0, sy, -0.04, steel);
  b.cyl(0.026, 0.05, 0, sy, -0.16, steel, 0.02);
  b.box(0.02, 0.03, 0.02, 0, sy - 0.03, 0.01, alu);
  b.box(0.02, 0.03, 0.02, 0, sy - 0.03, -0.1, alu);
  b.box(0.008, 0.012, 0.03, 0.024, sy - 0.01, -0.02, GLOW.coil); // charge readout
  b.hand(0.012, -0.09, 0.125, -0.32, 0.25);
  b.hand(-0.02, -0.05, -0.36, 0.1, -0.35);
  b.arm([0.02, -0.12, 0.16], [0.12, -0.35, 0.45]);
  b.arm([-0.035, -0.08, -0.33], [-0.22, -0.32, 0.1], 0.04);
  const group = b.finish();
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.016, 20),
    new THREE.MeshPhysicalMaterial({
      color: '#7fd9ff',
      transparent: true,
      opacity: 0.35,
      roughness: 0.05,
      depthWrite: false,
    }),
  );
  lens.position.set(0, sy, 0.061);
  group.add(lens);
  const flash = muzzleFlash(-0.7, 0.012, 0.01);
  flash.visible = false;
  group.add(flash);
  return {
    group,
    flash,
    sightY: sy,
    adsZ: 0.3,
    hip: new THREE.Vector3(0.16, -0.17, -0.42),
    redDot: false,
  };
}

const ISKRA_SIGHT_Y = 0.074;

/** "Iskra" smart SMG: stubby bullpup-ish body, holo sight, an orange "target lock" strip. */
export function buildIskra(): GunModel {
  const b = new Builder();
  const { steel, alu, polymer } = MAT;
  b.box(0.05, 0.05, 0.28, 0, 0.008, -0.06, polymer); // body
  b.box(0.046, 0.03, 0.16, 0, -0.03, 0.02, alu); // lower
  b.box(0.052, 0.01, 0.18, 0.027, 0.012, -0.08, GLOW.smart); // smart strip (right side)
  b.cyl(0.009, 0.1, 0, 0.012, -0.25, steel); // barrel
  b.cyl(0.018, 0.05, 0, 0.012, -0.3, alu); // shroud
  b.box(0.026, 0.12, 0.034, 0, -0.1, -0.02, steel).rotation.x = 0.08; // mag
  b.box(0.032, 0.09, 0.045, 0, -0.085, 0.09, polymer).rotation.x = -0.3; // grip
  b.box(0.04, 0.06, 0.1, 0, -0.005, 0.18, polymer); // short stock
  for (let i = 0; i < 12; i++) b.box(0.017, 0.005, 0.006, 0, 0.036, -0.18 + i * 0.02, steel);
  const sy = ISKRA_SIGHT_Y;
  b.box(0.04, 0.008, 0.05, 0, sy - 0.026, -0.04, alu);
  b.box(0.008, 0.045, 0.05, -0.02, sy, -0.04, alu);
  b.box(0.008, 0.045, 0.05, 0.02, sy, -0.04, alu);
  b.hand(0.012, -0.08, 0.1, -0.32, 0.25);
  b.hand(-0.02, -0.07, -0.08, 0.2, -0.4);
  b.arm([0.02, -0.11, 0.14], [0.12, -0.34, 0.44]);
  b.arm([-0.035, -0.1, -0.06], [-0.22, -0.32, 0.18], 0.04);
  const group = b.finish();
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.032, 0.036),
    new THREE.MeshPhysicalMaterial({
      color: '#ffd2a8',
      transparent: true,
      opacity: 0.14,
      roughness: 0.05,
      depthWrite: false,
    }),
  );
  glass.position.set(0, sy, -0.05);
  group.add(glass);
  const flash = muzzleFlash(-0.33, 0.012, 0.11);
  group.add(flash);
  return {
    group,
    flash,
    sightY: sy,
    adsZ: 0.3,
    hip: new THREE.Vector3(0.15, -0.16, -0.38),
    redDot: true,
  };
}

/** Height of the pistol's sight line (top of the front post) above the model origin. */
const PISTOL_SIGHT_Y = 0.041;

export function buildPistol(): GunModel {
  const b = new Builder();
  const { steel, polymer } = MAT;
  b.box(0.03, 0.032, 0.19, 0, 0.018, -0.04, steel); // slide
  for (let i = 0; i < 6; i++) b.box(0.032, 0.02, 0.003, 0, 0.02, 0.03 + i * 0.008, polymer); // serrations
  b.box(0.028, 0.024, 0.16, 0, -0.01, -0.03, polymer); // frame + dust cover
  b.cyl(0.006, 0.02, 0, 0.014, -0.14, steel); // barrel crown
  b.box(0.028, 0.1, 0.045, 0, -0.07, 0.035, polymer).rotation.x = -0.22; // grip
  b.box(0.02, 0.008, 0.045, 0, -0.123, 0.047, steel); // mag base
  b.box(0.006, 0.026, 0.04, 0, -0.03, -0.005, polymer); // trigger guard
  // Iron sights: two rear posts forming a notch, one front post; the post top is the sight line.
  b.box(0.007, 0.008, 0.008, -0.009, PISTOL_SIGHT_Y - 0.004, 0.045, steel);
  b.box(0.007, 0.008, 0.008, 0.009, PISTOL_SIGHT_Y - 0.004, 0.045, steel);
  b.box(0.004, 0.008, 0.006, 0, PISTOL_SIGHT_Y - 0.004, -0.125, steel);
  // Two-hand grip
  b.hand(0.004, -0.07, 0.04, -0.22, 0.05, 0.06);
  b.hand(-0.018, -0.075, 0.03, -0.1, -0.5, 0.05);
  b.arm([0.01, -0.1, 0.07], [0.14, -0.33, 0.42]);
  b.arm([-0.03, -0.1, 0.06], [-0.2, -0.33, 0.4], 0.04);
  const group = b.finish();
  const flash = muzzleFlash(-0.17, 0.014, 0.11);
  group.add(flash);
  return {
    group,
    flash,
    sightY: PISTOL_SIGHT_Y,
    adsZ: 0.34,
    hip: new THREE.Vector3(0.13, -0.15, -0.36),
    redDot: false,
  };
}

/** Where the seax model's grip origin (the fist) sits in the viewmodel knife's space. */
export const KNIFE_MODEL_AT: [number, number, number] = [0, -0.005, 0.025];

/**
 * The viewmodel knife with the seax model (render/knifeModel.ts): its grip origin at
 * `KNIFE_MODEL_AT`, in the primitive fist (short, so the guard and wire collar show) unless the
 * real arms hold it (`primitiveArm` false). Geometry and material are the model's own (shared).
 */
export function buildModelKnife(
  model: { geometry: THREE.BufferGeometry; material: THREE.Material },
  primitiveArm = true,
): THREE.Group {
  const b = new Builder();
  if (primitiveArm) {
    b.hand(0, -0.006, 0.034, Math.PI / 2, 0, 0.042);
    b.arm([0, -0.02, 0.07], [0.1, -0.28, 0.42]);
  }
  const g = b.finish();
  const knife = new THREE.Mesh(model.geometry, model.material);
  knife.name = 'knife:model';
  knife.position.set(...KNIFE_MODEL_AT);
  g.add(knife);
  return g;
}

export function buildKnife(withArm = true): THREE.Group {
  const b = new Builder();
  const { steel, blade, polymer } = MAT;
  b.box(0.024, 0.028, 0.11, 0, 0, 0.02, polymer); // handle
  for (let i = 0; i < 4; i++) b.box(0.026, 0.004, 0.006, 0, 0.012, -0.01 + i * 0.022, steel);
  b.box(0.05, 0.034, 0.008, 0, 0, -0.04, steel); // guard
  b.box(0.005, 0.03, 0.15, 0, 0.002, -0.12, blade); // blade body
  const tip = b.box(0.005, 0.021, 0.021, 0, -0.004, -0.2, blade); // clipped tip
  tip.rotation.x = Math.PI / 4;
  b.hand(0, -0.005, 0.025, Math.PI / 2, 0, 0.07);
  if (withArm) b.arm([0, -0.02, 0.07], [0.1, -0.28, 0.42]);
  return b.finish();
}

export function buildGrenade(): THREE.Group {
  const b = new Builder();
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.034, 2), MAT.olive);
  body.scale.set(1, 1.2, 1);
  b.group.add(body);
  b.box(0.012, 0.03, 0.018, 0, 0.05, 0, MAT.steel); // fuse head
  b.box(0.008, 0.075, 0.012, 0.024, 0.02, 0, MAT.steel).rotation.z = -0.12; // spoon
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0025, 6, 16), MAT.steel);
  ring.position.set(-0.018, 0.058, 0);
  b.group.add(ring);
  b.hand(0.02, -0.03, 0.01, 0.2, 0.4, 0.05);
  b.arm([0.03, -0.06, 0.04], [-0.16, -0.32, 0.4], 0.04);
  return b.finish();
}
