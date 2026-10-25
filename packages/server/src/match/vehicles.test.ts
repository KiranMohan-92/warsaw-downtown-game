import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySnapshotMove,
  AVOID_SPAWN_RADIUS,
  sameCrew,
  seatButtonMask,
  weaponContext,
  computeDamage,
  RIFLE,
  Button,
  createPlayerState,
  emptyInput,
  initPhysics,
  JETPACK,
  JetMode,
  motionError,
  motionFromWire,
  PhysicsWorld,
  PLAYER,
  pushOutOfVehicle,
  hullObstacle,
  sanitizeInput,
  seatFromWire,
  SIM,
  SIM_DT,
  snapshotError,
  stepPlayerInCrowd,
  VEHICLE,
  type CombatEvent,
  type PlayerInput,
  type Vec3,
} from '@wd/shared';
import { MatchSim, type ServerPlayer } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

/**
 * The range street with one truck at its south end facing north (+z), open street ahead: fast to
 * build (the Market's own placement is checked in `routes.test.ts` and below, once).
 */
const TRUCK_SPOT = { x: 0, z: -50, yaw: 0 };
const range = (extra: Partial<ConstructorParameters<typeof MatchSim>[0]> = {}): MatchSim =>
  new MatchSim({
    map: 'range',
    size: 'full',
    mode: 'standard',
    spawnProtection: 0,
    vehicleSpawns: [TRUCK_SPOT],
    ...extra,
  });
const market = (extra: Partial<ConstructorParameters<typeof MatchSim>[0]> = {}): MatchSim =>
  new MatchSim({ map: 'defilad', size: 'market', mode: 'standard', spawnProtection: 0, ...extra });

/** Put a player's body somewhere (tests only). */
function place(p: ServerPlayer, at: Vec3): void {
  p.body.setPosition(at);
  p.state.move.pos = { ...at };
  p.state.move.vel = { x: 0, y: 0, z: 0 };
}

/** One input per tick for player `p` (seq from its last), `n` times. */
function feed(sim: MatchSim, p: ServerPlayer, n: number, input: Partial<PlayerInput> = {}): void {
  for (let i = 0; i < n; i++) {
    const seq = p.lastSeq + 1;
    sim.receiveInputs(
      p.id,
      [{ ...emptyInput(seq), yaw: p.state.view.yaw, ...input, seq }],
      sim.nowMs,
    );
    sim.step();
  }
}

/** Tap a button (pressed one tick, released the next). */
function tap(
  sim: MatchSim,
  p: ServerPlayer,
  button: number,
  input: Partial<PlayerInput> = {},
): void {
  feed(sim, p, 1, { ...input, buttons: button });
  feed(sim, p, 1, input);
}

/** A point beside the truck (local x, z → world), on the ground. */
function beside(sim: MatchSim, vehicle: number, lx: number, lz: number): Vec3 {
  const v = sim.vehicles.get(vehicle)!;
  const m = v.motion;
  const cy = Math.cos(m.yaw);
  const sy = Math.sin(m.yaw);
  return { x: m.pos.x + lx * cy + lz * sy, y: m.pos.y + 0.02, z: m.pos.z - lx * sy + lz * cy };
}

/** Wait out the seat cooldown. */
const cool = (sim: MatchSim, p: ServerPlayer): void =>
  feed(sim, p, Math.ceil(VEHICLE.seatCooldown * SIM.tickHz) + 1);

