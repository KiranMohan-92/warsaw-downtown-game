import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LoadingScreen,
  STALL_MS,
  TICK_MS,
  type LoadingElement,
  type LoadingEnv,
} from './LoadingScreen.ts';
import { resolveTips, rotateTips, TIPS } from './tips.ts';

/** Just enough of the index.html loading screen (the client tests run in node, without jsdom). */
class FakeEl implements LoadingElement {
  readonly dataset: Record<string, string | undefined> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
  };
  readonly style = { transform: '' };
  readonly attrs = new Map<string, string>();
  readonly parts = new Map<string, FakeEl>();
  textContent: string | null = '';
  removed = false;
  focused = false;
  private click: (() => void) | null = null;
  focus(): void {
    this.focused = true;
  }
  querySelector(selector: string): FakeEl | null {
    const m = /^\[data-l="(\w+)"\]$/.exec(selector);
    return m ? (this.parts.get(m[1]!) ?? null) : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  addEventListener(_type: 'click', fn: () => void): void {
    this.click = fn;
  }
  press(): void {
    this.click?.();
  }
  remove(): void {
    this.removed = true;
  }
}

function page(): FakeEl {
  const root = new FakeEl();
  for (const part of ['bar', 'track', 'pct', 'stage', 'tip', 'message', 'detail', 'reload']) {
    root.parts.set(part, new FakeEl());
  }
  return root;
}

/** A manual clock and timers: `advance` runs the 10 Hz redraw as the page would. */
function env(reducedMotion = false): LoadingEnv & {
  advance(ms: number): void;
  reloads: number;
  intervals: number;
} {
  let now = 1000;
  const every: { fn: () => void; ms: number; next: number }[] = [];
  const after: { fn: () => void; at: number }[] = [];
  const e = {
    reloads: 0,
    get intervals() {
      return every.length;
    },
    now: () => now,
    every: (fn: () => void, ms: number) => {
      const t = { fn, ms, next: now + ms };
      every.push(t);
      return () => void every.splice(every.indexOf(t), 1);
    },
    after: (fn: () => void, ms: number) => void after.push({ fn, at: now + ms }),
    reducedMotion,
    reload: () => void e.reloads++,
    paint: () => Promise.resolve(),
    advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 10);
        for (const t of [...every]) {
          if (now >= t.next) {
            t.next += t.ms;
            t.fn();
          }
        }
        for (const a of after.filter((x) => now >= x.at)) {
          after.splice(after.indexOf(a), 1);
          a.fn();
        }
      }
    },
  };
  return e;
}

const part = (root: FakeEl, name: string): FakeEl => root.parts.get(name)!;
const scale = (root: FakeEl): number =>
  Number(/scaleX\(([\d.]+)\)/.exec(part(root, 'bar').style.transform)?.[1] ?? NaN);

afterEach(() => vi.restoreAllMocks());

