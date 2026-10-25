import { describe, expect, it } from 'vitest';
import {
  CAMERA_RADIUS,
  CameraSpline,
  CollisionSmoother,
  collideCamera,
  easeOutCubic,
  follow,
  forwardOf,
  lookAngles,
  orbitPoint,
  overShoulder,
  WIDE_PIVOT_HEIGHT,
  wideVantage,
  smootherstep,
  smoothstep,
  type RayCast,
  type V3,
} from './cinematicMath.ts';

const v = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

/** A wall: the plane x = `at` (infinite), as the physics ray would see it. */
const wallAtX =
  (at: number): RayCast =>
  (o, d, max) => {
    if (Math.abs(d.x) < 1e-9) return null;
    const t = (at - o.x) / d.x;
    return t >= 0 && t <= max ? t : null;
  };

describe('easing', () => {
  it('starts at 0, ends at 1, clamps outside and never goes backwards', () => {
    for (const f of [smoothstep, smootherstep, easeOutCubic]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      expect(f(-2)).toBe(0);
      expect(f(3)).toBe(1);
      let last = 0;
      for (let i = 1; i <= 100; i++) {
        const y = f(i / 100);
        expect(y).toBeGreaterThanOrEqual(last);
        last = y;
      }
    }
  });

  it('smootherstep arrives with zero velocity (the intro hands off without a jerk)', () => {
    const h = 1e-4;
    expect((smootherstep(1) - smootherstep(1 - h)) / h).toBeLessThan(1e-3);
    expect((smootherstep(h) - smootherstep(0)) / h).toBeLessThan(1e-3);
  });

  it('follow is frame-rate independent', () => {
    // Two 1/120 s steps cover the same fraction as one 1/60 s step.
    const one = follow(1 / 60, 0.1);
    const half = follow(1 / 120, 0.1);
    expect(1 - (1 - half) * (1 - half)).toBeCloseTo(one, 10);
    expect(follow(0.1, 0)).toBe(1);
  });
});

