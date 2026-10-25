import { beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  emptyInput,
  GRENADE,
  initPhysics,
  KNIFE,
  KNIFE_DEFENSE,
  MATCH,
  MATCH_NET,
  RIFLE,
  SIDEARM,
  SIM,
  type CombatEvent,
  type GrenadeState,
  type PlayerInput,
  type RespawnMessage,
  type Vec3,
} from '@wd/shared';
import { rewindCapMs } from './lagComp.ts';
import { MatchSim, type QueuedInput, type ServerPlayer } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

const TICK = 1000 / SIM.tickHz;
type Hit = Extract<CombatEvent, { type: 'hit' }>;

/** Put a player somewhere (tests only: players move by inputs in the game). */
function place(p: ServerPlayer, feet: Vec3, yaw = 0): void {
  p.body.setPosition(feet);
  p.body.setGrounded(true);
  p.state.move.pos = { ...feet };
  p.state.view = { yaw, pitch: 0 };
}

/**
 * Drives a match like connected clients: one input per player per tick (sequence numbers kept
 * per player), sent at the tick's time, then one server tick. Collects every combat event.
 */
class Driver {
  readonly events: CombatEvent[] = [];
  private readonly seq = new Map<string, number>();
  constructor(readonly sim: MatchSim) {}

  tick(inputs: Record<string, Partial<QueuedInput>>, perTick = 1): void {
    for (const [id, extra] of Object.entries(inputs)) {
      const batch: QueuedInput[] = [];
      for (let k = 0; k < perTick; k++) {
        const s = this.seq.get(id) ?? 0;
        this.seq.set(id, s + 1);
        batch.push({ ...emptyInput(s), ...extra, seq: s });
      }
      this.sim.receiveInputs(id, batch, this.sim.nowMs);
    }
    this.sim.step();
    this.events.push(...this.sim.drainEvents());
  }

  run(n: number, inputs: Record<string, Partial<QueuedInput>>): void {
    for (let i = 0; i < n; i++) this.tick(inputs);
  }

  hits(): Hit[] {
    return this.events.filter((e): e is Hit => e.type === 'hit');
  }
}

