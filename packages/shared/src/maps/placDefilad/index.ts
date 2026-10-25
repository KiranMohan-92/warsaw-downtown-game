/**
 * Plac Defilad — the real block around the Palace of Culture and Science at 1:1 (M2).
 *
 * Base layer: OpenStreetMap (tools/osm/build-map.ts → osm.gen.json, ODbL). Gameplay layer on top
 * (Kiran: real Warsaw as the base, customised for fights): a market on Plac Defilad, a
 * construction site with an open concrete skeleton and a pit, containers, stalled trams and buses
 * breaking the long boulevards, hedges, an underpass + car park (south) and a service tunnel
 * (north), the enterable Palace wing and courtyards, and scaffolds to the Palace roofs.
 *
 * Frame: +X ≈ east along Świętokrzyska, +Z ≈ south along Marszałkowska, origin at the Palace.
 * Map sizes: full block, or the north/south halves split along the Złota line.
 */
import { block, boxMinMax, ramp } from '../builder.ts';
import { area, clipConvex, rectPoly, subtractAll, type Poly, type Pt } from '../geom.ts';
import {
  bus,
  cabin,
  car,
  container,
  crowdBarrier,
  fence,
  hedge,
  jersey,
  kiosk,
  pallet,
  pipeStack,
  planter,
  scaffold,
  shelter,
  tram,
} from '../props.ts';
import { R, rectToPoly, stairDown, underground, type Rect } from '../solids.ts';
import type {
  DummyDef,
  MapFoliage,
  MapBox,
  MapDefinition,
  MapFlat,
  MapPrism,
  MapSection,
  MapTree,
  PickupKind,
} from '../types.ts';
import type { Vec3 } from '../../math/vec3.ts';
import osmData from './osm.gen.json' with { type: 'json' };
import { coverFill } from '../coverFill.ts';
import { scatterDecor } from '../decor.ts';
import {
  buildMarketQuarter,
  MARKET_BOUNDS,
  MARKET_HALL,
  TRUCK_LANE_JUNCTIONS,
  TRUCK_LANES,
  TRUCK_LANES_CLEAR,
} from './market.ts';
import { buildPalace, HALL_STAIR_TOP } from './palace.ts';

interface OsmData {
  attribution: string;
  streets: {
    marszalkowskaX: number;
    platerX: number;
    swietokrzyskaZ: number;
    jerozolimskieZ: number;
    zlotaZ: number;
  };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  palace: { outer: Pt[]; holes: Pt[][] };
  prisms: (Omit<MapPrism, 'mat' | 'top'> & { mat: string; top?: string })[];
  flats: (Omit<MapFlat, 'mat'> & { mat: string })[];
  trees: MapTree[];
  foliage: MapFoliage[];
}
const osm = osmData as unknown as OsmData;

export const DEFILAD_CUT_Z = Math.round(osm.streets.zlotaZ);
/** Max distance (m) from any street spot to cover after the cover-fill pass. */
export const COVER_GAP = 6;
/** Tighter still inside the compact Market quarter (Shipment-style density). */
export const MARKET_COVER_GAP = 4;
const FLOOR = -5;
const SLAB = -0.5;

let cached: MapDefinition | null = null;

/** Build (once) the full Plac Defilad map definition. Spawns are generated per size at load. */
export function placDefilad(): MapDefinition {
  cached ??= build();
  return cached;
}

