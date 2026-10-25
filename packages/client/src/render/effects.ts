import * as THREE from 'three';
import type { GrenadeState, SmokeCloud, SurfaceKind, Vec3, WorldRaycaster } from '@wd/shared';
import { DEBRIS, ImpactDebris } from './debris.ts';
import {
  DECAL_GAIN,
  DECAL_TILE_COUNT,
  DECAL_TILE_PX,
  DECAL_VARIANTS,
  decalTile,
  decalWorldSize,
  impactDecalAtlasTexture,
} from './decalAtlas.ts';
import { OVER_FLATS } from './mapMesh.ts';

export { impactDecalAtlasTexture } from './decalAtlas.ts';

const TRACER_LIFE = 0.06;
const MAX_DECALS = 160;
const SMOKE_LIFE = 2.6;
const FIREBALL_LIFE = 0.28;
/** UV inset per tile edge (half a texel) so bilinear filtering never bleeds a neighbour in. */
const DECAL_TILE_SCALE = 1 / DECAL_TILE_COUNT;
const DECAL_UV_INSET = 0.5 / (DECAL_TILE_PX * DECAL_TILE_COUNT);

export interface ExplosionContact {
  point: Vec3;
  normal: Vec3;
  surface: SurfaceKind;
}

/** Pooled combat effects: tracers, per-surface decals and shared impact debris. */
export class Effects {
  readonly group = new THREE.Group();
  private readonly tracers: { mesh: THREE.Mesh; life: number }[] = [];
  /**
   * Bullet holes, two batches of the same program: walls and props keep a small depth bias;
   * up-facing ground holes need `OVER_FLATS` to clear the paving flats, a bias that on a wall
   * would pull a far decal ~20 cm forward through whatever stands in front of it.
   */
  private readonly decalBatches: { wall: DecalBatch; ground: DecalBatch };
  private readonly tmp = new THREE.Object3D();
  /** Surface debris (chips, splinters, sparks, glints, dust): three pooled draw calls. */
  readonly debris = new ImpactDebris();
  private readonly grenadeMeshes = new Map<number, THREE.Mesh>();
  private readonly grenadeGeo = new THREE.IcosahedronGeometry(0.07, 1);
  private readonly grenadeMat = new THREE.MeshStandardMaterial({
    color: '#4e5536',
    roughness: 0.8,
    metalness: 0.1,
  });
  private readonly fireballs: { sprite: THREE.Sprite; life: number }[] = [];
  private readonly smoke: {
    sprite: THREE.Sprite;
    life: number;
    vel: THREE.Vector3;
    size: number;
  }[] = [];
  private readonly scorches: THREE.Mesh[] = [];
  private readonly scorchMats: { wall: THREE.MeshBasicMaterial; ground: THREE.MeshBasicMaterial };
  private scorchCursor = 0;
  /** A short-lived light at the blast (one permanent light: toggling lights recompiles shaders). */
  private readonly blastLight = new THREE.PointLight('#ffb766', 0, 28, 1.6);
  private blastLife = 0;
  private readonly planeNormal = new THREE.Vector3(0, 0, 1);
  private readonly contactNormal = new THREE.Vector3();

