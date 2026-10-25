import { Client } from '@colyseus/sdk';
import {
  MATCH_NET,
  MATCH_SCORE_LIMITS,
  MATCH_TIME_LIMITS,
  parseMatchSettingsUpdate,
  UNLIMITED,
  type MatchScoreLimit,
  type MatchTimeLimit,
  type MatchPing,
  type MatchPong,
  sanitizeName,
  ROOMS,
  normalizeMatchOptions,
  parseMatchOptions,
  type ChatMessage,
  type CombatMessage,
  type DropMessage,
  type LobbyMessage,
  type MatchSettings,
  type MatchSettingsUpdate,
  type MatchStateMessage,
  type RespawnMessage,
  type RosterMessage,
  type SnapshotMessage,
  type WelcomeMessage,
  type PrimaryId,
} from '@wd/shared';
import type { Settings } from '../settings/settings.ts';
import type { ChatMode } from '../hud/ChatFeed.ts';
import { LobbyChat } from '../ui/LobbyChat.ts';
import { resolveServerUrl } from './connectOnline.ts';
import type { MatchRoomLink } from './roomLink.ts';

export type FriendMatchSettings = MatchSettings;
export type FriendLobbyPlayer = LobbyMessage['players'][number];
export type FriendLobbyState = LobbyMessage;

export interface FriendRoomBuffer {
  stop?: () => void;
  welcome: WelcomeMessage | null;
  roster: RosterMessage | null;
  match: MatchStateMessage | null;
  /** The last lobby update (who hosts: the End match control). */
  lobby?: LobbyMessage | null;
  respawn: RespawnMessage | null;
  snapshots: SnapshotMessage[];
  combats: CombatMessage[];
  drops?: DropMessage[];
  /** Chat since the match started, while the game builds (`bufferPregameChat`). */
  chats?: ChatMessage[];
}

export interface FriendRoomLaunch {
  room: MatchRoomLink;
  settings: FriendMatchSettings;
  buffer: FriendRoomBuffer;
  playerName: string;
}

type FriendLobbyMode = 'create' | 'join';

export const DEFAULT_FRIEND_SETTINGS: FriendMatchSettings = settingsFromOptions(
  normalizeMatchOptions({ map: 'defilad', size: 'market', mode: 'standard', lobby: true }),
);

export function gameRadarToMatchRadar(radar: Settings['radar']): FriendMatchSettings['radar'] {
  return radar === 'pickups' ? 'uplinks' : 'off';
}

export function matchRadarToGameRadar(radar: FriendMatchSettings['radar']): Settings['radar'] {
  return radar === 'uplinks' ? 'pickups' : 'off';
}

export function friendLobbyMode(search: string): FriendLobbyMode | null {
  const q = new URLSearchParams(search);
  if (q.has('room')) return 'join';
  const v = q.get('lobby');
  return v === 'create' || v === 'host' ? 'create' : null;
}

export function roomCodeFromSearch(search: string): string | null {
  const code = new URLSearchParams(search).get('room')?.trim();
  return code || null;
}

export function friendSettingsFromGameSettings(settings: Settings): FriendMatchSettings {
  return normalizeFriendSettings({
    ...DEFAULT_FRIEND_SETTINGS,
    map: settings.map,
    size: settings.mapSize,
    mode: settings.matchMode,
    weather: settings.weather,
    radar: gameRadarToMatchRadar(settings.radar),
    botCount: settings.botCount,
    botDifficulty: settings.botDifficulty,
    scoreLimit: settings.scoreLimit,
    timeLimit: settings.timeLimit,
    vehicles: settings.vehicles,
    botChatter: settings.botChatter,
  });
}

export function normalizeFriendSettings(raw: Partial<FriendMatchSettings>): FriendMatchSettings {
  const parsed = parseMatchOptions({ ...DEFAULT_FRIEND_SETTINGS, ...raw, lobby: true });
  return parsed ? settingsFromOptions(parsed) : DEFAULT_FRIEND_SETTINGS;
}

export function friendRoomOptions(
  settings: FriendMatchSettings,
  name: string,
  primary?: PrimaryId,
): ReturnType<typeof normalizeMatchOptions> {
  return normalizeMatchOptions({
    ...settings,
    lobby: true,
    name,
    ...(primary ? { primary } : {}),
  });
}

