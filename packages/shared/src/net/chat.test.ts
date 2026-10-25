import { describe, expect, it } from 'vitest';
import {
  CHAT,
  ChatSendMessageOrNull,
  cleanChatText,
  maskProfanity,
  QUICK_CHAT,
  QUICK_CHAT_IDS,
  quickChatText,
  sanitizeChatText,
} from './chat.ts';

const parse = (raw: unknown): unknown => ChatSendMessageOrNull['~standard'].validate(raw).value;

describe('chat schema', () => {
  it('accepts a quick-chat preset or a line of text', () => {
    expect(parse({ quick: 'gg' })).toEqual({ quick: 'gg' });
    expect(parse({ text: 'hello' })).toEqual({ text: 'hello' });
  });

  it('refuses anything else (the room kicks the sender)', () => {
    for (const bad of [
      null,
      'gg',
      {},
      { quick: 'notAPreset' },
      { quick: 3 },
      { text: 42 },
      { text: 'x'.repeat(CHAT.maxRawLength + 1) },
      [{ text: 'hi' }],
    ]) {
      expect(parse(bad)).toBeNull();
    }
  });

  it('has 8–10 presets, unique ids, each with its own line', () => {
    expect(QUICK_CHAT.length).toBeGreaterThanOrEqual(8);
    expect(QUICK_CHAT.length).toBeLessThanOrEqual(10);
    expect(new Set(QUICK_CHAT_IDS).size).toBe(QUICK_CHAT.length);
    expect(quickChatText('gg')).toBe('GG');
    expect(quickChatText('nope')).toBe('');
  });
});

describe('sanitizeChatText', () => {
  it('strips control and format characters, collapses whitespace, trims', () => {
    expect(sanitizeChatText('  hi\n\tthere\u0000‮!  ')).toBe('hi there!');
    expect(sanitizeChatText('a​b')).toBe('ab');
  });

  it(`cuts to ${CHAT.maxLength} characters (code points)`, () => {
    expect(sanitizeChatText('x'.repeat(200))).toHaveLength(CHAT.maxLength);
    const emoji = sanitizeChatText('😀'.repeat(100));
    expect(Array.from(emoji)).toHaveLength(CHAT.maxLength);
  });

  it('cuts glyph-stacking spam to two marks per letter', () => {
    expect(sanitizeChatText(`a${'́'.repeat(30)}`)).toBe('á́');
  });

  it('keeps markup as plain characters (clients render text, never HTML)', () => {
    expect(sanitizeChatText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('gives nothing for non-strings and blank lines', () => {
    expect(sanitizeChatText(undefined)).toBe('');
    expect(sanitizeChatText('   \n ')).toBe('');
  });
});

describe('maskProfanity', () => {
  it('masks with asterisks of the same length, case and leet folded', () => {
    expect(maskProfanity('oh fuck off')).toBe('oh **** off');
    expect(maskProfanity('SH1T happens')).toBe('**** happens');
    expect(maskProfanity('fuuuuck')).toBe('*******');
    expect(maskProfanity('you $h!t')).toBe('you ****');
  });

  it('masks the Polish ones too', () => {
    expect(maskProfanity('kurwa mać')).toBe('****a mać');
    expect(maskProfanity('Kurwa')).toBe('****a');
  });

  it('leaves harmless words alone (whole-word and word-start stems)', () => {
    for (const ok of [
      'cocktail at the peacock',
      'Dickens wrote that',
      'a swanky scope',
      'classic pass',
      'Nice shot.',
      'Skyscraper',
    ]) {
      expect(maskProfanity(ok)).toBe(ok);
    }
    expect(maskProfanity('what a dick')).toBe('what a ****');
    expect(maskProfanity('wanker')).toBe('****er');
  });

  it('cleanChatText = sanitize, then mask', () => {
    expect(cleanChatText('  shit\n\nhappens ')).toBe('**** happens');
  });
});
