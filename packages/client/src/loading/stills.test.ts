import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LoadingScreen, TICK_MS, type LoadingElement, type LoadingEnv } from './LoadingScreen.ts';
import {
  FADE_MS,
  HOLD_MS,
  KB_VARIANTS,
  orderStills,
  PORTRAIT_QUERY,
  PRELOAD_DELAY_MS,
  STILL_FADE_MS,
  STILL_HOLD_MS,
  STILLS,
  StillRotator,
  stillUrl,
  type BackdropHost,
  type Still,
} from './stills.ts';

/** The page's clock as CSS sees it: delayed fades happen at their time without any tick. */
const clock = { t: 0 };

/** A slide as the rotator sees it, plus what happened to it. */
class FakeSlide {
  onFrom = Infinity;
  offFrom = Infinity;
  removed = false;
  shows = 0;
  lastDelay = NaN;
  constructor(
    readonly id: string,
    readonly variant: number,
  ) {}
  get on(): boolean {
    return clock.t >= this.onFrom && clock.t < this.offFrom;
  }
  show(delayMs: number): void {
    this.onFrom = clock.t + delayMs;
    this.offFrom = Infinity;
    this.lastDelay = delayMs;
    this.shows++;
  }
  hide(delayMs: number): void {
    this.offFrom = clock.t + delayMs;
  }
  remove(): void {
    this.removed = true;
  }
}

/** The page's backdrop: loads finish only when the test says so. */
function host(withFirst = true) {
  clock.t = 0;
  const first = new FakeSlide(STILLS[0]!.id, 0);
  first.onFrom = -Infinity;
  const loads: { slide: FakeSlide; done: (ok: boolean) => void }[] = [];
  const h: BackdropHost & { loads: typeof loads; first0: FakeSlide } = {
    loads,
    first0: first,
    first: () => (withFirst ? first : null),
    load: (still: Still, variant: number, done: (ok: boolean) => void) => {
      const slide = new FakeSlide(still.id, variant);
      loads.push({ slide, done });
      return slide;
    },
  };
  return h;
}

/** Steps the rotator at the loading screen's 10 Hz. */
function run(r: StillRotator, from: number, ms: number): number {
  for (let t = from + TICK_MS; t <= from + ms; t += TICK_MS) {
    clock.t = t;
    r.tick(t);
  }
  clock.t = from + ms;
  return from + ms;
}

const onScreen = (h: ReturnType<typeof host>): string[] =>
  [h.first0, ...h.loads.map((l) => l.slide)].filter((s) => s.on).map((s) => s.id);

