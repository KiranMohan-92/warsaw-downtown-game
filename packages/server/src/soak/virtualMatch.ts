import { MATCH_NET, SIM, type MatchPong, type WelcomeMessage, type InputMessage } from '@wd/shared';
import { MatchSim, type MatchConfig } from '../match/MatchSim.ts';
import { DelayLine, DelayQueue, type LinkProfile } from './delayLine.ts';
import { SoakClient, type SoakClientOptions, type SoakWorld } from './soakClient.ts';

const TICK_MS = 1000 / SIM.tickHz;

interface Wire {
  type: string;
  msg: unknown;
}

interface Seat {
  id: string;
  client: SoakClient;
  up: DelayQueue<Wire>;
  down: DelayQueue<Wire>;
  /** Frames every `frameMs`, starting at this phase (ms). */
  nextFrameMs: number;
  frameMs: number;
}

/**
 * The match room on a virtual clock: `MatchSim` stepped exactly the way `MatchRoom` steps it
 * (one tick per 1/60 s, combat → match → per-recipient snapshots every second tick, a ping every
 * second, welcome/roster/match on join, respawn messages), with every message crossing a seeded
 * `DelayLine` each way. Deterministic and independent of the host's load, so a test can assert
 * fairness at a given latency without real sockets (the socket path is `soak.ts`). Messages are
 * structured-cloned, as a serializer would copy them.
 */
export class VirtualMatch {
  readonly sim: MatchSim;
  readonly seats: Seat[] = [];
  nowMs = 0;
  private nextTickMs = TICK_MS;
  private nextPingMs = MATCH_NET.pingIntervalMs;
  private nextId = 1;

  constructor(
    config: MatchConfig,
    private readonly up: LinkProfile,
    private readonly down: LinkProfile,
    private readonly seed = 1,
  ) {
    this.sim = new MatchSim(config);
    this.sim.onRespawn = (p, msg) =>
      this.seats.find((s) => s.id === p.id)?.down.push(wire('respawn', msg), this.nowMs);
  }

  /** Seat a headless client (it joins now: welcome, roster and score go out over its link). */
  join(world: SoakWorld, opts: SoakClientOptions, frameMs = 1000 / 60): SoakClient {
    const id = `c${this.nextId++}`;
    const n = this.seats.length;
    const upQ = new DelayQueue<Wire>(new DelayLine(this.up, this.seed * 7919 + n * 2));
    const downQ = new DelayQueue<Wire>(new DelayLine(this.down, this.seed * 7919 + n * 2 + 1));
    const client = new SoakClient(
      world,
      { send: (type, msg) => upQ.push(wire(type, msg), this.nowMs) },
      opts,
    );
    const seat: Seat = {
      id,
      client,
      up: upQ,
      down: downQ,
      nextFrameMs: this.nowMs + ((n * 5.3) % frameMs),
      frameMs,
    };
    this.seats.push(seat);
    const p = this.sim.addPlayer(id, opts.name, this.nowMs);
    const pos = p.state.move.pos;
    const welcome: WelcomeMessage = {
      id,
      map: this.sim.config.map,
      size: this.sim.config.size,
      mode: this.sim.config.mode,
      tick: this.sim.tick,
      tickHz: SIM.tickHz,
      spawn: { x: pos.x, y: pos.y, z: pos.z, yaw: p.state.view.yaw },
      seed: p.seed,
      primary: p.state.arsenal.primary,
    };
    downQ.push(wire('welcome', welcome), this.nowMs);
    this.broadcast('roster', this.sim.roster());
    this.sim.takeMatchChange();
    this.broadcast('match', this.sim.matchState());
    return client;
  }

  /** Advance the virtual clock to `untilMs` in 1 ms steps. */
  runUntil(untilMs: number): void {
    while (this.nowMs < untilMs) {
      this.nowMs += 1;
      const now = this.nowMs;
      for (const s of this.seats) for (const w of s.up.takeDue(now)) this.serverReceive(s, w);
      while (now >= this.nextTickMs) {
        this.nextTickMs += TICK_MS;
        const snapshot = this.sim.runTicks(1);
        const events = this.sim.drainEvents();
        if (events.length) this.broadcast('combat', { events });
        const match = this.sim.takeMatchChange();
        if (match) this.broadcast('match', match);
        if (snapshot)
          for (const s of this.seats) s.down.push(wire('snap', this.sim.snapshot(s.id)), now);
      }
      if (now >= this.nextPingMs) {
        this.nextPingMs += MATCH_NET.pingIntervalMs;
        for (const s of this.seats) {
          const ping = this.sim.issuePing(s.id, now);
          if (ping) s.down.push(wire('ping', ping), now);
        }
      }
      for (const s of this.seats) {
        for (const w of s.down.takeDue(now)) s.client.receive(w.type, w.msg, now);
        if (now >= s.nextFrameMs) {
          s.nextFrameMs += s.frameMs;
          s.client.frame(now);
        }
      }
    }
  }

  dispose(): void {
    for (const s of this.seats) s.client.finish(this.nowMs);
    this.sim.dispose();
  }

  private serverReceive(s: Seat, w: Wire): void {
    if (w.type === 'input') {
      this.sim.receiveInputs(s.id, (w.msg as InputMessage).inputs, this.nowMs);
    } else if (w.type === 'pong') {
      this.sim.receivePong(s.id, (w.msg as MatchPong).t, this.nowMs);
    } else if (w.type === 'ready') this.sim.markReady(s.id);
  }

  private broadcast(type: string, msg: unknown): void {
    for (const s of this.seats) s.down.push(wire(type, msg), this.nowMs);
  }
}

const wire = (type: string, msg: unknown): Wire => ({ type, msg: structuredClone(msg) });
