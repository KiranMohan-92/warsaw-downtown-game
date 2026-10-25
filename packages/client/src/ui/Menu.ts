import { MATCH_SCORE_LIMITS, MATCH_TIME_LIMITS, UNLIMITED } from '@wd/shared';
import { scoreLimitLabel, timeLimitLabel } from '../net/friendLobby.ts';
import {
  ACTIONS,
  cmPer360,
  DEFAULT_SETTINGS,
  keyLabel,
  saveSettings,
  type Action,
  type Settings,
} from '../settings/settings.ts';
import type { SettingsChange } from '../settings/pageOverrides.ts';

type Field =
  | {
      key: keyof Settings;
      label: string;
      kind: 'range';
      min: number;
      max: number;
      step: number;
      fmt?: (v: number) => string;
    }
  | { key: keyof Settings; label: string; kind: 'number'; min: number; max: number; step: number }
  | { key: keyof Settings; label: string; kind: 'check' }
  | {
      key: keyof Settings;
      label: string;
      kind: 'select';
      options: [string, string][];
      /** Option value → setting (default: the string itself). */
      parse?: (v: string) => unknown;
    }
  | { key: keyof Settings; label: string; kind: 'color' }
  | { key: keyof Settings; label: string; kind: 'text'; maxLength: number; placeholder: string };

const HOLD_TOGGLE: [string, string][] = [
  ['hold', 'Hold'],
  ['toggle', 'Toggle'],
];
const pct = (v: number): string => `${Math.round(v * 100)}%`;
/** A limit option back to its setting: `unlimited` or a whole number. */
const limitValue = (v: string): unknown => (v === UNLIMITED ? UNLIMITED : Number(v));

/** Practice match / new friend room settings (Menu › Match). */
const PRACTICE_FIELDS: Field[] = [
  {
    key: 'botDifficulty',
    label: 'Bot difficulty (practice and friend rooms you create)',
    kind: 'select',
    options: [
      ['easy', 'Easy — slow to react, loose aim'],
      ['normal', 'Normal — about an average player'],
      ['hard', 'Hard — quick, accurate, fights your recoil'],
    ],
  },
  {
    key: 'botCount',
    label: 'Bots in a practice match',
    kind: 'select',
    options: [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]),
    parse: Number,
  },
  {
    key: 'scoreLimit',
    label: 'Score limit',
    kind: 'select',
    options: MATCH_SCORE_LIMITS.map((v) => [String(v), scoreLimitLabel(v)]),
    parse: limitValue,
  },
  {
    key: 'timeLimit',
    label: 'Time limit',
    kind: 'select',
    options: MATCH_TIME_LIMITS.map((v) => [String(v), timeLimitLabel(v)]),
    parse: limitValue,
  },
  {
    key: 'vehicles',
    label: 'Vehicles (armored trucks on the Market)',
    kind: 'select',
    options: [
      ['on', 'On'],
      ['off', 'Off'],
    ],
  },
  {
    key: 'botChatter',
    label: 'Bot chatter (practice and friend rooms you create)',
    kind: 'select',
    options: [
      ['on', 'On — the bots trash-talk (PG-13) and answer your quick chat'],
      ['off', 'Off — silent bots'],
    ],
  },
];

/** What the menu can do about the match in play (all optional: tests build a bare menu). */
export interface MenuMatchControls {
  /** This page is a practice match vs bots. */
  practice?: boolean;
  /** Start practice (or leave it: back to the normal page). */
  onPractice?: () => void;
  /** Practice settings changed since it started: offer a restart that applies them. */
  practicePending?: () => boolean;
  onRestartPractice?: () => void;
  /** Whether the End match control applies now (the host of a running match). */
  canEndMatch?: () => boolean;
  onEndMatch?: () => void;
}

