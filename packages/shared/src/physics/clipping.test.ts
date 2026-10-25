import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER } from '../config/tunables.ts';
import { TEST_STREET } from '../maps/testStreet.ts';
import { Button, emptyInput } from '../sim/input.ts';
import { createPlayerState } from '../sim/player.ts';
import { crowdMemberOf, stepPlayerInCrowd, type CrowdMember } from '../sim/playerCollision.ts';
import { run } from '../sim/testUtils.ts';
import { SIM_DT } from '../config/tunables.ts';
import { initPhysics, PhysicsWorld } from './world.ts';

/**
 * Anti-clipping sweep over the whole M1 map: from a grid of start points, sprint (with jump and
 * crouch spam: slides) in 16 directions into whatever is there. After every sim step the capsule must not
 * overlap static geometry and must stay inside the map bounds.
 */
describe('anti-clipping sweep (test-street)', () => {
  let world: PhysicsWorld;
  beforeAll(async () => {
    await initPhysics();
    world = new PhysicsWorld(TEST_STREET);
  });

  it('never penetrates geometry or leaves the map', () => {
    const { minX, maxX, minZ, maxZ } = TEST_STREET.bounds;
    const failures: string[] = [];
    let runs = 0;
    // The crouch spam on the sprint starts slides (crouch capsule, boosted into whatever is there).
    let slides = 0;
    const directions = 16;
    for (let x = minX + 3; x < maxX; x += 5) {
      for (let z = minZ + 3; z < maxZ; z += 5) {
        // Start above anything at this spot; skip points buried inside solid blocks.
        const start = { x, y: 20, z };
        const probe = world.castRay({ x, y: 39, z }, { x: 0, y: -1, z: 0 }, 60);
        if (!probe) continue;
        start.y = probe.point.y + 0.05;
        if (start.y > 15 || world.overlapsStatic(start, PLAYER.standHeight)) continue;
        for (let d = 0; d < directions; d++) {
          const yaw = (d / directions) * Math.PI * 2;
          const p = createPlayerState(start);
          const body = world.createCharacter(start);
          runs++;
          run(
            p,
            body,
            2.5,
            (i) => ({
              moveZ: 1,
              moveX: d % 3 === 0 ? 0.4 : 0,
              yaw,
              buttons:
                Button.Sprint |
                (i % 40 === 5 ? Button.Jump : 0) |
                (i % 90 > 70 ? Button.Crouch : 0),
            }),
            (ev, step) => {
              if (ev.some((e) => e.type === 'slide')) slides++;
              const pos = p.move.pos;
              const h = p.move.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
              if (world.overlapsStatic(pos, h, 0.03)) {
                failures.push(`overlap start=(${x},${z}) yaw=${d} step=${step} at ${fmt(pos)}`);
              }
              if (pos.x < minX || pos.x > maxX || pos.z < minZ || pos.z > maxZ || pos.y < -0.5) {
                failures.push(
                  `out of bounds start=(${x},${z}) yaw=${d} step=${step} at ${fmt(pos)}`,
                );
              }
            },
          );
          body.free();
          if (failures.length > 20) break;
        }
      }
    }
    expect(runs).toBeGreaterThan(300);
    expect(slides).toBeGreaterThan(200); // (most crouch presses land mid-jump: those crouch)
    expect(failures.slice(0, 20)).toEqual([]);
  }, 120_000);

  it('player-collision pushes never shove anyone into geometry', () => {
    // A sprints into B from 1.5 m in 8 directions at points over the whole street: B is shoved
    // into whatever is there (walls, props, kerbs, ledges); neither capsule may enter it.
    const { minX, maxX, minZ, maxZ } = TEST_STREET.bounds;
    const failures: string[] = [];
    const ground = (x: number, z: number): { x: number; y: number; z: number } | null => {
      const probe = world.castRay({ x, y: 39, z }, { x: 0, y: -1, z: 0 }, 60);
      if (!probe || probe.point.y > 15) return null;
      const feet = { x, y: probe.point.y + 0.05, z };
      return world.overlapsStatic(feet, PLAYER.standHeight) ? null : feet;
    };
    const crowd: CrowdMember[] = [0, 1].map(() => ({ id: '', x: 0, y: 0, z: 0, height: 0 }));
    let runs = 0;
    for (let x = minX + 4; x < maxX; x += 7) {
      for (let z = minZ + 4; z < maxZ; z += 7) {
        for (let d = 0; d < 8; d++) {
          const yaw = (d / 8) * Math.PI * 2;
          const bFeet = ground(x, z);
          const aFeet = ground(x + Math.sin(yaw) * 1.5, z + Math.cos(yaw) * 1.5);
          if (!bFeet || !aFeet || Math.abs(aFeet.y - bFeet.y) > 0.3) continue;
          const actors = [
            { id: 'a', p: createPlayerState(aFeet), body: world.createCharacter(aFeet) },
            { id: 'b', p: createPlayerState(bFeet), body: world.createCharacter(bFeet) },
          ];
          runs++;
          for (let i = 0; i < 120; i++) {
            actors.forEach((q, k) => crowdMemberOf(q.id, q.p.move, crowd[k]!));
            for (const q of actors) {
              const input = {
                ...emptyInput(i),
                ...(q.id === 'a' ? { moveZ: 1, yaw, buttons: Button.Sprint } : {}),
              };
              stepPlayerInCrowd(q.p, input, SIM_DT, q.body, crowd, q.id);
              const h = q.p.move.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
              if (world.overlapsStatic(q.p.move.pos, h, 0.03))
                failures.push(
                  `${q.id} in geometry start=(${x},${z}) dir=${d} step=${i} at ${fmt(q.p.move.pos)}`,
                );
            }
          }
          for (const q of actors) q.body.free();
          if (failures.length > 20) break;
        }
      }
    }
    expect(runs).toBeGreaterThan(100);
    expect(failures.slice(0, 20)).toEqual([]);
  }, 120_000);
});

const fmt = (v: { x: number; y: number; z: number }): string =>
  `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
