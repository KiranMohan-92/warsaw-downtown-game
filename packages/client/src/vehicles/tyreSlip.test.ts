import { describe, expect, it } from 'vitest';
import { TRUCK, VEHICLE, WHEELS } from '@wd/shared';
import {
  DUST_RATE,
  DUST_SLIP,
  SKID_CAPACITY,
  SKID_LIFE,
  SKID_SLIP,
  SkidRing,
  TYRE_WIDTH,
  dustRate,
  emitCount,
  planeHeight,
  groundDust,
  skidFade,
  skidHalfWidth,
  skidInk,
  slipAmount,
  wheelSideSpeed,
  wheelSlip,
  type SlipPose,
} from './tyreSlip.ts';

/** A pose heading `yaw` with `forward` / `side` (+ right) speed, at `x, z`. */
function pose(
  yaw: number,
  forward: number,
  side = 0,
  yawRate = 0,
  x = 0,
  z = 0,
  grounded = true,
): SlipPose {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  // right = (−cos, 0, sin)
  return {
    pos: { x, y: 0, z },
    vel: { x: fx * forward - fz * side, y: 0, z: fz * forward + fx * side },
    yaw,
    yawRate,
    grounded,
  };
}

/** The next pose `dt` later at the same velocity (positions consistent with it). */
function after(p: SlipPose, dt: number, forward: number, side = 0, yawRate = p.yawRate): SlipPose {
  const next = pose(p.yaw + yawRate * dt, forward, side, yawRate, p.pos.x, p.pos.z);
  next.pos.x += next.vel.x * dt;
  next.pos.z += next.vel.z * dt;
  return next;
}

const DT = 1 / 60;

describe('tyre slip', () => {
  it('reads forward and sideways speed in the truck frame at any heading', () => {
    for (const yaw of [0, 0.7, -2.1, Math.PI]) {
      const prev = pose(yaw, 10, 3);
      const s = slipAmount(after(prev, DT, 10, 3), prev, DT);
      expect(s.valid).toBe(true);
      expect(s.forward).toBeCloseTo(10, 6);
      expect(s.side).toBeCloseTo(3, 6);
      expect(s.speed).toBeCloseTo(Math.hypot(10, 3), 6);
      expect(s.accel).toBeCloseTo(0, 4);
    }
  });

  it('measures launches and braking as change of speed, not of its forward share', () => {
    const prev = pose(0.3, 4);
    expect(slipAmount(after(prev, DT, 4 + 6 * DT), prev, DT).accel).toBeCloseTo(6, 4);
    expect(slipAmount(after(prev, DT, 4 - 13 * DT), prev, DT).accel).toBeCloseTo(-13, 4);
    // Velocity turning sideways at the same speed (a drift's rotation) is no braking.
    const turned = pose(0.3, 4 * Math.cos(0.2), 4 * Math.sin(0.2));
    turned.pos.x = turned.vel.x * DT;
    turned.pos.z = turned.vel.z * DT;
    expect(slipAmount(turned, prev, DT).accel).toBeCloseTo(0, 4);
  });

  it('is invalid across cuts, in the air and with a bad dt (no dust, ribbons restart)', () => {
    const prev = pose(0, 10);
    const jumped = after(prev, DT, 10);
    jumped.pos.x += 5; // respawn / reconcile snap / replay cut
    expect(slipAmount(jumped, prev, DT).valid).toBe(false);
    const air = after(prev, DT, 10);
    air.grounded = false;
    expect(slipAmount(air, prev, DT).valid).toBe(false);
    for (const dt of [0, -1, Number.NaN, Infinity]) {
      expect(slipAmount(after(prev, DT, 10), prev, dt).valid).toBe(false);
    }
    for (const w of WHEELS) expect(wheelSlip(w, slipAmount(jumped, prev, DT))).toBe(0);
  });

  it('swings the tail out and the nose in: wheel side speed from the yaw rate', () => {
    // Turning left (+ω) in place: the front moves left (−), the tail right (+).
    expect(wheelSideSpeed('fl', 0, 1)).toBeLessThan(0);
    expect(wheelSideSpeed('rl', 0, 1)).toBeGreaterThan(0);
    expect(wheelSideSpeed('rr', 2, 0)).toBe(2);
  });

  it('keeps every wheel clean when cruising and cornering at the grip limit', () => {
    for (const speed of [3, 8, VEHICLE.topSpeed]) {
      // The sim's yaw at full lock: the bicycle model, capped by the cornering limit.
      const lock =
        VEHICLE.maxSteer + (VEHICLE.minSteer - VEHICLE.maxSteer) * (speed / VEHICLE.topSpeed);
      const yawRate = Math.min(
        (speed * Math.tan(lock)) / TRUCK.wheelbase,
        VEHICLE.maxLateralAccel / speed,
      );
      for (const rate of [0, yawRate, -yawRate]) {
        const prev = pose(0.4, speed, 0, rate);
        const s = slipAmount(after(prev, DT, speed, 0, rate), prev, DT);
        for (const w of WHEELS) expect(wheelSlip(w, s)).toBeLessThan(DUST_SLIP);
      }
    }
  });

  it('slides the rear wheels most in a handbrake drift', () => {
    // Mid-drift: the body slides 4 m/s to the right while yawing left hard.
    const prev = pose(0, 9, 4, 1.4);
    const s = slipAmount(after(prev, DT, 9, 4, 1.4), prev, DT);
    const slip = Object.fromEntries(WHEELS.map((w) => [w, wheelSlip(w, s)]));
    expect(slip.rl).toBeGreaterThan(0.9);
    expect(slip.rr).toBeGreaterThan(0.9);
    expect(slip.fl).toBeGreaterThan(0);
    expect(slip.fl).toBeLessThan(slip.rl! * 0.6);
    for (const w of ['rl', 'rr'] as const) expect(slip[w]).toBeGreaterThanOrEqual(SKID_SLIP);
  });

  it('spins all four on a hard launch and locks them under hard braking', () => {
    const still = pose(0, 0);
    const launch = slipAmount(after(still, DT, VEHICLE.accel * DT), still, DT);
    for (const w of WHEELS) {
      expect(wheelSlip(w, launch, VEHICLE.accel)).toBeGreaterThan(DUST_SLIP);
      // A gentle creep is no wheelspin.
      expect(wheelSlip(w, launch, 1.5)).toBe(0);
    }
    const fast = pose(0, 14);
    const brake = slipAmount(after(fast, DT, 14 - 15 * DT), fast, DT);
    for (const w of WHEELS) expect(wheelSlip(w, brake, -15)).toBeGreaterThan(0.95);
    // The handbrake alone (rear-only, 6 m/s²) locks the rear past the skid threshold, not the
    // front; coasting (1.8) locks nothing.
    const handbrake = -VEHICLE.handbrakeDecel;
    expect(wheelSlip('rl', brake, handbrake)).toBeGreaterThanOrEqual(SKID_SLIP);
    expect(wheelSlip('fl', brake, handbrake)).toBe(0);
    for (const w of WHEELS) expect(wheelSlip(w, brake, -VEHICLE.coastDecel)).toBe(0);
  });
});

