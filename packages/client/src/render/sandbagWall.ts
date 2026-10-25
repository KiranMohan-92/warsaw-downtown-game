/**
 * Sandbag walls as bags: each `sandbag` box (local X = length, 0.95 m high, 0.7 m deep) is drawn
 * up close as courses of individual filled bags — two rows deep, half-bond staggered (half bags at
 * the ends of every other course), pinched tied ends, bags varying in fill, length, set and
 * colour, an uneven top line and the end bags of the upper courses sagging off the wall. Beyond
 * `SANDBAG_LOD_DISTANCE` the plain box (the pillowed-course texture) draws instead.
 *
 * Bags stay within 3 cm of the collision box (what you see is what stops a bullet). Presentation
 * only: deterministic per wall (every client builds the same bags), same on every tier, same
 * material (no new program). Baked lighting: every bag vertex reads the lightmap texel of the box
 * face it faces, so the bags sit in the same occlusion as the box they replace (no re-bake).
 */
import { quatFromEulerDeg, rotateByQuat, type MapBox, type Vec3 } from '@wd/shared';

/** Courses per 0.95 m wall (0.19 m each: plump, slightly squashed bags). */
export const SANDBAG_COURSES = 5;
/** Nominal bag length (m); each course fits a whole number of bags to the wall. */
export const SANDBAG_LENGTH = 0.6;
/** Bags drawn within this distance of a wall chunk; the textured box beyond. */
export const SANDBAG_LOD_DISTANCE = 40;
/** Visual envelope beyond the collision box (m), every side. */
export const SANDBAG_OVERHANG = 0.03;

/**
 * Ring positions along a bag (0..1) and the cross-section scale there: pinched, tied ends that
 * round off into a body bulging gently to the middle (a filled sack, not a straight prism: with
 * only the end rings the body was a flat-sided loaf). 80 triangles per bag: 7 rings × 10 sides
 * (140) cost 0.3–1.1 ms of Intel UHD on Low for the Market's 39 near chunks; this keeps ~0.2.
 */
const RINGS: readonly { t: number; w: number; h: number }[] = [
  { t: 0, w: 0.52, h: 0.4 },
  { t: 0.1, w: 0.88, h: 0.8 },
  { t: 0.5, w: 0.97, h: 0.94 },
  { t: 0.9, w: 0.88, h: 0.8 },
  { t: 1, w: 0.52, h: 0.4 },
];
/** Cross-section points (around): a boxy superellipse, flatter underneath where bags stack. */
const AROUND = 8;
/** Triangles per bag: the body between the rings plus the two tied-end fans. */
export const SANDBAG_BAG_TRIS = (RINGS.length - 1) * AROUND * 2 + 2 * AROUND;
const SECTION: readonly [number, number][] = Array.from({ length: AROUND }, (_, k) => {
  const a = (k / AROUND) * Math.PI * 2 + Math.PI / AROUND;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const z = Math.sign(c) * Math.abs(c) ** 0.7 * 0.5;
  let y = Math.sign(s) * Math.abs(s) ** 0.8 * 0.5;
  if (y < 0) y *= 0.9; // pressed a little flat by the course above
  return [z, y];
});

