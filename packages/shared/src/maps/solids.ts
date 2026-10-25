/**
 * Volumetric authoring on convex prisms: stack tiers, carve rooms/doors/passages. Every operation
 * keeps pieces convex, so they drop straight into Rapier convex-hull colliders and the renderer.
 */
import { stairs, type Dir } from './builder.ts';
import { area, clipConvex, rectPoly, subtractConvex, type Poly } from './geom.ts';
import type { MapBox, MapPrism, MaterialId } from './types.ts';

export interface Solid {
  pts: Poly;
  y0: number;
  y1: number;
}

/** Pieces ∩ window (or all pieces) extruded y0..y1. */
export function tier(
  pieces: readonly Poly[],
  window: Poly | null,
  y0: number,
  y1: number,
): Solid[] {
  const out: Solid[] = [];
  for (const p of pieces) {
    const c = window ? clipConvex(p, window) : p;
    if (c.length >= 3 && area(c) > 0.01) out.push({ pts: c, y0, y1 });
  }
  return out;
}

/** Remove the volume `hole` × [y0, y1] from every solid (doors, halls, passages, porches). */
export function carve(solids: readonly Solid[], hole: Poly, y0: number, y1: number): Solid[] {
  const out: Solid[] = [];
  for (const s of solids) {
    if (s.y1 <= y0 || s.y0 >= y1) {
      out.push(s);
      continue;
    }
    const inside = clipConvex(s.pts, hole);
    if (inside.length < 3) {
      out.push(s);
      continue;
    }
    for (const p of subtractConvex(s.pts, hole)) out.push({ pts: p, y0: s.y0, y1: s.y1 });
    if (y0 > s.y0) out.push({ pts: inside, y0: s.y0, y1: y0 });
    if (y1 < s.y1) out.push({ pts: inside, y0: y1, y1: s.y1 });
  }
  return out;
}

export const toPrisms = (
  solids: readonly Solid[],
  mat: MaterialId,
  extra: Partial<MapPrism> = {},
): MapPrism[] =>
  solids.map((s) => ({
    pts: s.pts.map((q) => [q[0], q[1]] as [number, number]),
    y0: s.y0,
    y1: s.y1,
    mat,
    ...extra,
  }));

// ---- underground ---------------------------------------------------------------------------------

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
export const R = (x0: number, z0: number, x1: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  z0: Math.min(z0, z1),
  x1: Math.max(x0, x1),
  z1: Math.max(z0, z1),
});
export const rectToPoly = (r: Rect): Poly => rectPoly(r.x0, r.z0, r.x1, r.z1);

/**
 * Underground network from axis-aligned rooms/corridors (union of rects) at one floor level:
 * floor slabs, and walls along every rect edge except where another rect continues the space.
 * The ceiling is the street slab above.
 */
export function underground(
  rooms: readonly Rect[],
  floorY: number,
  ceilY: number,
  mat: MaterialId = 'concrete',
  /** Walls (default: the floor's material). */
  wallMat: MaterialId = mat,
): MapBox[] {
  const boxes: MapBox[] = [];
  const t = 0.4;
  const h = ceilY - floorY;
  const inside = (x: number, z: number): boolean =>
    rooms.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  for (const r of rooms) {
    boxes.push({
      center: { x: (r.x0 + r.x1) / 2, y: floorY - 0.15, z: (r.z0 + r.z1) / 2 },
      size: { x: r.x1 - r.x0, y: 0.3, z: r.z1 - r.z0 },
      mat,
    });
    // Edges: [fixed coord, from, to, axis, outward sign]
    const edges: [number, number, number, 'x' | 'z', number][] = [
      [r.x0, r.z0, r.z1, 'x', -1],
      [r.x1, r.z0, r.z1, 'x', 1],
      [r.z0, r.x0, r.x1, 'z', -1],
      [r.z1, r.x0, r.x1, 'z', 1],
    ];
    for (const [fixed, a, b, axis, sgn] of edges) {
      // Walk the edge in 0.25 m samples; runs whose outside neighbour is open get no wall.
      const step = 0.25;
      let runStart: number | null = null;
      const flush = (end: number): void => {
        if (runStart === null || end - runStart < 0.05) {
          runStart = null;
          return;
        }
        const mid = (runStart + end) / 2;
        const len = end - runStart + (axis === 'x' ? 0 : 0);
        boxes.push({
          center:
            axis === 'x'
              ? { x: fixed + (sgn * t) / 2, y: floorY + h / 2, z: mid }
              : { x: mid, y: floorY + h / 2, z: fixed + (sgn * t) / 2 },
          size: axis === 'x' ? { x: t, y: h, z: len } : { x: len, y: h, z: t },
          mat: wallMat,
        });
        runStart = null;
      };
      for (let u = a; u < b - 1e-6; u += step) {
        const um = Math.min(b, u + step / 2);
        const ox = axis === 'x' ? fixed + sgn * 0.05 : um;
        const oz = axis === 'x' ? um : fixed + sgn * 0.05;
        const open = inside(ox, oz);
        if (!open && runStart === null) runStart = u;
        if (open) flush(u);
      }
      flush(b);
    }
  }
  return boxes;
}

/**
 * A stair from street level down to `floorY`, descending along `dir` from the top edge (tx, tz).
 * Returns the stair boxes, the slab opening to cut, and waist-high rails on the open sides.
 */
export function stairDown(
  tx: number,
  tz: number,
  dir: Dir,
  floorY: number,
  width: number,
  topY = 0,
): { boxes: MapBox[]; opening: Rect } {
  const rise = topY - floorY;
  const run = rise / Math.tan((33 * Math.PI) / 180);
  const along = dir === '+x' || dir === '-x';
  const s = dir === '+x' || dir === '+z' ? 1 : -1;
  const bx = along ? tx + s * run : tx;
  const bz = along ? tz : tz + s * run;
  const up: Dir = along ? (s > 0 ? '-x' : '+x') : s > 0 ? '-z' : '+z';
  const boxes = stairs({ x: bx, y: floorY, z: bz }, up, run, rise, width, 'concrete');
  const opening = along
    ? R(tx, tz - width / 2, tx + s * (run + 0.4), tz + width / 2)
    : R(tx - width / 2, tz, tx + width / 2, tz + s * (run + 0.4));
  // Rails on the two long sides and across the bottom end, at street level.
  const rail = (x0: number, z0: number, x1: number, z1: number): MapBox => ({
    center: { x: (x0 + x1) / 2, y: topY + 0.5, z: (z0 + z1) / 2 },
    size: { x: Math.max(0.08, Math.abs(x1 - x0)), y: 1.0, z: Math.max(0.08, Math.abs(z1 - z0)) },
    mat: 'metal',
  });
  const o = opening;
  if (along) {
    boxes.push(
      rail(o.x0, o.z0 - 0.05, o.x1, o.z0 - 0.05),
      rail(o.x0, o.z1 + 0.05, o.x1, o.z1 + 0.05),
    );
    const endX = s > 0 ? o.x1 + 0.05 : o.x0 - 0.05;
    boxes.push(rail(endX, o.z0, endX, o.z1));
  } else {
    boxes.push(
      rail(o.x0 - 0.05, o.z0, o.x0 - 0.05, o.z1),
      rail(o.x1 + 0.05, o.z0, o.x1 + 0.05, o.z1),
    );
    const endZ = s > 0 ? o.z1 + 0.05 : o.z0 - 0.05;
    boxes.push(rail(o.x0, endZ, o.x1, endZ));
  }
  return { boxes, opening };
}
