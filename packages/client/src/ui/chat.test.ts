import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUICK_CHAT, type ChatMessage, type ChatSendMessage } from '@wd/shared';
import { chatParts, chatVisible } from '../hud/ChatFeed.ts';
import { muteKeyIds, scoreboardRows } from '../hud/Scoreboard.ts';
import { ChatController } from './ChatController.ts';
import { ChatMutes, MUTES_KEY } from './chatMutes.ts';
import { LobbyChat } from './LobbyChat.ts';
import { bufferPregameChat, makeBuffer, PREGAME_CHAT_MAX } from '../net/friendLobby.ts';
import { wheelKey, wheelPick } from './QuickChat.ts';

/** Just enough DOM for the chat (client tests run in node, without jsdom). */
class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  className = '';
  innerHTML = '';
  hidden = false;
  value = '';
  type = '';
  maxLength = 0;
  spellcheck = true;
  autocomplete = '';
  placeholder = '';
  focused = false;
  private ownText = '';
  readonly classList = {
    set: new Set<string>(),
    add: (...c: string[]) => c.forEach((x) => this.classList.set.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classList.set.delete(x)),
    contains: (c: string) => this.classList.set.has(c),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classList.set.has(c);
      if (want) this.classList.set.add(c);
      else this.classList.set.delete(c);
      return want;
    },
  };
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.ownText = v;
    this.children = [];
  }
  append(...nodes: (FakeEl | string)[]): void {
    for (const n of nodes) {
      const el = typeof n === 'string' ? Object.assign(new FakeEl(), { textContent: n }) : n;
      el.parent = this;
      this.children.push(el);
    }
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  focus(): void {
    this.focused = true;
  }
  blur(): void {
    this.focused = false;
  }
  fire(type: string, e: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(e);
  }
  /** Every element under this one (depth first). */
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

const g = globalThis as unknown as { document?: unknown };
let savedDocument: unknown;
beforeAll(() => {
  savedDocument = g.document;
  g.document = { createElement: () => new FakeEl() };
});
afterAll(() => {
  g.document = savedDocument;
});

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 1,
  from: 'p2',
  name: 'Ania',
  slot: 1,
  kind: 'player',
  text: 'hi',
  ...over,
});

describe('chat filter and line parts', () => {
  it('mutes hide a player (bots too); quick-only hides typed lines; off hides everything', () => {
    const muted = new Set(['Ania', 'Taran']); // by name
    expect(chatVisible(msg({}), 'all', new Set())).toBe(true);
    expect(chatVisible(msg({}), 'all', muted)).toBe(false);
    expect(chatVisible(msg({ kind: 'bot', from: 'bot:1', name: 'Taran' }), 'all', muted)).toBe(
      false,
    );
    expect(chatVisible(msg({ kind: 'bot', from: 'bot:2', name: 'Lis' }), 'all', muted)).toBe(true);
    expect(chatVisible(msg({ from: 'p3' }), 'quick', new Set())).toBe(false);
    expect(chatVisible(msg({ from: 'p3', kind: 'quick' }), 'quick', new Set())).toBe(true);
    expect(chatVisible(msg({ kind: 'bot', from: 'bot:2' }), 'quick', new Set())).toBe(true);
    expect(chatVisible(msg({ kind: 'system', from: '', name: '' }), 'quick', muted)).toBe(true);
    for (const kind of ['player', 'quick', 'bot', 'system'] as const)
      expect(chatVisible(msg({ kind }), 'off', new Set())).toBe(false);
  });

  it('bot lines carry the [BOT] tag; presets show their own text; notices no name', () => {
    expect(chatParts(msg({ kind: 'bot', name: 'Taran', text: 'Next!' }))).toEqual({
      tag: '[BOT]',
      name: 'Taran',
      body: 'Next!',
    });
    expect(chatParts(msg({ kind: 'quick', text: undefined, quick: 'gg' })).body).toBe('GG');
    expect(chatParts(msg({ kind: 'system', text: 'Slow down' })).name).toBe('');
  });
});

