import type { NetStats } from './onlineSession.ts';

export type NetLevel = 'good' | 'fair' | 'poor';

export interface NetIndicator {
  /** The ping readout, e.g. "42 ms" ("— ms" until measured). */
  ping: string;
  level: NetLevel;
  /** A short warning when the link itself is the problem, else null. */
  warning: string | null;
}

/** No snapshot for this long (ms): the link is stalling right now. */
export const STALL_NOW_MS = 250;
/** This many arrival gaps (> 150 ms) within 10 s: the link keeps stalling. */
export const STALLS_UNSTABLE = 3;
/** A frame this long (ms) means the page itself is hitching (messages wait for it). */
export const PAGE_HITCH_MS = 120;

/**
 * What the HUD's network indicator says (pure). Ping colour: < 80 ms good, < 150 fair, else
 * poor. The warning names the network (not the game) when snapshots stop arriving now, keep
 * stalling, or jitter has pushed the interpolation buffer far up — so players know a hitch or
 * a slowed-down enemy is the connection. `pageHitchMs` = the longest frame in the last 10 s
 * (the stall window): messages are
 * only read between frames, so while the page itself hitches (≥ `PAGE_HITCH_MS`) late arrivals
 * are not blamed on the network (a live silence still is, once it outlasts the hitch).
 */
export function netIndicator(s: NetStats, pageHitchMs = 0): NetIndicator {
  const ping = s.rttMs >= 0 ? `${Math.round(s.rttMs)} ms` : '— ms';
  let level: NetLevel = s.rttMs < 0 || s.rttMs < 80 ? 'good' : s.rttMs < 150 ? 'fair' : 'poor';
  let warning: string | null = null;
  const hitching = pageHitchMs >= PAGE_HITCH_MS;
  if (s.silenceMs >= Math.max(STALL_NOW_MS, pageHitchMs + 100)) {
    warning = 'NETWORK STALL';
    level = 'poor';
  } else if (hitching) {
    // The page, not the link: say nothing about the network.
  } else if (s.stalls >= STALLS_UNSTABLE || s.delayMs >= 180) {
    warning = 'UNSTABLE CONNECTION';
    if (level === 'good') level = 'fair';
  } else if (s.jitterMs >= 25 || s.stalls > 0) {
    warning = 'JITTER';
    if (level === 'good') level = 'fair';
  }
  return { ping, level, warning };
}
