import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Client, type Room } from '@colyseus/sdk';
import { ROOMS, SIM, type BotPersonalityId, type MapId, type MapSize } from '@wd/shared';
import {
  SoakClient,
  soakWorld,
  type ClientStats,
  type ShotRecord,
  type SoakClientOptions,
  type SoakWorld,
} from './soakClient.ts';
import { Reservoir } from './stats.ts';

/** How a client worker takes its seat ('join': by the room id `ClientHandle.join` sends). */
export type SeatJob =
  | { kind: 'create'; options: Record<string, unknown> }
  | { kind: 'join'; options: Record<string, unknown> }
  | { kind: 'quick'; options: Record<string, unknown> };

export interface ClientJob {
  soakClient: true;
  endpoint: string;
  name: string;
  seed: number;
  /** The client's bot personality (`SoakClientOptions.personality`). */
  personality?: BotPersonalityId;
  map: MapId;
  size: MapSize;
  seat: SeatJob;
  /** The soak's jetpack flyer (`SoakClientOptions.flyer`). */
  flyer?: boolean;
}

/** What a worker reports every second while it plays. */
export interface ClientStatus {
  type: 'status';
  /** Welcomed (in the match). */
  playing: boolean;
  phase: string | null;
  /** Shots judged since the last status. */
  shots: ShotRecord[];
  corrections: number;
  errors: number;
}

export interface ClientResult {
  stats: ClientStats;
  /** Gaps between this client's frames (ms): a stalled host shows here. */
  frameGaps: number[];
}

export type FromWorker =
  | { type: 'joined'; roomId: string }
  | ClientStatus
  | { type: 'result'; result: ClientResult }
  | { type: 'fatal'; error: string };

/**
 * One headless client in its own worker thread — its own event loop, like a player's own
 * machine: a slow frame of one client never delays another's frames, inputs or snapshot
 * handling. The worker joins with the Colyseus SDK, plays at 60 frames a second, and posts its
 * judged shots and figures back.
 */
export interface ClientHandle {
  /** The room this client sat down in (once it has); rejects if the worker fails first. */
  roomId: Promise<string>;
  /** Why this worker is gone (a fatal error, an uncaught exception, an unexpected exit). */
  readonly failure: string | null;
  /** A 'join' seat: the room to join (its world is built meanwhile, in parallel). */
  join(roomId: string): void;
  onStatus(cb: (s: ClientStatus) => void): void;
  /** The host starts the friend lobby's match. */
  start(): void;
  /**
   * End the run and collect the client's figures. Always settles: a worker that failed (before
   * or while finishing) or does not answer within `timeoutMs` yields a result whose only content
   * is that error, so the run reports it and ends instead of hanging.
   */
  finish(timeoutMs?: number): Promise<ClientResult>;
  /** Stop the worker now (teardown on a failed run). */
  terminate(): Promise<void>;
}

