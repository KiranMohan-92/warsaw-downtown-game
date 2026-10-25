/**
 * GPU frame time from `EXT_disjoint_timer_query_webgl2` (Chrome/Edge desktop; absent elsewhere,
 * where `available` is false and `median()` NaN). Under vsync the frame interval sits at the
 * display's budget however much headroom the GPU has; the GPU's own time shows that headroom,
 * so dynamic resolution can raise the scale straight to what fits instead of probing blind.
 *
 * One query around the frame's draws; results arrive a few frames later and are polled without
 * blocking. A disjoint event (power state change, context switch) discards the batch.
 */
export interface TimerQueryGl {
  createQuery(): WebGLQuery | null;
  deleteQuery(q: WebGLQuery | null): void;
  beginQuery(target: number, q: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(q: WebGLQuery, pname: number): unknown;
  getParameter(pname: number): unknown;
  getExtension(name: string): unknown;
  readonly QUERY_RESULT: number;
  readonly QUERY_RESULT_AVAILABLE: number;
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Samples kept for the median (~1 s at 60 fps). */
const WINDOW = 48;
/** Queries in flight at most (results lag 1–3 frames). */
const MAX_PENDING = 4;
/** A median older than this (ms of frames fed) is stale. */
const STALE_MS = 2000;

export class GpuFrameTimer {
  private readonly ext: TimerExt | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private readonly samples: number[] = [];
  private sinceSampleMs = Infinity;

  constructor(private readonly gl: TimerQueryGl | null) {
    this.ext = (gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
  }

  get available(): boolean {
    return this.ext !== null;
  }

  /** Start timing this frame's GPU work (skipped while too many results are outstanding). */
  begin(): void {
    if (!this.ext || !this.gl || this.active || this.pending.length >= MAX_PENDING) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.gl || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collect finished results; `frameMs` ages the median. Call once per frame, outside begin/end. */
  poll(frameMs: number): void {
    if (Number.isFinite(frameMs) && frameMs > 0) this.sinceSampleMs += frameMs;
    if (!this.ext || !this.gl) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.reset();
      return;
    }
    while (this.pending.length > 0) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = Number(gl.getQueryParameter(q, gl.QUERY_RESULT));
      gl.deleteQuery(q);
      if (!(ns > 0) || !Number.isFinite(ns)) continue;
      this.samples.push(ns / 1e6);
      if (this.samples.length > WINDOW) this.samples.shift();
      this.sinceSampleMs = 0;
    }
  }

  /** Median GPU ms of the recent frames; NaN when unavailable, too few samples or stale. */
  median(): number {
    if (this.samples.length < 12 || this.sinceSampleMs > STALE_MS) return NaN;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }

  /** Forget the samples (after a resolution or tier change they describe another workload). */
  reset(): void {
    // Results still in flight describe the old workload too. Letting them arrive
    // after a resize can make the resolution governor raise its scale using stale data.
    if (this.gl && this.ext) {
      if (this.active) {
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.gl.deleteQuery(this.active);
        this.active = null;
      }
      for (const q of this.pending) this.gl.deleteQuery(q);
    }
    this.pending.length = 0;
    this.samples.length = 0;
    this.sinceSampleMs = Infinity;
  }
}
