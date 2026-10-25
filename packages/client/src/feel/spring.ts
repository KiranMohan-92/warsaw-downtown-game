/**
 * Critically damped spring (no overshoot) and an underdamped variant for punchy kicks. Both are
 * frame-rate independent: they integrate with the real frame dt using a stable closed form.
 */
export class Spring {
  value = 0;
  velocity = 0;
  constructor(
    /** Angular frequency (rad/s): higher = snappier. */
    public stiffness: number,
    /** 1 = critically damped, < 1 bounces. */
    public damping = 1,
  ) {}

  /** Add an instantaneous velocity impulse. */
  kick(v: number): void {
    this.velocity += v;
  }

  update(target: number, dt: number): number {
    // Semi-implicit integration sub-stepped for stability at low frame rates.
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    const w = this.stiffness;
    for (let i = 0; i < steps; i++) {
      const accel = w * w * (target - this.value) - 2 * this.damping * w * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Exponential smoothing toward a target, frame-rate independent. `rate` in 1/s. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);
