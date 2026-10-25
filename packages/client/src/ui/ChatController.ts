import { CHAT, type ChatMessage, type ChatSendMessage, type QuickChatId } from '@wd/shared';
import { ChatFeed, chatVisible, type ChatMode } from '../hud/ChatFeed.ts';
import type { InputModal } from '../input/Input.ts';
import type { MatchRoomLink } from '../net/roomLink.ts';
import { pageMutes, type ChatMutes } from './chatMutes.ts';
import { QuickChatWheel, wheelKey } from './QuickChat.ts';

/** What the chat needs from the game each frame. */
export interface ChatFrame {
  /** The Chat key was pressed (Enter by default). */
  chatPressed: boolean;
  /** The quick-chat key is held (X by default) and the game is being played. */
  quickHeld: boolean;
  /** The hold-Tab scoreboard is up: its number keys mute/unmute a row. */
  scoreboardOpen: boolean;
  /** The pointer is locked (playing); losing it (Esc, the menu) cancels typing. */
  locked: boolean;
}

/** The scoreboard row a mute key picks (1-based, `Scoreboard.idForKey`). */
export type MuteKeyTarget = (n: number) => string | null;

/**
 * In-match chat on the client: the feed, the chat box (Enter types, Enter sends, Esc cancels),
 * the hold-to-open quick-chat wheel and per-player mutes. It takes the keyboard and mouse over
 * only while it needs them (`InputModal`): while typing nothing reaches the game; while the wheel
 * is up, number keys, clicks and mouse travel pick a line instead of switching guns, firing or
 * turning; while the scoreboard is up, 1–6 mute/unmute its rows. Otherwise it never consumes
 * anything. Every line arrives from the server (practice: the worker), already cleaned.
 */
export class ChatController implements InputModal {
  readonly feed: ChatFeed;
  readonly wheel: QuickChatWheel;
  private readonly box = document.createElement('div');
  private readonly field = document.createElement('input');
  /** Mutes by name (they last across matches: `chatMutes.ts`). */
  private readonly muted: ChatMutes;
  private send: ((msg: ChatSendMessage) => void) | null = null;
  private typing = false;
  /** The wheel said its line (or was dismissed): it stays shut until the key is let go. */
  private wheelSpent = false;
  private scoreboardOpen = false;
  private shownMode: ChatMode | null = null;
  private noticeAt = -Infinity;
  /** Screenshots/probes: keep the wheel up without the key. */
  forceWheel = false;

