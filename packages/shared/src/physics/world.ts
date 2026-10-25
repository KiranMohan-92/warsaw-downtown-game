import { treeTrunkRadiusOf } from '../maps/trees.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { CHARACTER, PLAYER, VEHICLE_IMPACT } from '../config/tunables.ts';
import { quatFromEulerDeg, rotateByQuat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import {
  fitBox,
  fitDecor,
  instanceCorners,
  PROP_GEOMETRY,
  PROP_SIZES,
  propInterior,
  propSurface,
  type PropInstance,
  type PropModelId,
} from '../maps/propModels.ts';
import { surfaceOfMaterial, surfaceOfModel, type SurfaceKind } from '../maps/surfaces.ts';
import { placeRayMesh, wreckRayMesh } from '../maps/wreckGeometry.ts';
import type { HeroId, MapDefinition, WreckHeroId } from '../maps/types.ts';
import type { WorldHit, WorldRaycaster } from '../sim/hitscan.ts';
import type { CharacterBody, MoveResult } from '../sim/player.ts';
import type { Quat } from '../math/quat.ts';
import type { VehicleObstacle, VehicleWorld } from '../sim/vehicles/vehicle.ts';

let initPromise: Promise<void> | null = null;

/** Load the Rapier WASM module once (browser and Node). Must resolve before creating worlds. */
export function initPhysics(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

/** Collision groups: 16-bit membership << 16 | 16-bit filter. */
const GROUP_STATIC = 1 << 0;
const GROUP_CHARACTER = 1 << 1;
/** Reject capsules contained inside crate shells without filling their visible slat gaps. */
const GROUP_INTERIOR = 1 << 2;
/** A knocked prop tumbling as a rigid body (server only): meets the world and other tumblers. */
const GROUP_DYNPROP = 1 << 4;
const groups = (member: number, filter: number): number =>
  ((member & 0xffff) << 16) | (filter & 0xffff);
/** Static world: collides with characters; queried by bullets. */
const STATIC_GROUPS = groups(GROUP_STATIC, GROUP_CHARACTER | GROUP_STATIC | GROUP_DYNPROP);
/**
 * Character capsules only collide with the static world. Players bump each other through the
 * shared soft push (`sim/playerCollision.ts`), not Rapier contacts: it must be predictable from
 * the positions a client knows, and gentle.
 */
/**
 * Movement stand-ins for small, densely scanned props (see `MOVE_HULL_MODELS`): only characters
 * collide with them (and capsule overlap tests see them); bullets and rays never do.
 */
const GROUP_MOVE_HULL = 1 << 3;
const MOVE_HULL_GROUPS = groups(GROUP_MOVE_HULL, GROUP_CHARACTER | GROUP_DYNPROP);
/** A prop scan that has a movement hull: bullets/rays only, characters sweep against the hull. */
const SCAN_ONLY_GROUPS = groups(GROUP_STATIC, GROUP_STATIC);
const CHARACTER_GROUPS = groups(GROUP_CHARACTER, GROUP_STATIC | GROUP_MOVE_HULL);
/**
 * Tumbling props land on the static world and the dense props' hulls (not their scans), and
 * knock into each other. No query sees them: until a prop settles (and is static again) players,
 * bullets and trucks pass it.
 */
const DYNPROP_GROUPS = groups(GROUP_DYNPROP, GROUP_STATIC | GROUP_MOVE_HULL | GROUP_DYNPROP);
/** Queries that should only see static geometry. */
const QUERY_STATIC = groups(0xffff, GROUP_STATIC);
/** What characters stand on (static world + movement hulls): the jetpack's ground probe. */
const QUERY_GROUND = groups(GROUP_CHARACTER, GROUP_STATIC | GROUP_MOVE_HULL);
const QUERY_OVERLAP = groups(GROUP_CHARACTER, GROUP_STATIC | GROUP_INTERIOR | GROUP_MOVE_HULL);
/**
 * Vehicle bodies sweep what characters sweep: the static world and the dense props' movement
 * hulls; the dense scans behind those hulls are skipped by `isMoveScan` (see `vehicleQuery`).
 */
const QUERY_VEHICLE = groups(GROUP_CHARACTER, GROUP_STATIC | GROUP_MOVE_HULL);
/** Point containment as before movement hulls existed (lightmap bakes). */
const QUERY_POINT = groups(0xffff, GROUP_STATIC | GROUP_INTERIOR);
/** Character capsules only (a settling prop must not close round a player). */
const QUERY_CHARACTER = groups(0xffff, GROUP_CHARACTER);

/**
 * Props whose character collision is the scan's convex hull instead of its triangles. Rapier's
 * character controller builds a contact for every triangle inside the capsule's box on each
 * iteration: against these small, dense scans (a 1000-triangle bin fits in 0.6 × 1 m) one
 * sweep costs 0.3–2.6 ms and a step into one stalled frames for 80–180 ms (a hull: ~0.03 ms).
 * Their hulls are their visible volume to within a few cm (closed boxes, drums, bins, bags, a
 * lying tyre, the convex jersey profile), and nobody fits in a bin opening or a tyre hole. Bullets
 * still hit the exact scan. Lamps (a hull would wall in the arm) and cars (long, sparse: cheap)
 * keep their triangles.
 */
export const MOVE_HULL_MODELS: ReadonlySet<PropModelId> = new Set<PropModelId>([
  'crate',
  'crate_small',
  'cardboard_box',
  'jersey',
  'drum',
  'bin',
  'trashbag',
  'tyre',
  'utility_box',
]);

const capsuleHalf = (height: number): number => height / 2 - PLAYER.radius;
const WRECK_HERO_IDS: ReadonlySet<WreckHeroId> = new Set<WreckHeroId>([
  'heli_wreck',
  'armoured_wreck',
  'tank_wreck',
]);
const isWreckHeroId = (id: HeroId): id is WreckHeroId => WRECK_HERO_IDS.has(id as WreckHeroId);

/** Where a prop is: standing (static colliders), tumbling (server rigid body), or gone. */
export type PropState = 'static' | 'moving' | 'gone';

/** A prop's pose on the wire and in events: bottom centre and rotation (rounded). */
export interface PropPose {
  pos: Vec3;
  quat: Quat;
}

interface PropRecord {
  readonly home: PropInstance;
  /** Current pose (the home pose until it moves). */
  inst: PropInstance;
  state: PropState;
  colliders: RAPIER.Collider[];
  body: RAPIER.RigidBody | null;
  /** Time tumbling, and time spent at rest (s). */
  age: number;
  still: number;
}

/** A settling body below these speeds for `PROP_REST_TIME` is at rest (m/s, rad/s, s). */
const PROP_REST_SPEED = 0.06;
const PROP_REST_SPIN = 0.15;
const PROP_REST_TIME = 0.25;
/** A prop kept from settling by someone standing in it is removed after this much longer (s). */
const PROP_OCCUPIED_GRACE = 3;
/** Fell out of the world (m). */
const PROP_FLOOR = -20;
/** Hits this close to the nearest count as tied (a box cast: share of the sweep; a ray: m). */
const BOX_TIE = 1e-3;
const RAY_TIE = 1e-4;
const round = (v: number, step: number): number => Math.round(v / step) * step;

/** A settled pose rounded for the wire; both sides place exactly these numbers. */
export function roundPropPose(pos: Vec3, quat: Quat): PropPose {
  const l = Math.hypot(quat.x, quat.y, quat.z, quat.w) || 1;
  const s = quat.w < 0 ? -1 / l : 1 / l; // one sign: q and -q are the same rotation
  return {
    pos: { x: round(pos.x, 1e-3), y: round(pos.y, 1e-3), z: round(pos.z, 1e-3) },
    quat: {
      x: round(quat.x * s, 1e-4),
      y: round(quat.y * s, 1e-4),
      z: round(quat.z * s, 1e-4),
      w: round(quat.w * s, 1e-4),
    },
  };
}

/** A pose as [x, y, z, qx, qy, qz, qw] (events and snapshots). */
export const propPoseToWire = (p: PropPose): number[] => [
  p.pos.x,
  p.pos.y,
  p.pos.z,
  p.quat.x,
  p.quat.y,
  p.quat.z,
  p.quat.w,
];

/** Decode a wire pose (null if malformed: untrusted data). */
export function propPoseFromWire(a: readonly number[] | undefined, at = 0): PropPose | null {
  const raw: unknown = a;
  if (!a || !Array.isArray(raw) || a.length < at + 7) return null;
  for (let i = at; i < at + 7; i++) if (!Number.isFinite(a[i])) return null;
  return {
    pos: { x: a[at]!, y: a[at + 1]!, z: a[at + 2]! },
    quat: { x: a[at + 3]!, y: a[at + 4]!, z: a[at + 5]!, w: a[at + 6]! },
  };
}

/** The props of a map in canonical order (their ids): its tagged boxes, then its decor. */
export function mapPropInstances(map: MapDefinition): PropInstance[] {
  return [
    ...map.boxes
      .filter((b) => b.model && b.visible !== false && b.collide !== false)
      .flatMap((b) => fitBox(b, PROP_SIZES)),
    ...(map.decor ?? []).flatMap((d) => fitDecor(d, PROP_SIZES)),
  ];
}

/** World bounding box of an instance. */
function instanceBounds(inst: PropInstance): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of instanceCorners(inst, PROP_SIZES[inst.model])) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  return { min, max };
}

