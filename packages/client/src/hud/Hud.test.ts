import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Just enough DOM for the HUD (the client tests run in node, without jsdom). */
class FakeEl {
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  className = '';
  innerHTML = '';
  offsetWidth = 0;
  private text = '';
  writes = 0;
  readonly style = {
    props: new Map<string, string>(),
    setProperty(k: string, v: string): void {
      this.props.set(k, v);
    },
  } as { props: Map<string, string>; setProperty(k: string, v: string): void } & Record<
    string,
    unknown
  >;
  readonly classList = {
    set: new Set<string>(),
    add: (...c: string[]) => c.forEach((x) => this.classList.set.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classList.set.delete(x)),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classList.set.has(c);
      if (want) this.classList.set.add(c);
      else this.classList.set.delete(c);
      return want;
    },
    contains: (c: string) => this.classList.set.has(c) || this.className.split(' ').includes(c),
  };
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.writes++;
    this.text = v;
    this.children.length = 0;
  }
  append(...c: FakeEl[]): void {
    for (const x of c) if (!this.children.includes(x)) this.children.push(x);
  }
  prepend(c: FakeEl): void {
    this.children.unshift(c);
  }
  find(pred: (e: FakeEl) => boolean): FakeEl | undefined {
    for (const c of this.children) {
      if (pred(c)) return c;
      const d = c.find(pred);
      if (d) return d;
    }
    return undefined;
  }
}

const g = globalThis as { document?: unknown; window?: unknown };
beforeAll(() => {
  g.document = { createElement: () => new FakeEl() };
  g.window = { innerWidth: 1600, innerHeight: 900 };
});
afterAll(() => {
  delete g.document;
  delete g.window;
});

const make = async () => {
  const { Hud } = await import('./Hud.ts');
  const parent = new FakeEl();
  const hud = new Hud(parent as unknown as HTMLElement);
  const root = hud.root as unknown as FakeEl;
  const byTestId = (id: string) => root.find((e) => e.dataset.testid === id)!;
  const byClass = (c: string) => root.find((e) => e.className.split(' ').includes(c))!;
  return { hud, byTestId, byClass };
};

