import { describe, expect, it } from 'vitest';
import { MATCH_NET, type MatchStateMessage, type WelcomeMessage } from '@wd/shared';
import { OnlineLink, wireOnlineRoom } from './connectOnline.ts';
import { onlineStatusText } from './onlineBadge.ts';
import { OnlineSession } from './onlineSession.ts';
import { PRACTICE_FAILED, PracticeRoom, type PracticePort } from './practiceRoom.ts';
import type { MatchRoomLink } from './roomLink.ts';
import { DEFAULT_SETTINGS } from '../settings/settings.ts';
import { practiceChanges, practiceRestartUrl, practiceSettings } from './practiceRoom.ts';

const TICK_MS = 1000 / 60;
const welcome: WelcomeMessage = {
  id: 'me',
  map: 'range',
  size: 'full',
  mode: 'standard',
  tick: 0,
  tickHz: 60,
  spawn: { x: 0, y: 0, z: 0, yaw: 0 },
  seed: 1,
  primary: 'ar7',
};
const playing: MatchStateMessage = {
  phase: 'playing',
  endsAt: 36000,
  scoreLimit: 25,
  scores: [],
  winners: [],
};

/** A room double that records what is sent and lets the test deliver messages. */
function fakeRoom(): MatchRoomLink & {
  sent: string[];
  deliver: (type: string, msg: unknown) => void;
} {
  const handlers = new Map<string, (m: unknown) => void>();
  const sent: string[] = [];
  return {
    roomId: 'R',
    sessionId: 'me',
    reconnection: { minUptime: 5000 },
    sent,
    onMessage: <T>(type: string, cb: (m: T) => void) => {
      handlers.set(type, cb as (m: unknown) => void);
      return () => handlers.delete(type);
    },
    send: (type: string) => sent.push(type),
    leave: () => Promise.resolve(1000),
    onDrop: () => undefined,
    onReconnect: () => undefined,
    onLeave: () => undefined,
    deliver: (type, msg) => handlers.get(type)?.(msg),
  };
}

describe('practice pause: session timing waits with the worker', () => {
  it('the draw timeline holds through a pause and continues where the sim stopped', () => {
    const s = new OnlineSession();
    s.handleWelcome(welcome);
    // One second of snapshots every 2 ticks, on time.
    let tick = 0;
    let local = 1000;
    for (; tick <= 60; tick += 2, local += 2 * TICK_MS)
      s.handleSnapshot({ t: tick, players: [] }, local);
    const before = s.viewTime(local)!;
    s.pauseTiming(local);
    // The worker's clock is stopped for 600 ms: nothing moves, the buffer doesn't grow.
    expect(s.viewTime(local + 300)).toBe(before);
    expect(s.viewTime(local + 600)).toBe(before);
    // A snapshot that was already in flight changes nothing either.
    s.handleSnapshot({ t: tick, players: [] }, local + 5);
    s.resumeTiming(local + 600);
    // The sim continues from the tick it paused at.
    const resumed = local + 600;
    const after = s.viewTime(resumed + 2 * TICK_MS)!;
    expect(after - before).toBeGreaterThan(0);
    expect(after - before).toBeLessThan(2 * TICK_MS + 2);
    s.handleSnapshot({ t: tick + 2, players: [] }, resumed + 2 * TICK_MS);
    s.handleSnapshot({ t: tick + 4, players: [] }, resumed + 4 * TICK_MS);
    // Drawn (and reported as view time) one interpolation delay behind the sim, no more.
    const vt = s.viewTime(resumed + 4 * TICK_MS)!;
    expect((tick + 4) * TICK_MS - vt).toBeCloseTo(MATCH_NET.interpDelayMs, -1);
    expect(s.netStats(resumed + 4 * TICK_MS).delayMs).toBe(MATCH_NET.interpDelayMs);
  });

  it('without a pause, the same gap is a stall: the timeline jumps ahead (what the fix avoids)', () => {
    const s = new OnlineSession();
    s.handleWelcome(welcome);
    let tick = 0;
    let local = 1000;
    for (; tick <= 60; tick += 2, local += 2 * TICK_MS)
      s.handleSnapshot({ t: tick, players: [] }, local);
    const before = s.viewTime(local)!;
    expect(s.viewTime(local + 600)! - before).toBeGreaterThan(400);
  });
});