/** Trunk height (collider = rendered trunk, so bullets stop where you see bark). */
export const treeTrunkHeight = (t: { height: number; kind: 'broadleaf' | 'conifer' }): number =>
  t.height * (t.kind === 'conifer' ? 0.35 : 0.55);

/** Static map collision + scene queries, shared by client and server. */
export class PhysicsWorld implements WorldRaycaster, VehicleWorld {
  readonly world: RAPIER.World;
  /** Colliders with no rendered geometry (bounds, stair ramps): no decals or sparks on these. */
  private readonly hidden = new Set<number>();
  /** Collider → what it is made of (impact sounds/effects only). */
  private readonly surfaces = new Map<number, SurfaceKind>();
  /** Dense prop scans that have a movement hull (vehicles sweep the hull, never the scan). */
  private readonly moveScans = new Set<number>();
  private readonly notMoveScan = (c: RAPIER.Collider): boolean => !this.moveScans.has(c.handle);
  /** Prop colliders (scan and hull) → prop id. */
  private readonly propOf = new Map<number, number>();
  private readonly propList: PropRecord[] = [];
  /** Props tumbling now (server). */
  private readonly moving = new Set<number>();
  /** Colliders were added since the last step: queries see them only after one. */
  private stale = false;
  /** Prisms Rapier could not hull (degenerate slivers). */
  skippedHulls = 0;

