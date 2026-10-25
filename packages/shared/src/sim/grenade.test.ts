import { describe, expect, it } from 'vitest';
import { GRENADE, KNIFE, SIM_DT } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import { explosionDamage, spawnGrenade, stepGrenade } from './grenade.ts';
import { humanoidHitboxes } from './hitbox.ts';
import type { WorldHit, WorldRaycaster } from './hitscan.ts';
import { resolveMelee } from './melee.ts';

/** Infinite floor at y = 0, plus optional axis-aligned walls (x ranges at a given z plane). */
function world(
  walls: { z: number; x0: number; x1: number; top: number; bottom?: number }[] = [],
): WorldRaycaster {
  return {
    castRay(o: Vec3, d: Vec3, max: number): WorldHit | null {
      let best: WorldHit | null = null;
      if (d.y < 0) {
        const t = o.y / -d.y;
        if (t >= 0 && t <= max)
          best = {
            distance: t,
            point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t },
            normal: { x: 0, y: 1, z: 0 },
            visible: true,
          };
      }
      for (const w of walls) {
        if (Math.abs(d.z) < 1e-9) continue;
        const t = (w.z - o.z) / d.z;
        if (t < 0 || t > max || (best && t >= best.distance)) continue;
        const p = { x: o.x + d.x * t, y: o.y + d.y * t, z: w.z };
        if (p.x >= w.x0 && p.x <= w.x1 && p.y >= (w.bottom ?? 0) && p.y <= w.top)
          best = {
            distance: t,
            point: p,
            normal: { x: 0, y: 0, z: d.z > 0 ? -1 : 1 },
            visible: true,
          };
      }
      return best;
    },
  };
}

describe('grenade flight', () => {
  it('arcs forward, bounces, loses energy, comes to rest, then explodes on its fuse', () => {
    const w = world();
    const g = spawnGrenade(1, 1, { x: 0, y: 1.6, z: 0 }, 0, 0, { x: 0, y: 0, z: 0 }, w);
    let bounces = 0;
    let exploded = false;
    let t = 0;
    let firstBounce = 0;
    while (!exploded && t < 10) {
      const r = stepGrenade(g, SIM_DT, w);
      if (r.bounceSpeed > 1) {
        bounces++;
        if (!firstBounce) firstBounce = r.bounceSpeed;
      }
      exploded = r.exploded;
      t += SIM_DT;
      expect(g.pos.y).toBeGreaterThan(-0.01); // never through the floor
    }
    expect(exploded).toBe(true);
    expect(t).toBeCloseTo(GRENADE.fuse, 1);
    expect(bounces).toBeGreaterThanOrEqual(1);
    expect(g.resting).toBe(true);
    expect(g.pos.z).toBeLessThan(-8); // thrown forward (yaw 0 = -Z)
  });

  it('bounces back off a wall instead of passing through it', () => {
    const w = world([{ z: -4, x0: -10, x1: 10, top: 10 }]);
    const g = spawnGrenade(1, 1, { x: 0, y: 1.6, z: 0 }, 0, 0, { x: 0, y: 0, z: 0 }, w);
    for (let i = 0; i < 180; i++) {
      stepGrenade(g, SIM_DT, w);
      expect(g.pos.z).toBeGreaterThan(-4);
    }
  });

  it('a grenade resting on something that moves away (a truck bed) falls again', () => {
    const g = spawnGrenade(1, 1, { x: 0, y: 1.6, z: 0 }, 0, -1.2, { x: 0, y: 0, z: 0 }, world());
    g.pos = { x: 0, y: 1.2, z: -2 }; // on a "bed" at 1.2 m
    g.vel = { x: 0, y: 0, z: 0 };
    g.resting = true;
    const bed = world([]);
    const onBed: WorldRaycaster = {
      castRay: (o, d, max) =>
        d.y < 0 && o.y - 1.2 <= max + 1e-9 && o.y >= 1.2
          ? {
              distance: o.y - 1.2,
              point: { ...o, y: 1.2 },
              normal: { x: 0, y: 1, z: 0 },
              visible: true,
            }
          : bed.castRay(o, d, max),
    };
    stepGrenade(g, SIM_DT, onBed);
    expect(g.resting).toBe(true);
    expect(g.pos.y).toBeCloseTo(1.2, 6);
    // The truck drives off: only the street below.
    for (let i = 0; i < 60; i++) stepGrenade(g, SIM_DT, bed);
    expect(g.pos.y).toBeLessThan(0.3);
  });

  it('never spawns inside a wall when thrown point-blank', () => {
    const w = world([{ z: -0.2, x0: -10, x1: 10, top: 10 }]);
    const g = spawnGrenade(1, 1, { x: 0, y: 1.6, z: 0 }, 0, 0, { x: 0, y: 0, z: 0 }, w);
    expect(g.pos.z).toBeGreaterThan(-0.2);
  });
});

