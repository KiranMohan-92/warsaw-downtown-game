/**
 * The Market quarter — Plac Defilad in front of the Palace's east facade, built dense for close
 * quarters (Kiran: "too open, we lose each other"). It is part of the full map and is also the
 * compact "Market" map size (≈132 × 126 m), where the Palace facade and its corner wings are the
 * west/north/south walls and a container wall closes the east.
 *
 * Modern-shooter density rules applied: cover every 5–8 m, no straight lane longer than one
 * block, three height levels (street, climbable crates/containers/tank/hall upstairs, metro),
 * several routes between any two points.
 */
import { block, boxMinMax, stairs, wall, type Opening } from '../builder.ts';
import { rectPoly } from '../geom.ts';
import {
  climbStack,
  container,
  crate,
  cartonPallets,
  cratePile,
  crateSteps,
  foodTruck,
  armouredWreck,
  helicopterWreck,
  jersey,
  kiosk,
  pallet,
  planter,
  sandbags,
  stall,
  table,
  tankWreck,
} from '../props.ts';
import { R, stairDown, underground, type Rect } from '../solids.ts';
import type { Vec3 } from '../../math/vec3.ts';
import type { MapBox, MapFoliage, PickupKind } from '../types.ts';

export const MARKET_BOUNDS = { minX: 38, maxX: 170, minZ: -62, maxZ: 64 };
const FLOOR = -5;
const SLAB = -0.5;

/**
 * Truck lanes (Kiran, 2026-10-02: clear drivable routes): 5 m wide plus 1 m shoulders, kept
 * free of props, cover fill, street dressing and trees (cover is placed along them instead, so
 * the ≤ 4 m-to-cover rule is measured inside them too). The west edge runs north–south under the
 * Palace facade — along the boundary at either end, in front of the portico between — with the
 * trucks parked at its two ends; two crossings run east across the forecourt to a lane along the
 * maze's west edge, so there is a loop as well as the long run. Bot drivers keep to these
 * (`MapDefinition.truckLanes`).
 */
export const TRUCK_LANES: readonly Rect[] = [
  R(39.5, -53, 44.5, -22), // west edge, north, along the boundary (truck 1 parks at its end)
  R(39.5, -27, 58.5, -22), // round the portico's north wing
  R(53.5, -27, 58.5, 25), // in front of the portico (clear of its columns)
  R(39.5, 20, 58.5, 25), // round its south wing
  R(39.5, 20, 44.5, 53), // west edge, south (truck 2 at its end)
  R(53.5, -22, 91, -17), // north crossing
  R(53.5, 17, 91, 22), // south crossing
  R(86, -22, 91, 22), // along the maze's west edge
  // Turning room at the bends (a 5 m truck turns wide): the inside of the two bends the portico
  // doesn't stand in, and the outside of the two it does…
  R(44.5, -30, 47.5, -27),
  R(44.5, 25, 47.5, 28),
  R(58.5, -29, 61.5, -22),
  R(58.5, 22, 61.5, 29),
  // …and inside the bends where the crossings meet the west edge and the maze-side lane.
  R(58.5, -17, 61.5, -14),
  R(58.5, 14, 61.5, 17),
  R(83, -17, 86, -14),
  R(83, 14, 86, 17),
];
/**
 * Where truck lanes meet (their overlaps, grown by the shoulders and the bends' turning room):
 * protected like a doorway, since cover can't stand in a crossing — the ≤ 4 m-to-cover rule is
 * measured everywhere else, the lanes themselves included.
 */
export const TRUCK_LANE_JUNCTIONS: readonly Rect[] = TRUCK_LANES.flatMap((a, i) =>
  TRUCK_LANES.slice(i + 1).flatMap((b) => {
    const r = R(
      Math.max(a.x0, b.x0),
      Math.max(a.z0, b.z0),
      Math.min(a.x1, b.x1),
      Math.min(a.z1, b.z1),
    );
    return r.x1 >= r.x0 && r.z1 >= r.z0 ? [R(r.x0 - 1, r.z0 - 1, r.x1 + 1, r.z1 + 1)] : [];
  }),
);
/** The lanes with their shoulders: nothing solid is placed within 1 m of a lane either. */
export const TRUCK_LANES_CLEAR: readonly Rect[] = TRUCK_LANES.map((r) =>
  R(r.x0 - 1, r.z0 - 1, r.x1 + 1, r.z1 + 1),
);