function build(): MapDefinition {
  const B = osm.bounds;
  const S = osm.streets;
  const boxes: MapBox[] = [];
  const openings: Rect[] = [];
  const keepClear: Rect[] = [];
  const add = (...b: MapBox[]): void => {
    boxes.push(...b);
  };

  // ---- Palace -------------------------------------------------------------------------------------
  const palace = buildPalace(osm.palace.outer, osm.palace.holes);
  add(...palace.boxes);
  keepClear.push(...palace.keepClear);

  // ---- underground: south (underpass + car park) ---------------------------------------------------
  const southRooms: Rect[] = [
    R(226, 62, 236, 212), // Centrum underpass (under the east pavement)
    R(236, 196, 245, 204), // branch to the east stair
    R(160, 78, 222, 170), // car park under the plaza
    R(222, 124, 226, 130), // car park ↔ underpass door
  ];
  // Every stairwell's footprint joins the underground space (so no tunnel wall can cut across
  // the steps), and becomes an opening in the street slab.
  const southStairs = [
    stairDown(231, 62, '+z', FLOOR, 6),
    stairDown(231, 212, '-z', FLOOR, 6),
    stairDown(252, 200, '-x', FLOOR, 6),
    stairDown(164, 78, '+z', FLOOR, 4),
  ];
  const rampOpening = R(187, 148, 195, 168.4);
  add(
    ...underground([...southRooms, ...southStairs.map((s) => s.opening), rampOpening], FLOOR, SLAB),
  );
  for (const s of southStairs) {
    add(...s.boxes);
    openings.push(s.opening);
  }
  // Vehicle ramp into the car park (20 m at 14°), with rails.
  add(ramp({ x: 191, y: FLOOR, z: 148 }, '+z', 20, -FLOOR, 8, 'concrete'));
  openings.push(rampOpening);
  add(boxMinMax({ x: 186.9, y: 0, z: 148 }, { x: 187, y: 1, z: 168.4 }, 'metal'));
  add(boxMinMax({ x: 195, y: 0, z: 148 }, { x: 195.1, y: 1, z: 168.4 }, 'metal'));
  add(boxMinMax({ x: 187, y: 0, z: 147.9 }, { x: 195, y: 1, z: 148 }, 'metal'));
  // Car park pillars (9 m grid) and a few parked cars below.
  for (let x = 168; x < 220; x += 9) {
    for (let z = 90; z < 168; z += 9) {
      const inRamp = x > 184 && x < 198 && z > 144;
      const inStair = x < 169 && z < 90;
      if (!inRamp && !inStair) add(block(x, z, FLOOR, 0.8, -FLOOR + SLAB, 0.8, 'concrete'));
    }
  }
  for (const [x, z, r] of [
    [172.5, 96, 90],
    [181.5, 105, 90],
    [204, 96, 90],
    [213, 123, 90],
    [177, 141, 90],
    [208, 150, 90],
  ] as const) {
    add(...car({ x, z, y: FLOOR, rot: r }));
  }

  // ---- underground: north (service tunnel) --------------------------------------------------------
  const northRooms: Rect[] = [
    R(0, -146, 150, -140), // main tunnel
    R(1, -146, 7, -127), // up to the north square stair
    R(56.5, -206, 61.5, -146), // branch to the park
    R(76.5, -146, 79.5, -118), // up into the Palace NE hall
    R(110, -158, 150, -128), // construction pit (open to the sky)
  ];
  const northStairs = [
    stairDown(4, -120, '-z', FLOOR, 5),
    stairDown(59, -213, '+z', FLOOR, 5),
    stairDown(HALL_STAIR_TOP.x, HALL_STAIR_TOP.z, '-z', FLOOR, 3),
  ];
  add(...underground([...northRooms, ...northStairs.map((s) => s.opening)], FLOOR, SLAB));
  for (const s of northStairs) {
    add(...s.boxes);
    openings.push(s.opening);
  }
  openings.push(R(110, -158, 150, -128)); // the pit itself: no slab above
  add(ramp({ x: 130, y: FLOOR, z: -154 }, '+x', 20, -FLOOR, 5, 'concrete')); // pit ramp
  // Pit edge rails except at the ramp top and along the north edge (jump-down spots).
  add(boxMinMax({ x: 110, y: 0, z: -158.1 }, { x: 150, y: 1, z: -158 }, 'metal'));
  add(boxMinMax({ x: 109.9, y: 0, z: -158 }, { x: 110, y: 1, z: -140 }, 'metal'));
  add(boxMinMax({ x: 150, y: 0, z: -151 }, { x: 150.1, y: 1, z: -128 }, 'metal'));
  for (const [x, z] of [
    [118, -134],
    [140, -136],
    [122, -150],
  ] as const) {
    add(...pallet({ x, z, y: FLOOR }));
  }
  add(...container({ x: 128, z: -134, y: FLOOR, rot: 0 }, 'ends'));

  // ---- construction site (north-east, where the real theatre is being built) -----------------------
  // Open concrete skeleton: 3 slabs, columns, reached by an exposed scaffold stair.
  const skel = R(158, -185, 192, -160);
  for (const y of [4, 8, 12]) {
    add(
      boxMinMax({ x: skel.x0, y: y - 0.3, z: skel.z0 }, { x: skel.x1, y, z: skel.z1 }, 'concrete'),
    );
  }
  for (let i = 0; i <= 4; i++) {
    const x = Math.min(
      skel.x1 - 0.3,
      Math.max(skel.x0 + 0.3, skel.x0 + ((skel.x1 - skel.x0) * i) / 4),
    );
    for (const z of [skel.z0 + 0.3, (skel.z0 + skel.z1) / 2, skel.z1 - 0.3]) {
      add(block(x, z, 0, 0.6, 11.7, 0.6, 'concrete'));
    }
  }
  // Half-built walls on the upper floors (cover up high).
  add(block(166, -178, 4, 8, 1.1, 0.3, 'concrete'), block(184, -168, 8, 0.3, 1.1, 8, 'concrete'));
  add(block(172, -165, 12, 6, 1.1, 0.3, 'concrete'));
  add(...scaffold({ x: 170, z: -158.75, rot: 180 }, 20, 3)); // open side (+Z local) faces the slabs
  keepClear.push(R(156, -187, 196, -155));
  // Crane (landmark) and site clutter.
  add(block(150, -178, 0, 4, 1.2, 4, 'concrete'), block(150, -178, 1.2, 1.8, 38, 1.8, 'metal'));
  add({ center: { x: 162, y: 39.7, z: -178 }, size: { x: 34, y: 1.2, z: 1.2 }, mat: 'metal' });
  add(
    ...fence({ x: 149, z: -191, rot: 0 }, 98, [
      [20, 26],
      [70, 75],
    ]),
  );
  add(...fence({ x: 100, z: -143, rot: 90 }, 96, [[40, 46]]));
  add(
    ...fence({ x: 149, z: -95, rot: 0 }, 98, [
      [45, 52],
      [85, 90],
    ]),
  );
  add(...fence({ x: 198, z: -167, rot: 90 }, 48, [[10, 16]]));
  add(...cabin({ x: 112, z: -104, rot: 0 }), ...cabin({ x: 119, z: -104, rot: 0 }));
  add(block(115.5, -104, 2.6, 13, 2.6, 2.4, 'accent')); // stacked cabins (upper, closed)
  add(...container({ x: 172, z: -120, rot: 0 }, 'ends'));
  add(...container({ x: 172, z: -123.5, rot: 0 }, 'closed'));
  add(...container({ x: 172, z: -123.5, y: 2.59, rot: 0 }, 'closed'));
  add(...container({ x: 188, z: -112, rot: 90 }, 'side'));
  add(
    ...container({ x: 132, z: -102, rot: 0 }, 'closed'),
    ...container({ x: 132, z: -102, y: 2.59, rot: 0 }, 'closed'),
  );
  add(...pipeStack({ x: 156, z: -130, rot: 90 }), ...pipeStack({ x: 110, z: -120, rot: 0 }, 6, 2));
  for (const [x, z] of [
    [145, -112],
    [147, -114],
    [160, -106],
    [183, -135],
    [106, -170],
    [125, -178],
    [138, -172],
  ] as const) {
    add(...pallet({ x, z }));
  }

  // ---- Plac Defilad: the dense Market quarter (also the compact "Market" map size) -------------
  const market = buildMarketQuarter();
  add(...market.boxes);
  openings.push(...market.openings);
  keepClear.push(...market.keepClear);
  // East of the quarter: cars and containers towards Marszałkowska.
  for (const [x, z, r, w] of [
    [196, 14, 80, false],
    [184, -40, 100, true],
    [190, 48, 10, false],
  ] as const) {
    add(...car({ x, z, rot: r }, w));
  }
  add(
    ...container({ x: 196, z: -30, rot: 90 }, 'ends'),
    ...container({ x: 196, z: 36, rot: 90 }, 'side'),
  );
  // Bus station and car rows above the car park.
  add(...bus({ x: 176, z: 104, rot: 90 }), ...bus({ x: 184, z: 118, rot: 90 }, true));
  for (const z of [132, 145, 158]) {
    for (let x = 172; x <= 232; x += 6.5) {
      if ((Math.round(x) + z) % 4 === 1) continue;
      if (x > 184 && x < 198 && z > 140) continue; // car-park ramp
      add(...car({ x, z, rot: 90 }, (Math.round(x) + z) % 7 === 0));
    }
  }

  // ---- north square (between the Palace's north wings) --------------------------------------------
  add(
    ...container({ x: -24, z: -98, rot: 0 }, 'ends'),
    ...container({ x: 22, z: -112, rot: 90 }, 'ends'),
  );
  add(...jersey({ x: -8, z: -88, rot: 0 }, 8), ...jersey({ x: 20, z: -90, rot: 20 }, 6));
  for (const [x, z] of [
    [-38, -118],
    [-30, -84],
    [30, -84],
    [-12, -126],
    [28, -126],
  ] as const) {
    add(...planter({ x, z }));
  }
  add(...car({ x: -36, z: -104, rot: 80 }, true));

  // ---- south square --------------------------------------------------------------------------------
  add(
    ...container({ x: -20, z: 104, rot: 90 }, 'side'),
    ...container({ x: 18, z: 96, rot: 0 }, 'ends'),
  );
  add(...kiosk({ x: -2, z: 120, rot: 0 }), ...kiosk({ x: 30, z: 124, rot: 0 }));
  add(...car({ x: -34, z: 88, rot: 95 }), ...car({ x: 4, z: 86, rot: 10 }, true));
  add(...jersey({ x: 10, z: 110, rot: 90 }, 8));

  // ---- west side (between the Palace and Emilii Plater) --------------------------------------------
  for (const [x, z, r] of [
    [-110, -140, 90],
    [-104, -30, 90],
    [-106, 70, 90],
    [-110, 160, 90],
  ] as const) {
    add(...car({ x, z, rot: r }, z % 20 === 0));
  }
  add(
    ...container({ x: -140, z: -60, rot: 90 }, 'ends'),
    ...container({ x: -142.6, z: -60, rot: 90 }, 'closed'),
  );
  add(...container({ x: -140, z: 110, rot: 90 }, 'side'));
  add(...hedge({ x: -135, z: -200, rot: 90 }, 30), ...hedge({ x: -130, z: 30, rot: 90 }, 24));
  add(...hedge({ x: -135, z: 200, rot: 90 }, 20));

  // ---- parks: hedge rooms (north park and south gardens) -------------------------------------------
  for (const [x, z, r, len] of [
    [-60, -250, 0, 26],
    [-30, -262, 90, 18],
    [10, -240, 0, 22],
    [40, -270, 90, 20],
    [90, -236, 0, 24],
    [130, -262, 90, 16],
    [170, -230, 0, 20],
    [-100, -230, 90, 22],
    [-80, 210, 0, 22],
    [-20, 225, 90, 16],
    [80, 212, 0, 24],
    [120, 240, 90, 18],
    [160, 205, 0, 18],
    [-110, 262, 0, 20],
  ] as const) {
    add(...hedge({ x, z, rot: r }, len));
  }
  add(...kiosk({ x: 0, z: -222, rot: 0 }), ...kiosk({ x: 150, z: 280, rot: 0 }));

  // ---- streets: break the long boulevards, close the ends -----------------------------------------
  const mx = S.marszalkowskaX;
  for (const z of [-270, -130, 45, 170, 300]) add(...tram({ x: mx, z, rot: 90 }));
  for (const [dx, z, burnt] of [
    [-10, -205, false],
    [10, -60, true],
    [-10, 110, false],
    [10, 235, true],
  ] as const) {
    add(...bus({ x: mx + dx, z, rot: 90 }, burnt));
  }
  for (const z of [-310, -170, -20, 80, 205, 330]) {
    add(
      ...car({ x: mx - 13, z, rot: 92 }, z % 3 === 0),
      ...car({ x: mx + 13, z: z + 18, rot: 268 }),
    );
  }
  for (const z of [-95, 140])
    add(...jersey({ x: mx - 6, z, rot: 60 }, 6), ...jersey({ x: mx + 6, z: z + 6, rot: -60 }, 6));
  add(
    ...tram({ x: mx, z: B.minZ + 8, rot: 90 }, true),
    ...tram({ x: mx, z: B.maxZ - 8, rot: 90 }, true),
  );
  const px = S.platerX;
  for (const [z, kind] of [
    [-250, 'bus'],
    [-170, 'car'],
    [-80, 'bus'],
    [60, 'car'],
    [150, 'bus'],
    [250, 'car'],
  ] as const) {
    if (kind === 'bus') add(...bus({ x: px + (z % 20 === 0 ? -3 : 3), z, rot: 90 }, z < 0));
    else add(...car({ x: px - 3, z, rot: 90 }), ...car({ x: px + 3, z: z + 9, rot: 275 }, true));
  }
  add(
    ...bus({ x: px, z: B.minZ + 9, rot: 75 }, true),
    ...bus({ x: px, z: B.maxZ - 9, rot: 105 }, true),
  );
  const sz = S.swietokrzyskaZ;
  for (const [x, kind] of [
    [-120, 'bus'],
    [-30, 'car'],
    [60, 'bus'],
    [150, 'car'],
    [220, 'bus'],
  ] as const) {
    if (kind === 'bus') add(...bus({ x, z: sz + (x % 20 === 0 ? -4 : 4), rot: 0 }, x > 100));
    else add(...car({ x, z: sz - 4, rot: 3 }, true), ...car({ x: x + 10, z: sz + 4, rot: 178 }));
  }
  const jz = S.jerozolimskieZ;
  for (const x of [-110, 60, 200]) add(...tram({ x, z: jz, rot: 0 }));
  for (const [x, burnt] of [
    [-40, true],
    [130, false],
  ] as const) {
    add(...bus({ x, z: jz - 11, rot: 0 }, burnt));
  }
  for (const x of [-150, 10, 100, 250])
    add(...car({ x, z: jz + 12, rot: 180 }), ...car({ x: x + 14, z: jz - 12, rot: 2 }, x > 200));
  // Street ends: derailed trams/burnt buses already cap Marszałkowska & Plater; cap the E–W streets.
  for (const x of [B.minX + 8, B.maxX - 8]) {
    add(...bus({ x, z: sz, rot: 88 }, true));
    add(...tram({ x, z: jz, rot: 0 }, true));
  }
  for (const z of [S.zlotaZ, 135]) {
    for (let k = -2; k <= 2; k++) {
      add(...crowdBarrier({ x: B.minX + 3, z: z + k * 2.6, rot: 90 }));
      add(...crowdBarrier({ x: B.maxX - 3, z: z + k * 2.6, rot: 90 }));
    }
  }
  // Tram/bus shelters along the boulevards (glass back = see-through-ish cover).
  for (const z of [-240, -40, 190]) add(...shelter({ x: mx - 18, z, rot: 90 }));
  for (const x of [-60, 120]) add(...shelter({ x, z: jz - 19, rot: 180 }));

  // ---- invisible world bounds ---------------------------------------------------------------------
  const H = 300;
  const wall = (x0: number, z0: number, x1: number, z1: number): MapBox =>
    boxMinMax({ x: x0, y: -10, z: z0 }, { x: x1, y: H, z: z1 }, 'concrete', { visible: false });
  add(
    wall(B.minX - 2, B.minZ - 2, B.maxX + 2, B.minZ),
    wall(B.minX - 2, B.maxZ, B.maxX + 2, B.maxZ + 2),
    wall(B.minX - 2, B.minZ, B.minX, B.maxZ),
    wall(B.maxX, B.minZ, B.maxX + 2, B.maxZ),
  );

  // ---- prisms: OSM buildings + Palace + street slab (with openings) --------------------------------
  const prisms: MapPrism[] = osm.prisms.map((p) => ({
    ...p,
    mat: p.mat as MapPrism['mat'],
    top: p.top as MapPrism['top'],
  }));
  prisms.push(...palace.prisms);
  // Street slab: 64 m tiles around the playable area (short pieces, good culling chunks), one
  // big ring beyond for the horizon. Openings are snapped outward to 0.5 m so near-coincident
  // edges merge instead of leaving centimetre slivers.
  const snap = (r: Rect): Rect =>
    R(
      Math.floor(r.x0 * 2) / 2,
      Math.floor(r.z0 * 2) / 2,
      Math.ceil(r.x1 * 2) / 2,
      Math.ceil(r.z1 * 2) / 2,
    );
  const holes = openings.map((o) => rectToPoly(snap(o)));
  const T = 64;
  const inner = R(
    Math.floor((B.minX - 100) / T) * T,
    Math.floor((B.minZ - 100) / T) * T,
    Math.ceil((B.maxX + 100) / T) * T,
    Math.ceil((B.maxZ + 100) / T) * T,
  );
  const slab = (pts: Poly): MapPrism => ({
    pts,
    y0: SLAB,
    y1: 0,
    mat: 'concrete',
    top: 'sidewalk',
  });
  for (let x = inner.x0; x < inner.x1; x += T) {
    for (let z = inner.z0; z < inner.z1; z += T) {
      const tile = rectPoly(x, z, x + T, z + T);
      const hit = holes.filter((h) => area(clipConvex(tile, h)) > 0.01);
      for (const p of hit.length ? subtractAll([tile], hit) : [tile]) prisms.push(slab(p));
    }
  }
  const far = 900;
  prisms.push(
    slab(rectPoly(inner.x0 - far, inner.z0 - far, inner.x1 + far, inner.z0)),
    slab(rectPoly(inner.x0 - far, inner.z1, inner.x1 + far, inner.z1 + far)),
    slab(rectPoly(inner.x0 - far, inner.z0, inner.x0, inner.z1)),
    slab(rectPoly(inner.x1, inner.z0, inner.x1 + far, inner.z1)),
  );

  // ---- flats: keep road/grass markings out of the openings ----------------------------------------
  const flats: MapFlat[] = [];
  // Indoor floors cover their footprint (the lawn under the market hall would win the depth
  // offset markings get and show through its terrazzo).
  const indoor = [rectToPoly(MARKET_HALL)];
  for (const f of osm.flats) {
    const hit = [...holes, ...indoor].filter((h) => area(clipConvex(f.pts, h)) > 0.01);
    const pieces: Poly[] = hit.length ? subtractAll([f.pts], hit) : [f.pts];
    for (const p of pieces) flats.push({ ...f, pts: p, mat: f.mat as MapFlat['mat'] });
  }

  // ---- trees: drop any that clash with authored geometry, openings, routes -------------------------
  // Truck lanes too: no trunk stands in one.
  const clear = [...keepClear, ...openings, ...TRUCK_LANES_CLEAR];
  const boxAabbs = boxes
    .filter((b) => b.collide !== false && b.visible !== false && b.center.y - b.size.y / 2 < 3)
    .map((b) => {
      const r = Math.hypot(b.size.x, b.size.z) / 2;
      return R(b.center.x - r, b.center.z - r, b.center.x + r, b.center.z + r);
    });
  const trees = osm.trees.filter((t) => {
    const inRect = (r: Rect, m: number): boolean =>
      t.x > r.x0 - m && t.x < r.x1 + m && t.z > r.z0 - m && t.z < r.z1 + m;
    return !clear.some((r) => inRect(r, 1.5)) && !boxAabbs.some((r) => inRect(r, 0.6));
  });
  // Bushes/tall grass: same rules (not in openings, routes, or clipping through props).
  let foliage = osm.foliage.filter((f) => {
    const inRect = (r: Rect, m: number): boolean =>
      f.x > r.x0 - m && f.x < r.x1 + m && f.z > r.z0 - m && f.z < r.z1 + m;
    return !clear.some((r) => inRect(r, f.r)) && !boxAabbs.some((r) => inRect(r, f.r * 0.7));
  });

  // The quarter's own bushes stay out of the truck lanes as well.
  foliage.push(
    ...market.foliage.filter(
      (f) =>
        !TRUCK_LANES_CLEAR.some(
          (r) => f.x > r.x0 - f.r && f.x < r.x1 + f.r && f.z > r.z0 - f.r && f.z < r.z1 + f.r,
        ),
    ),
  );

  // ---- cover fill (Kiran: too open, we lose each other) -----------------------------------------------
  // ---- practice dummies on the plaza (removed when M3 brings real opponents) -----------------------
  const dummies: DummyDef[] = [
    { id: 'pd1', pos: { x: 76, y: 0, z: -8 }, yaw: Math.PI / 2 },
    { id: 'pd2', pos: { x: 92, y: 0, z: 22 }, yaw: Math.PI / 2 },
    {
      id: 'pd3',
      pos: { x: 90.6, y: 0, z: -12 },
      yaw: Math.PI / 2,
      path: { to: { x: 90.6, y: 0, z: 6 }, speed: 2.5 },
    },
    { id: 'pd4', pos: { x: -20, y: 0, z: -100 }, yaw: 0 },
  ];

  // Uplinks: contested spots (exposed or deep) that pull players together. Radar uplinks give a
  // radar charge (call in with T); drone uplinks give a recon-drone charge (launch with B).
  const uplinks: { pos: Vec3; kind: PickupKind }[] = [
    ...market.pickups,
    { pos: { x: 175, y: 12, z: -172 }, kind: 'radar' }, // construction skeleton, top floor
    { pos: { x: -5, y: 0, z: -110 }, kind: 'radar' }, // north square
    { pos: { x: 66, y: 0, z: -100 }, kind: 'radar' }, // Palace north-east hall
    { pos: { x: 231, y: -5, z: 140 }, kind: 'radar' }, // Centrum underpass
    { pos: { x: 0, y: 0, z: 230 }, kind: 'radar' }, // south gardens
    { pos: { x: -140, y: 0, z: -40 }, kind: 'radar' }, // west side, by the containers
    { pos: { x: -100, y: 0, z: -250 }, kind: 'drone' }, // north park
    { pos: { x: 140, y: 0, z: -120 }, kind: 'drone' }, // construction site
    { pos: { x: -150, y: 0, z: 150 }, kind: 'drone' }, // west side, south
    { pos: { x: 180, y: 0, z: 250 }, kind: 'drone' }, // south gardens, east
  ];

  const protect = [
    // Uplink spots stay walkable (never under a cover piece).
    ...uplinks.map((u) => R(u.pos.x - 2, u.pos.z - 2, u.pos.x + 2, u.pos.z + 2)),
    // Practice dummies (and their patrol lines) stay in the open.
    ...dummies.map((d) =>
      R(
        Math.min(d.pos.x, d.path?.to.x ?? d.pos.x) - 2,
        Math.min(d.pos.z, d.path?.to.z ?? d.pos.z) - 2,
        Math.max(d.pos.x, d.path?.to.x ?? d.pos.x) + 2,
        Math.max(d.pos.z, d.path?.to.z ?? d.pos.z) + 2,
      ),
    ),
    // Doors, passages, courtyards, hall: plus a 3 m apron so nothing lands in front of them.
    ...keepClear.map((r) => R(r.x0 - 3, r.z0 - 3, r.x1 + 3, r.z1 + 3)),
    // Stair/ramp openings plus room to reach their top edge.
    ...openings.map((r) => R(r.x0 - 2.5, r.z0 - 2.5, r.x1 + 2.5, r.z1 + 2.5)),
  ];
  // 1. The Market quarter: dense (≤ 4 m to cover anywhere).
  const marketFill = coverFill({
    bounds: MARKET_BOUNDS,
    boxes,
    prisms,
    trees,
    foliage,
    keepClear: [...protect, ...TRUCK_LANE_JUNCTIONS],
    // Cover goes beside the truck lanes, never in them (and the lanes still count: ≤ 4 m)…
    // …except where they cross (protected like a doorway: nothing can stand in a crossing).
    keepOpen: TRUCK_LANES_CLEAR,
    maxGap: MARKET_COVER_GAP,
    seed: 11,
  });
  boxes.push(...marketFill.boxes);
  // 2. Everywhere else on the block: ≤ 6 m to cover.
  const filled = coverFill({
    bounds: B,
    boxes,
    prisms,
    trees,
    foliage,
    keepClear: [
      ...protect,
      R(MARKET_BOUNDS.minX, MARKET_BOUNDS.minZ, MARKET_BOUNDS.maxX, MARKET_BOUNDS.maxZ),
    ],
    maxGap: COVER_GAP,
  });
  boxes.push(...filled.boxes);
  const fillAabbs = [...marketFill.boxes, ...filled.boxes].map((b) => {
    const r = Math.hypot(b.size.x, b.size.z) / 2;
    return R(b.center.x - r, b.center.z - r, b.center.x + r, b.center.z + r);
  });
  foliage = foliage.filter(
    (f) => !fillAabbs.some((r) => f.x > r.x0 && f.x < r.x1 && f.z > r.z0 && f.z < r.z1),
  );

  // ---- street dressing in the Market (bins, drums, lamps…; colliders match the models) ---------
  const decor = scatterDecor({
    bounds: MARKET_BOUNDS,
    boxes,
    prisms,
    trees,
    foliage,
    keepClear: [...protect, ...TRUCK_LANES_CLEAR],
    seed: 5,
    lampSpacing: 16,
    density: 0.24,
  });

  // ---- map sizes ------------------------------------------------------------------------------------
  const cut = DEFILAD_CUT_Z;
  const cutBoxes: MapBox[] = [
    boxMinMax({ x: B.minX, y: -10, z: cut - 0.3 }, { x: B.maxX, y: H, z: cut + 0.3 }, 'concrete', {
      visible: false,
    }),
  ];
  // Visible barrier line where the cut crosses open ground (west of and east of the Palace).
  for (let x = B.minX + 2; x < B.maxX - 2; x += 4.2) {
    if (x > -127 && x < 54) continue; // inside the Palace
    // Centred on the cut, inside the invisible wall: flush from both halves.
    const at = { x, z: cut, rot: 0 };
    cutBoxes.push(...(Math.round(x) % 3 === 0 ? jersey(at) : crowdBarrier(at)));
  }
  const sections: MapSection[] = [
    {
      id: 'market',
      name: 'Market — close quarters (Palace forecourt + Plac Defilad market)',
      bounds: { ...MARKET_BOUNDS },
      boxes: market.sectionBoxes,
      spawnCount: 10,
    },
    {
      id: 'north',
      name: 'North half — park, construction site, north wings',
      bounds: { ...B, maxZ: cut },
      boxes: cutBoxes,
      spawnCount: 14,
    },
    {
      id: 'south',
      name: 'South half — plaza market, underpass, south gardens',
      bounds: { ...B, minZ: cut },
      boxes: cutBoxes,
      spawnCount: 14,
    },
  ];

  // Generic prop builders also serve the full city. Scan replacement is bounded to the Market.
  const marketModel = (b: MapBox): MapBox => {
    if (
      !b.model ||
      (b.center.x >= MARKET_BOUNDS.minX &&
        b.center.x <= MARKET_BOUNDS.maxX &&
        b.center.z >= MARKET_BOUNDS.minZ &&
        b.center.z <= MARKET_BOUNDS.maxZ)
    )
      return b;
    const { model: _model, ...plain } = b;
    return plain;
  };

  return {
    name: 'Plac Defilad',
    bounds: { ...B },
    boxes: boxes.map(marketModel),
    spawns: [],
    dummies,
    prisms,
    flats,
    trees,
    foliage,
    decor,
    // Radar uplinks: contested spots (exposed or deep) that pull players together.
    pickups: uplinks.map((u, i) => ({ id: `${u.kind}${i + 1}`, pos: u.pos, kind: u.kind })),
    // Secret (Kiran): inside the helicopter wreck's hull, against the rear bulkhead (local
    // x 2.2 of the wreck at (74, 32), rot 160; its floor pitches up toward the rear).
    skateboard: { x: 71.93, y: 2.0, z: 31.25 },
    // Two armored trucks in the forecourt (Kiran: moving cover, fast flanks), parked at the ends of
    // the west edge's truck lane under the Palace facade (out of the through route), facing down
    // it toward the forecourt crossings:
    // both on the main drivable network (`vehicles/driveGraph.ts`, checked in `routes.test.ts`),
    // ≥ 15 m from any player spawn.
    vehicles: [
      { x: 42, z: -50, yaw: 0 },
      { x: 42, z: 50, yaw: Math.PI },
    ],
    truckLanes: TRUCK_LANES,
    // Jetpacks (Kiran: 3 per match, 3 areas): the Palace forecourt's open middle, the stall rows
    // east of the hall, the container blocks on the maze's north-west side. Open sky, ≥ 2 m
    // from anything solid, out of foliage, ≥ 14 m from every spawn, clear of the truck lanes
    // (`jetpackSpots.test.ts` checks all of it on the built map).
    jetpacks: [
      { x: 72, y: 1, z: -8 },
      { x: 139, y: 1, z: -5 },
      { x: 98, y: 1, z: 38 },
    ],
    sections: sections.map((section) => ({ ...section, boxes: section.boxes.map(marketModel) })),
    stats: {
      coverGap: filled.maxGap,
      coverPlaced: filled.placed,
      marketGap: marketFill.maxGap,
      marketPlaced: marketFill.placed,
      coverWorst: filled.worstAt,
      marketWorst: marketFill.worstAt,
    },
    attribution: osm.attribution,
    viewDistance: 1800,
  };
}
