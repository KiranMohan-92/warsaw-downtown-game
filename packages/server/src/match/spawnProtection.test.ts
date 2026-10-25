import { beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  emptyInput,
  GRENADE,
  initPhysics,
  MATCH,
  SIM,
  SIM_DT,
  snapshotProtected,
  SPAWN_PROTECTION,
  type CombatEvent,
  type Vec3,
} from '@wd/shared';
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

/** One input per listed player per tick, then one server tick; collects the combat events. */
class Driver {
  readonly events: CombatEvent[] = [];
  private readonly seq = new Map<string, number>();
  constructor(readonly sim: MatchSim) {}

  tick(inputs: Record<string, Partial<QueuedInput>>): void {
    for (const [id, extra] of Object.entries(inputs)) {
      const s = this.seq.get(id) ?? 0;
      this.seq.set(id, s + 1);
      this.sim.receiveInputs(id, [{ ...emptyInput(s), ...extra, seq: s }], this.sim.nowMs);
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

function aim(eye: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - eye.x;
  const dy = to.y - eye.y;
  const dz = to.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

const ticks = (seconds: number): number => Math.round(seconds * SIM.tickHz);
const flagged = (sim: MatchSim, id: string): boolean =>
  snapshotProtected(sim.snapshot().players.find((p) => p.id === id)!);

/** A shooter at (0, 0, -12) and a target 10 m north on the range's open lane, both just spawned. */
function duel() {
  const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
  const a = sim.addPlayer('a', 'Ada', 0);
  const b = sim.addPlayer('b', 'Bo', 0);
  place(a, { x: 0, y: 0, z: -12 });
  place(b, { x: 0, y: 0, z: -22 }, Math.PI);
  const look = aim({ x: 0, y: 1.62, z: -12 }, { x: 0, y: 1.17, z: -22 });
  return { sim, d: new Driver(sim), a, b, ads: { ...look, buttons: Button.Ads } };
}

describe('spawn protection (server-authoritative)', () => {
  it('blocks bullets for the full window: the shooter is told it was blocked, then damage lands', () => {
    const { sim, d, a, b, ads } = duel();
    expect(a.state.spawnGuard).toBe(SPAWN_PROTECTION.duration);
    expect(flagged(sim, 'b')).toBe(true);
    d.run(30, { a: ads, b: {} });
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire }, b: {} });
    const blocked = d.hits();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      by: 'a',
      target: 'b',
      weapon: 'rifle',
      dmg: 0,
      hp: 100,
      killed: false,
      outcome: 'protected',
    });
    expect(b.state.health).toBe(100);
    // The shot ended the shooter's own protection (before it resolved), not the target's.
    expect(a.state.spawnGuard).toBe(0);
    expect(flagged(sim, 'a')).toBe(false);
    expect(flagged(sim, 'b')).toBe(true);

    // B's protection runs out on the server clock.
    d.run(ticks(SPAWN_PROTECTION.duration) - 32, { a: ads, b: {} });
    expect(b.state.spawnGuard).toBeGreaterThan(0);
    d.tick({ a: ads, b: {} });
    expect(b.state.spawnGuard).toBe(0);
    expect(flagged(sim, 'b')).toBe(false);
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire }, b: {} });
    const landed = d.hits().at(-1)!;
    expect(landed.outcome).toBeUndefined();
    expect(landed.dmg).toBeGreaterThan(0);
    expect(b.state.health).toBeLessThan(100);
    sim.dispose();
  });

  it('blocks the knife: no damage, no guard wear, no parry stun on the attacker', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const a = sim.addPlayer('a', 'Ada', 0);
    const b = sim.addPlayer('b', 'Bo', 0);
    place(a, { x: 0, y: 0, z: -12 });
    place(b, { x: 0, y: 0, z: -13.4 }, Math.PI);
    const d = new Driver(sim);
    // B raises its guard facing A just in time for a parry, were it not protected.
    d.run(5, { a: {}, b: {} });
    d.tick({ a: { buttons: Button.Melee }, b: { yaw: Math.PI } });
    d.run(30, { a: {}, b: { yaw: Math.PI, buttons: Button.Block } });
    const hit = d.hits().find((h) => h.weapon === 'knife');
    expect(hit).toMatchObject({ by: 'a', target: 'b', dmg: 0, outcome: 'protected' });
    expect(b.state.health).toBe(100);
    expect(b.state.arsenal.guard.blocks).toBe(0);
    expect(b.state.arsenal.counter).toBe(0);
    expect(a.state.arsenal.stun).toBe(0);
    expect(a.state.spawnGuard).toBe(0); // the swing ended the attacker's own protection
    sim.dispose();
  });

  it('blocks frag blasts (the thrower loses its own protection with the throw)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const a = sim.addPlayer('a', 'Ada', 0);
    const b = sim.addPlayer('b', 'Bo', 0);
    place(a, { x: 0, y: 0, z: -12 });
    place(b, { x: 0, y: 0, z: -13.5 }, Math.PI);
    b.state.health = 10; // any blast in the open would kill
    // Test setup: still protected when the (3.5 s) fuse runs out.
    b.state.spawnGuard = 10;
    b.guardEndsTick = sim.tick + ticks(10);
    const d = new Driver(sim);
    const down = { pitch: -1.4 };
    d.run(3, { a: down, b: {} });
    d.tick({ a: { ...down, buttons: Button.Grenade }, b: {} });
    expect(a.state.spawnGuard).toBe(0);
    d.run(Math.ceil((GRENADE.windup + GRENADE.fuse + 0.2) * SIM.tickHz), { a: down, b: {} });
    const frag = d.hits().filter((h) => h.weapon === 'frag');
    expect(frag.find((h) => h.target === 'b')).toMatchObject({ dmg: 0, outcome: 'protected' });
    expect(frag.find((h) => h.target === 'a')!.dmg).toBeGreaterThan(0); // its own frag: no cover
    expect(b.state.health).toBe(10);
    sim.dispose();
  });

  it('runs on server time: a player sending no inputs still loses protection', () => {
    const { sim, d, b } = duel();
    d.run(ticks(SPAWN_PROTECTION.duration) + 20, { a: {} }); // B silent (menu open, tab hidden)
    expect(b.ack).toBe(-1);
    expect(b.state.spawnGuard).toBe(0);
    sim.dispose();
  });

  it('expires on the server clock at the configured duration, inputs or none', () => {
    const { sim, d, a, b, ads } = duel();
    const n = ticks(SPAWN_PROTECTION.duration);
    // B sends nothing (its movement-credit buffer never matters); A keeps aiming at it.
    d.run(n - 2, { a: ads });
    expect(b.state.spawnGuard).toBeCloseTo(2 * SIM_DT, 9);
    expect(a.state.spawnGuard).toBeCloseTo(2 * SIM_DT, 9);
    // The last protected tick: a shot resolved in it is still blocked.
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire } });
    expect(d.hits().at(-1)).toMatchObject({ target: 'b', outcome: 'protected' });
    expect(b.state.spawnGuard).toBeCloseTo(SIM_DT, 9);
    // Tick n: gone, and the next shot lands.
    d.tick({ a: ads });
    expect(b.state.spawnGuard).toBe(0);
    expect(flagged(sim, 'b')).toBe(false);
    d.run(20, { a: ads }); // recoil settles
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire } });
    expect(d.hits()).toHaveLength(2);
    expect(d.hits().at(-1)!.outcome).toBeUndefined();
    expect(b.state.health).toBeLessThan(100);
    sim.dispose();
  });

  it('a late batch of inputs (after a stall) never stretches it', () => {
    const { sim, b } = duel();
    for (let i = 0; i < ticks(1.5); i++) sim.step(); // B's inputs held up in the network
    const late = Array.from({ length: 90 }, (_, i) => emptyInput(i));
    sim.receiveInputs('b', late, sim.nowMs);
    for (let i = 0; i < ticks(SPAWN_PROTECTION.duration - 1.5); i++) sim.step();
    expect(b.state.spawnGuard).toBe(0);
    sim.dispose();
  });

  it('a batch near the deadline neither shortens it nor lets a simultaneous bullet land', () => {
    const { sim, d, b, ads } = duel();
    const n = ticks(SPAWN_PROTECTION.duration);
    d.run(n - 6, { a: ads }); // B stalled: nothing from it since the spawn
    expect(b.state.spawnGuard).toBeCloseTo(6 * SIM_DT, 9);
    // 8 empty inputs arrive at once (their steps alone would count 8 ticks down), in the same
    // tick as A's shot.
    sim.receiveInputs(
      'b',
      Array.from({ length: 8 }, (_, i) => emptyInput(i)),
      sim.nowMs,
    );
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire } });
    expect(b.applied).toBeGreaterThan(1); // several steps ran this tick
    expect(d.hits().at(-1)).toMatchObject({ target: 'b', outcome: 'protected', dmg: 0 });
    expect(b.state.health).toBe(100);
    expect(b.state.spawnGuard).toBeCloseTo(5 * SIM_DT, 9); // the clock's remainder, restored
    sim.dispose();
  });

  it('an attack inside a batch still ends it at once', () => {
    const { sim, d, a, b } = duel();
    const back = aim({ x: 0, y: 1.62, z: -22 }, { x: 0, y: 1.17, z: -12 });
    d.run(40, { a: {} }); // B stalled
    const batch = Array.from({ length: 6 }, (_, i) => ({
      ...emptyInput(i),
      ...back,
      buttons: i === 3 ? Button.Fire : 0,
    }));
    sim.receiveInputs('b', batch, sim.nowMs);
    sim.step();
    expect(b.shots).toBe(1);
    expect(b.state.spawnGuard).toBe(0);
    expect(flagged(sim, 'b')).toBe(false);
    d.run(20, { a: {} }); // and stays off (the clock never restores it)
    expect(b.state.spawnGuard).toBe(0);
    expect(a.state.spawnGuard).toBeGreaterThan(0);
    sim.dispose();
  });

  it('aiming, reloading and sprinting keep it; the own snapshot carries what is left', () => {
    const { sim, d, b } = duel();
    b.state.guns.rifle.ammo = 5;
    d.run(20, { b: { buttons: Button.Ads } });
    d.tick({ b: { buttons: Button.Reload } });
    d.run(20, { b: { moveZ: 1, buttons: Button.Sprint } });
    expect(b.state.move.sprinting).toBe(true);
    expect(b.state.spawnGuard).toBeCloseTo(SPAWN_PROTECTION.duration - 41 * SIM_DT, 6);
    const own = sim.snapshot('b').players.find((p) => p.id === 'b')!;
    expect(own.own!.sg).toBeCloseTo(b.state.spawnGuard, 9);
    expect(sim.snapshot('b').players.find((p) => p.id === 'a')!.own).toBeUndefined();
    sim.dispose();
  });

  it('every respawn grants it again', () => {
    const { sim, d, b, ads } = duel();
    b.guardBroken = true; // test setup: this life's protection already over
    b.state.health = 1;
    d.run(30, { a: ads, b: {} });
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire }, b: {} });
    expect(b.state.health).toBe(0);
    expect(flagged(sim, 'b')).toBe(false); // the dead never shimmer
    d.run(ticks(MATCH.respawnDelay) + 2, { a: {}, b: {} });
    expect(b.life).toBe(1);
    expect(b.state.health).toBe(100);
    expect(b.state.spawnGuard).toBeGreaterThan(SPAWN_PROTECTION.duration - 0.1);
    expect(flagged(sim, 'b')).toBe(true);
    sim.dispose();
  });

  it('a player still loading gets the full protection when it joins the fight', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    sim.addPlayer('a', 'Ada', 0);
    const late = sim.addPlayer('late', 'Late', 0, false, { ready: false });
    for (let i = 0; i < ticks(3); i++) sim.step(); // loading: idles through its protection
    expect(late.state.spawnGuard).toBe(0);
    sim.markReady('late');
    expect(late.state.spawnGuard).toBe(SPAWN_PROTECTION.duration);
    sim.dispose();
  });

  it('can be turned off per match (tests)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    expect(sim.addPlayer('a', 'Ada', 0).state.spawnGuard).toBe(0);
    sim.dispose();
  });
});