export function shareRoomUrl(href: string, roomId: string): string {
  const u = new URL(href);
  u.searchParams.delete('online');
  u.searchParams.delete('lobby');
  u.searchParams.set('room', roomId);
  return u.toString();
}

/**
 * Combat messages kept while the game builds after the match started (`Game.create` can take
 * many seconds on integrated GPUs): every one since the welcome (grenades in flight, kills for
 * the feed), bounded only by age and a generous count.
 */
export const PREGAME_COMBAT_MAX_AGE_MS = 30_000;
export const PREGAME_COMBAT_MAX_MESSAGES = 512;

/** Append `msg` (received at `nowMs`) and drop only what is past the age or count bound. */
export function bufferPregameCombat(
  combats: CombatMessage[],
  times: number[],
  msg: CombatMessage,
  nowMs: number,
): void {
  combats.push(msg);
  times.push(nowMs);
  let drop = Math.max(0, combats.length - PREGAME_COMBAT_MAX_MESSAGES);
  while (drop < times.length && nowMs - times[drop]! > PREGAME_COMBAT_MAX_AGE_MS) drop++;
  if (drop > 0) {
    combats.splice(0, drop);
    times.splice(0, drop);
  }
}

/** Lines kept across the lobby → game handoff, at most (the newest). */
export const PREGAME_CHAT_MAX = 20;

/** Keep `msg` for the game, dropping the oldest beyond `PREGAME_CHAT_MAX`. */
export function bufferPregameChat(chats: ChatMessage[], msg: ChatMessage): void {
  chats.push(msg);
  if (chats.length > PREGAME_CHAT_MAX) chats.splice(0, chats.length - PREGAME_CHAT_MAX);
}

export const makeBuffer = (): FriendRoomBuffer => ({
  stop: undefined,
  welcome: null,
  roster: null,
  match: null,
  lobby: null,
  respawn: null,
  snapshots: [],
  combats: [],
  chats: [],
});

export async function runFriendLobby(args: {
  parent: HTMLElement;
  search: string;
  href: string;
  page: { protocol: string; hostname: string; host?: string };
  envUrl?: string;
  prod: boolean;
  name: string;
  primary?: PrimaryId;
  settings: FriendMatchSettings;
  /** Menu › HUD › Chat (the lobby's chat follows it). */
  chatMode?: ChatMode;
}): Promise<FriendRoomLaunch | null> {
  const mode = friendLobbyMode(args.search);
  if (!mode) return null;
  const url = resolveServerUrl(args.search, args.page, args.envUrl, args.prod);
  const roomCode = roomCodeFromSearch(args.search);
  const chatMode = args.chatMode ?? 'all';
  const screen = new FriendLobbyScreen(args.parent, () => chatMode);
  screen.setStatus(mode === 'create' ? 'Creating room...' : `Joining ${roomCode ?? 'room'}...`);
  const client = new Client(url);
  const options = friendRoomOptions(args.settings, args.name, args.primary);
  try {
    const room =
      mode === 'create'
        ? await client.create(ROOMS.match, options)
        : roomCode
          ? await client.joinById(roomCode, options)
          : null;
    if (!room) {
      screen.showFailure('Room code missing.');
      return await keepLobbyOpen();
    }
    return await screen.run(room, args.href, args.settings, args.name);
  } catch (err) {
    screen.showFailure(err instanceof Error ? err.message : String(err));
    return await keepLobbyOpen();
  }
}

function keepLobbyOpen(): Promise<never> {
  return new Promise(() => {});
}

function settingsFromOptions(
  options: ReturnType<typeof normalizeMatchOptions>,
): FriendMatchSettings {
  return {
    map: options.map,
    size: options.size,
    mode: options.mode,
    weather: options.weather,
    radar: options.radar,
    botCount: options.botCount,
    botBehaviour: options.botBehaviour,
    botDifficulty: options.botDifficulty,
    scoreLimit: options.scoreLimit,
    timeLimit: options.timeLimit,
    vehicles: options.vehicles,
    ...(options.botChatter ? { botChatter: options.botChatter } : {}),
  };
}