describe('Hud', () => {
  it('updates the weapon-drop prompt only when its text changes', async () => {
    const { hud, byTestId } = await make();
    const prompt = byTestId('weapon-drop-prompt');
    hud.setDropPrompt('E  Take AR-7 rifle');
    const writes = prompt.writes;
    hud.setDropPrompt('E  Take AR-7 rifle');
    expect(prompt.writes).toBe(writes);
    expect(prompt.classList.contains('on')).toBe(true);
    hud.setDropPrompt(null);
    expect(prompt.classList.contains('on')).toBe(false);
    expect(prompt.textContent).toBe('');
  });

  it('shows the PRONE and BOARD chips only while active', async () => {
    const { hud, byTestId } = await make();
    const prone = byTestId('status-prone');
    const board = byTestId('status-board');
    expect(prone.textContent).toBe('PRONE');
    expect(board.textContent).toBe('BOARD');
    hud.setStatus({ prone: true, board: false });
    expect(prone.classList.contains('on')).toBe(true);
    expect(board.classList.contains('on')).toBe(false);
    hud.setStatus({ prone: false, board: true });
    expect(prone.classList.contains('on')).toBe(false);
    expect(board.classList.contains('on')).toBe(true);
  });

  it('shows PROTECTED with a draining bar while spawn-protected, hidden at 0', async () => {
    const { hud, byTestId } = await make();
    const chip = byTestId('status-protected');
    expect(chip.textContent).toBe('PROTECTED');
    expect(chip.classList.contains('on')).toBe(false);
    const fill = chip.find((e) => e.className === '')!; // the bar inside the drain track
    hud.setStatus({ prone: false, board: false, protection: 1 });
    expect(chip.classList.contains('on')).toBe(true);
    expect(fill.style.transform).toBe('scaleX(1)');
    hud.setStatus({ prone: false, board: false, protection: 0.5 });
    expect(fill.style.transform).toBe('scaleX(0.5)');
    hud.setStatus({ prone: false, board: false, protection: 0 });
    expect(chip.classList.contains('on')).toBe(false);
    hud.setStatus({ prone: true, board: false }); // callers without protection: off
    expect(chip.classList.contains('on')).toBe(false);
  });

  it('the blocked marker is its own look, and a normal hit marker clears it', async () => {
    const { hud, byClass } = await make();
    const marker = byClass('hitmarker');
    hud.blockedMarker();
    expect(marker.classList.contains('blocked')).toBe(true);
    expect(marker.classList.contains('show')).toBe(true);
    hud.hitmarker('torso', false);
    expect(marker.classList.contains('blocked')).toBe(false);
    expect(marker.classList.contains('show')).toBe(true);
  });

  it('writes the ammo readout only when it changes and empties the round ticks', async () => {
    const { hud, byTestId, byClass } = await make();
    const ammo = byTestId('ammo');
    hud.setAmmo(30, 120, 'AR-7 rifle', false, 30);
    const writes = ammo.writes;
    for (let i = 0; i < 10; i++) hud.setAmmo(30, 120, 'AR-7 rifle', false, 30);
    expect(ammo.writes).toBe(writes);
    expect(ammo.textContent).toBe('30 / 120');
    hud.setAmmo(6, 120, 'AR-7 rifle', false, 30);
    const ticks = byClass('mag-ticks').children;
    expect(ticks).toHaveLength(30);
    expect(ticks.filter((t) => !t.classList.contains('spent'))).toHaveLength(6);
    expect(ammo.classList.contains('low')).toBe(true);
    expect(byClass('ammo-box').classList.contains('low')).toBe(true);
    hud.setAmmo(-1, -1, 'Combat knife', false);
    expect(ammo.textContent).toBe('—');
    expect(byClass('ammo-box').classList.contains('melee')).toBe(true);
  });

  it('flags low health below 30', async () => {
    const { hud, byClass } = await make();
    const box = byClass('health-box');
    hud.setHealth(100, 100);
    expect(box.classList.contains('low')).toBe(false);
    hud.setHealth(22, 100);
    expect(box.classList.contains('low')).toBe(true);
    expect(byClass('health-num').textContent).toBe('22');
    hud.setHealth(45, 100);
    expect(box.classList.contains('low')).toBe(false);
    expect(box.classList.contains('mid')).toBe(true);
  });

  it('drops the heat readout (OVERHEAT) when switching from an overheated energy gun to the knife', async () => {
    const { hud, byClass } = await make();
    const box = byClass('ammo-box');
    hud.setHeat(1, true, 'ARC');
    expect(box.classList.contains('overheated')).toBe(true);
    hud.setAmmo(-1, -1, 'Combat knife', false);
    expect(box.classList.contains('melee')).toBe(true);
    for (const c of ['heat', 'hot', 'overheated']) expect(box.classList.contains(c), c).toBe(false);
    hud.setHeat(0.8, false, 'ARC');
    hud.setAmmo(-1, -1, 'Combat knife', false);
    expect(box.classList.contains('hot')).toBe(false);
  });

  it("draws the scope's aiming dot outside the reticle's centre mask", () => {
    // A CSS mask also cuts the element's own ::before/::after, so the dot can't live on it.
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selectors: m[1]!.split(',').map((x) => x.trim()),
      body: m[2]!,
    }));
    const masked = new Set(
      rules.filter((r) => /(^|[\s;])mask\s*:/.test(r.body)).flatMap((r) => r.selectors),
    );
    expect(masked.has('.scope-reticle')).toBe(true);
    const dot = rules.find(
      (r) => r.selectors.some((x) => x.startsWith('.scope')) && /border-radius:\s*50%/.test(r.body),
    );
    expect(dot, 'scope dot rule').toBeDefined();
    for (const sel of dot!.selectors) {
      const host = sel.replace(/::?(after|before)$/, '');
      for (let s = host; s; s = s.replace(/\s*\S+$/, '')) expect(masked.has(s), sel).toBe(false);
    }
  });
});