  constructor(map: MapDefinition) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    for (const b of map.boxes) {
      if (!b.hero || !isWreckHeroId(b.hero)) continue;
      const mesh = wreckRayMesh(b.hero);
      if (!mesh) continue;
      const q = quatFromEulerDeg(b.rot);
      const positions = placeRayMesh(mesh, b.center, (v) => rotateByQuat(v, q));
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(
          positions,
          mesh.indices,
          RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
        ).setCollisionGroups(SCAN_ONLY_GROUPS),
      );
      this.moveScans.add(collider.handle);
      this.surfaces.set(collider.handle, surfaceOfMaterial(b.mat));
    }
    for (const b of map.boxes) {
      if (b.collide === false || (b.model && b.visible !== false)) continue;
      const wreckMesh = b.heroPart && isWreckHeroId(b.heroPart) ? wreckRayMesh(b.heroPart) : null;
      const desc = RAPIER.ColliderDesc.cuboid(b.size.x / 2, b.size.y / 2, b.size.z / 2)
        .setTranslation(b.center.x, b.center.y, b.center.z)
        .setRotation(quatFromEulerDeg(b.rot))
        .setCollisionGroups(wreckMesh ? MOVE_HULL_GROUPS : STATIC_GROUPS);
      const collider = this.world.createCollider(desc);
      if (b.visible === false) this.hidden.add(collider.handle);
      this.surfaces.set(collider.handle, surfaceOfMaterial(b.mat));
    }
    // Static props use the same reduced surface as rendering: no invisible walls across a
    // barrier's taper, a bin opening or a tyre hole. Welded edges avoid internal seam contacts.
    for (const inst of mapPropInstances(map)) {
      this.propList.push({
        home: inst,
        inst,
        state: 'static',
        colliders: [],
        body: null,
        age: 0,
        still: 0,
      });
      this.buildProp(this.propList.length - 1);
    }
    // Prisms are convex by construction (see maps/geom): solid convex-hull colliders.
    for (const p of map.prisms ?? []) {
      if (p.collide === false || p.backdrop) continue;
      const verts = new Float32Array(p.pts.length * 6);
      p.pts.forEach(([x, z], i) => {
        verts.set([x, p.y0, z, x, p.y1, z], i * 6);
      });
      const desc = RAPIER.ColliderDesc.convexHull(verts);
      if (!desc) continue; // degenerate sliver
      try {
        const collider = this.world.createCollider(desc.setCollisionGroups(STATIC_GROUPS));
        if (p.visible === false) this.hidden.add(collider.handle);
        this.surfaces.set(collider.handle, surfaceOfMaterial(p.mat));
      } catch {
        // Rapier can't hull a near-flat sliver; tests assert this never happens on real maps.
        this.skippedHulls++;
      }
    }
    // Tree trunks collide; crowns only conceal (no collider).
    for (const t of map.trees ?? []) {
      const h = treeTrunkHeight(t);
      const r = treeTrunkRadiusOf(t); // the drawn trunk (maps/trees.ts)
      const trunk = this.world.createCollider(
        RAPIER.ColliderDesc.cylinder(h / 2, r)
          .setTranslation(t.x, (t.y ?? 0) + h / 2, t.z)
          .setCollisionGroups(STATIC_GROUPS),
      );
      this.surfaces.set(trunk.handle, 'wood');
    }
    // One step builds the broad-phase so scene queries see every collider.
    this.world.step();
    this.stale = false;
    this.world.gravity = { x: 0, y: -VEHICLE_IMPACT.gravity, z: 0 };
  }

  /** A prop's static colliders at its current pose: the scan, its movement hull, a crate core. */
  private buildProp(id: number): void {
    const rec = this.propList[id]!;
    const inst = rec.inst;
    const { positions, indices } = propSurface(inst);
    const hull = MOVE_HULL_MODELS.has(inst.model)
      ? RAPIER.ColliderDesc.convexHull(positions)
      : null;
    const propCollider = this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(
        positions,
        indices,
        RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
      ).setCollisionGroups(hull ? SCAN_ONLY_GROUPS : STATIC_GROUPS),
    );
    rec.colliders.push(propCollider);
    this.surfaces.set(propCollider.handle, surfaceOfModel(inst.model));
    this.propOf.set(propCollider.handle, id);
    if (hull) {
      const h = this.world.createCollider(hull.setCollisionGroups(MOVE_HULL_GROUPS));
      rec.colliders.push(h);
      this.propOf.set(h.handle, id);
      this.moveScans.add(propCollider.handle);
    }
    const core = propInterior(inst);
    if (core)
      rec.colliders.push(
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(core.size.x / 2, core.size.y / 2, core.size.z / 2)
            .setTranslation(core.center.x, core.center.y, core.center.z)
            .setRotation(core.quat)
            .setSensor(true)
            .setCollisionGroups(groups(GROUP_INTERIOR, 0xffff)),
        ),
      );
    rec.state = 'static';
    this.stale = true;
  }

  /** Drop a prop's static colliders or its rigid body (idempotent). */
  private clearProp(id: number): void {
    const rec = this.propList[id]!;
    for (const c of rec.colliders) {
      this.surfaces.delete(c.handle);
      this.propOf.delete(c.handle);
      this.moveScans.delete(c.handle);
      this.world.removeCollider(c, false);
    }
    rec.colliders = [];
    if (rec.body) this.world.removeRigidBody(rec.body);
    rec.body = null;
    this.moving.delete(id);
  }

  /** How many props the map has (ids 0 … n-1, `mapPropInstances` order). */
  get propCount(): number {
    return this.propList.length;
  }

  /** A prop's current pose (its last static one while it tumbles), or undefined for a bad id. */
  prop(id: number): PropInstance | undefined {
    return this.propList[id]?.inst;
  }

  propState(id: number): PropState | undefined {
    return this.propList[id]?.state;
  }

  /** A prop's world bounding box at its current (last static) pose. */
  propBounds(id: number): { min: Vec3; max: Vec3 } | undefined {
    const rec = this.propList[id];
    return rec && instanceBounds(rec.inst);
  }

  /** Not standing where the map put it (moved, tumbling or gone). */
  propChanged(id: number): boolean {
    const rec = this.propList[id];
    return !!rec && (rec.state !== 'static' || rec.inst !== rec.home);
  }

  /** Smashed (or fell out of the world): no colliders for the rest of the match. */
  removeProp(id: number): boolean {
    const rec = this.propList[id];
    if (!rec || rec.state === 'gone') return false;
    this.clearProp(id);
    rec.state = 'gone';
    return true;
  }

  /** Stand a prop at a pose (settled, or told by the server): static colliders there. */
  placeProp(id: number, pose: PropPose): void {
    const rec = this.propList[id];
    if (!rec) return;
    this.clearProp(id);
    rec.inst = { ...rec.inst, pos: { ...pose.pos }, quat: { ...pose.quat } };
    this.buildProp(id);
  }

  /** Every prop back where the map put it. Returns the ids that changed. */
  resetProps(): number[] {
    const out: number[] = [];
    this.propList.forEach((rec, id) => {
      if (rec.state === 'static' && rec.inst === rec.home) return;
      this.clearProp(id);
      rec.inst = rec.home;
      this.buildProp(id);
      out.push(id);
    });
    this.refreshQueries();
    return out;
  }

  /**
   * Knock a standing prop over (server): its static colliders go and a rigid body of `mass`
   * takes over with velocity `vel`, plus impulse `j` at world point `at` (an off-centre hit
   * spins it). Returns false if the prop isn't standing.
   */
  knockProp(id: number, mass: number, vel: Vec3, impulse?: { at: Vec3; j: Vec3 }): boolean {
    const rec = this.propList[id];
    if (!rec || rec.state !== 'static') return false;
    this.clearProp(id);
    const inst = rec.inst;
    const g = PROP_GEOMETRY[inst.model];
    const local = new Float32Array(g.positions.length * 3);
    g.positions.forEach((p, i) => {
      local.set([p[0]! * inst.scale.x, p[1]! * inst.scale.y, p[2]! * inst.scale.z], i * 3);
    });
    const shape = RAPIER.ColliderDesc.convexHull(local);
    if (!shape) {
      rec.state = 'gone';
      return true;
    }
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(inst.pos.x, inst.pos.y, inst.pos.z)
        .setRotation(inst.quat)
        .setLinvel(vel.x, vel.y, vel.z)
        .setLinearDamping(0.15)
        .setAngularDamping(0.6)
        .setCcdEnabled(true),
    );
    this.world.createCollider(
      shape.setMass(mass).setFriction(0.8).setRestitution(0.15).setCollisionGroups(DYNPROP_GROUPS),
      body,
    );
    if (impulse) body.applyImpulseAtPoint(impulse.j, impulse.at, true);
    rec.body = body;
    rec.state = 'moving';
    rec.age = 0;
    rec.still = 0;
    this.moving.add(id);
    return true;
  }

  /** Standing props resting on top of prop `id` (they fall when it goes). */
  propsOnTop(id: number): number[] {
    const rec = this.propList[id];
    if (!rec) return [];
    const a = instanceBounds(rec.inst);
    const out: number[] = [];
    this.propList.forEach((o, j) => {
      if (j === id || o.state !== 'static') return;
      // Cheap reject first: nowhere near in plan.
      if (
        Math.abs(o.inst.pos.x - rec.inst.pos.x) > 4 ||
        Math.abs(o.inst.pos.z - rec.inst.pos.z) > 4
      )
        return;
      const b = instanceBounds(o.inst);
      if (b.min.y < a.max.y - 0.12 || b.min.y > a.max.y + 0.08) return;
      if (b.min.x > a.max.x - 0.05 || b.max.x < a.min.x + 0.05) return;
      if (b.min.z > a.max.z - 0.05 || b.max.z < a.min.z + 0.05) return;
      out.push(j);
    });
    return out;
  }

  /** The tumbling props' poses now (server, for snapshots). */
  movingProps(): { id: number; pose: PropPose }[] {
    const out: { id: number; pose: PropPose }[] = [];
    for (const id of this.moving) {
      const b = this.propList[id]!.body!;
      out.push({ id, pose: { pos: b.translation(), quat: b.rotation() } });
    }
    return out;
  }

  /**
   * Advance the tumbling props by `dt` (server, once per tick). Props that came to rest in the
   * last step (or tumbled past `VEHICLE_IMPACT.maxTumble`) settle first: static again at their
   * rounded pose, and out of the world: gone. Then one step, which also brings scene queries up
   * to date: everything placed is seen by the very next query (the clients place it on the
   * event, before their next step too).
   */
  stepProps(
    dt: number,
    vehicleBlockers: readonly VehicleObstacle[] = [],
  ): { settled: { id: number; pose: PropPose }[]; lost: number[] } {
    const settled: { id: number; pose: PropPose }[] = [];
    const lost: number[] = [];
    for (const id of [...this.moving]) {
      const rec = this.propList[id]!;
      const b = rec.body!;
      const t = b.translation();
      if (t.y < PROP_FLOOR) {
        this.removeProp(id);
        lost.push(id);
      } else if (
        rec.age > 0 &&
        (b.isSleeping() || rec.still >= PROP_REST_TIME || rec.age >= VEHICLE_IMPACT.maxTumble)
      ) {
        const pose = roundPropPose(t, b.rotation());
        if (this.holdsCharacter(b, pose) || this.holdsVehicle(b, pose, vehicleBlockers)) {
          // Someone stands or drives in it (tumblers pass through them): solid only once they are
          // out, or gone if they stay (never a prop closing round a player or truck).
          if (rec.age >= VEHICLE_IMPACT.maxTumble + PROP_OCCUPIED_GRACE) {
            this.removeProp(id);
            lost.push(id);
          }
          continue;
        }
        this.placeProp(id, pose);
        settled.push({ id, pose });
      }
    }
    if (!this.moving.size) {
      this.refreshQueries();
      return { settled, lost };
    }
    this.world.timestep = dt;
    this.world.step();
    this.stale = false;
    for (const id of this.moving) {
      const rec = this.propList[id]!;
      const b = rec.body!;
      rec.age += dt;
      const v = b.linvel();
      const w = b.angvel();
      const resting =
        Math.hypot(v.x, v.y, v.z) < PROP_REST_SPEED && Math.hypot(w.x, w.y, w.z) < PROP_REST_SPIN;
      rec.still = resting ? rec.still + dt : 0;
    }
    return { settled, lost };
  }

  /** Does a character capsule overlap this body's shape at `pose`? */
  private holdsCharacter(b: RAPIER.RigidBody, pose: PropPose): boolean {
    const shape = b.collider(0).shape;
    return (
      this.world.intersectionWithShape(pose.pos, pose.quat, shape, undefined, QUERY_CHARACTER) !==
      null
    );
  }

  /** Does a vehicle hull overlap this body's shape at `pose`? */
  private holdsVehicle(
    b: RAPIER.RigidBody,
    pose: PropPose,
    vehicles: readonly VehicleObstacle[],
  ): boolean {
    if (!vehicles.length) return false;
    const shape = b.collider(0).shape;
    for (const v of vehicles) {
      const h = Math.max(0.01, (v.top - v.y) / 2);
      const q = { x: 0, y: Math.sin(v.yaw / 2), z: 0, w: Math.cos(v.yaw / 2) };
      if (
        shape.intersectsShape(
          pose.pos,
          pose.quat,
          new RAPIER.Cuboid(v.hx, h, v.hz),
          { x: v.x, y: v.y + h, z: v.z },
          q,
        )
      )
        return true;
    }
    return false;
  }

  /** Make scene queries see colliders added since the last step (none tumbling: nothing moves). */
  refreshQueries(): void {
    if (!this.stale || this.moving.size) return;
    this.world.step();
    this.stale = false;
  }

  /**
   * The first hit of `cast`, independent of the broad phase's tree: hits within `eps` of the
   * nearest (coplanar faces of a carton grid, a crate on a crate) are put in a fixed order — map
   * geometry (never rebuilt: same handles on every side) before props, props by their canonical
   * id — so the server and every client pick the same one whatever order their props were
   * removed and placed in. Returns that hit and the nearest time of impact.
   */
  private resolveTies<H extends { collider: RAPIER.Collider }>(
    cast: (filter?: (c: RAPIER.Collider) => boolean) => H | null,
    toiOf: (h: H) => number,
    base: ((c: RAPIER.Collider) => boolean) | undefined,
    eps: number,
  ): { hit: H; toi: number } | null {
    const first = cast(base);
    if (!first) return null;
    const t0 = toiOf(first);
    let best = first;
    const seen = new Set<number>([first.collider.handle]);
    for (let i = 0; i < 6; i++) {
      const h = cast((c) => !seen.has(c.handle) && (!base || base(c)));
      if (!h || toiOf(h) > t0 + eps) break;
      seen.add(h.collider.handle);
      if (this.tieKey(h.collider) < this.tieKey(best.collider)) best = h;
    }
    return { hit: best, toi: t0 };
  }

  /** Order of tied hits: map geometry by handle first, then props by id. */
  private tieKey(c: RAPIER.Collider): number {
    const prop = this.propOf.get(c.handle);
    return prop === undefined ? -1e12 + c.handle : prop;
  }

  /** `base`, and leave out the props `skip` names (a truck breaking through them). */
  private skipping(
    skip: ((prop: number) => boolean) | undefined,
    base?: (c: RAPIER.Collider) => boolean,
  ): ((c: RAPIER.Collider) => boolean) | undefined {
    if (!skip) return base;
    return (c) => {
      if (base && !base(c)) return false;
      const id = this.propOf.get(c.handle);
      return id === undefined || !skip(id);
    };
  }

  castRay(
    origin: Vec3,
    dir: Vec3,
    maxDistance: number,
    skip?: (prop: number) => boolean,
  ): WorldHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const cast = (filter?: (c: RAPIER.Collider) => boolean) =>
      this.world.castRayAndGetNormal(
        ray,
        maxDistance,
        true,
        undefined,
        QUERY_STATIC,
        undefined,
        undefined,
        filter,
      );
    // Vehicle queries (they pass `skip`) resolve ties by prop id: the same answer on both sides.
    const tied = skip
      ? this.resolveTies(cast, (h) => h.timeOfImpact, this.skipping(skip), RAY_TIE)
      : null;
    const hit = tied?.hit ?? cast(this.skipping(skip));
    if (!hit) return null;
    const d = tied?.toi ?? hit.timeOfImpact;
    const prop = this.propOf.get(hit.collider.handle);
    return {
      distance: d,
      point: { x: origin.x + dir.x * d, y: origin.y + dir.y * d, z: origin.z + dir.z * d },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      visible: !this.hidden.has(hit.collider.handle),
      surface: this.surfaces.get(hit.collider.handle),
      ...(prop !== undefined ? { prop } : {}),
    };
  }

  /** Presentation occlusion/support against rendered solids; gameplay queries retain their helpers. */
  castVisibleRay(origin: Vec3, dir: Vec3, maxDistance: number): WorldHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      QUERY_STATIC,
      undefined,
      undefined,
      (collider) => !this.hidden.has(collider.handle),
    );
    if (!hit) return null;
    const d = hit.timeOfImpact;
    const prop = this.propOf.get(hit.collider.handle);
    return {
      distance: d,
      point: { x: origin.x + dir.x * d, y: origin.y + dir.y * d, z: origin.z + dir.z * d },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      visible: true,
      surface: this.surfaces.get(hit.collider.handle),
      ...(prop !== undefined ? { prop } : {}),
    };
  }

  /** Sweep an oriented box against static geometry (vehicle bodies; `VehicleWorld`). */
  castBox(
    center: Vec3,
    rot: Quat,
    half: Vec3,
    disp: Vec3,
    skip?: (prop: number) => boolean,
  ): { toi: number; normal: Vec3; point: Vec3; prop?: number } | null {
    const shape = new RAPIER.Cuboid(half.x, half.y, half.z);
    const cast = (filter?: (c: RAPIER.Collider) => boolean) =>
      this.world.castShape(
        center,
        rot,
        disp,
        shape,
        0.01,
        1,
        false,
        undefined,
        QUERY_VEHICLE,
        undefined,
        undefined,
        filter,
      );
    const tied = this.resolveTies(
      cast,
      (h) => h.time_of_impact,
      this.skipping(skip, this.notMoveScan),
      BOX_TIE,
    );
    if (!tied) return null;
    const hit = tied.hit;
    const n = hit.normal1;
    const w = hit.witness1;
    const prop = this.propOf.get(hit.collider.handle);
    return {
      toi: tied.toi,
      normal: { x: n.x, y: n.y, z: n.z },
      point: { x: w.x, y: w.y, z: w.z },
      ...(prop !== undefined ? { prop } : {}),
    };
  }

  /** True if an oriented box overlaps static geometry (vehicle bodies; `VehicleWorld`). */
  boxOverlaps(center: Vec3, rot: Quat, half: Vec3, skip?: (prop: number) => boolean): boolean {
    return (
      this.world.intersectionWithShape(
        center,
        rot,
        new RAPIER.Cuboid(half.x, half.y, half.z),
        undefined,
        QUERY_VEHICLE,
        undefined,
        undefined,
        this.skipping(skip, this.notMoveScan),
      ) !== null
    );
  }

  /**
   * A ray against what characters stand on: the static world and the props' movement hulls
   * (the jetpack's ground probe — its ceiling sits above the hull you would land on).
   */
  castGroundRay(origin: Vec3, dir: Vec3, maxDistance: number): WorldHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, true, undefined, QUERY_GROUND);
    if (!hit) return null;
    const d = hit.timeOfImpact;
    return {
      distance: d,
      point: { x: origin.x + dir.x * d, y: origin.y + dir.y * d, z: origin.z + dir.z * d },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      visible: !this.hidden.has(hit.collider.handle),
      surface: this.surfaces.get(hit.collider.handle),
    };
  }

  /** True if a character capsule with feet at `feet` overlaps static geometry. */
  overlapsStatic(feet: Vec3, height: number, shrink = 0.01): boolean {
    const shape = new RAPIER.Capsule(capsuleHalf(height), PLAYER.radius - shrink);
    let hit = false;
    this.world.intersectionsWithShape(
      { x: feet.x, y: feet.y + height / 2, z: feet.z },
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      () => {
        hit = true;
        return false; // stop at first
      },
      undefined,
      QUERY_OVERLAP,
    );
    return hit;
  }

  /** True if `p` is inside a static collider or a crate interior (movement hulls excluded). */
  containsPoint(p: Vec3): boolean {
    let inside = false;
    this.world.intersectionsWithPoint(
      p,
      () => {
        inside = true;
        return false; // stop at the first
      },
      undefined,
      QUERY_POINT,
    );
    return inside;
  }

  createCharacter(feet: Vec3): RapierCharacter {
    return new RapierCharacter(this, feet);
  }

  free(): void {
    this.world.free();
  }
}

