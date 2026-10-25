import * as THREE from 'three';
import { smokeVisibility, type SmokeCloud } from '@wd/shared';
import type { SurfaceKind, Vec3, WorldRaycaster } from '@wd/shared';
import { stepDebrisBody, type DebrisMotionOptions } from './debrisMotion.ts';
import {
  DEBRIS,
  FLASH,
  KICK,
  READ_MAX_GROWTH,
  READ_PX,
  READ_VIEW_HEIGHT,
  impactScale,
  pixelsPerMeter,
  puffScreenLimit,
  readableSize,
} from './impactProfile.ts';
import { ImpactPool } from './impactPool.ts';
import { ImpactSprites } from './impactSprites.ts';
import { CHUNKS, ChunkDebris } from './chunks.ts';

export { DEBRIS, MAX_POINT_PX } from './impactProfile.ts';
export type { DebrisChipProfile, DebrisPreset } from './impactProfile.ts';
export const chipProfileForSurface = (surface: SurfaceKind) => DEBRIS[surface].chip;
export const IMPACT_CAPACITY = { chips: CHUNKS.capacity, puffs: 256, glow: 512 } as const;
const MAX_DT = 1 / 20;
const COLLISION_RAYS_PER_FRAME = 96;
const MOTION: DebrisMotionOptions = {
  gravity: 12,
  radius: 0.075,
  restitution: 0.38,
  tangentDamping: 0.62,
  settleSpeed: 0.55,
  maxDt: MAX_DT,
};

interface Particle {
  born: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  r: number;
  g: number;
  b: number;
  collide: boolean;
  settled: boolean;
  planeNx: number;
  planeNy: number;
  planeNz: number;
  planeD: number;
  sx: number;
  sy: number;
  sz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wx: number;
  wy: number;
  wz: number;
  radius: number;
  angle: number;
  flash: boolean;
  ember: boolean;
  /** A dense kick jet (puff pool): instant, darker, decelerating fast. */
  kick: boolean;
  /** A glass glint that twinkles as it tumbles. */
  twinkle: boolean;
  rendered: boolean;
}
function particle(): Particle {
  return {
    born: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 0,
    max: 0,
    r: 0,
    g: 0,
    b: 0,
    collide: false,
    settled: false,
    planeNx: 0,
    planeNy: 1,
    planeNz: 0,
    planeD: 0,
    sx: 0,
    sy: 0,
    sz: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    wx: 0,
    wy: 0,
    wz: 0,
    radius: 0.035,
    angle: 0,
    flash: false,
    ember: false,
    kick: false,
    twinkle: false,
    rendered: false,
  };
}

/**
 * Four fixed draws: persistent sun-lit chunks (chips + splinters, `chunks.ts`), alpha puffs,
 * additive streaks/glints/point flashes.
 */
export class ImpactDebris {
  readonly group = new THREE.Group();
  /** Chunks that fly, bounce, settle and stay (Kiran: "realistic physics"). */
  readonly chunks = new ChunkDebris();
  private readonly puffs = new ImpactPool(IMPACT_CAPACITY.puffs, particle);
  private readonly glow = new ImpactPool(IMPACT_CAPACITY.glow, particle);
  private readonly dust = new ImpactSprites(IMPACT_CAPACITY.puffs, false, 'fx:dust');
  private readonly sparks = new ImpactSprites(IMPACT_CAPACITY.glow, true, 'fx:sparks');
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly spin = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly tint = new THREE.Color(1, 1, 1);
  private readonly sunDirection = new THREE.Vector3();
  private readonly motion = { ...MOTION };
  private world: WorldRaycaster | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private smoke: readonly SmokeCloud[] = [];
  private viewportHeight = 900;
  private low = false;

  constructor() {
    this.group.name = 'fx:impacts';
    this.group.add(this.chunks.group, this.dust.mesh, this.sparks.mesh);
  }