describe('loading backdrop rotation', () => {
  it('loads the next still only after the first paint, one at a time, and crossfades on time', () => {
    const h = host();
    const r = new StillRotator(h, STILLS, { now: 0, reducedMotion: false });
    let t = run(r, 0, PRELOAD_DELAY_MS - TICK_MS);
    expect(h.loads.length).toBe(0);
    t = run(r, t, TICK_MS);
    expect(h.loads.length).toBe(1);
    expect(h.loads[0]!.slide.id).toBe(STILLS[1]!.id);
    h.loads[0]!.done(true);
    // Decoded: armed at once for the end of the first still's hold (a CSS delay)…
    t = run(r, t, TICK_MS);
    expect(h.loads[0]!.slide.shows).toBe(1);
    expect(h.loads[0]!.slide.lastDelay).toBe(HOLD_MS - t);
    // …so the first still keeps its hold.
    t = run(r, t, HOLD_MS - t - TICK_MS);
    expect(onScreen(h)).toEqual([STILLS[0]!.id]);
    expect(h.loads.length).toBe(1);
    t = run(r, t, TICK_MS);
    expect(onScreen(h)).toEqual([STILLS[1]!.id]);
    expect(r.count).toBe(2);
    // The old one fades (CSS) and leaves the DOM once the fade is over.
    expect(h.first0.removed).toBe(false);
    t = run(r, t, FADE_MS + 200);
    expect(h.first0.removed).toBe(true);
    // Each still gets the next Ken Burns variant.
    h.loads[1]!.done(true);
    run(r, t, HOLD_MS);
    expect(h.loads.slice(0, 2).map((l) => l.slide.variant)).toEqual([
      1 % KB_VARIANTS,
      2 % KB_VARIANTS,
    ]);
  });

  it('crossfades on time even when the main thread is blocked (no ticks) through the hold', () => {
    const h = host();
    const r = new StillRotator(h, STILLS, { now: 0, reducedMotion: false });
    run(r, 0, PRELOAD_DELAY_MS);
    h.loads[0]!.done(true);
    run(r, PRELOAD_DELAY_MS, TICK_MS);
    // A 14 s synchronous map build starts here: no tick until it ends.
    clock.t = HOLD_MS - 1;
    expect(onScreen(h)).toEqual([STILLS[0]!.id]);
    clock.t = HOLD_MS;
    expect(onScreen(h)).toEqual([STILLS[1]!.id]);
    clock.t = 14_000;
    expect(onScreen(h)).toEqual([STILLS[1]!.id]);
    // After the block: the old slide leaves the DOM and the next still is fetched.
    r.tick(14_000);
    expect(h.first0.removed).toBe(true);
    expect(h.loads.length).toBe(2);
  });

  it('counts the first still from the page start, not from when the bundle ran', () => {
    const h = host();
    const r = new StillRotator(h, STILLS, { now: 3000, startedAt: 0, reducedMotion: false });
    r.tick(3000);
    expect(h.loads.length).toBe(1);
    h.loads[0]!.done(true);
    run(r, 3000, HOLD_MS - 3000);
    expect(onScreen(h)).toEqual([STILLS[1]!.id]);
  });

  it('a slow load holds the current still (never a blank), a failed one is skipped', () => {
    const h = host();
    const r = new StillRotator(h, STILLS, { now: 0, reducedMotion: false });
    let t = run(r, 0, HOLD_MS * 3);
    expect(onScreen(h)).toEqual([STILLS[0]!.id]);
    expect(h.loads.length).toBe(1);
    h.loads[0]!.done(false);
    t = run(r, t, TICK_MS * 2);
    expect(h.loads[0]!.slide.removed).toBe(true);
    expect(h.loads[0]!.slide.shows).toBe(0);
    // The next one is tried at once (the hold is long over) and shown when decoded.
    expect(h.loads[1]!.slide.id).toBe(STILLS[2]!.id);
    h.loads[1]!.done(true);
    run(r, t, TICK_MS);
    expect(onScreen(h)).toEqual([STILLS[2]!.id]);
  });

  it('wraps round the list, and every slide but the one on screen leaves the DOM', () => {
    const h = host();
    const r = new StillRotator(h, STILLS, { now: 0, reducedMotion: false });
    let t = 0;
    for (let i = 0; i < STILLS.length + 2; i++) {
      t = run(r, t, PRELOAD_DELAY_MS);
      h.loads.at(-1)!.done(true);
      t = run(r, t, HOLD_MS);
    }
    run(r, t, FADE_MS + 200);
    const ids = h.loads.map((l) => l.slide.id);
    expect(ids.slice(0, STILLS.length)).toEqual([...STILLS.slice(1), STILLS[0]].map((s) => s!.id));
    expect(onScreen(h).length).toBe(1);
    const live = [h.first0, ...h.loads.map((l) => l.slide)].filter((s) => !s.removed);
    // The one on screen, and the next one loading (hidden, not yet shown).
    expect(live.length).toBe(2);
    expect(live[1]).toBe(h.loads.at(-1)!.slide);
    expect(live[1]!.shows).toBe(0);
  });

  it('reduced motion: longer holds (the pan is off and the fade slower, in CSS)', () => {
    const h = host();
    const r = new StillRotator(h, STILLS, { now: 0, reducedMotion: true });
    let t = run(r, 0, PRELOAD_DELAY_MS);
    h.loads[0]!.done(true);
    t = run(r, t, HOLD_MS * 1.2 - PRELOAD_DELAY_MS);
    expect(onScreen(h)).toEqual([STILLS[0]!.id]);
    t = run(r, t, STILL_HOLD_MS - HOLD_MS * 1.2);
    expect(onScreen(h)).toEqual([STILLS[1]!.id]);
    run(r, t, FADE_MS + 200);
    expect(h.first0.removed).toBe(false);
    expect(STILL_FADE_MS).toBeGreaterThan(FADE_MS);
    expect(STILL_HOLD_MS).toBeGreaterThan(HOLD_MS);
  });

  it('stop: no more loads, an unfinished load is dropped, the current still stays', () => {
    const h = host();
    const r = new StillRotator(h, STILLS, { now: 0, reducedMotion: false });
    run(r, 0, PRELOAD_DELAY_MS);
    r.stop();
    expect(h.loads[0]!.slide.removed).toBe(true);
    h.loads[0]!.done(true);
    run(r, PRELOAD_DELAY_MS, HOLD_MS * 3);
    expect(h.loads.length).toBe(1);
    expect(onScreen(h)).toEqual([STILLS[0]!.id]);
  });

  it('a page without the static still rotates nothing', () => {
    const h = host(false);
    const r = new StillRotator(h, STILLS, { now: 0, reducedMotion: false });
    run(r, 0, HOLD_MS * 2);
    expect(h.loads.length).toBe(0);
  });

  it('plays the saved weather first, keeping the static first still first', () => {
    // The shipped set is all golden hour (Trailer 2): a mixed list exercises the ordering.
    const mk = (id: string, weather: Still['weather']): Still => ({
      id,
      focus: [50, 50],
      portrait: [50, 50],
      weather,
    });
    const mixed = [mk('a', 'golden'), mk('b', 'dusk'), mk('c', 'rain'), mk('d', 'sunny')];
    const mixed2 = [...mixed, mk('e', 'sunny')];
    const rain = orderStills(mixed, 'rain');
    expect(rain[0]).toBe(mixed[0]);
    expect(rain[1]!.weather).toBe('rain');
    expect(new Set(rain)).toEqual(new Set(mixed));
    expect(
      orderStills(mixed2, 'sunny')
        .slice(1, 3)
        .every((s) => s.weather === 'sunny'),
    ).toBe(true);
    expect(orderStills(mixed, 'overcast')).toEqual(mixed);
    expect(orderStills(mixed)).toEqual(mixed);
    expect(orderStills(STILLS, 'golden')).toEqual(STILLS);
  });
});

