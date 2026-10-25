import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROOMS } from '@wd/shared';
import { createGameServer } from '../app.ts';
import { DEFAULT_MATCH_LIMITS, matchGuard } from './matchGuard.ts';

// The Cloudflare rate-limit key over real HTTP matchmaking (Colyseus hands `onAuth` a Fetch
// `Request`, not a socket: this is what the unit tests of `rateLimitKey` cannot show). Bound to
// loopback like `pnpm host` (GAME_HOST=127.0.0.1).
const PORT = 27670 + Math.floor(Math.random() * 1000);
const server = createGameServer(undefined, { quickJoin: { botCount: 0 } });
const env = { WD_TRUST_CF: process.env.WD_TRUST_CF, GAME_HOST: process.env.GAME_HOST };

beforeAll(async () => {
  await server.listen(PORT, '127.0.0.1');
});
afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  matchGuard.reset();
});
afterAll(async () => {
  await server.gracefullyShutdown(false);
});

/**
 * One matchmaking create with the given headers. The options are invalid on purpose: `onAuth`
 * charges the rate limit first, then refuses them, so no room is ever built. Returns the error.
 */
async function matchmake(headers: Record<string, string>): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/matchmake/create/${ROOMS.match}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ map: 'mars' }),
  });
  const text = await res.text();
  if (/too many requests/.test(text)) return 'rate';
  if (/invalid/.test(text)) return 'invalid';
  return `unexpected ${res.status}: ${text}`;
}

/** Three requests from one Cloudflare client, each forging a different first X-Forwarded-For hop. */
const forgedBurst = () =>
  [1, 2, 3].map((i) => ({
    'x-forwarded-for': `10.0.0.${i}, 198.51.100.7`,
    'cf-connecting-ip': '198.51.100.7',
  }));

describe('matchmaking rate-limit key over HTTP', () => {
  const tight = { ...DEFAULT_MATCH_LIMITS, requestBurst: 2, requestsPerSec: 0.001 };

  it('behind the local tunnel, forged X-Forwarded-For hops share the CF-Connecting-IP bucket', async () => {
    process.env.WD_TRUST_CF = '1';
    process.env.GAME_HOST = '127.0.0.1';
    matchGuard.reset(tight);
    const results = [];
    for (const h of forgedBurst()) results.push(await matchmake(h));
    expect(results).toEqual(['invalid', 'invalid', 'rate']);
    // Another Cloudflare client has its own budget.
    expect(
      await matchmake({ 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': '203.0.113.4' }),
    ).toBe('invalid');
  });

  it('without the flag (or bound beyond loopback) the key is unchanged: the first hop', async () => {
    for (const set of [
      () => delete process.env.WD_TRUST_CF,
      () => {
        process.env.WD_TRUST_CF = '1';
        process.env.GAME_HOST = '0.0.0.0';
      },
    ]) {
      set();
      matchGuard.reset(tight);
      const results = [];
      for (const h of forgedBurst()) results.push(await matchmake(h));
      // Each forged hop is its own key (the forgery Cloudflare trust closes)…
      expect(results).toEqual(['invalid', 'invalid', 'invalid']);
      // …and one hop repeated is limited as before.
      const same = { 'x-forwarded-for': '10.0.0.9' };
      expect([await matchmake(same), await matchmake(same), await matchmake(same)]).toEqual([
        'invalid',
        'invalid',
        'rate',
      ]);
    }
  });
});
