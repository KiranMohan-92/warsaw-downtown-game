/**
 * Loading screen controller. The markup and its CSS are static in index.html (the first paint
 * is the loading screen, before this bundle runs); this takes it over, draws the boot progress
 * (loading/progress.ts) at ~10 Hz, rotates tips, and removes the element once the game is
 * warmed up. Every animation is CSS; after `finish` nothing of it is left in the DOM.
 */

import {
  BOOT_STAGES,
  BootProgress,
  type BootReporter,
  type BootSink,
  type BootStage,
} from './progress.ts';
import type { WeatherId } from '../settings/settings.ts';
import {
  domBackdrop,
  orderStills,
  STILLS,
  StillRotator,
  type BackdropHost,
  type Still,
} from './stills.ts';

/** The DOM this uses (real elements in the page, small fakes in tests). */
export interface LoadingElement {
  querySelector(selector: string): LoadingElement | null;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { add(...c: string[]): void; toggle(c: string, on?: boolean): boolean };
  readonly style: { transform: string };
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: 'click', fn: () => void): void;
  remove(): void;
  focus?(): void;
}

/** What sits under the screen (the HUD + menu root): made inert while loading. */
export interface InertTarget {
  inert: boolean;
}

export interface LoadingEnv {
  now(): number;
  /** Call `fn` every `ms`; returns a stop function. */
  every(fn: () => void, ms: number): () => void;
  after(fn: () => void, ms: number): void;
  reducedMotion: boolean;
  reload(): void;
  /** Resolves once the browser has had a chance to paint. */
  paint(): Promise<void>;
}

export interface LoadingOptions {
  tips?: readonly string[];
  /** No report for this long marks the load as stalled (it keeps going). */
  stallMs?: number;
  /** When loading began (env clock): the page's start, so the script stage has its real time. */
  startedAt?: number;
  /**
   * The HUD/menu root under the screen. It is inert while loading (the menu's Play buttons exist
   * from the Game constructor on, and Tab + Enter would reach them under the overlay), live
   * again during `pause` (the friend lobby lives there) and from `finish` on.
   */
  under?: InertTarget | null;
  /** The cinematic backdrop (stills.ts): the page's slides and the rotation order. */
  backdrop?: { host: BackdropHost; stills: readonly Still[] } | null;
}

/** Redraw rate of the bar (the model eases between redraws; CSS smooths the steps). */
export const TICK_MS = 100;
/** Generous: software WebGL (CI) compiles shaders for minutes, but always reports between. */
export const STALL_MS = 90_000;
const TIP_MS = 7000;
/** Matches the CSS fade-out. */
const FADE_MS = 400;

export class LoadingScreen implements BootSink {
  readonly progress: BootProgress;
  private readonly bar: LoadingElement | null;
  private readonly track: LoadingElement | null;
  private readonly pct: LoadingElement | null;
  private readonly stageText: LoadingElement | null;
  private readonly tipText: LoadingElement | null;
  private readonly message: LoadingElement | null;
  private readonly detail: LoadingElement | null;
  private readonly reloadButton: LoadingElement | null;
  private readonly under: InertTarget | null;
  private readonly tips: readonly string[];
  private readonly stallMs: number;
  private readonly backdrop: StillRotator | null;
  private stop: (() => void) | null;
  private paused = false;
  private tipIndex = 0;
  private tipAt: number;
  private drawnLabel = '';
  private drawnState = '';
  private removed = false;

  constructor(
    private readonly root: LoadingElement,
    private readonly env: LoadingEnv,
    opts: LoadingOptions = {},
  ) {
    const now = env.now();
    this.progress = new BootProgress(BOOT_STAGES, Math.min(now, opts.startedAt ?? now));
    this.tips = opts.tips ?? [];
    this.stallMs = opts.stallMs ?? STALL_MS;
    this.bar = root.querySelector('[data-l="bar"]');
    this.track = root.querySelector('[data-l="track"]');
    this.pct = root.querySelector('[data-l="pct"]');
    this.stageText = root.querySelector('[data-l="stage"]');
    this.tipText = root.querySelector('[data-l="tip"]');
    this.message = root.querySelector('[data-l="message"]');
    this.detail = root.querySelector('[data-l="detail"]');
    this.reloadButton = root.querySelector('[data-l="reload"]');
    this.reloadButton?.addEventListener('click', () => env.reload());
    this.under = opts.under ?? null;
    if (this.under) this.under.inert = true;
    // The inline watchdog in index.html stands down once the bundle has taken over.
    root.dataset.claimed = '1';
    if (env.reducedMotion) root.classList.add('wdl-still');
    this.backdrop = opts.backdrop
      ? new StillRotator(opts.backdrop.host, opts.backdrop.stills, {
          now,
          reducedMotion: env.reducedMotion,
          ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
        })
      : null;
    this.tipAt = now;
    this.showTip();
    this.progress.report('physics', 0, now);
    this.draw(now);
    this.stop = env.every(() => this.tick(), TICK_MS);
  }

  /** Game.create's reporter. A new stage's words are drawn at once (before a long build). */
  readonly report: BootReporter = (stage: BootStage, done = 0) => {
    if (this.removed) return;
    const now = this.env.now();
    this.progress.report(stage, done, now);
    if (this.progress.label !== this.drawnLabel) this.draw(now);
  };

