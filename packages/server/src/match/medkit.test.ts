import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, MEDKIT, PLAYER } from '@wd/shared';
import { MatchSim } from './MatchSim.ts';
import { MatchTactics } from './tactics.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('medkits', () => {
  it('heal a hurt player (capped), stay for a healthy one, then recharge', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      const at = { ...a.state.move.pos };
      const tactics = new MatchTactics(
        { ...sim.map, pickups: [{ id: 'med', pos: at, kind: 'medkit' }] },
        'off', // medkits exist whatever the radar setting
      );
      tactics.step(sim.players.values());
      expect(tactics.pickups[0]!.cooldown).toBe(0); // full health: walks past
      a.state.health = 30;
      tactics.step(sim.players.values());
      expect(a.state.health).toBe(30 + MEDKIT.heal);
      expect(tactics.pickups[0]!.cooldown).toBeCloseTo(MEDKIT.respawn, 1);
      a.state.health = 90;
      tactics.step(sim.players.values());
      expect(a.state.health).toBe(90); // recharging
      tactics.pickups[0]!.cooldown = 0;
      tactics.step(sim.players.values());
      expect(a.state.health).toBe(PLAYER.maxHealth); // capped
      expect(tactics.snapshot('a').pickups[0]!.kind).toBe('medkit');
    } finally {
      sim.dispose();
    }
  });

  it('sit on open floor across the Market', { timeout: 120_000 }, () => {
    const sim = new MatchSim({ map: 'defilad', size: 'market', mode: 'standard' });
    try {
      const meds = (sim.map.pickups ?? []).filter((p) => p.kind === 'medkit');
      expect(meds.length).toBeGreaterThanOrEqual(6);
      for (const m of meds) {
        const down = sim.physics.castRay(
          { x: m.pos.x, y: m.pos.y + 1, z: m.pos.z },
          { x: 0, y: -1, z: 0 },
          2,
        );
        expect(down, m.id).not.toBeNull();
        expect(Math.abs(down!.point.y - m.pos.y), m.id).toBeLessThan(0.05);
        const feet = { x: m.pos.x, y: m.pos.y + 0.02, z: m.pos.z };
        expect(sim.physics.overlapsStatic(feet, PLAYER.standHeight, 0.05), m.id).toBe(false);
      }
    } finally {
      sim.dispose();
    }
  });
});
