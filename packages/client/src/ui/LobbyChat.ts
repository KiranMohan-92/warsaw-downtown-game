import { CHAT, type ChatMessage, type ChatSendMessage } from '@wd/shared';
import { ChatFeed, chatVisible, type ChatMode } from '../hud/ChatFeed.ts';
import type { MatchRoomLink } from '../net/roomLink.ts';
import { pageMutes, type ChatMutes } from './chatMutes.ts';

/** Name colours by seat (the players' colours: `render/remotePlayersView.ts` SLOT_COLORS). */
export const LOBBY_PALETTE = ['#d9534f', '#4f8ad9', '#e0b43a', '#5cb85c', '#a760d6', '#e07b39'];

/**
 * Chat on the friend-lobby screen, before the match starts: a compact feed (the last five
 * lines, no fading) and a text box (Enter sends). The same `chat` messages, server validation,
 * rate limits and mutes as in the match; the bots only start talking once it runs.
 */
export class LobbyChat {
  readonly root = document.createElement('div');
  readonly feed: ChatFeed;
  private readonly field = document.createElement('input');
  private send: ((msg: ChatSendMessage) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly opts: { mode: () => ChatMode; mutes?: ChatMutes } = { mode: () => 'all' },
  ) {
    this.root.className = 'friend-lobby-chat';
    this.root.dataset.testid = 'lobby-chat';
    this.feed = new ChatFeed(this.root, LOBBY_PALETTE);
    this.field.type = 'text';
    this.field.maxLength = CHAT.maxLength;
    this.field.spellcheck = false;
    this.field.autocomplete = 'off';
    this.field.dataset.testid = 'lobby-chat-input';
    this.field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      this.submit();
    });
    this.root.append(this.field);
    parent.append(this.root);
    this.applyMode();
  }

  private get mutes(): ChatMutes {
    return this.opts.mutes ?? pageMutes();
  }

  /** The lobby's room: lines in, our lines out. Returns the unsubscribe. */
  attach(room: Pick<MatchRoomLink, 'onMessage' | 'send'>): () => void {
    this.send = (msg) => room.send('chat', msg);
    const off = room.onMessage('chat', (m: ChatMessage) => this.receive(m));
    return () => {
      off();
      this.send = null;
    };
  }

  receive(msg: ChatMessage): void {
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
    if (!chatVisible(msg, this.opts.mode(), this.mutes)) return;
    this.feed.add(msg, 0);
    this.feed.update(0, true); // the lobby never fades lines
  }

  /** Mute or unmute a name (the lobby roster's buttons); the feed follows at once. */
  toggleMute(name: string): boolean {
    const muted = this.mutes.toggle(name);
    const mode = this.opts.mode();
    this.feed.refilter((m) => chatVisible(m, mode, this.mutes));
    return muted;
  }

  isMuted(name: string): boolean {
    return this.mutes.has(name);
  }

  /** Typed chat follows Menu › HUD › Chat (quick only / off: no box). */
  applyMode(): void {
    const mode = this.opts.mode();
    this.feed.refilter((m) => chatVisible(m, mode, this.mutes));
    this.root.hidden = mode === 'off';
    this.field.hidden = mode !== 'all';
    this.field.placeholder = 'Say something to the room · Enter sends';
  }

  private submit(): void {
    const text = this.field.value;
    this.field.value = '';
    if (text.trim() && this.opts.mode() === 'all') {
      this.send?.({ text: text.slice(0, CHAT.maxRawLength) });
    }
  }
}
