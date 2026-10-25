/**
 * Which cinematic camera moment is playing (presentation only: the sim never reads it). A small
 * state machine, pure so its transitions are tested:
 *
 *   play ─ startIntro ─▶ intro ─ (duration | input) ─▶ play
 *   play ─ died ─▶ death (pull out of the head) ─▶ killcam (killer known) | orbit (self/world)
 *        └─ respawned ─▶ play (a clean cut back to first person)
 *   any  ─ matchEnded ─▶ victory ─ (matchStarted | input) ─▶ play
 *
 * Disabled (the "Cinematic cameras" setting off), nothing leaves `play`. The first-person view
 * is only ever taken while the player isn't playing anyway (dead, results, the join warm-up);
 * where they could already act (intro, results), any input hands the camera straight back.
 */

export type ShotMode = 'play' | 'intro' | 'death' | 'killcam' | 'orbit' | 'victory';

/** Timings (s) of the camera moments. */
export const CINE = {
  /** The match-intro fly-over. */
  introDuration: 3.6,
  /** Death cam: pull up and out of the first-person view, behind the body. */
  deathPull: 0.5,
  /** Kill cam replay length (the respawn wait is 3 s: 0.5 pull + 2.5 replay). */
  killcamLength: 2.5,
  /** Seconds of the replay after the killing blow (the victim going down). */
  killcamPostRoll: 0.35,
  /** Victory shot: fly from where the camera was to the winner. */
  victoryFly: 1.6,
  /** Orbit speeds (rad/s): the body of an own frag, the winner. */
  orbitSpeed: 0.35,
  victoryOrbitSpeed: 0.2,
} as const;

/** Who killed the local player, for the kill cam and its banner. */
export interface KillInfo {
  /** The killer's id; null = own frag, the world or unknown (the camera orbits the body). */
  killer: string | null;
  killerName: string;
  /** Weapon name as the banner shows it. */
  weapon: string;
  /** Metres between the killer and the victim at the blow. */
  distance: number;
  headshot: boolean;
  /** Server ms of the killing blow (end of the replay window); NaN = no replay (offline). */
  killMs: number;
}

export class CameraDirector {
  private on = true;
  mode: ShotMode = 'play';
  /** Seconds in the current mode. */
  time = 0;
  kill: KillInfo | null = null;
  /** Mode changed since the composer last looked (it restarts its smoothing on entry). */
  entered = false;
  /** Seconds left of a preview (test hook) shot; 0 = a real one. */
  private previewLeft = 0;

  get enabled(): boolean {
    return this.on;
  }

  /** The "Cinematic cameras" setting: off cuts back to first person at once. */
  setEnabled(on: boolean): void {
    this.on = on;
    if (!on) this.go('play');
  }

  /** The camera is outside the player's head (viewmodel and crosshair hide, the body shows). */
  get outside(): boolean {
    return this.mode !== 'play';
  }

  /** One of the death moments (pull-out, kill cam, orbit), waiting for the respawn. */
  get deathShot(): boolean {
    return this.mode === 'death' || this.mode === 'killcam' || this.mode === 'orbit';
  }

  /** A preview started by the test hook (ends on its own; no respawn will come). */
  get preview(): boolean {
    return this.previewLeft > 0;
  }

  private go(mode: ShotMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.time = 0;
    this.entered = true;
    if (mode === 'play') {
      this.kill = null;
      this.previewLeft = 0;
    }
  }

  /** Match intro (join / practice start). False if it can't play now. */
  startIntro(): boolean {
    if (!this.on || this.mode !== 'play') return false;
    this.go('intro');
    return true;
  }

  /** The local player died. The results' victory shot keeps the camera. */
  died(info: KillInfo): void {
    if (!this.on || this.mode === 'victory') return;
    this.kill = info;
    this.previewLeft = 0; // a real death is never a preview (it waits for the respawn)
    this.mode = 'play'; // re-enter even from a death shot (a stale one is replaced)
    this.go('death');
  }

  /** The local player is alive again: a clean cut back to first person. */
  respawned(): void {
    if (this.deathShot) this.go('play');
  }

  /** Results phase: the victory shot (over any death moment). */
  matchEnded(): void {
    if (!this.on) return;
    this.previewLeft = 0;
    this.go('victory');
  }

  /** The next match started: back to the player's eyes. */
  matchStarted(): void {
    if (this.mode === 'victory') this.go('play');
  }

  /**
   * The player pressed something. The intro and the victory shot hand control back at once
   * (true). Death moments are not skipped here: online the server decides the respawn; offline
   * the game respawns early and calls `respawned`.
   */
  skip(): boolean {
    if (this.mode !== 'intro' && this.mode !== 'victory' && !this.preview) return false;
    this.go('play');
    return true;
  }

  /** Test hook: play `mode` for `seconds` then return to play (a preview, no real event). */
  startPreview(
    mode: Exclude<ShotMode, 'play'>,
    seconds: number,
    kill: KillInfo | null = null,
  ): void {
    if (!this.on) return;
    this.mode = 'play';
    this.go(mode);
    this.kill = kill;
    this.previewLeft = Math.max(0.01, seconds);
  }

  /** Seconds into the kill cam's replay (0 … `killcamLength`). */
  get replayTime(): number {
    return this.mode === 'killcam' ? Math.min(this.time, CINE.killcamLength) : 0;
  }

  update(dt: number): void {
    if (this.mode === 'play') return;
    this.time += dt;
    if (this.previewLeft > 0) {
      this.previewLeft -= dt;
      if (this.previewLeft <= 0) {
        this.go('play');
        return;
      }
    }
    if (this.mode === 'intro' && this.time >= CINE.introDuration) this.go('play');
    else if (this.mode === 'death' && this.time >= CINE.deathPull) {
      this.go(this.kill?.killer ? 'killcam' : 'orbit');
    }
    // The kill cam holds its last frame, the orbit keeps turning, until the respawn cut.
  }

  /** Read and clear the mode-entry flag (the composer snaps its smoothing on entry). */
  takeEntered(): boolean {
    const e = this.entered;
    this.entered = false;
    return e;
  }
}