describe('quick-chat wheel maths', () => {
  it('segments run clockwise from the top; the dead zone picks nothing', () => {
    expect(wheelPick(0, -100, 10, 40)).toBe(0);
    expect(wheelPick(0, 100, 10, 40)).toBe(5);
    expect(wheelPick(-100, 0, 10, 40)).toBe(8);
    expect(wheelPick(100, -30, 10, 40)).toBe(2);
    expect(wheelPick(10, 10, 10, 40)).toBe(-1);
  });

  it('number keys 1–9 then 0 pick the presets', () => {
    expect(wheelKey('Digit1')).toBe(0);
    expect(wheelKey('Digit9')).toBe(8);
    expect(wheelKey('Digit0')).toBe(9);
    expect(wheelKey('Numpad3')).toBe(2);
    expect(wheelKey('KeyA')).toBe(-1);
  });
});

describe('scoreboard mute keys', () => {
  it('everyone but you, top to bottom, at most six', () => {
    const p = (id: string, kills: number) => ({
      id,
      name: id,
      kills,
      deaths: 0,
      bot: id.startsWith('bot'),
      ping: null,
    });
    const rows = scoreboardRows([p('me', 9), p('bot:1', 3), p('ania', 5)], 'me');
    expect(muteKeyIds(rows)).toEqual(['ania', 'bot:1']);
  });
});

function controller(mode: () => 'all' | 'quick' | 'off' = () => 'all') {
  const root = new FakeEl();
  const sent: ChatSendMessage[] = [];
  let released = 0;
  let rowTarget: string | null = 'bot:1';
  let t = 0;
  const c = new ChatController(root as unknown as HTMLElement, {
    mode,
    me: () => 'me',
    palette: ['#f00', '#0f0', '#00f'],
    release: () => released++,
    muteTarget: () => rowTarget,
    nameOf: (id) => ({ me: 'Me', p2: 'Ania', 'bot:1': 'Taran' })[id] ?? null,
    mutes: new ChatMutes(null),
    now: () => t,
  });
  c.attach({
    onMessage: () => () => {},
    send: (_type: string, m?: unknown) => sent.push(m as ChatSendMessage),
  });
  const field = root.all().find((e) => e.dataset.testid === 'chat-input')!;
  const frame = (o: Partial<Parameters<ChatController['frame']>[0]> = {}): void =>
    c.frame({ chatPressed: false, quickHeld: false, scoreboardOpen: false, locked: true, ...o });
  return {
    c,
    root,
    sent,
    field,
    frame,
    released: () => released,
    setRow: (id: string | null) => (rowTarget = id),
    advance: (s: number) => (t += s),
  };
}

