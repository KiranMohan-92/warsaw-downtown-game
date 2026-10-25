import { describe, expect, it } from 'vitest';
import { netIndicator } from './netIndicator.ts';

const base = { rttMs: 40, jitterMs: 4, delayMs: 100, silenceMs: 20, stalls: 0 };

describe('netIndicator', () => {
  it('shows the ping, coloured by round trip', () => {
    expect(netIndicator(base)).toEqual({ ping: '40 ms', level: 'good', warning: null });
    expect(netIndicator({ ...base, rttMs: 110 }).level).toBe('fair');
    expect(netIndicator({ ...base, rttMs: 190.4 })).toMatchObject({
      ping: '190 ms',
      level: 'poor',
    });
    expect(netIndicator({ ...base, rttMs: -1 })).toMatchObject({ ping: '— ms', level: 'good' });
  });

  it('warns when the link stalls now, keeps stalling, or jitters', () => {
    expect(netIndicator({ ...base, silenceMs: 400 })).toMatchObject({
      warning: 'NETWORK STALL',
      level: 'poor',
    });
    expect(netIndicator({ ...base, stalls: 3 }).warning).toBe('UNSTABLE CONNECTION');
    expect(netIndicator({ ...base, delayMs: 200 }).warning).toBe('UNSTABLE CONNECTION');
    expect(netIndicator({ ...base, stalls: 1 })).toMatchObject({
      warning: 'JITTER',
      level: 'fair',
    });
    expect(netIndicator({ ...base, jitterMs: 30 }).warning).toBe('JITTER');
  });

  it('does not blame the network for late arrivals while the page itself hitches', () => {
    // A 300 ms frame in the last 10 s: the stalls and the grown buffer are the page's.
    expect(netIndicator({ ...base, stalls: 4, delayMs: 220, jitterMs: 40 }, 300).warning).toBe(
      null,
    );
    // A live silence well beyond the hitch is still the network.
    expect(netIndicator({ ...base, silenceMs: 300 }, 300).warning).toBe(null);
    expect(netIndicator({ ...base, silenceMs: 450 }, 300).warning).toBe('NETWORK STALL');
  });
});
