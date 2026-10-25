import { describe, expect, it } from 'vitest';
import { GpuFrameTimer, type TimerQueryGl } from './gpuTimer.ts';

/** A fake GL whose queries finish `lag` polls after they end, each taking `ms`. */
function fakeGl(opts: { ext?: boolean; lag?: number; ms?: () => number } = {}) {
  const lag = opts.lag ?? 2;
  let polls = 0;
  let disjoint = false;
  const queries = new Map<object, { endedAt: number; ns: number }>();
  let active: object | null = null;
  const deleted: object[] = [];
  const gl: TimerQueryGl & { setDisjoint(v: boolean): void; deleted: object[]; tick(): void } = {
    QUERY_RESULT: 1,
    QUERY_RESULT_AVAILABLE: 2,
    createQuery: () => ({}),
    deleteQuery: (q) => void deleted.push(q!),
    beginQuery: (_t, q) => {
      active = q;
    },
    endQuery: () => {
      queries.set(active!, { endedAt: polls, ns: (opts.ms?.() ?? 10) * 1e6 });
      active = null;
    },
    getQueryParameter: (q, p) => {
      const r = queries.get(q)!;
      return p === 2 ? polls - r.endedAt >= lag : r.ns;
    },
    getParameter: () => disjoint,
    getExtension: (name) =>
      opts.ext === false || name !== 'EXT_disjoint_timer_query_webgl2'
        ? null
        : { TIME_ELAPSED_EXT: 9, GPU_DISJOINT_EXT: 10 },
    setDisjoint: (v) => (disjoint = v),
    deleted,
    tick: () => void polls++,
  };
  return gl;
}

function frames(t: GpuFrameTimer, gl: ReturnType<typeof fakeGl>, n: number): void {
  for (let i = 0; i < n; i++) {
    gl.tick();
    t.poll(16.7);
    t.begin();
    t.end();
  }
}

describe('GpuFrameTimer', () => {
  it('reports nothing without the extension (other browsers)', () => {
    const gl = fakeGl({ ext: false });
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 60);
    expect(t.available).toBe(false);
    expect(t.median()).toBeNaN();
    expect(new GpuFrameTimer(null).median()).toBeNaN();
  });

  it('medians the recent frames once enough results arrived', () => {
    const gl = fakeGl({ ms: () => 12 });
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 6);
    expect(t.median()).toBeNaN(); // too few yet
    frames(t, gl, 40);
    expect(t.median()).toBeCloseTo(12);
  });

  it('ignores outliers (median) and never keeps more than a few queries in flight', () => {
    let i = 0;
    const gl = fakeGl({ lag: 3, ms: () => (++i % 10 === 0 ? 80 : 11) });
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 80);
    expect(t.median()).toBeCloseTo(11);
    expect((t as unknown as { pending: unknown[] }).pending.length).toBeLessThanOrEqual(4);
  });

  it('invalidates samples and in-flight results immediately on a disjoint event', () => {
    const gl = fakeGl({ ms: () => 9 });
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 40);
    expect(t.median()).toBeCloseTo(9);
    gl.setDisjoint(true);
    const before = gl.deleted.length;
    t.poll(16.7);
    expect(gl.deleted.length).toBeGreaterThan(before);
    expect(t.median()).toBeNaN();
    gl.setDisjoint(false);
    frames(t, gl, 6);
    expect(t.median()).toBeNaN(); // requires enough new results
    frames(t, gl, 40);
    expect(t.median()).toBeCloseTo(9);
  });

  it('reset forgets samples (a resize changes the workload)', () => {
    const gl = fakeGl();
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 40);
    t.reset();
    expect(t.median()).toBeNaN();
  });

  it('discards delayed queries from the old resolution before accepting new timing', () => {
    let ms = 75;
    const gl = fakeGl({ lag: 3, ms: () => ms });
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 2);
    const before = gl.deleted.length;
    t.reset();
    expect(gl.deleted.length - before).toBe(2);
    ms = 8;
    frames(t, gl, 14);
    expect(t.median()).toBeNaN(); // only 11 new samples, no old queries counted
    frames(t, gl, 2);
    expect(t.median()).toBeCloseTo(8);
  });

  it('closes an active query on reset and allows subsequent frames to be measured', () => {
    const gl = fakeGl({ ms: () => 7 });
    const t = new GpuFrameTimer(gl);
    t.begin();
    t.reset();
    expect(gl.deleted).toHaveLength(1);
    t.end(); // the cancelled query cannot be queued again
    frames(t, gl, 40);
    expect(t.median()).toBeCloseTo(7);
  });

  it('rejects invalid GPU results and does not let invalid frame ages corrupt fresh samples', () => {
    let ms = Infinity;
    const gl = fakeGl({ ms: () => ms });
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 40);
    expect(t.median()).toBeNaN();
    ms = NaN;
    frames(t, gl, 40);
    expect(t.median()).toBeNaN();
    ms = 10;
    frames(t, gl, 40);
    t.poll(NaN);
    t.poll(-100);
    expect(t.median()).toBeCloseTo(10);
  });

  it('expires a median when no new query results arrive', () => {
    const gl = fakeGl();
    const t = new GpuFrameTimer(gl);
    frames(t, gl, 40);
    // Drain results, then age without submitting another query.
    gl.tick();
    gl.tick();
    t.poll(16.7);
    t.poll(2001);
    expect(t.median()).toBeNaN();
  });
});
