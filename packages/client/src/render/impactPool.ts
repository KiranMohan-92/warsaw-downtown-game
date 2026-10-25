/** Fixed records allocated at construction; acquire never creates or moves particle objects. */
export class ImpactPool<T extends { life: number; born: number }> {
  readonly slots: readonly T[];
  private cursor = 0;
  private serial = 0;

  constructor(capacity: number, create: () => T) {
    this.slots = Array.from({ length: capacity }, create);
  }

  /**
   * A free slot, else the oldest live one (recycled). `limit` uses only the first `limit` slots
   * (a smaller ring on a lower tier; slots past it just run out).
   */
  acquire(limit = this.slots.length): T {
    const n = Math.max(1, Math.min(this.slots.length, Math.floor(limit)));
    if (this.cursor >= n) this.cursor = 0;
    let oldest = this.cursor;
    for (let i = 0; i < n; i++) {
      const index = (this.cursor + i) % n;
      const slot = this.slots[index]!;
      if (slot.life <= 0) {
        oldest = index;
        break;
      }
      if (slot.born < this.slots[oldest]!.born) oldest = index;
    }
    this.cursor = (oldest + 1) % n;
    const slot = this.slots[oldest]!;
    slot.born = ++this.serial;
    return slot;
  }

  get count(): number {
    let n = 0;
    for (const p of this.slots) if (p.life > 0) n++;
    return n;
  }
}
