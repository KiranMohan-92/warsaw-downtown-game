import { createServer, connect, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DelayLine, DelayQueue, DEFAULT_LINK } from './delayLine.ts';
import { LatencyProxy } from './latencyProxy.ts';

describe('soak link model', () => {
  it('delays every chunk by the one-way delay, in order', () => {
    const line = new DelayLine(DEFAULT_LINK);
    expect([0, 5, 5, 20].map((t) => line.schedule(t))).toEqual([50, 55, 55, 70]);
  });

  it('jitter spreads deliveries but never reorders them (TCP): late ones bunch', () => {
    const line = new DelayLine({ ...DEFAULT_LINK, jitterMs: 20 }, 7);
    const due = Array.from({ length: 500 }, (_, i) => line.schedule(i * 2));
    for (let i = 1; i < due.length; i++) expect(due[i]!).toBeGreaterThanOrEqual(due[i - 1]!);
    const extra = due.map((d, i) => d - i * 2 - 50);
    expect(Math.min(...extra)).toBeGreaterThanOrEqual(-20);
    expect(Math.max(...extra)).toBeLessThanOrEqual(20 + 2); // + the wait behind a later one
    // Seeded: the same schedule again.
    const again = new DelayLine({ ...DEFAULT_LINK, jitterMs: 20 }, 7);
    expect(Array.from({ length: 500 }, (_, i) => again.schedule(i * 2))).toEqual(due);
  });

  it('loss costs a retransmission delay and holds back what follows (head-of-line)', () => {
    const line = new DelayLine({ ...DEFAULT_LINK, loss: 0.1 }, 3);
    const due = Array.from({ length: 1000 }, (_, i) => line.schedule(i));
    expect(line.lost).toBeGreaterThan(60);
    expect(line.lost).toBeLessThan(140);
    const first = due.findIndex((d, i) => d - i > 50);
    expect(due[first]! - first).toBe(250);
    // The next chunk, not lost itself, waits behind it.
    expect(due[first + 1]!).toBeGreaterThanOrEqual(due[first]!);
  });

  it('a queue releases items when due, oldest first', () => {
    const q = new DelayQueue<string>(new DelayLine(DEFAULT_LINK));
    q.push('a', 0);
    q.push('b', 10);
    expect(q.takeDue(49)).toEqual([]);
    expect(q.takeDue(60)).toEqual(['a', 'b']);
    expect(q.size).toBe(0);
  });
});

describe('latency proxy (real sockets)', () => {
  it('forwards both ways, in order, no earlier than the delay', async () => {
    // An echo server behind the proxy: 50 ms up + 50 ms back.
    const echo = createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const proxy = new LatencyProxy(
      { host: '127.0.0.1', port: (echo.address() as AddressInfo).port },
      DEFAULT_LINK,
      DEFAULT_LINK,
    );
    const port = await proxy.listen();
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', r));
    let got = '';
    const t0 = performance.now();
    const done = new Promise<number>((resolve) =>
      sock.on('data', (d: Buffer) => {
        got += d.toString();
        if (got.length >= 3) resolve(performance.now() - t0);
      }),
    );
    for (const c of ['a', 'b', 'c']) sock.write(c);
    const rtt = await done;
    expect(got).toBe('abc');
    expect(rtt).toBeGreaterThanOrEqual(99);
    expect(rtt).toBeLessThan(2000);
    expect(proxy.stats().chunks).toBeGreaterThanOrEqual(2);
    sock.destroy();
    await proxy.close();
    await new Promise<void>((r) => echo.close(() => r()));
  });
});
