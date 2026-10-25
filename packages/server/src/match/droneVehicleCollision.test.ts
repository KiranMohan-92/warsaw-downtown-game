import { beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  clonePlayerState,
  emptyInput,
  initPhysics,
  MATCH_NET,
  ownStateError,
  PhysicsWorld,
  reconcile,
  SIM_DT,
  stepPlayer,
  toSnapshotPlayer,
  withHulls,
  type PlayerInput,
  type PredictedStep,
  type SnapshotPlayer,
} from '@wd/shared';
import { MatchSim } from './MatchSim.ts';

beforeAll(initPhysics);

function fixture(wreck = false) {
  const sim = new MatchSim({
    map: 'range',
    size: 'full',
    mode: 'standard',
    spawnProtection: 0,
    vehicles: 'on',
    vehicleSpawns: [{ x: 0, z: -22, yaw: 0 }],
    jetpacks: 'off',
    scoreLimit: 'unlimited',
    timeLimit: 'unlimited',
  });
  const truck = sim.vehicles.get(1)!;
  if (wreck) {
    truck.condition = 'wreck';
    truck.health = 0;
    truck.until = sim.tick + 1200;
  }
  const pilot = sim.addPlayer('pilot', 'Pilot', 0);
  const pos = { x: 0, y: 0, z: -12 };
  pilot.body.setPosition(pos);
  pilot.body.setGrounded(true);
  pilot.state.move.pos = { ...pos };
  pilot.state.move.grounded = true;
  pilot.state.droneCharges = 1;
  sim.step();
  const physics = new PhysicsWorld(sim.map);
  const movement = {
    castRay: physics.castGroundRay.bind(physics),
  };
  const env = {
    vehicles: sim.vehicles.obstacles(),
    droneWorld: withHulls(movement, sim.vehicles.hullsNow()),
  };
  return { sim, pilot, physics, env };
}

const flightInput = (seq: number): PlayerInput => ({
  ...emptyInput(seq),
  moveZ: 1,
  pitch: seq < 90 ? -0.28 : 0,
  buttons: seq === 0 ? Button.Drone : 0,
});

describe('drone collision with authoritative truck armour', () => {
  it.each([false, true])('blocks flight at a parked truck (wreck = %s)', (wreck) => {
    const { sim, pilot, physics } = fixture(wreck);
    try {
      for (let i = 0; i < 180; i++) {
        sim.receiveInputs(pilot.id, [flightInput(i)], sim.nowMs);
        sim.step();
      }

      expect(pilot.state.drone?.alive).toBe(true);
      expect(pilot.state.drone!.pos.z).toBeGreaterThan(-20);
      expect(pilot.state.drone!.pos.z).toBeLessThan(-18);
      expect(pilot.state.drone!.vel.z).toBe(0);
    } finally {
      physics.free();
      sim.dispose();
    }
  });

  it.each([3, 6, 9])(
    'keeps exact truck-contact prediction with %i ticks of one-way latency',
    (latency) => {
      const { sim, pilot, physics, env } = fixture();
      try {
        let state = clonePlayerState(pilot.state);
        const body = physics.createCharacter(state.move.pos);
        body.setGrounded(true);
        let pending: PredictedStep[] = [];
        const upstream: { due: number; input: PlayerInput }[] = [];
        const downstream: { due: number; snap: SnapshotPlayer }[] = [];
        let comparisons = 0;
        let corrections = 0;
        for (let i = 0; i < 600; i++) {
          while (downstream[0] && downstream[0].due <= i) {
            const { snap } = downstream.shift()!;
            if (snap.ack < 0) continue;
            const acked = pending.find((p) => p.input.seq === snap.ack);
            if (acked) {
              expect(ownStateError(acked.after, snap.own!)).toBeLessThan(1e-6);
              comparisons++;
            }
            const result = reconcile(state, pending, snap, body, SIM_DT, { env });
            corrections += Number(result.corrected);
            state = result.state;
            pending = result.pending;
          }
          const input = flightInput(i);
          stepPlayer(state, input, SIM_DT, body, env);
          pending.push({ input, after: clonePlayerState(state) });
          upstream.push({ due: i + latency, input });
          while (upstream[0] && upstream[0].due <= i)
            sim.receiveInputs(pilot.id, [upstream.shift()!.input], sim.nowMs);
          sim.step();
          if (sim.tick % MATCH_NET.snapshotEvery === 0)
            downstream.push({
              due: i + latency,
              snap: sim.snapshot(pilot.id).players.find((p) => p.id === pilot.id)!,
            });
        }
        expect(comparisons).toBeGreaterThan(250);
        expect(corrections).toBe(0);
        expect(state.drone?.alive).toBe(true);
        expect(state.drone!.pos.z).toBeGreaterThan(-20);
        expect(state.drone!.pos.z).toBeLessThan(-18);
        expect(state.drone!.vel.z).toBe(0);
      } finally {
        physics.free();
        sim.dispose();
      }
    },
  );

  it('replays the unacknowledged approach into the same truck contact', () => {
    const { sim, pilot, physics, env } = fixture();
    try {
      const state = clonePlayerState(pilot.state);
      const body = physics.createCharacter(state.move.pos);
      body.setGrounded(true);
      const pending: PredictedStep[] = [];
      for (let i = 0; i < 120; i++) {
        const input = flightInput(i);
        stepPlayer(state, input, SIM_DT, body, env);
        pending.push({ input, after: clonePlayerState(state) });
        if (i < 20) {
          sim.receiveInputs(pilot.id, [input], sim.nowMs);
          sim.step();
        }
      }
      expect(state.drone?.alive).toBe(true);
      expect(state.drone!.pos.z).toBeGreaterThan(-20);
      expect(state.drone!.pos.z).toBeLessThan(-18);
      const snapshot = sim.snapshot(pilot.id).players.find((p) => p.id === pilot.id)!;
      expect(snapshot.ack).toBe(19);
      expect(pilot.state.drone!.pos.z).toBeGreaterThan(-18);
      const expected = toSnapshotPlayer(pilot.id, state, 119, 0, { own: true }).own!;
      const replayed = reconcile(state, pending, snapshot, body, SIM_DT, {
        env,
        forceReset: true,
      });
      expect(replayed.corrected).toBe(true);
      expect(ownStateError(replayed.state, expected)).toBeLessThan(1e-6);
    } finally {
      physics.free();
      sim.dispose();
    }
  });
});