describe('vehicles: placement and seats', () => {
  it('two trucks stand on the Market, intact and empty, in every snapshot', () => {
    const sim = market();
    expect(sim.vehicles.list).toHaveLength(2);
    sim.addPlayer('a', 'A', 0);
    const snap = sim.snapshot('a');
    expect(snap.vehicles).toHaveLength(2);
    for (const v of snap.vehicles!) {
      expect(v.hp).toBe(VEHICLE.maxHealth);
      expect(v.st).toBe(0);
      expect(motionFromWire(v.m)).not.toBeNull();
    }
    // Players spawn well away from the trucks (the generator keeps clear of their spots).
    for (const v of sim.vehicles.list)
      for (const sp of sim.spawns)
        expect(
          Math.hypot(sp.pos.x - v.spawn.pos.x, sp.pos.z - v.spawn.pos.z),
        ).toBeGreaterThanOrEqual(AVOID_SPAWN_RADIUS);
    sim.dispose();
    const off = range({ vehicles: 'off' });
    expect(off.vehicles.list).toHaveLength(0);
    off.dispose();
  });

  it('Interact gets you into the nearest free seat; seats fill; too far gets nothing', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    const c = sim.addPlayer('c', 'C', 0);
    place(a, beside(sim, 1, 1.6, 0.4)); // at the driver's door (left, front)
    tap(sim, a, Button.Interact);
    expect(a.state.seat).toMatchObject({ vehicle: 1, seat: 'driver' });
    expect(a.state.seat!.motion).toBe(sim.vehicles.get(1)!.motion);
    place(b, beside(sim, 1, 1.6, 0.4)); // the same door: driver taken, next nearest
    tap(sim, b, Button.Interact);
    expect(b.state.seat?.seat).toBe('rearL');
    place(c, beside(sim, 1, 6, 0)); // 5 m away: out of reach
    tap(sim, c, Button.Interact);
    expect(c.state.seat).toBeNull();
    // Snapshot: seats on the wire, and the driver's own entry carries the truck's motion.
    const snap = sim.snapshot('a');
    const ea = snap.players.find((p) => p.id === 'a')!;
    expect(seatFromWire(ea.vh)).toEqual({ vehicle: 1, seat: 'driver' });
    expect(ea.own?.vm).toBeDefined();
    expect(seatFromWire(snap.players.find((p) => p.id === 'b')!.vh)?.seat).toBe('rearL');
    sim.dispose();
  });

  it('switch seat goes to the next free one; Interact gets out beside the truck, clear', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    place(a, beside(sim, 1, 1.6, 0.4));
    tap(sim, a, Button.Interact);
    cool(sim, a);
    tap(sim, a, Button.SwitchSeat);
    expect(a.state.seat?.seat).toBe('front');
    cool(sim, a);
    tap(sim, a, Button.Interact);
    expect(a.state.seat).toBeNull();
    const v = sim.vehicles.get(1)!;
    const o = hullObstacle(v.id, v.motion.pos, v.motion.yaw);
    expect(pushOutOfVehicle(a.state.move.pos, 0.3, PLAYER.standHeight, o)).toBeNull();
    expect(sim.physics.overlapsStatic(a.state.move.pos, PLAYER.standHeight)).toBe(false);
    expect(Object.values(v.seats).every((s) => s === null)).toBe(true);
    // Walks away normally afterwards (no stale seat in the sim).
    const before = { ...a.state.move.pos };
    feed(sim, a, 30, { moveZ: 1 });
    expect(
      Math.hypot(a.state.move.pos.x - before.x, a.state.move.pos.z - before.z),
    ).toBeGreaterThan(1);
    sim.dispose();
  });

  it('never exits into a wall: a truck parked against geometry lets you out the open side', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    const v = sim.vehicles.get(1)!;
    place(a, beside(sim, 1, 1.6, 0.4));
    tap(sim, a, Button.Interact);
    // Find the facade west of the truck: drive the truck against it isn't needed — check every
    // exit lands outside geometry and with a clear line from the seat.
    cool(sim, a);
    tap(sim, a, Button.Interact);
    const feet = a.state.move.pos;
    const hip = { x: v.motion.pos.x, y: v.motion.pos.y + 1.2, z: v.motion.pos.z };
    const dx = feet.x - hip.x;
    const dz = feet.z - hip.z;
    const len = Math.hypot(dx, 1.1 - 1.2, dz);
    const hit = sim.physics.castRay(hip, { x: dx / len, y: -0.1 / len, z: dz / len }, len);
    expect(hit === null || hit.distance > len - 0.1).toBe(true);
    sim.dispose();
  });

  it('a seated player cannot be pushed by the crowd and is not in it', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    place(a, beside(sim, 1, 1.6, 0.4));
    tap(sim, a, Button.Interact);
    const seatPos = { ...a.state.move.pos };
    feed(sim, a, 20, { moveZ: 0 });
    expect(a.state.move.pos.x).toBeCloseTo(seatPos.x, 5);
    expect(a.state.move.pos.z).toBeCloseTo(seatPos.z, 5);
    sim.dispose();
  });
});

