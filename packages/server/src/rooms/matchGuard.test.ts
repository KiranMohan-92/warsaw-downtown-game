import { describe, expect, it } from 'vitest';
import type { AuthContext } from '@colyseus/core';
import { MatchRoom, matchmakeMethod } from './MatchRoom.ts';
import {
  isLoopbackHost,
  MatchGuard,
  matchGuard,
  rateLimitKey,
  trustCloudflare,
} from './matchGuard.ts';

describe('MatchGuard', () => {
  it('caps live rooms and frees a slot when one closes', () => {
    const g = new MatchGuard({ maxRooms: 2, requestBurst: 10, requestsPerSec: 1 });
    expect(g.openRoom()).toBe(true);
    expect(g.openRoom()).toBe(true);
    expect(g.openRoom()).toBe(false);
    expect(g.rooms).toBe(2);
    g.closeRoom();
    expect(g.openRoom()).toBe(true);
    g.closeRoom();
    g.closeRoom();
    g.closeRoom(); // never below zero
    expect(g.rooms).toBe(0);
  });

  it('rate-limits matchmaking per client address, refilling over time', () => {
    const g = new MatchGuard({ maxRooms: 2, requestBurst: 3, requestsPerSec: 1 });
    const burst = [0, 0, 0, 0].map(() => g.allowRequest('1.2.3.4', 0));
    expect(burst).toEqual([true, true, true, false]);
    expect(g.allowRequest('5.6.7.8', 0)).toBe(true); // another address has its own budget
    expect(g.allowRequest('1.2.3.4', 500)).toBe(false);
    expect(g.allowRequest('1.2.3.4', 1000)).toBe(true); // one per second
  });

  it('a join Colyseus retries (lost seat race) is charged once, not per attempt', async () => {
    matchGuard.reset({ maxRooms: 2, requestBurst: 1, requestsPerSec: 0.001 });
    try {
      const ctx = { ip: '9.9.9.9', token: undefined, headers: new Headers() } as AuthContext;
      const opts = { lobby: false, map: 'range', size: 'full', mode: 'standard' };
      await expect(MatchRoom.onAuth('', opts, ctx)).resolves.toEqual({ matchmade: true });
      // the retry
      await expect(MatchRoom.onAuth('', opts, ctx)).resolves.toEqual({ matchmade: true });
      const next: AuthContext = { ...ctx }; // a new request from the same address
      await expect(MatchRoom.onAuth('', opts, next)).rejects.toThrow(/too many requests/);
    } finally {
      matchGuard.reset();
    }
  });

  it('matchmaking needs every room key; a share link (joinById) needs none', async () => {
    matchGuard.reset();
    const at = (method: string): AuthContext => ({
      ip: `m-${method}`,
      token: undefined,
      headers: new Headers(),
      req: { url: `http://localhost/matchmake/${method}/match` },
    });
    for (const method of ['create', 'join', 'joinOrCreate']) {
      await expect(MatchRoom.onAuth('', { map: 'range' }, at(method))).rejects.toThrow(/required/);
    }
    await expect(MatchRoom.onAuth('', {}, at('joinById'))).resolves.toEqual({ matchmade: false });
    expect(matchmakeMethod({ req: { url: 'http://h/matchmake/joinById/abc?x=1' } })).toBe(
      'joinById',
    );
    expect(matchmakeMethod({})).toBeNull();
  });

  it('forgets the stalest addresses first, so forged addresses cannot grow it forever', () => {
    const g = new MatchGuard({ maxRooms: 2, requestBurst: 1, requestsPerSec: 0.001 });
    expect(g.allowRequest('victim', 0)).toBe(true);
    expect(g.allowRequest('victim', 1)).toBe(false);
    for (let i = 0; i < 5000; i++) g.allowRequest(`forged-${i}`, 2);
    // The table stayed bounded: 'victim' was evicted and starts over with a fresh budget.
    expect(g.allowRequest('victim', 3)).toBe(true);
  });
});

describe('rateLimitKey (Cloudflare quick tunnel)', () => {
  const via = (headers: Record<string, string>, ip = '203.0.113.9') => ({ ip, headers });
  it("keeps Colyseus's address unless the trust is on", () => {
    expect(rateLimitKey(via({ 'cf-connecting-ip': '198.51.100.7' }), false)).toBe('203.0.113.9');
  });
  it('uses CF-Connecting-IP when trusted, not a forged X-Forwarded-For first hop', () => {
    // A client sends "X-Forwarded-For: 1.2.3.4"; Cloudflare appends, Colyseus reads the forged hop.
    const forged = via(
      { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4, 198.51.100.7' },
      '1.2.3.4',
    );
    expect(rateLimitKey(forged, true)).toBe('198.51.100.7');
    expect(rateLimitKey(via({ 'cf-connecting-ip': ' 2001:db8::5 ' }), true)).toBe('2001:db8::5');
    const headers = new Headers({ 'cf-connecting-ip': '198.51.100.8' });
    expect(rateLimitKey({ ip: 'x', headers }, true)).toBe('198.51.100.8');
  });
  it("falls back to Colyseus's address on a missing or malformed header", () => {
    expect(rateLimitKey(via({ 'cf-connecting-ip': 'not an ip' }), true)).toBe('203.0.113.9');
    expect(rateLimitKey(via({}), true)).toBe('203.0.113.9');
    expect(rateLimitKey({ headers: {} }, true)).toBe('unknown');
  });
  it('trusts the header only when the server is bound to loopback', () => {
    expect(trustCloudflare({ WD_TRUST_CF: '1', GAME_HOST: '127.0.0.1' })).toBe(true);
    expect(trustCloudflare({ WD_TRUST_CF: '1', GAME_HOST: '::1' })).toBe(true);
    expect(trustCloudflare({ WD_TRUST_CF: '1', GAME_HOST: 'localhost' })).toBe(true);
    // Reachable from other machines (or the 0.0.0.0 default): anyone could forge the header.
    expect(trustCloudflare({ WD_TRUST_CF: '1' })).toBe(false);
    expect(trustCloudflare({ WD_TRUST_CF: '1', GAME_HOST: '0.0.0.0' })).toBe(false);
    expect(trustCloudflare({ WD_TRUST_CF: '1', GAME_HOST: '192.168.1.5' })).toBe(false);
    expect(trustCloudflare({ GAME_HOST: '127.0.0.1' })).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});
