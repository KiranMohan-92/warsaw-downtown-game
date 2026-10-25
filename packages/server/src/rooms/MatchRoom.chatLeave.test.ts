import { describe, expect, it } from 'vitest';
import { parseMatchOptions } from '@wd/shared';
import { MatchChat } from '../match/matchChat.ts';
import { createLobbyState, joinLobby, type LobbyState } from './lobbyState.ts';
import { MatchRoom } from './MatchRoom.ts';

/** The room's own onLeave on a lobby that never started (no transport, no match). */
describe('match room chat cleanup', () => {
  it('guests who chat in an unstarted lobby and leave leave no chat state behind', () => {
    const lobby: LobbyState = createLobbyState(
      parseMatchOptions({ lobby: true, map: 'range', size: 'full', mode: 'standard' })!,
    );
    const chat = new MatchChat(
      {
        sender: (id) => {
          const seat = lobby.seats.get(id);
          return seat ? { name: seat.name, slot: 0, bot: false } : null;
        },
        now: () => 0,
      },
      { seed: 1 },
    );
    // The room's state set by hand (its private fields: no constructor, no transport).
    const room = Object.create(MatchRoom.prototype) as MatchRoom;
    Object.assign(room as unknown as Record<string, unknown>, {
      lobby,
      chat,
      broadcast: () => {},
      broadcastLobby: () => {},
    });
    for (let i = 0; i < 100; i++) {
      const id = `guest${i}`;
      joinLobby(lobby, id, `Guest ${i}`, 0);
      chat.fromPlayer(id, { text: 'hi all' });
      room.onLeave({ sessionId: id } as Parameters<MatchRoom['onLeave']>[0]);
    }
    expect(lobby.seats.size).toBe(0);
    expect(chat.trackedSenders).toBe(0);
  });
});
