import { describe, expect, it } from 'vitest';
import { ImpactPool } from './impactPool.ts';

describe('fixed impact slots', () => {
  it('recycles the oldest live slot and reuses expired slots without growing', () => {
    const pool = new ImpactPool(3, () => ({ life: 0, born: 0, tag: 0 }));
    const first = pool.acquire();
    first.life = 1;
    const second = pool.acquire();
    second.life = 1;
    const third = pool.acquire();
    third.life = 1;
    expect(pool.acquire()).toBe(first);
    first.life = 1;
    second.life = 0;
    expect(pool.acquire()).toBe(second);
    second.life = 1;
    expect(pool.acquire()).toBe(third);
    const storage = pool.slots;
    const identities = new Set(storage);
    for (let i = 0; i < 1000; i++) pool.acquire().life = 1;
    expect(pool.slots).toBe(storage);
    expect(pool.slots).toHaveLength(3);
    expect(new Set(pool.slots)).toEqual(identities);
    expect(pool.count).toBe(3);
  });

  it('can use a smaller ring of its slots (Low), recycling oldest-first inside it', () => {
    const pool = new ImpactPool(8, () => ({ life: 0, born: 0 }));
    const used = new Set<object>();
    for (let i = 0; i < 20; i++) {
      const p = pool.acquire(3);
      p.life = 1;
      used.add(p);
    }
    expect(used.size).toBe(3);
    expect(pool.count).toBe(3);
    expect([...used].every((p) => pool.slots.indexOf(p as never) < 3)).toBe(true);
  });
});
