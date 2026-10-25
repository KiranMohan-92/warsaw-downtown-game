import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, SIM, SPAWN_PROTECTION, type MatchSettings } from '@wd/shared';
import { PracticeHost, PRACTICE_PLAYER_ID } from './practiceHost.ts';

const settings: MatchSettings = {
  map: 'defilad',
  size: 'market',
  mode: 'standard',
  weather: 'sunny',
  radar: 'uplinks',
  vehicles: 'on',
  botCount: 5,
  botDifficulty: 'normal',
  botBehaviour: 'ffa',
  scoreLimit: 'unlimited',
  timeLimit: 'unlimited',
  botChatter: 'off',
};

beforeAll(async () => {
  await initPhysics();
});

describe('idle practice spawns on the Market', () => {
  for (const botDifficulty of ['easy', 'normal', 'hard'] as const) {
    it(`${botDifficulty}: 20 seeds, five bots, three protected lives and varied first spawns`, () => {
      expect(SPAWN_PROTECTION.duration).toBeGreaterThanOrEqual(3);
      const firstSpawns = new Set<string>();
      let quietLives = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const host = new PracticeHost(
          { settings: { ...settings, botDifficulty }, name: 'Idle', spawnSeed: seed },
          () => {},
        );
        try {
          const sim = host.sim;
          const human = sim.players.get(PRACTICE_PLAYER_ID)!;
          expect([...sim.players.values()].filter((p) => p.bot)).toHaveLength(5);
          // Snapshot handlers can be registered long before the GPU finishes warm-up.
          host.step(30 * SIM.tickHz, true);
          expect(human.ready).toBe(false);
          expect(human.deaths).toBe(0);
          host.receive('ready', {}, sim.nowMs);
          firstSpawns.add(`${human.state.move.pos.x},${human.state.move.pos.z}`);
          for (let life = 0; life < 3; life++) {
            expect(human.state.health).toBe(100);
            const born = sim.tick;
            let firstDamage = Infinity;
            for (let tick = 1; tick <= 6 * SIM.tickHz; tick++) {
              host.step(1, false); // no human input, even a neutral packet
              if (human.state.health < 100 && firstDamage === Infinity) firstDamage = tick;
              if (tick <= 3 * SIM.tickHz)
                expect(
                  human.state.health,
                  `${botDifficulty}, seed ${seed}, life ${life}, tick ${sim.tick - born}`,
                ).toBe(100);
            }
            if (firstDamage > 5 * SIM.tickHz) quietLives++;
            // Exercise the normal scheduled respawn path without waiting for a bot to find us.
            if (life < 2) {
              const previous = human.life;
              human.state.health = 0;
              human.respawnTick = sim.tick + 1;
              host.step(1, false);
              expect(human.life).toBe(previous + 1);
              expect(human.state.spawnGuard).toBe(SPAWN_PROTECTION.duration);
            }
          }
        } finally {
          host.dispose();
        }
      }
      expect(firstSpawns.size).toBeGreaterThan(1);
      // Spawn safety should usually buy time beyond the invulnerability window.
      expect(quietLives).toBeGreaterThan(30);
    }, 180_000);
  }
});
