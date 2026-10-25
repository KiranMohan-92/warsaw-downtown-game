import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@colyseus/sdk';
import { initPhysics, normalizeMatchOptions } from '@wd/shared';
import { createGameServer } from '../app.ts';
import { DEFAULT_MATCH_LIMITS, matchGuard } from '../rooms/matchGuard.ts';
import { seatClient } from './clientWorker.ts';
import { DEFAULT_LINK } from './delayLine.ts';
import { LatencyProxy } from './latencyProxy.ts';
import { soakWorld, type SoakClient } from './soakClient.ts';

// The harness's socket path (`pnpm soak` minus the worker threads): SoakClients seated with the
// real SDK through the latency proxy to a real server. Wall clock, so it asserts only what load
// can't break: they are welcomed, the messages reach the session, pings are answered, nothing
// errors. Fairness is asserted on the virtual clock (soak.test.ts).
const PORT = 27700 + Math.floor(Math.random() * 900);
const server = createGameServer(undefined, { quickJoin: { botCount: 0 } });
const proxy = new LatencyProxy({ host: '127.0.0.1', port: PORT }, DEFAULT_LINK, DEFAULT_LINK);
let proxyPort = 0;

beforeAll(async () => {
  matchGuard.reset({ ...DEFAULT_MATCH_LIMITS, requestBurst: 1000, requestsPerSec: 1000 });
  await initPhysics();
  await server.listen(PORT);
  proxyPort = await proxy.listen();
});
afterAll(async () => {
  await proxy.close();
  await server.gracefullyShutdown(false);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('soak clients over real sockets', () => {
  it('two clients join through the proxy, play and leave cleanly', async () => {
    const world = await soakWorld('range', 'full');
    const endpoint = `http://127.0.0.1:${proxyPort}`;
    const options = (name: string) => ({
      ...normalizeMatchOptions({ map: 'range', size: 'full', mode: 'standard', name }),
      primary: 'ar7',
    });
    const a = await seatClient(
      new Client(endpoint),
      world,
      { name: 'A', seed: 1 },
      {
        kind: 'quick',
        options: options('A'),
      },
    );
    const b = await seatClient(
      new Client(endpoint),
      world,
      { name: 'B', seed: 2 },
      { kind: 'join', options: options('B') },
      a.room.roomId,
    );
    const clients: SoakClient[] = [a.client, b.client];
    const t0 = performance.now();
    while (performance.now() - t0 < 3500) {
      for (const c of clients) c.frame(performance.now());
      await sleep(8);
    }
    for (const c of clients) {
      expect(c.id, c.opts.name).not.toBeNull();
      expect(c.state, c.opts.name).not.toBeNull();
      expect(c.errors, c.opts.name).toEqual([]);
      expect(c.snapshots, c.opts.name).toBeGreaterThan(20);
      expect(c.steps, c.opts.name).toBeGreaterThan(60);
      // The server's ping reached the session and our pong came back (the RTT it measured).
      expect(c.session.rtt, c.opts.name).toBeGreaterThanOrEqual(90);
      expect(c.session.roster.map((r) => r.name).sort()).toEqual(['A', 'B']);
    }
    await a.leave();
    await b.leave();
    expect(a.client.errors).toEqual([]);
    expect(proxy.stats().chunks).toBeGreaterThan(100);
  }, 60_000);
});
