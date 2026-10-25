import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics, SIM_DT } from '@wd/shared';
import { buildBotObservation, getNavGraph } from '../bots/index.ts';
import { MatchSim } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

const CONFIG = { map: 'range', size: 'full', mode: 'standard', botCount: 1 } as const;

describe('match spawn random streams', () => {
  it('defaults to a reproducible layout and bot simulation without drawing ambient randomness', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const sims: MatchSim[] = [];
    try {
      sims.push(new MatchSim(CONFIG));
      random.mockReturnValue(0.9);
      sims.push(new MatchSim(CONFIG), new MatchSim({ ...CONFIG, spawnSeed: 0 }));
      for (const sim of sims) sim.addPlayer('h', 'Human', 0);
      for (let tick = 0; tick < 120; tick++) {
        for (const sim of sims) sim.step();
        expect(sims[1]!.snapshot()).toEqual(sims[0]!.snapshot());
        expect(sims[2]!.snapshot()).toEqual(sims[0]!.snapshot());
      }
      expect(random).not.toHaveBeenCalled();
    } finally {
      for (const sim of sims) sim.dispose();
      random.mockRestore();
    }
  });

  it('replays explicit seeds while allowing different matches to start in different places', () => {
    const starts = [0, 1, 2, 0, 1, 2].map((spawnSeed) => {
      const sim = new MatchSim({ ...CONFIG, botCount: 0, spawnSeed });
      try {
        return { ...sim.addPlayer('h', 'Human', 0).state.move.pos };
      } finally {
        sim.dispose();
      }
    });
    expect(starts.slice(0, 3)).toEqual(starts.slice(3));
    expect(new Set(starts.map((pos) => JSON.stringify(pos))).size).toBeGreaterThan(1);
  });

  it('keeps bot decisions independent of spawn seeds and extra spawn draws for identical observations', () => {
    const a = new MatchSim({ ...CONFIG, spawnSeed: 0 });
    const b = new MatchSim({ ...CONFIG, spawnSeed: 1 });
    try {
      for (const sim of [a, b]) sim.addPlayer('h', 'Human', 0);
      // Consume extra choices after the bot exists, without running its decision provider.
      for (let n = 0; n < 12; n++) {
        b.addPlayer('visitor', 'Visitor', 0);
        b.removePlayer('visitor');
      }
      const players = [...a.players.values()].map((p) => ({ ...p, isBot: p.bot }));
      const self = players.find((p) => p.bot)!;
      expect(b.players.get(self.id)!.seed).toBe(self.seed);
      const nav = getNavGraph(a.map, a.physics);
      for (let seq = 0; seq < 180; seq++) {
        const obs = buildBotObservation({
          map: a.map,
          physics: a.physics,
          nav,
          self,
          players,
          mode: 'standard',
          nowMs: seq * SIM_DT * 1000,
          seq,
        });
        expect(b.bots.providers.get(self.id)!.decide(obs, SIM_DT)).toEqual(
          a.bots.providers.get(self.id)!.decide(obs, SIM_DT),
        );
      }
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
