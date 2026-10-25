import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  clonePlayerState,
  createPlayerState,
  DRONE,
  emptyInput,
  MATCH_NET,
  SIM_DT,
  smokeLifetime,
  stepPlayer,
  toSnapshotPlayer,
  TokenBucket,
  type CharacterBody,
  type CombatMessage,
  type DropMessage,
  type InputMessage,
  type LedgeQueries,
  type MatchPing,
  type MatchStateMessage,
  type MoveResult,
  type PlayerInput,
  type PlayerState,
  type RespawnMessage,
  type RosterMessage,
  type SnapshotMessage,
  type Vec3,
  type WelcomeMessage,
} from '@wd/shared';
import {
  nameSender,
  OnlineJoin,
  OnlineLink,
  onlineRequested,
  onlineToSave,
  pageOnline,
  resolveServerUrl,
  wireOnlineRoom,
  type LeavableRoom,
} from './connectOnline.ts';
import { deathBanner, killLine, matchLine, resultText } from './combatFeed.ts';
import {
  DEFAULT_FRIEND_SETTINGS,
  friendLobbyMode,
  friendRoomOptions,
  normalizeFriendSettings,
  roomCodeFromSearch,
  shareRoomUrl,
} from './friendLobby.ts';
import { onlineStatusText } from './onlineBadge.ts';
import { MAX_PENDING, OnlineSession } from './onlineSession.ts';

/** Infinite flat ground at y = 0 (no WASM needed). */
class Flat implements CharacterBody {
  feet: Vec3;
  constructor(feet: Vec3 = { x: 0, y: 0, z: 0 }) {
    this.feet = { ...feet };
  }
  move(d: Vec3): MoveResult {
    const y = Math.max(0, this.feet.y + d.y);
    const moved = { x: d.x, y: y - this.feet.y, z: d.z };
    this.feet = { x: this.feet.x + d.x, y, z: this.feet.z + d.z };
    return { moved, grounded: y <= 1e-6 && d.y <= 0 };
  }
  setCrouched(): boolean {
    return true;
  }
  setPosition(f: Vec3): void {
    this.feet = { ...f };
  }
}

class RayOnlyDroneBody extends Flat {
  readonly world: LedgeQueries = {
    castRay(origin: Vec3, dir: Vec3, maxDistance: number) {
      if (dir.z >= -1e-6) return null;
      const distance = (-1 - origin.z) / dir.z;
      if (distance < 0 || distance > maxDistance) return null;
      return {
        distance,
        point: {
          x: origin.x + dir.x * distance,
          y: origin.y + dir.y * distance,
          z: origin.z + dir.z * distance,
        },
        normal: { x: 0, y: 0, z: 1 },
      };
    },
    overlapsStatic: () => false,
    castGroundRay: () => null,
  };
}

const welcome: WelcomeMessage = {
  id: 'me',
  map: 'range',
  size: 'full',
  mode: 'standard',
  tick: 0,
  tickHz: 60,
  spawn: { x: 0, y: 0, z: 0, yaw: 0 },
  seed: 101,
  primary: 'ar7',
};

const run = (seq: number): PlayerInput => ({ ...emptyInput(seq), moveZ: 1, moveX: 0.3 });

function setup(): {
  session: OnlineSession;
  sent: InputMessage[];
  player: PlayerState;
  body: Flat;
  step: (n: number) => void;
} {
  const session = new OnlineSession();
  const sent: InputMessage[] = [];
  session.attach({ sendInputs: (m) => sent.push(m) });
  session.handleWelcome(welcome);
  const ctx = {
    session,
    sent,
    player: createPlayerState({ x: 0, y: 0, z: 0 }, welcome.seed),
    body: new Flat(),
    seq: 0,
    step(n: number) {
      for (let i = 0; i < n; i++) {
        const input = run(ctx.seq++);
        stepPlayer(ctx.player, input, SIM_DT, ctx.body);
        session.recordStep(input, ctx.player);
      }
    },
  };
  return ctx;
}

/** The server: same code, same inputs (optionally only the first `n`). */
function serverAfter(n: number): PlayerState {
  const p = createPlayerState({ x: 0, y: 0, z: 0 }, welcome.seed);
  const body = new Flat();
  for (let i = 0; i < n; i++) stepPlayer(p, run(i), SIM_DT, body);
  return p;
}

describe('OnlineSession bootstrap snapshots', () => {
  it('holds visible state without timing samples, then ignores late held timestamps after play', () => {
    const { session } = setup();
    const other = createPlayerState({ x: 5, y: 0, z: 0 });
    other.move.vel.x = 10;
    const held: SnapshotMessage = {
      t: 0,
      held: true,
      players: [toSnapshotPlayer('bo', other, -1, 0)],
    };
    session.handleSnapshot(held, 1000);
    const initial = session.remotePlayers(1000);
    expect(initial).toHaveLength(1);
    expect(initial[0]!.pose.x).toBe(5);
    session.handleSnapshot(held, 30_000);
    expect(session.remotePlayers(30_000)).toEqual(initial);
    expect(session.serverNow(30_000)).toBe(0);
    expect(session.clock.synced).toBe(false);
    expect(session.netStats(30_000)).toMatchObject({
      jitterMs: 0,
      delayMs: MATCH_NET.interpDelayMs,
      silenceMs: 0,
      stalls: 0,
    });

    const stepMs = 2000 / 60;
    for (let i = 1; i <= 15; i++) {
      const localMs = 30_000 + i * stepMs;
      session.handleSnapshot({ t: i * 2, players: held.players }, localMs);
      session.handleSnapshot(held, localMs + 5);
      expect(session.serverNow(localMs + 5)).toBeCloseTo(i * stepMs + 5, 6);
      expect(session.clock.synced).toBe(true);
      expect(session.netStats(localMs + 5).jitterMs).toBeLessThan(0.001);
      expect(session.netStats(localMs + 5).delayMs).toBe(MATCH_NET.interpDelayMs);
      expect(session.netStats(localMs + 5).stalls).toBe(0);
    }
  });
});

