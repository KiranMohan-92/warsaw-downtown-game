import { beforeAll, describe, expect, it } from 'vitest';
import {
  emptyInput,
  eyePosition,
  initPhysics,
  MATCH_NET,
  SIM,
  SPAWN_PROTECTION,
  spawnSafety,
  type RespawnMessage,
} from '@wd/shared';
import type { BotObservation } from '../bots/index.ts';
import { MatchSim, type ServerPlayer } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

/** Stand `p` a few metres in front of `viewer`, facing it (test setup only). */
function standInFront(sim: MatchSim, viewer: ServerPlayer, p: ServerPlayer, dist = 4): void {
  const { pos } = viewer.state.move;
  const yaw = viewer.state.view.yaw;
  const at = { x: pos.x - Math.sin(yaw) * dist, y: pos.y, z: pos.z - Math.cos(yaw) * dist };
  p.state.move.pos = { ...at };
  p.body.setPosition(at);
  p.history.record({
    ms: sim.nowMs,
    feet: p.state.move.pos,
    eye: p.state.move.eyeHeight,
    life: p.life,
    alive: true,
  });
}

describe('players still loading the game (friend lobby start) are out of the fight', () => {
  it('rechecks spawn safety against current opponents and sends one life transition at ready', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 19 });
    try {
      const loading = sim.addPlayer('loading', 'Loading', 0, false, { ready: false });
      const camper = sim.addPlayer('camper', 'Camper', 0);
      const joinedAt = { ...loading.state.move.pos };
      // The opponent reached the loading player's original spawn before Play.
      camper.state.move.pos = { ...joinedAt };
      camper.body.setPosition(joinedAt);
      const enemies = [eyePosition(camper.state)];
      const safestAuthored = Math.max(
        ...sim.spawns.map((s) => spawnSafety(s, enemies, sim.physics)),
      );
      const moves: RespawnMessage[] = [];
      sim.onRespawn = (p, msg) => {
        if (p.id === loading.id) moves.push(msg);
      };
      sim.markReady(loading.id);
      expect(loading.state.move.pos).not.toEqual(joinedAt);
      // The full-room pool can improve on the authored starts; it must not sacrifice safety.
      expect(
        spawnSafety({ pos: loading.state.move.pos, yaw: 0 }, enemies, sim.physics),
      ).toBeGreaterThanOrEqual(safestAuthored);
      expect(loading.state.spawnGuard).toBe(SPAWN_PROTECTION.duration);
      expect(moves).toEqual([expect.objectContaining({ life: 1, seq: -1 })]);
      expect(sim.snapshot(loading.id).players.find((p) => p.id === loading.id)?.life).toBe(1);
      sim.markReady(loading.id);
      expect(moves).toHaveLength(1); // repeated ready cannot relocate or renew protection
    } finally {
      sim.dispose();
    }
  });

  it('cannot be hit and are invisible to bots until ready', () => {
    const sim = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      botCount: 1,
      botBehaviour: 'hunt-humans',
    });
    try {
      const loading = sim.addPlayer('loading', 'Loading', 0, false, { ready: false });
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      expect(loading.ready).toBe(false);
      expect(bot.ready).toBe(true);
      standInFront(sim, bot, loading);

      const seen: BotObservation[] = [];
      sim.bots.providers.set(bot.id, {
        decide: (o) => {
          seen.push(o);
          return emptyInput(o.seq);
        },
      });
      // Not hittable (shots and knife use these targets), not seen or hunted by the bot.
      expect(sim.targetsAt(sim.nowMs, bot.id).map((t) => t.id)).not.toContain('loading');
      expect(sim.fighting().map((p) => p.id)).not.toContain('loading');
      sim.bots.enqueue();
      expect(seen.at(-1)!.visiblePlayers.map((p) => p.id)).not.toContain('loading');

      // Ready: a safe new spawn, in the fight. Put it in view again to test perception alone.
      sim.markReady('loading');
      standInFront(sim, bot, loading);
      expect(sim.targetsAt(sim.nowMs, bot.id).map((t) => t.id)).toContain('loading');
      sim.bots.enqueue();
      expect(seen.at(-1)!.visiblePlayers.map((p) => p.id)).toContain('loading');
    } finally {
      sim.dispose();
    }
  });

  it('a client that acts, or never says ready, is in the fight anyway', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 0 });
    try {
      const acting = sim.addPlayer('acting', 'Acting', 0, false, { ready: false });
      const silent = sim.addPlayer('silent', 'Silent', 0, false, { ready: false });
      // Sending inputs means playing: no shooting while untouchable.
      sim.receiveInputs('acting', [emptyInput(0)], 0);
      expect(acting.ready).toBe(true);
      // The safety timeout.
      expect(silent.readyByTick).toBe(Math.ceil((MATCH_NET.readyTimeoutMs / 1000) * SIM.tickHz));
      expect(MATCH_NET.readyTimeoutMs).toBeLessThanOrEqual(20000);
      silent.readyByTick = sim.tick + 2;
      sim.step();
      expect(silent.ready).toBe(false);
      sim.step();
      sim.step();
      expect(silent.ready).toBe(true);
      // Quick join (ready at once) is unchanged.
      expect(sim.addPlayer('quick', 'Quick', 0).ready).toBe(true);
    } finally {
      sim.dispose();
    }
  });
});
