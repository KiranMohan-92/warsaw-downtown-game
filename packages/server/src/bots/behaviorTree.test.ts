import { beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  FoliageIndex,
  PhysicsWorld,
  createArsenal,
  createPlayerState,
  emptyInput,
  grantSpawnProtection,
  initPhysics,
  isGun,
  stepArsenal,
  type MapDefinition,
  type PlayerInput,
  type Vec3,
} from '@wd/shared';
import { MatchSim, type ServerPlayer } from '../match/MatchSim.ts';
import { createBehaviorTreeBot, holdPoint } from './behaviorTree.ts';
import { buildBotObservation } from './observation.ts';
import { getNavGraph, type NavGraph, type NavNode } from './nav.ts';
import type { BotObservation, PublicPlayerLike } from './types.ts';

beforeAll(async () => {
  await initPhysics();
});

const testMap: MapDefinition = {
  name: 'bot test',
  bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  boxes: [],
  spawns: [],
  dummies: [],
};

const node = (i: number, x: number, z: number, links: readonly number[]): NavNode => ({
  i,
  x,
  y: 0,
  z,
  links,
});

const testNav: NavGraph = {
  key: 'test',
  cellSize: 4,
  nodes: [node(0, 0, 0, [1]), node(1, 0, -8, [0, 2]), node(2, 0, -16, [1])],
  get wanderNodes() {
    return this.nodes;
  },
  nearest(pos: Vec3): NavNode | null {
    return this.nodes.reduce<NavNode | null>((best, n) => {
      if (!best) return n;
      return Math.hypot(n.x - pos.x, n.z - pos.z) < Math.hypot(best.x - pos.x, best.z - pos.z)
        ? n
        : best;
    }, null);
  },
  path(from: Vec3, to: Vec3): readonly Vec3[] {
    const s = this.nearest(from);
    const g = this.nearest(to);
    if (!s || !g) return [];
    if (s.i === g.i) return [{ x: g.x, y: g.y, z: g.z }];
    return this.nodes
      .filter((n) => n.i > s.i && n.i <= g.i)
      .map((n) => ({ x: n.x, y: n.y, z: n.z }));
  },
  route(from: Vec3, to: Vec3) {
    return { points: this.path(from, to), complete: true };
  },
  lineOfSight(): boolean {
    return false;
  },
};

function observation(extra: Partial<BotObservation> = {}): BotObservation {
  return {
    nowMs: 1000,
    seq: 7,
    map: testMap,
    nav: testNav,
    self: {
      id: 'bot',
      name: '[BOT] Basia',
      isBot: true,
      health: 100,
      ammo: 30,
      reserve: 120,
      reloadTimer: 0,
      grenades: 1,
      weapon: 'rifle',
      primary: 'ar7',
      heat: 0,
      charge: 0,
      adsAmount: 0,
      primaryRounds: 150,
      recoilPitch: 0,
      recoilYaw: 0,
      sprinting: false,
      tacSprint: false,
      tacFuel: 1,
      pos: { x: 0, y: 0, z: 0 },
      eye: { x: 0, y: 1.62, z: 0 },
      yaw: 0,
      pitch: 0,
      slot: 1,
    },
    visiblePlayers: [],
    memories: [],
    smoke: [],
    mode: 'standard',
    ...extra,
  };
}

const humanAhead = {
  id: 'human',
  name: 'Kiran',
  isBot: false,
  health: 100,
  pos: { x: 0, y: 0, z: -14 },
  eye: { x: 0, y: 1.62, z: -14 },
  yaw: Math.PI,
  pitch: 0,
  slot: 0,
  visibility: 1,
  protected: false,
  reloading: false,
};

const droneAhead = {
  kind: 'drone' as const,
  id: 'drone:human',
  ownerId: 'human',
  isBot: false,
  pos: { x: 0, y: 2.1, z: -14 },
  eye: { x: 0, y: 2.1, z: -14 },
  yaw: 0,
  pitch: 0,
  slot: 0,
  visibility: 1,
  protected: false as const,
  reloading: false as const,
};

