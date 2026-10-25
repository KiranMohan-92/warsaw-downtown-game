import { describe, expect, it } from 'vitest';
import { parseMatchOptions } from '@wd/shared';
import {
  createLobbyState,
  joinLobby,
  lobbyMessage,
  renameLobbySeat,
  removeLobbySeat,
  setLobbyConnected,
  startLobby,
  updateLobbySettings,
} from './lobbyState.ts';

function options(raw: Record<string, unknown>) {
  const parsed = parseMatchOptions(raw);
  if (!parsed) throw new Error('test options did not parse');
  return parsed;
}

describe('lobby state', () => {
  it('makes the first human host and transfers host only when that seat leaves', () => {
    const state = createLobbyState(options({ lobby: true }));
    joinLobby(state, 'a', 'Ada', 10);
    joinLobby(state, 'b', 'Bo', 20);
    const message = lobbyMessage(state, 'ROOM');
    expect(message).toMatchObject({
      roomId: 'ROOM',
      hostId: 'a',
      phase: 'lobby',
    });
    expect(message.players.filter((p) => !p.bot)).toEqual([
      { id: 'a', name: 'Ada', connected: true },
      { id: 'b', name: 'Bo', connected: true },
    ]);

    setLobbyConnected(state, 'a', false);
    expect(state.hostId).toBe('a');
    removeLobbySeat(state, 'a');
    expect(state.hostId).toBe('b');
  });

  it('lets only the host change validated settings before start', () => {
    const state = createLobbyState(options({ lobby: true }));
    joinLobby(state, 'host', 'Host', 0);
    joinLobby(state, 'guest', 'Guest', 1);

    expect(updateLobbySettings(state, 'guest', { botCount: 1 }, 'ROOM')).toMatchObject({
      ok: false,
      code: 'host-only',
    });
    expect(updateLobbySettings(state, 'host', { botCount: 8 }, 'ROOM')).toMatchObject({
      ok: false,
      code: 'invalid-settings',
    });
    expect(
      updateLobbySettings(
        state,
        'host',
        { map: 'range', size: 'market', mode: 'knife', radar: 'off', botCount: 2 },
        'ROOM',
      ),
    ).toMatchObject({
      ok: true,
      message: {
        settings: { map: 'range', size: 'full', mode: 'knife', radar: 'off', botCount: 2 },
      },
    });
  });

  it('locks settings after the host starts the match', () => {
    const state = createLobbyState(options({ lobby: true, scoreLimit: 25 }));
    joinLobby(state, 'host', 'Host', 0);

    expect(startLobby(state, 'guest', 'ROOM')).toMatchObject({ ok: false, code: 'host-only' });
    expect(startLobby(state, 'host', 'ROOM')).toMatchObject({
      ok: true,
      message: { phase: 'playing' },
    });
    expect(updateLobbySettings(state, 'host', { scoreLimit: 50 }, 'ROOM')).toMatchObject({
      ok: false,
      code: 'already-started',
    });
    expect(startLobby(state, 'host', 'ROOM')).toMatchObject({
      ok: false,
      code: 'already-started',
    });
  });

  it('shows planned bots in the lobby, clipped by human seats', () => {
    const state = createLobbyState(options({ lobby: true, botCount: 5 }));
    joinLobby(state, 'a', 'Ada', 0);
    joinLobby(state, 'b', 'Bo', 1);

    expect(lobbyMessage(state, 'ROOM').players.filter((p) => p.bot)).toHaveLength(4);
    expect(
      lobbyMessage(state, 'ROOM', [{ id: 'bot:1', name: 'Bot 1', connected: true, bot: true }])
        .players,
    ).toContainEqual({
      id: 'bot:1',
      name: 'Bot 1',
      connected: true,
      bot: true,
    });
  });

  it('rate-limits lobby-only name changes like match renames', () => {
    const state = createLobbyState(options({ lobby: true }));
    joinLobby(state, 'host', 'Host', 0);

    expect(renameLobbySeat(state, 'host', 'Name 1', 0)).toBe(true);
    expect(renameLobbySeat(state, 'host', 'Name 2', 0)).toBe(true);
    expect(renameLobbySeat(state, 'host', 'Name 3', 0)).toBe(true);
    expect(renameLobbySeat(state, 'host', 'Name 4', 0)).toBe(false);
    expect(lobbyMessage(state, 'ROOM').players[0]).toMatchObject({ name: 'Name 3' });
  });
});
