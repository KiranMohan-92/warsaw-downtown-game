import { humanoidHitboxes, lerpAngle, MATCH_NET, type HitShape, type Vec3 } from '@wd/shared';

/** Where a player was at one server time (what their hit volumes are built from). */
export interface Pose {
  /** Server time (ms): tick × 1/60 s, the timeline snapshots and view times use. */
  ms: number;
  feet: Vec3;
  eye: number;
  /** Facing (prone hit volumes lie along it). */
  yaw?: number;
  life: number;
  alive: boolean;
  /** In a truck's cab (its glass weakens rounds): rewound with the pose, not read live. */
  cab?: boolean;
}

/**
 * A player's recent poses, one per server tick (the newest last), for lag compensation: the
 * server rebuilds anyone's hit volumes as they were at a past server time. Kept short
 * (`MATCH_NET.historyTicks`, more than the rewind cap) and pure (time is passed in).
 */
export class PoseHistory {
  private readonly poses: Pose[] = [];

  constructor(private readonly capacity: number = MATCH_NET.historyTicks) {}

  get size(): number {
    return this.poses.length;
  }

  record(p: Pose): void {
    const last = this.poses.at(-1);
    if (last && p.ms <= last.ms) this.poses.pop(); // same tick again (or a clock reset)
    this.poses.push({ ...p, feet: { ...p.feet } });
    if (this.poses.length > this.capacity) this.poses.shift();
  }

  clear(): void {
    this.poses.length = 0;
  }

  /**
   * The pose at server time `ms`: blended between the two recorded around it (feet, eye
   * height, facing), the way clients blend snapshots. Never across a respawn (the side of the gap `ms`
   * is on); before the oldest / after the newest it holds the end. Null with no history.
   */
  at(ms: number): Pose | null {
    const h = this.poses;
    const first = h[0];
    if (!first) return null;
    if (ms <= first.ms) return first;
    for (let i = 1; i < h.length; i++) {
      const b = h[i]!;
      if (ms > b.ms) continue;
      const a = h[i - 1]!;
      if (a.life !== b.life) return ms >= b.ms ? b : a;
      if (a.alive !== b.alive) return ms - a.ms < b.ms - ms ? a : b;
      const k = (ms - a.ms) / (b.ms - a.ms);
      const lerp = (x: number, y: number): number => x + (y - x) * k;
      return {
        ms,
        feet: {
          x: lerp(a.feet.x, b.feet.x),
          y: lerp(a.feet.y, b.feet.y),
          z: lerp(a.feet.z, b.feet.z),
        },
        eye: lerp(a.eye, b.eye),
        // Shortest arc, as clients interpolate it (prone hit volumes lie along the facing).
        yaw: a.yaw !== undefined && b.yaw !== undefined ? lerpAngle(a.yaw, b.yaw, k) : b.yaw,
        life: a.life,
        alive: a.alive,
        // Seated or not is a step, not a blend: the nearer tick's.
        ...((k < 0.5 ? a.cab : b.cab) ? { cab: true } : {}),
      };
    }
    return h.at(-1)!;
  }
}

/**
 * A player's round trip as the server measured it (its own `ping` → the client's `pong`; never a
 * number the client reports), for the rewind cap. Two views of the last `rttWindow` samples:
 *
 * - `smoothed`: an EWMA (¼ per sample), for the HUD badge.
 * - `forRewind`: their 90th percentile (the largest sample is left out once there are two). A
 *   percentile rather than the EWMA because one spike moves an EWMA by a quarter of its size for
 *   seconds (a 1 s hiccup would add 250 ms of rewind), while a real rise in ping shows in the
 *   percentile within two samples and ordinary jitter is covered. A client can only make its
 *   round trip look *longer* (by sitting on pongs), which the absolute ceiling bounds.
 */
export class RttEstimate {
  private readonly samples: number[] = [];
  smoothed: number | null = null;

  constructor(private readonly window: number = MATCH_NET.rttWindow) {}

