import { parseArgs } from 'node:util';
import { MATCH, MATCH_NET, parseMatchOptions, type MatchSettings } from '@wd/shared';
import type { LinkProfile } from './delayLine.ts';

/** A soak run's validated command line. */
export interface SoakArgs {
  clients: number;
  /** One-way delay / jitter (ms) and loss (0–1), as the link profile for both directions. */
  link: LinkProfile;
  bots: number;
  seed: number;
  /** Seconds to play (`--full`: the match's time limit). */
  seconds: number;
  full: boolean;
  quick: boolean;
  virtual: boolean;
  /** An external server to test (`--server host:port`), else one is forked. */
  server: { host: string; port: number } | undefined;
  json: string | undefined;
  /** The friend lobby's settings: a full match runs its whole time limit (nobody scores 100). */
  settings: Pick<MatchSettings, 'map' | 'size' | 'mode' | 'botCount' | 'scoreLimit' | 'timeLimit'>;
}

/**
 * Parse and validate the flags (throws an `Error` naming the flag). Everything the room would
 * refuse is refused here, before a server is started: the counts against the player cap and
 * the match settings against the room's own schema (`parseMatchOptions`).
 */
export function parseSoakArgs(argv: readonly string[]): SoakArgs {
  const { values: a } = parseArgs({
    args: [...argv],
    options: {
      clients: { type: 'string', default: '6' },
      /** One-way delay (ms) added to every message in each direction. */
      latency: { type: 'string', default: '50' },
      /** ± this much (ms) on each one-way delivery, uniformly (never reorders: TCP). */
      jitter: { type: 'string', default: '0' },
      /** Percent of TCP chunks "lost" (each costs a retransmission delay, see delayLine.ts). */
      loss: { type: 'string', default: '0' },
      seconds: { type: 'string', default: '60' },
      full: { type: 'boolean', default: false },
      map: { type: 'string', default: 'defilad' },
      size: { type: 'string', default: 'market' },
      bots: { type: 'string', default: '0' },
      /** Quick join (the server's settings) instead of a friend lobby with the run's settings. */
      quick: { type: 'boolean', default: false },
      server: { type: 'string' },
      seed: { type: 'string', default: '1' },
      json: { type: 'string' },
      /** No sockets: the same clients against MatchSim on a virtual clock. */
      virtual: { type: 'boolean', default: false },
    },
  });
  const num = (s: string | undefined, name: string): number => {
    const n = Number(s);
    if (s === undefined || s.trim() === '' || !Number.isFinite(n) || n < 0) {
      throw new Error(`--${name}: not a number ≥ 0: ${s}`);
    }
    return n;
  };
  const int = (s: string | undefined, name: string, lo: number, hi: number): number => {
    const n = num(s, name);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new Error(`--${name}: a whole number ${lo}–${hi}, got ${s}`);
    }
    return n;
  };
  const clients = int(a.clients, 'clients', 1, MATCH_NET.maxPlayers);
  const bots = int(a.bots, 'bots', 0, MATCH_NET.maxPlayers - 1);
  const loss = num(a.loss, 'loss');
  if (loss > 100) throw new Error(`--loss: a percentage 0–100, got ${a.loss}`);
  const timeLimit = MATCH.timeLimit; // the default match: 10 min
  const raw = {
    map: a.map,
    size: a.size,
    mode: 'standard',
    botCount: bots,
    scoreLimit: 100,
    timeLimit,
  };
  const parsed = parseMatchOptions({ ...raw, lobby: true });
  if (!parsed) throw new Error(`--map/--size: not a match the server runs: ${a.map}/${a.size}`);
  return {
    clients,
    link: {
      delayMs: num(a.latency, 'latency'),
      jitterMs: num(a.jitter, 'jitter'),
      loss: loss / 100,
      rtoMs: 200,
    },
    bots,
    seed: int(a.seed, 'seed', 0, 2 ** 31 - 1),
    seconds: a.full ? timeLimit : num(a.seconds, 'seconds'),
    full: a.full,
    quick: a.quick,
    virtual: a.virtual,
    server: parseServer(a.server),
    json: a.json,
    settings: {
      map: parsed.map,
      size: parsed.size,
      mode: parsed.mode,
      botCount: parsed.botCount,
      scoreLimit: parsed.scoreLimit,
      timeLimit: parsed.timeLimit,
    },
  };
}

/**
 * `--server host:port` (both required: a bare host or a port out of range would only fail later,
 * as a crashed proxy connect). IPv6 literals go in brackets: `[::1]:2567`.
 */
function parseServer(raw: string | undefined): { host: string; port: number } | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\[[0-9a-fA-F:]+\]|[^\s:/[\]]+):(\d{1,5})$/.exec(raw.trim());
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535) {
    throw new Error(`--server: expected host:port (port 1–65535), got ${raw}`);
  }
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}

/**
 * What a run started and must stop again, whatever happens: steps are registered as they are
 * started and run once, newest first; a step that throws does not keep the rest from running.
 */
export class Teardown {
  private readonly steps: { name: string; stop: () => Promise<unknown> | void }[] = [];
  private ran = false;
  /** What failed while tearing down (reported, never thrown). */
  readonly errors: string[] = [];

  /** `stepTimeoutMs`: a step that never settles is abandoned after this long (the rest run). */
  constructor(private readonly stepTimeoutMs = 10_000) {}

  add(name: string, stop: () => Promise<unknown> | void): void {
    this.steps.push({ name, stop });
  }

  async run(): Promise<void> {
    if (this.ran) return;
    this.ran = true;
    for (const step of this.steps.reverse()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          step.stop(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`did not stop within ${this.stepTimeoutMs} ms`)),
              this.stepTimeoutMs,
            );
          }),
        ]);
      } catch (err) {
        this.errors.push(`${step.name}: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
