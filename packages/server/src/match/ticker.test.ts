import { describe, expect, it } from 'vitest';
import { FixedTicker } from './ticker.ts';

const STEP = 1000 / 60;

describe('FixedTicker', () => {
  it('runs as many whole ticks as real time has passed, carrying the remainder', () => {
    const t = new FixedTicker(STEP, 8, 1000, 0);
    expect(t.advance(10)).toBe(0); // early callback
    expect(t.advance(STEP)).toBe(1);
    expect(t.advance(STEP * 3)).toBe(2);
    // Node's 16 ms interval: 25 callbacks = 400 ms = 24 ticks, never 25.
    const u = new FixedTicker(STEP, 8, 1000, 0);
    let ticks = 0;
    for (let i = 1; i <= 25; i++) ticks += u.advance(i * 16);
    expect(ticks).toBe(24);
  });

  it('catches up after a stall a few ticks per callback, and skips beyond the backlog cap', () => {
    const t = new FixedTicker(STEP, 8, 1000, 0);
    expect(t.advance(STEP * 20)).toBe(8); // 20 due: 8 now…
    expect(t.advance(STEP * 20)).toBe(8); // …8 more…
    expect(t.advance(STEP * 20)).toBe(4); // …the rest
    // A 5 s freeze catches up on at most 1 s (60 ticks), then carries on at the clock's rate.
    const u = new FixedTicker(STEP, 8, 1000, 0);
    let ticks = 0;
    for (let i = 0; i < 20; i++) ticks += u.advance(5000);
    expect(ticks).toBe(60);
    expect(u.advance(5000 + STEP)).toBe(1);
  });

  it('ignores a clock that steps backwards', () => {
    const t = new FixedTicker(STEP, 8, 1000, 100);
    expect(t.advance(50)).toBe(0);
    expect(t.advance(100 + STEP)).toBe(1);
  });
});
