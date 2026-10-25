import { beforeAll, describe, expect, it } from 'vitest';
import {
  bodyOverlaps,
  boxMinMax,
  cartonPallets,
  createVehicleMotion,
  hullObstacle,
  initPhysics,
  motionError,
  PhysicsWorld,
  propPoseFromWire,
  SIM_DT,
  stepVehicle,
  type CombatEvent,
  type MapDefinition,
  type PropHit,
} from '@wd/shared';
import { isPropEvent, PropSync } from '../../../client/src/net/propSync.ts';
import { MatchSim } from './MatchSim.ts';
import { MatchProps } from './props.ts';

beforeAll(async () => {
  await initPhysics();
});

/** A street with a bin, a drum and a carton stack on the truck's line, and a bin beside it. */
const street = (): MapDefinition => ({
  name: 'props',
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  boxes: [boxMinMax({ x: -40, y: -1, z: -40 }, { x: 40, y: 0, z: 40 }, 'ground')],
  decor: [
    { kind: 'bin', x: 0, z: 6 },
    { kind: 'drum', x: 0.6, z: 11 },
    { kind: 'cardboard', x: -0.4, z: 16 },
    { kind: 'bin', x: 8, z: 6 },
  ],
  spawns: [],
  dummies: [],
});

/** A truck driven through the street at full throttle on `world` with the match's props. */
function run(world: PhysicsWorld, events: CombatEvent[], ticks: number): MatchProps {
  let tick = 0;
  const props = new MatchProps(
    world,
    (e) => events.push(e),
    () => tick,
  );
  const m = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
  for (; tick < ticks; tick++) {
    stepVehicle(m, { throttle: 1, steer: 0, handbrake: false }, SIM_DT, world, [], 1, props);
    props.step();
  }
  return props;
}

const ofKind = (events: CombatEvent[], k: string): number[] =>
  events.flatMap((e) => (e.type === 'prop' && e.k === k ? [e.id] : []));

