import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOT,
  createPlayerState,
  initPhysics,
  PRIMARY_IDS,
  type CombatEvent,
  type PrimaryId,
  type Vec3,
} from '@wd/shared';
import { MatchSim, type ServerPlayer } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

type Hit = Extract<CombatEvent, { type: 'hit' }>;

/** Put a player somewhere (tests only: players move by inputs in the game). */
function place(p: ServerPlayer, feet: Vec3, yaw = 0): void {
  p.body.setPosition(feet);
  p.body.setGrounded(true);
  p.state.move.pos = { ...feet };
  p.state.view = { yaw, pitch: 0 };
}

describe('bot arsenal', () => {
  it('bots may draw every primary (none excluded)', () => {
    expect([...BOT.primaries].sort()).toEqual([...PRIMARY_IDS].sort());
  });

  it('picks a primary per bot and per life, deterministically, with real variety', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 5 });
    const again = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 5 });
    try {
      sim.addPlayer('human', 'Human', 0);
      again.addPlayer('human', 'Human', 0);
      const bots = [...sim.players.values()].filter((p) => p.bot);
      expect(bots).toHaveLength(5);
      // The first life goes through the join loadout (addPlayer's primary), like a human's.
      for (const b of bots) {
        expect(b.state.arsenal.primary).toBe(sim.bots.primaryFor(b.id, 0));
        expect(b.primary).toBe(b.state.arsenal.primary);
        expect(again.players.get(b.id)!.state.arsenal.primary).toBe(b.state.arsenal.primary);
      }
      expect(new Set(bots.map((b) => b.state.arsenal.primary)).size).toBeGreaterThanOrEqual(3);
      // A bot draws only its personality's guns; over the five seats' lives the whole arsenal
      // comes up.
      const lives = new Set<PrimaryId>();
      for (const b of bots) {
        const pool = BOT.personalities[sim.bots.personalities.get(b.id)!].primaries;
        for (let life = 0; life < 40; life++) {
          const primary = sim.bots.primaryFor(b.id, life);
          expect(pool).toContain(primary);
          lives.add(primary);
        }
      }
      expect(lives.size).toBe(PRIMARY_IDS.length);
    } finally {
      sim.dispose();
      again.dispose();
    }
  });

  it('a respawning bot takes its next primary through the loadout path', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 1 });
    try {
      sim.addPlayer('human', 'Human', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      const told: string[] = [];
      sim.onRespawn = (p, msg) => {
        if (p === bot) told.push(msg.primary ?? '');
      };
      for (let life = 1; life <= 6; life++) {
        bot.state.health = 0;
        bot.respawnTick = sim.tick + 1;
        sim.step();
        sim.step();
        expect(bot.life).toBe(life);
        const want = sim.bots.primaryFor(bot.id, life);
        expect(bot.primary).toBe(want);
        expect(bot.state.arsenal.primary).toBe(want);
        expect(told.at(-1)).toBe(want);
      }
      // Humans keep what they chose.
      const human = sim.players.get('human')!;
      expect(human.state.arsenal.primary).toBe('ar7');
    } finally {
      sim.dispose();
    }
  });

  it('knife-only bots keep the human kit (the primary is moot)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'knife', botCount: 1 });
    try {
      sim.addPlayer('human', 'Human', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      expect(bot.state.arsenal.primary).toBe('ar7');
      expect(bot.state.arsenal.slot).toBe('knife');
    } finally {
      sim.dispose();
    }
  });

  /**
   * The real behaviour tree, through the real input path, with one gun: a bot facing an idle
   * player on the range's open lane must kill them with it (no frag: it has none this life).
   */
  function duelWith(
    primary: PrimaryId,
    distance: number,
  ): { kills: Hit[]; shots: number; seconds: number } {
    const sim = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      botCount: 1,
      botDifficulty: 'hard',
      // The gun's handling is under test, not the 2 s hold on a freshly spawned target.
      spawnProtection: 0,
    });
    try {
      const human = sim.addPlayer('human', 'Human', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      // Test setup: this life's kit is `primary` (what a respawn with that loadout builds).
      bot.primary = primary;
      bot.state = createPlayerState(bot.state.move.pos, bot.seed, 'standard', primary);
      bot.state.arsenal.grenades = 0;
      sim.bots.reset(bot.id);
      place(bot, { x: 0, y: 0, z: -12 });
      place(human, { x: 0, y: 0, z: -12 - distance }, Math.PI);
      const kills: Hit[] = [];
      let ticks = 0;
      for (let t = 0; t < 60 * 20 && !kills.length; t++) {
        sim.bots.enqueue();
        sim.step();
        for (const e of sim.drainEvents())
          if (e.type === 'hit' && e.by === bot.id && e.killed) kills.push(e);
        ticks = t;
      }
      return { kills, shots: bot.shots, seconds: ticks / 60 };
    } finally {
      sim.dispose();
    }
  }

  for (const [primary, distance] of [
    ['ar7', 10],
    ['coil', 14],
    ['iskra', 9],
    ['shotgun', 10],
    ['marksman', 16],
    ['arc', 10],
  ] as const) {
    it(`a bot scores a kill with the ${primary}`, () => {
      const { kills, shots, seconds } = duelWith(primary, distance);
      expect(shots, `${primary} shots`).toBeGreaterThan(0);
      expect(kills.length, `${primary} (${shots} shots, ${seconds.toFixed(1)} s)`).toBeGreaterThan(
        0,
      );
      // With the primary itself (not the knife or a frag).
      expect(kills[0]!.weapon).toBe('rifle');
    });
  }
});
