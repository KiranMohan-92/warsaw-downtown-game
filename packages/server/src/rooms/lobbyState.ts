import {
  MATCH_NET,
  parseMatchOptions,
  parseMatchSettingsUpdate,
  sanitizeName,
  TokenBucket,
  type LobbyMessage,
  type LobbyPlayer,
  type MatchOptions,
  type MatchSettings,
  type MatchSettingsUpdate,
} from '@wd/shared';

export interface LobbySeat {
  readonly id: string;
  name: string;
  connected: boolean;
  readonly joinedAt: number;
  readonly nameBucket: TokenBucket;
}

export interface LobbyState {
  phase: LobbyMessage['phase'];
  settings: MatchSettings;
  hostId: string | null;
  readonly seats: Map<string, LobbySeat>;
}

export type LobbyCommandResult =
  | { ok: true; message: LobbyMessage }
  | { ok: false; code: 'invalid-settings' | 'host-only' | 'already-started'; message: string };

export type LobbyStartResult =
  | { ok: true; settings: MatchSettings }
  | { ok: false; code: 'host-only' | 'already-started'; message: string };

export function createLobbyState(options: MatchOptions): LobbyState {
  return {
    phase: options.lobby ? 'lobby' : 'playing',
    settings: settingsFromOptions(options),
    hostId: null,
    seats: new Map(),
  };
}

export function settingsFromOptions(options: MatchOptions): MatchSettings {
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

export function lobbySettingsFromRaw(raw: unknown): MatchSettings | null {
  const parsed = parseMatchOptions(raw);
  return parsed ? settingsFromOptions(parsed) : null;
}

export function joinLobby(state: LobbyState, id: string, name: string, nowMs: number): LobbySeat {
  let seat = state.seats.get(id);
  if (!seat) {
    seat = {
      id,
      name,
      connected: true,
      joinedAt: nowMs,
      nameBucket: new TokenBucket(MATCH_NET.nameRatePerSec, MATCH_NET.nameBurst, nowMs),
    };
    state.seats.set(id, seat);
  } else {
    seat.name = name;
    seat.connected = true;
  }
  state.hostId ??= id;
  return seat;
}

export function setLobbyConnected(state: LobbyState, id: string, connected: boolean): void {
  const seat = state.seats.get(id);
  if (seat) seat.connected = connected;
}

export function renameLobbySeat(
  state: LobbyState,
  id: string,
  raw: string,
  nowMs: number,
): boolean {
  const seat = state.seats.get(id);
  if (!seat || !seat.nameBucket.take(nowMs)) return false;
  const name = sanitizeName(raw, seat.name);
  if (name === seat.name) return false;
  seat.name = name;
  return true;
}

export function removeLobbySeat(state: LobbyState, id: string): void {
  const wasHost = state.hostId === id;
  state.seats.delete(id);
  if (wasHost) state.hostId = oldestSeat(state)?.id ?? null;
}

export function updateLobbySettings(
  state: LobbyState,
  senderId: string,
  raw: unknown,
  roomId: string,
): LobbyCommandResult {
  if (state.phase !== 'lobby') {
    return { ok: false, code: 'already-started', message: 'match already started' };
  }
  if (senderId !== state.hostId) {
    return { ok: false, code: 'host-only', message: 'only the host can change settings' };
  }
  const patch = parseMatchSettingsUpdate(raw);
  if (!patch || Object.keys(patch).length === 0) {
    return { ok: false, code: 'invalid-settings', message: 'invalid lobby settings' };
  }
  state.settings = mergeSettings(state.settings, patch);
  return { ok: true, message: lobbyMessage(state, roomId) };
}

export function startLobby(
  state: LobbyState,
  senderId: string,
  roomId: string,
): LobbyCommandResult {
  const result = authorizeLobbyStart(state, senderId);
  if (!result.ok) return result;
  state.phase = 'playing';
  return { ok: true, message: lobbyMessage(state, roomId) };
}

export function authorizeLobbyStart(state: LobbyState, senderId: string): LobbyStartResult {
  if (state.phase !== 'lobby') {
    return { ok: false, code: 'already-started', message: 'match already started' };
  }
  if (senderId !== state.hostId) {
    return { ok: false, code: 'host-only', message: 'only the host can start the match' };
  }
  return { ok: true, settings: state.settings };
}

export function commitLobbyStart(state: LobbyState, roomId: string): LobbyCommandResult {
  state.phase = 'playing';
  return { ok: true, message: lobbyMessage(state, roomId) };
}

export function lobbyMessage(
  state: LobbyState,
  roomId: string,
  actualBots: readonly LobbyPlayer[] = [],
): LobbyMessage {
  return {
    roomId,
    hostId: state.hostId,
    phase: state.phase,
    settings: state.settings,
    players: [...lobbyPlayers(state), ...botPlayers(state, actualBots)],
  };
}

function lobbyPlayers(state: LobbyState): LobbyPlayer[] {
  return [...state.seats.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
}

function botPlayers(state: LobbyState, actualBots: readonly LobbyPlayer[]): LobbyPlayer[] {
  if (actualBots.length) return actualBots.map((p) => ({ ...p, bot: true }));
  if (state.phase !== 'lobby') return [];
  const humans = state.seats.size;
  const planned = Math.min(state.settings.botCount, Math.max(0, MATCH_NET.maxPlayers - humans));
  return Array.from({ length: planned }, (_, i) => ({
    id: `bot:pending:${i + 1}`,
    name: `Bot ${i + 1}`,
    connected: true,
    bot: true,
  }));
}

function oldestSeat(state: LobbyState): LobbySeat | undefined {
  return [...state.seats.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
}

function mergeSettings(current: MatchSettings, patch: MatchSettingsUpdate): MatchSettings {
  const next: MatchSettings = {
    ...current,
    ...patch,
  };
  if (next.map === 'range') next.size = 'full';
  next.botCount = Math.min(next.botCount, MATCH_NET.maxPlayers - 1);
  return next;
}
