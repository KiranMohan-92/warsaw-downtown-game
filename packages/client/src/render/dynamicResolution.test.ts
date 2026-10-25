import { describe, expect, it } from 'vitest';
import {
  DynamicResolution,
  GPU_FIXED_SHARE,
  GPU_HEADROOM,
  predictGpuMs,
  isLightFrame,
  RefreshEstimate,
  SLOWEST_PANEL_MS,
  TARGET_FRAME_MS,
} from './dynamicResolution.ts';

/** Simulate a fill-rate-bound GPU: frame time ∝ pixels ∝ scale², floored at vsync (16.67 ms). */
function run(drs: DynamicResolution, msAtFull: number, seconds: number): void {
  let t = 0;
  while (t < seconds * 1000) {
    const ms = Math.max(1000 / 60, msAtFull * drs.scale * drs.scale);
    drs.update(ms);
    t += ms;
  }
}

describe('DynamicResolution', () => {
  it('stays at full resolution when the GPU keeps up', () => {
    const drs = new DynamicResolution();
    run(drs, 12, 30);
    expect(drs.scale).toBe(1);
  });

  it('drops resolution until the frame fits the 60 Hz budget (Intel UHD profile)', () => {
    const drs = new DynamicResolution();
    run(drs, 24.9, 6); // measured: 40 fps at 100%
    expect(drs.scale).toBeLessThanOrEqual(0.8);
    expect(24.9 * drs.scale * drs.scale).toBeLessThanOrEqual((1000 / 60) * 1.08);
    expect(drs.scale).toBeGreaterThanOrEqual(0.7); // doesn't overshoot downward
  });

  it('does not oscillate: after settling, probes fail and back off', () => {
    const drs = new DynamicResolution();
    run(drs, 24.9, 6);
    const settled = drs.scale;
    let changes = 0;
    let t = 0;
    while (t < 120_000) {
      const ms = Math.max(1000 / 60, 24.9 * drs.scale * drs.scale);
      if (drs.update(ms)) changes++;
      t += ms;
    }
    expect(Math.abs(drs.scale - settled)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(changes).toBeLessThan(6); // probes are rare (30 s, then exponential back-off)
  });

  it('recovers to full resolution once the load goes away', () => {
    const drs = new DynamicResolution();
    run(drs, 30, 6);
    expect(drs.scale).toBeLessThan(0.8);
    run(drs, 10, 400);
    expect(drs.scale).toBe(1);
  });

  it('reports exhaustion at the floor', () => {
    const drs = new DynamicResolution(0.6);
    run(drs, 80, 10);
    expect(drs.scale).toBeCloseTo(0.6, 6);
    expect(drs.exhausted).toBe(true);
  });

  it('reports no change once pinned at the floor (no resize every window)', () => {
    const drs = new DynamicResolution(0.6);
    run(drs, 80, 10);
    let changes = 0;
    for (let i = 0; i < 300; i++) if (drs.update(40)) changes++; // ~12 s, still over budget
    expect(changes).toBe(0);
    expect(drs.scale).toBeCloseTo(0.6, 6);
  });

  it('ignores stall frames', () => {
    const drs = new DynamicResolution();
    for (let i = 0; i < 10; i++) drs.update(1000);
    expect(drs.scale).toBe(1);
  });
});

/**
 * A GPU with a timer: GPU ms = fixed + per-pixel × scale² (the share GPU_FIXED_SHARE models);
 * the frame interval is vsync-floored, the GPU time is what the timer reports.
 */
function runGpu(
  drs: DynamicResolution,
  gpuAtFull: number,
  seconds: number,
  fixedShare = GPU_FIXED_SHARE,
): number {
  let t = 0;
  let changes = 0;
  while (t < seconds * 1000) {
    const gpu = gpuAtFull * (fixedShare + (1 - fixedShare) * drs.scale * drs.scale);
    const ms = Math.max(1000 / 60, gpu);
    if (drs.update(ms, gpu)) changes++;
    t += ms;
  }
  return changes;
}

describe('DynamicResolution with a GPU timer', () => {
  const budget = 1000 / 60;

  it('predicts GPU time from the fixed share and pixels', () => {
    expect(predictGpuMs(10, 1, 1)).toBeCloseTo(10);
    expect(predictGpuMs(10, 1, 0.5)).toBeCloseTo(
      10 * (GPU_FIXED_SHARE + (1 - GPU_FIXED_SHARE) / 4),
    );
    // Measured 23.4 ms at 100 % and 13.8 ms at 60 % on Intel UHD (Low): the model's fit.
    expect(predictGpuMs(23.4, 1, 0.6)).toBeCloseTo(13.8, 0);
    expect(predictGpuMs(predictGpuMs(12, 0.6, 0.8), 0.8, 0.6)).toBeCloseTo(12, 1);
  });

  it('climbs back from a low scale in one raise to the largest step that fits, in seconds', () => {
    const drs = new DynamicResolution(0.6);
    drs.reset(0.6); // e.g. Auto just dropped a tier at the floor
    const changes = runGpu(drs, 18, 6); // the iGPU's Low frame: 18 ms at 100 %
    expect(changes).toBe(1);
    expect(drs.scale).toBeGreaterThan(0.75);
    const gpu = 18 * (GPU_FIXED_SHARE + (1 - GPU_FIXED_SHARE) * drs.scale * drs.scale);
    expect(gpu).toBeLessThanOrEqual(budget * GPU_HEADROOM + 1e-9);
    expect(predictGpuMs(gpu, drs.scale, drs.scale + 0.05)).toBeGreaterThan(budget * GPU_HEADROOM);
  });

  it('goes to full resolution when the GPU has room, and never blind-probes when it has none', () => {
    const roomy = new DynamicResolution(0.6);
    roomy.reset(0.7);
    runGpu(roomy, 10, 5);
    expect(roomy.scale).toBe(1);
    const tight = new DynamicResolution(0.6);
    tight.reset(0.8);
    // At 0.8 this GPU needs ~15.9 ms: under the frame budget (no drop) but no headroom to raise.
    const changes = runGpu(tight, 21, 120);
    expect(changes).toBe(0);
    expect(tight.scale).toBeCloseTo(0.8, 6);
  });

  it('a raise that misses backs off and caps further raises below that scale', () => {
    const drs = new DynamicResolution(0.6);
    drs.reset(0.6);
    // The real fixed share is higher than the model's: the raise overshoots and misses.
    runGpu(drs, 20, 6, 0.7);
    expect(drs.scale).toBeLessThan(1);
    let changes = 0;
    changes += runGpu(drs, 20, 25, 0.7); // within the cap: no repeat of the missed raise
    expect(changes).toBeLessThanOrEqual(1);
    const gpu = 20 * (0.7 + 0.3 * drs.scale * drs.scale);
    expect(Math.max(budget, gpu)).toBeLessThanOrEqual(budget * 1.08);
  });

  it('still drops on frame time (the timer only guides raises)', () => {
    const drs = new DynamicResolution(0.6);
    runGpu(drs, 30, 4);
    expect(drs.scale).toBeLessThan(0.8);
  });
});

/** A 56 Hz panel (measured: an empty page in a visible Chrome window ticks at 17.8 ms). */
const PANEL_56 = 17.8;

/**
 * A GPU with headroom on that panel: every frame is one refresh, with the odd late presentation
 * (measured in the game: ~18.1 ms average) — over a 60 Hz budget's +8 % tolerance (18.0 ms), well
 * inside the panel's own (19.2 ms).
 */
function lightGameFrame(i: number): number {
  return PANEL_56 + (i % 4 === 0 ? 1.2 : 0);
}

describe('RefreshEstimate', () => {
  it('learns a sub-60 Hz panel from light frames', () => {
    const r = new RefreshEstimate();
    for (let i = 0; i < 120; i++) r.push(PANEL_56 + (i % 3) * 0.05, true);
    expect(r.ms).toBeCloseTo(PANEL_56, 0);
    expect(r.fps).toBeGreaterThan(55);
    expect(r.fps).toBeLessThan(57);
  });

  it('never learns from heavy frames: a slow GPU still reads as slow', () => {
    const r = new RefreshEstimate();
    for (let i = 0; i < 200; i++) r.push(25, false);
    expect(r.ms).toBe(TARGET_FRAME_MS);
  });

  it('keeps the 60 fps target on faster or uncapped displays', () => {
    const r = new RefreshEstimate();
    for (let i = 0; i < 120; i++) r.push(1000 / 144, true);
    expect(r.ms).toBe(TARGET_FRAME_MS);
  });

  it('judges light frames without the interval (missed vsync never teaches it)', () => {
    expect(isLightFrame(true, NaN)).toBe(true);
    expect(isLightFrame(false, 8)).toBe(true);
    expect(isLightFrame(false, 12)).toBe(false);
    expect(isLightFrame(false, NaN)).toBe(false);
    // 60 Hz panel, light GPU, a third of frames miss vsync: still 60 Hz.
    const r = new RefreshEstimate();
    for (let i = 0; i < 120; i++) r.push(i % 3 === 0 ? 33.3 : 16.7, isLightFrame(false, 8));
    expect(r.ms).toBeLessThan(17); // one 60 Hz refresh, not the 33 ms misses
  });

  it('keeps the base refresh when half the callbacks miss (CPU-bound play)', () => {
    const r = new RefreshEstimate();
    for (let i = 0; i < 120; i++) r.push(i % 2 ? 33.3 : 16.7, isLightFrame(false, 8));
    expect(r.ms).toBeLessThan(17);
  });

  it('a busy menu that mostly misses still finds the refresh, and never trusts below 48 Hz', () => {
    const busy = new RefreshEstimate();
    for (let i = 0; i < 120; i++) busy.push(i % 4 === 0 ? 16.7 : 33.3, true);
    expect(busy.ms).toBeLessThan(17);
    const allMissed = new RefreshEstimate();
    for (let i = 0; i < 120; i++) allMissed.push(33.3, true);
    expect(allMissed.ms).toBe(SLOWEST_PANEL_MS);
  });

  it('ignores stalls longer than a 30 Hz refresh', () => {
    const r = new RefreshEstimate();
    for (let i = 0; i < 120; i++) r.push(i % 2 ? PANEL_56 : 80, true);
    expect(r.ms).toBeCloseTo(PANEL_56, 0);
  });
});

describe('DynamicResolution on a 56 Hz panel', () => {
  it('with the fixed 60 Hz budget a GPU with headroom loses resolution (the bug)', () => {
    const drs = new DynamicResolution(0.6);
    for (let i = 0; i < 1200; i++) drs.update(lightGameFrame(i));
    expect(drs.scale).toBeLessThan(0.8);
  });

  it('with the panel budget it stays sharp when the GPU keeps up', () => {
    const drs = new DynamicResolution(0.6);
    drs.setBudget(PANEL_56);
    for (let i = 0; i < 1200; i++) drs.update(lightGameFrame(i));
    expect(drs.scale).toBe(1);
  });

  it('still drops resolution when the GPU really is too slow for the panel', () => {
    const drs = new DynamicResolution(0.6);
    drs.setBudget(PANEL_56);
    for (let t = 0; t < 8000;) {
      const ms = Math.max(PANEL_56, 26 * drs.scale * drs.scale);
      drs.update(ms);
      t += ms;
    }
    expect(drs.scale).toBeLessThan(1);
    expect(26 * drs.scale * drs.scale).toBeLessThanOrEqual(PANEL_56 * 1.08);
  });

  it('never budgets tighter than 60 Hz', () => {
    const drs = new DynamicResolution(0.6);
    drs.setBudget(1000 / 144);
    for (let t = 0; t < 10000;) {
      drs.update(1000 / 60);
      t += 1000 / 60;
    }
    expect(drs.scale).toBe(1);
  });
});