/** Aim (yaw, pitch) from `eye` at `to`. */
function aim(eye: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - eye.x;
  const dy = to.y - eye.y;
  const dz = to.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

const chestOf = (feet: Vec3): Vec3 => ({ x: feet.x, y: feet.y + 1.17, z: feet.z });

/** A shooter at (0, 0, -12) and a target 10 m north on the range's open firing lane. */
function duel(): { sim: MatchSim; d: Driver; a: ServerPlayer; b: ServerPlayer } {
  const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
  const a = sim.addPlayer('a', 'Ada', 0);
  const b = sim.addPlayer('b', 'Bo', 0);
  place(a, { x: 0, y: 0, z: -12 });
  place(b, { x: 0, y: 0, z: -22 }, Math.PI);
  // Nothing between them (the test's own premise).
  expect(sim.physics.castRay({ x: 0, y: 1.2, z: -12.5 }, { x: 0, y: 0, z: -1 }, 9)).toBeNull();
  return { sim, d: new Driver(sim), a, b };
}

describe('lag compensation', () => {
  /**
   * B stands at x = 0, then strafes east for `moveTicks`; A aims (ADS) where B stood and fires
   * one shot reporting view time `vt(sim)`. Returns the shot's hits.
   */
  function scenario(moveTicks: number, vt: (sim: MatchSim, t0: number) => number | undefined) {
    const { sim, d, a, b } = duel();
    const eye = { x: 0, y: 1.62, z: -12 };
    const look = aim(eye, chestOf(b.state.move.pos));
    const ads = { ...look, buttons: Button.Ads };
    d.run(30, { a: ads, b: {} }); // settle, full ADS
    const t0 = sim.nowMs; // B at x = 0 in the history here
    const x0 = b.state.move.pos.x;
    d.run(moveTicks, { a: ads, b: { moveX: 1 } });
    const moved = b.state.move.pos.x - x0;
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire, vt: vt(sim, t0) }, b: { moveX: 1 } });
    expect(a.shots).toBe(1);
    const hits = d.hits();
    sim.dispose();
    return { hits, moved };
  }

  it('a target that moved is hit where the shooter saw it (rewound to the view time)', () => {
    // 150 ms of strafing: B is well clear of the line of fire now...
    const now = scenario(9, (sim) => sim.nowMs + TICK);
    expect(now.moved).toBeGreaterThan(0.35); // clear of every hit volume (torso r = 0.24 m)
    expect(now.hits).toEqual([]); // ...so a shot at the present misses,
    // ...but the shooter was drawing B 150 ms back, still standing in the sights: a hit.
    const seen = scenario(9, (_sim, t0) => t0);
    expect(seen.hits).toHaveLength(1);
    expect(seen.hits[0]).toMatchObject({ by: 'a', target: 'b', weapon: 'rifle' });
  });

  it('never rewinds past the cap: an old view time is clamped to the cap of that player', () => {
    // 500 ms of strafing: B left the sights ~400 ms ago. Claiming the view from back then
    // reaches only the cap (290 ms without a measured ping), where B was already out of the line.
    const late = scenario(30, (_sim, t0) => t0);
    expect(late.moved).toBeGreaterThan(1.5);
    expect(late.hits).toEqual([]);
  });

  it('the rewind reaches exactly the capped time: aimed where B was then, a hit', () => {
    const { sim, d, a, b } = duel();
    const eye = { x: 0, y: 1.62, z: -12 };
    const ads = { ...aim(eye, chestOf(b.state.move.pos)), buttons: Button.Ads };
    d.run(30, { a: ads, b: {} });
    const t0 = sim.nowMs;
    d.run(30, { a: ads, b: { moveX: 1 } });
    // The shot is resolved in the next tick; the cap puts its view at (that tick − the cap).
    const capped = b.history.at(sim.nowMs + TICK - rewindCapMs(null))!;
    const look = aim(eye, chestOf(capped.feet));
    d.run(15, { a: { ...look, buttons: Button.Ads }, b: { moveX: 1 } }); // re-aim, re-settle
    // B keeps moving: aim at where B was one cap before the shot tick.
    const at = b.history.at(sim.nowMs + TICK - rewindCapMs(null))!;
    const shot = { ...aim(eye, chestOf(at.feet)), buttons: Button.Ads | Button.Fire, vt: t0 };
    d.tick({ a: shot, b: { moveX: 1 } });
    expect(a.shots).toBe(1);
    expect(d.hits()).toHaveLength(1);
    sim.dispose();
  });

  it('without a reported view time: interpolation delay + the round trip', () => {
    const { sim, d, a, b } = duel();
    a.rtt = 80; // rewind = 100 + 80 ms
    const eye = { x: 0, y: 1.62, z: -12 };
    const ads = { ...aim(eye, chestOf(b.state.move.pos)), buttons: Button.Ads };
    d.run(30, { a: ads, b: {} });
    d.run(9, { a: ads, b: { moveX: 1 } }); // 150 ms: B was in the sights 180 ms ago
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire }, b: { moveX: 1 } });
    expect(d.hits()).toHaveLength(1);
    sim.dispose();
  });
});

