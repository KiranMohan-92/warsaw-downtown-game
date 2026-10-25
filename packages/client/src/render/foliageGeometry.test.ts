import { describe, expect, it } from 'vitest';
import { FRINGE_SOLID, bushArchetype, grassArchetype } from './foliageGeometry.ts';

/**
 * Concealment parity across quality tiers: Low draws only the opaque cores, Medium+ adds leaf
 * cards. Cards must never extend beyond the core, or High would hide players that Low shows.
 */
describe('foliage cards stay inside the opaque core (tier-fair concealment)', () => {
  for (const [name, build] of [
    ['bush', bushArchetype],
    ['grass', grassArchetype],
  ] as const) {
    it(`${name}: every card vertex within the unit cylinder the core circumscribes`, () => {
      const g = build();
      let cards = 0;
      let coreMaxR = 0;
      for (let i = 0; i < g.pos.length; i += 3) {
        const r = Math.hypot(g.pos[i]!, g.pos[i + 2]!);
        const y = g.pos[i + 1]!;
        if (g.fol[i + 2] === 1) {
          coreMaxR = Math.max(coreMaxR, r);
          continue;
        }
        // Opaque leaf sprigs are drawn on every tier (no parity question): not cards.
        if (g.fol[i + 2] === FRINGE_SOLID) continue;
        cards++;
        expect(r).toBeLessThanOrEqual(1 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(-1e-6);
        expect(y).toBeLessThanOrEqual(1 + 1e-6);
      }
      // Grass has no alpha cards at all: its blades are opaque geometry, the same on every tier.
      if (name === 'grass') expect(cards).toBe(0);
      else expect(cards).toBeGreaterThan(0);
      expect(coreMaxR).toBeGreaterThanOrEqual(1); // the core reaches the cylinder wall
    });
  }
});
