/**
 * The client's side of the props trucks break (server-owned: `server/match/props.ts`).
 *
 * - Physics: every `prop` event is applied to this client's static world at once (a smashed or
 *   knocked prop loses its colliders, a settled one stands where the server says), so movement,
 *   bullets, sight and the driver's prediction meet what the server's world has.
 * - Prediction: the local driver's truck breaks through props as the server's would (the shared
 *   `stepVehicle`); until the server confirms, the props it broke are passed (`passed`). Every
 *   reconcile replay starts afresh (`replay`) and finds them again.
 * - Drawing: tumbling props are drawn from the snapshots' poses on the remote players' timeline;
 *   visible changes come due at their server tick (at once for props this client's truck broke).
 *
 * The client predicts nothing for the props themselves and reports nothing.
 */
import {
  propPoseFromWire,
  SIM_DT,
  type CombatEvent,
  type PhysicsWorld,
  type PropHit,
  type PropPose,
  type Vec3,
  type VehicleProps,
} from '@wd/shared';

const TICK_MS = SIM_DT * 1000;
/** Poses kept per tumbling prop (≈ 0.5 s of snapshots). */
const MAX_SAMPLES = 16;

export type PropEvent = Extract<CombatEvent, { type: 'prop' } | { type: 'propsReset' }>;

/** A visible change for the renderer. */
export type PropShow =
  | { k: 'reset' }
  /** Smashed (debris at `at`) or gone: hide it. */
  | { k: 'hide'; id: number; n: number; at?: Vec3; v?: number; quiet: boolean }
  /** Knocked over: it is drawn from `pose` from now on (debris and a thud at `at`). */
  | { k: 'knock'; id: number; n: number; at?: Vec3; v?: number; quiet: boolean }
  /** At rest: its final pose (drawn there for good). */
  | { k: 'place'; id: number; n: number; pose: PropPose };

interface Due {
  ms: number;
  show: PropShow;
}

export const isPropEvent = (e: CombatEvent): e is PropEvent =>
  e.type === 'prop' || e.type === 'propsReset';

export class PropSync implements VehicleProps {
  /** The world events are applied to (null: not built yet; events then only queue visuals). */
  physics: PhysicsWorld | null = null;
  /** Props the local truck broke in this prediction (passed until a replay). */
  private readonly predicted = new Set<number>();
  /** Props this client's truck broke: shown at once, drawn at their newest pose. */
  private readonly own = new Set<number>();
  /** Tumbling props' poses by server time (ms). */
  /** Each tumble's poses by server time (ms), per prop and knock number (`trackKey`). */
  private readonly tracks = new Map<string, { ms: number; pose: PropPose }[]>();
  /**
   * The knock each prop is drawn from: a new one takes over only when it comes due on the draw
   * timeline (until then the older tumble keeps playing out), and only its own settle ends it.
   */
  private readonly drawn = new Map<number, number>();
  private due: Due[] = [];

  passed(id: number): boolean {
    return this.predicted.has(id);
  }

  hit(h: PropHit): void {
    for (const id of [h.id, ...h.carried]) {
      this.predicted.add(id);
      this.own.add(id);
    }
  }

  /** A reconcile replays from the server's state: the props it broke are found again. */
  replay(): void {
    this.predicted.clear();
  }

  /** A server event (validated: untrusted wire data). */
  apply(e: PropEvent): void {
    const w = this.physics;
    if (e.type === 'propsReset') {
      w?.resetProps();
      this.predicted.clear();
      this.own.clear();
      this.tracks.clear();
      this.drawn.clear();
      this.due = [{ ms: Number.NEGATIVE_INFINITY, show: { k: 'reset' } }];
      return;
    }
    const id = e.id;
    if (!Number.isInteger(id) || id < 0 || (w && id >= w.propCount)) return;
    const ms = Number.isFinite(e.tick) ? e.tick * TICK_MS : Number.NEGATIVE_INFINITY;
    const at = validVec(e.at);
    const v = Number.isFinite(e.v) ? e.v : undefined;
    const quiet = e.quiet === true;
    const n = Number.isInteger(e.n) ? e.n! : 0;
    const key = trackKey(id, n);
    switch (e.k) {
      case 'smash':
      case 'gone':
        w?.removeProp(id);
        this.queue(ms, { k: 'hide', id, n, at, v, quiet }, id);
        return;
      case 'knock': {
        w?.removeProp(id);
        if (!this.tracks.has(key)) this.tracks.set(key, []);
        this.queue(ms, { k: 'knock', id, n, at, v, quiet }, id);
        return;
      }
      case 'settle': {
        const pose = propPoseFromWire(e.p);
        if (!pose) return;
        if (w) {
          w.placeProp(id, pose);
          w.refreshQueries();
        }
        // Standing again: a truck meets it again.
        this.predicted.delete(id);
        const track = this.tracks.get(key);
        if (track) push(track, ms, pose);
        this.queue(ms, { k: 'place', id, n, pose }, id);
        return;
      }
      default:
        return;
    }
  }