  setWorldRaycaster(world: WorldRaycaster | null): void {
    this.world = world;
    this.chunks.setWorldRaycaster(world);
  }

  setView(camera: THREE.PerspectiveCamera, viewportHeight: number, low: boolean): void {
    this.camera = camera;
    this.viewportHeight = viewportHeight;
    this.low = low;
    this.chunks.setLow(low);
    this.dust.setView(viewportHeight, puffScreenLimit(low, viewportHeight));
    this.sparks.setView(viewportHeight, puffScreenLimit(low, viewportHeight));
  }

  setSmoke(smoke: readonly SmokeCloud[]): void {
    this.smoke = smoke;
  }

  scaleAt(point: Vec3): number {
    if (!this.camera) return 1;
    // View depth, rather than ray length: a wide-FOV edge hit gets the same projected size.
    const e = this.camera.matrixWorldInverse.elements;
    const depth = -(e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14]);
    return impactScale(depth, this.viewportHeight, this.camera.fov);
  }

  /** The view height (px) sizes are read against. */
  get viewportPx(): number {
    return this.viewportHeight;
  }

  /** Pixels per metre at a point's view depth (0 without a camera: no readability minimums). */
  pxPerMeterAt(point: Vec3): number {
    if (!this.camera) return 0;
    return pixelsPerMeter(this.depthAt(point), this.viewportHeight, this.camera.fov);
  }

  /** A world size grown to at least `minPx` on screen at this hit (capped far away). */
  private readable(size: number, minPx: number, ppm: number, maxGrowth: number): number {
    return readableSize(size, minPx, ppm, this.viewportHeight, maxGrowth);
  }

  /** View depth of a point (m; 0 without a camera). */
  depthAt(point: Vec3): number {
    if (!this.camera) return 0;
    const e = this.camera.matrixWorldInverse.elements;
    return -(e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14]);
  }

  /** Cheap diffuse sky/ground/key tint. No scene lights or shader defines are added on impact. */
  setLighting(sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void {
    this.sunDirection.copy(sun.position).sub(sun.target.position).normalize();
    this.dust.setLighting(this.sunDirection);
    impactAmbientTint(sun, hemi, this.tint);
  }

  /** Nonempty buffers guarantee actual warm-up draws, including the first puff and spark. */
  beginWarmUp(): () => void {
    const restoreChunks = this.chunks.beginWarmUp();
    const restoreDust = this.dust.beginWarmUp();
    const restoreSparks = this.sparks.beginWarmUp();
    return () => {
      restoreChunks();
      restoreDust();
      restoreSparks();
    };
  }

  /** Writes only preallocated records; all surface profiles and scratch maths are reused. */
  burst(point: Vec3, normal: Vec3, surface: SurfaceKind, rnd: () => number = Math.random): void {
    const profile = DEBRIS[surface];
    const scale = this.scaleAt(point);
    // Screen-space minimums (flash, streaks, kick, chips) so a 25 m hit still reads.
    const ppm = this.pxPerMeterAt(point);
    let hardLeft = Math.min(20, Math.max(0, COLLISION_RAYS_PER_FRAME - this.collidableCount));
    // Persistent chunks: real size and speed; each flying chunk grows to keep `READ_PX.chip` on
    // screen and eases back to its true size as it lands.
    const minFlight = ppm > 0 ? (READ_PX.chip * (this.viewportHeight / READ_VIEW_HEIGHT)) / ppm : 0;
    this.chunks.spawn(
      point,
      normal,
      surface,
      randomCount(profile.bits, rnd),
      profile.bitColor,
      minFlight,
      rnd,
    );
    const dustCount = randomCount(profile.dust, rnd);
    // Never trim a surface's entire puff on Low.
    const count = this.low && dustCount > 0 ? Math.max(1, Math.ceil(dustCount * 0.5)) : dustCount;
    for (let i = 0; i < count; i++) {
      const p = this.puffs.acquire();
      this.launch(p, point, normal, 1.15, scale, rnd);
      p.life = p.max = profile.dustLife * (0.8 + rnd() * 0.4);
      const shade = 0.9 + rnd() * 0.25;
      p.r = profile.dustColor[0] * this.tint.r * shade;
      p.g = profile.dustColor[1] * this.tint.g * shade;
      p.b = profile.dustColor[2] * this.tint.b * shade;
      p.sx = profile.dustSize * scale * (0.9 + rnd() * 0.2) * (this.low ? 0.8 : 1);
      p.sy = p.sx * (0.9 + rnd() * 0.2);
      // Start small and clear of the contact; growth stays outside the source plane.
      separate(p, Math.max(p.sx, p.sy) * 0.2);
    }
    // The kick: after the billow, so pool order keeps the billow first. Low keeps it (the punch).
    for (let i = 0; i < profile.kick; i++) {
      const p = this.puffs.acquire();
      this.launch(p, point, normal, profile.kickSpeed * (1 - i * 0.3), scale, rnd);
      // Mostly straight out of the surface: a jet, not a spray.
      const len = Math.hypot(p.vx, p.vy, p.vz) || 1;
      const speed = profile.kickSpeed * (1 - i * 0.3) * Math.sqrt(scale);
      p.vx = (p.vx / len) * speed * 0.35 + p.planeNx * speed * 0.65;
      p.vy = (p.vy / len) * speed * 0.35 + p.planeNy * speed * 0.65;
      p.vz = (p.vz / len) * speed * 0.35 + p.planeNz * speed * 0.65;
      p.kick = true;
      p.life = p.max = KICK.life * (0.85 + rnd() * 0.3);
      p.r = profile.dustColor[0] * this.tint.r * KICK.shade;
      p.g = profile.dustColor[1] * this.tint.g * KICK.shade;
      p.b = profile.dustColor[2] * this.tint.b * KICK.shade;
      // Drawn along its motion: `sx` is the jet's length, `sy` its width.
      const width = profile.dustSize * KICK.size * scale * (0.9 + rnd() * 0.2);
      p.sy = this.readable(width, READ_PX.kickWidth, ppm, READ_MAX_GROWTH.sprite);
      p.sx = this.readable(width * 1.8, READ_PX.kickLength, ppm, READ_MAX_GROWTH.sprite);
      separate(p, p.sy * 0.3);
    }
    // Low: half the spark trails (never none), each 30 % shorter. Additive trail overdraw was the
    // measurable cost of sustained fire at metal on the Intel iGPU (Low ~-5 fps); presence stays.
    const allSparks = randomCount(profile.sparks, rnd);
    const sparks = this.low && allSparks > 0 ? Math.max(1, Math.ceil(allSparks * 0.5)) : allSparks;
    const trail = this.low ? 0.7 : 1;
    for (let i = 0; i < sparks; i++) {
      const p = this.glow.acquire();
      this.launch(p, point, normal, profile.sparkSpeed, scale, rnd);
      p.life = p.max = profile.sparkLife * (0.8 + rnd() * 0.4);
      p.r = profile.sparkColor[0];
      p.g = profile.sparkColor[1];
      p.b = profile.sparkColor[2];
      p.sx = this.readable(
        profile.sparkLength * scale * (0.75 + rnd() * 0.5) * trail,
        READ_PX.sparkLength * trail,
        ppm,
        READ_MAX_GROWTH.sprite,
      );
      p.sy = this.readable(
        profile.sparkWidth * scale,
        READ_PX.sparkWidth,
        ppm,
        READ_MAX_GROWTH.sprite,
      );
      p.collide = hardLeft > 0;
      if (p.collide) hardLeft--;
    }
    const embers = randomCount(profile.embers, rnd);
    for (let i = 0; i < embers; i++) {
      const p = this.glow.acquire();
      this.launch(p, point, normal, 2.2, scale, rnd);
      p.ember = true;
      p.twinkle = profile.twinkle;
      p.life = p.max = profile.twinkle ? 0.45 + rnd() * 0.25 : 0.24 + rnd() * 0.14;
      p.r = profile.sparkColor[0];
      p.g = profile.sparkColor[1];
      p.b = profile.sparkColor[2];
      p.sx = p.sy = 0.045 * scale;
    }
    if (profile.flashSize > 0) {
      const life = profile.flashLife[0] + rnd() * (profile.flashLife[1] - profile.flashLife[0]);
      const size = profile.flashSize * scale * (0.9 + rnd() * 0.2);
      if (!profile.hotFlash) {
        const clear = flashClearance(size);
        this.flash(point, normal, scale, rnd, clear, size, size, 0, life, profile.sparkColor, 1);
        return;
      }
      // Hot surfaces (every tier, full size): a sharp star — a small HDR white-yellow disc that
      // saturates to a crisp white dot, two thin crossed rays of unequal length at a random roll
      // (the glint texture tapers them to points) — and a tight orange glow, ~1.5× the disc, for
      // ~2 frames. A bullet spark, not a ball.
      // The disc stops growing with distance early (its floor takes over): far discs stay tight.
      const discWorld =
        size * FLASH.disc * (Math.min(scale, FLASH.discScaleMax) / Math.max(scale, 1e-6));
      const disc = this.readable(discWorld, READ_PX.flashCore, ppm, READ_MAX_GROWTH.sprite);
      const roll = rnd() * Math.PI;
      const ray = this.readable(size * FLASH.ray, READ_PX.flashRay, ppm, READ_MAX_GROWTH.sprite);
      const rayWidth = this.readable(
        ray * FLASH.rayWidth,
        READ_PX.flashRayWidth,
        ppm,
        READ_MAX_GROWTH.sprite,
      );
      const glow = Math.min(
        this.readable(disc * FLASH.glowSize, READ_PX.flashGlow, ppm, Infinity),
        disc * FLASH.glowMax,
      );
      // One clearance off the surface for the whole flash: every part shares one centre, so an
      // oblique hit doesn't spread core, rays and glow across the screen.
      const clear = flashClearance(disc, ray, glow);
      this.flash(point, normal, scale, rnd, clear, disc, disc, 0, life, FLASH.core, 1);
      this.flash(point, normal, scale, rnd, clear, ray, rayWidth, roll, life, FLASH.core, 1);
      const cross = roll + Math.PI / 2 + (rnd() - 0.5) * 0.5;
      this.flash(point, normal, scale, rnd, clear, ray * 0.7, rayWidth, cross, life, FLASH.core, 1);
      this.flash(
        point,
        normal,
        scale,
        rnd,
        clear,
        glow,
        glow,
        0,
        FLASH.glowLife,
        FLASH.glow,
        FLASH.glowAlpha,
      );
    }
  }

  /**
   * One flash billboard: `length` × `width` (a disc when equal) rolled by `angle`, its centre
   * `clearance` m off the surface (shared by every part of one flash).
   */
  private flash(
    point: Vec3,
    normal: Vec3,
    scale: number,
    rnd: () => number,
    clearance: number,
    length: number,
    width: number,
    angle: number,
    life: number,
    colour: readonly [number, number, number],
    alpha: number,
  ): void {
    const p = this.glow.acquire();
    this.launch(p, point, normal, 0, scale, rnd);
    p.flash = true;
    p.angle = angle;
    p.life = p.max = life;
    p.r = colour[0] * alpha;
    p.g = colour[1] * alpha;
    p.b = colour[2] * alpha;
    p.sx = length;
    p.sy = width;
    separate(p, clearance);
  }

  private launch(
    p: Particle,
    point: Vec3,
    normal: Vec3,
    speed: number,
    scale: number,
    rnd: () => number,
  ): void {
    const len = Math.hypot(normal.x, normal.y, normal.z) || 1;
    p.planeNx = normal.x / len;
    p.planeNy = normal.y / len;
    p.planeNz = normal.z / len;
    p.planeD = p.planeNx * point.x + p.planeNy * point.y + p.planeNz * point.z;
    p.radius = MOTION.radius * scale;
    p.x = point.x + p.planeNx * p.radius;
    p.y = point.y + p.planeNy * p.radius;
    p.z = point.z + p.planeNz * p.radius;
    const velocity = speed * (0.6 + rnd() * 0.7) * Math.sqrt(scale);
    p.vx = (p.planeNx + (rnd() - 0.5) * 1.2) * velocity;
    p.vy = (p.planeNy + 0.35 + (rnd() - 0.5) * 1.2) * velocity;
    p.vz = (p.planeNz + (rnd() - 0.5) * 1.2) * velocity;
    // Keep the whole spray travelling outwards even on sloped/underside faces.
    const outward = p.vx * p.planeNx + p.vy * p.planeNy + p.vz * p.planeNz;
    if (outward < velocity * 0.3) {
      const push = velocity * 0.3 - outward;
      p.vx += p.planeNx * push;
      p.vy += p.planeNy * push;
      p.vz += p.planeNz * push;
    }
    p.angle = rnd() * Math.PI * 2;
    p.rendered = false;
    p.flash = false;
    p.ember = false;
    p.kick = false;
    p.twinkle = false;
    p.collide = false;
    p.settled = false;
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const step = Math.min(dt, MAX_DT);
    let rays = COLLISION_RAYS_PER_FRAME;
    this.chunks.update(dt);
    let n = 0;
    const drag = Math.exp(-2 * step);
    const kickDrag = Math.exp(-7 * step);
    for (const p of this.puffs.slots) {
      if (p.life <= 0) continue;
      if (!ageParticle(p, step)) continue;
      const k = p.kick ? kickDrag : drag;
      p.vx *= k;
      p.vz *= k;
      p.vy = p.vy * k + 0.45 * step;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.z += p.vz * step;
      const elapsed = p.max - p.life;
      // A kick is there at full density on its first frame and thins as it opens; a billow eases in.
      const growth = p.kick
        ? 0.7 + 1.1 * Math.min(1, elapsed / p.max)
        : 0.35 + 0.8 * Math.min(1, elapsed / 0.25);
      const alpha = p.kick
        ? Math.min(1, p.life / (p.max * 0.7)) * KICK.alpha
        : Math.min(1, elapsed / 0.08, p.life / 0.4) * 0.65;
      // No depth texture pass: keep the entire billboard's bounding sphere off the source.
      separate(p, Math.hypot(p.sx, p.sy) * growth * 0.5);
      this.writeSprite(this.dust, n++, p, p.sx * growth, p.sy * growth, alpha, p.kick);
    }
    this.dust.finish(n);
    n = 0;
    for (const p of this.glow.slots) {
      if (p.life <= 0) continue;
      if (!ageParticle(p, step)) continue;
      if (!p.flash) rays = this.move(p, step, rays);
      const fade = p.life / p.max;
      const growth = p.flash ? 1 + 0.15 * (1 - fade) : 0.6 + 0.4 * fade;
      const streak = !p.flash && !p.ember;
      // Streaks fade fast (linear: hot, then gone); glints hold; glass glints twinkle.
      let alpha = streak ? fade : Math.sqrt(fade);
      if (p.twinkle) alpha *= 0.35 + 0.65 * Math.abs(Math.sin((p.max - p.life) * 38 + p.angle * 5));
      this.writeSprite(this.sparks, n++, p, p.sx * growth, p.sy * growth, alpha, streak);
    }
    this.sparks.finish(n);
  }

  private move(p: Particle, dt: number, rays: number): number {
    this.motion.radius = p.radius;
    const sweep = p.collide && !p.settled && this.world && rays > 0;
    stepDebrisBody(p, dt, sweep ? this.world : null, this.motion);
    return sweep ? rays - 1 : rays;
  }

  private writeSprite(
    batch: ImpactSprites,
    n: number,
    p: Particle,
    width: number,
    height: number,
    alpha: number,
    streak: boolean,
  ): void {
    batch.centers[n * 3] = p.x;
    batch.centers[n * 3 + 1] = p.y;
    batch.centers[n * 3 + 2] = p.z;
    batch.colors[n * 4] = p.r;
    batch.colors[n * 4 + 1] = p.g;
    batch.colors[n * 4 + 2] = p.b;
    // One draw can contain hits on both sides of a cloud; attenuate by each segment's depth.
    batch.colors[n * 4 + 3] =
      alpha *
      (this.camera && this.smoke.length ? smokeVisibility(this.smoke, this.camera.position, p) : 1);
    batch.sizes[n * 2] = width;
    batch.sizes[n * 2 + 1] = height;
    batch.angles[n] = p.angle;
    batch.velocities[n * 3] = streak ? p.vx : 0;
    batch.velocities[n * 3 + 1] = streak ? p.vy : 0;
    batch.velocities[n * 3 + 2] = streak ? p.vz : 0;
  }

  get count(): number {
    return this.chunks.stats().live + this.puffs.count + this.glow.count;
  }
  get collidableCount(): number {
    // Sparks only: chunks have their own in-flight cap and one ray each.
    let n = 0;
    for (let i = 0; i < this.glow.slots.length; i++) {
      const p = this.glow.slots[i]!;
      if (p.life > 0 && p.collide && !p.settled) n++;
    }
    return n;
  }
}

