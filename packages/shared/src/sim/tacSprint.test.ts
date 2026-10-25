import { beforeAll, describe, expect, it } from 'vitest';
import { MOVEMENT, RIFLE, SIM_DT, SLIDE, TAC_SPRINT } from '../config/tunables.ts';
import { boxMinMax } from '../maps/builder.ts';
import type { MapDefinition } from '../maps/types.ts';
import { SnapFlag } from '../net/protocol.ts';
import { reconcile, type PredictedStep } from '../net/reconcile.ts';
import { applySnapshotMove, snapshotError, toSnapshotPlayer } from '../net/snapshot.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { Button, emptyInput, type PlayerInput } from './input.ts';
import {
  clonePlayerState,
  createPlayerState,
  horizontalSpeed,
  stepPlayer,
  type PlayerEvent,
  type PlayerState,
} from './player.ts';
import { FlatGroundBody, run } from './testUtils.ts';

const S = Button.Sprint;
const T = Button.TacSprint;

/** Grounded and sprinting flat out toward -Z, on flat ground. */
function sprinting(): { p: PlayerState; body: FlatGroundBody } {
  const body = new FlatGroundBody();
  const p = createPlayerState({ x: 0, y: 0, z: 0 });
  run(p, body, 0.1, {});
  run(p, body, 0.6, { moveZ: 1, buttons: S });
  return { p, body };
}

/** One step with TacSprint pressed (the client's double tap), Sprint held. */
const tap = (p: PlayerState, body: FlatGroundBody, extra = 0): PlayerEvent[] =>
  run(p, body, SIM_DT, { moveZ: 1, buttons: S | T | extra });

describe('tactical sprint: trigger', () => {
  it('TacSprint pressed on a sprint starts a burst faster than a sprint', () => {
    const { p, body } = sprinting();
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.sprintSpeed, 3);
    tap(p, body);
    expect(p.move.tacSprint).toBe(true);
    expect(p.move.sprinting).toBe(true);
    run(p, body, 0.2, { moveZ: 1, buttons: S });
    expect(horizontalSpeed(p.move)).toBeCloseTo(TAC_SPRINT.speed, 3);
    // Holding the TacSprint bit is not a new press: nothing restarts or stacks.
    run(p, body, 0.2, { moveZ: 1, buttons: S | T });
    expect(horizontalSpeed(p.move)).toBeCloseTo(TAC_SPRINT.speed, 3);
  });

  it('never from a walk, a low run, crouched, prone-less fakes in the air, or with a low tank', () => {
    const walk = createPlayerState({ x: 0, y: 0, z: 0 });
    const body = new FlatGroundBody();
    run(walk, body, 0.5, { moveZ: 1 });
    run(walk, body, SIM_DT, { moveZ: 1, buttons: T });
    expect(walk.move.tacSprint).toBe(false);

    // A low run (Crouch held before sprinting; a Crouch press on a sprint would slide).
    const low = { p: createPlayerState({ x: 0, y: 0, z: 0 }), body: new FlatGroundBody() };
    run(low.p, low.body, 0.1, {});
    run(low.p, low.body, 0.5, { moveZ: 1, buttons: S | Button.Crouch });
    expect(low.p.move.lowRun).toBe(true);
    run(low.p, low.body, SIM_DT, { moveZ: 1, buttons: S | Button.Crouch | T });
    expect(low.p.move.tacSprint).toBe(false);

    const air = sprinting();
    run(air.p, air.body, SIM_DT, { moveZ: 1, buttons: S | Button.Jump });
    run(air.p, air.body, 0.1, { moveZ: 1, buttons: S });
    expect(air.p.move.grounded).toBe(false);
    run(air.p, air.body, SIM_DT, { moveZ: 1, buttons: S | T });
    expect(air.p.move.tacSprint).toBe(false);

    const empty = sprinting();
    empty.p.move.tacFuel = TAC_SPRINT.minStart - 0.05;
    tap(empty.p, empty.body);
    expect(empty.p.move.tacSprint).toBe(false);
  });
});

