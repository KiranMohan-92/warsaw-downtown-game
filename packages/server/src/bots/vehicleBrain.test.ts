import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOT,
  Button,
  emptyInput,
  initPhysics,
  JETPACK,
  JetMode,
  SIM_DT,
  type Vec3,
} from '@wd/shared';
import { MatchSim, type ServerPlayer } from '../match/MatchSim.ts';
import { pursuitPoint, VehicleBrain, walkRound } from './vehicleBrain.ts';
import type { BotObservation, BotVehicleView } from './types.ts';

beforeAll(async () => {
  await initPhysics();
});

/** The range street with one truck at its south end, facing north, open road ahead. */
const range = (bots: number, spawnSeed?: number): MatchSim =>
  new MatchSim({
    map: 'range',
    size: 'full',
    mode: 'standard',
    botCount: bots,
    spawnProtection: 0,
    ...(spawnSeed !== undefined ? { spawnSeed } : {}),
    vehicleSpawns: [{ x: 0, z: -50, yaw: 0 }],
  });

function place(p: ServerPlayer, at: Vec3): void {
  p.body.setPosition(at);
  p.state.move.pos = { ...at };
  p.state.move.vel = { x: 0, y: 0, z: 0 };
}

/** Step the match `seconds`, the human sending `input` each tick. */
function run(sim: MatchSim, human: ServerPlayer, seconds: number, buttons = 0, moveZ = 0): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    sim.receiveInputs(human.id, [{ ...emptyInput(human.lastSeq + 1), buttons, moveZ }], sim.nowMs);
    sim.step();
  }
}

describe('bots and trucks (real MatchSim, the bots’ own input path)', () => {
  it('a rusher beside a free truck takes the wheel and drives off', () => {
    const sim = range(1);
    const human = sim.addPlayer('h', 'H', 0);
    const bot = [...sim.players.values()].find((p) => p.bot)!;
    expect(sim.bots.personalities.get(bot.id)).toBe('rusher');
    place(human, { x: 0, y: 0.02, z: 50 }); // far up the street
    place(bot, { x: 3, y: 0.02, z: -50 }); // at the driver's door
    let seated = -1;
    for (let t = 0; t < 4 / SIM_DT && seated < 0; t++) {
      run(sim, human, SIM_DT);
      if (bot.state.seat?.seat === 'driver') seated = t;
    }
    expect(seated).toBeGreaterThanOrEqual(0);
    const start = { ...sim.vehicles.get(1)!.motion.pos };
    run(sim, human, 8);
    const m = sim.vehicles.get(1)!.motion.pos;
    expect(Math.hypot(m.x - start.x, m.z - start.z)).toBeGreaterThan(15);
    sim.dispose();
  });

  it('a flying bot never boards; a seated one never lights its pack', () => {
    const sim = range(1);
    const human = sim.addPlayer('h', 'H', 0);
    const bot = [...sim.players.values()].find((p) => p.bot)!;
    place(human, { x: 0, y: 0.02, z: 50 });
    place(bot, { x: 3, y: 0.02, z: -50 }); // at the driver's door, but on a lit pack
    bot.state.move.jet = JetMode.Flying;
    bot.state.move.jetFuel = JETPACK.flightTime;
    for (let t = 0; t < 3 / SIM_DT; t++) {
      run(sim, human, SIM_DT);
      expect(bot.state.seat).toBeNull();
    }
    // Back on foot with the pack worn: it takes the wheel, and never ignites while seated.
    bot.state.move.jet = JetMode.Worn;
    place(bot, { x: 3, y: 0.02, z: -50 });
    let seated = false;
    for (let t = 0; t < 6 / SIM_DT; t++) {
      run(sim, human, SIM_DT);
      if (bot.state.seat) seated = true;
      if (bot.state.seat) expect(bot.state.move.jet).toBe(JetMode.Worn);
    }
    expect(seated).toBe(true);
    sim.dispose();
  });

  it.each([undefined, 0, 1, 2])(
    'with someone at the wheel, a bot hops into a passenger seat; parked, it gets out (spawn seed %s)',
    (spawnSeed) => {
      const sim = range(1, spawnSeed);
      const human = sim.addPlayer('h', 'H', 0);
      const bot = [...sim.players.values()].find((p) => p.bot)!;
      // Stage it before the driver boards: a nearby spawn can start a competing boarding plan
      // during these two setup ticks, before the bot is placed at the passenger door.
      place(bot, { x: 0, y: 0.02, z: 50 });
      place(human, { x: 1.6, y: 0.02, z: -49.6 });
      run(sim, human, SIM_DT, Button.Interact);
      run(sim, human, SIM_DT);
      expect(human.state.seat?.seat).toBe('driver');
      place(bot, { x: -3, y: 0.02, z: -51.3 }); // by the bed, right side
      // (Each try at a truck is a dice roll against the personality's `ride`: allow a few tries.)
      let rode = false;
      for (let t = 0; t < 40 / SIM_DT && !rode; t++) {
        if (t % 60 === 0) place(bot, { x: -3, y: 0.02, z: -51.3 }); // keep it by the bed
        run(sim, human, SIM_DT);
        rode = bot.state.seat !== null && bot.state.seat.seat !== 'driver';
      }
      expect(rode).toBe(true);
      // The truck stands still: the passenger gets out within the idle time (+ slack).
      let out = false;
      for (let t = 0; t < (BOT.vehicle.idleExitSeconds + 2) / SIM_DT && !out; t++) {
        run(sim, human, SIM_DT);
        out = bot.state.seat === null;
      }
      expect(out).toBe(true);
      sim.dispose();
    },
  );
});

