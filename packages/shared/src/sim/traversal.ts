import { PLAYER, TRAVERSAL } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';

/**
 * Climbing and vaulting (Kiran: "climb and jump over obstacles").
 *
 * - **Mantle**: facing something up to `TRAVERSAL.maxMantle` tall with room on top, jump (or hold
 *   jump in the air) and you pull yourself up onto it.
 * - **Vault**: sprinting into something up to `TRAVERSAL.maxVault` tall with open ground behind,
 *   jump and you hop over it in one motion, keeping your momentum.
 *
 * Detection is physics probes (the world tells us what's there); execution is a short fixed path
 * (rise → over), deterministic so client prediction and the server agree.
 */
export interface Ledge {
  kind: 'mantle' | 'vault';
  /** Ledge top height (world y). */
  top: number;
  /**
   * Waypoints after the start: rise in place → across above the top → (vault) drop. Axis-wise
   * segments, so the capsule never cuts an obstacle's corner; every one is overlap-checked.
   */
  path: Vec3[];
  /** Where the feet end up (last waypoint). */
  to: Vec3;
  /** Finish crouched (only a crouched body fits on top). */
  crouch: boolean;
}

export interface TraversalState {
  kind: 'mantle' | 'vault';
  t: number;
  dur: number;
  from: Vec3;
  path: Vec3[];
  to: Vec3;
  /** Horizontal direction of travel (unit). */
  dir: { x: number; z: number };
}

/** What the physics world must answer for traversal (implemented by `PhysicsWorld`). */
export interface LedgeQueries {
  /** `normal`: the surface normal at the hit (the slide's ground grade reads it). */
  castRay(
    origin: Vec3,
    dir: Vec3,
    maxDistance: number,
  ): { distance: number; point: Vec3; normal?: Vec3 } | null;
  overlapsStatic(feet: Vec3, height: number, shrink?: number): boolean;
  /**
   * A ray against what characters stand on (the static world plus the props' movement hulls):
   * the jetpack's ground probe. Absent: `castRay` stands in.
   */
  castGroundRay?(
    origin: Vec3,
    dir: Vec3,
    maxDistance: number,
  ): { distance: number; point: Vec3; normal?: Vec3 } | null;
}

/**
 * Look for a climbable ledge (or vaultable obstacle) straight ahead of a character at `feet`
 * facing horizontal unit direction `dir`. `vault` = allowed to vault (sprinting).
 */
