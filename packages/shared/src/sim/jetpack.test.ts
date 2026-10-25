import { beforeAll, describe, expect, it } from 'vitest';
import { JETPACK, MOVEMENT, PLAYER, RIFLE, SIM_DT, TAC_SPRINT } from '../config/tunables.ts';
import { boxMinMax } from '../maps/builder.ts';
import type { Vec3 } from '../math/vec3.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { run } from './testUtils.ts';
import { Button, emptyInput, type PlayerInput } from './input.ts';
import {
  createJetpacks,
  grantJetpack,
  jetpackRespawned,
  jetSputter,
  JetMode,
  stepJetpacks,
} from './jetpack.ts';
import {
  clonePlayerState,
  createPlayerState,
  stepPlayer,
  type CharacterBody,
  type MoveResult,
  type PlayerEvent,
  type PlayerState,
} from './player.ts';
import { currentSpread } from './weapon.ts';

/**
 * Flat ground at y = 0 with one flat-topped block (a container roof, 2.6 m) over x ∈ [10, 16]:
 * the capsule stands on whichever is under its centre line; rays down see the same.
 */
class RoofBody implements CharacterBody {
  feet: Vec3;
  constructor(feet: Vec3 = { x: 0, y: 0, z: 0 }) {
    this.feet = { ...feet };
  }
  static ground(x: number): number {
    return x >= 10 && x <= 16 ? 2.6 : 0;
  }
  move(delta: Vec3): MoveResult {
    const x = this.feet.x + delta.x;
    const floor = RoofBody.ground(x);
    const y = Math.max(floor, this.feet.y + delta.y);
    const moved = { x: delta.x, y: y - this.feet.y, z: delta.z };
    this.feet = { x, y, z: this.feet.z + delta.z };
    return { moved, grounded: y <= floor + 1e-6 && delta.y <= 0 };
  }
  setCrouched(): boolean {
    return true;
  }
  setPosition(feet: Vec3): void {
    this.feet = { ...feet };
  }
  readonly world = {
    castRay: (o: Vec3, d: Vec3, max: number) => {
      if (d.y >= 0) return null;
      const dist = o.y - RoofBody.ground(o.x);
      return dist >= 0 && dist <= max ? { distance: dist, point: { ...o, y: o.y - dist } } : null;
    },
    overlapsStatic: () => false,
  };
}

const J = Button.Jump;
const fresh = (x = 0): { p: PlayerState; body: RoofBody } => {
  const y = RoofBody.ground(x);
  const p = createPlayerState({ x, y, z: 0 });
  p.move.grounded = true;
  grantJetpack(p.move);
  return { p, body: new RoofBody({ x, y, z: 0 }) };
};
let seq = 0;
const step = (p: PlayerState, body: CharacterBody, input: Partial<PlayerInput>): PlayerEvent[] =>
  stepPlayer(p, { ...emptyInput(seq++), ...input }, SIM_DT, body);
/** Jump, release, press again in the air: lit. */
function ignite(p: PlayerState, body: CharacterBody): PlayerEvent[] {
  const ev = [...step(p, body, { buttons: J })];
  for (let i = 0; i < 8; i++) ev.push(...step(p, body, {}));
  ev.push(...step(p, body, { buttons: J }));
  return ev;
}

