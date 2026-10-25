import * as v from 'valibot';
import type { BotPersonalityId } from '../config/tunables.ts';

/**
 * In-match chat: free text, preset quick-chat lines and the bots' chatter. Client → server
 * messages are validated here (`ChatSendMessageOrNull`), then cleaned (`cleanChatText`: control
 * and format characters stripped, whitespace collapsed, at most `CHAT.maxLength` characters, a
 * basic profanity mask) and rate limited on the server; clients render every line as text, never
 * as HTML.
 */
export const CHAT = {
  /** Characters a line keeps at most (code points, after cleaning). */
  maxLength: 80,
  /** Raw text a `chat` message may carry at all (longer: the sender is kicked, like any junk). */
  maxRawLength: 256,
  /** Per-sender token bucket: a burst of this many lines… */
  burst: 3,
  /** …then this many per second (one every 2.5 s). Quick chat and text share it. */
  ratePerSec: 0.4,
  /** The same line again from the same sender within this window is dropped (ms). */
  repeatWindowMs: 8000,
  /** At most one "slow down" notice per sender per this long (ms). */
  noticeEveryMs: 5000,
} as const;

/**
 * Quick-chat presets (order = the wheel and the number keys 1–9, 0). `reply` is what the bots
 * hear in it (`server/match/botChatter.ts`). Append-only ids: they ride on the wire.
 */
export const QUICK_CHAT = [
  { id: 'niceShot', text: 'Nice shot.', reply: 'praise' },
  { id: 'isThatAll', text: 'Is that all?', reply: 'taunt' },
  { id: 'reloading', text: 'Reloading!', reply: 'callout' },
  { id: 'behindYou', text: 'Behind you!', reply: 'callout' },
  { id: 'gg', text: 'GG', reply: 'praise' },
  { id: 'comeAtMe', text: 'Come at me.', reply: 'taunt' },
  { id: 'rooftops', text: 'Watch the rooftops!', reply: 'callout' },
  { id: 'thanks', text: 'Thanks!', reply: 'praise' },
  { id: 'tooEasy', text: 'Too easy.', reply: 'taunt' },
  { id: 'truce', text: 'Truce?', reply: 'truce' },
] as const;
export type QuickChatId = (typeof QUICK_CHAT)[number]['id'];
export type QuickChatReply = (typeof QUICK_CHAT)[number]['reply'];
export const QUICK_CHAT_IDS = QUICK_CHAT.map((q) => q.id) as unknown as readonly [
  QuickChatId,
  ...QuickChatId[],
];

/** A quick-chat preset's line ('' for an unknown id: old/new peers). */
export function quickChatText(id: string): string {
  return QUICK_CHAT.find((q) => q.id === id)?.text ?? '';
}

/** Message: client → server, a quick-chat preset or a free-text line. */
export const ChatSendMessage = v.union([
  v.object({ quick: v.picklist(QUICK_CHAT_IDS) }),
  v.object({ text: v.pipe(v.string(), v.maxLength(CHAT.maxRawLength)) }),
]);
export type ChatSendMessage = v.InferOutput<typeof ChatSendMessage>;

/** `ChatSendMessage`, or null for anything else (the sender is kicked). */
export const ChatSendMessageOrNull = {
  '~standard': {
    version: 1,
    vendor: 'wd',
    validate: (value: unknown): { value: ChatSendMessage | null } => {
      const r = v.safeParse(ChatSendMessage, value);
      return { value: r.success ? r.output : null };
    },
    types: undefined as
      { input: ChatSendMessage | null; output: ChatSendMessage | null } | undefined,
  },
} as const;

/**
 * Who said it: a bot's chatter, a human's free text, a human's quick-chat preset, or a server
 * notice for one player only (rate limited).
 */
export type ChatKind = 'bot' | 'player' | 'quick' | 'system';

/** Message: server → clients (a notice: only to its player). */
export interface ChatMessage {
  /** Increments per room (clients key and de-duplicate on it). */
  id: number;
  /** Sender's player id ('' for a notice). */
  from: string;
  /** Sender's name when it was said (they may have left since). */
  name: string;
  /** Sender's colour slot (0–5; -1 for a notice). */
  slot: number;
  kind: ChatKind;
  /** The (cleaned) line: free text, a bot's line or a notice. */
  text?: string;
  /** The preset (kind `quick`); clients show its own text for it. */
  quick?: QuickChatId;
  /** A bot's personality (flavours its tag). */
  persona?: BotPersonalityId;
}

/** Runs of more than two combining marks (glyph-stacking spam) are cut to two. */
const MARK_RUN = /(\p{M}{2})\p{M}+/gu;

/** Printable, single-line, trimmed, at most `CHAT.maxLength` characters ('' if nothing is left). */
export function sanitizeChatText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const clean = raw
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, '')
    .replace(MARK_RUN, '$1')
    .trim();
  return Array.from(clean).slice(0, CHAT.maxLength).join('').trim();
}

/** Leetspeak and look-alike letters, folded before matching (one character each way). */
const FOLD: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '8': 'b',
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ó: 'o',
  ś: 's',
  ź: 'z',
  ż: 'z',
};

/**
 * Stems masked anywhere in a word (no harmless English word contains them), at the start of a
 * word only ("swanky" is fine), and as whole words only ("cocktail", "Dickens" and "peacock"
 * are fine). English plus the Polish ones Warsaw players will reach for. A basic mask, not
 * moderation: per-player mute and Menu › Chat are the real controls.
 */
const ANYWHERE = [
  'fuck',
  'fuk',
  'motherf',
  'shit',
  'cunt',
  'bitch',
  'bastard',
  'asshole',
  'dildo',
  'nigg',
  'fagg',
  'retard',
  'whore',
  'slut',
  'twat',
  'kurw',
  'pierdol',
  'jeb',
  'chuj',
  'pizd',
];
const WORD_START = ['wank', 'piss', 'huj'];
const WHOLE_WORD = ['cock', 'dick', 'fag', 'pussy', 'prick'];
/** Each letter may repeat ("fuuuck"); folded text keeps one UTF-16 unit per original one. */
const stem = (s: string): string =>
  s
    .split('')
    .map((c) => `${c}+`)
    .join('');
const MASK = new RegExp(
  [
    `(?:${ANYWHERE.map(stem).join('|')})`,
    `(?<![a-z])(?:${WORD_START.map(stem).join('|')})`,
    `(?<![a-z])(?:${WHOLE_WORD.map(stem).join('|')})(?:e?s)?(?![a-z])`,
  ].join('|'),
  'g',
);

/** Asterisks over profanity (same length; the rest of the line untouched). */
export function maskProfanity(text: string): string {
  // Fold per UTF-16 unit, so match indices are the original's.
  let folded = '';
  for (const ch of text.split('')) {
    const lower = ch.toLowerCase();
    const one = lower.length === 1 ? lower : ch;
    folded += FOLD[one] ?? one;
  }
  let out = '';
  let from = 0;
  for (const m of folded.matchAll(MASK)) {
    out += text.slice(from, m.index) + '*'.repeat(m[0].length);
    from = m.index + m[0].length;
  }
  return out + text.slice(from);
}

/** What a free-text line becomes before anyone sees it ('' = nothing to send). */
export function cleanChatText(raw: unknown): string {
  return maskProfanity(sanitizeChatText(raw));
}
