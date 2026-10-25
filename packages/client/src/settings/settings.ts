/**
 * Player settings (per-browser, localStorage). Units follow shooter conventions so players can
 * carry their numbers over: Source-style sensitivity (0.022°/count) and horizontal FOV at 16:9.
 */

import {
  MATCH_BOT_CHATTER,
  MATCH_BOT_DIFFICULTIES,
  MATCH_NET,
  PRIMARY_IDS,
  UNLIMITED,
  type MatchScoreLimit,
  type MatchTimeLimit,
  type PrimaryId,
} from '@wd/shared';

/** Rebindable actions. `reserved` ones are shown in the menu but arrive in later milestones. */
export const ACTIONS = {
  forward: { label: 'Move forward' },
  back: { label: 'Move back' },
  left: { label: 'Strafe left' },
  right: { label: 'Strafe right' },
  sprint: { label: 'Sprint (double-tap: tactical sprint; + Crouch = low run)' },
  crouch: { label: 'Crouch' },
  prone: { label: 'Prone (lie down / get up)' },
  jump: { label: 'Jump' },
  fire: { label: 'Fire' },
  ads: { label: 'Aim down sights' },
  reload: { label: 'Reload' },
  primary: { label: 'Rifle' },
  secondary: { label: 'Sidearm' },
  knife: { label: 'Knife' },
  melee: { label: 'Quick knife (melee)' },
  block: { label: 'Block / parry knife' },
  grenade: { label: 'Frag grenade' },
  radar: { label: 'Call radar (uplink charge)' },
  smoke: { label: 'Smoke grenade' },
  jammer: { label: 'Drone jammer pulse' },
  drone: { label: 'Recon drone (launch / return)' },
  inspect: { label: 'Inspect weapon' },
  interact: { label: 'Get in / out of a truck' },
  switchSeat: { label: 'Switch seat (in a truck)' },
  scoreboard: { label: 'Scoreboard (hold; 1–6 mute/unmute a player)' },
  chat: { label: 'Chat (type a message; Enter sends, Esc cancels)' },
  quickChat: { label: 'Quick chat wheel (hold; mouse or 1–9, 0)' },
} as const;
export type Action = keyof typeof ACTIONS;

/** Two slots per action (primary, secondary); '' = unbound. Codes are KeyboardEvent.code or MouseN. */
export type Keybinds = Record<Action, [string, string]>;

export const DEFAULT_KEYBINDS: Keybinds = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', ''],
  crouch: ['KeyC', 'ControlLeft'],
  prone: ['KeyZ', ''],
  jump: ['Space', ''],
  fire: ['Mouse0', ''],
  ads: ['Mouse2', ''],
  reload: ['KeyR', ''],
  primary: ['Digit1', ''],
  secondary: ['Digit2', ''],
  knife: ['Digit3', ''],
  melee: ['KeyQ', 'KeyV'],
  block: ['KeyF', 'Mouse3'],
  radar: ['KeyT', ''],
  smoke: ['KeyH', ''],
  jammer: ['KeyJ', ''],
  drone: ['KeyB', ''],
  grenade: ['KeyG', ''],
  // Presentation only (no sim button). F is Block; Y was free.
  inspect: ['KeyY', ''],
  scoreboard: ['Tab', ''],
  // Trucks: E and N were free (F is Block, G the frag, X the quick-chat wheel).
  interact: ['KeyE', ''],
  switchSeat: ['KeyN', ''],
  // Presentation only. Enter types; X was free (Z prone, F block, G frag, T radar, Y inspect).
  chat: ['Enter', ''],
  quickChat: ['KeyX', ''],
};

export const WEATHERS = ['sunny', 'overcast', 'rain', 'dusk', 'neon', 'golden'] as const;
export type WeatherId = (typeof WEATHERS)[number];
export const QUALITIES = ['auto', 'low', 'medium', 'high', 'ultra'] as const;
export type Quality = (typeof QUALITIES)[number];

