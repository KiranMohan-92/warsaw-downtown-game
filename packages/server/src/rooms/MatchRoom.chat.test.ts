import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { CHAT, ROOMS, type ChatMessage, type WelcomeMessage } from '@wd/shared';
import { createGameServer } from '../app.ts';
import { DEFAULT_MATCH_LIMITS, matchGuard } from './matchGuard.ts';

// Chat over the real transport (like MatchRoom.test.ts): validated, cleaned, rate limited.
const PORT = 27670 + Math.floor(Math.random() * 1000);
const server = createGameServer(undefined, { quickJoin: { botCount: 0 } });
const url = `http://localhost:${PORT}`;

beforeAll(async () => {
  matchGuard.reset({ ...DEFAULT_MATCH_LIMITS, requestBurst: 1000, requestsPerSec: 1000 });
  await server.listen(PORT);
});
afterAll(async () => {
  await server.gracefullyShutdown(false);
});

const RANGE = { lobby: false, map: 'range', size: 'full', mode: 'standard' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function join(
  name: string,
  roomId?: string,
): Promise<{ room: Room; id: string; chat: ChatMessage[] }> {
  const client = new Client(url);
  const options = { ...RANGE, name };
  const room = roomId
    ? await client.joinById(roomId, options)
    : await client.joinOrCreate(ROOMS.match, options);
  const chat: ChatMessage[] = [];
  room.onMessage('chat', (m: ChatMessage) => chat.push(m));
  const welcome = await new Promise<WelcomeMessage>((resolve) =>
    room.onMessage('welcome', resolve),
  );
  return { room, id: welcome.id, chat };
}

describe('match room chat', () => {
  it('lines reach everyone cleaned; floods get one notice; junk kicks the sender', async () => {
    const a = await join('Ania');
    const b = await join('Bartek', a.room.roomId);
    a.room.send('chat', { text: '  hello\u0000   shit  ' });
    b.room.send('chat', { quick: 'gg' });
    await sleep(300);
    for (const seen of [a.chat, b.chat]) {
      expect(seen).toEqual([
        expect.objectContaining({ from: a.id, name: 'Ania', kind: 'player', text: 'hello ****' }),
        expect.objectContaining({ from: b.id, name: 'Bartek', kind: 'quick', quick: 'gg' }),
      ]);
    }
    // A flood: the burst goes out, then one notice to the sender only.
    for (let i = 0; i < CHAT.burst + 3; i++) a.room.send('chat', { text: `spam ${i}` });
    await sleep(300);
    expect(b.chat.filter((m) => m.from === a.id)).toHaveLength(CHAT.burst); // incl. "hello"
    expect(a.chat.filter((m) => m.kind === 'system')).toHaveLength(1);
    expect(b.chat.filter((m) => m.kind === 'system')).toHaveLength(0);

    const kicked = new Promise<number>((resolve) => b.room.onLeave((code) => resolve(code)));
    b.room.send('chat', { text: 'x'.repeat(CHAT.maxRawLength + 1) });
    expect(await kicked).not.toBe(4000);
    await a.room.leave();
  }, 30000);

  it('a friend lobby chats before the match starts (bots stay quiet there)', async () => {
    const opts = { lobby: true, map: 'range', size: 'full', mode: 'standard', botCount: 2 };
    const host = await new Client(url).create(ROOMS.match, { ...opts, name: 'Host' });
    const guest = await new Client(url).joinById(host.roomId, { ...opts, name: 'Guest' });
    const seen: ChatMessage[] = [];
    guest.onMessage('chat', (m: ChatMessage) => seen.push(m));
    host.onMessage('chat', () => {});
    host.onMessage('lobby', () => {});
    guest.onMessage('lobby', () => {});
    await sleep(200);
    host.send('chat', { text: 'pick a map' });
    host.send('chat', { quick: 'isThatAll' });
    await sleep(1500);
    expect(seen).toEqual([
      expect.objectContaining({
        from: host.sessionId,
        name: 'Host',
        kind: 'player',
        text: 'pick a map',
      }),
      expect.objectContaining({ kind: 'quick', quick: 'isThatAll' }),
    ]);
    await host.leave();
    await guest.leave();
  }, 30000);
});