describe('OnlineSession smoke timeline', () => {
  const tick = 1000 / 60;
  const snapAt = (t: number, smoke: { id: number; age: number }[]): SnapshotMessage => ({
    t,
    players: [],
    tactical: {
      smoke: smoke.map((c) => ({ id: c.id, pos: { x: 0, y: 0, z: 0 }, age: c.age })),
      pickups: [],
      radar: { charges: 0, live: 0 },
    },
  });

  it('rewinds the server set (spent clouds included) to the view time, one list per time', () => {
    const { session } = setup();
    const life = smokeLifetime();
    session.handleSnapshot(
      snapAt(100, [
        { id: 1, age: life - 0.02 },
        { id: 2, age: 1 },
      ]),
      0,
    );
    // Two ticks on: cloud 1 ran out; the server still sends it (spent, within the window).
    session.handleSnapshot(
      snapAt(102, [
        { id: 2, age: 1 + 2 / 60 },
        { id: 1, age: life - 0.02 + 2 / 60 },
      ]),
      33,
    );
    const before = session.smokeAt(101 * tick);
    expect(before.map((c) => c.id).sort()).toEqual([1, 2]);
    expect(before.find((c) => c.id === 2)!.age).toBeCloseTo(1 + 1 / 60, 9);
    // The same view time is the same list (the shot and the frame share it), refilled in place.
    expect(session.smokeAt(101 * tick)).toBe(before);
    expect(session.smokeAt(102 * tick).map((c) => c.id)).toEqual([2]); // spent: not drawn
    expect(session.smokeAt(102 * tick)).toBe(before);
    // A late, older snapshot never rolls the smoke back; a new match's empty list clears it.
    session.handleSnapshot(snapAt(90, [{ id: 9, age: 1 }]), 40);
    expect(session.smokeAt(undefined).map((c) => c.id)).toEqual([2]);
    session.handleSnapshot(snapAt(104, []), 66);
    expect(session.smokeAt(103 * tick)).toEqual([]);
  });

  it('keeps spotted drone pings and jam state in the private tactical snapshot', () => {
    const { session } = setup();
    session.handleSnapshot(
      {
        t: 10,
        players: [],
        tactical: {
          smoke: [],
          pickups: [],
          radar: { charges: 0, live: 0 },
          jammed: 3.5,
          spotted: [{ id: 'bo', pos: { x: 4, y: 0, z: -2 }, t: 1.2 }],
        },
      },
      20,
    );
    expect(session.tactical?.jammed).toBe(3.5);
    expect(session.tactical?.spotted).toEqual([{ id: 'bo', pos: { x: 4, y: 0, z: -2 }, t: 1.2 }]);

    session.handleSnapshot(
      {
        t: 12,
        players: [],
        tactical: {
          smoke: [],
          pickups: [],
          radar: { charges: 0, live: 0 },
          jammed: 0,
          spotted: [],
        },
      },
      40,
    );
    expect(session.tactical?.spotted).toEqual([]);
    session.handleSnapshot(
      {
        t: 11,
        players: [],
        tactical: {
          smoke: [],
          pickups: [],
          radar: { charges: 0, live: 0 },
          jammed: 2,
          spotted: [{ id: 'bo', pos: { x: 9, y: 0, z: 9 }, t: 1.8 }],
        },
      },
      50,
    );
    expect(session.tactical?.jammed).toBe(0);
    expect(session.tactical?.spotted).toEqual([]);
  });

  it('keeps advancing with snapshots while no step runs (menu open), junk entries dropped', () => {
    const { session } = setup();
    // No recordStep at all: the smoke follows the network timeline alone.
    session.handleSnapshot(snapAt(100, [{ id: 5, age: 2 }]), 0);
    const a = session.smokeAt(session.viewTime(10))[0]!.age;
    session.handleSnapshot(snapAt(130, [{ id: 5, age: 2.5 }]), 500);
    session.handleSnapshot(snapAt(160, [{ id: 5, age: 3 }]), 1000);
    const b = session.smokeAt(session.viewTime(1010))[0]!.age;
    expect(b - a).toBeGreaterThan(0.8);
    const junk = snapAt(170, [{ id: 6, age: 1 }]);
    junk.tactical!.smoke.push({ id: 7, pos: { x: 0, y: 0, z: 0 }, age: Number.NaN });
    session.handleSnapshot(junk, 1100);
    expect(session.smokeAt(undefined).map((c) => c.id)).toEqual([6]);
  });
});

describe('OnlineSession inputs', () => {
  it('sends nothing before the welcome, then batches every step (inputs only)', () => {
    const session = new OnlineSession();
    const sent: InputMessage[] = [];
    session.attach({ sendInputs: (m) => sent.push(m) });
    session.recordStep(run(0), createPlayerState({ x: 0, y: 0, z: 0 }));
    session.flush();
    expect(sent).toEqual([]);

    const ctx = setup();
    ctx.step(3);
    ctx.session.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.inputs.map((i) => i.seq)).toEqual([0, 1, 2]);
    expect(Object.keys(ctx.sent[0]!.inputs[0]!).sort()).toEqual(
      ['buttons', 'moveX', 'moveZ', 'pitch', 'seq', 'yaw'].sort(),
    );
    ctx.session.flush(); // nothing new: no empty message
    expect(ctx.sent).toHaveLength(1);
    // A long hitch: split into schema-sized batches.
    ctx.step(MATCH_NET.maxInputBatch + 4);
    ctx.session.flush();
    expect(ctx.sent.slice(1).map((m) => m.inputs.length)).toEqual([MATCH_NET.maxInputBatch, 4]);
  });

  it('caps unacknowledged predictions', () => {
    const ctx = setup();
    ctx.step(MAX_PENDING + 30);
    expect(ctx.session.pendingCount).toBe(MAX_PENDING);
  });
});

describe('OnlineSession reconciliation', () => {
  it('keeps an exact prediction and drops acknowledged steps', () => {
    const ctx = setup();
    ctx.step(20);
    ctx.session.handleSnapshot(
      { t: 12, players: [toSnapshotPlayer('me', serverAfter(12), 11, 0)] },
      0,
    );
    const r = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(r.corrected).toBe(false);
    expect(ctx.session.pendingCount).toBe(9); // the acknowledged step (reference) + 8
    expect(ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)).toBeNull(); // consumed
  });

  it('corrects to the server and replays the unacknowledged inputs', () => {
    const ctx = setup();
    ctx.step(20);
    const server = serverAfter(12);
    server.move.pos.x += 2; // the server disagrees (e.g. it dropped an input)
    ctx.session.handleSnapshot({ t: 12, players: [toSnapshotPlayer('me', server, 11, 0)] }, 0);
    const r = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(r.corrected).toBe(true);
    expect(r.state.move.pos.x).toBeCloseTo(ctx.player.move.pos.x + 2, 6);
    expect(ctx.body.feet.x).toBeCloseTo(r.state.move.pos.x, 9);
    expect(ctx.session.corrections).toBe(1);
  });

  it('trusts the prediction until the first acknowledgement, and ignores stale snapshots', () => {
    const ctx = setup();
    ctx.step(5);
    const idle = createPlayerState({ x: 0, y: 0, z: 0 });
    ctx.session.handleSnapshot({ t: 3, players: [toSnapshotPlayer('me', idle, -1, 0)] }, 0);
    expect(ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)).toBeNull();
    ctx.session.handleSnapshot(
      { t: 6, players: [toSnapshotPlayer('me', serverAfter(5), 4, 0)] },
      0,
    );
    ctx.session.handleSnapshot({ t: 4, players: [toSnapshotPlayer('me', idle, 2, 0)] }, 0); // late
    expect(ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!.corrected).toBe(false);
  });

  it('a server respawn (life bump) rebuilds a fresh life at the new spot', () => {
    const ctx = setup();
    ctx.step(10);
    ctx.player.arsenal.grenades = 0;
    const fresh = createPlayerState({ x: 30, y: 0, z: 30 }, welcome.seed);
    ctx.session.handleSnapshot({ t: 10, players: [toSnapshotPlayer('me', fresh, 9, 1)] }, 0);
    const r = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(r.corrected).toBe(true);
    expect(r.state.move.pos).toEqual({ x: 30, y: 0, z: 30 });
    expect(r.state.arsenal.grenades).toBe(fresh.arsenal.grenades);
    // The next snapshot of the same life is a normal check again.
    const later = clonePlayerState(r.state);
    ctx.session.handleSnapshot({ t: 12, players: [toSnapshotPlayer('me', later, 9, 1)] }, 0);
    expect(ctx.session.reconcile(r.state, ctx.body, SIM_DT)!.corrected).toBe(false);
  });
  it('replays drone flight through ray-only surfaces when the movement ray misses', () => {
    const session = new OnlineSession();
    session.attach({ sendInputs: () => undefined });
    session.handleWelcome(welcome);
    const player = createPlayerState({ x: 0, y: 0, z: 0 }, welcome.seed);
    const body = new RayOnlyDroneBody();
    const droneWorld = { castRay: body.world.castGroundRay!.bind(body.world) };
    player.droneCharges = 1;

    const apply = (input: PlayerInput): void => {
      stepPlayer(player, input, SIM_DT, body, { droneWorld });
      session.recordStep(input, player);
    };
    apply({ ...emptyInput(0), buttons: Button.Drone, yaw: 0, pitch: 0 });
    const server = clonePlayerState(player);
    server.move.pos.x += 0.02; // force replay of the unacknowledged drone flight
    for (let i = 1; i <= 36; i++) apply({ ...emptyInput(i), moveZ: 1, yaw: 0, pitch: 0 });

    session.handleSnapshot({ t: 1, players: [toSnapshotPlayer('me', server, 0, 0)] }, 0);
    const r = session.reconcile(player, body, SIM_DT)!;

    expect(r.corrected).toBe(true);
    expect(r.state.drone?.alive).toBe(true);
    expect(r.state.drone!.pos.z).toBeLessThan(-1.5);
  });
});

