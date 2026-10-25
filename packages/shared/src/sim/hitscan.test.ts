import { describe, expect, it } from 'vitest';
import { ISKRA, RIFLE, SHOTGUN } from '../config/tunables.ts';
import { humanoidHitboxes } from './hitbox.ts';
import {
  bendShot,
  pelletDirections,
  shotDirection,
  traceGunShot,
  traceShot,
  type HitTarget,
  type WorldRaycaster,
} from './hitscan.ts';
import type { ShotFired } from './weapon.ts';

const open: WorldRaycaster = { castRay: () => null };
const eye = { x: 0, y: 1.6, z: 0 };
// A body 20 m straight ahead (forward is -Z at yaw 0).
const ahead: HitTarget<string> = { id: 'a', shapes: humanoidHitboxes({ x: 0, y: 0, z: -20 }, 1.6) };
const shot = (yaw: number, spreadDeg = 0): ShotFired => ({
  yaw,
  pitch: -0.022,
  spreadDeg,
  seed: 12345,
  shotCounter: 0,
});

describe('traceGunShot (the predicted marker and the soak harness trace every shot with it)', () => {
  it('one pellet: exactly the plain trace of the shot direction', () => {
    const s = shot(0.004, 0.3);
    const [r] = traceGunShot(eye, s, RIFLE, open, [ahead], { smoke: [] });
    expect(r).toEqual(traceShot(eye, shotDirection(s), RIFLE.maxRange, open, [ahead], true));
    expect(r?.kind).toBe('target');
  });

  it('a shotgun traces its whole pellet fan', () => {
    const s = shot(0);
    const results = traceGunShot(eye, s, SHOTGUN, open, [ahead], { smoke: [] });
    expect(results).toHaveLength(SHOTGUN.pellets);
    const dirs = pelletDirections(s, SHOTGUN.pellets, SHOTGUN.pelletSpreadDeg);
    results.forEach((r, i) =>
      expect(r).toEqual(traceShot(eye, dirs[i]!, SHOTGUN.maxRange, open, [ahead], true)),
    );
  });

  it('smart rounds bend toward the sight set, damage only lands on the targets', () => {
    // Aimed 1.5° to the side: inside Iskra's cone, a miss without the bend.
    const s = shot(0.026);
    const bent = bendShot(
      eye,
      shotDirection(s),
      ISKRA.maxRange,
      open,
      [ahead],
      ISKRA.homingConeDeg,
      ISKRA.homingMaxBendDeg,
      { smoke: [] },
    );
    expect(traceShot(eye, shotDirection(s), ISKRA.maxRange, open, [ahead], true).kind).toBe('miss');
    expect(traceGunShot(eye, s, ISKRA, open, [ahead], { smoke: [] })[0]).toEqual(
      traceShot(eye, bent, ISKRA.maxRange, open, [ahead], true),
    );
    // Bent toward a body that can't take damage (not in `targets`): the round finds nobody.
    expect(traceGunShot(eye, s, ISKRA, open, [], { smoke: [] }, [ahead])[0]?.kind).toBe('miss');
  });
});
