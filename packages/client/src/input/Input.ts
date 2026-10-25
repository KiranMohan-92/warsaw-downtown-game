import { Button, MAX_PITCH, TAC_SPRINT, type PlayerInput } from '@wd/shared';
import { DEG_PER_COUNT, type Action, type Settings } from '../settings/settings.ts';
import { activityLevel, LookActivity } from './activity.ts';

/**
 * Something that takes the keyboard/mouse over for a while (the chat box while typing, the
 * quick-chat wheel, the scoreboard's mute keys). Each hook returns true when it consumed the
 * event: the game never sees it (no movement, no fire, no view turn).
 */
export interface InputModal {
  key(code: string, down: boolean, e: Pick<KeyboardEvent, 'repeat'>): boolean;
  button(code: string): boolean;
  look(dx: number, dy: number): boolean;
}

/**
 * Keyboard + raw mouse. Mouse deltas are applied to the view immediately on every event (render
 * rate, no sim-tick quantisation); the 60 Hz sim samples the current view and buttons via
 * `sample()`. Presses shorter than one sim step are latched so taps are never lost.
 * Bindings come from settings and can be changed live.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  /** When the mouse last turned the view (ms, `performance.now`): the truck's chase camera
   * recentres behind the truck once you leave the mouse alone. */
  lastLookMs = Number.NEGATIVE_INFINITY;
  /** Look movement (degrees) since the last `consumeLookDelta()`, for weapon sway. */
  private lookDx = 0;
  private lookDy = 0;
  private readonly down = new Set<Action>();
  private readonly latched = new Set<Action>();
  private readonly toggles = { sprint: false, crouch: false, ads: false };
  /** Last Sprint press (ms) and a tactical sprint gesture waiting for the next sample. */
  private lastSprintPress = -Infinity;
  private tacLatched = false;
  private codeToActions = new Map<string, Action[]>();
  /** When set, the next key/mouse press is captured for rebinding instead of played. */
  private capture: ((code: string | null) => void) | null = null;
  locked = false;
  /** Scripted input for automated tests (`?autotest`): bypasses pointer lock. */
  scripted: { buttons: number; moveX: number; moveZ: number } | null = null;
  /** Scripted taps, latched until the next sim step (same semantics as real key taps). */
  scriptedTaps = 0;
  onLockChange: (locked: boolean) => void = () => {};
  /** See `InputModal` (chat). */
  modal: InputModal | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly settings: () => Settings,
    /** Current sensitivity scale from zoom (FOV-matched ADS). */
    private readonly zoomSensScale: () => number,
  ) {
    this.rebuildBindings();
    const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'mousemove';
    document.addEventListener(moveEvent, (e) => this.onMove(e as MouseEvent));
    document.addEventListener('keydown', (e) => this.onKey(e, true));
    document.addEventListener('keyup', (e) => this.onKey(e, false));
    document.addEventListener('mousedown', (e) => {
      if (this.capture) {
        e.preventDefault();
        this.finishCapture(`Mouse${e.button}`);
      } else if (this.locked) {
        if (this.modal?.button(`Mouse${e.button}`)) return;
        this.pressedAny = true;
        this.press(`Mouse${e.button}`, true);
      }
    });
    document.addEventListener('mouseup', (e) => this.press(`Mouse${e.button}`, false));
    document.addEventListener('contextmenu', (e) => {
      if (this.locked || this.capture) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseAll();
      this.onLockChange(this.locked);
    });
    window.addEventListener('blur', () => this.releaseAll());
    // Mouse wheel cycles weapons (latched like a tap).
    document.addEventListener(
      'wheel',
      (e) => {
        if (!this.locked || e.deltaY === 0 || this.modal?.button('Wheel')) return;
        // Queue each detent (capped) so fast scrolling cycles reliably.
        this.wheelQueue = Math.max(-3, Math.min(3, this.wheelQueue + (e.deltaY > 0 ? 1 : -1)));
        this.pressedAny = true;
      },
      { passive: true },
    );
  }

  /**
   * Input since the last `consumeActivity` (camera moments: any of it skips the intro or the
   * victory shot, only a press respawns early offline; see `input/activity.ts`). Any key or
   * button counts as a press, bound or not; controls still held from before count as activity
   * (not as a press); a look counts once its travel adds up within a short time window.
   */
  private pressedAny = false;
  private looked = false;
  private readonly look = new LookActivity();

  /** 0 nothing, 1 a deliberate look or held controls, 2 a fresh key/button press (or a tap). */
  consumeActivity(): 0 | 1 | 2 {
    const sc = this.scripted;
    const held =
      this.down.size > 0 || (sc !== null && (sc.buttons !== 0 || sc.moveX !== 0 || sc.moveZ !== 0));
    const out = activityLevel(this.pressedAny || this.scriptedTaps !== 0, held, this.looked);
    this.pressedAny = false;
    this.looked = false;
    return out;
  }

  /** Pending wheel detents (+ next, - previous). */
  private wheelQueue = 0;
  /** A detent was sent last sample: skip one so the next is a fresh press edge. */
  private wheelSentLast = false;

  /** Call after keybinds change. */
  rebuildBindings(): void {
    this.codeToActions = new Map();
    const binds = this.settings().keybinds;
    for (const [action, codes] of Object.entries(binds) as [Action, [string, string]][]) {
      for (const code of codes) {
        if (!code) continue;
        const list = this.codeToActions.get(code) ?? [];
        list.push(action);
        this.codeToActions.set(code, list);
      }
    }
  }

  /** Capture the next key or mouse button (Escape cancels → null). */
  captureNext(done: (code: string | null) => void): void {
    this.capture = done;
  }

  private finishCapture(code: string | null): void {
    const cb = this.capture;
    this.capture = null;
    cb?.(code);
  }

  /** Request pointer lock with raw (OS-acceleration-free) input where supported. */
  async requestLock(): Promise<void> {
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try {
        await this.canvas.requestPointerLock();
      } catch {
        // user gesture missing or denied; they can click again
      }
    }
  }

  private onMove(e: MouseEvent): void {
    if (!this.locked) return;
    const { movementX: dx, movementY: dy } = e;
    // Some browsers emit a bogus huge delta when the lock engages.
    if (Math.abs(dx) > 1500 || Math.abs(dy) > 1500) return;
    if (this.modal?.look(dx, dy)) return;
    const s = this.settings();
    const degPerCount = DEG_PER_COUNT * s.sensitivity * this.zoomSensScale();
    const yawDeg = dx * degPerCount;
    const pitchDeg = dy * degPerCount * (s.invertY ? 1 : -1);
    this.yaw -= (yawDeg * Math.PI) / 180;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + (pitchDeg * Math.PI) / 180));
    this.lookDx += yawDeg;
    this.lookDy += pitchDeg;
    if (dx !== 0 || dy !== 0) this.lastLookMs = performance.now();
    if (this.look.add(Math.abs(dx) + Math.abs(dy), performance.now())) this.looked = true;
  }

  private onKey(e: KeyboardEvent, isDown: boolean): void {
    if (this.capture && isDown) {
      e.preventDefault();
      this.finishCapture(e.code === 'Escape' ? null : e.code);
      return;
    }
    if (this.modal?.key(e.code, isDown, e)) {
      // A consumed release still lets go of whatever that key holds (a quick-chat key rebound
      // to a digit, a weapon key released while the scoreboard is up): nothing stays stuck down.
      if (!isDown) this.press(e.code, false);
      return;
    }
    if (!this.locked) return;
    if (this.codeToActions.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (isDown) this.pressedAny = true;
    this.press(e.code, isDown);
  }

  private press(code: string, isDown: boolean): void {
    const actions = this.codeToActions.get(code);
    if (!actions) return;
    const s = this.settings();
    for (const action of actions) {
      if (isDown) {
        if (!this.down.has(action)) {
          if (action === 'sprint') this.sprintPressed(s.sprintMode === 'toggle');
          if (action === 'crouch' && s.crouchMode === 'toggle')
            this.toggles.crouch = !this.toggles.crouch;
          if (action === 'ads' && s.adsMode === 'toggle') this.toggles.ads = !this.toggles.ads;
          // Crouch on the run keeps a sprint toggle going (Sprint + Crouch = low run); from a
          // standstill or walk it cancels the toggle as before.
          if (action === 'crouch' && !this.down.has('forward')) this.toggles.sprint = false;
          if (action === 'sprint') this.toggles.crouch = false; // and sprint stands you up
          // So does Jump (a toggled slide cancels into a jump, not a mid-air crouch).
          if (action === 'jump') this.toggles.crouch = false;
        }
        if (!this.down.has(action)) this.presses.add(action);
        this.down.add(action);
        this.latched.add(action);
      } else {
        this.down.delete(action);
      }
    }
  }

  /**
   * A Sprint press: a double tap (hold sprint) or a press while a toggled sprint runs forward
   * (toggle sprint, which then stays on) asks for a tactical sprint (`Button.TacSprint`, latched
   * for one sample); the sim decides whether a burst can start.
   */
  private sprintPressed(toggle: boolean, now = performance.now()): void {
    if (toggle) {
      if (this.toggles.sprint && this.down.has('forward')) this.tacLatched = true;
      else this.toggles.sprint = !this.toggles.sprint;
    } else if (now - this.lastSprintPress <= TAC_SPRINT.doubleTapWindow * 1000) {
      this.tacLatched = true;
    }
    this.lastSprintPress = now;
  }

  /** Let go of everything held (the chat box opened: nothing keeps walking or firing). */
  release(): void {
    this.releaseAll();
  }

  /** The key bound to an action (its first slot), for hints. */
  keyFor(action: Action): string {
    const [a, b] = this.settings().keybinds[action];
    return a || b;
  }

  private releaseAll(): void {
    this.down.clear();
    this.latched.clear();
    this.presses.clear();
    this.tacLatched = false;
  }

  /** A presentation-only action held right now (the scoreboard); never reaches the sim. */
  held(action: Action): boolean {
    return this.locked && this.down.has(action);
  }

  /** Presses of presentation-only actions (Inspect) since the last call; never reach the sim. */
  private readonly presses = new Set<Action>();
  consumePress(action: Action): boolean {
    const had = this.presses.has(action);
    this.presses.delete(action);
    return had;
  }

  consumeLookDelta(): { dx: number; dy: number } {
    const d = { dx: this.lookDx, dy: this.lookDy };
    this.lookDx = 0;
    this.lookDy = 0;
    return d;
  }

  /** Build the input for one sim step. */
  sample(seq: number): PlayerInput {
    if (this.scripted) {
      const buttons = this.scripted.buttons | this.scriptedTaps;
      this.scriptedTaps = 0;
      return { seq, yaw: this.yaw, pitch: this.pitch, ...this.scripted, buttons };
    }
    const active = (a: Action): boolean => this.down.has(a) || this.latched.has(a);
    const s = this.settings();
    const moveZ = (active('forward') ? 1 : 0) - (active('back') ? 1 : 0);
    const moveX = (active('right') ? 1 : 0) - (active('left') ? 1 : 0);
    // A sprint toggle ends when you stop moving forward (standard behaviour).
    if (moveZ <= 0) this.toggles.sprint = false;

    let buttons = 0;
    if (active('jump')) buttons |= Button.Jump;
    if (active('fire')) buttons |= Button.Fire;
    if (active('reload')) buttons |= Button.Reload;
    if (active('melee')) buttons |= Button.Melee;
    if (active('block')) buttons |= Button.Block;
    if (active('grenade')) buttons |= Button.Grenade;
    if (active('radar')) buttons |= Button.Radar;
    if (active('smoke')) buttons |= Button.Smoke;
    if (active('jammer')) buttons |= Button.Jammer;
    if (active('drone')) buttons |= Button.Drone;
    if (active('primary')) buttons |= Button.Slot1;
    if (active('secondary')) buttons |= Button.Slot2;
    if (active('knife')) buttons |= Button.Slot3;
    if (!this.wheelSentLast && this.wheelQueue !== 0) {
      buttons |= this.wheelQueue > 0 ? Button.NextWeapon : Button.PrevWeapon;
      this.wheelQueue -= Math.sign(this.wheelQueue);
      this.wheelSentLast = true;
    } else {
      this.wheelSentLast = false;
    }
    if (s.sprintMode === 'toggle' ? this.toggles.sprint : active('sprint'))
      buttons |= Button.Sprint;
    if (s.crouchMode === 'toggle' ? this.toggles.crouch : active('crouch'))
      buttons |= Button.Crouch;
    if (s.adsMode === 'toggle' ? this.toggles.ads : active('ads')) buttons |= Button.Ads;
    if (active('prone')) buttons |= Button.Prone;
    if (active('interact')) buttons |= Button.Interact;
    if (active('switchSeat')) buttons |= Button.SwitchSeat;
    if (this.tacLatched) buttons |= Button.TacSprint;
    this.tacLatched = false;

    const len = Math.hypot(moveX, moveZ) || 1;
    this.latched.clear();
    return {
      seq,
      moveX: moveX / len,
      moveZ: moveZ / len,
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
    };
  }
}
