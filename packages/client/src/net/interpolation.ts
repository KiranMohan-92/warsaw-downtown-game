import {
  lerpAction,
  lerpAngle,
  MATCH_NET,
  SIM,
  snapshotAction,
  snapshotPrimary,
  type PlayerAction,
  type PrimaryId,
  type SnapshotPlayer,
} from '@wd/shared';

/** A remote player's pose at one instant (what the renderer draws). */
export interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  eye: number;
  /** `SnapFlag` bits of the nearer sample (discrete: never blended). */
  f: number;
  hp: number;
  life: number;
  /** Weapon in hand (`SNAP_SLOTS` index) and this life's primary: what their soldier holds. */
  sl: number;
  primary: PrimaryId;
  /** What their hands are doing (reload, throw, strike, guard, stun), progress blended. */
  action: PlayerAction;
  /** In a vehicle: its seat on the wire (`seatFromWire`), from the nearer sample. */
  vh?: number;
}

interface Entry {
  /** Server time of the snapshot (ms). */
  t: number;
  s: SnapshotPlayer;
}

/** Shortest-arc blend between two angles (shared: the server rewinds facing the same way). */
export { lerpAngle };

const pose = (s: SnapshotPlayer): RemotePose => ({
  x: s.x,
  y: s.y,
  z: s.z,
  yaw: s.yaw,
  pitch: s.pitch,
  eye: s.eye,
  f: s.f,
  hp: s.hp,
  life: s.life,
  sl: s.sl,
  primary: snapshotPrimary(s),
  action: snapshotAction(s),
  ...(s.vh !== undefined ? { vh: s.vh } : {}),
});

/** How a pose was sampled (filled in by `SnapshotBuffer.sample`). */
export interface SampleInfo {
  /** Past the newest snapshot by this long (ms; 0 = between two real states, or before them). */
  pastNewestMs: number;
}

const finiteOr0 = (v: number): number => (Number.isFinite(v) ? v : 0);

/**
 * One remote player's recent snapshots, sampled at a render time in the past (the caller passes
 * "server now − interpolation delay"), so there are normally two real states to blend between.
 * Pure: time is always passed in.
 */
export class SnapshotBuffer {
  private entries: Entry[] = [];