const TABS: { id: string; title: string; fields: Field[] }[] = [
  {
    id: 'match',
    title: 'Match',
    fields: [
      {
        key: 'map',
        label: 'Map (reloads)',
        kind: 'select',
        options: [
          ['defilad', 'Plac Defilad — the real block around the Palace'],
          ['range', 'Test range (firing range, sparring)'],
        ],
      },
      {
        key: 'mapSize',
        label: 'Map size (reloads; Plac Defilad only)',
        kind: 'select',
        options: [
          ['market', 'Market — close quarters (≈130 × 125 m, best for 2–6)'],
          ['full', 'Full block (≈480 × 690 m)'],
          ['north', 'North half — park, construction site, north wings'],
          ['south', 'South half — plaza market, underpass, south gardens'],
        ],
      },
      {
        key: 'radar',
        label: 'Radar (reloads)',
        kind: 'select',
        options: [
          ['pickups', 'Uplinks — collect one to see everyone for 10 s'],
          ['off', 'Off'],
        ],
      },
      {
        key: 'matchMode',
        label: 'Loadout',
        kind: 'select',
        options: [
          ['standard', 'Standard (rifle, pistol, knife, 1 frag)'],
          ['knife', 'Knife only'],
        ],
      },
      {
        key: 'primary',
        label: 'Primary weapon (from your next spawn)',
        kind: 'select',
        options: [
          ['ar7', 'AR-7 rifle — all-rounder'],
          ['coil', 'KS-9 Cewka coilgun — silent, charge per shot, 2 headshots'],
          ['iskra', 'Iskra smart SMG — fast, rounds bend toward your target'],
          ['shotgun', 'M-12 Grom pump shotgun — one pull up close, weak past 25 m'],
          ['marksman', 'SR-8 Sokół marksman — 3× scope, headshot kills'],
          ['arc', 'ŁUK-3 arc rifle — energy, no reloads, overheats'],
        ],
      },
      ...PRACTICE_FIELDS,
      {
        key: 'sparring',
        label: 'Knife sparring partner (attacks you — practise block F / parry)',
        kind: 'check',
      },
      {
        key: 'online',
        label: 'Play online with friends (reloads; same map, size and loadout meet)',
        kind: 'check',
      },
      {
        key: 'playerName',
        label: 'Your name online',
        kind: 'text',
        maxLength: 16,
        placeholder: 'Player',
      },
    ],
  },
  {
    id: 'graphics',
    title: 'Graphics & weather',
    fields: [
      {
        key: 'weather',
        label: 'Weather',
        kind: 'select',
        options: [
          ['golden', 'Golden hour'],
          ['sunny', 'Sunny (bright)'],
          ['overcast', 'Overcast'],
          ['rain', 'Rain (dark storm)'],
          ['dusk', 'Dusk'],
          ['neon', 'Warsaw 2030 — neon night'],
        ],
      },
      {
        key: 'quality',
        label: 'Graphics quality',
        kind: 'select',
        options: [
          ['auto', 'Auto (adapts to your GPU)'],
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
          ['ultra', 'Ultra'],
        ],
      },
      {
        key: 'fov',
        label: 'Field of view (horizontal, 16:9)',
        kind: 'range',
        min: 70,
        max: 120,
        step: 1,
        fmt: (v) => `${v}°`,
      },
      {
        key: 'renderScale',
        label: 'Render scale',
        kind: 'range',
        min: 0.5,
        max: 1,
        step: 0.05,
        fmt: pct,
      },
      { key: 'dynamicResolution', label: 'Dynamic resolution (hold 60 fps)', kind: 'check' },
      { key: 'cameraBob', label: 'Camera and weapon bob', kind: 'check' },
      {
        key: 'cinematicCameras',
        label: 'Cinematic cameras (intro, kill cam, victory)',
        kind: 'check',
      },
      { key: 'skipIntro', label: 'Skip match intro', kind: 'check' },
      { key: 'showGrid', label: 'Level-design grid', kind: 'check' },
      { key: 'showFps', label: 'Show performance overlay', kind: 'check' },
    ],
  },
  {
    id: 'mouse',
    title: 'Mouse & controls',
    fields: [
      {
        key: 'sensitivity',
        label: 'Sensitivity',
        kind: 'range',
        min: 0.1,
        max: 8,
        step: 0.01,
        fmt: (v) => v.toFixed(2),
      },
      {
        key: 'mouseDpi',
        label: 'Mouse DPI (for cm/360)',
        kind: 'number',
        min: 100,
        max: 32000,
        step: 50,
      },
      {
        key: 'adsSensitivity',
        label: 'ADS sensitivity (× FOV-matched)',
        kind: 'range',
        min: 0.2,
        max: 2,
        step: 0.01,
        fmt: (v) => `${v.toFixed(2)}×`,
      },
      { key: 'invertY', label: 'Invert Y', kind: 'check' },
      { key: 'sprintMode', label: 'Sprint', kind: 'select', options: HOLD_TOGGLE },
      { key: 'crouchMode', label: 'Crouch', kind: 'select', options: HOLD_TOGGLE },
      { key: 'adsMode', label: 'Aim down sights', kind: 'select', options: HOLD_TOGGLE },
    ],
  },
  { id: 'keys', title: 'Key bindings', fields: [] },
  {
    id: 'hud',
    title: 'HUD & audio',
    fields: [
      { key: 'crosshairColor', label: 'Crosshair colour', kind: 'color' },
      { key: 'damageNumbers', label: 'Damage numbers', kind: 'check' },
      {
        key: 'chatMode',
        label: 'Chat (Enter types, hold X for quick chat)',
        kind: 'select',
        options: [
          ['all', 'All — players, quick chat and bots'],
          ['quick', 'Quick chat only — no typed messages (bots still talk)'],
          ['off', 'Off — no chat at all'],
        ],
      },
      {
        key: 'masterVolume',
        label: 'Master volume',
        kind: 'range',
        min: 0,
        max: 1,
        step: 0.01,
        fmt: pct,
      },
    ],
  },
];

