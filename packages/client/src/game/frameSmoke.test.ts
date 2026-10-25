import { describe, expect, it } from 'vitest';
import type { SmokeCloud } from '@wd/shared';
import { Game } from './Game.ts';

/** Game's smoke timeline with plain state, without a renderer or browser. */
function fakeGame() {
  const asked: (number | undefined)[] = [];
  const list: SmokeCloud[] = [];
  const game = {
    smoke: [] as SmokeCloud[],
    online: {
      viewTime: (localMs: number) => localMs - 100,
      smokeAt: (vt: number | undefined) => {
        asked.push(vt);
        return list;
      },
    },
  };
  Object.setPrototypeOf(game, Game.prototype);
  const g = game as unknown as { sampleFrameTime(ms: number): void; visibleSmoke: SmokeCloud[] };
  return { g, asked, list };
}

describe('Game smoke timeline (online)', () => {
  it('follows the frame view time with the sim paused (no steps), one list for all users', () => {
    const { g, asked, list } = fakeGame();
    // Menu open: frames keep sampling the network time though no sim step runs.
    g.sampleFrameTime(1000);
    expect(g.visibleSmoke).toBe(list);
    g.sampleFrameTime(1500);
    expect(g.visibleSmoke).toBe(list);
    expect(asked).toEqual([900, 1400]);
  });
});