export interface Settings {
  /** Map (lobby setting in M3). Changing it reloads the game. */
  map: 'defilad' | 'range';
  /** Map size (Plac Defilad): the compact Market, the full block, or one half of it. */
  mapSize: 'market' | 'full' | 'north' | 'south';
  /** Radar: collect uplinks to see everyone briefly, or no radar at all. Changing it reloads. */
  radar: 'pickups' | 'off';
  /** Loadout rule: standard (rifle, sidearm, knife, 1 frag) or knife-only. Lobby setting in M3. */
  matchMode: 'standard' | 'knife';
  /** Loadout primary (applies from your next spawn). */
  primary: PrimaryId;
  /** Knife sparring partner in the range (a bot on the real input path). */
  sparring: boolean;
  /**
   * Practice match vs bots (and a new friend room's defaults): bot count, difficulty and the
   * match limits (score / time, each may be unlimited). First to 25 in 10 min by default.
   */
  botCount: number;
  botDifficulty: (typeof MATCH_BOT_DIFFICULTIES)[number];
  scoreLimit: MatchScoreLimit;
  timeLimit: MatchTimeLimit;
  /** Armored trucks on the map (practice, and a new friend room's default). */
  vehicles: 'on' | 'off';
  /** Bots' chat lines in a practice match and new friend rooms (host setting). */
  botChatter: (typeof MATCH_BOT_CHATTER)[number];
  /**
   * What the chat feed shows and lets you send: everything, quick chat (and bots) only, or
   * nothing at all.
   */
  chatMode: 'all' | 'quick' | 'off';
  /**
   * Online match (M3a): join friends on the game server with the Match settings above instead
   * of playing alone. On by default in hosted (production) builds, off in dev; changing it
   * reloads. `?online` / `?online=0` override for one page.
   */
  online: boolean;
  /** Name shown to other players online (empty: the server picks "Player N"). */
  playerName: string;
  /** Degrees per mouse count = 0.022 × sensitivity. */
  sensitivity: number;
  /** Only used to display cm/360. */
  mouseDpi: number;
  /** Multiplier on top of FOV-matched ADS scaling (1 = same feel per screen distance). */
  adsSensitivity: number;
  invertY: boolean;
  /** Horizontal FOV at 16:9 (Hor+: wider screens see more, vertical FOV is kept). */
  fov: number;
  sprintMode: 'hold' | 'toggle';
  crouchMode: 'hold' | 'toggle';
  adsMode: 'hold' | 'toggle';
  keybinds: Keybinds;
  masterVolume: number;
  /** Internal resolution scale (0.5–1); the ceiling when dynamic resolution is on. */
  renderScale: number;
  /** Lower the internal resolution automatically to hold 60 fps. */
  dynamicResolution: boolean;
  /** Graphics preset; 'auto' starts at high and steps down if the frame rate can't hold. */
  quality: Quality;
  weather: WeatherId;
  /** Greybox 1 m grid overlay (level-design aid). */
  showGrid: boolean;
  cameraBob: boolean;
  /**
   * Cinematic camera moments (presentation only): the match-intro fly-over, the death/kill cam
   * while waiting to respawn and the victory shot in the results.
   */
  cinematicCameras: boolean;
  /** Skip the match-intro fly-over (the other moments still play). */
  skipIntro: boolean;
  damageNumbers: boolean;
  crosshairColor: string;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  map: 'defilad',
  mapSize: 'market',
  radar: 'pickups',
  matchMode: 'standard',
  primary: 'ar7',
  sparring: false,
  botCount: MATCH_NET.maxPlayers - 1,
  botDifficulty: 'normal',
  scoreLimit: 25,
  timeLimit: 600,
  vehicles: 'on',
  botChatter: 'on',
  chatMode: 'all',
  // Hosted builds start online (a shared link lands in a match with bots); dev keeps the
  // offline practice range. `?online=0` / the menu checkbox still switch it per page.
  online: import.meta.env.PROD,
  playerName: '',
  sensitivity: 1.6,
  mouseDpi: 800,
  adsSensitivity: 1,
  invertY: false,
  fov: 95,
  sprintMode: 'hold',
  crouchMode: 'hold',
  adsMode: 'hold',
  keybinds: DEFAULT_KEYBINDS,
  masterVolume: 0.7,
  renderScale: 1,
  dynamicResolution: true,
  quality: 'auto',
  // Golden hour (Kiran, 2026-10-13): long low side light, warm key, readable shade.
  weather: 'golden',
  showGrid: false,
  cameraBob: true,
  cinematicCameras: true,
  skipIntro: false,
  damageNumbers: true,
  crosshairColor: '#7dffb0',
  showFps: false,
};

