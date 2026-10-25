import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import {
  Button,
  clonePlayerState,
  createPlayerState,
  grantSpawnProtection,
  getMap,
  initPhysics,
  MATCH,
  MATCH_NET,
  PhysicsWorld,
  reconcile,
  resolveMap,
  ROOMS,
  sanitizeInput,
  SIM_DT,
  stepPlayer,
  type MatchPing,
  type MatchStateMessage,
  type PlayerInput,
  type PredictedStep,
  type RosterMessage,
  type SnapshotMessage,
  type SnapshotPlayer,
  type WelcomeMessage,
} from '@wd/shared';
import { createGameServer } from '../app.ts';
import { DEFAULT_MATCH_LIMITS, matchGuard } from './matchGuard.ts';

// Online match room (M3a movement, M3b combat messages) over the real transport, like app.test.ts.
const PORT = 26670 + Math.floor(Math.random() * 1000);
// Quick-join matches here run without bots (the server's setting; clients can't choose it).
const server = createGameServer(undefined, { quickJoin: { botCount: 0 } });
const url = `http://localhost:${PORT}`;

// Every test client connects from the same address: lift the per-address matchmaking rate
// (the rate-limit test lowers it on purpose).
const RELAXED = { ...DEFAULT_MATCH_LIMITS, requestBurst: 1000, requestsPerSec: 1000 };

beforeAll(async () => {
  matchGuard.reset(RELAXED);
  await server.listen(PORT);
});
afterAll(async () => {
  await server.gracefullyShutdown(false);
});

