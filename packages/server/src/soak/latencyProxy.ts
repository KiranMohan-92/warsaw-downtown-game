import { createServer, connect, type Server, type Socket } from 'node:net';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { DelayLine, type LinkProfile } from './delayLine.ts';

/** How late deliveries were against their schedule, and how many chunks went through. */
export interface ProxyStats {
  chunks: number;
  lost: number;
  connections: number;
  /** Delivery lateness vs the scheduled time (ms): timer precision of the proxy itself. */
  lateP50: number;
  lateP99: number;
  lateMax: number;
}

interface Pending {
  due: number;
  to: Socket;
  data: Buffer | null; // null = end of stream
}

/**
 * A TCP proxy that delays every byte in both directions by a `LinkProfile` (the game's HTTP
 * matchmaking and its WebSocket frames alike: the Colyseus SDK connects to it instead of the
 * server). Order is kept per direction, as TCP does. Timers on Windows fire on a 15.6 ms grid,
 * so deliveries within 20 ms are awaited with `setImmediate` (a busy loop that still serves
 * I/O): run it in its own worker thread (`startProxyWorker`) so the spin costs one core and
 * never stalls the clients or the server.
 */
export class LatencyProxy {
  private server: Server | null = null;
  private readonly queue: Pending[] = [];
  private readonly sockets = new Set<Socket>();
  private conns = 0;
  private chunks = 0;
  private lost = 0;
  private late: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private spinning = false;

  constructor(
    private readonly target: { host: string; port: number },
    private readonly up: LinkProfile,
    private readonly down: LinkProfile,
    private readonly seed = 1,
  ) {}

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((client) => this.accept(client));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    if (this.timer) clearTimeout(this.timer);
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  stats(): ProxyStats {
    const l = [...this.late].sort((a, b) => a - b);
    const q = (p: number): number => l[Math.min(l.length - 1, Math.floor(p * l.length))] ?? 0;
    return {
      chunks: this.chunks,
      lost: this.lost,
      connections: this.conns,
      lateP50: q(0.5),
      lateP99: q(0.99),
      lateMax: l.at(-1) ?? 0,
    };
  }

  private accept(client: Socket): void {
    const n = this.conns++;
    let server: Socket;
    try {
      server = connect(this.target.port, this.target.host);
    } catch {
      // An unusable target (e.g. a port out of range) throws here: refuse this connection, keep
      // the proxy (and its worker thread) alive so the run fails with the client's join error.
      client.destroy();
      return;
    }
    client.setNoDelay(true);
    server.setNoDelay(true);
    this.sockets.add(client);
    this.sockets.add(server);
    // Each connection and direction gets its own seeded schedule (reproducible runs).
    const upLine = new DelayLine(this.up, this.seed * 7919 + n * 2);
    const downLine = new DelayLine(this.down, this.seed * 7919 + n * 2 + 1);
    this.pipe(client, server, upLine);
    this.pipe(server, client, downLine);
    const drop = (): void => {
      client.destroy();
      server.destroy();
      this.sockets.delete(client);
      this.sockets.delete(server);
    };
    client.on('error', drop);
    server.on('error', drop);
    client.on('close', () => this.sockets.delete(client));
    server.on('close', () => this.sockets.delete(server));
  }

  private pipe(from: Socket, to: Socket, line: DelayLine): void {
    from.on('data', (data: Buffer) => {
      const lostBefore = line.lost;
      this.enqueue({ due: line.schedule(performance.now()), to, data });
      this.chunks++;
      this.lost += line.lost - lostBefore;
    });
    from.on('end', () => this.enqueue({ due: line.schedule(performance.now()), to, data: null }));
  }

  private enqueue(p: Pending): void {
    // Per-direction due times never decrease, but directions interleave: keep the queue sorted.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.due > p.due) i--;
    this.queue.splice(i, 0, p);
    // Exactly one wake-up is pending at any time: a timer (far) or an immediate (near).
    if (this.spinning) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.spinning = true;
    setImmediate(this.pump);
  }

