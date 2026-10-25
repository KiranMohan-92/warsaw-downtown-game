import { beforeAll, describe, expect, it } from 'vitest';
import {
  boxMinMax,
  initPhysics,
  PhysicsWorld,
  SIM_DT,
  type MapDefinition,
  type PropHit,
  type PropPose,
} from '@wd/shared';
import { PropSync } from './propSync.ts';

beforeAll(async () => {
  await initPhysics();
});

const TICK_MS = SIM_DT * 1000;
const map = (): MapDefinition => ({
  name: 'props',
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
  boxes: [boxMinMax({ x: -30, y: -1, z: -30 }, { x: 30, y: 0, z: 30 }, 'ground')],
  decor: [
    { kind: 'bin', x: 0, z: 6 },
    { kind: 'drum', x: 4, z: 6 },
  ],
  spawns: [],
  dummies: [],
});
const hitOf = (id: number): PropHit => ({
  id,
  kind: 'knock',
  mass: 15,
  shove: 1,
  into: 8,
  normal: { x: 0, z: -1 },
  vel: { x: 0, y: 0, z: 8 },
  point: { x: 0, y: 0.6, z: 5.7 },
  carried: [],
});
const blank = (): PropPose => ({ pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
const binRay = (w: PhysicsWorld) =>
  w.castRay({ x: 3, y: 0.5, z: 6 }, { x: -1, y: 0, z: 0 }, 3)?.prop;

describe('PropSync (the client side of props trucks break)', () => {
  it("the driver's prediction passes what it broke, until a replay finds it again", () => {
    const sync = new PropSync();
    expect(sync.passed(0)).toBe(false);
    sync.hit(hitOf(0));
    expect(sync.passed(0)).toBe(true);
    sync.replay();
    expect(sync.passed(0)).toBe(false);
  });

  it('server events change the world at once; tumblers interpolate; settled props stand again', () => {
    const physics = new PhysicsWorld(map());
    const sync = new PropSync();
    sync.physics = physics;
    expect(binRay(physics)).toBe(0);
    sync.apply({ type: 'prop', id: 0, k: 'knock', tick: 100, at: { x: 0, y: 0.6, z: 5.7 }, v: 8 });
    expect(binRay(physics)).toBeUndefined(); // movement, bullets and sight pass it now
    const t0 = 100 * TICK_MS;
    sync.snapshot(t0 + 2 * TICK_MS, [[0, 0, 0, 0.1, 7, 0, 0, 0, 1]]);
    sync.snapshot(t0 + 4 * TICK_MS, [[0, 0, 0, 0.1, 8, 0, 0, 0, 1]]);
    // A remote truck's: due at its tick on the draw timeline, drawn between the snapshots.
    expect(sync.takeDue(t0 - 50)).toEqual([]);
    expect(sync.takeDue(t0 + 1).map((s) => s.k)).toEqual(['knock']);
    const pose = blank();
    expect(sync.pose(0, t0 + 3 * TICK_MS, pose)).toBe(true);
    expect(pose.pos.z).toBeCloseTo(7.5, 6);
    expect([...sync.tumbling()]).toEqual([0]);
    // It settles: static there (both sides place exactly these numbers), drawn there for good.
    sync.apply({ type: 'prop', id: 0, k: 'settle', tick: 106, p: [0, 0, 8.5, 0, 0, 0, 1] });
    expect(physics.prop(0)!.pos).toEqual({ x: 0, y: 0, z: 8.5 });
    expect(physics.castRay({ x: 3, y: 0.5, z: 8.5 }, { x: -1, y: 0, z: 0 }, 3)?.prop).toBe(0);
    expect(sync.takeDue(106 * TICK_MS)).toEqual([
      {
        k: 'place',
        id: 0,
        n: 0,
        pose: { pos: { x: 0, y: 0, z: 8.5 }, quat: { x: 0, y: 0, z: 0, w: 1 } },
      },
    ]);
    expect([...sync.tumbling()]).toEqual([]);
  });

  it('an older settle still waiting on the timeline never ends a newer tumble', () => {
    const sync = new PropSync();
    sync.physics = new PhysicsWorld(map());
    const ms = (t: number) => t * TICK_MS;
    sync.apply({ type: 'prop', id: 0, k: 'knock', tick: 100, n: 1 });
    sync.apply({ type: 'prop', id: 0, k: 'settle', tick: 110, n: 1, p: [0, 0, 7, 0, 0, 0, 1] });
    // Knocked again before the old settle is due on the (delayed) draw timeline.
    sync.apply({ type: 'prop', id: 0, k: 'knock', tick: 112, n: 2 });
    sync.snapshot(ms(114), [[0, 2, 0, 0.2, 8, 0, 0, 0, 1]]);
    sync.snapshot(ms(116), [[0, 1, 0, 0, 9, 0, 0, 0, 1]]); // a stale row of the old tumble
    sync.snapshot(ms(118), [[0, 2, 0, 0.2, 9, 0, 0, 0, 1]]);
    expect(sync.takeDue(ms(111)).map((s) => s.k)).toEqual(['knock', 'place']);
    expect([...sync.tumbling()]).toEqual([]); // at rest on this timeline
    expect(sync.takeDue(ms(113)).map((s) => s.k)).toEqual(['knock']);
    expect([...sync.tumbling()]).toEqual([0]);
    const pose = blank();
    expect(sync.pose(0, ms(116), pose)).toBe(true);
    expect(pose.pos.z).toBeCloseTo(8.5, 6);
  });

  it('a new knock waits for its turn: the older tumble plays out until then', () => {
    const sync = new PropSync();
    sync.physics = new PhysicsWorld(map());
    const ms = (t: number) => t * TICK_MS;
    sync.apply({ type: 'prop', id: 0, k: 'knock', tick: 100, n: 1 });
    sync.snapshot(ms(102), [[0, 1, 0, 0, 7, 0, 0, 0, 1]]);
    sync.snapshot(ms(104), [[0, 1, 0, 0, 8, 0, 0, 0, 1]]);
    expect(sync.takeDue(ms(101)).map((s) => s.k)).toEqual(['knock']);
    // The server's later news: it settled, and was knocked again (both still ahead of the draw).
    sync.apply({ type: 'prop', id: 0, k: 'settle', tick: 106, n: 1, p: [0, 0, 8.5, 0, 0, 0, 1] });
    sync.apply({ type: 'prop', id: 0, k: 'knock', tick: 108, n: 2 });
    sync.snapshot(ms(110), [[0, 2, 0, 0.3, 9, 0, 0, 0, 1]]);
    const pose = blank();
    expect(sync.pose(0, ms(103), pose)).toBe(true); // the first tumble, not frozen
    expect(pose.pos.z).toBeCloseTo(7.5, 6);
    expect(sync.takeDue(ms(107)).map((s) => s.k)).toEqual(['place']);
    expect(sync.takeDue(ms(109)).map((s) => s.k)).toEqual(['knock']);
    expect(sync.pose(0, ms(110), pose)).toBe(true); // now the second
    expect(pose.pos.z).toBeCloseTo(9, 6);
  });

  it("this client's own truck's breaks show at once, not on the remote timeline", () => {
    const sync = new PropSync();
    sync.physics = new PhysicsWorld(map());
    sync.hit(hitOf(1));
    sync.apply({ type: 'prop', id: 1, k: 'smash', tick: 500 });
    expect(sync.takeDue(0).map((s) => s.k)).toEqual(['hide']);
  });

  it('a restore (late join, reconnect) starts from the map, then replays what changed', () => {
    const physics = new PhysicsWorld(map());
    const sync = new PropSync();
    sync.physics = physics;
    // Stale from before (an older match): the drum was smashed.
    sync.apply({ type: 'prop', id: 1, k: 'smash', tick: 5 });
    expect(physics.propState(1)).toBe('gone');
    sync.apply({ type: 'propsReset' });
    sync.apply({ type: 'prop', id: 0, k: 'gone', tick: 9, quiet: true });
    expect(physics.propState(1)).toBe('static');
    expect(physics.propState(0)).toBe('gone');
    expect(sync.takeDue(9 * TICK_MS)).toEqual([
      { k: 'reset' },
      { k: 'hide', id: 0, n: 0, at: undefined, v: undefined, quiet: true },
    ]);
  });

  it('ignores malformed events and snapshot entries (untrusted wire data)', () => {
    const physics = new PhysicsWorld(map());
    const sync = new PropSync();
    sync.physics = physics;
    sync.apply({ type: 'prop', id: 99, k: 'smash', tick: 1 });
    sync.apply({ type: 'prop', id: -1, k: 'smash', tick: 1 });
    sync.apply({ type: 'prop', id: 0, k: 'settle', tick: 1, p: [0, Number.NaN, 0, 0, 0, 0, 1] });
    sync.snapshot(0, [[0, 1, 2], null as unknown as number[]]);
    expect(physics.propState(0)).toBe('static');
    expect(sync.takeDue(Number.POSITIVE_INFINITY)).toEqual([]);
  });
});
