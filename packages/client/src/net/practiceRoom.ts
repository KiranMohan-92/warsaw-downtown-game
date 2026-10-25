import type { MatchSettings, PrimaryId } from '@wd/shared';
import type { Settings } from '../settings/settings.ts';
import { resolveMapChoice } from '../game/mapChoice.ts';
import {
  friendSettingsFromGameSettings,
  gameRadarToMatchRadar,
  makeBuffer,
  type FriendRoomLaunch,
} from './friendLobby.ts';
import type { MatchRoomLink } from './roomLink.ts';

/** `onLeave` code of a practice match whose worker failed (1000 = left on purpose). */
export const PRACTICE_FAILED = 4000;

/** What the practice worker is started with (`server/src/practice/practiceHost.ts`). */
export interface PracticeInit {
  settings: MatchSettings;
  name: string;
  primary?: PrimaryId;
  allowDevTools?: boolean;
}

/** The worker (or a test double): structured messages both ways. */
export interface PracticePort {
  postMessage(data: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  terminate(): void;
}

/** Practice mode for this page: `?practice` (one click from the menu; never saved). */
export function practiceRequested(search: string): boolean {
  const q = new URLSearchParams(search);
  if (!q.has('practice')) return false;
  const v = q.get('practice');
  return v !== '0' && v !== 'false';
}

/** This page's URL with practice on or off (other parameters kept; online flags dropped). */
export function practiceUrl(href: string, on: boolean): string {
  const u = new URL(href);
  u.searchParams.delete('online');
  u.searchParams.delete('room');
  u.searchParams.delete('lobby');
  if (on) u.searchParams.set('practice', '1');
  else u.searchParams.delete('practice');
  return u.toString();
}

/**
 * The practice match's settings from the player's: their map, mode, bots and limits, FFA. The
 * page's URL map/size/radar (set by a map change, kept when storage is blocked) wins over the
 * saved settings, exactly as for the page's own map (`resolveMapChoice`).
 */
export function practiceSettings(s: Settings, search = ''): MatchSettings {
  const choice = resolveMapChoice(search, s, undefined);
  return {
    ...friendSettingsFromGameSettings({
      ...s,
      map: choice.map,
      mapSize: choice.size,
      radar: choice.radar,
    }),
    botBehaviour: 'ffa',
  };
}

/** The practice settings the menu changed since the match was launched (they need a restart). */
export function practiceChanges(s: Settings, launched: MatchSettings): string[] {
  const out: string[] = [];
  if (Math.max(1, s.botCount) !== Math.max(1, launched.botCount)) out.push('botCount');
  if (s.botDifficulty !== launched.botDifficulty) out.push('botDifficulty');
  if (s.scoreLimit !== launched.scoreLimit) out.push('scoreLimit');
  if (s.timeLimit !== launched.timeLimit) out.push('timeLimit');
  if (gameRadarToMatchRadar(s.radar) !== launched.radar) out.push('radar');
  if (s.vehicles !== launched.vehicles) out.push('vehicles');
  if (s.botChatter !== (launched.botChatter ?? 'on')) out.push('botChatter');
  return out;
}

/** A new practice match with the menu's settings: the URL carries its map/size/radar. */
export function practiceRestartUrl(href: string, s: Settings): string {
  const u = new URL(practiceUrl(href, true));
  u.searchParams.set('map', s.map);
  u.searchParams.set('size', s.mapSize);
  u.searchParams.set('radar', s.radar);
  return u.toString();
}

/**
 * A practice match vs bots, offline: the server's own `MatchSim` and behaviour-tree bots in a
 * Web Worker, behind the same message interface as an online room (`MatchRoomLink`). Messages the
 * game has no handler for yet (it registers them while it builds) wait in order and are delivered
 * once it does, asynchronously as a socket would. The worker's clock starts when the game listens
 * for snapshots, so nothing is simulated while the page is still setting up.
 */
export class PracticeRoom implements MatchRoomLink {
  readonly roomId = 'practice';
  readonly sessionId = 'you';
  readonly reconnection = { minUptime: 0 };
  /** Set when the worker failed to start the match. */
  error: string | null = null;
  private readonly handlers = new Map<string, Set<(msg: unknown) => void>>();
  private readonly queue: { type: string; msg: unknown }[] = [];
  private readonly leaveCbs: ((code: number, reason?: string) => void)[] = [];
  /** How the room ended (replayed to anyone who subscribes later), null while it runs. */
  private ended: { code: number; reason?: string } | null = null;
  private flushScheduled = false;
  private running = false;
  private left = false;

