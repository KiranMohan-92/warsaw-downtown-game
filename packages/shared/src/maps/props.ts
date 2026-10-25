/**
 * Greybox set pieces built from boxes. Every prop is authored in local space (origin at its
 * footprint centre on the ground, +X along its length) and placed with a yaw, so a whole prop
 * rotates as one unit. Real dimensions (cars, buses, trams, ISO containers) keep cover heights and
 * sightlines honest.
 */
import { eulerDegFromQuat, quatFromEulerDeg, quatMul } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import { stairs } from './builder.ts';
import type { BodyHeroId, MapBox, MaterialId, PropModelTag, WreckHeroId } from './types.ts';

export interface Place {
  x: number;
  z: number;
  /** Ground height (default 0). */
  y?: number;
  /** Yaw in degrees (rotation about +Y; 0 = length along +X). */
  rot?: number;
}

type Local = {
  c: Vec3;
  s: Vec3;
  mat: MaterialId;
  tilt?: Vec3;
  collide?: boolean;
  visible?: boolean;
  model?: PropModelTag;
};

// ---- palettes (restrained, real-world; picked deterministically per object) --------------------
const CONTAINER_PAINT = [0x8a3b2a, 0x2d4f7a, 0x3d5e3f, 0x7c8084, 0xb8612e, 0x5a2a2e, 0x8c7a3c];
const AWNING = [0xa8312e, 0x2f6b43, 0x2c4f86, 0xe7dcc0, 0xc9742d, 0x6b2d4a];
const CHARRED = 0x2b2724;

/**
 * Solid body of each generated hero model (tools/assets/build_heroes.py `body`, metres: length
 * along local X, height, width). Its collision box; the model draws over it at 1:1.
 */
export const HERO_BODY: Readonly<Record<BodyHeroId, { x: number; y: number; z: number }>> = {
  burnt_car: { x: 3.56, y: 1.4, z: 1.54 },
  food_truck: { x: 4.13, y: 2.1, z: 1.98 },
  kiosk: { x: 2.08, y: 2.5, z: 2.28 },
};
const pickFor = (list: readonly number[], at: Place, salt: number): number => {
  const h =
    Math.sin(Math.round(at.x * 10) * 12.9898 + Math.round(at.z * 10) * 78.233 + salt) * 43758.5453;
  return list[Math.floor((h - Math.floor(h)) * list.length)]!;
};
/** Swap one material for another with a tint (e.g. generic 'accent' → car paint). */
const repaint = (boxes: MapBox[], from: MaterialId, to: MaterialId, tint: number): MapBox[] =>
  boxes.map((b) => (b.mat === from ? { ...b, mat: to, tint } : b));

/** Place local-space boxes: rotate each centre about the prop origin, add the yaw to each box. */
/**
 * A part's world rotation (three.js XYZ Euler, degrees): the placement yaw applied after the part's
 * own XYZ tilt, R = Ry(yaw) · Rx(tx) · Ry(ty) · Rz(tz). Without an X tilt that is exactly the Euler
 * (0, yaw + ty, tz), so plain yawed parts keep their simple angles; with one (the crashed
 * helicopter's boom, fin and blade) the yaw must be composed, not added to the Euler Y.
 */
export function placedRot(yaw: number, tilt: Vec3 | undefined): Vec3 {
  const t = tilt ?? { x: 0, y: 0, z: 0 };
  if (!t.x) return { x: 0, y: yaw + t.y, z: t.z };
  const e = eulerDegFromQuat(
    quatMul(quatFromEulerDeg({ x: 0, y: yaw, z: 0 }), quatFromEulerDeg(t)),
  );
  const r = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
  return { x: r(e.x), y: r(e.y), z: r(e.z) };
}

