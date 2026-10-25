import { Client, type Room } from '@colyseus/sdk';
import {
  type EndMatchMessage,
  type LobbyMessage,
  MATCH_NET,
  NET,
  ROOMS,
  sanitizeName,
  type CombatMessage,
  type DropMessage,
  type MatchOptions,
  type MatchPing,
  type MatchPong,
  type MatchStateMessage,
  type NameMessage,
  type RespawnMessage,
  type RosterMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@wd/shared';
import type { FriendRoomBuffer } from './friendLobby.ts';
import type { OnlineSession } from './onlineSession.ts';
import type { MatchRoomLink } from './roomLink.ts';

/**
 * When the page joins its match and under which name. The join waits for the first Play (the
 * menu, where the name is typed, is open until then), so the room hears the name the player
 * chose; a later edit is sent as a `name` message (once per change; the server sanitizes and
 * rate limits it too). Names are cleaned here the same way the server does (printable, at most
 * `MATCH_NET.maxNameLength` characters); an empty one keeps the current name.
 */
export class OnlineJoin {
  private started = false;
  /** The name the roster last confirmed for us. */
  private told = '';
  /** The latest non-empty menu name after joining. */
  private desired = '';
  /** The latest name sent and awaiting a roster echo. */
  private inFlight: string | null = null;
  private send: ((name: string) => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly join: (name: string) => void) {}

  get joined(): boolean {
    return this.started;
  }

  /** A friend lobby already joined the room before Game existed; Play should only resume/name it. */
  adoptJoined(name: string): void {
    this.started = true;
    this.told = sanitizeName(name, '');
    this.desired = this.told;
    this.pump();
  }

  /** Play pressed: join once, or submit the completed menu name when resuming. */
  start(name: string): void {
    if (this.started) {
      this.nameChanged(name);
      return;
    }
    this.started = true;
    this.told = sanitizeName(name, '');
    this.desired = this.told;
    this.join(this.told);
  }

  /** The room is joined: name changes go to it from now on. */
  attach(send: (name: string) => void): void {
    this.send = send;
    this.pump();
  }

  /** The roster echoed the server-accepted name. */
  serverName(name: string): void {
    const clean = sanitizeName(name, this.told);
    if (!this.desired) this.desired = clean;
    this.told = clean;
    if (clean === this.desired || clean === this.inFlight) {
      this.inFlight = null;
      this.clearRetry();
    }
    this.pump();
  }

  /** The name setting changed. Before the join it just rides along with it. */
  nameChanged(name: string): void {
    if (!this.started) return;
    const clean = sanitizeName(name, '');
    if (!clean) return;
    if (clean === this.desired) return;
    this.desired = clean;
    this.pump();
  }

  private pump(): void {
    if (!this.send || !this.desired || this.inFlight || this.desired === this.told) return;
    this.sendName(this.desired);
  }

  private sendName(name: string): void {
    this.inFlight = name;
    this.send?.(name);
    if (this.inFlight === name) this.armRetry();
  }

  private armRetry(): void {
    this.clearRetry();
    this.retry = setTimeout(() => {
      this.inFlight = null;
      this.pump();
    }, 1000 / MATCH_NET.nameRatePerSec);
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}

/**
 * Game server URL: `?server=` (host, host:port or a full http/https/ws/wss URL), else the
 * build-time `VITE_SERVER_URL`, else the page's host on the dev server port (2567). A bare host
 * gets the page's scheme: an https page may only open wss:// sockets (mixed content).
 */
export function resolveServerUrl(
  search: string,
  page: { protocol: string; hostname: string; host?: string },
  envUrl?: string,
  prod = false,
): string {
  const raw = new URLSearchParams(search).get('server')?.trim();
  if (raw) {
    const pageScheme = page.protocol === 'https:' ? 'https' : 'http';
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `${pageScheme}://${raw}`;
    try {
      const u = new URL(withScheme);
      if (['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && u.hostname) {
        // The SDK wants http(s) (it derives ws(s) itself for the socket).
        const scheme = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
        return `${scheme}//${u.host}`;
      }
    } catch {
      // not a URL: fall through to the default
    }
  }
  if (envUrl) return envUrl;
  const scheme = page.protocol === 'https:' ? 'https' : 'http';
  return prod
    ? `${scheme}://${page.host ?? page.hostname}`
    : `${scheme}://${page.hostname}:${NET.devServerPort}`;
}

/** Online mode: `?online` (or `?online=1`) turns it on for this page, `?online=0` off. */
export function onlineRequested(search: string, saved: boolean): boolean {
  const q = new URLSearchParams(search);
  if (!q.has('online')) return saved;
  const v = q.get('online');
  return v !== '0' && v !== 'false';
}

/**
 * The `online` setting to store. `?online` / `?online=0` only apply to the page they are on: a
 * shared `?online` link must not make every later plain visit start online, so an unchanged
 * value keeps what was saved; only a change made on this page (the checkbox) is persisted.
 */
export function onlineToSave(current: boolean, page: { online: boolean; saved: boolean }): boolean {
  return current === page.online ? page.saved : current;
}

/**
 * This page's online state and the saved preference behind it (for `onlineToSave`). `saved` is
 * the setting as loaded: a friend room forces the page online, and reading the preference after
 * that override would persist online:true on the next unrelated menu change.
 */
export function pageOnline(
  search: string,
  saved: boolean,
  friendRoom: boolean,
): { online: boolean; saved: boolean } {
  return { online: friendRoom || onlineRequested(search, saved), saved };
}

/** What the page needs of a joined room to leave it. */
export interface LeavableRoom {
  leave(consented?: boolean): Promise<unknown>;
}

/**
 * The page's hold on its match, so it can leave cleanly. A page that just closes (tab closed,
 * reload for a settings change) looks like a dropped connection: the server would keep a ghost
 * body, colour slot and roster entry for the 20 s reconnect window, and the reloaded page joins
 * as someone new (a 6-player room could even push friends into another match).
 */
export class OnlineLink {
  private room: LeavableRoom | null = null;
  private leaving = false;

  get left(): boolean {
    return this.leaving;
  }

  /**
   * `pageshow`: true when the page came back from the back/forward cache after `pagehide` left
   * the room. `left` is permanent and the join already happened, so this page can never play
   * online again: the caller reloads it (a fresh page joins as usual).
   */
  restoredFromCache(persisted: boolean): boolean {
    return persisted && this.leaving;
  }

  /** The joined room. After `leave` (the page is going away) it is left at once. */
  attach(room: LeavableRoom): void {
    if (this.leaving) void room.leave(true).catch(() => {});
    else this.room = room;
  }

  /**
   * Leave with consent. Resolves when the server confirmed or after `timeoutMs`, so a reload can
   * wait briefly for the leave to go out; on `pagehide` there is no waiting, the message is just
   * queued ahead of the socket's close.
   */
  leave(timeoutMs = 300): Promise<void> {
    this.leaving = true;
    const room = this.room;
    this.room = null;
    if (!room) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      room.leave(true).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function wireOnlineRoom(
  session: OnlineSession,
  link: OnlineLink,
  room: MatchRoomLink,
  buffer?: FriendRoomBuffer,
  /** A friend or practice room: its host may End match (quick-join rooms refuse it). */
  opts: { endMatch?: boolean } = {},
): void {
  link.attach(room);
  if (link.left) return;
  // Registered before the next socket message: the server's welcome/roster are held until the
  // client acknowledges the join, so none are missed. Friend lobbies may also pass messages that
  // arrived while the pre-game screen was up.
  room.onMessage('welcome', (w: WelcomeMessage) => session.handleWelcome(w));
  room.onMessage('roster', (r: RosterMessage) => session.handleRoster(r));
  room.onMessage('respawn', (m: RespawnMessage) => session.handleRespawn(m));
  room.onMessage('snap', (s: SnapshotMessage) => session.handleSnapshot(s, performance.now()));
  room.onMessage('combat', (m: CombatMessage) => session.handleCombat(m));
  room.onMessage('drop', (m: DropMessage) => session.handleDrops(m));
  room.onMessage('match', (m: MatchStateMessage) => session.handleMatch(m));
  room.onMessage('lobby', (m: LobbyMessage) => session.handleLobby(m));
  room.onMessage('ping', (m: MatchPing) => {
    const pong: MatchPong = { t: m.t };
    room.send('pong', pong);
    session.handlePing(m);
  });
  // The server keeps a dropped seat for 20 s: try to get back into it however soon after
  // joining the drop happens (the SDK's default refuses during the first 5 s).
  room.reconnection.minUptime = 0;
  room.onDrop(() => session.handleStatus({ state: 'reconnecting' }));
  room.onReconnect(() => session.handleStatus({ state: 'online' }));
  room.onLeave((code: number, reason?: string) =>
    session.handleStatus({
      state: 'offline',
      error: reason ? `${reason} (${code})` : `disconnected (${code})`,
    }),
  );
  session.attach({
    sendInputs: (msg) => room.send('input', msg),
    dropGun: (msg) => room.send('dropGun', msg),
    ...(opts.endMatch ? { endMatch: () => room.send('end', {} satisfies EndMatchMessage) } : {}),
  });
  buffer?.stop?.();
  if (buffer?.welcome) session.handleWelcome(buffer.welcome);
  if (buffer?.roster) session.handleRoster(buffer.roster);
  if (buffer?.match) session.handleMatch(buffer.match);
  if (buffer?.lobby) session.handleLobby(buffer.lobby);
  if (buffer?.respawn) session.handleRespawn(buffer.respawn);
  for (const msg of buffer?.combats ?? []) session.handleCombat(msg);
  for (const msg of buffer?.drops ?? []) session.handleDrops(msg);
  for (const snap of buffer?.snapshots ?? []) session.handleSnapshot(snap, performance.now());
  if (buffer) {
    buffer.combats.length = 0;
    buffer.snapshots.length = 0;
    if (buffer.drops) buffer.drops.length = 0;
  }
}

/**
 * Join (or create) a match with these options and wire the room to `session`. Retries with
 * back-off; the SDK itself reconnects a dropped socket into the same seat.
 */
export async function connectOnline(
  session: OnlineSession,
  link: OnlineLink,
  url: string,
  options: MatchOptions,
  attempts = 4,
): Promise<Room | null> {
  session.handleStatus({ state: 'connecting' });
  let lastError = '';
  for (let i = 0; i < attempts && !link.left; i++) {
    try {
      const room = await new Client(url).joinOrCreate(ROOMS.match, options);
      wireOnlineRoom(session, link, room);
      if (link.left) return null; // the page is going away: already left
      return room;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (i < attempts - 1) await sleep(500 * 2 ** i);
    }
  }
  session.handleStatus({ state: 'offline', error: lastError || 'could not join' });
  return null;
}

/** Send a name change to the joined room (see `OnlineJoin`). */
export function nameSender(room: Pick<MatchRoomLink, 'send'>): (name: string) => void {
  return (name) => {
    const msg: NameMessage = { name };
    room.send('name', msg);
  };
}
