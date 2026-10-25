import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER, SKATEBOARD } from '../config/tunables.ts';
import { quatFromEulerDeg, rotateByQuat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { Button } from '../sim/input.ts';
import { createPlayerState } from '../sim/player.ts';
import { boardSpawn } from '../sim/skateboard.ts';
import { run } from '../sim/testUtils.ts';
import { boxMinMax } from './builder.ts';
import { helicopterWreck } from './props.ts';
import { getMap, resolveMap } from './registry.ts';
import type { MapBox, MapDefinition } from './types.ts';

/** The cabin's crash pitch (nose down), shared with tools/assets/heli_collision.py. */
const HELI_WRECK_PITCH = 3;

beforeAll(async () => {
  await initPhysics();
});

/** The wreck alone at the origin (rot 0: cabin along +X, nose −X) on open ground. */
function wreckWorld(): { world: PhysicsWorld; boxes: MapBox[] } {
  const boxes = helicopterWreck({ x: 0, z: 0 });
  const map: MapDefinition = {
    name: 'heli',
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    boxes: [boxMinMax({ x: -30, y: -1, z: -30 }, { x: 30, y: 0, z: 30 }, 'ground'), ...boxes],
    spawns: [],
    dummies: [],
  };
  return { world: new PhysicsWorld(map), boxes };
}

/** A box's corners in world space. */
function corners(b: MapBox): Vec3[] {
  const q = quatFromEulerDeg(b.rot);
  const out: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const r = rotateByQuat(
          { x: (sx * b.size.x) / 2, y: (sy * b.size.y) / 2, z: (sz * b.size.z) / 2 },
          q,
        );
        out.push({ x: b.center.x + r.x, y: b.center.y + r.y, z: b.center.z + r.z });
      }
  return out;
}

/** Into the shell's frame: undo the pitch about the origin (x along the cabin). */
function shellFrame(p: Vec3): Vec3 {
  const th = (-HELI_WRECK_PITCH * Math.PI) / 180;
  return {
    x: p.x * Math.cos(th) - p.y * Math.sin(th),
    y: p.x * Math.sin(th) + p.y * Math.cos(th),
    z: p.z,
  };
}

/** Yaw that walks toward +X / +Z (forward = −Z turned by yaw). */
const TO_PLUS_X = -Math.PI / 2;
const TO_PLUS_Z = Math.PI;

