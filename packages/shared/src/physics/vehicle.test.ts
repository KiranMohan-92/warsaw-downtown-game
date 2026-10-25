import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT, VEHICLE } from '../config/tunables.ts';
import { block, boxMinMax } from '../maps/builder.ts';
import type { MapBox, MapDefinition } from '../maps/types.ts';
import {
  bodyOverlaps,
  cloneVehicleMotion,
  createVehicleMotion,
  motionError,
  stepVehicle,
  type DriveControls,
  type VehicleMotion,
  type VehicleObstacle,
} from '../sim/vehicles/vehicle.ts';
import { initPhysics, PhysicsWorld } from './world.ts';

beforeAll(async () => {
  await initPhysics();
});

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'drive',
  bounds: { minX: -120, maxX: 120, minZ: -120, maxZ: 120 },
  boxes: [boxMinMax({ x: -120, y: -1, z: -120 }, { x: 120, y: 0, z: 120 }, 'ground'), ...boxes],
  spawns: [],
  dummies: [],
});

/** A truck at the origin facing +Z, settled on the ground. */
function truck(boxes: MapBox[] = [], yaw = 0) {
  const world = new PhysicsWorld(mapOf(boxes));
  const m = createVehicleMotion({ x: 0, y: 0, z: 0 }, yaw);
  drive(m, world, 0.3, {});
  return { world, m };
}

function drive(
  m: VehicleMotion,
  world: PhysicsWorld,
  seconds: number,
  c: Partial<DriveControls>,
  obstacles: VehicleObstacle[] = [],
  onStep?: () => void,
): void {
  const steps = Math.round(seconds / SIM_DT);
  const controls = { throttle: 0, steer: 0, handbrake: false, ...c };
  for (let i = 0; i < steps; i++) {
    stepVehicle(m, controls, SIM_DT, world, obstacles, 1);
    onStep?.();
  }
}
const speed = (m: VehicleMotion) => Math.hypot(m.vel.x, m.vel.z);

