/**
 * Web Worker entry for a practice match (bundled into the client by Vite: see
 * `client/src/net/practiceRoom.ts`). The page posts `{ type: 'init', init }`, then `{ type: 'run' }`
 * once its game is listening, then room messages (`{ type, msg }`) and `{ type: 'pause', msg:
 * { paused } }` (the menu is open: the match waits, like single player); the worker posts room
 * messages back (`{ type, msg }`), or `{ type: 'failed', error }`.
 */
import { initPhysics } from '@wd/shared';
import { startPacedLoop } from '../match/pacer.ts';
import { PRACTICE_LOOP, PracticeHost, type PracticeInit } from './practiceHost.ts';

/** The worker global (typed locally: the server project has no DOM / WebWorker lib). */
interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
}
const scope = globalThis as unknown as WorkerScope;

let host: PracticeHost | null = null;
let starting: Promise<void> | null = null;
let stopLoop: (() => void) | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
const early: { type: string; msg: unknown }[] = [];
/** The page wants the match running (`run`) and is not paused (`pause`). */
let wanted = false;
let paused = false;

const post = (type: string, msg: unknown): void => scope.postMessage({ type, msg });

function run(): void {
  if (!host || stopLoop || !wanted || paused) return;
  const h = host;
  stopLoop = startPacedLoop(PRACTICE_LOOP, (ticks, snapshot) => h.step(ticks, snapshot));
  pingTimer = setInterval(() => h.ping(performance.now()), PRACTICE_LOOP.pingIntervalMs);
}

function halt(): void {
  stopLoop?.();
  stopLoop = null;
  if (pingTimer !== null) clearInterval(pingTimer);
  pingTimer = null;
}

function stop(): void {
  halt();
  host?.dispose();
  host = null;
}

/** `run` / `pause` (they may arrive before the match is built: applied when it is). */
function control(type: string, msg: unknown): boolean {
  if (type === 'run') wanted = true;
  else if (type === 'pause') {
    paused = (msg as { paused?: unknown } | null)?.paused === true;
    if (paused) halt();
  } else return false;
  run();
  return true;
}

scope.onmessage = (e) => {
  const data = e.data as { type?: unknown; msg?: unknown; init?: PracticeInit } | null;
  const type = typeof data?.type === 'string' ? data.type : '';
  if (type === 'init' && data?.init && !starting) {
    const init = data.init;
    starting = (async () => {
      try {
        await initPhysics();
        host = new PracticeHost(
          { ...init, spawnSeed: init.spawnSeed ?? Math.floor(Math.random() * 0x100000000) },
          post,
        );
        for (const m of early.splice(0)) host.receive(m.type, m.msg, performance.now());
        run();
      } catch (err) {
        scope.postMessage({
          type: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return;
  }
  if (type === 'stop') {
    stop();
    return;
  }
  if (control(type, data?.msg)) return;
  if (!host) {
    early.push({ type, msg: data?.msg });
    return;
  }
  host.receive(type, data?.msg, performance.now());
};