describe('explosion damage', () => {
  const c = { x: 0, y: 0.1, z: 0 };
  it('full inside the inner radius, falling to the minimum at the edge, zero beyond', () => {
    const w = world();
    expect(explosionDamage(c, { x: 1, y: 1, z: 0 }, w)).toBe(GRENADE.maxDamage);
    const mid = explosionDamage(c, { x: 4, y: 1, z: 0 }, w);
    expect(mid).toBeLessThan(GRENADE.maxDamage);
    expect(mid).toBeGreaterThan(GRENADE.minDamage);
    expect(explosionDamage(c, { x: GRENADE.blastRadius + 0.5, y: 1, z: 0 }, w)).toBe(0);
  });

  it('a wall between blast and target blocks all damage', () => {
    const w = world([{ z: -1.5, x0: -5, x1: 5, top: 3 }]);
    expect(explosionDamage(c, { x: 0, y: 1, z: -3 }, w)).toBe(0);
    expect(explosionDamage(c, { x: 0, y: 1, z: 3 }, w)).toBeGreaterThan(0);
  });
});

describe('knife hit test', () => {
  const eye = { x: 0, y: 1.62, z: 0 };
  const at = (z: number) => [{ id: 'd', shapes: humanoidHitboxes({ x: 0, y: 0, z }, 1.62) }];

  it('hits within reach, misses beyond it', () => {
    expect(resolveMelee(eye, 0, -0.2, world(), at(-1.2)).kind).toBe('target');
    expect(resolveMelee(eye, 0, -0.2, world(), at(-(KNIFE.range + 0.8))).kind).not.toBe('target');
  });

  it('the sweep radius forgives slightly off-centre slashes', () => {
    const offCentre = [{ id: 'd', shapes: humanoidHitboxes({ x: 0.45, y: 0, z: -1.2 }, 1.62) }];
    expect(resolveMelee(eye, 0, -0.2, world(), offCentre).kind).toBe('target');
  });

  it('walls block the knife', () => {
    const w = world([{ z: -0.6, x0: -5, x1: 5, top: 3 }]);
    expect(resolveMelee(eye, 0, -0.2, w, at(-1.2)).kind).toBe('world');
  });
});

describe('knife arc and reach', () => {
  const eye = { x: 0, y: 1.62, z: 0 };
  const dummyAt = (x: number, z: number) => [
    { id: 'd', shapes: humanoidHitboxes({ x, y: 0, z }, 1.62) },
  ];
  it('a slash catches a target well off-centre (wide swipe)', () => {
    // ~30° to the right at 1.8 m: well outside the blade's inflated radius on the centre ray.
    const t = dummyAt(0.9, -1.56);
    expect(resolveMelee(eye, 0, -0.25, world(), t, 'slash').kind).toBe('target');
  });
  it('the thrust out-reaches a slash', () => {
    const t = dummyAt(0, -(KNIFE.range + 0.55));
    expect(resolveMelee(eye, 0, -0.2, world(), t, 'slash').kind).not.toBe('target');
    expect(resolveMelee(eye, 0, -0.2, world(), t, 'thrust').kind).toBe('target');
  });
});