/** Resolve with the first message of `type` that satisfies `pred` (rejects after `ms`). */
function waitFor<T>(room: Room, type: string, pred: (m: T) => boolean, ms = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for '${type}'`));
    }, ms);
    const off = room.onMessage(type, (m: T) => {
      if (!pred(m)) return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const find = (snap: SnapshotMessage, id: string): SnapshotPlayer | undefined =>
  snap.players.find((p) => p.id === id);
const input = (seq: number, moveZ = 1) => ({ seq, moveX: 0, moveZ, yaw: 0, pitch: 0, buttons: 0 });

interface Joined {
  room: Room;
  welcome: WelcomeMessage;
  /** The score and clock the room sends every joiner (right after the welcome). */
  match: Promise<MatchStateMessage>;
}

/** Join a match and collect the welcome (the SDK queues messages until a listener exists). */
async function join(options: Record<string, unknown>, roomId?: string): Promise<Joined> {
  const client = new Client(url);
  const room = roomId
    ? await client.joinById(roomId, options)
    : await client.joinOrCreate(ROOMS.match, options);
  // Listen before awaiting: Node's socket delivers both frames in one go, and the SDK drops a
  // message nobody listens for.
  const match = waitFor<MatchStateMessage>(room, 'match', () => true);
  match.catch(() => {});
  const welcome = await waitFor<WelcomeMessage>(room, 'welcome', () => true);
  return { room, welcome, match };
}

const RANGE = { lobby: false, map: 'range', size: 'full', mode: 'standard' };
const MARKET = { lobby: false, map: 'defilad', size: 'market', mode: 'standard' };

describe('match room', () => {
  it('two players join the default map (Plac Defilad, Market) at spawns apart', async () => {
    const a = await join({ ...MARKET, name: 'Ada' });
    const both = waitFor<RosterMessage>(a.room, 'roster', (r) => r.players.length === 2);
    const b = await join({ name: 'Bo' }, a.room.roomId);
    expect(a.welcome).toMatchObject({ map: 'defilad', size: 'market', mode: 'standard' });
    expect(a.welcome.id).toBe(a.room.sessionId);
    expect(b.welcome.id).toBe(b.room.sessionId);
    const apart = Math.hypot(
      a.welcome.spawn.x - b.welcome.spawn.x,
      a.welcome.spawn.z - b.welcome.spawn.z,
    );
    expect(apart).toBeGreaterThan(5);

    const roster = await both;
    expect(roster.players.map((p) => p.name).sort()).toEqual(['Ada', 'Bo']);
    const snap = await waitFor<SnapshotMessage>(b.room, 'snap', (s) => s.players.length === 2);
    expect(find(snap, a.welcome.id)!.ack).toBe(-1);

    // Leaving frees the seat: the other player's roster shrinks to one.
    const after = waitFor<RosterMessage>(b.room, 'roster', (r) => r.players.length === 1);
    await a.room.leave();
    expect((await after).players[0]!.id).toBe(b.welcome.id);
    await b.room.leave();
  }, 30000);

  it('inputs move a player on the server; the other client sees it, acknowledged', async () => {
    const a = await join({ ...RANGE, name: 'Runner' });
    const b = await join({ ...RANGE, name: 'Watcher' }, a.room.roomId);
    const start = a.welcome.spawn;

    // 48 inputs of running forward, 8 per message at about the 60 Hz rate the client sends.
    let seq = 0;
    for (let batch = 0; batch < 6; batch++) {
      a.room.send('input', { inputs: Array.from({ length: 8 }, () => input(seq++)) });
      await sleep(140);
    }
    const snap = await waitFor<SnapshotMessage>(
      b.room,
      'snap',
      (s) => find(s, a.welcome.id)?.ack === seq - 1,
    );
    const runner = find(snap, a.welcome.id)!;
    expect(Math.hypot(runner.x - start.x, runner.z - start.z)).toBeGreaterThan(2);
    // The watcher sent nothing: unmoved, nothing acknowledged.
    const watcher = find(snap, b.welcome.id)!;
    const drift = Math.hypot(watcher.x - b.welcome.spawn.x, watcher.z - b.welcome.spawn.z);
    expect(drift).toBeLessThan(0.01);
    expect(watcher.ack).toBe(-1);
    await a.room.leave();
    await b.room.leave();
  }, 30000);

  it('rejects invalid payloads (sender kicked, never moved) and keeps serving the rest', async () => {
    const opts = { ...RANGE, mode: 'knife' };
    const honest = await join(opts);
    const cheater = await join(opts, honest.room.roomId);
    const kicked = new Promise<number>((resolve) => cheater.room.onLeave((code) => resolve(code)));
    const alone = waitFor<RosterMessage>(honest.room, 'roster', (r) => r.players.length === 1);

    // A position instead of inputs fails the schema and never reaches the sim.
    cheater.room.send('input', { x: 999, y: 0, z: 999 });
    expect(await kicked).not.toBe(4000); // not a consented leave: the server closed it
    const roster = await alone;
    expect(roster.players[0]!.id).toBe(honest.welcome.id);
    const snap = await waitFor<SnapshotMessage>(honest.room, 'snap', () => true);
    expect(snap.players.map((p) => p.id)).toEqual([honest.welcome.id]);

    // Every malformed shape is refused the same way.
    for (const bad of [
      { inputs: [] },
      { inputs: 'run' },
      { inputs: [{ ...input(0), seq: 'x' }] },
      { inputs: [{ ...input(0), moveZ: null }] },
      { inputs: Array.from({ length: MATCH_NET.maxInputBatch + 1 }, (_, i) => input(i)) },
    ]) {
      const c = await join(opts, honest.room.roomId);
      const left = new Promise<void>((resolve) => c.room.onLeave(() => resolve()));
      c.room.send('input', bad);
      await left;
    }

    // Extra keys are stripped: a valid (standing) input carrying a position moves nobody.
    const sneaky = await join(opts, honest.room.roomId);
    sneaky.room.send('input', { inputs: [{ ...input(0, 0), x: 500, y: 50, z: 500 }] });
    const s2 = await waitFor<SnapshotMessage>(
      honest.room,
      'snap',
      (s) => find(s, sneaky.welcome.id)?.ack === 0,
    );
    const p = find(s2, sneaky.welcome.id)!;
    expect(Math.hypot(p.x - sneaky.welcome.spawn.x, p.z - sneaky.welcome.spawn.z)).toBeLessThan(
      0.01,
    );
    await sneaky.room.leave();
    await honest.room.leave();
  }, 30000);

  it('an invalid input sent as a request is kicked too, without logging the payload', async () => {
    const opts = { ...RANGE, mode: 'knife', name: 'Requester' };
    const host = await join(opts);
    const sneak = await join(opts, host.room.roomId);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const left = new Promise<number>((resolve) => sneak.room.onLeave((code) => resolve(code)));
      const gone = waitFor<RosterMessage>(host.room, 'roster', (r) => r.players.length === 1);
      void sneak.room.request('input', { x: 999, z: 999 }).catch(() => {});
      expect(await left).not.toBe(4000);
      await gone;
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    await host.room.leave();
  }, 30000);

  it('a consented leave right before the page unloads frees the seat at once (no ghost)', async () => {
    const host = await join(RANGE);
    const guest = await join({ ...RANGE, name: 'Reloader' }, host.room.roomId);
    const rosters: RosterMessage[] = [];
    host.room.onMessage('roster', (r: RosterMessage) => rosters.push(r));
    const gone = waitFor<RosterMessage>(host.room, 'roster', (r) => r.players.length === 1);
    // What the page does on `pagehide` / before a settings reload: leave, and the socket closes
    // right after (the tab is going away) without waiting for the server's answer.
    void guest.room.leave(true);
    guest.room.connection.close(1000, 'unload');
    expect((await gone).players[0]!.id).toBe(host.welcome.id);
    // Never shown as a dropped player keeping a seat (that is what a bare close does).
    expect(
      rosters.some((r) => r.players.some((p) => p.id === guest.welcome.id && !p.connected)),
    ).toBe(false);
    await host.room.leave();
  }, 30000);

  it('refuses matchmaking floods: per-address rate, then a cap on live matches', async () => {
    try {
      // Over the per-address rate: refused before any room is built.
      matchGuard.reset({ ...RELAXED, requestBurst: 2, requestsPerSec: 0.001 });
      const client = new Client(url);
      const a = await client.create(ROOMS.match, RANGE);
      const b = await client.joinById(a.roomId, RANGE);
      await expect(client.create(ROOMS.match, RANGE)).rejects.toThrow(/too many requests/);
      await b.leave();
      await a.leave();

      // At the room cap a create fails; the rooms already running are unaffected.
      matchGuard.reset({ ...RELAXED, maxRooms: matchGuard.rooms + 1 });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const first = await client.create(ROOMS.match, RANGE);
        await expect(client.create(ROOMS.match, { ...RANGE, mode: 'knife' })).rejects.toThrow(
          /too many matches/,
        );
        // Invalid options are refused up front as well (and nothing is logged for either).
        await expect(client.create(ROOMS.match, { map: 'mars' })).rejects.toThrow(/invalid/);
        expect(errors).not.toHaveBeenCalled();
        const w = await waitFor<WelcomeMessage>(first, 'welcome', () => true).catch(() => null);
        expect(w === null || w.map === 'range').toBe(true);
        await first.leave();
      } finally {
        errors.mockRestore();
      }
      // The slot is released when the room goes away: a new match can be created again.
      for (let i = 0; i < 50 && matchGuard.rooms >= matchGuard.limits.maxRooms; i++) {
        await sleep(100);
      }
      const again = await client.create(ROOMS.match, RANGE);
      await again.leave();
    } finally {
      matchGuard.reset(RELAXED);
    }
  }, 30000);

  it('rate-limits input floods: excess inputs are dropped, not queued', async () => {
    const a = await join(RANGE);
    // 6 full batches at once = 96 inputs in an instant (a speed hack): only the burst passes.
    let seq = 0;
    for (let i = 0; i < 6; i++) {
      a.room.send('input', {
        inputs: Array.from({ length: MATCH_NET.maxInputBatch }, () => input(seq++)),
      });
    }
    await sleep(600);
    const snap = await waitFor<SnapshotMessage>(a.room, 'snap', () => true);
    const ack = find(snap, a.welcome.id)!.ack;
    expect(ack).toBeGreaterThanOrEqual(MATCH_NET.inputBurst - 1);
    // The burst plus at most what refilled while the messages were in flight (well under 96).
    expect(ack).toBeLessThan(MATCH_NET.inputBurst + 15);
    // The sender wasn't kicked: a normal-rate input afterwards is accepted.
    a.room.send('input', { inputs: [input(seq)] });
    const later = await waitFor<SnapshotMessage>(
      a.room,
      'snap',
      (s) => find(s, a.welcome.id)?.ack === seq,
    );
    expect(find(later, a.welcome.id)!.ack).toBe(seq);
    await a.room.leave();
  }, 30000);

  it('a dropped player keeps the seat and reconnects into it', async () => {
    const host = await join(RANGE);
    const guest = await join({ ...RANGE, name: 'Flaky' }, host.room.roomId);
    guest.room.reconnection.minUptime = 0;
    guest.room.reconnection.delay = 50;

    const dropped = waitFor<RosterMessage>(host.room, 'roster', (r) =>
      r.players.some((p) => p.id === guest.welcome.id && !p.connected),
    );
    const reconnected = new Promise<void>((resolve) => guest.room.onReconnect(() => resolve()));
    // Simulate a network drop; the SDK reconnects on its own into the same session.
    guest.room.connection.close(4010, 'network');
    expect((await dropped).players).toHaveLength(2);
    const back = waitFor<RosterMessage>(host.room, 'roster', (r) =>
      r.players.some((p) => p.id === guest.welcome.id && p.connected),
    );
    const after = await back;
    await reconnected; // the client side of the socket is open again too
    expect(after.players.find((p) => p.id === guest.welcome.id)!.slot).toBe(1);
    expect(guest.room.sessionId).toBe(guest.welcome.id);
    await guest.room.leave();
    await host.room.leave();
  }, 30000);

  it('a client predicting with the shared sim stays in lockstep with the server', async () => {
    await initPhysics();
    // The client's own copy of the world, built before joining, exactly as the game does.
    const physics = new PhysicsWorld(resolveMap(getMap('range'), 'full'));
    const me = await join(RANGE);
    try {
      const w = me.welcome;
      const body = physics.createCharacter(w.spawn);
      let state = createPlayerState(w.spawn, w.seed, w.mode);
      state.view = { yaw: w.spawn.yaw, pitch: 0 };
      grantSpawnProtection(state); // every life starts protected (the game grants it at welcome)
      let pending: PredictedStep[] = [];
      let corrections = 0;
      let lastAck = -1;
      const snaps: SnapshotMessage[] = [];
      me.room.onMessage('snap', (m: SnapshotMessage) => snaps.push(m));

      // 1.5 s of running, strafing, turning and a jump at a ~15 Hz client frame rate (worst case
      // for batching). Like the game, the client steps as many 60 Hz steps as real time has
      // passed (a fixed count per frame would run slower than the server's clock and get idled),
      // and reconciles on every snapshot.
      const total = 90;
      const t0 = performance.now();
      let seq = 0;
      while (seq < total) {
        for (const snap of snaps.splice(0)) {
          const mine = snap.players.find((p) => p.id === w.id);
          if (!mine || mine.ack < 0) continue;
          const r = reconcile(state, pending, mine, body, SIM_DT);
          if (r.corrected) corrections++;
          state = r.state;
          pending = r.pending;
          lastAck = mine.ack;
        }
        const due = Math.min(total, Math.floor((performance.now() - t0) / (SIM_DT * 1000)) + 1);
        const batch: PlayerInput[] = [];
        for (; seq < due && batch.length < MATCH_NET.maxInputBatch; seq++) {
          const input = sanitizeInput({
            seq,
            moveX: Math.sin(seq / 15),
            moveZ: 1,
            yaw: seq * 0.02,
            pitch: 0,
            buttons: seq === 40 ? Button.Jump : 0,
          });
          stepPlayer(state, input, SIM_DT, body);
          pending.push({ input, after: clonePlayerState(state) });
          batch.push(input);
        }
        if (batch.length) me.room.send('input', { inputs: batch });
        await sleep(66);
      }
      // The first snapshot that acknowledges the last input (later ones may include idle steps,
      // which start once inputs stop).
      let server: SnapshotPlayer | undefined;
      for (let i = 0; i < 100 && !server; i++) {
        server = snaps.map((s) => find(s, w.id)).find((p) => p?.ack === seq - 1);
        if (!server) await sleep(20);
      }
      if (!server) throw new Error('last input never acknowledged');
      expect(lastAck).toBeGreaterThan(40);
      expect(corrections).toBe(0);
      expect(server.x).toBeCloseTo(state.move.pos.x, 6);
      expect(server.y).toBeCloseTo(state.move.pos.y, 6);
      expect(server.z).toBeCloseTo(state.move.pos.z, 6);
    } finally {
      physics.free();
      await me.room.leave();
    }
  }, 30000);
});

describe('match room: M3b messages over the transport', () => {
  it('score and clock at join, own weapon state only in your own entry, ping echo, renames', async () => {
    const opts = { ...RANGE, name: 'Ada' };
    const a = await join(opts);
    const firstMatch = await a.match;
    expect(firstMatch).toMatchObject({ phase: 'playing', scoreLimit: MATCH.scoreLimit });
    expect(firstMatch.winners).toEqual([]);
    const two = waitFor<MatchStateMessage>(a.room, 'match', (m) => m.scores.length === 2);
    const b = await join({ ...opts, name: 'Bo' }, a.room.roomId);
    expect((await two).scores.every((s) => s.kills === 0 && s.deaths === 0)).toBe(true);

    // Each client's snapshot carries its own weapon/kit state, never anyone else's.
    const snap = await waitFor<SnapshotMessage>(b.room, 'snap', (s) => s.players.length === 2);
    expect(find(snap, b.welcome.id)!.own).toBeDefined();
    expect(find(snap, a.welcome.id)!.own).toBeUndefined();

    // Pings are echoed; the next ones carry the measured round trip.
    a.room.onMessage('ping', (m: MatchPing) => a.room.send('pong', { t: m.t }));
    const measured = await waitFor<MatchPing>(a.room, 'ping', (m) => m.rtt >= 0, 5000);
    expect(measured.rtt).toBeLessThan(1000);

    // A name edited after joining reaches everyone, sanitized.
    const renamed = waitFor<RosterMessage>(b.room, 'roster', (r) =>
      r.players.some((p) => p.id === a.welcome.id && p.name === 'Ada Lovelace'),
    );
    a.room.send('name', { name: '  Ada\u0007 Lovelace  ' });
    await renamed;

    // A malformed name message kicks the sender (like any invalid payload).
    const kicked = new Promise<number>((resolve) => a.room.onLeave((code) => resolve(code)));
    a.room.send('name', { name: 42 });
    expect(await kicked).not.toBe(4000);
    await b.room.leave();
  }, 30000);
});

describe('match room: the round trip is the server’s own measurement', () => {
  it('forged and replayed pongs measure nothing; the echo of a real ping does, once', async () => {
    const a = await join({ ...RANGE, mode: 'knife', name: 'Forger' });
    const pings: MatchPing[] = [];
    let honest = false;
    let kicked = false;
    a.room.onLeave(() => (kicked = true));
    a.room.onMessage('ping', (m: MatchPing) => {
      pings.push(m);
      if (honest) {
        a.room.send('pong', { t: m.t });
        a.room.send('pong', { t: m.t }); // replayed at once: counts once
        return;
      }
      // Stamps the server never sent: a made-up "300 ms ago", and a near miss of the real one.
      a.room.send('pong', { t: performance.now() - 300 });
      a.room.send('pong', { t: m.t - 0.001 });
    });
    // Three pings answered only with forgeries: nothing was measured.
    await waitFor<MatchPing>(a.room, 'ping', () => pings.length >= 3, 8000);
    expect(pings.every((p) => p.rtt === -1)).toBe(true);
    // Honest echoes from now on: the next ping carries a measured (local, small) round trip.
    honest = true;
    const measured = await waitFor<MatchPing>(a.room, 'ping', (m) => m.rtt >= 0, 8000);
    expect(measured.rtt).toBeLessThan(250);
    // Well-formed forgeries are ignored, not punished: the seat is still there.
    expect(kicked).toBe(false);
    await a.room.leave();
  }, 30000);
});

describe('match room: matchmaking keys and private friend lobbies', () => {
  const LOBBY = { lobby: true, map: 'range', size: 'full', mode: 'knife' };

  it('friend lobbies are never matchmade into; the share link still joins', async () => {
    const client = new Client(url);
    const host = await client.create(ROOMS.match, { ...LOBBY, name: 'Host' });
    // Same keys through matchmaking: join finds nothing, joinOrCreate builds its own room.
    await expect(client.join(ROOMS.match, LOBBY)).rejects.toThrow(/no rooms found/);
    const other = await client.joinOrCreate(ROOMS.match, LOBBY);
    expect(other.roomId).not.toBe(host.roomId);
    await other.leave();
    // The link (joinById) needs no keys at all.
    const friend = await client.joinById(host.roomId, { name: 'Friend' });
    expect(friend.roomId).toBe(host.roomId);
    await friend.leave();
    await host.leave();
  }, 30000);

  it('refuses matchmaking without every room key (an empty filter matched any room)', async () => {
    const a = await join(RANGE);
    const client = new Client(url);
    const partials = [{}, { map: 'range' }, { map: 'range', size: 'full', mode: 'standard' }];
    for (const partial of partials) {
      await expect(client.join(ROOMS.match, partial)).rejects.toThrow(/required/);
      await expect(client.joinOrCreate(ROOMS.match, partial)).rejects.toThrow(/required/);
      await expect(client.create(ROOMS.match, partial)).rejects.toThrow(/required/);
    }
    // With every key, matchmaking lands in the matching room.
    const b = await client.join(ROOMS.match, RANGE);
    expect(b.roomId).toBe(a.room.roomId);
    await b.leave();
    await a.room.leave();
  }, 30000);

  it('a seat whose options differ from the room is refused', async () => {
    const a = await join({ ...RANGE, mode: 'knife' });
    const client = new Client(url);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(client.joinById(a.room.roomId, { ...RANGE, mode: 'standard' })).rejects.toThrow(
        /do not fit/,
      );
      await expect(
        client.joinById(a.room.roomId, { ...RANGE, mode: 'knife', lobby: true }),
      ).rejects.toThrow(/do not fit/);
    } finally {
      errors.mockRestore();
    }
    await a.room.leave();
  }, 30000);

  it('a quick-join creator cannot impose settings on the players matched in', async () => {
    const crafted = {
      ...RANGE,
      mode: 'knife',
      botCount: 5,
      botBehaviour: 'hunt-humans',
      botDifficulty: 'hard',
      scoreLimit: 1,
      timeLimit: 60,
      weather: 'rain',
      radar: 'off',
    };
    const a = await join(crafted);
    // This test server's quick-join settings (no bots); everything else is the default.
    expect(a.welcome.settings).toMatchObject({
      map: 'range',
      mode: 'knife',
      botCount: 0,
      botBehaviour: 'ffa',
      botDifficulty: 'normal',
      scoreLimit: 25,
      timeLimit: 600,
      weather: 'golden',
      radar: 'uplinks',
    });
    expect((await a.match).scoreLimit).toBe(25);
    await a.room.leave();
  }, 30000);
});