  constructor() {
    this.group.name = 'effects';
    const tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 1);
    tracerGeo.translate(0, 0, -0.5); // origin at start, extends along -Z
    const tracerMat = new THREE.MeshBasicMaterial({
      color: '#ffe2a0',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // 24: a shotgun blast alone draws nine.
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat.clone());
      mesh.visible = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    const atlas = impactDecalAtlasTexture();
    this.decalBatches = {
      wall: new DecalBatch('fx:impact-decals', atlas, MAX_DECALS, WALL_DECAL_OFFSET),
      ground: new DecalBatch('fx:impact-decals-ground', atlas, MAX_GROUND_DECALS, OVER_FLATS),
    };
    this.group.add(this.decalBatches.wall.mesh, this.decalBatches.ground.mesh);
    this.group.add(this.debris.group);

    const fireMat = new THREE.SpriteMaterial({
      map: radialTexture('rgba(255,236,190,1)', 'rgba(255,120,30,0)'),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    for (let i = 0; i < 3; i++) {
      const sprite = new THREE.Sprite(fireMat.clone());
      sprite.visible = false;
      this.group.add(sprite);
      this.fireballs.push({ sprite, life: 0 });
    }
    const smokeMat = new THREE.SpriteMaterial({
      map: radialTexture('rgba(70,68,64,0.9)', 'rgba(70,68,64,0)'),
      depthWrite: false,
      transparent: true,
    });
    for (let i = 0; i < 36; i++) {
      const sprite = new THREE.Sprite(smokeMat.clone());
      sprite.visible = false;
      this.group.add(sprite);
      this.smoke.push({ sprite, life: 0, vel: new THREE.Vector3(), size: 1 });
    }
    const scorchMap = radialTexture('rgba(12,10,9,0.85)', 'rgba(12,10,9,0)');
    const scorchMat = (bias: { factor: number; units: number }): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        map: scorchMap,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: bias.factor,
        polygonOffsetUnits: bias.units,
      });
    // Same program, different depth bias: ground scorches clear the paving flats.
    this.scorchMats = { wall: scorchMat(WALL_DECAL_OFFSET), ground: scorchMat(OVER_FLATS) };
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), this.scorchMats.ground);
      m.name = 'fx:blast-scorch';
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.group.add(m);
      this.scorches.push(m);
    }
    this.group.add(this.blastLight);
  }

  setWorldRaycaster(world: WorldRaycaster | null): void {
    this.debris.setWorldRaycaster(world);
  }

  setImpactView(
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    low: boolean,
    smoke: readonly SmokeCloud[] = [],
  ): void {
    this.debris.setView(camera, viewportHeight, low);
    this.debris.setSmoke(smoke);
  }

  setImpactLighting(sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void {
    this.debris.setLighting(sun, hemi);
  }

  beginWarmUp(): () => void {
    const restoreDebris = this.debris.beginWarmUp();
    const restoreWall = this.decalBatches.wall.beginWarmUp(this.tmp);
    const restoreGround = this.decalBatches.ground.beginWarmUp(this.tmp);
    return () => {
      restoreDebris();
      restoreWall();
      restoreGround();
    };
  }

  addGrenade(id: number): void {
    const mesh = new THREE.Mesh(this.grenadeGeo, this.grenadeMat);
    mesh.castShadow = true;
    mesh.scale.set(1, 1.2, 1);
    this.group.add(mesh);
    this.grenadeMeshes.set(id, mesh);
  }

  explosion(at: Vec3, contact?: ExplosionContact): void {
    for (const f of this.fireballs) {
      if (f.life > 0) continue;
      f.sprite.position.set(at.x, at.y + 0.5, at.z);
      f.sprite.visible = true;
      f.life = FIREBALL_LIFE;
      break;
    }
    let spawned = 0;
    for (const p of this.smoke) {
      if (p.life > 0 || spawned >= 12) continue;
      const a = (spawned / 12) * Math.PI * 2 + Math.random() * 0.4;
      const r = Math.random() * 0.6;
      p.sprite.position.set(
        at.x + Math.cos(a) * r,
        at.y + 0.3 + Math.random() * 0.8,
        at.z + Math.sin(a) * r,
      );
      p.vel.set(
        Math.cos(a) * (1 + Math.random() * 2),
        0.8 + Math.random() * 1.2,
        Math.sin(a) * (1 + Math.random() * 2),
      );
      p.size = 1.2 + Math.random() * 1.2;
      p.life = SMOKE_LIFE * (0.7 + Math.random() * 0.3);
      p.sprite.visible = true;
      spawned++;
    }
    if (contact) {
      this.debris.burst(contact.point, contact.normal, contact.surface);
      this.debris.burst(contact.point, contact.normal, contact.surface);
      const scorch = this.scorches[this.scorchCursor]!;
      this.scorchCursor = (this.scorchCursor + 1) % this.scorches.length;
      const { point: p, normal: n } = contact;
      const lift = decalLift(n);
      scorch.material = isGround(n) ? this.scorchMats.ground : this.scorchMats.wall;
      scorch.position.set(p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift);
      this.contactNormal.set(n.x, n.y, n.z).normalize();
      scorch.quaternion.setFromUnitVectors(this.planeNormal, this.contactNormal);
      scorch.rotateZ(Math.random() * Math.PI * 2);
      scorch.visible = true;
    }
    this.blastLight.position.set(at.x, at.y + 0.8, at.z);
    this.blastLife = 0.18;
  }

  /** A tracer; `arc` = the energy rifle's thicker cyan bolt. */
  tracer(from: Vec3, to: Vec3, arc = false): void {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0]!;
    (t.mesh.material as THREE.MeshBasicMaterial).color.set(arc ? '#39e0ff' : '#ffe2a0');
    const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    t.mesh.position.set(from.x, from.y, from.z);
    t.mesh.lookAt(to.x, to.y, to.z);
    t.mesh.rotateY(Math.PI); // lookAt points +Z at the target; geometry extends along -Z
    t.mesh.scale.set(arc ? 2.4 : 1, arc ? 2.4 : 1, Math.min(len, 400));
    t.mesh.visible = true;
    t.life = TRACER_LIFE;
  }

  /**
   * Presentation dressing drawn over collision faces (the market hall's cladding): how far a
   * bullet hole must move out along the hit normal to sit on the visible skin. Collision stays
   * authoritative; only the decal moves.
   */
  private decalLift: ((point: Vec3, normal: Vec3) => number) | null = null;

  setDecalLift(lift: ((point: Vec3, normal: Vec3) => number) | null): void {
    this.decalLift = lift;
  }

  impact(point: Vec3, normal: Vec3, surface: SurfaceKind = 'stone', detail = true): void {
    if (detail) this.debris.burst(point, normal, surface);
    if (!DEBRIS[surface].decal) return;
    // Soft surfaces keep a divot only in the ground (lawn, dirt), not in a hedge or a sandbag face.
    if (surface === 'soft' && !isGround(normal)) return;
    // The surface's own offset (ground: clear the map's flats; walls: a hair), measured from the
    // collision face; presentation skins over that face (the market hall) push it further out.
    // Ground holes take whichever is higher, not the sum: a floor skin a few mm up is already
    // under the flats' clearance and must not lift the hole twice.
    const skin = this.decalLift?.(point, normal) ?? 0;
    const base = decalLift(normal);
    const lift = isGround(normal) ? Math.max(base, skin + 0.004) : base + skin;
    this.tmp.position.set(
      point.x + normal.x * lift,
      point.y + normal.y * lift,
      point.z + normal.z * lift,
    );
    this.tmp.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    this.tmp.rotateZ(Math.random() * Math.PI * 2);
    // Physical size, wherever it was shot from (±20 %), and one of the surface's variants.
    this.tmp.scale.setScalar(decalWorldSize(surface));
    this.tmp.updateMatrix();
    const tile = decalTile(surface, Math.random() * DECAL_VARIANTS);
    (isGround(normal) ? this.decalBatches.ground : this.decalBatches.wall).add(
      this.tmp.matrix,
      tile,
    );
  }

  update(dt: number, grenades: readonly GrenadeState[] = [], _alpha = 1): void {
    const live = new Set<number>();
    for (const g of grenades) {
      live.add(g.id);
      const mesh = this.grenadeMeshes.get(g.id);
      if (!mesh) continue;
      mesh.position.set(g.pos.x, g.pos.y, g.pos.z);
      if (!g.resting) mesh.rotation.x += dt * 14;
    }
    for (const [id, mesh] of this.grenadeMeshes) {
      if (live.has(id)) continue;
      this.group.remove(mesh);
      this.grenadeMeshes.delete(id);
    }
    for (const f of this.fireballs) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = 1 - Math.max(0, f.life) / FIREBALL_LIFE;
      f.sprite.scale.setScalar(1.5 + k * 5);
      f.sprite.material.opacity = Math.max(0, 1 - k * k);
      f.sprite.visible = f.life > 0;
    }
    for (const p of this.smoke) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vel.multiplyScalar(Math.exp(-1.6 * dt));
      p.vel.y += 0.35 * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      const k = 1 - Math.max(0, p.life) / SMOKE_LIFE;
      p.sprite.scale.setScalar(p.size * (1 + 2.2 * k));
      p.sprite.material.opacity = Math.max(0, 0.75 * (1 - k));
      p.sprite.visible = p.life > 0;
    }
    this.blastLife = Math.max(0, this.blastLife - dt);
    this.blastLight.intensity = (this.blastLife / 0.18) * 60;

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, t.life / TRACER_LIFE);
      t.mesh.visible = t.life > 0;
    }
    this.debris.update(dt);
  }
}

