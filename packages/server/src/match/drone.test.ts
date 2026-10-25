import { beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  clonePlayerState,
  DRONE,
  emptyInput,
  eyePosition,
  FoliageIndex,
  initPhysics,
  JAMMER,
  MATCH_NET,
  ownStateError,
  PhysicsWorld,
  reconcile,
  SIM,
  SIM_DT,
  stepPlayer,
  type PlayerInput,
  type PredictedStep,
  type SnapshotPlayer,
  type Vec3,
} from '@wd/shared';
import { MatchSim, type QueuedInput, type ServerPlayer } from './MatchSim.ts';

beforeAll(initPhysics);

function place(p: ServerPlayer, pos: Vec3): void {
  p.body.setPosition(pos);
  p.body.setGrounded(true);
  p.state.move.pos = { ...pos };
  p.state.move.grounded = true;
  p.state.view = { yaw: 0, pitch: 0 };
}

function fixture(extra: Partial<ConstructorParameters<typeof MatchSim>[0]> = {}) {
  const sim = new MatchSim({
    map: 'range',
    size: 'full',
    mode: 'standard',
    spawnProtection: 0,
    vehicles: 'off',
    jetpacks: 'off',
    scoreLimit: 'unlimited',
    timeLimit: 'unlimited',
    ...extra,
  });
  const pilot = sim.addPlayer('pilot', 'Pilot', 0);
  place(pilot, { x: 0, y: 0, z: -12 });
  // A server-owned uplink placed in the range's open lane (the range has no native uplinks).
  sim.tactics.pickups.push({
    id: 'recon',
    pos: { ...pilot.state.move.pos },
    kind: 'drone',
    cooldown: 0,
  });
  sim.step();
  const tick = (inputs: Record<string, Partial<QueuedInput>> = {}) => {
    for (const [id, input] of Object.entries(inputs)) {
      const p = sim.players.get(id)!;
      sim.receiveInputs(id, [{ ...emptyInput(p.lastSeq + 1), ...input }], sim.nowMs);
    }
    sim.step();
  };
  return { sim, pilot, tick };
}

const aim = (from: Vec3, to: Vec3) => ({
  yaw: Math.atan2(from.x - to.x, from.z - to.z),
  pitch: Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z)),
});

