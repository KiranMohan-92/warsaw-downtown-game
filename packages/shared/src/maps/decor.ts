/**
 * Street dressing: bins, oil drums, lamps, trash bags, tyre stacks, utility cabinets,
 * cardboard boxes. Shared reduced surfaces (propModels.ts) drive collision and rendering;
 * these conservative bounding sizes only control placement clearance.
 *
 * Placement is generated, deterministic and conservative: dressing stands flush against the side
 * of an existing solid (a container, kiosk, stall back, wall), never in doors, stairs, uplinks,
 * bushes or another piece's way, and always leaves ≥ `APRON` m of open ground in front of it, so
 * no alley gets narrower than a comfortable passage. Lamps stand in open spots only. Dressing is
 * not part of `MapDefinition.boxes` (the lightmap layout stays as baked).
 */
import type { Vec3 } from '../math/vec3.ts';
import { area, clipConvex, type Poly } from './geom.ts';
import type { Rect } from './solids.ts';
import type {
  Bounds,
  DecorKind,
  MapBox,
  MapDecor,
  MapFoliage,
  MapPrism,
  MapTree,
  MaterialId,
} from './types.ts';

export interface DecorDef {
  /**
   * Bounding size (x = width, y = height, z = depth, +Z = front): the client fits the model to
   * exactly this, so it must match the processed model (a client test checks the glTFs).
   */
  size: Vec3;
  /** Greybox material (fallback rendering if the models don't load). */
  mat: MaterialId;
  tint?: number;
  /** 'wall': flush against a solid's side; 'open': free-standing with space all round. */
  place: 'wall' | 'open';
  /** Relative frequency among wall pieces. */
  weight: number;
}

/** Stack of three tyres lying flat (the tyre model is 0.165 m thick). */
export const TYRE_STACK = 3;
export const TYRE_HEIGHT = 0.165;
/** Two cardboard boxes stacked (the box model is 0.337 m tall). */
export const CARDBOARD_STACK = 2;
export const CARDBOARD_HEIGHT = 0.337;

/** Sizes are the processed models' bounding boxes (tools/assets/build_models.py manifest). */
export const DECOR: Record<DecorKind, DecorDef> = {
  bin: {
    size: { x: 0.639, y: 0.906, z: 0.551 },
    mat: 'metal',
    tint: 0x3a3d3f,
    place: 'wall',
    weight: 3,
  },
  drum: {
    size: { x: 0.619, y: 0.928, z: 0.624 },
    mat: 'paint',
    tint: 0x2f4a6a,
    place: 'wall',
    weight: 2,
  },
  lamp: {
    size: { x: 0.689, y: 3.855, z: 0.386 },
    mat: 'metal',
    tint: 0x2a2c2e,
    place: 'open',
    weight: 0,
  },
  trashbag: {
    size: { x: 0.519, y: 0.568, z: 0.455 },
    mat: 'paint',
    tint: 0x1c1d1f,
    place: 'wall',
    weight: 3,
  },
  tyres: {
    size: { x: 0.589, y: TYRE_HEIGHT * TYRE_STACK, z: 0.566 },
    mat: 'paint',
    tint: 0x222222,
    place: 'wall',
    weight: 3,
  },
  utilityBox: {
    size: { x: 0.516, y: 1.092, z: 0.429 },
    mat: 'metal',
    tint: 0x5b6d7c,
    place: 'wall',
    weight: 1.5,
  },
  cardboard: {
    size: { x: 0.384, y: CARDBOARD_HEIGHT * CARDBOARD_STACK, z: 0.515 },
    mat: 'wood',
    tint: 0xb89a6a,
    place: 'wall',
    weight: 2,
  },
};

export const DECOR_KINDS = Object.keys(DECOR) as DecorKind[];