/**
 * Which start button leads. On the plain offline page a real match beats an empty range as the
 * first thing to do, so "Play vs bots" leads and Play becomes the free range; online and
 * practice pages keep Play (join / resume the match) as the lead action.
 */
export function menuLead(
  practice: boolean,
  online: boolean,
): { lead: 'play' | 'practice'; playLabel: string; playTitle?: string; practiceLabel: string } {
  if (practice) return { lead: 'play', playLabel: 'Play', practiceLabel: 'Leave practice' };
  if (online) return { lead: 'play', playLabel: 'Play', practiceLabel: 'Play vs bots' };
  return {
    lead: 'practice',
    playLabel: 'Free range',
    playTitle: 'Warm up alone: practice dummies, no match',
    practiceLabel: 'Play vs bots',
  };
}

/** Start / pause overlay with tabbed live settings. Changes apply immediately and persist. */
export class Menu {
  readonly root: HTMLDivElement;
  private readonly cm360: HTMLSpanElement;
  private readonly title: HTMLHeadingElement;
  private readonly keyButtons = new Map<string, HTMLButtonElement>();
  private readonly endButton: HTMLButtonElement;
  private readonly restartButton: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly settings: Settings,
    private readonly onChange: (s: Settings) => void,
    onPlay: (fullscreen: boolean) => void,
    /** Capture the next key/button for rebinding (null = cancelled). */
    private readonly captureKey: (done: (code: string | null) => void) => void,
    /**
     * Persist the settings (the game keeps page-only overrides out of storage). `changed` = the
     * keys the player just wrote (a reset writes them all), so the game can tell an explicit
     * choice from a value it forced on this page.
     */
    private readonly save: (s: Settings, changed: SettingsChange) => void = saveSettings,
    onFriendLobby: () => void = () => {},
    private readonly match: MenuMatchControls = {},
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.innerHTML = `
      <div class="menu-panel">
        <header>
          <h1>WARSAW DOWNTOWN</h1>
          <h2 class="menu-sub"></h2>
        </header>
        <div class="menu-actions">
          <button class="btn primary" data-act="play" data-testid="play">Play</button>
          <button class="btn primary practice" data-act="practice" data-testid="practice"></button>
          <button class="btn" data-act="fs">Play fullscreen</button>
          <button class="btn practice" data-act="restart-practice" data-testid="restart-practice" title="Your practice settings changed: start a new practice match with them" hidden>Restart practice (apply changes)</button>
          <button class="btn danger" data-act="end-match" data-testid="end-match" hidden>End match</button>
          <button class="btn" data-act="friend-lobby" data-testid="friend-lobby">Create friend room</button>
          <span class="spacer"></span>
          <button class="btn small" data-act="reset">Reset all settings</button>
        </div>
        <nav class="tabs"></nav>
        <div class="tab-body"></div>
        <p class="hint foot">Esc pauses · F3 performance overlay · Fullscreen lets the game capture Ctrl, so Ctrl+W can't close the tab.</p>
        <p class="hint foot credits">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL) · Soldiers and arms: Microsoft Rocketbox (MIT), animations: Quaternius (CC0) · Trees: EZ-Tree by Daniel Greenheck (MIT) · Wrecks (modified): <a href="https://sketchfab.com/3d-models/military-helicopter-blackhawk-gameready-ef68553cd30a420d8b62b22affb545e6" target="_blank" rel="noopener">“Military Helicopter Blackhawk Gameready”</a> by Vavtrudner, <a href="https://sketchfab.com/3d-models/armoured-truck-wrecked-47fd963028384551b96d859cc2162927" target="_blank" rel="noopener">“Armoured Truck - Wrecked”</a> by robertmasiboda, <a href="https://sketchfab.com/3d-models/leopard-2-a6-7cb23d5322df4b409a880de635826067" target="_blank" rel="noopener">“Leopard 2 A6”</a> by buh-late; truck (modified): <a href="https://sketchfab.com/3d-models/free-armored-police-vehicle-9aea4465dc974c728b6167eac5ffd22e" target="_blank" rel="noopener">“[Free] Armored Police Vehicle”</a> by Roam_Man (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>) · Sounds: CC0 (see ASSETS.md)</p>
      </div>`;
    parent.append(this.root);
    this.title = this.root.querySelector('.menu-sub')!;
    this.title.textContent = this.mapLabel();

