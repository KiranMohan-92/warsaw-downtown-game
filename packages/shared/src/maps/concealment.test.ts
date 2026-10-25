import { describe, expect, it } from 'vitest';
import { FoliageIndex } from './concealment.ts';

describe('foliage concealment (bots and server use this, not the renderer)', () => {
  const idx = new FoliageIndex([
    { x: 0, z: 0, r: 1.5, h: 1.8, kind: 'bush' },
    { x: 20, z: 0, r: 2, h: 1.1, kind: 'grass' },
  ]);
  const eye = (x: number, y = 1.6) => ({ x, y, z: 0 });

  it('a bush between you and a standing target hides them', () => {
    expect(idx.visibility(eye(-10), eye(10, 1.4))).toBe(0);
  });
  it('clear line away from foliage is fully visible', () => {
    expect(idx.visibility({ x: -10, y: 1.6, z: 5 }, { x: 10, y: 1.6, z: 5 })).toBe(1);
  });
  it('tall grass hides a crouched target but not a standing one', () => {
    // Target lying in the grass (chest at 0.6 m), watcher crouched nearby at 0.9 m.
    expect(idx.visibility({ x: 13, y: 0.9, z: 0 }, { x: 20, y: 0.6, z: 0 })).toBeLessThan(0.1);
    expect(idx.visibility({ x: 13, y: 1.6, z: 0 }, { x: 20, y: 1.5, z: 0 })).toBe(1);
  });
  it('a sight line in a tunnel under a surface bush is not hidden by it', () => {
    expect(idx.visibility({ x: -10, y: -3.4, z: 0 }, { x: 10, y: -3.5, z: 0 })).toBe(1);
  });
  it('looking down from a roof sees over the bush', () => {
    expect(idx.visibility({ x: -20, y: 16, z: 0 }, { x: 5, y: 1.4, z: 0 })).toBeGreaterThan(0.5);
  });
});