describe('chat controller', () => {
  it('renders lines as text (never HTML), five at most, fading after ~8 s', () => {
    const { c, root, frame, advance } = controller();
    c.receive(msg({ text: '<img src=x onerror=alert(1)>' }));
    const feed = root.all().find((e) => e.dataset.testid === 'chat-feed')!;
    expect(feed.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.all().every((e) => e.innerHTML === '')).toBe(true);
    for (let i = 2; i <= 8; i++) c.receive(msg({ id: i, text: `line ${i}` }));
    expect(c.feed.text()).toHaveLength(5);
    expect(c.feed.text().at(-1)).toContain('line 8');
    advance(9);
    frame();
    expect(feed.children.every((l) => l.classList.contains('old'))).toBe(true);
    // Open the box: the history shows again.
    frame({ chatPressed: true });
    expect(feed.children.some((l) => l.classList.contains('old'))).toBe(false);
  });

  it('a mute removes that player’s lines and hides the next ones; you cannot mute yourself', () => {
    const { c } = controller();
    c.receive(msg({ id: 1, from: 'bot:1', kind: 'bot', name: 'Taran', text: 'Next!' }));
    c.receive(msg({ id: 2, from: 'p2', text: 'hey' }));
    c.toggleMute('bot:1');
    expect(c.feed.text()).toEqual(['Aniahey']);
    c.receive(msg({ id: 3, from: 'bot:1', kind: 'bot', name: 'Taran', text: 'Too slow!' }));
    expect(c.feed.text()).toHaveLength(1);
    c.toggleMute('me');
    expect(c.isMuted('me')).toBe(false);
    c.toggleMute('bot:1');
    c.receive(msg({ id: 4, from: 'bot:1', kind: 'bot', name: 'Taran', text: 'Back.' }));
    expect(c.feed.text().at(-1)).toBe('[BOT]TaranBack.');
  });

  it('Enter opens the box: the game gets no keys or clicks, Enter sends, Esc cancels', () => {
    const { c, sent, field, frame, released } = controller();
    expect(c.key('KeyW', true)).toBe(false);
    frame({ chatPressed: true });
    expect(c.isTyping).toBe(true);
    expect(field.focused).toBe(true);
    expect(released()).toBe(1);
    expect(c.key('KeyW', true)).toBe(true);
    expect(c.key('Space', true)).toBe(true);
    expect(c.button('Mouse0')).toBe(true);
    expect(c.look(5, 5)).toBe(false); // looking around while typing is fine
    field.value = 'gg wp';
    const ev = { key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} };
    field.fire('keydown', ev);
    expect(sent).toEqual([{ text: 'gg wp' }]);
    expect(c.isTyping).toBe(false);
    expect(c.key('KeyW', true)).toBe(false);
    frame({ chatPressed: true });
    field.value = 'never mind';
    field.fire('keydown', { ...ev, key: 'Escape' });
    expect(c.isTyping).toBe(false);
    expect(sent).toHaveLength(1);
    // Losing the pointer (the menu) cancels typing too.
    frame({ chatPressed: true });
    frame({ locked: false });
    expect(c.isTyping).toBe(false);
  });

  it('Chat: quick only never opens the box; off sends nothing at all', () => {
    let mode: 'all' | 'quick' | 'off' = 'quick';
    const { c, sent, frame } = controller(() => mode);
    frame({ chatPressed: true });
    expect(c.isTyping).toBe(false);
    expect(c.feed.text().join(' ')).toContain('Typed chat is off');
    c.sendQuick('gg');
    expect(sent).toEqual([{ quick: 'gg' }]);
    mode = 'off';
    c.sendQuick('gg');
    frame({ quickHeld: true });
    expect(c.wheel.open).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('the wheel: number keys pick (and are not weapon keys), the mouse points, release sends', () => {
    const { c, sent, frame } = controller();
    frame({ quickHeld: true });
    expect(c.wheel.open).toBe(true);
    expect(c.key('Digit2', true)).toBe(true);
    expect(sent).toEqual([{ quick: QUICK_CHAT[1].id }]);
    expect(c.wheel.open).toBe(false);
    // Still held: stays shut until the key is let go.
    frame({ quickHeld: true });
    expect(c.wheel.open).toBe(false);
    frame();
    frame({ quickHeld: true });
    expect(c.wheel.open).toBe(true);
    expect(c.look(0, -120)).toBe(true); // the view doesn't turn
    expect(c.button('Mouse0')).toBe(true); // nor does it fire: it sends
    expect(sent.at(-1)).toEqual({ quick: QUICK_CHAT[0].id });
    frame();
    frame({ quickHeld: true });
    c.look(0, 120);
    frame(); // let go over the bottom segment
    expect(sent.at(-1)).toEqual({ quick: QUICK_CHAT[5].id });
    // Let go in the middle: nothing.
    frame({ quickHeld: true });
    frame();
    expect(sent).toHaveLength(3);
    // Closed: digits are weapon keys again.
    expect(c.key('Digit2', true)).toBe(false);
  });

  it('scoreboard up: 1–6 mute/unmute its rows instead of switching guns', () => {
    const { c, frame, setRow } = controller();
    expect(c.key('Digit1', true)).toBe(false);
    frame({ scoreboardOpen: true });
    expect(c.key('Digit1', true)).toBe(true);
    expect(c.isMuted('bot:1')).toBe(true);
    expect(c.key('Digit1', true)).toBe(true);
    expect(c.isMuted('bot:1')).toBe(false);
    setRow(null);
    expect(c.key('Digit5', true)).toBe(true);
    expect(c.key('Digit7', true)).toBe(false);
    frame();
    expect(c.key('Digit1', true)).toBe(false);
  });
});

/** A localStorage stand-in (or one that throws, like a blocked one). */
function memoryStore(
  blocked = false,
): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => {
      if (blocked) throw new Error('SecurityError');
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (blocked) throw new Error('SecurityError');
      data.set(k, v);
    },
  };
}

