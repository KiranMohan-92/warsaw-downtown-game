import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER } from '../config/tunables.ts';
import { boxMinMax } from '../maps/builder.ts';
import { DECOR_KINDS } from '../maps/decor.ts';
import { DECOR_MODELS, fitDecor, PROP_SIZES, propSurface } from '../maps/propModels.ts';
import type { MapDecor, MapDefinition } from '../maps/types.ts';
import { Button } from '../sim/input.ts';
import { createPlayerState } from '../sim/player.ts';
import { run } from '../sim/testUtils.ts';
import { initPhysics, MOVE_HULL_MODELS, PhysicsWorld } from './world.ts';

beforeAll(async () => {
  await initPhysics();
});

const mapOf = (decor: MapDecor[]): MapDefinition => ({
  name: 'hulls',
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
  boxes: [boxMinMax({ x: -30, y: -1, z: -30 }, { x: 30, y: 0, z: 30 }, 'ground')],
  decor,
  spawns: [],
  dummies: [],
});

describe('prop movement hulls', () => {
  it('give every dense prop one convex hull for characters, and none to lamps or cars', () => {
    const decor = DECOR_KINDS.map((kind, i): MapDecor => ({ kind, x: i * 3 - 12, z: 0, rot: 17 }));
    const world = new PhysicsWorld(mapOf(decor));
    let hulls = 0;
    world.world.forEachCollider((c) => {
      if (c.shape.type === RAPIER.ShapeType.ConvexPolyhedron) hulls++;
    });
    const expected = decor
      .flatMap((d) => fitDecor(d, PROP_SIZES))
      .filter((inst) => MOVE_HULL_MODELS.has(inst.model)).length;
    expect(hulls).toBe(expected);
    expect(hulls).toBeGreaterThan(0);
    expect(MOVE_HULL_MODELS.has('lamp')).toBe(false);
    expect(MOVE_HULL_MODELS.has('car')).toBe(false);
  });

  it('are invisible to rays: bullets still hit the exact scan', () => {
    // A grid of horizontal rays through a bin and a drum: every hit is where the bare scan
    // trimesh is hit (a hull would stop rays earlier and catch rays that pass the scan's waist).
    for (const kind of ['bin', 'drum'] as const) {
      const world = new PhysicsWorld(mapOf([{ kind, x: 0, z: 0, rot: 17 }]));
      const raw = new RAPIER.World({ x: 0, y: 0, z: 0 });
      for (const inst of fitDecor({ kind, x: 0, z: 0, rot: 17 }, PROP_SIZES)) {
        const { positions, indices } = propSurface(inst);
        raw.createCollider(RAPIER.ColliderDesc.trimesh(positions, indices));
      }
      raw.step();
      let hits = 0;
      let differs = 0;
      for (let y = 0.05; y < 0.9; y += 0.05)
        for (let x = -0.35; x <= 0.35; x += 0.02) {
          const hit = world.castRay({ x, y, z: 2 }, { x: 0, y: 0, z: -1 }, 4);
          const ref = raw.castRay(new RAPIER.Ray({ x, y, z: 2 }, { x: 0, y: 0, z: -1 }), 4, true);
          expect(hit === null).toBe(ref === null);
          if (!hit || !ref) continue;
          hits++;
          if (Math.abs(hit.distance - ref.timeOfImpact) > 1e-4) differs++;
        }
      expect(hits).toBeGreaterThan(20);
      expect(differs).toBe(0);
      raw.free();
      world.free();
    }
  });

  it('stop a sprint into a bin cheaply, never stepping onto it or resting inside it', () => {
    const world = new PhysicsWorld(mapOf([{ kind: 'bin', x: 0, z: 0 }]));
    let steps = 0;
    let ms = 0;
    let highest = 0;
    for (let a = 0; a < 8; a++) {
      // Sprint straight at it from 1.5 m away (yaw 0 faces -z).
      const yaw = (a * Math.PI) / 4;
      const feet = { x: Math.sin(yaw) * 1.5, y: 0.02, z: Math.cos(yaw) * 1.5 };
      const p = createPlayerState(feet);
      const body = world.createCharacter(feet);
      run(p, body, 0.2, {});
      const t0 = Date.now();
      run(p, body, 1, { yaw, moveZ: 1, buttons: Button.Sprint }, () => {
        steps++;
        highest = Math.max(highest, p.move.pos.y);
        expect(world.overlapsStatic(p.move.pos, PLAYER.standHeight, 0.02)).toBe(false);
      });
      ms += Date.now() - t0;
      expect(Math.hypot(p.move.pos.x, p.move.pos.z)).toBeGreaterThan(PLAYER.radius);
      body.free();
    }
    // Sweeping the bare scans cost Rapier's controller 1–20 ms per move (a bin ~3.7 ms; the
    // removed hydrant let the capsule step onto its shoulder); the hull ~0.2 ms.
    expect(ms / steps).toBeLessThan(3);
    expect(highest).toBeLessThan(0.2);
  });

  it('cover the decor models the Market dresses with', () => {
    for (const kind of DECOR_KINDS) {
      const { model } = DECOR_MODELS[kind];
      expect(MOVE_HULL_MODELS.has(model)).toBe(model !== 'lamp');
    }
  });
});

describe('vehicle bodies meet the movement hulls, not the dense scans', () => {
  it('a truck box overlaps a prop by its hull and sweeps into it like a character would', () => {
    const decor: MapDecor[] = [{ kind: 'drum', x: 0, z: 6, rot: 0 }];
    const world = new PhysicsWorld(mapOf(decor));
    expect(MOVE_HULL_MODELS.has('drum')).toBe(true);
    const half = { x: 1, y: 0.5, z: 1 };
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    // Right on the drum: the hull is there.
    expect(world.boxOverlaps({ x: 0, y: 0.6, z: 6 }, rot, half)).toBe(true);
    // Swept toward it from 3 m: stopped short of the drum's centre by its hull.
    const hit = world.castBox({ x: 0, y: 0.6, z: 0 }, rot, half, { x: 0, y: 0, z: 10 });
    expect(hit).not.toBeNull();
    expect(hit!.toi * 10).toBeLessThan(6 - 1);
    expect(hit!.toi * 10).toBeGreaterThan(3);
  });
});