describe('tactical sprint: tank', () => {
  it('a full tank lasts TAC_SPRINT.duration, then drops back into a normal sprint', () => {
    const { p, body } = sprinting();
    tap(p, body);
    let steps = 1;
    while (p.move.tacSprint && steps < 600) {
      run(p, body, SIM_DT, { moveZ: 1, buttons: S });
      steps++;
    }
    expect(steps * SIM_DT).toBeCloseTo(TAC_SPRINT.duration, 1);
    expect(p.move.tacFuel).toBe(0);
    expect(p.move.sprinting).toBe(true);
    run(p, body, 0.2, { moveZ: 1, buttons: S });
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.sprintSpeed, 3);
  });

  it('refills after the delay; a half tank allows a shorter burst', () => {
    const { p, body } = sprinting();
    tap(p, body);
    while (p.move.tacSprint) run(p, body, SIM_DT, { moveZ: 1, buttons: S });
    expect(p.move.tacFuel).toBe(0);
    // Nothing comes back during the delay (sprinting on, or standing still).
    run(p, body, TAC_SPRINT.rechargeDelay - 0.05, { moveZ: 1, buttons: S });
    expect(p.move.tacFuel).toBe(0);
    // Then it refills linearly: minStart of the tank after minStart × rechargeTime.
    run(p, body, 0.05 + TAC_SPRINT.minStart * TAC_SPRINT.rechargeTime, {
      moveZ: 1,
      buttons: S,
    });
    expect(p.move.tacFuel).toBeCloseTo(TAC_SPRINT.minStart, 1);
    tap(p, body);
    expect(p.move.tacSprint).toBe(true);
    let steps = 1;
    while (p.move.tacSprint) {
      run(p, body, SIM_DT, { moveZ: 1, buttons: S });
      steps++;
    }
    expect(steps * SIM_DT).toBeCloseTo(TAC_SPRINT.minStart * TAC_SPRINT.duration, 1);
    // A full refill takes rechargeTime.
    run(p, body, TAC_SPRINT.rechargeDelay + TAC_SPRINT.rechargeTime + 0.05, {});
    expect(p.move.tacFuel).toBe(1);
  });

  it('releasing Sprint or forward ends the burst and keeps the rest of the tank', () => {
    const { p, body } = sprinting();
    tap(p, body);
    run(p, body, 0.5, { moveZ: 1, buttons: S });
    run(p, body, SIM_DT, { moveZ: 1 });
    expect(p.move.tacSprint).toBe(false);
    expect(p.move.tacFuel).toBeCloseTo(1 - (0.5 + SIM_DT) / TAC_SPRINT.duration, 2);
    expect(p.move.tacDelay).toBeGreaterThan(0);
  });
});

describe('tactical sprint: weapon lowered', () => {
  it('Fire ends the burst; the gun needs the longer sprint-out before the first round', () => {
    const shotAfter = (tac: boolean): number => {
      const { p, body } = sprinting();
      if (tac) {
        tap(p, body);
        run(p, body, 0.3, { moveZ: 1, buttons: S });
      }
      let t = 0;
      for (; t < 1; t += SIM_DT) {
        const events = run(p, body, SIM_DT, { moveZ: 1, buttons: S | Button.Fire });
        expect(p.move.tacSprint).toBe(false);
        if (events.some((e) => e.type === 'shot')) break;
      }
      return t;
    };
    const normal = shotAfter(false);
    const tactical = shotAfter(true);
    expect(normal).toBeCloseTo(RIFLE.sprintToFireTime, 1);
    expect(tactical).toBeCloseTo(RIFLE.sprintToFireTime * TAC_SPRINT.sprintOutMultiplier, 1);
    expect(tactical).toBeGreaterThan(normal + 0.1);
  });

  it('ADS ends the burst (no aiming while bursting)', () => {
    const { p, body } = sprinting();
    tap(p, body);
    run(p, body, SIM_DT, { moveZ: 1, buttons: S | Button.Ads });
    expect(p.move.tacSprint).toBe(false);
    expect(p.move.sprinting).toBe(false);
  });

  it('a slide from a burst starts as from a sprint (entry capped at sprint speed)', () => {
    const { p, body } = sprinting();
    tap(p, body);
    run(p, body, 0.3, { moveZ: 1, buttons: S });
    const events = run(p, body, SIM_DT, { moveZ: 1, buttons: S | Button.Crouch });
    expect(events.some((e) => e.type === 'slide')).toBe(true);
    expect(p.move.sliding).toBe(true);
    expect(p.move.tacSprint).toBe(false);
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.sprintSpeed * SLIDE.boost, 1);
  });
});

