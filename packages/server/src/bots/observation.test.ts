import { beforeAll, describe, expect, it } from 'vitest';
import {
  boxMinMax,
  createPlayerState,
  grantSpawnProtection,
  launchDrone,
  hullAt,
  initPhysics,
  PhysicsWorld,
  withHulls,
  type MapDefinition,
} from '@wd/shared';
import { buildVisibleDrones, buildVisiblePlayers } from './observation.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('bot sight of fresh spawns', () => {
  it('reveals a protected spawn only inside the sight cone with clear sight', () => {
    const map: MapDefinition = {
      name: 'spawn sight',
      bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      boxes: [
        boxMinMax({ x: -40, y: -1, z: -40 }, { x: 40, y: 0, z: 40 }, 'ground'),
        boxMinMax({ x: -2, y: 0, z: -8 }, { x: 2, y: 3, z: -7 }, 'concrete'),
      ],
      spawns: [],
      dummies: [],
    };
    const physics = new PhysicsWorld(map);
    try {
      const self = {
        id: 'bot',
        name: 'Bot',
        slot: 0,
        isBot: true,
        state: createPlayerState({ x: 0, y: 0, z: 0 }),
      };
      for (const [pos, seen] of [
        [{ x: 0, y: 0, z: -4 }, true],
        [{ x: 10, y: 0, z: 0 }, false],
        [{ x: 0, y: 0, z: -12 }, false],
      ] as const) {
        const state = createPlayerState(pos);
        grantSpawnProtection(state);
        const target = { id: 'human', name: 'Human', slot: 1, isBot: false, state };
        const visible = buildVisiblePlayers({ map, physics, self, players: [self, target] });
        expect(visible).toEqual(
          seen ? [expect.objectContaining({ id: 'human', protected: true })] : [],
        );
      }
    } finally {
      physics.free();
    }
  });
});

describe('bot sight vs trucks', () => {
  it('a truck between a bot and its target blocks sight, as it stops rounds', () => {
    const map: MapDefinition = {
      name: 'lot',
      bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      boxes: [boxMinMax({ x: -40, y: -1, z: -40 }, { x: 40, y: 0, z: 40 }, 'ground')],
      spawns: [],
      dummies: [],
    };
    const physics = new PhysicsWorld(map);
    // The bot looks down -z at a crouched target 14 m away; a truck sits broadside between them
    // (its doors: below the windows, so nothing shows through glass).
    const botState = createPlayerState({ x: 0, y: 0, z: 0 });
    botState.view.yaw = 0;
    botState.view.pitch = 0;
    const self = { id: 'bot', name: 'Bot', slot: 0, isBot: true, state: botState };
    const targetState = createPlayerState({ x: 0, y: 0, z: -14 });
    targetState.move.crouched = true;
    targetState.move.eyeHeight = 1.05;
    const target = { id: 'h', name: 'H', slot: 1, isBot: false, state: targetState };
    const players = [self, target];
    const open = buildVisiblePlayers({ map, physics, self, players });
    expect(open.map((p) => p.id)).toEqual(['h']);
    const truck = hullAt(1, { x: 0, y: 0, z: -7 }, Math.PI / 2, 0, 0, false);
    const blocked = buildVisiblePlayers({
      map,
      physics,
      sight: withHulls(physics, [truck]),
      self,
      players,
    });
    expect(blocked).toEqual([]);
  });
});

describe('bot sight vs drones', () => {
  it('uses player sight rules for live enemy drones without exposing the owner', () => {
    const map: MapDefinition = {
      name: 'drone lot',
      bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      boxes: [boxMinMax({ x: -40, y: -1, z: -40 }, { x: 40, y: 0, z: 40 }, 'ground')],
      spawns: [],
      dummies: [],
    };
    const physics = new PhysicsWorld(map);
    try {
      const botState = createPlayerState({ x: 0, y: 0, z: 0 });
      botState.view.yaw = 0;
      botState.view.pitch = 0;
      const self = { id: 'bot', name: 'Bot', slot: 0, isBot: true, state: botState };
      const ownerState = createPlayerState({ x: 30, y: 0, z: -30 });
      ownerState.drone = launchDrone(ownerState.seed, { x: 0, y: 1.6, z: -12 }, 0);
      ownerState.drone.pos = { x: 0, y: 2.2, z: -12 };
      const owner = { id: 'human', name: 'Human', slot: 1, isBot: false, state: ownerState };
      const drones = buildVisibleDrones({ map, physics, self, players: [self, owner] });
      expect(drones).toEqual([
        expect.objectContaining({
          kind: 'drone',
          id: 'drone:human',
          ownerId: 'human',
          pos: ownerState.drone.pos,
        }),
      ]);

      ownerState.drone.alive = false;
      expect(buildVisibleDrones({ map, physics, self, players: [self, owner] })).toEqual([]);
    } finally {
      physics.free();
    }
  });

  it('does not see drones hidden by hard cover or level foliage', () => {
    const map: MapDefinition = {
      name: 'drone cover',
      bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      boxes: [
        boxMinMax({ x: -40, y: -1, z: -40 }, { x: 40, y: 0, z: 40 }, 'ground'),
        boxMinMax({ x: -2, y: 0, z: -6 }, { x: 2, y: 4, z: -5.7 }, 'concrete'),
      ],
      foliage: [{ x: 8, z: -9, r: 2, h: 3, kind: 'bush' }],
      spawns: [],
      dummies: [],
    };
    const physics = new PhysicsWorld(map);
    try {
      const botState = createPlayerState({ x: 0, y: 0, z: 0 });
      botState.view.yaw = 0;
      botState.view.pitch = 0;
      const self = { id: 'bot', name: 'Bot', slot: 0, isBot: true, state: botState };
      const ownerState = createPlayerState({ x: 30, y: 0, z: -30 });
      ownerState.drone = launchDrone(ownerState.seed, { x: 0, y: 1.6, z: -12 }, 0);
      const owner = { id: 'human', name: 'Human', slot: 1, isBot: false, state: ownerState };

      ownerState.drone.pos = { x: 0, y: 2.2, z: -12 };
      expect(buildVisibleDrones({ map, physics, self, players: [self, owner] })).toEqual([]);
      ownerState.drone.pos = { x: 8, y: 1.5, z: -9 };
      expect(buildVisibleDrones({ map, physics, self, players: [self, owner] })).toEqual([]);
    } finally {
      physics.free();
    }
  });
});
