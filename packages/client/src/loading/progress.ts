/**
 * Boot progress model for the loading screen (pure: every method takes `now` in ms, no DOM).
 *
 * Boot is a fixed sequence of named stages, each with a weight (its rough share of a ~22 s
 * load on the reference laptop). A stage's reports move the target within its span; the shown
 * value eases towards the target and, inside a stage that reports nothing for a while (a long
 * download or one big synchronous build), creeps towards 85 % of that stage's span on its own,
 * so the bar keeps moving without ever passing work that has not happened. It only moves
 * forward: a report for an earlier stage, or a lower fraction, is ignored.
 */

export type BootStage = 'script' | 'physics' | 'surfaces' | 'map' | 'assets' | 'setup' | 'shaders';

/** What Game.create reports: the stage now running and, optionally, how far it is (0–1). */
export type BootReporter = (stage: BootStage, done?: number) => void;

/** Where Game.create sends its progress (the loading screen). */
export interface BootSink {
  readonly report: BootReporter;
  /** Replace a stage's words (the map build names the map). */
  setLabel(stage: BootStage, label: string): void;
  /** Resolves once the browser could paint (before a long synchronous build). */
  paint(): Promise<void>;
}

export interface StageDef {
  readonly id: BootStage;
  /** Share of the whole bar (weights are normalised, so only ratios matter). */
  readonly weight: number;
  /** Typical duration (ms): sets how fast an unreported stage creeps. */
  readonly expectMs: number;
  /** Plain words for the player. */
  readonly label: string;
}

/**
 * Stage order and weights, from the boot of the Market on the reference laptop (Intel iGPU):
 * procedural surfaces ~6 s of CPU, the map build (physics, meshes, spawns, HUD) ~4–5 s, model
 * and texture downloads/decodes ~4 s, shader warm-up (both tier variants) ~5–6 s. `[boot]` in
 * the console lists the measured stage times of every load, for re-tuning.
 */
export const BOOT_STAGES: readonly StageDef[] = [
  { id: 'script', weight: 4, expectMs: 1500, label: 'Loading game files' },
  { id: 'physics', weight: 3, expectMs: 700, label: 'Starting physics' },
  { id: 'surfaces', weight: 26, expectMs: 6000, label: 'Preparing surfaces' },
  { id: 'map', weight: 20, expectMs: 4500, label: 'Building the map' },
  { id: 'assets', weight: 18, expectMs: 4000, label: 'Loading soldiers, guns and trees' },
  { id: 'setup', weight: 2, expectMs: 400, label: 'Placing props and lights' },
  { id: 'shaders', weight: 27, expectMs: 6000, label: 'Compiling shaders' },
];

/** Plain-words label for the map build ("Building the Market"). */
export function mapStageLabel(map: string, size: string): string {
  if (map === 'range') return 'Building the firing range';
  if (size === 'market') return 'Building the Market';
  if (size === 'north' || size === 'south') return `Building Plac Defilad (${size})`;
  return 'Building Plac Defilad';
}

/** Stage creep never passes this share of an unreported stage. */
const CREEP_MAX = 0.85;
/** Easing time constant of the shown value towards the target (ms). */
const EASE_MS = 250;

export type BootState = 'loading' | 'stalled' | 'error' | 'done';

export class BootProgress {
  private readonly starts: number[] = [];
  private readonly spans: number[] = [];
  private stageIndex = 0;
  /** Reported position (0–1 of the whole bar). */
  private target = 0;
  private shown = 0;
  private lastUpdate: number;
  private stageStart: number;
  private lastReport: number;
  private labelOverride = new Map<BootStage, string>();
  private readonly stageMs = new Map<BootStage, number>();
  state: BootState = 'loading';
  error = '';

  constructor(
    private readonly stages: readonly StageDef[],
    now: number,
  ) {
    const total = stages.reduce((a, s) => a + s.weight, 0);
    let at = 0;
    for (const s of stages) {
      this.starts.push(at);
      this.spans.push(s.weight / total);
      at += s.weight / total;
    }
    this.lastUpdate = now;
    this.stageStart = now;
    this.lastReport = now;
  }

  get stage(): BootStage {
    return this.stages[this.stageIndex]!.id;
  }

  get label(): string {
    if (this.state === 'done') return 'Ready';
    return this.labelOverride.get(this.stage) ?? this.stages[this.stageIndex]!.label;
  }

  /** Replace a stage's words (the map build names the map being built). */
  setLabel(stage: BootStage, label: string): void {
    this.labelOverride.set(stage, label);
  }

  /** `stage` is running and `done` (0–1) of it is finished. Earlier stages/fractions are ignored. */
  report(stage: BootStage, done: number, now: number): void {
    if (this.state === 'done' || this.state === 'error') return;
    const i = this.stages.findIndex((s) => s.id === stage);
    if (i < this.stageIndex) return;
    if (i > this.stageIndex) {
      // Close the stage(s) just left: their measured time, and the bar at least at their end.
      this.stageMs.set(this.stage, now - this.stageStart);
      this.stageIndex = i;
      this.stageStart = now;
    }
    const f = Math.min(1, Math.max(0, Number.isFinite(done) ? done : 0));
    this.target = Math.max(this.target, this.starts[i]! + this.spans[i]! * f);
    this.lastReport = now;
    if (this.state === 'stalled') this.state = 'loading';
  }

  /** Boot finished (warm-up included): the bar fills. */
  complete(now: number): void {
    if (this.state === 'error') return;
    this.stageMs.set(this.stage, now - this.stageStart);
    this.state = 'done';
    this.target = 1;
    this.shown = 1;
  }

  fail(message: string): void {
    if (this.state === 'done') return;
    this.state = 'error';
    this.error = message;
  }

  /**
   * Nothing reported for `timeoutMs`: the load is marked stalled (it keeps going; a later
   * report clears it). Returns true while stalled.
   */
  checkStall(now: number, timeoutMs: number): boolean {
    if (this.state === 'loading' && now - this.lastReport > timeoutMs) this.state = 'stalled';
    return this.state === 'stalled';
  }

  /** Don't count a wait on the player (the friend lobby) as a stall. */
  touch(now: number): void {
    this.lastReport = now;
    this.lastUpdate = now;
  }

  /** The value to draw now (0–1): eased, creeping inside a quiet stage, never lower than before. */
  value(now: number): number {
    if (this.state === 'done') return 1;
    const i = this.stageIndex;
    const s = this.stages[i]!;
    const creep = CREEP_MAX * (1 - Math.exp(-(now - this.stageStart) / Math.max(1, s.expectMs)));
    const goal = Math.max(this.target, this.starts[i]! + this.spans[i]! * creep);
    const dt = Math.max(0, now - this.lastUpdate);
    this.lastUpdate = now;
    this.shown += (goal - this.shown) * (1 - Math.exp(-dt / EASE_MS));
    this.shown = Math.min(1, Math.max(this.shown, 0));
    return this.shown;
  }

  /** Measured time of every finished stage (ms), for the console and re-tuning the weights. */
  timings(): ReadonlyMap<BootStage, number> {
    return this.stageMs;
  }
}
