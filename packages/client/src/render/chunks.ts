/**
 * Persistent impact debris (Kiran, 2026-10-16: "materials flying but disappearing afterwards; we
 * need realistic physics"): small 3D chunks — irregular rock/concrete/brick chips, metal
 * fragments and glass shards (one jittered low-poly shape), wood splinters (a tapered prism) —
 * fly off a hit with real velocity and spin, fall, bounce off the rendered world with per-material
 * restitution and friction, roll, come to rest lying on the surface they landed on, and stay for
 * `CHUNKS.persist` s before shrinking out (or are recycled oldest-first).
 *
 * Presentation only: never gameplay or the network; every client simulates its own from the hit
 * events it draws. Bounded: fixed pools (a smaller ring on Low), at most `activeCap` chunks in
 * flight (one ray each per frame, against visible geometry), sleeping chunks cost no physics.
 * Two instanced draws (chips + splinters) sharing one material: one program, warmed up.
 */
import * as THREE from 'three';
import type { SurfaceKind, Vec3, WorldHit, WorldRaycaster } from '@wd/shared';
import { stepDebrisBody, type DebrisMotionOptions } from './debrisMotion.ts';
import type { GroundLift } from './flatLift.ts';
import { ImpactPool } from './impactPool.ts';

export const CHUNKS = {
  /** Pool size (High/Medium) and the ring Low uses of it. */
  capacity: 256,
  lowCapacity: 96,
  /** Chunks in flight at once (each casts one ray per frame), per tier. */
  activeCap: 128,
  lowActiveCap: 64,
  /** Seconds a settled chunk lies there, then the shrink-out (s). */
  persist: 50,
  fade: 1.5,
  /** A chunk still flying after this long left the world (or is wedged): dropped / put to rest. */
  maxAir: 6,
  /** The flight-only screen growth eases back to the real size over this long after landing. */
  landEase: 0.25,
  /** Cap on the flight-only screen growth (a 6 px floor on the smallest 8 mm fragment at 25 m
   * needs ~29×; past ~35 m flying chunks may fall under it). */
  maxFlightGrow: 32,
  /** Speed (m/s) at which a flying chunk shows its full flight growth (less below it). */
  growSpeed: 2,
  /** A flying chunk slower than this (m/s) for `stillTime` s is stuck: it is put to rest there. */
  stillSpeed: 0.35,
  stillTime: 0.4,
  gravity: 12,
  settleSpeed: 0.45,
  maxDt: 1 / 20,
} as const;

/** How each surface's chunks look and move (world half-extents in m: x, y = thickness, z). */
export interface ChunkMaterial {
  shape: 'chip' | 'splinter';
  size: readonly [number, number, number];
  /** Launch speed off the surface (m/s, ±35 %). */
  speed: number;
  /** Bounce: share of the normal speed kept; tangential speed kept (friction) per contact. */
  restitution: number;
  friction: number;
  /** Spin at launch (rad/s, random axis). */
  spin: number;
  /** 0 = matte, 1 = glossy (glass shards glint in the sun, bare metal catches it). */
  gloss: number;
}

export const CHUNK_MATERIAL: Readonly<Record<SurfaceKind, Readonly<ChunkMaterial>>> = {
  // Concrete/stone/brick chips, 1.5–4 cm.
  stone: {
    shape: 'chip',
    size: [0.014, 0.008, 0.011],
    speed: 4,
    restitution: 0.32,
    friction: 0.6,
    spin: 16,
    gloss: 0,
  },
  // Torn steel/paint fragments: thin, springy, they skitter.
  metal: {
    shape: 'chip',
    size: [0.008, 0.0025, 0.007],
    speed: 5,
    restitution: 0.45,
    friction: 0.72,
    spin: 24,
    gloss: 0.6,
  },
  // Splinters, 4–8 cm long.
  wood: {
    shape: 'splinter',
    size: [0.03, 0.004, 0.006],
    speed: 4,
    restitution: 0.35,
    friction: 0.55,
    spin: 20,
    gloss: 0,
  },
  // Shards: flat, they slide far and barely bounce.
  glass: {
    shape: 'chip',
    size: [0.012, 0.0015, 0.01],
    speed: 3.8,
    restitution: 0.18,
    friction: 0.78,
    spin: 22,
    gloss: 1,
  },
  // Dirt clods and turf: dead, they stop where they land.
  soft: {
    shape: 'chip',
    size: [0.01, 0.008, 0.009],
    speed: 2.4,
    restitution: 0.08,
    friction: 0.35,
    spin: 8,
    gloss: 0,
  },
};

