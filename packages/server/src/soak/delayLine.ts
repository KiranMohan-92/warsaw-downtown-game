import { mulberry32 } from '@wd/shared';

/** A simulated link's one-way behaviour (every figure in ms, `loss` a probability 0–1). */
export interface LinkProfile {
  /** One-way delay (ms): 50 each way = 100 ms round trip. */
  delayMs: number;
  /** Each delivery is `delayMs` ± up to this much, uniformly (ms). */
  jitterMs: number;
  /**
   * Chance that a chunk is "lost". The game runs WebSockets over TCP, which never loses or
   * reorders a message: a lost segment is retransmitted, so loss shows up as a late delivery
   * (the retransmission timeout, `rtoMs`) that holds back everything sent after it
   * (head-of-line blocking). That is what is modelled.
   */
  loss: number;
  /** The retransmission delay a lost chunk costs (ms; TCP's minimum RTO is ~200 ms). */
  rtoMs: number;
}

export const DEFAULT_LINK: LinkProfile = { delayMs: 50, jitterMs: 0, loss: 0, rtoMs: 200 };

/**
 * One direction of a simulated link: when each chunk handed to it at `nowMs` is delivered.
 * Deliveries keep their order (TCP): jitter never reorders, it bunches — a chunk due before the
 * previous one waits for it. Pure and seeded (the same seed gives the same schedule), so the
 * real-socket proxy and the virtual-clock test share it.
 */
export class DelayLine {
  private readonly rng: () => number;
  private lastDue = Number.NEGATIVE_INFINITY;
  /** Chunks scheduled / "lost" (retransmitted late). */
  sent = 0;
  lost = 0;

  constructor(
    readonly profile: LinkProfile,
    seed = 1,
  ) {
    this.rng = mulberry32(seed);
  }

  /** The delivery time of a chunk sent at `nowMs`. */
  schedule(nowMs: number): number {
    const p = this.profile;
    this.sent++;
    let due = nowMs + p.delayMs;
    if (p.jitterMs > 0) due += (this.rng() * 2 - 1) * p.jitterMs;
    if (p.loss > 0 && this.rng() < p.loss) {
      this.lost++;
      due += p.rtoMs;
    }
    due = Math.max(nowMs, due, this.lastDue);
    this.lastDue = due;
    return due;
  }
}

/** A queue of items due at given times, released in order (drives the virtual-clock links). */
export class DelayQueue<T> {
  private readonly items: { due: number; item: T }[] = [];

  constructor(private readonly line: DelayLine) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T, nowMs: number): void {
    // Due times never decrease (`DelayLine` keeps order), so appending keeps the queue sorted.
    this.items.push({ due: this.line.schedule(nowMs), item });
  }

  /** Remove and return every item due by `nowMs`, oldest first. */
  takeDue(nowMs: number): T[] {
    let n = 0;
    while (n < this.items.length && this.items[n]!.due <= nowMs) n++;
    return this.items.splice(0, n).map((e) => e.item);
  }
}
