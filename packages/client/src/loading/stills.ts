/**
 * Loading-screen backdrop: graded stills of the game's own trailer footage (public/loading/, built
 * by tools/assets/build_loading_stills.py) behind the wordmark, with a slow Ken Burns pan/zoom
 * (CSS, index.html) and crossfades. The first still is static markup in index.html (it shows
 * before the bundle); this rotates the rest in, loading each one only while the one before it is
 * on screen, at low fetch priority, so the backdrop never competes with the game's own downloads.
 * A still is shown only once decoded: a slow or failed load holds the current one (never a blank).
 */

import type { WeatherId } from '../settings/settings.ts';

export interface Still {
  /** File under /loading/ (no extension). */
  readonly id: string;
  /** Cover-crop focal point (CSS object-position / transform-origin), percent of width/height. */
  readonly focus: readonly [number, number];
  /**
   * Portrait windows (phones; `PORTRAIT_QUERY`) show only ~a quarter of a 16:9 still's width, so
   * each still has its own portrait focal point. A still whose subject cannot survive that crop
   * (a hero filling the frame) has its own portrait file instead (`portraitId`, cut from a wider
   * shot of the same moment kind), framed by `portrait`.
   */
  readonly portrait: readonly [number, number];
  readonly portraitId?: string;
  readonly weather: WeatherId;
}

/** Rotation order (index 0 is the static one in index.html). Sources: build_loading_stills.py. */
export const STILLS: readonly Still[] = [
  { id: 'palace_golden', focus: [52, 45], portrait: [40, 50], weather: 'golden' },
  {
    id: 'jet_launch_golden',
    focus: [52, 45],
    portrait: [50, 45],
    portraitId: 'jet_launch_golden_portrait',
    weather: 'golden',
  },
  { id: 'jet_market_golden', focus: [58, 52], portrait: [58, 52], weather: 'golden' },
  { id: 'truck_colonnade_golden', focus: [62, 52], portrait: [66, 52], weather: 'golden' },
  { id: 'market_trucks_golden', focus: [50, 55], portrait: [52, 55], weather: 'golden' },
  { id: 'colonnade_fight_golden', focus: [60, 55], portrait: [54, 52], weather: 'golden' },
  { id: 'crown_golden', focus: [50, 40], portrait: [52, 38], weather: 'golden' },
  { id: 'skyline_golden', focus: [50, 45], portrait: [48, 45], weather: 'golden' },
];

/** Portrait windows (same query as the CSS in index.html). */
export const PORTRAIT_QUERY = '(max-aspect-ratio: 4/5)';

/** The file a window shows: a portrait one gets the still's portrait file if it has one. */
export const stillUrl = (s: Still, portrait = false): string =>
  `/loading/${(portrait && s.portraitId) || s.id}.webp`;

/** How long a still stays before the next fades in (if it has loaded), and the crossfade. */
export const HOLD_MS = 7000;
export const FADE_MS = 1600;
/** Reduced motion: no pan (CSS), slower fades, longer holds. */
export const STILL_HOLD_MS = 11000;
export const STILL_FADE_MS = 3000;
/** The next still starts loading this long after the current one appears (after first paint). */
export const PRELOAD_DELAY_MS = 1500;
/** Ken Burns variants in index.html (`.wdl-kb-0` …). */
export const KB_VARIANTS = 4;

/**
 * The first still stays first (it is in the HTML); the others play the match weather's stills
 * first (the saved weather setting: a friend room's host may still pick another), order kept.
 */
export function orderStills(stills: readonly Still[], weather?: WeatherId): Still[] {
  const [first, ...rest] = stills;
  if (!first) return [];
  if (!weather) return [first, ...rest];
  return [
    first,
    ...rest.filter((s) => s.weather === weather),
    ...rest.filter((s) => s.weather !== weather),
  ];
}

/** One slide on the page (a real element, a fake in tests). */
export interface Slide {
  /**
   * Fade in (and start its Ken Burns move) `delayMs` from now. The delay is CSS (transition and
   * animation delay), so the crossfade happens on the compositor on time even while the main
   * thread is busy in a long synchronous build (the Market build is one ~14 s task).
   */
  show(delayMs: number): void;
  /** Fade out `delayMs` from now (the fade time is CSS: FADE_MS, STILL_FADE_MS reduced). */
  hide(delayMs: number): void;
  remove(): void;
}

export interface BackdropHost {
  /** The static slide already in the page (index.html), if any. */
  first(): Slide | null;
  /** Start loading `still` (low priority); `done(ok)` once it is decoded (or failed). */
  load(still: Still, variant: number, done: (ok: boolean) => void): Slide;
}

interface Pending {
  slide: Slide;
  state: 'loading' | 'ready' | 'failed';
}

/**
 * Crossfade timing + lazy loading; driven by the loading screen's 10 Hz tick (no own timers).
 * A decoded still is armed at once for the end of the current one's hold (see `Slide.show`).
 */
