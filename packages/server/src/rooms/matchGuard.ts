import { isIP } from 'node:net';
import { TokenBucket } from '@wd/shared';

export interface MatchLimits {
  /** Live match rooms at most (each holds a full physics world for its map). */
  maxRooms: number;
  /** Matchmaking requests (create / join) per client address: burst… */
  requestBurst: number;
  /** …and sustained rate per second. */
  requestsPerSec: number;
}

export const DEFAULT_MATCH_LIMITS: MatchLimits = {
  maxRooms: 32,
  // A party of six joining at once from behind one address, plus a few settings reloads.
  requestBurst: 12,
  requestsPerSec: 1,
};

/** Client addresses tracked at most (spoofed addresses must not grow the table forever). */
const MAX_KEYS = 4096;

/**
 * Process-wide guard for the match room type: caps live rooms (creating one builds a physics
 * world, so unbounded creates are a memory/CPU denial of service) and rate-limits matchmaking
 * requests per client address. Time is injected (pure; unit-tested).
 *
 * The address is Colyseus's `AuthContext.ip`: the first `X-Real-IP` / `X-Forwarded-For` hop.
 * Colyseus passes no socket address for HTTP matchmaking, so without a reverse proxy setting
 * those headers every client shares one key (a global rate), and when the server is exposed
 * directly a client can forge them; the room cap is the backstop either way.
 */
export class MatchGuard {
  private live = 0;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(public limits: MatchLimits = { ...DEFAULT_MATCH_LIMITS }) {}

  get rooms(): number {
    return this.live;
  }

  /** One matchmaking request from `key` at `nowMs`. False: over its rate, refuse it. */
  allowRequest(key: string, nowMs: number): boolean {
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Most recently used last (Map order), so eviction below drops the stalest address.
      this.buckets.delete(key);
    } else {
      bucket = new TokenBucket(this.limits.requestsPerSec, this.limits.requestBurst, nowMs);
      if (this.buckets.size >= MAX_KEYS) {
        this.buckets.delete(this.buckets.keys().next().value!);
      }
    }
    this.buckets.set(key, bucket);
    return bucket.take(nowMs);
  }

  /** Claim a room slot (false: at the cap, refuse the create). Pair with `closeRoom`. */
  openRoom(): boolean {
    if (this.live >= this.limits.maxRooms) return false;
    this.live++;
    return true;
  }

  closeRoom(): void {
    this.live = Math.max(0, this.live - 1);
  }

  /** Forget every address (tests). */
  reset(limits: MatchLimits = { ...DEFAULT_MATCH_LIMITS }): void {
    this.limits = limits;
    this.buckets.clear();
  }
}

/** The one guard for this process's match rooms. */
export const matchGuard = new MatchGuard();

/** Loopback bind addresses: only this machine (the local cloudflared) can connect. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Whether `host` (a listen address) accepts connections from this machine only. */
export function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Whether to trust Cloudflare's `CF-Connecting-IP` for the rate-limit key. **Invariant: only
 * when the game server is bound to loopback** (`GAME_HOST=127.0.0.1`, as `pnpm host` sets it next
 * to `WD_TRUST_CF=1`): then the only client that can reach it is the local cloudflared, which
 * sets the header itself from the address Cloudflare saw. Colyseus hands HTTP matchmaking a Fetch
 * `Request` (no socket address), so the peer cannot be checked per request; the bind address is
 * what makes the header trustworthy. `WD_TRUST_CF=1` with any other `GAME_HOST` (or none: the
 * default is `0.0.0.0`) is ignored — anyone could reach the server directly and forge the header.
 */
export function trustCloudflare(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WD_TRUST_CF === '1' && isLoopbackHost(env.GAME_HOST);
}

/**
 * The matchmaking rate-limit key for a request. Colyseus's `ip` is the *first*
 * `X-Real-IP` / `X-Forwarded-For` hop, which a client can forge through a proxy that appends
 * (Cloudflare does). Behind the local Cloudflare quick tunnel (`trustCloudflare`, see its
 * invariant) the key is Cloudflare's own `CF-Connecting-IP` — the address Cloudflare saw, which
 * the client cannot set. Otherwise (not trusted, a missing or malformed header) it is Colyseus's
 * address, so exposing the server directly never trusts the header.
 */
export function rateLimitKey(
  context: {
    ip?: string;
    headers?: Headers | Record<string, string | string[] | undefined>;
  },
  trusted = trustCloudflare(),
): string {
  const fallback = context.ip ?? 'unknown';
  if (!trusted) return fallback;
  const h = context.headers;
  const raw =
    h instanceof Headers
      ? h.get('cf-connecting-ip')
      : ([h?.['cf-connecting-ip']].flat()[0] ?? null);
  const cf = typeof raw === 'string' ? raw.trim() : '';
  return cf && isIP(cf) ? cf : fallback;
}
