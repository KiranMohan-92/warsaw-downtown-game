import type { Settings } from './settings.ts';

/** The keys a menu save wrote on the player's behalf; `'all'` = a reset. */
export type SettingsChange = readonly (keyof Settings)[] | 'all';

/**
 * Settings this page shows without them being the player's choice: `?online` for this page, a
 * friend room's online/map/size/radar/weather/mode, the server's match mode. The menu shows (and
 * can change) them, but saving keeps what the player had, except for the keys the player
 * explicitly wrote (the menu reports them; a reset writes every key): those become their own,
 * even when the written value happens to equal the forced one.
 */
export class PageOverrides {
  private readonly forced = new Set<keyof Settings>();
  private readonly own: Partial<Settings> = {};

  /**
   * Show `value` for `key` on this page; `settings[key]` is the player's own value (the first
   * force of a key keeps it; later forces, e.g. the host changing settings, only move the shown
   * value). Writes `value` into `settings`.
   */
  force<K extends keyof Settings>(settings: Settings, key: K, value: Settings[K]): void {
    if (!this.forced.has(key)) this.own[key] = settings[key];
    this.forced.add(key);
    settings[key] = value;
  }

  /** What to store for `current` (the menu's settings) after the player wrote `changed`. */
  toSave(current: Settings, changed: SettingsChange): Settings {
    const out = { ...current };
    for (const key of this.forced) {
      if (changed === 'all' || changed.includes(key)) this.adopt(current, key);
      else this.restore(out, key);
    }
    return out;
  }

  /** The player wrote this key: its current value is theirs from now on. */
  private adopt<K extends keyof Settings>(current: Settings, key: K): void {
    this.own[key] = current[key];
  }

  private restore<K extends keyof Settings>(out: Settings, key: K): void {
    out[key] = this.own[key] as Settings[K];
  }
}
