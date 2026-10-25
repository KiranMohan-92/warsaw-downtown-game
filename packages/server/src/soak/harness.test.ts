import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startClientWorker, type ClientResult, type WorkerLike } from './clientWorker.ts';
import { DEFAULT_LINK } from './delayLine.ts';
import {
  LatencyProxy,
  startProxyWorker,
  type ProxyHandle,
  type ProxyWorkerLike,
} from './latencyProxy.ts';
import { clientTotals, DEFAULT_THRESHOLDS, fairness, verdict } from './report.ts';
import { parseSoakArgs, Teardown } from './soakArgs.ts';
import {
  noteOutcome,
  shotVerdict,
  sortedIds,
  splitStruck,
  type ShotOutcomes,
} from './shotVerdict.ts';
import { type ClientStats, type ShotRecord } from './soakClient.ts';

// The harness's own plumbing (review findings): a worker that dies must not hang the run, a
// failed start must not leave a server behind, and the verdict must not pass a bystander hit or
// one starved client.

/** A stand-in for a client worker thread: the test plays the worker's side. */
class FakeWorker extends EventEmitter implements WorkerLike {
  posted: unknown[] = [];
  terminated = 0;
  postMessage(m: unknown): void {
    this.posted.push(m);
  }
  terminate(): Promise<number> {
    this.terminated++;
    return Promise.resolve(0);
  }
}

const job = {
  endpoint: 'http://127.0.0.1:1',
  name: 'Soak 1',
  seed: 1,
  map: 'range' as const,
  size: 'full' as const,
  seat: { kind: 'quick' as const, options: {} },
};

const stats = (over: Partial<ClientStats> = {}): ClientStats => ({
  name: 'Soak 1',
  judged: [],
  corrections: 0,
  correctionErrors: [],
  stateCorrections: 0,
  deathCorrections: 0,
  contactCorrections: 0,
  contactErrors: [],
  seatCorrections: 0,
  driverCorrections: 0,
  driverErrors: [],
  drivingSteps: 0,
  ridingSteps: 0,
  respawns: 0,
  snapshots: 0,
  snapIntervals: [],
  interpDelays: [],
  frameCost: [],
  errors: [],
  kills: 0,
  deaths: 0,
  ...over,
});

describe('client worker handle', () => {
  it('a healthy worker: joined, finished, result returned, worker stopped', async () => {
    const w = new FakeWorker();
    const h = startClientWorker(job, () => w);
    w.emit('message', { type: 'joined', roomId: 'ROOM' });
    expect(await h.roomId).toBe('ROOM');
    const done = h.finish();
    expect(w.posted).toContain('finish');
    const result: ClientResult = { stats: stats({ snapshots: 900 }), frameGaps: [16] };
    w.emit('message', { type: 'result', result });
    expect(await done).toEqual(result);
    expect(h.failure).toBeNull();
    expect(w.terminated).toBe(1);
    // Our own terminate ends the thread: that exit is not a failure.
    w.emit('exit', 1);
    expect(h.failure).toBeNull();
  });

  it('a fatal error after joining: finish still settles, with the error as the result', async () => {
    const w = new FakeWorker();
    const h = startClientWorker(job, () => w);
    w.emit('message', { type: 'joined', roomId: 'ROOM' });
    await h.roomId;
    w.emit('message', { type: 'fatal', error: 'frame loop threw' });
    expect(h.failure).toBe('Soak 1: frame loop threw');
    const r = await h.finish(60_000); // no result will ever come: must not wait for one
    expect(r.stats.errors).toEqual(['Soak 1: frame loop threw']);
    expect(r.stats.judged).toEqual([]);
    expect(w.posted).not.toContain('finish');
  });

  it('an uncaught error or an unexpected exit while finishing settles the pending finish', async () => {
    for (const die of [
      (w: FakeWorker) => w.emit('error', new Error('out of memory')),
      (w: FakeWorker) => w.emit('exit', 1),
    ]) {
      const w = new FakeWorker();
      const h = startClientWorker(job, () => w);
      w.emit('message', { type: 'joined', roomId: 'ROOM' });
      const done = h.finish(60_000);
      die(w);
      const r = await done;
      expect(r.stats.errors).toHaveLength(1);
      expect(r.stats.errors[0]).toMatch(/out of memory|exited unexpectedly \(1\)/);
      expect(h.failure).not.toBeNull();
    }
  });

  it('a failure before joining rejects the seat and is kept for the run loop', async () => {
    const w = new FakeWorker();
    const h = startClientWorker(job, () => w);
    w.emit('message', { type: 'fatal', error: 'MatchmakeError: invalid match options' });
    await expect(h.roomId).rejects.toThrow(/invalid match options/);
    expect(h.failure).toMatch(/invalid match options/);
    expect((await h.finish()).stats.errors).toHaveLength(1);
  });

  it('a worker that never answers finish is given up on', async () => {
    const w = new FakeWorker();
    const h = startClientWorker(job, () => w);
    const r = await h.finish(30);
    expect(r.stats.errors[0]).toMatch(/no result within 30 ms/);
    expect(w.terminated).toBe(1);
  });
});