describe('jetpack flight', () => {
  it('lights on a second Jump press in the air, not on the ground jump', () => {
    const { p, body } = fresh();
    const first = step(p, body, { buttons: J });
    expect(first.some((e) => e.type === 'jump')).toBe(true);
    expect(p.move.jet).toBe(JetMode.Worn);
    step(p, body, {});
    expect(step(p, body, { buttons: J }).some((e) => e.type === 'jetIgnite')).toBe(true);
    expect(p.move.jet).toBe(JetMode.Flying);
  });

  it('climbs to the ceiling over the ground and eases into it (soft, no bump)', () => {
    const { p, body } = fresh();
    ignite(p, body);
    let maxY = 0;
    let prevVy = Infinity;
    let bounced = false;
    for (let i = 0; i < 6 * 60; i++) {
      step(p, body, { buttons: J });
      maxY = Math.max(maxY, p.move.pos.y);
      if (p.move.pos.y > 3.5 && p.move.vel.y > prevVy + 1e-9) bounced = true;
      if (p.move.pos.y > 3.5) prevVy = p.move.vel.y;
    }
    expect(maxY).toBeLessThanOrEqual(JETPACK.ceiling + 1e-6);
    expect(maxY).toBeGreaterThan(JETPACK.ceiling - 0.05);
    expect(bounced).toBe(false); // the climb only ever slows into the ceiling
    expect(p.move.vel.y).toBeGreaterThanOrEqual(-1e-6);
  });

  it('measures the ceiling from the roof under you, and settles back gently off its edge', () => {
    const { p, body } = fresh(13);
    ignite(p, body);
    for (let i = 0; i < 5 * 60; i++) step(p, body, { buttons: J });
    expect(p.move.pos.y).toBeGreaterThan(2.6 + JETPACK.ceiling - 0.05);
    expect(p.move.pos.y).toBeLessThanOrEqual(2.6 + JETPACK.ceiling + 1e-6);
    // Off the edge (yaw π/2 faces −x: back over open ground), hovering: it sinks to the ceiling.
    let minVy = 0;
    for (let i = 0; i < 3 * 60; i++) {
      step(p, body, { moveZ: 1, yaw: Math.PI / 2 });
      minVy = Math.min(minVy, p.move.vel.y);
    }
    expect(p.move.pos.x).toBeLessThan(10);
    expect(minVy).toBeGreaterThanOrEqual(-JETPACK.overCeilingSinkMax - 1e-6);
    expect(p.move.pos.y).toBeLessThan(JETPACK.ceiling + 0.5);
  });

  it('hovers with no input, descends on Crouch, and thrusts with inertia to ~sprint pace', () => {
    const { p, body } = fresh();
    ignite(p, body);
    for (let i = 0; i < 60; i++) step(p, body, { buttons: J });
    const y0 = p.move.pos.y;
    for (let i = 0; i < 90; i++) step(p, body, {});
    expect(Math.abs(p.move.pos.y - y0)).toBeLessThan(0.5);
    expect(Math.abs(p.move.vel.y)).toBeLessThan(0.05);
    // Thrust: inertia (not instant), top speed between a sprint and a tactical sprint.
    step(p, body, { moveZ: 1 });
    expect(Math.hypot(p.move.vel.x, p.move.vel.z)).toBeLessThan(1);
    for (let i = 0; i < 4 * 60; i++) step(p, body, { moveZ: 1 });
    const top = Math.hypot(p.move.vel.x, p.move.vel.z);
    expect(top).toBeGreaterThan(MOVEMENT.sprintSpeed);
    expect(top).toBeLessThan(TAC_SPRINT.speed);
    expect(p.move.sprinting).toBe(false);
    // Coasting brakes over about a second.
    for (let i = 0; i < 90; i++) step(p, body, {});
    expect(Math.hypot(p.move.vel.x, p.move.vel.z)).toBeLessThan(0.3);
    const yHigh = p.move.pos.y;
    for (let i = 0; i < 30; i++) step(p, body, { buttons: Button.Crouch });
    expect(p.move.pos.y).toBeLessThan(yHigh - 1);
    expect(p.move.crouched).toBe(false); // Crouch descends, the capsule stays standing
  });

  it('runs 20 s from ignition, sputters at the end, then drops straight down: a thud, no damage', () => {
    const { p, body } = fresh();
    const events = ignite(p, body);
    const lit = events.findIndex((e) => e.type === 'jetIgnite');
    expect(lit).toBeGreaterThanOrEqual(0);
    expect(jetSputter(JETPACK.sputterTime + 0.1)).toBe(1);
    expect(jetSputter(1)).toBeLessThan(1);
    let t = 0;
    let cut = -1;
    let cutPos: Vec3 | null = null;
    let land = -1;
    for (let i = 0; i < 23 * 60 && land < 0; i++) {
      const ev = step(p, body, { buttons: J, moveZ: 1 });
      t += SIM_DT;
      if (ev.some((e) => e.type === 'jetCutoff')) {
        cut = t;
        cutPos = { ...p.move.pos };
      }
      if (ev.some((e) => e.type === 'jetLand')) land = t;
      expect(ev.some((e) => e.type === 'land')).toBe(false);
    }
    expect(cut).toBeGreaterThan(JETPACK.flightTime - 0.05);
    expect(cut).toBeLessThan(JETPACK.flightTime + 0.05);
    expect(land - cut).toBeGreaterThan(0);
    expect(land - cut).toBeLessThan(1.2); // fast…
    const drift = Math.hypot(p.move.pos.x - cutPos!.x, p.move.pos.z - cutPos!.z);
    expect(drift).toBeLessThan(1.2); // …and straight down, not a teleport
    expect(p.move.jet).toBe(JetMode.None);
    expect(p.health).toBe(PLAYER.maxHealth);
    expect(p.move.landingSlowTimer).toBe(0);
    // Jump is a jump again.
    for (let i = 0; i < 5; i++) step(p, body, {});
    expect(step(p, body, { buttons: J }).some((e) => e.type === 'jump')).toBe(true);
  });

  it('allows no sprint, slide or prone while flying, and walks (no jump) on the ground', () => {
    const { p, body } = fresh();
    ignite(p, body);
    for (let i = 0; i < 60; i++) step(p, body, { buttons: Button.Crouch });
    expect(p.move.grounded).toBe(true);
    for (let i = 0; i < 60; i++) {
      const ev = step(p, body, {
        moveZ: 1,
        buttons: Button.Sprint | (i % 2 ? Button.Crouch | Button.Prone : 0),
      });
      expect(ev.some((e) => e.type === 'slide')).toBe(false);
    }
    expect(p.move.sprinting).toBe(false);
    expect(p.move.prone).toBe(false);
    expect(p.move.sliding).toBe(false);
    // Jump lifts off on thrust (no jump event).
    const ev = step(p, body, { buttons: J });
    expect(ev.some((e) => e.type === 'jump')).toBe(false);
    for (let i = 0; i < 20; i++) step(p, body, { buttons: J });
    expect(p.move.pos.y).toBeGreaterThan(0.3);
  });

  it('is deterministic: the same inputs give the same flight (prediction == server)', () => {
    const script = (i: number): Partial<PlayerInput> => ({
      buttons:
        (i % 50 < 30 ? J : 0) | (i % 90 > 80 ? Button.Crouch : 0) | (i % 7 ? Button.Fire : 0),
      moveX: Math.sin(i / 23),
      moveZ: Math.cos(i / 31),
      yaw: i / 100,
    });
    const run = (): PlayerState => {
      const { p, body } = fresh();
      ignite(p, body);
      for (let i = 0; i < 600; i++) step(p, body, script(i));
      return p;
    };
    const a = run();
    const b = run();
    expect(b.move).toEqual(a.move);
    expect(b.guns).toEqual(a.guns);
    // A copy mid-flight continues identically (a reconcile replay from a snapshot).
    const { p, body } = fresh();
    ignite(p, body);
    for (let i = 0; i < 200; i++) step(p, body, script(i));
    const c = clonePlayerState(p);
    const cb = new RoofBody(p.move.pos);
    for (let i = 200; i < 400; i++) {
      step(p, body, script(i));
      step(c, cb, script(i));
    }
    expect(c.move).toEqual(p.move);
  });

  it('shoots in flight: jump spread (a bit worse), tighter in an aimed hover, more recoil', () => {
    const { p, body } = fresh();
    ignite(p, body);
    for (let i = 0; i < 40; i++) step(p, body, { buttons: J });
    for (let i = 0; i < 40; i++) step(p, body, { buttons: Button.Ads });
    const shots = step(p, body, { buttons: Button.Ads | Button.Fire });
    expect(shots.some((e) => e.type === 'shot')).toBe(true);
    const w = p.guns.rifle;
    const ctx = {
      sprinting: false,
      crouched: false,
      grounded: false,
      speed: 0,
      walkSpeed: 4.6,
      ownerSeed: 1,
    };
    const hip = { ...w, adsAmount: 0, bloom: 0 };
    const ads = { ...w, adsAmount: 1, bloom: 0 };
    const jumping = currentSpread(hip, ctx);
    expect(currentSpread(hip, { ...ctx, flying: 1 })).toBeCloseTo(
      jumping + RIFLE.spread.airborne * (JETPACK.spreadScale - 1),
      6,
    );
    const steadyAds = currentSpread(ads, { ...ctx, flying: 1 });
    const fastAds = currentSpread(ads, { ...ctx, flying: 0 });
    expect(steadyAds).toBeLessThan(fastAds);
    expect(fastAds).toBeGreaterThan(currentSpread(ads, ctx)); // never better than a jump moving
    // Recoil: the same first shot kicks harder in flight than on the ground.
    const ground = createPlayerState({ x: 0, y: 0, z: 0 });
    ground.move.grounded = true;
    const gb = new RoofBody();
    for (let i = 0; i < 40; i++) step(ground, gb, { buttons: Button.Ads });
    step(ground, gb, { buttons: Button.Ads | Button.Fire });
    expect(p.guns.rifle.recoilPitch).toBeGreaterThan(ground.guns.rifle.recoilPitch * 1.1);
  });

  it('a flyer killed in the air falls to the ground', () => {
    const { p, body } = fresh();
    ignite(p, body);
    for (let i = 0; i < 90; i++) step(p, body, { buttons: J });
    expect(p.move.pos.y).toBeGreaterThan(2);
    p.health = 0;
    for (let i = 0; i < 90; i++) step(p, body, { buttons: J });
    expect(p.move.pos.y).toBe(0);
  });
});

