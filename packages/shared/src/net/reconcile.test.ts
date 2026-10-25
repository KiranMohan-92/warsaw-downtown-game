import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config/tunables.ts';
import { Button, emptyInput, type PlayerInput } from '../sim/input.ts';
import {
  clonePlayerState,
  createPlayerState,
  stepPlayer,
  type PlayerState,
} from '../sim/player.ts';
import { FlatGroundBody } from '../sim/testUtils.ts';
import { reconcile, type PredictedStep } from './reconcile.ts';
import { toSnapshotPlayer } from './snapshot.ts';

/** Inputs 0..n-1: run forward, strafing a bit, jumping at step 20. */
const inputs = (n: number): PlayerInput[] =>
  Array.from({ length: n }, (_, i) => ({
    ...emptyInput(i),
    moveZ: 1,
    moveX: i % 30 < 15 ? 0.4 : -0.4,
    yaw: 0.01 * i,
    buttons: i === 20 ? Button.Jump : 0,
  }));

/** Predict like the client: step every input, keeping a copy of the state after each. */
function predict(
  start: PlayerState,
  body: FlatGroundBody,
  list: PlayerInput[],
): { state: PlayerState; pending: PredictedStep[] } {
  const state = clonePlayerState(start);
  const pending: PredictedStep[] = [];
  for (const input of list) {
    stepPlayer(state, input, SIM_DT, body);
    pending.push({ input, after: clonePlayerState(state) });
  }
  return { state, pending };
}