/** Three's fog chunk with the fog colour replaced by the multiply blend's neutral (1). */
export function decalFogFragment(): string {
  return THREE.ShaderChunk.fog_fragment.split('fogColor').join('vec3( 1.0 )');
}

/** The decal factor after fog: `mix(factor, 1, fogFactor)` (what `decalFogFragment` does). */
export function foggedDecalFactor(factor: number, fogFactor: number): number {
  return factor + (1 - factor) * Math.min(1, Math.max(0, fogFactor));
}

function applyDecalAtlasUv(mat: THREE.MeshBasicMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
attribute float decalTile;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv.x = clamp(
    (vMapUv.x + decalTile) * ${DECAL_TILE_SCALE.toFixed(8)},
    decalTile * ${DECAL_TILE_SCALE.toFixed(8)} + ${DECAL_UV_INSET.toFixed(8)},
    (decalTile + 1.0) * ${DECAL_TILE_SCALE.toFixed(8)} - ${DECAL_UV_INSET.toFixed(8)}
  );
#endif`,
    );
    // The decal is a factor on an already-fogged surface: fog takes it toward 1 (no change),
    // not toward the fog colour, so in haze a hole fades with the wall it is on.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      decalFogFragment(),
    );
  };
  mat.customProgramCacheKey = () => `impactDecalAtlasUv:${DECAL_TILE_COUNT}:fogToNeutral`;
}

