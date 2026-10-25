/**
 * Rain physics for the presentation (render/rain.ts, materials, audio). Pure functions, no three.js.
 *
 * - Drop sizes follow the Marshall–Palmer spectrum N(D) = N0·e^(−ΛD), Λ = 4.1·R^(−0.21) mm⁻¹
 *   (R = rain rate in mm/h). The drawn population is that spectrum weighted by the drop's
 *   projected area (D²): sub-millimetre drops are invisible at game distances, so drawing them by
 *   count would waste the budget on drizzle nobody sees. That is a Gamma(3, Λ) law, truncated to
 *   [DROP_MIN_MM, DROP_MAX_MM] (bigger drops break up in free fall).
 * - Fall speed is the terminal velocity of Atlas, Srivastava & Sekhon (1973):
 *   v(D) = 9.65 − 10.3·e^(−0.6·D) m/s (D in mm): ≈ 4 m/s at 1 mm, 6.5 m/s at 2 mm, 8.8 m/s at 4 mm.
 * - Streak visibility is coverage-preserving, so the same rain conceals the same amount at every
 *   render scale and quality tier (fairness: concealment identical at all tiers).
 */

/** Storm rain rate the rain preset depicts (mm/h): heavy convective rain. */
export const STORM_RAIN_RATE = 25;
export const DROP_MIN_MM = 0.5;
export const DROP_MAX_MM = 5;

/** Marshall–Palmer slope Λ (mm⁻¹) for a rain rate in mm/h. */
export function marshallPalmerLambda(rainRate: number): number {
  return 4.1 * Math.pow(Math.max(rainRate, 0.1), -0.21);
}

/** Terminal fall speed (m/s) of a drop of diameter `d` mm (Atlas et al. 1973), ≥ 0. */
export function terminalVelocity(dMm: number): number {
  return Math.max(0, 9.65 - 10.3 * Math.exp(-0.6 * dMm));
}

/** Deterministic PRNG (mulberry32): the same drop field every session (and in tests). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One drawn drop diameter (mm): area-weighted Marshall–Palmer, i.e. Gamma(3, Λ), truncated to
 * [DROP_MIN_MM, DROP_MAX_MM] by rejection (a sum of three exponentials; ~1.1 tries on average).
 */
export function sampleDropDiameter(rnd: () => number, rainRate = STORM_RAIN_RATE): number {
  const lambda = marshallPalmerLambda(rainRate);
  for (let i = 0; i < 64; i++) {
    const d = -Math.log((1 - rnd()) * (1 - rnd()) * (1 - rnd())) / lambda;
    if (d >= DROP_MIN_MM && d <= DROP_MAX_MM) return d;
  }
  return 3 / lambda; // the mode-ish mean; practically unreachable
}

/**
 * Wind the drops ride (m/s, horizontal). Drops reach the air's speed within a few metres of fall,
 * so they drift with the wind: a breeze when calm, a storm's 5–6 m/s in a full gust.
 * `strength` 0..1 is the weather's wind (foliage `windStrengthFor`), `gust` 0..1 the shared
 * `WindGusts` signal.
 */
export function rainWindSpeed(strength: number, gust: number): number {
  const s = Math.min(1, Math.max(0, strength));
  const g = Math.min(1, Math.max(0, gust));
  return 0.6 + s * (1.6 + 4.2 * g);
}

/**
 * Exposure (s) that turns falling drops into streaks: the long trails the eye (and a 1/15 s film
 * frame) sees in a downpour, so rain reads as hair-fine lines, not dashes.
 */
export const STREAK_EXPOSURE = 1 / 18;
/** Share of the camera's own motion that smears the streaks (turning/sprinting tilts them). */
export const CAMERA_SMEAR = 0.45;
/** Eye focus distance (m) and pupil (m): drops nearer than ~2 m are defocused. */
export const FOCUS_DISTANCE = 6;
export const APERTURE = 0.004;

/**
 * Perceptual gain on the physical streak coverage: drops are ~2 mm, but the eye reads rain by its
 * glints, which are wider than the geometric drop.
 */
export const STREAK_GAIN = 60;
/**
 * A drop's glint is spread by the eye (ocular scatter) over more than its geometric size as it
 * recedes, so distant streaks stay readable: coverage × (1 + z / GLINT_DISTANCE). Depends only on
 * depth, so it is the same at every render scale and tier.
 */
