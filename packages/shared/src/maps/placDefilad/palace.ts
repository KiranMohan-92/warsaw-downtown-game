/**
 * Palace of Culture and Science — authored massing inside the real OSM footprint (OSM has one
 * 237 m outline and no tiers). Recognisable silhouette, gameplay first:
 * - stepped tower on the central block, spire to 237 m (the landmark you navigate by);
 * - Congress Hall half-circle to the west;
 * - the north-east wing's ground floor is an enterable hall (four doors, rooms, a stair down to
 *   the service tunnel);
 * - both courtyards are reachable through two 5 m passages each (≥2 approaches);
 * - a recessed east portico with columns; renovation scaffolds lead up to the 16 m wing roofs
 *   (exposed routes only).
 */
import { block } from '../builder.ts';
import { convexDecompose, pointInPolygon, rectPoly, type Pt } from '../geom.ts';
import { scaffold } from '../props.ts';
import { carve, R, rectToPoly, tier, toPrisms, type Rect, type Solid } from '../solids.ts';
import type { MapBox, MapPrism } from '../types.ts';

export const PALACE_TINT = 0xd9c9a6; // warm sandstone

/** The NE wing hall (ground floor). */
export const NE_HALL: Rect = R(51, -122, 80, -70);
export const HALL_HEIGHT = 5;
/** Stair from the hall down to the service tunnel (opening in the hall floor). */
export const HALL_STAIR_TOP = { x: 78, z: -112 };

export interface PalaceBuild {
  prisms: MapPrism[];
  boxes: MapBox[];
  /** Courtyard/passages/hall rects — ground that must stay free (trees, props). */
  keepClear: Rect[];
}

export function buildPalace(outer: readonly Pt[], holes: readonly (readonly Pt[])[]): PalaceBuild {
  const pieces = convexDecompose(outer, holes);
  const cx = 0;
  const cz = 0;
  const sq = (h: number): Rect => R(cx - h, cz - h, cx + h, cz + h);

  // ---- massing tiers (y0..y1 stacked) ----
  let solids: Solid[] = [
    ...tier(pieces, null, 0, 16), // wings and body
    ...tier(pieces, rectPoly(-130, -45, -86, 45), 16, 24), // Congress Hall
    ...tier(pieces, rectPoly(-34, -65, 37, 65), 16, 34), // central block
    ...tier(pieces, rectPoly(37, -22, 53, 20), 16, 22), // east entrance projection
    ...tier(pieces, rectToPoly(R(-30, -40, 30, 40)), 34, 62),
  ];
  const towerTiers: [number, number, number][] = [
    [21, 62, 110],
    [17, 110, 140],
    [13.5, 140, 165],
    [10, 165, 188],
    [5, 188, 205],
    [3, 205, 220],
    [1.2, 220, 237],
  ];
  for (const [h, y0, y1] of towerTiers) solids.push({ pts: rectToPoly(sq(h)), y0, y1 });

  // ---- NE wing hall + doors ----
  const hallPoly = rectToPoly(NE_HALL);
  for (const c of hallPoly) {
    if (!pointInPolygon(c, outer))
      throw new Error(`palace: NE hall corner ${c.join(',')} outside footprint`);
  }
  solids = carve(solids, hallPoly, 0, HALL_HEIGHT);
  const doors: Rect[] = [
    R(44, -100, 53, -95), // west → north square
    R(78, -104, 92, -99), // east → Plac Defilad
    R(60, -137, 65, -120), // north → park side
    R(62, -72, 67, -50), // south → east lawn
  ];
  for (const d of doors) solids = carve(solids, rectToPoly(d), 0, 3.2);

  // ---- courtyard passages (5 m tall) ----
  const passages: Rect[] = [
    R(-46, -80, -40, -62), // north courtyard → north square
    R(-92, -56, -67, -50), // north courtyard → west facade
    R(-46, 62, -40, 80), // south courtyard → south square
    R(-92, 48, -66, 54), // south courtyard → west facade
  ];
  for (const p of passages) solids = carve(solids, rectToPoly(p), 0, 5);

  // ---- east portico: recess the entrance (columns added as boxes) ----
  const porch = R(44, -18, 54, 16);
  solids = carve(solids, rectToPoly(porch), 0, 12);

  const prisms = toPrisms(solids, 'facade', { tint: PALACE_TINT, top: 'concrete' });

  // ---- boxes: portico columns, hall interior, scaffolds ----
  const boxes: MapBox[] = [];
  for (let z = -15; z <= 13; z += 4) {
    boxes.push({ ...block(51.5, z, 0, 1.3, 12, 1.3, 'facade'), tint: PALACE_TINT });
  }
  // Hall: two rows of columns, partition walls with gaps (twists and turns), cover crates.
  for (let x = 57; x <= 75; x += 6) {
    for (const z of [-110, -84]) {
      boxes.push({ ...block(x, z, 0, 0.9, HALL_HEIGHT, 0.9, 'facade'), tint: PALACE_TINT });
    }
  }
  const wallZ = -96;
  boxes.push(block(58, wallZ, 0, 14, 3.2, 0.3, 'plaster')); // x 51..65, gap 65..70
  boxes.push(block(75, wallZ, 0, 10, 3.2, 0.3, 'plaster')); // x 70..80
  boxes.push(block(66, -114, 0, 0.3, 3.2, 16, 'plaster')); // north rooms divider (z -122..-106)
  boxes.push(block(62, -80, 0, 0.3, 3.2, 12, 'plaster')); // south divider (z -86..-74)
  for (const [x, z] of [
    [55, -118],
    [70, -102],
    [76, -88],
    [56, -76],
    [69, -76],
  ] as const) {
    boxes.push(block(x, z, 0, 1.2, 1.1, 1.2, 'wood'));
  }
  // Renovation scaffolds up to the 16 m wing roofs (exposed climbs, one per half of the map).
  boxes.push(...scaffold({ x: 85.35, z: -96, rot: 270 }, 15, 4));
  boxes.push(...scaffold({ x: 87.3, z: 92, rot: 270 }, 15, 4));

  const keepClear: Rect[] = [
    ...passages,
    porch,
    NE_HALL,
    ...doors,
    R(-70, -66, -33, -32),
    R(-69, 33, -33, 67),
    // Courtyard exits out to the north/south squares: routes, never walled off by cover fill.
    R(-47, -92, -39, -66),
    R(-47, 67, -39, 92),
  ];
  return { prisms, boxes, keepClear };
}
