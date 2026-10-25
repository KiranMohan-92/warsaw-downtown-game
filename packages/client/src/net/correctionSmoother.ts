/** A position (m). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Visual smoothing of the local player's reconciliation corrections (presentation only: the
 * sim state is corrected exactly and at once, prediction stays exact). When the server's state
 * moves the predicted body by a small amount — a late or dropped input after a stall — the
 * camera keeps drawing where it was and the difference decays with time constant `tauMs`
 * (≈ 95 % gone in 100 ms), instead of the view snapping. A large correction (a teleport, a
 * respawn, anything over `snapDistance`) snaps: gliding across the map would be worse.
 */
export class CorrectionSmoother {
  private readonly off = { x: 0, y: 0, z: 0 };

  constructor(
    readonly tauMs = 35,
    readonly snapDistance = 2,
  ) {}

  /** The offset to add to the drawn position (m). */
  get offset(): Readonly<Vec3Like> {
    return this.off;
  }

  /**
   * The body moved from `before` to `after` by a correction. Returns `'blend'` when the view
   * glides (the offset absorbed it), `'snap'` when it jumps (`force`: respawn / teleport, or
   * too large).
   */
  correct(before: Vec3Like, after: Vec3Like, force = false): 'blend' | 'snap' {
    const x = this.off.x + before.x - after.x;
    const y = this.off.y + before.y - after.y;
    const z = this.off.z + before.z - after.z;
    if (force || !Number.isFinite(x + y + z) || Math.hypot(x, y, z) > this.snapDistance) {
      this.reset();
      return 'snap';
    }
    this.off.x = x;
    this.off.y = y;
    this.off.z = z;
    return 'blend';
  }

  /** Decay the offset by one frame (`dtSec`, seconds of real time). */
  update(dtSec: number): void {
    const k = Math.exp(-Math.max(0, dtSec * 1000) / this.tauMs);
    this.off.x *= k;
    this.off.y *= k;
    this.off.z *= k;
    if (Math.hypot(this.off.x, this.off.y, this.off.z) < 1e-4) this.reset();
  }

  reset(): void {
    this.off.x = this.off.y = this.off.z = 0;
  }
}
