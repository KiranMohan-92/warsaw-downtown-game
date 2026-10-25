import { describe, expect, it } from 'vitest';
import { MOVEMENT, SKATEBOARD } from '../config/tunables.ts';
import { Button, emptyInput, type PlayerInput } from './input.ts';
import { computeVelocity, createMoveState } from './movement.ts';
import { createBoard, stepBoard } from './skateboard.ts';

const at = (x: number, z: number, y = 0) => ({ x, y, z });
const mods = { adsAmount: 0, sprintBlocked: false };

describe('skateboard rules', () => {
  it('goes to the first eligible living player in reach, then follows them', () => {
    const b = createBoard(at(0, 0));
    const players = [
      { id: 'bot', pos: at(0.2, 0), alive: true, eligible: false },
      { id: 'dead', pos: at(0.1, 0), alive: false },
      { id: 'far', pos: at(3, 0), alive: true },
      { id: 'a', pos: at(0.5, 0.5), alive: true },
    ];
    expect(stepBoard(b, players)).toEqual([{ type: 'pickup', by: 'a' }]);
    players[3]!.pos = at(10, 4);
    expect(stepBoard(b, players)).toEqual([]);
    expect(b.pos).toEqual(at(10, 4));
  });

  it('drops where the rider died, and someone else can take it', () => {
    const b = createBoard(at(0, 0));
    const a = { id: 'a', pos: at(0, 0), alive: true };
    const c = { id: 'c', pos: at(30, 0), alive: true };
    stepBoard(b, [a, c]);
    a.pos = at(12, -3);
    stepBoard(b, [a, c]);
    a.alive = false;
    expect(stepBoard(b, [a, c])).toEqual([{ type: 'drop', by: 'a', pos: at(12, -3) }]);
    expect(b.rider).toBeNull();
    c.pos = at(12.4, -3);
    expect(stepBoard(b, [a, c])).toEqual([{ type: 'pickup', by: 'c' }]);
  });

  it('drops at the last spot when the rider leaves the match', () => {
    const b = createBoard(at(0, 0));
    stepBoard(b, [{ id: 'a', pos: at(0, 0), alive: true }]);
    stepBoard(b, [{ id: 'a', pos: at(5, 5), alive: true }]);
    expect(stepBoard(b, [])).toEqual([{ type: 'drop', by: 'a', pos: at(5, 5) }]);
  });

  it('is not picked up by a player crawling prone (you ride it standing)', () => {
    const b = createBoard(at(0, 0));
    const a = { id: 'a', pos: at(0.2, 0), alive: true, prone: true };
    expect(stepBoard(b, [a])).toEqual([]);
    a.prone = false;
    expect(stepBoard(b, [a])).toEqual([{ type: 'pickup', by: 'a' }]);
  });

  it('respects the floor: no pickup from a storey above', () => {
    const b = createBoard(at(0, 0));
    expect(stepBoard(b, [{ id: 'a', pos: at(0, 0, 4), alive: true }])).toEqual([]);
  });
});

describe('skateboard physics', () => {
  const ride = (input: Partial<PlayerInput>, seconds: number, s = createMoveState(at(0, 0))) => {
    s.board = true;
    s.grounded = true;
    const i = { ...emptyInput(), ...input };
    for (let n = Math.round(seconds * 60); n > 0; n--) computeVelocity(s, i, 0, 1 / 60, mods);
    return s;
  };
  const speed = (s: { vel: { x: number; z: number } }) => Math.hypot(s.vel.x, s.vel.z);

  it('pushes up to a cruise well above a sprint, and coasts', () => {
    const s = ride({ moveZ: 1 }, 3);
    expect(speed(s)).toBeCloseTo(SKATEBOARD.cruiseSpeed, 3);
    expect(SKATEBOARD.cruiseSpeed).toBeGreaterThan(MOVEMENT.sprintSpeed);
    ride({ moveZ: 0 }, 1, s);
    expect(speed(s)).toBeGreaterThan(SKATEBOARD.cruiseSpeed - 1.5);
    ride({ moveZ: -1 }, 1.5, s);
    expect(speed(s)).toBe(0);
  });

  it('carves toward the view instead of strafing, and never sprints or crouches', () => {
    const s = ride({ moveZ: 1, yaw: 0 }, 2);
    const h0 = Math.atan2(s.vel.x, s.vel.z);
    ride({ moveZ: 1, yaw: Math.PI / 2, buttons: Button.Sprint }, 0.1, s);
    const h1 = Math.atan2(s.vel.x, s.vel.z);
    const turned = Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)));
    // Grip-limited at cruise: ~lateralAccel / speed rad/s, not the low-speed pivot rate.
    expect(turned).toBeGreaterThan(0.05);
    expect(turned).toBeLessThan((SKATEBOARD.lateralAccel / SKATEBOARD.cruiseSpeed) * 0.1 * 1.05);
    expect(s.sprinting).toBe(false);
    expect(s.lowRun).toBe(false);
  });
});

describe('skateboard on the wire', () => {
  it('sends the rider flag, and a missed grant forces a correction', async () => {
    const { createPlayerState } = await import('./player.ts');
    const { applySnapshotMove, snapshotError, toSnapshotPlayer } =
      await import('../net/snapshot.ts');
    const server = createPlayerState(at(3, 4));
    server.move.board = true;
    const snap = toSnapshotPlayer('me', server, 1, 0);
    const client = createPlayerState(at(3, 4));
    expect(snapshotError(client, snap)).toBe(Infinity);
    applySnapshotMove(client, snap);
    expect(client.move.board).toBe(true);
    expect(snapshotError(client, snap)).toBeLessThan(1e-6);
  });
});
