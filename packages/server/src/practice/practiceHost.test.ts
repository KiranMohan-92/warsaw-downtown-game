import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOT,
  Button,
  emptyInput,
  initPhysics,
  MATCH_NET,
  PRIMARY_IDS,
  SIM_DT,
  type InputMessage,
  type DropMessage,
  type LobbyMessage,
  type MatchStateMessage,
  type RosterMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@wd/shared';
import { OnlineSession } from '../../../client/src/net/onlineSession.ts';
import { wireOnlineRoom, OnlineLink } from '../../../client/src/net/connectOnline.ts';
import { launchPractice, type PracticePort } from '../../../client/src/net/practiceRoom.ts';
import { DEFAULT_SETTINGS } from '../../../client/src/settings/settings.ts';
import { PRACTICE_PLAYER_ID, PracticeHost, type PracticeInit } from './practiceHost.ts';

// The test range: a small world (the Market's Rapier world + nav graph cost seconds to build).
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
  vehicles: 'on',
} as const satisfies PracticeInit['settings'];

/** A host and what it sent, by type (the newest of each, and all of them in order). */
function host(init: Partial<PracticeInit> = {}): {
  h: PracticeHost;
  sent: { type: string; msg: unknown }[];
  last: <T>(type: string) => T | undefined;
} {
  const sent: { type: string; msg: unknown }[] = [];
  const h = new PracticeHost({ settings: SETTINGS, name: 'Kiran', ...init }, (type, msg) =>
    sent.push({ type, msg: structuredClone(msg) }),
  );
  const last = <T>(type: string): T | undefined =>
    sent.findLast((m) => m.type === type)?.msg as T | undefined;
  return { h, sent, last };
}

