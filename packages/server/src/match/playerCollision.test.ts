import { beforeAll, describe, expect, it } from 'vitest';
import {
  boxMinMax,
  Button,
  clonePlayerState,
  crowdMemberOf,
  emptyInput,
  initPhysics,
  MATCH_NET,
  PhysicsWorld,
  PLAYER_COLLISION,
  reconcile,
  SIM,
  SIM_DT,
  stepPlayerInCrowd,
  toSnapshotPlayer,
  createPlayerState,
  type CrowdMember,
  type MapDefinition,
  type PlayerInput,
  type PredictedStep,
  type SnapshotPlayer,
  type Vec3,
} from '@wd/shared';
import { BehaviorTreeDecisionProvider, type NavGraph, type NavNode } from '../bots/index.ts';
import { MatchSim, type ServerPlayer } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

const TICK_MS = 1000 / SIM.tickHz;

function place(p: ServerPlayer, feet: Vec3, yaw = 0): void {
  p.body.setPosition(feet);
  p.body.setGrounded(true);
  p.state.move.pos = { ...feet };
  p.state.view = { yaw, pitch: 0 };
}

/**
 * Client A over a link with `oneWay` ticks of latency each way, against the real MatchSim: it
 * predicts with `stepPlayerInCrowd` against B where B's newest snapshot has it (what
 * `OnlineSession.crowd` does) and reconciles each snapshot with the shared `reconcile`. Returns
 * the prediction error (m) at the acknowledged step of every snapshot (the correction size) and
 * how close the two came on the server.
 */
function agreement(
  inputA: (i: number) => Partial<PlayerInput>,
  inputB: (i: number) => Partial<PlayerInput>,
  startB: Vec3,
  opts: { oneWay: number; ticks: number; burst?: number },
): { errors: number[]; closest: number } {
  const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
  const client = new PhysicsWorld(sim.map);
  try {
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0);
    place(a, { x: 0, y: 0, z: -12 });
    place(b, startB, Math.PI);
    sim.step(); // settle poses into the first snapshot
    const body = client.createCharacter(a.state.move.pos);
    body.setGrounded(true);
    let state = clonePlayerState(a.state);
    let pending: PredictedStep[] = [];
    const toServer: { at: number; input: PlayerInput }[] = [];
    const toClient: { at: number; own: SnapshotPlayer; b: SnapshotPlayer }[] = [];
    let newestB: { s: SnapshotPlayer } | null = null;
    const crowd: CrowdMember[] = [{ id: 'b', x: 0, y: 0, z: 0, height: 0 }];
    const fillCrowd = (): void => {
      const e = newestB;
      if (!e) return;
      const c = crowd[0]!;
      c.x = e.s.x;
      c.y = e.s.y;
      c.z = e.s.z;
      c.height = e.s.f & 2 ? 1.2 : 1.8; // SnapFlag.Crouched
    };
    const errors: number[] = [];
    let closest = Infinity;
    for (let i = 0; i < opts.ticks; i++) {
      // Snapshots arriving now: reconcile first, as the game does before stepping.
      while (toClient[0] && toClient[0].at <= i) {
        const snap = toClient.shift()!;
        newestB = { s: snap.b };
        fillCrowd();
        // Before the server applied any input (ack −1) the session keeps its own baseline.
        if (snap.own.ack < 0) continue;
        const acked = pending.find((s) => s.input.seq === snap.own.ack);
        if (acked) {
          const p = acked.after.move.pos;
          errors.push(Math.hypot(p.x - snap.own.x, p.y - snap.own.y, p.z - snap.own.z));
        }
        const r = reconcile(state, pending, snap.own, body, SIM_DT, {
          crowd: { members: newestB ? crowd : [], selfId: 'a' },
        });
        state = r.state;
        pending = r.pending;
      }
      const input: PlayerInput = { ...emptyInput(i), ...inputA(i), seq: i };
      stepPlayerInCrowd(state, input, SIM_DT, body, newestB ? crowd : [], 'a');
      pending.push({ input, after: clonePlayerState(state) });
      toServer.push({ at: i + opts.oneWay, input });
      // `burst`: the link delivers inputs in clumps (jitter), so the server catches up in substeps.
      while (toServer[0] && toServer[0].at <= i && i % (opts.burst ?? 1) === 0) {
        const q = toServer.shift()!;
        sim.receiveInputs('a', [q.input], sim.nowMs);
      }
      sim.receiveInputs('b', [{ ...emptyInput(i), ...inputB(i), seq: i }], sim.nowMs);
      sim.step();
      closest = Math.min(
        closest,
        Math.hypot(
          a.state.move.pos.x - b.state.move.pos.x,
          a.state.move.pos.z - b.state.move.pos.z,
        ),
      );
      if (sim.tick % MATCH_NET.snapshotEvery === 0)
        toClient.push({
          at: i + opts.oneWay,
          own: toSnapshotPlayer('a', a.state, a.ack, a.life, { own: true }),
          b: toSnapshotPlayer('b', b.state, b.ack, b.life),
        });
    }
    return { errors, closest };
  } finally {
    client.free();
    sim.dispose();
  }
}

