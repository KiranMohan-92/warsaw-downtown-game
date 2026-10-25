import { beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  createPlayerState,
  emptyInput,
  eyePosition,
  initPhysics,
  pickSafeSpawn,
  spawnSafety,
  PLAYER,
  sightVisibility,
  MATCH_NET,
  PhysicsWorld,
  sanitizeInput,
  SIM,
  SIM_DT,
  SMOKE,
  bendShot,
  humanoidHitboxes,
  ISKRA,
  smokeAt,
  smokeLifetime,
  smokeVisibility,
  stepPlayer,
  type SmokeCloud,
  type PlayerInput,
} from '@wd/shared';
import { MatchSim } from './MatchSim.ts';
import { pickSpawn } from './spawn.ts';
import { FixedTicker } from './ticker.ts';

beforeAll(async () => {
  await initPhysics();
});

const run = (seq: number, extra: Partial<PlayerInput> = {}): PlayerInput => ({
  ...emptyInput(seq),
  moveZ: 1,
  ...extra,
});

/** Feed `n` inputs (starting at `from`) at a steady 60 Hz and step once per input. */
function drive(sim: MatchSim, id: string, from: number, n: number, t0 = 0): number {
  for (let i = 0; i < n; i++) {
    sim.receiveInputs(id, [run(from + i)], t0 + (i * 1000) / 60);
    sim.step();
  }
  return t0 + (n * 1000) / 60;
}