export interface Chunk {
  born: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  settled: boolean;
  collide: boolean;
  planeNx: number;
  planeNy: number;
  planeNz: number;
  planeD: number;
  hitNx?: number;
  hitNy?: number;
  hitNz?: number;
  /** World half-extents (m) and the flight-only screen growth. */
  sx: number;
  sy: number;
  sz: number;
  grow: number;
  radius: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wx: number;
  wy: number;
  wz: number;
  r: number;
  g: number;
  b: number;
  splinter: boolean;
  gloss: number;
  restitution: number;
  friction: number;
  /** Seconds in flight; seconds since it settled. */
  air: number;
  rest: number;
  /** Seconds it has been nearly still while flying (wedged on an edge or a steep face). */
  still: number;
  /** The growth drawn on the last frame (the landing ease starts from it). */
  shown: number;
}

const chunk = (): Chunk => ({
  born: 0,
  life: 0,
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  settled: false,
  collide: true,
  planeNx: 0,
  planeNy: 1,
  planeNz: 0,
  planeD: 0,
  sx: 0.01,
  sy: 0.01,
  sz: 0.01,
  grow: 1,
  radius: 0.01,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  wx: 0,
  wy: 0,
  wz: 0,
  r: 0.5,
  g: 0.5,
  b: 0.5,
  splinter: false,
  gloss: 0,
  restitution: 0.3,
  friction: 0.6,
  air: 0,
  still: 0,
  shown: 1,
  rest: 0,
});

/** Visual scale of a chunk now: its flight growth eased out after landing × the final shrink. */
export function chunkDrawScale(
  c: Pick<Chunk, 'settled' | 'grow' | 'rest' | 'life'>,
  speed = Infinity,
): number {
  const shrink = c.settled ? Math.min(1, Math.max(0, c.life / CHUNKS.fade)) : 1;
  return chunkGrowth(c, speed) * shrink;
}

/**
 * The growth part of the drawn scale. Flying: the flight growth is for something visibly flying,
 * so a slow or stopped chunk is drawn at its true size even before it rests (a wedged chunk never
 * hangs there as a big block). Settled: `grow` is what was on screen when it landed (`settle`
 * stores it), eased down to 1 — the landing never pops the chunk back up to its flight size.
 */
export function chunkGrowth(c: Pick<Chunk, 'settled' | 'grow' | 'rest'>, speed = Infinity): number {
  if (c.settled) return 1 + (c.grow - 1) * Math.max(0, 1 - c.rest / CHUNKS.landEase);
  return 1 + (c.grow - 1) * Math.min(1, Math.max(0, speed / CHUNKS.growSpeed));
}

/**
 * Spin after a bounce: half the old spin kept, half turned into rolling on the surface
 * (ω = n × v / r for the speed left along it). `out` gets the new spin.
 */
export function bounceSpin(
  w: Vec3,
  n: Vec3,
  v: Vec3,
  radius: number,
  out: { x: number; y: number; z: number },
): void {
  const r = Math.max(1e-3, radius);
  const rx = (n.y * v.z - n.z * v.y) / r;
  const ry = (n.z * v.x - n.x * v.z) / r;
  const rz = (n.x * v.y - n.y * v.x) / r;
  out.x = w.x * 0.5 + rx * 0.5;
  out.y = w.y * 0.5 + ry * 0.5;
  out.z = w.z * 0.5 + rz * 0.5;
}

/**
 * Where a settled chunk lies: its thin local y axis along the surface normal, a yaw about it,
 * resting `sy` (its half-thickness) above the contact. Returns into `out` (position) and `q`.
 */