const max = (xs: number[]): number => xs.reduce((m, x) => Math.max(m, x), 0);
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const walkNorth = (): Partial<PlayerInput> => ({ moveZ: 1, yaw: 0 });
const sprintNorth = (): Partial<PlayerInput> => ({ moveZ: 1, yaw: 0, buttons: Button.Sprint });
const idle = (): Partial<PlayerInput> => ({ yaw: Math.PI });

describe('player collision: client prediction vs the server', () => {
  it('is exact without contact (the collision pass adds nothing when nobody is near)', () => {
    const r = agreement(walkNorth, idle, { x: 6, y: 0, z: -18 }, { oneWay: 3, ticks: 150 });
    expect(r.errors.length).toBeGreaterThan(30);
    expect(max(r.errors)).toBeLessThan(1e-6);
  });

  // Measured (max / mean correction, m) at 50 ms each way: 0.032 / 0.0013 walking into a
  // standing player, 0.031 / 0.0007 head-on, 0.032 / 0.0017 crossing; 150 ms each way head-on
  // 0.13 / 0.0014. Without contact it stays exact.
  it('stays within a few cm while sprinting into a standing player (50 ms each way)', () => {
    const r = agreement(sprintNorth, idle, { x: 0.05, y: 0, z: -16 }, { oneWay: 3, ticks: 240 });
    expect(r.closest).toBeLessThan(2 * PLAYER_COLLISION.radius); // they really were in contact
    expect(r.closest).toBeGreaterThan(2 * PLAYER_COLLISION.radius - 0.2);
    expect(max(r.errors)).toBeLessThan(0.05);
    expect(mean(r.errors)).toBeLessThan(0.005);
  });

  it('stays small when both walk into each other head-on (moving target)', () => {
    for (const oneWay of [3, 9]) {
      const r = agreement(
        walkNorth,
        () => ({ moveZ: 1, yaw: Math.PI }),
        { x: 0, y: 0, z: -18 },
        { oneWay, ticks: 240 },
      );
      expect(r.closest).toBeLessThan(2 * PLAYER_COLLISION.radius);
      expect(max(r.errors)).toBeLessThan(oneWay === 3 ? 0.05 : 0.2);
      expect(mean(r.errors)).toBeLessThan(0.005);
    }
  });

  it('stays small when a strafing player crosses the walker', () => {
    const r = agreement(
      walkNorth,
      () => ({ moveX: 1, yaw: Math.PI }),
      { x: 5, y: 0, z: -17 },
      { oneWay: 3, ticks: 240 },
    );
    expect(r.closest).toBeLessThan(2 * PLAYER_COLLISION.radius);
    expect(max(r.errors)).toBeLessThan(0.05);
    expect(mean(r.errors)).toBeLessThan(0.005);
  });

  // Inputs arriving in clumps (jitter) are caught up in substeps: when the server runs them
  // relative to the others' motion is then not when the client predicted them, which the
  // collision turns into a correction. Measured at 50 ms each way, max / mean (m): 4-input
  // clumps 0.06 / 0.002 standing, 0.12 / 0.002 head-on, 0.21 / 0.005 crossing; 8-input (133 ms)
  // clumps up to 0.46 / 0.005 (the same as stepping each batch against a frozen crowd did).
  it('stays small on average when the link delivers inputs in clumps', () => {
    for (const [ia, ib, sb] of [
      [sprintNorth, idle, { x: 0.05, y: 0, z: -16 }],
      [walkNorth, () => ({ moveZ: 1, yaw: Math.PI }), { x: 0, y: 0, z: -18 }],
      [walkNorth, () => ({ moveX: 1, yaw: Math.PI }), { x: 5, y: 0, z: -17 }],
    ] as const) {
      const r = agreement(ia, ib, sb, { oneWay: 3, ticks: 240, burst: 4 });
      expect(r.closest).toBeGreaterThan(2 * PLAYER_COLLISION.radius - 0.2); // never through
      expect(max(r.errors)).toBeLessThan(0.3);
      expect(mean(r.errors)).toBeLessThan(0.01);
    }
  });
});