describe('tyre dust emission', () => {
  it('emits nothing below the slip threshold and more with slip and speed', () => {
    expect(dustRate(0, 10)).toBe(0);
    expect(dustRate(DUST_SLIP * 0.9, 10)).toBe(0);
    expect(dustRate(Number.NaN, 10)).toBe(0);
    expect(dustRate(0.5, 10)).toBeGreaterThan(dustRate(0.25, 10));
    expect(dustRate(0.5, 10)).toBeGreaterThan(dustRate(0.5, 2));
    expect(dustRate(1, 20)).toBeCloseTo(DUST_RATE);
    expect(dustRate(1, 0)).toBeGreaterThan(0); // a launch from a standstill still dusts
    expect(dustRate(1, 10, true)).toBeCloseTo(dustRate(1, 10) / 2);
  });

  it('spreads a steady rate over frames at any frame rate, capped per frame', () => {
    for (const dt of [1 / 144, 1 / 60, 1 / 22]) {
      let carry = 0;
      let total = 0;
      for (let t = 0; t < 2 - 1e-9; t += dt) {
        const e = emitCount(12, dt, carry);
        carry = e.carry;
        total += e.count;
        expect(carry).toBeGreaterThanOrEqual(0);
        expect(carry).toBeLessThan(1);
      }
      expect(Math.abs(total - 24)).toBeLessThanOrEqual(1);
    }
    expect(emitCount(1000, 1, 0, 6)).toEqual({ count: 6, carry: 0 });
    expect(emitCount(-5, 1, 0.5).count).toBe(0);
  });

  it('colours dust and marks by the ground: warm grey on paving, brown on soil', () => {
    const paving = groundDust('stone');
    const soil = groundDust('soft');
    expect(groundDust(undefined)).toEqual(paving);
    expect(paving[0] / paving[2]).toBeLessThan(1.4);
    expect(soil[0] / soil[2]).toBeGreaterThan(1.6);
    expect(soil[1]).toBeLessThan(paving[1]);
    expect(skidInk('stone').rgb[0]).toBeLessThan(0.05);
    expect(skidInk('soft').rgb[0]).toBeGreaterThan(skidInk('soft').rgb[2]);
  });
});

