import { beforeAll, describe, expect, it } from 'vitest';
import { block, boxMinMax, initPhysics, PhysicsWorld, WHEELS, type WorldHit } from '@wd/shared';
import {
  DEFAULT_LAUNCH,
  FRONT_AHEAD,
  FRONT_LAUNCH,
  FRONT_LEFT,
  TyreDemoRun,
  frontStart,
  tyreDemoPhase,
} from './tyreDemo.ts';
import { TyreFx } from './tyreFx.ts';

beforeAll(async () => {
  await initPhysics();
});

const world = (extra: ReturnType<typeof block>[] = []): PhysicsWorld =>
  new PhysicsWorld({
    name: 'demo',
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    boxes: [boxMinMax({ x: -100, y: -1, z: -100 }, { x: 100, y: 0, z: 100 }, 'paving'), ...extra],
    spawns: [],
    dummies: [],
  });

describe('tyre demo', () => {
  it('runs its phases in order and ends', () => {
    const order = [0, 1, 2, 2.6, 3.4, 4.2, 5, 6, 8].map((t) => tyreDemoPhase(t, 1.9));
    expect(order).toEqual([
      'launch',
      'launch',
      'drift',
      'drift',
      'straighten',
      'brake',
      'brake',
      'coast',
      'done',
    ]);
  });

  it('starts ahead-left of the camera and heads to its right, at any view heading', () => {
    for (const a of [0, 0.8, 2.5, -2]) {
      const forward = { x: Math.sin(a), z: -Math.cos(a) };
      const cam = { x: 5, z: -7 };
      const s = frontStart(cam, forward);
      const dx = s.x - cam.x;
      const dz = s.z - cam.z;
      const right = { x: -forward.z, z: forward.x };
      expect(dx * forward.x + dz * forward.z).toBeCloseTo(FRONT_AHEAD);
      expect(dx * right.x + dz * right.z).toBeCloseTo(-FRONT_LEFT);
      expect(Math.sin(s.yaw)).toBeCloseTo(right.x);
      expect(Math.cos(s.yaw)).toBeCloseTo(right.z);
    }
  });

  it('crosses the view: the drift starts near the middle of the screen', () => {
    const cam = { x: 0, z: 0 };
    const forward = { x: 0, z: -1 };
    const s = frontStart(cam, forward);
    const run = new TyreDemoRun(s.x, 0, s.z, s.yaw, FRONT_LAUNCH);
    const w = world();
    while (run.phase === 'launch') run.step(1 / 60, w);
    // Right of the view = +x here; the start was 10 m left.
    expect(Math.abs(run.motion.pos.x)).toBeLessThan(4);
    expect(run.blocked).toBe(false);
  });

  it('kicks up dust and lays marks through its whole script on open ground', () => {
    const w = world();
    const run = new TyreDemoRun(0, 0, -60, 0, DEFAULT_LAUNCH);
    const fx = new TyreFx(() => 0.5);
    const seen = new Set<string>();
    let skidsAtDrift = 0;
    for (let f = 0; f < 60 * 12 && run.phase !== 'done'; f++) {
      run.step(1 / 60, w);
      const contacts: (WorldHit | null)[] = WHEELS.map(() =>
        w.castRay({ ...run.motion.pos, y: run.motion.pos.y + 1 }, { x: 0, y: -1, z: 0 }, 3),
      );
      fx.truck(1, run.motion, true, contacts, 1 / 60);
      fx.update(1 / 60);
      seen.add(run.phase);
      if (run.phase === 'drift') skidsAtDrift = fx.stats().skids;
    }
    expect([...seen]).toEqual(['launch', 'drift', 'straighten', 'brake', 'coast', 'done']);
    expect(run.blocked).toBe(false);
    expect(skidsAtDrift).toBeGreaterThan(0);
    expect(fx.stats().skids).toBeGreaterThan(skidsAtDrift); // the brake laid more
    expect(run.state()).toMatchObject({ phase: 'done', blocked: false });
  });

  it('reports a run blocked by a wall', () => {
    const w = world([block(0, -50, 0, 10, 3, 1, 'concrete')]);
    const run = new TyreDemoRun(0, 0, -60, 0);
    for (let f = 0; f < 60 * 4; f++) run.step(1 / 60, w);
    expect(run.state().blocked).toBe(true);
    expect(run.state().speed).toBeLessThan(2);
  });
});