describe('behavior-tree bot decisions', () => {
  it('is deterministic for the same seed after the reaction window', () => {
    const a = createBehaviorTreeBot({
      id: 'a',
      seed: 11,
      difficulty: 'normal',
      behavior: 'ffa',
    });
    const b = createBehaviorTreeBot({
      id: 'b',
      seed: 11,
      difficulty: 'normal',
      behavior: 'ffa',
    });
    const obs = observation({ visiblePlayers: [humanAhead] });
    expect(a.decide(obs, 1 / 60)).toEqual(b.decide(obs, 1 / 60));
    const reacted = observation({ nowMs: 1400, seq: 8, visiblePlayers: [humanAhead] });
    expect(a.decide(reacted, 1 / 60)).toEqual(b.decide(reacted, 1 / 60));
  });

  it('does not fire before sight-acquisition reaction time has elapsed', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 16,
      difficulty: 'easy',
      behavior: 'ffa',
    });
    const first = bot.decide(observation({ nowMs: 0, visiblePlayers: [humanAhead] }), 1 / 60);
    expect((first.buttons & Button.Fire) === 0).toBe(true);
    const reacted = bot.decide(
      observation({ nowMs: 600, seq: 8, visiblePlayers: [humanAhead] }),
      1 / 60,
    );
    expect((reacted.buttons & Button.Fire) !== 0).toBe(true);
  });

  it('seeks a last-known target when sight is lost', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 12,
      difficulty: 'normal',
      behavior: 'ffa',
    });
    bot.decide(observation({ visiblePlayers: [humanAhead] }), 1 / 60);
    const input = bot.decide(observation({ nowMs: 1300, seq: 8 }), 1 / 60);
    expect(Math.hypot(input.moveX, input.moveZ)).toBeGreaterThan(0.1);
    expect(bot.debug.memories().map((m) => m.id)).toEqual(['human']);
  });

  it('shoots a visible drone but never remembers or launches one', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 19,
      difficulty: 'hard',
      behavior: 'ffa',
    });
    let fired = false;
    for (let i = 0; i < 240 && !fired; i++) {
      const input = bot.decide(
        observation({
          nowMs: 1000 + i * 16,
          seq: 8 + i,
          visibleDrones: [droneAhead],
        }),
        1 / 60,
      );
      expect(input.buttons & Button.Drone).toBe(0);
      fired = (input.buttons & Button.Fire) !== 0;
    }
    expect(fired).toBe(true);
    expect(bot.debug.memories()).toEqual([]);
  });

  it('does not let a drone starve a closer player target', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 22,
      difficulty: 'hard',
      behavior: 'ffa',
    });
    let last = emptyInput(0);
    const closeHuman = {
      ...humanAhead,
      id: 'close',
      pos: { x: 0, y: 0, z: -7 },
      eye: { x: 0, y: 1.62, z: -7 },
    };
    const sideDrone = {
      ...droneAhead,
      pos: { x: 8, y: 4, z: -14 },
      eye: { x: 8, y: 4, z: -14 },
    };
    let fired = false;
    for (let i = 0; i < 240; i++) {
      last = bot.decide(
        observation({
          nowMs: 1000 + i * 16,
          seq: 8 + i,
          visiblePlayers: [closeHuman],
          visibleDrones: [sideDrone],
        }),
        1 / 60,
      );
      fired ||= (last.buttons & Button.Fire) !== 0;
    }
    expect(Math.abs(last.yaw)).toBeLessThan(0.2);
    expect(fired).toBe(true);
  });

  it('does not let a drone distract from a visible player shooting it', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 24,
      difficulty: 'hard',
      behavior: 'ffa',
    });
    const shooter = { ...humanAhead, reloading: false };
    const sideDrone = {
      ...droneAhead,
      pos: { x: 8, y: 4, z: -10 },
      eye: { x: 8, y: 4, z: -10 },
    };
    let last = emptyInput(0);
    let fired = false;
    for (let i = 0; i < 240; i++) {
      last = bot.decide(
        observation({
          nowMs: 1000 + i * 16,
          seq: 8 + i,
          visiblePlayers: [shooter],
          visibleDrones: [sideDrone],
        }),
        1 / 60,
      );
      fired ||= (last.buttons & Button.Fire) !== 0;
    }
    expect(Math.abs(last.yaw)).toBeLessThan(0.2);
    expect(fired).toBe(true);
  });

  it('knife-only bots ignore visible drones and still attack a melee player', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 23,
      difficulty: 'hard',
      behavior: 'ffa',
    });
    const closeHuman = {
      ...humanAhead,
      pos: { x: 0, y: 0, z: -1.1 },
      eye: { x: 0, y: 1.62, z: -1.1 },
    };
    let attacks = 0;
    for (let i = 0; i < 180; i++) {
      const input = bot.decide(
        observation({
          nowMs: 1000 + i * 16,
          seq: 8 + i,
          mode: 'knife',
          self: { ...observation().self, weapon: 'knife' },
          visiblePlayers: [closeHuman],
          visibleDrones: [droneAhead],
        }),
        1 / 60,
      );
      if ((input.buttons & (Button.Fire | Button.Melee)) !== 0) attacks++;
    }
    expect(attacks).toBeGreaterThan(0);
  });

  it('stops shooting a drone when it is gone or obstructed, without hunting its owner', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 20,
      difficulty: 'hard',
      behavior: 'ffa',
    });
    let fired = false;
    for (let i = 0; i < 240 && !fired; i++) {
      const input = bot.decide(
        observation({ nowMs: 1000 + i * 16, seq: 8 + i, visibleDrones: [droneAhead] }),
        1 / 60,
      );
      fired = (input.buttons & Button.Fire) !== 0;
    }
    expect(fired).toBe(true);
    const hidden = bot.decide(observation({ nowMs: 6000, seq: 400, visibleDrones: [] }), 1 / 60);
    expect(hidden.buttons & Button.Fire).toBe(0);
    expect(Math.hypot(hidden.moveX, hidden.moveZ)).toBeGreaterThanOrEqual(0);
    expect(bot.debug.memories()).toEqual([]);
  });

  it('takes cover when badly hurt instead of pushing the duel', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 13,
      difficulty: 'hard',
      behavior: 'ffa',
    });
    const input = bot.decide(
      observation({
        self: { ...observation().self, health: 20 },
        visiblePlayers: [humanAhead],
      }),
      1 / 60,
    );
    expect((input.buttons & Button.Crouch) !== 0).toBe(true);
    expect((input.buttons & Button.Reload) === 0).toBe(true);
    expect(Math.hypot(input.moveX, input.moveZ)).toBeGreaterThan(0.1);
  });

  it('reloads while taking cover only when the current gun is low', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 14,
      difficulty: 'hard',
      behavior: 'ffa',
    });
    const input = bot.decide(
      observation({
        self: { ...observation().self, health: 20, ammo: 1 },
        visiblePlayers: [humanAhead],
      }),
      1 / 60,
    );
    expect((input.buttons & Button.Crouch) !== 0).toBe(true);
    expect((input.buttons & Button.Reload) !== 0).toBe(true);
  });
});