  /** A round-trip sample (ms); implausible ones are ignored. */
  observe(sampleMs: number): void {
    if (!Number.isFinite(sampleMs) || sampleMs < 0 || sampleMs > 5000) return;
    this.smoothed =
      this.smoothed === null ? sampleMs : this.smoothed + (sampleMs - this.smoothed) * 0.25;
    this.samples.push(sampleMs);
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** The round trip the rewind cap grants (ms), null until measured. */
  get forRewind(): number | null {
    const n = this.samples.length;
    if (n === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(0.9 * (n - 1))]!;
  }
}

/**
 * The pings the server sent one player and has not had echoed yet. A `pong` only counts as a
 * round-trip sample if it echoes the exact stamp of a ping still outstanding for that player,
 * once: unknown stamps (forged), repeats (replayed) and echoes older than `pongTimeoutMs` are
 * ignored. The stamp is the server's own high-resolution send time, so it doubles as the nonce
 * (a client can't echo one before receiving it), and the sample is measured against the
 * server's clock only. What is left to a client is answering late, which only lengthens its
 * measured round trip (bounded by the rewind ceiling). Bounded: at most `maxOutstandingPings`.
 */
export class PingTracker {
  private readonly sent: number[] = [];

  /** The server sends a ping stamped `t` (its clock, ms). */
  issue(t: number): void {
    this.sent.push(t);
    if (this.sent.length > MATCH_NET.maxOutstandingPings) this.sent.shift();
  }

  /** A pong echoing `t` arrived at `nowMs`: the round trip (ms), or null if it doesn't count. */
  consume(t: number, nowMs: number): number | null {
    const i = this.sent.indexOf(t);
    if (i < 0) return null;
    this.sent.splice(i, 1);
    const rtt = nowMs - t;
    return rtt >= 0 && rtt <= MATCH_NET.pongTimeoutMs ? rtt : null;
  }

  get outstanding(): number {
    return this.sent.length;
  }
}

/**
 * How far back this player's shots may be rewound (ms). What an honest client asks for is its
 * interpolation delay + its whole round trip (its server clock follows snapshot arrivals, so it
 * runs one trip behind; the input takes another to arrive) + a little queueing. So the cap is
 *
 *   min(`maxRewindMs`, interpolation delay + server-measured RTT + `rewindMarginMs`)
 *
 * The server can't see a client's jitter buffer, so the interpolation delay is granted up to the
 * buffer's ceiling (`maxInterpDelayMs`): a client claiming more than any buffer draws with gains
 * nothing, and whatever it claims and however long its ping, never more than `maxRewindMs`.
 * Before the first pong the round trip counts as 0.
 */
export function rewindCapMs(rttMs: number | null): number {
  const rtt = rttMs !== null && Number.isFinite(rttMs) ? Math.max(0, rttMs) : 0;
  return Math.min(
    MATCH_NET.maxRewindMs,
    MATCH_NET.maxInterpDelayMs + rtt + MATCH_NET.rewindMarginMs,
  );
}

/**
 * The server time a shot is checked at. The client reports the time it was drawing the others
 * at (`vt`: its server clock − interpolation delay), which is exactly what the shooter saw;
 * without one the server estimates it as its interpolation delay plus the round trip. Either way
 * it is clamped (never rejected) to [now − `rewindCapMs(rtt)`, now]: `rttMs` is the server's own
 * measurement (`RttEstimate.forRewind`), so nobody reaches back further than their cap whatever
 * they report.
 */
export function shotViewTime(
  nowMs: number,
  reportedVt: number | undefined,
  rttMs: number | null,
  capMs: number = rewindCapMs(rttMs),
): number {
  const lag =
    reportedVt !== undefined && Number.isFinite(reportedVt)
      ? nowMs - reportedVt
      : MATCH_NET.interpDelayMs + (rttMs ?? 0);
  return nowMs - Math.max(0, Math.min(capMs, lag));
}

/**
 * Hit volumes of a player rewound to `viewMs`, or null if they can't be hit there: dead then or
 * now, or in another life then (a respawn in between: the body the shooter saw is gone).
 */
export function rewoundShapes(
  history: PoseHistory,
  viewMs: number,
  now: { life: number; alive: boolean },
): HitShape[] | null {
  if (!now.alive) return null;
  const pose = history.at(viewMs);
  if (!pose || !pose.alive || pose.life !== now.life) return null;
  return humanoidHitboxes(pose.feet, pose.eye, pose.yaw ?? 0);
}
