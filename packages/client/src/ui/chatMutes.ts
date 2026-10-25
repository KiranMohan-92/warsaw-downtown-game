/**
 * Chat mutes, kept by player name so they last across matches and visits (ids change every
 * join). Saved in localStorage; when storage is blocked (private mode, a sandboxed frame) they
 * still hold for this page. Names compare case-insensitively.
 */
export const MUTES_KEY = 'wd.chat.mutes.v1';
/** At most this many names are kept (the oldest go first). */
export const MAX_MUTES = 200;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export class ChatMutes {
  private readonly names: string[];

  constructor(private readonly store: Store | null = defaultStore()) {
    this.names = load(store);
  }

  has(name: string): boolean {
    const k = key(name);
    return k !== '' && this.names.includes(k);
  }

  /** Mute or unmute a name; returns whether it is muted now. */
  toggle(name: string): boolean {
    const k = key(name);
    if (!k) return false;
    const i = this.names.indexOf(k);
    if (i >= 0) this.names.splice(i, 1);
    else {
      this.names.push(k);
      if (this.names.length > MAX_MUTES) this.names.splice(0, this.names.length - MAX_MUTES);
    }
    this.save();
    return i < 0;
  }

  list(): readonly string[] {
    return this.names;
  }

  private save(): void {
    try {
      this.store?.setItem(MUTES_KEY, JSON.stringify(this.names));
    } catch {
      // storage blocked or full: the mutes still hold for this page
    }
  }
}

const key = (name: string): string => name.trim().toLowerCase();

function load(store: Store | null): string[] {
  try {
    const raw: unknown = JSON.parse(store?.getItem(MUTES_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((n): n is string => typeof n === 'string')
      .map(key)
      .filter((n) => n !== '')
      .slice(-MAX_MUTES);
  } catch {
    return [];
  }
}

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let shared: ChatMutes | null = null;
/** The page's mutes (the friend lobby and the game share them). */
export function pageMutes(): ChatMutes {
  return (shared ??= new ChatMutes());
}