/** The part of `worker_threads.Worker` a handle needs (tests drive it with a fake). */
export interface WorkerLike {
  on(event: 'message', cb: (m: FromWorker) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  postMessage(m: unknown): void;
  terminate(): Promise<unknown>;
}

/** What a failed client contributes to the report: nothing but its error. */
function failedResult(name: string, error: string): ClientResult {
  return {
    stats: {
      name,
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
      errors: [error],
      kills: 0,
      deaths: 0,
    },
    frameGaps: [],
  };
}

/** How long `finish` waits for a worker's result before giving up on it (ms). */
const FINISH_TIMEOUT_MS = 15_000;

export function startClientWorker(
  job: Omit<ClientJob, 'soakClient'>,
  spawn: () => WorkerLike = () =>
    new Worker(new URL(import.meta.url), {
      workerData: { ...job, soakClient: true } satisfies ClientJob,
    }),
): ClientHandle {
  const worker = spawn();
  let status: ((s: ClientStatus) => void) | null = null;
  let failure: string | null = null;
  let result: ClientResult | null = null;
  let done = false; // the result is in, or we terminated it ourselves: an exit is expected
  let joined: (id: string) => void = () => {};
  let notJoined: (e: Error) => void = () => {};
  // Whoever waits in `finish` (at most one at a time is woken by a result or a failure).
  let wake: () => void = () => {};
  const fail = (error: string): void => {
    if (failure !== null || done) return;
    failure = `${job.name}: ${error}`;
    notJoined(new Error(failure)); // no effect once the seat was taken
    wake();
  };
  const roomId = new Promise<string>((resolve, reject) => {
    joined = resolve;
    notJoined = reject;
  });
  roomId.catch(() => {}); // the failure is also kept in `failure`: never an unhandled rejection
  worker.on('message', (m: FromWorker) => {
    if (m.type === 'joined') joined(m.roomId);
    else if (m.type === 'status') status?.(m);
    else if (m.type === 'result') {
      result = m.result;
      done = true;
      wake();
    } else fail(m.error);
  });
  worker.on('error', (e) => fail(`worker error: ${e.message}`));
  worker.on('exit', (code) => fail(`worker exited unexpectedly (${code})`));
  const terminate = async (): Promise<void> => {
    done = true;
    await worker.terminate().catch(() => {});
  };
  return {
    roomId,
    get failure() {
      return failure;
    },
    join: (id) => worker.postMessage({ join: id }),
    onStatus: (cb) => (status = cb),
    start: () => worker.postMessage('start'),
    terminate,
    finish: async (timeoutMs = FINISH_TIMEOUT_MS) => {
      if (failure === null && result === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            fail(`no result within ${timeoutMs} ms of finish`);
            resolve();
          }, timeoutMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
          worker.postMessage('finish');
        });
      }
      const out = result ?? failedResult(job.name, failure ?? `${job.name}: no result`);
      await terminate();
      return out;
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Take a seat with the Colyseus SDK and wire the room to a new `SoakClient`: every server
 * message to `receive`, drops/reconnects to the session status, and any unexpected leave or
 * error into `client.errors`. `roomId` is the room a 'join' seat joins.
 */
export async function seatClient(
  sdk: Client,
  world: SoakWorld,
  opts: SoakClientOptions,
  seat: SeatJob,
  roomId?: string,
): Promise<{ client: SoakClient; room: Room; leave(): Promise<void> }> {
  let room: Room | null = null;
  let leaving = false;
  const client = new SoakClient(world, { send: (t, m) => room?.send(t, m) }, opts);
  if (seat.kind === 'join' && roomId === undefined) throw new Error('join: no room id');
  const r =
    seat.kind === 'create'
      ? await sdk.create(ROOMS.match, seat.options)
      : seat.kind === 'join'
        ? await sdk.joinById(roomId!, seat.options)
        : await sdk.joinOrCreate(ROOMS.match, seat.options);
  room = r;
  r.reconnection.minUptime = 0;
  // Registered as soon as the join resolves: the SDK drops messages nobody listens for.
  r.onMessage('*', (type: string | number, payload: unknown) =>
    client.receive(String(type), payload, performance.now()),
  );
  r.onDrop((code) => {
    client.errors.push(`dropped (${code})`);
    client.setConnected(false);
  });
  r.onReconnect(() => client.setConnected(true));
  r.onLeave((code) => {
    if (!leaving) client.errors.push(`left unexpectedly (${code})`);
  });
  r.onError((code, message) => client.errors.push(`error ${code}: ${message ?? ''}`));
  return {
    client,
    room: r,
    leave: async () => {
      leaving = true;
      await r.leave().catch(() => {});
    },
  };
}

async function runWorker(job: ClientJob): Promise<void> {
  const port = parentPort!;
  let joinId: ((id: string) => void) | null = null;
  const roomToJoin = new Promise<string>((resolve) => (joinId = resolve));
  let finishing = false;
  let startMatch = (): void => {};
  port.on('message', (m: unknown) => {
    if (m === 'start') startMatch();
    else if (m === 'finish') finishing = true;
    else if (typeof m === 'object' && m && 'join' in m) joinId?.(String(m.join));
  });
  const world = await soakWorld(job.map, job.size);
  const s = job.seat;
  const seated = await seatClient(
    new Client(job.endpoint),
    world,
    {
      name: job.name,
      seed: job.seed,
      ...(job.personality ? { personality: job.personality } : {}),
      ...(job.flyer ? { flyer: true } : {}),
    },
    s,
    s.kind === 'join' ? await roomToJoin : undefined,
  );
  const { client, room: r } = seated;
  startMatch = () => r.send('start', {});
  port.postMessage({ type: 'joined', roomId: r.roomId } satisfies FromWorker);

  // 60 frames a second on the wall clock (the timer grid permitting), like a 60 Hz display.
  const frameMs = 1000 / SIM.tickHz;
  const gaps = new Reservoir();
  let next = performance.now();
  let last: number | null = null;
  let posted = 0;
  let lastStatus = performance.now();
  while (!finishing) {
    const now = performance.now();
    if (now >= next) {
      if (last !== null && client.state) gaps.push(now - last);
      last = now;
      try {
        client.frame(now);
      } catch (err) {
        client.errors.push(`frame threw: ${String(err)}`);
      }
      next = now - next > 100 ? now + frameMs : next + frameMs;
    }
    if (now - lastStatus >= 1000) {
      lastStatus = now;
      const shots = client.judged.slice(posted);
      posted = client.judged.length;
      port.postMessage({
        type: 'status',
        playing: client.state !== null,
        phase: client.session.match?.phase ?? null,
        shots,
        corrections: client.corrections,
        errors: client.errors.length,
      } satisfies FromWorker);
    }
    await sleep(Math.max(0, Math.floor(next - performance.now()) - 1));
  }
  client.finish(performance.now());
  const result: ClientResult = { stats: client.stats(), frameGaps: [...gaps.values] };
  await seated.leave();
  port.postMessage({ type: 'result', result } satisfies FromWorker);
}

const job = workerData as ClientJob | null;
if (!isMainThread && job?.soakClient) {
  runWorker(job).catch((err: unknown) =>
    parentPort?.postMessage({ type: 'fatal', error: String(err) } satisfies FromWorker),
  );
}
