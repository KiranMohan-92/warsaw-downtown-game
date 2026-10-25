import { lerpAngle, type PlayerAction } from '@wd/shared';
import type { RemotePose } from '../net/interpolation.ts';

/** How often a pose is kept (server ms): 40 Hz is smooth after interpolation and cheap. */
export const REPLAY_INTERVAL_MS = 25;
/** Poses kept per player: 160 × 25 ms = 4 s, more than a kill cam replays. */
export const REPLAY_CAPACITY = 160;

/** A fresh, zeroed pose (owned by a ring slot or a replay output; mutated in place). */
export function blankPose(): RemotePose {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    eye: 1.62,
    f: 0,
    hp: 100,
    life: 0,
    sl: 0,
    primary: 'ar7',
    action: { kind: 'none', v: 0, t: 0 },
  };
}

function copyAction(out: PlayerAction, a: PlayerAction): void {
  out.kind = a.kind;
  out.v = a.v;
  out.t = a.t;
}

export function copyPose(out: RemotePose, p: RemotePose): RemotePose {
  out.x = p.x;
  out.y = p.y;
  out.z = p.z;
  out.yaw = p.yaw;
  out.pitch = p.pitch;
  out.eye = p.eye;
  out.f = p.f;
  out.hp = p.hp;
  out.life = p.life;
  out.sl = p.sl;
  out.primary = p.primary;
  copyAction(out.action, p.action);
  return out;
}

/**
 * One player's recent poses for the kill cam: a fixed ring of pose slots written in place (no
 * per-frame garbage), timestamped in server ms, sampled back by time. Times only move forward; a
 * pose older than the newest kept is dropped, and poses closer than `interval` are thinned.
 * `freeze(t)` stops recording after `t` (the replay window is complete; nothing it needs is
 * overwritten while it plays).
 */
export class PoseRing {
  /** Whose poses these are (a ring is reused for whoever takes the slot next). */
  id = '';
  private readonly times: Float64Array;
  private readonly poses: RemotePose[];
  private head = 0;
  private size = 0;
  private frozenAfter = Number.POSITIVE_INFINITY;

  constructor(
    readonly capacity = REPLAY_CAPACITY,
    private readonly interval = REPLAY_INTERVAL_MS,
  ) {
    this.times = new Float64Array(capacity);
    this.poses = Array.from({ length: capacity }, blankPose);
  }

  get count(): number {
    return this.size;
  }

  /** Oldest / newest kept time (NaN when empty). */
  get oldest(): number {
    return this.size ? this.times[this.index(0)]! : Number.NaN;
  }

  get newest(): number {
    return this.size ? this.times[this.index(this.size - 1)]! : Number.NaN;
  }

  /** Drop every pose (a freeze stays: a new occupant mid-replay records nothing newer either). */
  clear(id = this.id): void {
    this.id = id;
    this.head = 0;
    this.size = 0;
  }

  /** Keep nothing newer than `t` until `unfreeze`. */
  freeze(t: number): void {
    this.frozenAfter = t;
  }

  unfreeze(): void {
    this.frozenAfter = Number.POSITIVE_INFINITY;
  }

  /** The i-th kept pose, oldest first. */
  private index(i: number): number {
    return (this.head + i) % this.capacity;
  }

  /** Record `pose` at server time `t` (ms). Returns whether it was kept. */
  push(t: number, pose: RemotePose): boolean {
    if (!Number.isFinite(t) || t > this.frozenAfter) return false;
    if (this.size && t < this.newest + this.interval) return false;
    let slot: number;
    if (this.size < this.capacity) {
      slot = this.index(this.size);
      this.size++;
    } else {
      // Full: the oldest slot becomes the newest.
      slot = this.head;
      this.head = (this.head + 1) % this.capacity;
    }
    this.times[slot] = t;
    copyPose(this.poses[slot]!, pose);
    return true;
  }

  /**
   * The pose at server time `t` into `out`: blended between the two kept poses around it
   * (position, eye, pitch linearly; yaw by the short arc; an action's progress within one
   * action), the discrete fields (flags, weapon, health, action kind) from the nearer one.
   * Across a life change (a respawn) nothing blends: the old life holds until the new pose's
   * time, like `SnapshotBuffer.sample`. Before the oldest or after the newest it holds the end
   * pose. False when empty.
   */
  sample(t: number, out: RemotePose): boolean {
    const n = this.size;
    if (!n) return false;
    if (t <= this.oldest || n === 1) {
      copyPose(out, this.poses[this.index(0)]!);
      return true;
    }
    if (t >= this.newest) {
      copyPose(out, this.poses[this.index(n - 1)]!);
      return true;
    }
    // Binary search for the last kept time ≤ t.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[this.index(mid)]! <= t) lo = mid;
      else hi = mid;
    }
    const ia = this.index(lo);
    const ib = this.index(hi);
    const ta = this.times[ia]!;
    const tb = this.times[ib]!;
    const k = tb > ta ? (t - ta) / (tb - ta) : 0;
    const a = this.poses[ia]!;
    const b = this.poses[ib]!;
    if (a.life !== b.life) {
      // A respawn between the two: never blend a corpse into the new spawn (it would slide
      // through the map). The old life holds until the new one's own timestamp.
      copyPose(out, a);
      return true;
    }
    copyPose(out, k < 0.5 ? a : b);
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.eye = a.eye + (b.eye - a.eye) * k;
    out.pitch = a.pitch + (b.pitch - a.pitch) * k;
    out.yaw = lerpAngle(a.yaw, b.yaw, k);
    if (a.action.kind === b.action.kind && a.action.v === b.action.v) {
      out.action.t = a.action.t + (b.action.t - a.action.t) * k;
    }
    return true;
  }
}

/**
 * Every player's ring for the kill cam: one per match slot (reused by whoever holds the slot)
 * and one for the local player, whose own soldier plays the victim in the replay.
 */
export class ReplayRecorder {
  readonly remotes: PoseRing[];
  readonly self = new PoseRing();

  constructor(slots: number) {
    this.remotes = Array.from({ length: slots }, () => new PoseRing());
  }

  /** Record a remote player's pose (a new occupant of the slot starts a fresh ring). */
  recordRemote(slot: number, id: string, t: number, pose: RemotePose): void {
    const ring = this.remotes[slot];
    if (!ring) return;
    if (ring.id !== id) ring.clear(id);
    ring.push(t, pose);
  }

  /** The ring holding `id`'s poses, if any. */
  ringOf(id: string): PoseRing | null {
    for (const r of this.remotes) if (r.id === id && r.count) return r;
    return null;
  }

  /** Stop keeping anything after `t` (the replay window is complete). */
  freeze(t: number): void {
    for (const r of this.remotes) r.freeze(t);
    this.self.freeze(t);
  }

  unfreeze(): void {
    for (const r of this.remotes) r.unfreeze();
    this.self.unfreeze();
  }
}
