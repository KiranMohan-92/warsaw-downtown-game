import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap, MOVEMENT, PLAYER, resolveMap, type MapBox } from '@wd/shared';
import {
  addHallSky,
  buildMarketHallPieces,
  hallDecalLift,
  HALL,
  HALL_INNER,
  HALL_LEVELS,
  HALL_SKY_ATTRIBUTE,
  HALL_WALL_REACH,
  type HallPiece,
} from './marketHallInterior.ts';
import { patchLampVolume } from './lampLight.ts';
import { BAKED_AO_INTENSITY } from './mapMesh.ts';

type Box = { min: THREE.Vector3; max: THREE.Vector3 };

const map = resolveMap(getMap('defilad'), 'market');
const pieces = buildMarketHallPieces(map);

function boundsOf(p: HallPiece): Box {
  p.geo.computeBoundingBox();
  return { min: p.geo.boundingBox!.min.clone(), max: p.geo.boundingBox!.max.clone() };
}

function boxOf(b: MapBox): Box {
  // The hall's boxes are axis-aligned; a rotated prop is taken by its (larger) axis-aligned hull.
  const geo = new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z);
  const r = b.rot ?? { x: 0, y: 0, z: 0 };
  geo.rotateX(THREE.MathUtils.degToRad(r.x));
  geo.rotateY(THREE.MathUtils.degToRad(r.y));
  geo.rotateZ(THREE.MathUtils.degToRad(r.z));
  geo.translate(b.center.x, b.center.y, b.center.z);
  geo.computeBoundingBox();
  const out = { min: geo.boundingBox!.min.clone(), max: geo.boundingBox!.max.clone() };
  geo.dispose();
  return out;
}

const nearHall = (b: Box, grow = 0): boolean =>
  b.max.x >= HALL.x0 - grow &&
  b.min.x <= HALL.x1 + grow &&
  b.max.z >= HALL.z0 - grow &&
  b.min.z <= HALL.z1 + grow;

const solids = map.boxes
  .filter((b) => b.collide !== false)
  .map(boxOf)
  .filter((b) => nearHall(b, 1));

/** Horizontal distance from (x, z) to a box's footprint. */
function rectDistance(x: number, z: number, b: Box): number {
  const dx = Math.max(b.min.x - x, 0, x - b.max.x);
  const dz = Math.max(b.min.z - z, 0, z - b.max.z);
  return Math.hypot(dx, dz);
}

const RADIUS = PLAYER.radius;
/** Highest an eye gets above its floor: standing eye plus a full jump. */
const EYE_REACH = PLAYER.standEyeHeight + MOVEMENT.jumpHeight;

/**
 * Where a player can stand on each hall floor (0.1 m grid): the capsule (radius, 1.8 m) clears
 * every collider and the point is over that floor.
 */
function walkable(floor: number, ceiling: number): { x: number; z: number; eye: number }[] {
  const out: { x: number; z: number; eye: number }[] = [];
  const supports = solids.filter((b) => Math.abs(b.max.y - floor) < 0.02);
  for (let x = HALL_INNER.x0 + 0.05; x < HALL_INNER.x1; x += 0.1) {
    for (let z = HALL_INNER.z0 + 0.05; z < HALL_INNER.z1; z += 0.1) {
      if (!supports.some((b) => rectDistance(x, z, b) === 0)) continue;
      const blocked = solids.some(
        (b) =>
          b.max.y > floor + 0.05 &&
          b.min.y < Math.min(ceiling, floor + 1.8) &&
          rectDistance(x, z, b) < RADIUS - 1e-6,
      );
      if (blocked) continue;
      // Highest the eye gets here: a full jump, or as far as the headroom (a lintel) allows.
      const head = solids
        .filter((b) => b.min.y >= floor + 1.8 - 1e-3 && rectDistance(x, z, b) < RADIUS - 1e-6)
        .reduce((m, b) => Math.min(m, b.min.y), ceiling);
      const eye = Math.min(floor + EYE_REACH, head - (PLAYER.standHeight - PLAYER.standEyeHeight));
      out.push({ x, z, eye });
    }
  }
  return out;
}