  private pump = (): void => {
    this.spinning = false;
    this.timer = null;
    const now = performance.now();
    while (this.queue.length && this.queue[0]!.due <= now) {
      const p = this.queue.shift()!;
      if (this.late.length < 200_000) this.late.push(now - p.due);
      if (p.to.destroyed) continue;
      if (p.data) p.to.write(p.data);
      else p.to.end();
    }
    const next = this.queue[0];
    if (!next) return;
    const wait = next.due - now;
    if (wait > 20) this.timer = setTimeout(this.pump, wait - 17);
    else {
      this.spinning = true;
      setImmediate(this.pump);
    }
  };
}

interface WorkerInit {
  soakProxy: true;
  target: { host: string; port: number };
  up: LinkProfile;
  down: LinkProfile;
  seed: number;
}

/** The part of `worker_threads.Worker` the proxy handle needs (tests drive it with a fake). */
export interface ProxyWorkerLike {
  on(event: 'message', cb: (m: unknown) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  postMessage(m: unknown): void;
  terminate(): Promise<unknown>;
}

export interface ProxyHandle {
  port: number;
  /** Why the worker is gone (an uncaught error, an unexpected exit), else null. */
  readonly failure: string | null;
  /** The proxy's figures; null if the worker is dead or does not answer in time. */
  stats(): Promise<ProxyStats | null>;
  /**
   * Close the proxy and end its thread. Always settles: a worker that already exited (its
   * upstream connect can crash it) or does not answer within the timeout is terminated anyway.
   */
  stop(): Promise<void>;
}

/** How long the proxy worker gets to answer `stats` / `stop` before it is given up on (ms). */
const PROXY_REPLY_TIMEOUT_MS = 3000;

/**
 * The proxy in its own worker thread. Resolves with its port and a stats/stop handle; rejects
 * if the worker dies before it listens.
 */
export async function startProxyWorker(
  target: { host: string; port: number },
  up: LinkProfile,
  down: LinkProfile,
  seed = 1,
  spawn: () => ProxyWorkerLike = () =>
    new Worker(new URL(import.meta.url), {
      workerData: { soakProxy: true, target, up, down, seed } satisfies WorkerInit,
    }),
  replyTimeoutMs = PROXY_REPLY_TIMEOUT_MS,
): Promise<ProxyHandle> {
  const worker = spawn();
  let failure: string | null = null;
  let stopped = false;
  // Whoever is waiting for the next message (the port, then one `ask` at a time).
  let reply: ((m: unknown) => void) | null = null;
  let died: (() => void) | null = null;
  const fail = (why: string): void => {
    if (stopped || failure !== null) return;
    failure = why;
    died?.();
  };
  worker.on('message', (m) => {
    const r = reply;
    reply = null;
    r?.(m);
  });
  worker.on('error', (e) => fail(`proxy worker error: ${e.message}`));
  worker.on('exit', (code) => fail(`proxy worker exited unexpectedly (${code})`));
  const port = await new Promise<number>((resolve, reject) => {
    reply = (m) => resolve((m as { port: number }).port);
    died = () => reject(new Error(failure ?? 'proxy worker died'));
  });
  /** One request, one reply; null when the worker is dead, dies meanwhile, or stays silent. */
  const ask = <T>(type: string): Promise<T | null> =>
    new Promise<T | null>((resolve) => {
      if (failure !== null) return resolve(null);
      const done = (v: T | null): void => {
        clearTimeout(timer);
        reply = null;
        died = null;
        resolve(v);
      };
      const timer = setTimeout(() => done(null), replyTimeoutMs);
      reply = (m) => done(m as T);
      died = () => done(null);
      worker.postMessage(type);
    });
  return {
    port,
    get failure() {
      return failure;
    },
    stats: () => ask<ProxyStats>('stats'),
    stop: async () => {
      await ask<unknown>('stop');
      stopped = true; // the exit that follows is ours
      await worker.terminate().catch(() => {});
    },
  };
}

const init = workerData as WorkerInit | null;
if (!isMainThread && init?.soakProxy && parentPort) {
  const port = parentPort;
  const proxy = new LatencyProxy(init.target, init.up, init.down, init.seed);
  void proxy.listen().then((p) => port.postMessage({ port: p }));
  port.on('message', (m: string) => {
    if (m === 'stats') port.postMessage(proxy.stats());
    else if (m === 'stop') void proxy.close().then(() => port.postMessage({ stopped: true }));
  });
}
