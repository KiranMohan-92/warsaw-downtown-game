import { describe, expect, it } from 'vitest';
import { pingLabel, scoreboardRows, type ScoreboardPlayer } from './Scoreboard.ts';

const p = (
  id: string,
  kills: number,
  deaths: number,
  extra: Partial<ScoreboardPlayer> = {},
): ScoreboardPlayer => ({ id, name: id, kills, deaths, bot: false, ping: 40, ...extra });

describe('scoreboard rows', () => {
  it('sorts by kills, then fewest deaths (how the match picks winners)', () => {
    const rows = scoreboardRows([p('a', 3, 5), p('b', 7, 2), p('c', 3, 1), p('d', 0, 0)], 'a');
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(rows.find((r) => r.id === 'a')!.me).toBe(true);
    expect(rows.filter((r) => r.me)).toHaveLength(1);
  });

  it('level on kills and deaths share a place; the next place skips', () => {
    const rows = scoreboardRows(
      [
        p('bot2', 4, 2, { bot: true }),
        p('zed', 4, 2),
        p('me', 4, 2),
        p('top', 9, 0),
        p('last', 1, 3),
      ],
      'me',
    );
    // Within a tie: you first, then humans, then bots (stable whatever the input order).
    expect(rows.map((r) => r.id)).toEqual(['top', 'me', 'zed', 'bot2', 'last']);
    expect(rows.map((r) => [r.rank, r.tied])).toEqual([
      [1, false],
      [2, true],
      [2, true],
      [2, true],
      [5, false],
    ]);
  });

  it('a zero-kill match: everyone level shares first', () => {
    const rows = scoreboardRows([p('a', 0, 0), p('b', 0, 0)], 'b');
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows.every((r) => r.rank === 1 && r.tied)).toBe(true);
  });

  it('the same input in any order gives the same rows', () => {
    const list = [p('x', 2, 2), p('y', 2, 2, { bot: true }), p('w', 5, 1), p('v', 2, 2)];
    const a = scoreboardRows(list, 'v');
    const b = scoreboardRows([...list].reverse(), 'v');
    expect(b).toEqual(a);
  });

  it('ping column: BOT tag for bots, the round trip for humans, a dash when unknown', () => {
    expect(pingLabel({ bot: true, ping: null })).toBe('BOT');
    expect(pingLabel({ bot: false, ping: 37.6 })).toBe('38');
    expect(pingLabel({ bot: false, ping: null })).toBe('—');
    expect(pingLabel({ bot: false, ping: -1 })).toBe('—');
  });
});
