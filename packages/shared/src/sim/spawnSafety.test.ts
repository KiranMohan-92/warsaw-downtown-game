import { describe, expect, it } from 'vitest';
import { PLAYER, SPAWN_SAFETY } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { SpawnPoint } from '../maps/types.ts';
import type { SightWorld } from './perception.ts';
import { pickSafeSpawn, spawnSafety } from './spawnSafety.ts';

/** A wall along x = `x` from z = `z0` to `z1`, full height: blocks any sight line crossing it. */
function wall(x: number, z0: number, z1: number): SightWorld & { rays: number } {
  const w = {
    rays: 0,
    castRay(o: Vec3, d: Vec3, max: number): unknown {
      w.rays++;
      if (Math.abs(d.x) < 1e-9) return null;
      const t = (x - o.x) / d.x;
      if (t <= 0 || t > max) return null;
      const z = o.z + d.z * t;
      return z >= z0 && z <= z1 ? { distance: t } : null;
    },
  };
  return w;
}

const spawn = (x: number, z: number): SpawnPoint => ({ pos: { x, y: 0, z }, yaw: 0 });
const eye = (x: number, z: number): Vec3 => ({ x, y: PLAYER.standEyeHeight, z });

describe('safest spawn (distance + line of sight)', () => {
  const open = { castRay: () => null };

  it('with nobody alive, the first spawn; without a world, farthest wins (distance only)', () => {
    const spawns = [spawn(0, 0), spawn(10, 0), spawn(50, 0)];
    expect(pickSafeSpawn(spawns, [])).toBe(spawns[0]);
    expect(pickSafeSpawn(spawns, [eye(1, 0)])).toBe(spawns[2]);
    expect(pickSafeSpawn(spawns, [eye(49, 0), eye(1, 0)])).toBe(spawns[1]);
    expect(pickSafeSpawn(spawns, [eye(1, 0)], open)).toBe(spawns[2]);
  });

  it('a spawn in an enemy’s view loses to a nearer one behind a wall', () => {
    // Enemy at (0, 20). Far spawn (40, 0) in the open (its sight line passes the wall's south
    // end at z = 17); near spawn (12, 20) straight behind the wall at x = 6.
    const spawns = [spawn(40, 0), spawn(12, 20)];
    const world = wall(6, 18, 25);
    const enemies = [eye(0, 20)];
    expect(pickSafeSpawn(spawns, enemies, open)).toBe(spawns[0]); // no cover anywhere: distance
    expect(pickSafeSpawn(spawns, enemies, world)).toBe(spawns[1]);
    // Heavily penalised: seen costs more than any distance on a map.
    expect(spawnSafety(spawns[0]!, enemies, world)).toBeCloseTo(
      Math.hypot(40, 20) - SPAWN_SAFETY.seenPenalty,
      6,
    );
    expect(spawnSafety(spawns[1]!, enemies, world)).toBeCloseTo(12, 6);
  });

  it('among spawns out of sight, the farthest; seen by fewer enemies beats seen by more', () => {
    // Wall at x = 5 over the whole strip: every spawn east of it is hidden from x < 5.
    const world = wall(5, -100, 100);
    const spawns = [spawn(8, 0), spawn(30, 0), spawn(20, 0)];
    expect(pickSafeSpawn(spawns, [eye(0, 0)], world)).toBe(spawns[1]);
    // A second enemy east of the wall sees them all (each is seen once): now distance to the
    // nearest enemy decides — 8 from the west one, 2 and 12 from the east one.
    expect(pickSafeSpawn(spawns, [eye(0, 0), eye(32, 0)], world)).toBe(spawns[2]);
    // Seen by one (the east enemy) vs by both: an enemy at x = 10 behind a half wall.
    const half = wall(15, -1, 1);
    const pair = [spawn(12, 0), spawn(40, 0)];
    // The x = 40 spawn is behind the half wall for the x = 10 enemy; x = 12 is in plain view.
    expect(pickSafeSpawn(pair, [eye(10, 0)], half)).toBe(pair[1]);
  });

  it('is deterministic: equal scores go to the lower index', () => {
    const spawns = [spawn(-10, 0), spawn(10, 0)];
    expect(pickSafeSpawn(spawns, [eye(0, 0)], open)).toBe(spawns[0]);
    expect(pickSafeSpawn([...spawns].reverse(), [eye(0, 0)], open)).toBe(spawns[1]);
  });

  it('varies empty-map spawns and equal-score ties with the supplied random draw', () => {
    const spawns = [spawn(-10, 0), spawn(10, 0)];
    expect(pickSafeSpawn(spawns, [], open, 0)).toBe(spawns[0]);
    expect(pickSafeSpawn(spawns, [], open, 0.75)).toBe(spawns[1]);
    expect(pickSafeSpawn(spawns, [eye(0, 0)], open, 0.75)).toBe(spawns[1]);
    // Randomness never trades away safety for variety.
    expect(pickSafeSpawn(spawns, [eye(9, 0)], open, 0.75)).toBe(spawns[0]);
  });

  it('costs one sight ray per enemy per spawn', () => {
    const world = wall(1000, 0, 0);
    const spawns = Array.from({ length: 28 }, (_, i) => spawn(i * 5, 0));
    const enemies = Array.from({ length: 5 }, (_, i) => eye(-i * 3, 7));
    pickSafeSpawn(spawns, enemies, world);
    expect(world.rays).toBe(28 * 5);
  });

  it('looks from the enemy’s eye to a standing eye at the spawn (a low wall hides nothing)', () => {
    let seenFrom: Vec3 | null = null;
    let dir: Vec3 | null = null;
    const probe: SightWorld = {
      castRay(o: Vec3, d: Vec3) {
        seenFrom = o;
        dir = d;
        return null;
      },
    };
    spawnSafety(spawn(10, 0), [eye(0, 0)], probe);
    expect(seenFrom).toEqual(eye(0, 0));
    expect(dir!.y).toBeCloseTo(0, 9); // eye level to eye level
  });
});