export function probeLedge(
  world: LedgeQueries,
  feet: Vec3,
  dir: { x: number; z: number },
  vault: boolean,
  /** Extra reach (m), e.g. from running speed: sprinters commit to a vault from further out. */
  extraReach = 0,
  /** Current capsule height (crouched climbers stay crouched). */
  height: number = PLAYER.standHeight,
): Ledge | null {
  const R = PLAYER.radius;
  const d3 = { x: dir.x, y: 0, z: dir.z };
  // Rise starts a hair back from the face (the controller rests within its skin of it).
  const back = { x: feet.x - dir.x * 0.05, y: feet.y, z: feet.z - dir.z * 0.05 };
  // 1. Something right in front (knee height), within reach.
  const front = world.castRay(
    { x: feet.x, y: feet.y + 0.35, z: feet.z },
    d3,
    R + TRAVERSAL.reach + extraReach,
  );
  if (!front) return null;
  const faceDist = front.distance;
  // 2. Its top: cast down just past the front face — starting under any ceiling above that spot,
  //    so a slab overhead can't be mistaken for the ledge.
  // Just past the face, so thin barriers/fences (≈5–10 cm) still report their top.
  const inset = faceDist + 0.03;
  const px = feet.x + dir.x * inset;
  const pz = feet.z + dir.z * inset;
  let probeTop = feet.y + TRAVERSAL.maxMantle + 0.4;
  const ceiling = world.castRay(
    { x: px, y: feet.y + 0.3, z: pz },
    { x: 0, y: 1, z: 0 },
    probeTop - feet.y - 0.3,
  );
  if (ceiling && ceiling.distance > 0.05) probeTop = ceiling.point.y - 0.05;
  const down = world.castRay(
    { x: px, y: probeTop, z: pz },
    { x: 0, y: -1, z: 0 },
    probeTop - feet.y,
  );
  if (!down || down.distance < 0.05) return null; // taller than we can reach (ray starts inside)
  const top = down.point.y;
  const h = top - feet.y;
  if (h < TRAVERSAL.minHeight || h > TRAVERSAL.maxMantle) return null;
  // Mid-jump grabs reach higher from the feet; cap the ledge relative to the ground you left.
  const floor = world.castRay({ x: feet.x, y: feet.y + 0.1, z: feet.z }, { x: 0, y: -1, z: 0 }, 4);
  const groundY = floor ? floor.point.y : feet.y - 4;
  if (top - groundY > TRAVERSAL.maxFromGround) return null;
  // 3. Nothing overhanging the path over the edge (clear at chest height above the top).
  const over = world.castRay({ x: feet.x, y: top + 0.45, z: feet.z }, d3, inset + R + 0.2);
  if (over) return null;

  // Vault: low obstacle, sprinting, open ground on the far side at about our level.
  if (vault && h <= TRAVERSAL.maxVault) {
    for (const extra of [1.1, 1.6, 2.2]) {
      const qx = px + dir.x * extra;
      const qz = pz + dir.z * extra;
      const clear = world.castRay({ x: px, y: top + 0.35, z: pz }, d3, extra);
      if (clear) break;
      const g = world.castRay(
        { x: qx, y: top + 0.3, z: qz },
        { x: 0, y: -1, z: 0 },
        top + 0.3 - (feet.y - 1.2),
      );
      if (!g || g.distance < 0.05) continue;
      const gy = g.point.y;
      if (gy > top - 0.3) continue; // that's still the obstacle (deep): mantle instead
      const land = { x: qx, y: gy + 0.02, z: qz };
      if (world.overlapsStatic(land, PLAYER.standHeight)) continue;
      const lift = top + 0.12;
      const path = [{ ...back, y: lift }, { x: qx, y: lift, z: qz }, land];
      if (!pathClear(world, feet, path, height)) continue;
      return { kind: 'vault', top, path, to: land, crouch: false };
    }
  }

  // Mantle: stand (or crouch) on top, a little past the edge.
  const on = {
    x: feet.x + dir.x * (faceDist + R + 0.12),
    y: top + 0.02,
    z: feet.z + dir.z * (faceDist + R + 0.12),
  };
  // There must be something to stand on up there (a fence top is not a ledge).
  const support = world.castRay({ x: on.x, y: top + 0.1, z: on.z }, { x: 0, y: -1, z: 0 }, 0.35);
  if (!support) return null;
  const stand = !world.overlapsStatic(on, PLAYER.standHeight);
  if (!stand && world.overlapsStatic(on, PLAYER.crouchHeight)) return null;
  const path = [{ ...back, y: top + 0.05 }, on];
  if (!pathClear(world, feet, path, stand ? height : PLAYER.crouchHeight)) return null;
  return { kind: 'mantle', top, path, to: on, crouch: !stand };
}

/** Sample every segment of a path (capsule of `height`, slightly shrunk): nothing in the way. */
function pathClear(
  world: LedgeQueries,
  from: Vec3,
  path: readonly Vec3[],
  height: number,
): boolean {
  let a = from;
  for (const b of path) {
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.15));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      if (world.overlapsStatic(q, height, 0.02)) return false;
    }
    a = b;
  }
  return true;
}

/** Duration of a traversal (seconds): higher climbs take longer. */
export function traversalDuration(l: Ledge, from: Vec3): number {
  return l.kind === 'vault'
    ? TRAVERSAL.vaultTime
    : TRAVERSAL.mantleBase + TRAVERSAL.mantlePerMetre * Math.max(0, l.top - from.y);
}

/**
 * Position along the path at progress t/dur. Time is shared by segment length (constant speed
 * along the path) with an ease-in/out over the whole move.
 */
export function traversalPoint(s: TraversalState): Vec3 {
  const k0 = Math.min(1, s.t / s.dur);
  const k = k0 * k0 * (3 - 2 * k0);
  const pts = [s.from, ...s.path];
  const lens = pts
    .slice(1)
    .map((b, i) => Math.hypot(b.x - pts[i]!.x, b.y - pts[i]!.y, b.z - pts[i]!.z));
  const total = lens.reduce((x, y) => x + y, 0) || 1;
  let d = k * total;
  for (let i = 0; i < lens.length; i++) {
    const L = lens[i]!;
    if (d <= L || i === lens.length - 1) {
      const u = L > 0 ? Math.min(1, d / L) : 1;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
    }
    d -= L;
  }
  return { ...s.to };
}
