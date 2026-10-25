import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER, VEHICLE } from '../../config/tunables.ts';
import { block, boxMinMax } from '../../maps/builder.ts';
import type { MapBox, MapDefinition } from '../../maps/types.ts';
import {
  applySnapshotMove,
  ownState,
  snapshotError,
  toSnapshotPlayer,
} from '../../net/snapshot.ts';
import { initPhysics, PhysicsWorld } from '../../physics/world.ts';
import { Button } from '../input.ts';
import { clonePlayerState, createPlayerState } from '../player.ts';
import {
  chooseSeat,
  findExitSpot,
  inFireArc,
  nextFreeSeat,
  seatButtonMask,
  seatFeet,
  seatFromWire,
  seatToWire,
} from './seats.ts';
import {
  BELTLINE,
  CAB_FLOOR,
  CAB_FRONT,
  HULL_BOXES,
  ROOF,
  SEAT_SPEC,
  SEATS,
  TRUCK,
  WHEEL_POS,
  WINDSCREEN_TOP,
} from './truckSpec.ts';
import {
  controlsFromInput,
  createVehicleMotion,
  motionFromWire,
  motionToWire,
  obbPush,
  stepVehicle,
  viewYawOf,
} from './vehicle.ts';
import { hullAt, hullObstacle, pushOutOfVehicle, rayHull, withHulls } from './vehicleHits.ts';

beforeAll(async () => {
  await initPhysics();
});

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'seats',
  bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
  boxes: [boxMinMax({ x: -60, y: -1, z: -60 }, { x: 60, y: 0, z: 60 }, 'ground'), ...boxes],
  spawns: [],
  dummies: [],
});

describe('truck spec (the model contract)', () => {
  it('has the agreed dimensions, a driver at front-left and seats inside the body', () => {
    expect(TRUCK).toMatchObject({ length: 5, width: 2.1, wheelbase: 3.1, track: 1.75 });
    expect(WHEEL_POS.fl).toEqual({ x: 0.875, y: 0.46, z: 1.55 });
    expect(WHEEL_POS.rr).toEqual({ x: -0.875, y: 0.46, z: -1.55 });
    // Front +Z, left +X: the driver sits front-left.
    expect(SEAT_SPEC.driver.hip.x).toBeGreaterThan(0);
    expect(SEAT_SPEC.driver.hip.z).toBeGreaterThan(0);
    for (const s of SEATS) {
      const h = SEAT_SPEC[s].hip;
      expect(Math.abs(h.x)).toBeLessThan(TRUCK.width / 2);
      expect(Math.abs(h.z)).toBeLessThan(TRUCK.length / 2);
    }
    // The cab eye stays under the roof; the bed crew sits above the bed walls (exposed).
    const roofArmour = HULL_BOXES[2]!;
    expect(SEAT_SPEC.driver.floor + SEAT_SPEC.driver.eye).toBeLessThan(roofArmour.min.y);
    expect(SEAT_SPEC.rearL.floor + SEAT_SPEC.rearL.eye).toBeGreaterThan(roofArmour.max.y);
  });

  it("matches the art lane's cab: seats behind the dash, eyes in the glass band", () => {
    for (const s of ['driver', 'front'] as const) {
      const spec = SEAT_SPEC[s];
      expect(spec.hip).toEqual({ x: s === 'driver' ? 0.45 : -0.45, y: 1.2, z: 0.15 });
      expect(spec.floor).toBe(CAB_FLOOR);
      const eye = spec.floor + spec.eye;
      // Above the armoured doors, under the roof: looking out of the windows.
      expect(eye).toBeGreaterThan(BELTLINE + 0.15);
      expect(eye).toBeLessThan(ROOF - 0.08);
      // The windscreen (pillars) 0.6–0.95 m ahead of the seat; the dash (≈ 0.37) clear of the hip.
      expect(WINDSCREEN_TOP - spec.hip.z).toBeCloseTo(0.6, 6);
      expect(CAB_FRONT - spec.hip.z).toBeCloseTo(0.95, 6);
      expect(spec.hip.z).toBeLessThan(0.37 - 0.2);
    }
    expect([CAB_FLOOR, BELTLINE, ROOF]).toEqual([0.91, 1.62, 1.94]);
    // The doors are armour up to the beltline: a round at 1.55 m stops there.
    const door = HULL_BOXES[1]!;
    expect(door.max.y).toBe(BELTLINE);
  });
});