  /**
   * Keep at most `capacity` snapshots (≈1 s at 30 Hz). Past the newest snapshot the player keeps
   * moving on its last velocity for at most `extrapolateMs`, then holds (0: always hold).
   */
  constructor(
    private readonly capacity = 32,
    private readonly extrapolateMs = 0,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  /** The newest snapshot and its server time (ms), if any. */
  newest(): Readonly<Entry> | undefined {
    return this.entries.at(-1);
  }

  /** Add a snapshot taken at server time `t` (ms). Out-of-order or duplicate ones are ignored. */
  push(t: number, s: SnapshotPlayer): void {
    const last = this.entries.at(-1);
    if (last && t <= last.t) return;
    this.entries.push({ t, s });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /**
   * The pose at server time `t`. Between two snapshots: blended (position, eye height, angles on
   * the short arc). Across a respawn (`life` changed) it never blends: it shows the old life
   * until the new one's first snapshot, then snaps. Before the oldest it holds the oldest. Past
   * the newest (a late packet, a stall) it moves the position along the newest snapshot's
   * velocity for at most `extrapolateMs`, then holds there: a short guess beats a freeze, a long
   * one would run players through walls. The dead are never extrapolated; neither is a fall
   * (a guessed drop would sink players into the ground).
   */
  sample(t: number, info?: SampleInfo): RemotePose | null {
    const e = this.entries;
    const first = e[0];
    if (info) info.pastNewestMs = 0;
    if (!first) return null;
    if (t <= first.t) return pose(first.s);
    for (let i = 1; i < e.length; i++) {
      const b = e[i]!;
      if (t > b.t) continue;
      const a = e[i - 1]!;
      if (a.s.life !== b.s.life) return pose(t >= b.t ? b.s : a.s);
      const k = (t - a.t) / (b.t - a.t);
      const lerp = (x: number, y: number): number => x + (y - x) * k;
      return {
        x: lerp(a.s.x, b.s.x),
        y: lerp(a.s.y, b.s.y),
        z: lerp(a.s.z, b.s.z),
        yaw: lerpAngle(a.s.yaw, b.s.yaw, k),
        pitch: lerp(a.s.pitch, b.s.pitch),
        eye: lerp(a.s.eye, b.s.eye),
        f: (k < 0.5 ? a : b).s.f,
        hp: (k < 0.5 ? a : b).s.hp,
        life: a.s.life,
        sl: (k < 0.5 ? a : b).s.sl,
        primary: snapshotPrimary(a.s),
        action: lerpAction(snapshotAction(a.s), snapshotAction(b.s), k),
        ...((k < 0.5 ? a : b).s.vh !== undefined ? { vh: (k < 0.5 ? a : b).s.vh } : {}),
      };
    }
    const newest = e.at(-1)!;
    const past = t - newest.t;
    if (info) info.pastNewestMs = past;
    const p = pose(newest.s);
    const ahead = Math.min(past, this.extrapolateMs) / 1000;
    if (ahead > 0 && newest.s.hp > 0) {
      p.x += finiteOr0(newest.s.vx) * ahead;
      p.z += finiteOr0(newest.s.vz) * ahead;
      p.y += Math.max(0, finiteOr0(newest.s.vy)) * ahead;
    }
    return p;
  }

  /** Drop snapshots no longer needed for times ≥ `t` (keeps the one just before `t`). */
  prune(t: number): void {
    let keepFrom = 0;
    for (let i = 0; i < this.entries.length; i++) if (this.entries[i]!.t <= t) keepFrom = i;
    if (keepFrom > 0) this.entries.splice(0, keepFrom);
  }
}

/**
 * A remote player's buffer plus the blend that hides the jump when data resumes after a stall.
 * While the player was drawn past the newest snapshot (extrapolated or held), a new snapshot
 * changes what that same instant looks like; the difference becomes an offset that decays with
 * time constant `blendMs` (≈ gone in 100–200 ms) instead of a snap. A respawn, or a jump of
 * more than `snapDistance` (6 m: a teleport; a sprinting player held through a ~1 s stall
 * is ~5 m off and still glides), snaps. Pure: time is always passed in.
 */
export class RemoteTrack {
  readonly buffer: SnapshotBuffer;
  private lastT: number | null = null;
  private lastLife: number | null = null;
  private wasPast = false;
  private readonly off = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly info: SampleInfo = { pastNewestMs: 0 };

  constructor(
    extrapolateMs: number,
    private readonly blendMs = 50,
    private readonly snapDistance = 6,
  ) {
    this.buffer = new SnapshotBuffer(32, extrapolateMs);
  }

  /** The blend offset still being smoothed away (m, rad). */
  get offset(): Readonly<{ x: number; y: number; z: number; yaw: number }> {
    return this.off;
  }

  push(t: number, s: SnapshotPlayer): void {
    const at = this.lastT;
    if (at === null || !this.wasPast) {
      this.buffer.push(t, s);
      return;
    }
    const before = this.buffer.sample(at);
    this.buffer.push(t, s);
    const after = this.buffer.sample(at);
    if (!before || !after || before.life !== after.life) return;
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    const dz = before.z - after.z;
    if (Math.hypot(dx + this.off.x, dy + this.off.y, dz + this.off.z) > this.snapDistance) {
      this.clearOffset();
      return;
    }
    this.off.x += dx;
    this.off.y += dy;
    this.off.z += dz;
    this.off.yaw += lerpAngle(after.yaw, before.yaw, 1) - after.yaw;
  }

  private clearOffset(): void {
    this.off.x = this.off.y = this.off.z = this.off.yaw = 0;
  }

  /** The pose to draw at render time `t` (server ms), with any resume blend applied. */
  sample(t: number): RemotePose | null {
    const raw = this.buffer.sample(t, this.info);
    this.wasPast = this.info.pastNewestMs > 0;
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(250, t - this.lastT));
    this.lastT = t;
    if (!raw) return null;
    if (raw.life !== this.lastLife) {
      this.lastLife = raw.life;
      this.clearOffset();
    }
    const k = Math.exp(-dt / this.blendMs);
    this.off.x *= k;
    this.off.y *= k;
    this.off.z *= k;
    this.off.yaw *= k;
    raw.x += this.off.x;
    raw.y += this.off.y;
    raw.z += this.off.z;
    raw.yaw += this.off.yaw;
    return raw;
  }

  prune(t: number): void {
    this.buffer.prune(t);
  }
}

export interface JitterConfig {
  /** Delay floor (ms): what a clean link uses. */
  baseMs: number;
  /** Delay ceiling (ms). */
  maxMs: number;
  /** Nominal snapshot interval (ms). */
  intervalMs: number;
  /** Target delay = interval + `lateGain` × the lateness peak (≈ the p95 of how late snapshots come). */
  lateGain: number;
  /** The lateness peak decays with this time constant (ms): slowly, so a stall leaves a margin. */
  peakDecayMs: number;
  /** The delay rises at most this many ms per ms (< 1: remote time slows, never runs backwards)… */
  riseRate: number;
  /** …and falls at most this many ms per ms (remote time runs slightly fast to drain it). */
  fallRate: number;
  /** A gap between arrivals longer than this counts as a stall (ms; the HUD warns). */
  stallMs: number;
  /** Stalls are remembered this long (ms). */
  stallWindowMs: number;
}

export const JITTER_DEFAULTS: JitterConfig = {
  baseMs: MATCH_NET.interpDelayMs,
  maxMs: MATCH_NET.maxInterpDelayMs,
  intervalMs: (MATCH_NET.snapshotEvery * 1000) / SIM.tickHz,
  lateGain: 1.5,
  peakDecayMs: 4000,
  riseRate: 0.5,
  fallRate: 0.02,
  stallMs: 150,
  stallWindowMs: 10_000,
};

/**
 * Adaptive jitter buffer: how far in the past remote players are drawn. Input: how late each
 * snapshot arrives compared with the fastest path seen (`ServerClock.lateness`); also the spread
 * of arrival intervals (EWMA of |arrival interval − server interval|, RFC 3550 style) for the
 * HUD. Target delay = clamp(base, interval + 1.5 × lateness peak, max): the peak jumps up at
 * once on a late snapshot, grows with the silence *during* a stall, and decays over seconds.
 * The delay in use slews toward the target (rising at ½ ms per ms, falling at 2 %), so the
 * timeline remote players are drawn on never jumps or runs backwards. Pure: time is passed in.
 *
 * Lag compensation stays honest: every input reports the view time actually drawn (server now −
 * this delay), and the server clamps each player's rewind to this buffer's ceiling + the round
 * trip it measured itself + a margin, never past `MATCH_NET.maxRewindMs` (350 ms; see
 * `server/match/lagComp.rewindCapMs`). So what is drawn is what is checked, up to ~60 ms of ping
 * with the buffer at its ceiling and ~200 ms with a clean one; beyond that the shooter has to
 * lead by the excess (the trade: smooth remote players on a stalling link).
 */
export class JitterBuffer {
  private delay: number;
  private peak = 0;
  private jitter = 0;
  private lastLocal: number | null = null;
  private lastServer: number | null = null;
  private lastUpdate: number | null = null;
  private stalls: number[] = [];

