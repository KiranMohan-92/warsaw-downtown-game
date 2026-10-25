import { beforeAll, describe, expect, it } from 'vitest';
import { MOVEMENT, PLAYER, RIFLE, SIM_DT, SLIDE } from '../config/tunables.ts';
import type { Vec3 } from '../math/vec3.ts';
import { boxMinMax, ramp } from '../maps/builder.ts';
import type { MapBox, MapDefinition } from '../maps/types.ts';
import { reconcile, type PredictedStep } from '../net/reconcile.ts';
import { toSnapshotPlayer } from '../net/snapshot.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { Button, emptyInput, type PlayerInput } from './input.ts';
import {
  clonePlayerState,
  createPlayerState,
  horizontalSpeed,
  stepPlayer,
  type CharacterBody,
  type MoveResult,
  type PlayerEvent,
  type PlayerState,
} from './player.ts';
import { FlatGroundBody, run } from './testUtils.ts';
import { currentSpread, createWeaponState, type WeaponContext } from './weapon.ts';

const S = Button.Sprint;
const C = Button.Crouch;

/** Grounded and sprinting flat out toward -Z (yaw 0). */
function sprinting(
  body: CharacterBody = new FlatGroundBody(),
  feet: Vec3 = { x: 0, y: 0, z: 0 },
): {
  p: PlayerState;
  body: CharacterBody;
} {
  const p = createPlayerState(feet);
  run(p, body, 0.1, {});
  run(p, body, 1, { moveZ: 1, buttons: S });
  return { p, body };
}

/** Step until the slide ends (or `max` s), recording the horizontal speed after each step. */
function slideOut(
  p: PlayerState,
  body: CharacterBody,
  input: Partial<PlayerInput> | ((step: number) => Partial<PlayerInput>),
  max = 3,
): number[] {
  const speeds: number[] = [];
  for (let i = 0; i < max / SIM_DT && p.move.sliding; i++) {
    const partial = typeof input === 'function' ? input(i) : input;
    stepPlayer(p, { ...emptyInput(i), ...partial }, SIM_DT, body);
    speeds.push(horizontalSpeed(p.move));
  }
  return speeds;
}

/** Tap Crouch on a sprint (one step), returning that step's events. */
function tapSlide(p: PlayerState, body: CharacterBody, extra = 0): PlayerEvent[] {
  return run(p, body, SIM_DT, { moveZ: 1, buttons: S | C | extra });
}

/** Flat fake with a ceiling: standing up always fails (a crawl space). */
class LowCeilingBody implements CharacterBody {
  private readonly flat = new FlatGroundBody();
  private crouched = false;
  move(delta: Vec3): MoveResult {
    return this.flat.move(delta);
  }
  setCrouched(crouched: boolean): boolean {
    if (!crouched && this.crouched) return false;
    this.crouched = crouched;
    return true;
  }
  setPosition(feet: Vec3): void {
    this.flat.setPosition(feet);
  }
}

/** Plane rising `grade` m per m travelled toward -Z (negative: downhill), with ground snapping. */
class SlopeBody implements CharacterBody {
  feet: Vec3 = { x: 0, y: 0, z: 0 };
  private grounded = false;
  constructor(private readonly grade: number) {}
  private ground(z: number): number {
    return -z * this.grade;
  }
  move(delta: Vec3): MoveResult {
    const x = this.feet.x + delta.x;
    const z = this.feet.z + delta.z;
    const g = this.ground(z);
    let y = Math.max(g, this.feet.y + delta.y);
    if (this.grounded && delta.y <= 0 && y - g < 0.35) y = g; // snap to ground
    const moved = { x: delta.x, y: y - this.feet.y, z: delta.z };
    this.feet = { x, y, z };
    this.grounded = y <= g + 1e-9 && delta.y <= 0;
    return { moved, grounded: this.grounded };
  }
  setCrouched(): boolean {
    return true;
  }
  setPosition(feet: Vec3): void {
    this.feet = { ...feet };
  }
}

