import { describe, expect, it } from 'vitest';
import type { CombatMessage } from '@wd/shared';
import {
  PREGAME_COMBAT_MAX_AGE_MS,
  PREGAME_COMBAT_MAX_MESSAGES,
  bufferPregameCombat,
} from './friendLobby.ts';

const nade = (id: number): CombatMessage => ({
  events: [
    {
      type: 'nade',
      id,
      by: 'p',
      pos: { x: 0, y: 1, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      fuse: 2,
      kind: 'frag',
    },
  ],
});
const idOf = (m: CombatMessage | undefined): number => (m?.events[0] as { id: number }).id;

describe('friend lobby pre-game combat buffer', () => {
  it('keeps every combat message during a long Game.create (no 4-message cap)', () => {
    const combats: CombatMessage[] = [];
    const times: number[] = [];
    // 40 messages over 8 s: grenades thrown early must still be replayed.
    for (let i = 0; i < 40; i++) bufferPregameCombat(combats, times, nade(i), i * 200);
    expect(combats).toHaveLength(40);
    expect(idOf(combats[0])).toBe(0);
    expect(times).toHaveLength(40);
  });

  it('is bounded by age and by a generous count', () => {
    const combats: CombatMessage[] = [];
    const times: number[] = [];
    bufferPregameCombat(combats, times, nade(0), 0);
    bufferPregameCombat(combats, times, nade(1), 1000);
    bufferPregameCombat(combats, times, nade(2), PREGAME_COMBAT_MAX_AGE_MS + 500);
    expect(combats.map(idOf)).toEqual([1, 2]);

    combats.length = 0;
    times.length = 0;
    for (let i = 0; i < PREGAME_COMBAT_MAX_MESSAGES + 10; i++) {
      bufferPregameCombat(combats, times, nade(i), 0);
    }
    expect(combats).toHaveLength(PREGAME_COMBAT_MAX_MESSAGES);
    expect(idOf(combats[0])).toBe(10);
    expect(times).toHaveLength(combats.length);
  });
});
