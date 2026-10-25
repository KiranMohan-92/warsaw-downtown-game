import { beforeAll, describe, expect, it } from 'vitest';
import { KNIFE, MOVEMENT, PLAYER, PLAYER_COLLISION, SIM_DT } from '../config/tunables.ts';
import { block, boxMinMax } from '../maps/builder.ts';
import type { MapBox, MapDefinition } from '../maps/types.ts';
import { initPhysics, PhysicsWorld, type RapierCharacter } from '../physics/world.ts';
import { Button, emptyInput, type PlayerInput } from './input.ts';
import { createPlayerState, type PlayerState } from './player.ts';
import {
  crowdMemberOf,
  separateFromCrowd,
  stepPlayerInCrowd,
  type CrowdMember,
} from './playerCollision.ts';
import { FlatGroundBody } from './testUtils.ts';

beforeAll(async () => {
  await initPhysics();
});

const C = PLAYER_COLLISION;
const REACH = 2 * C.radius;

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'test',
  bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  boxes: [boxMinMax({ x: -50, y: -1, z: -50 }, { x: 50, y: 0, z: 50 }, 'ground'), ...boxes],
  spawns: [],
  dummies: [],
});

interface Actor {
  id: string;
  p: PlayerState;
  body: RapierCharacter;
}

/** Players in one world, stepped like the server does: all against the start-of-tick crowd. */
class Scene {
  readonly world: PhysicsWorld;
  readonly actors: Actor[] = [];
  private readonly crowd: CrowdMember[] = [];
  private seq = 0;
  constructor(boxes: MapBox[] = []) {
    this.world = new PhysicsWorld(mapOf(boxes));
  }
  add(id: string, x: number, z: number, mode: 'standard' | 'knife' = 'standard'): Actor {
    const feet = { x, y: 0.02, z };
    const a = {
      id,
      p: createPlayerState(feet, this.actors.length + 1, mode),
      body: this.world.createCharacter(feet),
    };
    this.actors.push(a);
    return a;
  }
  /** One tick: every actor steps its input (by id) against where everyone was at its start. */
  tick(inputs: Record<string, Partial<PlayerInput>>): void {
    this.crowd.length = 0;
    for (const a of this.actors)
      if (a.p.health > 0)
        this.crowd.push(crowdMemberOf(a.id, a.p.move, { id: '', x: 0, y: 0, z: 0, height: 0 }));
    const seq = this.seq++;
    for (const a of this.actors)
      stepPlayerInCrowd(
        a.p,
        { ...emptyInput(seq), ...inputs[a.id] },
        SIM_DT,
        a.body,
        this.crowd,
        a.id,
      );
  }
  run(
    seconds: number,
    inputs: (step: number) => Record<string, Partial<PlayerInput>>,
    each?: (step: number) => void,
  ): void {
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) {
      this.tick(inputs(i));
      each?.(i);
    }
  }
}

const gap = (a: Actor, b: Actor): number =>
  Math.hypot(a.p.move.pos.x - b.p.move.pos.x, a.p.move.pos.z - b.p.move.pos.z);
const settle = (s: Scene): void => s.run(0.3, () => ({}));
/** Yaw that faces +Z / -Z (yaw 0 looks down -Z). */
const FACE_NEG_Z = 0;
const FACE_POS_Z = Math.PI;