describe('authoritative recon drones', () => {
  it('collects one charge, launches, flies and recalls through sanitized player inputs', () => {
    const { sim, pilot, tick } = fixture();
    try {
      expect(pilot.state.droneCharges).toBe(1);
      const body = { ...pilot.state.move.pos };
      const view = { ...pilot.state.view };
      tick({ pilot: { buttons: Button.Drone } });
      expect(pilot.state.drone?.alive).toBe(true);
      expect(pilot.state.droneCharges).toBe(0);
      const start = { ...pilot.state.drone!.pos };
      for (let i = 0; i < 60; i++)
        tick({ pilot: { moveZ: 1, yaw: 0.2, pitch: 0.1, buttons: Button.Fire | Button.Jump } });
      expect(pilot.state.drone!.pos.z).toBeLessThan(start.z - 2);
      expect(pilot.state.drone!.pos.y).toBeGreaterThan(start.y);
      expect(
        Math.hypot(
          pilot.state.move.pos.x - body.x,
          pilot.state.move.pos.y - body.y,
          pilot.state.move.pos.z - body.z,
        ),
      ).toBeLessThan(0.01); // Rapier settles its contact skin under empty body input.
      expect(pilot.state.view).toEqual(view);
      expect(pilot.shots).toBe(0);
      tick({ pilot: { buttons: Button.Drone } });
      expect(pilot.state.drone).toBeNull();
      expect(pilot.state.droneCharges).toBe(0);
      tick({ pilot: {} });
      tick({ pilot: { buttons: Button.Drone } });
      expect(pilot.state.drone).toBeNull();
    } finally {
      sim.dispose();
    }
  });

  it('expires the shared battery, including when input stops', () => {
    const { sim, pilot, tick } = fixture();
    try {
      tick({ pilot: { buttons: Button.Drone } });
      expect(pilot.state.drone?.battery).toBeCloseTo(DRONE.battery - SIM_DT);
      for (let i = 0; i < Math.ceil(DRONE.battery * SIM.tickHz) + MATCH_NET.stallTicks; i++) tick();
      expect(pilot.state.drone?.alive ?? false).toBe(false);
      expect(sim.snapshot('pilot').drones ?? []).toHaveLength(0);
    } finally {
      sim.dispose();
    }
  });

  it('idling preserves the drone view and held button edge when input resumes', () => {
    const { sim, pilot, tick } = fixture();
    try {
      tick({ pilot: { buttons: Button.Drone, yaw: 0.8, pitch: 0.3 } });
      expect(pilot.state.drone?.alive).toBe(true);
      for (let i = 0; i < MATCH_NET.stallTicks + 4; i++) tick();
      expect(pilot.state.drone?.yaw).toBe(0.8);
      expect(pilot.state.drone?.pitch).toBe(0.3);
      tick({ pilot: { buttons: Button.Drone, yaw: 0.8, pitch: 0.3 } });
      expect(pilot.state.drone?.alive).toBe(true);
    } finally {
      sim.dispose();
    }
  });

  it.each(['driver', 'passenger'] as const)(
    'a silent %s still loses the drone when its battery expires',
    (seat) => {
      const { sim, pilot, tick } = fixture({
        vehicles: 'on',
        vehicleSpawns: [{ x: 0, z: -50, yaw: 0 }],
      });
      try {
        if (seat === 'passenger') {
          const driver = sim.addPlayer('driver', 'Driver', 0);
          place(driver, { x: 1.6, y: 0.02, z: -49.6 });
          tick({ driver: { buttons: Button.Interact } });
          expect(driver.state.seat?.seat).toBe('driver');
        }
        place(pilot, { x: 1.6, y: 0.02, z: -49.6 });
        tick({ pilot: { buttons: Button.Interact } });
        expect(pilot.state.seat).not.toBeNull();
        expect(pilot.state.seat?.seat === 'driver').toBe(seat === 'driver');
        tick({ pilot: { buttons: Button.Drone } });
        expect(pilot.state.drone?.alive).toBe(true);
        pilot.state.drone!.battery = SIM_DT * 2;
        for (let i = 0; i < MATCH_NET.stallTicks + 4; i++) tick();
        expect(pilot.state.drone).toBeNull();
        expect(sim.snapshot('pilot').drones ?? []).toHaveLength(0);
      } finally {
        sim.dispose();
      }
    },
  );

  it.each(['wall', 'altitude'] as const)('uses the server physics and shared %s limit', (limit) => {
    const { sim, pilot, tick } = fixture();
    try {
      tick({ pilot: { buttons: Button.Drone } });
      expect(pilot.state.drone?.alive).toBe(true);
      for (let i = 0; i < 520; i++)
        tick({ pilot: limit === 'wall' ? { moveZ: 1 } : { buttons: Button.Jump } });
      const drone = pilot.state.drone!;
      if (limit === 'wall') {
        expect(drone.pos.z).toBeGreaterThanOrEqual(-60 + DRONE.radius - 1e-3);
        expect(drone.pos.z).toBeLessThan(-59);
      } else {
        expect(drone.pos.y).toBeCloseTo(drone.baseY + DRONE.maxAltitude);
      }
    } finally {
      sim.dispose();
    }
  });

  it('gives only the pilot visible pings, with walls and level foliage blocking but overhead sight working', () => {
    const { sim, pilot, tick } = fixture();
    try {
      const seen = sim.addPlayer('seen', 'Seen', 0);
      const wall = sim.addPlayer('wall', 'Wall', 0);
      const behind = sim.addPlayer('behind', 'Behind', 0);
      place(seen, { x: 0, y: 0, z: -22 });
      place(wall, { x: 20, y: 0, z: -28 });
      place(behind, { x: 0, y: 0, z: 0 });
      Object.defineProperty(sim, 'foliage', {
        value: new FoliageIndex([{ x: 0, z: -22, r: 1.5, h: 2, kind: 'bush' }]),
      });
      tick({ pilot: { buttons: Button.Drone } });
      expect(pilot.state.drone?.alive).toBe(true);
      for (let i = 0; i < 12; i++) tick({ pilot: {} });
      expect(sim.snapshot('pilot').tactical?.spotted ?? []).toHaveLength(0);
      // Fly above the bush using the real input and world, then look down at its occupant.
      for (let i = 0; i < 180; i++) tick({ pilot: { buttons: Button.Jump } });
      for (let i = 0; i < 12; i++)
        tick({ pilot: aim(pilot.state.drone!.pos, { x: 0, y: 1.2, z: -22 }) });
      const spotted = sim.snapshot('pilot').tactical!.spotted!;
      expect(spotted.map((s) => s.id)).toEqual(['seen']);
      expect(spotted[0]!.t).toBeGreaterThan(DRONE.spotTime - 0.2);
      for (const p of [seen, wall, behind])
        expect(sim.snapshot(p.id).tactical?.spotted ?? []).toHaveLength(0);
      expect(sim.snapshot().tactical).toBeUndefined();
      // A remembered ping must not track a target after visibility is lost.
      const lastSeen = spotted[0]!;
      place(seen, { x: 22, y: 0, z: -30 });
      for (let i = 0; i < 12; i++) tick({ pilot: {} });
      expect(sim.snapshot('pilot').tactical!.spotted!.find((s) => s.id === 'seen')?.pos).toEqual(
        lastSeen.pos,
      );
      // Looking straight at a player through a building still cannot spot them.
      tick({ pilot: { buttons: Button.Drone } });
      pilot.state.droneCharges = 1; // test fixture: a second uplink charge
      tick({ pilot: {} });
      tick({ pilot: { buttons: Button.Drone } });
      for (let i = 0; i < 12; i++)
        tick({ pilot: aim(pilot.state.drone!.pos, { x: 20, y: 1.2, z: -28 }) });
      expect((sim.snapshot('pilot').tactical?.spotted ?? []).some((s) => s.id === 'wall')).toBe(
        false,
      );
      for (let i = 0; i < Math.ceil(DRONE.spotTime * SIM.tickHz) + 1; i++) tick({ pilot: {} });
      expect(sim.snapshot('pilot').tactical?.spotted ?? []).toHaveLength(0);
    } finally {
      sim.dispose();
    }
  });

  it('forgets spotted targets when they die, respawn or leave', () => {
    const { sim, tick } = fixture();
    try {
      const target = sim.addPlayer('target', 'Target', 0);
      place(target, { x: 0, y: 0, z: -22 });
      const mark = () => {
        sim.tactics.markSpotted('pilot', [{ id: target.id, pos: target.state.move.pos }]);
        expect(sim.snapshot('pilot').tactical?.spotted).toHaveLength(1);
      };
      mark();
      target.state.health = 0;
      tick();
      expect(sim.snapshot('pilot').tactical?.spotted ?? []).toHaveLength(0);
      target.state.health = 100;
      mark();
      const life = target.life;
      place(target, { x: 0, y: -100, z: -22 });
      tick();
      expect(target.life).toBeGreaterThan(life);
      expect(sim.snapshot('pilot').tactical?.spotted ?? []).toHaveLength(0);
      mark();
      sim.removePlayer(target.id);
      expect(sim.snapshot('pilot').tactical?.spotted ?? []).toHaveLength(0);
    } finally {
      sim.dispose();
    }
  });

  it('resolves a jammer edge with per-life charges, radio range and self-radar immunity', () => {
    const { sim, pilot, tick } = fixture();
    try {
      const jammer = sim.addPlayer('jammer', 'Jammer', 0);
      place(jammer, { x: 4, y: 0, z: -12 });
      jammer.state.droneCharges = 1;
      const far = sim.addPlayer('far', 'Far', 0);
      place(far, { x: 0, y: 0, z: -52 });
      far.state.droneCharges = 1;
      tick({
        pilot: { buttons: Button.Drone },
        jammer: { buttons: Button.Drone },
        far: { buttons: Button.Drone },
      });
      // The jammer owner's drone cannot be pulsed while piloting (offline), so recall it first.
      tick({ jammer: {} });
      tick({ jammer: { buttons: Button.Drone } });
      tick({ jammer: { buttons: Button.Jammer } });
      expect(pilot.state.drone?.alive ?? false).toBe(false);
      expect(jammer.state.arsenal.jammers).toBe(JAMMER.perLife - 1);
      expect(sim.snapshot('pilot').tactical?.jammed).toBeGreaterThan(0);
      expect(sim.snapshot('jammer').tactical?.jammed ?? 0).toBe(0);
      expect(far.state.drone?.alive).toBe(true);
      expect(sim.snapshot('far').tactical?.jammed ?? 0).toBe(0);
      tick({ jammer: { buttons: Button.Jammer } });
      expect(jammer.state.arsenal.jammers).toBe(JAMMER.perLife - 1);
      expect(sim.drainEvents().some((e) => e.type === 'jammer')).toBe(true);
    } finally {
      sim.dispose();
    }
  });

  it('packs one compact live drone for every observer and a late joiner; full flight is own-only', () => {
    const { sim, pilot, tick } = fixture();
    try {
      tick({ pilot: { buttons: Button.Drone } });
      const late = sim.addPlayer('late', 'Late', 0);
      const snap = sim.snapshot('late');
      expect(snap.drones).toHaveLength(1);
      const drone = snap.drones![0]!;
      expect(drone).toHaveLength(6);
      expect(drone[0]).toBe('pilot');
      expect(drone.slice(1, 4)).toEqual(Object.values(pilot.state.drone!.pos));
      expect(snap.players.find((p) => p.id === 'pilot')!.own).toBeUndefined();
      expect(sim.snapshot('pilot').players.find((p) => p.id === 'pilot')!.own?.dr).toHaveLength(11);
      expect(snap.players.find((p) => p.id === late.id)!.own?.dr).toBeUndefined();
    } finally {
      sim.dispose();
    }
  });

  it.each([false, true])(
    'shoots a drone as a one-hit sphere at view time (rewound=%s)',
    (rewound) => {
      const { sim, pilot, tick } = fixture();
      try {
        place(pilot, { x: 0, y: 0, z: -22 });
        const shooter = sim.addPlayer('shooter', 'Shooter', 0);
        place(shooter, { x: 0, y: 0, z: -12 });
        tick({ pilot: { buttons: Button.Drone } });
        for (let i = 0; i < 40; i++) tick({ pilot: {}, shooter: { buttons: Button.Ads } });
        const at = { ...pilot.state.drone!.pos };
        const viewMs = sim.nowMs;
        if (rewound)
          for (let i = 0; i < 12; i++)
            tick({ pilot: { moveX: 1 }, shooter: { buttons: Button.Ads } });
        if (rewound) expect(pilot.state.drone!.pos.x).toBeGreaterThan(at.x + DRONE.radius * 2);
        tick({
          shooter: {
            ...aim(eyePosition(shooter.state), at),
            buttons: Button.Ads | Button.Fire,
            vt: viewMs,
          },
        });
        expect(pilot.state.drone?.alive ?? false).toBe(false);
        expect(pilot.state.health).toBe(100);
        expect(sim.snapshot('pilot').drones ?? []).toHaveLength(0);
      } finally {
        sim.dispose();
      }
    },
  );

  it('a rewound hit on a recalled flight cannot kill the replacement drone', () => {
    const { sim, pilot, tick } = fixture();
    try {
      place(pilot, { x: 0, y: 0, z: -22 });
      const shooter = sim.addPlayer('shooter', 'Shooter', 0);
      place(shooter, { x: 0, y: 0, z: -12 });
      tick({ pilot: { buttons: Button.Drone } });
      for (let i = 0; i < 40; i++) tick({ pilot: {}, shooter: { buttons: Button.Ads } });
      const at = { ...pilot.state.drone!.pos };
      const viewMs = sim.nowMs;
      tick({ pilot: { buttons: Button.Drone }, shooter: { buttons: Button.Ads } });
      tick({ pilot: {}, shooter: { buttons: Button.Ads } });
      pilot.state.droneCharges = 1;
      tick({ pilot: { buttons: Button.Drone }, shooter: { buttons: Button.Ads } });
      tick({
        shooter: {
          ...aim(eyePosition(shooter.state), at),
          buttons: Button.Ads | Button.Fire,
          vt: viewMs,
        },
      });
      expect(shooter.shots).toBe(1);
      expect(pilot.state.drone?.alive).toBe(true);
    } finally {
      sim.dispose();
    }
  });

  it('geometry in front of a drone wins the hitscan nearest-hit test', () => {
    const { sim, pilot, tick } = fixture();
    try {
      place(pilot, { x: 20, y: 0, z: -28 });
      const shooter = sim.addPlayer('shooter', 'Shooter', 0);
      place(shooter, { x: 0, y: 0, z: -12 });
      tick({ pilot: { buttons: Button.Drone } });
      for (let i = 0; i < 40; i++) tick({ pilot: {}, shooter: { buttons: Button.Ads } });
      const at = { ...pilot.state.drone!.pos };
      tick({
        shooter: {
          ...aim(eyePosition(shooter.state), at),
          buttons: Button.Ads | Button.Fire,
          vt: sim.nowMs,
        },
      });
      expect(shooter.shots).toBe(1);
      expect(pilot.state.drone?.alive).toBe(true);
      expect(sim.drainEvents().findLast((e) => e.type === 'shot')).toMatchObject({ by: 'shooter' });
    } finally {
      sim.dispose();
    }
  });

  it('junk axes, angles, extra state and input floods cannot teleport or accelerate a drone', () => {
    const { sim, pilot, tick } = fixture();
    try {
      tick({ pilot: { buttons: Button.Drone } });
      expect(pilot.state.drone?.alive).toBe(true);
      const start = { ...pilot.state.drone!.pos };
      const before = pilot.applied;
      const allowedSteps = 60 + Math.floor(pilot.credit);
      for (let i = 0; i < 60; i++) {
        const seq = pilot.lastSeq + 1;
        const junk = {
          ...emptyInput(seq),
          moveX: 1e100,
          moveZ: 1e100,
          yaw: NaN,
          pitch: Infinity,
          buttons: -1 & ~Button.Drone,
          pos: { x: 1e20, y: 1e20, z: 1e20 },
          speed: 1e20,
        };
        sim.receiveInputs(
          'pilot',
          Array.from({ length: 4 }, (_, k) => ({ ...junk, seq: seq + k })),
          sim.nowMs,
        );
        sim.step();
        const d = pilot.state.drone!;
        expect([d.pos.x, d.pos.y, d.pos.z, d.yaw, d.pitch].every(Number.isFinite)).toBe(true);
      }
      expect(pilot.applied - before).toBeLessThanOrEqual(allowedSteps);
      const d = pilot.state.drone!;
      expect(Math.hypot(d.pos.x - start.x, d.pos.z - start.z)).toBeLessThanOrEqual(
        DRONE.speed * allowedSteps * SIM_DT + 1e-6,
      );
      expect(d.pos.y).toBeLessThanOrEqual(d.baseY + DRONE.maxAltitude);
    } finally {
      sim.dispose();
    }
  });
});