describe('knife regressions (Codex review)', () => {
  const eye = { x: 0, y: 1.62, z: 0 };
  it('a wall touched only by a side ray still registers as a wall hit', () => {
    // Wall 1.2 m ahead, only on the right side of the fan.
    const w = world([{ z: -1.2, x0: 0.5, x1: 5, top: 3 }]);
    expect(resolveMelee(eye, 0, 0, w, [], 'slash').kind).toBe('world');
  });
});

describe('knife point-blank (lunged into the target)', () => {
  it('connects when the eye is already inside the target reach', () => {
    const eye = { x: 0, y: 1.62, z: 0 };
    const t = [{ id: 'd', shapes: humanoidHitboxes({ x: 0, y: 0, z: -0.15 }, 1.62) }];
    expect(resolveMelee(eye, 0, -0.2, world(), t, 'slash').kind).toBe('target');
  });
});

describe('knife point-blank guards (Codex re-review)', () => {
  const eye = { x: 0, y: 1.62, z: 0 };
  const close = () => [{ id: 'd', shapes: humanoidHitboxes({ x: 0, y: 0, z: -0.15 }, 1.62) }];
  it('does not hit a point-blank target behind you', () => {
    expect(resolveMelee(eye, Math.PI, -0.2, world(), close(), 'slash').kind).not.toBe('target');
  });
  it('picks the zone you aim at, not the first overlapping volume', () => {
    const r = resolveMelee(eye, 0, -0.9, world(), close(), 'slash'); // aiming down at the chest
    expect(r.kind === 'target' && r.zone).toBe('torso');
  });
  it('hits the overlapping target you aim at, regardless of list order', () => {
    // A second body just to the left overlaps at contact range; aiming dead ahead picks 'd'.
    const side = { id: 'side', shapes: humanoidHitboxes({ x: -0.3, y: 0, z: -0.3 }, 1.62) };
    // (It qualifies on its own, so the test really exercises the choice.)
    const alone = resolveMelee(eye, 0, -0.5, world(), [side], 'slash');
    expect(alone.kind === 'target' && alone.targetId).toBe('side');
    const r = resolveMelee(eye, 0, -0.5, world(), [side, ...close()], 'slash');
    expect(r.kind === 'target' && r.targetId).toBe('d');
  });
  it('overlapping bodies: the blade meets the nearer one first', () => {
    const near = { id: 'near', shapes: humanoidHitboxes({ x: 0, y: 0, z: -0.15 }, 1.62) };
    const far = { id: 'far', shapes: humanoidHitboxes({ x: 0, y: 0, z: -0.3 }, 1.62) };
    const r = resolveMelee(eye, 0, -0.5, world(), [far, near], 'slash');
    expect(r.kind === 'target' && r.targetId).toBe('near');
  });
  it('cover right in front of the blade stops a point-blank strike', () => {
    // A chest-high lip blocks the aimed swing, though the line down to the torso passes under it.
    const t = [{ id: 'd', shapes: humanoidHitboxes({ x: 0, y: 0, z: -0.35 }, 1.62) }];
    const lip = world([{ z: -0.2, x0: -1, x1: 1, bottom: 1.5, top: 1.8 }]);
    expect(resolveMelee(eye, 0, 0, world(), t, 'slash').kind).toBe('target'); // sanity: no lip
    expect(resolveMelee(eye, 0, 0, lip, t, 'slash').kind).not.toBe('target');
  });
  it('does not hit a point-blank target while looking up at the sky', () => {
    expect(resolveMelee(eye, 0, 1.4, world(), close(), 'slash').kind).not.toBe('target');
  });
});