describe('OnlineSession respawn and drops', () => {
  it('a respawn message rebuilds the new life from its first input, then agrees with the server', () => {
    const ctx = setup();
    ctx.step(20); // inputs 0..19 predicted in the old life
    // The server: respawned at (40, 0, 40) right after input 9, then applied 10 and 11.
    const fresh = () => {
      const p = createPlayerState({ x: 40, y: 0, z: 40 }, welcome.seed);
      p.view = { yaw: 0.5, pitch: 0 };
      return p;
    };
    const server = fresh();
    const sbody = new Flat(server.move.pos);
    for (let i = 10; i <= 11; i++) stepPlayer(server, run(i), SIM_DT, sbody);
    ctx.session.handleRespawn({ life: 1, seq: 9, x: 40, y: 0, z: 40, yaw: 0.5, primary: 'ar7' });
    ctx.session.handleSnapshot({ t: 20, players: [toSnapshotPlayer('me', server, 11, 1)] }, 0);
    const r = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(r.corrected).toBe(true);
    // Truth: the fresh life with inputs 10..19.
    const truth = fresh();
    const tbody = new Flat(truth.move.pos);
    for (let i = 10; i < 20; i++) stepPlayer(truth, run(i), SIM_DT, tbody);
    expect(r.state.move.pos.x).toBeCloseTo(truth.move.pos.x, 9);
    expect(r.state.move.pos.z).toBeCloseTo(truth.move.pos.z, 9);
    // One correction (the respawn): the snapshot at ack 11 already agreed with the replay.
    expect(ctx.session.corrections).toBe(1);
    // A stale old-life snapshot arriving late is ignored.
    ctx.session.handleSnapshot(
      { t: 22, players: [toSnapshotPlayer('me', serverAfter(12), 12, 0)] },
      0,
    );
    expect(ctx.session.reconcile(r.state, ctx.body, SIM_DT)).toBeNull();
  });

  it('while the connection is down, steps are not recorded (the server never gets them)', () => {
    const ctx = setup();
    ctx.step(2);
    ctx.session.flush();
    ctx.step(1); // recorded, but the socket drops before the frame's flush
    ctx.session.handleStatus({ state: 'reconnecting' });
    ctx.step(5);
    expect(ctx.session.pendingCount).toBe(3);
    ctx.session.flush();
    // Nothing queued during the drop is sent later (the SDK would deliver it after reconnecting).
    expect(ctx.sent.flatMap((m) => m.inputs.map((i) => i.seq))).toEqual([0, 1]);
    ctx.session.handleStatus({ state: 'online' });
    // Back in the seat: predictions from before the drop may never have reached the server.
    expect(ctx.session.pendingCount).toBe(0);
    ctx.step(1);
    expect(ctx.session.pendingCount).toBe(1);
  });

  it('after a reconnect, the next snapshot resets to the server and replays only newer inputs', () => {
    const ctx = setup();
    ctx.step(4); // seq 0–3: the server only ever got 0–1 (2–3 were lost with the socket)
    ctx.session.handleStatus({ state: 'reconnecting' });
    ctx.session.handleStatus({ state: 'online' });
    // The game's frame: reconcile (nothing new yet) before stepping.
    expect(ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)).toBeNull();
    ctx.step(2); // seq 4–5, sent after reconnecting
    const server = serverAfter(2);
    ctx.session.handleSnapshot({ t: 40, players: [toSnapshotPlayer('me', server, 1, 0)] }, 0);
    const r = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(r.corrected).toBe(true);
    // Server state (after 0–1) plus the replayed 4–5: never the lost 2–3.
    expect(r.pending.map((s) => s.input.seq)).toEqual([1, 4, 5]);
    // Each of 4–5 applied exactly once on top of the server state (the server gets the same).
    const expected = serverAfter(2);
    const body = new Flat(expected.move.pos);
    stepPlayer(expected, run(4), SIM_DT, body);
    stepPlayer(expected, run(5), SIM_DT, body);
    expect(r.state.move.pos).toEqual(expected.move.pos);
    expect(r.state.move.vel).toEqual(expected.move.vel);
  });
});

