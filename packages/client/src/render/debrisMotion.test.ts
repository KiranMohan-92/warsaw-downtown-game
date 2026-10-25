import { beforeAll, describe, expect, it } from 'vitest';
import {
  PhysicsWorld,
  getMap,
  initPhysics,
  resolveMap,
  type Vec3,
  type WorldHit,
  type WorldRaycaster,
} from '@wd/shared';
import {
  sourcePlane,
  stepDebrisBody,
  type DebrisBody,
  type DebrisMotionOptions,
} from './debrisMotion.ts';

const OPT: DebrisMotionOptions = {
  gravity: 12,
  radius: 0.035,
  restitution: 0.38,
  tangentDamping: 0.62,
  settleSpeed: 0.55,
  maxDt: 1 / 20,
};

function body(pos: Vec3, vel: Vec3, normal: Vec3 = { x: 0, y: 1, z: 0 }): DebrisBody {
  const plane = sourcePlane(pos, normal);
  return {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    vx: vel.x,
    vy: vel.y,
    vz: vel.z,
    settled: false,
    collide: true,
    planeNx: plane.nx,
    planeNy: plane.ny,
    planeNz: plane.nz,
    planeD: plane.d,
  };
}

function planeWorld(point: Vec3, normal: Vec3): WorldRaycaster {
  const d = normal.x * point.x + normal.y * point.y + normal.z * point.z;
  return {
    castRay(origin, dir, maxDistance): WorldHit | null {
      const denom = normal.x * dir.x + normal.y * dir.y + normal.z * dir.z;
      if (Math.abs(denom) < 1e-6) return null;
      const t = (d - normal.x * origin.x - normal.y * origin.y - normal.z * origin.z) / denom;
      if (t < 0 || t > maxDistance) return null;
      return {
        distance: t,
        point: {
          x: origin.x + dir.x * t,
          y: origin.y + dir.y * t,
          z: origin.z + dir.z * t,
        },
        normal,
        visible: true,
        surface: 'stone',
      };
    },
  };
}

describe('debris motion', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('bounces on the ground and loses energy', () => {
    const p = body({ x: 0, y: 0.3, z: 0 }, { x: 1, y: -8, z: 0 });
    stepDebrisBody(p, 1 / 30, planeWorld({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), OPT);
    expect(p.y).toBeGreaterThan(0);
    expect(p.vy).toBeGreaterThan(0);
    expect(Math.hypot(p.vx, p.vy, p.vz)).toBeLessThan(8.1);
  });

  it('bounces off a vertical wall without tunnelling', () => {
    const p = body({ x: 1, y: 1, z: 0 }, { x: -40, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    stepDebrisBody(p, 1 / 20, planeWorld({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), OPT);
    expect(p.x).toBeGreaterThan(0);
    expect(p.vx).toBeGreaterThan(0);
  });

  it('collides with floors above ground level', () => {
    const p = body({ x: 0, y: 2.4, z: 0 }, { x: 0, y: -7, z: 0 });
    stepDebrisBody(p, 1 / 20, planeWorld({ x: 0, y: 2, z: 0 }, { x: 0, y: 1, z: 0 }), OPT);
    expect(p.y).toBeGreaterThan(2);
    expect(p.vy).toBeGreaterThan(0);
  });

  it('damps tangential velocity on oblique impacts', () => {
    const p = body({ x: 1, y: 1, z: 0 }, { x: -20, y: 0, z: 8 }, { x: 1, y: 0, z: 0 });
    const before = Math.hypot(p.vx, p.vy, p.vz);
    stepDebrisBody(p, 1 / 20, planeWorld({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), OPT);
    expect(Math.abs(p.vz)).toBeLessThan(8);
    expect(Math.hypot(p.vx, p.vy, p.vz)).toBeLessThan(before);
  });

  it('guards unreasonable dt and non-finite values', () => {
    const p = body({ x: 0, y: 1, z: 0 }, { x: 0, y: -5, z: 0 });
    stepDebrisBody(
      p,
      Number.POSITIVE_INFINITY,
      planeWorld({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
      OPT,
    );
    expect(p.y).toBe(1);
  });

  it('keeps non-raycast particles outside the source contact plane', () => {
    const p = body({ x: 0.05, y: 1, z: 0 }, { x: -10, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    p.collide = false;
    stepDebrisBody(p, 1 / 20, null, OPT);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.vx).toBeGreaterThanOrEqual(0);
  });

  it('can use the real Rapier market ground', () => {
    const market = resolveMap(getMap('defilad'), 'market');
    const world = new PhysicsWorld(market);
    const origin = { x: 99, y: 6, z: 0 };
    const ground = world.castRay(origin, { x: 0, y: -1, z: 0 }, 20);
    expect(ground).not.toBeNull();
    const p = body({ x: origin.x, y: ground!.point.y + 0.3, z: origin.z }, { x: 0, y: -8, z: 0 });
    stepDebrisBody(p, 1 / 30, world, OPT);
    expect(p.y).toBeGreaterThan(ground!.point.y);
  });
});