  private queue(ms: number, show: PropShow, id: number): void {
    // This client's own truck broke it: no reason to wait for the remote timeline.
    this.due.push({ ms: this.own.has(id) ? Number.NEGATIVE_INFINITY : ms, show });
  }

  /** A snapshot's tumbling props (server time `serverMs`). */
  snapshot(serverMs: number, props: readonly (readonly number[])[] | undefined): void {
    const raw: unknown = props;
    if (!props || !Array.isArray(raw)) return;
    for (const p of props) {
      const id = p?.[0];
      const pose = propPoseFromWire(p, 2);
      if (!pose || !Number.isInteger(id) || !Number.isInteger(p[1])) continue;
      const track = this.tracks.get(trackKey(id!, p[1]!));
      if (track) push(track, serverMs, pose);
    }
  }

  /** The visible changes due by draw time `drawMs`, in order. */
  takeDue(drawMs: number): PropShow[] {
    if (!this.due.length) return [];
    const out: PropShow[] = [];
    const keep: Due[] = [];
    for (const d of this.due) {
      // In order: nothing overtakes an earlier change of the same prop.
      if (d.ms <= drawMs && !keep.some((k) => sameProp(k.show, d.show))) out.push(d.show);
      else keep.push(d);
    }
    this.due = keep;
    for (const s of out) {
      if (s.k === 'knock') {
        // Its tumble takes over now; older ones (already settled on this timeline) are done.
        this.drawn.set(s.id, s.n);
        for (const k of [...this.tracks.keys()])
          if (k.startsWith(`${s.id}:`) && Number(k.slice(k.indexOf(':') + 1)) < s.n)
            this.tracks.delete(k);
      } else if (s.k === 'place' || s.k === 'hide') {
        // A change retires only its own tumble.
        this.tracks.delete(trackKey(s.id, s.n));
        if (this.drawn.get(s.id) === s.n) this.drawn.delete(s.id);
      }
    }
    return out;
  }

  /** The props being drawn tumbling now. */
  tumbling(): IterableIterator<number> {
    return this.drawn.keys();
  }

  /** A tumbling prop's pose at draw time `drawMs` (its newest for this client's own). */
  pose(id: number, drawMs: number, out: PropPose): boolean {
    const n = this.drawn.get(id);
    const track = n === undefined ? undefined : this.tracks.get(trackKey(id, n));
    if (!track?.length) return false;
    const t = this.own.has(id) ? Number.POSITIVE_INFINITY : drawMs;
    // Not knocked yet on this timeline: it still stands as drawn.
    if (t < track[0]!.ms - 2 * TICK_MS) return false;
    let i = 0;
    while (i < track.length - 1 && track[i + 1]!.ms <= t) i++;
    const a = track[i]!;
    const b = track[i + 1];
    if (!b || t <= a.ms) {
      copyPose(t <= a.ms ? a.pose : (b ?? a).pose, out);
      return true;
    }
    const k = Math.min(1, (t - a.ms) / (b.ms - a.ms));
    lerpPose(a.pose, b.pose, k, out);
    return true;
  }
}

const trackKey = (id: number, n: number): string => `${id}:${n}`;

const sameProp = (a: PropShow, b: PropShow): boolean =>
  a.k !== 'reset' && b.k !== 'reset' && a.id === b.id;

function validVec(v: Vec3 | undefined): Vec3 | undefined {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    ? { x: v.x, y: v.y, z: v.z }
    : undefined;
}

function push(track: { ms: number; pose: PropPose }[], ms: number, pose: PropPose): void {
  const last = track.at(-1);
  if (last && ms <= last.ms) return; // late or repeated
  track.push({ ms, pose });
  if (track.length > MAX_SAMPLES) track.shift();
}

function copyPose(p: PropPose, out: PropPose): void {
  out.pos.x = p.pos.x;
  out.pos.y = p.pos.y;
  out.pos.z = p.pos.z;
  out.quat.x = p.quat.x;
  out.quat.y = p.quat.y;
  out.quat.z = p.quat.z;
  out.quat.w = p.quat.w;
}

/** Position lerp, rotation nlerp along the short arc (snapshots are 33 ms apart). */
function lerpPose(a: PropPose, b: PropPose, k: number, out: PropPose): void {
  out.pos.x = a.pos.x + (b.pos.x - a.pos.x) * k;
  out.pos.y = a.pos.y + (b.pos.y - a.pos.y) * k;
  out.pos.z = a.pos.z + (b.pos.z - a.pos.z) * k;
  const qa = a.quat;
  let qb = b.quat;
  if (qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w < 0)
    qb = { x: -qb.x, y: -qb.y, z: -qb.z, w: -qb.w };
  const x = qa.x + (qb.x - qa.x) * k;
  const y = qa.y + (qb.y - qa.y) * k;
  const z = qa.z + (qb.z - qa.z) * k;
  const w = qa.w + (qb.w - qa.w) * k;
  const l = Math.hypot(x, y, z, w) || 1;
  out.quat.x = x / l;
  out.quat.y = y / l;
  out.quat.z = z / l;
  out.quat.w = w / l;
}