describe('jetpack flight in the real Rapier world', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('lit crouched under a low ceiling: the eye stays with the crouched capsule, under the roof', () => {
    // A 1 m platform (x < 0) under a slab whose underside is at 2.3 m over x ∈ [-6, 6]: on the
    // platform only a crouch fits (1.3 m of headroom). Crouch-walk in from the open side, step
    // off the edge and light the pack in the air: standing up is still blocked (Codex P2).
    const CEIL = 2.3;
    const world = new PhysicsWorld({
      name: 'test',
      bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
      boxes: [
        boxMinMax({ x: -50, y: -1, z: -50 }, { x: 50, y: 0, z: 50 }, 'ground'),
        boxMinMax({ x: -20, y: 0, z: -3 }, { x: 0, y: 1, z: 3 }, 'concrete'),
        boxMinMax({ x: -6, y: CEIL, z: -3 }, { x: 6, y: CEIL + 0.3, z: 3 }, 'concrete'),
      ],
      spawns: [],
      dummies: [],
    });
    const feet = { x: -10, y: 1.05, z: 0 };
    const p = createPlayerState(feet);
    const body = world.createCharacter(feet);
    run(p, body, 0.3, {});
    grantJetpack(p.move);
    run(p, body, 0.4, { buttons: Button.Crouch });
    expect(p.move.crouched).toBe(true);
    // Crouch-walk right (+x at yaw 0) until airborne off the platform's edge.
    for (let i = 0; i < 600 && p.move.grounded; i++)
      run(p, body, SIM_DT, { moveX: 1, buttons: Button.Crouch });
    expect(p.move.grounded).toBe(false);
    run(p, body, 0.12, {}); // past the coyote time, still under the slab
    run(p, body, SIM_DT, { buttons: Button.Jump });
    expect(p.move.jet).toBe(JetMode.Flying);
    run(p, body, 1.2, {}); // hover (the boost lifts it into the slab)
    expect(p.move.crouched).toBe(true);
    expect(p.move.pos.y + p.move.eyeHeight).toBeLessThan(CEIL);
    expect(p.move.eyeHeight).toBeCloseTo(PLAYER.crouchEyeHeight, 2);
  });
});