describe('CameraSpline', () => {
  const keys: V3[] = [v(0, 10, 0), v(30, 12, 5), v(40, 4, 30), v(42, 1.6, 36)];
  const spline = new CameraSpline(keys.length);
  keys.forEach((k, i) => spline.setKey(i, k.x, k.y, k.z));
  spline.update();

  it('starts on the first key and ends exactly on the last', () => {
    const out = v();
    spline.sample(0, out);
    expect(out).toEqual(keys[0]);
    spline.sample(1, out);
    expect(out.x).toBeCloseTo(42, 9);
    expect(out.y).toBeCloseTo(1.6, 9);
    expect(out.z).toBeCloseTo(36, 9);
  });

  it('passes through every key, continuously (no jumps between frames)', () => {
    const out = v();
    const prev = v();
    spline.sample(0, prev);
    let nearest = keys.map(() => Number.POSITIVE_INFINITY);
    const steps = 2000;
    const maxStep = (spline.length / steps) * 3;
    for (let i = 1; i <= steps; i++) {
      spline.sample(i / steps, out);
      expect(Math.hypot(out.x - prev.x, out.y - prev.y, out.z - prev.z)).toBeLessThan(maxStep);
      nearest = nearest.map((d, k) =>
        Math.min(d, Math.hypot(out.x - keys[k]!.x, out.y - keys[k]!.y, out.z - keys[k]!.z)),
      );
      Object.assign(prev, out);
    }
    for (const d of nearest) expect(d).toBeLessThan(0.05);
  });

  it('keys can move (the last one follows the eye) without reallocating', () => {
    spline.setKey(3, 50, 2, 40);
    spline.update();
    const out = v();
    spline.sample(1, out);
    expect(out.x).toBeCloseTo(50, 9);
    expect(out.z).toBeCloseTo(40, 9);
  });

  it('stays between collinear keys (centripetal: no overshoot)', () => {
    const s = new CameraSpline(3);
    s.setKey(0, 0, 0, 0);
    s.setKey(1, 1, 0, 0);
    s.setKey(2, 10, 0, 0);
    s.update();
    const out = v();
    for (let i = 0; i <= 100; i++) {
      s.sample(i / 100, out);
      expect(out.x).toBeGreaterThanOrEqual(-1e-9);
      expect(out.x).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it('handles coincident keys', () => {
    const s = new CameraSpline(2);
    s.setKey(0, 1, 2, 3);
    s.setKey(1, 1, 2, 3);
    s.update();
    const out = v();
    expect(s.sample(0.5, out)).toEqual(v(1, 2, 3));
  });
});

describe('placement', () => {
  it('orbit angle = yaw sits behind the subject, yaw + π in front', () => {
    const c = v(10, 1, -4);
    const yaw = 0.7;
    const f = forwardOf(yaw, 0, v());
    const behind = orbitPoint(c, 3, 1.5, yaw, v());
    const front = orbitPoint(c, 3, 1.5, yaw + Math.PI, v());
    const along = (p: V3): number => (p.x - c.x) * f.x + (p.z - c.z) * f.z;
    expect(along(behind)).toBeCloseTo(-3, 9);
    expect(along(front)).toBeCloseTo(3, 9);
    expect(behind.y).toBeCloseTo(2.5, 9);
  });

  it('over the shoulder: behind the eye, to its right, above', () => {
    const eye = v(0, 1.6, 0);
    // Facing -Z (yaw 0): behind = +Z, right = +X.
    const p = overShoulder(eye, 0, 0, 1.8, 0.5, 0.3, v());
    expect(p.x).toBeCloseTo(0.5, 9);
    expect(p.y).toBeCloseTo(1.9, 9);
    expect(p.z).toBeCloseTo(1.8, 9);
    // Facing +X (yaw −π/2): behind = −X, right = +Z.
    const q = overShoulder(eye, -Math.PI / 2, 0, 1.8, 0.5, 0, v());
    expect(q.x).toBeCloseTo(-1.8, 9);
    expect(q.z).toBeCloseTo(0.5, 9);
  });

  it('lookAngles inverts forwardOf', () => {
    const from = v(3, 2, 1);
    for (const [yaw, pitch] of [
      [0.3, -0.4],
      [-2.5, 0.9],
      [3, 0],
    ] as const) {
      const f = forwardOf(yaw, pitch, v());
      const out = { yaw: 0, pitch: 0 };
      lookAngles(from, v(from.x + f.x * 5, from.y + f.y * 5, from.z + f.z * 5), out);
      expect(Math.cos(out.yaw - yaw)).toBeCloseTo(1, 9);
      expect(out.pitch).toBeCloseTo(pitch, 9);
    }
  });
});

describe('wideVantage', () => {
  const bounds = { minX: 38, maxX: 170, minZ: -62, maxZ: 64 };
  /** Ground at y = 0, with a roof at y = 8 over the map's middle. */
  const world =
    (roof: boolean): RayCast =>
    (o, d, max) => {
      if (d.y >= 0) return null;
      const t = (o.y - (roof ? 8 : 0)) / -d.y;
      return t >= 0 && t <= max ? t : null;
    };

  it('floats the pivot in open air above the ground under the middle of the map', () => {
    const v = wideVantage(bounds, world(false));
    expect(v.pivot).toEqual({ x: 104, y: WIDE_PIVOT_HEIGHT, z: 1 });
    expect(v.look).toEqual({ x: 104, y: 0, z: 1 });
  });

  it('clears a building there too, and survives a map with no ground under it', () => {
    expect(wideVantage(bounds, world(true)).pivot.y).toBe(8 + WIDE_PIVOT_HEIGHT);
    expect(wideVantage(bounds, () => null).pivot.y).toBe(WIDE_PIVOT_HEIGHT);
  });
});

describe('camera collision', () => {
  it('leaves a clear shot alone', () => {
    const out = v();
    const free = collideCamera(v(0, 1, 0), v(3, 1, 0), () => null, out);
    expect(free).toBeCloseTo(3, 9);
    expect(out).toEqual(v(3, 1, 0));
  });

  it('pulls the camera in front of a wall between it and the subject', () => {
    const out = v();
    const free = collideCamera(v(0, 1, 0), v(4, 1, 0), wallAtX(2), out);
    expect(free).toBeCloseTo(2 - CAMERA_RADIUS, 9);
    expect(out.x).toBeCloseTo(2 - CAMERA_RADIUS, 9);
    expect(out.x).toBeLessThan(2); // never on the far side of the wall
  });

  it('keeps off a wall just behind the wanted spot too (radius)', () => {
    const out = v();
    collideCamera(v(0, 1, 0), v(3, 1, 0), wallAtX(3.1), out);
    expect(out.x).toBeLessThanOrEqual(3.1 - CAMERA_RADIUS + 1e-9);
  });

  it('keeps the margin off a wall met at a grazing angle', () => {
    // Wall x = 2 with its normal; the camera heads along it at ~20°.
    const cast: RayCast = (o, d, max, n) => {
      const t = wallAtX(2)(o, d, max);
      if (t !== null && n) Object.assign(n, { x: -1, y: 0, z: 0 });
      return t;
    };
    const out = v();
    const dir = { x: Math.sin(0.35), z: Math.cos(0.35) };
    collideCamera(v(0, 1, 0), v(dir.x * 12, 1, dir.z * 12), cast, out);
    // Perpendicular distance to the wall still at least the radius.
    expect(2 - out.x).toBeGreaterThanOrEqual(CAMERA_RADIUS - 1e-9);
  });

  it('never passes through a wall, even one hard against the subject', () => {
    const out = v();
    const free = collideCamera(v(0, 1, 0), v(5, 1, 0), wallAtX(0.1), out);
    expect(free).toBeGreaterThanOrEqual(0);
    expect(out.x).toBeLessThan(0.1);
  });

  it('smoother: pulls in at once, eases back out', () => {
    const s = new CollisionSmoother();
    expect(s.update(5, 5, 1 / 60)).toBe(5);
    expect(s.update(1.2, 5, 1 / 60)).toBe(1.2); // a wall came closer: immediately
    const next = s.update(5, 5, 1 / 60);
    expect(next).toBeGreaterThan(1.2);
    expect(next).toBeLessThan(1.5); // eased, not popped
    let d = next;
    for (let i = 0; i < 300; i++) d = s.update(5, 5, 1 / 60);
    expect(d).toBeCloseTo(5, 3);
    s.reset();
    expect(s.update(2, 3, 1 / 60)).toBe(2);
  });
});