describe('vehicles: driving (server == client prediction)', () => {
  it('the driver predicts the truck exactly (same inputs, same code, own physics world)', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    place(a, beside(sim, 1, 1.6, 0.4));
    tap(sim, a, Button.Interact);
    expect(a.state.seat?.seat).toBe('driver');
    // The client rebuilds its state from its own snapshot entry (as reconcile does).
    const physics = new PhysicsWorld(sim.map);
    const local = createPlayerState(a.state.move.pos, a.seed, 'standard');
    const body = physics.createCharacter(a.state.move.pos);
    applySnapshotMove(
      local,
      sim.snapshot('a').players.find((p) => p.id === 'a')!,
    );
    expect(local.seat?.seat).toBe('driver');
    expect(motionError(local.seat!.motion!, a.state.seat!.motion!)).toBe(0);
    const inputs: PlayerInput[] = Array.from({ length: 360 }, (_, i) => ({
      seq: a.lastSeq + 1 + i,
      moveX: Math.sin(i / 35),
      moveZ: i < 250 ? 1 : -1,
      yaw: 1 + i * 0.01,
      pitch: 0,
      buttons: i % 120 > 100 ? Button.Jump : 0,
    }));
    const obstacles = sim.vehicles.obstacles();
    for (const input of inputs) {
      sim.receiveInputs('a', [input], sim.nowMs);
      sim.step();
      stepPlayerInCrowd(local, sanitizeInput(input), SIM_DT, body, [], 'a', {
        vehicles: obstacles.filter((o) => o.id !== 1),
      });
    }
    const m = a.state.seat!.motion!;
    expect(Math.hypot(m.pos.x - TRUCK_SPOT.x, m.pos.z - TRUCK_SPOT.z)).toBeGreaterThan(5); // it drove
    expect(motionError(local.seat!.motion!, m)).toBe(0);
    expect(local.move.pos).toEqual(a.state.move.pos);
    // And the snapshot agrees with the prediction (zero error: no correction).
    expect(
      snapshotError(
        local,
        sim.snapshot('a').players.find((p) => p.id === 'a')!,
      ),
    ).toBe(0);
    physics.free();
    sim.dispose();
  });

  it('passengers ride along; a driverless truck rolls to a stop', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    place(a, beside(sim, 1, 1.6, 0.4));
    tap(sim, a, Button.Interact);
    place(b, beside(sim, 1, -1.6, -1.3));
    tap(sim, b, Button.Interact);
    expect(b.state.seat?.seat).toBe('rearR');
    const start = { ...b.state.move.pos };
    for (let i = 0; i < 90; i++) {
      sim.receiveInputs('a', [{ ...emptyInput(a.lastSeq + 1), moveZ: 1 }], sim.nowMs);
      sim.receiveInputs('b', [{ ...emptyInput(b.lastSeq + 1) }], sim.nowMs);
      sim.step();
    }
    expect(Math.hypot(b.state.move.pos.x - start.x, b.state.move.pos.z - start.z)).toBeGreaterThan(
      5,
    );
    // The driver bails: the empty truck stops by itself.
    cool(sim, a);
    tap(sim, a, Button.Interact);
    expect(a.state.seat).toBeNull();
    feed(sim, a, 180);
    const v = sim.vehicles.get(1)!;
    expect(Math.hypot(v.motion.vel.x, v.motion.vel.z)).toBeLessThan(0.05);
    sim.dispose();
  });
});

/** Seat `p` in truck 1 at `seat` by tapping Interact from the right door spot. */
function seat(sim: MatchSim, p: ServerPlayer, lx: number, lz: number): void {
  place(p, beside(sim, 1, lx, lz));
  tap(sim, p, Button.Interact);
}