/** A 1.6 m wide corridor along z, 20 m long, with a straight nav line down its middle. */
function corridor(): { world: PhysicsWorld; nav: NavGraph } {
  const map: MapDefinition = {
    name: 'corridor',
    bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    boxes: [
      boxMinMax({ x: -20, y: -1, z: -20 }, { x: 20, y: 0, z: 20 }, 'ground'),
      boxMinMax({ x: -2, y: 0, z: -10 }, { x: -0.8, y: 3, z: 10 }, 'concrete'),
      boxMinMax({ x: 0.8, y: 0, z: -10 }, { x: 2, y: 3, z: 10 }, 'concrete'),
    ],
    spawns: [],
    dummies: [],
  };
  const nodes: NavNode[] = [];
  for (let z = -12; z <= 12; z++)
    nodes.push({ i: nodes.length, x: 0, y: 0, z, links: z > -12 ? [nodes.length - 1] : [] });
  const nearest = (p: Vec3): NavNode =>
    nodes[Math.max(0, Math.min(nodes.length - 1, Math.round(p.z) + 12))]!;
  const nav: NavGraph = {
    key: 'corridor',
    cellSize: 1,
    nodes,
    wanderNodes: nodes,
    nearest,
    path: (from, to) => nav.route(from, to).points,
    route: (from, to) => {
      const s = nearest(from).z;
      const e = nearest(to).z;
      const pts: Vec3[] = [];
      for (let z = s; z !== e; z += Math.sign(e - s))
        pts.push({ x: 0, y: 0, z: z + Math.sign(e - s) });
      return { points: pts, complete: true };
    },
    lineOfSight: () => true,
  };
  return { world: new PhysicsWorld(map), nav };
}