  constructor(readonly cfg: JitterConfig = JITTER_DEFAULTS) {
    this.delay = cfg.baseMs;
  }

  /**
   * A snapshot from server time `serverMs` arrived at local time `localMs`, `latenessMs` later
   * than the fastest path seen.
   */
  observe(serverMs: number, localMs: number, latenessMs: number): void {
    this.update(localMs);
    const c = this.cfg;
    if (this.lastLocal !== null && this.lastServer !== null && serverMs > this.lastServer) {
      const gap = localMs - this.lastLocal;
      if (gap > c.stallMs) this.stalls.push(localMs);
      const d = gap - (serverMs - this.lastServer);
      this.jitter += (Math.abs(d) - this.jitter) / 16;
    }
    if (this.lastServer === null || serverMs > this.lastServer) {
      this.lastLocal = localMs;
      this.lastServer = serverMs;
    }
    this.peak = Math.max(this.peak, Math.max(0, latenessMs));
    while (this.stalls.length && this.stalls[0]! < localMs - c.stallWindowMs) this.stalls.shift();
  }

  /** Advance to local time `localMs` (monotonic: earlier times change nothing). */
  update(localMs: number): void {
    const c = this.cfg;
    if (this.lastUpdate === null) {
      this.lastUpdate = localMs;
      return;
    }
    const dt = localMs - this.lastUpdate;
    if (dt <= 0) return;
    this.lastUpdate = localMs;
    this.peak *= Math.exp(-dt / c.peakDecayMs);
    // A silence longer than one interval: the next snapshot is already this late.
    const silence = this.silenceMs(localMs);
    if (silence > c.intervalMs) this.peak = Math.max(this.peak, silence - c.intervalMs);
    const target = this.targetMs;
    if (target > this.delay) this.delay = Math.min(target, this.delay + c.riseRate * dt);
    else this.delay = Math.max(target, this.delay - c.fallRate * dt);
  }