describe('pickSpawn', () => {
  const spawns = [
    { pos: { x: 0, y: 0, z: 0 }, yaw: 0 },
    { pos: { x: 10, y: 0, z: 0 }, yaw: 0 },
    { pos: { x: 50, y: 0, z: 0 }, yaw: 0 },
  ];
  it('uses the first spawn in an empty match, else the one farthest from everyone', () => {
    expect(pickSpawn(spawns, [])).toBe(spawns[0]);
    expect(pickSpawn(spawns, [{ x: 1, y: 0, z: 0 }])).toBe(spawns[2]);
    expect(
      pickSpawn(spawns, [
        { x: 49, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
      ]),
    ).toBe(spawns[1]);
  });
});

describe('safest respawn (distance + line of sight, real map geometry)', () => {
  it.each([
    ['range', 'full'],
    ['defilad', 'market'],
  ] as const)('%s/%s: a full room joins and respawns at least 3 m apart', (map, size) => {
    for (const spawnSeed of [0, 1, 2]) {
      const sim = new MatchSim({ map, size, mode: 'standard', spawnSeed });
      try {
        const players = Array.from({ length: MATCH_NET.maxPlayers }, (_, i) =>
          sim.addPlayer(`p${i}`, `Player ${i}`, 0, false, { ready: i % 2 === 0 }),
        );
        const assertSeparated = (): void => {
          for (const [i, a] of players.entries()) {
            expect(sim.physics.overlapsStatic(a.state.move.pos, PLAYER.standHeight)).toBe(false);
            for (const b of players.slice(i + 1)) {
              const pa = a.state.move.pos;
              const pb = b.state.move.pos;
              expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeGreaterThanOrEqual(3);
            }
          }
        };
        assertSeparated();
        // Simultaneous respawns, then another wave within the same second. Earlier choices
        // must count immediately, including loading players and the new lives in this tick.
        for (const delay of [SIM.tickHz * 2, SIM.tickHz / 2]) {
          sim.runTicks(delay);
          for (const p of players) {
            p.state.health = 0;
            p.respawnTick = sim.tick + 1;
          }
          sim.step();
          assertSeparated();
        }
      } finally {
        sim.dispose();
      }
    }
  });

  it('keeps recently assigned spawns clear after their occupants move away', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 2 });
    try {
      const recent: { x: number; z: number }[] = [];
      for (let i = 0; i < MATCH_NET.maxPlayers; i++) {
        const p = sim.addPlayer(`p${i}`, `Player ${i}`, 0);
        const pos = { ...p.state.move.pos };
        for (const previous of recent) {
          expect(Math.hypot(pos.x - previous.x, pos.z - previous.z)).toBeGreaterThanOrEqual(3);
        }
        recent.push(pos);
        // The reservation, not their current location, must keep this spawn unavailable.
        p.body.setPosition({ x: 0, y: 0, z: -45 });
        p.state.move.pos = { x: 0, y: 0, z: -45 };
        sim.runTicks(5);
      }
    } finally {
      sim.dispose();
    }
  });

  it('releases departed players reservations so same-tick join/leave bursts cannot fill the map', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 1 });
    try {
      const anchor = sim.addPlayer('anchor', 'Anchor', 0);
      for (let i = 0; i < 40; i++) {
        const p = sim.addPlayer(`p${i}`, `Player ${i}`, 0);
        const a = anchor.state.move.pos;
        const b = p.state.move.pos;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(3);
        sim.removePlayer(p.id);
      }
      expect(sim.tick).toBe(0);
      expect(sim.players.size).toBe(1);
    } finally {
      sim.dispose();
    }
  });

  it.each([
    ['range', 'full'],
    ['defilad', 'market'],
  ] as const)('%s/%s: a respawn goes where no living enemy can see it', (map, size) => {
    const sim = new MatchSim({ map, size, mode: 'standard', spawnProtection: 0 });
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    // Let the join reservations expire before isolating sight/distance scoring below.
    sim.runTicks(SIM.tickHz);
    // Stand A on every authored spawn in turn. An expanded pool may improve on its best
    // point, but must preserve the shared sight/distance safety ordering.
    for (const at of sim.spawns.slice(0, 6)) {
      a.body.setPosition(at.pos);
      a.state.move.pos = { ...at.pos };
      const enemy = eyePosition(a.state);
      const expected = pickSafeSpawn(sim.spawns, [enemy], sim.physics);
      b.state.health = 0;
      b.respawnTick = sim.tick + 1;
      sim.step();
      expect(
        spawnSafety({ pos: b.state.move.pos, yaw: b.state.view.yaw }, [enemy], sim.physics),
      ).toBeGreaterThanOrEqual(spawnSafety(expected, [enemy], sim.physics));
      const eye = { ...b.state.move.pos, y: b.state.move.pos.y + PLAYER.standEyeHeight };
      const hidden = sim.spawns.some(
        (s) =>
          sightVisibility(
            enemy,
            { ...s.pos, y: s.pos.y + PLAYER.standEyeHeight },
            sim.physics,
            [],
          ) === 0,
      );
      // Out of sight whenever the map has any spawn out of A's sight.
      if (hidden) expect(sightVisibility(enemy, eye, sim.physics, [])).toBe(0);
    }
    sim.dispose();
  });
});