/** The market hall (enterable, two floors). */
const HALL = R(128, 14, 152, 28);
/** The market hall's footprint (lawn markings are cut out of it: it has its own floor). */
export const MARKET_HALL = HALL;
const HALL_FLOOR2 = 3.6;
const HALL_ROOF = 7.2;

export interface MarketBuild {
  boxes: MapBox[];
  openings: Rect[];
  keepClear: Rect[];
  /** Uplink spots inside the quarter (radar charges and a recon-drone charge). */
  pickups: { pos: Vec3; kind: PickupKind }[];
  /** Boundary pieces used only by the compact "Market" size. */
  sectionBoxes: MapBox[];
  /** Bush clumps in the maze (walk-in hiding spots). */
  foliage: MapFoliage[];
}

const hash = (x: number, z: number, salt: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * A pile of cover at `at`: antique chests or, at about 45 % of spots, pallets of cartons (Kiran:
 * mix the chests with other market stock). Same footprint and heights either way.
 */
const pileAt = (at: { x: number; z: number }): MapBox[] =>
  hash(at.x, at.z, 29) < 0.45 ? cartonPallets(at) : cratePile(at);

export function buildMarketQuarter(): MarketBuild {
  const boxes: MapBox[] = [];
  const add = (...b: MapBox[]): void => {
    boxes.push(...b);
  };
  const openings: Rect[] = [];
  const keepClear: Rect[] = [];

  // ---- metro passage under the plaza (4 entrances) ------------------------------------------------
  const rooms: Rect[] = [
    R(60, -3, 158, 3), // east–west passage
    R(96, -9, 114, 9), // ticket hall (pillars)
    R(118, -36, 122, -3), // branch north
    R(146, 3, 150, 36), // branch south
  ];
  const stairsDown = [
    stairDown(62, 0, '+x', FLOOR, 4),
    stairDown(120, -44, '+z', FLOOR, 4),
    stairDown(148, 44, '-z', FLOOR, 4),
    stairDown(166, 0, '-x', FLOOR, 4),
  ];
  // Granite floor, glazed tile walls (a real metro passage, not a bunker).
  add(
    ...underground([...rooms, ...stairsDown.map((s) => s.opening)], FLOOR, SLAB, 'paving', 'tile'),
  );
  // Ceiling lights: strips along the passages, a grid in the ticket hall (dressing, no light).
  // Never inside a stair shaft (heads on the way down), 1 m margin.
  const inShaft = (x: number, z: number): boolean =>
    stairsDown.some(
      ({ opening: o }) => x > o.x0 - 1 && x < o.x1 + 1 && z > o.z0 - 1 && z < o.z1 + 1,
    );
  const lamps: MapBox[] = [];
  const lamp = (x: number, z: number, w: number, d: number): void => {
    if (!inShaft(x, z))
      lamps.push({ ...block(x, z, SLAB - 0.08, w, 0.08, d, 'metal'), dress: 'lightPanel' });
  };
  for (let x = 64; x <= 156; x += 6) if (x < 96 || x > 114) lamp(x, 0, 1.4, 0.25);
  for (const x of [99, 102, 105, 108, 111]) for (const z of [-3, 0, 3]) lamp(x, z, 1.2, 0.3);
  for (let z = -33; z <= -6; z += 6) lamp(120, z, 0.25, 1.4);
  for (let z = 6; z <= 33; z += 6) lamp(148, z, 0.25, 1.4);
  add(...lamps);
  for (const s of stairsDown) {
    add(...s.boxes);
    openings.push(s.opening);
  }
  for (const x of [99, 105, 111]) {
    for (const z of [-5.5, 5.5]) add(block(x, z, FLOOR, 0.8, -FLOOR + SLAB, 0.8, 'tile'));
  }
  add(block(105, 0, FLOOR, 5, 1.1, 1.2, 'concrete')); // ticket counter island (cover)
  add(...crate({ x: 90, y: FLOOR, z: 1.6 })); // a crate in the passage
  add(...pallet({ x: 136, y: FLOOR, z: -1.5 }), ...pallet({ x: 76, y: FLOOR, z: 1.4 }));

  // ---- market hall: two floors, doors on every side, stair inside, windows upstairs ---------------
  const H = HALL;
  const t = 0.3;
  const door = (from: number, w = 2.2): Opening => ({ from, to: from + w, bottom: 0, top: 2.4 });
  const win = (from: number): Opening => ({
    from,
    to: from + 2.2,
    bottom: HALL_FLOOR2 + 0.9,
    top: HALL_FLOOR2 + 2.2,
  });
  add(
    ...wall({ x: H.x0, z: H.z0 }, { x: H.x1, z: H.z0 }, 0, HALL_ROOF, t, 'plaster', [
      door(4),
      door(16),
      win(2),
      win(9),
      win(18),
    ]),
  );
  add(
    ...wall({ x: H.x0, z: H.z1 }, { x: H.x1, z: H.z1 }, 0, HALL_ROOF, t, 'plaster', [
      door(10),
      win(4),
      win(14),
      win(20),
    ]),
  );
  add(
    ...wall({ x: H.x0, z: H.z0 }, { x: H.x0, z: H.z1 }, 0, HALL_ROOF, t, 'plaster', [
      door(6),
      win(3),
      win(9),
    ]),
  );
  add(
    ...wall({ x: H.x1, z: H.z0 }, { x: H.x1, z: H.z1 }, 0, HALL_ROOF, t, 'plaster', [
      door(5),
      win(8),
    ]),
  );
  add(
    boxMinMax(
      { x: H.x0, y: HALL_ROOF, z: H.z0 },
      { x: H.x1, y: HALL_ROOF + 0.3, z: H.z1 },
      'concrete',
    ),
  );
  // Upper floor with a stair well in the south-east corner (stair climbs −x along the south
  // wall, clear of every door).
  const well = R(H.x1 - 7.2, H.z1 - 2.2, H.x1 - 1, H.z1 - 0.4);
  const stairRun = 5.4;
  add(
    boxMinMax(
      { x: H.x0, y: HALL_FLOOR2 - 0.25, z: H.z0 },
      { x: H.x1, y: HALL_FLOOR2, z: well.z0 },
      'wood',
    ),
  );
  add(
    boxMinMax(
      { x: H.x0, y: HALL_FLOOR2 - 0.25, z: well.z1 },
      { x: H.x1, y: HALL_FLOOR2, z: H.z1 },
      'wood',
    ),
  );
  add(
    boxMinMax(
      { x: H.x0, y: HALL_FLOOR2 - 0.25, z: well.z0 },
      // Bridge to the top tread, with 1 cm overlap to avoid a float-precision ray seam.
      { x: well.x1 - stairRun + 0.01, y: HALL_FLOOR2, z: well.z1 },
      'wood',
    ),
  );
  add(
    boxMinMax(
      { x: well.x1, y: HALL_FLOOR2 - 0.25, z: well.z0 },
      { x: H.x1, y: HALL_FLOOR2, z: well.z1 },
      'wood',
    ),
  );
  add(
    ...stairs(
      { x: well.x1, y: 0, z: (well.z0 + well.z1) / 2 },
      '-x',
      stairRun,
      HALL_FLOOR2,
      1.7,
      'wood',
    ),
  );
  // Terrazzo floor over the park ground (5 cm: above the lawn markings, walks like flat ground).
  add(boxMinMax({ x: H.x0, y: 0, z: H.z0 }, { x: H.x1, y: 0.05, z: H.z1 }, 'terrazzo'));
  // Ground-floor ceiling: joists under the upper floor (not over the stair well: heads on the
  // climb) and recessed light panels between them.
  const under = HALL_FLOOR2 - 0.25;
  for (let x = H.x0 + 2; x < H.x1 - 1; x += 3) {
    const zs: [number, number][] =
      x > well.x0 - 0.2 && x < well.x1 + 0.2 ? [[H.z0, well.z0]] : [[H.z0, H.z1]];
    for (const [z0, z1] of zs)
      add(block(x, (z0 + z1) / 2, under - 0.22, 0.18, 0.22, z1 - z0, 'wood'));
  }
  for (let x = H.x0 + 3.5; x < H.x1 - 2; x += 6)
    for (const z of [H.z0 + 3.5, H.z0 + 10.5])
      add({ ...block(x, z, under - 0.05, 1.2, 0.05, 0.6, 'metal'), dress: 'lightPanel' });
  // Upper floor: steel roof beams and hanging lamps between them.
  for (let x = H.x0 + 1.5; x < H.x1; x += 3)
    add(block(x, (H.z0 + H.z1) / 2, HALL_ROOF - 0.35, 0.22, 0.35, H.z1 - H.z0, 'trim'));
  for (let x = H.x0 + 3; x < H.x1 - 1; x += 6)
    for (const z of [H.z0 + 4, H.z0 + 10])
      add({ ...block(x, z, HALL_ROOF - 1.3, 0.5, 1.3, 0.5, 'metal'), dress: 'pendant' });
  // Ground floor: counters and crates (cover inside); upstairs: partitions and crates.
  add(block(137, 20, 0, 6, 1.0, 1.2, 'wood'), block(146, 19.5, 0, 1.2, 1.0, 4, 'wood'));
  add(...pileAt({ x: 132, z: 24.5 }));
  add(
    block(140, 21, HALL_FLOOR2, 0.2, 2.4, 6, 'plaster'),
    block(146, 17, HALL_FLOOR2, 5, 2.4, 0.2, 'plaster'),
  );
  add(...crate({ x: 133, z: 25, y: HALL_FLOOR2 }), ...crate({ x: 149, z: 16, y: HALL_FLOOR2 }));
  keepClear.push(R(H.x0 - 2, H.z0 - 2, H.x1 + 2, H.z1 + 2));

  // ---- forecourt (between the Palace facade and the market) --------------------------------------
  add(...tankWreck({ x: 72, z: -30, rot: 200 }));
  add(...helicopterWreck({ x: 74, z: 32, rot: 160 }));
  add(...sandbags({ x: 60.5, z: -8.4, rot: 90 }, 5), ...sandbags({ x: 60.5, z: 8.4, rot: 90 }, 5));
  add(...sandbags({ x: 80, z: -3, rot: 20 }, 4), ...sandbags({ x: 64, z: -46, rot: 0 }, 5));
  // (The pile and the two wrecks stand beside the truck lanes, not in them.)
  add(...pileAt({ x: 84, z: -45 }), ...pileAt({ x: 62, z: 47 }), ...pileAt({ x: 80.6, z: 9 }));
  // Wrecked armoured trucks (CC BY scan) where a burnt-out car and a covered car stood.
  add(
    ...armouredWreck({ x: 66, z: 13.6, rot: 75 }),
    ...armouredWreck({ x: 83, z: -25.5, rot: 105 }),
  );
  add(...container({ x: 80, z: 52, rot: 90 }, 'ends'));
  add(...kiosk({ x: 48.5, z: -38, rot: 0 }), ...kiosk({ x: 48.5, z: 38, rot: 0 }));
  for (const z of [-52, 52]) add(...planter({ x: 70, z }));
  add(...jersey({ x: 88, z: 30, rot: 90 }, 6), ...jersey({ x: 88, z: -30, rot: 90 }, 6));

  // ---- market maze: 12 m blocks with 2.5–3 m alleys ---------------------------------------------
  const blocked = [
    ...openings.map((o) => R(o.x0 - 1.5, o.z0 - 1.5, o.x1 + 1.5, o.z1 + 1.5)),
    keepClear[0]!,
  ];
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
  // Brick pattern: every other row shifts half a block, so north–south alleys never run
  // straight through the market.
  const alleyX: number[][] = [];
  let row = 0;
  for (let cz = -58; cz < 60; cz += 12, row++) {
    const off = row % 2 ? 6 : 0;
    alleyX.push([]);
    for (let cx = 92 - off; cx < 166; cx += 12) {
      alleyX[row]!.push(cx);
      const cell = R(
        Math.max(cx + 1.4, 93.4),
        cz + 1.4,
        Math.min(cx + 12 - 1.4, 166.6),
        cz + 12 - 1.4,
      ); // alleys ≈ 2.8 m
      if (cell.x1 - cell.x0 < 3) continue;
      if (cell.x1 - cell.x0 < 8) {
        // Half cell at the maze edge: a crate pile.
        const px = (cell.x0 + cell.x1) / 2;
        const pz = (cell.z0 + cell.z1) / 2;
        if (!blocked.some((b) => overlaps(R(px - 1.6, pz - 1.6, px + 1.6, pz + 1.6), b))) {
          add(...pileAt({ x: px - 0.6, z: pz - 0.6 }));
        }
        continue;
      }
      if (blocked.some((b) => overlaps(cell, b))) {
        // Partial cell next to a stairwell/hall: a single crate pile or sandbags, off the path.
        const r = hash(cx, cz, 1);
        const px = cell.x0 + 1.5;
        const pz = cell.z0 + 1.5;
        if (!blocked.some((b) => overlaps(R(px - 1.5, pz - 1.5, px + 1.5, pz + 1.5), b))) {
          add(...(r < 0.5 ? pileAt({ x: px, z: pz }) : sandbags({ x: px + 1, z: pz, rot: 0 }, 3)));
        }
        continue;
      }
      const mx = (cell.x0 + cell.x1) / 2;
      const mz = (cell.z0 + cell.z1) / 2;
      const r = hash(cx, cz, 2);
      const rot = hash(cx, cz, 3) < 0.5 ? 0 : 90;
      if (r < 0.22) {
        // Back-to-back stall rows with a crate at each end.
        const along = rot === 0;
        for (const k of [-3, 0, 3]) {
          const sx = along ? mx + k : mx - 1.1;
          const sz = along ? mz - 1.1 : mz + k;
          add(...stall({ x: sx, z: sz, rot: along ? 180 : 270 }));
          add(
            ...stall({ x: along ? sx : mx + 1.1, z: along ? mz + 1.1 : sz, rot: along ? 0 : 90 }),
          );
        }
        add(
          ...crate({ x: along ? mx - 5 : mx, z: along ? mz : mz - 5 }),
          ...table({ x: along ? mx + 4.6 : mx + 3, z: along ? mz + 3 : mz + 4.6, rot }),
        );
      } else if (r < 0.4) {
        // Walk-through container with crate steps onto its roof + a crate pile.
        add(...container({ x: mx, z: mz, rot }, 'ends'));
        const side = rot === 0 ? { x: mx - 4.9, z: mz } : { x: mx, z: mz + 4.9 };
        // Steps climb along local +X, towards the container (east for 0°, north for 90°).
        add(...crateSteps({ ...side, rot: rot === 0 ? 0 : 90 }));
        add(...pileAt({ x: rot === 0 ? mx + 2 : mx + 2.8, z: rot === 0 ? mz + 3 : mz - 2 }));
      } else if (r < 0.55) {
        // Two-high container stack you can climb (quick exposed vertical).
        add(...climbStack({ x: mx + 0.45, z: mz - 1.2, rot }));
      } else if (r < 0.72) {
        // Food truck, tables, crates.
        add(...foodTruck({ x: mx, z: mz - 1.5, rot }));
        add(
          ...table({ x: mx - 2.5, z: mz + 2.8, rot: 0 }),
          ...table({ x: mx + 1.5, z: mz + 3, rot: 90 }),
        );
        add(...crate({ x: mx + 3.4, z: mz + 1.2 }));
      } else if (r < 0.86) {
        // Stall L with a pallet stack and a crate pile inside the corner.
        add(
          ...stall({ x: mx - 2, z: mz - 3, rot: 180 }),
          ...stall({ x: mx + 1.4, z: mz - 3, rot: 180 }),
        );
        add(...stall({ x: mx - 3.5, z: mz + 0.6, rot: 270 }));
        add(...pallet({ x: mx + 1, z: mz + 1 }), ...pileAt({ x: mx + 2.5, z: mz + 2.5 }));
      } else {
        // Breathing space: planter + sandbag arc (still cover every few metres).
        add(...planter({ x: mx, z: mz }, 2.4));
        add(
          ...sandbags({ x: mx - 3, z: mz + 3, rot: 45 }, 3),
          ...sandbags({ x: mx + 3, z: mz - 3, rot: 45 }, 3),
        );
      }
    }
  }

  // Alley crossings: ~40% get a crate pile or sandbags, so routes twist (seeded).
  row = 0;
  for (let cz = -58; cz < 60; cz += 12, row++) {
    for (const cx of alleyX[row] ?? []) {
      if (cx < 94 || cx > 164 || cz < -56) continue;
      const r = hash(cx, cz, 11);
      if (r > 0.4) continue;
      const spot = R(cx - 1.8, cz - 1.8, cx + 1.8, cz + 1.8);
      if (blocked.some((b) => overlaps(spot, b))) continue;
      add(
        ...(r < 0.2
          ? pileAt({ x: cx - 0.6, z: cz - 0.6 })
          : sandbags({ x: cx, z: cz, rot: r < 0.3 ? 0 : 90 }, 2.6)),
      );
    }
  }

  // Bush clumps at alley corners and in the forecourt: step in and you're hidden (soft cover).
  const foliage: MapFoliage[] = [];
  const bushAt = (x: number, z: number, salt: number): void => {
    const spot = R(x - 1.4, z - 1.4, x + 1.4, z + 1.4);
    if (blocked.some((b) => overlaps(spot, b))) return;
    const r = hash(x, z, salt);
    foliage.push({ x, z, r: 1.2 + r * 0.6, h: 1.5 + r * 0.5, kind: 'bush' });
  };
  row = 0;
  for (let cz = -58; cz < 60; cz += 12, row++) {
    for (const cx of alleyX[row] ?? []) {
      if (cx < 94 || cx > 164) continue;
      if (hash(cx, cz, 21) < 0.45) bushAt(cx + 3.5, cz + 0.2, 22);
      if (hash(cx, cz, 23) < 0.3) bushAt(cx + 0.2, cz + 6, 24);
    }
  }
  for (const [x, z] of [
    [48, -30],
    [48, 30],
    [66, -52],
    [66, 56],
    [82, -8],
    [82, 44],
    [60, 18],
    [60, -20],
  ] as const) {
    bushAt(x, z, 25);
  }

  // ---- compact-size boundary: container wall east, invisible walls all round ---------------------
  const sectionBoxes: MapBox[] = [];
  const B = MARKET_BOUNDS;
  const HH = 300;
  const inv = (x0: number, z0: number, x1: number, z1: number): MapBox =>
    boxMinMax({ x: x0, y: -10, z: z0 }, { x: x1, y: HH, z: z1 }, 'concrete', { visible: false });
  sectionBoxes.push(
    inv(B.minX - 1, B.minZ - 1, B.maxX + 1, B.minZ),
    inv(B.minX - 1, B.maxZ, B.maxX + 1, B.maxZ + 1),
    inv(B.minX - 1, B.minZ, B.minX, B.maxZ),
    inv(B.maxX, B.minZ, B.maxX + 1, B.maxZ),
  );
  for (let z = B.minZ + 3.1; z < B.maxZ - 3; z += 6.2) {
    sectionBoxes.push(...container({ x: B.maxX + 1.25, z, rot: 90 }, 'closed'));
    if (hash(z, 1, 9) < 0.5)
      sectionBoxes.push(...container({ x: B.maxX + 1.25, z, y: 2.59, rot: 90 }, 'closed'));
  }
  for (let x = 92; x < B.maxX; x += 6.2) {
    sectionBoxes.push(...container({ x, z: B.minZ - 1.25, rot: 0 }, 'closed'));
    sectionBoxes.push(...container({ x, z: B.maxZ + 1.25, rot: 0 }, 'closed'));
  }

  const pickups: { pos: Vec3; kind: PickupKind }[] = [
    { pos: { x: HALL.x0 + 18, y: HALL_FLOOR2, z: HALL.z0 + 7 }, kind: 'radar' }, // hall upstairs
    { pos: { x: 105, y: FLOOR, z: 0 }, kind: 'radar' }, // metro ticket hall
    { pos: { x: HALL.x0 + 5, y: 0, z: HALL.z0 + 4 }, kind: 'drone' }, // hall ground floor
    // Medkits (Kiran: no regeneration): spread so every zone has one, a risky one up top.
    { pos: { x: 60, y: 0, z: -40 }, kind: 'medkit' }, // south-west stalls
    { pos: { x: 56, y: 0, z: 42 }, kind: 'medkit' }, // north-west
    { pos: { x: 88, y: 0, z: -12 }, kind: 'medkit' }, // centre
    { pos: { x: 108, y: 0, z: 32 }, kind: 'medkit' }, // north-centre
    { pos: { x: HALL.x0 + 18, y: 0, z: HALL.z0 + 10 }, kind: 'medkit' }, // hall ground floor
    { pos: { x: 124, y: 0, z: -20 }, kind: 'medkit' }, // south-east
    { pos: { x: 152, y: 0, z: 48 }, kind: 'medkit' }, // north-east
    { pos: { x: 138, y: 2.59, z: -42 }, kind: 'medkit' }, // container roof (crate stairs)
  ];
  return { boxes, openings, keepClear, pickups, sectionBoxes, foliage };
}

export const MARKET_RECT = rectPoly(
  MARKET_BOUNDS.minX,
  MARKET_BOUNDS.minZ,
  MARKET_BOUNDS.maxX,
  MARKET_BOUNDS.maxZ,
);
