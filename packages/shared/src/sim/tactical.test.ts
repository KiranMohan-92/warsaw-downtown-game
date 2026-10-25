import { beforeAll, describe, expect, it } from 'vitest';
import { DRONE, GRENADE, JAMMER, SMOKE } from '../config/tunables.ts';
import { boxMinMax } from '../maps/builder.ts';
import type { MapDefinition } from '../maps/types.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { createArsenal, stepArsenal } from './arsenal.ts';
import { droneSpots, jammerPulse, launchDrone, stepDrone } from './drone.ts';
import { spawnGrenade } from './grenade.ts';
import { Button, type PlayerInput } from './input.ts';
import { SIGHT_THRESHOLD, sightVisibility } from './perception.ts';
import { FoliageIndex } from '../maps/concealment.ts';
import { smokeShape, smokeVisibility, stepSmoke, type SmokeCloud } from './smoke.ts';
import {
  createTactical,
  grantPickup,
  markSpotted,
  radarView,
  stepTactical,
  takesPickup,
  toggleDrone,
} from './tactical.ts';

let world: PhysicsWorld;
beforeAll(async () => {
  await initPhysics();
  const map: MapDefinition = {
    name: 't',
    bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
    boxes: [
      boxMinMax({ x: -60, y: -1, z: -60 }, { x: 60, y: 0, z: 60 }, 'ground'),
      boxMinMax({ x: -3, y: 0, z: -12 }, { x: 3, y: 4, z: -11 }, 'concrete'), // a wall ahead
    ],
    spawns: [],
    dummies: [],
  };
  world = new PhysicsWorld(map);
});

const input = (p: Partial<PlayerInput>): PlayerInput => ({
  seq: 0,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  ...p,
});

describe('smoke grenade', () => {
  it('H throws a smoke (its own count), frag stays untouched', () => {
    const a = createArsenal();
    const ev = stepArsenal(a, input({ buttons: Button.Smoke }), 0, 1 / 60);
    expect(ev).toContainEqual({ type: 'grenadeWindup', kind: 'smoke' });
    expect(a.smokes).toBe(SMOKE.perLife - 1);
    expect(a.grenades).toBe(GRENADE.perLife);
    const g = spawnGrenade(
      1,
      1,
      { x: 0, y: 1.6, z: 0 },
      0,
      0,
      { x: 0, y: 0, z: 0 },
      world,
      'smoke',
    );
    expect(g.kind).toBe('smoke');
    expect(g.fuse).toBe(SMOKE.fuse);
  });

  it('blooms, hides a target behind it, then thins out and disappears', () => {
    const cloud: SmokeCloud = { id: 1, pos: { x: 0, y: 0, z: -10 }, age: 0 };
    let clouds = [cloud];
    const eye = { x: 0, y: 1.6, z: 0 };
    const target = { x: 0, y: 1.4, z: -20 };
    clouds = stepSmoke(clouds, SMOKE.bloom);
    expect(smokeShape(cloud).radius).toBeCloseTo(SMOKE.radius, 1);
    expect(smokeVisibility(clouds, eye, target)).toBe(0);
    // Off to the side it's clear.
    expect(smokeVisibility(clouds, eye, { x: 20, y: 1.4, z: -20 })).toBe(1);
    clouds = stepSmoke(clouds, SMOKE.hold + SMOKE.fade + 0.1);
    expect(clouds.length).toBe(0);
  });
});