describe('OnlineSession: reconnect before any acknowledgement (M3a review fix)', () => {
  it('takes damage and death even before the first input acknowledgement', () => {
    const ctx = setup();
    ctx.step(4);
    const server = createPlayerState({ x: 0, y: 0, z: 0 }, welcome.seed);
    server.health = 75;
    ctx.session.handleSnapshot(
      { t: 3, players: [toSnapshotPlayer('me', server, -1, 0, { own: true })] },
      0,
    );
    const hurt = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(hurt.state.health).toBe(75);
    server.health = 0;
    ctx.session.handleSnapshot(
      { t: 4, players: [toSnapshotPlayer('me', server, -1, 0, { own: true })] },
      0,
    );
    const dead = ctx.session.reconcile(hurt.state, ctx.body, SIM_DT)!;
    expect(dead.state.health).toBe(0);
    expect(dead.state.move.pos).toEqual(server.move.pos);
    ctx.session.handleSnapshot(
      { t: 5, players: [toSnapshotPlayer('me', server, -1, 0, { own: true })] },
      0,
    );
    expect(ctx.session.reconcile(dead.state, ctx.body, SIM_DT)).toBeNull();
  });

  it('a lost trigger before reconnect cannot swallow the first new trigger press', () => {
    const ctx = setup();
    const fire = { ...emptyInput(0), buttons: Button.Fire };
    stepPlayer(ctx.player, fire, SIM_DT, ctx.body);
    ctx.session.recordStep(fire, ctx.player);
    ctx.session.handleStatus({ state: 'reconnecting' });
    ctx.session.handleStatus({ state: 'online' });
    ctx.session.reconcile(ctx.player, ctx.body, SIM_DT);
    const jump = { ...emptyInput(1), buttons: Button.Fire | Button.Jump };
    stepPlayer(ctx.player, jump, SIM_DT, ctx.body);
    ctx.session.recordStep(jump, ctx.player);
    const server = createPlayerState({ x: 0, y: 0, z: 0 }, welcome.seed);
    ctx.session.handleSnapshot(
      { t: 30, players: [toSnapshotPlayer('me', server, -1, 0, { own: true })] },
      0,
    );
    const r = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    stepPlayer(server, jump, SIM_DT, new Flat());
    expect(r.state).toEqual(server);
  });

  it('drops the stale prediction and replays only the inputs sent after reconnecting', () => {
    const ctx = setup();
    ctx.step(6); // seq 0–5: none ever reached the server (the socket dropped at once)
    ctx.session.handleStatus({ state: 'reconnecting' });
    ctx.session.handleStatus({ state: 'online' });
    expect(ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)).toBeNull();
    ctx.step(3); // seq 6–8, sent after reconnecting
    // The server never applied an input: its state is the spawn (ack -1).
    const server = createPlayerState({ x: 0, y: 0, z: 0 }, welcome.seed);
    ctx.session.handleSnapshot({ t: 30, players: [toSnapshotPlayer('me', server, -1, 0)] }, 0);
    const r = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(r).not.toBeNull();
    expect(r.corrected).toBe(true);
    expect(r.pending.map((s) => s.input.seq)).toEqual([6, 7, 8]);
    // The spawn plus 6–8 exactly once: what the server will compute once they arrive.
    const expected = createPlayerState({ x: 0, y: 0, z: 0 }, welcome.seed);
    const body = new Flat();
    for (let i = 6; i <= 8; i++) stepPlayer(expected, run(i), SIM_DT, body);
    expect(r.state.move.pos).toEqual(expected.move.pos);
    // The next ack-less snapshot trusts the rebuilt prediction again (no correction loop).
    ctx.session.handleSnapshot({ t: 32, players: [toSnapshotPlayer('me', server, -1, 0)] }, 0);
    expect(ctx.session.reconcile(r.state, ctx.body, SIM_DT)).toBeNull();
  });

  it('without a drop, an ack-less snapshot still trusts the prediction (both started at spawn)', () => {
    const ctx = setup();
    ctx.step(4);
    const idle = createPlayerState({ x: 0, y: 0, z: 0 });
    ctx.session.handleSnapshot({ t: 3, players: [toSnapshotPlayer('me', idle, -1, 0)] }, 0);
    expect(ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)).toBeNull();
  });
});

describe('OnlineSession combat plumbing (M3b)', () => {
  it('sends each input with the view time it was taken at', () => {
    const ctx = setup();
    const input = run(0);
    stepPlayer(ctx.player, input, SIM_DT, ctx.body);
    ctx.session.recordStep(input, ctx.player, 1234.5);
    ctx.session.recordStep(run(1), ctx.player);
    ctx.session.flush();
    expect(ctx.sent[0]!.inputs.map((i) => i.vt)).toEqual([1234.5, undefined]);
    expect('vt' in ctx.sent[0]!.inputs[1]!).toBe(false);
  });

  it('view time = the server clock minus the interpolation delay (what the others are drawn at)', () => {
    const ctx = setup();
    expect(ctx.session.viewTime(0)).toBeUndefined(); // no clock yet
    ctx.session.handleSnapshot({ t: 60, players: [] }, 500);
    expect(ctx.session.viewTime(500)).toBeCloseTo(1000 - MATCH_NET.interpDelayMs, 6);
  });

  it('queues combat events in order until the game takes them; keeps the newest if flooded', () => {
    const ctx = setup();
    const boom = (id: number) => ({
      type: 'boom' as const,
      id,
      by: 'bo',
      pos: { x: 0, y: 0, z: 0 },
    });
    ctx.session.handleCombat({ events: [boom(1), boom(2)] });
    ctx.session.handleCombat({ events: [boom(3)] });
    expect(ctx.session.takeCombat().map((e) => (e.type === 'boom' ? e.id : 0))).toEqual([1, 2, 3]);
    expect(ctx.session.takeCombat()).toEqual([]);
    ctx.session.handleCombat({ events: Array.from({ length: 600 }, (_, i) => boom(i)) });
    const kept = ctx.session.takeCombat();
    expect(kept).toHaveLength(512);
    expect(kept.at(-1)).toMatchObject({ id: 599 });
  });

  it('match clock and round trip from the server; the status line shows the ping', () => {
    const ctx = setup();
    ctx.session.handleSnapshot({ t: 600, players: [] }, 0); // server now = 10 s
    ctx.session.handleMatch({
      phase: 'playing',
      endsAt: 600 + 90 * 60,
      scoreLimit: 25,
      scores: [],
      winners: [],
    });
    expect(ctx.session.phaseSecondsLeft(0)).toBeCloseTo(90, 6);
    ctx.session.handlePing({ t: 1, rtt: 48 });
    expect(onlineStatusText(ctx.session)).toBe('online · 48 ms · waiting for friends to join');
  });

  it('before Play the badge says how to join', () => {
    expect(onlineStatusText(new OnlineSession())).toBe('online: press Play to join the match');
  });
});