describe('vehicle handling (real physics)', () => {
  it('sits level on flat ground and does not drift', () => {
    const { m, world } = truck();
    drive(m, world, 2, {});
    expect(m.grounded).toBe(true);
    expect(Math.abs(m.pos.y)).toBeLessThan(0.01);
    expect(Math.hypot(m.pos.x, m.pos.z)).toBeLessThan(1e-6);
    expect(Math.abs(m.pitch) + Math.abs(m.roll)).toBeLessThan(1e-4);
  });

  it('accelerates like a heavy truck that still answers, tops out, brakes hard', () => {
    const { m, world } = truck();
    let t50 = 0;
    let t = 0;
    drive(m, world, 8, { throttle: 1 }, [], () => {
      t += SIM_DT;
      if (!t50 && speed(m) >= 50 / 3.6) t50 = t;
    });
    expect(t50).toBeGreaterThan(2.2);
    expect(t50).toBeLessThan(4);
    expect(speed(m)).toBeGreaterThan(VEHICLE.topSpeed * 0.95);
    expect(speed(m)).toBeLessThanOrEqual(VEHICLE.topSpeed + 1e-9);
    const z0 = m.pos.z;
    drive(m, world, 2, { throttle: -1 });
    expect(m.pos.z - z0).toBeLessThan(25); // stopping distance from top speed
    expect(m.vel.z).toBeLessThan(0.5); // stopped (and maybe creeping back)
  });

  it('reverses slower than it drives', () => {
    const { m, world } = truck();
    drive(m, world, 5, { throttle: -1 });
    expect(m.vel.z).toBeLessThan(0);
    expect(speed(m)).toBeLessThanOrEqual(VEHICLE.reverseSpeed + 1e-9);
  });

  it('turns tight at walking pace and wide at speed (no pivot)', () => {
    const slow = truck();
    drive(slow.m, slow.world, 0.6, { throttle: 0.6 });
    drive(slow.m, slow.world, 4, { throttle: 0.15, steer: 1 });
    const v = speed(slow.m);
    const radiusSlow = v / Math.abs(slow.m.yawRate);
    expect(radiusSlow).toBeLessThan(8);
    expect(slow.m.yawRate).toBeGreaterThan(0); // steer + = left = yaw +
    const fast = truck();
    drive(fast.m, fast.world, 6, { throttle: 1 });
    drive(fast.m, fast.world, 1.5, { throttle: 1, steer: 1 });
    const radiusFast = speed(fast.m) / Math.abs(fast.m.yawRate);
    expect(radiusFast).toBeGreaterThan(20);
    // Grip limit: lateral acceleration never above the cornering cap (+ the slip it bleeds).
    expect(speed(fast.m) * Math.abs(fast.m.yawRate)).toBeLessThan(VEHICLE.maxLateralAccel + 0.5);
  });

  it('handbrake swings the tail out (sideways slip) and slows it', () => {
    const { m, world } = truck();
    drive(m, world, 4, { throttle: 1 });
    const v0 = speed(m);
    let slip = 0;
    drive(m, world, 1, { steer: 1, handbrake: true }, [], () => {
      const fx = Math.sin(m.yaw);
      const fz = Math.cos(m.yaw);
      slip = Math.max(slip, Math.abs(-fz * m.vel.x + fx * m.vel.z));
    });
    expect(slip).toBeGreaterThan(1.5);
    expect(speed(m)).toBeLessThan(v0 * 0.8);
  });

  it('climbs a kerb, a 30 cm step, but a 50 cm wall stops the body', () => {
    for (const [h, climbs] of [
      [0.15, true],
      [0.3, true],
      [0.55, false],
    ] as const) {
      const { m, world } = truck([block(0, 30, 0, 30, h, 40, 'concrete')]);
      drive(m, world, 5, { throttle: 0.7 });
      if (climbs) {
        expect(m.pos.z).toBeGreaterThan(20);
        expect(m.pos.y).toBeGreaterThan(h - 0.05);
      } else {
        expect(m.pos.z).toBeLessThan(10 + 2.5);
        expect(speed(m)).toBeLessThan(0.5);
      }
      expect(bodyOverlaps(world, m.pos, m.yaw, m.pitch, m.roll)).toBe(false);
    }
  });

  it('slides along a glancing wall instead of sticking to it', () => {
    const wall: MapBox = { ...block(-3, 25, 0, 1, 3, 60, 'concrete'), rot: { x: 0, y: 20, z: 0 } };
    const { m, world } = truck([wall]);
    let overlaps = 0;
    drive(m, world, 6, { throttle: 1 }, [], () => {
      if (bodyOverlaps(world, m.pos, m.yaw, m.pitch, m.roll)) overlaps++;
    });
    expect(overlaps).toBe(0);
    expect(m.pos.z).toBeGreaterThan(30); // carried on along it
  });

  it('never ends inside geometry while steering hard into a wall', () => {
    const { m, world } = truck([block(4, 6, 0, 1, 3, 30, 'concrete')]);
    let overlaps = 0;
    drive(m, world, 6, { throttle: 1, steer: -1 }, [], () => {
      if (bodyOverlaps(world, m.pos, m.yaw, m.pitch, m.roll)) overlaps++;
    });
    drive(m, world, 3, { throttle: -1, steer: 1 }, [], () => {
      if (bodyOverlaps(world, m.pos, m.yaw, m.pitch, m.roll)) overlaps++;
    });
    expect(overlaps).toBe(0);
  });

  it('drops off a ledge and lands without bouncing through the floor', () => {
    const { m, world } = truck([
      boxMinMax({ x: -10, y: 0, z: -10 }, { x: 10, y: 1.2, z: 6 }, 'concrete'),
    ]);
    // Start on top of the platform.
    m.pos.y = 1.2;
    drive(m, world, 0.5, {});
    expect(m.pos.y).toBeGreaterThan(1.1);
    let minY = Infinity;
    drive(m, world, 4, { throttle: 0.6 }, [], () => {
      if (m.pos.z > 12) minY = Math.min(minY, m.pos.y);
    });
    expect(m.grounded).toBe(true);
    expect(minY).toBeGreaterThan(-0.15);
    expect(Math.abs(m.pos.y)).toBeLessThan(0.03);
  });

  it('is pushed out of another truck, never through it', () => {
    const { m, world } = truck();
    const other: VehicleObstacle = {
      id: 2,
      x: 0,
      z: 12,
      yaw: Math.PI / 2,
      hx: 1.05,
      hz: 2.5,
      y: 0,
      top: 2,
    };
    drive(m, world, 4, { throttle: 1 }, [other]);
    // Front of our truck (z + 2.5) stays behind the other's side (z 12 - 1.05).
    expect(m.pos.z + 2.5).toBeLessThan(12 - 1.05 + 0.3);
  });

  it('is deterministic: the same inputs give bit-identical motion (prediction == server)', () => {
    const script = (i: number): DriveControls => ({
      throttle: i % 200 < 150 ? 1 : -0.5,
      steer: Math.sin(i / 40),
      handbrake: i % 300 > 270,
    });
    const boxes = [block(6, 20, 0, 2, 0.2, 8, 'concrete'), block(-8, 30, 0, 1, 3, 20, 'concrete')];
    const a = truck(boxes);
    const b = truck(boxes);
    const copy = cloneVehicleMotion(a.m);
    for (let i = 0; i < 600; i++) {
      stepVehicle(a.m, script(i), SIM_DT, a.world);
      stepVehicle(b.m, script(i), SIM_DT, b.world);
    }
    expect(motionError(a.m, b.m)).toBe(0);
    // And a replay from a mid-run copy matches a straight run.
    const c = truck(boxes);
    c.m = copy;
    for (let i = 0; i < 600; i++) stepVehicle(c.m, script(i), SIM_DT, c.world);
    expect(motionError(a.m, c.m)).toBe(0);
  });
});
