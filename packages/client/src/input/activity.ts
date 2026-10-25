/**
 * What counts as the player "doing something" for the camera moments (pure, so it is tested):
 * a press edge, controls held down, or a deliberate look.
 */

/** Mouse counts within about `LOOK_WINDOW_MS` that count as looking around. */
export const LOOK_ACTIVITY_COUNTS = 12;
/** The look travel decays with this time constant (ms): a bounded, frame-rate independent window. */
export const LOOK_WINDOW_MS = 200;

/**
 * Mouse travel over a sliding time window: steady movement adds up whatever the frame or polling
 * rate (10 counts per frame at 60 or 240 Hz both cross the threshold), while sensor noise or a
 * resting hand (a count now and then) decays away before it does.
 */
export class LookActivity {
  private travel = 0;
  private last = Number.NaN;

  /** Add `counts` of travel at `nowMs`; true once the window holds a deliberate look. */
  add(counts: number, nowMs: number): boolean {
    if (Number.isFinite(this.last)) {
      this.travel *= Math.exp(-Math.max(0, nowMs - this.last) / LOOK_WINDOW_MS);
    }
    this.last = nowMs;
    this.travel += Math.abs(counts);
    return this.travel > LOOK_ACTIVITY_COUNTS;
  }

  reset(): void {
    this.travel = 0;
    this.last = Number.NaN;
  }
}

/**
 * 0 nothing; 1 a deliberate look or controls held down (enough to hand the camera back from the
 * intro or the victory shot: a player already moving or firing when it starts must keep control);
 * 2 a fresh key/button press (the only thing that respawns early offline).
 */
export function activityLevel(pressed: boolean, held: boolean, looked: boolean): 0 | 1 | 2 {
  return pressed ? 2 : held || looked ? 1 : 0;
}