describe('soak flags', () => {
  it('defaults: 6 clients, 50 ms each way, 60 s, the Market', () => {
    const a = parseSoakArgs([]);
    expect(a).toMatchObject({ clients: 6, bots: 0, seconds: 60, full: false, virtual: false });
    expect(a.link).toEqual({ delayMs: 50, jitterMs: 0, loss: 0, rtoMs: 200 });
    expect(a.settings).toMatchObject({ map: 'defilad', size: 'market', botCount: 0 });
    expect(parseSoakArgs(['--full']).seconds).toBe(a.settings.timeLimit);
    expect(parseSoakArgs(['--loss', '2', '--jitter', '10', '--latency', '75']).link).toEqual({
      delayMs: 75,
      jitterMs: 10,
      loss: 0.02,
      rtoMs: 200,
    });
    expect(parseSoakArgs(['--map', 'range']).settings.size).toBe('full');
  });

  it('refuses what the room would refuse, before anything is started', () => {
    // `--bots 6` used to pass here and fail in the room (a server was already forked by then).
    expect(() => parseSoakArgs(['--bots', '6'])).toThrow(/--bots: a whole number 0–5/);
    expect(parseSoakArgs(['--bots', '5']).settings.botCount).toBe(5);
    expect(() => parseSoakArgs(['--bots', '-1'])).toThrow(/--bots/);
    expect(() => parseSoakArgs(['--bots', '1.5'])).toThrow(/--bots/);
    expect(() => parseSoakArgs(['--clients', '0'])).toThrow(/--clients: a whole number 1–6/);
    expect(() => parseSoakArgs(['--clients', '7'])).toThrow(/--clients/);
    expect(() => parseSoakArgs(['--map', 'mars'])).toThrow(/--map/);
    expect(() => parseSoakArgs(['--size', 'huge'])).toThrow(/--map\/--size/);
    expect(() => parseSoakArgs(['--latency', 'fast'])).toThrow(/--latency/);
    expect(() => parseSoakArgs(['--loss', '150'])).toThrow(/--loss/);
  });

  it('--server must be host:port with a usable port', () => {
    expect(parseSoakArgs([]).server).toBeUndefined();
    expect(parseSoakArgs(['--server', '127.0.0.1:2567']).server).toEqual({
      host: '127.0.0.1',
      port: 2567,
    });
    expect(parseSoakArgs(['--server', 'play.example.test:443']).server).toEqual({
      host: 'play.example.test',
      port: 443,
    });
    expect(parseSoakArgs(['--server', '[::1]:2567']).server).toEqual({ host: '::1', port: 2567 });
    // A port out of range used to crash the proxy's upstream connect mid-run.
    for (const bad of ['127.0.0.1:70000', '127.0.0.1:0', '127.0.0.1', ':2567', 'host:port', '']) {
      expect(() => parseSoakArgs(['--server', bad]), bad).toThrow(/--server: expected host:port/);
    }
    expect(() => parseSoakArgs(['--server', 'http://127.0.0.1:2567'])).toThrow(/--server/);
  });
});

