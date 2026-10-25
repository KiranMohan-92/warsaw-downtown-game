import { quickChatText, type ChatMessage } from '@wd/shared';

/** Menu › HUD › Chat. */
export type ChatMode = 'all' | 'quick' | 'off';

export const CHAT_FEED = {
  /** Lines shown at most. */
  maxLines: 5,
  /** A line fades out this long after it arrived (s), unless the chat box is open. */
  fadeAfter: 8,
} as const;

/**
 * Whether a message is shown: never from a muted player (mutes are by name); `quick` hides typed lines (presets,
 * bots and notices stay); `off` shows nothing.
 */
export function chatVisible(
  msg: Pick<ChatMessage, 'kind' | 'from' | 'name'>,
  mode: ChatMode,
  muted: { has(name: string): boolean },
): boolean {
  if (mode === 'off') return false;
  if (msg.from && msg.name && muted.has(msg.name)) return false;
  if (mode === 'quick' && msg.kind === 'player') return false;
  return true;
}

/** What a line shows: the tag, the sender, the words ('' for an unknown preset). */
export function chatParts(msg: ChatMessage): { tag: string; name: string; body: string } {
  const body = msg.kind === 'quick' ? quickChatText(msg.quick ?? '') : (msg.text ?? '');
  return {
    tag: msg.kind === 'bot' ? '[BOT]' : '',
    name: msg.kind === 'system' ? '' : msg.name,
    body,
  };
}

interface Line {
  msg: ChatMessage;
  at: number;
  el: HTMLDivElement;
}

/**
 * The chat feed, bottom-left above the health panel: at most five lines, each fading ~8 s
 * after it arrived (all of them stay while the chat box is open). Lines are built from text
 * nodes only (`textContent`): nothing a player types is ever parsed as HTML. Filtering (mode,
 * mutes) happens when a line arrives and again when a mute changes.
 */
export class ChatFeed {
  readonly root = document.createElement('div');
  private lines: Line[] = [];
  private open = false;

  constructor(
    parent: HTMLElement,
    /** Name colour per slot (the players' colours). */
    private readonly palette: readonly string[],
  ) {
    this.root.className = 'chat-feed';
    this.root.dataset.testid = 'chat-feed';
    parent.append(this.root);
  }

  /** A message arrived (already filtered by the caller). */
  add(msg: ChatMessage, nowSec: number): void {
    if (this.lines.some((l) => l.msg.id === msg.id && l.msg.from === msg.from)) return;
    const el = this.build(msg);
    this.root.append(el);
    this.lines.push({ msg, at: nowSec, el });
    while (this.lines.length > CHAT_FEED.maxLines) this.lines.shift()?.el.remove();
  }

  /** Drop the lines that should no longer show (a mute, a mode change). */
  refilter(keep: (msg: ChatMessage) => boolean): void {
    this.lines = this.lines.filter((l) => {
      if (keep(l.msg)) return true;
      l.el.remove();
      return false;
    });
  }

  /** Per frame: fade old lines (only class flips; nothing rebuilt). */
  update(nowSec: number, open: boolean): void {
    if (open !== this.open) {
      this.open = open;
      this.root.classList.toggle('open', open);
    }
    for (const l of this.lines) {
      const old = !open && nowSec - l.at > CHAT_FEED.fadeAfter;
      if (l.el.classList.contains('old') !== old) l.el.classList.toggle('old', old);
    }
  }

  /** The visible lines' text (tests and probes). */
  text(): string[] {
    return this.lines.map((l) => l.el.textContent ?? '');
  }

  private build(msg: ChatMessage): HTMLDivElement {
    const { tag, name, body } = chatParts(msg);
    const el = document.createElement('div');
    el.className = `chat-line chat-${msg.kind}`;
    if (tag) {
      const t = document.createElement('span');
      t.className = 'chat-tag';
      t.textContent = tag;
      el.append(t);
    }
    if (name) {
      const n = document.createElement('span');
      n.className = 'chat-name';
      n.textContent = name;
      const color = this.palette[msg.slot % this.palette.length];
      if (msg.slot >= 0 && color) n.style.color = color;
      el.append(n);
    }
    const b = document.createElement('span');
    b.className = 'chat-text';
    b.textContent = body;
    el.append(b);
    return el;
  }
}
