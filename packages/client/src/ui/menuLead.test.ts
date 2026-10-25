import { describe, expect, it } from 'vitest';
import { menuLead } from './Menu.ts';

describe('menu lead button', () => {
  it('offline page: Play vs bots leads, Play becomes the free range', () => {
    const l = menuLead(false, false);
    expect(l.lead).toBe('practice');
    expect(l.practiceLabel).toBe('Play vs bots');
    expect(l.playLabel).toBe('Free range');
  });

  it('online page: Play (join the match) leads', () => {
    const l = menuLead(false, true);
    expect(l.lead).toBe('play');
    expect(l.playLabel).toBe('Play');
  });

  it('practice page: Play (resume) leads, the practice button leaves', () => {
    const l = menuLead(true, false);
    expect(l.lead).toBe('play');
    expect(l.playLabel).toBe('Play');
    expect(l.practiceLabel).toBe('Leave practice');
  });
});