describe('the loading screen drives the backdrop', () => {
  class El implements LoadingElement {
    readonly dataset: Record<string, string | undefined> = {};
    readonly classList = { add: () => {}, toggle: () => false };
    readonly style = { transform: '' };
    textContent: string | null = '';
    querySelector(): El | null {
      return null;
    }
    setAttribute(): void {}
    addEventListener(): void {}
    remove(): void {}
  }
  function env(): LoadingEnv & { advance(ms: number): void; intervals: number } {
    let now = 0;
    const every: { fn: () => void; ms: number; next: number }[] = [];
    return {
      get intervals() {
        return every.length;
      },
      now: () => now,
      every: (fn, ms) => {
        const t = { fn, ms, next: now + ms };
        every.push(t);
        return () => void every.splice(every.indexOf(t), 1);
      },
      after: () => {},
      reducedMotion: false,
      reload: () => {},
      paint: () => Promise.resolve(),
      advance(ms) {
        const end = now + ms;
        while (now < end) {
          now += 10;
          for (const t of [...every]) {
            if (now >= t.next) {
              t.next += t.ms;
              t.fn();
            }
          }
        }
      },
    };
  }

  it('on its own 10 Hz tick (no extra timers), held while paused, stopped at ready', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const h = host();
    const e = env();
    const screen = new LoadingScreen(new El(), e, { backdrop: { host: h, stills: STILLS } });
    expect(e.intervals).toBe(1);
    e.advance(PRELOAD_DELAY_MS + TICK_MS);
    expect(h.loads.length).toBe(1);
    h.loads[0]!.done(true);
    screen.pause();
    e.advance(HOLD_MS * 2);
    clock.t = e.now();
    expect(onScreen(h)).toEqual([STILLS[0]!.id]);
    expect(h.loads[0]!.slide.shows).toBe(0);
    screen.resume();
    e.advance(TICK_MS * 2);
    clock.t = e.now();
    expect(onScreen(h)).toEqual([STILLS[1]!.id]);
    e.advance(PRELOAD_DELAY_MS + TICK_MS);
    expect(h.loads.length).toBe(2);
    screen.finish();
    clock.t = e.now();
    // The pending load is dropped; the still on screen fades out with the screen.
    expect(h.loads[1]!.slide.removed).toBe(true);
    expect(onScreen(h)).toEqual([STILLS[1]!.id]);
  });
});