describe('loading screen', () => {
  it('claims the static screen and draws stages in plain words', () => {
    const root = page();
    const e = env();
    const screen = new LoadingScreen(root, e, { tips: ['one', 'two'] });
    expect(root.dataset.claimed).toBe('1');
    expect(root.dataset.state).toBe('loading');
    expect(part(root, 'stage').textContent).toBe('Starting physics');
    screen.setLabel('map', 'Building the Market');
    screen.report('map');
    // Drawn at once, not at the next redraw (a synchronous build follows).
    expect(part(root, 'stage').textContent).toBe('Building the Market');
    e.advance(2000);
    expect(scale(root)).toBeGreaterThan(0.3);
    expect(part(root, 'track').attrs.get('aria-valuenow')).toBe(part(root, 'pct').textContent);
  });

  it('redraws at ~10 Hz and the bar never goes back', () => {
    const root = page();
    const e = env();
    const screen = new LoadingScreen(root, e);
    let last = 0;
    const steps: [Parameters<typeof screen.report>[0], number][] = [
      ['surfaces', 0],
      ['map', 0],
      ['assets', 0.3],
      ['assets', 0.1],
      ['physics', 1],
      ['shaders', 0.5],
    ];
    for (const [stage, done] of steps) {
      screen.report(stage, done);
      for (let i = 0; i < 10; i++) {
        e.advance(TICK_MS);
        const v = scale(root);
        expect(v).toBeGreaterThanOrEqual(last);
        last = v;
      }
    }
    expect(e.intervals).toBe(1);
  });

  it('rotates tips', () => {
    const root = page();
    const e = env();
    new LoadingScreen(root, e, { tips: ['one', 'two', 'three'] });
    expect(part(root, 'tip').textContent).toBe('one');
    e.advance(7100);
    expect(part(root, 'tip').textContent).toBe('two');
    expect(part(root, 'tip').classes.has('wdl-tip-b')).toBe(true);
  });

  it('a stalled stage says so with Reload, and recovers if loading goes on', () => {
    const root = page();
    const e = env();
    const screen = new LoadingScreen(root, e, { stallMs: 5000 });
    screen.report('assets', 0.2);
    e.advance(5200);
    expect(root.dataset.state).toBe('stalled');
    expect(part(root, 'message').textContent).toMatch(/longer than it should/);
    part(root, 'reload').press();
    expect(e.reloads).toBe(1);
    screen.report('assets', 0.4);
    e.advance(TICK_MS);
    expect(root.dataset.state).toBe('loading');
    expect(part(root, 'message').textContent).toBe('');
    expect(STALL_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('a boot error shows the message and stops redrawing', () => {
    const root = page();
    const e = env();
    const screen = new LoadingScreen(root, e);
    screen.fail(new Error('WebGL2 is not available'));
    expect(root.dataset.state).toBe('error');
    expect(part(root, 'message').textContent).toBe('Something went wrong while loading.');
    expect(part(root, 'detail').textContent).toBe('WebGL2 is not available');
    expect(part(root, 'stage').textContent).toBe('Loading stopped');
    expect(e.intervals).toBe(0);
    // A late finish cannot hide the error.
    screen.finish();
    expect(root.removed).toBe(false);
  });

  it('is paused (hidden, never stalled) while the friend lobby is up', () => {
    const root = page();
    const e = env();
    const screen = new LoadingScreen(root, e, { stallMs: 5000 });
    screen.pause();
    expect(root.dataset.state).toBe('hidden');
    e.advance(60_000);
    expect(root.dataset.state).toBe('hidden');
    screen.resume();
    expect(root.dataset.state).toBe('loading');
    e.advance(1000);
    expect(root.dataset.state).toBe('loading');
  });

  it('fades out on ready, stops catching input at once, then leaves the DOM', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const root = page();
    const e = env();
    const screen = new LoadingScreen(root, e);
    screen.report('shaders', 0.5);
    screen.finish();
    // `done` = opacity 0 + pointer-events none (index.html CSS); the element stays for the fade.
    expect(root.dataset.state).toBe('done');
    expect(scale(root)).toBe(1);
    expect(part(root, 'pct').textContent).toBe('100');
    expect(root.removed).toBe(false);
    expect(e.intervals).toBe(0);
    e.advance(500);
    expect(root.removed).toBe(true);
    expect(screen.isRemoved).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[boot\] stage ms: .*shaders/));
    // Late reports after removal are ignored.
    screen.report('shaders', 1);
    expect(e.intervals).toBe(0);
  });

  it('autotest removes it in the same call as ready', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const root = page();
    const screen = new LoadingScreen(root, env());
    screen.finish(true);
    expect(root.removed).toBe(true);
  });

  it('reduced motion: marked still, and removed without a fade', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const root = page();
    const screen = new LoadingScreen(root, env(true));
    expect(root.classes.has('wdl-still')).toBe(true);
    screen.finish();
    expect(root.removed).toBe(true);
    const moving = page();
    new LoadingScreen(moving, env(false));
    expect(moving.classes.has('wdl-still')).toBe(false);
  });
});