describe('seats', () => {
  const m = createVehicleMotion({ x: 10, y: 0, z: 0 }, Math.PI / 2); // facing +x

  it('the nearest free seat from where you stand; none beyond reach', () => {
    // Facing +x: the truck's left (+X local) is world -z… (local +X = (cos h, -sin h)).
    const leftDoor = { x: 10 + 0.45, y: 0, z: -1.6 };
    expect(chooseSeat(m, new Set(), leftDoor)).toBe('driver');
    expect(chooseSeat(m, new Set(['driver']), leftDoor)).toBe('rearL');
    const rightBed = { x: 10 - 1.35, y: 0, z: 1.7 };
    expect(chooseSeat(m, new Set(), rightBed)).toBe('rearR');
    expect(chooseSeat(m, new Set(), { x: 10, y: 0, z: 8 })).toBeNull();
    expect(chooseSeat(m, new Set(SEATS), leftDoor)).toBeNull();
    expect(nextFreeSeat('driver', new Set(['driver', 'front']))).toBe('rearL');
    expect(nextFreeSeat('rearR', new Set(['rearR', 'driver']))).toBe('front');
    expect(nextFreeSeat('front', new Set(SEATS))).toBeNull();
  });

  it('never through a wall: a truck within reach on the other side of one is not', () => {
    // The truck's left side faces -z; a 3 m wall runs between it and a player 1.55 m out.
    const player = { x: 10.4, y: 0, z: -2.6 };
    const walled = new PhysicsWorld(
      mapOf([boxMinMax({ x: 5, y: 0, z: -2.15 }, { x: 15, y: 3, z: -1.9 }, 'concrete')]),
    );
    const open = new PhysicsWorld(mapOf([]));
    expect(chooseSeat(m, new Set(), player)).toBe('driver'); // no world: reach only
    expect(chooseSeat(m, new Set(), player, open)).toBe('driver');
    expect(chooseSeat(m, new Set(), player, walled)).toBeNull();
    // From the open side of the same wall, the far doors still work.
    expect(chooseSeat(m, new Set(), { x: 10.4, y: 0, z: 1.8 }, walled)).toBe('front');
  });

  it('what each seat can do with its hands', () => {
    expect(seatButtonMask('driver') & Button.Fire).toBeTruthy();
    expect(seatButtonMask('driver') & Button.Reload).toBe(0);
    expect(seatButtonMask('front') & Button.Fire).toBe(0);
    expect(seatButtonMask('front') & Button.Grenade).toBeTruthy();
    expect(seatButtonMask('rearL') & (Button.Fire | Button.Grenade)).toBe(0);
    expect(seatButtonMask('rearR') & Button.Melee).toBeTruthy();
  });

  it('fire arcs: the front passenger out of the right window and the windscreen; bed all round', () => {
    const h = 0.3;
    const aim = (rel: number): number => viewYawOf(h + rel); // view yaw looking `rel` off forward
    expect(inFireArc('front', aim(0), h)).toBe(true); // ahead
    expect(inFireArc('front', aim(-Math.PI / 2), h)).toBe(true); // out of the right window
    expect(inFireArc('front', aim(Math.PI / 2), h)).toBe(false); // across the driver
    expect(inFireArc('front', aim(Math.PI), h)).toBe(false); // back through the cab
    expect(inFireArc('front', aim(VEHICLE.frontArcMin - 0.05), h)).toBe(false);
    for (const rel of [0, 1, 2, 3, -2]) expect(inFireArc('rearL', aim(rel), h)).toBe(true);
    expect(inFireArc('driver', aim(0), h)).toBe(false);
  });

  it('gets out beside the truck, never into a wall: a wall on the left sends the driver right', () => {
    const facing = createVehicleMotion({ x: 0, y: 0, z: 0 }, 0); // facing +z, left = +x
    const open = new PhysicsWorld(mapOf([]));
    const out = findExitSpot(open, facing, 'driver')!;
    expect(out.x).toBeGreaterThan(TRUCK.width / 2); // the driver's own side
    const walled = new PhysicsWorld(mapOf([block(1.6, 0, 0, 0.4, 3, 12, 'concrete')]));
    const spot = findExitSpot(walled, facing, 'driver')!;
    expect(spot).not.toBeNull();
    expect(walled.overlapsStatic(spot, PLAYER.standHeight)).toBe(false);
    expect(spot.x < 1.4 || Math.abs(spot.z) > TRUCK.length / 2).toBe(true);
    // Boxed in on every side: stays in.
    const boxed = new PhysicsWorld(
      mapOf([
        block(1.4, 0, 0, 0.4, 3, 12, 'concrete'),
        block(-1.4, 0, 0, 0.4, 3, 12, 'concrete'),
        block(0, 3, 0, 4, 3, 0.4, 'concrete'),
        block(0, -3, 0, 4, 3, 0.4, 'concrete'),
      ]),
    );
    expect(findExitSpot(boxed, facing, 'driver')).toBeNull();
  });
});