describe('mutes last across matches (by name)', () => {
  it('a mute is saved and a new page (new ids) still hides that name', () => {
    const store = memoryStore();
    const first = new ChatMutes(store);
    expect(first.toggle('Taran')).toBe(true);
    expect(JSON.parse(store.data.get(MUTES_KEY)!)).toEqual(['taran']);
    const next = new ChatMutes(store);
    expect(next.has('taran')).toBe(true);
    expect(next.has('TARAN ')).toBe(true);
    expect(next.toggle('Taran')).toBe(false);
    expect(new ChatMutes(store).has('Taran')).toBe(false);
  });

  it('blocked or junk storage: mutes still work for the page', () => {
    const blocked = new ChatMutes(memoryStore(true));
    expect(blocked.toggle('Lis')).toBe(true);
    expect(blocked.has('Lis')).toBe(true);
    const junk = memoryStore();
    junk.data.set(MUTES_KEY, '{not json');
    expect(new ChatMutes(junk).list()).toEqual([]);
    junk.data.set(MUTES_KEY, JSON.stringify(['ok', 3, null, '']));
    expect(new ChatMutes(junk).list()).toEqual(['ok']);
  });
});

describe('friend-lobby chat', () => {
  it('shows lines (no fading), sends typed text, follows mutes and the Chat setting', () => {
    let mode: 'all' | 'quick' | 'off' = 'all';
    const root = new FakeEl();
    const sent: unknown[] = [];
    const chat = new LobbyChat(root as unknown as HTMLElement, {
      mode: () => mode,
      mutes: new ChatMutes(null),
    });
    let handler: ((m: ChatMessage) => void) | null = null;
    const off = chat.attach({
      onMessage: (_t: string, cb: (m: ChatMessage) => void) => {
        handler = cb;
        return () => (handler = null);
      },
      send: (_t: string, m?: unknown) => sent.push(m),
    } as never);
    handler!(msg({ id: 1, text: 'gl hf' }));
    handler!(
      msg({ id: 2, from: 'p3', name: 'Bartek', kind: 'quick', text: undefined, quick: 'gg' }),
    );
    expect(chat.feed.text()).toEqual(['Aniagl hf', 'BartekGG']);
    const field = root.all().find((e) => e.dataset.testid === 'lobby-chat-input')!;
    field.value = 'ready when you are';
    field.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(sent).toEqual([{ text: 'ready when you are' }]);
    expect(field.value).toBe('');
    chat.toggleMute('Ania');
    expect(chat.feed.text()).toEqual(['BartekGG']);
    mode = 'quick';
    chat.applyMode();
    expect(field.hidden).toBe(true);
    field.value = 'sneaky';
    field.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(sent).toHaveLength(1);
    off();
    expect(handler).toBeNull();
  });
});

describe('review fixes', () => {
  it('a held number key (autorepeat) mutes once, not on and off', () => {
    const { c, frame, sent } = controller();
    frame({ scoreboardOpen: true });
    expect(c.key('Digit1', true)).toBe(true);
    for (let i = 0; i < 5; i++) expect(c.key('Digit1', true, { repeat: true })).toBe(true);
    expect(c.isMuted('bot:1')).toBe(true);
    // The wheel ignores repeats too (a digit held from before it opened says nothing).
    frame();
    frame({ quickHeld: true });
    expect(c.key('Digit2', true, { repeat: true })).toBe(true);
    expect(sent).toEqual([]);
    expect(c.wheel.open).toBe(true);
  });

  it('changing Menu › Chat drops the lines it no longer allows at once', () => {
    let mode: 'all' | 'quick' | 'off' = 'all';
    const { c, frame } = controller(() => mode);
    frame();
    c.receive(msg({ id: 1, text: 'typed' }));
    c.receive(msg({ id: 2, kind: 'quick', text: undefined, quick: 'gg' }));
    expect(c.feed.text()).toHaveLength(2);
    mode = 'quick';
    frame();
    expect(c.feed.text()).toEqual(['AniaGG']);
    mode = 'off';
    frame();
    expect(c.feed.text()).toEqual([]);
    expect(c.feed.root.hidden).toBe(true);
  });

  it('a hidden feed is really hidden (its display rule does not win over [hidden])', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.chat-feed\[hidden\][^{]*\{\s*display:\s*none;/);
  });
});