describe('behavior-tree bots and spawn protection', () => {
  const bot = () =>
    createBehaviorTreeBot({ id: 'bot', seed: 21, difficulty: 'hard', behavior: 'ffa' });
  const shielded = { ...humanAhead, protected: true };
  const attack = Button.Fire | Button.Melee | Button.Grenade;

  it('tracks a protected target but never fires, swings or throws at it', () => {
    for (const z of [-14, -1.2]) {
      const target = { ...shielded, pos: { x: 0, y: 0, z }, eye: { x: 0, y: 1.62, z } };
      const b = bot();
      for (let i = 0; i < 240; i++) {
        const input = b.decide(
          observation({ nowMs: 1000 + i * 16, seq: 8 + i, visiblePlayers: [target] }),
          1 / 60,
        );
        expect(input.buttons & attack).toBe(0);
      }
      // Still facing it (weapon up, ready for the moment it ends).
      const last = b.decide(observation({ nowMs: 5000, seq: 400, visiblePlayers: [target] }), 1);
      expect(Math.abs(Math.sin(last.yaw))).toBeLessThan(0.2);
    }
  });

  it('fires once the protection ends', () => {
    const b = bot();
    b.decide(observation({ nowMs: 0, visiblePlayers: [shielded] }), 1 / 60);
    let fired = false;
    for (let i = 0; i < 120 && !fired; i++) {
      const input = b.decide(
        observation({ nowMs: 1000 + i * 16, seq: 8 + i, visiblePlayers: [humanAhead] }),
        1 / 60,
      );
      fired = (input.buttons & Button.Fire) !== 0;
    }
    expect(fired).toBe(true);
  });

  it('prefers a hittable player over a nearer protected one, and switches to it', () => {
    const near = { ...shielded, id: 'near' };
    const far = {
      ...humanAhead,
      id: 'far',
      pos: { x: 20, y: 0, z: -20 },
      eye: { x: 20, y: 1.62, z: -20 },
    };
    const b = bot();
    // Only the protected one in view: it is the target (tracked, not shot)...
    b.decide(observation({ nowMs: 0, visiblePlayers: [near] }), 1 / 60);
    // ...until someone hittable shows up: the bot turns to them and shoots.
    let input = b.decide(observation({ nowMs: 100, visiblePlayers: [near, far] }), 1);
    let fired = false;
    for (let i = 0; i < 180; i++) {
      input = b.decide(
        observation({ nowMs: 1000 + i * 16, seq: 9 + i, visiblePlayers: [near, far] }),
        1 / 60,
      );
      fired ||= (input.buttons & Button.Fire) !== 0;
    }
    expect(fired).toBe(true);
    // Facing the far one (north-east), not the protected one straight north.
    const toFar = Math.atan2(-20, 20);
    expect(
      Math.abs(Math.atan2(Math.sin(input.yaw - toFar), Math.cos(input.yaw - toFar))),
    ).toBeLessThan(0.3);
  });
});

