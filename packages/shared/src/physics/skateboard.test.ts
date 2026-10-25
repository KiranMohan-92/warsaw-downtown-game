import { beforeAll, describe, expect, it } from 'vitest';
import { SKATEBOARD } from '../config/tunables.ts';
import { block, boxMinMax, ramp } from '../maps/builder.ts';
import type { MapBox, MapDefinition } from '../maps/types.ts';
import { Button } from '../sim/input.ts';
import { createPlayerState, type PlayerState } from '../sim/player.ts';
import { run } from '../sim/testUtils.ts';
import { initPhysics, PhysicsWorld } from './world.ts';

beforeAll(async () => {
  await initPhysics();
});

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'board',
  bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 },
  boxes: [boxMinMax({ x: -80, y: -1, z: -80 }, { x: 80, y: 0, z: 80 }, 'ground'), ...boxes],
  spawns: [],
  dummies: [],
});

/** A rider on the board, facing -Z (yaw 0), settled on the ground. */
function rider(boxes: MapBox[], at = { x: 0, y: 0.05, z: 0 }) {
  const world = new PhysicsWorld(mapOf(boxes));
  const p = createPlayerState(at);
  const body = world.createCharacter(at);
  run(p, body, 0.3, {});
  p.move.board = true;
  return { p, body };
}
const speed = (p: PlayerState) => Math.hypot(p.move.vel.x, p.move.vel.z);
const heading = (p: PlayerState) => Math.atan2(p.move.vel.x, p.move.vel.z);

describe('skateboard handling (real physics)', () => {
  it('stops dead on a wall head-on, and scrapes speed off along a glancing wall', () => {
    const head = rider([block(0, -30, 0, 10, 3, 1, 'concrete')]);
    run(head.p, head.body, 5, { moveZ: 1 });
    expect(speed(head.p)).toBeLessThan(0.1);
    const glance = rider([
      { ...block(0, -20, 0, 40, 3, 1, 'concrete'), rot: { x: 0, y: 45, z: 0 } },
    ]);
    run(glance.p, glance.body, 2.5, { moveZ: 1 });
    run(glance.p, glance.body, 1.5, {}); // coasting along the wall
    expect(speed(glance.p)).toBeLessThan(SKATEBOARD.cruiseSpeed * 0.6);
  });

  it('rolls over a kerb with a bump but needs an ollie for a ledge', () => {
    const kerb = rider([block(0, -30, 0, 10, 0.1, 40, 'concrete')]);
    run(kerb.p, kerb.body, 4, { moveZ: 1 });
    expect(kerb.p.move.pos.y).toBeGreaterThan(0.08);
    const ledge = rider([block(0, -30, 0, 10, 0.45, 40, 'concrete')]);
    run(ledge.p, ledge.body, 4, { moveZ: 1 });
    expect(ledge.p.move.pos.y).toBeLessThan(0.1); // blocked
    const ollie = rider([block(0, -30, 0, 10, 0.45, 40, 'concrete')]);
    run(ollie.p, ollie.body, 2.1, { moveZ: 1 });
    run(ollie.p, ollie.body, 1 / 60, { moveZ: 1, buttons: Button.Jump });
    run(ollie.p, ollie.body, 1.5, { moveZ: 1 });
    expect(ollie.p.move.pos.y).toBeGreaterThan(0.4); // on top
  });

  it('speeds up downhill and slows uphill without pushing', () => {
    // Downhill: a ramp rising toward +z; start at its top rolling -z.
    const down = rider([ramp({ x: 0, y: 0, z: -30 }, '+z', 20, 3, 6, 'concrete')], {
      x: 0,
      y: 3.1,
      z: -11,
    });
    run(down.p, down.body, 0.6, { moveZ: 1 });
    const top = speed(down.p);
    run(down.p, down.body, 1.2, {});
    expect(speed(down.p)).toBeGreaterThan(top + 1);
    // Uphill: coast into a ramp rising toward -z.
    const up = rider([ramp({ x: 0, y: 0, z: -12 }, '-z', 20, 3, 6, 'concrete')]);
    run(up.p, up.body, 1.6, { moveZ: 1 });
    run(up.p, up.body, 1.6, {});
    const flatCoast = rider([]);
    run(flatCoast.p, flatCoast.body, 1.6, { moveZ: 1 });
    run(flatCoast.p, flatCoast.body, 1.6, {});
    expect(speed(up.p)).toBeLessThan(speed(flatCoast.p) - 1);
  });

  it('carves wide at speed, tight when slow; A/D carve; coasting lets you look away', () => {
    const fast = rider([]);
    run(fast.p, fast.body, 3, { moveZ: 1, yaw: 0 });
    const h0 = heading(fast.p);
    run(fast.p, fast.body, 0.5, { moveZ: 1, yaw: Math.PI / 2 });
    const fastTurn = Math.abs(
      Math.atan2(Math.sin(heading(fast.p) - h0), Math.cos(heading(fast.p) - h0)),
    );
    expect(fastTurn).toBeLessThan((SKATEBOARD.lateralAccel / SKATEBOARD.cruiseSpeed) * 0.5 * 1.05);
    // Coasting: look 90° away — the board keeps its line.
    const coast = rider([]);
    run(coast.p, coast.body, 3, { moveZ: 1, yaw: 0 });
    const c0 = heading(coast.p);
    run(coast.p, coast.body, 0.5, { yaw: Math.PI / 2 });
    expect(Math.abs(heading(coast.p) - c0)).toBeLessThan(1e-3);
    // Strafe keys carve while coasting (right = clockwise from above).
    run(coast.p, coast.body, 0.5, { moveX: 1, yaw: Math.PI / 2 });
    const d = Math.atan2(Math.sin(heading(coast.p) - c0), Math.cos(heading(coast.p) - c0));
    expect(d).toBeLessThan(-0.2);
  });

  it('lands a drop at speed and rolls on', () => {
    const { p, body } = rider([block(0, 0, 0, 10, 1.5, 20, 'concrete')], { x: 0, y: 1.55, z: 5 });
    run(p, body, 3, { moveZ: 1 });
    expect(p.move.grounded).toBe(true);
    expect(p.move.pos.y).toBeLessThan(0.1);
    expect(speed(p)).toBeGreaterThan(SKATEBOARD.cruiseSpeed * 0.9);
  });
});
