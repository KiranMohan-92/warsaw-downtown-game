import { describe, expect, it } from 'vitest';
import { voiceFor } from './Game.ts';

describe('voiceFor', () => {
  it('is stable per player and spreads players over the four voices', () => {
    expect(voiceFor('abc')).toBe(voiceFor('abc'));
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'bot:1', 'bot:2'].map(voiceFor));
    for (const v of seen) expect(v >= 0 && v < 4).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
  });
});