describe('IME composition', () => {
  it('Enter while composing confirms the text, never sends (game box and lobby box)', () => {
    const { c, sent, field, frame } = controller();
    frame({ chatPressed: true });
    field.value = '日本';
    const ev = { key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} };
    field.fire('keydown', { ...ev, isComposing: true });
    field.fire('keydown', { ...ev, keyCode: 229 });
    expect(sent).toEqual([]);
    expect(c.isTyping).toBe(true);
    field.fire('keydown', ev);
    expect(sent).toEqual([{ text: '日本' }]);

    const root = new FakeEl();
    const lobbySent: unknown[] = [];
    const lobby = new LobbyChat(root as unknown as HTMLElement, {
      mode: () => 'all',
      mutes: new ChatMutes(null),
    });
    lobby.attach({
      onMessage: () => () => {},
      send: (_t: string, m?: unknown) => lobbySent.push(m),
    } as never);
    const box = root.all().find((e) => e.dataset.testid === 'lobby-chat-input')!;
    box.value = 'こんにちは';
    box.fire('keydown', { ...ev, isComposing: true });
    expect(lobbySent).toEqual([]);
    expect(box.value).toBe('こんにちは');
    box.fire('keydown', ev);
    expect(lobbySent).toEqual([{ text: 'こんにちは' }]);
  });
});

describe('round-3 review fixes', () => {
  it('losing focus ends typing cleanly; Tab keeps the box focused', () => {
    const { c, field, frame, sent } = controller();
    frame({ chatPressed: true });
    let prevented = false;
    field.fire('keydown', {
      key: 'Tab',
      preventDefault: () => (prevented = true),
      stopPropagation: () => {},
    });
    expect(prevented).toBe(true);
    expect(c.isTyping).toBe(true);
    // A click on the game (or anything) takes the focus: the game gets its keys back.
    field.fire('blur', {});
    expect(c.isTyping).toBe(false);
    expect(c.key('KeyW', true)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('lines said during the lobby → game handoff are kept (bounded) and replayed', () => {
    const buffer = makeBuffer();
    expect(buffer.chats).toEqual([]);
    for (let i = 1; i <= PREGAME_CHAT_MAX + 5; i++) {
      bufferPregameChat(
        buffer.chats!,
        msg({ id: i, kind: 'bot', name: 'Taran', from: 'bot:1', text: `line ${i}` }),
      );
    }
    expect(buffer.chats).toHaveLength(PREGAME_CHAT_MAX);
    expect(buffer.chats![0]!.id).toBe(6);
    const { c } = controller();
    c.replay(buffer.chats!.splice(0).slice(-2));
    expect(c.feed.text()).toEqual(['[BOT]Taranline 24', '[BOT]Taranline 25']);
    expect(buffer.chats).toEqual([]);
  });
});

describe('round-4 review fixes', () => {
  it('losing the pointer with a line lit cancels the wheel without sending it', () => {
    const { c, sent, frame } = controller();
    frame({ quickHeld: true });
    c.look(0, -120); // "Nice shot." lit
    // Esc: the browser drops the pointer and every held key at once.
    frame({ quickHeld: false, locked: false });
    expect(c.wheel.open).toBe(false);
    expect(sent).toEqual([]);
    // Releasing the key while still playing still says it.
    frame({ quickHeld: true });
    c.look(0, -120);
    frame();
    expect(sent).toEqual([{ quick: QUICK_CHAT[0].id }]);
  });
});
