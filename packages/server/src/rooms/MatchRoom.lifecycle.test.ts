import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@colyseus/core';
import { initPhysics, parseMatchOptions, type LobbyErrorMessage } from '@wd/shared';
import type { MatchSim } from '../match/MatchSim.ts';
import { MatchRoom } from './MatchRoom.ts';
import { createLobbyState, joinLobby, setLobbyConnected } from './lobbyState.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('match room lobby lifecycle without sockets', () => {
  it('supplies a fresh spawn seed at the live room boundary, including zero', async () => {
    const random = vi.spyOn(Math, 'random');
    try {
      for (const draw of [0, 0.5]) {
        random.mockReturnValue(draw);
        const options = parseMatchOptions({
          lobby: true,
          botCount: 0,
          map: 'range',
          size: 'full',
        })!;
        const room = roomStub(
          createLobbyState(options),
          Object.assign([] as Client[], { getById: () => undefined }),
          0,
        );
        vi.spyOn(room, 'setMatchmaking').mockResolvedValue(undefined);
        try {
          await (room as unknown as { startPlaying: () => Promise<void> }).startPlaying();
          const sim = (room as unknown as { sim: MatchSim }).sim;
          expect(sim.config.spawnSeed).toBe(Math.floor(draw * 0x100000000));
        } finally {
          room.onDispose();
        }
      }
    } finally {
      random.mockRestore();
    }
  });

  it('starts with every reserved human seat before filling bots', async () => {
    const options = parseMatchOptions({ lobby: true, botCount: 5, map: 'range', size: 'full' });
    if (!options) throw new Error('test options did not parse');
    const lobby = createLobbyState(options);
    joinLobby(lobby, 'host', 'Host', 0);
    joinLobby(lobby, 'reserved', 'Reserved', 1);
    setLobbyConnected(lobby, 'reserved', false);

    const sent: { type: string; payload: unknown }[] = [];
    const host = {
      sessionId: 'host',
      send: (type: string, payload: unknown) => {
        sent.push({ type, payload });
      },
    } as unknown as Client;
    const clients = Object.assign([host], { getById: () => host });
    const room = roomStub(lobby, clients, 0);
    const matchmaking = vi.spyOn(room, 'setMatchmaking').mockResolvedValue(undefined);

    const startPlaying = (
      room as unknown as { startPlaying: () => Promise<void> }
    ).startPlaying.bind(room);
    await startPlaying();
    const sim = (
      room as unknown as {
        sim: { roster: () => { players: { id: string; bot?: true; connected: boolean }[] } };
      }
    ).sim;
    const roster = sim.roster().players;

    expect(roster.find((p) => p.id === 'host')).toMatchObject({ connected: true });
    expect(roster.find((p) => p.id === 'reserved')).toMatchObject({ connected: false });
    expect(roster.filter((p) => p.bot)).toHaveLength(4);
    expect(roster).toHaveLength(6);
    expect(sent.some((m) => m.type === 'welcome')).toBe(true);
    // Bots' nav graph was built at the start, before the loop's first tick.
    const bots = (room as unknown as { sim: { bots: { nav: unknown } } }).sim.bots;
    expect(bots.nav).not.toBeNull();
    expect(matchmaking).toHaveBeenCalledWith({
      metadata: { lobby: true, map: 'range', size: 'full', mode: 'standard' },
    });

    room.onDispose();
  });

  it('reconciles a late join that arrives while start metadata is pending', async () => {
    const options = parseMatchOptions({ lobby: true, botCount: 5, map: 'range', size: 'full' });
    if (!options) throw new Error('test options did not parse');
    const lobby = createLobbyState(options);
    joinLobby(lobby, 'host', 'Host', 0);

    const sent: Record<string, string[]> = { host: [], late: [] };
    const host = client('host', sent.host!);
    const late = client('late', sent.late!);
    const clients = Object.assign([host, late], {
      getById: (id: string) => (id === 'late' ? late : host),
    });
    const room = roomStub(lobby, clients, 10);
    let releaseMatchmaking: (() => void) | undefined;
    vi.spyOn(room, 'setMatchmaking').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseMatchmaking = resolve;
        }),
    );

    const startPlaying = (
      room as unknown as { startPlaying: () => Promise<void> }
    ).startPlaying.bind(room);
    const starting = startPlaying();
    await Promise.resolve();
    room.onJoin(late, { name: 'Late' });
    expect(sent.late).not.toContain('welcome');

    releaseMatchmaking?.();
    await starting;

    const sim = (
      room as unknown as {
        sim: { roster: () => { players: { id: string; bot?: true; connected: boolean }[] } };
      }
    ).sim;
    const roster = sim.roster().players;
    expect(roster.find((p) => p.id === 'late')).toMatchObject({ connected: true });
    expect(roster.filter((p) => p.bot)).toHaveLength(4);
    expect(sent.late).toContain('welcome');

    room.onDispose();
  });

  it('rejects host setting changes while async start is pending', async () => {
    const options = parseMatchOptions({ lobby: true, botCount: 5, map: 'range', size: 'full' });
    if (!options) throw new Error('test options did not parse');
    const hostErrors: LobbyErrorMessage[] = [];
    const handlers = new Map<string, (client: Client, msg: unknown) => void>();
    const host = {
      sessionId: 'host',
      send: (type: string, payload: unknown) => {
        if (type === 'lobbyError') hostErrors.push(payload as LobbyErrorMessage);
      },
    } as unknown as Client;
    const room = new MatchRoom();
    let metadata: unknown;
    Object.defineProperty(room, 'metadata', {
      get: () => metadata,
      set: (value: unknown) => {
        metadata = value;
      },
      configurable: true,
    });
    vi.spyOn(room, 'onMessage').mockImplementation((messageType, _schema, cb) => {
      handlers.set(String(messageType), (client, msg) => {
        cb(client, msg, {} as Parameters<typeof cb>[2]);
      });
      return () => undefined;
    });
    vi.spyOn(room.clock, 'setInterval').mockImplementation(
      () => undefined as unknown as ReturnType<typeof room.clock.setInterval>,
    );
    vi.spyOn(
      room as unknown as { runPacedLoop: () => () => void },
      'runPacedLoop',
    ).mockImplementation(() => () => {});
    vi.spyOn(room, 'broadcast').mockImplementation(() => {});
    const setPrivate = vi.spyOn(room, 'setPrivate').mockResolvedValue(undefined);
    Object.defineProperties(room, {
      clients: { value: Object.assign([host], { getById: () => host }) },
      roomId: { value: 'ROOM' },
    });
    try {
      await room.onCreate(options);
      // A friend lobby is private from creation: matchmaking never lands in it.
      expect(setPrivate).toHaveBeenCalledWith(true);
      room.onJoin(host, { name: 'Host' });

      let releaseMatchmaking: (() => void) | undefined;
      vi.spyOn(room, 'setMatchmaking').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseMatchmaking = resolve;
          }),
      );
      const startPlaying = (
        room as unknown as { startPlaying: () => Promise<void> }
      ).startPlaying.bind(room);
      const starting = startPlaying();
      await Promise.resolve();

      handlers.get('settings')?.(host, { botCount: 0 });
      expect(hostErrors).toContainEqual({
        code: 'already-started',
        message: 'match already starting',
      });

      releaseMatchmaking?.();
      await starting;
      const sim = (
        room as unknown as {
          sim: { roster: () => { players: { bot?: true }[] } };
        }
      ).sim;
      expect(sim.roster().players.filter((p) => p.bot)).toHaveLength(5);
      // The host's client is still building its game: out of the fight until it says `ready`.
      const players = (room as unknown as { sim: { players: Map<string, { ready: boolean }> } }).sim
        .players;
      expect(players.get('host')!.ready).toBe(false);
      handlers.get('ready')?.(host, {});
      expect(players.get('host')!.ready).toBe(true);
    } finally {
      room.onDispose();
    }
  });

  it('a lobby player who dropped before the start gets the welcome on reconnecting', async () => {
    const options = parseMatchOptions({ lobby: true, botCount: 0, map: 'range', size: 'full' });
    if (!options) throw new Error('test options did not parse');
    const lobby = createLobbyState(options);
    joinLobby(lobby, 'host', 'Host', 0);
    joinLobby(lobby, 'flaky', 'Flaky', 1);
    setLobbyConnected(lobby, 'flaky', false); // dropped while still in the lobby
    const sent: Record<string, string[]> = { host: [], flaky: [] };
    const host = client('host', sent.host!);
    const flaky = client('flaky', sent.flaky!);
    // Only the host is connected when the match starts.
    const room = roomStub(lobby, Object.assign([host], { getById: () => host }), 0);
    vi.spyOn(room, 'setMatchmaking').mockResolvedValue(undefined);
    const startPlaying = (
      room as unknown as { startPlaying: () => Promise<void> }
    ).startPlaying.bind(room);
    await startPlaying();
    expect(sent.host).toContain('welcome');
    expect(sent.flaky).not.toContain('welcome');

    room.onReconnect(flaky);
    expect(sent.flaky!.filter((t) => t === 'welcome')).toHaveLength(1);
    expect(sent.flaky).toContain('match');
    // A later drop and reconnect is an ordinary resume: no second welcome.
    room.onReconnect(flaky);
    expect(sent.flaky!.filter((t) => t === 'welcome')).toHaveLength(1);
    room.onDispose();
  });

  it('does not dispose the starting sim twice when disposed during matchmaking update', async () => {
    const options = parseMatchOptions({ lobby: true, botCount: 0, map: 'range', size: 'full' });
    if (!options) throw new Error('test options did not parse');
    const lobby = createLobbyState(options);
    joinLobby(lobby, 'host', 'Host', 0);
    const host = client('host', []);
    const room = roomStub(lobby, Object.assign([host], { getById: () => host }), 0);
    let releaseMatchmaking: (() => void) | undefined;
    vi.spyOn(room, 'setMatchmaking').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseMatchmaking = resolve;
        }),
    );

    const startPlaying = (
      room as unknown as { startPlaying: () => Promise<void> }
    ).startPlaying.bind(room);
    const starting = startPlaying();
    await Promise.resolve();
    const sim = (room as unknown as { sim: { dispose: () => void } }).sim;
    const dispose = vi.spyOn(sim, 'dispose');

    room.onDispose();
    releaseMatchmaking?.();
    await expect(starting).rejects.toThrow(/disposed/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

function client(sessionId: string, sentTypes: string[]): Client {
  return {
    sessionId,
    send: (type: string) => {
      sentTypes.push(type);
    },
  } as unknown as Client;
}

function roomStub(
  lobby: ReturnType<typeof createLobbyState>,
  clients: Client[] & { getById: (id: string) => Client | undefined },
  currentTime: number,
): MatchRoom {
  const room = Object.create(MatchRoom.prototype) as MatchRoom;
  Object.defineProperties(room, {
    lobby: { value: lobby, writable: true },
    clock: { value: { currentTime } },
    clients: { value: clients },
    roomId: { value: 'ROOM' },
    metadata: {
      set: () => {
        throw new Error('metadata setter used after create');
      },
    },
  });
  vi.spyOn(room, 'broadcast').mockImplementation(() => {});
  vi.spyOn(
    room as unknown as { runPacedLoop: () => () => void },
    'runPacedLoop',
  ).mockImplementation(() => () => {});
  return room;
}