describe('MatchSim', () => {
  it('spawns joiners apart, moves players only by their inputs, and acknowledges them', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    expect(a.slot).toBe(0);
    expect(b.slot).toBe(1);
    const pa = { ...a.state.move.pos };
    const pb = { ...b.state.move.pos };
    expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeGreaterThan(20); // farthest spawn

    drive(sim, 'a', 0, 60);
    expect(a.ack).toBe(59);
    const moved = Math.hypot(a.state.move.pos.x - pa.x, a.state.move.pos.z - pa.z);
    expect(moved).toBeGreaterThan(3); // ~1 s of running
    // B sent nothing: B stays put (it idles through physics only).
    expect(b.ack).toBe(-1);
    expect(Math.hypot(b.state.move.pos.x - pb.x, b.state.move.pos.z - pb.z)).toBeLessThan(0.01);

    const snap = sim.snapshot();
    expect(snap.t).toBe(60);
    expect(snap.players.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(snap.players.find((p) => p.id === 'a')!.ack).toBe(59);
    expect(sim.roster().players).toEqual([
      { id: 'a', name: 'A', slot: 0, connected: true },
      { id: 'b', name: 'B', slot: 1, connected: true },
    ]);
    sim.dispose();
  });

  it.each([
    ['range', 'full'],
    ['defilad', 'market'],
  ] as const)(
    '%s/%s: the server equals a client predicting with the same code (exact)',
    (map, size) => {
      const sim = new MatchSim({ map, size, mode: 'standard' });
      const p = sim.addPlayer('a', 'A', 0);
      // The client: its own physics world for the same map and the same inputs.
      const physics = new PhysicsWorld(sim.map);
      const local = createPlayerState(p.state.move.pos, p.seed, 'standard');
      local.view = { ...p.state.view };
      const body = physics.createCharacter(p.state.move.pos);
      const inputs: PlayerInput[] = Array.from({ length: 180 }, (_, i) => ({
        seq: i,
        moveX: Math.sin(i / 20),
        moveZ: 1,
        yaw: 7 + i * 0.013, // beyond 2π: the server wraps it (sanitizeInput)
        pitch: 0.1,
        buttons: (i % 50 === 10 ? Button.Jump : 0) | (i > 120 ? Button.Crouch : 0),
      }));
      for (const [i, input] of inputs.entries()) {
        sim.receiveInputs('a', [input], (i * 1000) / 60);
        sim.step();
        stepPlayer(local, sanitizeInput(input), SIM_DT, body);
      }
      expect(p.ack).toBe(179);
      expect(p.state.move.pos).toEqual(local.move.pos);
      expect(p.state.move.vel).toEqual(local.move.vel);
      expect(p.state.move.crouched).toBe(true);
      physics.free();
      sim.dispose();
    },
  );

  it('drops stale and duplicate inputs, and rate-limits floods', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    expect(sim.receiveInputs('a', [run(5), run(5), run(3), run(6)], 0)).toBe(2);
    expect(p.queue.map((i) => i.seq)).toEqual([5, 6]);
    sim.step();
    sim.step(); // one step of movement time per tick
    expect(p.ack).toBe(6);

    // A flood: 200 inputs in one instant → only the burst gets through.
    const flood = Array.from({ length: 200 }, (_, i) => run(100 + i));
    const accepted = sim.receiveInputs('a', flood, 1000);
    expect(accepted).toBeLessThanOrEqual(MATCH_NET.inputBurst);
    expect(p.dropped).toBeGreaterThanOrEqual(200 - MATCH_NET.inputBurst);
    // Queued inputs drain at the speed of time: one step per tick, never a burst-teleport.
    for (let i = 0; i < 5; i++) sim.step();
    expect(p.queue.length).toBe(accepted - 5);
    sim.dispose();
  });

  it('a speed hack (inputs at 2× rate) moves no more steps than time allows', () => {
    // Compare input pacing on the same spawn layout (ordinary matches randomize it).
    const honest = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 0 });
    const h = honest.addPlayer('h', 'H', 0);
    const start = { ...h.state.move.pos };
    drive(honest, 'h', 0, 180);
    const honestDist = Math.abs(h.state.move.pos.z - start.z);

    const cheat = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 0 });
    const c = cheat.addPlayer('c', 'C', 0);
    let seq = 0;
    for (let tick = 0; tick < 180; tick++) {
      const t = (tick * 1000) / 60;
      cheat.receiveInputs('c', [run(seq++), run(seq++)], t);
      cheat.step();
    }
    // Every step is paid with elapsed time: 180 ticks → at most 180 inputs applied.
    expect(c.applied).toBeLessThanOrEqual(180);
    const cheatDist = Math.abs(c.state.move.pos.z - start.z);
    expect(cheatDist).toBeLessThanOrEqual(honestDist + 1e-9);
    // Saving time up (sending nothing) then bursting catches up, but never overtakes the clock.
    const saver = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 0 });
    const sp = saver.addPlayer('s', 'S', 0);
    for (let tick = 0; tick < 6; tick++) saver.step();
    saver.receiveInputs(
      's',
      Array.from({ length: 30 }, (_, i) => run(i)),
      100,
    );
    for (let tick = 0; tick < 4; tick++) saver.step();
    expect(sp.ack + 1).toBeLessThanOrEqual(10); // 10 ticks of time, 10 steps at most
    // A slow server tick (a 50 ms timer hitch) earns its real time: catch-up, not a loss.
    saver.step(50);
    expect(sp.ack + 1).toBeLessThanOrEqual(13);
    expect(sp.ack + 1).toBeGreaterThanOrEqual(12);
    saver.dispose();
    honest.dispose();
    cheat.dispose();
  });

  it('a stalled player still falls (idle steps) but nothing is acknowledged', () => {
    // Use the open street: lifting an indoor spawn can put the body on an upper floor.
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 0 });
    const p = sim.addPlayer('a', 'A', 0);
    const ground = p.state.move.pos.y;
    const air = { ...p.state.move.pos, y: ground + 4 };
    p.body.setPosition(air);
    p.state.move.pos = { ...air };
    p.state.move.grounded = false;
    for (let i = 0; i < MATCH_NET.stallTicks - 1; i++) sim.step();
    expect(p.state.move.pos.y).toBeCloseTo(ground + 4, 6); // within the grace period: frozen
    for (let i = 0; i < 90; i++) sim.step();
    expect(p.state.move.pos.y).toBeLessThan(ground + 0.05); // landed
    expect(p.ack).toBe(-1);
    sim.dispose();
  });

  it('sparse inputs cannot hover: every tick without input still costs movement time', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed: 0 });
    const p = sim.addPlayer('a', 'A', 0);
    const ground = p.state.move.pos.y;
    const air = { ...p.state.move.pos, y: ground + 4 };
    p.body.setPosition(air);
    p.state.move.pos = { ...air };
    p.state.move.grounded = false;
    // One standing input just before the grace would run out, over and over.
    let seq = 0;
    for (let tick = 0; tick < 240; tick++) {
      if (tick % (MATCH_NET.stallTicks - 1) === 0) {
        sim.receiveInputs('a', [{ ...emptyInput(seq++) }], (tick * 1000) / 60);
      }
      sim.step();
    }
    expect(p.state.move.pos.y).toBeLessThan(ground + 0.05); // fell anyway
  });

  it('idle steps move the body only: weapons and kit stay as the paused client has them', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    // Start a reload (fire a round first so there is something to reload), then go quiet.
    let seq = 0;
    for (let i = 0; i < 3; i++) {
      sim.receiveInputs('a', [{ ...emptyInput(seq++), buttons: Button.Fire }], i * 17);
      sim.step();
    }
    sim.receiveInputs('a', [{ ...emptyInput(seq), buttons: Button.Reload }], 60);
    sim.step();
    const gun = { ...p.state.guns.rifle };
    expect(gun.reloadTimer).toBeGreaterThan(0);
    for (let i = 0; i < 600; i++) sim.step(); // 10 s idle
    expect(p.state.guns.rifle).toEqual(gun); // frozen, like the client that stopped stepping
  });

  it('tells the room about a respawn with the last input of the old life', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    const told: [number, number][] = [];
    sim.onRespawn = (q, msg) => told.push([q.life, msg.seq]);
    sim.receiveInputs('a', [run(0), run(1)], 0);
    sim.step();
    sim.step();
    const deep = { x: 0, y: -30, z: 0 };
    p.body.setPosition(deep);
    p.state.move.pos = { ...deep };
    sim.step();
    expect(told).toEqual([[1, 1]]);
    expect(p.lastRespawn).toMatchObject({ life: 1, seq: 1 }); // kept for a reconnect
    sim.dispose();
  });

  it('respawns a player who falls out of the world (life counter bumps)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    const deep = { x: 0, y: -30, z: 0 };
    p.body.setPosition(deep);
    p.state.move.pos = { ...deep };
    sim.step();
    expect(p.life).toBe(1);
    expect(p.state.move.pos.y).toBeGreaterThan(-1);
    expect(sim.snapshot().players[0]!.life).toBe(1);
    sim.dispose();
  });

  it('a network stall leaves no standing input lag: the queue drains once inputs resume', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    const TICK = 1000 / 60;
    // The client makes one input per 60 Hz step and sends it at once; the network holds
    // everything sent in [1000, 1500) ms (a 500 ms Wi-Fi hiccup) and then delivers it in one go.
    const held: PlayerInput[] = [];
    const depth: number[] = [];
    const resumeTick = Math.ceil(1500 / TICK);
    for (let tick = 0; tick < resumeTick + 180; tick++) {
      const t = tick * TICK;
      held.push(run(tick));
      if (t < 1000 || t >= 1500) {
        // Batches as the client sends them (at most `maxInputBatch` per message).
        while (held.length) sim.receiveInputs('a', held.splice(0, MATCH_NET.maxInputBatch), t);
      }
      sim.step();
      depth.push(p.queue.length);
    }
    // During the stall the server idled the player (gravity only), then skipped the late inputs
    // it had already spent that time on: within a second the queue is back to jitter size...
    const settled = depth.slice(resumeTick + 60);
    expect(Math.max(...settled)).toBeLessThanOrEqual(2);
    expect(p.skipped).toBeGreaterThan(0);
    // ...and the ack keeps up with the newest input (no permanent ~280 ms of lag).
    expect(p.ack).toBeGreaterThanOrEqual(resumeTick + 180 - 1 - 2);

    // Repeated hiccups don't accumulate either.
    let seq = resumeTick + 180;
    for (let hiccup = 0; hiccup < 5; hiccup++) {
      for (let i = 0; i < 90; i++, seq++) {
        held.push(run(seq));
        if (i < 30 || i >= 60) {
          while (held.length) {
            sim.receiveInputs('a', held.splice(0, MATCH_NET.maxInputBatch), seq * TICK);
          }
        }
        sim.step();
      }
    }
    expect(p.queue.length).toBeLessThanOrEqual(2);
    expect(p.ack).toBeGreaterThanOrEqual(seq - 1 - 2);
    sim.dispose();
  });

  it('skipped late inputs keep button edges: a Jump held through them is not pressed again', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    for (let i = 0; i < 60; i++) sim.step(); // settle on the ground
    for (let i = 0; i < 40; i++) sim.step(); // then a stall: idle steps, debt
    expect(p.idleDebt).toBeGreaterThan(20);
    // The backlog: Jump pressed in the first (stale) input and held; all but the newest skipped.
    const held = Array.from({ length: 13 }, (_, i) => ({ ...emptyInput(i), buttons: Button.Jump }));
    sim.receiveInputs('a', held, 2000);
    sim.step();
    expect(p.skipped).toBeGreaterThan(0);
    expect(p.state.move.vel.y).toBeLessThanOrEqual(0); // no late jump from the held button
    expect(p.state.move.grounded).toBe(true);
    sim.dispose();
  });

  it('jitter and a resume after a pause never skip inputs (they fit the budget)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    // A long pause (menu open): idle steps only, nothing queued.
    for (let i = 0; i < 600; i++) sim.step();
    expect(p.idleDebt).toBeGreaterThan(0);
    // Resume at a 30 fps client: two inputs per frame, every other tick.
    let seq = 0;
    for (let tick = 0; tick < 120; tick++) {
      if (tick % 2 === 0) sim.receiveInputs('a', [run(seq++), run(seq++)], 10_000 + tick * 17);
      sim.step();
    }
    // A 150 ms hitch on the client (under the stall budget): a burst of 9, all applied.
    sim.receiveInputs(
      'a',
      Array.from({ length: 9 }, () => run(seq++)),
      12_300,
    );
    for (let i = 0; i < 4; i++) sim.step();
    expect(p.skipped).toBe(0);
    expect(p.applied).toBe(seq);
    expect(p.ack).toBe(seq - 1);
    sim.dispose();
  });

  it('a full queue drops its oldest input, never the newest', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0);
    // Spread over time so the rate limiter lets every one through; no ticks run meanwhile.
    for (let i = 0; i < MATCH_NET.maxQueuedInputs + 5; i++) {
      sim.receiveInputs('a', [run(i)], i * 20);
    }
    expect(p.queue.length).toBe(MATCH_NET.maxQueuedInputs);
    expect(p.queue[0]!.seq).toBe(5);
    expect(p.queue.at(-1)!.seq).toBe(MATCH_NET.maxQueuedInputs + 4);
    expect(p.dropped).toBe(5);
    sim.dispose();
  });

  it('server time follows the wall clock however coarse the timer (31 ms Windows ticks)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    sim.addPlayer('a', 'A', 0);
    const ticker = new FixedTicker(
      1000 / SIM.tickHz,
      MATCH_NET.maxCatchUpTicks,
      MATCH_NET.maxCatchUpMs,
      0,
    );
    const snaps: { wall: number; t: number }[] = [];
    let wall = 0;
    for (let i = 0; i < 200; i++) {
      // 15.6 ms timer granularity: a 16.67 ms interval fires every ~31 ms, now and then 47.
      wall += i % 10 === 9 ? 47 : 31.2;
      if (sim.runTicks(ticker.advance(wall))) snaps.push({ wall, t: sim.snapshot().t });
    }
    // Every snapshot's time (t × 1/60 s) is within one tick of the wall clock...
    for (const s of snaps) {
      expect(Math.abs((s.t * 1000) / SIM.tickHz - s.wall)).toBeLessThanOrEqual(1000 / SIM.tickHz);
    }
    // ...and they still come at ~30 Hz of real time (one per callback at most).
    const period = (2 * 1000) / SIM.tickHz;
    expect(snaps.length).toBeGreaterThan((0.9 * wall) / period);
    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i]!.wall - snaps[i - 1]!.wall).toBeLessThanOrEqual(2 * 47);
    }
    // Counting callbacks instead would have put t at ~half the wall time.
    expect(sim.tick).toBe(Math.floor(wall / (1000 / SIM.tickHz) + 1e-6));
    sim.dispose();
  });

  it('holds at most six players and frees seats (and colour slots) on leave', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'knife' });
    for (let i = 0; i < MATCH_NET.maxPlayers; i++) sim.addPlayer(`p${i}`, `P${i}`, 0);
    expect(sim.full).toBe(true);
    expect(() => sim.addPlayer('extra', 'X', 0)).toThrow(/full/);
    sim.removePlayer('p2');
    expect(sim.full).toBe(false);
    expect(sim.addPlayer('late', 'L', 0).slot).toBe(2);
    expect(sim.players.get('late')!.state.arsenal.slot).toBe('knife'); // host's mode
    sim.dispose();
  });

  it('judges smart-round smoke at the view time, the same clouds the client derives', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    sim.addPlayer('a', 'A', 0);
    for (let i = 0; i < 30; i++) sim.step();
    // A cloud pops this tick (the grenade step runs before the tactics step).
    sim.tactics.smoke.push({ id: 7, pos: { x: 0, y: 0, z: -10 }, age: 0 });
    sim.step();
    const popped = sim.nowMs;
    // A shot drawn 100 ms earlier (input in flight while it popped): no cloud yet.
    expect(sim.smokeAt(popped - 100)).toEqual([]);
    expect(sim.smokeAt(popped - 1000 * SIM_DT)).toEqual([]); // the previous tick's snapshot
    expect(sim.smokeAt(popped).map((c) => c.id)).toEqual([7]);
    for (let i = 0; i < 12; i++) sim.step();
    // 200 ms later a shot drawn 100 ms back sees it, ~0.1 s old.
    const seen = sim.smokeAt(sim.nowMs - 100);
    expect(seen.map((c) => c.id)).toEqual([7]);
    expect(seen[0]!.age).toBeCloseTo(13 * SIM_DT - 0.1, 9);
    // The client derives the same from the snapshot it got (ages as of the snapshot's tick).
    const snap = sim.snapshot('a');
    expect(
      smokeAt(snap.tactical!.smoke, snap.t * (1000 / SIM.tickHz), sim.nowMs - 100)[0]!.age,
    ).toBeCloseTo(seen[0]!.age, 12);
    sim.dispose();
  });

  it('clouds that run out within the rewind window: server and client judge them alike', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    sim.addPlayer('a', 'A', 0);
    for (let i = 0; i < 10; i++) sim.step();
    const life = smokeLifetime();
    // Two overlapping clouds on the sight line, both about to run out, and one mid-life aside.
    const eye = { x: 0, y: 50, z: 0 };
    const at = (z: number) => ({ x: 0.3, y: 50 - SMOKE.radius * 0.4, z });
    sim.tactics.smoke.push(
      { id: 1, pos: at(-10), age: life - 0.05 },
      { id: 2, pos: at(-11), age: life - 0.15 },
      { id: 3, pos: { x: 40, y: 0, z: 0 }, age: 5 },
    );
    // The client: the smoke of its newest tactical snapshot (30 Hz), as OnlineSession keeps it.
    let client: SmokeCloud[] = [];
    let clientMs = 0;
    for (let i = 0; i < 12; i++) {
      sim.step();
      if (i % 2 === 1) {
        const snap = sim.snapshot('a');
        const ms = snap.t * (1000 / SIM.tickHz);
        client = snap.tactical!.smoke;
        clientMs = ms;
      }
    }
    expect(sim.tactics.smoke.map((c) => c.id)).toEqual([3]); // both ran out on the server
    const target = [{ id: 't', shapes: humanoidHitboxes({ x: 0.6, y: 48.38, z: -20 }, 1.62) }];
    const aim = { x: 0, y: 0, z: -1 };
    const judged = new Set<string>();
    for (let back = 0; back <= MATCH_NET.maxRewindMs; back += 20) {
      const vt = sim.nowMs - back;
      const server = sim.smokeAt(vt);
      const mine = smokeAt(client, clientMs, vt);
      const ids = (l: readonly SmokeCloud[]) => l.map((c) => c.id).sort();
      expect(ids(mine), `${back} ms back`).toEqual(ids(server));
      for (const c of server) expect(mine.find((m) => m.id === c.id)!.age).toBeCloseTo(c.age, 9);
      judged.add(ids(server).join());
      const vis = (l: readonly SmokeCloud[]) =>
        smokeVisibility(l, eye, { x: 0.6, y: 49.5, z: -20 });
      expect(vis(mine)).toBeCloseTo(vis(server), 9);
      const bend = (l: readonly SmokeCloud[]) =>
        bendShot(eye, aim, 150, sim.physics, target, ISKRA.homingConeDeg, ISKRA.homingMaxBendDeg, {
          smoke: l,
        });
      expect(bend(mine)).toEqual(bend(server));
    }
    // The window covered view times with both, one and neither of the dying clouds.
    expect([...judged].sort()).toEqual(['1,2,3', '2,3', '3']);
    // Spent clouds ride in the snapshot but are never drawn or seen by bots.
    expect(client.map((c) => c.id).sort()).toEqual([1, 2, 3]);
    expect(smokeAt(client, clientMs, clientMs).map((c) => c.id)).toEqual([3]);
    sim.dispose();
  });

  it('no smoke through the results, even a cloud that ran out just before the end', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', timeLimit: 1 });
    sim.addPlayer('a', 'A', 0);
    for (let i = 0; i < 50; i++) sim.step();
    // Runs out ~3 ticks before the clock does: spent (retained) when the match ends.
    sim.tactics.smoke.push({ id: 1, pos: { x: 0, y: 0, z: -10 }, age: smokeLifetime() - 0.1 });
    let guard = 0;
    while (sim.phase === 'playing' && guard++ < 100) sim.step();
    expect(sim.phase).toBe('ended');
    for (let i = 0; i < 120; i++) {
      sim.step();
      if (i % 2) continue;
      const snap = sim.snapshot('a');
      const ms = snap.t * (1000 / SIM.tickHz);
      expect(snap.tactical!.smoke).toEqual([]);
      for (const back of [0, 100, MATCH_NET.maxInterpDelayMs]) {
        expect(smokeAt(snap.tactical!.smoke, ms, sim.nowMs - back)).toEqual([]);
        expect(sim.smokeAt(sim.nowMs - back)).toEqual([]);
      }
    }
    sim.dispose();
  });

  it('keeps a spent cloud as long as the client can draw it (interpolation ceiling)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    sim.addPlayer('a', 'A', 0);
    for (let i = 0; i < 10; i++) sim.step();
    sim.tactics.smoke.push({ id: 1, pos: { x: 0, y: 0, z: -10 }, age: smokeLifetime() - 0.02 });
    // It runs out after 2 ticks; 240 ms later a client drawing at the 250 ms ceiling still
    // sees its last moments, and so does the server rewinding there.
    for (let i = 0; i < 2 + 14; i++) sim.step();
    const snap = sim.snapshot('a');
    const ms = snap.t * (1000 / SIM.tickHz);
    const vt = ms - MATCH_NET.maxInterpDelayMs;
    expect(snap.tactical!.smoke.map((c) => c.id)).toEqual([1]);
    const drawn = smokeAt(snap.tactical!.smoke, ms, vt);
    expect(drawn.map((c) => c.id)).toEqual([1]);
    expect(sim.smokeAt(vt)[0]!.age).toBeCloseTo(drawn[0]!.age, 9);
    // Kept as far back as a shot can be rewound (the rewind ceiling is the longer of the two);
    // past that (plus a tick) it is dropped from the snapshots.
    const more = (MATCH_NET.maxRewindMs - MATCH_NET.maxInterpDelayMs) / (1000 / SIM.tickHz);
    for (let i = 0; i < Math.ceil(more) + 2; i++) sim.step();
    expect(sim.snapshot('a').tactical!.smoke).toEqual([]);
    sim.dispose();
  });

  it('a new match starts with no smoke on either side, even clouds about to run out', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', timeLimit: 1 });
    sim.addPlayer('a', 'A', 0);
    for (let i = 0; i < 50; i++) sim.step();
    const life = smokeLifetime();
    // Near expiry at the match end: one runs out in the last ticks, one freezes in the results.
    sim.tactics.smoke.push(
      { id: 1, pos: { x: 0, y: 0, z: -10 }, age: life - 0.1 },
      { id: 2, pos: { x: 0, y: 0, z: -12 }, age: life - 0.2 },
    );
    let guard = 0;
    while (sim.phase === 'playing' && guard++ < 1000) sim.step();
    expect(sim.phase).not.toBe('playing');
    while (sim.phase !== 'playing' && guard++ < 2000) sim.step();
    expect(sim.phase).toBe('playing');
    sim.step();
    sim.step();
    const snap = sim.snapshot('a');
    const clientMs = snap.t * (1000 / SIM.tickHz);
    expect(snap.tactical!.smoke).toEqual([]);
    for (let back = 0; back <= MATCH_NET.maxRewindMs; back += 50) {
      expect(sim.smokeAt(sim.nowMs - back)).toEqual([]);
      expect(smokeAt(snap.tactical!.smoke, clientMs, sim.nowMs - back)).toEqual([]);
    }
    sim.dispose();
  });
});

describe('loadout (server)', () => {
  it('a joiner spawns with their primary; a new pick waits for the next life', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const p = sim.addPlayer('a', 'A', 0, false, { primary: 'coil' });
    expect(p.state.arsenal.primary).toBe('coil');
    sim.setLoadout('a', 'iskra');
    expect(p.primary).toBe('iskra');
    expect(p.state.arsenal.primary).toBe('coil'); // this life keeps its gun
    sim.dispose();
  });
});