describe('loading stills in the page', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const dir = new URL('../../public/loading/', import.meta.url);

  it('the first still is static markup, preloaded in <head>, with its focal point', () => {
    const first = STILLS[0]!;
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toMatch(
      new RegExp(`<link rel="preload" as="image" href="${stillUrl(first)}" fetchpriority="high"`),
    );
    const screen = html.indexOf('id="wd-loading"');
    const img = html.indexOf(`src="${stillUrl(first)}"`);
    expect(img).toBeGreaterThan(screen);
    expect(img).toBeLessThan(html.indexOf('class="wdl-title"'));
    expect(html).toContain(`--fx: ${first.focus[0]}%; --fy: ${first.focus[1]}%`);
    expect(html).toMatch(/class="wdl-slide wdl-on wdl-play wdl-kb-0"/);
    expect(html).toContain('data-l="bg"');
    // The rest are fetched by the bundle at low priority, never by the page itself.
    for (const s of STILLS.slice(1)) expect(html).not.toContain(stillUrl(s));
    const ts = readFileSync(new URL('./stills.ts', import.meta.url), 'utf8');
    expect(ts).toMatch(/fetchPriority = 'low'/);
  });

  it('CSS fade times match the rotator, and reduced motion keeps a (slower) fade, no pan', () => {
    // Every variant keeps the armed delay (stills.ts Slide.show: fades on time during long tasks).
    const fade = 'var(--wdl-fade, 0ms)';
    expect(html).toContain(`transition: opacity ${FADE_MS / 1000}s ease-in-out ${fade};`);
    const still = `transition: opacity ${STILL_FADE_MS / 1000}s linear ${fade} !important;`;
    const block = (sel: string, from = html) => {
      const at = from.indexOf(`${sel} {`);
      return at < 0 ? '' : from.slice(at, from.indexOf('}', at));
    };
    expect(block('#wd-loading.wdl-still .wdl-bg .wdl-slide')).toContain(still);
    const media = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block('#wd-loading .wdl-bg .wdl-slide', media)).toContain(still);
    // The Ken Burns move outlasts hold + fade (it never stops before the slide has gone).
    const kb =
      /\.wdl-slide\.wdl-play img \{\s*animation: wdl-kb-0 (\d+)s [^;]*var\(--wdl-in, 0ms\) both;/.exec(
        html,
      );
    expect(Number(kb?.[1]) * 1000).toBeGreaterThan(HOLD_MS + FADE_MS);
    for (let v = 0; v < KB_VARIANTS; v++) expect(html).toContain(`@keyframes wdl-kb-${v} {`);
  });

  it('ships exactly the listed stills as WebP, within the download budget', () => {
    const files = readdirSync(dir).sort();
    const ids = STILLS.flatMap((s) => (s.portraitId ? [s.id, s.portraitId] : [s.id]));
    expect(files).toEqual(ids.map((id) => `${id}.webp`).sort());
    let total = 0;
    for (const id of ids) {
      const path = new URL(`${id}.webp`, dir);
      const head = readFileSync(path).subarray(0, 12);
      expect(head.toString('latin1', 0, 4)).toBe('RIFF');
      expect(head.toString('latin1', 8, 12)).toBe('WEBP');
      total += statSync(path).size;
    }
    expect(statSync(new URL(`${STILLS[0]!.id}.webp`, dir)).size).toBeLessThanOrEqual(200_000);
    for (const id of ids) expect(statSync(new URL(`${id}.webp`, dir)).size).toBeLessThan(200_000);
    expect(total).toBeLessThanOrEqual(1_000_000);
    expect(STILLS.length).toBeGreaterThanOrEqual(5);
    expect(STILLS.length).toBeLessThanOrEqual(8);
  });

  it('the builder lists the same stills in the same order', () => {
    const py = readFileSync(
      new URL('../../../../tools/assets/build_loading_stills.py', import.meta.url),
      'utf8',
    );
    const ids = [...py.matchAll(/^\s+\('(\w+)', '\w+', [\d.]+, [\d.]+\),$/gm)].map((m) => m[1]);
    expect(ids).toEqual(STILLS.map((s) => s.id));
    const portraits = [...py.matchAll(/^\s+\('(\w+)', '\w+', [\d.]+, [\d.]+, [\d.]+\),$/gm)];
    expect(portraits.map((m) => m[1])).toEqual(STILLS.flatMap((s) => s.portraitId ?? []));
  });

  it('portrait windows: a focal point per still, its portrait file if it has one', () => {
    for (const s of STILLS) {
      for (const v of [...s.focus, ...s.portrait]) expect(v >= 0 && v <= 100).toBe(true);
      expect(stillUrl(s)).toBe(`/loading/${s.id}.webp`);
      expect(stillUrl(s, true)).toBe(`/loading/${s.portraitId ?? s.id}.webp`);
    }
    // The ARC hero fills its 16:9 frame: phones get a full-body cut instead (Kiran, 2026-10-01).
    expect(STILLS.find((s) => s.id === 'jet_launch_golden')?.portraitId).toBeDefined();
    // The static first still is shared by both (no portrait file), framed by its portrait point.
    const first = STILLS[0]!;
    expect(first.portraitId).toBeUndefined();
    expect(html).toContain(`--px: ${first.portrait[0]}%; --py: ${first.portrait[1]}%`);
    // The CSS uses the same query as the file choice, with the portrait point and push-in.
    const at = html.indexOf(`@media ${PORTRAIT_QUERY} {`);
    expect(at).toBeGreaterThan(0);
    const media = html.slice(at, html.indexOf('.wdl-shade {', at));
    expect(media).toContain('object-position: var(--px, 50%) var(--py, 50%)');
    expect(media).toContain('transform-origin: var(--px, 50%) var(--py, 50%)');
    expect(media).toMatch(/#wd-loading \.wdl-slide\.wdl-play img \{\s*animation-name: wdl-kb-p;/);
    expect(html).toContain('@keyframes wdl-kb-p {');
    const ts = readFileSync(new URL('./stills.ts', import.meta.url), 'utf8');
    expect(ts).toMatch(/stillUrl\(still, window\.matchMedia\?\.\(PORTRAIT_QUERY\)/);
  });
});
