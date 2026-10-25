import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySnapshotMove,
  Button,
  createJetpacks,
  createPlayerState,
  emptyInput,
  getMap,
  initPhysics,
  JETPACK,
  JetMode,
  PhysicsWorld,
  resolveMap,
  SIM_DT,
  snapshotError,
  spawnsFor,
  stepPlayerInCrowd,
  type PlayerInput,
} from '@wd/shared';
import { MatchSim } from './MatchSim.ts';
import { MatchTactics } from './tactics.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('jetpacks on the server', () => {
  it.each([0, 1, 2])(
    '3 per match: pickup grants a pack, unlit drops on death, lit is spent, a new match resets (spawn seed %i)',
    (spawnSeed) => {
      const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnSeed });
      try {
        const a = sim.addPlayer('a', 'A', 0);
        const b = sim.addPlayer('b', 'B', 0);
        // Fixed open-street spots: offsets from a random spawn can cross the map bounds.
        const at = { x: 0, y: 0, z: 45 };
        a.state.move.pos = { ...at };
        const spots = [
          { ...at, y: at.y + 1 },
          { x: 0, y: 1, z: 0 },
          { x: 0, y: 1, z: -45 },
        ];
        const t = new MatchTactics({ ...sim.map, jetpacks: spots }, 'uplinks', sim.physics);
        expect(t.jetpacks).toHaveLength(3);
        const homes = t.jetpacks.map((j) => ({ ...j.pos }));
        expect(t.jetpacks[0]!.pos.y).toBeCloseTo(at.y, 1); // cast onto the floor
        b.state.move.pos = { x: at.x + 15, y: at.y, z: at.z };
        t.step(sim.players.values());
        expect(a.state.move.jet).toBe(JetMode.Worn);
        expect(a.state.move.jetFuel).toBe(JETPACK.flightTime);
        expect(t.snapshot('b').jetpacks?.[0]?.carrier).toBe('a');
        // Killed before lighting it: it drops where A fell.
        a.state.move.pos = { x: at.x + 5, y: at.y, z: at.z + 1 };
        t.step(sim.players.values());
        a.state.health = 0;
        t.step(sim.players.values());
        const j = t.jetpacks[0]!;
        expect(j.carrier).toBeNull();
        expect(j.spent).toBe(false);
        expect(Math.hypot(j.pos.x - (at.x + 5), j.pos.z - (at.z + 1))).toBeLessThan(1e-6);
        // B takes it, lights it, lands: spent; 2 left this match.
        b.state.move.pos = { ...j.pos };
        t.step(sim.players.values());
        expect(b.state.move.jet).toBe(JetMode.Worn);
        b.state.move.jet = JetMode.Flying;
        t.step(sim.players.values());
        b.state.move.jet = JetMode.None;
        t.step(sim.players.values());
        expect(t.jetpacks[0]!.spent).toBe(true);
        expect(t.snapshot('a').jetpacks?.filter((x) => !x.spent)).toHaveLength(2);
        expect(t.takeJetpackEvents().map((e) => e.type)).toEqual([
          'pickup',
          'drop',
          'pickup',
          'spent',
        ]);
        t.reset();
        expect(t.jetpacks).toHaveLength(3);
        expect(t.jetpacks.map((j) => j.pos)).toEqual(homes);
        expect(t.jetpacks.every((x) => !x.spent && x.carrier === null)).toBe(true);
        // Jetpacks off (skill duels): none.
        expect(
          new MatchTactics({ ...sim.map, jetpacks: spots }, 'uplinks', sim.physics, {
            jetpacks: false,
          }).jetpacks,
        ).toHaveLength(0);
      } finally {
        sim.dispose();
      }
    },
  );

  it('predicts a flight exactly: client steps == server steps', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', spawnProtection: 0 });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      sim.tactics.jetpacks = createJetpacks([{ ...a.state.move.pos }]);
      let seq = 0;
      const send = (i: Partial<PlayerInput>): PlayerInput => {
        const input = { ...emptyInput(seq++), ...i };
        sim.receiveInputs('a', [input], sim.nowMs);
        sim.step();
        return input;
      };
      for (let i = 0; i < 30; i++) send({});
      expect(a.state.move.jet).toBe(JetMode.Worn);
      // The client adopts the server's state, then predicts the next steps itself.
      const client = createPlayerState(a.state.move.pos, a.seed);
      applySnapshotMove(
        client,
        sim.snapshot('a').players.find((p) => p.id === 'a')!,
      );
      const body = sim.physics.createCharacter(client.move.pos);
      body.setGrounded(client.move.grounded);
      const script = (i: number): Partial<PlayerInput> => ({
        buttons:
          i === 0 || i === 12 || (i > 20 && i % 40 < 30)
            ? Button.Jump
            : i % 40 > 34
              ? Button.Crouch
              : 0,
        moveZ: i > 30 ? 1 : 0,
        moveX: Math.sin(i / 17) * 0.6,
        yaw: i / 90,
      });
      let flew = false;
      for (let i = 0; i < 360; i++) {
        const input = send(script(i));
        stepPlayerInCrowd(client, input, SIM_DT, body, [], 'a');
        if (a.state.move.jet === JetMode.Flying && a.state.move.pos.y > 1) flew = true;
      }
      expect(flew).toBe(true);
      const snap = sim.snapshot('a').players.find((p) => p.id === 'a')!;
      expect(snapshotError(client, snap)).toBeLessThan(1e-9);
      body.free();
    } finally {
      sim.dispose();
    }
  });
});