export const DEG_PER_COUNT = 0.022;

/** Centimetres of mouse travel for a full 360° turn. */
export function cmPer360(s: Pick<Settings, 'sensitivity' | 'mouseDpi'>): number {
  const counts = 360 / (DEG_PER_COUNT * s.sensitivity);
  return (counts / s.mouseDpi) * 2.54;
}

const KEY = 'wd.settings.v2';
/**
 * v1 saved the whole object on any menu change, so its `online` is almost always just the old
 * `false` default, not a choice: migrating drops it (hosted builds then start online, like a
 * fresh visit). Seeds that write v1 keep every other field through this fallback.
 */
const LEGACY_KEY = 'wd.settings.v1';
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
/** A match limit: a whole number in range, or unlimited. */
const limit = <T extends MatchScoreLimit | MatchTimeLimit>(
  v: unknown,
  fallback: T,
  lo: number,
  hi: number,
): T =>
  v === UNLIMITED
    ? (v as T)
    : typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
      ? (v as T)
      : fallback;
const CODE =
  /^(Key[A-Z]|Digit\d|Arrow(Up|Down|Left|Right)|Mouse[0-4]|F\d{1,2}|Numpad\w+|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Space|Tab|CapsLock|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Enter|Backspace|Insert|Delete|Home|End|PageUp|PageDown)$/;

function sanitizeKeybinds(raw: unknown): Keybinds {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as Keybinds;
  const added: Action[] = [];
  for (const action of Object.keys(DEFAULT_KEYBINDS) as Action[]) {
    const v = r[action];
    const def = DEFAULT_KEYBINDS[action];
    if (Array.isArray(v) && v.length === 2) {
      const slot = (x: unknown, d: string): string =>
        x === '' ? '' : typeof x === 'string' && CODE.test(x) ? x : d;
      out[action] = [slot(v[0], def[0]), slot(v[1], def[1])];
    } else {
      out[action] = [...def];
      added.push(action);
    }
  }
  // An action new since these binds were saved (e.g. Inspect) never takes a key the player has
  // already given to something else: that default stays unbound.
  if (Object.keys(r).length) {
    for (const action of added) {
      const taken = (code: string): boolean =>
        (Object.keys(out) as Action[]).some((a) => a !== action && out[a].includes(code));
      out[action] = out[action].map((c) => (c && taken(c) ? '' : c)) as [string, string];
    }
  }
  return out;
}

/** Printable, single-line, at most 16 characters (the server sanitizes again). */
export function cleanName(raw: string): string {
  const clean = raw
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trimStart();
  return Array.from(clean).slice(0, 16).join('');
}