describe('player collision (soft push)', () => {
  it('pulls apart two players standing inside each other, gently', () => {
    const s = new Scene();
    const a = s.add('a', 0, 0);
    const b = s.add('b', 0.2, 0.05);
    let maxStep = 0;
    let last = { x: b.p.move.pos.x, z: b.p.move.pos.z };
    s.run(
      1.5,
      () => ({}),
      () => {
        maxStep = Math.max(maxStep, Math.hypot(b.p.move.pos.x - last.x, b.p.move.pos.z - last.z));
        last = { x: b.p.move.pos.x, z: b.p.move.pos.z };
      },
    );
    expect(gap(a, b)).toBeGreaterThan(REACH - 0.02);
    expect(maxStep).toBeLessThanOrEqual(C.maxPushSpeed * SIM_DT + 1e-6);
  });

  it('splits two players spawned exactly on top of each other (deterministic by id)', () => {
    const s = new Scene();
    const a = s.add('a', 3, 3);
    const b = s.add('b', 3, 3);
    s.run(1.5, () => ({}));
    expect(gap(a, b)).toBeGreaterThan(REACH - 0.02);
    expect(a.p.move.pos.x).toBeGreaterThan(b.p.move.pos.x); // 'a' < 'b' goes +x
  });

  it('a sprinter cannot walk through a standing player; he is shoved at a capped, gentle speed', () => {
    const s = new Scene();
    const a = s.add('a', 0, 3);
    const b = s.add('b', 0.02, 0); // almost dead ahead of the sprinter (off-centre by 2 cm)
    settle(s);
    let deepest = 0;
    let maxPush = 0;
    let prevB = { ...b.p.move.pos };
    s.run(
      1.5,
      () => ({ a: { moveZ: 1, yaw: FACE_NEG_Z, buttons: Button.Sprint } }),
      () => {
        deepest = Math.max(deepest, REACH - gap(a, b));
        maxPush = Math.max(maxPush, Math.hypot(b.p.move.pos.x - prevB.x, b.p.move.pos.z - prevB.z));
        prevB = { ...b.p.move.pos };
      },
    );
    expect(deepest).toBeLessThanOrEqual(C.walkPenetration + 0.01);
    expect(maxPush).toBeLessThanOrEqual(C.maxPushSpeed * SIM_DT + 1e-6);
    // Either shoved along, or (head-on) slipped past: never through at sprint speed.
    const aheadOfB = a.p.move.pos.z < b.p.move.pos.z;
    if (aheadOfB)
      expect(Math.abs(a.p.move.pos.x - b.p.move.pos.x)).toBeGreaterThan(
        REACH - C.walkPenetration - 0.02,
      );
    expect(Math.abs(b.p.move.pos.z)).toBeLessThan(C.maxPushSpeed * 1.5 + 0.05);
  });

  it('pushes never put anyone into a wall (pinned against a wall, the pusher stops)', () => {
    // Wall face at z = -1: b stands against it, a walks b into it head-on and at an angle.
    for (const angle of [0, 0.4, -0.7]) {
      const s = new Scene([block(0, -1.5, 0, 12, 3, 1, 'concrete')]);
      const b = s.add('b', 0, -1 + PLAYER.radius + 0.05);
      const a = s.add('a', Math.sin(angle) * 2, b.p.move.pos.z + Math.cos(angle) * 2);
      settle(s);
      let worst = 0;
      s.run(
        3,
        () => ({ a: { moveZ: 1, yaw: angle, buttons: Button.Sprint } }),
        () => {
          for (const x of [a, b])
            if (s.world.overlapsStatic(x.p.move.pos, PLAYER.standHeight, 0.03)) worst++;
        },
      );
      expect(worst).toBe(0);
      expect(b.p.move.pos.z).toBeGreaterThan(-1 + PLAYER.radius - 0.03);
      expect(REACH - gap(a, b)).toBeLessThanOrEqual(C.walkPenetration + 0.02);
    }
  });

  it('two sprinters meeting head-on slip past each other instead of jamming', () => {
    const s = new Scene();
    const a = s.add('a', 0, 5);
    const b = s.add('b', 0, -5);
    settle(s);
    let closest = Infinity;
    s.run(
      3,
      () => ({
        a: { moveZ: 1, yaw: FACE_NEG_Z, buttons: Button.Sprint },
        b: { moveZ: 1, yaw: FACE_POS_Z, buttons: Button.Sprint },
      }),
      () => {
        closest = Math.min(closest, gap(a, b));
      },
    );
    expect(a.p.move.pos.z).toBeLessThan(-3); // both made it through to the other side
    expect(b.p.move.pos.z).toBeGreaterThan(3);
    expect(closest).toBeGreaterThan(REACH - 2 * C.walkPenetration - 0.02); // never through
  });

  it('a stationary player cannot hold a 1 m doorway: the walker gets through', () => {
    // Wall across x at z ∈ [-0.15, 0.15] with a 1 m gap at x ∈ [-0.5, 0.5].
    const s = new Scene([
      boxMinMax({ x: -10, y: 0, z: -0.15 }, { x: -0.5, y: 3, z: 0.15 }, 'concrete'),
      boxMinMax({ x: 0.5, y: 0, z: -0.15 }, { x: 10, y: 3, z: 0.15 }, 'concrete'),
    ]);
    const holder = s.add('holder', 0, 0);
    const walker = s.add('walker', 0, 3);
    settle(s);
    let through = -1;
    let worst = 0;
    s.run(
      8,
      () => ({ walker: { moveZ: 1, yaw: FACE_NEG_Z } }),
      (i) => {
        if (through < 0 && walker.p.move.pos.z < -1) through = i;
        for (const x of [holder, walker])
          if (s.world.overlapsStatic(x.p.move.pos, PLAYER.standHeight, 0.03)) worst++;
      },
    );
    expect(through).toBeGreaterThan(0);
    expect(through * SIM_DT).toBeLessThan(6);
    expect(worst).toBe(0);
  });

  it('two players both pushing into each other in a 1 m doorway still get past each other', () => {
    const s = new Scene([
      boxMinMax({ x: -10, y: 0, z: -0.15 }, { x: -0.5, y: 3, z: 0.15 }, 'concrete'),
      boxMinMax({ x: 0.5, y: 0, z: -0.15 }, { x: 10, y: 3, z: 0.15 }, 'concrete'),
    ]);
    const a = s.add('a', 0, 2);
    const b = s.add('b', 0, -2);
    settle(s);
    let closest = Infinity;
    s.run(
      4,
      () => ({ a: { moveZ: 1, yaw: FACE_NEG_Z }, b: { moveZ: 1, yaw: FACE_POS_Z } }),
      () => {
        closest = Math.min(closest, gap(a, b));
      },
    );
    expect(a.p.move.pos.z).toBeLessThan(-2);
    expect(b.p.move.pos.z).toBeGreaterThan(2);
    expect(closest).toBeGreaterThan(REACH - 2 * C.walkPenetration - 0.02); // around, not through
  });

  it('a knife lunge stops at the target instead of carrying through it', () => {
    // Standing slash from 0.9 m: the lunge alone carries ~0.5 m, into the target's body.
    const free = new Scene();
    const solo = free.add('a', 0, 0.9, 'knife');
    settle(free);
    free.run(0.6, (i) => ({ a: { yaw: FACE_NEG_Z, buttons: i < 2 ? Button.Fire : 0 } }));
    expect(solo.p.move.pos.z).toBeLessThan(REACH - C.walkPenetration - 0.05); // would overlap

    const s = new Scene();
    const a = s.add('a', 0, 0.9, 'knife');
    const target = s.add('t', 0, 0);
    settle(s);
    let closest = Infinity;
    s.run(
      0.6,
      (i) => ({ a: { yaw: FACE_NEG_Z, buttons: i < 2 ? Button.Fire : 0 } }),
      () => {
        closest = Math.min(closest, gap(a, target));
      },
    );
    expect(closest).toBeGreaterThan(REACH - C.walkPenetration - 0.01);
    expect(Math.abs(a.p.move.pos.x)).toBeLessThan(0.05); // stopped, not slid around mid-strike

    // Sprinting in and slashing: still never through the body.
    const run = new Scene();
    const b = run.add('a', 0, 3, 'knife');
    const t2 = run.add('t', 0, 0);
    settle(run);
    closest = Infinity;
    run.run(
      1.2,
      (i) => ({
        a: { moveZ: 1, yaw: FACE_NEG_Z, buttons: Button.Sprint | (i % 30 < 2 ? Button.Fire : 0) },
      }),
      () => {
        closest = Math.min(closest, gap(b, t2));
      },
    );
    expect(closest).toBeGreaterThan(REACH - C.walkPenetration - 0.01);
    expect(KNIFE.lungeSpeed).toBeGreaterThan(MOVEMENT.walkSpeed); // the lunge is a real shove
  });

  it('pushing into two neighbours at once never shoves you back faster than the cap', () => {
    // Codex repro: neighbours 0.48 m apart, the mover 0.48 m from each, sprinting into the gap.
    // Summing each contact's full rollback retracted more than the step moved (~3.8 m/s back).
    const nb: CrowdMember[] = [
      { id: 'l', x: -0.24, y: 0, z: 0, height: PLAYER.standHeight },
      { id: 'r', x: 0.24, y: 0, z: 0, height: PLAYER.standHeight },
    ];
    const z0 = Math.sqrt(0.48 * 0.48 - 0.24 * 0.24);
    for (const step of [0.02, 0.06, 0.115]) {
      const p = createPlayerState({ x: 0, y: 0, z: z0 - step });
      p.move.vel = { x: 0, y: 0, z: -6.9 };
      const body = new FlatGroundBody(p.move.pos);
      const from = { x: 0, y: 0, z: z0 };
      separateFromCrowd(p, from, nb, 'me', body, SIM_DT);
      // Never behind where the step started by more than one capped soft push.
      expect(p.move.pos.z, `step ${step}`).toBeLessThanOrEqual(z0 + C.maxPushSpeed * SIM_DT + 1e-6);
      // And the walk into the wedge is stopped (no deeper than the limit on either side).
      for (const q of nb) {
        const pen = REACH - Math.hypot(p.move.pos.x - q.x, p.move.pos.z - q.z);
        expect(pen, `step ${step} vs ${q.id}`).toBeLessThanOrEqual(C.walkPenetration + 1e-3);
      }
    }
    // A sprinter held in a wedge of two standing players stays put, no backward flinging.
    const s = new Scene();
    const l = s.add('l', -0.26, 0);
    const r = s.add('r', 0.26, 0);
    const a = s.add('a', 0, 1.5);
    settle(s);
    let maxBack = 0;
    let prevZ = a.p.move.pos.z;
    s.run(
      1.5,
      () => ({ a: { moveZ: 1, yaw: FACE_NEG_Z, buttons: Button.Sprint } }),
      () => {
        maxBack = Math.max(maxBack, a.p.move.pos.z - prevZ);
        prevZ = a.p.move.pos.z;
      },
    );
    expect(maxBack).toBeLessThanOrEqual(C.maxPushSpeed * SIM_DT + 1e-6);
    expect(gap(l, r)).toBeGreaterThan(0); // (sanity: all three still there)
  });

  it('ignores the dead, and players above or below (a floor apart)', () => {
    const a = createPlayerState({ x: 0, y: 0, z: 0 });
    const body = new FlatGroundBody();
    const crowd: CrowdMember[] = [
      { id: 'up', x: 0.1, y: PLAYER.standHeight + 0.05, z: 0, height: PLAYER.standHeight },
      { id: 'self', x: 0, y: 0, z: 0, height: PLAYER.standHeight },
    ];
    expect(separateFromCrowd(a, { x: 0, y: 0, z: 0 }, crowd, 'self', body, SIM_DT)).toBe(false);
    a.health = 0;
    crowd[0]!.y = 0;
    expect(separateFromCrowd(a, { x: 0, y: 0, z: 0 }, crowd, 'self', body, SIM_DT)).toBe(false);
  });

  it('is off with the tunable off (and never touches a player alone)', () => {
    const s = new Scene();
    const a = s.add('a', 0, 0);
    const b = s.add('b', 0.2, 0);
    C.enabled = false;
    try {
      s.run(0.5, () => ({}));
      expect(gap(a, b)).toBeLessThan(0.21);
    } finally {
      C.enabled = true;
    }
  });
});