describe('Market jetpack spots', () => {
  it('three areas: open sky, room round them, off spawns, foliage and truck lanes', () => {
    const base = getMap('defilad');
    const map = resolveMap(base, 'market');
    const physics = new PhysicsWorld(map);
    try {
      const spots = map.jetpacks ?? [];
      expect(spots).toHaveLength(3);
      const spawns = spawnsFor(physics, base, map, 'market');
      const lanes =
        (map as { truckLanes?: readonly { x0: number; z0: number; x1: number; z1: number }[] })
          .truckLanes ?? [];
      for (const s of spots) {
        const floor = physics.castGroundRay(s, { x: 0, y: -1, z: 0 }, 5);
        expect(floor, JSON.stringify(s)).toBeTruthy();
        const g = floor!.point;
        expect(Math.abs(g.y)).toBeLessThan(0.3); // street level
        // Open sky above.
        expect(physics.castRay({ ...g, y: g.y + 0.3 }, { x: 0, y: 1, z: 0 }, 40)).toBeNull();
        // ≥ 2 m to anything solid at every height a lift-off passes.
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          for (const h of [0.3, 1, 1.7, 3]) {
            const dir = { x: Math.cos(a), y: 0, z: Math.sin(a) };
            expect(physics.castRay({ ...g, y: g.y + h }, dir, 2), `${s.x},${s.z} ${i} ${h}`).toBe(
              null,
            );
          }
        }
        for (const f of map.foliage ?? [])
          expect(Math.hypot(f.x - s.x, f.z - s.z) - f.r).toBeGreaterThan(1.5);
        for (const sp of spawns)
          expect(Math.hypot(sp.pos.x - s.x, sp.pos.z - s.z)).toBeGreaterThan(10);
        for (const r of lanes)
          expect(s.x > r.x0 - 3 && s.x < r.x1 + 3 && s.z > r.z0 - 3 && s.z < r.z1 + 3).toBe(false);
      }
      for (let i = 0; i < 3; i++)
        for (let k = i + 1; k < 3; k++)
          expect(Math.hypot(spots[i]!.x - spots[k]!.x, spots[i]!.z - spots[k]!.z)).toBeGreaterThan(
            30,
          );
    } finally {
      physics.free();
    }
  });
});