  constructor(
    parent: HTMLElement,
    private readonly opts: {
      mode: () => ChatMode;
      /** Our own player id (null before the welcome). */
      me: () => string | null;
      palette: readonly string[];
      /** Let go of every held control (the chat box takes the keyboard). */
      release: () => void;
      muteTarget?: MuteKeyTarget;
      /** A player's current name (the roster), for mutes. */
      nameOf?: (id: string) => string | null;
      /** Where mutes are kept (default: the page's, saved in localStorage). */
      mutes?: ChatMutes;
      /** Seconds (performance clock). */
      now?: () => number;
    },
  ) {
    this.muted = opts.mutes ?? pageMutes();
    this.feed = new ChatFeed(parent, opts.palette);
    this.wheel = new QuickChatWheel(parent);
    this.box.className = 'chat-box';
    this.box.dataset.testid = 'chat-box';
    const label = document.createElement('span');
    label.className = 'chat-box-label';
    label.textContent = 'SAY';
    this.field.type = 'text';
    this.field.maxLength = CHAT.maxLength;
    this.field.spellcheck = false;
    this.field.autocomplete = 'off';
    this.field.placeholder = 'Enter sends · Esc cancels';
    this.field.dataset.testid = 'chat-input';
    this.box.append(label, this.field);
    parent.append(this.box);
    this.field.addEventListener('keydown', (e) => {
      // Enter while an IME is composing confirms the composition, never sends.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.submit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.closeBox();
      } else if (e.key === 'Tab') {
        // Tab would move the focus off the box: keep typing instead.
        e.preventDefault();
      }
    });
    // Focus lost any other way (a click on the game, the window): typing ends cleanly, so the
    // game never keeps swallowing keys for a box that can't hear them.
    this.field.addEventListener('blur', () => this.closeBox());
  }

  /** Lines that arrived while the game was being built (the friend lobby's handoff buffer). */
  replay(msgs: readonly ChatMessage[]): void {
    for (const m of msgs) this.receive(m);
  }

  private get nowSec(): number {
    return this.opts.now?.() ?? performance.now() / 1000;
  }

  /** The joined room: incoming lines go to the feed, our lines go out through it. */
  attach(room: Pick<MatchRoomLink, 'onMessage' | 'send'>): void {
    room.onMessage('chat', (m: ChatMessage) => this.receive(m));
    this.send = (msg) => room.send('chat', msg);
  }

  /** A line from the server (or the practice worker). */
  receive(msg: ChatMessage): void {
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
    if (!chatVisible(msg, this.opts.mode(), this.muted)) return;
    this.feed.add(msg, this.nowSec);
  }

  get isTyping(): boolean {
    return this.typing;
  }

  isMuted(id: string): boolean {
    const name = this.opts.nameOf?.(id);
    return !!name && this.muted.has(name);
  }

  /** Whether a name is muted (the scoreboard marks those rows). */
  isMutedName(name: string): boolean {
    return this.muted.has(name);
  }

  toggleMute(id: string): void {
    if (!id || id === this.opts.me()) return;
    const name = this.opts.nameOf?.(id);
    if (!name) return;
    this.muted.toggle(name);
    const mode = this.opts.mode();
    this.feed.refilter((m) => chatVisible(m, mode, this.muted));
  }

  /** Say a quick-chat preset. */
  sendQuick(id: QuickChatId): void {
    if (this.opts.mode() === 'off') return;
    this.send?.({ quick: id });
  }

  /** Per frame (render). */
  frame(f: ChatFrame): void {
    this.scoreboardOpen = f.scoreboardOpen;
    const mode = this.opts.mode();
    if (mode !== this.shownMode) {
      // Menu › HUD › Chat changed: lines it no longer allows go now, not when they fade.
      this.shownMode = mode;
      this.feed.refilter((m) => chatVisible(m, mode, this.muted));
    }
    if (this.typing && (!f.locked || mode !== 'all')) this.closeBox();
    if (f.chatPressed && !this.typing && f.locked) this.openBox(mode);
    // The wheel: held key (not while typing), once per hold.
    if (!f.quickHeld) this.wheelSpent = false;
    const want =
      this.forceWheel || (f.quickHeld && !this.wheelSpent && !this.typing && mode !== 'off');
    if (want !== this.wheel.open) {
      // Let go over a line: say it. Losing the pointer (Esc, the menu) lets go of every key
      // too, but that cancels the wheel instead.
      if (!want && this.wheel.open && !this.wheelSpent && f.locked) {
        const id = this.wheel.selectedId;
        if (id) this.sendQuick(id);
      }
      this.wheel.show(want);
    }
    this.feed.update(this.nowSec, this.typing);
    this.feed.root.hidden = mode === 'off';
  }

  private openBox(mode: ChatMode): void {
    if (mode === 'off') return;
    if (mode === 'quick') {
      this.notice('Typed chat is off (Menu › HUD › Chat). Hold the quick-chat key instead.');
      return;
    }
    this.typing = true;
    this.opts.release();
    this.wheel.show(false);
    this.box.classList.add('on');
    this.field.value = '';
    this.field.focus({ preventScroll: true });
  }

  private closeBox(): void {
    if (!this.typing) return;
    this.typing = false;
    this.box.classList.remove('on');
    this.field.blur();
  }

  private submit(): void {
    const text = this.field.value;
    this.closeBox();
    if (text.trim()) this.send?.({ text: text.slice(0, CHAT.maxRawLength) });
  }

  private notice(text: string): void {
    const now = this.nowSec;
    if (now - this.noticeAt < 4) return;
    this.noticeAt = now;
    this.feed.add(
      { id: -Math.round(now * 1000), from: '', name: '', slot: -1, kind: 'system', text },
      now,
    );
  }

  private pickFromWheel(index: number): void {
    const id = index >= 0 ? this.wheelIdAt(index) : this.wheel.selectedId;
    if (id) this.sendQuick(id);
    this.wheelSpent = true;
    this.forceWheel = false;
    this.wheel.show(false);
  }

  private wheelIdAt(index: number): QuickChatId | null {
    this.wheel.point(index);
    return this.wheel.selectedId;
  }

  // InputModal ---------------------------------------------------------------------------------

  key(code: string, down: boolean, e?: { repeat?: boolean }): boolean {
    // Held keys autorepeat: only the first press acts (a held 3 must not flip a mute on and off).
    const press = down && e?.repeat !== true;
    if (this.typing) return true; // the box has the keyboard
    if (this.wheel.open) {
      const i = wheelKey(code);
      if (i >= 0) {
        if (press) this.pickFromWheel(i);
        return true;
      }
      return false;
    }
    if (this.scoreboardOpen && this.opts.muteTarget) {
      const m = /^(?:Digit|Numpad)([1-6])$/.exec(code);
      if (m) {
        if (press) {
          const id = this.opts.muteTarget(Number(m[1]));
          if (id) this.toggleMute(id);
        }
        return true;
      }
    }
    return false;
  }

  button(code: string): boolean {
    if (this.typing) return true;
    if (this.wheel.open) {
      if (code === 'Mouse0') this.pickFromWheel(-1);
      return true;
    }
    return false;
  }

  look(dx: number, dy: number): boolean {
    if (!this.wheel.open) return false;
    this.wheel.move(dx, dy);
    return true;
  }
}