describe('spawn protection with lag compensation', () => {
  /**
   * Protection is judged at resolve time (now), never rewound: the pose history rewinds where
   * a target was, not whether it could be hurt. Protection only runs down within a life, so a
   * target protected now was protected at every view time since its spawn, and a shot whose view
   * time is before the target's (re)spawn never hits it (`targetsAt` checks the life). A target
   * that ended its protection (it fired) after the shooter's view time is hit: it chose to fight.
   */
  it('a rewound shot at a target protected now is blocked, whatever the view time', () => {
    const { sim, d, b, ads } = duel();
    d.run(30, { a: ads, b: {} });
    const t0 = sim.nowMs;
    d.run(6, { a: ads, b: {} });
    // View time 100 ms back: B stood in the same place, protected then and now.
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire, vt: t0 }, b: {} });
    expect(d.hits().at(-1)).toMatchObject({ target: 'b', outcome: 'protected', dmg: 0 });
    expect(b.state.health).toBe(100);
    sim.dispose();
  });

  it('a target that fired after the shooter’s view time takes the rewound hit', () => {
    const { sim, d, a, b, ads } = duel();
    const back = { ...aim({ x: 0, y: 1.62, z: -22 }, { x: 0, y: 1.17, z: -12 }) };
    d.run(30, { a: ads, b: back });
    const t0 = sim.nowMs; // B still protected here
    expect(b.state.spawnGuard).toBeGreaterThan(0);
    d.tick({ a: ads, b: { ...back, buttons: Button.Fire } }); // B fires: protection off
    expect(b.state.spawnGuard).toBe(0);
    expect(a.state.health).toBe(100); // A was protected: B's shot was blocked
    d.run(2, { a: ads, b: back });
    // A's view time is from before B fired; judged now, B is no longer protected.
    d.tick({ a: { ...ads, buttons: Button.Ads | Button.Fire, vt: t0 + TICK }, b: back });
    const onB = d.hits().filter((h) => h.target === 'b');
    expect(onB.at(-1)!.outcome).toBeUndefined();
    expect(b.state.health).toBeLessThan(100);
    sim.dispose();
  });
});
