/**
 * Tyre dust and skid marks for the trucks (presentation only, never the sim). Slipping wheels
 * kick up soft camera-facing dust that grows, drifts with the wind and fades over ~1.5–2.5 s, and
 * lay dark ribbons on the ground that fade over ~26 s. Driven by `VehiclesView` from the drawn
 * pose of every truck (ours predicted, the rest interpolated), so remote trucks dust up too.
 *
 * Two draws at most, both pooled and built before warm-up: the dust is an `ImpactSprites` batch
 * (the impacts' own dust program: same material recipe and cache key, so no new program), the
 * skids one indexed ribbon mesh over a fixed ring of segments (its program is compiled and drawn
 * in `Game.warmUp` through `beginWarmUp`). Nothing is allocated per frame or per particle.
 */
import * as THREE from 'three';
import {
  smokeVisibility,
  WHEEL_POS,
  WHEELS,
  type SmokeCloud,
  type Vec3,
  type WorldHit,
} from '@wd/shared';
import { impactAmbientTint } from '../render/debris.ts';
import { OVER_FLATS } from '../render/mapMesh.ts';
import { ImpactPool } from '../render/impactPool.ts';
import { ImpactSprites } from '../render/impactSprites.ts';
import {
  SKID_CAPACITY,
  SKID_FADE_FROM,
  SKID_LIFE,
  SKID_LIFT,
  SKID_SLIP,
  SKID_STEP,
  SkidRing,
  dustRate,
  emitCount,
  groundDust,
  skidHalfWidth,
  skidInk,
  skidOpacity,
  planeHeight,
  slipAmount,
  wheelSlip,
  type SlipPose,
} from './tyreSlip.ts';

/** Live dust particles shared by every truck (a full four-wheel drift peaks near ~80 on High). */
export const TYRE_DUST_CAPACITY = 112;
const DUST_LIFE = 1.5;
const DUST_LIFE_SPREAD = 1.0;
/** Billboard size (m): born small at the tyre, grown to a soft cloud. */
const DUST_SIZE0 = 0.55;
const DUST_SIZE1 = 2.6;
const DUST_PEAK_ALPHA = 0.5;
/** Screen cap on a dust billboard (share of the view height): keeps chase-cam overdraw bounded. */
const DUST_SCREEN = { high: 0.32, low: 0.22 } as const;
/** Ribbon texture repeat along the track (m per texture length). */
const SKID_TEXTURE_LENGTH = 1.6;
/** A wheel farther than this from its last ribbon point (m) starts a new ribbon. */
const SKID_BREAK = 3;

interface Dust {
  born: number;
  life: number;
  max: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  s0: number;
  s1: number;
  peak: number;
  angle: number;
  spin: number;
}
const dust = (): Dust => ({
  born: 0,
  life: 0,
  max: 1,
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  r: 0,
  g: 0,
  b: 0,
  s0: 1,
  s1: 1,
  peak: 0,
  angle: 0,
  spin: 0,
});

interface WheelTrack {
  /** Laying a ribbon (the wheel slipped last frame). */
  laying: boolean;
  /** Last ribbon point, and whether its edges (`l*`, `r*`) were laid. */
  x: number;
  y: number;
  z: number;
  edges: boolean;
  lx: number;
  ly: number;
  lz: number;
  rx: number;
  ry: number;
  rz: number;
  /** Direction of the last segment (x, z; unit). */
  dx: number;
  dz: number;
  /** Ground normal at the last ribbon point (for its edges' heights). */
  nx: number;
  ny: number;
  nz: number;
  /** Texture distance along the ribbon. */
  v: number;
  /** Fraction of a dust particle carried to the next frame. */
  carry: number;
}

interface TruckTrack {
  has: boolean;
  seen: boolean;
  prev: SlipPose;
  /** Forward-speed change, smoothed (m/s²): one frame's interpolation step is not a launch. */
  accel: number;
  wheels: WheelTrack[];
}