export function restPose(
  contact: Vec3,
  n: Vec3,
  halfThickness: number,
  yaw: number,
  out: { x: number; y: number; z: number },
  q: THREE.Quaternion,
): void {
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  NORMAL.set(n.x / len, n.y / len, n.z / len);
  q.setFromUnitVectors(UP, NORMAL);
  YAW.setFromAxisAngle(UP, yaw);
  q.multiply(YAW);
  out.x = contact.x + NORMAL.x * halfThickness;
  out.y = contact.y + NORMAL.y * halfThickness;
  out.z = contact.z + NORMAL.z * halfThickness;
}
const UP = new THREE.Vector3(0, 1, 0);
const NORMAL = new THREE.Vector3();
const YAW = new THREE.Quaternion();

/**
 * Advance one chunk (pure apart from the world rays): ages it, flies and bounces it, settles it
 * and lays it down. Returns whether it used a world ray this step.
 */
export function stepChunk(
  c: Chunk,
  dt: number,
  world: WorldRaycaster | null,
  opt: DebrisMotionOptions,
  scratchQ: THREE.Quaternion,
  groundLift: GroundLift | null = null,
): boolean {
  if (!(dt > 0) || c.life <= 0) return false;
  if (c.settled) {
    c.rest += dt;
    c.life -= dt;
    return false;
  }
  c.air += dt;
  if (c.air > CHUNKS.maxAir) {
    // Fell out of the world (still fast) or wedged somewhere (slow): drop it / let it lie.
    if (Math.hypot(c.vx, c.vy, c.vz) > 1) {
      c.life = 0;
      return false;
    }
    HIT_N.x = c.hitNx ?? 0;
    HIT_N.y = c.hitNy ?? 1;
    HIT_N.z = c.hitNz ?? 0;
    settle(c, HIT_N, scratchQ, groundLift);
    return false;
  }
  opt.radius = c.radius;
  opt.restitution = c.restitution;
  opt.tangentDamping = c.friction;
  const ray = !!world && c.collide;
  const bounced = stepDebrisBody(c, dt, ray ? world : null, opt);
  if (bounced) {
    HIT_N.x = c.hitNx ?? 0;
    HIT_N.y = c.hitNy ?? 1;
    HIT_N.z = c.hitNz ?? 0;
    const n = HIT_N;
    W.x = c.wx;
    W.y = c.wy;
    W.z = c.wz;
    V.x = c.vx;
    V.y = c.vy;
    V.z = c.vz;
    bounceSpin(W, n, V, c.radius, SPIN);
    c.wx = SPIN.x;
    c.wy = SPIN.y;
    c.wz = SPIN.z;
    if (c.settled) settle(c, n, scratchQ, groundLift);
  }
  if (!c.settled) {
    // Wedged (an edge, a steep ledge, a corner): bouncing in place forever reads as hanging in
    // the air. Nearly still for a moment → put to rest against what it last touched.
    c.still = Math.hypot(c.vx, c.vy, c.vz) < CHUNKS.stillSpeed ? c.still + dt : 0;
    if (c.still > CHUNKS.stillTime) {
      HIT_N.x = c.hitNx ?? 0;
      HIT_N.y = c.hitNy ?? 1;
      HIT_N.z = c.hitNz ?? 0;
      settle(c, HIT_N, scratchQ, groundLift);
      return ray;
    }
  }
  if (!c.settled) {
    const spin = Math.hypot(c.wx, c.wy, c.wz);
    if (spin > 1e-5) {
      const half = spin * dt * 0.5;
      const s = Math.sin(half) / spin;
      scratchQ.set(c.wx * s, c.wy * s, c.wz * s, Math.cos(half));
      Q.set(c.qx, c.qy, c.qz, c.qw).multiply(scratchQ).normalize();
      c.qx = Q.x;
      c.qy = Q.y;
      c.qz = Q.z;
      c.qw = Q.w;
    }
  }
  return ray;
}
const SPIN = { x: 0, y: 0, z: 0 };
const HIT_N = { x: 0, y: 1, z: 0 };
const W = { x: 0, y: 0, z: 0 };
const V = { x: 0, y: 0, z: 0 };
const CONTACT = { x: 0, y: 0, z: 0 };
const Q = new THREE.Quaternion();
const POS = { x: 0, y: 0, z: 0 };

