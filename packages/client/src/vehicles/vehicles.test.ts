import type { Material, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createVehicleMotion,
  motionToWire,
  SEAT_NODE,
  SIGHT_THRESHOLD,
  SIM_DT,
  sightVisibility,
  spawnGrenade,
  stepGrenade,
  SEAT_SPEC,
  SEATS,
  WHEEL_POS,
  WHEELS,
  type SnapshotVehicle,
} from '@wd/shared';
import {
  hullsOf,
  obstaclesOf,
  seatEyeOf,
  VehicleTrack,
  withOwnTruck,
  withTrucks,
  type VehiclePose,
} from '../net/vehicleTrack.ts';
import { buildTruckPlaceholder, hasTruckLayout, truckMaterials, WHEEL_NODE } from './truckModel.ts';

const snap = (x: number, yaw: number, st = 0, hp = 800): SnapshotVehicle => {
  const m = createVehicleMotion({ x, y: 0, z: 0 }, yaw);
  m.vel = { x: 6, y: 0, z: 0 };
  return { id: 1, m: motionToWire(m), hp, st };
};

describe('vehicle track (drawn on the remote-player timeline)', () => {
  it('blends pose and heading between snapshots, holds the ends, extrapolates briefly', () => {
    const t = new VehicleTrack(1, 150);
    t.push(1000, snap(0, 3.1));
    t.push(1033, snap(2, -3.1)); // across ±π: the short way round
    const mid = t.sample(1016.5)!;
    expect(mid.motion.pos.x).toBeCloseTo(1, 6);
    expect(Math.abs(Math.abs(mid.motion.yaw) - Math.PI)).toBeLessThan(0.05);
    expect(t.sample(900)!.motion.pos.x).toBe(0);
    // Past the newest: on along its velocity (6 m/s) for ≤ 150 ms, then held.
    expect(t.sample(1083)!.motion.pos.x).toBeCloseTo(2 + 0.3, 6);
    expect(t.sample(1500)!.motion.pos.x).toBeCloseTo(2 + 0.9, 6);
  });

  it('never blends across a condition change (a wreck, a respawn) and ignores junk', () => {
    const t = new VehicleTrack(1, 0);
    t.push(1000, snap(0, 0, 0));
    t.push(1033, snap(30, 0, 2)); // gone
    expect(t.sample(1010)!.motion.pos.x).toBe(0);
    expect(t.sample(1025)!.condition).toBe('gone');
    t.push(1066, { id: 1, m: [1, 2], hp: 1, st: 0 });
    expect(t.newest()!.t).toBe(1033);
    // Gone trucks are no obstacle and draw no hull.
    expect(obstaclesOf([t])).toHaveLength(0);
    expect(hullsOf([t.sample(1033)!])).toHaveLength(0);
  });

  it('a seat eye in the drawn truck (passenger shots and camera)', () => {
    const t = new VehicleTrack(4, 0);
    t.push(0, { ...snap(10, 0), id: 4 });
    const eye = seatEyeOf([t.sample(0)!], { vehicle: 4, seat: 'rearL' })!;
    const s = SEAT_SPEC.rearL;
    expect(eye.x).toBeCloseTo(10 + s.hip.x, 6);
    expect(eye.y).toBeCloseTo(s.floor + s.eye, 6);
    expect(eye.z).toBeCloseTo(s.hip.z, 6);
    expect(seatEyeOf([], { vehicle: 4, seat: 'rearL' })).toBeNull();
  });
});

describe('truck placeholder (model contract)', () => {
  it('has every contract node where the spec puts it (the art lane’s glb drops in)', () => {
    const root = buildTruckPlaceholder(truckMaterials());
    expect(hasTruckLayout(root)).toBe(true);
    for (const w of WHEELS) {
      const n = root.getObjectByName(WHEEL_NODE[w])!;
      expect(n.position.toArray()).toEqual([WHEEL_POS[w].x, WHEEL_POS[w].y, WHEEL_POS[w].z]);
    }
    for (const s of SEATS) {
      const n = root.getObjectByName(SEAT_NODE[s])!;
      const h = SEAT_SPEC[s].hip;
      expect(n.position.toArray()).toEqual([h.x, h.y, h.z]);
    }
    expect(hasTruckLayout(new THREE.Group())).toBe(false);
    // Few draws: the body merged per material (3) + one per wheel.
    let meshes = 0;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBe(3 + WHEELS.length);
  });
});

describe('vehicles view', () => {
  it('swapping in a loaded model rebuilds each spawned truck once, in place (no endless loop)', async () => {
    const { VehiclesView } = await import('./vehiclesView.ts');
    const world = { castRay: () => null } as unknown as ConstructorParameters<
      typeof VehiclesView
    >[0];
    const view = new VehiclesView(world, [
      { id: 1, x: 10, y: 0, z: 5, yaw: 0.5 },
      { id: 2, x: -4, y: 0, z: 30, yaw: 1.2 },
    ]);
    const before = view.group.children.map((c) => c.uuid);
    view.rebuildInstances();
    const trucks = view.group.children.filter((c) => c.name.startsWith('truck:'));
    expect(trucks.map((c) => c.name).sort()).toEqual(['truck:1', 'truck:2']);
    expect(trucks.some((c) => before.includes(c.uuid))).toBe(false);
    const t1 = trucks.find((c) => c.name === 'truck:1')!;
    expect(t1.position.toArray()).toEqual([10, 0, 5]);
    expect(t1.rotation.y).toBeCloseTo(0.5, 6);
  });
});