describe('practice match host (MatchSim + bots, no server)', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('replays the default spawn layout and bot simulation when constructed without a seed', () => {
    const { h: a, last: first } = host();
    const { h: b, last: replay } = host({ spawnSeed: 0 });
    try {
      expect(first<WelcomeMessage>('welcome')).toEqual(replay<WelcomeMessage>('welcome'));
      for (const h of [a, b]) h.receive('ready', {}, 0);
      for (let tick = 0; tick < 120; tick++) {
        for (const h of [a, b]) h.step(1, false);
        expect(a.sim.snapshot()).toEqual(b.sim.snapshot());
      }
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('opens like a started friend room: welcome, roster with five personalities, match, lobby', () => {
    const { h, sent, last } = host();
    try {
      expect(sent.map((m) => m.type)).toEqual(['welcome', 'roster', 'match', 'lobby']);
      const welcome = last<WelcomeMessage>('welcome')!;
      expect(welcome.id).toBe(PRACTICE_PLAYER_ID);
      expect(welcome.settings?.botDifficulty).toBe('normal');
      const roster = last<RosterMessage>('roster')!.players;
      const bots = roster.filter((p) => p.bot);
      expect(bots).toHaveLength(5);
      // Seats cycle the personalities; names are their callsigns, all different.
      expect(bots.map((b) => b.persona)).toEqual([
        'rusher',
        'flanker',
        'anchor',
        'marksman',
        'rusher',
      ]);
      expect(new Set(bots.map((b) => b.name)).size).toBe(5);
      expect(bots[0]!.name).toBe(BOT.personalities.rusher.callsigns[0]);
      expect(roster.find((p) => !p.bot)?.name).toBe('Kiran');
      expect(last<LobbyMessage>('lobby')).toMatchObject({
        hostId: PRACTICE_PLAYER_ID,
        phase: 'playing',
      });
      expect(last<MatchStateMessage>('match')).toMatchObject({ phase: 'playing', scoreLimit: 25 });
    } finally {
      h.dispose();
    }
  });

  it('steps like the room: snapshots every second tick, combat and score changes; bots fight', () => {
    const { h, sent } = host();
    try {
      h.receive('ready', {}, 0);
      for (let t = 0; t < 60 * 15; t += 2) h.step(2, true);
      const snaps = sent.filter((m) => m.type === 'snap');
      expect(snaps.length).toBe(15 * 30);
      // Bots shoot each other (and the idle player): fifteen seconds of five bots on the range.
      const combat = sent.filter((m) => m.type === 'combat').length;
      expect(combat).toBeGreaterThan(10);
      expect(h.sim.scores().reduce((a, s) => a + s.kills, 0)).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });

  it('validates what the page sends like the room does (junk is dropped, not applied)', () => {
    const { h } = host();
    try {
      h.receive('input', { inputs: [{ seq: 'x' }] }, 0);
      h.receive('loadout', { primary: 'railgun' }, 0);
      h.receive('end', { force: 1 }, 0); // extra keys are fine: `{}` schema
      expect(h.sim.phase).toBe('ended');
      const p = h.sim.players.get(PRACTICE_PLAYER_ID)!;
      expect(p.lastSeq).toBe(-1);
      expect(PRIMARY_IDS).toContain(p.primary);
    } finally {
      h.dispose();
    }
  });

  it('gates development drops, validates their payloads and sends feedback before state', () => {
    const normal = host({ settings: { ...SETTINGS, botCount: 1 } });
    const debug = host({ settings: { ...SETTINGS, botCount: 1 }, allowDevTools: true });
    const payload = { primaryId: 'shotgun', x: 0, z: -22, ammoFraction: 0.5 };
    try {
      normal.h.receive('dropGun', payload, 0);
      expect(normal.h.sim.drops).toHaveLength(0);
      for (const invalid of [
        { ...payload, primaryId: 'knife' },
        { ...payload, x: Infinity },
      ])
        debug.h.receive('dropGun', invalid, 0);
      expect(debug.h.sim.drops).toHaveLength(0);
      debug.h.receive('ready', {}, 0);
      debug.h.receive('dropGun', payload, 0);
      debug.h.step(1, true);
      expect(debug.last<DropMessage>('drop')?.events).toContainEqual(
        expect.objectContaining({ type: 'spawn' }),
      );
      expect(debug.last<SnapshotMessage>('snap')?.drops).toHaveLength(1);
      expect(debug.sent.findIndex((m) => m.type === 'drop')).toBeLessThan(
        debug.sent.findIndex((m) => m.type === 'snap'),
      );
    } finally {
      normal.h.dispose();
      debug.h.dispose();
    }
  });

  it('launches, flies and recalls a recon drone via the practice worker input messages', () => {
    const { h, last } = host({ settings: { ...SETTINGS, botCount: 1 } });
    try {
      h.receive('ready', {}, 0);
      const p = h.sim.players.get(PRACTICE_PLAYER_ID)!;
      h.sim.tactics.pickups.push({
        id: 'recon',
        kind: 'drone',
        pos: { ...p.state.move.pos },
        cooldown: 0,
      });
      h.step(2, true);
      expect(p.state.droneCharges).toBe(1);
      const body = { ...p.state.move.pos };
      h.receive('input', { inputs: [{ ...emptyInput(0), buttons: Button.Drone }] }, h.sim.nowMs);
      h.step(2, true);
      expect(last<SnapshotMessage>('snap')!.drones?.[0]?.[0]).toBe(PRACTICE_PLAYER_ID);
      const start = { ...p.state.drone!.pos };
      for (let seq = 1; seq < 13; seq++) {
        h.receive('input', { inputs: [{ ...emptyInput(seq), moveZ: 1 }] }, h.sim.nowMs);
        h.step(1, true);
      }
      expect(p.state.drone!.pos.z).toBeLessThan(start.z - 0.2);
      expect(
        Math.hypot(
          p.state.move.pos.x - body.x,
          p.state.move.pos.y - body.y,
          p.state.move.pos.z - body.z,
        ),
      ).toBeLessThan(0.01);
      // The worker uses the room schema: non-finite flight commands never enter its sim.
      h.receive('input', { inputs: [{ ...emptyInput(13), moveX: Infinity }] }, h.sim.nowMs);
      expect(p.lastSeq).toBe(12);
      h.receive('input', { inputs: [{ ...emptyInput(13), buttons: Button.Drone }] }, h.sim.nowMs);
      h.step(2, true);
      expect(last<SnapshotMessage>('snap')!.drones ?? []).toHaveLength(0);
      expect(p.state.drone).toBeNull();
      expect([...h.sim.players.values()].every((q) => !q.bot || q.state.drone === null)).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it('unlimited score and time: no clock, kills never end it; End match does', () => {
    const { h, last } = host({
      settings: { ...SETTINGS, scoreLimit: 'unlimited', timeLimit: 'unlimited' },
    });
    try {
      expect(last<MatchStateMessage>('match')).toMatchObject({
        endsAt: null,
        scoreLimit: 'unlimited',
      });
      h.sim.players.get(PRACTICE_PLAYER_ID)!.kills = 500;
      h.step(60, true);
      expect(h.sim.phase).toBe('playing');
      h.receive('end', {}, 0);
      expect(last<MatchStateMessage>('match')).toMatchObject({ phase: 'ended' });
      // A second End during the results changes nothing.
      const before = h.sim.phaseEnds;
      h.receive('end', {}, 0);
      expect(h.sim.phaseEnds).toBe(before);
    } finally {
      h.dispose();
    }
  });
});

/**
 * The page side and the worker side joined by a message port pair (structured clones, delivered
 * on a later turn, like `postMessage`): the client's real `PracticeRoom` + `OnlineSession` (the
 * online path the game plays practice through) against the real host.
 */
function linkedPractice(): {
  room: ReturnType<typeof launchPractice>['room'];
  session: OnlineSession;
  pump: () => Promise<void>;
  host: () => PracticeHost | null;
  toWorker: string[];
} {
  let h: PracticeHost | null = null;
  let running = false;
  const toWorker: string[] = [];
  const pending: (() => void)[] = [];
  const port: PracticePort = {
    onmessage: null,
    postMessage: (raw) => {
      const data = structuredClone(raw) as { type: string; msg?: unknown; init?: PracticeInit };
      toWorker.push(data.type);
      if (data.type === 'init') {
        h = new PracticeHost(data.init!, (type, msg) => {
          const copy = structuredClone({ type, msg });
          pending.push(() => port.onmessage?.({ data: copy }));
        });
      } else if (data.type === 'run') running = true;
      else if (data.type !== 'stop') h?.receive(data.type, data.msg, 0);
    },
    terminate: () => {
      h?.dispose();
      h = null;
    },
  };
  const launch = launchPractice(
    { ...DEFAULT_SETTINGS, map: 'range', mapSize: 'full', playerName: 'Kiran' },
    () => port,
  );
  const session = new OnlineSession();
  wireOnlineRoom(session, new OnlineLink(), launch.room, launch.buffer, { endMatch: true });
  const pump = async (): Promise<void> => {
    if (running) h?.step(2, true);
    for (const f of pending.splice(0)) f();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { room: launch.room, session, pump, host: () => h, toWorker };
}

describe('practice match flow (page ↔ worker)', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('the game listens first, then the worker clock runs; scores, host and End match work', async () => {
    const { room, session, pump, host: h, toWorker } = linkedPractice();
    try {
      // Registering the snapshot handler (wireOnlineRoom) started the worker's clock.
      expect(toWorker.slice(0, 2)).toEqual(['init', 'run']);
      await pump();
      await pump();
      expect(session.id).toBe(PRACTICE_PLAYER_ID);
      expect(session.roster.filter((p) => p.bot)).toHaveLength(DEFAULT_SETTINGS.botCount);
      expect(session.match?.scoreLimit).toBe(DEFAULT_SETTINGS.scoreLimit);
      // You host a practice match: End match is offered and goes to the worker.
      expect(session.canEndMatch).toBe(true);
      // Play: ready, then inputs through the session (prediction == the worker's sim).
      room.send('ready', {});
      let seq = 0;
      for (let i = 0; i < 90; i++) {
        const input = { seq: seq++, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons: Button.Sprint };
        room.send('input', { inputs: [input] } satisfies InputMessage);
        await pump();
      }
      const me = h()!.sim.players.get(PRACTICE_PLAYER_ID)!;
      expect(me.ack).toBeGreaterThan(40);
      expect(session.endMatch()).toBe(true);
      await pump();
      await pump();
      expect(session.match?.phase).toBe('ended');
      expect(session.canEndMatch).toBe(false);
      // Pings carry nobody else's round trip (bots have none).
      expect(Object.keys(session.pings)).toEqual([]);
    } finally {
      await room.leave();
    }
    expect(toWorker.at(-1)).toBe('stop');
    expect(h()).toBeNull();
  });

  it('messages that arrive before the game listens wait, in order', async () => {
    const delivered: string[] = [];
    let h: PracticeHost | null = null;
    const port: PracticePort = {
      onmessage: null,
      postMessage: (raw) => {
        const data = raw as { type: string; init?: PracticeInit };
        if (data.type === 'init')
          h = new PracticeHost(data.init!, (type, msg) =>
            port.onmessage?.({ data: { type, msg } }),
          );
      },
      terminate: () => h?.dispose(),
    };
    const { room } = launchPractice(
      { ...DEFAULT_SETTINGS, map: 'range', mapSize: 'full' },
      () => port,
    );
    try {
      // welcome/roster/match/lobby were posted already; only now does anyone listen.
      for (const t of ['lobby', 'match', 'roster', 'welcome'])
        room.onMessage(t, () => delivered.push(t));
      expect(delivered).toEqual([]);
      await new Promise((r) => setTimeout(r, 0));
      expect(delivered).toEqual(['welcome', 'roster', 'match', 'lobby']);
    } finally {
      await room.leave();
    }
  });
});

it('practice uses the room pacing numbers', () => {
  expect(MATCH_NET.snapshotEvery * SIM_DT).toBeCloseTo(1 / 30, 9);
});