describe('slide: trigger', () => {
  it('Crouch pressed on a sprint starts a slide: crouch capsule, boosted, event', () => {
    const { p, body } = sprinting();
    const events = tapSlide(p, body);
    expect(events).toContainEqual({ type: 'slide', speed: MOVEMENT.sprintSpeed });
    expect(p.move.sliding).toBe(true);
    expect(p.move.crouched).toBe(true);
    expect(p.move.sprinting).toBe(false);
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.sprintSpeed * SLIDE.boost, 6);
  });

  it('toggle crouch (the button stays down) slides and ends crouched', () => {
    const { p, body } = sprinting();
    tapSlide(p, body);
    slideOut(p, body, { moveZ: 1, buttons: S | C });
    run(p, body, 0.2, { moveZ: 1, buttons: C });
    expect(p.move.crouched).toBe(true);
    expect(p.move.sliding).toBe(false);
  });

  it('hold crouch released mid-slide: the slide carries on, then you stand (headroom)', () => {
    const { p, body } = sprinting();
    tapSlide(p, body);
    const speeds = slideOut(p, body, { moveZ: 1 });
    expect(speeds.length * SIM_DT).toBeGreaterThan(0.5); // released on the first step: still slid
    run(p, body, SIM_DT, { moveZ: 1 });
    expect(p.move.crouched).toBe(false);
  });

  it('no slide from a walk, standing still, prone, on the board, aiming or off the ground', () => {
    const walk = createPlayerState({ x: 0, y: 0, z: 0 });
    const wb = new FlatGroundBody();
    run(walk, wb, 1, { moveZ: 1 });
    run(walk, wb, SIM_DT, { moveZ: 1, buttons: C });
    expect(walk.move.sliding).toBe(false);
    expect(walk.move.crouched).toBe(true);

    const still = createPlayerState({ x: 0, y: 0, z: 0 });
    run(still, wb, 0.5, { buttons: S | C });
    expect(still.move.sliding).toBe(false);

    const aim = sprinting();
    tapSlide(aim.p, aim.body, Button.Ads);
    expect(aim.p.move.sliding).toBe(false);

    const board = sprinting();
    board.p.move.board = true;
    tapSlide(board.p, board.body);
    expect(board.p.move.sliding).toBe(false);

    const prone = sprinting();
    prone.p.move.prone = true; // (flat fakes can't go prone: set the state directly)
    tapSlide(prone.p, prone.body);
    expect(prone.p.move.sliding).toBe(false);

    // Mid-jump: a press long before touchdown does nothing; the landing is a normal one.
    const air = sprinting();
    run(air.p, air.body, SIM_DT, { moveZ: 1, buttons: S | Button.Jump });
    run(air.p, air.body, 0.05, { moveZ: 1, buttons: S });
    run(air.p, air.body, SIM_DT, { moveZ: 1, buttons: S | C });
    expect(air.p.move.sliding).toBe(false);
    run(air.p, air.body, 1, { moveZ: 1, buttons: S }); // release: lands, sprints on
    expect(air.p.move.grounded).toBe(true);
    expect(air.p.move.sliding).toBe(false);
  });

  it('a Crouch press just before touching down from a sprint jump slides on landing', () => {
    const { p, body } = sprinting();
    run(p, body, SIM_DT, { moveZ: 1, buttons: S | Button.Jump });
    // Airborne until the apex and down: press Crouch ~0.1 s before touchdown.
    const air = (2 * Math.sqrt(2 * MOVEMENT.gravity * MOVEMENT.jumpHeight)) / MOVEMENT.gravity;
    run(p, body, air - 0.12, { moveZ: 1, buttons: S });
    expect(p.move.grounded).toBe(false);
    let slid = false;
    run(p, body, 0.3, { moveZ: 1, buttons: S | C }, (e) => {
      if (e.some((x) => x.type === 'slide')) slid = true;
    });
    expect(slid).toBe(true);
  });
});