class FriendLobbyScreen {
  private readonly root = document.createElement('div');
  private status = document.createElement('div');
  private readonly code = document.createElement('input');
  private readonly name = document.createElement('input');
  private roster = document.createElement('div');
  private form = document.createElement('div');
  private readonly start = document.createElement('button');
  private state: FriendLobbyState | null = null;
  private readonly chat: LobbyChat;

  constructor(parent: HTMLElement, chatMode: () => ChatMode = () => 'all') {
    this.root.className = 'friend-lobby';
    this.root.innerHTML = `
      <section class="friend-lobby-panel">
        <h1>Warsaw Downtown</h1>
        <p class="friend-lobby-status"></p>
        <label class="friend-lobby-share">
          <span>Room link</span>
        </label>
        <label class="friend-lobby-name">
          <span>Your name</span>
        </label>
        <div class="friend-lobby-form"></div>
        <div class="friend-lobby-roster"></div>
        <div class="friend-lobby-chat-host"></div>
        <div class="friend-lobby-actions"></div>
      </section>`;
    this.status = this.root.querySelector('.friend-lobby-status')!;
    this.form = this.root.querySelector('.friend-lobby-form')!;
    this.roster = this.root.querySelector('.friend-lobby-roster')!;
    const share = this.root.querySelector('.friend-lobby-share')!;
    this.code.readOnly = true;
    this.code.dataset.testid = 'room-link';
    share.append(this.code);
    const name = this.root.querySelector('.friend-lobby-name')!;
    this.name.maxLength = MATCH_NET.maxNameLength;
    this.name.placeholder = 'Player';
    this.name.dataset.testid = 'lobby-name';
    name.append(this.name);
    const actions = this.root.querySelector('.friend-lobby-actions')!;
    this.start.className = 'btn primary';
    this.start.textContent = 'Start match';
    this.start.dataset.testid = 'start-room';
    actions.append(this.start);
    this.chat = new LobbyChat(this.root.querySelector('.friend-lobby-chat-host')!, {
      mode: chatMode,
    });
    parent.append(this.root);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  run(
    room: MatchRoomLink,
    href: string,
    initial: FriendMatchSettings,
    initialName = '',
  ): Promise<FriendRoomLaunch> {
    room.reconnection.minUptime = 0;
    const buffer = makeBuffer();
    const stops: (() => void)[] = [];
    let settled = false;
    let lobbySeen = false;
    let settings = initial;
    let playerName = sanitizeName(initialName, 'Player');
    const fallback = (): FriendLobbyState => ({
      roomId: room.roomId,
      hostId: room.sessionId,
      phase: 'lobby',
      settings,
      players: [],
    });
    const launch = (resolve: (v: FriendRoomLaunch) => void): void => {
      if (settled) return;
      settled = true;
      this.root.remove();
      resolve({ room, settings, buffer, playerName });
    };
    this.code.value = shareRoomUrl(href, room.roomId);
    this.code.addEventListener('focus', () => this.code.select());
    this.name.value = playerName;
    this.name.addEventListener('change', () => room.send('name', { name: this.name.value }));
    return new Promise<FriendRoomLaunch>((resolve) => {
      const maybeLaunch = (): void => {
        if (!lobbySeen || (this.state?.phase === 'playing' && buffer.welcome)) launch(resolve);
      };
      buffer.stop = () => {
        for (const stop of stops.splice(0)) stop();
        buffer.stop = undefined;
      };
      const update = (next: LobbyMessage): void => {
        lobbySeen = true;
        buffer.lobby = next;
        settings = next.settings;
        const self = next.players.find((p) => p.id === room.sessionId && !p.bot);
        if (self) {
          playerName = self.name;
          if (document.activeElement !== this.name) this.name.value = self.name;
        }
        this.state = next;
        this.render(room);
        maybeLaunch();
      };
      stops.push(room.onMessage('lobby', update));
      stops.push(this.chat.attach(room));
      // From the start of the match until the game takes over, lines are kept for it (the bots'
      // greeting lands while integrated GPUs are still compiling shaders).
      stops.push(
        room.onMessage('chat', (m: ChatMessage) => {
          if (buffer.welcome) bufferPregameChat((buffer.chats ??= []), m);
        }),
      );
      stops.push(
        room.onMessage('lobbyError', (raw: { message?: string }) => {
          this.setStatus(raw.message ?? 'Lobby command refused.');
        }),
      );
      stops.push(
        room.onMessage('ping', (m: MatchPing) => {
          const pong: MatchPong = { t: m.t };
          room.send('pong', pong);
        }),
      );
      stops.push(
        room.onMessage('welcome', (m: WelcomeMessage) => {
          buffer.welcome = m;
          settings = normalizeFriendSettings({
            ...settings,
            map: m.map,
            size: m.size,
            mode: m.mode,
          });
          maybeLaunch();
        }),
      );
      stops.push(room.onMessage('roster', (m: RosterMessage) => (buffer.roster = m)));
      stops.push(room.onMessage('match', (m: MatchStateMessage) => (buffer.match = m)));
      stops.push(room.onMessage('respawn', (m: RespawnMessage) => (buffer.respawn = m)));
      stops.push(
        room.onMessage('snap', (m: SnapshotMessage) => {
          buffer.snapshots.push(m);
          if (buffer.snapshots.length > 4) buffer.snapshots.shift();
        }),
      );
      const combatTimes: number[] = [];
      stops.push(
        room.onMessage('drop', (m: DropMessage) => {
          if (!buffer.welcome) return;
          const drops = (buffer.drops ??= []);
          drops.push(m);
          if (drops.length > 32) drops.shift();
        }),
      );
      stops.push(
        room.onMessage('combat', (m: CombatMessage) => {
          // Only the match's own events: nothing before our welcome belongs to this game.
          if (!buffer.welcome) return;
          bufferPregameCombat(buffer.combats, combatTimes, m, performance.now());
        }),
      );
      const onPageHide = (): void => void room.leave(true).catch(() => {});
      window.addEventListener('pagehide', onPageHide);
      stops.push(() => window.removeEventListener('pagehide', onPageHide));
      room.onDrop(() => this.setStatus('Connection dropped; reconnecting...'));
      room.onReconnect(() =>
        this.setStatus(this.state?.phase === 'playing' ? 'Starting match...' : 'Reconnected.'),
      );
      room.onLeave((code) => {
        if (!settled) this.showFailure(`Disconnected (${code}).`);
      });
      this.start.onclick = () => {
        room.send('start', {});
        this.setStatus('Starting match...');
      };
      update(fallback());
    });
  }

  showFailure(message: string): void {
    this.setStatus(message);
    this.form.replaceChildren();
    this.roster.replaceChildren();
    this.start.textContent = 'Back to menu';
    this.start.disabled = false;
    this.start.onclick = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      url.searchParams.delete('lobby');
      window.location.replace(url.toString());
    };
  }

