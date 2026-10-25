import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@colyseus/sdk';
import { ROOMS, type PongMessage } from '@wd/shared';
import { createGameServer } from './app.ts';

const PORT = 25670 + Math.floor(Math.random() * 1000);
const server = createGameServer();

beforeAll(async () => {
  await server.listen(PORT);
});
afterAll(async () => {
  await server.gracefullyShutdown(false);
});

describe('game server', () => {
  it('serves /health', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect(res.ok).toBe(true);
  });

  it('a client can join the dev room and round-trip a ping', async () => {
    const room = await new Client(`http://localhost:${PORT}`).joinOrCreate(ROOMS.dev);
    const pong = await new Promise<PongMessage>((resolve) => {
      room.onMessage('pong', resolve);
      room.send('ping', { t: 42 });
    });
    expect(pong.t).toBe(42);
    await room.leave();
  });

  it('malformed messages are rejected and never break the room for other players', async () => {
    const client = new Client(`http://localhost:${PORT}`);
    const honest = await client.joinOrCreate(ROOMS.dev);
    const cheater = await client.joinById(honest.roomId);
    const cheaterPongs: unknown[] = [];
    cheater.onMessage('pong', (m) => cheaterPongs.push(m));
    cheater.send('ping', { t: 'not a number' });
    cheater.send('ping', { t: Infinity });
    // The honest player in the same room keeps getting served.
    const pong = await new Promise<PongMessage>((resolve) => {
      honest.onMessage('pong', resolve);
      honest.send('ping', { t: 7 });
    });
    expect(pong.t).toBe(7);
    expect(cheaterPongs).toEqual([]); // invalid payloads never reach game logic
    await honest.leave();
  });
});
