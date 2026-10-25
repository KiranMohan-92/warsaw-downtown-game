import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@colyseus/core';
import { Button, emptyInput, GRENADE, initPhysics, parseMatchOptions, SIM } from '@wd/shared';
import { MatchSim } from '../match/MatchSim.ts';
import { MatchRoom } from './MatchRoom.ts';
import { createLobbyState, joinLobby, setLobbyConnected } from './lobbyState.ts';

beforeAll(async () => {
  await initPhysics();
});

describe('match room grenade restoration', () => {
  it.each(['join', 'reconnect'] as const)(
    'sends active frags at their current pose and remaining fuse on %s',
    (path) => {
      const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
      try {
        sim.addPlayer('thrower', 'Ada', 0);
        if (path === 'reconnect') sim.addPlayer('guest', 'Bo', 0).connected = false;
        // Release through the same input path as a client, then let the frag fly for a while.
        const ticks = Math.ceil((GRENADE.windup + 0.5) * SIM.tickHz);
        for (let seq = 0; seq < ticks; seq++) {
          sim.receiveInputs(
            'thrower',
            [{ ...emptyInput(seq), buttons: seq === 0 ? Button.Grenade : 0 }],
            sim.nowMs,
          );
          sim.step();
        }
        expect(sim.grenades).toHaveLength(1);
        const { g, owner } = sim.grenades[0]!;
        expect(g.fuse).toBeGreaterThan(0);
        expect(g.fuse).toBeLessThan(GRENADE.fuse);
        sim.drainEvents(); // The original throw was already broadcast while this client was away.

        // Exercise the production lifecycle without starting a room, timers or sockets.
        const options = parseMatchOptions({
          map: 'range',
          size: 'full',
          mode: 'standard',
          botCount: 0,
        });
        if (!options) throw new Error('test options did not parse');
        const lobby = createLobbyState(options);
        joinLobby(lobby, 'thrower', 'Ada', 0);
        if (path === 'reconnect') {
          joinLobby(lobby, 'guest', 'Bo', 0);
          setLobbyConnected(lobby, 'guest', false);
        }
        const room = Object.create(MatchRoom.prototype) as MatchRoom;
        Object.defineProperties(room, {
          sim: { value: sim },
          lobby: { value: lobby },
          roomId: { value: 'ROOM' },
          clock: { value: { currentTime: sim.nowMs } },
        });
        const broadcast = vi.spyOn(room, 'broadcast').mockImplementation(() => {});
        const send = vi.fn();
        const client = { sessionId: 'guest', send } as unknown as Client;
        if (path === 'join') room.onJoin(client, { name: 'Bo' });
        else room.onReconnect(client);

        expect(send).toHaveBeenCalledWith('combat', {
          events: [
            {
              type: 'nade',
              id: g.id,
              by: owner,
              pos: g.pos,
              vel: g.vel,
              fuse: g.fuse,
              kind: 'frag',
              resting: g.resting,
            },
          ],
        });
        expect(broadcast.mock.calls.some(([type]) => type === 'combat')).toBe(false);
        expect(sim.drainEvents()).toEqual([]);
      } finally {
        sim.dispose();
      }
    },
  );
});