export const GLINT_DISTANCE = 5;
/** Drawn drop width relative to its diameter (the highlight band of a drop is wider). */
export const DROP_VISUAL_SCALE = 2.2;
/** Most opaque a streak pixel gets; past it a streak is drawn longer, never wider. */
export const STREAK_ALPHA_CAP = 0.42;
/**
 * Widest a streak is drawn: 1.5 px at a 720 px-tall target (scaled with the target, so the clamp is
 * the same at every render scale): defocused near drops stay soft lines, never bars.
 */
export const STREAK_MAX_WIDTH = 1.5;
export const STREAK_MAX_WIDTH_REF_H = 720;
/** Each end of a streak fades in/out over this share of its drawn length (no hard ends). */
export const STREAK_TAPER = 0.25;
/** Longest a streak is drawn, as a share of the render-target height. */
export const STREAK_MAX_LENGTH = 0.18;
/** Streaks covering less than this share of the screen are skipped (scale-invariant cull). */
export const STREAK_CULL_SHARE = 1e-7;

export interface StreakInput {
  /** Drop diameter (mm). */
  dMm: number;
  /** View depth (m). */
  z: number;
  /** Streak length from its motion, in render-target pixels. */
  lengthPx: number;
  /** Render-target height in pixels and projection[1][1] (1 / tan(vfov / 2)). */
  viewportH: number;
  viewportW: number;
  proj11: number;
  /** Extra visibility factor (fog, near fade), 0..1. */
  fade?: number;
}

export interface StreakFootprint {
  /** Drawn width (px, 1..STREAK_MAX_WIDTH). */
  width: number;
  /** Drawn core length (px): the motion length, longer when the alpha cap spreads it. */
  length: number;
  /** Length of each tapered end (px). */
  ramp: number;
  /** Per-pixel opacity on the kernel's plateau (≤ the cap). */
  alpha: number;
  /** Alpha-weighted pixel area the streak covers (opacity × the drop's own area). */
  coverage: number;
  culled: boolean;
}

/**
 * How a streak is drawn — the exact maths of the rain vertex shader (render/rain.ts mirrors these
 * lines). Coverage-preserving at every render scale and tier: over the exposure a drop hides its
 * own area (gain × sharpPx² × glint × fade); the kernel (`streakKernel`) integrates to exactly
 * width × (length + width), so alpha = coverage / that area. Widths stay 1..1.5 px (defocus never
 * makes a bar); past the opacity cap the streak is drawn longer instead; every pixel quantity is
 * in render-target pixels, so each clamp is the same at any render scale; a streak too bright for
 * the longest capped line is widened up to maxW, so no coverage is lost; the one cap on coverage
 * (coverCap) is proportional to the target; the cull compares coverage with the screen size.
 */
export function streakFootprint(s: StreakInput): StreakFootprint {
  const focal = s.proj11 * 0.5 * s.viewportH;
  const sharp = (s.dMm * 0.001 * DROP_VISUAL_SCALE * focal) / s.z;
  const blur = APERTURE * focal * Math.abs(1 / s.z - 1 / FOCUS_DISTANCE);
  const maxW = Math.max(1, (STREAK_MAX_WIDTH * s.viewportH) / STREAK_MAX_WIDTH_REF_H);
  const width0 = Math.min(maxW, Math.max(1, Math.sqrt(sharp * sharp + blur * blur)));
  const maxLen = STREAK_MAX_LENGTH * s.viewportH;
  // The most a streak may hide: a full-cap streak of the longest length and the (unfloored,
  // proportional) widest width. It scales with the target squared, as coverage does, so the cap
  // bites at the same drops by the same share at every render scale.
  const mw = (STREAK_MAX_WIDTH * s.viewportH) / STREAK_MAX_WIDTH_REF_H;
  const coverCap = STREAK_ALPHA_CAP * mw * (maxLen + mw);
  const raw = STREAK_GAIN * sharp * sharp * (1 + s.z / GLINT_DISTANCE) * (s.fade ?? 1);
  const coverage = Math.min(raw, coverCap);
  let width = width0;
  let length = Math.min(s.lengthPx, maxLen);
  if (coverage / (width * (length + width)) > STREAK_ALPHA_CAP) {
    // Past the cap: longer first; at the longest, a little wider (never past maxW). Coverage is
    // carried over in full: it fits, since it is at most coverCap and maxW ≥ mw.
    length = Math.min(maxLen, coverage / (STREAK_ALPHA_CAP * width) - width);
    if (coverage / (width * (length + width)) > STREAK_ALPHA_CAP) {
      const w = 0.5 * (Math.sqrt(length * length + (4 * coverage) / STREAK_ALPHA_CAP) - length);
      width = Math.min(maxW, Math.max(width, w));
    }
  }
  const alpha = Math.min(STREAK_ALPHA_CAP, coverage / (width * (length + width)));
  const ramp = Math.max(1, (STREAK_TAPER / (1 - STREAK_TAPER)) * (length + width));
  const culled = raw < STREAK_CULL_SHARE * s.viewportW * s.viewportH;
  return { width, length, ramp, alpha, coverage, culled };
}

