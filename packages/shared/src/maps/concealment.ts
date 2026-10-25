import type { Vec3 } from '../math/vec3.ts';
import type { MapFoliage } from './types.ts';

/**
 * Line-of-sight through soft cover (bushes, tall grass), shared by rendering-independent systems:
 * bot perception (M3/M6) and any server-side visibility checks. Hard cover (walls, trunks) is a
 * physics ray cast; this adds what physics can't see because foliage has no collider.
 *
 * Model: each clump is a vertical cylinder (r, h). Sight is blocked by the total length of the
 * sight line that passes through foliage: ≥ `BLOCK_DEPTH` metres of leaves hides a target
 * completely; less gives partial visibility (bots can "glimpse").
 */
export const FOLIAGE_BLOCK_DEPTH = 1.6;

const CELL = 8;

export class FoliageIndex {
  private readonly grid = new Map<string, MapFoliage[]>();

  constructor(readonly items: readonly MapFoliage[]) {
    for (const f of items) {
      const x0 = Math.floor((f.x - f.r) / CELL);
      const x1 = Math.floor((f.x + f.r) / CELL);
      const z0 = Math.floor((f.z - f.r) / CELL);
      const z1 = Math.floor((f.z + f.r) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = `${x},${z}`;
          const list = this.grid.get(k) ?? [];
          list.push(f);
          this.grid.set(k, list);
        }
      }
    }
  }

  /**
   * Visibility of `to` from `from` through foliage: 1 = clear, 0 = fully hidden. Only the
   * foliage between them counts, at the height the line passes (tall grass hides a crouched
   * body, not a standing one).
   */
  visibility(from: Vec3, to: Vec3): number {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return 1;
    // Walk the grid cells along the segment (DDA-lite: sample every half cell).
    const seen = new Set<MapFoliage>();
    const steps = Math.ceil(len / (CELL / 2)) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const k = `${Math.floor((from.x + dx * t) / CELL)},${Math.floor((from.z + dz * t) / CELL)}`;
      for (const f of this.grid.get(k) ?? []) seen.add(f);
    }
    let depth = 0;
    for (const f of seen) depth += this.depthThrough(from, to, f, len);
    return Math.max(0, 1 - depth / FOLIAGE_BLOCK_DEPTH);
  }

  /** Length (m, horizontal) of the segment inside the clump's cylinder, below its top. */
  private depthThrough(a: Vec3, b: Vec3, f: MapFoliage, len: number): number {
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    const ox = a.x - f.x;
    const oz = a.z - f.z;
    const bq = ox * dx + oz * dz;
    const c = ox * ox + oz * oz - f.r * f.r;
    const disc = bq * bq - c;
    if (disc <= 0) return 0;
    const s = Math.sqrt(disc);
    const t0 = Math.max(0, -bq - s);
    const t1 = Math.min(len, -bq + s);
    if (t1 <= t0) return 0;
    // Clip to the clump's vertical extent [base, top]: sight lines over it (from a roof) or
    // under it (a tunnel below a surface bush) don't count.
    const base = f.y ?? 0;
    const top = base + f.h;
    const dy = (b.y - a.y) / len;
    let lo = t0;
    let hi = t1;
    if (Math.abs(dy) < 1e-9) {
      if (a.y < base || a.y > top) return 0;
    } else {
      // Parameter range where y ∈ [base, top].
      const tb = (base - a.y) / dy;
      const tt = (top - a.y) / dy;
      lo = Math.max(lo, Math.min(tb, tt));
      hi = Math.min(hi, Math.max(tb, tt));
    }
    return Math.max(0, hi - lo);
  }
}
