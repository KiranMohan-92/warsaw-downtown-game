import { describe, expect, it } from 'vitest';
import { RIFLE } from '../config/tunables.ts';
import { DEG, len3, viewDir, type Vec3 } from '../math/vec3.ts';
import { applyDamage, computeDamage, falloffMultiplier } from './damage.ts';
import { humanoidHitboxes, rayCapsule, raySphere } from './hitbox.ts';
import { shotDirection, traceShot, type WorldRaycaster } from './hitscan.ts';
import type { ShotFired } from './weapon.ts';

const noWorld: WorldRaycaster = { castRay: () => null };
const wallAt = (z: number): WorldRaycaster => ({
  castRay: (o: Vec3, d: Vec3, max: number) => {
    if (d.z >= 0) return null;
    const t = (o.z - z) / -d.z;
    return t >= 0 && t <= max
      ? {
          distance: t,
          point: { x: o.x + d.x * t, y: o.y + d.y * t, z },
          normal: { x: 0, y: 0, z: 1 },
          visible: true,
        }
      : null;
  },
});

describe('damage', () => {
  it('applies zone multipliers', () => {
    expect(computeDamage('torso', 5)).toBe(RIFLE.damage);
    expect(computeDamage('head', 5)).toBe(RIFLE.damage * RIFLE.headMultiplier);
    expect(computeDamage('legs', 5)).toBe(Math.round(RIFLE.damage * RIFLE.legMultiplier * 10) / 10);
  });

  it('falls off linearly between start and end, then floors', () => {
    expect(falloffMultiplier(RIFLE.falloffStart)).toBe(1);
    const mid = (RIFLE.falloffStart + RIFLE.falloffEnd) / 2;
    expect(falloffMultiplier(mid)).toBeCloseTo((1 + RIFLE.falloffMinMultiplier) / 2, 6);
    expect(falloffMultiplier(500)).toBe(RIFLE.falloffMinMultiplier);
  });

  it('4 body shots or 2 headshots kill at close range', () => {
    const t = { health: 100 };
    for (let i = 0; i < 3; i++) expect(applyDamage(t, computeDamage('torso', 10))).toBe(false);
    expect(applyDamage(t, computeDamage('torso', 10))).toBe(true);
    const h = { health: 100 };
    applyDamage(h, computeDamage('head', 10));
    expect(applyDamage(h, computeDamage('head', 10))).toBe(true);
  });

  it('cannot kill twice', () => {
    const t = { health: 10 };
    expect(applyDamage(t, 50)).toBe(true);
    expect(applyDamage(t, 50)).toBe(false);
  });
});

describe('ray primitives', () => {
  const o = { x: 0, y: 0, z: 0 };
  const fwd = { x: 0, y: 0, z: -1 };
  it('sphere hit distance', () => {
    expect(raySphere(o, fwd, { x: 0, y: 0, z: -10 }, 1)).toBeCloseTo(9, 9);
    expect(raySphere(o, fwd, { x: 2, y: 0, z: -10 }, 1)).toBe(-1);
    expect(raySphere(o, fwd, { x: 0, y: 0, z: 10 }, 1)).toBe(-1); // behind
  });
  it('capsule hit on side and on cap', () => {
    const a = { x: 0, y: -1, z: -10 };
    const b = { x: 0, y: 1, z: -10 };
    expect(rayCapsule(o, fwd, a, b, 0.5)).toBeCloseTo(9.5, 9);
    const down = { x: 0, y: -1, z: 0 };
    expect(rayCapsule({ x: 0, y: 5, z: -10 }, down, a, b, 0.5)).toBeCloseTo(3.5, 9);
    expect(rayCapsule(o, fwd, { x: 1, y: -1, z: -10 }, { x: 1, y: 1, z: -10 }, 0.5)).toBe(-1);
  });
});