describe('reconcile', () => {
  it('keeps the prediction and drops acknowledged steps when the server agrees', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = inputs(40);
    const client = predict(start, new FlatGroundBody(), list);
    // The server ran the same code on the first 25 inputs.
    const server = predict(start, new FlatGroundBody(), list.slice(0, 25)).state;
    const snap = toSnapshotPlayer('me', server, 24, 0);

    const r = reconcile(client.state, client.pending, snap, new FlatGroundBody(), SIM_DT);
    expect(r.corrected).toBe(false);
    expect(r.state).toBe(client.state); // untouched: no replay needed
    expect(r.error).toBeLessThan(1e-9);
    // The acknowledged step stays as the reference for a repeat of the same ack.
    expect(r.pending.map((s) => s.input.seq)).toEqual(list.slice(24).map((i) => i.seq));
    const again = reconcile(r.state, r.pending, snap, new FlatGroundBody(), SIM_DT);
    expect(again.corrected).toBe(false);
    expect(again.pending).toHaveLength(r.pending.length);
  });

  it('on a misprediction, resets to the server state and replays unacknowledged inputs', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = inputs(40);
    const client = predict(start, new FlatGroundBody(), list);

    // The server's truth differs: it saw the player 1.5 m further east at input 24 (e.g. it
    // idled them through a stall the client never predicted).
    const server = predict(start, new FlatGroundBody(), list.slice(0, 25)).state;
    server.move.pos.x += 1.5;
    const snap = toSnapshotPlayer('me', server, 24, 0);

    const body = new FlatGroundBody(client.state.move.pos);
    const r = reconcile(client.state, client.pending, snap, body, SIM_DT);
    expect(r.corrected).toBe(true);
    expect(r.error).toBeCloseTo(1.5, 6);

    // Ground truth: the server state with the remaining 15 inputs applied on top.
    const truth = predict(server, new FlatGroundBody(server.move.pos), list.slice(25)).state;
    expect(r.state.move.pos.x).toBeCloseTo(truth.move.pos.x, 9);
    expect(r.state.move.pos.y).toBeCloseTo(truth.move.pos.y, 9);
    expect(r.state.move.pos.z).toBeCloseTo(truth.move.pos.z, 9);
    expect(r.state.move.vel.x).toBeCloseTo(truth.move.vel.x, 9);
    // The body was moved with the replay, and the pending predictions were rewritten.
    expect(body.feet.x).toBeCloseTo(truth.move.pos.x, 9);
    expect(r.pending).toHaveLength(16); // the acknowledged step (now the server's) + 15
    expect(r.pending[0]!.after.move.pos.x).toBeCloseTo(server.move.pos.x, 9);
    expect(r.pending.at(-1)!.after.move.pos.x).toBeCloseTo(truth.move.pos.x, 9);
    // The same snapshot again (30 Hz snapshots, 60 Hz inputs): now it agrees, no second replay.
    const again = reconcile(r.state, r.pending, snap, body, SIM_DT);
    expect(again.corrected).toBe(false);
    // Nothing the caller passed in was mutated.
    expect(client.pending[39]!.after.move.pos.x).not.toBeCloseTo(truth.move.pos.x, 3);
  });

  it('replays button presses as presses (jump right after the acknowledged step)', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    // Stand still for 30 steps, then jump on step 30.
    const list = Array.from({ length: 40 }, (_, i) => ({
      ...emptyInput(i),
      buttons: i === 30 ? Button.Jump : 0,
    }));
    const client = predict(start, new FlatGroundBody(), list);
    const server = predict(start, new FlatGroundBody(), list.slice(0, 30)).state;
    server.move.pos.z -= 2; // force a correction at ack 29
    const r = reconcile(
      client.state,
      client.pending,
      toSnapshotPlayer('me', server, 29, 0),
      new FlatGroundBody(),
      SIM_DT,
    );
    expect(r.corrected).toBe(true);
    expect(r.state.move.pos.y).toBeGreaterThan(0.1); // the replayed jump happened
    expect(r.state.move.pos.y).toBeCloseTo(client.state.move.pos.y, 9);
  });

  it('with nothing acknowledged yet (ack -1), rebuilds from the spawn and replays everything', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = inputs(10);
    const client = predict(start, new FlatGroundBody(), list);
    // The server spawned the player somewhere else.
    const spawn = createPlayerState({ x: 20, y: 0, z: -5 });
    const r = reconcile(
      client.state,
      client.pending,
      toSnapshotPlayer('me', spawn, -1, 0),
      new FlatGroundBody(),
      SIM_DT,
    );
    const truth = predict(spawn, new FlatGroundBody(spawn.move.pos), list).state;
    expect(r.corrected).toBe(true);
    expect(r.state.move.pos.x).toBeCloseTo(truth.move.pos.x, 9);
    expect(r.state.move.pos.z).toBeCloseTo(truth.move.pos.z, 9);
    expect(r.pending).toHaveLength(10); // nothing acknowledged: no reference step
  });

  it('a stance mismatch always corrects, however small the position error', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = inputs(5);
    const client = predict(start, new FlatGroundBody(), list);
    const server = clonePlayerState(client.pending[4]!.after);
    server.move.crouched = !server.move.crouched;
    const r = reconcile(
      client.state,
      client.pending,
      toSnapshotPlayer('me', server, 4, 0),
      new FlatGroundBody(),
      SIM_DT,
    );
    expect(r.corrected).toBe(true);
    expect(r.error).toBe(Infinity);
    expect(r.state.move.crouched).toBe(server.move.crouched);
  });

  it('after a server respawn, rebuilds on a fresh spawn state (base) and replays the rest', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = inputs(30);
    const client = predict(start, new FlatGroundBody(), list);
    client.state.arsenal.grenades = 0; // the old life threw its grenade
    // The server respawned the player at (40, 0, 40) right after input 9.
    const fresh = createPlayerState({ x: 40, y: 0, z: 40 });
    const snap = toSnapshotPlayer('me', fresh, 9, 1);
    const r = reconcile(client.state, client.pending, snap, new FlatGroundBody(), SIM_DT, {
      forceReset: true,
      base: fresh,
    });
    const truth = predict(fresh, new FlatGroundBody(fresh.move.pos), list.slice(10)).state;
    expect(r.corrected).toBe(true);
    expect(r.state.move.pos.x).toBeCloseTo(truth.move.pos.x, 9);
    expect(r.state.move.pos.z).toBeCloseTo(truth.move.pos.z, 9);
    expect(r.state.arsenal.grenades).toBe(fresh.arsenal.grenades); // new life, new kit
    expect(r.pending).toHaveLength(21); // reference (the fresh life at ack 9) + 20
    expect(fresh.move.pos).toEqual({ x: 40, y: 0, z: 40 }); // the base itself is untouched
  });
});
