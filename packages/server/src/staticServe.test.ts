import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGameServer } from './app.ts';

const PORT = 27670 + Math.floor(Math.random() * 1000);
let dir: string;
let server: ReturnType<typeof createGameServer>;

beforeAll(async () => {
  dir = await mkdtemp(join(process.cwd(), '.static-serve-test-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  // Random bytes: incompressible, and well past a socket's write buffer.
  const big = Buffer.alloc(900 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  await writeFile(join(dir, 'big.jpg'), big);
  server = createGameServer(dir);
  await server.listen(PORT);
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
  await rm(dir, { recursive: true, force: true });
});

/** GET over one shared keep-alive socket; resolves 'timeout' if the server never answers. */
function get(agent: http.Agent, path: string): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000);
    http
      .get({ host: '127.0.0.1', port: PORT, path, agent }, (res) => {
        let n = 0;
        res.on('data', (d: Buffer) => (n += d.length));
        res.on('end', () => {
          clearTimeout(timer);
          resolve(`${res.statusCode}:${n}`);
        });
      })
      .on('error', (e) => resolve(`error ${e.message}`));
  });
}

describe('static client over the real transport', () => {
  // Regression: @colyseus/better-call's setResponse never ended a response whose last write hit
  // backpressure, so the keep-alive socket stalled and the browser's asset loads hung after a
  // handful of big files (patched in patches/@colyseus__better-call@1.3.3.patch).
  it('keeps serving on a keep-alive socket after a large body', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect(await get(agent, '/big.jpg')).toBe(`200:${900 * 1024}`);
      expect(await get(agent, '/big.jpg')).toBe(`200:${900 * 1024}`);
      expect(await get(agent, '/health')).toMatch(/^200:/);
    } finally {
      agent.destroy();
    }
  });
});