/**
 * How far a decal sits off its surface (m): ground (up-facing) decals clear the map's lifted
 * flats (`OVER_FLATS`); walls keep a hair.
 */
export function decalLift(normal: Vec3): number {
  return isGround(normal) ? OVER_FLATS.lift : 0.004;
}

/** Up-facing enough to be ground (where the map's flats lie). */
export function isGround(normal: Vec3): boolean {
  const len = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return normal.y / len > 0.5;
}

/** The old wall/prop decal depth bias (factor, units). */
export const WALL_DECAL_OFFSET = { factor: -4, units: 0 } as const;
/** Ground holes kept (a second, smaller ring). */
const MAX_GROUND_DECALS = 96;

/** One instanced ring of atlas decals with its own depth bias (the shared decal program). */
class DecalBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly tile: THREE.InstancedBufferAttribute;
  private cursor = 0;

  constructor(
    name: string,
    atlas: THREE.Texture,
    private readonly capacity: number,
    bias: { factor: number; units: number },
  ) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.tile = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(
      THREE.DynamicDrawUsage,
    );
    geo.setAttribute('decalTile', this.tile);
    // Multiply blend (dst × src): the atlas holds factors relative to the surface underneath, so
    // spall is lighter paving on paving and lighter sandstone on sandstone (Kiran's grade:
    // fixed light-grey spall read as white paint on blue-grey paving). `color` restores the
    // gain the atlas was divided by; no tone mapping on a factor (the surface it scales already
    // has it), and fog fades the factor to 1, not to the fog colour. Blend state, not a define: one program for both batches.
    const mat = new THREE.MeshBasicMaterial({
      name: 'fx:impact-decal-atlas',
      map: atlas,
      color: new THREE.Color(DECAL_GAIN, DECAL_GAIN, DECAL_GAIN),
      transparent: true,
      depthWrite: false,
      // Fogged toward the blend's neutral, not the fog colour (`decalFogFragment`).
      fog: true,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: bias.factor,
      polygonOffsetUnits: bias.units,
    });
    applyDecalAtlasUv(mat);
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  add(matrix: THREE.Matrix4, tile: number): void {
    this.mesh.setMatrixAt(this.cursor, matrix);
    this.tile.setX(this.cursor, tile);
    this.cursor = (this.cursor + 1) % this.capacity;
    this.mesh.count = Math.min(this.capacity, this.mesh.count + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tile.needsUpdate = true;
  }

  /** Draw one off-screen decal (warm-up), keeping slot 0; returns the restore. */
  beginWarmUp(tmp: THREE.Object3D): () => void {
    const count = this.mesh.count;
    const matrix = new THREE.Matrix4();
    const tile = this.tile.getX(0);
    if (count > 0) this.mesh.getMatrixAt(0, matrix);
    tmp.position.set(0, -500, 0);
    tmp.quaternion.identity();
    tmp.scale.setScalar(0.12);
    tmp.updateMatrix();
    this.mesh.setMatrixAt(0, tmp.matrix);
    this.tile.setX(0, 0);
    this.mesh.count = Math.max(1, count);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tile.needsUpdate = true;
    return () => {
      if (count > 0) this.mesh.setMatrixAt(0, matrix);
      this.tile.setX(0, tile);
      this.mesh.count = count;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.tile.needsUpdate = true;
    };
  }
}

function radialTexture(
  inner = 'rgba(255,255,255,1)',
  outer = 'rgba(255,255,255,0)',
): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.45, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