describe('jetpack pickups', () => {
  const at = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
  const spots = [at(0, 0), at(30, 0), at(60, 0)];

  it('three per match, one each; worn ones are not taken twice', () => {
    const items = createJetpacks(spots);
    expect(items).toHaveLength(3);
    const a = { id: 'a', pos: at(0.3, 0), alive: true, jet: 0 };
    const b = { id: 'b', pos: at(0.2, 0.1), alive: true, jet: 0 };
    expect(stepJetpacks(items, [a, b])).toEqual([{ type: 'pickup', id: 0, by: 'a' }]);
    a.jet = 1;
    expect(stepJetpacks(items, [a, b])).toEqual([]);
    // Carrying one, you can't take another.
    a.pos = at(30, 0);
    expect(stepJetpacks(items, [a, b])).toEqual([]);
    expect(items[1]!.carrier).toBeNull();
    expect(stepJetpacks(items, [a, { ...b, eligible: false, pos: at(60, 0) }])).toEqual([]);
  });

  it('an unlit pack drops where its carrier died (onto the floor); a lit one is spent', () => {
    const items = createJetpacks(spots);
    const a = { id: 'a', pos: at(0, 0), alive: true, jet: 0 };
    stepJetpacks(items, [a]);
    a.jet = 1;
    a.pos = at(5, 7, 1.5); // killed mid-jump
    a.alive = false;
    const ev = stepJetpacks(items, [a], (p) => ({ ...p, y: 0 }));
    expect(ev).toEqual([{ type: 'drop', id: 0, by: 'a', pos: at(5, 7, 0) }]);
    const c = { id: 'c', pos: at(5.5, 7), alive: true, jet: 0 };
    expect(stepJetpacks(items, [a, c])).toEqual([{ type: 'pickup', id: 0, by: 'c' }]);
    c.jet = 2;
    stepJetpacks(items, [a, c]);
    c.alive = false;
    expect(stepJetpacks(items, [a, c])).toEqual([{ type: 'spent', id: 0, by: 'c' }]);
    expect(items[0]!.spent).toBe(true);
  });

  it('a flight that lands is spent; nothing comes back until the match resets', () => {
    let items = createJetpacks(spots);
    const a = { id: 'a', pos: at(30, 0), alive: true, jet: 0 };
    stepJetpacks(items, [a]);
    a.jet = 2;
    stepJetpacks(items, [a]);
    a.jet = 0;
    expect(stepJetpacks(items, [a])).toEqual([{ type: 'spent', id: 1, by: 'a' }]);
    for (let i = 0; i < 100; i++) expect(stepJetpacks(items, [a])).toEqual([]);
    expect(items.filter((i) => !i.spent)).toHaveLength(2);
    items = createJetpacks(spots); // the next match
    expect(items.every((i) => !i.spent && i.carrier === null)).toBe(true);
  });

  it('lit and killed in the same tick: the pack is spent, not dropped for reuse', () => {
    // Codex P2: the step's first look at the carrier already sees it dead while flying.
    const items = createJetpacks(spots);
    const a = { id: 'a', pos: at(0, 0), alive: true, jet: 0 };
    stepJetpacks(items, [a]);
    a.jet = 1;
    stepJetpacks(items, [a]);
    expect(items[0]!.armed).toBe(false);
    a.jet = 2; // ignited this tick...
    a.alive = false; // ...and shot in the same one
    expect(stepJetpacks(items, [a])).toEqual([{ type: 'spent', id: 0, by: 'a' }]);
    expect(items[0]!.spent).toBe(true);
  });

  it('a respawn without a death keeps the count honest', () => {
    const items = createJetpacks(spots);
    stepJetpacks(items, [{ id: 'a', pos: at(0, 0), alive: true, jet: 0 }]);
    items[0]!.pos = at(3, 3, -30); // fell out of the world
    expect(jetpackRespawned(items, 'a', spots)).toEqual([
      { type: 'drop', id: 0, by: 'a', pos: at(0, 0) },
    ]);
    stepJetpacks(items, [{ id: 'b', pos: at(30, 0), alive: true, jet: 0 }]);
    items[1]!.armed = true;
    expect(jetpackRespawned(items, 'b', spots)).toEqual([{ type: 'spent', id: 1, by: 'b' }]);
  });
});