describe('hitscan', () => {
  const feet = { x: 0, y: 0, z: -20 };
  const target = { id: 'dummy', shapes: humanoidHitboxes(feet, 1.62) };

  it('a muzzle inside a body hits it (bullets), but not with hitFromInside off (knife)', () => {
    const eye = { x: 0, y: 1.2, z: -20 }; // inside the dummy's torso capsule
    const dir = viewDir(0, 0);
    const bullet = traceShot(eye, dir, 100, noWorld, [target], true);
    expect(bullet.kind === 'target' && bullet.zone).toBe('torso');
    expect(traceShot(eye, dir, 100, noWorld, [target]).kind).toBe('miss');
  });

  it('a muzzle inside two overlapping bodies hits the one the shot points into', () => {
    const eye = { x: 0, y: 1.2, z: -20 };
    const back = { id: 'back', shapes: humanoidHitboxes({ x: 0, y: 0, z: -20.15 }, 1.62) };
    const pick = (yaw: number) => {
      const r = traceShot(eye, viewDir(yaw, 0), 100, noWorld, [target, back], true);
      return r.kind === 'target' ? r.targetId : r.kind;
    };
    expect(pick(0)).toBe('back'); // shooting toward -Z, into the body behind
    expect(pick(Math.PI)).toBe('dummy');
  });

  it('firing away from a body you overlap does not hit it', () => {
    // Muzzle just inside the torso's surface (4 cm deep), shooting straight out of the body.
    const eye = { x: 0, y: 1.2, z: -19.8 };
    const r = traceShot(eye, viewDir(Math.PI, 0), 100, noWorld, [target], true);
    expect(r.kind).toBe('miss');
  });

  it('zero-spread shot follows the aim exactly', () => {
    const shot: ShotFired = { yaw: 0.3, pitch: -0.2, spreadDeg: 0, seed: 1, shotCounter: 0 };
    const d = shotDirection(shot);
    const v = viewDir(0.3, -0.2);
    expect(d.x).toBeCloseTo(v.x, 12);
    expect(d.y).toBeCloseTo(v.y, 12);
  });

  it('spread is deterministic per seed and stays inside the cone', () => {
    const aim = viewDir(0, 0);
    for (let seed = 0; seed < 200; seed++) {
      const shot: ShotFired = { yaw: 0, pitch: 0, spreadDeg: 3, seed, shotCounter: seed };
      const a = shotDirection(shot);
      const b = shotDirection(shot);
      expect(a).toEqual(b);
      expect(len3(a)).toBeCloseTo(1, 9);
      const angle = Math.acos(Math.min(1, a.x * aim.x + a.y * aim.y + a.z * aim.z));
      expect(angle).toBeLessThanOrEqual(3 * DEG + 1e-9);
    }
  });

  it('hits head / torso / legs by aim height', () => {
    const at = (y: number): string => {
      const r = traceShot({ x: 0, y, z: 0 }, { x: 0, y: 0, z: -1 }, 100, noWorld, [target]);
      return r.kind === 'target' ? r.zone : r.kind;
    };
    expect(at(1.66)).toBe('head');
    expect(at(1.2)).toBe('torso');
    expect(at(0.5)).toBe('legs');
    expect(at(2.2)).toBe('miss');
  });

  it('walls block shots; targets in front of walls are hit', () => {
    const o = { x: 0, y: 1.2, z: 0 };
    const dir = { x: 0, y: 0, z: -1 };
    expect(traceShot(o, dir, 100, wallAt(-10), [target]).kind).toBe('world');
    const r = traceShot(o, dir, 100, wallAt(-30), [target]);
    expect(r.kind).toBe('target');
  });

  it('picks the nearest of several targets', () => {
    const near = { id: 'near', shapes: humanoidHitboxes({ x: 0, y: 0, z: -8 }, 1.62) };
    const r = traceShot({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 100, noWorld, [
      target,
      near,
    ]);
    expect(r.kind === 'target' && r.targetId).toBe('near');
  });
});
