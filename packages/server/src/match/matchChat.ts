import {
  CHAT,
  cleanChatText,
  TokenBucket,
  type ChatMessage,
  type ChatSendMessage,
  type CombatEvent,
  type QuickChatId,
} from '@wd/shared';
import { BotChatter, type ChatterPlayer } from './botChatter.ts';
import type { MatchSim } from './MatchSim.ts';

/** What one `chat` message from a player turns into. */
export interface ChatOutcome {
  /** For everyone in the match (null: nothing to say, or refused). */
  all: ChatMessage | null;
  /** For the sender only: why it was refused (rate limit), at most once in a while. */
  sender: ChatMessage | null;
}

/**
 * Who may chat and when it is (a room supplies both: in its lobby the seats and its clock, in a
 * running match the match's players). Bots are never senders.
 */
export interface ChatSource {
  sender(id: string): { name: string; slot: number; bot: boolean } | null;
  now(): number;
}

/** A running match as the chat source (its players, its own clock). */
export function simSource(sim: MatchSim): ChatSource {
  return {
    sender: (id) => {
      const p = sim.players.get(id);
      return p ? { name: p.name, slot: p.slot, bot: p.bot } : null;
    },
    now: () => sim.nowMs,
  };
}

/** Bots call a player with no name of their own (the page's "You", the server's "Player N") this. */
export const UNNAMED_CALL = 'rookie';
const UNNAMED = /^(?:You|Player [0-9]+)$/;
/** What bots call a human: their name, or `UNNAMED_CALL` for a default one. */
export function callName(name: string): string {
  return UNNAMED.test(name) ? UNNAMED_CALL : name;
}

/**
 * The match's chat, beside `MatchSim` (never inside it: chat touches no game state). Players'
 * lines are validated upstream (`ChatSendMessageOrNull`), then cleaned (`cleanChatText`), rate
 * limited per sender (token bucket + no immediate repeats) and stamped with the sender's name and
 * colour; quick-chat presets travel as their id. Bots' lines come from `BotChatter`, which reads
 * the match after every step. Time is the match's own clock (`sim.nowMs`), so a paused practice
 * match neither refills buckets nor lets lines through.
 */
export class MatchChat {
  readonly chatter: BotChatter;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly lastSaid = new Map<string, { line: string; at: number }>();
  private readonly noticedAt = new Map<string, number>();
  private nextId = 1;
  /** Humans' quick chat the bots haven't heard yet (they hear it on the match's own clock). */
  private heard: { id: string; quick: QuickChatId }[] = [];

  constructor(
    private readonly source: ChatSource,
    opts: { seed: number; botChatter?: boolean },
  ) {
    this.chatter = new BotChatter(opts.seed, opts.botChatter ?? true);
  }

  /** A player's `chat` message (already schema-checked). Bots and unknown ids say nothing. */
  fromPlayer(id: string, msg: ChatSendMessage): ChatOutcome {
    const p = this.source.sender(id);
    const none: ChatOutcome = { all: null, sender: null };
    if (!p || p.bot) return none;
    const now = this.source.now();
    const text = 'text' in msg ? cleanChatText(msg.text) : '';
    const line = 'quick' in msg ? `#${msg.quick}` : text;
    if (!line) return none;
    const last = this.lastSaid.get(id);
    if (last && last.line === line && now - last.at < CHAT.repeatWindowMs) return none;
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = new TokenBucket(CHAT.ratePerSec, CHAT.burst, now);
      this.buckets.set(id, bucket);
    }
    if (!bucket.take(now)) {
      const noticed = this.noticedAt.get(id) ?? -Infinity;
      if (now - noticed < CHAT.noticeEveryMs) return none;
      this.noticedAt.set(id, now);
      return {
        all: null,
        sender: {
          id: this.nextId++,
          from: '',
          name: '',
          slot: -1,
          kind: 'system',
          text: 'Slow down: chat is rate limited.',
        },
      };
    }
    this.lastSaid.set(id, { line, at: now });
    const base = { id: this.nextId++, from: id, name: p.name, slot: p.slot };
    if ('quick' in msg) {
      this.heard.push({ id, quick: msg.quick });
      if (this.heard.length > 2) this.heard.shift();
      return { all: { ...base, kind: 'quick', quick: msg.quick }, sender: null };
    }
    return { all: { ...base, kind: 'player', text }, sender: null };
  }

  /** After the room ran its ticks (with the combat events it drained): bot lines due now. */
  afterStep(sim: MatchSim, events: readonly CombatEvent[]): ChatMessage[] {
    const lines = this.chatter.update(
      sim.nowMs,
      chatterPlayers(sim),
      events,
      sim.phase,
      sim.winners,
    );
    // Heard now (it knows the players from this update); a reply comes after its typing delay.
    for (const h of this.heard.splice(0)) this.chatter.heardQuick(sim.nowMs, h.id, h.quick);
    return lines.map((l) => ({
      id: this.nextId++,
      from: l.from,
      name: l.name,
      slot: l.slot,
      kind: 'bot',
      text: l.text,
      persona: l.persona,
    }));
  }

  /** Senders with rate-limit state kept (tests, diagnostics). */
  get trackedSenders(): number {
    return new Set([...this.buckets.keys(), ...this.lastSaid.keys(), ...this.noticedAt.keys()])
      .size;
  }

  /** Lobby quick chat is never answered (the bots aren't in a match yet). */
  forgetHeard(): void {
    this.heard.length = 0;
  }

  /** Forget a player who left (their bucket and last line). */
  remove(id: string): void {
    this.buckets.delete(id);
    this.lastSaid.delete(id);
    this.noticedAt.delete(id);
    this.heard = this.heard.filter((h) => h.id !== id);
    this.chatter.forget(id);
  }
}

/** The match as the chatter sees it (copies: it never holds or writes a player's state). */
export function chatterPlayers(sim: MatchSim): ChatterPlayer[] {
  const out: ChatterPlayer[] = [];
  for (const p of sim.players.values()) {
    const persona = sim.bots.personalities.get(p.id);
    out.push({
      id: p.id,
      name: p.bot ? p.name : callName(p.name),
      slot: p.slot,
      bot: p.bot,
      ...(persona ? { persona } : {}),
      hp: p.state.health,
      life: p.life,
      kills: p.kills,
      x: p.state.move.pos.x,
      z: p.state.move.pos.z,
    });
  }
  return out;
}

/** A seed from a room id (deterministic per room; practice passes its own). */
export function chatSeed(roomId: string): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < roomId.length; i++) h = Math.imul(h ^ roomId.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
