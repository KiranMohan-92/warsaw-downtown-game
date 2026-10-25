import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT, VEHICLE_IMPACT } from '../config/tunables.ts';
import { boxMinMax } from '../maps/builder.ts';
import type { DecorKind, MapDefinition } from '../maps/types.ts';
import {
  createVehicleMotion,
  propImpact,
  propSpeedLoss,
  stepVehicle,
  type PropHit,
  type VehicleMotion,
  type VehicleProps,
} from '../sim/vehicles/vehicle.ts';
import { initPhysics, PhysicsWorld, type PropPose } from './world.ts';

beforeAll(async () => {
  await initPhysics();
});

/** Flat ground with decor pieces (props in id order) on the truck's line (+Z from the origin). */
const mapOf = (decor: { kind: DecorKind; z: number; x?: number }[]): MapDefinition => ({
  name: 'props',
  bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
  boxes: [boxMinMax({ x: -60, y: -1, z: -60 }, { x: 60, y: 0, z: 60 }, 'ground')],
  decor: decor.map((d) => ({ kind: d.kind, x: d.x ?? 0, z: d.z })),
  spawns: [],
  dummies: [],
});

/** What the server does with a hit (smash: gone; knock: tumbling), recording it. */
function serverProps(world: PhysicsWorld, hits: PropHit[]): VehicleProps {
  return {
    passed: () => false,
    hit: (h) => {
      hits.push(h);
      if (h.kind === 'smash') world.removeProp(h.id);
      else world.knockProp(h.id, h.mass, { x: 0, y: 0, z: h.into });
    },
  };
}

/** Coast the truck from the origin at `speed` along +Z for `seconds`. */
function coast(
  world: PhysicsWorld,
  speed: number,
  seconds: number,
  props?: VehicleProps,
): VehicleMotion {
  const m = createVehicleMotion({ x: 0, y: 0, z: 0 }, 0);
  for (let i = 0; i < 20; i++)
    stepVehicle(m, { throttle: 0, steer: 0, handbrake: false }, SIM_DT, world);
  m.vel = { x: 0, y: 0, z: speed };
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++)
    stepVehicle(m, { throttle: 0, steer: 0, handbrake: false }, SIM_DT, world, [], 1, props);
  return m;
}

/** Step the tumbling props until none is left (bounded). */
function settle(world: PhysicsWorld): { id: number; pose: PropPose }[] {
  const out: { id: number; pose: PropPose }[] = [];
  for (let i = 0; i < 600 && (i === 0 || world.movingProps().length); i++)
    out.push(...world.stepProps(SIM_DT).settled);
  return out;
}