/** Put a chunk to rest on the surface it is touching (`n`), lying flat, for its persist time. */
function settle(
  c: Chunk,
  n: Vec3,
  scratchQ: THREE.Quaternion,
  groundLift: GroundLift | null,
): void {
  // The body sits `radius` off the contact (the bounce put it there): find the contact again.
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const contact = CONTACT;
  contact.x = c.x - (n.x / len) * c.radius;
  contact.y = c.y - (n.y / len) * c.radius;
  contact.z = c.z - (n.z / len) * c.radius;
  // On the ground the rays meet the collision floor, but the paving is drawn lifted over it
  // (map flats, up to ~2 cm): lie on what is drawn, not inside it.
  if (groundLift && n.y / len > 0.5) contact.y += groundLift(contact.x, contact.y, contact.z);
  // Keep the heading it tumbled to (its local x projected), so piles don't line up.
  const yaw = Math.atan2(2 * (c.qw * c.qy + c.qx * c.qz), 1 - 2 * (c.qy * c.qy + c.qz * c.qz));
  restPose(contact, n, c.sy, yaw, POS, scratchQ);
  c.x = POS.x;
  c.y = POS.y;
  c.z = POS.z;
  c.qx = scratchQ.x;
  c.qy = scratchQ.y;
  c.qz = scratchQ.z;
  c.qw = scratchQ.w;
  c.vx = c.vy = c.vz = 0;
  c.wx = c.wy = c.wz = 0;
  c.settled = true;
  c.rest = 0;
  // Ease down from what was on screen (speed-attenuated), never back up to the flight growth.
  c.grow = Math.min(c.grow, c.shown);
  c.life = CHUNKS.persist + CHUNKS.fade;
}

/** A jittered, flat-shaded low-poly chunk normalised to the unit box (deterministic). */
export function chunkGeometry(shape: 'chip' | 'splinter'): THREE.BufferGeometry {
  const base =
    shape === 'chip'
      ? new THREE.IcosahedronGeometry(1, 0)
      : new THREE.CylinderGeometry(0.45, 0.12, 2, 5, 1).rotateZ(Math.PI / 2);
  const geo = base.index ? base.toNonIndexed() : base;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  // Same jitter for the same corner (shared by its faces), so the solid stays closed.
  const jitter = new Map<string, [number, number, number]>();
  let k = 0;
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let j = jitter.get(key);
    if (!j) {
      const h = (n: number): number => {
        const v = Math.sin((k + 1) * 12.9898 + n * 78.233) * 43758.5453;
        return v - Math.floor(v);
      };
      const amp = shape === 'chip' ? 0.32 : 0.18;
      j = [1 + (h(1) - 0.5) * amp * 2, 1 + (h(2) - 0.5) * amp * 2, 1 + (h(3) - 0.5) * amp * 2];
      jitter.set(key, j);
      k++;
    }
    pos.setXYZ(i, pos.getX(i) * j[0], pos.getY(i) * j[1], pos.getZ(i) * j[2]);
  }
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const half = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(half).multiplyScalar(0.5);
  box.getCenter(centre);
  geo.translate(-centre.x, -centre.y, -centre.z);
  geo.scale(1 / half.x, 1 / half.y, 1 / half.z);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.name = `fx:debris-${shape}-geo`;
  return geo;
}

/** The persistent chunk debris: one pool, two instanced draws (chips, splinters), one material. */
export class ChunkDebris {
  readonly group = new THREE.Group();
  readonly chips: THREE.InstancedMesh;
  readonly splinters: THREE.InstancedMesh;
  private readonly pool = new ImpactPool(CHUNKS.capacity, chunk);
  private readonly motion: DebrisMotionOptions = {
    gravity: CHUNKS.gravity,
    radius: 0.01,
    restitution: 0.3,
    tangentDamping: 0.6,
    settleSpeed: CHUNKS.settleSpeed,
    maxDt: CHUNKS.maxDt,
  };
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scratchQ = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private low = false;
  private groundLift: GroundLift | null = null;
  /** Chunks in flight after the last update (spawns add to it). */
  private flying = 0;
  private world: WorldRaycaster | null = null;
  /** Rays against what is drawn: collision-only helpers (stair ramps, hull skins) are skipped. */
  private readonly visible: WorldRaycaster = {
    castRay: (o: Vec3, d: Vec3, max: number): WorldHit | null => {
      const w = this.world;
      if (!w) return null;
      return w.castVisibleRay ? w.castVisibleRay(o, d, max) : w.castRay(o, d, max);
    },
  };