describe('OnlineJoin (join at Play, names follow; M3a review fix)', () => {
  it('resuming Play submits the completed name once, without sending every keystroke', () => {
    const sent: string[] = [];
    const j = new OnlineJoin(() => {});
    j.start('Ada');
    j.attach((name) => sent.push(name));
    j.start('Kiran'); // Play after editing in the menu
    j.serverName('Kiran');
    j.start('Kiran'); // unchanged resume
    expect(sent).toEqual(['Kiran']);
  });
  it('joins once, at the first Play, with the name typed by then (cleaned)', () => {
    const joins: string[] = [];
    const j = new OnlineJoin((name) => joins.push(name));
    j.nameChanged('Ada'); // still in the menu: nothing sent, the join will carry it
    expect(joins).toEqual([]);
    expect(j.joined).toBe(false);
    j.start('  Ada\u0007 Lovelace-the-first-programmer ');
    j.start('Ada');
    expect(joins).toEqual(['Ada Lovelace-the']);
    expect(joins[0]!.length).toBe(MATCH_NET.maxNameLength);
  });

  it('later edits go to the room once per change; in-flight edits wait for the join', () => {
    const sent: string[] = [];
    const j = new OnlineJoin(() => {});
    j.start('Ada');
    j.nameChanged('Bo'); // joining still in flight
    expect(sent).toEqual([]);
    j.attach((n) => sent.push(n));
    expect(sent).toEqual(['Bo']);
    j.serverName('Bo');
    j.nameChanged('Bo'); // unchanged (e.g. another setting changed)
    j.nameChanged('   '); // empty keeps the name
    j.nameChanged('Cy‮');
    expect(sent).toEqual(['Bo', 'Cy']);
    j.serverName('Cy');
    expect(sent).toEqual(['Bo', 'Cy']);
  });

  it('keeps the latest rejected name queued and retries when the server bucket refills', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const bucket = new TokenBucket(MATCH_NET.nameRatePerSec, MATCH_NET.nameBurst, now);
      const sent: string[] = [];
      const accepted: string[] = [];
      const j = new OnlineJoin(() => {});
      j.start('Ada');
      j.attach((name) => {
        sent.push(name);
        if (!bucket.take(now)) return;
        accepted.push(name);
        j.serverName(name);
      });

      j.nameChanged('Bo');
      j.nameChanged('Cy');
      j.nameChanged('Dee');
      j.nameChanged('Eve'); // server silently drops this one: no roster echo
      j.nameChanged('Fay');
      expect(sent).toEqual(['Bo', 'Cy', 'Dee', 'Eve']);
      expect(accepted).toEqual(['Bo', 'Cy', 'Dee']);

      now += 1000 / MATCH_NET.nameRatePerSec;
      vi.advanceTimersByTime(1000 / MATCH_NET.nameRatePerSec);
      expect(sent).toEqual(['Bo', 'Cy', 'Dee', 'Eve', 'Fay']);
      expect(accepted).toEqual(['Bo', 'Cy', 'Dee', 'Fay']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces or clears a queued rename when the menu reverts during an in-flight send', () => {
    const sent: string[] = [];
    const j = new OnlineJoin(() => {});
    j.start('Ada');
    j.attach((name) => sent.push(name));
    j.nameChanged('Bo');
    j.nameChanged('Cy');
    j.nameChanged('Bo');
    expect(sent).toEqual(['Bo']);
    j.serverName('Bo');
    expect(sent).toEqual(['Bo']);
  });

  it('can return to the acknowledged name after an in-flight rename lands', () => {
    const sent: string[] = [];
    const j = new OnlineJoin(() => {});
    j.start('Ada');
    j.attach((name) => sent.push(name));
    j.nameChanged('Bo');
    j.nameChanged('Ada');
    expect(sent).toEqual(['Bo']);
    j.serverName('Bo');
    expect(sent).toEqual(['Bo', 'Ada']);
    j.serverName('Ada');
  });

  it('keeps a reverted desired name through a stale roster echo while another name is in flight', () => {
    const sent: string[] = [];
    const j = new OnlineJoin(() => {});
    j.start('Ada');
    j.attach((name) => sent.push(name));
    j.nameChanged('Bo');
    j.nameChanged('Ada');
    j.serverName('Ada'); // a stale roster echo for the old accepted name, not an ack for Bo
    expect(sent).toEqual(['Bo']);
    j.serverName('Bo');
    expect(sent).toEqual(['Bo', 'Ada']);
    j.serverName('Ada');
  });

  it('does not retry after a dropped rename when the menu reverted to the acknowledged name', () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const j = new OnlineJoin(() => {});
      j.start('Ada');
      j.attach((name) => sent.push(name));
      j.nameChanged('Bo'); // silently dropped: no roster echo
      j.nameChanged('Ada');
      vi.advanceTimersByTime(1000 / MATCH_NET.nameRatePerSec);
      expect(sent).toEqual(['Bo']);

      // If a delayed Bo echo arrives after the user reverted, the client restores Ada.
      j.serverName('Bo');
      expect(sent).toEqual(['Bo', 'Ada']);
      j.serverName('Ada');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the retry clear a dropped in-flight rename after reverting, so later edits can send', () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const j = new OnlineJoin(() => {});
      j.start('Ada');
      j.attach((name) => sent.push(name));
      j.nameChanged('Bo'); // silently dropped: no roster echo
      j.nameChanged('Ada');
      j.nameChanged('Cy');
      vi.advanceTimersByTime(1000 / MATCH_NET.nameRatePerSec);
      expect(sent).toEqual(['Bo', 'Cy']);
      j.serverName('Cy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts the server fallback roster name when joining with an empty name', () => {
    const sent: string[] = [];
    const j = new OnlineJoin((name) => sent.push(`join:${name}`));
    j.start('   ');
    j.attach((name) => sent.push(name));
    j.serverName('Player 1');
    expect(sent).toEqual(['join:']);
  });

  it('sends a name message the server schema accepts', () => {
    const calls: [string, unknown][] = [];
    nameSender({ send: (type: string, msg: unknown) => void calls.push([type, msg]) })('Ada');
    expect(calls).toEqual([['name', { name: 'Ada' }]]);
  });
});

describe('combat feed texts', () => {
  const names: Record<string, string> = { bo: 'Bo', cy: 'Cy' };
  const nameOf = (id: string) => names[id] ?? '?';
  const hit = (by: string, target: string, extra: object = {}) => ({
    type: 'hit' as const,
    by,
    target,
    weapon: 'rifle' as const,
    zone: 'torso' as const,
    dmg: 25,
    hp: 0,
    killed: true,
    at: { x: 0, y: 0, z: 0 },
    from: { x: 0, y: 0, z: 0 },
    ...extra,
  });

  it('kill feed and death banner', () => {
    expect(killLine(hit('me', 'bo', { zone: 'head' }), 'me', nameOf)).toBe(
      'You ✕ Bo (rifle, headshot)',
    );
    expect(killLine(hit('bo', 'me', { weapon: 'knife' }), 'me', nameOf)).toBe('Bo ✕ you (knife)');
    expect(killLine(hit('cy', 'cy', { weapon: 'frag' }), 'me', nameOf)).toBe(
      'Cy blew themselves up',
    );
    expect(deathBanner(hit('bo', 'me', { weapon: 'sidearm' }), nameOf)).toBe(
      'Killed by Bo (pistol) — respawning',
    );
  });

  it('score line and results (a shared win names everyone sharing it)', () => {
    const m = {
      phase: 'playing' as const,
      endsAt: 0,
      scoreLimit: 25,
      scores: [
        { id: 'me', kills: 4, deaths: 2 },
        { id: 'bo', kills: 7, deaths: 1 },
        { id: 'cy', kills: 3, deaths: 5 },
      ],
      winners: [],
    };
    expect(matchLine(m, 'me', nameOf, 125.2)).toBe(
      'You 4 K / 2 D · best other: Bo 7 · first to 25 · 2:06',
    );
    expect(resultText({ ...m, phase: 'ended', winners: ['me'] }, 'me', nameOf)).toBe(
      'Match over — you win!',
    );
    expect(resultText({ ...m, phase: 'ended', winners: ['me', 'bo'] }, 'me', nameOf)).toBe(
      'Match over — shared win: you, Bo',
    );
    expect(matchLine({ ...m, phase: 'ended', winners: ['bo'] }, 'me', nameOf, 4.2)).toBe(
      'Match over — Bo wins · next match in 5 s',
    );
  });
});

describe('OnlineSession remote players', () => {
  it('decodes live drone snapshots, excluding our own drone and interpolating on the draw timeline', () => {
    const ctx = setup();
    const s = ctx.session;
    const me = toSnapshotPlayer('me', createPlayerState({ x: 0, y: 0, z: 0 }), -1, 0);
    for (let i = 0; i <= 6; i++) {
      const t = i * 2;
      s.handleSnapshot(
        {
          t,
          players: [me],
          drones: [
            ['me', 99, 99, 99, 0, 255],
            ['bo', i, 3, 4, 0.2 * i, 128],
          ],
        },
        (t * 1000) / 60 + 10,
      );
    }
    const drones = s.remoteDrones((12 * 1000) / 60 + 10);
    expect(drones.map((d) => d.owner)).toEqual(['bo']);
    expect(drones[0]!.pos.x).toBeCloseTo(3, 1);
    expect(drones[0]!.battery).toBeCloseTo((128 / 255) * DRONE.battery, 6);

    for (let i = 7; i <= 12; i++) {
      const t = i * 2;
      s.handleSnapshot({ t, players: [me], drones: [] }, (t * 1000) / 60 + 10);
    }
    expect(s.remoteDrones((24 * 1000) / 60 + 10)).toEqual([]);

    // A stale snapshot arriving late must not resurrect the drone or reverse its track.
    s.handleSnapshot({ t: 8, players: [me], drones: [['bo', -50, 3, 4, 0, 200]] }, 500);
    expect(s.remoteDrones((24 * 1000) / 60 + 10)).toEqual([]);

    // Long absent streams stay bounded and keep the drone gone.
    for (let i = 13; i <= 90; i++) {
      const t = i * 2;
      s.handleSnapshot({ t, players: [me], drones: [] }, (t * 1000) / 60 + 10);
    }
    expect(s.remoteDrones((180 * 1000) / 60 + 10)).toEqual([]);

    // The absent track has been pruned; an older delayed packet still cannot create a new one.
    s.handleSnapshot({ t: 8, players: [me], drones: [['bo', -70, 3, 4, 0, 255]] }, 4000);
    expect(s.remoteDrones((180 * 1000) / 60 + 10)).toEqual([]);
  });

  it('draws others 100 ms in the past between two snapshots, with roster names', () => {
    const ctx = setup();
    const s = ctx.session;
    s.handleRoster({
      players: [
        { id: 'me', name: 'Me', slot: 0, connected: true },
        { id: 'bo', name: 'Bo', slot: 1, connected: true },
      ],
    });
    const other = (x: number) => toSnapshotPlayer('bo', createPlayerState({ x, y: 0, z: 0 }), 0, 0);
    const me = toSnapshotPlayer('me', createPlayerState({ x: 0, y: 0, z: 0 }), -1, 0);
    // Snapshots every 2 ticks (33.3 ms), each arriving 10 ms after it was taken.
    for (let i = 0; i <= 6; i++) {
      const t = i * 2;
      s.handleSnapshot({ t, players: [me, other(i)] }, (t * 1000) / 60 + 10);
    }
    const localNow = (12 * 1000) / 60 + 10; // just after the last arrival
    const remotes = s.remotePlayers(localNow);
    expect(remotes.map((r) => r.id)).toEqual(['bo']); // never ourselves
    expect(remotes[0]!.name).toBe('Bo');
    expect(remotes[0]!.slot).toBe(1);
    // Server now ≈ 200 ms → render at ≈ 100 ms → x ≈ 3 (one unit per 33.3 ms).
    expect(remotes[0]!.pose.x).toBeCloseTo(3, 1);

    // Someone who left disappears.
    s.handleRoster({ players: [{ id: 'me', name: 'Me', slot: 0, connected: true }] });
    expect(s.remotePlayers(localNow)).toEqual([]);
  });

  it('bumps into the others where their newest snapshot has them (player collision)', () => {
    const ctx = setup();
    const s = ctx.session;
    const other = (id: string, x: number, crouched = false, hp = 100) => {
      const p = createPlayerState({ x, y: 0, z: 0 });
      p.move.crouched = crouched;
      p.health = hp;
      return toSnapshotPlayer(id, p, 0, 0);
    };
    const me = toSnapshotPlayer('me', createPlayerState({ x: 0, y: 0, z: 0 }), -1, 0);
    s.handleSnapshot({ t: 2, players: [me, other('bo', 1), other('cy', 5, true)] }, 40);
    s.handleSnapshot({ t: 4, players: [me, other('bo', 2), other('cy', 5, true, 0)] }, 70);
    const crowd = s.crowd();
    // Never ourselves, never the dead; the newest position (not the drawn, interpolated one).
    expect(crowd.map((c) => [c.id, c.x, c.height])).toEqual([['bo', 2, 1.8]]);
    expect(s.crowd()).toBe(crowd); // reused, no garbage per frame
    s.handleSnapshot({ t: 6, players: [me, other('bo', 2), other('cy', 5, true)] }, 100);
    expect(s.crowd().map((c) => [c.id, c.height])).toEqual([
      ['bo', 1.8],
      ['cy', 1.2],
    ]);
  });

  it('after a stall the buffer grows; view time reports exactly the (bigger) delay drawn', () => {
    const ctx = setup();
    const s = ctx.session;
    s.handleRoster({
      players: [
        { id: 'me', name: 'Me', slot: 0, connected: true },
        { id: 'bo', name: 'Bo', slot: 1, connected: true },
      ],
    });
    const other = (x: number) => {
      const st = createPlayerState({ x, y: 0, z: 0 });
      st.move.vel.x = 30; // 30 m/s: one unit per 33.3 ms
      return toSnapshotPlayer('bo', st, 0, 0);
    };
    const me = toSnapshotPlayer('me', createPlayerState({ x: 0, y: 0, z: 0 }), -1, 0);
    const arrive = (i: number, late = 0) =>
      s.handleSnapshot({ t: i * 2, players: [me, other(i)] }, (i * 2000) / 60 + 10 + late);
    for (let i = 0; i <= 30; i++) arrive(i);
    const clean = (60 * 1000) / 60 + 10;
    expect(s.netStats(clean).delayMs).toBe(MATCH_NET.interpDelayMs);
    // 400 ms of silence, drawn frame by frame: players keep moving (extrapolated, then held)…
    let x = s.remotePlayers(clean)[0]!.pose.x;
    for (let t = clean + 16; t <= clean + 400; t += 16) {
      const nx = s.remotePlayers(t)[0]!.pose.x;
      expect(nx).toBeGreaterThanOrEqual(x - 1e-9);
      x = nx;
    }
    const stalled = clean + 400;
    const stats = s.netStats(stalled);
    expect(stats.delayMs).toBeGreaterThan(MATCH_NET.interpDelayMs + 50);
    expect(stats.delayMs).toBeLessThanOrEqual(MATCH_NET.maxInterpDelayMs);
    expect(stats.silenceMs).toBeCloseTo(400, 6);
    // …and every input's view time is exactly what is drawn: server now − the adapted delay
    // (the server still caps the rewind at 200 ms, so a bigger buffer buys nothing extra).
    const serverNow = s.clock.now(stalled)!;
    expect(s.viewTime(stalled)).toBeCloseTo(serverNow - stats.delayMs, 9);
    // The link resumes (the backlog arrives at once): no jump in what is drawn.
    for (let i = 31; i <= 42; i++) arrive(i, 400 - (i - 31) * 33.3);
    const resumed = s.remotePlayers(stalled + 16)[0]!.pose.x;
    expect(Math.abs(resumed - x)).toBeLessThan(0.6);
  });

  it('status text lists who is in the match', () => {
    const ctx = setup();
    ctx.session.handleRoster({
      players: [
        { id: 'me', name: 'Me', slot: 0, connected: true },
        { id: 'bo', name: 'Bo', slot: 1, connected: false },
      ],
    });
    expect(onlineStatusText(ctx.session)).toBe('online · 2 players: you, Bo (away)');
    ctx.session.handleStatus({ state: 'offline', error: 'disconnected (4002)' });
    expect(onlineStatusText(ctx.session)).toContain('offline');
  });
});

describe('online URL options', () => {
  const page = { protocol: 'http:', hostname: 'laptop.local', host: 'laptop.local:5173' };
  it('picks the server from ?server=, the build env, or the page host on :2567', () => {
    expect(resolveServerUrl('', page)).toBe('http://laptop.local:2567');
    expect(resolveServerUrl('', { protocol: 'https:', hostname: 'wd.example' })).toBe(
      'https://wd.example:2567',
    );
    expect(resolveServerUrl('', page, 'https://env.example')).toBe('https://env.example');
    expect(resolveServerUrl('?server=192.168.1.20:2567', page)).toBe('http://192.168.1.20:2567');
    expect(resolveServerUrl('?server=wss://game.example', page)).toBe('https://game.example');
    expect(resolveServerUrl('?server=javascript:alert(1)', page)).toBe('http://laptop.local:2567');
    expect(resolveServerUrl('?server=', page)).toBe('http://laptop.local:2567');
  });

  it('uses the page origin in production unless ?server= or env override it', () => {
    expect(resolveServerUrl('', page, undefined, true)).toBe('http://laptop.local:5173');
    expect(resolveServerUrl('', page, 'https://env.example', true)).toBe('https://env.example');
    expect(resolveServerUrl('?server=game.example', page, undefined, true)).toBe(
      'http://game.example',
    );
  });

  it('a bare ?server= host takes the page scheme (an https page cannot open ws://)', () => {
    const https = { protocol: 'https:', hostname: 'wd.example' };
    expect(resolveServerUrl('?server=game.example:2567', https)).toBe('https://game.example:2567');
    expect(resolveServerUrl('?server=http://lan.box:2567', https)).toBe('http://lan.box:2567');
    expect(resolveServerUrl('?server=javascript:alert(1)', https)).toBe('https://wd.example:2567');
  });

  it('?online turns online mode on for the page, ?online=0 off, else the saved setting', () => {
    expect(onlineRequested('', false)).toBe(false);
    expect(onlineRequested('', true)).toBe(true);
    expect(onlineRequested('?online', false)).toBe(true);
    expect(onlineRequested('?online=1', false)).toBe(true);
    expect(onlineRequested('?online=0', true)).toBe(false);
  });

  it('a ?online link never becomes the saved default; only the checkbox is persisted', () => {
    // Opened `?online` with single-player saved: changing any other setting keeps it saved off.
    const page = { online: onlineRequested('?online', false), saved: false };
    expect(onlineToSave(true, page)).toBe(false);
    // Unticking the box on that page is a real choice (saved off either way) …
    expect(onlineToSave(false, page)).toBe(false);
    // … and ticking it on a plain single-player page saves online.
    expect(onlineToSave(true, { online: false, saved: false })).toBe(true);
    // `?online=0` on a page whose saved default is online: other changes keep online saved.
    expect(onlineToSave(false, { online: false, saved: true })).toBe(true);
  });
});

describe('friend lobby URL and settings helpers', () => {
  it('recognizes create and room-link flows without changing ?online quick join', () => {
    expect(friendLobbyMode('?online')).toBeNull();
    expect(friendLobbyMode('?lobby=create')).toBe('create');
    expect(friendLobbyMode('?lobby=host')).toBe('create');
    expect(friendLobbyMode('?room=abc123')).toBe('join');
    expect(roomCodeFromSearch('?room=AbC123')).toBe('AbC123');
    expect(roomCodeFromSearch('?room=')).toBeNull();
  });

  it('builds share links that keep server overrides but use ?room as the join key', () => {
    expect(shareRoomUrl('https://wd.example/?online&server=lan:2567&lobby=create', 'R42')).toBe(
      'https://wd.example/?server=lan%3A2567&room=R42',
    );
  });

  it('clamps friend settings and normalizes room options for server validation', () => {
    const settings = normalizeFriendSettings({
      ...DEFAULT_FRIEND_SETTINGS,
      map: 'range',
      size: 'market',
      mode: 'knife',
      weather: 'rain',
      radar: 'off',
      botCount: 5,
      botBehaviour: 'hunt-humans',
      botDifficulty: 'hard',
      scoreLimit: 1,
      timeLimit: 60,
    });
    expect(settings).toMatchObject({
      map: 'range',
      size: 'full',
      mode: 'knife',
      weather: 'rain',
      radar: 'off',
      botCount: 5,
      botBehaviour: 'hunt-humans',
      botDifficulty: 'hard',
      scoreLimit: 1,
      timeLimit: 60,
    });
    expect(friendRoomOptions(settings, ' Ada ')).toMatchObject({
      lobby: true,
      map: 'range',
      size: 'full',
      mode: 'knife',
      name: 'Ada',
      botCount: 5,
    });
  });
});

describe('wireOnlineRoom friend handoff', () => {
  it('installs live handlers before stopping lobby buffering and replays the latest buffered state', () => {
    type HandlerMap = {
      welcome: (m: WelcomeMessage) => void;
      roster: (m: RosterMessage) => void;
      respawn: (m: RespawnMessage) => void;
      snap: (m: SnapshotMessage) => void;
      combat: (m: CombatMessage) => void;
      drop: (m: DropMessage) => void;
      match: (m: MatchStateMessage) => void;
      lobby: (m: unknown) => void;
      ping: (m: MatchPing) => void;
    };
    const attached: (keyof HandlerMap)[] = [];
    const handlers: Partial<HandlerMap> = {};
    const sent: { type: string; payload: unknown }[] = [];
    const stopOrder: string[] = [];
    const session = new OnlineSession();
    const link = new OnlineLink();
    const replayWelcome: WelcomeMessage = {
      ...welcome,
      id: 'me',
      seed: 202,
      tick: 12,
      spawn: { x: 2, y: 0, z: 3, yaw: 0.75 },
    };
    const replayRoster: RosterMessage = {
      players: [
        { id: 'me', name: 'Ada', slot: 0, connected: true },
        { id: 'bot-1', name: 'Courier', slot: 1, connected: true, bot: true },
      ],
    };
    const replayMatch: MatchStateMessage = {
      phase: 'playing',
      endsAt: 3600,
      scoreLimit: 25,
      scores: [
        { id: 'me', kills: 1, deaths: 0 },
        { id: 'bot-1', kills: 0, deaths: 1 },
      ],
      winners: [],
    };
    const replayRespawn: RespawnMessage = {
      life: 2,
      seq: -1,
      x: 4,
      y: 0,
      z: 5,
      yaw: 1.25,
      primary: 'ar7',
    };
    const firstSnapshot: SnapshotMessage = {
      t: 14,
      players: [toSnapshotPlayer('me', createPlayerState({ x: 4, y: 0, z: 5 }, 202), -1, 2)],
      tactical: {
        smoke: [{ id: 7, pos: { x: 1, y: 0, z: 2 }, age: 0.5 }],
        pickups: [{ id: 'uplink', pos: { x: 6, y: 0, z: 7 }, kind: 'radar', cooldown: 0 }],
        radar: { charges: 1, live: 2 },
      },
    };
    const staleSnapshot: SnapshotMessage = {
      t: 13,
      players: [toSnapshotPlayer('me', createPlayerState({ x: 0, y: 0, z: 0 }, 202), -1, 1)],
    };
    const replayCombat: CombatMessage = { events: [] };
    const replayDrops: DropMessage = {
      events: [{ type: 'ammo', dropId: 'drop-1', by: 'me', amount: 12 }],
    };
    const buffer = {
      stop: () => stopOrder.push(`stop-after-${attached.join(',')}`),
      welcome: replayWelcome,
      roster: replayRoster,
      match: replayMatch,
      respawn: replayRespawn,
      snapshots: [staleSnapshot, firstSnapshot],
      combats: [replayCombat],
      drops: [replayDrops],
    };
    const room = {
      reconnection: { minUptime: 5 },
      onMessage: <K extends keyof HandlerMap>(kind: K, handler: HandlerMap[K]) => {
        attached.push(kind);
        handlers[kind] = handler;
        return () => undefined;
      },
      onDrop: () => undefined,
      onReconnect: () => undefined,
      onLeave: () => undefined,
      send: (type: string, payload: unknown) => sent.push({ type, payload }),
      leave: () => Promise.resolve(),
    };

    wireOnlineRoom(session, link, room as never, buffer);

    expect(stopOrder).toEqual([
      'stop-after-welcome,roster,respawn,snap,combat,drop,match,lobby,ping',
    ]);
    expect(room.reconnection.minUptime).toBe(0);
    expect(session.id).toBe('me');
    expect(session.roster.map((p) => p.name)).toEqual(['Ada', 'Courier']);
    expect(onlineStatusText(session)).toContain('[BOT] Courier');
    expect(session.nameOf('bot-1')).toBe('[BOT] Courier');
    expect(session.match).toEqual(replayMatch);
    expect(session.tactical).toMatchObject({
      smoke: [{ id: 7, age: 0.5 }],
      pickups: [{ id: 'uplink', kind: 'radar', cooldown: 0 }],
      radar: { charges: 1, live: 2 },
    });
    expect(session.pendingCount).toBe(0);
    expect(buffer.snapshots).toEqual([]);
    expect(buffer.combats).toEqual([]);
    expect(buffer.drops).toEqual([]);
    expect(session.takeDrops()).toEqual(replayDrops.events);
    expect(session.takeDrops()).toEqual([]);

    const liveDrops: DropMessage = {
      events: [{ type: 'swap', dropId: 'drop-2', by: 'me', primary: 'shotgun' }],
    };
    handlers.drop?.(liveDrops);
    expect(session.takeDrops()).toEqual(liveDrops.events);

    handlers.ping?.({ t: 99, rtt: 42 });
    expect(sent).toEqual([{ type: 'pong', payload: { t: 99 } }]);
  });
});

describe('OnlineLink (leaving cleanly)', () => {
  const fakeRoom = (): LeavableRoom & { calls: (boolean | undefined)[] } => {
    const calls: (boolean | undefined)[] = [];
    return {
      calls,
      leave: (consented?: boolean) => {
        calls.push(consented);
        return Promise.resolve(4000);
      },
    };
  };

  it('leaves the joined room with consent, once', async () => {
    const link = new OnlineLink();
    const room = fakeRoom();
    link.attach(room);
    await link.leave();
    await link.leave();
    expect(room.calls).toEqual([true]);
    expect(link.left).toBe(true);
  });

  it('a room joined after the page started leaving is left at once', () => {
    const link = new OnlineLink();
    void link.leave();
    const late = fakeRoom();
    link.attach(late);
    expect(late.calls).toEqual([true]);
  });

  it('never waits long for the server (a reload goes ahead after the timeout)', async () => {
    vi.useFakeTimers();
    try {
      const link = new OnlineLink();
      link.attach({ leave: () => new Promise(() => {}) }); // the server never answers
      let done = false;
      void link.leave(300).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Back/Forward restore after leaving needs a reload; other pageshows do not', async () => {
    const link = new OnlineLink();
    link.attach({ leave: () => Promise.resolve(4000) });
    expect(link.restoredFromCache(true)).toBe(false); // restored without having left: still joined
    await link.leave(); // pagehide
    expect(link.restoredFromCache(false)).toBe(false); // a fresh load's pageshow
    expect(link.restoredFromCache(true)).toBe(true);
  });
});

describe('friend room online preference (review fix)', () => {
  it('a friend room plays online without changing the saved preference', () => {
    const page = pageOnline('?room=AbC123', false, true);
    expect(page).toEqual({ online: true, saved: false });
    // Changing an unrelated setting on that page keeps single-player saved …
    expect(onlineToSave(true, page)).toBe(false);
    // … and unticking online there saves it off too.
    expect(onlineToSave(false, page)).toBe(false);
    expect(pageOnline('?room=AbC123', true, true)).toEqual({ online: true, saved: true });
    expect(pageOnline('', false, false)).toEqual({ online: false, saved: false });
    expect(pageOnline('?online', false, false)).toEqual({ online: true, saved: false });
  });
});