describe('armour and obstacles', () => {
  const hull = hullAt(1, { x: 0, y: 0, z: 0 }, 0, 0, 0);

  it('a round hits the door below the beltline; through the window it passes into the cab', () => {
    const door = rayHull({ x: 10, y: 1.0, z: 0.4 }, { x: -1, y: 0, z: 0 }, hull, 50);
    expect(door?.distance).toBeCloseTo(10 - TRUCK.width / 2, 6);
    expect(door?.normal.x).toBeCloseTo(1, 6);
    const glass = rayHull({ x: 10, y: 1.78, z: 0.4 }, { x: -1, y: 0, z: 0 }, hull, 50);
    // Across the cab: the window on the far side is open too; nothing stops it.
    expect(glass).toBeNull();
    const bed = rayHull({ x: 10, y: 1.3, z: -1.5 }, { x: -1, y: 0, z: 0 }, hull, 50);
    expect(bed?.distance).toBeCloseTo(10 - TRUCK.width / 2, 6); // bed wall
    const over = rayHull({ x: 10, y: 1.8, z: -1.5 }, { x: -1, y: 0, z: 0 }, hull, 50);
    expect(over).toBeNull(); // over the bed walls
  });

  it('the hulls join the static world for bullets and sight (nearest wins, tagged)', () => {
    const world = new PhysicsWorld(mapOf([block(-6, 0, 0, 0.5, 3, 10, 'concrete')]));
    const both = withHulls(world, [hull]);
    const hit = both.castRay({ x: 10, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 50);
    expect(hit && 'vehicle' in hit ? hit.vehicle : undefined).toBe(1);
    const past = both.castRay({ x: 10, y: 2.5, z: 0 }, { x: -1, y: 0, z: 0 }, 50);
    expect(past && 'vehicle' in past ? past.vehicle : undefined).toBeUndefined();
    expect(past?.distance).toBeCloseTo(10 + 5.75, 1); // the wall behind
    expect(withHulls(world, [])).toBe(world);
  });

  it('walkers are pushed out of the footprint the short way; above the roof nothing', () => {
    const o = hullObstacle(1, { x: 0, y: 0, z: 0 }, 0);
    const p = pushOutOfVehicle({ x: 0.9, y: 0, z: 0 }, PLAYER.radius, 1.8, o)!;
    expect(p.x).toBeCloseTo(TRUCK.width / 2 + PLAYER.radius - 0.9, 6);
    expect(p.z).toBeCloseTo(0, 6);
    expect(pushOutOfVehicle({ x: 0.9, y: 2.1, z: 0 }, PLAYER.radius, 1.8, o)).toBeNull();
    expect(pushOutOfVehicle({ x: 3, y: 0, z: 0 }, PLAYER.radius, 1.8, o)).toBeNull();
    // Two trucks side by side, overlapping 0.2 m: pushed apart along x.
    const push = obbPush(1.9, 0, 0, 1.05, 2.5, { ...o })!;
    expect(push.x).toBeCloseTo(0.2, 6);
  });
});

describe('controls and the wire', () => {
  it('W+A on a keyboard is full throttle and full lock (the stick disk mapped to the square)', () => {
    const d = Math.SQRT1_2;
    const c = controlsFromInput(-d, d, false);
    expect(c.throttle).toBeCloseTo(1, 6);
    expect(c.steer).toBeCloseTo(1, 6); // A = left = +
    const half = controlsFromInput(0, 0.5, true);
    expect(half.throttle).toBeCloseTo(0.5, 6);
    expect(half.handbrake).toBe(true);
  });

  it('seat and motion round-trip through a snapshot entry; equal states compare as exact', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    const motion = createVehicleMotion({ x: 3, y: 0.1, z: -2 }, 0.7);
    motion.vel = { x: 1, y: 0, z: 2 };
    motion.steer = 0.2;
    p.seat = { vehicle: 2, seat: 'driver', motion };
    p.move.pos = seatFeet(motion, 'driver');
    const s = toSnapshotPlayer('a', p, 5, 0, { own: true });
    expect(seatFromWire(s.vh)).toEqual({ vehicle: 2, seat: 'driver' });
    expect(motionFromWire(s.own?.vm)).toEqual(motion);
    expect(seatFromWire(seatToWire({ vehicle: 7, seat: 'rearR' }))).toEqual({
      vehicle: 7,
      seat: 'rearR',
    });
    const q = createPlayerState({ x: 9, y: 9, z: 9 });
    applySnapshotMove(q, s);
    expect(q.seat).toEqual(p.seat);
    expect(snapshotError(q, s)).toBe(0);
    // A different seat, or the truck predicted elsewhere, is a mismatch.
    const moved = clonePlayerState(q);
    moved.seat!.motion!.pos.x += 0.5;
    expect(snapshotError(moved, s)).toBeGreaterThan(0.4);
    const other = clonePlayerState(q);
    other.seat = { vehicle: 2, seat: 'front' };
    expect(snapshotError(other, s)).toBe(Infinity);
    const walking = clonePlayerState(q);
    walking.seat = null;
    expect(snapshotError(walking, s)).toBe(Infinity);
    expect(ownState(walking).vm).toBeUndefined();
    expect(motionToWire(motion)).toHaveLength(12);
    expect(motionFromWire([1, 2, 3])).toBeNull();
    expect(seatFromWire(-1)).toBeNull();
  });

  it("a passenger's seat position is not predicted (only its seat and hands are compared)", () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    p.seat = { vehicle: 1, seat: 'rearL' };
    const s = toSnapshotPlayer('a', p, 5, 0, { own: true });
    const q = clonePlayerState(p);
    q.move.pos.x += 3; // the client drew the truck elsewhere
    expect(snapshotError(q, s)).toBe(0);
  });
});

describe('truck vs truck: only when level', () => {
  it('a truck on the level below (the car park under the plaza) never pushes one above', () => {
    const world = new PhysicsWorld(mapOf([]));
    const run = (o: Parameters<typeof stepVehicle>[4]): { x: number; z: number } => {
      const m = createVehicleMotion({ x: 0, y: 0, z: 0 }, 0);
      for (let i = 0; i < 30; i++)
        stepVehicle(m, { throttle: 0, steer: 0, handbrake: false }, 1 / 60, world, o, 1);
      return { x: m.pos.x, z: m.pos.z };
    };
    const alone = run([]);
    // Overlapping in plan, but 6 m down.
    const below = { id: 2, x: 0.8, z: 0.5, yaw: 0.3, hx: 1.05, hz: 2.5, y: -6, top: -4 };
    expect(run([below])).toEqual(alone);
    // Level with us: pushed out.
    const level = { ...below, y: 0, top: TRUCK.height };
    const pushed = run([level]);
    expect(Math.hypot(pushed.x - alone.x, pushed.z - alone.z)).toBeGreaterThan(0.1);
  });
});