describe('skid marks', () => {
  it('fades over its life, holding full strength at first', () => {
    expect(skidFade(0)).toBe(1);
    expect(skidFade(5)).toBe(1);
    expect(skidFade(SKID_LIFE * 0.7)).toBeGreaterThan(0);
    expect(skidFade(SKID_LIFE * 0.7)).toBeLessThan(1);
    expect(skidFade(SKID_LIFE)).toBe(0);
    expect(skidFade(1e6)).toBe(0);
    expect(SKID_LIFE).toBeGreaterThanOrEqual(20);
    expect(SKID_LIFE).toBeLessThanOrEqual(30);
  });

  it('finds heights on a tilted ground plane (ribbon edges follow slopes)', () => {
    const n = { x: 0.2, y: Math.sqrt(1 - 0.2 * 0.2 - 0.1 * 0.1), z: 0.1 };
    // Points on the plane satisfy n · (q − p) = 0.
    for (const [x, z] of [
      [1, 0],
      [0, 1],
      [-0.3, 0.4],
    ] as const) {
      const y = planeHeight(2, 1, 3, n, 2 + x, 3 + z);
      expect(n.x * x + n.y * (y - 1) + n.z * z).toBeCloseTo(0, 9);
    }
    expect(planeHeight(0, 0.5, 0, { x: 0, y: 1, z: 0 }, 4, -2)).toBe(0.5);
    // A wall-steep normal is clamped (no runaway heights).
    expect(Math.abs(planeHeight(0, 0, 0, { x: 1, y: 0, z: 0 }, 0.2, 0))).toBeLessThanOrEqual(1);
  });

  it('is a tyre wide rolling along, wider sliding sideways', () => {
    expect(skidHalfWidth(0, 1, 0) * 2).toBeCloseTo(TYRE_WIDTH);
    expect(skidHalfWidth(0, 0, 0) * 2).toBeCloseTo(TYRE_WIDTH);
    const sideways = skidHalfWidth(1, 0, 0);
    expect(sideways).toBeGreaterThan(skidHalfWidth(0.3, 1, 0));
    expect(skidHalfWidth(0.3, 1, 0)).toBeGreaterThan(skidHalfWidth(0, 1, 0));
    // Heading-relative: rolling along a 1 rad heading is the plain width.
    expect(skidHalfWidth(Math.sin(1), Math.cos(1), 1) * 2).toBeCloseTo(TYRE_WIDTH);
  });

  it('keeps a fixed ring of segments, overwriting the oldest', () => {
    const ring = new SkidRing(4);
    const buffers = [ring.positions, ring.colors, ring.uvs, ring.born];
    const quad = Array.from({ length: 12 }, (_, i) => i);
    expect(ring.count).toBe(0);
    for (let i = 0; i < 6; i++) {
      expect(ring.next).toBe(i % 4);
      expect(ring.push(quad, i, i + 1, [0.1, 0.2, 0.3], 0.5, i)).toBe(i % 4);
    }
    expect(ring.count).toBe(4);
    expect([ring.positions, ring.colors, ring.uvs, ring.born]).toEqual(buffers);
    // Slot 0 and 1 were overwritten by pushes 4 and 5.
    expect(ring.ageAt(0, 10)).toBe(6);
    expect(ring.ageAt(1, 10)).toBe(5);
    expect(ring.ageAt(2, 10)).toBe(8);
    // Vertex layout: start L/R, end L/R; u across, v along; RGBA with the given opacity.
    expect(Array.from(ring.positions.slice(12, 24))).toEqual(quad);
    expect(Array.from(ring.uvs.slice(8, 16))).toEqual([0, 5, 1, 5, 0, 6, 1, 6]);
    expect(Array.from(ring.colors.slice(16, 20))).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
      0.5,
    ]);
    // Never-laid slots are long dead.
    expect(skidFade(new SkidRing(2).ageAt(1, 0))).toBe(0);
    expect(SKID_CAPACITY).toBeGreaterThanOrEqual(512);
  });
});