    const nav = this.root.querySelector<HTMLElement>('.tabs')!;
    const body = this.root.querySelector<HTMLDivElement>('.tab-body')!;
    const panes = new Map<string, HTMLElement>();
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.textContent = tab.title;
      btn.dataset.tab = tab.id;
      nav.append(btn);
      const pane = document.createElement('section');
      pane.className = 'pane';
      for (const f of tab.fields) pane.append(this.row(f));
      if (tab.id === 'mouse') {
        const p = document.createElement('p');
        p.className = 'hint';
        p.innerHTML =
          'Turn distance: <span class="cm360"></span> per 360° · raw input, no acceleration';
        pane.insertBefore(p, pane.children[3] ?? null);
      }
      if (tab.id === 'keys') this.buildKeybinds(pane);
      body.append(pane);
      panes.set(tab.id, pane);
      btn.addEventListener('click', () => select(tab.id));
    }
    const select = (id: string): void => {
      for (const [pid, pane] of panes) pane.classList.toggle('active', pid === id);
      nav
        .querySelectorAll<HTMLButtonElement>('.tab')
        .forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    };
    select('match');

    this.cm360 = this.root.querySelector('.cm360')!;
    this.refreshDerived();

    this.root.querySelector('[data-act="play"]')!.addEventListener('click', () => onPlay(false));
    this.root.querySelector('[data-act="fs"]')!.addEventListener('click', () => onPlay(true));
    this.root.querySelector('[data-act="friend-lobby"]')!.addEventListener('click', onFriendLobby);
    // One click to a full match against bots (offline; reloads into practice), or back out.
    const practice = this.root.querySelector<HTMLButtonElement>('[data-act="practice"]')!;
    const play = this.root.querySelector<HTMLButtonElement>('[data-act="play"]')!;
    const lead = menuLead(!!match.practice, this.settings.online);
    practice.textContent = lead.practiceLabel;
    practice.title = match.practice
      ? 'Back to the free range'
      : 'A full match against bots on this map, offline (Match tab: difficulty, bots, limits)';
    play.textContent = lead.playLabel;
    if (lead.playTitle) play.title = lead.playTitle;
    play.classList.toggle('primary', lead.lead === 'play');
    practice.classList.toggle('primary', lead.lead === 'practice');
    if (lead.lead === 'practice') play.before(practice);
    practice.addEventListener('click', () => match.onPractice?.());
    this.restartButton = this.root.querySelector<HTMLButtonElement>(
      '[data-act="restart-practice"]',
    )!;
    this.restartButton.addEventListener('click', () => match.onRestartPractice?.());
    this.endButton = this.root.querySelector<HTMLButtonElement>('[data-act="end-match"]')!;
    this.endButton.addEventListener('click', () => {
      if (match.canEndMatch?.()) match.onEndMatch?.();
      this.refreshMatchControls();
    });
    this.refreshMatchControls();
    this.root.querySelector('[data-act="reset"]')!.addEventListener('click', () => {
      Object.assign(this.settings, structuredClone(DEFAULT_SETTINGS));
      this.commit('all');
      body.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((input) => {
        this.syncInput(input);
      });
      this.refreshKeyButtons();
    });
  }

  /** Start-screen subtitle: the map (and size) in play. */
  private mapLabel(): string {
    if (this.settings.map === 'range') return 'Test range';
    const size = {
      market: 'Market (close quarters)',
      full: 'full block',
      north: 'north half',
      south: 'south half',
    }[this.settings.mapSize];
    return `Plac Defilad · ${size}`;
  }

  private buildKeybinds(pane: HTMLElement): void {
    const table = document.createElement('div');
    table.className = 'keys';
    table.innerHTML =
      '<span></span><span class="kh">Primary</span><span class="kh">Secondary</span>';
    for (const [action, meta] of Object.entries(ACTIONS) as [Action, (typeof ACTIONS)[Action]][]) {
      const reserved = (meta as { reserved?: string }).reserved ?? null;
      const name = document.createElement('span');
      name.className = 'kname';
      name.innerHTML = reserved ? `${meta.label} <em>${reserved}</em>` : meta.label;
      table.append(name);
      for (const slot of [0, 1] as const) {
        const b = document.createElement('button');
        b.className = 'keycap';
        b.dataset.action = action;
        b.dataset.slot = String(slot);
        b.addEventListener('click', () => this.rebind(action, slot, b));
        b.addEventListener('contextmenu', (e) => {
          // Right-click clears the slot.
          e.preventDefault();
          this.settings.keybinds[action][slot] = '';
          this.commit(['keybinds']);
          this.refreshKeyButtons();
        });
        this.keyButtons.set(`${action}:${slot}`, b);
        table.append(b);
      }
    }
    pane.append(table);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Click a slot, then press a key or mouse button (Esc cancels). Right-click a slot to clear it. A key used elsewhere is moved to the new action.';
    pane.append(hint);
    this.refreshKeyButtons();
  }

  private rebind(action: Action, slot: 0 | 1, button: HTMLButtonElement): void {
    button.classList.add('listening');
    button.textContent = 'Press…';
    this.captureKey((code) => {
      button.classList.remove('listening');
      if (code) {
        // Standard behaviour: a key belongs to one action; steal it from wherever it was.
        for (const binds of Object.values(this.settings.keybinds)) {
          for (const i of [0, 1] as const) if (binds[i] === code) binds[i] = '';
        }
        this.settings.keybinds[action][slot] = code;
        this.commit(['keybinds']);
      }
      this.refreshKeyButtons();
    });
  }

  private refreshKeyButtons(): void {
    for (const [id, b] of this.keyButtons) {
      const [action, slot] = id.split(':') as [Action, string];
      b.textContent = keyLabel(this.settings.keybinds[action][Number(slot) as 0 | 1]);
    }
  }

  private row(f: Field): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = `row row-${f.kind}`;
    const name = document.createElement('span');
    name.textContent = f.label;
    label.append(name);
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.kind === 'select') {
      const sel = document.createElement('select');
      for (const [value, text] of f.options) sel.add(new Option(text, value));
      input = sel;
    } else {
      const inp = document.createElement('input');
      inp.type =
        f.kind === 'text'
          ? 'text'
          : f.kind === 'check'
            ? 'checkbox'
            : f.kind === 'color'
              ? 'color'
              : f.kind === 'range'
                ? 'range'
                : 'number';
      if (f.kind === 'text') {
        inp.maxLength = f.maxLength;
        inp.placeholder = f.placeholder;
        inp.spellcheck = false;
      }
      if (f.kind === 'range' || f.kind === 'number') {
        inp.min = String(f.min);
        inp.max = String(f.max);
        inp.step = String(f.step);
      }
      input = inp;
    }
    input.dataset.key = f.key;
    input.dataset.testid = `setting-${f.key}`;
    label.append(input);
    const out = document.createElement('output');
    if (f.kind === 'range') label.append(out);
    const fmt = f.kind === 'range' ? f.fmt : undefined;
    const show = (): void => {
      if (fmt) out.textContent = fmt(Number(input.value));
    };
    input.addEventListener('sync', show);
    this.syncInput(input);
    input.addEventListener('input', () => {
      const s = this.settings as unknown as Record<string, unknown>;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') s[f.key] = input.checked;
      else if (f.kind === 'range' || f.kind === 'number') {
        const n = Number(input.value);
        if (Number.isFinite(n)) s[f.key] = Math.min(f.max, Math.max(f.min, n));
      } else if (f.kind === 'select' && f.parse) s[f.key] = f.parse(input.value);
      else s[f.key] = input.value;
      show();
      this.commit([f.key]);
    });
    return label;
  }

  private syncInput(input: HTMLInputElement | HTMLSelectElement): void {
    const v = (this.settings as unknown as Record<string, unknown>)[input.dataset.key!];
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(v);
    else input.value = String(v);
    input.dispatchEvent(new Event('sync'));
  }

  private commit(changed: SettingsChange): void {
    this.save(this.settings, changed);
    this.refreshDerived();
    this.onChange(this.settings);
    this.refreshMatchControls();
  }

  private refreshDerived(): void {
    this.cm360.textContent = `${cmPer360(this.settings).toFixed(1)} cm`;
  }

  show(paused: boolean): void {
    this.title.textContent = paused
      ? 'Paused'
      : this.match.practice
        ? `Practice vs bots · ${this.mapLabel()}`
        : this.mapLabel();
    this.refreshMatchControls();
    this.root.classList.add('open');
  }

  /** End match shows only while it applies (the host, mid-match). */
  refreshMatchControls(): void {
    this.restartButton.hidden = !(this.match.practicePending?.() ?? false);
    const can = this.match.canEndMatch?.() ?? false;
    this.endButton.hidden = !can;
    this.endButton.disabled = !can;
  }

  hide(): void {
    this.root.classList.remove('open');
  }
}
