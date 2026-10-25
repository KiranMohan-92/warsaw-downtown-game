import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPlayerState,
  createTactical,
  createWeaponDrops,
  createVehicleMotion,
  DRONE,
  SIM_DT,
  clonePlayerState,
  stepDrone,
  emptyInput,
  launchDrone,
  motionToWire,
  toSnapshotPlayer,
  initPhysics,
  PhysicsWorld,
  tankWreck,
  helicopterWreck,
  type CharacterBody,
  type MapBox,
  type MapDefinition,
  type Vec3,
  type WorldRaycaster,
} from '@wd/shared';
import { OnlineSession } from '../net/onlineSession.ts';
import { Game } from './Game.ts';

beforeAll(async () => {
  await initPhysics();
});

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'drone-wreck-flight',
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
  boxes,
  spawns: [],
  dummies: [],
});

/** Exercise the actual fixed-step caller, with presentation and unrelated entities absent. */
function flightGame(
  online: OnlineSession | null,
  movement: WorldRaycaster,
  opts: { dronePos?: Vec3; yaw?: number } = {},
) {
  const player = createPlayerState({ x: 0, y: 0, z: 0 }, 7);
  player.drone = launchDrone(7, { x: 0, y: 0.9, z: 0 }, opts.yaw ?? 0);
  if (opts.dronePos) player.drone.pos = { ...opts.dronePos };
  player.drone.vel = { x: 0, y: 0, z: 0 };
  const body: CharacterBody = {
    world: {
      castRay: () => null,
      castGroundRay: movement.castRay.bind(movement),
      overlapsStatic: () => false,
    },
    move: (delta) => ({ moved: { ...delta, y: 0 }, grounded: true }),
    setCrouched: () => true,
    setPosition: () => {},
  };
  const game = {
    player,
    body,
    online,
    seq: 0,
    input: { sample: (seq: number) => ({ ...emptyInput(seq), moveZ: 1, yaw: opts.yaw ?? 0 }) },
    physics: { castRay: () => null, castGroundRay: movement.castRay.bind(movement) },
    tactical: createTactical(),
    weaponDrops: createWeaponDrops(),
    dummies: [],
    partner: null,
    offlineCrowd: [],
    smoke: [],
    board: null,
    jetpacks: [],
    pickups: [],
    grenades: [],
    respawnTimer: 0,
    handleEvent: () => {},
    queryVehicles: () => [],
  };
  Object.setPrototypeOf(game, Game.prototype);
  const step = () =>
    (Game.prototype as unknown as { simStep(this: unknown): void }).simStep.call(game);
  return { player, body, step };
}

