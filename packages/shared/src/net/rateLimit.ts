/**
 * Token bucket: `ratePerSec` tokens refill continuously up to `burst`. Time is injected (ms), so
 * the limiter is a pure state machine and deterministic in tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    nowMs: number,
  ) {
    this.tokens = burst;
    this.last = nowMs;
  }

  /** Take one token if available. Returns false (and takes nothing) when over the limit. */
  take(nowMs: number): boolean {
    const elapsed = Math.max(0, nowMs - this.last) / 1000;
    this.last = Math.max(this.last, nowMs);
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
