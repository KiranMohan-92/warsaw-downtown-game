import type { PlayerEvent } from '@wd/shared';
import { rewindCapMs } from '../match/lagComp.ts';
import type { MatchSim, ServerPlayer } from '../match/MatchSim.ts';
import { Reservoir } from './stats.ts';

type CollectIntents = (
  p: ServerPlayer,
  events: readonly PlayerEvent[],
  vt: number | undefined,
  out: unknown[],
) => void;

/**
 * Server-side ground truth for lag compensation: for every shot a human fires, how far back the
 * shooter's reported view time is when the server applies it (server now − `vt`), and how often
 * that exceeds the player's rewind cap (`lagComp.rewindCapMs`, then the server checks the shot later
 * than the shooter saw: moving targets are displaced by speed × the excess). Test tooling only:
 * it wraps `MatchSim`'s (private) per-step intent collection, on an instance or the prototype.
 */
export class RewindProbe {
  readonly lagMs = new Reservoir();
  shots = 0;
  clamped = 0;

  /** Watch one sim (`install(sim)`) or every sim of this process (`install(MatchSim.prototype)`). */
  install(target: MatchSim): void {
    const t = target as unknown as { collectIntents: CollectIntents };
    const original = t.collectIntents;
    const onShot = (lag: number, cap: number): void => {
      this.shots++;
      this.lagMs.push(lag);
      if (lag > cap) this.clamped++;
    };
    t.collectIntents = function (this: MatchSim, p, events, vt, out) {
      if (!p.bot && vt !== undefined && events.some((e) => e.type === 'shot')) {
        onShot(this.nowMs - vt, rewindCapMs(p.ping.forRewind ?? p.rtt));
      }
      original.call(this, p, events, vt, out);
    };
  }
}
