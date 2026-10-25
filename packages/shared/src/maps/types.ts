import type { Vec3 } from '../math/vec3.ts';
import type { Pt } from './geom.ts';

/** Greybox material ids; the client maps each to a colour + grid texture. */
export type MaterialId =
  | 'ground'
  | 'asphalt'
  | 'sidewalk'
  | 'concrete'
  | 'plaster'
  | 'wood'
  | 'metal'
  | 'trim'
  | 'accent'
  | 'grass'
  | 'paving'
  | 'facade'
  | 'glass'
  | 'foliage'
  | 'bark'
  | 'paint'
  | 'container'
  /** Glazed subway tile (metro walls, clad pillars). */
  | 'tile'
  /** Polished terrazzo (market hall floor). */
  | 'terrazzo'
  /** Burnt, sooty, rusting sheet metal (the helicopter wreck): presentation only. */
  | 'wreck'
  /** Filled burlap sandbags (cover walls): presentation only. */
  | 'sandbag';

/**
 * What a box *is*, for the renderer: the client draws a tagged box as CC0 models fitted exactly
 * to its footprint and height (render/propFit.ts), and falls back to the greybox if the models
 * don't load. The box remains the placement envelope; shared reduced surfaces supply exact collision.
 */
export type PropModelTag = 'crate' | 'jersey' | 'car' | 'cartons';

/**
 * Procedurally dressed set pieces (client render/setDressing.ts): the box keeps its collision
 * but is drawn as a detailed model filling the same volume, identical on every tier.
 */
export type DressKind = 'stallAwning' | 'lightPanel' | 'pendant';

/**
 * Generated hero models (client render/heroModels.ts; Kiran-approved Higgsfield assets). The
 * tagged box is the model's solid body (collision); the model is drawn over it at 1:1, with thin
 * overhangs (awnings, mirrors) visual only. Identical on every tier.
 */
export type HeroId = BodyHeroId | WreckHeroId;
/** Heroes drawn over one body box (its collision; `HERO_BODY`). */
export type BodyHeroId = 'burnt_car' | 'food_truck' | 'kiosk';
/**
 * Re-baked CC BY wrecks (tools/assets/rebake_model.py): drawn at a zero-size invisible anchor box
 * at the prop's origin (`hero`); their collision boxes are `heroPart`s (drawn only as the fallback).
 */
export type WreckHeroId = 'heli_wreck' | 'armoured_wreck' | 'tank_wreck';

/** Oriented box: the only primitive in greybox maps. Rotation is Euler XYZ in degrees. */
export interface MapBox {
  center: Vec3;
  size: Vec3;
  rot?: Vec3;
  mat: MaterialId;
  /** Collides with players and bullets (default true). */
  collide?: boolean;
  /** Rendered (default true). Invisible collide-only boxes: stair ramps, bounds. */
  visible?: boolean;
  /** Albedo tint (0xRRGGBB): car paint, container colours, awnings. */
  tint?: number;
  /** Drawn as a real model fitted to the box (set by the prop builders). */
  model?: PropModelTag;
  /** Drawn by the set-dressing builder instead of as a box (collision unchanged). */
  dress?: DressKind;
  /** Drawn as this hero model instead of as a box (the box is its body; collision unchanged). */
  hero?: HeroId;
  /**
   * An invisible extra collider of this hero model (the wreck's cabin): the model covers it, so
   * it is drawn only as a box when the model is missing (the fallback), like the body.
   */
  heroPart?: HeroId;
}

/** Small street dressing (maps/decor.ts has each kind's size and colliders). */
export type DecorKind = 'bin' | 'drum' | 'lamp' | 'trashbag' | 'tyres' | 'utilityBox' | 'cardboard';

/**
 * A piece of street dressing standing on the ground. Shared model surfaces supply collision
 * (`propSurface`), so what you see is what blocks you and your bullets. Kept out of `boxes`:
 * it is not part of the lightmap layout, and its colliders are derived from the kind.
 */
export interface MapDecor {
  kind: DecorKind;
  x: number;
  z: number;
  /** Ground height (default 0). */
  y?: number;
  /**
   * Yaw in degrees (local +Z = the side facing away from the wall it stands against).
   */
  rot?: number;
}

export interface SpawnPoint {
  pos: Vec3;
  yaw: number;
}

export interface DummyDef {
  id: string;
  pos: Vec3;
  /** Facing yaw (radians). */
  yaw: number;
  /** Optional ping-pong patrol from `pos` to `to`. */
  path?: { to: Vec3; speed: number };
  crouched?: boolean;
}