/** A synthetic observation of a bot at the wheel of truck 1. */
function atWheel(
  nowMs: number,
  v: Partial<BotVehicleView>,
  drive: BotObservation['drive'],
): BotObservation {
  const pos = v.pos ?? { x: 0, y: 0, z: 0 };
  return {
    nowMs,
    seq: 0,
    map: {
      name: 'x',
      bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
      boxes: [],
      spawns: [],
      dummies: [],
    },
    nav: null as never,
    self: { seat: { vehicle: 1, seat: 'driver' }, pos, eye: pos } as never,
    visiblePlayers: [],
    memories: [],
    smoke: [],
    mode: 'standard',
    vehicles: [
      {
        id: 1,
        pos,
        yaw: 0,
        speed: 0,
        forwardSpeed: 0,
        condition: 'active',
        health: 1,
        free: ['front', 'rearL', 'rearR'],
        hasDriver: true,
        ...v,
      },
    ],
    drive,
  };
}

describe('the driving brain (synthetic)', () => {
  // A straight road north: nodes every 2 m from z 0 to 40.
  const nodes = Array.from({ length: 21 }, (_, i) => ({ x: 0, y: 0, z: i * 2 }));
  const road = {
    cell: 2,
    nodes,
    edges: nodes.map((_, i) => [i - 1, i + 1].filter((j) => j >= 0 && j < nodes.length)),
  };

  it('drives along its route: throttle on, steering toward the road ahead', () => {
    const brain = new VehicleBrain(7, BOT.personalities.flanker);
    const plan = brain.plan(atWheel(0, { pos: { x: 1.5, y: 0, z: 0 } }, road), null, {
      id: 'x',
      pos: { x: 0, y: 0, z: 40 },
      seenAt: 0,
      isBot: true,
    });
    expect(plan?.kind).toBe('drive');
    if (plan?.kind !== 'drive') return;
    expect(plan.moveZ).toBeGreaterThan(0.5);
    // Road is to the left (-x of a +z heading is the right... the road at x 0 is to our right).
    expect(plan.moveX).toBeGreaterThan(0);
  });

  it('stuck: backs out, and after a few back-outs gets out to fight on foot', () => {
    const brain = new VehicleBrain(7, BOT.personalities.flanker);
    const memory = { id: 'x', pos: { x: 0, y: 0, z: 40 }, seenAt: 0, isBot: true };
    let reversed = 0;
    let exited = false;
    for (let t = 0; t < 30_000 && !exited; t += 1000 / 60) {
      const plan = brain.plan(atWheel(t, { speed: 0, forwardSpeed: 0 }, road), null, memory);
      if (plan?.kind !== 'drive') continue;
      if (plan.moveZ < -0.5) reversed++;
      if (plan.interact) exited = true;
    }
    expect(reversed).toBeGreaterThan(0);
    expect(exited).toBe(true);
  });

  it('a beaten truck is abandoned at once', () => {
    const brain = new VehicleBrain(7, BOT.personalities.rusher);
    const plan = brain.plan(atWheel(0, { health: 0.1 }, road), null, null);
    expect(plan?.kind === 'drive' && plan.interact).toBe(true);
  });
});

