import { SMOKE } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';

/**
 * Thermal-blocking smoke: a cloud that blooms, holds and thins out. It blocks sight for players
 * (rendered), drone cameras and bots (this model) — including thermal, which is the point of
 * modern multispectral smoke. Deterministic; the M3 server owns the clouds.
 */
export interface SmokeCloud {
  id: number;
  pos: Vec3;
  age: number;
}

export const smokeLifetime = (): number => SMOKE.bloom + SMOKE.hold + SMOKE.fade;

/** Current radius (m) and density (0..1) of a cloud. */
export function smokeShape(c: SmokeCloud): { radius: number; density: number } {
  return { radius: smokeRadius(c), density: smokeDensity(c) };
}

function smokeRadius(c: SmokeCloud): number {
  const bloom = Math.min(1, c.age / SMOKE.bloom);
  return SMOKE.radius * (0.35 + 0.65 * Math.sqrt(bloom));
}

function smokeDensity(c: SmokeCloud): number {
  const fadeStart = SMOKE.bloom + SMOKE.hold;
  return c.age < fadeStart ? 1 : Math.max(0, 1 - (c.age - fadeStart) / SMOKE.fade);
}

/** Age clouds; returns the clouds still alive. */
export function stepSmoke(clouds: SmokeCloud[], dt: number): SmokeCloud[] {
  for (const c of clouds) c.age += dt;
  return clouds.filter((c) => c.age < smokeLifetime());
}

/**
 * The clouds as they were at server time `atMs`, from a list whose ages are as of `listMs`: a
 * cloud's shape is a pure function of its age, so each is aged by `atMs − listMs` (younger for
 * an earlier time), and only those alive then are kept — popped (age > 0) and not yet gone
 * (age < lifetime, the rule `stepSmoke` drops them by). Smart-round concealment and the online
 * smoke drawing use this at the view time on both sides, so a cloud that pops while a shot is in
 * flight never decides it and what is drawn is what is judged. The list must still hold clouds
 * that expired within the rewind window (the server retains them and sends them in its
 * snapshots, so both sides rewind the same set). `out` is reused (its objects too) so a per-frame caller makes no garbage.
 */
export function smokeAt(
  clouds: readonly SmokeCloud[],
  listMs: number,
  atMs: number,
  out: SmokeCloud[] = [],
): SmokeCloud[] {
  const shift = (atMs - listMs) / 1000;
  const life = smokeLifetime();
  let n = 0;
  for (const c of clouds) {
    const age = c.age + shift;
    // Popped at age 0 (the tick before it was first listed): not there yet at that time.
    if (age <= 1e-9 || age >= life) continue;
    const o = out[n];
    if (o) {
      o.id = c.id;
      o.pos = c.pos;
      o.age = age;
    } else out[n] = { id: c.id, pos: c.pos, age };
    n++;
  }
  out.length = n;
  return out;
}

/** Centre of a cloud's sphere: it sits on the ground and billows up (≈0.4 radius above). */
export function smokeCentre(c: SmokeCloud): Vec3 {
  const { radius } = smokeShape(c);
  return { x: c.pos.x, y: c.pos.y + radius * 0.4, z: c.pos.z };
}

/**
 * Visibility of `to` from `from` through smoke: 1 = clear, 0 = hidden. Counts the length of the
 * sight line inside each cloud (a sphere), weighted by its density.
 */
export function smokeVisibility(clouds: readonly SmokeCloud[], from: Vec3, to: Vec3): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return 1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  let depth = 0;
  for (const c of clouds) {
    // Hot render callers test every pooled particle; keep this segment test allocation-free.
    const radius = smokeRadius(c);
    const density = smokeDensity(c);
    if (density <= 0) continue;
    const ox = from.x - c.pos.x;
    const oy = from.y - (c.pos.y + radius * 0.4);
    const oz = from.z - c.pos.z;
    const b = ox * ux + oy * uy + oz * uz;
    const cc = ox * ox + oy * oy + oz * oz - radius * radius;
    const disc = b * b - cc;
    if (disc <= 0) continue;
    const s = Math.sqrt(disc);
    const t0 = Math.max(0, -b - s);
    const t1 = Math.min(len, -b + s);
    if (t1 > t0) depth += (t1 - t0) * density;
  }
  return Math.max(0, 1 - depth / SMOKE.blockDepth);
}
