/**
 * Dynamic resolution: keeps frame time at the display's budget (60 Hz, or the panel's own slower
 * refresh: `RefreshEstimate`) by adjusting the internal render scale (the HUD stays native). Integrated GPUs are fill-rate bound, so resolution is the
 * lever that works (measured on Intel UHD at 1080p: 100% → 40 fps, 75% → 70 fps).
 *
 * Under vsync a healthy frame time sits *at* the budget, so "headroom" can't be observed
 * directly; after a long stable stretch we probe one step up and back off (with a growing wait)
 * if the probe misses.
 *
 * Every change resizes the render targets, which is itself a visible hitch on integrated GPUs
 * (measured 100–800 ms). So changes are rare by design: drop only after a full second over
 * budget, probe up only after 30 s of stability (backing off to 5 min after a miss).
 *
 * **With a GPU timer** (`gpuMs`, EXT_disjoint_timer_query_webgl2) headroom *is* observable: the
 * GPU's own frame time under vsync. After a short stable stretch the scale jumps straight to the
 * largest step whose predicted GPU time (`predictGpuMs`) fits `GPU_HEADROOM` of the budget: one
 * resize instead of a 30 s probe per step, so Auto climbs back from a tier drop's low resolution
 * in seconds. A raise that still misses backs off like a probe and caps further raises below
 * that scale for the probe wait. Without a timer (other browsers) the blind probes remain.
 */
/** Share of the frame budget a GPU-guided raise may fill (the rest absorbs view changes). */
export const GPU_HEADROOM = 0.85;
/**
 * Resolution-independent share of the GPU frame (geometry, shadow pass, depth pre-pass),
 * measured on Intel UHD (Market, Low, GPU timer queries): 23.4 ms at 100 %, 13.8 ms at 60 %.
 */
export const GPU_FIXED_SHARE = 0.35;
/** Stable time before a GPU-guided raise (half during a fast start). */
export const GPU_STABLE_MS = 2500;

/**
 * GPU ms predicted at scale `to` from `gpuMs` measured at scale `from`: the frame at full
 * resolution is `GPU_FIXED_SHARE` fixed work plus the rest ∝ pixels (scale²).
 */
export function predictGpuMs(gpuMs: number, from: number, to: number): number {
  const at = (s: number): number => GPU_FIXED_SHARE + (1 - GPU_FIXED_SHARE) * s * s;
  return (gpuMs * at(to)) / at(from);
}

/** The game's frame target: 60 fps, unless the display itself refreshes slower. */
export const TARGET_FRAME_MS = 1000 / 60;
/** The slowest display refresh taken at face value (48 Hz); anything slower is load, not a panel. */
export const SLOWEST_PANEL_MS = 1000 / 48;

/**
 * The display's refresh interval, learned from **light** frames only (menu/paused frames, or
 * frames the GPU timer shows finished well inside the interval). Some panels and compositors run
 * below 60 Hz (measured: an empty page in Kiran's visible Chrome ticks at 56 Hz, 17.8 ms); a
 * fixed 16.7 ms budget then reads every frame as late, so dynamic resolution sinks to its floor
 * and Auto drops tiers on a GPU with headroom. Heavy frames never teach it: a slow GPU must
 * still read as slow. The estimate never goes below the 60 Hz target (faster displays still
 * aim for 60) nor slower than 48 Hz (`SLOWEST_PANEL_MS`).
 */
/**
 * Whether a frame can teach `RefreshEstimate`: the menu is up (almost no GPU work), or the GPU's
 * own time is well inside a 60 Hz frame. Judged without the frame's interval: an interval-relative
 * test would accept missed-vsync frames (33 ms) and reject on-time ones (Codex P2).
 */
export function isLightFrame(paused: boolean, gpuMs: number): boolean {
  return paused || (gpuMs > 0 && gpuMs < TARGET_FRAME_MS * 0.6);
}

export class RefreshEstimate {
  private readonly ring = new Float32Array(90);
  private n = 0;
  private i = 0;
  private sinceSort = 0;
  /** Current estimate (ms per refresh), at least the 60 Hz target. */
  ms = TARGET_FRAME_MS;

  push(frameMs: number, light: boolean): void {
    if (!light || !(frameMs > 4) || frameMs > 1000 / 30) return;
    this.ring[this.i] = frameMs;
    this.i = (this.i + 1) % this.ring.length;
    this.n = Math.min(this.ring.length, this.n + 1);
    if (++this.sinceSort < 30 || this.n < 60) return;
    this.sinceSort = 0;
    // A missed refresh only ever lengthens an interval (whole multiples), so a low quantile is
    // one refresh even when most callbacks miss (CPU-bound play, a busy menu). Clamped to the
    // slowest real panels (48 Hz): a misreading can loosen the budget by at most ~25 %.
    const sorted = Array.from(this.ring.subarray(0, this.n)).sort((a, b) => a - b);
    const low = sorted[Math.floor(this.n * 0.15)]!;
    this.ms = Math.min(SLOWEST_PANEL_MS, Math.max(TARGET_FRAME_MS, low));
  }