describe('player collision: bots', () => {
  it('two bots meeting head-on in a corridor both still reach their goals', () => {
    const { world, nav } = corridor();
    try {
      const bots = [
        { id: 'north', from: { x: 0, y: 0.02, z: 11 }, goal: { x: 0, y: 0, z: -11 } },
        { id: 'south', from: { x: 0.05, y: 0.02, z: -11 }, goal: { x: 0, y: 0, z: 11 } },
      ].map((b, k) => ({
        ...b,
        state: createPlayerState(b.from, k + 1),
        body: world.createCharacter(b.from),
        brain: new BehaviorTreeDecisionProvider({
          id: b.id,
          seed: 11 + k,
          difficulty: 'normal',
          behavior: 'ffa',
        }) as unknown as {
          yaw: number;
          steer(p: Vec3, g: Vec3, n: NavGraph, t: number): { x: number; z: number };
        },
        arrived: -1,
      }));
      const crowd: CrowdMember[] = bots.map(() => ({ id: '', x: 0, y: 0, z: 0, height: 0 }));
      let closest = Infinity;
      for (let i = 0; i < 20 * SIM.tickHz; i++) {
        bots.forEach((b, k) => crowdMemberOf(b.id, b.state.move, crowd[k]!));
        for (const b of bots) {
          const pos = b.state.move.pos;
          if (b.arrived < 0 && Math.abs(pos.z - b.goal.z) < 1) b.arrived = i;
          // Look where the route goes (the tree's aim does this while no enemy is in sight).
          b.brain.yaw = Math.atan2(-(b.goal.x - pos.x), -(b.goal.z - pos.z));
          const move = b.brain.steer(pos, b.goal, nav, i * TICK_MS);
          const input = { ...emptyInput(i), moveX: move.x, moveZ: move.z, yaw: b.brain.yaw };
          stepPlayerInCrowd(b.state, input, SIM_DT, b.body, crowd, b.id);
        }
        const [p, q] = bots;
        closest = Math.min(
          closest,
          Math.hypot(
            p!.state.move.pos.x - q!.state.move.pos.x,
            p!.state.move.pos.z - q!.state.move.pos.z,
          ),
        );
      }
      for (const b of bots) expect(b.arrived, b.id).toBeGreaterThan(0);
      for (const b of bots) expect(b.arrived * SIM_DT, b.id).toBeLessThan(10);
      expect(closest).toBeLessThan(2 * PLAYER_COLLISION.radius); // they did meet
      expect(closest).toBeGreaterThan(
        2 * PLAYER_COLLISION.radius - 2 * PLAYER_COLLISION.walkPenetration - 0.02,
      );
    } finally {
      world.free();
    }
  });

  it('a batch of late inputs never carries two walkers through each other (substeps)', () => {
    // Codex repro: 1.2 m apart, walking at each other, eight queued inputs each land in one
    // tick. Stepping each player's batch against the other's old position swapped their sides.
    for (const batch of [1, 4, 8]) {
      const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
      try {
        const a = sim.addPlayer('a', 'A', 0);
        const b = sim.addPlayer('b', 'B', 0);
        place(a, { x: 0, y: 0, z: -12 });
        place(b, { x: 0, y: 0, z: -13.2 }, Math.PI);
        // Already walking at each other (4.6 m/s: a batch of 8 covers 0.61 m each).
        a.state.move.vel = { x: 0, y: 0, z: -4.6 };
        b.state.move.vel = { x: 0, y: 0, z: 4.6 };
        a.state.move.grounded = b.state.move.grounded = true;
        let seq = 0;
        let closest = Infinity;
        for (let t = 0; t < 48; t += batch) {
          const inputs = (yaw: number) =>
            Array.from({ length: batch }, (_, k) => ({
              ...emptyInput(seq + k),
              moveZ: 1,
              yaw,
            }));
          sim.receiveInputs('a', inputs(0), sim.nowMs);
          sim.receiveInputs('b', inputs(Math.PI), sim.nowMs);
          seq += batch;
          // The whole batch arrives at once; the budget lets the server catch up on it.
          for (const p of [a, b]) p.credit = MATCH_NET.stallTicks;
          sim.step();
          closest = Math.min(
            closest,
            Math.hypot(
              a.state.move.pos.x - b.state.move.pos.x,
              a.state.move.pos.z - b.state.move.pos.z,
            ),
          );
          // Head-on: never swapped through (a sidestep around is fine, a pass through is not).
          if (a.state.move.pos.z < b.state.move.pos.z)
            expect(
              Math.abs(a.state.move.pos.x - b.state.move.pos.x),
              `batch ${batch}`,
            ).toBeGreaterThan(0.3);
        }
        expect(closest, `batch ${batch}`).toBeGreaterThan(
          2 * PLAYER_COLLISION.radius - 2 * PLAYER_COLLISION.walkPenetration - 0.03,
        );
      } finally {
        sim.dispose();
      }
    }
  });

  it('bots in a real match are bumped by the same pass (the MatchSim tick resolves them)', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      const b = sim.addPlayer('b', 'B', 0);
      place(a, { x: 0, y: 0, z: -12 });
      place(b, { x: 0.1, y: 0, z: -12 }); // inside each other
      for (let i = 0; i < 90; i++) {
        sim.receiveInputs('a', [{ ...emptyInput(i), seq: i }], sim.nowMs);
        sim.receiveInputs('b', [{ ...emptyInput(i), seq: i }], sim.nowMs);
        sim.step();
      }
      const d = Math.hypot(
        a.state.move.pos.x - b.state.move.pos.x,
        a.state.move.pos.z - b.state.move.pos.z,
      );
      expect(d).toBeGreaterThan(2 * PLAYER_COLLISION.radius - 0.02);
    } finally {
      sim.dispose();
    }
  });
});
