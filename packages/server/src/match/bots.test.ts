import { beforeAll, describe, expect, it } from 'vitest';
import {
  clonePlayerState,
  emptyInput,
  initPhysics,
  PhysicsWorld,
  sanitizeInput,
  SIM_DT,
  stepPlayer,
} from '@wd/shared';
import { MatchSim } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('M3 input-only bot integration', () => {
  it('decision production only enqueues sanitized inputs; the common player step does the moving', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 1 });
    const physics = new PhysicsWorld(sim.map);
    try {
      sim.addPlayer('human', 'Human', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      const before = clonePlayerState(bot.state);
      const predicted = clonePlayerState(bot.state);
      const body = physics.createCharacter(bot.state.move.pos);
      const raw = { ...emptyInput(0), moveX: 20, moveZ: 10, yaw: 9, pitch: 99 };
      sim.bots.providers.set(bot.id, { decide: () => ({ ...raw }) });
      sim.bots.enqueue();
      expect(bot.state).toEqual(before);
      expect(bot.applied).toBe(0);
      expect(bot.ack).toBe(-1);
      expect(sim.grenades).toHaveLength(0);
      expect(sim.drainEvents()).toHaveLength(0);
      expect(bot.queue).toEqual([{ ...sanitizeInput(raw), vt: sim.nowMs }]);

      // A repeated seq is ignored on the next enqueue, exactly as for human inputs.
      sim.step();
      stepPlayer(predicted, sanitizeInput(raw), SIM_DT, body);
      expect(bot.state).toEqual(predicted);
      expect(bot.applied).toBe(1);
      expect(bot.ack).toBe(0);
    } finally {
      physics.free();
      sim.dispose();
    }
  });

  it('replaces bots with late humans, reserves disconnected humans and refills departing seats', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 5 });
    try {
      const host = sim.addPlayer('host', 'Host', 0);
      expect(sim.players.size).toBe(6);
      expect(sim.roster().players.filter((p) => p.bot)).toHaveLength(5);
      host.connected = false;
      for (let i = 1; i < 6; i++) sim.addPlayer(`human${i}`, `Human ${i}`, 0);
      expect(sim.players.size).toBe(6);
      expect(sim.bots.providers.size).toBe(0);
      expect(() => sim.addPlayer('overflow', 'Overflow', 0)).toThrow('match is full');
      sim.removePlayer('human1');
      expect(sim.players.size).toBe(6);
      expect(sim.bots.providers.size).toBe(1);
      for (const p of [...sim.players.values()]) if (!p.bot) sim.removePlayer(p.id);
      expect(sim.players.size).toBe(0);
    } finally {
      sim.dispose();
    }
  });

  it('knife-only bots have the same restricted kit as human players', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'knife', botCount: 1 });
    try {
      const human = sim.addPlayer('human', 'Human', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      expect(bot.state.arsenal).toEqual(human.state.arsenal);
      expect(bot.state.arsenal.slot).toBe('knife');
      expect(bot.state.arsenal.grenades).toBe(0);
      expect(sim.matchState().scores.map((s) => s.id)).toContain(bot.id);
    } finally {
      sim.dispose();
    }
  });
});