/**
 * The fragment kernel (mirrors the rain fragment shader): `u` = px across from the centre line,
 * `a` = px along from the start of the drawn streak. Across: a hard box for a 1 px streak (exact on
 * average over sub-pixel positions), else a bar of `width` with 1 px edges; both integrate to the
 * width. Along: a trapezoid over [0, length + width + ramp] with `ramp`-long linear ends (≥ 25 % of
 * the length each: tapered, never a hard end), integrating to length + width.
 */
export function streakKernel(
  u: number,
  a: number,
  f: Pick<StreakFootprint, 'width' | 'length' | 'ramp'>,
): number {
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const across =
    f.width <= 1 ? (Math.abs(u) <= 0.5 ? 1 : 0) : clamp01(f.width * 0.5 + 0.5 - Math.abs(u));
  const total = f.length + f.width + f.ramp;
  const along = clamp01(a / f.ramp) * clamp01((total - a) / f.ramp);
  return across * along;
}

/**
 * How far (px) the drawn streak reaches ahead of the drop, along its motion (mirrors the vertex
 * shader's placement). Only the drop itself is tested against the rain occlusion and the quad keeps
 * the drop's depth, so this lead is drawn even under a shelter right below the drop: it is half a
 * width, as in the pre-taper streak, with both tapered ends on the trail (exposed) side.
 */
export function streakLeadPx(f: Pick<StreakFootprint, 'width' | 'ramp'>): number {
  return f.width * 0.5;
}

/**
 * Alpha-weighted pixel area of a rasterised streak: the kernel sampled at pixel centres over its
 * quad (a horizontal streak at a sub-pixel offset), averaged over offsets as a moving streak is.
 */
export function rasterCoverage(f: StreakFootprint, offset?: number, offsetAlong = offset): number {
  if (f.culled) return 0;
  if (offset === undefined) {
    let s = 0;
    for (let i = 0; i < 24; i++)
      for (let k = 0; k < 24; k++) s += rasterCoverage(f, (i + 0.5) / 24, (k + 0.5) / 24);
    return s / 576;
  }
  const oa = offsetAlong ?? offset;
  const r = f.width * 0.5 + 0.5;
  const total = f.length + f.width + f.ramp;
  let sum = 0;
  for (let py = Math.floor(-r + offset) - 1; py <= Math.ceil(r + offset) + 1; py++) {
    for (let px = Math.floor(oa) - 1; px <= Math.ceil(total + oa) + 1; px++) {
      sum += f.alpha * streakKernel(py + 0.5 - offset, px + 0.5 - oa, f);
    }
  }
  return sum;
}

/**
 * Surface wetness over time: 0 = dry, 1 = soaked. Wetting is quick (a film forms in seconds,
 * puddles fill over the first half minute), drying is slow. The first value set is applied at
 * once (a match that starts in rain has been raining for a while).
 */
export class WetnessRamp {
  static readonly WET_TAU = 9;
  static readonly DRY_TAU = 50;
  value = 0;
  private target = 0;
  private primed = false;

  set(target: number): void {
    this.target = Math.min(1, Math.max(0, target));
    if (!this.primed) {
      this.primed = true;
      this.value = this.target;
    }
  }

  update(dt: number): number {
    const tau = this.target > this.value ? WetnessRamp.WET_TAU : WetnessRamp.DRY_TAU;
    this.value += (this.target - this.value) * (1 - Math.exp(-Math.max(0, dt) / tau));
    if (Math.abs(this.target - this.value) < 1e-4) this.value = this.target;
    return this.value;
  }
}

/**
 * Puddle fill for a surface wetness: basins only hold standing water once the ground is
 * saturated (the last ~60 % of the ramp).
 */
export function puddleFill(wetness: number): number {
  const t = Math.min(1, Math.max(0, (wetness - 0.4) / 0.6));
  return t * t * (3 - 2 * t);
}
