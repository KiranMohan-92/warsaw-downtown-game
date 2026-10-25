import { describe, expect, it } from 'vitest';
import { CorrectionSmoother } from './correctionSmoother.ts';

describe('CorrectionSmoother', () => {
  it('a small correction keeps the view where it was, then decays out over ~100 ms', () => {
    const c = new CorrectionSmoother();
    // The server moved us 0.4 m back along x.
    expect(c.correct({ x: 10, y: 0, z: 5 }, { x: 9.6, y: 0, z: 5 })).toBe('blend');
    // Drawn = body + offset = where we were.
    expect(9.6 + c.offset.x).toBeCloseTo(10, 9);
    let t = 0;
    while (t < 0.1 - 1e-9) {
      c.update(1 / 120);
      t += 1 / 120;
    }
    expect(Math.abs(c.offset.x)).toBeLessThan(0.4 * 0.06); // ~95 % gone after 100 ms
    for (let i = 0; i < 60; i++) c.update(1 / 60);
    expect(c.offset.x).toBe(0);
  });

  it('corrections accumulate, and a large total or a forced one (respawn) snaps', () => {
    const c = new CorrectionSmoother();
    c.correct({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(c.offset.x).toBeCloseTo(-1, 9);
    expect(c.correct({ x: 1, y: 0, z: 0 }, { x: 2.5, y: 0, z: 0 })).toBe('snap'); // 2.5 m total
    expect(c.offset.x).toBe(0);
    expect(c.correct({ x: 0, y: 0, z: 0 }, { x: 0.1, y: 0, z: 0 }, true)).toBe('snap');
    expect(c.correct({ x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 })).toBe('snap'); // teleport
    expect(c.correct({ x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 0 })).toBe('snap');
    expect(c.offset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('never touches the corrected state itself (it only returns an offset)', () => {
    const c = new CorrectionSmoother();
    const after = { x: 3, y: 1, z: -2 };
    c.correct({ x: 3.2, y: 1, z: -2 }, after);
    expect(after).toEqual({ x: 3, y: 1, z: -2 });
  });
});