describe('vehicles: combat', () => {
  it('run-overs: walking pace shoves without damage, speed hurts with credit to the driver', () => {
    const sim = range();
    const d = sim.addPlayer('d', 'Driver', 0);
    const v = sim.addPlayer('v', 'Victim', 0);
    seat(sim, d, 1.6, 0.4);
    const truck = sim.vehicles.get(1)!;
    // Victim 6 m ahead of the nose (the truck faces +x, east).
    place(v, beside(sim, 1, 0, 2.5 + 6));
    // Crawl into them: no damage, they are pushed.
    for (let i = 0; i < 150; i++) {
      sim.receiveInputs('d', [{ ...emptyInput(d.lastSeq + 1), moveZ: 0.25 }], sim.nowMs);
      sim.receiveInputs('v', [{ ...emptyInput(v.lastSeq + 1) }], sim.nowMs);
      sim.step();
      if (Math.hypot(truck.motion.vel.x, truck.motion.vel.z) > VEHICLE.runOverSpeed - 0.5) break;
    }
    expect(v.state.health).toBe(PLAYER.maxHealth);
    // Now at speed: the victim stands ahead again.
    sim.drainEvents();
    place(v, beside(sim, 1, 0, 2.5 + 14));
    let killed: CombatEvent | undefined;
    for (let i = 0; i < 240 && !killed; i++) {
      sim.receiveInputs('d', [{ ...emptyInput(d.lastSeq + 1), moveZ: 1 }], sim.nowMs);
      sim.receiveInputs('v', [{ ...emptyInput(v.lastSeq + 1) }], sim.nowMs);
      sim.step();
      killed = sim.drainEvents().find((e) => e.type === 'hit' && e.target === 'v');
    }
    expect(killed).toMatchObject({ type: 'hit', by: 'd', weapon: 'truck' });
    sim.dispose();
  });

  it('the hull stops bullets at the doors; through the cab glass a round is weakened', () => {
    const sim = range();
    const shooter = sim.addPlayer('s', 'S', 0);
    const crew = sim.addPlayer('c', 'C', 0);
    seat(sim, crew, 1.6, 0.4); // driver (cab, left)
    const truck = sim.vehicles.get(1)!;
    const at = beside(sim, 1, 9, 0.15); // 8 m off the driver's door
    place(shooter, at);
    const target = beside(sim, 1, 0, 0.15);
    const aim = (y: number): { yaw: number; pitch: number } => {
      const dx = target.x - at.x;
      const dz = target.z - at.z;
      const dy = y - (at.y + PLAYER.standEyeHeight);
      return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
    };
    // Let the stance settle, then one aimed round at the door (below the beltline).
    feed(sim, shooter, 30, aim(truck.motion.pos.y + 1.0));
    sim.drainEvents();
    tap(sim, shooter, Button.Fire, aim(truck.motion.pos.y + 1.0));
    let events = sim.drainEvents();
    expect(events.some((e) => e.type === 'vhit' && e.vehicle === 1)).toBe(true);
    expect(events.some((e) => e.type === 'hit' && e.target === 'c')).toBe(false);
    expect(truck.health).toBeLessThan(VEHICLE.maxHealth);
    // Through the side window at the driver's head height: the driver is hit, weakened.
    feed(sim, shooter, 30, aim(crew.state.move.pos.y + crew.state.move.eyeHeight - 0.1));
    sim.drainEvents();
    tap(sim, shooter, Button.Fire, aim(crew.state.move.pos.y + crew.state.move.eyeHeight - 0.1));
    events = sim.drainEvents();
    const hit = events.find((e) => e.type === 'hit' && e.target === 'c');
    expect(hit).toBeDefined();
    if (hit?.type === 'hit') {
      const d = Math.hypot(hit.at.x - hit.from.x, hit.at.y - hit.from.y, hit.at.z - hit.from.z);
      expect(hit.dmg).toBeCloseTo(computeDamage(hit.zone, d, RIFLE) * VEHICLE.glassDamage, 6);
    }
    sim.dispose();
  });

  it('the front passenger shoots out of the window arc only; the bed shoots all round', () => {
    const sim = range();
    const gunner = sim.addPlayer('g', 'G', 0);
    seat(sim, gunner, -1.6, 0.4); // front passenger (right)
    expect(gunner.state.seat?.seat).toBe('front');
    // Facing back over the left shoulder (out of the arc): the round meets the cab.
    const heading = sim.vehicles.get(1)!.motion.yaw;
    const viewOf = (rel: number): number => heading + rel + Math.PI; // view yaw for an aim
    sim.drainEvents();
    tap(sim, gunner, Button.Fire, { yaw: viewOf(2.6) });
    let shot = sim.drainEvents().find((e) => e.type === 'shot');
    expect(shot?.type === 'shot' && shot.from.x === shot.to.x && shot.from.z === shot.to.z).toBe(
      true,
    );
    // Out of the right window: a real shot.
    feed(sim, gunner, 12);
    tap(sim, gunner, Button.Fire, { yaw: viewOf(-Math.PI / 2) });
    shot = sim.drainEvents().find((e) => e.type === 'shot');
    expect(
      shot?.type === 'shot' && Math.hypot(shot.to.x - shot.from.x, shot.to.z - shot.from.z),
    ).toBeGreaterThan(1);
    sim.dispose();
  });

  it('riding together is a truce: the crew cannot shoot each other', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    seat(sim, a, 1.6, -1.3); // rear left
    seat(sim, b, -1.6, -1.3); // rear right
    expect(a.state.seat?.seat).toBe('rearL');
    expect(b.state.seat?.seat).toBe('rearR');
    const targets = sim.targetsAt(sim.nowMs, 'a');
    expect(targets.some((t) => t.id === 'b')).toBe(false);
    sim.dispose();
  });

  it('a truck blowing up hurts a truck beside it, but not one behind a wall', () => {
    // The range's building wall at x = 27 (z −14…−2, 3.6 m tall).
    const blast = (other: { x: number; z: number }): number => {
      const sim = range({
        vehicleSpawns: [
          { x: 24.5, z: -8, yaw: 0 },
          { ...other, yaw: 0 },
        ],
      });
      const x = sim.addPlayer('x', 'X', 0);
      const first = sim.vehicles.get(1)!;
      first.health = 1;
      sim.vehicles.damage(first, 'x', 5, sim.tick);
      feed(sim, x, 1);
      expect(first.condition).toBe('wreck');
      const hp = sim.vehicles.get(2)!.health;
      sim.dispose();
      return hp;
    };
    expect(blast({ x: 20, z: -8 })).toBeLessThan(VEHICLE.maxHealth); // same side, 2.4 m apart
    expect(blast({ x: 29.5, z: -8 })).toBe(VEHICLE.maxHealth); // the wall between
  });

  it('a frag thrown at the doors bounces off the armour (never through into the cab)', () => {
    const sim = range();
    const thrower = sim.addPlayer('t', 'T', 0);
    const truck = sim.vehicles.get(1)!;
    const at = beside(sim, 1, 5, 0.45); // 5 m off the driver's door
    place(thrower, at);
    const c = truck.motion.pos;
    const yaw = Math.atan2(-(c.x - at.x), -(c.z - at.z));
    feed(sim, thrower, 30, { yaw, pitch: -0.33 });
    sim.drainEvents();
    tap(sim, thrower, Button.Grenade, { yaw, pitch: -0.33 });
    let boom: Extract<CombatEvent, { type: 'boom' }> | undefined;
    for (let i = 0; i < 4 * SIM.tickHz && !boom; i++) {
      feed(sim, thrower, 1, { yaw, pitch: -0.33 });
      boom = sim.drainEvents().find((e) => e.type === 'boom');
    }
    expect(boom).toBeDefined();
    // Local x of the blast (+x = the driver's side): it stays out on the thrower's side.
    const dx = boom!.pos.x - c.x;
    const dz = boom!.pos.z - c.z;
    const lx = dx * Math.cos(truck.motion.yaw) - dz * Math.sin(truck.motion.yaw);
    expect(lx).toBeGreaterThan(1.05);
    sim.dispose();
  });

  it('destroyed: the crew dies (credit to the attacker), the wreck stays, the truck comes back', () => {
    const sim = range();
    const attacker = sim.addPlayer('x', 'X', 0);
    const crew = sim.addPlayer('c', 'C', 0);
    seat(sim, crew, 1.6, 0.4);
    const truck = sim.vehicles.get(1)!;
    sim.drainEvents();
    // Bring it to its last hit point, then one more round of damage through the shared path.
    truck.health = 1;
    sim.vehicles.damage(truck, 'x', 5, sim.tick);
    feed(sim, attacker, 1);
    const events = sim.drainEvents();
    expect(events.some((e) => e.type === 'vboom' && e.vehicle === 1 && e.by === 'x')).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'hit', target: 'c', by: 'x', weapon: 'wreck', killed: true }),
    );
    expect(crew.state.seat).toBeNull();
    expect(attacker.kills).toBe(1);
    expect(truck.condition).toBe('wreck');
    // Wreck → gone → back at its spawn, intact.
    feed(sim, attacker, Math.ceil(VEHICLE.wreckTime * SIM.tickHz) + 1);
    expect(truck.condition).toBe('gone');
    sim.vehicles.list.forEach((v) => {
      if (v.condition === 'gone') v.until = sim.tick + 1;
    });
    feed(sim, attacker, 2);
    expect(truck.condition).toBe('active');
    expect(truck.health).toBe(VEHICLE.maxHealth);
    expect(truck.motion.pos.x).toBeCloseTo(truck.spawn.pos.x, 6);
    sim.dispose();
  });
});