describe('drone prediction over delayed input/snapshot links', () => {
  it.each([3, 6, 9])('has zero mispredictions with %i ticks of one-way latency', (latency) => {
    const { sim, pilot } = fixture();
    const physics = new PhysicsWorld(sim.map);
    try {
      let state = clonePlayerState(pilot.state);
      const body = physics.createCharacter(state.move.pos);
      body.setGrounded(true);
      let pending: PredictedStep[] = [];
      const upstream: { due: number; input: PlayerInput }[] = [];
      const downstream: { due: number; snap: SnapshotPlayer }[] = [];
      let checked = 0;
      let corrections = 0;
      for (let i = 0; i < 600; i++) {
        while (downstream[0] && downstream[0].due <= i) {
          const { snap } = downstream.shift()!;
          if (snap.ack < 0) continue;
          const acked = pending.find((p) => p.input.seq === snap.ack);
          if (acked) {
            expect(ownStateError(acked.after, snap.own!)).toBeLessThan(1e-6);
            checked++;
          }
          const result = reconcile(state, pending, snap, body, SIM_DT);
          corrections += Number(result.corrected);
          state = result.state;
          pending = result.pending;
        }
        const input = {
          ...emptyInput(i),
          yaw: Math.sin(i / 70) * 0.5,
          pitch: Math.sin(i / 50) * 0.15,
          moveX: Math.sin(i / 40) * 0.6,
          moveZ: i < 350 ? 0.8 : -0.8,
          buttons:
            i === 0 || i === 570
              ? Button.Drone
              : i < 90
                ? Button.Jump
                : i > 420
                  ? Button.Crouch
                  : 0,
        };
        stepPlayer(state, input, SIM_DT, body);
        if (i === 0) {
          expect(state.drone?.alive).toBe(true);
          expect(state.droneCharges).toBe(0);
        }
        pending.push({ input, after: clonePlayerState(state) });
        upstream.push({ due: i + latency, input });
        while (upstream[0] && upstream[0].due <= i)
          sim.receiveInputs('pilot', [upstream.shift()!.input], sim.nowMs);
        sim.step();
        if (sim.tick % MATCH_NET.snapshotEvery === 0)
          downstream.push({
            due: i + latency,
            snap: sim.snapshot('pilot').players.find((p) => p.id === 'pilot')!,
          });
      }
      expect(checked).toBeGreaterThan(250);
      expect(corrections).toBe(0);
      expect(pilot.state.drone).toBeNull();
    } finally {
      physics.free();
      sim.dispose();
    }
  });
});
