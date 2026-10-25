import { describe, expect, it } from 'vitest';
import { BOOT_STAGES, BootProgress, mapStageLabel, type StageDef } from './progress.ts';

const STAGES: readonly StageDef[] = [
  { id: 'script', weight: 1, expectMs: 1000, label: 'Loading game files' },
  { id: 'surfaces', weight: 2, expectMs: 1000, label: 'Preparing surfaces' },
  { id: 'assets', weight: 1, expectMs: 1000, label: 'Loading soldiers, guns and trees' },
];

/** Run the model to settle at `now` (many small steps, as the 10 Hz redraw would). */
function settle(p: BootProgress, from: number, to: number): number {
  let v = 0;
  for (let t = from; t <= to; t += 100) v = p.value(t);
  return v;
}

describe('boot progress', () => {
  it('weights stages by their share of the bar', () => {
    const p = new BootProgress(STAGES, 0);
    p.report('surfaces', 0, 0);
    // Script (1 of 4) is done; creep toward the surfaces span is limited to 85 % of it.
    expect(settle(p, 0, 10_000)).toBeGreaterThanOrEqual(0.25);
    p.report('surfaces', 0.5, 10_000);
    const half = settle(p, 10_000, 20_000);
    expect(half).toBeGreaterThanOrEqual(0.25 + 0.5 * 0.5 - 1e-6);
    expect(half).toBeLessThan(0.25 + 0.5 * 0.85 + 1e-6);
    p.report('assets', 0, 20_000);
    expect(settle(p, 20_000, 20_500)).toBeGreaterThan(0.7);
  });

  it('only moves forward: earlier stages and lower fractions are ignored', () => {
    const p = new BootProgress(STAGES, 0);
    p.report('assets', 0.5, 0);
    let last = 0;
    const reports: [StageDef['id'], number][] = [
      ['script', 1],
      ['surfaces', 0.9],
      ['assets', 0.1],
      ['assets', 0.8],
      ['assets', 0.2],
    ];
    let t = 0;
    for (const [stage, done] of reports) {
      p.report(stage, done, t);
      for (let i = 0; i < 20; i++) {
        t += 50;
        const v = p.value(t);
        expect(v).toBeGreaterThanOrEqual(last);
        last = v;
      }
    }
    expect(p.stage).toBe('assets');
    expect(p.label).toBe('Loading soldiers, guns and trees');
  });

  it('eases towards a report instead of jumping', () => {
    const p = new BootProgress(STAGES, 0);
    p.report('assets', 1, 0);
    const first = p.value(100);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.5);
    expect(settle(p, 100, 3000)).toBeCloseTo(1, 2);
  });

  it('creeps inside a quiet stage but never past its end', () => {
    const p = new BootProgress(STAGES, 0);
    p.report('surfaces', 0, 0);
    const v = settle(p, 0, 60_000);
    expect(v).toBeGreaterThan(0.25 + 0.5 * 0.8);
    expect(v).toBeLessThanOrEqual(0.75);
  });

  it('marks a stall after the timeout, and a later report clears it', () => {
    const p = new BootProgress(STAGES, 0);
    p.report('surfaces', 0, 0);
    expect(p.checkStall(59_000, 60_000)).toBe(false);
    expect(p.checkStall(61_000, 60_000)).toBe(true);
    expect(p.state).toBe('stalled');
    p.report('surfaces', 0.5, 62_000);
    expect(p.state).toBe('loading');
    // Waiting on the player (friend lobby) is not a stall.
    p.touch(200_000);
    expect(p.checkStall(250_000, 60_000)).toBe(false);
  });

  it('completes to a full bar, and a failure sticks', () => {
    const done = new BootProgress(STAGES, 0);
    done.report('surfaces', 0.2, 10);
    done.complete(500);
    expect(done.value(600)).toBe(1);
    expect(done.label).toBe('Ready');
    expect([...done.timings().keys()]).toEqual(['script', 'surfaces']);

    const failed = new BootProgress(STAGES, 0);
    failed.fail('WebGL unavailable');
    failed.report('assets', 1, 10);
    failed.complete(20);
    expect(failed.state).toBe('error');
    expect(failed.error).toBe('WebGL unavailable');
  });

  it('names stages in plain words, including the map being built', () => {
    for (const s of BOOT_STAGES) expect(s.label).toMatch(/^[A-Z][a-z ,]+$/);
    expect(BOOT_STAGES.map((s) => s.id)).toEqual([
      'script',
      'physics',
      'surfaces',
      'map',
      'assets',
      'setup',
      'shaders',
    ]);
    expect(mapStageLabel('defilad', 'market')).toBe('Building the Market');
    expect(mapStageLabel('defilad', 'full')).toBe('Building Plac Defilad');
    expect(mapStageLabel('defilad', 'north')).toBe('Building Plac Defilad (north)');
    expect(mapStageLabel('range', 'full')).toBe('Building the firing range');
    const p = new BootProgress(BOOT_STAGES, 0);
    p.setLabel('map', mapStageLabel('defilad', 'market'));
    p.report('map', 0, 0);
    expect(p.label).toBe('Building the Market');
    p.report('shaders', 0, 1);
    expect(p.label).toBe('Compiling shaders');
  });
});