/** Local (x, z) → world, for a piece at `d` (the same yaw convention as props.ts `place`). */
export function decorToWorld(d: MapDecor, x: number, z: number): { x: number; z: number } {
  const yaw = ((d.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return { x: d.x + x * cos + z * sin, z: d.z - x * sin + z * cos };
}

// ---- placement --------------------------------------------------------------------------------------

/** Open ground (m) kept in front of every wall piece. */
export const APRON = 1.6;
/** Clear radius (m) around a lamp post. */
export const LAMP_CLEARANCE = 1.8;
/** Gap (m) between a piece and the wall it stands against. */
const WALL_GAP = 0.03;
/** Height band (m above the ground) where a solid blocks walking. */
const WALK_BAND: [number, number] = [0.1, 1.9];

export interface DecorInput {
  bounds: Bounds;
  boxes: readonly MapBox[];
  prisms: readonly MapPrism[];
  trees: readonly MapTree[];
  foliage: readonly MapFoliage[];
  /** Doors, stairs, uplinks, patrol lines… (nothing is placed on or in front of these). */
  keepClear: readonly Rect[];
  seed?: number;
  /** Stop after this many pieces (default 90). */
  max?: number;
  /** Chance that one side of a host gets a piece (default 0.18). */
  density?: number;
  /** Lamp grid spacing (m; default 11). */
  lampSpacing?: number;
}

interface Solid {
  poly: Poly;
  y0: number;
  y1: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const hash = (x: number, z: number, salt: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
  return h - Math.floor(h);
};

/** Oriented rectangle (centre, half extents along local x/z, yaw deg) → CCW polygon. */
export function orientedRect(cx: number, cz: number, hx: number, hz: number, yawDeg: number): Poly {
  const yaw = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const pt = (x: number, z: number): [number, number] => [
    cx + x * cos + z * sin,
    cz - x * sin + z * cos,
  ];
  const p = [pt(-hx, -hz), pt(hx, -hz), pt(hx, hz), pt(-hx, hz)];
  // Winding flips with the yaw convention: return it counter-clockwise.
  const s = p.reduce((acc, a, i) => {
    const b = p[(i + 1) % 4]!;
    return acc + a[0] * b[1] - b[0] * a[1];
  }, 0);
  return s < 0 ? p.reverse() : p;
}

function solidOfBox(b: MapBox): Solid | null {
  if (b.collide === false) return null;
  const r = b.rot ?? { x: 0, y: 0, z: 0 };
  let poly: Poly;
  let y0 = b.center.y - b.size.y / 2;
  let y1 = b.center.y + b.size.y / 2;
  if (Math.abs(r.x) < 1e-6 && Math.abs(r.z) < 1e-6) {
    poly = orientedRect(b.center.x, b.center.z, b.size.x / 2, b.size.z / 2, r.y);
  } else {
    // Tilted (wrecks, ramps): conservative bounding box of the 3D corners.
    const e = Math.hypot(b.size.x, b.size.y, b.size.z) / 2;
    poly = orientedRect(b.center.x, b.center.z, e, e, 0);
    y0 = b.center.y - e;
    y1 = b.center.y + e;
  }
  return withBounds(poly, y0, y1);
}

function withBounds(poly: Poly, y0: number, y1: number): Solid {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return { poly, y0, y1, x0, z0, x1, z1 };
}

const CELL = 4;

/** Uniform-grid index of solids for footprint overlap queries. */
class SolidIndex {
  private readonly grid = new Map<string, Solid[]>();

  add(s: Solid): void {
    for (let i = Math.floor(s.x0 / CELL); i <= Math.floor(s.x1 / CELL); i++) {
      for (let j = Math.floor(s.z0 / CELL); j <= Math.floor(s.z1 / CELL); j++) {
        const k = `${i},${j}`;
        const list = this.grid.get(k);
        if (list) list.push(s);
        else this.grid.set(k, [s]);
      }
    }
  }

  /** Does `poly` overlap any solid that spans part of [y0, y1]? */
  blocked(poly: Poly, y0: number, y1: number): boolean {
    const q = withBounds(poly, y0, y1);
    const seen = new Set<Solid>();
    for (let i = Math.floor(q.x0 / CELL); i <= Math.floor(q.x1 / CELL); i++) {
      for (let j = Math.floor(q.z0 / CELL); j <= Math.floor(q.z1 / CELL); j++) {
        for (const s of this.grid.get(`${i},${j}`) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          if (s.y1 <= y0 || s.y0 >= y1) continue;
          if (s.x1 <= q.x0 || s.x0 >= q.x1 || s.z1 <= q.z0 || s.z0 >= q.z1) continue;
          if (area(clipConvex(poly, s.poly)) > 1e-4) return true;
        }
      }
    }
    return false;
  }
}

/** Can box `b` carry a piece of dressing against its sides? */
function isHost(b: MapBox): boolean {
  if (b.collide === false || b.visible === false || b.model || b.mat === 'glass') return false;
  // A wreck model's colliders (heroPart) sit inside its silhouette (wheels, bonnet, rotor overhang
  // it): a piece set against their faces would stand inside the drawn wreck.
  if (b.heroPart) return false;
  const r = b.rot ?? { x: 0, y: 0, z: 0 };
  if (Math.abs(r.x) > 1e-6 || Math.abs(r.z) > 1e-6) return false;
  const bottom = b.center.y - b.size.y / 2;
  return Math.abs(bottom) < 0.05 && b.size.y >= 0.9;
}

const overlapsRect = (poly: Poly, r: Rect): boolean =>
  poly.some(([x, z]) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) ||
  area(clipConvex(poly, [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]])) > 1e-4; // prettier-ignore

/**
 * Deterministic street dressing for `input.bounds` (street level, y = 0): wall pieces against the
 * sides of existing solids, lamps in open spots. See the module comment for the rules.
 */
export function scatterDecor(input: DecorInput): MapDecor[] {
  const seed = input.seed ?? 7;
  const max = input.max ?? 90;
  const density = input.density ?? 0.18;
  const B = input.bounds;
  const margin = 3;
  const solids = new SolidIndex();
  for (const b of input.boxes) {
    const s = solidOfBox(b);
    if (s) solids.add(s);
  }
  for (const p of input.prisms) {
    if (p.collide === false || p.backdrop) continue;
    solids.add(withBounds([...p.pts], p.y0, p.y1));
  }
  for (const t of input.trees) {
    const r = 0.5; // ≥ any trunk radius (maps/trees.ts treeTrunkRadiusOf caps at 0.45)
    solids.add(withBounds(orientedRect(t.x, t.z, r, r, 0), t.y ?? 0, (t.y ?? 0) + t.height));
  }
  const out: MapDecor[] = [];
  const inside = (x: number, z: number): boolean =>
    x > B.minX + margin && x < B.maxX - margin && z > B.minZ + margin && z < B.maxZ - margin;
  const clearOfFoliage = (x: number, z: number, reach: number): boolean =>
    input.foliage.every((f) => Math.hypot(f.x - x, f.z - z) > f.r + reach + 0.2);
  const clearOfDecor = (x: number, z: number, dist: number): boolean =>
    out.every((d) => Math.hypot(d.x - x, d.z - z) > dist);
  const clearOfKeep = (poly: Poly): boolean => !input.keepClear.some((r) => overlapsRect(poly, r));

  /** Validate and add a piece; returns whether it was placed. */
  const tryPlace = (d: MapDecor, apron: Poly | null): boolean => {
    const def = DECOR[d.kind];
    if (!inside(d.x, d.z)) return false;
    const foot = orientedRect(d.x, d.z, def.size.x / 2 + 0.02, def.size.z / 2 + 0.02, d.rot ?? 0);
    const reach = Math.hypot(def.size.x, def.size.z) / 2;
    if (!clearOfFoliage(d.x, d.z, reach) || !clearOfDecor(d.x, d.z, reach + 0.9)) return false;
    if (!clearOfKeep(foot) || (apron && !clearOfKeep(apron))) return false;
    if (solids.blocked(foot, 0.02, def.size.y)) return false;
    if (apron && solids.blocked(apron, WALK_BAND[0], WALK_BAND[1])) return false;
    out.push(d);
    solids.add(withBounds(foot, d.y ?? 0, (d.y ?? 0) + def.size.y));
    return true;
  };

  // Lamps: a jittered grid of open spots with room all round.
  const spacing = input.lampSpacing ?? 11;
  for (let x = B.minX + margin; x < B.maxX - margin && out.length < max; x += spacing) {
    for (let z = B.minZ + margin; z < B.maxZ - margin && out.length < max; z += spacing) {
      const px = x + (hash(x, z, seed + 1) - 0.5) * spacing * 0.5;
      const pz = z + (hash(x, z, seed + 2) - 0.5) * spacing * 0.5;
      const ring = orientedRect(px, pz, LAMP_CLEARANCE, LAMP_CLEARANCE, 45 * hash(px, pz, seed));
      if (solids.blocked(ring, WALK_BAND[0], WALK_BAND[1])) continue;
      tryPlace(
        { kind: 'lamp', x: px, z: pz, rot: Math.round(hash(px, pz, seed + 3) * 4) * 90 },
        ring,
      );
    }
  }

  // Wall pieces against the sides of street-level solids.
  const wallKinds = (Object.keys(DECOR) as DecorKind[]).filter((k) => DECOR[k].place === 'wall');
  const total = wallKinds.reduce((s, k) => s + DECOR[k].weight, 0);
  const pick = (h: number): DecorKind => {
    let acc = 0;
    for (const k of wallKinds) {
      acc += DECOR[k].weight / total;
      if (h < acc) return k;
    }
    return wallKinds[wallKinds.length - 1]!;
  };
  for (const b of input.boxes) {
    if (out.length >= max) break;
    if (!isHost(b)) continue;
    const yaw = b.rot?.y ?? 0;
    const rad = (yaw * Math.PI) / 180;
    const ex = { x: Math.cos(rad), z: -Math.sin(rad) }; // local +X in world
    const ez = { x: Math.sin(rad), z: Math.cos(rad) }; // local +Z in world
    const faces = [
      { n: ex, half: b.size.x / 2, len: b.size.z, t: ez },
      { n: { x: -ex.x, z: -ex.z }, half: b.size.x / 2, len: b.size.z, t: ez },
      { n: ez, half: b.size.z / 2, len: b.size.x, t: ex },
      { n: { x: -ez.x, z: -ez.z }, half: b.size.z / 2, len: b.size.x, t: ex },
    ];
    for (let fi = 0; fi < 4 && out.length < max; fi++) {
      const f = faces[fi]!;
      const cx = b.center.x;
      const cz = b.center.z;
      if (hash(cx, cz, seed + 10 + fi) > density) continue;
      const kind = pick(hash(cx, cz, seed + 20 + fi));
      const def = DECOR[kind];
      if (f.len < def.size.x + 0.3) continue;
      const along = (hash(cx, cz, seed + 30 + fi) - 0.5) * (f.len - def.size.x - 0.3);
      const out_ = f.half + WALL_GAP + def.size.z / 2;
      const x = cx + f.t.x * along + f.n.x * out_;
      const z = cz + f.t.z * along + f.n.z * out_;
      const faceYaw = (Math.atan2(f.n.x, f.n.z) * 180) / Math.PI;
      const rot = Math.round(faceYaw * 100) / 100;
      // Open ground in front: the piece's width plus a shoulder each side, APRON deep.
      const front = out_ + def.size.z / 2;
      const ax = cx + f.t.x * along + f.n.x * (front + APRON / 2);
      const az = cz + f.t.z * along + f.n.z * (front + APRON / 2);
      const apron = orientedRect(ax, az, def.size.x / 2 + 0.3, APRON / 2, faceYaw);
      tryPlace({ kind, x: round3(x), z: round3(z), rot }, apron);
    }
  }
  return out;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