describe('vehicles view shadows', () => {
  it('every truck casts through one shared depth material (warmed up), glass casts none', async () => {
    const { VehiclesView } = await import('./vehiclesView.ts');
    const world = { castRay: () => null } as unknown as ConstructorParameters<
      typeof VehiclesView
    >[0];
    const view = new VehiclesView(world, [
      { id: 1, x: 0, y: 0, z: 0, yaw: 0 },
      { id: 2, x: 8, y: 0, z: 0, yaw: 0 },
    ]);
    const depth = new Set<Material>();
    let casters = 0;
    view.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const transparent = [m.material].flat().some((x) => x.transparent);
      if (transparent) expect(m.castShadow).toBe(false);
      else if (m.castShadow) {
        casters++;
        expect(m.customDepthMaterial).toBeDefined();
        depth.add(m.customDepthMaterial!);
      }
    });
    expect(casters).toBeGreaterThan(0);
    expect(depth.size).toBe(1); // one program, compiled in warmUp (none on a truck's first shadow)
  });
});

describe('the client meets the trucks where the server does', () => {
  // An open lot: the ground at y 0, nothing else.
  const ground = {
    castRay(
      o: { x: number; y: number; z: number },
      d: { x: number; y: number; z: number },
      max: number,
    ) {
      if (d.y >= 0) return null;
      const t = o.y / -d.y;
      return t <= max
        ? {
            distance: t,
            point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t },
            normal: { x: 0, y: 1, z: 0 },
            visible: true,
          }
        : null;
    },
  };
  const truck = {
    id: 1,
    motion: createVehicleMotion({ x: 0, y: 0, z: 0 }, Math.PI / 2),
    condition: 'active' as const,
  } as unknown as Parameters<typeof withTrucks>[1][number];

  it('a name tag behind a truck is hidden (its armour blocks sight, as a wall does)', () => {
    const eye = { x: 0, y: 1.2, z: -8 };
    const head = { x: 0, y: 1.0, z: 8 }; // crouched behind the truck's doors
    expect(sightVisibility(eye, head, ground, [], null)).toBeGreaterThanOrEqual(SIGHT_THRESHOLD);
    expect(sightVisibility(eye, head, withTrucks(ground, [truck]), [], null)).toBeLessThan(
      SIGHT_THRESHOLD,
    );
  });

  it('the client’s copy of a frag bounces off the truck instead of passing through', () => {
    const g = spawnGrenade(
      1,
      1,
      { x: 0, y: 1, z: -6 },
      Math.PI,
      -0.15,
      { x: 0, y: 0, z: 0 },
      ground,
    );
    const world = withTrucks(ground, [truck]);
    for (let i = 0; i < 120; i++) stepGrenade(g, SIM_DT, world);
    expect(g.pos.z).toBeLessThan(-1); // stays on the thrower's side of the doors
  });
});

describe('client truck queries use the trucks as this frame draws them', () => {
  const ground = {
    castRay(
      o: { x: number; y: number; z: number },
      d: { x: number; y: number; z: number },
      max: number,
    ) {
      if (d.y >= 0) return null;
      const t = o.y / -d.y;
      return t <= max
        ? {
            distance: t,
            point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t },
            normal: { x: 0, y: 1, z: 0 },
            visible: true,
          }
        : null;
    },
  };
  const pose = (id: number, x: number, z = 0) => ({
    id,
    motion: createVehicleMotion({ x, y: 0, z }, Math.PI / 2),
    hp: 800,
    condition: 'active' as const,
  });

  it('the truck we drive is where our prediction has it, not the late server pose', () => {
    // Under latency the server's pose of our truck is 3 m behind our prediction.
    const net = [pose(1, 0), pose(2, 20)];
    const predicted = createVehicleMotion({ x: 0, y: 0, z: 3 }, Math.PI / 2);
    const drawn = withOwnTruck(net, { vehicle: 1, seat: 'driver' }, predicted);
    expect(drawn[0]!.motion.pos.z).toBe(3);
    expect(drawn[1]!.motion).toBe(net[1]!.motion);
    // A passenger's truck isn't predicted: the network pose stays.
    expect(withOwnTruck(net, { vehicle: 1, seat: 'front' }, predicted)[0]!.motion.pos.z).toBe(0);
    // A frag thrown at where our truck really is bounces off it there.
    const at = (poses: readonly VehiclePose[]) => {
      const g = spawnGrenade(
        1,
        1,
        { x: -6, y: 1, z: 3 },
        -Math.PI / 2,
        -0.15,
        { x: 0, y: 0, z: 0 },
        ground,
      );
      const world = withTrucks(ground, poses);
      for (let i = 0; i < 90; i++) stepGrenade(g, SIM_DT, world);
      return g.pos.x;
    };
    expect(at(drawn)).toBeLessThan(-1); // bounced back off the doors
    expect(at(net)).toBeGreaterThan(1); // the late pose: it would have flown through
  });

  it('a moving truck is queried at this step’s time, not the last frame’s', () => {
    const t = new VehicleTrack(1, 150);
    t.push(1000, snap(0, 0));
    t.push(1033, snap(1.6, 0)); // 48 m/s… a fast step: 0.8 m between 60 Hz frames
    const last = t.sample(1000)!.motion.pos.x;
    const now = t.sample(1016.5)!.motion.pos.x;
    expect(now - last).toBeGreaterThan(0.7);
  });
});