describe('the driving brain: paths and boarding', () => {
  it('pursues a point along the path, not the next waypoint past the lookahead', () => {
    // An L: 10 m north, then east. 12 m ahead along it is 2 m into the second leg (a corner
    // cut straight at the far waypoint would clip whatever stands inside the bend).
    const p = pursuitPoint(
      { x: 0, y: 0, z: 0 },
      [
        { x: 0, y: 0, z: 10 },
        { x: 10, y: 0, z: 10 },
      ],
      12,
    )!;
    expect(p.x).toBeCloseTo(2, 6);
    expect(p.z).toBeCloseTo(10, 6);
    expect(pursuitPoint({ x: 0, y: 0, z: 0 }, [{ x: 0, y: 0, z: 10 }], 4)).toEqual({
      x: 0,
      y: 0,
      z: 10,
    });
  });

  it('boarding from the far side walks round the nearer end, then to the door', () => {
    // Truck at the origin facing +z; the driver's door is on its local +X (world +x) side.
    const v = { id: 1, pos: { x: 0, y: 0, z: 0 }, yaw: 0 } as BotVehicleView;
    const door = { x: 1.65, y: 0, z: 0.4 };
    // From its own side: straight to the door.
    expect(walkRound(v, 'driver', { x: 3, y: 0, z: 1 }, door)).toBe(door);
    // From the far side, level with it: along our side to the front end first.
    const first = walkRound(v, 'driver', { x: -2.5, y: 0, z: 0.5 }, door);
    expect(first.x).toBeLessThan(-1);
    expect(first.z).toBeGreaterThan(2.5);
    // Past the end: to the corner on the door's side.
    const second = walkRound(v, 'driver', { x: -1, y: 0, z: 3.5 }, door);
    expect(second.x).toBeGreaterThan(1);
    expect(second.z).toBeGreaterThan(2.5);
  });

  it('backing out of a dead end turns the nose toward the way on (a three-point turn)', () => {
    const brain = new VehicleBrain(7, BOT.personalities.flanker);
    // The road runs off to the east (+x) of a truck facing north (+z), stuck against a wall.
    const east = Array.from({ length: 11 }, (_, i) => ({ x: i * 2, y: 0, z: 0 }));
    const road = {
      cell: 2,
      nodes: east,
      edges: east.map((_, i) => [i - 1, i + 1].filter((j) => j >= 0 && j < east.length)),
    };
    const memory = { id: 'x', pos: { x: 20, y: 0, z: 0 }, seenAt: 0, isBot: true };
    let forward: { moveX: number } | null = null;
    let backing: { moveX: number } | null = null;
    for (let t = 0; t < 5000 && !backing; t += 1000 / 60) {
      const plan = brain.plan(atWheel(t, { speed: 0, forwardSpeed: 0 }, road), null, memory);
      if (plan?.kind !== 'drive') continue;
      if (plan.moveZ > 0.3) forward ??= plan;
      if (plan.moveZ < -0.5) backing = plan;
    }
    expect(forward).not.toBeNull();
    expect(backing).not.toBeNull();
    // Backing, the wheel is turned the other way from driving toward the road, so the nose
    // swings round toward it as the tail goes back.
    expect(Math.sign(backing!.moveX)).toBe(-Math.sign(forward!.moveX));
    expect(backing!.moveX).not.toBe(0);
  });
});

describe('the boarding decision', () => {
  it('a bot that rolled to ride walks to a passenger seat, even with the wheel free', () => {
    // Never drives, always rides: the wheel being free must not change the plan.
    const persona = { ...BOT.personalities.rusher, drive: 0, ride: 1 };
    const brain = new VehicleBrain(3, persona);
    const obs = atWheel(0, { free: ['driver', 'front', 'rearL', 'rearR'], hasDriver: false }, null);
    const onFoot = {
      ...obs,
      self: { seat: null, pos: { x: 6, y: 0, z: 0 }, eye: { x: 6, y: 1.6, z: 0 } } as never,
    };
    let plan = brain.plan(onFoot, null, null);
    for (let t = 1; plan?.kind !== 'walk' && t < 40; t++)
      plan = brain.plan({ ...onFoot, nowMs: t * 1000 }, null, null);
    expect(plan?.kind).toBe('walk');
    if (plan?.kind !== 'walk') return;
    // The driver's door is on the truck's +X side at the cab; a passenger seat is elsewhere.
    expect(Math.hypot(plan.goal.x - 1.65, plan.goal.z - 0.4)).toBeGreaterThan(0.5);
  });
});
