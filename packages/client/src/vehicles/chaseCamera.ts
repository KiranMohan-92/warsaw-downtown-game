/**
 * The driver's chase camera framing (presentation only). Walls are handled by the shared camera
 * collision (`collideCamera`); tree crowns have no collider (they only conceal), so on their own
 * the camera would sit inside a crown and see nothing but leaves. Here each nearby crown is a
 * volume matching the drawn tree, and the framing steps through a few candidates — the default
 * (back and a little up), then closer and higher — taking the first whose line from the truck is
 * clear of crowns (up to where walls stop it). The camera is then also kept short of the first
 * crown on its line, so even when every framing is obstructed it sits outside the leaves; what
 * is left between it and a truck parked right under a tree is faded (`treeModels.treeFade`).
 */
import { treeSpecies, treeWidthRatio, TREE_MODEL, type MapTree } from '@wd/shared';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A crown: from `base` to `top` (m) about the trunk axis (x, z), at most `r` wide. A broadleaf
 * crown is an ellipsoid; a pine's is a cone, widest at its lowest branches.
 */
export interface Crown {
  x: number;
  z: number;
  base: number;
  top: number;
  r: number;
  cone: boolean;
}

/** The crown a map tree draws (`treeModels.ts` proportions). */
export function crownOf(t: MapTree): Crown {
  const unit = TREE_MODEL[treeSpecies(t)].crown;
  const r = (treeWidthRatio(t, unit) * t.height) / 2;
  const cone = t.kind === 'conifer';
  const ground = t.y ?? 0;
  return {
    x: t.x,
    z: t.z,
    base: ground + t.height * (cone ? 0.22 : 0.4),
    top: ground + t.height,
    r,
    cone,
  };
}

/** Whether a point is inside a crown shrunk by `shrink` (m: the sparse outer leaves). */
export function insideCrown(p: V3, c: Crown, shrink = 0.3): boolean {
  if (p.y <= c.base || p.y >= c.top) return false;
  const h = c.top - c.base;
  const u = (p.y - c.base) / h; // 0 at the lowest branches, 1 at the top
  const w = c.cone ? 1 - u : Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2));
  const r = c.r * w - shrink;
  if (r <= 0) return false;
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  return dx * dx + dz * dz < r * r;
}

/** Crowns within `reach` (m, horizontal) of a point, written into `out`. */
export function crownsNear(
  crowns: readonly Crown[],
  p: V3,
  reach: number,
  out: Crown[] = [],
): Crown[] {
  out.length = 0;
  for (const c of crowns) {
    const r = reach + c.r;
    const dx = c.x - p.x;
    const dz = c.z - p.z;
    if (dx * dx + dz * dz < r * r) out.push(c);
  }
  return out;
}

/**
 * Where the segment a → b first enters a crown (fraction 0..1, 0 if `a` is inside), or null.
 * A small `shrink` (m) keeps the sparse outer leaves from counting.
 */
export function segmentCrown(a: V3, b: V3, c: Crown, shrink = 0.3): number | null {
  if (insideCrown(a, c, shrink)) return 0;
  // Sampled (every ~0.25 m) then refined: both shapes, no special cases, a few dozen tests.
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(2, Math.ceil(len / 0.25));
  let prev = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!insideCrown(lerp3(a, b, t), c, shrink)) {
      prev = t;
      continue;
    }
    let lo = prev;
    let hi = t;
    for (let k = 0; k < 6; k++) {
      const mid = (lo + hi) / 2;
      if (insideCrown(lerp3(a, b, mid), c, shrink)) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  return null;
}

const scratchP = { x: 0, y: 0, z: 0 };
function lerp3(a: V3, b: V3, t: number): V3 {
  scratchP.x = a.x + (b.x - a.x) * t;
  scratchP.y = a.y + (b.y - a.y) * t;
  scratchP.z = a.z + (b.z - a.z) * t;
  return scratchP;
}