  private render(room: MatchRoomLink): void {
    const state = this.state;
    if (!state) return;
    const host = state.hostId === room.sessionId;
    this.setStatus(host ? 'You are the host.' : 'Waiting for the host to start.');
    this.roster.replaceChildren(
      ...state.players.map((p) => {
        const el = document.createElement('div');
        el.className = 'friend-lobby-player';
        el.textContent = `${p.bot ? '[BOT] ' : ''}${p.name}${p.connected ? '' : ' (away)'}`;
        if (!p.bot && p.id !== room.sessionId) {
          const mute = document.createElement('button');
          mute.className = 'btn small friend-lobby-mute';
          mute.dataset.testid = 'lobby-mute';
          const label = (): string => (this.chat.isMuted(p.name) ? 'Unmute' : 'Mute');
          mute.textContent = label();
          mute.addEventListener('click', () => {
            this.chat.toggleMute(p.name);
            mute.textContent = label();
          });
          el.append(' ', mute);
        }
        return el;
      }),
    );
    this.start.disabled = !host;
    this.renderSettings(state.settings, host, room);
  }

  private renderSettings(
    settings: FriendMatchSettings,
    enabled: boolean,
    room: MatchRoomLink,
  ): void {
    this.form.replaceChildren(
      select('map', 'Map', settings.map, [
        ['defilad', 'Plac Defilad'],
        ['range', 'Test range'],
      ]),
      select('size', 'Size', settings.size, [
        ['market', 'Market'],
        ['full', 'Full block'],
        ['north', 'North half'],
        ['south', 'South half'],
      ]),
      select('mode', 'Mode', settings.mode, [
        ['standard', 'Standard'],
        ['knife', 'Knife-only'],
      ]),
      select('weather', 'Weather', settings.weather, [
        ['golden', 'Golden hour'],
        ['sunny', 'Sunny'],
        ['overcast', 'Overcast'],
        ['rain', 'Rain'],
        ['dusk', 'Dusk'],
      ]),
      select('radar', 'Radar', settings.radar, [
        ['uplinks', 'Uplinks'],
        ['off', 'Off'],
      ]),
      numeric('botCount', 'Bots', settings.botCount, 0, MATCH_NET.maxPlayers - 1, 1),
      select('botBehaviour', 'Bot behaviour', settings.botBehaviour, [
        ['ffa', 'Fair FFA'],
        ['hunt-humans', 'Hunt humans'],
      ]),
      select('botDifficulty', 'Bot difficulty', settings.botDifficulty, [
        ['easy', 'Easy'],
        ['normal', 'Normal'],
        ['hard', 'Hard'],
      ]),
      select(
        'scoreLimit',
        'Score limit',
        String(settings.scoreLimit),
        limitOptions(MATCH_SCORE_LIMITS, settings.scoreLimit, scoreLimitLabel),
      ),
      select(
        'timeLimit',
        'Time limit',
        String(settings.timeLimit),
        limitOptions(MATCH_TIME_LIMITS, settings.timeLimit, timeLimitLabel),
      ),
      select('vehicles', 'Vehicles (armored trucks)', settings.vehicles, [
        ['on', 'On'],
        ['off', 'Off'],
      ]),
      select('botChatter', 'Bot chatter', settings.botChatter ?? 'on', [
        ['on', 'On — bots trash-talk (PG-13)'],
        ['off', 'Off'],
      ]),
    );
    for (const input of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input,select',
    )) {
      input.disabled = !enabled;
      input.addEventListener('change', () => {
        if (!enabled) return;
        const key = input.dataset.key as keyof MatchSettingsUpdate | undefined;
        if (!key) return;
        const patch = lobbySettingsPatch(key, input.value);
        if (patch) room.send('settings', patch);
      });
    }
  }
}