  /** Let the new stage's words paint before a long synchronous build. */
  paint(): Promise<void> {
    return this.env.paint();
  }

  /** Name the map in the build stage ("Building the Market"). */
  setLabel(stage: BootStage, label: string): void {
    this.progress.setLabel(stage, label);
  }

  /** Hide while the friend lobby is up (waiting on players is not a stall). */
  pause(): void {
    this.paused = true;
    this.root.dataset.state = 'hidden';
    this.drawnState = 'hidden';
    if (this.under) this.under.inert = false;
  }

  resume(): void {
    this.paused = false;
    if (this.under) this.under.inert = true;
    this.progress.touch(this.env.now());
    this.draw(this.env.now());
  }

  /** Boot threw: say so, with a Reload button, instead of a frozen bar. */
  fail(error: unknown): void {
    if (this.removed) return;
    const text = error instanceof Error ? error.message : String(error);
    this.progress.fail(text || 'unknown error');
    this.paused = false;
    // Even if it failed during the lobby: the half-built game underneath is not usable.
    if (this.under) this.under.inert = true;
    this.stopTicking();
    this.draw(this.env.now());
    this.reloadButton?.focus?.();
  }

  /**
   * The game is ready (warm-up done). The screen stops catching input at once and fades out,
   * then leaves the DOM; `instant` (autotest) removes it in the same call.
   */
  finish(instant = false): void {
    if (this.removed || this.progress.state === 'error') return;
    this.progress.complete(this.env.now());
    // The game is live now (same moment the screen stops catching pointer input).
    if (this.under) this.under.inert = false;
    this.stopTicking();
    this.draw(this.env.now());
    this.logTimings();
    if (instant || this.env.reducedMotion) this.remove();
    else this.env.after(() => this.remove(), FADE_MS);
  }

  get isRemoved(): boolean {
    return this.removed;
  }

  private tick(): void {
    const now = this.env.now();
    if (this.paused) {
      this.progress.touch(now);
      return;
    }
    this.progress.checkStall(now, this.stallMs);
    this.backdrop?.tick(now);
    if (this.tips.length > 1 && now - this.tipAt >= TIP_MS) {
      this.tipAt = now;
      this.tipIndex = (this.tipIndex + 1) % this.tips.length;
      this.showTip();
    }
    this.draw(now);
  }

  private draw(now: number): void {
    const p = this.progress;
    const v = p.value(now);
    const state = p.state;
    if (state !== this.drawnState) {
      this.drawnState = state;
      this.root.dataset.state = state;
      if (this.message) {
        this.message.textContent =
          state === 'error'
            ? 'Something went wrong while loading.'
            : state === 'stalled'
              ? 'This is taking much longer than it should.'
              : '';
      }
      if (this.detail) this.detail.textContent = state === 'error' ? p.error : '';
    }
    if (this.bar) this.bar.style.transform = `scaleX(${v.toFixed(4)})`;
    const pct = String(Math.floor(v * 100));
    if (this.pct && this.pct.textContent !== pct) {
      this.pct.textContent = pct;
      this.track?.setAttribute('aria-valuenow', pct);
    }
    const label = p.state === 'error' ? 'Loading stopped' : p.label;
    if (label !== this.drawnLabel) {
      this.drawnLabel = label;
      if (this.stageText) this.stageText.textContent = label;
    }
  }

  private showTip(): void {
    const tip = this.tips[this.tipIndex];
    if (!this.tipText || tip === undefined) return;
    this.tipText.textContent = tip;
    // Restart the CSS fade-in (a class toggle; nothing animates from script).
    this.tipText.classList.toggle('wdl-tip-b', this.tipIndex % 2 === 1);
  }

  private stopTicking(): void {
    this.backdrop?.stop();
    this.stop?.();
    this.stop = null;
  }

  private remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.stopTicking();
    this.root.remove();
  }

  private logTimings(): void {
    const parts = [...this.progress.timings()].map(([s, ms]) => `${s} ${Math.round(ms)}`);
    console.info(`[boot] stage ms: ${parts.join(' · ')}`);
  }
}

/** The page's loading screen, or null when the page has none (the lead's probes, old HTML). */
export function attachLoadingScreen(
  opts: LoadingOptions & { weather?: WeatherId } = {},
): LoadingScreen | null {
  const root = document.getElementById('wd-loading');
  if (!root) return null;
  const { weather, ...rest } = opts;
  const host = domBackdrop(root);
  const env: LoadingEnv = {
    now: () => performance.now(),
    every: (fn, ms) => {
      const id = window.setInterval(fn, ms);
      return () => window.clearInterval(id);
    },
    after: (fn, ms) => void window.setTimeout(fn, ms),
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    reload: () => window.location.reload(),
    paint: nextPaint,
  };
  // performance.now() counts from navigation: the script stage is the bundle's download + parse.
  return new LoadingScreen(root, env, {
    startedAt: 0,
    backdrop: host ? { host, stills: orderStills(STILLS, weather) } : null,
    ...rest,
  });
}

/**
 * Let the browser paint the loading screen before a long synchronous build. Never waits on a
 * frame alone: a background tab runs no animation frames, and the load must not stop there.
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = window.setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      window.setTimeout(() => {
        window.clearTimeout(fallback);
        resolve();
      }, 0),
    );
  });
}