describe('tactical sprint: wire', () => {
  it('the snapshot carries the burst flag and the tank; a mismatch corrects', () => {
    const { p, body } = sprinting();
    tap(p, body);
    run(p, body, 0.4, { moveZ: 1, buttons: S });
    const snap = toSnapshotPlayer('me', p, 1, 0, { own: true });
    expect(snap.f & SnapFlag.TacSprint).toBe(SnapFlag.TacSprint);
    const other = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(other, snap);
    expect(other.move.tacSprint).toBe(true);
    expect(other.move.tacFuel).toBeCloseTo(p.move.tacFuel, 9);
    expect(snapshotError(other, snap)).toBeLessThan(1e-9);
    other.move.tacSprint = false;
    expect(snapshotError(other, snap)).toBe(Infinity);
  });
});

describe('tactical sprint: physics (Rapier)', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('client prediction and the server agree through bursts, a slide and a wall', () => {
    const map: MapDefinition = {
      name: 'tac',
      bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 },
      boxes: [
        boxMinMax({ x: -80, y: -1, z: -80 }, { x: 80, y: 0, z: 80 }, 'ground'),
        boxMinMax({ x: -20, y: 0, z: -46 }, { x: 20, y: 3, z: -45 }, 'concrete'),
      ],
      spawns: [],
      dummies: [],
    };
    const start = { x: 0, y: 0.05, z: 0 };
    const serverWorld = new PhysicsWorld(map);
    const clientWorld = new PhysicsWorld(map);
    const serverBody = serverWorld.createCharacter(start);
    const clientBody = clientWorld.createCharacter(start);
    const server = createPlayerState(start);
    let client = createPlayerState(start);
    let pending: PredictedStep[] = [];
    // Sprint; burst at 0.5 s; fire at 1.2 s (ends it); burst again at 1.6 s; slide at 2 s;
    // sprint; burst at 3.4 s into the wall at z = -45.
    const input = (i: number): PlayerInput => ({
      ...emptyInput(i),
      moveZ: i < 6 ? 0 : 1,
      moveX: i > 100 && i < 110 ? 0.6 : 0,
      yaw: 0.001 * i,
      buttons:
        (i >= 6 ? S : 0) |
        (i === 30 || i === 96 || i === 204 ? T : 0) |
        (i === 72 ? Button.Fire : 0) |
        (i === 120 ? Button.Crouch : 0),
    });
    let bursts = 0;
    let corrected = 0;
    for (let i = 0; i < 330; i++) {
      const inp = input(i);
      stepPlayer(client, inp, SIM_DT, clientBody);
      pending.push({ input: inp, after: clonePlayerState(client) });
      const was = server.move.tacSprint;
      stepPlayer(server, inp, SIM_DT, serverBody);
      if (!was && server.move.tacSprint) bursts++;
      if (i % 2 === 1) {
        const snap = toSnapshotPlayer('me', server, i, 0, { own: true });
        const r = reconcile(client, pending, snap, clientBody, SIM_DT);
        client = r.state;
        pending = r.pending;
        if (r.corrected) corrected++;
      }
    }
    expect(bursts).toBe(3);
    expect(corrected).toBe(0);
    expect(client.move.pos).toEqual(server.move.pos);
    expect(client.move.tacFuel).toBe(server.move.tacFuel);
    // Ran into the wall: stopped at its face, burst over.
    expect(server.move.pos.z).toBeGreaterThan(-45);
    serverBody.free();
    clientBody.free();
  });
});
