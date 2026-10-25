import { beforeAll, describe, expect, it } from 'vitest';
import { Button, emptyInput, initPhysics, MATCH, SIM, type GrenadeState } from '@wd/shared';
import { MatchSim } from './MatchSim.ts';
import { MatchTactics } from './tactics.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('M3 match settings and shared tactics', () => {
  it('uses the host clock and score limit, preserving shared winners', () => {
    const sim = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      scoreLimit: 7,
      timeLimit: 60,
    });
    try {
      sim.addPlayer('a', 'A', 0);
      sim.addPlayer('b', 'B', 0);
      expect(sim.matchState().scoreLimit).toBe(7);
      expect(sim.phaseEnds).toBe(60 * SIM.tickHz);
      sim.runTicks(60 * SIM.tickHz);
      expect(sim.matchState()).toMatchObject({ phase: 'ended', winners: ['a', 'b'] });
    } finally {
      sim.dispose();
    }
  });

  it('unlimited score and time: no clock, kills never end it', () => {
    const sim = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      scoreLimit: 'unlimited',
      timeLimit: 'unlimited',
    });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      sim.addPlayer('b', 'B', 0);
      // Well past first-to-25 (scripted kills: the score check runs every tick) and past the
      // default 10 min clock's worth of ticks would be slow; no clock is ever set instead.
      a.kills = 30;
      sim.runTicks(120);
      expect(sim.phaseEnds).toBeNull();
      expect(sim.matchState()).toMatchObject({
        phase: 'playing',
        endsAt: null,
        scoreLimit: 'unlimited',
      });
    } finally {
      sim.dispose();
    }
  });

  it('either limit alone still ends it: the clock with unlimited score, kills with no clock', () => {
    const timed = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      scoreLimit: 'unlimited',
      timeLimit: 300,
    });
    try {
      timed.addPlayer('a', 'A', 0);
      timed.runTicks(300 * SIM.tickHz - 1);
      expect(timed.phase).toBe('playing');
      timed.runTicks(1);
      expect(timed.phase).toBe('ended');
    } finally {
      timed.dispose();
    }
  });

  it('End match: the normal results and shared win; the next match keeps the limits', () => {
    const sim = new MatchSim({
      map: 'range',
      size: 'full',
      mode: 'standard',
      scoreLimit: 'unlimited',
      timeLimit: 'unlimited',
    });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      const b = sim.addPlayer('b', 'B', 0);
      a.kills = b.kills = 2;
      a.deaths = b.deaths = 1;
      expect(sim.endMatch()).toBe(true);
      expect(sim.endMatch()).toBe(false);
      expect(sim.matchState()).toMatchObject({ phase: 'ended', winners: ['a', 'b'] });
      expect(sim.matchState().endsAt).not.toBeNull();
      sim.runTicks(Math.round(MATCH.intermission * SIM.tickHz));
      expect(sim.matchState()).toMatchObject({ phase: 'playing', endsAt: null });
    } finally {
      sim.dispose();
    }
  });

  it('shares smoke clouds with both recipients without frag damage', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      sim.addPlayer('b', 'B', 0);
      const smoke: GrenadeState = {
        id: 12,
        owner: a.seed,
        pos: { ...a.state.move.pos },
        vel: { x: 0, y: 0, z: 0 },
        fuse: 0,
        resting: true,
        kind: 'smoke',
      };
      sim.grenades.push({ g: smoke, owner: a.id });
      sim.step();
      expect(a.state.health).toBe(100);
      const cloud = sim.snapshot('a').tactical?.smoke;
      expect(cloud).toHaveLength(1);
      expect(sim.snapshot('b').tactical?.smoke).toEqual(cloud);
      expect(sim.drainEvents()).toContainEqual({
        type: 'boom',
        id: 12,
        by: 'a',
        pos: smoke.pos,
        kind: 'smoke',
      });
    } finally {
      sim.dispose();
    }
  });

  it('creates smoke only when the shared arsenal releases a legal input throw', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    try {
      const p = sim.addPlayer('a', 'A', 0);
      for (let seq = 0; seq < 90; seq++) {
        sim.receiveInputs('a', [{ ...emptyInput(seq), buttons: Button.Smoke }], sim.nowMs);
        sim.step();
      }
      expect(p.state.arsenal.smokes).toBe(0);
      expect(sim.drainEvents().filter((e) => e.type === 'nade' && e.kind === 'smoke')).toHaveLength(
        1,
      );
    } finally {
      sim.dispose();
    }
  });

  it('radar off never grants a charge or creates uplinks', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', radar: 'off' });
    try {
      sim.addPlayer('a', 'A', 0);
      sim.receiveInputs('a', [{ ...emptyInput(), buttons: Button.Radar }], 0);
      sim.step();
      expect(sim.snapshot('a').tactical).toMatchObject({
        pickups: [],
        radar: { charges: 0, live: 0 },
      });
    } finally {
      sim.dispose();
    }
  });

  it('resolves an uplink race once and sends only the recipient radar charge', () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    try {
      const a = sim.addPlayer('a', 'A', 0);
      const b = sim.addPlayer('b', 'B', 0);
      // Co-locate the test participants at a test uplink, then use the real pickup/input rules.
      b.state.move.pos = { ...a.state.move.pos };
      const tactics = new MatchTactics(
        {
          ...sim.map,
          pickups: [{ id: 'uplink', pos: { ...a.state.move.pos }, kind: 'radar' }],
        },
        'uplinks',
      );
      tactics.add(a.id);
      tactics.add(b.id);
      tactics.step(sim.players.values());
      expect(tactics.snapshot(a.id).radar.charges).toBe(1);
      expect(tactics.snapshot(b.id).radar.charges).toBe(0);
      expect(tactics.pickups[0]!.cooldown).toBeGreaterThan(0);
      tactics.input(a, { ...emptyInput(), buttons: Button.Radar });
      expect(tactics.snapshot(a.id).radar.live).toBeGreaterThan(0);
      expect(tactics.snapshot(a.id).radar.charges).toBe(0);
      expect(tactics.snapshot(b.id).radar.live).toBe(0);
    } finally {
      sim.dispose();
    }
  });
});