describe('helicopter wreck collision', () => {
  it('is one rigid shell: every cabin panel shares the pitch and the panels meet', () => {
    const shell = helicopterWreck({ x: 0, z: 0 }).slice(0, 13);
    for (const b of shell) expect(b.rot).toEqual({ x: 0, y: 0, z: HELI_WRECK_PITCH });
    const ext = shell.map((b) => {
      const c = corners(b).map(shellFrame);
      return {
        y0: Math.min(...c.map((p) => p.y)),
        y1: Math.max(...c.map((p) => p.y)),
        x0: Math.min(...c.map((p) => p.x)),
        x1: Math.max(...c.map((p) => p.x)),
      };
    });
    const [floor, roof, , , , ...rest] = ext; // floor, roof, cockpit (two steps), rear
    const walls = rest.slice(0, 6).filter((_, i) => i !== 2 && i !== 5); // not the door headers
    for (const w of walls) {
      // Each wall reaches into the floor slab and the roof: no slots between them.
      expect(w.y0).toBeLessThan(floor!.y1 - 0.05);
      expect(w.y1).toBeGreaterThan(roof!.y0 + 0.05);
    }
    // 2.25 m of headroom inside, axis-aligned in the shell frame.
    expect(roof!.y0 - floor!.y1).toBeGreaterThan(2.1);
    expect(floor!.x1 - floor!.x0).toBeCloseTo(5.6, 2);
    // The nose collider stays inside the model's nose (x ≥ −4.05 low down, ≥ −3.35 above 1 m
    // in the prop frame), so no invisible metal stands in front of it.
    const [, , nose, noseTop] = shell.map((b) => corners(b));
    expect(Math.min(...nose!.map((p) => p.x))).toBeGreaterThan(-4.05);
    expect(Math.min(...noseTop!.map((p) => p.x))).toBeGreaterThan(-3.35);
  });

  it('placed with a yaw, every collider (crash-tilted boom, fin and blade too) stays on the model', () => {
    // The model is drawn in the prop's local frame turned by the yaw about the anchor; each
    // collider's corners must be its local corners turned the same way (the Market wreck: 160°).
    const local = helicopterWreck({ x: 0, z: 0 });
    for (const at of [
      { x: 74, z: 32, rot: 160 },
      { x: -12, z: 5, rot: 75 },
      { x: 3, z: -40, rot: -110 },
    ]) {
      const placed = helicopterWreck(at);
      expect(placed).toHaveLength(local.length);
      const yaw = quatFromEulerDeg({ x: 0, y: at.rot, z: 0 });
      let worst = 0;
      placed.forEach((b, i) => {
        const want = corners(local[i]!).map((c) => {
          const r = rotateByQuat(c, yaw);
          return { x: at.x + r.x, y: r.y, z: at.z + r.z };
        });
        corners(b).forEach((c, k) => {
          const w = want[k]!;
          worst = Math.max(worst, Math.hypot(c.x - w.x, c.y - w.y, c.z - w.z));
        });
      });
      expect(worst, `rot ${at.rot}`).toBeLessThan(1e-4);
    }
  });

  it('the belly sits on the ground: nothing to crawl under', () => {
    const floor = helicopterWreck({ x: 0, z: 0 })[0]!;
    const c = corners(floor);
    // The slab's lowest edge along the whole length is at or below the ground.
    expect(Math.max(...c.filter((p) => p.y < 0.2).map((p) => p.y))).toBeLessThanOrEqual(0.03);
    const near = (xs: number) => {
      const r = c.filter((p) => p.y < 0.1).map((p) => p.x);
      return xs < 0 ? Math.min(...r) : Math.max(...r);
    };
    expect(near(-1)).toBeLessThan(-2.7);
    expect(near(1)).toBeGreaterThan(2.7);
  });

  it('is walkable: in through the left door, along the floor to the rear, out the right door', () => {
    const { world } = wreckWorld();
    const start = { x: -0.8, y: 0.05, z: -2.8 };
    const p = createPlayerState(start);
    const body = world.createCharacter(start);
    run(p, body, 0.75, { moveZ: 1, yaw: TO_PLUS_Z });
    expect(Math.abs(p.move.pos.z)).toBeLessThan(0.9); // inside the cabin
    expect(p.move.pos.y).toBeGreaterThan(0.15); // on the floor, not the ground
    run(p, body, 1.5, { moveZ: 1, yaw: TO_PLUS_X });
    expect(p.move.pos.x).toBeGreaterThan(2.0); // reached the rear
    run(p, body, 0.55, { moveZ: 1, yaw: -TO_PLUS_X });
    run(p, body, 2.5, { moveZ: 1, yaw: TO_PLUS_Z });
    expect(p.move.pos.z).toBeGreaterThan(1.8); // out of the right door
    body.free();
  });

  it('the skateboard spot is on the hull floor, reachable, and no capsule overlaps it', () => {
    const market = resolveMap(getMap('defilad'), 'market');
    const spot = market.skateboard!;
    const mw = new PhysicsWorld(market);
    const board = boardSpawn(spot, (from) => mw.castRay(from, { x: 0, y: -1, z: 0 }, 5));
    expect(board.y).toBeGreaterThan(0.2); // the floor, not the ground under the hull
    expect(board.y).toBeLessThan(0.8);
    expect(mw.overlapsStatic({ ...board, y: board.y + 0.02 }, PLAYER.standHeight)).toBe(false);
    // In the wreck's frame (74, 32, rot 160), and walked to on the lone wreck.
    const yaw = (160 * Math.PI) / 180;
    const dx = board.x - 74;
    const dz = board.z - 32;
    const local = {
      x: dx * Math.cos(yaw) - dz * Math.sin(yaw),
      z: dx * Math.sin(yaw) + dz * Math.cos(yaw),
    };
    expect(Math.abs(local.z)).toBeLessThan(1.0);
    expect(local.x).toBeGreaterThan(-2.7);
    expect(local.x).toBeLessThan(2.7);
    const { world } = wreckWorld();
    const start = { x: -0.8, y: 0.05, z: -2.8 };
    const p = createPlayerState(start);
    const body = world.createCharacter(start);
    run(p, body, 0.75, { moveZ: 1, yaw: TO_PLUS_Z });
    run(p, body, 4, (i) => {
      const toX = local.x - p.move.pos.x;
      const toZ = local.z - p.move.pos.z;
      return Math.hypot(toX, toZ) < 0.3 || i < 0 ? {} : { moveZ: 1, yaw: Math.atan2(-toX, -toZ) };
    });
    expect(Math.hypot(p.move.pos.x - local.x, p.move.pos.z - local.z)).toBeLessThan(
      SKATEBOARD.pickupRadius,
    );
    body.free();
  }, 30_000);

  it('anti-clipping sweep round and through the wreck stays clean', () => {
    const { world } = wreckWorld();
    const failures: string[] = [];
    let runs = 0;
    for (let x = -8; x <= 12; x += 2) {
      for (let z = -5; z <= 8; z += 2) {
        const probe = world.castRay({ x, y: 9, z }, { x: 0, y: -1, z: 0 }, 12);
        if (!probe) continue;
        const start = { x, y: probe.point.y + 0.05, z };
        if (start.y > 4 || world.overlapsStatic(start, PLAYER.standHeight)) continue;
        for (let d = 0; d < 8; d++) {
          const yaw = (d / 8) * Math.PI * 2;
          const p = createPlayerState(start);
          const body = world.createCharacter(start);
          runs++;
          run(
            p,
            body,
            2.0,
            (i) => ({
              moveZ: 1,
              moveX: d % 3 === 0 ? 0.4 : 0,
              yaw,
              buttons:
                Button.Sprint |
                (i % 40 === 5 ? Button.Jump : 0) |
                (i % 90 > 70 ? Button.Crouch : 0),
            }),
            (_ev, step) => {
              const pos = p.move.pos;
              const h = p.move.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
              if (world.overlapsStatic(pos, h, 0.03))
                failures.push(`overlap start=(${x},${z}) yaw=${d} step=${step}`);
            },
          );
          body.free();
          if (failures.length > 10) break;
        }
      }
    }
    expect(runs).toBeGreaterThan(300);
    expect(failures.slice(0, 10)).toEqual([]);
  }, 120_000);
});