/** Score limit as the menus show it ("25", "Unlimited"). */
export const scoreLimitLabel = (v: MatchScoreLimit): string =>
  v === UNLIMITED ? 'Unlimited' : String(v);
/** Time limit as the menus show it ("10 min", "Unlimited"). */
export const timeLimitLabel = (v: MatchTimeLimit): string =>
  v === UNLIMITED ? 'Unlimited' : `${Math.round(v / 6) / 10} min`;

/** Menu options for a limit: the presets, plus the current value if it is not one of them. */
export function limitOptions<T extends MatchScoreLimit | MatchTimeLimit>(
  presets: readonly T[],
  current: T,
  label: (v: T) => string,
): [string, string][] {
  const values = presets.includes(current) ? presets : [...presets, current];
  return values.map((v) => [String(v), label(v)]);
}

/** A form value as a host settings patch, through the server's own schema (null: invalid). */
export function lobbySettingsPatch(
  key: keyof MatchSettingsUpdate,
  value: string,
): MatchSettingsUpdate | null {
  const numeric = key === 'botCount' || key === 'scoreLimit' || key === 'timeLimit';
  const raw = numeric && value !== UNLIMITED ? Number(value) : value;
  return parseMatchSettingsUpdate({ [key]: raw });
}

function row(label: string, input: HTMLInputElement | HTMLSelectElement): HTMLLabelElement {
  const el = document.createElement('label');
  el.className = 'friend-lobby-row';
  const span = document.createElement('span');
  span.textContent = label;
  el.append(span, input);
  return el;
}

function select(
  key: keyof FriendMatchSettings,
  label: string,
  value: string,
  options: [string, string][],
): HTMLLabelElement {
  const input = document.createElement('select');
  input.dataset.key = key;
  for (const [v, text] of options) input.add(new Option(text, v));
  input.value = value;
  return row(label, input);
}

function numeric(
  key: keyof FriendMatchSettings,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
): HTMLLabelElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.dataset.key = key;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return row(label, input);
}