/** A stand-in for the proxy's worker thread. */
class FakeProxyWorker extends EventEmitter implements ProxyWorkerLike {
  posted: unknown[] = [];
  terminated = 0;
  /** Answer requests like the real worker (false: stay silent). */
  answers = true;
  postMessage(m: unknown): void {
    this.posted.push(m);
    if (!this.answers) return;
    const reply = m === 'stats' ? { chunks: 7 } : { stopped: true };
    queueMicrotask(() => this.emit('message', reply));
  }
  terminate(): Promise<number> {
    this.terminated++;
    return Promise.resolve(0);
  }
}

const startProxy = async (w: FakeProxyWorker, replyTimeoutMs = 3000): Promise<ProxyHandle> => {
  const starting = startProxyWorker(
    { host: '127.0.0.1', port: 1 },
    DEFAULT_LINK,
    DEFAULT_LINK,
    1,
    () => w,
    replyTimeoutMs,
  );
  w.emit('message', { port: 4242 });
  return starting;
};

describe('latency proxy worker handle', () => {
  it('a healthy worker answers stats and stop, and is terminated', async () => {
    const w = new FakeProxyWorker();
    const proxy = await startProxy(w);
    expect(proxy.port).toBe(4242);
    expect(await proxy.stats()).toEqual({ chunks: 7 });
    await proxy.stop();
    expect(w.posted).toEqual(['stats', 'stop']);
    expect(w.terminated).toBe(1);
    w.emit('exit', 1); // our own terminate: not a failure
    expect(proxy.failure).toBeNull();
  });

  it('a worker that died after announcing its port: stop() still settles', async () => {
    for (const die of [
      (w: FakeProxyWorker) => w.emit('error', new RangeError('Port should be >= 0 and < 65536')),
      (w: FakeProxyWorker) => w.emit('exit', 1),
    ]) {
      const w = new FakeProxyWorker();
      const proxy = await startProxy(w, 60_000); // the old stop() waited for a reply for ever
      die(w);
      expect(proxy.failure).toMatch(/Port should be|exited unexpectedly \(1\)/);
      expect(await proxy.stats()).toBeNull();
      await proxy.stop();
      expect(w.posted).toEqual([]); // nothing is asked of a dead worker
      expect(w.terminated).toBe(1);
    }
  });

  it('a worker that dies, or stays silent, while stop() waits: settled and terminated', async () => {
    const dying = new FakeProxyWorker();
    dying.answers = false;
    const a = await startProxy(dying, 60_000);
    const stopping = a.stop();
    dying.emit('exit', 1);
    await stopping;
    expect(dying.terminated).toBe(1);

    const silent = new FakeProxyWorker();
    silent.answers = false;
    const b = await startProxy(silent, 20);
    expect(await b.stats()).toBeNull();
    await b.stop();
    expect(silent.terminated).toBe(1);
  });

  it('a worker that dies before it listens rejects the start', async () => {
    const w = new FakeProxyWorker();
    const starting = startProxyWorker(
      { host: '127.0.0.1', port: 1 },
      DEFAULT_LINK,
      DEFAULT_LINK,
      1,
      () => w,
    );
    w.emit('error', new Error('listen EACCES'));
    await expect(starting).rejects.toThrow(/listen EACCES/);
  });

  it('a failed join with the proxy worker already dead: teardown completes, exit code 2', async () => {
    // The CLI's shape: server and proxy registered, then a client fails to join.
    const stopped: string[] = [];
    const w = new FakeProxyWorker();
    const teardown = new Teardown();
    const run = async (): Promise<number> => {
      try {
        teardown.add('server', () => void stopped.push('server'));
        const proxy = await startProxy(w, 60_000);
        teardown.add('proxy', () => proxy.stop());
        w.emit('exit', 1); // its upstream connect crashed it
        await Promise.reject(new Error('Soak 1: MatchmakeError: connection refused'));
        return 0;
      } catch {
        return 2;
      } finally {
        await teardown.run();
      }
    };
    expect(await run()).toBe(2);
    expect(stopped).toEqual(['server']); // the server's stop ran after the dead proxy's
    expect(w.terminated).toBe(1);
    expect(teardown.errors).toEqual([]);
  });

  it('an unusable upstream refuses the connection instead of crashing the proxy', async () => {
    const proxy = new LatencyProxy({ host: '127.0.0.1', port: 70000 }, DEFAULT_LINK, DEFAULT_LINK);
    const port = await proxy.listen();
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => {
      sock.once('close', () => resolve());
      sock.once('error', () => resolve());
    });
    // Still serving: a second connection is accepted (and refused the same way).
    const again = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => {
      again.once('close', () => resolve());
      again.once('error', () => resolve());
    });
    expect(proxy.stats().connections).toBe(2);
    await proxy.close();
  });
});

