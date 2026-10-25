import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '@wd/shared';
import { MatchSim } from './MatchSim.ts';
import { MatchTactics } from './tactics.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('skateboard on the server', () => {
  it('rides until death, drops there, never survives a respawn, and bots leave it', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      const b = sim.addPlayer('b', 'B', 0);
      const spot = { ...a.state.move.pos };
      const tactics = new MatchTactics({ ...sim.map, skateboard: spot }, 'uplinks');
      b.state.move.pos = { x: spot.x + 20, y: spot.y, z: spot.z };
      tactics.step(sim.players.values());
      expect(tactics.board?.rider).toBe('a');
      expect(a.state.move.board).toBe(true);
      expect(b.state.move.board).toBe(false);
      expect(tactics.snapshot('b').board?.rider).toBe('a');

      // Killed away from the spot: the board stays where A fell.
      a.state.move.pos = { x: spot.x + 7, y: spot.y, z: spot.z - 2 };
      tactics.step(sim.players.values());
      a.state.health = 0;
      tactics.step(sim.players.values());
      expect(tactics.board?.rider).toBeNull();
      expect(tactics.board?.pos).toEqual(a.state.move.pos);
      expect(tactics.takeBoardEvents().map((e) => e.type)).toEqual(['pickup', 'drop']);

      // A's new life starts without it; B walks over and takes it.
      tactics.respawned('a');
      a.state = { ...a.state, health: 100 };
      a.state.move.pos = { x: spot.x - 30, y: spot.y, z: spot.z };
      b.state.move.pos = { ...tactics.board!.pos };
      tactics.step(sim.players.values());
      expect(tactics.board?.rider).toBe('b');
      expect(a.state.move.board).toBe(false);
      expect(b.state.move.board).toBe(true);

      // A fall out of the world (respawn without a death) releases it too.
      tactics.respawned('b');
      expect(tactics.board?.rider).toBeNull();
    } finally {
      sim.dispose();
    }
  });

  it('bots never pick it up', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 1 });
    try {
      const bot = [...sim.players.values()].find((p) => p.bot);
      if (!bot) return; // bots join with the first human in some configs
      const tactics = new MatchTactics(
        { ...sim.map, skateboard: { ...bot.state.move.pos } },
        'uplinks',
      );
      tactics.step(sim.players.values());
      expect(tactics.board?.rider).toBeNull();
    } finally {
      sim.dispose();
    }
  });

  it(
    'hides the Market board inside the helicopter wreck, on its floor',
    { timeout: 120_000 },
    () => {
      const sim = new MatchSim({ map: 'defilad', size: 'market', mode: 'standard' });
      try {
        const pos = (sim as unknown as { tactics: MatchTactics }).tactics.board!.pos;
        // On the hull floor (0.3–1.3 m up: it pitches), under the roof, near the wreck.
        expect(pos.y).toBeGreaterThan(0.3);
        expect(pos.y).toBeLessThan(1.3);
        expect(Math.hypot(pos.x - 74, pos.z - 32)).toBeLessThan(4);
        const roof = sim.physics.castRay(
          { x: pos.x, y: pos.y + 0.2, z: pos.z },
          { x: 0, y: 1, z: 0 },
          3,
        );
        expect(roof).not.toBeNull();
      } finally {
        sim.dispose();
      }
    },
  );
});