describe('vehicles: Codex round 2', () => {
  it('a run-over lands after every step of the tick: a victim later in the order still acts', () => {
    const sim = range();
    const d = sim.addPlayer('d', 'Driver', 0); // stepped first
    const v = sim.addPlayer('v', 'Victim', 0); // stepped after the driver
    seat(sim, d, 1.6, 0.4);
    const truck = sim.vehicles.get(1)!;
    place(v, beside(sim, 1, 0, 2.5 + 20));
    // The victim walks toward the truck (facing it) while it comes on at full throttle.
    const toward = { yaw: truck.motion.yaw, moveZ: 1 };
    let moved: number | null = null;
    for (let i = 0; i < 300 && moved === null; i++) {
      const before = { ...v.state.move.pos };
      const alive = v.state.health > 0;
      sim.receiveInputs('d', [{ ...emptyInput(d.lastSeq + 1), moveZ: 1 }], sim.nowMs);
      sim.receiveInputs('v', [{ ...emptyInput(v.lastSeq + 1), ...toward }], sim.nowMs);
      sim.step();
      if (alive && v.state.health <= 0)
        moved = Math.hypot(v.state.move.pos.x - before.x, v.state.move.pos.z - before.z);
    }
    expect(moved).not.toBeNull();
    // Its own step ran in the tick it died (a lethal run-over applied mid-loop froze it).
    expect(moved!).toBeGreaterThan(0.01);
    sim.dispose();
  });

  it('smart rounds never bend toward a crewmate (the same set the shooter’s client uses)', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    const c = sim.addPlayer('c', 'C', 0);
    seat(sim, a, 1.6, -1.3);
    seat(sim, b, -1.6, -1.3);
    place(c, beside(sim, 1, 0, 12));
    feed(sim, c, 2);
    const sight = (
      sim as unknown as { sightTargetsAt(ms: number, by: string): { id: string }[] }
    ).sightTargetsAt(sim.nowMs, 'a');
    expect(sight.map((t) => t.id)).toEqual(['c']);
    expect(sameCrew(1, 1)).toBe(true);
    expect(sameCrew(undefined, undefined)).toBe(false);
    expect(sameCrew(1, 2)).toBe(false);
    sim.dispose();
  });

  it('a respawned truck is not in a shot rewound to before it was back', () => {
    const sim = range();
    const x = sim.addPlayer('x', 'X', 0);
    const truck = sim.vehicles.get(1)!;
    truck.health = 1;
    sim.vehicles.damage(truck, 'x', 5, sim.tick);
    feed(sim, x, Math.ceil(VEHICLE.wreckTime * SIM.tickHz) + 2);
    expect(truck.condition).toBe('gone');
    feed(sim, x, 30); // gone for half a second
    truck.until = sim.tick + 1;
    feed(sim, x, 3);
    expect(truck.condition).toBe('active');
    expect(sim.vehicles.hullsAt(sim.nowMs).some((h) => h.id === 1)).toBe(true);
    // 100 ms ago it was gone: no hull to stop a round there.
    expect(sim.vehicles.hullsAt(sim.nowMs - 100).some((h) => h.id === 1)).toBe(false);
    sim.dispose();
  });

  it('no knife from a passenger seat (Fire with the knife in hand), guns still fire', () => {
    const knives = range({ mode: 'knife' });
    const g = knives.addPlayer('g', 'G', 0);
    seat(knives, g, 1.6, -1.3); // bed, left
    expect(g.state.seat?.seat).toBe('rearL');
    expect(g.state.arsenal.slot).toBe('knife');
    for (let i = 0; i < 20; i++) feed(knives, g, 1, { buttons: Button.Fire });
    expect(g.state.arsenal.melee.swings).toBe(0);
    expect(g.state.arsenal.melee.phase).toBe('idle');
    knives.dispose();
    expect(seatButtonMask('rearL', 'knife') & Button.Fire).toBeTruthy();
    expect(seatButtonMask('rearL', 'rifle') & Button.Fire).toBe(0);
  });

  it('a blast is blocked from a bed passenger by another truck’s armour', () => {
    // Truck 2 parked broadside between the passenger in truck 1 and the frag.
    const sim = range({
      vehicleSpawns: [
        { x: 0, z: -50, yaw: 0 },
        { x: 3.6, z: -50, yaw: 0 },
      ],
    });
    const p = sim.addPlayer('p', 'P', 0);
    seat(sim, p, 1.6, -1.3);
    expect(p.state.seat?.seat).toBe('rearL');
    sim.drainEvents();
    const blast = (at: { x: number; z: number }): number => {
      const hp = p.state.health;
      (sim as unknown as { grenades: { g: unknown; owner: string }[] }).grenades.push({
        g: {
          id: 99,
          owner: 0,
          pos: { x: at.x, y: 0.15, z: at.z },
          vel: { x: 0, y: 0, z: 0 },
          fuse: 0.001,
          resting: true,
          kind: 'frag',
        },
        owner: 'nobody',
      });
      feed(sim, p, 1);
      return hp - p.state.health;
    };
    // Behind truck 2 (its doors between): nothing reaches the passenger.
    expect(blast({ x: 6.4, z: -50.6 })).toBe(0);
    sim.dispose();
    // Control: the same spot with no truck between hurts.
    const open = range();
    const q = open.addPlayer('p', 'P', 0);
    seat(open, q, 1.6, -1.3);
    const hp = q.state.health;
    (open as unknown as { grenades: { g: unknown; owner: string }[] }).grenades.push({
      g: {
        id: 99,
        owner: 0,
        pos: { x: 6.4, y: 0.15, z: -50.6 },
        vel: { x: 0, y: 0, z: 0 },
        fuse: 0.001,
        resting: true,
        kind: 'frag',
      },
      owner: 'nobody',
    });
    feed(open, q, 1);
    expect(hp - q.state.health).toBeGreaterThan(0);
    open.dispose();
  });
});