describe('server damage, death and respawn', () => {
  it('seeds pose history on join so a first-tick shot can see the target', () => {
    const { sim, a, b } = duel();
    const targets = sim.targetsAt(sim.nowMs, a.id);
    expect(b.history.size).toBe(1);
    expect(targets.some((t) => t.id === b.id)).toBe(true);
    sim.dispose();
  });

  it('collects same-tick shots before applying lethal damage, so return fire still counts', () => {
    const { sim, d, a, b } = duel();
    const eyeA = { x: 0, y: 1.62, z: -12 };
    const eyeB = { x: 0, y: 1.62, z: -22 };
    const aimA = aim(eyeA, chestOf(b.state.move.pos));
    const aimB = aim(eyeB, chestOf(a.state.move.pos));
    d.run(20, { a: { ...aimA, buttons: Button.Ads }, b: { ...aimB, buttons: Button.Ads } });
    a.state.health = 25;
    b.state.health = 25;
    d.tick({
      a: { ...aimA, buttons: Button.Ads | Button.Fire },
      b: { ...aimB, buttons: Button.Ads | Button.Fire },
    });
    expect(
      d
        .hits()
        .filter((h) => h.killed)
        .map((h) => h.by)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(a.kills).toBe(1);
    expect(b.kills).toBe(1);
    expect(a.deaths).toBe(1);
    expect(b.deaths).toBe(1);
    sim.dispose();
  });

  it('preserves each queued input’s weapon state when a catch-up tick applies a burst', () => {
    const { sim, d, a, b } = duel();
    const eye = { x: 0, y: 1.62, z: -12 };
    const look = aim(eye, chestOf(b.state.move.pos));
    a.credit = 2;
    sim.receiveInputs(
      'a',
      [
        { ...emptyInput(0), ...look, buttons: Button.Fire },
        { ...emptyInput(1), yaw: Math.PI / 2, buttons: Button.Slot3 },
      ],
      sim.nowMs,
    );
    sim.step(0);
    d.events.push(...sim.drainEvents());
    expect(d.events.find((e) => e.type === 'shot')).toMatchObject({ by: 'a', slot: 'rifle' });
    expect(a.shots).toBe(1);
    expect(a.state.arsenal.target).toBe('knife');
    sim.dispose();
  });

  it('tags a gun hit with the firing input seq even when later catch-up inputs advance ack', () => {
    const { sim, d, a, b } = duel();
    const eye = { x: 0, y: 1.62, z: -12 };
    const look = aim(eye, chestOf(b.state.move.pos));
    d.run(20, { a: { ...look, buttons: Button.Ads }, b: {} });
    a.credit = 2;
    sim.receiveInputs(
      'a',
      [
        { ...emptyInput(100), ...look, buttons: Button.Ads | Button.Fire },
        { ...emptyInput(101), ...look, buttons: Button.Ads },
      ],
      sim.nowMs,
    );
    sim.step(0);
    d.events.push(...sim.drainEvents());
    expect(a.ack).toBe(101);
    expect(d.hits()).toContainEqual(expect.objectContaining({ by: 'a', target: 'b', seq: 100 }));
    sim.dispose();
  });

  it('shots damage, a kill scores, the dead stay down, then respawn fresh at a spawn', () => {
    const { sim, d, a, b } = duel();
    const respawns: RespawnMessage[] = [];
    sim.onRespawn = (_p, m) => respawns.push(m);
    const eye = { x: 0, y: 1.62, z: -12 };
    const fire = { ...aim(eye, chestOf(b.state.move.pos)), buttons: Button.Ads | Button.Fire };
    d.run(20, { a: { ...fire, buttons: Button.Ads }, b: {} });
    // Hold the trigger until B goes down (4 torso hits at 25; recoil climbs to the head).
    for (let i = 0; i < 60 && b.state.health > 0; i++) d.tick({ a: fire, b: {} });
    const hits = d.hits();
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.by === 'a' && h.target === 'b')).toBe(true);
    // Health only ever falls, and the last hit is the kill.
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.hp).toBeLessThan(hits[i - 1]!.hp);
    expect(hits.at(-1)).toMatchObject({ killed: true, hp: 0 });
    expect(b.state.health).toBe(0);
    expect(a.kills).toBe(1);
    expect(b.deaths).toBe(1);
    expect(sim.takeMatchChange()?.scores).toEqual([
      { id: 'a', kills: 1, deaths: 0 },
      { id: 'b', kills: 0, deaths: 1 },
    ]);

    // Dead: inputs are acknowledged but do nothing, and bullets pass through the body.
    const body = { ...b.state.move.pos };
    const before = d.hits().length;
    d.run(30, { a: fire, b: { moveZ: 1, buttons: Button.Fire } });
    expect(b.state.move.pos).toEqual(body);
    expect(d.hits().length).toBe(before);
    expect(b.life).toBe(0);

    // After the respawn delay: a fresh life at a generated spawn, the client told.
    d.run(Math.round(MATCH.respawnDelay * SIM.tickHz), { a: {}, b: {} });
    expect(b.life).toBe(1);
    expect(b.state.health).toBe(100);
    expect(b.state.guns.rifle.ammo).toBe(RIFLE.magazineSize);
    expect(respawns).toHaveLength(1);
    expect(sim.spawns.some((s) => s.pos.x === respawns[0]!.x && s.pos.z === respawns[0]!.z)).toBe(
      true,
    );
    expect(sim.snapshot('b').players.find((p) => p.id === 'b')!.life).toBe(1);
    sim.dispose();
  });

  it('knife strikes are resolved on the server too, with the defender’s guard', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'Ada', 0);
    const b = sim.addPlayer('b', 'Bo', 0);
    place(a, { x: 0, y: 0, z: -12 });
    place(b, { x: 0, y: 0, z: -13.4 }, Math.PI);
    const d = new Driver(sim);
    d.run(5, { a: {}, b: {} });
    d.tick({ a: { buttons: Button.Melee }, b: {} }); // quick knife: opening chamber, then the cut
    d.run(30, { a: {}, b: {} });
    const hit = d.hits().find((h) => h.weapon === 'knife');
    expect(hit).toMatchObject({ by: 'a', target: 'b', outcome: 'hit' });
    expect(b.state.health).toBeLessThan(100);

    // Guard up and facing A: the next strike is blocked (a quarter of the damage).
    const hp = b.state.health;
    const guard = { yaw: Math.PI, buttons: Button.Block };
    d.run(40, { a: {}, b: guard });
    d.tick({ a: { buttons: Button.Melee }, b: guard });
    d.run(30, { a: {}, b: guard });
    const blocked = d
      .hits()
      .filter((h) => h.weapon === 'knife')
      .at(-1)!;
    expect(blocked.outcome).toBe('blocked');
    expect(b.state.health).toBeCloseTo(hp - blocked.dmg, 6);
    expect(blocked.dmg).toBeLessThan(20);
    sim.dispose();
  });

  it('frags fly and go off on the server: blast damage, kill credit, no credit for yourself', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'Ada', 0);
    const b = sim.addPlayer('b', 'Bo', 0);
    place(a, { x: 0, y: 0, z: -12 });
    place(b, { x: 0, y: 0, z: -13.5 }, Math.PI);
    const d = new Driver(sim);
    // Both nearly dead, so any blast damage in the open kills: the credit rules are the test.
    a.state.health = 10;
    b.state.health = 10;
    const down = { pitch: -1.4 }; // at our feet
    d.run(3, { a: down, b: {} });
    d.tick({ a: { ...down, buttons: Button.Grenade }, b: {} });
    d.run(Math.ceil((GRENADE.windup + GRENADE.fuse + 0.5) * SIM.tickHz), { a: down, b: {} });
    const nade = d.events.find((e) => e.type === 'nade');
    const boom = d.events.find((e) => e.type === 'boom');
    expect(nade).toMatchObject({ by: 'a' });
    expect(boom).toMatchObject({ by: 'a' });
    const frag = d.hits().filter((h) => h.weapon === 'frag');
    expect(frag.map((h) => h.target).sort()).toEqual(['a', 'b']);
    expect(frag.every((h) => h.killed)).toBe(true);
    expect(a.kills).toBe(1); // B
    expect(a.deaths).toBe(1); // yourself: a death, no kill
    expect(b.deaths).toBe(1);
    expect(sim.grenades).toHaveLength(0);
    sim.dispose();
  });

  it.each(['blocked', 'parried'] as const)(
    'uses the knife release pose for a %s during catch-up, preserving live parry effects',
    (outcome) => {
      const { sim, d, a, b } = duel();
      place(a, { x: -1.2, y: 0, z: -12.9 });
      place(b, { x: 0, y: 0, z: -13.4 }, Math.PI);
      d.run(3, { a: {}, b: { yaw: Math.PI } });
      // The strike releases inside the guard arc, then the attacker slides outside it during
      // the remaining inputs. Defense must see the source pose, not the end of the batch.
      a.state.move.vel = { x: 0, y: 0, z: -6 };
      Object.assign(a.state.arsenal.melee, {
        phase: 'windup',
        timer: 0.001,
        move: 'slash',
        empowered: true,
        combo: 2,
      });
      b.state.arsenal.guard.held = true;
      b.state.arsenal.guard.heldFor = outcome === 'parried' ? 0.05 : 0.6;
      const look = aim({ ...a.state.move.pos, y: 1.62 }, chestOf(b.state.move.pos));
      a.credit = MATCH_NET.maxStepsPerTick;
      sim.receiveInputs(
        'a',
        Array.from({ length: MATCH_NET.maxStepsPerTick }, (_, k) => ({
          ...emptyInput(3 + k),
          ...look,
          vt: sim.nowMs,
        })),
        sim.nowMs,
      );
      sim.step(0);
      const hit = sim.drainEvents().find((e): e is Hit => e.type === 'hit');
      expect(hit).toMatchObject({ weapon: 'knife', outcome });
      if (outcome === 'parried') {
        expect(a.state.arsenal.stun).toBe(KNIFE_DEFENSE.parryStun);
        expect(a.state.arsenal.melee.combo).toBe(0);
        expect(a.state.move.vel.x).toBeLessThan(-1);
        expect(b.state.arsenal.counter).toBe(KNIFE_DEFENSE.counterWindow);
      } else {
        expect(hit!.dmg).toBe(
          Math.round(
            (KNIFE.damage + KNIFE_DEFENSE.counterBonusDamage) *
              KNIFE_DEFENSE.guardDamageMultiplier *
              10,
          ) / 10,
        );
      }
      sim.dispose();
    },
  );

  it('frag blast LOS uses the real range geometry: open target hurt, target behind cover safe', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'Ada', 0);
    const b = sim.addPlayer('b', 'Bo', 0);
    const c = sim.addPlayer('c', 'Cy', 0);
    place(a, { x: 0, y: 0, z: -12 });
    place(b, { x: -6, y: 0, z: -27.6 });
    place(c, { x: -6, y: 0, z: -31.5 });
    b.state.health = 10;
    c.state.health = 10;
    const g: GrenadeState = {
      id: 99,
      owner: a.seed,
      pos: { x: -6, y: 0.08, z: -29.25 },
      vel: { x: 0, y: 0, z: 0 },
      fuse: 0,
      resting: true,
      kind: 'frag',
    };
    sim.grenades.push({ g, owner: 'a' });
    sim.step();
    const frag = sim.drainEvents().filter((e): e is Hit => e.type === 'hit' && e.weapon === 'frag');
    expect(frag.map((h) => h.target)).toEqual(['b']);
    expect(b.state.health).toBe(0);
    expect(c.state.health).toBe(10);
    sim.dispose();
  });
});