describe('recon drone', () => {
  it('B launches with a drone charge; B again recalls it', () => {
    const t = createTactical();
    expect(toggleDrone(t, Button.Drone, 0, 1, { x: 0, y: 1.6, z: 0 }, 0)).toBeNull(); // no charge
    expect(takesPickup(t, 'drone')).toBe(true);
    grantPickup(t, 'drone');
    expect(takesPickup(t, 'drone')).toBe(false);
    expect(toggleDrone(t, Button.Drone, 0, 1, { x: 0, y: 1.6, z: 0 }, 0)).toBe('launched');
    expect(t.drone?.alive).toBe(true);
    expect(toggleDrone(t, Button.Drone, 0, 1, { x: 0, y: 1.6, z: 0 }, 0)).toBe('recalled');
    expect(t.drone).toBeNull();
  });

  it('no launch mid-climb (hands busy); the charge is kept', () => {
    const t = createTactical();
    grantPickup(t, 'drone');
    expect(toggleDrone(t, Button.Drone, 0, 1, { x: 0, y: 1.6, z: 0 }, 0, true)).toBeNull();
    expect(t.droneCharges).toBe(1);
  });

  it('flies where you look (look up + W climbs, look down + W dives); Jump/Crouch go straight up/down', () => {
    const fly = (p: Partial<PlayerInput>, s = 1): number => {
      const d = launchDrone(1, { x: 20, y: 1.6, z: 20 }, 0);
      d.pos.y = 10;
      d.vel = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < s * 60; i++) stepDrone(d, input(p), 1 / 60, world);
      return d.pos.y - 10;
    };
    expect(fly({ moveZ: 1, pitch: 0.6 })).toBeGreaterThan(4);
    expect(fly({ moveZ: 1, pitch: -0.6 })).toBeLessThan(-4);
    expect(Math.abs(fly({ moveZ: 1, pitch: 0 }))).toBeLessThan(1e-6);
    expect(fly({ buttons: Button.Jump })).toBeGreaterThan(3);
    expect(fly({ buttons: Button.Crouch })).toBeLessThan(-3);
  });

  it('cannot fly through a gap narrower than itself, but slides along a wall it touches', () => {
    // Two posts 0.5 m apart (the drone is 0.6 m across), straight ahead.
    const gap = new PhysicsWorld({
      name: 'gap',
      bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      boxes: [
        boxMinMax({ x: -20, y: -1, z: -20 }, { x: 20, y: 0, z: 20 }, 'ground'),
        boxMinMax({ x: -3, y: 0, z: -6 }, { x: -0.25, y: 6, z: -5 }, 'concrete'),
        boxMinMax({ x: 0.25, y: 0, z: -6 }, { x: 3, y: 6, z: -5 }, 'concrete'),
        boxMinMax({ x: 5, y: 0, z: -15 }, { x: 6, y: 6, z: 15 }, 'concrete'), // long side wall
      ],
      spawns: [],
      dummies: [],
    });
    const d = launchDrone(1, { x: 0, y: 1.6, z: 0 }, 0);
    d.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120; i++) stepDrone(d, input({ moveZ: 1 }), 1 / 60, gap);
    expect(d.pos.z).toBeGreaterThan(-5);
    // Pressed against the side wall (strafe right), it still flies along it.
    const w = launchDrone(1, { x: 4, y: 1.6, z: 8 }, 0);
    w.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 60; i++) stepDrone(w, input({ moveX: 1 }), 1 / 60, gap);
    const z0 = w.pos.z;
    for (let i = 0; i < 60; i++) stepDrone(w, input({ moveX: 1, moveZ: 1 }), 1 / 60, gap);
    expect(w.pos.z).toBeLessThan(z0 - 3);
  });

  it('is a ball, not a point: grazing a wall edge by less than its radius still stops it', () => {
    const d = launchDrone(1, { x: 3.1, y: 1.6, z: 0 }, 0); // centre 0.1 m past the wall's end
    d.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120; i++) stepDrone(d, input({ moveZ: 1 }), 1 / 60, world);
    expect(d.pos.z).toBeGreaterThan(-11); // blocked at the wall face
  });

  it('flies with the sticks, stops at walls, and runs out of battery', () => {
    const d = launchDrone(1, { x: 0, y: 1.6, z: 0 }, 0);
    for (let i = 0; i < 180; i++) stepDrone(d, input({ moveZ: 1 }), 1 / 60, world); // 3 s at the wall
    expect(d.pos.z).toBeGreaterThan(-11); // did not pass through the wall at z −11
    expect(d.pos.z).toBeLessThan(-9.5); // but got there
    let end: string | null = null;
    for (let i = 0; i < DRONE.battery * 60 && !end; i++)
      end = stepDrone(d, input({}), 1 / 60, world);
    expect(end).toBe('battery');
    expect(d.alive).toBe(false);
  });

  it('spots targets in view and in the clear — not behind walls or in smoke', () => {
    const d = launchDrone(1, { x: 0, y: 1.6, z: 0 }, 0);
    d.pos = { x: 0, y: 8, z: 0 };
    d.pitch = -0.4;
    const inView = { id: 'a', pos: { x: 2, y: 1.4, z: -8 } };
    const behindWall = { id: 'b', pos: { x: 0, y: 1.4, z: -14 } };
    const behind = { id: 'c', pos: { x: 0, y: 1.4, z: 10 } };
    expect(droneSpots(d, [inView, behindWall, behind], world, [])).toEqual(['a']);
    const smoke: SmokeCloud[] = [{ id: 1, pos: { x: 2, y: 0, z: -8 }, age: SMOKE.bloom }];
    expect(droneSpots(d, [inView], world, smoke)).toEqual([]);
    // Foliage hides from the drone too (same sight model as bots): a low drone looking level.
    const low = launchDrone(1, { x: 0, y: 1.6, z: 0 }, 0);
    const lurker = { id: 'd', pos: { x: 20, y: 1.2, z: -2 } };
    low.yaw = Math.atan2(-lurker.pos.x, -lurker.pos.z);
    expect(droneSpots(low, [lurker], world, [])).toEqual(['d']);
    const bush = new FoliageIndex([{ x: 10, z: -1, r: 2, h: 2, kind: 'bush' }]);
    expect(droneSpots(low, [lurker], world, [], bush)).toEqual([]);
    // …but from overhead the drone sees down into a bush: the drone is the counter to bush
    // campers (Kiran's call). A thin line through the clump's top barely counts.
    const camper = new FoliageIndex([{ x: 2, z: -8, r: 1.5, h: 2, kind: 'bush' }]);
    expect(droneSpots(d, [inView], world, [], camper)).toEqual(['a']);
  });

  it('spotted marks show on the pilot radar and expire', () => {
    const t = createTactical();
    expect(radarView(t)).toBe('dark');
    markSpotted(t, ['a']);
    expect(radarView(t)).toBe('spotted');
    stepTactical(t, DRONE.spotTime + 0.1);
    expect(radarView(t)).toBe('dark');
  });
});