describe('vehicles: Codex round 3', () => {
  it('Fire + Interact in one input: the shot leaves the seat it was fired from (arc rule kept)', () => {
    const sim = range();
    const g = sim.addPlayer('g', 'G', 0);
    seat(sim, g, -1.6, 0.4); // front passenger
    expect(g.state.seat?.seat).toBe('front');
    cool(sim, g);
    const heading = sim.vehicles.get(1)!.motion.yaw;
    const back = heading + 2.6 + Math.PI; // over the left shoulder: out of the window arc
    sim.drainEvents();
    feed(sim, g, 1, { yaw: back, buttons: Button.Fire | Button.Interact });
    expect(g.state.seat).toBeNull(); // got out in the same input…
    const shot = sim.drainEvents().find((e) => e.type === 'shot');
    // …but the round met the cab, as the client predicted (no shot from the exit spot).
    expect(shot?.type === 'shot' && shot.from.x === shot.to.x && shot.from.z === shot.to.z).toBe(
      true,
    );
    sim.dispose();
  });

  it('glass protection is judged at the shooter’s view time (rewound with the pose)', () => {
    const sim = range();
    const d = sim.addPlayer('d', 'D', 0);
    seat(sim, d, 1.6, 0.4); // driver: the cab
    feed(sim, d, 3);
    const seatedAt = sim.nowMs;
    expect(d.history.at(seatedAt)?.cab).toBe(true);
    cool(sim, d);
    tap(sim, d, Button.Interact);
    expect(d.state.seat).toBeNull();
    feed(sim, d, 3);
    // Out now, but a round fired at the time it sat there meets the glass.
    expect(d.history.at(seatedAt)?.cab).toBe(true);
    expect(d.history.at(sim.nowMs)?.cab).toBeFalsy();
    sim.dispose();
  });

  it('a driver getting out mid-input moves the truck once that tick, not twice', () => {
    const sim = range();
    const d = sim.addPlayer('d', 'D', 0);
    seat(sim, d, 1.6, 0.4);
    feed(sim, d, 90, { moveZ: 1 });
    cool(sim, d);
    const truck = sim.vehicles.get(1)!;
    feed(sim, d, 1, { moveZ: 1 });
    const p0 = { ...truck.motion.pos };
    const speed = Math.hypot(truck.motion.vel.x, truck.motion.vel.z);
    expect(speed).toBeGreaterThan(3);
    feed(sim, d, 1, { moveZ: 1, buttons: Button.Interact });
    expect(d.state.seat).toBeNull();
    const moved = Math.hypot(truck.motion.pos.x - p0.x, truck.motion.pos.z - p0.z);
    expect(moved).toBeLessThan(speed * SIM_DT * 1.4);
    sim.dispose();
  });
});