describe('anti-cheat: the shared weapon state machine enforces fire rate and ammo', () => {
  function shooter(): { sim: MatchSim; d: Driver; a: ServerPlayer } {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'Ada', 0);
    place(a, { x: 0, y: 0, z: -12 });
    return { sim, d: new Driver(sim), a };
  }

  it('a held trigger at twice the input rate still fires at 720 RPM', () => {
    const { sim, d, a } = shooter();
    // Two Fire inputs per tick for one second: the movement budget steps only one per tick.
    for (let i = 0; i < SIM.tickHz; i++) d.tick({ a: { buttons: Button.Fire } }, 2);
    const perSecond = RIFLE.roundsPerMinute / 60;
    expect(a.shots).toBeLessThanOrEqual(perSecond + 1);
    expect(a.shots).toBeGreaterThanOrEqual(perSecond - 1);
    expect(a.state.guns.rifle.ammo).toBe(RIFLE.magazineSize - a.shots);
    sim.dispose();
  });

  it('a semi-auto spammed every step fires no faster than its cycle rate', () => {
    const { sim, d, a } = shooter();
    d.tick({ a: { buttons: Button.Slot2 } });
    d.run(30, { a: {} }); // pistol up
    for (let i = 0; i < SIM.tickHz; i++) d.tick({ a: { buttons: i % 2 ? 0 : Button.Fire } });
    expect(a.state.arsenal.slot).toBe('sidearm');
    expect(a.shots).toBeLessThanOrEqual(SIDEARM.roundsPerMinute / 60 + 1);
    expect(a.shots).toBeGreaterThan(3);
    sim.dispose();
  });

  it('no shot without ammo: a magazine empties, then nothing until the reload is done', () => {
    const { sim, d, a } = shooter();
    d.run(Math.round(3 * SIM.tickHz), { a: { buttons: Button.Fire } }); // 2.5 s empties it
    expect(a.shots).toBe(RIFLE.magazineSize);
    expect(a.state.guns.rifle.reloadTimer).toBeGreaterThan(0);
    sim.dispose();
  });

  it('view angles are sanitized: pitch clamped, yaw wrapped, garbage never reaches the sim', () => {
    const { sim, d, a } = shooter();
    d.tick({ a: { yaw: 1e6, pitch: 50 } });
    expect(Math.abs(a.state.view.pitch)).toBeLessThanOrEqual((89 * Math.PI) / 180 + 1e-9);
    expect(Math.abs(a.state.view.yaw)).toBeLessThan(Math.PI * 2);
    sim.dispose();
  });
});

