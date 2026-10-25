import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Button, createJetpacks, grantJetpack, initPhysics, JetMode, type Vec3 } from '@wd/shared';
import { MatchSim, type ServerPlayer } from '../match/MatchSim.ts';
import { JetpackPilot } from './jetpackPilot.ts';
import type { BotObservation, BotVisiblePlayer } from './types.ts';

beforeAll(async () => {
  await initPhysics();
});

function place(p: ServerPlayer, feet: Vec3, yaw = 0): void {
  p.body.setPosition(feet);
  p.body.setGrounded(true);
  p.state.move.pos = { ...feet };
  p.state.view = { yaw, pitch: 0 };
}

describe('bots and jetpacks', () => {
  it('a rusher takes a nearby pack, lights it for a fight, flies and shoots from the air', () => {
    const sim = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      botCount: 1,
      botDifficulty: 'hard',
      spawnProtection: 0,
    });
    try {
      const human = sim.addPlayer('human', 'Human', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      expect(sim.bots.personalities.get(bot.id)).toBe('rusher');
      bot.state.arsenal.grenades = 0;
      place(bot, { x: 0, y: 0, z: -12 });
      place(human, { x: 0, y: 0, z: -34 }, Math.PI);
      human.state.health = 1e6; // a target that stays up: the flight is under test
      // The pack lies 4 m from the bot.
      sim.tactics.jetpacks = createJetpacks([{ x: 3, y: 0, z: -14 }]);
      let took = -1;
      let lit = -1;
      let maxAlt = 0;
      let airShots = 0;
      for (let t = 0; t < 60 * 14 && airShots < 3; t++) {
        sim.step();
        const m = bot.state.move;
        if (took < 0 && m.jet !== JetMode.None) took = t;
        if (lit < 0 && m.jet >= JetMode.Flying) lit = t;
        if (m.jet === JetMode.Flying) maxAlt = Math.max(maxAlt, m.pos.y);
        for (const e of sim.drainEvents())
          if (e.type === 'shot' && e.by === bot.id && m.jet === JetMode.Flying && m.pos.y > 1)
            airShots++;
      }
      expect(took).toBeGreaterThanOrEqual(0);
      expect(lit).toBeGreaterThan(took);
      expect(maxAlt).toBeGreaterThan(2);
      expect(airShots).toBeGreaterThanOrEqual(3);
    } finally {
      sim.dispose();
    }
  });

  it('keenness follows the personality; nothing to do without packs', () => {
    const packs = Array.from({ length: 40 }, (_, id) => ({ id, pos: { x: id, y: 0, z: 0 } }));
    const obs = (id: number) =>
      ({
        nowMs: 0,
        self: { jet: 0, pos: { x: id, y: 0, z: 0 } },
        jetpacks: [packs[id]!],
        memories: [],
      }) as unknown as Parameters<JetpackPilot['packGoal']>[0];
    const wanted = (p: JetpackPilot) => packs.filter((x) => p.packGoal(obs(x.id)) !== null).length;
    expect(wanted(new JetpackPilot(7, 'rusher'))).toBe(40);
    expect(wanted(new JetpackPilot(7, 'anchor'))).toBeLessThan(
      wanted(new JetpackPilot(7, 'flanker')),
    );
    const none = { ...obs(0), jetpacks: undefined } as Parameters<JetpackPilot['packGoal']>[0];
    expect(new JetpackPilot(7, 'rusher').packGoal(none)).toBeNull();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A hand-built observation: open ground, everyone sees everyone. */
  function obs(
    nowMs: number,
    self: { jet: number; grounded: boolean; health?: number; y?: number; alt?: number },
    visiblePlayers: BotVisiblePlayer[] = [],
  ): BotObservation {
    const y = self.y ?? 0;
    return {
      nowMs,
      self: {
        pos: { x: 0, y, z: 0 },
        eye: { x: 0, y: y + 1.62, z: 0 },
        health: self.health ?? 100,
        jet: self.jet,
        grounded: self.grounded,
        jetFuel: 10,
        jetAlt: self.alt ?? y,
      },
      visiblePlayers,
      memories: [],
      nav: { nodes: [], lineOfSight: () => true },
      jetpacks: [],
    } as unknown as BotObservation;
  }

  it('a badly hurt pilot that landed with fuel left stays down (Codex P2: it hopped)', () => {
    const hops = (health: number): number => {
      const p = new JetpackPilot(3, 'rusher');
      let jumps = 0;
      for (let t = 0; t < 180; t++) {
        const r = p.adjust(
          obs(t * 16, { jet: JetMode.Flying, grounded: true, health }),
          null,
          null,
          0,
          0,
          0,
        );
        if (r && (r.buttons & Button.Jump) !== 0) jumps++;
      }
      return jumps;
    };
    expect(hops(100)).toBeGreaterThan(0); // healthy: takes off again to cruise
    expect(hops(40)).toBe(0);
  });

  it('time spent wearing an unlit pack never counts as being aimed at (Codex P2)', () => {
    const p = new JetpackPilot(3, 'rusher');
    const flying = { jet: JetMode.Flying, grounded: false, y: 2 };
    // A first flight, landed (jet back to none), then a second pack worn unlit for ~8 s.
    p.adjust(obs(0, flying), null, null, 0, 0, 0);
    p.adjust(obs(16, { jet: JetMode.None, grounded: true }), null, null, 0, 0, 0);
    for (let t = 32; t <= 8000; t += 16)
      p.adjust(obs(t, { jet: JetMode.Worn, grounded: true }), null, null, 0, 0, 0);
    // Lit: someone aims at us on the very first flying tick (an eye level with ours, facing +Z).
    const aimer = {
      id: 'e',
      pos: { x: 0, y: 2, z: -10 },
      eye: { x: 0, y: 3.62, z: -10 },
      yaw: Math.PI,
      pitch: 0,
    } as unknown as BotVisiblePlayer;
    const r = p.adjust(obs(8016, flying, [aimer]), null, null, 0, 0, 0)!;
    // Aimed at for one tick, not 8 s: no break-line drop, it climbs to cruise.
    expect(r.buttons & Button.Crouch).toBe(0);
    expect(r.buttons & Button.Jump).not.toBe(0);
  });

  it('the pilot sees the enemies the tree remembers, through the real MatchBots path (Codex P2)', () => {
    const sim = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      botCount: 1,
      botDifficulty: 'normal',
      spawnProtection: 0,
    });
    const spy = vi.spyOn(JetpackPilot.prototype, 'adjust');
    try {
      const human = sim.addPlayer('human', 'Human', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      human.state.health = 1e6;
      place(bot, { x: 0, y: 0, z: -12 });
      place(human, { x: 0, y: 0, z: -24 }, Math.PI);
      for (let t = 0; t < 60; t++) sim.step(); // seen
      for (let t = 0; t < 60; t++) {
        place(human, { x: 0, y: 0, z: -140 }); // well out of sight range
        sim.step();
      }
      const last = spy.mock.calls.at(-1)![0];
      expect(last.visiblePlayers.some((p) => p.id === human.id)).toBe(false);
      expect(last.memories.some((m) => m.id === human.id)).toBe(true);
    } finally {
      sim.dispose();
    }
  });

  it('hunt-humans: other bots in sight light nothing; a human does (fair FFA: bots do) (Codex P2)', () => {
    /** Ticks until the first bot lights its worn pack (-1: never), with the human hidden first. */
    const run = (behaviour: 'ffa' | 'hunt-humans', showHumanAt: number): number => {
      const sim = new MatchSim({
        map: 'range',
        size: 'full',
        mode: 'standard',
        botCount: 2,
        botDifficulty: 'normal',
        spawnProtection: 0,
        botBehaviour: behaviour,
      });
      try {
        const human = sim.addPlayer('human', 'Human', 0);
        human.state.health = 1e6;
        const [a, b] = [...sim.players.values()].filter((p) => p.bot);
        a!.state.arsenal.grenades = 0;
        b!.state.arsenal.grenades = 0;
        b!.state.health = 1e6;
        place(a!, { x: 0, y: 0, z: -12 });
        place(b!, { x: 0, y: 0, z: -27 }, Math.PI);
        grantJetpack(a!.state.move);
        for (let t = 0; t < 60 * 8; t++) {
          if (t < showHumanAt) place(human, { x: 0, y: 0, z: -140 });
          else if (t === showHumanAt) place(human, { x: 2, y: 0, z: -26 }, Math.PI);
          sim.step();
          sim.drainEvents();
          if (a!.state.move.jet >= JetMode.Flying) return t;
        }
        return -1;
      } finally {
        sim.dispose();
      }
    };
    expect(run('hunt-humans', Infinity)).toBe(-1); // only a bot in sight: stays unlit
    const lit = run('hunt-humans', 120);
    expect(lit).toBeGreaterThan(120); // lights once the human shows up
    expect(run('ffa', Infinity)).toBeGreaterThanOrEqual(0); // fair FFA: the bot is a fight
  });
});