  constructor(
    private readonly port: PracticePort,
    init: PracticeInit,
  ) {
    port.onmessage = (e) => this.receive(e.data);
    port.postMessage({ type: 'init', init });
  }

  onMessage<T = unknown>(type: string, cb: (msg: T) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const handler = cb as (msg: unknown) => void;
    set.add(handler);
    if (type === 'snap' && !this.running && !this.left) {
      this.running = true;
      this.port.postMessage({ type: 'run' });
    }
    if (this.queue.length) this.scheduleFlush();
    return () => {
      set.delete(handler);
    };
  }

  send(type: string, msg?: unknown): void {
    if (this.left) return;
    this.port.postMessage({ type, msg });
  }

  leave(): Promise<number> {
    this.end(1000);
    return Promise.resolve(1000);
  }

  /** Close the room once: stop the worker and tell every subscriber (now or later) why. */
  private end(code: number, reason?: string): void {
    if (this.left) return;
    this.left = true;
    this.ended = reason ? { code, reason } : { code };
    this.port.postMessage({ type: 'stop' });
    this.port.terminate();
    for (const cb of this.leaveCbs.splice(0)) cb(code, reason);
  }

  /** No network: a practice room never drops or reconnects. */
  onDrop(): void {}
  onReconnect(): void {}

  /**
   * Called when the room ends; a room that already ended (a worker that failed before the game
   * was wired to it) tells a late subscriber at once, on a later turn.
   */
  onLeave(cb: (code: number, reason?: string) => void): void {
    const ended = this.ended;
    if (ended) setTimeout(() => cb(ended.code, ended.reason), 0);
    else this.leaveCbs.push(cb);
  }

  private receive(data: unknown): void {
    if (this.left) return;
    const d = data as { type?: unknown; msg?: unknown; error?: unknown } | null;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'failed') {
      this.error = typeof d.error === 'string' ? d.error : 'practice match failed';
      console.warn(`practice match: ${this.error}`);
      this.end(PRACTICE_FAILED, `practice match failed: ${this.error}`);
      return;
    }
    this.queue.push({ type: d.type, msg: d.msg });
    // Nothing waits for a handler that never comes (bounded, oldest first).
    if (this.queue.length > 256) this.queue.splice(0, this.queue.length - 256);
    if (!this.flushScheduled) this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      this.flush();
    }, 0);
  }

  /** Deliver queued messages that have a handler now, in arrival order; keep the rest. */
  private flush(): void {
    const keep: { type: string; msg: unknown }[] = [];
    for (const item of this.queue.splice(0)) {
      const set = this.handlers.get(item.type);
      if (!set?.size || this.left) {
        keep.push(item);
        continue;
      }
      for (const cb of [...set]) cb(item.msg);
    }
    this.queue.unshift(...keep);
  }
}

/** The practice worker: the server's match code, bundled by Vite into its own chunk. */
function practiceWorker(): PracticePort {
  const worker = new Worker(
    new URL('../../../server/src/practice/practiceWorker.ts', import.meta.url),
    { type: 'module', name: 'practice-match' },
  );
  const port: PracticePort = {
    onmessage: null,
    postMessage: (data) => worker.postMessage(data),
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (e: MessageEvent<unknown>) => port.onmessage?.({ data: e.data });
  // A script that fails to load or throws ends the match like a failed start.
  worker.onerror = (e) =>
    port.onmessage?.({ data: { type: 'failed', error: e.message || 'practice worker error' } });
  return port;
}

/**
 * Start a practice match for these settings: the room the game is built around (like a friend
 * room whose match already started, with no lobby screen).
 */
export function launchPractice(
  s: Settings,
  makePort: () => PracticePort = practiceWorker,
  search = '',
): FriendRoomLaunch & { room: PracticeRoom } {
  const settings = practiceSettings(s, search);
  const playerName = s.playerName.trim() || 'You';
  const room = new PracticeRoom(makePort(), {
    settings,
    name: playerName,
    primary: s.primary,
    allowDevTools: import.meta.env.DEV || new URLSearchParams(search).has('autotest'),
  });
  return { room, settings, buffer: makeBuffer(), playerName };
}