describe('match flow', () => {
  function kill(sim: MatchSim, d: Driver, killer: ServerPlayer, victim: ServerPlayer): void {
    const eye = {
      x: killer.state.move.pos.x,
      y: killer.state.move.pos.y + 1.62,
      z: killer.state.move.pos.z,
    };
    const look = aim(eye, chestOf(victim.state.move.pos));
    const idle = { [victim.id]: {} };
    d.run(20, { [killer.id]: { ...look, buttons: Button.Ads }, ...idle });
    for (let i = 0; i < 90 && victim.state.health > 0; i++) {
      d.tick({ [killer.id]: { ...look, buttons: Button.Ads | Button.Fire }, ...idle });
    }
    expect(victim.state.health).toBe(0);
    void sim;
  }

  it('first to the score limit wins; results, then a fresh match', () => {
    const { sim, d, a, b } = duel();
    a.kills = MATCH.scoreLimit - 1;
    sim.takeMatchChange();
    kill(sim, d, a, b);
    expect(sim.phase).toBe('ended');
    const ended = sim.takeMatchChange()!;
    expect(ended).toMatchObject({ phase: 'ended', winners: ['a'] });
    // No damage while the results show.
    const lifeA = a.life;
    d.run(Math.round(MATCH.intermission * SIM.tickHz) - 1, { a: {}, b: {} });
    expect(sim.phase).toBe('ended');
    d.tick({ a: {}, b: {} });
    expect(sim.phase).toBe('playing');
    expect(sim.takeMatchChange()).toMatchObject({
      phase: 'playing',
      winners: [],
      scores: [
        { id: 'a', kills: 0, deaths: 0 },
        { id: 'b', kills: 0, deaths: 0 },
      ],
    });
    expect(a.life).toBe(lifeA + 1); // everyone respawns for the new match
    expect(b.state.health).toBe(100);
    sim.dispose();
  });

  it('defers score-limit ending until same-tick trades are counted', () => {
    const { sim, d, a, b } = duel();
    const eyeA = { x: 0, y: 1.62, z: -12 };
    const eyeB = { x: 0, y: 1.62, z: -22 };
    const aimA = aim(eyeA, chestOf(b.state.move.pos));
    const aimB = aim(eyeB, chestOf(a.state.move.pos));
    a.kills = MATCH.scoreLimit - 1;
    b.kills = MATCH.scoreLimit - 1;
    d.run(20, { a: { ...aimA, buttons: Button.Ads }, b: { ...aimB, buttons: Button.Ads } });
    a.state.health = 25;
    b.state.health = 25;
    d.tick({
      a: { ...aimA, buttons: Button.Ads | Button.Fire },
      b: { ...aimB, buttons: Button.Ads | Button.Fire },
    });
    expect(sim.matchState()).toMatchObject({ phase: 'ended', winners: ['a', 'b'] });
    expect(a.kills).toBe(MATCH.scoreLimit);
    expect(b.kills).toBe(MATCH.scoreLimit);
    sim.dispose();
  });

  it('defers score-limit ending until all victims in a frag blast are counted', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'Ada', 0);
    const b = sim.addPlayer('b', 'Bo', 0);
    const c = sim.addPlayer('c', 'Cy', 0);
    place(a, { x: 0, y: 0, z: -12 });
    place(b, { x: 0, y: 0, z: -13.5 });
    place(c, { x: 1, y: 0, z: -13.5 });
    a.kills = MATCH.scoreLimit - 1;
    b.state.health = 10;
    c.state.health = 10;
    const g: GrenadeState = {
      id: 100,
      owner: a.seed,
      pos: { x: 0, y: 0.08, z: -13 },
      vel: { x: 0, y: 0, z: 0 },
      fuse: 0,
      resting: true,
      kind: 'frag',
    };
    sim.grenades.push({ g, owner: 'a' });
    sim.step();
    const hits = sim.drainEvents().filter((e): e is Hit => e.type === 'hit' && e.weapon === 'frag');
    expect(hits.map((h) => h.target).sort()).toEqual(['a', 'b', 'c']);
    expect(a.kills).toBe(MATCH.scoreLimit + 1);
    expect(a.deaths).toBe(1);
    expect(sim.matchState()).toMatchObject({ phase: 'ended', winners: ['a'] });
    sim.dispose();
  });

  it('clears in-flight frags on match end and suppresses combat during intermission', () => {
    const { sim, d, a, b } = duel();
    const g: GrenadeState = {
      id: 101,
      owner: a.seed,
      pos: { x: 0, y: 0.08, z: -13 },
      vel: { x: 0, y: 0, z: 0 },
      fuse: 0,
      resting: true,
      kind: 'frag',
    };
    sim.grenades.push({ g, owner: 'a' });
    a.kills = MATCH.scoreLimit;
    sim.phaseEnds = sim.tick + 1;
    sim.step();
    expect(sim.phase).toBe('ended');
    expect(sim.grenades).toHaveLength(0);
    sim.drainEvents();

    const eyeA = { x: 0, y: 1.62, z: -12 };
    const look = aim(eyeA, chestOf(b.state.move.pos));
    d.tick({ a: { ...look, buttons: Button.Fire | Button.Grenade }, b: {} });
    expect(
      d.events.filter((e) => e.type === 'shot' || e.type === 'nade' || e.type === 'hit'),
    ).toEqual([]);
    expect(sim.grenades).toHaveLength(0);
    sim.dispose();
  });

  it('at the whistle: most kills wins, equal kills and deaths share the win', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    a.kills = 3;
    b.kills = 3;
    a.deaths = 1;
    b.deaths = 1;
    sim.phaseEnds = sim.tick + 1;
    sim.step();
    expect(sim.matchState()).toMatchObject({ phase: 'ended', winners: ['a', 'b'] });
    sim.dispose();
  });

  it('keeps shared weapon prediction coherent during results without emitting combat', () => {
    const { sim, d, a } = duel();
    sim.phaseEnds = sim.tick + 1;
    sim.step();
    sim.drainEvents();
    d.tick({ a: { buttons: Button.Fire } });
    expect(a.state.guns.rifle.ammo).toBe(RIFLE.magazineSize - 1);
    expect(a.state.prevButtons).toBe(Button.Fire);
    expect(d.events).toEqual([]);
    sim.dispose();
  });

  it('renames: sanitized, rate limited, unchanged names ignored', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    sim.addPlayer('a', 'Player 1', 0);
    expect(sim.rename('a', '  Ada‮\u0007 ', 0)).toBe(true);
    expect(sim.roster().players[0]!.name).toBe('Ada');
    expect(sim.rename('a', 'Ada', 0)).toBe(false);
    expect(sim.rename('a', 'x'.repeat(40), 0)).toBe(true);
    expect(sim.roster().players[0]!.name).toHaveLength(MATCH_NET.maxNameLength);
    expect(sim.rename('a', '', 0)).toBe(false); // empty keeps the name
    // The burst is spent: further changes are ignored until the bucket refills.
    expect(sim.rename('a', 'Bo', 0)).toBe(false);
    expect(sim.rename('a', 'Bo', 1000 / MATCH_NET.nameRatePerSec)).toBe(true);
    expect(sim.rename('nobody', 'X', 0)).toBe(false);
    sim.dispose();
  });

  it('forged, replayed and stale pongs never move the round trip or the rewind cap', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    // A 10 ms player: honest echoes of the pings the server sent it.
    let now = 1000;
    for (let i = 0; i < 4; i++, now += 1000) {
      const ping = sim.issuePing('a', now)!;
      expect(sim.receivePong('a', ping.t, now + 10)).toBe(true);
    }
    expect(a.ping.forRewind).toBe(10);
    const honestCap = rewindCapMs(a.ping.forRewind);
    expect(honestCap).toBe(300);
    // Forged: stamps the server never sent (the old code took now − t from any finite t).
    for (const back of [60, 300, 300, 1000, 4000]) {
      expect(sim.receivePong('a', now - back, now)).toBe(false);
    }
    // Replayed: a real, already answered stamp again and again.
    expect(sim.receivePong('a', 1000, now)).toBe(false);
    expect(sim.receivePong('a', 4000, now)).toBe(false);
    // Someone else's ping is not ours to answer.
    const theirs = sim.issuePing('b', now)!;
    expect(sim.receivePong('a', theirs.t, now + 500)).toBe(false);
    expect(b.pings.outstanding).toBe(1);
    // Stale: answered after the timeout.
    const old = sim.issuePing('a', now)!;
    expect(sim.receivePong('a', old.t, now + MATCH_NET.pongTimeoutMs + 1)).toBe(false);
    expect(a.ping.forRewind).toBe(10);
    expect(a.rtt).toBe(10);
    expect(rewindCapMs(a.ping.forRewind)).toBe(honestCap);
    // An unknown player: nothing issued, nothing counted.
    expect(sim.issuePing('nobody', now)).toBeNull();
    expect(sim.receivePong('nobody', now, now)).toBe(false);
    // The ping carries the smoothed round trip for the badge.
    expect(sim.issuePing('a', now + 1000)).toMatchObject({ t: now + 1000, rtt: 10 });
    sim.dispose();
  });

  it('round trips are smoothed; implausible samples ignored', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'A', 0);
    sim.observeRtt('a', 100);
    expect(a.rtt).toBe(100);
    sim.observeRtt('a', 200);
    expect(a.rtt).toBe(125);
    sim.observeRtt('a', -5);
    sim.observeRtt('a', 1e9);
    expect(a.rtt).toBe(125);
    sim.dispose();
  });

  it('inputs keep their view time on the queue (and only a finite one)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'A', 0);
    const inputs: (PlayerInput & { vt?: number })[] = [
      { ...emptyInput(0), vt: 500 },
      { ...emptyInput(1), vt: Number.NaN },
      emptyInput(2),
    ];
    sim.receiveInputs('a', inputs, 0);
    expect(a.queue.map((q) => q.vt)).toEqual([500, undefined, undefined]);
    sim.dispose();
  });
});