export class StillRotator {
  private readonly hold: number;
  private readonly fade: number;
  private current: Slide | null;
  private shownAt: number;
  private next = 1;
  private shown = 0;
  private pending: Pending | null = null;
  private leaving: { slide: Slide; at: number }[] = [];
  private stopped = false;

  constructor(
    private readonly host: BackdropHost,
    private readonly stills: readonly Still[],
    opts: { now: number; startedAt?: number; reducedMotion: boolean },
  ) {
    this.hold = opts.reducedMotion ? STILL_HOLD_MS : HOLD_MS;
    this.fade = opts.reducedMotion ? STILL_FADE_MS : FADE_MS;
    this.current = host.first();
    // The static still has been on screen since the page's first paint.
    this.shownAt = Math.min(opts.now, opts.startedAt ?? opts.now);
    if (!this.current) this.stopped = true;
  }

  /** Stills shown or armed so far, the static one included. */
  get count(): number {
    return this.shown + (this.current ? 1 : 0);
  }

  tick(now: number): void {
    this.leaving = this.leaving.filter((l) => {
      if (now < l.at) return true;
      l.slide.remove();
      return false;
    });
    if (this.stopped || this.stills.length < 2) return;
    if (!this.pending && now - this.shownAt >= PRELOAD_DELAY_MS) this.startLoad();
    const p = this.pending;
    if (!p) return;
    if (p.state === 'failed') {
      p.slide.remove();
      this.pending = null;
      return;
    }
    if (p.state === 'ready') {
      const delay = Math.max(0, this.shownAt + this.hold - now);
      const at = now + delay;
      this.pending = null;
      p.slide.show(delay);
      if (this.current) {
        this.current.hide(delay);
        this.leaving.push({ slide: this.current, at: at + this.fade + 100 });
      }
      this.current = p.slide;
      this.shown++;
      this.shownAt = at;
    }
  }

  /** No more loads or fades (the screen is going: ready, error). The current still stays. */
  stop(): void {
    this.stopped = true;
    if (this.pending) {
      this.pending.slide.remove();
      this.pending = null;
    }
  }

  private startLoad(): void {
    const still = this.stills[this.next % this.stills.length];
    if (!still) return;
    const variant = this.next % KB_VARIANTS;
    this.next = this.next + 1 >= this.stills.length ? 0 : this.next + 1;
    const pending: Pending = { slide: null as unknown as Slide, state: 'loading' };
    this.pending = pending;
    pending.slide = this.host.load(still, variant, (ok) => {
      if (pending.state === 'loading') pending.state = ok ? 'ready' : 'failed';
    });
  }
}

/** The page's backdrop: `.wdl-bg` in index.html. Null without one (old HTML, probes). */
export function domBackdrop(root: Element): BackdropHost | null {
  const bg = root.querySelector<HTMLElement>('[data-l="bg"]');
  if (!bg) return null;
  const wrap = (el: HTMLElement): Slide => ({
    // `wdl-play` starts the Ken Burns move at show and stays through the fade-out (no snap back).
    // Two delays: the fade's (in and out) and the pan's (set once: changing a running
    // animation's delay would make it jump).
    show: (delayMs) => {
      el.style.setProperty('--wdl-fade', `${Math.round(delayMs)}ms`);
      el.style.setProperty('--wdl-in', `${Math.round(delayMs)}ms`);
      el.classList.add('wdl-on', 'wdl-play');
    },
    hide: (delayMs) => {
      el.style.setProperty('--wdl-fade', `${Math.round(delayMs)}ms`);
      el.classList.remove('wdl-on');
    },
    remove: () => el.remove(),
  });
  return {
    first: () => {
      const el = bg.querySelector<HTMLElement>('.wdl-slide');
      return el ? wrap(el) : null;
    },
    load: (still, variant, done) => {
      const el = document.createElement('div');
      el.className = `wdl-slide wdl-kb-${variant}`;
      el.style.setProperty('--fx', `${still.focus[0]}%`);
      el.style.setProperty('--fy', `${still.focus[1]}%`);
      el.style.setProperty('--px', `${still.portrait[0]}%`);
      el.style.setProperty('--py', `${still.portrait[1]}%`);
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.width = 1600;
      img.height = 900;
      // Chosen once per load (a phone turned mid-load keeps the file, the CSS re-crops it).
      img.src = stillUrl(still, window.matchMedia?.(PORTRAIT_QUERY).matches ?? false);
      // Decoded before it is shown, so the fade never starts on a half-drawn image.
      img.decode().then(
        () => done(true),
        () => done(false),
      );
      el.append(img);
      // In the page (opacity 0, not yet moving) from now on: decoded and laid out before its fade.
      bg.append(el);
      return wrap(el);
    },
  };
}