describe('teardown', () => {
  it('stops everything that was started, newest first, once, even when a step throws', async () => {
    const order: string[] = [];
    const t = new Teardown();
    t.add('server', () => void order.push('server'));
    t.add('proxy', () => {
      order.push('proxy');
      throw new Error('already closed');
    });
    t.add('client', async () => {
      await Promise.resolve();
      order.push('client');
    });
    await t.run();
    await t.run();
    expect(order).toEqual(['client', 'proxy', 'server']);
    expect(t.errors).toEqual(['proxy: Error: already closed']);
  });

  it('a step that never settles is abandoned after its timeout; the rest still stop', async () => {
    const order: string[] = [];
    const t = new Teardown(20);
    t.add('server', () => void order.push('server'));
    t.add('proxy', () => new Promise<void>(() => {})); // waits for a reply that never comes
    await t.run();
    expect(order).toEqual(['server']);
    expect(t.errors).toEqual(['proxy: Error: did not stop within 20 ms']);
  });

  it('runs when the body between start and stop rejects (the try/finally the CLI uses)', async () => {
    const stopped: string[] = [];
    const t = new Teardown();
    const run = async (): Promise<number> => {
      try {
        t.add('server', () => void stopped.push('server'));
        await Promise.reject(new Error('MatchmakeError: invalid match options'));
        return 0;
      } catch {
        return 2;
      } finally {
        await t.run();
      }
    };
    expect(await run()).toBe(2);
    expect(stopped).toEqual(['server']);
  });
});

const shot = (over: Partial<ShotRecord>): ShotRecord => ({
  seq: 0,
  localMs: 0,
  intent: 'aim',
  target: 'b',
  speed: 3,
  distance: 20,
  delayMs: 100,
  hits: ['b'],
  shielded: [],
  damaged: ['b'],
  blocked: [],
  excluded: null,
  ...over,
});

/** One server answer for a shot: damage (no outcome) or a block on a protected body. */
type Outcome = { target: string; outcome?: 'protected' };
const hurt = (...ids: string[]): Outcome[] => ids.map((target) => ({ target }));
const block = (...ids: string[]): Outcome[] =>
  ids.map((target) => ({ target, outcome: 'protected' }));

/**
 * A shot as `SoakClient` records and judges it: the pellets' bodies split by how they were drawn
 * (`onShot`), the server's answers gathered in the order given (`takeCombat`), then the verdict
 * (`judge`; the death-race and phase exclusions need a session and are left out).
 */
const play = (
  over: Partial<ShotRecord>,
  struck: readonly string[],
  drawnProtected: readonly string[],
  answers: readonly Outcome[],
): ShotRecord => {
  const got: ShotOutcomes = { damaged: new Set(), blocked: new Set() };
  for (const e of answers) noteOutcome(got, e.target, e.outcome);
  const s = shot({
    ...over,
    ...splitStruck(struck, new Set(drawnProtected)),
    damaged: sortedIds(got.damaged),
    blocked: sortedIds(got.blocked),
  });
  return { ...s, excluded: shotVerdict(s).protectedOnly ? 'target protected' : null };
};

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1
    ? [[...xs]]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
      );

