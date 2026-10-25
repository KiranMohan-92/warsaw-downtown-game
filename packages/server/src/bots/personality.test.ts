import { describe, expect, it } from 'vitest';
import {
  BOT,
  Button,
  MATCH_NET,
  PRIMARY_IDS,
  type BotPersonalityId,
  type MapDefinition,
  type Vec3,
} from '@wd/shared';
import { personalityForSeat } from '../match/bots.ts';
import { createBehaviorTreeBot } from './behaviorTree.ts';
import type { NavGraph, NavNode } from './nav.ts';
import type { BotObservation, BotVisiblePlayer } from './types.ts';

const map: MapDefinition = {
  name: 'persona test',
  bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
  boxes: [],
  spawns: [],
  dummies: [],
};

/** An open 4 m grid (x −24…24, z −48…8): routes are straight lines. */
const nodes: NavNode[] = [];
for (let x = -24; x <= 24; x += 4)
  for (let z = -48; z <= 8; z += 4) nodes.push({ i: nodes.length, x, y: 0, z, links: [] });
const nav: NavGraph = {
  key: 'grid',
  cellSize: 4,
  nodes,
  wanderNodes: nodes,
  nearest: (p: Vec3) =>
    nodes.reduce((b, n) =>
      Math.hypot(n.x - p.x, n.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? n : b,
    ),
  path: (_from: Vec3, to: Vec3) => [to],
  route: (_from: Vec3, to: Vec3) => ({ points: [to], complete: true }),
  lineOfSight: () => false,
};

function obs(
  extra: Partial<BotObservation> = {},
  self: Partial<BotObservation['self']> = {},
): BotObservation {
  return {
    nowMs: 1000,
    seq: 1,
    map,
    nav,
    self: {
      id: 'bot',
      name: 'Bot',
      isBot: true,
      health: 100,
      ammo: 30,
      reserve: 120,
      reloadTimer: 0,
      grenades: 0,
      weapon: 'rifle',
      primary: 'ar7',
      heat: 0,
      charge: 0,
      adsAmount: 0,
      primaryRounds: 150,
      recoilPitch: 0,
      recoilYaw: 0,
      sprinting: true,
      tacSprint: false,
      tacFuel: 1,
      pos: { x: 0, y: 0, z: 0 },
      eye: { x: 0, y: 1.62, z: 0 },
      yaw: 0,
      pitch: 0,
      slot: 1,
      ...self,
    },
    visiblePlayers: [],
    memories: [],
    smoke: [],
    mode: 'standard',
    ...extra,
  };
}

const target = (z: number, extra: Partial<BotVisiblePlayer> = {}): BotVisiblePlayer => ({
  id: 'human',
  name: 'Kiran',
  isBot: false,
  pos: { x: 0, y: 0, z },
  eye: { x: 0, y: 1.62, z },
  yaw: 0,
  pitch: 0,
  slot: 0,
  visibility: 1,
  protected: false,
  reloading: false,
  ...extra,
});

const bot = (personality?: BotPersonalityId, seed = 3) =>
  createBehaviorTreeBot({
    id: 'bot',
    seed,
    difficulty: 'normal',
    behavior: 'ffa',
    ...(personality ? { personality } : {}),
  });

describe('bot personalities: config', () => {
  it('four distinct personalities, seats cycle through them', () => {
    expect(new Set(BOT.personalityOrder).size).toBe(4);
    expect(Object.keys(BOT.personalities).sort()).toEqual([...BOT.personalityOrder].sort());
    expect([1, 2, 3, 4, 5, 6].map(personalityForSeat)).toEqual([
      'rusher',
      'flanker',
      'anchor',
      'marksman',
      'rusher',
      'flanker',
    ]);
  });

  it('every gun belongs to some personality; callsigns fit a roster name', () => {
    const guns = new Set(Object.values(BOT.personalities).flatMap((p) => [...p.primaries]));
    expect([...guns].sort()).toEqual([...PRIMARY_IDS].sort());
    for (const p of Object.values(BOT.personalities)) {
      expect(p.callsigns.length).toBeGreaterThan(0);
      for (const c of p.callsigns)
        expect([...c].length).toBeLessThanOrEqual(MATCH_NET.maxNameLength);
      expect(p.rangeScale).toBeGreaterThan(0);
      expect(p.coverHealth).toBeGreaterThan(0);
      expect(p.coverHealth).toBeLessThan(1);
    }
    // Only the movers burst; the holders stop and watch.
    expect(BOT.personalities.rusher.tacSprint && BOT.personalities.flanker.tacSprint).toBe(true);
    expect(BOT.personalities.anchor.tacSprint || BOT.personalities.marksman.tacSprint).toBe(false);
    expect(BOT.personalities.anchor.holdSeconds).toBeGreaterThan(0);
  });
});

describe('bot personalities: behaviour', () => {
  /** See the target once at `z`, then lose it: the bot hunts the memory. */
  function hunting(b: ReturnType<typeof bot>, z: number): void {
    b.decide(obs({ nowMs: 1000, visiblePlayers: [target(z)] }), 1 / 60);
  }

  it('rushers burst (fresh TacSprint presses) toward a far memory; anchors never do', () => {
    const presses = (p: BotPersonalityId): boolean[] => {
      const b = bot(p);
      hunting(b, -40);
      const out: boolean[] = [];
      for (let i = 0; i < 20; i++) {
        const input = b.decide(obs({ nowMs: 1100 + i * 17, seq: 2 + i }), 1 / 60);
        expect(input.buttons & Button.Sprint).toBe(Button.Sprint);
        out.push((input.buttons & Button.TacSprint) !== 0);
      }
      return out;
    };
    const rusher = presses('rusher');
    expect(rusher.some(Boolean)).toBe(true);
    // A press is an edge: never two ticks running.
    for (let i = 1; i < rusher.length; i++) expect(rusher[i] && rusher[i - 1]).toBe(false);
    expect(presses('anchor').some(Boolean)).toBe(false);
    // Already bursting (or a low tank): no press.
    const b = bot('rusher');
    hunting(b, -40);
    const bursting = b.decide(obs({ nowMs: 1100 }, { tacSprint: true }), 1 / 60);
    expect(bursting.buttons & Button.TacSprint).toBe(0);
    const low = b.decide(obs({ nowMs: 1117 }, { tacFuel: 0.2 }), 1 / 60);
    expect(low.buttons & Button.TacSprint).toBe(0);
  });

  it('flankers come in from the side; the baseline walks straight at the memory', () => {
    const sideways = (p?: BotPersonalityId): number => {
      const b = bot(p);
      hunting(b, -40);
      return b.decide(obs({ nowMs: 1100, seq: 2 }), 1 / 60).moveX;
    };
    expect(Math.abs(sideways())).toBeLessThan(0.05);
    expect(Math.abs(sideways('flanker'))).toBeGreaterThan(0.15);
  });

  it('anchors hold the spot they reach (crouched, still), then move on', () => {
    const b = bot('anchor');
    // Roam: pick a spot, then arrive there.
    b.decide(obs({ nowMs: 1000 }, { sprinting: false }), 1 / 60);
    const goal = b.debug.wanderGoal();
    expect(goal).not.toBeNull();
    const at = { pos: { ...goal! }, eye: { x: goal!.x, y: 1.62, z: goal!.z }, sprinting: false };
    const held = b.decide(obs({ nowMs: 1017, seq: 2 }, at), 1 / 60);
    expect(Math.hypot(held.moveX, held.moveZ)).toBe(0);
    expect(held.buttons & Button.Crouch).toBe(Button.Crouch);
    expect(held.buttons & Button.Sprint).toBe(0);
    // Still holding a couple of seconds later (it looks around meanwhile).
    const later = b.decide(obs({ nowMs: 3000, seq: 3 }, at), 1 / 60);
    expect(Math.hypot(later.moveX, later.moveZ)).toBe(0);
    // After the hold (≤ 1.3 × holdSeconds) it roams again.
    const gone = b.decide(
      obs({ nowMs: 1017 + BOT.personalities.anchor.holdSeconds * 1300 + 50, seq: 4 }, at),
      1 / 60,
    );
    expect(gone.buttons & Button.Sprint).toBe(Button.Sprint);
  });

  it('rushers and flankers charge a target they see reloading; the baseline keeps aiming', () => {
    const charge = (p?: BotPersonalityId): number => {
      const b = bot(p);
      b.decide(obs({ nowMs: 1000, visiblePlayers: [target(-20)] }), 1 / 60);
      const input = b.decide(
        obs({ nowMs: 1600, seq: 2, visiblePlayers: [target(-20, { reloading: true })] }),
        1 / 60,
      );
      return input.buttons;
    };
    const rusher = charge('rusher');
    expect(rusher & Button.Sprint).toBe(Button.Sprint);
    expect(rusher & Button.Ads).toBe(0);
    const baseline = charge();
    expect(baseline & Button.Ads).toBe(Button.Ads);
  });

  it('anchors fight some engagements crouched; rushers never do', () => {
    const crouchShare = (p: BotPersonalityId): number => {
      let crouched = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const b = bot(p, seed);
        b.decide(obs({ nowMs: 1000, visiblePlayers: [target(-12)] }), 1 / 60);
        const input = b.decide(obs({ nowMs: 1800, seq: 2, visiblePlayers: [target(-12)] }), 1 / 60);
        if (input.buttons & Button.Crouch) crouched++;
      }
      return crouched / 60;
    };
    const anchor = crouchShare('anchor');
    expect(anchor).toBeGreaterThan(0.3);
    expect(anchor).toBeLessThan(0.8);
    expect(crouchShare('rusher')).toBe(0);
  });
});