export class TyreFx {
  readonly group = new THREE.Group();
  private readonly dust = new ImpactSprites(TYRE_DUST_CAPACITY, false, 'fx:tyre-dust');
  private readonly pool = new ImpactPool(TYRE_DUST_CAPACITY, dust);
  readonly ring = new SkidRing(SKID_CAPACITY);
  private readonly skids: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly skidTime = { value: 0 };
  /** position, color, uv, aBorn: views of the ring's arrays, uploaded by written slot. */
  private readonly skidAttrs: THREE.BufferAttribute[];
  private readonly trucks = new Map<number, TruckTrack>();
  private readonly quad = new Float32Array(12);
  private readonly lastNormal = { x: 0, y: 1, z: 0 };
  /** Smoke concealment: the eye and the clouds; dust behind smoke from there is not drawn. */
  private eye: Vec3 | null = null;
  private smoke: readonly SmokeCloud[] = [];
  private readonly probe = { x: 0, y: 0, z: 0 };
  private readonly tint = new THREE.Color(1, 1, 1);
  private readonly sunDirection = new THREE.Vector3(0, 1, 0);
  private time = 0;
  private low = false;
  private windX = 0.4;
  private windZ = 0.3;
  private dirty = false;

  constructor(private readonly rnd: () => number = Math.random) {
    this.group.name = 'fx:tyres';
    this.dust.mesh.name = 'fx:tyre-dust';
    const geo = new THREE.BufferGeometry();
    const ring = this.ring;
    this.skidAttrs = [
      dynamic(ring.positions, 3),
      dynamic(ring.colors, 4),
      dynamic(ring.uvs, 2),
      dynamic(ring.born, 1),
    ];
    const [position, color, uv, born] = this.skidAttrs;
    geo.setAttribute('position', position!);
    geo.setAttribute('color', color!);
    geo.setAttribute('uv', uv!);
    geo.setAttribute('aBorn', born!);
    const index = new Uint16Array(SKID_CAPACITY * 6);
    for (let i = 0; i < SKID_CAPACITY; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      name: 'fx:skid-marks',
      map: skidTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Over every ground flat (see `OVER_FLATS`): the paving is drawn as lifted, offset flats.
      polygonOffset: true,
      polygonOffsetFactor: OVER_FLATS.factor,
      polygonOffsetUnits: OVER_FLATS.units,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.skidTime = this.skidTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aBorn;\nuniform float skidTime;',
        )
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
#ifdef USE_COLOR_ALPHA
  vColor.a *= 1.0 - smoothstep(${(SKID_LIFE * SKID_FADE_FROM).toFixed(2)}, ${SKID_LIFE.toFixed(2)}, skidTime - aBorn);
#endif`,
        );
    };
    mat.customProgramCacheKey = () => 'tyre-skid-v1';
    this.skids = new THREE.Mesh(geo, mat);
    this.skids.name = 'fx:skid-marks';
    this.skids.frustumCulled = false;
    // Under the dust and everything else transparent on the ground.
    this.skids.renderOrder = -1;
    this.group.add(this.skids, this.dust.mesh);
  }

  /** View height (px) and tier: Low halves the dust rate and caps its screen size lower. */
  setView(viewportHeight: number, low: boolean): void {
    this.low = low;
    this.dust.setView(viewportHeight, viewportHeight * (low ? DUST_SCREEN.low : DUST_SCREEN.high));
  }

  /**
   * The view's eye and the smoke clouds it sees through. Smoke writes no depth and the dust is one
   * batch sorted by its average centre, so each particle takes the shared `smokeVisibility` like
   * impact debris: a truck's dust behind smoke never shows through it (concealment rule).
   */
  setSmoke(eye: Vec3, smoke: readonly SmokeCloud[]): void {
    this.eye = eye;
    this.smoke = smoke;
  }

  /** The impacts' diffuse sun/sky tint and the sun direction for the dust's lit side. */
  setLighting(sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void {
    this.sunDirection.copy(sun.position).sub(sun.target.position).normalize();
    this.dust.setLighting(this.sunDirection);
    impactAmbientTint(sun, hemi, this.tint);
  }

  /** Wind direction (x, z; the foliage's) and strength 0–1: dust drifts at 0.5–3 m/s. */
  setWind(dirX: number, dirZ: number, strength: number): void {
    const len = Math.hypot(dirX, dirZ) || 1;
    const speed = 0.5 + 2.5 * Math.min(1, Math.max(0, strength));
    this.windX = (dirX / len) * speed;
    this.windZ = (dirZ / len) * speed;
  }

  /**
   * One truck this frame: its drawn motion, whether it can slip (active, not a wreck) and the
   * ground under each wheel (`WHEELS` order; null = in the air). Call once per drawn truck, then
   * `update`.
   */
  truck(
    id: number,
    motion: SlipPose & { steer: number },
    active: boolean,
    contacts: readonly (WorldHit | null)[],
    dt: number,
  ): void {
    const t = this.track(id);
    t.seen = true;
    const slip = slipAmount(motion, t.prev, t.has ? dt : 0);
    copyPose(t.prev, motion);
    t.has = true;
    if (!active || !slip.valid) {
      t.accel = 0;
      for (const w of t.wheels) {
        w.laying = false;
        w.carry = 0;
      }
      return;
    }
    t.accel += (slip.accel - t.accel) * Math.min(1, dt * 10);
    for (let i = 0; i < WHEELS.length; i++) {
      const wheel = WHEELS[i]!;
      const w = t.wheels[i]!;
      const hit = contacts[i];
      if (!hit) {
        w.laying = false;
        continue;
      }
      const s = wheelSlip(wheel, slip, t.accel);
      const emit = emitCount(dustRate(s, slip.speed, this.low), dt, w.carry);
      w.carry = emit.carry;
      for (let k = 0; k < emit.count; k++) this.spawnDust(hit, motion, s);
      const heading = motion.yaw + (WHEEL_POS[wheel].z > 0 ? motion.steer : 0);
      if (s >= SKID_SLIP) this.layRibbon(w, hit, heading, s);
      else w.laying = false;
    }
  }

  /** Age and draw the dust; forget trucks not reported this frame (they restart cleanly). */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    this.time += step;
    this.skidTime.value = this.time;
    for (const t of this.trucks.values()) {
      if (!t.seen) {
        t.has = false;
        for (const w of t.wheels) w.laying = false;
      }
      t.seen = false;
    }
    const pull = 1 - Math.exp(-1.4 * step);
    let n = 0;
    const d = this.dust;
    for (const p of this.pool.slots) {
      if (p.life <= 0) continue;
      p.life -= step;
      if (p.life <= 0) continue;
      // Thrown off the tyre, then carried by the wind, rising a little as it spreads.
      p.vx += (this.windX - p.vx) * pull;
      p.vz += (this.windZ - p.vz) * pull;
      p.vy += (0.15 - p.vy) * pull;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.z += p.vz * step;
      const age = p.max - p.life;
      const t = age / p.max;
      const size = p.s0 + (p.s1 - p.s0) * (1 - Math.exp(-age * 1.8));
      const alpha = p.peak * Math.min(1, age / 0.12) * (1 - smoothstep(0.3, 1, t));
      d.centers[n * 3] = p.x;
      d.centers[n * 3 + 1] = p.y + size * 0.3;
      d.centers[n * 3 + 2] = p.z;
      d.colors[n * 4] = p.r;
      d.colors[n * 4 + 1] = p.g;
      d.colors[n * 4 + 2] = p.b;
      const probe = this.probe;
      probe.x = p.x;
      probe.y = p.y + size * 0.3;
      probe.z = p.z;
      d.colors[n * 4 + 3] =
        alpha * (this.eye && this.smoke.length ? smokeVisibility(this.smoke, this.eye, probe) : 1);
      d.sizes[n * 2] = size;
      d.sizes[n * 2 + 1] = size * 0.82;
      d.angles[n] = p.angle + p.spin * age;
      d.velocities[n * 3] = 0;
      d.velocities[n * 3 + 1] = 0;
      d.velocities[n * 3 + 2] = 0;
      n++;
    }
    d.finish(n);
    const geo = this.skids.geometry;
    geo.setDrawRange(0, this.ring.count * 6);
    if (this.dirty) {
      for (const attr of this.skidAttrs) attr.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Draw one off-screen dust billboard and the ribbon batch for warm-up; returns the restore. */
  beginWarmUp(): () => void {
    const restoreDust = this.dust.beginWarmUp();
    const geo = this.skids.geometry;
    const range = geo.drawRange.count;
    // Never-laid slots are zero-area quads: a real draw call, no pixels.
    geo.setDrawRange(0, Math.max(6, range));
    return () => {
      restoreDust();
      geo.setDrawRange(0, range);
    };
  }

  /** Live dust and laid skid segments (debug / autotest). */
  stats(): { dust: number; skids: number } {
    return { dust: this.pool.count, skids: this.ring.count };
  }

  private track(id: number): TruckTrack {
    let t = this.trucks.get(id);
    if (!t) {
      t = {
        has: false,
        seen: false,
        prev: {
          pos: { x: 0, y: 0, z: 0 },
          vel: { x: 0, y: 0, z: 0 },
          yaw: 0,
          yawRate: 0,
          grounded: false,
        },
        accel: 0,
        wheels: WHEELS.map(() => ({
          laying: false,
          x: 0,
          y: 0,
          z: 0,
          edges: false,
          lx: 0,
          ly: 0,
          lz: 0,
          rx: 0,
          ry: 0,
          rz: 0,
          dx: 0,
          dz: 0,
          nx: 0,
          ny: 1,
          nz: 0,
          v: 0,
          carry: 0,
        })),
      };
      this.trucks.set(id, t);
    }
    return t;
  }

  private spawnDust(hit: WorldHit, motion: SlipPose, slip: number): void {
    const rnd = this.rnd;
    const p = this.pool.acquire();
    p.x = hit.point.x + (rnd() - 0.5) * 0.35;
    p.y = hit.point.y + 0.15;
    p.z = hit.point.z + (rnd() - 0.5) * 0.35;
    // A share of the truck's own motion plus a kick up and out; the wind takes over from there.
    p.vx = motion.vel.x * 0.18 + (rnd() - 0.5) * 1.4;
    p.vy = 0.45 + rnd() * 0.75;
    p.vz = motion.vel.z * 0.18 + (rnd() - 0.5) * 1.4;
    p.life = p.max = DUST_LIFE + rnd() * DUST_LIFE_SPREAD;
    const [r, g, b] = groundDust(hit.surface);
    const shade = 0.88 + rnd() * 0.2;
    p.r = r * this.tint.r * shade;
    p.g = g * this.tint.g * shade;
    p.b = b * this.tint.b * shade;
    const big = 0.6 + 0.4 * Math.min(1, slip);
    p.s0 = DUST_SIZE0 * (0.85 + rnd() * 0.4);
    p.s1 = DUST_SIZE1 * big * (0.8 + rnd() * 0.45);
    // Low emits half as many: each a little denser, so a drift still reads as one cloud.
    p.peak = DUST_PEAK_ALPHA * (0.55 + 0.45 * Math.min(1, slip)) * (this.low ? 1.15 : 1);
    p.angle = rnd() * Math.PI * 2;
    p.spin = (rnd() - 0.5) * 0.9;
  }

  /** Extend this wheel's ribbon to the contact point (a segment every `SKID_STEP` metres). */
  private layRibbon(w: WheelTrack, hit: WorldHit, heading: number, slip: number): void {
    const n = hit.normal;
    const px = hit.point.x + n.x * SKID_LIFT;
    const py = hit.point.y + n.y * SKID_LIFT;
    const pz = hit.point.z + n.z * SKID_LIFT;
    if (!w.laying) {
      w.laying = true;
      this.restartRibbon(w, px, py, pz, n);
      return;
    }
    const dx = px - w.x;
    const dz = pz - w.z;
    const dist = Math.hypot(dx, dz);
    if (dist > SKID_BREAK || !Number.isFinite(dist)) {
      this.restartRibbon(w, px, py, pz, n);
      return;
    }
    if (dist < SKID_STEP) return;
    const ux = dx / dist;
    const uz = dz / dist;
    // A reversal would fold the quad over itself: start fresh edges instead of joining.
    if (w.edges && ux * w.dx + uz * w.dz < 0.2) w.edges = false;
    const half = skidHalfWidth(dx, dz, heading);
    const sx = -uz * half;
    const sz = ux * half;
    const q = this.quad;
    if (w.edges) {
      q[0] = w.lx;
      q[1] = w.ly;
      q[2] = w.lz;
      q[3] = w.rx;
      q[4] = w.ry;
      q[5] = w.rz;
    } else {
      // Fresh start edges: on the ground plane under the previous point (its own normal).
      const last = this.lastNormal;
      last.x = w.nx;
      last.y = w.ny;
      last.z = w.nz;
      q[0] = w.x + sx;
      q[1] = planeHeight(w.x, w.y, w.z, last, q[0], w.z + sz);
      q[2] = w.z + sz;
      q[3] = w.x - sx;
      q[4] = planeHeight(w.x, w.y, w.z, last, q[3], w.z - sz);
      q[5] = w.z - sz;
    }
    // Each edge on the lifted ground plane through this contact (slopes, cambers).
    q[6] = px + sx;
    q[7] = planeHeight(px, py, pz, n, q[6], pz + sz);
    q[8] = pz + sz;
    q[9] = px - sx;
    q[10] = planeHeight(px, py, pz, n, q[9], pz - sz);
    q[11] = pz - sz;
    const v1 = w.v + dist / SKID_TEXTURE_LENGTH;
    const ink = skidInk(hit.surface);
    const slot = this.ring.push(q, w.v, v1, ink.rgb, skidOpacity(ink.alpha, slip), this.time);
    this.markDirty(slot);
    w.edges = true;
    w.lx = q[6];
    w.ly = q[7];
    w.lz = q[8];
    w.rx = q[9];
    w.ry = q[10];
    w.rz = q[11];
    w.dx = ux;
    w.dz = uz;
    w.x = px;
    w.y = py;
    w.z = pz;
    w.nx = n.x;
    w.ny = n.y;
    w.nz = n.z;
    // Keep the texture coordinate small (float precision on long drifts).
    w.v = v1 % 64;
  }

  /** Begin a new ribbon at this point (no edges yet). */
  private restartRibbon(w: WheelTrack, x: number, y: number, z: number, n: Vec3): void {
    w.edges = false;
    w.x = x;
    w.y = y;
    w.z = z;
    w.nx = n.x;
    w.ny = n.y;
    w.nz = n.z;
  }

  /** Upload only the slots written this frame. */
  private markDirty(slot: number): void {
    for (const attr of this.skidAttrs) {
      attr.addUpdateRange(slot * 4 * attr.itemSize, 4 * attr.itemSize);
    }
    this.dirty = true;
  }
}

function dynamic(array: Float32Array, size: number): THREE.BufferAttribute {
  return new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
}

function copyPose(to: SlipPose, from: SlipPose): void {
  to.pos.x = from.pos.x;
  to.pos.y = from.pos.y;
  to.pos.z = from.pos.z;
  to.vel.x = from.vel.x;
  to.vel.y = from.vel.y;
  to.vel.z = from.vel.z;
  to.yaw = from.yaw;
  to.yawRate = from.yawRate;
  to.grounded = from.grounded;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

let skidMap: THREE.DataTexture | undefined;
/**
 * The ribbon's opacity: soft edges across the tyre, tread streaks and patchy rubber along it
 * (u across 0–1, v along the track, repeating). Colour comes from the vertices.
 */
export function skidTexture(): THREE.DataTexture {
  if (skidMap) return skidMap;
  const w = 32;
  const h = 64;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      const edge = smoothstep(0, 0.16, u) * smoothstep(1, 0.84, u);
      // Tread grooves (lighter lines along the track) and slow patchiness (periodic in v).
      // Light tread grooves and patchiness: the mark stays dense (the vertex alpha sets it).
      const groove = 0.88 + 0.12 * Math.abs(Math.sin(u * Math.PI * 5));
      const patch =
        0.9 +
        0.06 * Math.sin(v * Math.PI * 2 + Math.sin(u * 9) * 0.6) +
        0.04 * Math.sin(v * Math.PI * 6 + u * 4);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(Math.max(0, Math.min(1, edge * groove * patch)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  skidMap = tex;
  return tex;
}