/** The sun/sky tint dust takes (diffuse key + hemisphere), shared by impacts and tyre dust. */
export function impactAmbientTint(
  sun: THREE.DirectionalLight,
  hemi: THREE.HemisphereLight,
  out: THREE.Color,
): THREE.Color {
  const total = Math.max(0.01, hemi.intensity + sun.intensity * 0.22);
  return out.setRGB(
    (hemi.color.r * hemi.intensity * 0.8 +
      hemi.groundColor.r * hemi.intensity * 0.2 +
      sun.color.r * sun.intensity * 0.22) /
      total,
    (hemi.color.g * hemi.intensity * 0.8 +
      hemi.groundColor.g * hemi.intensity * 0.2 +
      sun.color.g * sun.intensity * 0.22) /
      total,
    (hemi.color.b * hemi.intensity * 0.8 +
      hemi.groundColor.b * hemi.intensity * 0.2 +
      sun.color.b * sun.intensity * 0.22) /
      total,
  );
}

/** How far a flash's centre sits off its surface (m): for its largest part, capped at 0.6 m. */
export function flashClearance(...sizes: number[]): number {
  let largest = 0;
  for (const s of sizes) if (s > largest) largest = s;
  return Math.min(largest * 0.52, 0.6);
}

function ageParticle(p: Particle, step: number): boolean {
  // Preserve the pool's born serial: it decides which live record is oldest on saturation.
  p.life -= p.rendered ? step : Math.min(step, p.max * 0.1);
  p.rendered = true;
  return p.life > 0;
}

function separate(p: Particle, radius: number): void {
  const distance = p.x * p.planeNx + p.y * p.planeNy + p.z * p.planeNz - p.planeD;
  const push = Math.max(0, radius - distance);
  p.x += p.planeNx * push;
  p.y += p.planeNy * push;
  p.z += p.planeNz * push;
}
function randomCount(range: readonly [number, number], rnd: () => number): number {
  return range[0] + Math.floor(rnd() * (range[1] - range[0] + 1));
}

/** Also used by blowing dust; installed before Game.warmUp, never changed on hits. */
export function clampPointSize(mat: THREE.PointsMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      'gl_PointSize = clamp(gl_PointSize, 1.0, 64.0);\n#include <fog_vertex>',
    );
  };
  mat.customProgramCacheKey = () => 'clampPoints64';
}
