import { beforeAll, describe, expect, it } from 'vitest';
import {
  emptyInput,
  eyePosition,
  initPhysics,
  MATCH_NET,
  SIM,
  SPAWN_PROTECTION,
  spawnSafety,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@wd/shared';
import { CameraDirector, CINE } from '../../../client/src/camera/cameraDirector.ts';
import { OnlineSession } from '../../../client/src/net/onlineSession.ts';
import { PRACTICE_PLAYER_ID, PracticeHost, type PracticeInit } from './practiceHost.ts';

const SETTINGS = {
  map: 'range',
  size: 'full',
  mode: 'standard',
  weather: 'sunny',
  radar: 'uplinks',
  botCount: 5,
  botBehaviour: 'ffa',
  botDifficulty: 'normal',
  scoreLimit: 25,
  timeLimit: 600,
  vehicles: 'off',
} as const satisfies PracticeInit['settings'];

describe('practice starts when its local player can play', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  for (const start of ['ready', 'input'] as const) {
    it(`keeps the full spawn window after a long warm-up, then starts on ${start}`, () => {
      const snaps: SnapshotMessage[] = [];
      const h = new PracticeHost(
        { settings: SETTINGS, name: 'You', spawnSeed: 731 },
        (type, msg) => {
          if (type === 'snap') snaps.push(structuredClone(msg) as SnapshotMessage);
        },
      );
      try {
        const p = h.sim.players.get(PRACTICE_PLAYER_ID)!;
        // The worker is already running while the page uploads assets and warms shaders.
        const warmupTicks = Math.ceil((MATCH_NET.readyTimeoutMs / 1000 + 10) * SIM.tickHz);
        h.receive('ready', null, 0);
        h.receive('input', { inputs: [{ seq: 'invalid' }] }, 0);
        h.step(warmupTicks, false);
        expect(snaps).toHaveLength(0);
        h.step(2, true);
        expect(h.sim.tick).toBe(0);
        expect(h.sim.nowMs).toBe(0);
        expect(p.ready).toBe(false);
        expect(p.state.health).toBe(100);
        expect(snaps).toHaveLength(1);
        expect(snaps[0]).toMatchObject({ t: 0, held: true });
        expect(h.sim.config.spawnSeed).toBe(731);

        const msg = start === 'input' ? { inputs: [emptyInput(0)] } : {};
        h.receive(start, msg, 30000);
        expect(p.ready).toBe(true);
        expect(p.state.spawnGuard).toBe(SPAWN_PROTECTION.duration);
        h.step(1, true);
        expect(h.sim.tick).toBe(1);
        expect(p.state.health).toBe(100);
        expect(p.state.spawnGuard).toBeCloseTo(SPAWN_PROTECTION.duration - 1 / SIM.tickHz);
        expect(snaps).toHaveLength(2);
        expect(snaps[1]!.held).toBeUndefined();
      } finally {
        h.dispose();
      }
    });
  }

  it('shows the frozen bootstrap world through the intro and starts timing only when playable', () => {
    const session = new OnlineSession();
    let localMs = 1000;
    let snapshots = 0;
    const h = new PracticeHost(
      {
        settings: { ...SETTINGS, map: 'defilad', size: 'market', vehicles: 'on' },
        name: 'You',
        spawnSeed: 1,
      },
      (type, msg) => {
        if (type === 'welcome') session.handleWelcome(msg as WelcomeMessage);
        if (type === 'snap') {
          snapshots++;
          session.handleSnapshot(msg as SnapshotMessage, localMs);
        }
      },
    );
    try {
      // Game pauses timing on the menu, then pointer lock resumes it before the intro ends.
      session.pauseTiming(localMs);
      localMs += 30_000;
      h.step(30 * SIM.tickHz, true);
      const bots = session.remotePlayers(localMs);
      const trucks = session.vehicles(localMs);
      expect(bots).toHaveLength(5);
      expect(trucks).toHaveLength(2);
      session.resumeTiming(localMs);
      for (let tick = 0; tick < CINE.introDuration * SIM.tickHz; tick += 2) {
        localMs += 2000 / SIM.tickHz;
        h.step(2, true);
        expect(session.remotePlayers(localMs)).toEqual(bots);
        expect(session.vehicles(localMs)).toEqual(trucks);
        expect(session.serverNow(localMs)).toBe(0);
        expect(session.clock.synced).toBe(false);
        expect(session.netStats(localMs)).toMatchObject({
          delayMs: MATCH_NET.interpDelayMs,
          jitterMs: 0,
          silenceMs: 0,
          stalls: 0,
        });
      }
      expect(h.sim.tick).toBe(0);
      expect(snapshots).toBeGreaterThan(1);

      h.receive('ready', {}, localMs);
      for (let tick = 0; tick < 2 * SIM.tickHz; tick += 2) {
        localMs += 2000 / SIM.tickHz;
        h.step(2, true);
        expect(Math.abs(session.serverNow(localMs)! - h.sim.nowMs)).toBeLessThan(1);
        expect(session.netStats(localMs)).toMatchObject({
          delayMs: MATCH_NET.interpDelayMs,
          stalls: 0,
        });
        expect(session.netStats(localMs).jitterMs).toBeLessThan(0.001);
      }
    } finally {
      h.dispose();
    }
  });

  for (const intro of [true, false]) {
    it(`welcomes the player at the safe playable spawn with the intro ${intro ? 'on' : 'off'}`, () => {
      const messages: WelcomeMessage[] = [];
      const h = new PracticeHost(
        { settings: { ...SETTINGS, map: 'defilad', size: 'market' }, name: 'You', spawnSeed: 1 },
        (type, msg) => {
          if (type === 'welcome') messages.push(msg as WelcomeMessage);
        },
      );
      try {
        const p = h.sim.players.get(PRACTICE_PLAYER_ID)!;
        const bots = [...h.sim.players.values()].filter((p) => p.bot);
        const enemies = bots.map((p) => eyePosition(p.state));
        const safest = Math.max(...h.sim.spawns.map((s) => spawnSafety(s, enemies, h.sim.physics)));
        const { x, y, z, yaw } = messages[0]!.spawn;
        const destination = { x, y, z };
        expect(bots).toHaveLength(5);
        expect(spawnSafety({ pos: destination, yaw }, enemies, h.sim.physics)).toBe(safest);

        // Game plans the Market intro's final eye from welcome, then sends ready at handoff.
        const director = new CameraDirector();
        director.setEnabled(intro);
        if (director.startIntro()) {
          for (let frame = 0; frame <= CINE.introDuration * SIM.tickHz; frame++) {
            director.update(1 / SIM.tickHz);
            h.step(1, true);
          }
        }
        expect(director.mode).toBe('play');
        expect(h.sim.tick).toBe(0);
        expect(bots.map((p) => eyePosition(p.state))).toEqual(enemies);
        expect(p.state.move.pos).toEqual(destination);
        h.receive('ready', {}, 30_000 + CINE.introDuration * 1000);
        expect(p.state.move.pos).toEqual(destination);
        expect(p.state.view.yaw).toBe(yaw);
        expect(p.state.spawnGuard).toBe(3);
        h.step(1, false);
        expect(p.state.spawnGuard).toBeCloseTo(3 - 1 / SIM.tickHz);
      } finally {
        h.dispose();
      }
    });
  }
});
