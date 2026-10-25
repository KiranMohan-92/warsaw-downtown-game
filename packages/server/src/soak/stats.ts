/** Order statistics of a sample (ms or any unit); zeros for an empty one. */
export interface Dist {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
}

export function dist(values: readonly number[]): Dist {
  if (!values.length) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s.at(-1)!,
    min: s[0]!,
  };
}

/** "p50/p95/p99/max" with one decimal (ms). */
export const fmtDist = (d: Dist, digits = 1): string =>
  d.n ? [d.p50, d.p95, d.p99, d.max].map((v) => v.toFixed(digits)).join(' / ') : 'no samples';

export const pct = (num: number, den: number): string =>
  den ? `${((100 * num) / den).toFixed(1)} % (${num}/${den})` : 'n/a (0 samples)';

/** A reservoir that keeps at most `cap` values (every value while under it, then a sample). */
export class Reservoir {
  readonly values: number[] = [];
  private seen = 0;
  private state = 0x9e3779b9;

  constructor(private readonly cap = 100_000) {}

  push(v: number): void {
    this.seen++;
    if (this.values.length < this.cap) {
      this.values.push(v);
      return;
    }
    // xorshift: deterministic, no Math.random
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    const j = (this.state >>> 0) % this.seen;
    if (j < this.cap) this.values[j] = v;
  }
}