describe('the HUD under the loading screen', () => {
  it('takes no focus while loading, is live in the friend lobby, and from ready on', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const hud = { inert: false };
    const root = page();
    const screen = new LoadingScreen(root, env(), { under: hud });
    // The menu's Play buttons exist from the Game constructor on: not reachable by Tab + Enter.
    expect(hud.inert).toBe(true);
    screen.pause();
    expect(hud.inert).toBe(false);
    screen.resume();
    expect(hud.inert).toBe(true);
    screen.report('shaders', 0.9);
    expect(hud.inert).toBe(true);
    screen.finish();
    // Live at once, while the screen is still fading (it no longer catches input either).
    expect(hud.inert).toBe(false);
    expect(root.removed).toBe(false);
  });

  it('stays inert after a boot error (even one in the lobby); focus goes to Reload', () => {
    const hud = { inert: false };
    const root = page();
    const screen = new LoadingScreen(root, env(), { under: hud });
    screen.pause();
    screen.fail(new Error('room closed'));
    expect(hud.inert).toBe(true);
    expect(root.dataset.state).toBe('error');
    expect(part(root, 'reload').focused).toBe(true);
  });
});

describe('loading tips', () => {
  it('rotate from one random start: every tip exactly once per cycle, order kept', () => {
    for (let start = -3; start < TIPS.length + 3; start += 0.5) {
      const r = rotateTips(TIPS, start);
      expect(r.length).toBe(TIPS.length);
      expect(new Set(r)).toEqual(new Set(TIPS));
      const k = TIPS.indexOf(r[0]!);
      r.forEach((t, i) => expect(t).toBe(TIPS[(k + i) % TIPS.length]));
    }
    expect(rotateTips(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
    expect(rotateTips([], 3)).toEqual([]);
  });

  it('the screen shows the rotated list in order and wraps after the last', () => {
    const root = page();
    const e = env();
    const tips = rotateTips(['a', 'b', 'c'], 2);
    new LoadingScreen(root, e, { tips });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(part(root, 'tip').textContent ?? '');
      e.advance(7000);
    }
    expect(seen).toEqual(['c', 'a', 'b', 'c', 'a', 'b']);
  });

  it("use the player's keys and drop tips whose key is unbound", () => {
    const keys: Record<string, string> = { prone: 'Z', block: 'F', radar: 'T', grenade: 'G' };
    const tips = resolveTips((a) => keys[a] ?? null);
    expect(tips).toContain('Press Z to go prone and lie flat behind low cover.');
    expect(tips.some((t) => t.includes('{'))).toBe(false);
    // melee and inspect are unbound here: those two tips are left out.
    expect(tips.length).toBe(TIPS.length - 2);
  });

  it('never mention a slide or give away the secret', () => {
    for (const t of TIPS) {
      expect(t).not.toMatch(/slide|skate|board|helicopter/i);
    }
  });
});

describe('index.html loading screen', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

  it('is static markup painted before the bundle, with every part the controller drives', () => {
    const screen = html.indexOf('id="wd-loading"');
    expect(screen).toBeGreaterThan(0);
    expect(screen).toBeLessThan(html.indexOf('src="/src/main.ts"'));
    // Inline CSS in <head>: nothing to fetch before the first paint.
    expect(html.indexOf('#wd-loading {')).toBeLessThan(html.indexOf('</head>'));
    for (const p of ['bar', 'track', 'pct', 'stage', 'tip', 'message', 'detail', 'reload']) {
      expect(html).toContain(`data-l="${p}"`);
    }
    expect(html).toContain('OpenStreetMap contributors');
  });

  it('never catches input once done, and honours reduced motion before the bundle runs', () => {
    expect(html).toMatch(/#wd-loading\[data-state='done'\] \{[^}]*pointer-events: none/);
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toMatch(/#wd-loading\.wdl-still/);
    // An inline watchdog covers a bundle that never loads, and stands down once claimed.
    expect(html).toMatch(/hasAttribute\('data-claimed'\)/);
  });

  it('scrolls itself on short viewports, so Reload stays reachable', () => {
    const block = /#wd-loading \{([^}]*)\}/.exec(html)?.[1] ?? '';
    expect(block).toMatch(/overflow: auto/);
    expect(block).not.toMatch(/overflow: hidden/);
    expect(html).toMatch(/@media \(max-height: 520px\)/);
  });
});