describe('slide: motion', () => {
  it('launches at boost × sprint speed and decays to crouch-walk speed in 0.6-0.9 s', () => {
    const { p, body } = sprinting();
    tapSlide(p, body);
    const speeds = slideOut(p, body, { moveZ: 1, buttons: S | C });
    const duration = (speeds.length + 1) * SIM_DT;
    expect(duration).toBeGreaterThan(0.6);
    expect(duration).toBeLessThan(0.9);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]!).toBeLessThan(speeds[i - 1]!);
    expect(speeds.at(-1)!).toBeLessThan(MOVEMENT.crouchSpeed);
    expect(speeds.at(-2)!).toBeGreaterThanOrEqual(MOVEMENT.crouchSpeed);
  });

  it('steering is weak: a full strafe turns the slide by only ~steerRate × duration', () => {
    const { p, body } = sprinting();
    tapSlide(p, body);
    const speeds = slideOut(p, body, { moveX: 1, buttons: S | C });
    const heading = Math.atan2(p.move.vel.x, -p.move.vel.z); // 0 = straight on (-Z), + = right
    const t = (speeds.length + 1) * SIM_DT;
    expect(heading).toBeGreaterThan(0.1);
    expect(heading).toBeLessThanOrEqual(SLIDE.steerRate * t + 1e-6);
  });

  it('cooldown: no chained slides within SLIDE.cooldown, fine after it', () => {
    const { p, body } = sprinting();
    tapSlide(p, body);
    slideOut(p, body, { moveZ: 1, buttons: S });
    // Stand up and sprint again, then try straight away.
    run(p, body, 0.3, { moveZ: 1, buttons: S });
    expect(horizontalSpeed(p.move)).toBeGreaterThan(SLIDE.minSpeed);
    tapSlide(p, body);
    expect(p.move.sliding).toBe(false);
    run(p, body, SLIDE.cooldown, { moveZ: 1, buttons: S });
    tapSlide(p, body);
    expect(p.move.sliding).toBe(true);
  });

  it('Jump cancels into a normal jump (standard height), even with Crouch held', () => {
    const { p, body } = sprinting();
    tapSlide(p, body);
    run(p, body, 0.15, { moveZ: 1, buttons: S | C });
    expect(p.move.sliding).toBe(true);
    const y0 = p.move.pos.y;
    const events = run(p, body, SIM_DT, { moveZ: 1, buttons: S | C | Button.Jump });
    expect(events.some((e) => e.type === 'jump')).toBe(true);
    expect(p.move.sliding).toBe(false);
    expect(p.move.crouched).toBe(false);
    expect(p.move.slideCooldown).toBeGreaterThan(0);
    expect(horizontalSpeed(p.move)).toBeGreaterThan(MOVEMENT.sprintSpeed); // momentum carried
    let apex = p.move.pos.y;
    run(p, body, 0.8, { moveZ: 1, buttons: S | C }, () => {
      apex = Math.max(apex, p.move.pos.y);
    });
    expect(apex - y0).toBeGreaterThan(MOVEMENT.jumpHeight * 0.95);
    expect(apex - y0).toBeLessThan(MOVEMENT.jumpHeight * 1.05);
  });

  it('Crouch and Jump in the same tick on a sprint: the jump wins (no slide)', () => {
    const { p, body } = sprinting();
    const y0 = p.move.pos.y;
    const events = run(p, body, SIM_DT, { moveZ: 1, buttons: S | C | Button.Jump });
    expect(events.some((e) => e.type === 'jump')).toBe(true);
    expect(events.some((e) => e.type === 'slide')).toBe(false);
    expect(p.move.sliding).toBe(false);
    expect(p.move.crouched).toBe(false);
    let apex = p.move.pos.y;
    run(p, body, 0.3, { moveZ: 1, buttons: S | C }, () => {
      apex = Math.max(apex, p.move.pos.y);
    });
    expect(apex - y0).toBeGreaterThan(MOVEMENT.jumpHeight * 0.95);
  });

  it('a low ceiling: the slide ends crouched (no headroom to stand), and Jump cannot cancel', () => {
    const body = new LowCeilingBody();
    const { p } = sprinting(body);
    tapSlide(p, body);
    run(p, body, 0.1, (i) => ({ moveZ: 1, buttons: i === 0 ? Button.Jump : 0 }));
    expect(p.move.sliding).toBe(true); // the jump press did nothing
    slideOut(p, body, { moveZ: 1 });
    run(p, body, 0.3, { moveZ: 1 });
    expect(p.move.crouched).toBe(true);
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.crouchSpeed, 4);
  });

  it('slopes: uphill shortens the slide, downhill extends it', () => {
    const duration = (grade: number): number => {
      const body = new SlopeBody(grade);
      const { p } = sprinting(body);
      tapSlide(p, body);
      return slideOut(p, body, { moveZ: 1, buttons: S | C }).length * SIM_DT;
    };
    const flat = duration(0);
    const up = duration(0.15);
    const down = duration(-0.15);
    expect(up).toBeLessThan(flat - 0.1);
    expect(down).toBeGreaterThan(flat + 0.1);
    expect(down).toBeLessThanOrEqual(SLIDE.maxTime + SIM_DT);
  });
});