/** Framing candidates: distance back along the view and lift (m), preferred first. */
export const CHASE_FRAMINGS: readonly { distance: number; lift: number }[] = [
  { distance: 6.8, lift: 0.4 },
  { distance: 5.2, lift: 1.1 },
  { distance: 4.0, lift: 1.8 },
];

/** The wanted camera point for a framing about `pivot`, looking along (yaw, pitch). */
export function framingPoint(
  pivot: V3,
  yaw: number,
  pitch: number,
  distance: number,
  lift: number,
  out: V3,
): V3 {
  // View forward = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch): the camera sits back.
  const cp = Math.cos(pitch);
  out.x = pivot.x + Math.sin(yaw) * cp * distance;
  out.y = pivot.y - Math.sin(pitch) * distance + lift;
  out.z = pivot.z + Math.cos(yaw) * cp * distance;
  return out;
}

/**
 * The fraction of pivot → want before the first crown (1 when clear). A crown the pivot itself is
 * in (a low tree over the truck) can't be got out of by framing, so it doesn't count.
 */
export function crownClear(pivot: V3, want: V3, crowns: readonly Crown[]): number {
  let t = 1;
  for (const c of crowns) {
    const e = segmentCrown(pivot, want, c);
    if (e !== null && e > 0 && e < t) t = e;
  }
  return t;
}

const scratchWant = { x: 0, y: 0, z: 0 };
const scratchEnd = { x: 0, y: 0, z: 0 };

/**
 * The first framing whose line from the truck is clear of crowns, up to where walls stop it
 * (`wall(pivot, want)`: the wall-free distance, the shared camera collision) — a crown behind a
 * wall doesn't matter. If every framing meets a crown, the one that gets furthest before it.
 */
export function pickFraming(
  pivot: V3,
  yaw: number,
  pitch: number,
  crowns: readonly Crown[],
  wall: (from: V3, to: V3) => number,
): number {
  let best = 0;
  let bestFree = -1;
  for (let i = 0; i < CHASE_FRAMINGS.length; i++) {
    const f = CHASE_FRAMINGS[i]!;
    const want = framingPoint(pivot, yaw, pitch, f.distance, f.lift, scratchWant);
    const len = Math.hypot(want.x - pivot.x, want.y - pivot.y, want.z - pivot.z);
    const k = len > 1e-6 ? Math.min(len, wall(pivot, want)) / len : 0;
    scratchEnd.x = pivot.x + (want.x - pivot.x) * k;
    scratchEnd.y = pivot.y + (want.y - pivot.y) * k;
    scratchEnd.z = pivot.z + (want.z - pivot.z) * k;
    const t = crownClear(pivot, scratchEnd, crowns);
    if (t >= 1) return i;
    if (t * k * len > bestFree) {
      bestFree = t * k * len;
      best = i;
    }
  }
  return best;
}

/**
 * Eases the framing between candidates: a more obstructed framing is taken at once (as walls pull
 * the camera in), a freer one only after it has stayed clear a moment, so it doesn't flicker at
 * the edge of a crown. Distance and lift then follow the chosen framing smoothly.
 */
export class FramingSmoother {
  distance = CHASE_FRAMINGS[0]!.distance;
  lift = CHASE_FRAMINGS[0]!.lift;
  private index = 0;
  private freerFor = 0;

  reset(): void {
    this.index = 0;
    this.freerFor = 0;
    this.distance = CHASE_FRAMINGS[0]!.distance;
    this.lift = CHASE_FRAMINGS[0]!.lift;
  }

  update(want: number, dt: number, hold = 0.5, tau = 0.15): void {
    if (want > this.index) {
      this.index = want;
      this.freerFor = 0;
    } else if (want < this.index) {
      this.freerFor += dt;
      if (this.freerFor >= hold) {
        this.index = want;
        this.freerFor = 0;
      }
    } else this.freerFor = 0;
    const f = CHASE_FRAMINGS[this.index]!;
    const k = 1 - Math.exp(-dt / tau);
    this.distance += (f.distance - this.distance) * k;
    this.lift += (f.lift - this.lift) * k;
  }

  get framing(): number {
    return this.index;
  }
}