describe('practice failure before the game listens', () => {
  it('a worker that failed at once still ends the session, with the reason, for a late subscriber', async () => {
    const port: PracticePort = {
      onmessage: null,
      postMessage: (data) => {
        if ((data as { type: string }).type === 'init')
          port.onmessage?.({ data: { type: 'failed', error: 'no WebAssembly' } });
      },
      terminate: () => undefined,
    };
    const room = new PracticeRoom(port, {
      settings: practiceSettings(DEFAULT_SETTINGS),
      name: 'You',
    });
    expect(room.error).toBe('no WebAssembly');
    // The game wires the room only now (Game.create took seconds).
    const session = new OnlineSession();
    wireOnlineRoom(session, new OnlineLink(), room, undefined, { endMatch: true });
    const codes: number[] = [];
    room.onLeave((code) => codes.push(code));
    await new Promise((r) => setTimeout(r, 0));
    expect(codes).toEqual([PRACTICE_FAILED]);
    expect(session.status).toEqual({
      state: 'offline',
      error: `practice match failed: no WebAssembly (${PRACTICE_FAILED})`,
    });
    expect(onlineStatusText(session, 'PRACTICE')).toContain('practice match failed');
  });
});

describe('End match only in rooms that allow it', () => {
  const host = (
    endMatch: boolean,
  ): { session: OnlineSession; room: ReturnType<typeof fakeRoom> } => {
    const room = fakeRoom();
    const session = new OnlineSession();
    wireOnlineRoom(session, new OnlineLink(), room, undefined, { endMatch });
    room.deliver('welcome', welcome);
    room.deliver('match', playing);
    // Quick-join rooms name a host too (the first human) and broadcast lobby updates.
    room.deliver('lobby', {
      roomId: 'R',
      hostId: 'me',
      phase: 'playing',
      settings: practiceSettings(DEFAULT_SETTINGS),
      players: [],
    });
    return { session, room };
  };

  it('quick join: the host is not offered End match (the server would refuse it)', () => {
    const { session, room } = host(false);
    expect(session.hostId).toBe('me');
    expect(session.canEndMatch).toBe(false);
    expect(session.endMatch()).toBe(false);
    expect(room.sent).not.toContain('end');
  });

  it('friend or practice room: the host may end it', () => {
    const { session, room } = host(true);
    expect(session.canEndMatch).toBe(true);
    expect(session.endMatch()).toBe(true);
    expect(room.sent).toContain('end');
  });
});

describe('practice pause: the match countdown waits too', () => {
  it('phase seconds and server time hold while paused and continue after', () => {
    const s = new OnlineSession();
    s.handleWelcome(welcome);
    // 60 s left at server time 0.
    s.handleMatch({ ...playing, endsAt: 60 * 60 });
    s.handleSnapshot({ t: 0, players: [] }, 1000);
    const left = s.phaseSecondsLeft(1000)!;
    expect(left).toBeCloseTo(60, 1);
    s.pauseTiming(1000);
    expect(s.phaseSecondsLeft(91_000)).toBe(left);
    expect(s.serverNow(91_000)).toBe(s.serverNow(1000));
    s.resumeTiming(91_000);
    expect(s.phaseSecondsLeft(91_000)).toBeCloseTo(left, 3);
    expect(s.phaseSecondsLeft(101_000)).toBeCloseTo(left - 10, 1);
  });
});

describe('practice settings: URL precedence and changes after launch', () => {
  it('the URL map/size/radar win over saved settings, as for the page itself', () => {
    const saved = { ...DEFAULT_SETTINGS, map: 'defilad' as const, radar: 'pickups' as const };
    expect(practiceSettings(saved, '?practice=1&map=range&radar=off')).toMatchObject({
      map: 'range',
      size: 'full',
      radar: 'off',
    });
    expect(practiceSettings(saved, '?practice=1&size=north')).toMatchObject({
      map: 'defilad',
      size: 'north',
      radar: 'uplinks',
    });
    // Junk in the URL falls back to the settings.
    expect(practiceSettings(saved, '?map=moon&radar=x')).toMatchObject({
      map: 'defilad',
      radar: 'uplinks',
    });
  });

  it('menu changes after launch are detected; the restart carries them (URL included)', () => {
    const launched = practiceSettings(DEFAULT_SETTINGS);
    expect(practiceChanges(DEFAULT_SETTINGS, launched)).toEqual([]);
    const changed = {
      ...DEFAULT_SETTINGS,
      botCount: 1,
      botDifficulty: 'easy' as const,
      scoreLimit: 'unlimited' as const,
      timeLimit: 300,
      radar: 'off' as const,
    };
    expect(practiceChanges(changed, launched)).toEqual([
      'botCount',
      'botDifficulty',
      'scoreLimit',
      'timeLimit',
      'radar',
    ]);
    const url = new URL(practiceRestartUrl('http://h/?practice=1&radar=pickups&online=1', changed));
    expect(url.searchParams.get('practice')).toBe('1');
    expect(url.searchParams.has('online')).toBe(false);
    // The relaunched page builds exactly the changed match.
    const relaunched = practiceSettings(changed, url.search);
    expect(practiceChanges(changed, relaunched)).toEqual([]);
    expect(relaunched).toMatchObject({ botCount: 1, botDifficulty: 'easy', radar: 'off' });
  });
});