describe('slide: shooting', () => {
  const ctx = (o: Partial<WeaponContext>): WeaponContext => ({
    sprinting: false,
    crouched: true,
    grounded: true,
    speed: 0,
    walkSpeed: MOVEMENT.walkSpeed,
    ownerSeed: 1,
    ...o,
  });

  it('hip spread is a little worse than crouch-walking, whatever the slide speed', () => {
    const w = createWeaponState(RIFLE);
    const crouchWalk = currentSpread(w, ctx({ speed: MOVEMENT.crouchSpeed }));
    const slide = currentSpread(w, ctx({ speed: 9, sliding: true }));
    expect(slide).toBeCloseTo(crouchWalk * SLIDE.spreadMultiplier, 9);
    expect(slide).toBeLessThan(currentSpread(w, ctx({ crouched: false, speed: 6.9 })));
    // Fully aimed: the multiplier is gone.
    w.adsAmount = 1;
    expect(currentSpread(w, ctx({ speed: 9, sliding: true }))).toBeCloseTo(
      currentSpread(w, ctx({ speed: MOVEMENT.crouchSpeed })),
      9,
    );
  });

  it('fires while sliding (after the usual sprint-out) with the slide spread; ADS is slower', () => {
    const { p, body } = sprinting();
    tapSlide(p, body);
    const shots: number[] = [];
    run(p, body, 0.4, { moveZ: 1, buttons: S | C | Button.Fire }, (e) => {
      for (const x of e) if (x.type === 'shot' && p.move.sliding) shots.push(x.shot.spreadDeg);
    });
    expect(shots.length).toBeGreaterThan(0);
    const w = createWeaponState(RIFLE);
    expect(shots[0]).toBeCloseTo(currentSpread(w, ctx({ speed: 9, sliding: true })), 9);

    const a = sprinting();
    tapSlide(a.p, a.body);
    run(a.p, a.body, 0.1, { moveZ: 1, buttons: C | Button.Ads });
    expect(a.p.move.sliding).toBe(true);
    const sliding = a.p.guns.rifle.adsAmount;
    const b = createPlayerState({ x: 0, y: 0, z: 0 });
    const bb = new FlatGroundBody();
    run(b, bb, 0.1, { buttons: C });
    run(b, bb, 0.1, { buttons: C | Button.Ads });
    expect(sliding).toBeCloseTo(b.guns.rifle.adsAmount / SLIDE.adsTimeMultiplier, 6);
  });
});