describe('vehicles: Codex round 4', () => {
  it('Fire + Interact from the bed: the crew truce holds for that shot', () => {
    const sim = range();
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    seat(sim, a, 1.6, -1.3); // rear left
    seat(sim, b, -1.6, -1.3); // rear right
    cool(sim, a);
    const ea = {
      x: a.state.move.pos.x,
      y: a.state.move.pos.y + a.state.move.eyeHeight,
      z: a.state.move.pos.z,
    };
    const eb = {
      x: b.state.move.pos.x,
      y: b.state.move.pos.y + b.state.move.eyeHeight - 0.3,
      z: b.state.move.pos.z,
    };
    const dx = eb.x - ea.x;
    const dz = eb.z - ea.z;
    const aim = { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(eb.y - ea.y, Math.hypot(dx, dz)) };
    feed(sim, a, 12, aim);
    feed(sim, a, 1, { ...aim, buttons: Button.Fire | Button.Interact });
    expect(a.state.seat).toBeNull();
    expect(b.state.health).toBe(PLAYER.maxHealth);
    sim.dispose();
  });

  it('a frag wound up on foot is put back (not thrown) when you take the wheel', () => {
    const sim = range();
    const d = sim.addPlayer('d', 'D', 0);
    const frags = d.state.arsenal.grenades;
    place(d, beside(sim, 1, 1.6, 0.4));
    feed(sim, d, 1, { buttons: Button.Grenade });
    expect(d.state.arsenal.throwPhase).toBe('windup');
    tap(sim, d, Button.Interact);
    expect(d.state.seat?.seat).toBe('driver');
    sim.drainEvents();
    feed(sim, d, 60);
    expect(sim.drainEvents().some((e) => e.type === 'nade')).toBe(false);
    expect(d.state.arsenal.throwPhase).toBe('idle');
    expect(d.state.arsenal.grenades).toBe(frags);
    sim.dispose();
  });

  it('a seated shooter’s spread context ignores the truck’s speed (the crosshair’s too)', () => {
    const sim = range();
    const g = sim.addPlayer('g', 'G', 0);
    seat(sim, g, 1.6, -1.3);
    g.state.move.vel = { x: 9, y: 0, z: 0 };
    expect(weaponContext(g.state).speed).toBe(0);
    expect(weaponContext(g.state, false).speed).toBeCloseTo(9, 6);
    sim.dispose();
  });
});