/** Validate anything (e.g. stale or hand-edited storage) into legal settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    map: oneOf(r.map, ['defilad', 'range'] as const, d.map),
    mapSize: oneOf(r.mapSize, ['market', 'full', 'north', 'south'] as const, d.mapSize),
    radar: oneOf(r.radar, ['pickups', 'off'] as const, d.radar),
    matchMode: oneOf(r.matchMode, ['standard', 'knife'] as const, d.matchMode),
    primary: oneOf(r.primary, PRIMARY_IDS, d.primary),
    sparring: bool(r.sparring, d.sparring),
    botCount: Math.round(num(r.botCount, d.botCount, 0, MATCH_NET.maxPlayers - 1)),
    botDifficulty: oneOf(r.botDifficulty, MATCH_BOT_DIFFICULTIES, d.botDifficulty),
    scoreLimit: limit(r.scoreLimit, d.scoreLimit, 1, 100),
    timeLimit: limit(r.timeLimit, d.timeLimit, 60, 3600),
    vehicles: oneOf(r.vehicles, ['on', 'off'] as const, d.vehicles),
    botChatter: oneOf(r.botChatter, MATCH_BOT_CHATTER, d.botChatter),
    chatMode: oneOf(r.chatMode, ['all', 'quick', 'off'] as const, d.chatMode),
    online: bool(r.online, d.online),
    playerName: typeof r.playerName === 'string' ? cleanName(r.playerName) : d.playerName,
    sensitivity: num(r.sensitivity, d.sensitivity, 0.05, 20),
    mouseDpi: num(r.mouseDpi, d.mouseDpi, 100, 32000),
    adsSensitivity: num(r.adsSensitivity, d.adsSensitivity, 0.2, 3),
    invertY: bool(r.invertY, d.invertY),
    fov: num(r.fov, d.fov, 70, 120),
    sprintMode: oneOf(r.sprintMode, ['hold', 'toggle'] as const, d.sprintMode),
    crouchMode: oneOf(r.crouchMode, ['hold', 'toggle'] as const, d.crouchMode),
    adsMode: oneOf(r.adsMode, ['hold', 'toggle'] as const, d.adsMode),
    keybinds: sanitizeKeybinds(r.keybinds),
    masterVolume: num(r.masterVolume, d.masterVolume, 0, 1),
    renderScale: num(r.renderScale, d.renderScale, 0.5, 1),
    dynamicResolution: bool(r.dynamicResolution, d.dynamicResolution),
    quality: oneOf(r.quality, QUALITIES, d.quality),
    weather: oneOf(r.weather, WEATHERS, d.weather),
    showGrid: bool(r.showGrid, d.showGrid),
    cameraBob: bool(r.cameraBob, d.cameraBob),
    cinematicCameras: bool(r.cinematicCameras, d.cinematicCameras),
    skipIntro: bool(r.skipIntro, d.skipIntro),
    damageNumbers: bool(r.damageNumbers, d.damageNumbers),
    crosshairColor:
      typeof r.crosshairColor === 'string' && /^#[0-9a-f]{6}$/i.test(r.crosshairColor)
        ? r.crosshairColor
        : d.crosshairColor,
    showFps: bool(r.showFps, d.showFps),
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return sanitizeSettings({});
    const old = JSON.parse(legacy) as Record<string, unknown> | null;
    // Only the stale default goes: a v1 `true` was a real choice (it had to be ticked).
    if (old && typeof old === 'object' && old.online === false) delete old.online;
    return sanitizeSettings(old);
  } catch {
    return sanitizeSettings({});
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable (private mode): settings just won't persist
  }
}

/** Vertical FOV (degrees) from the horizontal-at-16:9 setting. */
export function verticalFov(hfovDeg: number): number {
  const h = (hfovDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) * (9 / 16)) * 180) / Math.PI;
}

/** Human-readable key label for the menu. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  const named: Record<string, string> = {
    Mouse0: 'LMB',
    Mouse1: 'MMB',
    Mouse2: 'RMB',
    Mouse3: 'Mouse 4',
    Mouse4: 'Mouse 5',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    ShiftLeft: 'L Shift',
    ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl',
    ControlRight: 'R Ctrl',
    AltLeft: 'L Alt',
    AltRight: 'R Alt',
    Backquote: '`',
  };
  return named[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '');
}