export function place(at: Place, parts: Local[]): MapBox[] {
  const yaw = ((at.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const y0 = at.y ?? 0;
  return parts.map((p) => {
    // Right-handed yaw about +Y: x' = x cos + z sin, z' = -x sin + z cos.
    const x = at.x + p.c.x * cos + p.c.z * sin;
    const z = at.z - p.c.x * sin + p.c.z * cos;
    const rot = placedRot(at.rot ?? 0, p.tilt);
    return {
      center: { x, y: y0 + p.c.y, z },
      size: p.s,
      ...(rot.x || rot.y || rot.z ? { rot } : {}),
      mat: p.mat,
      ...(p.collide === false ? { collide: false } : {}),
      ...(p.visible === false ? { visible: false } : {}),
      ...(p.model ? { model: p.model } : {}),
    };
  });
}

/** Tag every part as drawn by prop model `model` (the renderer fits models to each box). */
const as = (model: PropModelTag, parts: Local[]): Local[] => parts.map((p) => ({ ...p, model }));

/** Box resting on the ground at local (x, z) with size (w along X, h, d along Z). */
const lb = (
  x: number,
  z: number,
  w: number,
  h: number,
  d: number,
  mat: MaterialId,
  y = 0,
): Local => ({
  c: { x, y: y + h / 2, z },
  s: { x: w, y: h, z: d },
  mat,
});

// ---- vehicles --------------------------------------------------------------------------------------

/** Parked car (4.5 m): hood-height cover; a burnt wreck sits lower and darker. */
export function car(at: Place, wrecked = false): MapBox[] {
  // Parked cars wear a fitted cover: the CC0 `covered_car` scan fills the box and is its
  // collision. Wrecks are the generated burnt-out sedan (hero model) over a two-box body —
  // lower body plus cabin, so you can still shoot over the bonnet.
  if (wrecked) {
    const [body, cabin] = place(at, [
      lb(0, 0, HERO_BODY.burnt_car.x, 0.95, HERO_BODY.burnt_car.z, 'metal'),
      lb(-0.15, 0, 1.9, HERO_BODY.burnt_car.y - 0.95, 1.36, 'metal', 0.95),
    ]);
    return [
      { ...body!, tint: CHARRED, hero: 'burnt_car' },
      { ...cabin!, tint: CHARRED, visible: false, heroPart: 'burnt_car' },
    ];
  }
  return repaint(
    place(at, as('car', [lb(0, 0, 4.35, 1.41, 1.79, 'accent')])),
    'accent',
    'paint',
    0x3c4038,
  );
}

/** City bus (12 m). A burnt-out bus doubles as a boundary set piece. */
export function bus(at: Place, burnt = false): MapBox[] {
  const boxes = place(at, [
    lb(0, 0, 12, 2.3, 2.55, burnt ? 'metal' : 'accent', 0.35),
    lb(0, 0, 11.6, 0.9, 2.5, burnt ? 'metal' : 'glass', 1.5),
  ]);
  // Yellow municipal-style livery (no logos); burnt-out shells are charred.
  return burnt
    ? repaint(boxes, 'metal', 'paint', CHARRED)
    : repaint(boxes, 'accent', 'paint', 0xd6a92a);
}

/**
 * Tram (two 15 m sections). `derailed` tilts it off the rails — a boundary set piece that
 * closes a street end.
 */
export function tram(at: Place, derailed = false): MapBox[] {
  const tilt = derailed ? { x: 0, y: 7, z: 9 } : undefined;
  const sec = (x: number): Local[] => [
    { ...lb(x, 0, 14.6, 2.3, 2.4, 'trim', 0.4), ...(tilt ? { tilt } : {}) },
    { ...lb(x, 0, 14.2, 0.9, 2.36, 'glass', 1.55), ...(tilt ? { tilt } : {}) },
  ];
  return repaint(place(at, [...sec(-7.5), ...sec(7.5)]), 'trim', 'paint', 0xdcae2c);
}

// ---- containers & site -------------------------------------------------------------------------------

export type ContainerOpen = 'closed' | 'ends' | 'side';

/**
 * 20 ft ISO container (6.06 × 2.59 × 2.44). `ends` = doors open at both ends (a walk-through
 * hide with two approaches); `side` = one long side cut away (a lean-in firing position).
 */
export function container(at: Place, open: ContainerOpen = 'closed', length = 6.06): MapBox[] {
  const L = length;
  const H = 2.59;
  const W = 2.44;
  const t = 0.08;
  const paint = pickFor(CONTAINER_PAINT, at, 2);
  if (open === 'closed')
    return repaint(place(at, [lb(0, 0, L, H, W, 'metal')]), 'metal', 'container', paint);
  const parts: Local[] = [
    lb(0, 0, L, t, W, 'metal'), // floor
    lb(0, 0, L, t, W, 'metal', H - t), // roof
    lb(0, -W / 2 + t / 2, L, H - 2 * t, t, 'metal', t), // long side
  ];
  if (open === 'ends') parts.push(lb(0, W / 2 - t / 2, L, H - 2 * t, t, 'metal', t));
  else {
    // Side open: keep both end walls for cover.
    parts.push(lb(-L / 2 + t / 2, 0, t, H - 2 * t, W, 'metal', t));
    parts.push(lb(L / 2 - t / 2, 0, t, H - 2 * t, W, 'metal', t));
  }
  return repaint(place(at, parts), 'metal', 'container', paint);
}

/** Site office / cabin (6 × 2.6 × 2.4) with a door gap in the long side, window slot opposite. */
export function cabin(at: Place): MapBox[] {
  const t = 0.1;
  const boxes = place(at, [
    lb(0, 0, 6, t, 2.4, 'wood'),
    lb(0, 0, 6, t, 2.4, 'accent', 2.5),
    lb(-3 + t / 2, 0, t, 2.4, 2.4, 'accent', t),
    lb(3 - t / 2, 0, t, 2.4, 2.4, 'accent', t),
    lb(-1.6, -1.2 + t / 2, 2.8, 2.4, t, 'accent', t),
    lb(2.2, -1.2 + t / 2, 1.6, 2.4, t, 'accent', t), // door gap at x ≈ 0.4..1.4
    lb(0, 1.2 - t / 2, 6, 1.0, t, 'accent', t), // window slot above 1.1 m
    lb(0, 1.2 - t / 2, 6, 0.5, t, 'accent', 1.9),
  ]);
  return repaint(boxes, 'accent', 'paint', 0xd8dad6);
}

/** Stack of pipes/beams as stepped boxes (low → chest-high cover). */
export function pipeStack(at: Place, length = 6, rows = 3): MapBox[] {
  const parts: Local[] = [];
  for (let r = 0; r < rows; r++)
    parts.push(lb(0, 0, length, 0.45, 0.5 * (rows - r) + 0.5, 'metal', r * 0.45));
  return place(at, parts);
}

/** Pallet of construction materials (bricks/blocks, 1.2 m). */
export const pallet = (at: Place, h = 1.2): MapBox[] =>
  place(at, [lb(0, 0, 1.2, 0.15, 1.0, 'wood'), lb(0, 0, 1.1, h - 0.15, 0.95, 'concrete', 0.15)]);

/** Jersey barrier run (0.6 × 0.85): waist cover. */
export const jersey = (at: Place, length = 4): MapBox[] =>
  place(at, as('jersey', [lb(0, 0, length, 0.85, 0.6, 'concrete')]));

/** Police crowd barrier (2.5 m panel, see-through in reality — thin, low cover). */
export const crowdBarrier = (at: Place): MapBox[] => place(at, [lb(0, 0, 2.5, 1.1, 0.08, 'metal')]);

/**
 * Construction fence along local X, `length` metres, with gaps [from, to] (metres from the
 * start) for gates and holes.
 */
export function fence(at: Place, length: number, gaps: [number, number][] = [], h = 2.0): MapBox[] {
  const parts: Local[] = [];
  let cursor = 0;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > cursor) parts.push(lb(-length / 2 + (cursor + a) / 2, 0, a - cursor, h, 0.06, 'metal'));
    cursor = b;
  }
  if (cursor < length)
    parts.push(lb(-length / 2 + (cursor + length) / 2, 0, length - cursor, h, 0.06, 'metal'));
  return place(at, parts);
}

