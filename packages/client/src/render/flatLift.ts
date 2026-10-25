/**
 * How far the rendered ground sits above the collision at a point: the map's flats (paving,
 * asphalt, grass markings) are drawn lifted by layer (`mapMesh.FLAT_LIFT`), up to ~2 cm, while
 * rays meet the collision floor under them. Things resting on the ground at runtime (impact
 * chunks) add this so they lie on the paving, not inside it. A coarse bucket grid built once.
 */
import type { MapFlat } from '@wd/shared';
import { FLAT_LIFT, flatDrawLayer } from './mapMesh.ts';

const CELL = 8;
/** A flat counts at a point when it lies within this of the contact height (m). */
const FLAT_Y_TOLERANCE = 0.05;

export type GroundLift = (x: number, y: number, z: number) => number;

export function createFlatLift(flats: readonly MapFlat[]): GroundLift {
  const cells = new Map<string, number[]>();
  const boxes = flats.map((f, i) => {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of f.pts) {
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const key = `${cx},${cz}`;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(i);
      }
    }
    return { x0, z0, x1, z1, lift: FLAT_LIFT.base + flatDrawLayer(f) * FLAT_LIFT.perLayer };
  });
  return (x, y, z) => {
    const list = cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return 0;
    let lift = 0;
    for (const i of list) {
      const b = boxes[i]!;
      const f = flats[i]!;
      if (b.lift <= lift || x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (Math.abs(f.y - y) > FLAT_Y_TOLERANCE || !inside(f.pts, x, z)) continue;
      lift = b.lift;
    }
    return lift;
  };
}

/** Even-odd point-in-polygon on (x, z). */
function inside(pts: MapFlat['pts'], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]!;
    const [xj, zj] = pts[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