describe('drone jammer', () => {
  it('J pulses once per life', () => {
    const a = createArsenal();
    expect(stepArsenal(a, input({ buttons: Button.Jammer }), 0, 1 / 60)).toContainEqual({
      type: 'jammer',
    });
    expect(a.jammers).toBe(JAMMER.perLife - 1);
    expect(stepArsenal(a, input({ buttons: Button.Jammer }), 0, 1 / 60)).not.toContainEqual({
      type: 'jammer',
    });
  });

  it('downs enemy drones in range (not your own) and jams nearby radars', () => {
    const mine = launchDrone(1, { x: 0, y: 1.6, z: 0 }, 0);
    const near = launchDrone(2, { x: 10, y: 1.6, z: 0 }, 0);
    const far = launchDrone(3, { x: 100, y: 1.6, z: 0 }, 0);
    const { downed, jammed } = jammerPulse(
      { x: 0, y: 1, z: 0 },
      1,
      [mine, near, far],
      [
        { id: 'me', pos: { x: 0, y: 0, z: 0 }, owner: 1 },
        { id: 'close', pos: { x: 5, y: 0, z: 5 }, owner: 2 },
        { id: 'away', pos: { x: 80, y: 0, z: 0 }, owner: 3 },
      ],
    );
    expect(downed).toEqual([near]);
    expect(mine.alive && far.alive && !near.alive).toBe(true);
    expect(jammed).toEqual(['close']);
    const t = createTactical();
    t.radar.live = 5;
    t.jammed = JAMMER.radarJam;
    expect(radarView(t)).toBe('jammed'); // jamming beats even a called-in radar
  });
});

describe('sight (bots see by the same rules as players)', () => {
  const eye = { x: 0, y: 1.6, z: 0 };
  it('clear line: seen; behind a wall: hidden', () => {
    expect(sightVisibility(eye, { x: 10, y: 1.4, z: -10 }, world, [])).toBe(1);
    expect(sightVisibility(eye, { x: 0, y: 1.4, z: -20 }, world, [])).toBe(0);
  });
  it('smoke and thick foliage hide a target in the open', () => {
    const target = { x: 20, y: 1.0, z: 0 };
    const smoke: SmokeCloud[] = [{ id: 1, pos: { x: 10, y: 0, z: 0 }, age: SMOKE.bloom }];
    expect(sightVisibility(eye, target, world, smoke)).toBeLessThan(SIGHT_THRESHOLD);
    const bushes = new FoliageIndex([{ x: 10, z: 0, r: 2, h: 2, kind: 'bush' }]);
    expect(sightVisibility(eye, target, world, [], bushes)).toBeLessThan(SIGHT_THRESHOLD);
  });
});