/** Rapier kinematic character controller behind the sim's `CharacterBody` interface. */
export class RapierCharacter implements CharacterBody {
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly collider: RAPIER.Collider;
  private feet: Vec3;
  private height = PLAYER.standHeight;
  /** Ledge/vault probes run against the same static world. */
  get world(): PhysicsWorld {
    return this.physics;
  }
  /** A vehicle this player drives sweeps the same static world. */
  get vehicleWorld(): PhysicsWorld {
    return this.physics;
  }

  constructor(
    private readonly physics: PhysicsWorld,
    feet: Vec3,
  ) {
    const world = physics.world;
    this.feet = { ...feet };
    this.controller = world.createCharacterController(CHARACTER.skin);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    // Rapier's autostep silently fails below ~0.04 m/step (crouch-walking, first contact with a
    // step face), so stepping is done explicitly in `tryStepUp` instead.
    this.controller.disableAutostep();
    this.controller.setMaxSlopeClimbAngle((CHARACTER.maxSlopeClimbDeg * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((CHARACTER.minSlopeSlideDeg * Math.PI) / 180);
    this.controller.setSlideEnabled(true);
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(capsuleHalf(this.height), PLAYER.radius)
        .setTranslation(feet.x, feet.y + this.height / 2, feet.z)
        .setCollisionGroups(CHARACTER_GROUPS),
    );
  }

  get position(): Vec3 {
    return { ...this.feet };
  }

  /** Current capsule height (stand, crouch or prone). */
  get capsuleHeight(): number {
    return this.height;
  }

  setPosition(feet: Vec3): void {
    this.feet = { ...feet };
    this.collider.setTranslation({ x: feet.x, y: feet.y + this.height / 2, z: feet.z });
  }

  /** Collide-and-slide `delta` from `from` without committing. */
  private sweep(from: Vec3, delta: Vec3, snap: boolean): { to: Vec3; grounded: boolean } {
    this.collider.setTranslation({ x: from.x, y: from.y + this.height / 2, z: from.z });
    if (snap) this.controller.enableSnapToGround(CHARACTER.snapToGround);
    else this.controller.disableSnapToGround();
    this.controller.computeColliderMovement(this.collider, delta, undefined, CHARACTER_GROUPS);
    const m = this.controller.computedMovement();
    return {
      to: { x: from.x + m.x, y: from.y + m.y, z: from.z + m.z },
      grounded: this.controller.computedGrounded(),
    };
  }

  /**
   * Step over a ledge up to `CHARACTER.stepHeight`: sweep up, forward (at least
   * `stepMinWidth` so the capsule clears the edge), then down. Accept only if we land on walkable
   * ground and actually rose.
   */
  private tryStepUp(
    start: Vec3,
    delta: Vec3,
    maxStep = CHARACTER.stepHeight,
  ): { to: Vec3; grounded: boolean } | null {
    const dh = Math.hypot(delta.x, delta.z);
    if (dh < 1e-5) return null;
    const up = this.sweep(start, { x: 0, y: maxStep, z: 0 }, false);
    const climbed = up.to.y - start.y;
    if (climbed < 0.05) return null;
    const dist = Math.max(dh, CHARACTER.stepMinWidth);
    const fwd = this.sweep(
      up.to,
      { x: (delta.x / dh) * dist, y: 0, z: (delta.z / dh) * dist },
      false,
    );
    if (Math.hypot(fwd.to.x - up.to.x, fwd.to.z - up.to.z) < dist * 0.5) return null;
    const down = this.sweep(fwd.to, { x: 0, y: -(climbed + 0.05), z: 0 }, false);
    const rise = down.to.y - start.y;
    if (!down.grounded || rise < 0.02 || rise > maxStep + 0.01) return null;
    return down;
  }

  private grounded = false;

  /**
   * Restore ground contact after a teleport or a network correction (M3 reconciliation), so the
   * next move snaps / steps up exactly as it did where that state was computed.
   */
  setGrounded(grounded: boolean): void {
    this.grounded = grounded;
  }

  /**
   * Safety net for the controller's one known leak: snapping the round capsule bottom onto an
   * exact box edge (sliding precisely along it) can sink it a few cm into the corner. If a move
   * ends inside static geometry, lift the capsule out (≤ 12 cm, i.e. onto the edge it was riding);
   * if that isn't clear either, cancel the move. Invariant: the capsule never rests in geometry.
   */
  private depenetrate(
    start: Vec3,
    r: { to: Vec3; grounded: boolean },
  ): { to: Vec3; grounded: boolean } {
    const inside = (p: Vec3): boolean => this.physics.overlapsStatic(p, this.height, 0.02);
    if (!inside(r.to)) return r;
    for (let lift = 0.02; lift <= 0.121; lift += 0.02) {
      const up = { x: r.to.x, y: r.to.y + lift, z: r.to.z };
      if (!inside(up)) return { to: up, grounded: r.grounded };
    }
    return { to: start, grounded: this.grounded };
  }

  /**
   * Two passes: horizontal collide-and-slide, then vertical (gravity / snap). A single combined
   * sweep lets Rapier occasionally register a toi≈0 contact with the floor it is resting on and
   * drop that step's horizontal motion: a one-frame hitch on flat ground.
   */
  move(delta: Vec3, maxStep?: number): MoveResult {
    const start = { ...this.feet };
    const desiredH = Math.hypot(delta.x, delta.z);
    let result: { to: Vec3; grounded: boolean } | null = null;
    let afterH = start;
    if (desiredH > 1e-6) {
      afterH = this.sweep(start, { x: delta.x, y: 0, z: delta.z }, false).to;
      const movedH = Math.hypot(afterH.x - start.x, afterH.z - start.z);
      if (this.grounded && delta.y <= 0 && movedH < desiredH - 1e-4) {
        result = this.tryStepUp(start, delta, maxStep);
      }
    }
    result ??= this.sweep(afterH, { x: 0, y: delta.y, z: 0 }, this.grounded && delta.y <= 0);
    result = this.depenetrate(start, result);
    this.grounded = result.grounded;
    this.setPosition(result.to);
    return {
      moved: { x: result.to.x - start.x, y: result.to.y - start.y, z: result.to.z - start.z },
      grounded: result.grounded,
    };
  }

  /**
   * A player-collision push: horizontal collide-and-slide only (no step-up, no ground snap), with
   * the same depenetration safety net, and ground contact left as the last `move` found it (the
   * next move snaps or falls from there, exactly as on the other side of the network).
   */
  nudge(delta: Vec3): Vec3 {
    const start = this.feet;
    const r = this.depenetrate(start, this.sweep(start, { x: delta.x, y: 0, z: delta.z }, false));
    this.setPosition(r.to);
    return { x: r.to.x - start.x, y: r.to.y - start.y, z: r.to.z - start.z };
  }

  setProne(prone: boolean): boolean {
    const target = prone ? PLAYER.proneHeight : PLAYER.standHeight;
    if (target === this.height) return true;
    if (target > this.height && this.physics.overlapsStatic(this.feet, target, 0.02)) return false;
    this.height = target;
    this.collider.setHalfHeight(capsuleHalf(target));
    this.setPosition(this.feet);
    return true;
  }

  setCrouched(crouched: boolean): boolean {
    const target = crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
    if (target === this.height) return true;
    // Growing (standing up, or crouching up from prone) needs the headroom first.
    if (target > this.height && this.physics.overlapsStatic(this.feet, target, 0.02)) return false;
    this.height = target;
    this.collider.setHalfHeight(capsuleHalf(target));
    this.setPosition(this.feet); // keep feet planted, recentre capsule
    return true;
  }

  free(): void {
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeCollider(this.collider, false);
  }
}