  /** The frame rate the governor should expect from this display. */
  get fps(): number {
    return 1000 / this.ms;
  }
}

export class DynamicResolution {
  scale: number;
  private samples = 0;
  private sumMs = 0;
  private windowMs = 0;
  private stableMs = 0;
  private probeWaitMs = 30000;
  private probing = false;
  /** Consecutive over-budget windows (a drop needs two: one full second). */
  private overWindows = 0;
  /** Right after start (no remembered setting): converge quickly, one window per drop. */
  private fastMs = 0;
  /** Total time fed (ms): the clock of the raise cap. */
  private clockMs = 0;
  /** A raise to this scale (or above) missed: none to it before `capUntilMs`. */
  private capScale = Infinity;
  private capUntilMs = 0;

  /** Converge fast for the next few seconds (first run on this machine). */
  fastStart(ms = 8000): void {
    this.fastMs = ms;
  }

  constructor(
    public min = 0.6,
    public max = 1,
    private budgetMs = TARGET_FRAME_MS,
    private readonly step = 0.05,
  ) {
    this.scale = max;
  }

  /** Follow the display's refresh (`RefreshEstimate.ms`): a slower panel loosens the budget. */
  setBudget(ms: number): void {
    this.budgetMs = Math.max(TARGET_FRAME_MS, ms);
  }

  reset(scale = this.max): void {
    this.scale = Math.min(this.max, Math.max(this.min, scale));
    this.samples = 0;
    this.sumMs = 0;
    this.windowMs = 0;
    this.stableMs = 0;
    this.probing = false;
    this.overWindows = 0;
    this.capScale = Infinity;
  }

  /** True when the scale is at its floor and frames are still over budget. */
  get exhausted(): boolean {
    return this.scale <= this.min + 1e-6;
  }

  private quantize(v: number): number {
    return Math.min(this.max, Math.max(this.min, Math.round(v / this.step) * this.step));
  }

  /**
   * Feed one frame's duration and, when known, the GPU's median frame time at the current
   * scale (NaN: no timer). Returns true when the scale changed.
   */
  update(frameMs: number, gpuMs = NaN): boolean {
    if (!(frameMs > 0) || frameMs > 250) return false; // ignore stalls (tab switch, GC spike)
    this.fastMs = Math.max(0, this.fastMs - frameMs);
    this.clockMs += frameMs;
    this.samples++;
    this.sumMs += frameMs;
    this.windowMs += frameMs;
    if (this.windowMs < 500) return false;
    const avg = this.sumMs / this.samples;
    this.samples = 0;
    this.sumMs = 0;
    const window = this.windowMs;
    this.windowMs = 0;

    if (avg > this.budgetMs * 1.08) {
      // A probe that misses backs off at once; otherwise wait for a second over-budget window.
      if (!this.probing && this.fastMs <= 0 && ++this.overWindows < 2) {
        this.stableMs = 0; // a slow window breaks the stable streak even before we act on it
        return false;
      }
      this.overWindows = 0;
      // Over budget: shrink in proportion to the overshoot (pixels ∝ scale²).
      const next = this.quantize(this.scale * Math.max(0.8, Math.sqrt(this.budgetMs / avg)) - 1e-9);
      const changed = next < this.scale;
      if (this.probing) {
        this.probeWaitMs = Math.min(300000, this.probeWaitMs * 2);
        this.capScale = Math.min(this.capScale, this.scale);
        this.capUntilMs = this.clockMs + this.probeWaitMs;
      }
      this.probing = false;
      this.stableMs = 0;
      const prev = this.scale;
      this.scale = changed ? next : this.quantize(this.scale - this.step);
      // At the floor both candidates clamp to `min`: nothing to resize.
      return this.scale !== prev;
    }
    this.probing = false;
    this.overWindows = 0;
    this.stableMs += window;
    if (this.clockMs >= this.capUntilMs) this.capScale = Infinity;
    if (gpuMs > 0 && Number.isFinite(gpuMs)) return this.raiseByGpu(gpuMs);
    if (
      this.scale < this.max &&
      this.stableMs >= this.probeWaitMs &&
      this.scale + this.step < this.capScale
    ) {
      this.scale = this.quantize(this.scale + this.step);
      this.stableMs = 0;
      this.probing = true;
      return true;
    }
    return false;
  }

  /** The largest step (below the cap) whose predicted GPU time fits the headroom. */
  private raiseByGpu(gpuMs: number): boolean {
    const wait = this.fastMs > 0 ? GPU_STABLE_MS / 2 : GPU_STABLE_MS;
    if (this.scale >= this.max - 1e-9 || this.stableMs < wait) return false;
    let target = this.scale;
    for (
      let s = this.quantize(this.scale + this.step);
      s > target + 1e-9;
      s = this.quantize(s + this.step)
    ) {
      if (s >= this.capScale - 1e-9) break;
      if (predictGpuMs(gpuMs, this.scale, s) > this.budgetMs * GPU_HEADROOM) break;
      target = s;
    }
    if (target <= this.scale + 1e-9) return false;
    this.scale = target;
    this.stableMs = 0;
    this.probing = true;
    return true;
  }
}