describe('behavior-tree bots use every gun the way it works', () => {
  type Self = BotObservation['self'];
  const at = (z: number) => ({
    ...humanAhead,
    pos: { x: 0, y: 0, z },
    eye: { x: 0, y: 1.62, z },
  });
  /**
   * Drive a bot for `ticks` from t = 1 s (reaction time elapsed from the first tick on) against a
   * target `z` ahead; `step` updates the bot's own gun state from what it pressed (a stand-in
   * for the shared weapon sim). Returns the buttons it pressed, tick by tick.
   */
  function drive(
    self: Partial<Self>,
    z: number,
    ticks: number,
    step: (s: Self, buttons: number) => Self = (s) => s,
  ): number[] {
    const bot = createBehaviorTreeBot({ id: 'bot', seed: 5, difficulty: 'hard', behavior: 'ffa' });
    let s: Self = { ...observation().self, ...self };
    const out: number[] = [];
    bot.decide(observation({ nowMs: 0, self: s, visiblePlayers: [at(z)] }), 1 / 60);
    for (let i = 0; i < ticks; i++) {
      const obs = observation({
        nowMs: 1000 + (i * 1000) / 60,
        seq: 8 + i,
        self: s,
        visiblePlayers: [at(z)],
      });
      const b = bot.decide(obs, 1 / 60).buttons;
      out.push(b);
      s = step(s, b);
    }
    return out;
  }
  const fires = (b: number): boolean => (b & Button.Fire) !== 0;

  it('holds the coilgun trigger through its charge and releases after every shot', () => {
    const shots: number[] = [];
    const buttons = drive({ primary: 'coil', adsAmount: 1 }, -14, 240, (s, b) => {
      // The shared rule: hold to charge 0.25 s, a shot spends the press (-1) until released.
      if (!fires(b)) return { ...s, charge: 0 };
      if (s.charge < 0) return s;
      const charge = s.charge + 1 / 60;
      if (charge >= 0.25 - 1e-9) {
        shots.push(1);
        return { ...s, charge: -1 };
      }
      return { ...s, charge };
    });
    expect(shots.length).toBeGreaterThanOrEqual(2);
    // Holds: runs of at least 15 consecutive ticks (0.25 s) of Fire.
    let run = 0;
    let longest = 0;
    for (const b of buttons) {
      run = fires(b) ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeGreaterThanOrEqual(15);
  });

  it('waits for the scope before firing a scoped gun', () => {
    for (const primary of ['coil', 'marksman'] as const) {
      expect(drive({ primary, adsAmount: 0.5 }, -14, 120).some(fires), primary).toBe(false);
      expect(drive({ primary, adsAmount: 1 }, -14, 120).some(fires), primary).toBe(true);
    }
  });

  it('eases off the arc rifle before it overheats and resumes once it has cooled', () => {
    expect(drive({ primary: 'arc', heat: 0.9 }, -10, 60).some(fires)).toBe(false);
    expect(drive({ primary: 'arc', heat: 0.2 }, -10, 60).some(fires)).toBe(true);
    // Hysteresis: after venting starts it waits for heatResume, not just below heatRelease.
    let heat = 0.9;
    const buttons = drive({ primary: 'arc', heat }, -10, 120, (s, b) => {
      heat = fires(b) ? heat + 0.05 : Math.max(0, heat - 0.6 / 60);
      return { ...s, heat };
    });
    const first = buttons.findIndex(fires);
    expect(first).toBeGreaterThan(0);
    expect(0.9 - (first * 0.6) / 60).toBeLessThanOrEqual(0.35 + 0.02);
  });

  it('never wastes shotgun shells out of range, fires them up close', () => {
    expect(drive({ primary: 'shotgun' }, -30, 120).some(fires)).toBe(false);
    expect(drive({ primary: 'shotgun' }, -8, 120).some(fires)).toBe(true);
  });

  it('fires full auto in bursts, so the recoil settles between them', () => {
    const buttons = drive({ primary: 'iskra' }, -8, 180);
    const shots = buttons.filter(fires).length;
    // 1000 rpm unbroken would be ~50 presses in 3 s; bursts of 5 with 0.35 s pauses are far fewer.
    expect(shots).toBeGreaterThan(5);
    expect(shots).toBeLessThan(40);
  });

  it('switches to the pistol once the primary is dry', () => {
    // Pressed as fresh edges (every other tick) until the pistol is in hand.
    const buttons = drive({ primaryRounds: 0 }, -10, 4);
    expect(buttons.filter((b) => b & Button.Slot2).length).toBe(2);
    expect(buttons.some((b) => b & Button.Slot1)).toBe(false);
    expect(
      drive({ primaryRounds: 0, weapon: 'sidearm' }, -10, 4).some((b) => b & Button.Slot2),
    ).toBe(false);
  });

  it('keeps re-pressing the primary slot until it is in hand (a busy knife drops the first)', () => {
    // Real hands: the knife mid-recovery when the target steps out of knife range. The first
    // Slot1 press lands while the hands are busy and is dropped (switches are press edges).
    const arsenal = createArsenal('standard', 'ar7');
    arsenal.slot = arsenal.target = 'knife';
    arsenal.melee.phase = 'recover';
    arsenal.melee.timer = 0.3;
    let prev = 0;
    const buttons = drive({ weapon: 'knife' }, -10, 90, (s, b) => {
      stepArsenal(arsenal, { ...emptyInput(0), buttons: b }, prev, 1 / 60);
      prev = b;
      return { ...s, weapon: isGun(arsenal.slot) ? arsenal.slot : 'knife' };
    });
    expect(buttons.some((b) => (b & Button.Slot1) !== 0)).toBe(true);
    expect(arsenal.slot).toBe('rifle');
  });

  it('plants to shoot precision guns and keeps strafing with the others', () => {
    const moveOf = (primary: 'marksman' | 'ar7'): number => {
      const bot = createBehaviorTreeBot({ id: 'b', seed: 9, difficulty: 'hard', behavior: 'ffa' });
      const self = { ...observation().self, primary, adsAmount: 1 };
      bot.decide(observation({ nowMs: 0, self, visiblePlayers: [at(-16)] }), 1 / 60);
      let moved = 0;
      for (let i = 0; i < 120; i++) {
        const obs = observation({
          nowMs: 1000 + (i * 1000) / 60,
          seq: 8 + i,
          self,
          visiblePlayers: [at(-16)],
        });
        const input = bot.decide(obs, 1 / 60);
        moved += Math.hypot(input.moveX, input.moveZ);
      }
      return moved;
    };
    expect(moveOf('marksman')).toBe(0);
    expect(moveOf('ar7')).toBeGreaterThan(0);
  });

  it('holds its engage distance on its own side of the target', () => {
    const p = holdPoint({ x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: 0 }, 8);
    expect(p.z).toBeCloseTo(3, 9); // behind us (back off), never beyond the target (z < -5)
    const q = holdPoint({ x: 0, y: 0, z: -14 }, { x: 0, y: 0, z: 0 }, 8);
    expect(q.z).toBeCloseTo(-6, 9);
  });
});

describe('bot nav graph', () => {
  it('builds a cached Market path over shared physics samples', () => {
    const sim = new MatchSim({ map: 'defilad', size: 'market', mode: 'standard' });
    const graph = getNavGraph(sim.map, sim.physics);
    expect(getNavGraph(sim.map, sim.physics)).toBe(graph);
    const start = graph.nodes.find((n) => n.links.length > 0);
    expect(start).toBeDefined();
    const seen = new Set<number>([start!.i]);
    const queue = [start!.i];
    for (let i = 0; i < queue.length; i++) {
      for (const next of graph.nodes[queue[i]!]!.links) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    let far = start!;
    for (const i of seen) {
      const n = graph.nodes[i]!;
      if (
        Math.hypot(n.x - start!.x, n.z - start!.z) > Math.hypot(far.x - start!.x, far.z - start!.z)
      )
        far = n;
    }
    const path = graph.path(start!, far);
    expect(path.length).toBeGreaterThan(2);
    expect(path.at(-1)).toMatchObject({ x: far.x, z: far.z });
    const spawnComponents = sim.spawns.map((spawn) => {
      const nearest = graph.nearest(spawn.pos);
      expect(nearest).not.toBeNull();
      return seen.has(nearest!.i);
    });
    expect(spawnComponents.every(Boolean)).toBe(true);
    sim.dispose();
  });

  it('does not reuse a freed physics world for cached line of sight', () => {
    const map: MapDefinition = {
      ...testMap,
      boxes: [
        {
          center: { x: 0, y: 1, z: -4 },
          size: { x: 6, y: 2, z: 0.4 },
          mat: 'concrete',
        },
      ],
    };
    const first = new PhysicsWorld(map);
    const cached = getNavGraph(map, first);
    expect(cached.lineOfSight({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -8 })).toBe(false);
    first.free();
    const second = new PhysicsWorld(map);
    const fresh = getNavGraph(map, second);
    expect(fresh).not.toBe(cached);
    expect(fresh.lineOfSight({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -8 })).toBe(false);
    second.free();
  });
});

describe('bot perception boundary', () => {
  function player(id: string, pos: Vec3): PublicPlayerLike {
    const state = createPlayerState(pos);
    state.move.grounded = true;
    return {
      id,
      name: id,
      slot: id === 'bot' ? 1 : 0,
      isBot: id === 'bot',
      state,
    };
  }

  it('never learns an unseen spawn or replaces an old sighting with its new position', () => {
    const physics = new PhysicsWorld(testMap);
    try {
      for (const sawPreviousLife of [false, true]) {
        const config = { id: 'bot', seed: 31, difficulty: 'hard', behavior: 'ffa' } as const;
        const actual = createBehaviorTreeBot(config);
        const absent = createBehaviorTreeBot(config);
        const self = player('bot', { x: 0, y: 0, z: 0 });
        const old = player('human', { x: 0, y: 0, z: -14 });
        const build = (players: PublicPlayerLike[], nowMs: number, seq: number) =>
          buildBotObservation({
            map: testMap,
            physics,
            nav: testNav,
            self,
            players,
            mode: 'standard',
            nowMs,
            seq,
          });
        const before = build(sawPreviousLife ? [self, old] : [self], 0, 0);
        actual.decide(before, 1 / 60);
        absent.decide(before, 1 / 60);
        const fresh = player('human', { x: 20, y: 0, z: 0 });
        grantSpawnProtection(fresh.state);
        for (let i = 0; i < 60; i++) {
          const nowMs = 3000 + (i * 1000) / 60;
          const hidden = build([self, fresh], nowMs, i + 1);
          expect(hidden.visiblePlayers).toEqual([]);
          // Movement and aim must be identical to a world without the unseen spawn.
          const input = actual.decide(hidden, 1 / 60);
          expect(input).toEqual(absent.decide(build([self], nowMs, i + 1), 1 / 60));
          expect(input.buttons & (Button.Fire | Button.Melee | Button.Grenade)).toBe(0);
        }
        expect(actual.debug.memories()).toEqual(
          sawPreviousLife
            ? [{ id: 'human', pos: old.state.move.pos, seenAt: 0, isBot: false }]
            : [],
        );
      }
    } finally {
      physics.free();
    }
  });

  it('does not expose players hidden by smoke or foliage', () => {
    const hiddenMap: MapDefinition = {
      ...testMap,
      foliage: [{ x: 0, z: -4, r: 2.2, h: 2, kind: 'bush' }],
    };
    const physics = new PhysicsWorld(hiddenMap);
    const self = player('bot', { x: 0, y: 0, z: 0 });
    const target = player('human', { x: 0, y: 0, z: -8 });
    const nav = testNav;
    const smokeHidden = buildBotObservation({
      map: hiddenMap,
      physics,
      nav,
      self,
      players: [self, target],
      smoke: [{ id: 1, pos: { x: 0, y: 0, z: -4 }, age: 3 }],
      mode: 'standard',
      nowMs: 0,
      seq: 0,
    });
    expect(smokeHidden.visiblePlayers).toEqual([]);
    const foliageHidden = buildBotObservation({
      map: hiddenMap,
      physics,
      nav,
      self,
      players: [self, target],
      foliage: new FoliageIndex(hiddenMap.foliage ?? []),
      mode: 'standard',
      nowMs: 0,
      seq: 0,
    });
    expect(foliageHidden.visiblePlayers).toEqual([]);
    physics.free();
  });

  it('does not expose a target outside the bot camera cone', () => {
    const physics = new PhysicsWorld(testMap);
    const self = player('bot', { x: 0, y: 0, z: 0 });
    const sideTarget = player('human', { x: 5, y: 0, z: 0 });
    const obs = buildBotObservation({
      map: testMap,
      physics,
      nav: testNav,
      self,
      players: [self, sideTarget],
      mode: 'standard',
      nowMs: 0,
      seq: 0,
    });
    expect(obs.visiblePlayers).toEqual([]);
    physics.free();
  });
});

describe('bot input-only integration boundary', () => {
  function publicPlayer(p: ServerPlayer, isBot: boolean): PublicPlayerLike {
    return { id: p.id, name: p.name, slot: p.slot, isBot, state: p.state };
  }

  it('drives MatchSim only by enqueueing provider PlayerInput', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const botPlayer = sim.addPlayer('bot', '[BOT] Basia', 0);
    const human = sim.addPlayer('human', 'Kiran', 0);
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 42,
      difficulty: 'easy',
      behavior: 'ffa',
    });
    const nav = getNavGraph(sim.map, sim.physics);
    const start = { ...botPlayer.state.move.pos };
    const appliedInputs: PlayerInput[] = [];
    for (let seq = 0; seq < 90; seq++) {
      const players = [publicPlayer(botPlayer, true), publicPlayer(human, false)];
      const obs = buildBotObservation({
        map: sim.map,
        physics: sim.physics,
        nav,
        self: players[0]!,
        players,
        mode: 'standard',
        nowMs: sim.nowMs,
        seq,
      });
      const input = bot.decide(obs, 1 / 60);
      appliedInputs.push(input);
      sim.receiveInputs('bot', [{ ...input, vt: sim.nowMs }], sim.nowMs);
      sim.step();
    }
    expect(appliedInputs.every((input, seq) => input.seq === seq)).toBe(true);
    expect(botPlayer.applied).toBe(90);
    expect(botPlayer.ack).toBe(89);
    expect(human.applied).toBe(0);
    expect(
      Math.hypot(botPlayer.state.move.pos.x - start.x, botPlayer.state.move.pos.z - start.z),
    ).toBeGreaterThan(0.5);
    sim.dispose();
  });

  it('does not mutate a frozen observation while deciding', () => {
    const bot = createBehaviorTreeBot({
      id: 'bot',
      seed: 99,
      difficulty: 'normal',
      behavior: 'ffa',
    });
    const obs = observation({ visiblePlayers: [humanAhead] });
    Object.freeze(obs.self.pos);
    Object.freeze(obs.self.eye);
    Object.freeze(obs.self);
    Object.freeze(obs.visiblePlayers);
    Object.freeze(obs);
    expect(bot.decide(obs, 1 / 60)).toMatchObject({ seq: 7 });
  });
});