/**
 * Scaffolding along local X (`length` m, `depth` m deep): walkable decks every 4 m (`levels` of
 * them) plus a stair tower at the +X end — two lanes of opposite 2 m flights meeting at a landing,
 * so every deck is reachable and there is ≥2 m headroom everywhere. The decks are exposed: a
 * vertical position reachable only by an exposed route. The guard rail runs along local −Z; place
 * the scaffold with local +Z facing the building so you can step off onto its floors/roof.
 * Yaw must be a multiple of 90°.
 */
export function scaffold(at: Place, length: number, levels: number, depth = 2.4): MapBox[] {
  const parts: Local[] = [];
  const bay = 2.5;
  const bays = Math.max(2, Math.round(length / bay));
  const L = bays * bay;
  const run = 2.9; // 2 m rise per flight (~35°)
  const landing = 1.2;
  const towerEnd = L / 2 + run + landing;
  const top = levels * 4;
  for (let i = 0; i <= bays; i++) {
    const x = -L / 2 + i * bay;
    parts.push(
      lb(x, -depth / 2, 0.06, top + 1.1, 0.06, 'metal'),
      lb(x, depth / 2, 0.06, top + 1.1, 0.06, 'metal'),
    );
  }
  parts.push(
    lb(towerEnd, -depth / 2, 0.06, top + 1.1, 0.06, 'metal'),
    lb(towerEnd, depth / 2, 0.06, top + 1.1, 0.06, 'metal'),
  );
  for (let k = 1; k <= levels; k++) {
    parts.push(lb(0, 0, L, 0.1, depth, 'wood', k * 4 - 0.1)); // deck
    parts.push(lb(0, -depth / 2, L, 0.06, 0.05, 'metal', k * 4 + 1.0)); // guard rail (−Z side)
    parts.push(
      lb(L / 2 + run + landing / 2, 0, landing, 0.1, depth, 'wood', (k - 1) * 4 + 2 - 0.1),
    ); // landing
  }
  const boxes = place(at, parts);
  const r = ((((at.rot ?? 0) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  if (r % 90 !== 0) throw new Error('scaffold(): yaw must be a multiple of 90°');
  const yaw = (r * Math.PI) / 180;
  const toWorld = (lx: number, lz: number): { x: number; z: number } => ({
    x: at.x + lx * Math.cos(yaw) + lz * Math.sin(yaw),
    z: at.z - lx * Math.sin(yaw) + lz * Math.cos(yaw),
  });
  const plusX = ({ 0: '+x', 90: '-z', 180: '-x', 270: '+z' } as const)[r];
  const minusX = ({ 0: '-x', 90: '+z', 180: '+x', 270: '-z' } as const)[r];
  const laneW = depth / 2 - 0.05;
  const y0 = at.y ?? 0;
  for (let k = 1; k <= levels; k++) {
    const a = toWorld(L / 2, -depth / 4);
    boxes.push(...stairs({ x: a.x, y: y0 + (k - 1) * 4, z: a.z }, plusX, run, 2, laneW, 'wood'));
    const b = toWorld(L / 2 + run, depth / 4);
    boxes.push(
      ...stairs({ x: b.x, y: y0 + (k - 1) * 4 + 2, z: b.z }, minusX, run, 2, laneW, 'wood'),
    );
  }
  return boxes;
}

// ---- street furniture & greenery ------------------------------------------------------------------

/** Market stall: counter, back panel, canopy (the canopy is head-height; you can duck under). */
export const stall = (at: Place): MapBox[] =>
  repaintStall(at, [
    lb(0, 0.6, 3, 1.0, 0.7, 'wood'),
    lb(0, -0.9, 3, 2.2, 0.08, 'wood'),
    lb(0, 0, 3.4, 0.06, 2.3, 'accent', 2.3),
  ]).map((b) => (b.mat === 'paint' ? { ...b, dress: 'stallAwning' as const } : b));

function repaintStall(at: Place, parts: Local[]): MapBox[] {
  return repaint(place(at, parts), 'accent', 'paint', pickFor(AWNING, at, 3));
}

function repaintTruck(at: Place, parts: Local[]): MapBox[] {
  return repaint(place(at, parts), 'accent', 'paint', 0xe3dccb);
}

/** Newspaper/snack kiosk (solid, 3 × 2.5). */
export const kiosk = (at: Place): MapBox[] =>
  place(at, [lb(0, 0, HERO_BODY.kiosk.x, HERO_BODY.kiosk.y, HERO_BODY.kiosk.z, 'paint')]).map(
    (b) => ({ ...b, tint: 0x2f5a44, hero: 'kiosk' as const }),
  );

/** Tram/bus shelter: roof on posts with a glazed back wall. */
export const shelter = (at: Place, length = 6): MapBox[] =>
  place(at, [
    lb(0, 0, length + 0.4, 0.1, 1.8, 'metal', 2.5),
    lb(0, -0.8, length, 2.3, 0.05, 'glass', 0.15),
    lb(-length / 2, -0.8, 0.1, 2.5, 0.1, 'metal'),
    lb(length / 2, -0.8, 0.1, 2.5, 0.1, 'metal'),
  ]);

/** Clipped hedge (blocks movement and sight; concealment identical at all qualities). */
export const hedge = (at: Place, length: number, h = 1.6): MapBox[] =>
  place(at, [lb(0, 0, length, h, 1.0, 'foliage')]);

/** Concrete planter with shrub (crouch cover). */
export const planter = (at: Place, size = 2): MapBox[] =>
  place(at, [
    lb(0, 0, size, 0.7, size, 'concrete'),
    lb(0, 0, size - 0.3, 0.6, size - 0.3, 'foliage', 0.7),
  ]);

/** Advertising column / pillar (1 m square). */
export const pillar = (at: Place, h = 3): MapBox[] => place(at, [lb(0, 0, 1, h, 1, 'concrete')]);

// ---- close-quarters cover (M2 tightening) --------------------------------------------------------

/** Wooden crate (0.9 m: one jump) — stack them into steps up to container roofs. */
export const crate = (at: Place, size = 0.9): MapBox[] =>
  place(at, as('crate', [lb(0, 0, size, size, size, 'wood')]));

/**
 * Crate stair: 0.9 → 1.8 m steps against something taller (a container roof at 2.59 m is one more
 * jump). Local +X climbs.
 */
export const crateSteps = (at: Place): MapBox[] =>
  place(at, as('crate', [lb(-0.9, 0, 0.9, 0.9, 1.1, 'wood'), lb(0, 0, 0.9, 1.8, 1.1, 'wood')]));

/** Crate pile: mixed heights, crouch/stand cover with jump-up spots. */
export const cratePile = (at: Place): MapBox[] =>
  place(
    at,
    as('crate', [
      lb(0, 0, 1.2, 1.2, 1.2, 'wood'),
      lb(1.25, 0.1, 0.9, 0.9, 0.9, 'wood'),
      lb(0.1, 1.25, 0.9, 0.9, 0.9, 'wood'),
      lb(0, 0, 0.9, 0.9, 0.9, 'wood', 1.2),
    ]),
  );

/**
 * Pallet stock: two pallets loaded with cartons (the market's back-stock), the same footprint and
 * cover heights as a crate pile — chest-high and crouch-high, one jump up the short one.
 */
export const cartonPallets = (at: Place): MapBox[] =>
  place(at, [
    lb(0, 0, 1.2, 0.15, 1.0, 'wood'),
    ...as('cartons', [lb(0, 0, 1.15, 1.2, 0.95, 'wood', 0.15)]),
    lb(0.15, 1.3, 1.2, 0.15, 1.0, 'wood'),
    ...as('cartons', [lb(0.15, 1.3, 1.15, 0.7, 0.95, 'wood', 0.15)]),
  ]).map((b) => (b.model === 'cartons' ? { ...b, tint: 0xa88a5c } : b));

/** Sandbag wall (0.95 m: chest cover when crouched, waist when standing). Local X length. */
export const sandbags = (at: Place, length = 4): MapBox[] =>
  place(at, [lb(0, 0, length, 0.95, 0.7, 'sandbag')]).map((b) => ({ ...b, tint: 0xeee6d6 }));

/** Market table (0.75 m, jumpable). */
export const table = (at: Place): MapBox[] => place(at, [lb(0, 0, 1.8, 0.75, 0.9, 'wood')]);

/**
 * Crashed utility helicopter (render: the CC BY Blackhawk wreck, re-textured, no markings):
 * gear collapsed, nose down 3°, tail boom snapped and lying beside it, one main blade fallen
 * across the right side. The boxes follow that model: generated by
 * `tools/assets/heli_collision.py` from the same crash parameters as the model
 * (`tools/assets/vehicle_configs/heli_wreck.json`) — regenerate both together. The cabin is an
 * enterable shell (2.2 m inside) with a door on each side, offset so you can't see straight
 * through (left x −1.8 … 0.2, right −1.0 … 1.0; 2.4 m high), a solid cockpit, a belly slab on the ground
 * (nothing to crawl under) and sills ≤ 0.42 m (a step up).
 */
export function helicopterWreck(at: Place): MapBox[] {
  const box = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    rx: number,
    ry: number,
    rz: number,
  ): Local => ({
    c: { x, y, z },
    s: { x: w, y: h, z: d },
    mat: 'metal',
    tilt: { x: rx, y: ry, z: rz },
  });
  const boxes = place(at, [
    box(-0.0246, 0.1194, 0, 5.6, 0.5, 2.9, 0, 0, 3), // floor
    box(-0.1596, 2.6958, 0, 5.8, 0.2, 2.7, 0, 0, 3), // roof
    box(-3.4243, 0.502, 0, 1.15, 1, 2.2, 0, 0, 3), // cockpit
    box(-3.089, 1.2706, 0, 0.4, 0.5, 2.2, 0, 0, 3), // cockpit_top
    box(2.7501, 1.6316, 0, 0.1, 2.43, 2.7, 0, 0, 3), // rear
    box(-2.3929, 1.3621, -1.45, 1, 2.43, 0.1, 0, 0, 3), // wall_l1
    box(1.4019, 1.561, -1.45, 2.6, 2.43, 0.1, 0, 0, 3), // wall_l2
    box(-0.9502, 2.4942, -1.45, 2, 0.22, 0.1, 0, 0, 3), // head_l
    box(-1.9934, 1.383, 1.45, 1.8, 2.43, 0.1, 0, 0, 3), // wall_r1
    box(1.8014, 1.5819, 1.45, 1.8, 2.43, 0.1, 0, 0, 3), // wall_r2
    box(-0.1513, 2.536, 1.45, 2, 0.22, 0.1, 0, 0, 3), // head_r
    box(0.4212, 3.0767, 0, 3.6, 0.6, 1.7, 0, 0, 3), // engine
    box(4.2182, 1.3231, 0, 3, 1.5, 1.2, 0, 0, 3), // boom_root
    box(2.1207, 3.1308, 0, 1.4, 0.83, 2.6, 0, 0, 3), // exhaust
    box(0.1164, 3.1609, 0, 1.8, 0.82, 0.9, 0, 0, 3), // hub
    box(-2.0743, 2.9259, 0, 1.4, 0.46, 0.72, 0, 0, 3), // fairing
    box(3.0648, 2.314, 0, 0.8, 0.76, 1.7, 0, 0, 3), // aft_1
    box(3.871, 2.2161, 0, 0.8, 0.48, 1.2, 0, 0, 3), // aft_2
    box(7.8054, 0.8322, 0.7659, 3.6, 1, 0.9, -2.4, -14.811, -9.312), // boom
    box(8.6154, 1.7671, 0.8375, 1.9, 1.4, 0.6, -2.4, -14.811, -9.312), // fin
    box(9.1904, 3.0934, 1.0376, 1.7, 1.4, 0.9, -2.4, -14.811, -9.312), // fin_top
    box(8.6129, 0.8056, 0.9807, 0.95, 0.6, 3.2, -2.4, -14.811, -9.312), // stabiliser
    box(1.1775, 1.4185, 4.0649, 0.6, 0.12, 5.8, 33.619, 16.697, -7.449), // blade
  ]);
  // Burnt, sooty sheet metal (the fallback drawing when the model is missing).
  return asWreckHero('heli_wreck', at, repaint(boxes, 'metal', 'wreck', 0xffffff));
}

/**
 * A wreck drawn as a re-baked model: its boxes become the model's (collision-only) parts, plus a
 * zero-size invisible anchor at the prop's origin that carries the model (render/heroModels.ts).
 */
function asWreckHero(id: WreckHeroId, at: Place, boxes: MapBox[]): MapBox[] {
  const [anchor] = place(at, [
    { c: { x: 0, y: 0.0005, z: 0 }, s: { x: 0.001, y: 0.001, z: 0.001 }, mat: 'metal' },
  ]);
  return [
    ...boxes.map((b) => ({ ...b, heroPart: id })),
    { ...anchor!, collide: false, visible: false, hero: id },
  ];
}

/**
 * Wrecked armoured truck (render: the CC BY photogrammetry scan, unit marking painted out),
 * front +X: armoured hull with a ring turret, low bonnet. Boxes fitted to the scan (ytop per
 * 0.4 m slice; tools/assets/vehicle_configs/armoured_wreck.json).
 */
export function armouredWreck(at: Place): MapBox[] {
  const boxes = place(at, [
    lb(-0.8, 0, 2.8, 2.25, 1.86, 'metal'), // armoured hull
    lb(1.45, 0, 1.7, 1.36, 1.86, 'metal'), // bonnet
    lb(-0.4, 0, 1.2, 0.4, 1.1, 'metal', 2.25), // turret
  ]);
  return asWreckHero('armoured_wreck', at, repaint(boxes, 'metal', 'wreck', 0x9a9a8a));
}

/**
 * Knocked-out tank (generic, no markings): tracks 1.0 m (jump up), hull 1.75 m, turret knocked
 * askew, barrel drooping. Hard cover you can climb onto. Boxes fitted to the shipped model
 * (tools/assets/vehicle_spec.py WRECK_BOXES; test_wreck_rays.py casts a ray grid at the mesh).
 */
export function tankWreck(at: Place): MapBox[] {
  const boxes = place(at, [
    lb(0, -1.4125, 7.2, 1, 0.775, 'metal'), // track_l
    lb(0, 1.4125, 7.2, 1, 0.775, 'metal'), // track_r
    lb(0, 0, 6.6, 1.35, 2, 'metal', 0.4), // hull between the tracks
    lb(3.56, 0, 0.72, 0.72, 3.5, 'metal', 1.2), // rear engine deck (overhangs the hull)
    { ...lb(-0.403, 0.207, 3.4, 1, 2.8, 'metal', 1.749), tilt: { x: 6, y: 22, z: 4 } }, // turret
    { ...lb(-4.461, 1.828, 3.97, 0.3, 0.3, 'metal', 1.407), tilt: { x: 0, y: 18.81, z: 7.64 } }, // barrel (drooping, fitted to the model)
    { ...lb(2.04, -0.743, 2.1, 0.65, 2.6, 'metal', 2.335), tilt: { x: 6, y: 22, z: 4 } }, // turret bustle (overhangs the rear)
    { ...lb(-2.247, 0.924, 0.6, 0.32, 1.1, 'metal', 1.783), tilt: { x: 6, y: 22, z: 4 } }, // mantlet
    { ...lb(0.746, -0.471, 0.55, 0.32, 0.48, 'metal', 2.966), tilt: { x: 6, y: 22, z: 4 } }, // commander's cupola
  ]);
  // The CC BY Leopard wreck model draws over these (models/vehicles/tank_wreck).
  return asWreckHero('tank_wreck', at, repaint(boxes, 'metal', 'paint', 0x4c5241));
}

/** Food truck / van (5.5 × 2.2 × 2.6): full-height cover. */
export const foodTruck = (at: Place): MapBox[] =>
  repaintTruck(at, [
    lb(0, 0, HERO_BODY.food_truck.x, HERO_BODY.food_truck.y, HERO_BODY.food_truck.z, 'accent'),
  ]).map((b) => ({ ...b, hero: 'food_truck' as const }));

/**
 * Two-high container stack with a crate stair up to the lower roof (2.59 m) — a quick,
 * exposed vertical position. Local X along the containers.
 */
export function climbStack(at: Place): MapBox[] {
  const yaw = ((at.rot ?? 0) * Math.PI) / 180;
  const off = (lx: number, lz: number): Place => ({
    x: at.x + lx * Math.cos(yaw) + lz * Math.sin(yaw),
    z: at.z - lx * Math.sin(yaw) + lz * Math.cos(yaw),
    y: at.y,
    rot: at.rot,
  });
  return [
    ...container(off(0, 0), 'closed'),
    ...container({ ...off(1.5, 2.44), y: at.y ?? 0 }, 'side'),
    ...container({ ...off(0, 2.44), y: (at.y ?? 0) + 2.59 }, 'closed'),
    ...crateSteps({ ...off(-4.9, 0), rot: at.rot }),
  ];
}