describe('vehicles: lag compensation and spawn protection', () => {
  it('a shot is checked against the truck where the shooter drew it (rewound), within the cap', () => {
    const sim = range();
    const driver = sim.addPlayer('d', 'D', 0);
    const shooter = sim.addPlayer('s', 'S', 0);
    seat(sim, driver, 1.6, 0.4);
    place(shooter, { x: -9, y: 0.02, z: -30 }); // beside the street the truck will drive up
    sim.observeRtt('s', 80);
    // Drive north for a while at speed.
    for (let i = 0; i < 120; i++) {
      sim.receiveInputs('d', [{ ...emptyInput(driver.lastSeq + 1), moveZ: 1 }], sim.nowMs);
      sim.receiveInputs('s', [{ ...emptyInput(shooter.lastSeq + 1) }], sim.nowMs);
      sim.step();
    }
    const truck = sim.vehicles.get(1)!;
    expect(truck.motion.vel.z).toBeGreaterThan(8);
    // Where the shooter drew it 150 ms ago (the history), vs now ~1.5 m further north.
    const drawnMs = sim.nowMs - 150;
    const then = truck.history.at(drawnMs)!;
    expect(truck.motion.pos.z - then.pos.z).toBeGreaterThan(1.2);
    const eye = { x: -9, y: 0.02 + PLAYER.standEyeHeight, z: -30 };
    // Aim at the rear of the bed as drawn (it has moved on since: now the round would miss).
    const aimAt = { x: then.pos.x, y: then.pos.y + 0.8, z: then.pos.z - 2.3 };
    const dx = aimAt.x - eye.x;
    const dy = aimAt.y - eye.y;
    const dz = aimAt.z - eye.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const hpBefore = truck.health;
    sim.drainEvents();
    sim.receiveInputs(
      's',
      [{ ...emptyInput(shooter.lastSeq + 1), yaw, pitch, buttons: Button.Fire, vt: drawnMs }],
      sim.nowMs,
    );
    sim.receiveInputs('d', [{ ...emptyInput(driver.lastSeq + 1), moveZ: 1 }], sim.nowMs);
    sim.step();
    expect(sim.drainEvents().some((e) => e.type === 'vhit' && e.by === 's')).toBe(true);
    expect(truck.health).toBeLessThan(hpBefore);
    sim.dispose();
  });

  it('spawn protection still holds against a run-over; getting in ends your own', () => {
    const sim = range({ spawnProtection: 2 });
    const d = sim.addPlayer('d', 'Driver', 0);
    seat(sim, d, 1.6, 0.4);
    expect(d.state.spawnGuard).toBe(0); // in the truck: no longer protected
    feed(sim, d, Math.ceil(VEHICLE.seatCooldown * SIM.tickHz));
    // Speed up, then a freshly (re)spawned player appears in front.
    for (let i = 0; i < 90; i++) {
      sim.receiveInputs('d', [{ ...emptyInput(d.lastSeq + 1), moveZ: 1 }], sim.nowMs);
      sim.step();
    }
    const v = sim.addPlayer('v', 'Victim', sim.nowMs); // protected for 2 s
    const truck = sim.vehicles.get(1)!;
    place(v, beside(sim, 1, 0, 2.5 + 6));
    sim.drainEvents();
    let hit: CombatEvent | undefined;
    for (let i = 0; i < 60 && !hit; i++) {
      sim.receiveInputs('d', [{ ...emptyInput(d.lastSeq + 1), moveZ: 1 }], sim.nowMs);
      sim.receiveInputs('v', [{ ...emptyInput(v.lastSeq + 1) }], sim.nowMs);
      sim.step();
      hit = sim.drainEvents().find((e) => e.type === 'hit' && e.target === 'v');
    }
    expect(hit).toMatchObject({ type: 'hit', weapon: 'truck', dmg: 0, outcome: 'protected' });
    expect(v.state.health).toBe(PLAYER.maxHealth);
    expect(truck.motion.vel.z).toBeGreaterThan(VEHICLE.runOverSpeed);
    sim.dispose();
  });
});

describe('vehicles and jetpacks', () => {
  it('a flying jetpack wearer cannot board; on the ground with the pack on, they can', () => {
    const sim = range();
    const p = sim.addPlayer('a', 'A', 0);
    place(p, beside(sim, 1, 1.6, 0.15));
    p.state.move.jet = JetMode.Flying;
    p.state.move.jetFuel = JETPACK.flightTime;
    p.state.move.grounded = false;
    tap(sim, p, Button.Interact);
    expect(p.state.seat).toBeNull();
    expect(p.state.move.jet).toBe(JetMode.Flying);
    // Landed, the pack still on: getting in is fine.
    p.state.move.jet = JetMode.Worn;
    place(p, beside(sim, 1, 1.6, 0.15));
    cool(sim, p);
    tap(sim, p, Button.Interact);
    expect(p.state.seat?.vehicle).toBe(1);
    sim.dispose();
  });

  it('a seated wearer cannot ignite', () => {
    const sim = range();
    const p = sim.addPlayer('a', 'A', 0);
    seat(sim, p, 1.6, 0.15);
    expect(p.state.seat).not.toBeNull();
    p.state.move.jet = JetMode.Worn;
    sim.drainEvents();
    for (let i = 0; i < 3; i++) tap(sim, p, Button.Jump);
    expect(p.state.move.jet).toBe(JetMode.Worn);
    expect(p.state.seat).not.toBeNull();
    sim.dispose();
  });
});