/** Deterministic 0..1 stream for a wall (its centre + salt): every client lays the same bags. */
function wallRandom(b: MapBox, salt: number): () => number {
  let s =
    (Math.imul(Math.round(b.center.x * 100) ^ 0x9e3779b9, 0x85ebca6b) ^
      Math.round(b.center.z * 100)) +
    salt;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One bag in the wall's local frame (metres; x along the wall, y up from its centre, z across). */
export interface Bag {
  x: number;
  y: number;
  z: number;
  len: number;
  height: number;
  width: number;
  /** Turn about y (set in the wall), roll about z (sagging end), tilt about x. */
  yaw: number;
  roll: number;
  tilt: number;
  /** Albedo multiplier (fill, dirt). */
  shade: number;
  /** Which bag cell of the sandbag texture it shows (column 0..2, row 0..5). */
  cell: [number, number];
}

/** The bags of one sandbag box (local frame). */
export function sandbagLayout(b: MapBox): Bag[] {
  const L = b.size.x;
  const H = b.size.y;
  const D = b.size.z;
  const rnd = wallRandom(b, 31);
  const hc = H / SANDBAG_COURSES;
  const n = Math.max(2, Math.round(L / SANDBAG_LENGTH));
  const bl = L / n;
  const rows = D > 0.5 ? [-D / 4, D / 4] : [0];
  const bw = D / rows.length;
  const bags: Bag[] = [];
  for (let c = 0; c < SANDBAG_COURSES; c++) {
    const top = c === SANDBAG_COURSES - 1;
    const upper = c >= SANDBAG_COURSES - 2;
    for (const [ri, z] of rows.entries()) {
      // Half bond: odd courses start and end with a half bag (back row offset the other way).
      const odd = (c + ri) % 2 === 1;
      const lens = odd ? [0.5, ...Array<number>(n - 1).fill(1), 0.5] : Array<number>(n).fill(1);
      let x = -L / 2;
      lens.forEach((k, i) => {
        const len = k * bl;
        const end = i === 0 ? -1 : i === lens.length - 1 ? 1 : 0;
        // Upper courses' end bags sag off the wall end: lower, rolled down outwards.
        const sag = upper && end !== 0 ? (top ? 0.035 : 0.015) * (0.6 + 0.8 * rnd()) : 0;
        // Taller than the course: each bag sinks well into the one below (a clean crease, never two
        // near-coincident surfaces fighting in depth).
        const height = hc * (1.24 + 0.08 * rnd()) * (top ? 1 : 0.97);
        bags.push({
          x: x + len / 2 + (rnd() - 0.5) * 0.02 - end * sag * 0.3,
          y:
            -H / 2 +
            hc * (c + 0.5) +
            (rnd() - 0.5) * 0.012 +
            (top ? (rnd() - 0.6) * 0.025 : 0) -
            sag,
          z: z + (rnd() - 0.5) * 0.02,
          len: len * (0.95 + 0.06 * rnd()) + 0.03,
          height,
          width: bw * (0.98 + 0.08 * rnd()),
          yaw: (rnd() - 0.5) * 0.07,
          roll: end * sag * 2.2 + (rnd() - 0.5) * 0.04,
          tilt: (rnd() - 0.5) * (top ? 0.08 : 0.04),
          shade: 0.86 + 0.2 * rnd(),
          cell: [Math.floor(rnd() * 3), Math.floor(rnd() * 6)],
        });
        x += len;
      });
    }
  }
  return bags;
}

/** One vertex of a bag mesh in world space (and its box-local position/normal for the lightmap). */
export interface BagVertex {
  p: Vec3;
  n: Vec3;
  u: number;
  v: number;
  shade: number;
  /** Box-local position (clamped onto `lmFace` for the lightmap). */
  local: Vec3;
  /**
   * The box face (mapMesh `FACES` order: +x, −x, +y, −y, +z, −z) whose lightmap texels this bag
   * reads: one per bag (its row's side), so no triangle interpolates between two atlas rects.
   */
  lmFace: number;
}

const TILE = 1.9; // the sandbag texture tile (materials.ts `sandbag.tile`)
/** Burlap half of the tile (materials.ts `SANDBAG_BURLAP_V`), kept clear of its edges (mips). */
const BURLAP_V0 = TILE * 0.53;
const BURLAP_V1 = TILE * 0.97;

/**
 * Emit the bags of box `b`: `vertex` gets each vertex (returns its index), `tri` each triangle.
 * Per bag: `RINGS` × `AROUND` sides + two pinched end fans (`SANDBAG_BAG_TRIS`).
 */
export function emitSandbagWall(
  b: MapBox,
  vertex: (v: BagVertex) => number,
  tri: (a: number, b: number, c: number) => void,
): number {
  const q = quatFromEulerDeg(b.rot);
  const toWorld = (p: Vec3): Vec3 => {
    const w = rotateByQuat(p, q);
    return { x: b.center.x + w.x, y: b.center.y + w.y, z: b.center.z + w.z };
  };
  const bags = sandbagLayout(b);
  for (const bag of bags) {
    const bq = quatFromEulerDeg({
      x: (bag.tilt * 180) / Math.PI,
      y: (bag.yaw * 180) / Math.PI,
      z: (bag.roll * 180) / Math.PI,
    });
    const place = (lp: Vec3): Vec3 => {
      const r = rotateByQuat(lp, bq);
      return { x: bag.x + r.x, y: bag.y + r.y, z: bag.z + r.z };
    };
    // Template point on the unit bag → bag-local metres.
    const at = (ring: number, k: number): Vec3 => {
      const r = RINGS[ring]!;
      const [sz, sy] = SECTION[k % AROUND]!;
      // Plump middle: the top domes a little more than the sides bulge.
      const dome = sy > 0 ? 1 + 0.12 * (r.h - 0.42) : 1;
      return {
        x: (r.t - 0.5) * bag.len,
        y: sy * bag.height * r.h * dome,
        z: sz * bag.width * r.w,
      };
    };
    // Smooth normal from the bag surface itself (central differences round the section and
    // along the bag; one-sided at the pinched ends).
    const normalAt = (ring: number, k: number): Vec3 => {
      const k0 = at(ring, k + AROUND - 1);
      const k1 = at(ring, k + 1);
      const r0 = at(Math.max(0, ring - 1), k);
      const r1 = at(Math.min(RINGS.length - 1, ring + 1), k);
      const du = { x: k1.x - k0.x, y: k1.y - k0.y, z: k1.z - k0.z };
      const dv = { x: r1.x - r0.x, y: r1.y - r0.y, z: r1.z - r0.z };
      // (along × around) points outwards for this winding.
      const n = {
        x: dv.y * du.z - dv.z * du.y,
        y: dv.z * du.x - dv.x * du.z,
        z: dv.x * du.y - dv.y * du.x,
      };
      const l = Math.hypot(n.x, n.y, n.z) || 1;
      return { x: n.x / l, y: n.y / l, z: n.z / l };
    };
    // Cloth at real scale: metres along the bag, round it squeezed into the burlap band; each
    // bag its own patch of the tile.
    const uvOf = (s: number, t: number): [number, number] => [
      (TILE * bag.cell[0]) / 3 + bag.cell[1] * 0.11 + s * bag.len,
      BURLAP_V0 + t * (BURLAP_V1 - BURLAP_V0),
    ];
    const emit = (lp: Vec3, ln: Vec3, s: number, t: number, shade: number): number => {
      const local = place(lp);
      const [u, v] = uvOf(s, t);
      return vertex({
        p: toWorld(local),
        n: rotateByQuat(rotateByQuat(ln, bq), q),
        u,
        v,
        shade: bag.shade * shade,
        local,
        lmFace: bag.z >= 0 ? 4 : 5,
      });
    };
    const ids: number[][] = [];
    RINGS.forEach((r, ri) => {
      const row: number[] = [];
      for (let k = 0; k <= AROUND; k++) {
        const [, sy] = SECTION[k % AROUND]!;
        // Underside and seams in shadow; the tied ends a little darker (gathered cloth).
        const shade = (sy < 0 ? 0.62 : 0.9 + 0.2 * sy) * (r.w < 0.6 ? 0.82 : 1);
        row.push(emit(at(ri, k), normalAt(ri, k), r.t, k / AROUND, shade));
      }
      ids.push(row);
    });
    for (let ri = 0; ri + 1 < RINGS.length; ri++) {
      for (let k = 0; k < AROUND; k++) {
        const a = ids[ri]![k]!;
        const b2 = ids[ri]![k + 1]!;
        const c = ids[ri + 1]![k + 1]!;
        const d = ids[ri + 1]![k]!;
        tri(a, c, b2);
        tri(a, d, c);
      }
    }
    // Tied ends: a short gathered tuft past each pinched ring.
    for (const [ri, dir] of [
      [0, -1],
      [RINGS.length - 1, 1],
    ] as const) {
      const tip = emit(
        { x: dir * (bag.len / 2 + 0.025), y: bag.height * 0.04, z: 0 },
        { x: dir, y: 0.2, z: 0 },
        ri === 0 ? 0 : 1,
        0.5,
        0.7,
      );
      for (let k = 0; k < AROUND; k++) {
        const a = ids[ri]![k]!;
        const b2 = ids[ri]![k + 1]!;
        if (dir < 0) tri(tip, a, b2);
        else tri(tip, b2, a);
      }
    }
  }
  return bags.length;
}