describe('market hall interior dressing', () => {
  it('reads the hall it dresses from the map (levels, faces)', () => {
    const tops = (y: number): MapBox[] =>
      map.boxes.filter((b) => Math.abs(b.center.y + b.size.y / 2 - y) < 1e-3 && nearHall(boxOf(b)));
    const bottoms = (y: number): MapBox[] =>
      map.boxes.filter((b) => Math.abs(b.center.y - b.size.y / 2 - y) < 1e-3 && nearHall(boxOf(b)));
    expect(tops(HALL_LEVELS.floor).some((b) => b.mat === 'terrazzo')).toBe(true);
    expect(bottoms(HALL_LEVELS.ceiling).some((b) => b.mat === 'wood' && b.size.x > 10)).toBe(true);
    expect(tops(HALL_LEVELS.upper).some((b) => b.mat === 'wood' && b.size.x > 10)).toBe(true);
    expect(bottoms(HALL_LEVELS.roof).some((b) => b.mat === 'concrete')).toBe(true);
    // Perimeter walls are 0.3 m thick, centred on the hall's edges.
    const north = map.boxes.filter(
      (b) =>
        b.mat === 'plaster' &&
        Math.abs(b.center.z - HALL.z0) < 1e-3 &&
        Math.abs(b.size.z - 0.3) < 1e-6,
    );
    expect(north.length).toBeGreaterThan(4);
    expect(HALL_INNER.z0).toBeCloseTo(HALL.z0 + 0.15, 6);
    // Nothing for a map without the hall.
    expect(buildMarketHallPieces(getMap('range'))).toEqual([]);
  });

  it('is deterministic, finite, indexed, inside the hall and lit by a sane sky factor', () => {
    const again = buildMarketHallPieces(map);
    expect(again.length).toBe(pieces.length);
    let tris = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const q = again[i]!;
      expect([q.kind, q.mat]).toEqual([p.kind, p.mat]);
      expect(Array.from(q.geo.getAttribute('position').array)).toEqual(
        Array.from(p.geo.getAttribute('position').array),
      );
      expect(p.geo.index).not.toBeNull();
      tris += p.geo.index!.count / 3;
      const pos = p.geo.getAttribute('position');
      const nrm = p.geo.getAttribute('normal');
      const col = p.geo.getAttribute('color');
      const sky = p.geo.getAttribute(HALL_SKY_ATTRIBUTE);
      expect(p.geo.getAttribute('uv').count).toBe(pos.count);
      expect(col.count).toBe(pos.count);
      expect(sky.count).toBe(pos.count);
      for (let v = 0; v < pos.count; v++) {
        expect(Number.isFinite(pos.getX(v) + pos.getY(v) + pos.getZ(v))).toBe(true);
        expect(Math.hypot(nrm.getX(v), nrm.getY(v), nrm.getZ(v))).toBeCloseTo(1, 4);
        expect(col.getX(v) + col.getY(v) + col.getZ(v)).toBeGreaterThan(0);
        expect(sky.getX(v)).toBeGreaterThanOrEqual(1 - BAKED_AO_INTENSITY - 1e-6);
        expect(sky.getX(v)).toBeLessThanOrEqual(1 + 1e-6);
      }
      const b = boundsOf(p);
      expect(b.min.x).toBeGreaterThanOrEqual(HALL.x0 - 0.15 - 1e-4);
      expect(b.max.x).toBeLessThanOrEqual(HALL.x1 + 0.15 + 1e-4);
      expect(b.min.z).toBeGreaterThanOrEqual(HALL.z0 - 0.15 - 1e-4);
      expect(b.max.z).toBeLessThanOrEqual(HALL.z1 + 0.15 + 1e-4);
      expect(b.min.y).toBeGreaterThanOrEqual(-1e-4);
      expect(b.max.y).toBeLessThanOrEqual(HALL_LEVELS.roof + 1e-4);
    }
    expect(tris).toBeGreaterThan(5_000);
    expect(tris).toBeLessThanOrEqual(25_000);
    // Indoors: the fill light is mostly occluded, as the bake has it.
    const floor = pieces.filter((p) => p.mat === 'terrazzo');
    let sum = 0;
    let n = 0;
    for (const p of floor) {
      const s = p.geo.getAttribute(HALL_SKY_ATTRIBUTE);
      for (let v = 0; v < s.count; v++) {
        sum += s.getX(v);
        n++;
      }
    }
    expect(sum / n).toBeGreaterThan(1 - BAKED_AO_INTENSITY + 0.05);
    expect(sum / n).toBeLessThan(0.6);
  });

  it('dresses what the brief asks for, with its counts', () => {
    const count = (kind: HallPiece['kind'], mat?: string): number =>
      pieces.filter((p) => p.kind === kind && (!mat || p.mat === mat)).length;
    // One steel nosing per tread.
    const treads = map.boxes.filter(
      (b) =>
        b.mat === 'wood' &&
        b.visible !== false &&
        b.center.y - b.size.y / 2 < 0.01 &&
        b.size.x < 0.4 &&
        nearHall(boxOf(b)),
    );
    expect(count('hall-stair')).toBe(treads.length);
    expect(treads.length).toBeGreaterThan(10);
    // Window frames: 5 parts each (two jambs, head, mullion, timber sill).
    expect(count('hall-window')).toBe(5 * 9);
    expect(count('hall-floor', 'terrazzo')).toBeGreaterThan(200);
    expect(count('hall-floor', 'metal')).toBe(5); // a threshold at every door
    expect(count('hall-cover')).toBe(2 * 3 + 2 * 3); // two counters, two partitions
    expect(count('hall-railing')).toBeGreaterThan(10);
    expect(count('hall-dressing')).toBeGreaterThan(10);
    // Stall shutters (tile slats with u pinned between the subway tile's joints).
    const slats = pieces.filter((p) => {
      if (p.mat !== 'tile') return false;
      const uv = p.geo.getAttribute('uv');
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < uv.count; v++) {
        lo = Math.min(lo, uv.getX(v));
        hi = Math.max(hi, uv.getX(v));
      }
      return hi - lo < 0.02;
    });
    expect(slats.length).toBeGreaterThanOrEqual(5);
    // Glazed-brick piers on both floors (0.5 m wide, 8 cm proud).
    const piers = pieces.filter((p) => {
      const b = boundsOf(p);
      const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
      return p.mat === 'tile' && Math.abs(w - 0.5) < 1e-4 && b.max.y - b.min.y > 2.5;
    });
    expect(piers.length).toBeGreaterThanOrEqual(15);
    expect(piers.some((p) => boundsOf(p).min.y > 3)).toBe(true);
    // Draw budget: one draw per material in the hall's chunk.
    expect(new Set(pieces.map((p) => p.mat))).toEqual(
      new Set(['tile', 'paint', 'wood', 'metal', 'sandbag', 'plaster', 'terrazzo', 'trim']),
    );
  });

  it('keeps every piece where it belongs: on a wall, on cover, on a floor or overhead', () => {
    const faces = [
      { axis: 'z' as const, at: HALL_INNER.z0, dir: 1 },
      { axis: 'z' as const, at: HALL_INNER.z1, dir: -1 },
      { axis: 'x' as const, at: HALL_INNER.x0, dir: 1 },
      { axis: 'x' as const, at: HALL_INNER.x1, dir: -1 },
    ];
    const onWall = (b: Box, reach: number): boolean =>
      faces.some(({ axis, at, dir }) => {
        const lo = dir > 0 ? at - 1e-4 : at - reach - 1e-4;
        const hi = dir > 0 ? at + reach + 1e-4 : at + 1e-4;
        return b.min[axis] >= lo && b.max[axis] <= hi;
      });
    const cover = map.boxes
      .filter((b) => b.collide !== false && b.visible !== false && !b.model)
      .map(boxOf)
      .filter((b) => nearHall(b) && b.max.y - b.min.y > 0.8 && b.max.y - b.min.y < 2.6);
    for (const p of pieces) {
      const b = boundsOf(p);
      const at = JSON.stringify({ kind: p.kind, mat: p.mat, min: b.min, max: b.max });
      switch (p.kind) {
        case 'hall-wall':
          expect(onWall(b, HALL_WALL_REACH), at).toBe(true);
          break;
        case 'hall-dressing':
          expect(onWall(b, 0.24), at).toBe(true);
          expect(b.max.y, at).toBeLessThan(HALL_LEVELS.floor + 0.6);
          break;
        case 'hall-cover': {
          // Within 2 cm of a cover box's sides, at most 1.2 cm above its top.
          const host = cover.find(
            (c) =>
              b.min.x >= c.min.x - 0.02 - 1e-4 &&
              b.max.x <= c.max.x + 0.02 + 1e-4 &&
              b.min.z >= c.min.z - 0.02 - 1e-4 &&
              b.max.z <= c.max.z + 0.02 + 1e-4 &&
              b.max.y <= c.max.y + 0.012 + 1e-4 &&
              b.min.y >= c.min.y - 1e-4,
          );
          expect(host, at).toBeDefined();
          break;
        }
        case 'hall-floor':
          expect(b.max.y, at).toBeLessThanOrEqual(HALL_LEVELS.floor + 0.02);
          break;
        case 'hall-ceiling': {
          // Overhead: every vertex out of reach of an eye (≥ the radius from the walls).
          const pos = p.geo.getAttribute('position');
          for (let v = 0; v < pos.count; v++) {
            const x = pos.getX(v);
            const y = pos.getY(v);
            const z = pos.getZ(v);
            const fromWall = Math.min(
              x - HALL_INNER.x0,
              HALL_INNER.x1 - x,
              z - HALL_INNER.z0,
              HALL_INNER.z1 - z,
            );
            if (fromWall < RADIUS) continue;
            const floor = y < HALL_LEVELS.ceiling + 0.01 ? HALL_LEVELS.floor : HALL_LEVELS.upper;
            expect(y - floor, at).toBeGreaterThan(EYE_REACH);
          }
          break;
        }
        case 'hall-stair':
        case 'hall-railing':
        case 'hall-window':
          break; // checked below
      }
    }
  });

  it('keeps walk and firing space clear: no piece reaches an eye column anywhere you can stand', () => {
    // Exempt by design: guard rails over the stair void (visual only, see the module notes) and
    // flat floor pieces/nosings (under the column, which starts at knee height).
    const checked = pieces.filter(
      (p) => p.kind !== 'hall-railing' && p.kind !== 'hall-floor' && p.kind !== 'hall-stair',
    );
    const EYE_COLUMN = 0.1;
    for (const [floor, ceiling] of [
      [HALL_LEVELS.floor, HALL_LEVELS.ceiling],
      [HALL_LEVELS.upper, HALL_LEVELS.roof],
    ] as const) {
      const spots = walkable(floor, ceiling);
      expect(spots.length).toBeGreaterThan(10_000);
      const y0 = floor + 0.3;
      for (const p of checked) {
        const b = boundsOf(p);
        if (b.max.y <= y0 || b.min.y >= ceiling) continue;
        const hit = spots.find(
          (s) => b.min.y < s.eye + 0.05 && rectDistance(s.x, s.z, b) < EYE_COLUMN,
        );
        expect(hit, JSON.stringify({ kind: p.kind, mat: p.mat, b, hit })).toBeUndefined();
      }
    }
  });

  it('keeps the round-2 look: clean surfaces, small quiet terrazzo, dark counters, duct by the wall', () => {
    const lum = (p: HallPiece): number => {
      const c = p.geo.getAttribute('color');
      return (c.getX(0) + c.getY(0) + c.getZ(0)) / 3;
    };
    const size = (p: HallPiece): THREE.Vector3 => {
      const b = boundsOf(p);
      return b.max.clone().sub(b.min);
    };
    // Ground-floor ceiling: painted boards (the clean paint surface), not the stained plaster scan.
    const ceiling = pieces.filter(
      (p) => p.kind === 'hall-ceiling' && boundsOf(p).max.y <= HALL_LEVELS.ceiling + 1e-4,
    );
    expect(ceiling.length).toBeGreaterThan(300);
    expect(new Set(ceiling.map((p) => p.mat))).toEqual(new Set(['paint']));
    for (const p of ceiling) expect(size(p).z).toBeLessThanOrEqual(0.14 + 1e-4);
    // No plaster scan above either dado: the cream render is the low-variation trim surface, and
    // plaster only carries the upstairs painted band and its line (≤ 1.26 m above that floor).
    for (const p of pieces.filter((q) => q.mat === 'plaster'))
      expect(boundsOf(p).max.y).toBeLessThanOrEqual(HALL_LEVELS.upper + 1.26 + 1e-4);
    const cream = pieces.filter((p) => p.mat === 'trim');
    expect(cream.some((p) => boundsOf(p).max.y < HALL_LEVELS.ceiling)).toBe(true);
    expect(cream.some((p) => boundsOf(p).min.y > HALL_LEVELS.upper)).toBe(true);
    // Terrazzo: 0.6 m tiles, two close tones, a wider oxblood band along every wall.
    const floor = pieces.filter((p) => p.mat === 'terrazzo');
    for (const p of floor) {
      const s = size(p);
      expect(Math.max(s.x, s.z)).toBeLessThanOrEqual(0.6 + 1e-4);
    }
    const centre = floor.filter((p) => {
      const b = boundsOf(p);
      return (
        b.min.x > HALL_INNER.x0 + 1 &&
        b.max.x < HALL_INNER.x1 - 1 &&
        b.min.z > HALL_INNER.z0 + 1 &&
        b.max.z < HALL_INNER.z1 - 1
      );
    });
    const field = centre.map(lum);
    // Linear colours: the two tones are 0.77 apart (≈ 0.89 in sRGB) before jitter and the rare
    // stain; the first round's chessboard was ≈ 0.5.
    expect(Math.min(...field) / Math.max(...field)).toBeGreaterThan(0.65);
    for (const [axis, at] of [
      ['x', HALL_INNER.x0],
      ['x', HALL_INNER.x1],
      ['z', HALL_INNER.z0],
      ['z', HALL_INNER.z1],
    ] as const) {
      const band = floor.filter((p) => {
        const b = boundsOf(p);
        return Math.abs(b.min[axis] - at) < 1e-3 || Math.abs(b.max[axis] - at) < 1e-3;
      });
      expect(band.length).toBeGreaterThan(5);
      for (const p of band) {
        const c = p.geo.getAttribute('color');
        expect(c.getX(0)).toBeGreaterThan(c.getZ(0) * 1.3); // oxblood: red over blue
      }
    }
    // Counters: timber fronts and a dark zinc top, darker than the field of the floor.
    const counters = pieces.filter((p) => p.kind === 'hall-cover' && boundsOf(p).max.y < 1.5);
    expect(new Set(counters.map((p) => p.mat))).toEqual(new Set(['wood', 'paint', 'metal']));
    // Duct: one run square to the beams (along x), by the north wall, clear of the crate.
    const duct = pieces.filter(
      (p) => p.kind === 'hall-ceiling' && p.mat === 'metal' && size(p).x > 10,
    );
    expect(duct.length).toBe(1);
    const d = boundsOf(duct[0]!);
    expect(d.min.z).toBeGreaterThan(HALL_INNER.z0 + 0.8); // inside the knee braces
    expect(d.max.z).toBeLessThan(HALL_INNER.z0 + 1.6);
    expect(d.max.x).toBeLessThan(148.55 - PLAYER.radius); // the upstairs crate at (149, 16)
  });

  it('puts bullet holes on the visible skin of a dressed wall span', () => {
    const lift = hallDecalLift(pieces);
    // A closed shutter on the north wall: a hit on the wall behind it, mid-height.
    const curtain = pieces.find((p) => {
      if (p.mat !== 'tile' || Math.abs(boundsOf(p).min.z - HALL_INNER.z0) > 1e-4) return false;
      const uv = p.geo.getAttribute('uv');
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < uv.count; v++) {
        lo = Math.min(lo, uv.getX(v));
        hi = Math.max(hi, uv.getX(v));
      }
      return hi - lo < 1e-6; // slats: u pinned
    });
    expect(curtain).toBeDefined();
    const c = boundsOf(curtain!);
    const inward = { x: 0, y: 0, z: 1 };
    const behind = { x: (c.min.x + c.max.x) / 2, y: 1.0, z: HALL_INNER.z0 };
    expect(lift(behind, inward)).toBeCloseTo(c.max.z - HALL_INNER.z0, 4); // the 42 mm curtain
    expect(c.max.z - HALL_INNER.z0).toBeGreaterThan(0.04);
    // A brick pier upstairs: 8 cm proud.
    const pier = pieces.find((p) => {
      const b = boundsOf(p);
      return p.mat === 'tile' && b.min.y > 3 && Math.abs(b.max.x - b.min.x - 0.5) < 1e-4;
    })!;
    const pb = boundsOf(pier);
    const onPier = { x: (pb.min.x + pb.max.x) / 2, y: 5, z: pb.min.z };
    const into = pb.min.z < 20 ? inward : { x: 0, y: 0, z: -1 };
    if (into.z < 0) onPier.z = pb.max.z;
    expect(lift(onPier, into)).toBeCloseTo(0.08, 4);
    // Painted ceiling boards 4 mm under the slab; the exterior face of a wall: nothing.
    expect(lift({ x: 135, y: HALL_LEVELS.ceiling, z: 16.07 }, { x: 0, y: -1, z: 0 })).toBeCloseTo(
      0.004,
      4,
    );
    expect(lift({ x: 140, y: 1, z: HALL.z0 - 0.15 }, { x: 0, y: 0, z: -1 })).toBe(0);
    // Behind a louvred vent: the tilted slats' bounds (68 mm) are not their surface, so the hole
    // lands on the vent's 20 mm back plate, never floating in front of the slats.
    expect(lift({ x: 134, y: 6.16, z: 14.15 }, inward)).toBeCloseTo(0.02, 4);
  });

  it('shades sacks outward on every wall (east/west ones are rotated, not mirrored)', () => {
    const sacks = pieces.filter((p) => p.mat === 'sandbag');
    const turned = sacks.filter((p) => {
      const b = boundsOf(p);
      return b.max.z - b.min.z > b.max.x - b.min.x;
    });
    expect(turned.length).toBeGreaterThan(0);
    expect(sacks.length - turned.length).toBeGreaterThan(0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const centre = new THREE.Vector3();
    for (const p of sacks) {
      p.geo.computeBoundingBox();
      p.geo.boundingBox!.getCenter(centre);
      const pos = p.geo.getAttribute('position');
      const nrm = p.geo.getAttribute('normal');
      const idx = p.geo.index!;
      let outward = 0;
      let faces = 0;
      for (let t = 0; t < idx.count; t += 3) {
        a.fromBufferAttribute(pos, idx.getX(t));
        b.fromBufferAttribute(pos, idx.getX(t + 1));
        c.fromBufferAttribute(pos, idx.getX(t + 2));
        const n = b.clone().sub(a).cross(c.clone().sub(a));
        if (n.lengthSq() < 1e-12) continue;
        const mid = a.clone().add(b).add(c).divideScalar(3).sub(centre);
        faces++;
        if (n.dot(mid) > 0) outward++;
      }
      expect(outward / faces).toBeGreaterThan(0.97);
      let along = 0;
      for (let v = 0; v < pos.count; v++) {
        a.fromBufferAttribute(pos, v).sub(centre);
        b.fromBufferAttribute(nrm, v);
        if (a.dot(b) >= 0) along++;
      }
      expect(along / pos.count).toBeGreaterThan(0.97);
    }
  });

  it('nosings sit on the treads; rails stay over the stair and its void', () => {
    const treads = map.boxes
      .filter(
        (b) =>
          b.mat === 'wood' &&
          b.center.y - b.size.y / 2 < 0.01 &&
          b.size.x < 0.4 &&
          nearHall(boxOf(b)) &&
          b.visible !== false,
      )
      .map(boxOf);
    const stair = {
      x0: Math.min(...treads.map((t) => t.min.x)),
      x1: Math.max(...treads.map((t) => t.max.x)),
      z0: Math.min(...treads.map((t) => t.min.z)),
      z1: Math.max(...treads.map((t) => t.max.z)),
    };
    for (const p of pieces.filter((q) => q.kind === 'hall-stair')) {
      const b = boundsOf(p);
      const tread = treads.find(
        (t) =>
          Math.abs(t.max.x - b.max.x + 0.004) < 1e-4 && Math.abs(t.max.y - b.max.y + 0.004) < 1e-4,
      );
      expect(tread).toBeDefined();
      expect(b.min.z).toBeGreaterThanOrEqual(stair.z0);
      expect(b.max.z).toBeLessThanOrEqual(stair.z1);
    }
    // The upper floor ends at the void's north edge: rails never stand on the walkable floor.
    const voidZ0 = stair.z0 - 0.05;
    for (const p of pieces.filter((q) => q.kind === 'hall-railing')) {
      const b = boundsOf(p);
      expect(b.min.x).toBeGreaterThanOrEqual(stair.x0 - 0.01);
      expect(b.max.x).toBeLessThanOrEqual(stair.x1 + 0.01);
      expect(b.min.z).toBeGreaterThanOrEqual(voidZ0 - 0.01);
      expect(b.max.z).toBeLessThanOrEqual(stair.z1 + 0.05);
    }
  });

  it('leaves doors open and windows ≥ 88 % clear', () => {
    // Openings = gaps in the perimeter walls' coverage at a probe height.
    const walls = map.boxes.filter(
      (b) =>
        b.mat === 'plaster' &&
        (Math.abs(b.center.z - HALL.z0) < 1e-3 ||
          Math.abs(b.center.z - HALL.z1) < 1e-3 ||
          Math.abs(b.center.x - HALL.x0) < 1e-3 ||
          Math.abs(b.center.x - HALL.x1) < 1e-3),
    );
    const gaps = (y: number): Box[] => {
      const out: Box[] = [];
      for (const [axis, at] of [
        ['x', HALL.z0],
        ['x', HALL.z1],
        ['z', HALL.x0],
        ['z', HALL.x1],
      ] as const) {
        const line = walls
          .map(boxOf)
          .filter((b) =>
            axis === 'x' ? b.min.z < at && b.max.z > at : b.min.x < at && b.max.x > at,
          )
          .filter((b) => b.min.y <= y && b.max.y >= y);
        const lo = axis === 'x' ? HALL_INNER.x0 : HALL_INNER.z0;
        const hi = axis === 'x' ? HALL_INNER.x1 : HALL_INNER.z1;
        const spans = line
          .map((b): [number, number] => (axis === 'x' ? [b.min.x, b.max.x] : [b.min.z, b.max.z]))
          .sort((p, q) => p[0] - q[0]);
        let cursor = lo;
        for (const [a, c] of [...spans, [hi, hi] as [number, number]]) {
          if (a - cursor > 0.3) {
            const at0 = at - 0.15;
            const at1 = at + 0.15;
            out.push(
              axis === 'x'
                ? { min: new THREE.Vector3(cursor, 0, at0), max: new THREE.Vector3(a, 0, at1) }
                : { min: new THREE.Vector3(at0, 0, cursor), max: new THREE.Vector3(at1, 0, a) },
            );
          }
          cursor = Math.max(cursor, c);
        }
      }
      return out;
    };
    const intersects = (a: Box, b: Box): boolean =>
      a.min.x < b.max.x &&
      a.max.x > b.min.x &&
      a.min.y < b.max.y &&
      a.max.y > b.min.y &&
      a.min.z < b.max.z &&
      a.max.z > b.min.z;
    const doors = gaps(1.2).map((d) => {
      d.min.y = HALL_LEVELS.floor + 0.02;
      d.max.y = 2.3;
      return d;
    });
    expect(doors.length).toBe(5);
    for (const d of doors)
      for (const p of pieces)
        expect(intersects(boundsOf(p), d), `${p.kind} ${p.mat} in a door`).toBe(false);
    const windows = gaps(5.1).map((w) => {
      w.min.y = 4.5;
      w.max.y = 5.8;
      return w;
    });
    expect(windows.length).toBe(9);
    for (const w of windows) {
      const along = w.max.x - w.min.x > w.max.z - w.min.z ? 'x' : 'z';
      const width = w.max[along] - w.min[along];
      let covered = 0;
      for (const p of pieces) {
        const b = boundsOf(p);
        if (!intersects(b, w)) continue;
        expect(p.kind).toBe('hall-window');
        const a0 = Math.max(b.min[along], w.min[along]);
        const a1 = Math.min(b.max[along], w.max[along]);
        const h0 = Math.max(b.min.y, w.min.y);
        const h1 = Math.min(b.max.y, w.max.y);
        covered += Math.max(0, a1 - a0) * Math.max(0, h1 - h0);
      }
      expect(covered / (width * (w.max.y - w.min.y))).toBeLessThan(0.12);
    }
  });

  it('scales only the fill light by the sky factor, before the lamps, on Medium+ only', () => {
    const m = new THREE.MeshStandardMaterial();
    addHallSky(m);
    patchLampVolume(m, 'world');
    expect(m.customProgramCacheKey()).toMatch(/hallSky-v1\|lampVolume:world$/);
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <aomap_fragment>\n',
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain(`attribute float ${HALL_SKY_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain(`vHallSky = ${HALL_SKY_ATTRIBUTE};`);
    const f = shader.fragmentShader;
    const sky = f.indexOf('reflectedLight.indirectDiffuse *= vHallSky;');
    const ao = f.indexOf('#include <aomap_fragment>');
    const lamps = f.indexOf('lampVolume, ');
    expect(sky).toBeGreaterThan(0);
    expect(sky).toBeLessThan(ao);
    expect(ao).toBeLessThan(lamps);
    expect(f.lastIndexOf('#ifndef TONE_MAPPING', sky)).toBeGreaterThan(-1);
  });
});