  constructor() {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
    material.name = 'fx:debris-chunk';
    // Per-instance gloss (one program for every material's chunks): roughness falls toward
    // polished, metalness rises for bare metal, so shards and fragments catch the sun.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aGloss;\nvarying float vGloss;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGloss = aGloss;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGloss;')
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, vGloss);',
        )
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.85, max(0.0, vGloss * 2.5 - 1.25));',
        );
    };
    material.customProgramCacheKey = () => 'debris-chunk-gloss-v1';
    const mesh = (shape: 'chip' | 'splinter', name: string): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(chunkGeometry(shape), material, CHUNKS.capacity);
      m.name = name;
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(CHUNKS.capacity * 3),
        3,
      ).setUsage(THREE.DynamicDrawUsage);
      m.geometry.setAttribute(
        'aGloss',
        new THREE.InstancedBufferAttribute(new Float32Array(CHUNKS.capacity), 1).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      return m;
    };
    this.chips = mesh('chip', 'fx:debris-chips');
    this.splinters = mesh('splinter', 'fx:debris-splinters');
    this.group.name = 'fx:debris-chunks';
    this.group.add(this.chips, this.splinters);
  }

  setWorldRaycaster(world: WorldRaycaster | null): void {
    this.world = world;
  }

  /** The rendered ground's lift over the collision (map flats) where chunks come to rest. */
  setGroundLift(lift: GroundLift | null): void {
    this.groundLift = lift;
  }

  setLow(low: boolean): void {
    this.low = low;
  }

  /**
   * Throw up to `count` chunks of `surface` off a hit (`point`, outward `normal`), coloured
   * `colour`; `minFlightSize` = the world size (m) a chunk must show at in flight to keep its
   * readability floor (each chunk grows to it while flying, ≤ `maxFlightGrow`×, and eases back to
   * its true size on landing; 0 = none). Fewer when too many are in flight.
   */
  spawn(
    point: Vec3,
    normal: Vec3,
    surface: SurfaceKind,
    count: number,
    colour: readonly [number, number, number],
    minFlightSize: number,
    rnd: () => number = Math.random,
  ): number {
    const m = CHUNK_MATERIAL[surface];
    const cap = this.low ? CHUNKS.lowActiveCap : CHUNKS.activeCap;
    const n = Math.max(0, Math.min(count, cap - this.flying));
    const ring = this.low ? CHUNKS.lowCapacity : CHUNKS.capacity;
    const len = Math.hypot(normal.x, normal.y, normal.z) || 1;
    const nx = normal.x / len;
    const ny = normal.y / len;
    const nz = normal.z / len;
    for (let i = 0; i < n; i++) {
      const c = this.pool.acquire(ring);
      const size = 0.6 + rnd() * 0.9;
      c.sx = m.size[0] * size * (0.85 + rnd() * 0.3);
      c.sy = m.size[1] * size * (0.85 + rnd() * 0.3);
      c.sz = m.size[2] * size * (0.85 + rnd() * 0.3);
      c.radius = Math.max(c.sx, c.sy, c.sz);
      c.grow = Math.min(CHUNKS.maxFlightGrow, Math.max(1, minFlightSize / (2 * c.radius)));
      c.splinter = m.shape === 'splinter';
      c.gloss = m.gloss;
      c.restitution = m.restitution;
      c.friction = m.friction;
      c.planeNx = nx;
      c.planeNy = ny;
      c.planeNz = nz;
      c.planeD = nx * point.x + ny * point.y + nz * point.z;
      c.x = point.x + nx * c.radius;
      c.y = point.y + ny * c.radius;
      c.z = point.z + nz * c.radius;
      // A cone out of the surface, a little lift, real speeds (no distance scaling: they stay).
      const speed = m.speed * (0.65 + rnd() * 0.7);
      c.vx = (nx + (rnd() - 0.5) * 1.3) * speed;
      c.vy = (ny + 0.4 + (rnd() - 0.5) * 1.3) * speed;
      c.vz = (nz + (rnd() - 0.5) * 1.3) * speed;
      const out = c.vx * nx + c.vy * ny + c.vz * nz;
      if (out < speed * 0.3) {
        const push = speed * 0.3 - out;
        c.vx += nx * push;
        c.vy += ny * push;
        c.vz += nz * push;
      }
      this.quaternion.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 1).normalize();
      c.qx = this.quaternion.x;
      c.qy = this.quaternion.y;
      c.qz = this.quaternion.z;
      c.qw = this.quaternion.w;
      const spin = m.spin * (0.5 + rnd());
      c.wx = (rnd() - 0.5) * spin;
      c.wy = (rnd() - 0.5) * spin;
      c.wz = (rnd() - 0.5) * spin;
      const shade = 0.78 + rnd() * 0.42;
      c.r = colour[0] * shade;
      c.g = colour[1] * shade;
      c.b = colour[2] * shade;
      c.settled = false;
      c.collide = true;
      c.hitNx = c.hitNy = c.hitNz = undefined;
      c.air = 0;
      c.still = 0;
      c.rest = 0;
      c.shown = c.grow;
      c.life = CHUNKS.maxAir + CHUNKS.persist + CHUNKS.fade;
    }
    this.flying += n;
    return n;
  }

  update(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const step = Math.min(dt, CHUNKS.maxDt);
    let chips = 0;
    let splinters = 0;
    let flying = 0;
    const world = this.world ? this.visible : null;
    for (const c of this.pool.slots) {
      if (c.life <= 0) continue;
      stepChunk(c, step, world, this.motion, this.scratchQ, this.groundLift);
      if (c.life <= 0) continue;
      if (!c.settled) flying++;
      const speed = Math.hypot(c.vx, c.vy, c.vz);
      c.shown = chunkGrowth(c, speed);
      const s = chunkDrawScale(c, speed);
      this.position.set(c.x, c.y, c.z);
      this.quaternion.set(c.qx, c.qy, c.qz, c.qw);
      this.scale.set(c.sx * s, c.sy * s, c.sz * s);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.color.setRGB(c.r, c.g, c.b);
      const mesh = c.splinter ? this.splinters : this.chips;
      const i = c.splinter ? splinters++ : chips++;
      mesh.setMatrixAt(i, this.matrix);
      mesh.setColorAt(i, this.color);
      (mesh.geometry.getAttribute('aGloss') as THREE.InstancedBufferAttribute).setX(i, c.gloss);
    }
    this.flying = flying;
    for (const [mesh, n] of [
      [this.chips, chips],
      [this.splinters, splinters],
    ] as const) {
      mesh.count = n;
      if (n) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
        mesh.geometry.getAttribute('aGloss').needsUpdate = true;
      }
    }
  }

  /** One off-screen instance in each draw for warm-up; returns the restore. */
  beginWarmUp(): () => void {
    const saved = [this.chips, this.splinters].map((mesh) => {
      const m = new THREE.Matrix4();
      const c = new THREE.Color();
      mesh.getMatrixAt(0, m);
      mesh.getColorAt(0, c);
      const count = mesh.count;
      this.matrix.makeScale(0.01, 0.01, 0.01).setPosition(0, -500, 0);
      mesh.setMatrixAt(0, this.matrix);
      mesh.setColorAt(0, this.color.setRGB(0.5, 0.5, 0.5));
      mesh.count = Math.max(1, count);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      return { mesh, m, c, count };
    });
    return () => {
      for (const { mesh, m, c, count } of saved) {
        mesh.setMatrixAt(0, m);
        mesh.setColorAt(0, c);
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      }
    };
  }

  /** Live chunks, in flight, at rest. */
  stats(): { live: number; flying: number; resting: number } {
    let live = 0;
    let resting = 0;
    for (const c of this.pool.slots) {
      if (c.life <= 0) continue;
      live++;
      if (c.settled) resting++;
    }
    return { live, flying: live - resting, resting };
  }

  /** The records (tests/probes). */
  get slots(): readonly Chunk[] {
    return this.pool.slots;
  }
}
