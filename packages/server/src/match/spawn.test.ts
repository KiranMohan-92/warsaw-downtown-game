import { describe, expect, it } from 'vitest';
import type { SpawnPoint } from '@wd/shared';
import { pickSpawn, spawnCandidates } from './spawn.ts';

const at = (x: number, z: number): SpawnPoint => ({ pos: { x, y: 0, z }, yaw: 0 });

describe('spawn candidates', () => {
  const pool = [at(0, 0), at(10, 0), at(20, 0)];
  const authored = [at(100, 100)];

  it('keeps only the clear spawns when any are clear', () => {
    expect(spawnCandidates(pool, authored, (s) => s.pos.x > 5)).toEqual([pool[1], pool[2]]);
  });

  it('falls back to the whole pool when every spawn is occupied (crowded match)', () => {
    const c = spawnCandidates(pool, authored, () => false);
    expect(c).toEqual(pool);
    // Scoring still picks the safest of them, and never throws.
    expect(() => pickSpawn(c, [{ x: 0, y: 1.6, z: 0 }])).not.toThrow();
    expect(pickSpawn(c, [{ x: 0, y: 1.6, z: 0 }])).toBe(pool[2]);
  });

  it('falls back to the authored spawns when the pool is empty', () => {
    expect(spawnCandidates([], authored, () => false)).toEqual(authored);
  });
});
