import { describe, expect, it } from 'vitest';
import { DRONE, SIM_DT } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { WorldRaycaster } from './hitscan.ts';
import type { LedgeQueries } from './traversal.ts';
import { Button, emptyInput, sanitizeInput, type PlayerInput } from './input.ts';
import {
  clonePlayerState,
  createPlayerState,
  stepPlayer,
  type PlayerState,
  type StepEnv,
} from './player.ts';
import { FlatGroundBody } from './testUtils.ts';
import { hullAt, withHulls } from './vehicles/vehicleHits.ts';

const clearWorld: LedgeQueries = {
  castRay: () => null,
  overlapsStatic: () => false,
};

const clearDroneWorld: WorldRaycaster = {
  castRay: () => null,
};

class DroneBody extends FlatGroundBody {
  readonly world = clearWorld;
}

const step = (
  p: PlayerState,
  body: DroneBody,
  partial: Partial<PlayerInput>,
  seq = 0,
  env?: StepEnv,
): ReturnType<typeof stepPlayer> =>
  stepPlayer(p, { ...emptyInput(seq), ...partial }, SIM_DT, body, env);

describe('stepPlayer recon drone integration', () => {
  it('launches, flies and recalls through the same input path while the body stays exposed', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 7);
    const body = new DroneBody();
    step(p, body, {});
    p.droneCharges = 1;

    const launched = step(p, body, { buttons: Button.Drone, yaw: 0.25, pitch: -0.1 }, 1);
    expect(launched).toContainEqual({ type: 'droneLaunched' });
    expect(p.drone?.alive).toBe(true);
    expect(p.droneCharges).toBe(0);
    expect(p.prevButtons).toBe(Button.Drone);
    expect(p.view).toEqual({ yaw: 0, pitch: 0 });
    const stillHeld = step(p, body, { buttons: Button.Drone, yaw: 0.25, pitch: 0 }, 2);
    expect(stillHeld).toEqual([]);
    expect(p.drone).not.toBeNull();

    const bodyPos = { ...p.move.pos };
    const droneStart = { ...p.drone!.pos };
    for (let i = 3; i < 62; i++) {
      step(p, body, { moveZ: 1, yaw: 0.25, pitch: 0 }, i);
    }
    expect(p.move.pos).toEqual(bodyPos);
    expect(body.feet).toEqual(bodyPos);
    expect(p.view).toEqual({ yaw: 0, pitch: 0 });
    expect(p.drone!.pos.z).toBeLessThan(droneStart.z - 3);

    step(p, body, { yaw: 0.25, pitch: 0 }, 63);
    const recalled = step(p, body, { buttons: Button.Drone, yaw: 0.25, pitch: 0 }, 64);
    expect(recalled).toContainEqual({ type: 'droneRecalled' });
    expect(p.drone).toBeNull();
    expect(p.prevButtons).toBe(Button.Drone);
  });

  it('recall happens before body input, so the recall frame can move, turn and fire', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 11);
    const body = new DroneBody();
    step(p, body, {});
    p.droneCharges = 1;
    step(p, body, { buttons: Button.Drone }, 1);
    expect(p.drone?.alive).toBe(true);
    step(p, body, {}, 2);

    const before = { ...p.move.pos };
    const recalled = step(
      p,
      body,
      { buttons: Button.Drone | Button.Fire, moveZ: 1, yaw: 0.4, pitch: -0.2 },
      3,
    );

    expect(recalled).toContainEqual({ type: 'droneRecalled' });
    expect(recalled.some((e) => e.type === 'shot')).toBe(true);
    expect(p.drone).toBeNull();
    expect(p.view).toEqual({ yaw: 0.4, pitch: -0.2 });
    expect(p.move.pos.z).toBeLessThan(before.z);
    expect(body.feet.z).toBeLessThan(before.z);
  });

  it('expires on battery and deep-clones flight state', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 9);
    const body = new DroneBody();
    p.droneCharges = 1;
    step(p, body, { buttons: Button.Drone }, 1);
    expect(p.drone).not.toBeNull();

    const copy = clonePlayerState(p);
    copy.drone!.pos.x += 10;
    copy.drone!.vel.y = 99;
    expect(p.drone!.pos.x).not.toBe(copy.drone!.pos.x);
    expect(p.drone!.vel.y).not.toBe(copy.drone!.vel.y);

    let events: ReturnType<typeof stepPlayer> = [];
    for (let i = 0; i < Math.ceil(DRONE.battery / SIM_DT) + 2 && p.drone; i++) {
      events = step(p, body, { yaw: 0, pitch: 0 }, i + 2);
    }
    expect(events).toContainEqual({ type: 'droneBattery' });
    expect(p.drone).toBeNull();
  });

  it('sanitized junk input cannot teleport or speed up the drone', () => {
    const sane = createPlayerState({ x: 0, y: 0, z: 0 }, 3);
    const junk = createPlayerState({ x: 0, y: 0, z: 0 }, 3);
    const saneBody = new DroneBody();
    const junkBody = new DroneBody();
    sane.droneCharges = 1;
    junk.droneCharges = 1;
    step(sane, saneBody, { buttons: Button.Drone }, 1);
    step(junk, junkBody, { buttons: Button.Drone }, 1);

    const noisy = sanitizeInput({
      seq: 2,
      moveX: 999,
      moveZ: 999,
      yaw: Number.POSITIVE_INFINITY,
      pitch: Number.NaN,
      buttons: Button.Jump | (1 << 30),
    });
    const expected = sanitizeInput({
      seq: 2,
      moveX: 1,
      moveZ: 1,
      yaw: 0,
      pitch: 0,
      buttons: Button.Jump,
    });
    stepPlayer(junk, noisy, SIM_DT, junkBody);
    stepPlayer(sane, expected, SIM_DT, saneBody);
    expect(junk.drone!.pos).toEqual(sane.drone!.pos);
    const delta = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(delta(junk.drone!.pos, { x: 0, y: 2.22, z: 0 })).toBeLessThan(DRONE.speed * SIM_DT);
  });

  it('does not launch while traversing', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 4);
    const body = new DroneBody();
    p.droneCharges = 1;
    p.move.traversal = {
      kind: 'mantle',
      t: 0,
      dur: 1,
      from: { x: 0, y: 0, z: 0 },
      path: [{ x: 0, y: 1, z: 0 }],
      to: { x: 0, y: 1, z: 0 },
      dir: { x: 0, z: -1 },
    };
    expect(step(p, body, { buttons: Button.Drone }, 1)).not.toContainEqual({
      type: 'droneLaunched',
    });
    expect(p.droneCharges).toBe(1);
    expect(p.drone).toBeNull();
  });

  it('flies against vehicle hulls on the same path prediction uses', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 12);
    const body = new DroneBody();
    const env = {
      droneWorld: withHulls(clearDroneWorld, [hullAt(9, { x: 0, y: 1, z: -5 }, 0, 0, 0)]),
    };
    p.droneCharges = 1;
    step(p, body, { buttons: Button.Drone }, 1, env);
    expect(p.drone?.alive).toBe(true);

    for (let i = 0; i < 120; i++) step(p, body, { moveZ: 1, yaw: 0, pitch: 0 }, i + 2, env);

    expect(p.drone!.pos.z).toBeGreaterThan(-2.5);
  });
});