describe('slide: physics (Rapier)', () => {
  beforeAll(async () => {
    await initPhysics();
  });
  const mapOf = (boxes: MapBox[]): MapDefinition => ({
    name: 'slide',
    bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
    boxes: [boxMinMax({ x: -50, y: -1, z: -50 }, { x: 50, y: 0, z: 50 }, 'ground'), ...boxes],
    spawns: [],
    dummies: [],
  });
  const start = { x: 0, y: 0.05, z: 0 };

  /** Slide length (s) from a 1 s sprint toward -Z over `boxes`, Crouch held. */
  const slideOn = (boxes: MapBox[], from = start): number => {
    const world = new PhysicsWorld(mapOf(boxes));
    const body = world.createCharacter(from);
    const { p } = sprinting(body, from);
    tapSlide(p, body);
    const t = (slideOut(p, body, { moveZ: 1, buttons: S | C }).length + 1) * SIM_DT;
    body.free();
    return t;
  };

  it('a real 25 % ramp drags the slide the whole way up; a kerb costs nothing', () => {
    const flat = slideOn([]);
    // Ramp from z = -7 up toward -Z (rise 3 over 12 m: ≈ 3.7 cm a step at slide speed).
    const up = slideOn([ramp({ x: 0, y: 0, z: -7 }, '-z', 12, 3, 6, 'concrete')]);
    // Downhill: off a 3 m deck down the mirrored ramp.
    const down = slideOn(
      [
        boxMinMax({ x: -3, y: 0, z: -7 }, { x: 3, y: 3, z: 10 }, 'concrete'),
        ramp({ x: 0, y: 3, z: -7 }, '-z', 12, -3, 6, 'concrete'),
      ],
      { x: 0, y: 3.05, z: 0 },
    );
    // A 15 cm kerb onto a raised sidewalk, crossed early in the slide.
    const kerb = slideOn([
      boxMinMax({ x: -3, y: 0, z: -40 }, { x: 3, y: 0.15, z: -7.5 }, 'paving'),
    ]);
    // Uphill: friction + 22 × 0.8 × 0.25 = 13.4 m/s² instead of 9.
    expect(up).toBeLessThan(flat * 0.8);
    expect(down).toBeGreaterThan(flat + 0.1);
    expect(Math.abs(kerb - flat)).toBeLessThan(0.05);
  });

  it('a wall ends the slide (crouched, stopped against it, never inside it)', () => {
    const world = new PhysicsWorld(
      mapOf([boxMinMax({ x: -3, y: 0, z: -10 }, { x: 3, y: 3, z: -9 }, 'concrete')]),
    );
    const body = world.createCharacter(start);
    const { p } = sprinting(body, start);
    tapSlide(p, body);
    const speeds = slideOut(p, body, { moveZ: 1, buttons: S | C });
    // Still fast when it hit (a slide on the flat would have carried on), stopped at the face.
    expect(p.move.sliding).toBe(false);
    expect(speeds.at(-2)!).toBeGreaterThan(4);
    expect(horizontalSpeed(p.move)).toBeLessThan(1);
    expect(p.move.pos.z).toBeCloseTo(-9 + PLAYER.radius, 1);
    run(p, body, SIM_DT, { moveZ: 1, buttons: C });
    expect(p.move.crouched).toBe(true);
    expect(world.overlapsStatic(p.move.pos, PLAYER.crouchHeight, 0.03)).toBe(false);
    body.free();
  });

  it('under a real slab: released Crouch cannot stand, so it stays crouched', () => {
    // Slab at 1.4 m over the slide's end (standing 1.8 blocked, crouch 1.2 fits).
    const world = new PhysicsWorld(
      mapOf([boxMinMax({ x: -3, y: 1.4, z: -20 }, { x: 3, y: 1.8, z: -9 }, 'concrete')]),
    );
    const body = world.createCharacter(start);
    const { p } = sprinting(body, start);
    tapSlide(p, body);
    slideOut(p, body, { moveZ: 1 });
    run(p, body, 0.2, {});
    expect(p.move.pos.z).toBeLessThan(-9.5); // ended under the slab
    expect(p.move.crouched).toBe(true);
    expect(body.capsuleHeight).toBe(PLAYER.crouchHeight);
    expect(world.overlapsStatic(p.move.pos, PLAYER.crouchHeight, 0.03)).toBe(false);
    body.free();
  });

  it('client prediction and the server agree through slides, a jump-cancel and a wall', () => {
    const map = mapOf([boxMinMax({ x: -20, y: 0, z: -24 }, { x: 20, y: 3, z: -23 }, 'concrete')]);
    const serverWorld = new PhysicsWorld(map);
    const clientWorld = new PhysicsWorld(map);
    const serverBody = serverWorld.createCharacter(start);
    const clientBody = clientWorld.createCharacter(start);
    const server = createPlayerState(start);
    let client = createPlayerState(start);
    let pending: PredictedStep[] = [];
    // Sprint; slide at 1 s (steer left); jump-cancel at 1.3 s; sprint; slide into the wall at 3 s.
    const input = (i: number): PlayerInput => ({
      ...emptyInput(i),
      moveZ: i < 6 ? 0 : 1,
      moveX: i > 60 && i < 80 ? -1 : 0,
      yaw: 0.002 * i,
      buttons:
        (i >= 6 ? S : 0) |
        (i === 60 || i === 180 ? C : 0) |
        (i >= 180 ? C : 0) |
        (i === 78 ? Button.Jump : 0) |
        (i % 7 === 0 && i > 100 ? Button.Fire : 0),
    });
    let slides = 0;
    let corrected = 0;
    for (let i = 0; i < 260; i++) {
      const inp = input(i);
      stepPlayer(client, inp, SIM_DT, clientBody);
      pending.push({ input: inp, after: clonePlayerState(client) });
      for (const e of stepPlayer(server, inp, SIM_DT, serverBody)) if (e.type === 'slide') slides++;
      if (i % 2 === 1) {
        const snap = toSnapshotPlayer('me', server, i, 0, { own: true });
        const r = reconcile(client, pending, snap, clientBody, SIM_DT);
        client = r.state;
        pending = r.pending;
        if (r.corrected) corrected++;
      }
    }
    expect(slides).toBe(2);
    expect(corrected).toBe(0);
    expect(client.move.pos).toEqual(server.move.pos);
    serverBody.free();
    clientBody.free();
  });
});