/**
 * Vertical extrusion of a *convex* XZ polygon (CCW) between y0 and y1: buildings, slabs, kerbs.
 * Concave footprints are pre-split into convex pieces (see `geom.convexDecompose`), which keeps
 * colliders solid and cheap.
 */
export interface MapPrism {
  pts: Pt[];
  y0: number;
  y1: number;
  /** Wall material. */
  mat: MaterialId;
  /** Top face material (defaults to `mat`). */
  top?: MaterialId;
  /** Albedo tint (0xRRGGBB) — lets hundreds of buildings share one facade material. */
  tint?: number;
  collide?: boolean;
  visible?: boolean;
  /** Outside the playable area (skyline/backdrop): rendered cheaply, never walkable. */
  backdrop?: boolean;
}

/** Flat ground marking (road surface, grass, paving) — visual only, laid just above y. */
export interface MapFlat {
  pts: Pt[];
  y: number;
  mat: MaterialId;
  /** Draw order among overlapping flats (higher on top). */
  layer?: number;
}

/**
 * A tree: trunk collides (players and bullets), the crown only hides — and hides identically at
 * every graphics quality (concealment is never culled by settings).
 */
export interface MapTree {
  x: number;
  z: number;
  y?: number;
  height: number;
  /** Crown radius (m). */
  crown: number;
  kind: 'broadleaf' | 'conifer';
}

/**
 * Soft concealment: bushes and tall grass. No collider — you can walk into them and bullets pass
 * through — but they block sight (players and bots alike: see `concealment.ts`). Rendered the
 * same at every graphics quality so nobody can switch cover off.
 */
export interface MapFoliage {
  x: number;
  z: number;
  y?: number;
  /** Clump radius (m). */
  r: number;
  /** Height (m): bushes ~1.2–2 hide a standing player, tall grass ~1–1.3 a crouched one. */
  h: number;
  kind: 'bush' | 'grass';
}

export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** A pickup point: radar uplink (radar charge) or drone uplink (recon drone charge). */
export type PickupKind = 'radar' | 'drone' | 'medkit';
export interface PickupDef {
  id: string;
  pos: Vec3;
  kind: PickupKind;
}

/** A playable sub-area of a big map (map-size option): its own boundary and spawns. */
export interface MapSection {
  id: string;
  name: string;
  bounds: Bounds;
  /** Extra boundary geometry that closes the cut edge (barriers, wrecks, invisible walls). */
  boxes: MapBox[];
  spawnCount: number;
}

export interface MapDefinition {
  name: string;
  /** Playable XZ bounds (inclusive), used by tests, spawns and the minimap. */
  bounds: Bounds;
  boxes: MapBox[];
  spawns: SpawnPoint[];
  dummies: DummyDef[];
  prisms?: MapPrism[];
  flats?: MapFlat[];
  trees?: MapTree[];
  foliage?: MapFoliage[];
  /** Street dressing with matching colliders (bins, lamps…). */
  decor?: MapDecor[];
  /** Pickup points (radar uplinks). Sections keep the ones inside their bounds. */
  pickups?: PickupDef[];
  /**
   * The skateboard's secret spot (x, z; y = a height inside the space to cast down from onto
   * its floor). Absent: no skateboard on this map.
   */
  skateboard?: Vec3;
  /**
   * Vehicle spawns (the armored trucks): ground point between the axles, heading (forward =
   * (sin yaw, cos yaw)). Spots outside a section's bounds are skipped. Absent: no vehicles.
   */
  vehicles?: { x: number; y?: number; z: number; yaw: number }[];
  /**
   * Truck lanes (axis-aligned rects, x0/z0–x1/z1): the routes kept clear for the trucks. Bot
   * drivers keep to them where they can and roam between points on them.
   */
  truckLanes?: readonly { x0: number; z0: number; x1: number; z1: number }[];
  /**
   * Jetpack spots (Kiran: three per match, one per spot, in three areas; y = a height to cast
   * down from onto the floor). Spots outside a section's bounds are skipped. Absent: none.
   */
  jetpacks?: Vec3[];
  /** Map-size options; absent = one fixed size. */
  sections?: MapSection[];
  /** Build statistics (for tests and the debug overlay). */
  stats?: {
    coverGap: number;
    coverPlaced: number;
    marketGap?: number;
    marketPlaced?: number;
    coverWorst?: { x: number; z: number } | null;
    marketWorst?: { x: number; z: number } | null;
  };
  /** Attribution to show in credits (e.g. OpenStreetMap, ODbL). */
  attribution?: string;
  /** Where the knife sparring partner starts (default: 10 m in front of the player). */
  sparringSpot?: Vec3;
  /** Recommended far plane / fog distance for the renderer (m). */
  viewDistance?: number;
}