describe('verdict', () => {
  const hits = Array.from({ length: 40 }, (_, i) => shot({ seq: i }));
  const clean = Array.from({ length: 99 }, (_, i) =>
    shot({ seq: 100 + i, intent: 'miss', hits: [], damaged: [] }),
  );
  const rates = [{ name: 'Soak 1', rate: 30 }];
  const miss = { intent: 'miss' as const };

  it('a deliberate miss seen clear but confirmed on a bystander is a false hit', () => {
    const bystander = shot({ seq: 999, intent: 'miss', hits: [], damaged: ['c'] });
    const onTarget = shot({ seq: 998, intent: 'miss', hits: [], damaged: ['b'] });
    const f = fairness([...hits, ...clean, bystander]);
    expect(f.missedPredictedClear).toBe(100);
    expect(f.missedFalseHits).toBe(1);
    expect(f.missedFalseHitsOnOthers).toBe(1);
    const both = fairness([...hits, ...clean, bystander, onTarget]);
    expect(both.missedFalseHits).toBe(2);
    expect(both.missedFalseHitsOnOthers).toBe(1);
    // 1 % is the limit: one in a hundred still passes, two in a hundred and one fail.
    expect(verdict(f, DEFAULT_THRESHOLDS, { snapshotRates: rates, errors: 0 })).toEqual([]);
    expect(verdict(both, DEFAULT_THRESHOLDS, { snapshotRates: rates, errors: 0 }).join()).toMatch(
      /false hits/,
    );
    // Bystander hits alone fail it too (they used to be invisible to the verdict).
    const two = fairness([...hits, ...clean.slice(0, 50), bystander, { ...bystander, seq: 997 }]);
    expect(two.missedFalseHits).toBe(2);
    expect(verdict(two, DEFAULT_THRESHOLDS, { snapshotRates: rates, errors: 0 }).join()).toMatch(
      /false hits 3\.8 % \(2\/52\)/,
    );
  });

  it('shots at spawn-protected bodies are blocked: neither hits nor misses nor false hits', () => {
    const shots = [
      ...hits,
      // Drawn protected and blocked by the server: both sides agree.
      play({ seq: 900 }, ['b'], ['b'], block('b')),
      // Shimmer not drawn yet (a predicted hit), the server blocked it.
      play({ seq: 901 }, ['b'], [], block('b')),
      // Drawn protected, but the protection had ended on the server: damage after all.
      play({ seq: 902 }, ['b'], ['b'], hurt('b')),
      // A deliberate miss that struck a protected bystander: blocked, not a false hit.
      play({ seq: 903, ...miss }, [], [], block('c')),
    ];
    const f = fairness(shots);
    expect(f.excluded).toEqual({ 'target protected': 4 });
    expect([f.aimedPredicted, f.aimedConfirmed]).toEqual([40, 40]); // untouched by the four
    expect([f.missed, f.missedFalseHits]).toEqual([0, 0]);
    expect(f).toMatchObject({
      protectedShots: 4,
      protectedDrawn: 2,
      protectedServer: 3,
      protectedBoth: 1,
      protectedDrawnButHit: 1,
    });
    expect(verdict(f, DEFAULT_THRESHOLDS, { snapshotRates: rates, errors: 0 })).toEqual([]);
  });

  it('a fan that damages someone is judged as that hit, even if also blocked elsewhere', () => {
    // A shotgun blast: damage on the predicted body, a pellet blocked on a protected bystander.
    const mixedHit = play({ seq: 800 }, ['b'], [], [...hurt('b'), ...block('c')]);
    // A deliberate miss that damaged someone while another pellet was blocked: a false hit.
    const mixedFalse = play({ seq: 801, ...miss }, [], [], [...hurt('d'), ...block('c')]);
    // A predicted hit that never came; the block on a bystander does not explain it.
    const unconfirmed = play({ seq: 802 }, ['b'], [], block('c'));
    expect([mixedHit, mixedFalse, unconfirmed].map((s) => s.excluded)).toEqual([null, null, null]);
    expect(shotVerdict(mixedHit)).toMatchObject({ confirmed: ['b'], exempt: ['c'] });
    expect(shotVerdict(mixedFalse)).toMatchObject({ falseHits: ['d'], exempt: ['c'] });
    expect(shotVerdict(unconfirmed)).toMatchObject({ unconfirmed: ['b'], exempt: ['c'] });
    // Protection alone: blocked on the predicted body; drawn protected (blocked, damaged once
    // its protection had ended, or untouched); a miss blocked on a bystander, no damage anywhere.
    for (const only of [
      play({}, ['b'], [], block('b')),
      play({}, ['b'], ['b'], block('b')),
      play({}, ['b'], ['b'], hurt('b')),
      play({}, ['b'], ['b'], []),
      play(miss, [], [], block('c')),
    ]) {
      expect(only.excluded, JSON.stringify(only)).toBe('target protected');
    }
    // Drawn protected on one body, damage on another: the damage still counts.
    expect(play({}, ['b'], ['b'], hurt('d')).excluded).toBeNull();

    const f = fairness([...hits, ...clean, mixedHit, mixedFalse, unconfirmed]);
    expect(f.excluded).toEqual({});
    expect([f.aimedPredicted, f.aimedConfirmed]).toEqual([42, 41]); // + the blast, − the no-show
    expect(f.missedPredictedClear).toBe(100);
    expect([f.missedFalseHits, f.missedFalseHitsOnOthers]).toEqual([1, 1]);
    // With fewer clean misses the same false hit fails the run (it used to vanish).
    const few = fairness([...hits, ...clean.slice(0, 20), mixedFalse]);
    expect(verdict(few, DEFAULT_THRESHOLDS, { snapshotRates: rates, errors: 0 }).join()).toMatch(
      /false hits 4\.8 % \(1\/21\)/,
    );
  });

  it('a fan with several outcomes is judged the same whatever order they arrive in', () => {
    /** The one record every arrival order (and pellet order) of a fan must give. */
    const fan = (
      over: Partial<ShotRecord>,
      struck: readonly string[],
      drawnProtected: readonly string[],
      answers: readonly Outcome[],
    ): ShotRecord => {
      const all = permutations(answers).flatMap((order) =>
        permutations(struck).map((pellets) => play(over, pellets, drawnProtected, order)),
      );
      for (const s of all) expect(s).toEqual(all[0]);
      return all[0] as ShotRecord;
    };
    // Drawn blocked on b; its protection ended in flight, and the blast damaged b and c. The
    // exemption covers b only: c is a hit the shooter never saw, whichever event came first.
    const falseHit = fan(miss, ['b'], ['b'], hurt('b', 'c'));
    expect(falseHit.excluded).toBeNull();
    expect(shotVerdict(falseHit)).toMatchObject({ falseHits: ['c'], exempt: ['b'] });
    const f = fairness([...hits, ...clean.slice(0, 20), falseHit]);
    expect([f.missedFalseHits, f.missedFalseHitsOnOthers]).toEqual([1, 1]);
    expect(verdict(f, DEFAULT_THRESHOLDS, { snapshotRates: rates, errors: 0 }).join()).toMatch(
      /false hits 4\.8 % \(1\/21\)/,
    );
    // Two bodies drawn protected, both out of protection by the server's resolve and both
    // damaged: protection timing twice over. Blocked, not a false hit on "the other one".
    const twoShielded = fan(miss, ['b', 'c', 'c'], ['b', 'c'], hurt('c', 'b'));
    expect(twoShielded).toMatchObject({ shielded: ['b', 'c'], excluded: 'target protected' });
    const g = fairness([...hits, ...clean.slice(0, 20), twoShielded]);
    expect([g.missedPredictedClear, g.missedFalseHits]).toEqual([20, 0]);
    expect(g).toMatchObject({ protectedShots: 1, protectedDrawn: 1, protectedDrawnButHit: 1 });
    expect(verdict(g, DEFAULT_THRESHOLDS, { snapshotRates: rates, errors: 0 })).toEqual([]);
    // …and a third body nobody drew in the line is still a false hit.
    expect(shotVerdict(fan(miss, ['b', 'c'], ['b', 'c'], hurt('c', 'd', 'b')))).toMatchObject({
      falseHits: ['d'],
      exempt: ['b', 'c'],
      protectedOnly: false,
    });
    // Two predicted hits: each is confirmed (or not) on its own.
    const twoHits = fan({}, ['b', 'c'], [], hurt('c'));
    expect(shotVerdict(twoHits)).toMatchObject({ confirmed: ['c'], unconfirmed: ['b'] });
    expect(fairness([twoHits])).toMatchObject({
      aimedPredicted: 1,
      aimedConfirmed: 0,
      aimedOtherConfirmed: 1,
    });
    // The predicted body among several damaged: the confirm, whoever was reported first.
    const crowd = fan({}, ['b'], [], [...hurt('a', 'b', 'c'), ...block('e', 'd')]);
    expect(shotVerdict(crowd)).toEqual({
      confirmed: ['b'],
      unconfirmed: [],
      falseHits: ['a', 'c'],
      exempt: ['d', 'e'],
      protectedOnly: false,
    });
    expect(fairness([crowd])).toMatchObject({ aimedPredicted: 1, aimedConfirmed: 1 });
    // Predicted b, only bystanders damaged: unconfirmed, and a hit on someone else.
    expect(fairness([fan({}, ['b'], [], hurt('d', 'c'))])).toMatchObject({
      aimedPredicted: 1,
      aimedConfirmed: 0,
      aimedOtherConfirmed: 1,
    });
    // A deliberate miss that damaged its target and a bystander: one false hit, also on others.
    expect(fairness([fan(miss, [], [], hurt('c', 'b'))])).toMatchObject({
      missedFalseHits: 1,
      missedFalseHitsOnOthers: 1,
    });
    // Blocked on the predicted body and on a bystander: protection explains the no-show.
    expect(fan({}, ['b'], [], block('c', 'b')).excluded).toBe('target protected');
    // The predicted body blocked while the same fan damaged d: the shot stays (a false hit on
    // d), and b is not an unfair miss: protection explains that body.
    const mixed = fan({}, ['b'], [], [...block('b'), ...hurt('d')]);
    expect(mixed.excluded).toBeNull();
    expect(fairness([mixed])).toMatchObject({ aimedPredicted: 0, aimedConfirmed: 0 });

    // Single-target outcomes are judged as before.
    expect(shotVerdict(play({}, ['b'], [], hurt('b')))).toMatchObject({ confirmed: ['b'] });
    expect(shotVerdict(play({}, ['b'], [], []))).toMatchObject({ unconfirmed: ['b'] });
    expect(shotVerdict(play({}, ['b'], [], hurt('c')))).toMatchObject({
      unconfirmed: ['b'],
      falseHits: ['c'],
    });
    expect(play(miss, [], [], []).excluded).toBeNull(); // a clean miss is a miss, not "blocked"
    expect(shotVerdict(play(miss, [], [], []))).toEqual({
      confirmed: [],
      unconfirmed: [],
      falseHits: [],
      exempt: [],
      protectedOnly: false,
    });
  });

  it('any fan: the verdict matches a per-body reference under every arrival order', () => {
    // mulberry32: a fixed seed, so a failure names a reproducible fan.
    let seed = 0x5eed;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number): number => Math.floor(rand() * n);
    const shuffle = <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    };
    const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const seen = { twoShieldedHurt: 0, excluded: 0, falseHit: 0, unconfirmed: 0, orders: 0 };

    for (let n = 0; n < 500; n++) {
      // 0–3 bodies struck unprotected, 0–3 struck drawn protected; the rest nobody drew in line.
      const ids = shuffle(pool);
      const hitIds = ids.slice(0, int(4));
      const shieldIds = ids.slice(hitIds.length, hitIds.length + int(4));
      // The server's answers: any body at all (the unexpected ones too), damaged and / or blocked.
      const answers = shuffle(
        pool.flatMap((id) => [
          ...(rand() < 0.35 ? hurt(id) : []),
          ...(rand() < 0.25 ? block(id) : []),
        ]),
      ).slice(0, 5);
      const damaged = answers.filter((e) => !e.outcome).map((e) => e.target);
      const blocked = answers.filter((e) => e.outcome).map((e) => e.target);
      const intent = rand() < 0.5 ? ('aim' as const) : ('miss' as const);
      const target = pool[int(pool.length)] as string;

      // The reference: each body classified on its own, straight from the generated sets.
      const ref = { confirmed: [] as string[], unconfirmed: [] as string[] };
      const refFalse: string[] = [];
      const refExempt: string[] = [];
      for (const id of pool) {
        const hurtIt = damaged.includes(id);
        const blockedIt = blocked.includes(id);
        if (hitIds.includes(id)) {
          if (hurtIt) ref.confirmed.push(id);
          else if (blockedIt) refExempt.push(id);
          else ref.unconfirmed.push(id);
        } else if (shieldIds.includes(id)) refExempt.push(id);
        else if (hurtIt) refFalse.push(id);
        else if (blockedIt) refExempt.push(id);
      }
      const refOnly =
        refExempt.length > 0 && ref.confirmed.length + ref.unconfirmed.length + refFalse.length < 1;

      // Every arrival order, each with the pellets (some bodies struck twice) in a fresh order.
      const pellets = [...hitIds, ...shieldIds, ...hitIds.slice(0, 1), ...shieldIds.slice(0, 1)];
      const orders = permutations(answers);
      const records = orders.map((order) =>
        play({ seq: n, intent, target }, shuffle(pellets), shieldIds, order),
      );
      const first = records[0] as ShotRecord;
      const label = JSON.stringify({ n, hitIds, shieldIds, answers, intent, target });
      expect(new Set(records.map((r) => JSON.stringify(r))).size, label).toBe(1);

      expect(shotVerdict(first), label).toEqual({
        confirmed: ref.confirmed,
        unconfirmed: ref.unconfirmed,
        falseHits: refFalse,
        exempt: refExempt,
        protectedOnly: refOnly,
      });
      expect(first.excluded, label).toBe(refOnly ? 'target protected' : null);

      // The run's figures for this one shot, from the same sets.
      const aimedAt = intent === 'aim' && !refOnly && hitIds.includes(target);
      const clear = !refOnly && hitIds.length === 0;
      expect(fairness([first]), label).toMatchObject({
        excluded: refOnly ? { 'target protected': 1 } : {},
        aimedPredicted: aimedAt && (damaged.includes(target) || !blocked.includes(target)) ? 1 : 0,
        aimedConfirmed: aimedAt && damaged.includes(target) ? 1 : 0,
        missedPredictedClear: intent === 'miss' && clear ? 1 : 0,
        missedFalseHits: intent === 'miss' && clear && refFalse.length ? 1 : 0,
        clearConfirmed: clear && refFalse.length ? 1 : 0,
        protectedShots: refOnly ? 1 : 0,
      });

      seen.orders += orders.length;
      seen.excluded += refOnly ? 1 : 0;
      seen.falseHit += refFalse.length ? 1 : 0;
      seen.unconfirmed += ref.unconfirmed.length ? 1 : 0;
      seen.twoShieldedHurt += shieldIds.filter((id) => damaged.includes(id)).length >= 2 ? 1 : 0;
    }
    // The generator reached the cases that matter (not 500 empty fans).
    expect(seen.orders).toBeGreaterThan(5000);
    for (const k of ['twoShieldedHurt', 'excluded', 'falseHit', 'unconfirmed'] as const) {
      expect(seen[k], k).toBeGreaterThan(10);
    }
  });

  it('every client must reach the snapshot rate: one starved client fails the run', () => {
    const f = fairness(hits);
    const seconds = 100;
    const five = Array.from({ length: 5 }, (_, i) =>
      stats({ name: `Soak ${i + 1}`, snapshots: 30 * seconds }),
    );
    const starved = stats({ name: 'Soak 6', snapshots: 15 * seconds });
    const t = clientTotals([...five, starved], seconds);
    expect(t.snapshotRate).toBeCloseTo(27.5, 6); // the pooled mean is above the 27/s limit…
    expect(t.snapshotRates.map((c) => c.rate)).toEqual([30, 30, 30, 30, 30, 15]);
    const fails = verdict(f, DEFAULT_THRESHOLDS, { snapshotRates: t.snapshotRates, errors: 0 });
    expect(fails).toEqual(['Soak 6: snapshot rate 15.0/s < 27/s']); // …the verdict is not
    const healthy = clientTotals(five, seconds);
    expect(
      verdict(f, DEFAULT_THRESHOLDS, { snapshotRates: healthy.snapshotRates, errors: 0 }),
    ).toEqual([]);
    expect(verdict(f, DEFAULT_THRESHOLDS, { snapshotRates: [], errors: 0 }).join()).toMatch(
      /no client reported/,
    );
  });
});