  /** The delay the buffer is heading for (ms). */
  get targetMs(): number {
    const c = this.cfg;
    return Math.min(c.maxMs, Math.max(c.baseMs, c.intervalMs + c.lateGain * this.peak));
  }

  /** The interpolation delay to draw remote players with at local time `localMs` (ms). */
  delayMs(localMs: number): number {
    this.update(localMs);
    return this.delay;
  }

  /** Arrival-interval jitter (ms, EWMA). */
  get jitterMs(): number {
    return this.jitter;
  }

  /** Time since the last snapshot arrived (ms; 0 before the first). */
  silenceMs(localMs: number): number {
    return this.lastLocal === null ? 0 : Math.max(0, localMs - this.lastLocal);
  }

  /** Stalls (arrival gaps longer than `stallMs`) within the last `stallWindowMs`. */
  recentStalls(localMs: number): number {
    return this.stalls.filter((t) => t >= localMs - this.cfg.stallWindowMs).length;
  }

  /** Forget the link's history (reconnect, new welcome): back to the base delay. */
  reset(): void {
    this.delay = this.cfg.baseMs;
    this.peak = 0;
    this.jitter = 0;
    this.lastLocal = this.lastServer = this.lastUpdate = null;
    this.stalls = [];
  }
}

/**
 * Estimates the server clock from snapshot arrivals: offset = server time − local time. Network
 * delay only ever makes a snapshot look older, so the estimate follows the *newest-looking*
 * arrivals quickly and drifts back slowly (jitter doesn't drag the timeline around). A jump of
 * more than `resyncMs` (tab was hidden, server restarted) resets it.
 */
export class ServerClock {
  private offset: number | null = null;

  constructor(
    private readonly slewDown = 0.02,
    private readonly resyncMs = 1000,
  ) {}

  observe(serverMs: number, localMs: number): void {
    const sample = serverMs - localMs;
    if (this.offset === null || Math.abs(sample - this.offset) > this.resyncMs) {
      this.offset = sample;
    } else if (sample > this.offset) {
      this.offset = sample; // an arrival faster than any before: the truest estimate
    } else {
      this.offset += (sample - this.offset) * this.slewDown; // slowly accept a longer path
    }
  }

  get synced(): boolean {
    return this.offset !== null;
  }

  /**
   * How much later than the fastest path seen a snapshot from `serverMs` arriving at `localMs`
   * came (ms, ≥ 0): the jitter buffer's input.
   */
  lateness(serverMs: number, localMs: number): number {
    return this.offset === null ? 0 : Math.max(0, this.offset - (serverMs - localMs));
  }

  /**
   * The server's clock stood still for `ms` of local time (a paused practice match): server
   * time keeps going from where it stopped instead of jumping ahead by the pause.
   */
  shift(ms: number): void {
    if (this.offset !== null && Number.isFinite(ms) && ms > 0) this.offset -= ms;
  }

  /** Server time now (ms), or null before the first snapshot. */
  now(localMs: number): number | null {
    return this.offset === null ? null : localMs + this.offset;
  }
}