describe('MatchProps (server-owned prop state)', () => {
  it('a truck knocks and smashes what it hits; tumblers stream in snapshots, then settle', () => {
    const world = new PhysicsWorld(street());
    const events: CombatEvent[] = [];
    let streamed = false;
    let tick = 0;
    const props = new MatchProps(
      world,
      (e) => events.push(e),
      () => tick,
    );
    const m = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
    for (; tick < 600; tick++) {
      stepVehicle(m, { throttle: 1, steer: 0, handbrake: false }, SIM_DT, world, [], 1, props);
      props.step();
      const snap = props.snapshot();
      if (snap?.some((p) => p[0] === 0)) streamed = true;
    }
    expect(m.pos.z).toBeGreaterThan(20); // through all of it
    expect(ofKind(events, 'knock')).toEqual(expect.arrayContaining([0, 1]));
    expect(ofKind(events, 'smash').length).toBeGreaterThan(0);
    expect(streamed).toBe(true);
    // Everything knocked came to rest, where the settle event says; the bin aside is untouched.
    expect(props.snapshot()).toBeUndefined();
    for (const id of ofKind(events, 'knock')) {
      const settle = events.findLast((e) => e.type === 'prop' && e.id === id && e.k === 'settle');
      expect(settle, `prop ${id}`).toBeDefined();
      const pose = propPoseFromWire(settle?.type === 'prop' ? settle.p : undefined)!;
      expect(world.prop(id)!.pos).toEqual(pose.pos);
      expect(world.propState(id)).toBe('static');
    }
    expect(world.propChanged(4)).toBe(false);
  });

  it('a late joiner (or a reconnect with stale props) ends up with the same world', () => {
    const world = new PhysicsWorld(street());
    const events: CombatEvent[] = [];
    // Mid-way: some settled, maybe some still tumbling.
    const props = run(world, events, 140);
    // The joiner's own world, from before (an older match smashed the far bin).
    const client = new PhysicsWorld(street());
    client.removeProp(4);
    const sync = new PropSync();
    sync.physics = client;
    for (const e of props.restore()) if (isPropEvent(e)) sync.apply(e);
    for (let id = 0; id < world.propCount; id++) {
      const server = world.propState(id);
      // A tumbling prop has no static colliders on either side.
      expect(client.propState(id), `prop ${id}`).toBe(server === 'moving' ? 'gone' : server);
      if (server === 'static') expect(client.prop(id)).toEqual(world.prop(id));
    }
    // Rays agree everywhere along the street.
    for (let z = -2; z < 24; z += 0.5) {
      const ray = (w: PhysicsWorld) =>
        w.castRay({ x: 3, y: 0.3, z }, { x: -1, y: 0, z: 0 }, 6)?.distance ?? null;
      expect(ray(client), `z ${z}`).toBe(ray(world));
    }
  });

  it("the driver's prediction breaks through exactly as the server does (shared data)", () => {
    const world = new PhysicsWorld(street());
    const client = new PhysicsWorld(street());
    const events: CombatEvent[] = [];
    let tick = 0;
    const props = new MatchProps(
      world,
      (e) => events.push(e),
      () => tick,
    );
    const sync = new PropSync();
    sync.physics = client;
    const server = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
    const predicted = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
    const controls = { throttle: 1, steer: 0.08, handbrake: false };
    let worst = 0;
    for (; tick < 240; tick++) {
      // The client predicts ahead of the server's events (they arrive after the tick).
      stepVehicle(predicted, controls, SIM_DT, client, [], 1, sync);
      stepVehicle(server, controls, SIM_DT, world, [], 1, props);
      props.step();
      for (const e of events.splice(0)) if (isPropEvent(e)) sync.apply(e);
      worst = Math.max(worst, motionError(server, predicted));
    }
    expect(ofKind(events, 'knock').length + props.restore().length).toBeGreaterThan(1);
    expect(worst).toBeLessThan(1e-9);
  });

  it.each([
    [
      'a field of props',
      Array.from({ length: 60 }, (_, i) => ({
        kind: (['bin', 'drum', 'cardboard', 'tyres', 'trashbag', 'utilityBox'] as const)[i % 6]!,
        x: ((i * 7) % 11) - 5,
        z: 4 + i * 0.55,
      })),
      0.6,
      [],
    ],
    [
      // Pallets of stacked cartons (the Market's back-stock): the upper layers go with the lower
      // ones on the server without a truck hit of their own.
      'carton pallets',
      [] as MapDefinition['decor'] & object,
      0.05,
      [0, 4, 8, 12].flatMap((z) => cartonPallets({ x: -0.6, z: 6 + z })),
    ],
  ])('drivers mispredict nothing through %s at 85 ms each way', (_, decor, weave, boxes) => {
    const base = street();
    const yard: MapDefinition = { ...base, decor, boxes: [...base.boxes, ...boxes] };
    const world = new PhysicsWorld(yard);
    const client = new PhysicsWorld(yard);
    const L = 5; // ticks each way
    const events: CombatEvent[] = [];
    let tick = 0;
    const props = new MatchProps(
      world,
      (e) => events.push(e),
      () => tick,
    );
    const sync = new PropSync();
    sync.physics = client;
    const controls = (i: number) => ({
      throttle: 1,
      steer: Math.sin(i / 25) * weave,
      handbrake: false,
    });
    const server = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
    let predicted = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
    const history: ReturnType<typeof createVehicleMotion>[] = [];
    const inbox: { at: number; events: CombatEvent[]; ack: number; motion: typeof server }[] = [];
    let corrections = 0;
    let hits = 0;
    for (tick = 0; tick < 420; tick++) {
      // Client: predict input `tick`.
      stepVehicle(predicted, controls(tick), SIM_DT, client, [], 1, sync);
      history[tick] = { ...predicted, pos: { ...predicted.pos }, vel: { ...predicted.vel } };
      // Server: input `tick - L` arrives now; its events and state reach the client L later.
      const i = tick - L;
      if (i >= 0) {
        stepVehicle(server, controls(i), SIM_DT, world, [], 1, props);
        props.step();
        hits += events.filter((e) => e.type === 'prop' && e.k !== 'settle').length;
        inbox.push({
          at: tick + L,
          events: events.splice(0),
          ack: i,
          motion: { ...server, pos: { ...server.pos }, vel: { ...server.vel } },
        });
      }
      // Client: deliveries due (events before the snapshot, as the room sends them).
      while (inbox.length && inbox[0]!.at <= tick) {
        const d = inbox.shift()!;
        for (const e of d.events) if (isPropEvent(e)) sync.apply(e);
        if (motionError(history[d.ack]!, d.motion) <= 1e-6) continue;
        corrections++;
        sync.replay();
        predicted = { ...d.motion, pos: { ...d.motion.pos }, vel: { ...d.motion.vel } };
        for (let j = d.ack + 1; j <= tick; j++) {
          stepVehicle(predicted, controls(j), SIM_DT, client, [], 1, sync);
          history[j] = { ...predicted, pos: { ...predicted.pos }, vel: { ...predicted.vel } };
        }
      }
    }
    expect(hits).toBeGreaterThan(5);
    expect(corrections).toBe(0);
  });

  it('delays a settle event that would become solid inside the driver hull', () => {
    const blocker = createVehicleMotion({ x: 0.6, y: 0, z: 11 }, 0);
    const world = new PhysicsWorld(street());
    const events: CombatEvent[] = [];
    let tick = 0;
    const props = new MatchProps(
      world,
      (e) => events.push(e),
      () => tick,
      () => [hullObstacle(1, blocker.pos, blocker.yaw)],
    );
    props.hit({
      id: 1,
      kind: 'knock',
      mass: 60,
      shove: 1,
      into: 5,
      normal: { x: 0, z: -1 },
      vel: { x: 0, y: 0, z: 0 },
      point: { x: 0.6, y: 0.5, z: 11 },
      carried: [],
    });

    // Past maxTumble: without a vehicle occupancy guard this would settle inside the truck.
    for (; tick < 320; tick++) props.step();
    expect(world.propState(1)).toBe('moving');
    expect(events.some((e) => e.type === 'prop' && e.id === 1 && e.k === 'settle')).toBe(false);

    blocker.pos.x = 8;
    for (; tick < 420 && world.propState(1) === 'moving'; tick++) props.step();
    expect(world.propState(1)).toBe('static');
    expect(events.some((e) => e.type === 'prop' && e.id === 1 && e.k === 'settle')).toBe(true);
  });

  it('drivers stay in sync when a delayed settle would otherwise appear under the truck', () => {
    const world = new PhysicsWorld(street());
    const client = new PhysicsWorld(street());
    const events: CombatEvent[] = [];
    let tick = 0;
    const props = new MatchProps(
      world,
      (e) => events.push(e),
      () => tick,
    );
    const sync = new PropSync();
    sync.physics = client;
    const controls = (i: number) => ({
      throttle: i < 90 ? 1 : 0,
      steer: 0,
      handbrake: false,
    });
    const server = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
    let predicted = createVehicleMotion({ x: 0, y: 0, z: -6 }, 0);
    const latency = 5;
    const history: ReturnType<typeof createVehicleMotion>[] = [];
    const inbox: { at: number; events: CombatEvent[]; ack: number; motion: typeof server }[] = [];
    let corrections = 0;
    let settleInsideDriver = false;

    for (tick = 0; tick < 360; tick++) {
      stepVehicle(predicted, controls(tick), SIM_DT, client, [], 1, sync);
      history[tick] = { ...predicted, pos: { ...predicted.pos }, vel: { ...predicted.vel } };

      const i = tick - latency;
      if (i >= 0) {
        stepVehicle(server, controls(i), SIM_DT, world, [], 1, props);
        props.step();
        const delivered = events.splice(0);
        if (
          delivered.some((e) => e.type === 'prop' && e.k === 'settle') &&
          bodyOverlaps(world, server.pos, server.yaw, server.pitch, server.roll)
        )
          settleInsideDriver = true;
        inbox.push({
          at: tick + latency,
          events: delivered,
          ack: i,
          motion: { ...server, pos: { ...server.pos }, vel: { ...server.vel } },
        });
      }

      while (inbox.length && inbox[0]!.at <= tick) {
        const d = inbox.shift()!;
        for (const e of d.events) if (isPropEvent(e)) sync.apply(e);
        if (motionError(history[d.ack]!, d.motion) <= 1e-6) continue;
        corrections++;
        sync.replay();
        predicted = { ...d.motion, pos: { ...d.motion.pos }, vel: { ...d.motion.vel } };
        for (let j = d.ack + 1; j <= tick; j++) {
          stepVehicle(predicted, controls(j), SIM_DT, client, [], 1, sync);
          history[j] = { ...predicted, pos: { ...predicted.pos }, vel: { ...predicted.vel } };
        }
      }
    }

    expect(settleInsideDriver).toBe(false);
    expect(corrections).toBe(0);
  });

  it("validates nothing from clients: there's no client path; a stale hit is a no-op", () => {
    const world = new PhysicsWorld(street());
    const events: CombatEvent[] = [];
    const props = new MatchProps(
      world,
      (e) => events.push(e),
      () => 0,
    );
    const hit: PropHit = {
      id: 0,
      kind: 'smash',
      mass: 15,
      shove: 1,
      into: 5,
      normal: { x: 0, z: -1 },
      vel: { x: 0, y: 0, z: 5 },
      point: { x: 0, y: 0.5, z: 5.7 },
      carried: [],
    };
    props.hit(hit);
    props.hit(hit); // already gone: nothing more
    props.hit({ ...hit, id: 999 });
    expect(ofKind(events, 'smash')).toEqual([0]);
  });

  it('a carton stack bursts as one; a knocked prop takes what stood on it down with it', () => {
    const world = new PhysicsWorld({
      ...street(),
      decor: [
        { kind: 'cardboard', x: 0, z: 6 },
        { kind: 'tyres', x: 4, z: 6 },
      ],
    });
    const events: CombatEvent[] = [];
    const props = new MatchProps(
      world,
      (e) => events.push(e),
      () => 0,
    );
    const hit = (id: number, kind: 'smash' | 'knock'): PropHit => ({
      id,
      kind,
      mass: 10,
      shove: 1,
      into: 6,
      normal: { x: 0, z: -1 },
      vel: { x: 0, y: 0, z: 6 },
      point: { ...world.prop(id)!.pos },
      carried: [],
    });
    props.hit(hit(0, 'smash')); // the bottom carton
    expect(ofKind(events, 'smash')).toEqual([0, 1]);
    props.hit(hit(2, 'knock')); // the bottom tyre: the two above fall
    expect(ofKind(events, 'knock')).toEqual([2, 3, 4]);
    expect([2, 3, 4].map((id) => world.propState(id))).toEqual(['moving', 'moving', 'moving']);
  });
});