describe('Game drone flight prediction wiring', () => {
  it.each([0, 1])('stops at the newest online truck hull (condition %i)', (condition) => {
    const session = new OnlineSession();
    session.handleWelcome({
      id: 'me',
      map: 'range',
      size: 'full',
      mode: 'standard',
      tick: 0,
      tickHz: 60,
      spawn: { x: 0, y: 0, z: 0, yaw: 0 },
      seed: 7,
      primary: 'ar7',
    });
    const { player, step } = flightGame(session, { castRay: () => null });
    session.handleSnapshot(
      {
        t: 0,
        players: [toSnapshotPlayer('me', player, -1, 0)],
        vehicles: [
          {
            id: 1,
            m: motionToWire(createVehicleMotion({ x: 0, y: 0, z: -5 }, 0)),
            hp: condition === 0 ? 800 : 0,
            st: condition,
          },
        ],
      },
      0,
    );
    for (let i = 0; i < 120; i++) step();

    expect(player.drone?.alive).toBe(true);
    expect(player.drone!.pos.z).toBeGreaterThan(-2.5);
    expect(player.drone!.pos.z).toBeLessThan(-1);
    expect(player.drone!.vel.z).toBe(0);
  });

  it('client reconciliation replays the same truck contact as its fixed-step prediction', () => {
    const session = new OnlineSession();
    session.handleWelcome({
      id: 'me',
      map: 'range',
      size: 'full',
      mode: 'standard',
      tick: 0,
      tickHz: 60,
      spawn: { x: 0, y: 0, z: 0, yaw: 0 },
      seed: 7,
      primary: 'ar7',
    });
    const { player, body, step } = flightGame(session, { castRay: () => null });
    const vehicles = [
      {
        id: 1,
        m: motionToWire(createVehicleMotion({ x: 0, y: 0, z: -5 }, 0)),
        hp: 800,
        st: 0 as const,
      },
    ];
    session.handleSnapshot({ t: 0, players: [toSnapshotPlayer('me', player, -1, 0)], vehicles }, 0);
    step();
    const acknowledged = toSnapshotPlayer('me', player, 0, 0);
    acknowledged.x += 0.02; // force replay of the later approach without changing the drone
    for (let i = 1; i < 120; i++) step();
    const predictedDrone = {
      ...player.drone!,
      pos: { ...player.drone!.pos },
      vel: { ...player.drone!.vel },
    };
    expect(predictedDrone.pos.z).toBeGreaterThan(-2.5);
    expect(predictedDrone.pos.z).toBeLessThan(-1);
    session.handleSnapshot({ t: 1, players: [acknowledged], vehicles }, 0);

    const result = session.reconcile(player, body, SIM_DT)!;

    expect(result.corrected).toBe(true);
    expect(result.state.drone).toEqual(predictedDrone);
  });

  it.each([
    ['tank', tankWreck({ x: 0, z: 0 }), { x: -3.5, y: 1.1, z: -14 }],
    ['helicopter', helicopterWreck({ x: 0, z: 0 }), { x: -4, y: 0.5, z: -14 }],
  ] as const)(
    'flies against %s movement hulls rather than its ray-only mesh',
    (_name, boxes, start) => {
      const world = new PhysicsWorld(mapOf(boxes));
      try {
        const dir = { x: 0, y: 0, z: 1 };
        const rayOnly = world.castRay(start, dir, 30);
        expect(rayOnly).not.toBeNull();
        expect(world.castGroundRay(start, dir, 30)).toBeNull();

        const { player, step } = flightGame(
          null,
          { castRay: (origin, d, maxDistance) => world.castGroundRay(origin, d, maxDistance) },
          { dronePos: start, yaw: Math.PI },
        );
        const movementFlight = clonePlayerState(player).drone!;
        const bulletFlight = clonePlayerState(player).drone!;
        const movement = { castRay: world.castGroundRay.bind(world) };
        for (let i = 0; i < 180; i++) {
          const input = { ...emptyInput(i), moveZ: 1, yaw: Math.PI };
          stepDrone(movementFlight, input, SIM_DT, movement);
          stepDrone(bulletFlight, input, SIM_DT, world);
          step();
        }

        expect(player.drone?.alive).toBe(true);
        expect(player.drone).toEqual(movementFlight);
        expect(player.drone!.pos.z).not.toBeCloseTo(bulletFlight.pos.z, 3);
      } finally {
        world.free();
      }
    },
  );

  it('uses movement solids offline even when bullet rays do not see those solids', () => {
    const wallZ = -2;
    const { player, step } = flightGame(null, {
      castRay: (origin, dir, maxDistance) => {
        if (dir.z >= 0 || origin.z < wallZ) return null;
        const distance = (wallZ - origin.z) / dir.z;
        return distance <= maxDistance
          ? {
              distance,
              point: { ...origin, z: wallZ },
              normal: { x: 0, y: 0, z: 1 },
              visible: false,
            }
          : null;
      },
    });
    for (let i = 0; i < 120; i++) step();

    expect(player.drone?.alive).toBe(true);
    expect(player.drone!.pos.z).toBeCloseTo(wallZ + DRONE.radius);
  });
});