describe('trucks against props (VEHICLE_IMPACT)', () => {
  it('a broken prop costs the truck the momentum it hands over, by class and mass', () => {
    const control = coast(new PhysicsWorld(mapOf([])), 10, 1.2);
    const losses: Record<string, number> = {};
    for (const kind of ['cardboard', 'trashbag', 'bin', 'drum', 'tyres', 'utilityBox'] as const) {
      const world = new PhysicsWorld(mapOf([{ kind, z: 6 }]));
      const hits: PropHit[] = [];
      const m = coast(world, 10, 1.2, serverProps(world, hits));
      expect(hits.length, kind).toBeGreaterThan(0);
      // The loss each hit hands over (along its normal), and nothing else changed.
      let expected = 0;
      for (const h of hits) {
        expect(h.into).toBeGreaterThanOrEqual(propImpact(world.prop(h.id)!)!.minSpeed);
        expected += propSpeedLoss(h.into, h.mass) * -h.normal.z;
      }
      expect(control.vel.z - m.vel.z, kind).toBeCloseTo(expected, 3);
      expect(m.pos.z, kind).toBeGreaterThan(8); // through, not stopped
      losses[kind] = control.vel.z - m.vel.z;
      const first = hits[0]!;
      expect(first.kind).toBe(kind === 'cardboard' || kind === 'trashbag' ? 'smash' : 'knock');
    }
    // Heavier props cost more: a drum (60 kg) more than a bin (15 kg) more than a carton.
    expect(losses.drum).toBeGreaterThan(losses.bin!);
    expect(losses.bin).toBeGreaterThan(losses.cardboard!);
    expect(losses.drum).toBeLessThan(0.6); // 3 t of truck: a drum is a bump, not a wall
  });

  it('too slow for its class, or a solid prop: a wall, as before', () => {
    // A drum at walking pace stops the truck; a lamp post at speed stops it too.
    for (const [kind, speed] of [
      ['drum', 1],
      ['lamp', 10],
    ] as const) {
      const world = new PhysicsWorld(mapOf([{ kind, z: 6 }]));
      const hits: PropHit[] = [];
      const m = coast(world, speed, 2, serverProps(world, hits));
      expect(hits, kind).toEqual([]);
      expect(world.propState(0), kind).toBe('static');
      expect(m.pos.z, kind).toBeLessThan(6);
    }
    // Without a props handler (route planning, old callers) every prop is solid.
    const world = new PhysicsWorld(mapOf([{ kind: 'bin', z: 6 }]));
    expect(coast(world, 10, 1.2).pos.z).toBeLessThan(6);
    expect(world.propState(0)).toBe('static');
  });

  it('a jersey barrier only gives way to a fast truck, with a big speed loss', () => {
    const I = VEHICLE_IMPACT.props.jersey!;
    expect(I.minSpeed).toBeGreaterThan(8);
    const loss = propSpeedLoss(12, I.mass);
    expect(loss).toBeGreaterThan(3);
    expect(propSpeedLoss(12, VEHICLE_IMPACT.props.bin!.mass)).toBeLessThan(0.1);
  });

  it('a smashed prop no longer blocks movement, rays or trucks', () => {
    const world = new PhysicsWorld(mapOf([{ kind: 'trashbag', z: 6 }]));
    const ray = (): unknown =>
      world.castRay({ x: 3, y: 0.2, z: 6 }, { x: -1, y: 0, z: 0 }, 6)?.prop;
    const feet = { x: 0, y: 0.01, z: 6 };
    expect(ray()).toBe(0);
    expect(world.overlapsStatic(feet, 1.8)).toBe(true);
    expect(world.removeProp(0)).toBe(true);
    expect(world.removeProp(0)).toBe(false); // idempotent
    expect(ray()).toBeUndefined();
    expect(world.castRay({ x: 3, y: 0.2, z: 6 }, { x: -1, y: 0, z: 0 }, 6)).toBeNull();
    expect(world.overlapsStatic(feet, 1.8)).toBe(false);
    expect(coast(world, 6, 2).pos.z).toBeGreaterThan(6); // nothing left to stop a truck
  });

  it('a knocked prop tumbles and settles: the same inputs give the same final pose', () => {
    const run = (): { pose: PropPose; world: PhysicsWorld } => {
      const world = new PhysicsWorld(mapOf([{ kind: 'drum', z: 6 }]));
      expect(
        world.knockProp(
          0,
          60,
          { x: 0.5, y: 1, z: 6 },
          {
            at: { x: 0.1, y: 0.7, z: 5.7 },
            j: { x: 0, y: 0, z: 120 },
          },
        ),
      ).toBe(true);
      expect(world.propState(0)).toBe('moving');
      // Tumbling: no query sees it (players, bullets and trucks pass it until it settles).
      expect(world.castRay({ x: 3, y: 0.5, z: 6 }, { x: -1, y: 0, z: 0 }, 6)).toBeNull();
      const settled = settle(world);
      expect(settled.map((s) => s.id)).toEqual([0]);
      return { pose: settled[0]!.pose, world };
    };
    const a = run();
    const b = run();
    expect(b.pose).toEqual(a.pose);
    // It moved (and came down on the ground), and stands there now: rays and capsules meet it.
    const p = a.pose.pos;
    expect(p.z).toBeGreaterThan(7);
    expect(p.y).toBeGreaterThan(-0.05);
    expect(p.y).toBeLessThan(0.7);
    expect(a.world.propState(0)).toBe('static');
    expect(a.world.propChanged(0)).toBe(true);
    const down = a.world.castRay({ x: p.x, y: 3, z: p.z }, { x: 0, y: -1, z: 0 }, 5);
    expect(down?.prop).toBe(0);
    // Its old spot is clear.
    expect(a.world.overlapsStatic({ x: 0, y: 0.01, z: 6 }, 1.8)).toBe(false);
  });

  it('a settled prop is in the very next query, while others still tumble', () => {
    const world = new PhysicsWorld(
      mapOf([
        { kind: 'bin', z: 6 },
        { kind: 'drum', z: 20 },
      ]),
    );
    world.knockProp(0, 15, { x: 0, y: 0, z: 0.5 }); // a nudge: down again at once
    world.knockProp(1, 60, { x: 0, y: 6, z: 8 }); // a long flight
    let checked = false;
    for (let i = 0; i < 600 && !checked; i++) {
      const { settled } = world.stepProps(SIM_DT);
      const s = settled.find((x) => x.id === 0);
      if (!s) continue;
      expect(world.propState(1)).toBe('moving');
      const p = s.pose.pos;
      expect(world.castRay({ x: p.x, y: 3, z: p.z }, { x: 0, y: -1, z: 0 }, 5)?.prop).toBe(0);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it('tied hits resolve by prop id, whatever order the props were rebuilt in', () => {
    // Two carton stacks side by side: the truck's front meets both faces at the same time.
    const decor = [
      { kind: 'cardboard' as const, z: 6, x: -0.3 },
      { kind: 'cardboard' as const, z: 6, x: 0.3 },
    ];
    const a = new PhysicsWorld(mapOf(decor));
    const b = new PhysicsWorld(mapOf(decor));
    // Rebuild b's props in another order: its broad-phase tree differs from a's.
    for (const id of [3, 1, 2, 0]) b.placeProp(id, b.prop(id)!);
    b.refreshQueries();
    const sweep = (w: PhysicsWorld, skip?: (id: number) => boolean) =>
      w.castBox(
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 1, y: 0.6, z: 2.4 },
        { x: 0, y: 0, z: 6 },
        skip,
      );
    const ha = sweep(a);
    const hb = sweep(b);
    expect(ha?.prop).toBe(1); // the lowest id of the tied (upper) cartons
    expect(hb).toEqual(ha);
    // And the next one, once it is passed: the same on both sides too.
    const skip = (id: number) => id === 1;
    expect(sweep(b, skip)).toEqual(sweep(a, skip));
    expect(sweep(a, skip)?.prop).toBe(3);
  });

  it('a prop never settles round a player: it waits until they are out', () => {
    const world = new PhysicsWorld(mapOf([{ kind: 'drum', z: 6 }]));
    const body = world.createCharacter({ x: 0, y: 0, z: 6 }); // standing where the drum lands
    world.knockProp(0, 60, { x: 0, y: 0, z: 0.2 });
    for (let i = 0; i < 120; i++) world.stepProps(SIM_DT);
    expect(world.propState(0)).toBe('moving'); // at rest, but not solid round the player
    // Free to walk out (a solid drum round the capsule would cancel every move).
    let moved = 0;
    for (let i = 0; i < 60; i++)
      moved += Math.hypot(body.move({ x: 0.05, y: -0.01, z: 0 }).moved.x);
    expect(moved).toBeGreaterThan(1.5);
    // Out of it: it settles.
    for (let i = 0; i < 60 && world.propState(0) === 'moving'; i++) world.stepProps(SIM_DT);
    expect(world.propState(0)).toBe('static');
  });

  it('a prop someone keeps standing in is gone after the grace, never solid round them', () => {
    const world = new PhysicsWorld(mapOf([{ kind: 'drum', z: 6 }]));
    world.createCharacter({ x: 0, y: 0, z: 6 });
    world.knockProp(0, 60, { x: 0, y: 0, z: 0.2 });
    let lost: number[] = [];
    for (let i = 0; i < 60 * 10 && !lost.length; i++) lost = world.stepProps(SIM_DT).lost;
    expect(lost).toEqual([0]);
    expect(world.propState(0)).toBe('gone');
  });

  it('a new match puts every prop back where the map put it', () => {
    const world = new PhysicsWorld(
      mapOf([
        { kind: 'bin', z: 6 },
        { kind: 'cardboard', z: 12 },
      ]),
    );
    const home = world.prop(0)!;
    world.knockProp(0, 15, { x: 0, y: 0, z: 5 });
    settle(world);
    world.removeProp(2); // the top carton of the stack
    expect(world.resetProps().sort()).toEqual([0, 2]);
    for (let id = 0; id < world.propCount; id++) {
      expect(world.propChanged(id)).toBe(false);
      expect(world.propState(id)).toBe('static');
    }
    expect(world.prop(0)).toBe(home);
    expect(world.castRay({ x: 3, y: 0.5, z: 6 }, { x: -1, y: 0, z: 0 }, 6)?.prop).toBe(0);
    expect(world.resetProps()).toEqual([]);
  });

  it('props stacked on one that goes are found (they fall with it)', () => {
    const world = new PhysicsWorld(
      mapOf([
        { kind: 'cardboard', z: 6 },
        { kind: 'tyres', z: 12 },
      ]),
    );
    // Two cartons (ids 0, 1), three tyres (2, 3, 4), each layer on the one below.
    expect(world.propsOnTop(0)).toEqual([1]);
    expect(world.propsOnTop(1)).toEqual([]);
    expect(world.propsOnTop(2)).toEqual([3]);
    expect(world.propsOnTop(3)).toEqual([4]);
  });

  it('a truck rolls through cartons under its body sweep (the wheels crush them)', () => {
    // Under the left wheels' track.
    const world = new PhysicsWorld(mapOf([{ kind: 'cardboard', z: 6, x: 0.875 }]));
    world.removeProp(1); // the top carton: only the low one is left, under the body's sweep
    const hits: PropHit[] = [];
    const m = coast(world, 8, 1.5, serverProps(world, hits));
    expect(hits.map((h) => [h.id, h.kind])).toContainEqual([0, 'smash']);
    expect(m.pos.z).toBeGreaterThan(8);
    expect(m.pos.y).toBeLessThan(0.05); // never climbed it
  });
});