describe('props in the match', () => {
  it('persist through the match, ride the snapshots, and are all back for the next one', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', timeLimit: 1 });
    sim.addPlayer('a', 'A', 0);
    const hit: PropHit = {
      id: 0,
      kind: 'knock',
      mass: 45,
      shove: 1,
      into: 6,
      normal: { x: 0, z: -1 },
      vel: { x: 0, y: 0, z: 6 },
      point: { ...sim.physics.prop(0)!.pos },
      carried: [],
    };
    sim.props.hit(hit);
    sim.props.hit({ ...hit, id: 1, kind: 'smash' });
    sim.step();
    // (Crates stacked on the knocked one fall with it.)
    expect(sim.snapshot('a').props?.map((p) => p[0])).toContain(0);
    let guard = 0;
    while (sim.physics.movingProps().length && guard++ < 600) sim.step();
    expect(sim.physics.propChanged(0)).toBe(true);
    expect(sim.physics.propState(1)).toBe('gone');
    expect(sim.snapshot('a').props).toBeUndefined();
    let events = sim.drainEvents().filter(isPropEvent);
    const kinds = events.map((e) => (e.type === 'prop' ? `${e.k}:${e.id}` : e.type));
    expect(kinds.slice(0, 1)).toEqual(['knock:0']);
    expect(kinds).toEqual(expect.arrayContaining(['smash:1', 'settle:0']));
    // Through the rest of the match and the results: still so.
    while (sim.phase === 'playing' && guard++ < 2000) sim.step();
    expect(sim.physics.propState(1)).toBe('gone');
    sim.drainEvents();
    while (sim.phase !== 'playing' && guard++ < 4000) sim.step();
    // A new match: every prop home, and the clients are told.
    events = sim.drainEvents().filter(isPropEvent);
    expect(events).toContainEqual({ type: 'propsReset' });
    for (let id = 0; id < sim.physics.propCount; id++)
      expect(sim.physics.propChanged(id)).toBe(false);
    sim.dispose();
  });
});
