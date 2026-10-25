import {
  ChatSendMessageOrNull,
  DropGunMessageOrNull,
  EndMatchMessageOrNull,
  InputMessageOrNull,
  LoadoutMessageOrNull,
  MATCH_NET,
  MatchPongOrNull,
  NameMessageOrNull,
  ReadyMessageOrNull,
  SIM,
  sanitizeName,
  type CombatMessage,
  type DropMessage,
  type LobbyMessage,
  type MatchSettings,
  type PrimaryId,
  type WelcomeMessage,
} from '@wd/shared';
import { MatchSim } from '../match/MatchSim.ts';
import { MatchChat, simSource } from '../match/matchChat.ts';

/** The local player's id in a practice match (one human, the rest bots). */
export const PRACTICE_PLAYER_ID = 'you';
/** The room id a practice match reports (shown nowhere; there is no share link). */
export const PRACTICE_ROOM_ID = 'practice';

/** What the page asks for: the match settings (bots, limits, map…), its name and primary. */
export interface PracticeInit {
  settings: MatchSettings;
  name: string;
  primary?: PrimaryId;
  /** Seed for the bots' chatter lines (default: a fresh one per match). */
  chatSeed?: number;
  /** Spawn-only RNG seed (default 0); the practice worker supplies a fresh seed per match. */
  spawnSeed?: number;
  /** Development or an explicit `?autotest` launch; never enabled by ordinary practice. */
  allowDevTools?: boolean;
}

/** Messages a practice host sends (the same ones a `MatchRoom` sends a client). */
export type PracticeSend = (type: string, msg: unknown) => void;

/**
 * A practice match vs bots without a server: the authoritative `MatchSim` (behaviour-tree bots,
 * lag compensation, spawn protection, scoring) driven exactly the way `MatchRoom` drives it, for
 * one local human. It runs in a Web Worker beside the game (`practiceWorker.ts`) and speaks the
 * room's own messages, so the client plays it through its online path (prediction, reconcile,
 * kill feed, kill cam, scoreboard) — the bots are the real ones, not an offline imitation.
 * Client messages are validated with the room's schemas: an invalid one is dropped.
 */
export class PracticeHost {
  readonly sim: MatchSim;
  /** Your lines, and the bots' chatter (they answer your quick chat). */
  readonly chat: MatchChat;
  private readonly settings: MatchSettings;
  private stopped = false;
  private readonly allowDevTools: boolean;

  constructor(
    init: PracticeInit,
    private readonly send: PracticeSend,
  ) {
    this.allowDevTools = init.allowDevTools === true;
    // Practice is one human and bots: a bot-less practice is just the range.
    this.settings = { ...init.settings, botCount: Math.max(1, init.settings.botCount) };
    this.sim = new MatchSim({
      ...this.settings,
      ...(init.spawnSeed !== undefined ? { spawnSeed: init.spawnSeed } : {}),
    });
    if (this.settings.botCount > 0) this.sim.bots.prewarm();
    // Out of the fight until the game is built and the player pressed Play (`ready`).
    this.sim.addPlayer(PRACTICE_PLAYER_ID, sanitizeName(init.name, 'You'), 0, false, {
      ready: false,
      ...(init.primary ? { primary: init.primary } : {}),
    });
    // Bots now occupy their initial spawns. Reserve the safe destination before the intro is
    // planned from welcome; the readiness hold keeps those opponents still until control.
    this.sim.prepareReadySpawn(PRACTICE_PLAYER_ID);
    this.chat = new MatchChat(simSource(this.sim), {
      seed: init.chatSeed ?? Date.now() >>> 0,
      botChatter: this.settings.botChatter !== 'off',
    });
    this.sim.onRespawn = (p, msg) => {
      if (p.id === PRACTICE_PLAYER_ID) this.send('respawn', msg);
    };
    this.sendWelcome();
    this.send('roster', this.sim.roster());
    this.sim.takeMatchChange();
    this.send('match', this.sim.matchState());
    this.send('lobby', this.lobby());
  }

  /** The lobby view: you host (so you may end a match without limits) and it is playing. */
  private lobby(): LobbyMessage {
    const roster = this.sim.roster().players;
    return {
      roomId: PRACTICE_ROOM_ID,
      hostId: PRACTICE_PLAYER_ID,
      phase: 'playing',
      settings: this.settings,
      players: roster.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        ...(p.bot ? { bot: true } : {}),
      })),
    };
  }

  private sendWelcome(): void {
    const p = this.sim.players.get(PRACTICE_PLAYER_ID);
    if (!p) return;
    const pos = p.state.move.pos;
    const welcome: WelcomeMessage = {
      id: p.id,
      map: this.sim.config.map,
      size: this.sim.config.size,
      mode: this.sim.config.mode,
      settings: this.settings,
      tick: this.sim.tick,
      tickHz: SIM.tickHz,
      spawn: { x: pos.x, y: pos.y, z: pos.z, yaw: p.state.view.yaw },
      seed: p.seed,
      primary: p.state.arsenal.primary,
    };
    this.send('welcome', welcome);
  }

  /** Validated room messages, plus the explicitly enabled development `dropGun` hook. */
  receive(type: string, raw: unknown, nowMs: number): void {
    if (this.stopped) return;
    const sim = this.sim;
    const id = PRACTICE_PLAYER_ID;
    switch (type) {
      case 'input': {
        const msg = InputMessageOrNull['~standard'].validate(raw).value;
        if (msg) sim.receiveInputs(id, msg.inputs, sim.nowMs);
        return;
      }
      case 'pong': {
        const msg = MatchPongOrNull['~standard'].validate(raw).value;
        if (msg) sim.receivePong(id, msg.t, nowMs);
        return;
      }
      case 'ready':
        if (ReadyMessageOrNull['~standard'].validate(raw).value) sim.markReady(id);
        return;
      case 'loadout': {
        const msg = LoadoutMessageOrNull['~standard'].validate(raw).value;
        if (msg) sim.setLoadout(id, msg.primary);
        return;
      }
      case 'dropGun': {
        if (!this.allowDevTools) return;
        const msg = DropGunMessageOrNull['~standard'].validate(raw).value;
        if (msg) sim.spawnWeaponDrop(msg.primaryId, msg.x, msg.z, msg.ammoFraction);
        return;
      }
      case 'name': {
        const msg = NameMessageOrNull['~standard'].validate(raw).value;
        if (msg && sim.rename(id, msg.name, nowMs)) {
          this.send('roster', sim.roster());
          this.send('lobby', this.lobby());
        }
        return;
      }
      case 'chat': {
        const msg = ChatSendMessageOrNull['~standard'].validate(raw).value;
        if (!msg) return;
        const out = this.chat.fromPlayer(id, msg);
        if (out.all) this.send('chat', out.all);
        if (out.sender) this.send('chat', out.sender);
        return;
      }
      case 'end':
        if (EndMatchMessageOrNull['~standard'].validate(raw).value && sim.endMatch()) {
          const match = sim.takeMatchChange();
          if (match) this.send('match', match);
        }
        return;
    }
  }

  /** `ticks` sim ticks (combat → match → snapshot, as `MatchRoom` does). */
  step(ticks: number, snapshot: boolean): void {
    if (this.stopped) return;
    const sim = this.sim;
    // The worker starts before shader warm-up finishes. Its lone human has no loading timeout:
    // keep the match clock (and all spawn windows) intact until ready or the first accepted input.
    const ready = sim.players.get(PRACTICE_PLAYER_ID)?.ready;
    if (ready) sim.runTicks(ticks);
    const events = sim.drainEvents();
    if (events.length) this.send('combat', { events } satisfies CombatMessage);
    const drops = sim.drainDrops();
    if (drops.length) this.send('drop', { events: drops } satisfies DropMessage);
    const match = sim.takeMatchChange();
    if (match) this.send('match', match);
    for (const line of this.chat.afterStep(sim, events)) this.send('chat', line);
    // The intro still draws bots and trucks. Mark its frozen state so repeated tick-zero
    // arrivals cannot seed or skew the client's clock and jitter estimates.
    if (snapshot) {
      const snap = sim.snapshot(PRACTICE_PLAYER_ID);
      this.send('snap', ready ? snap : { ...snap, held: true });
    }
  }

  /** The once-a-second `ping` (round trip for the badge, the scoreboard and lag compensation). */
  ping(nowMs: number): void {
    if (this.stopped) return;
    const ping = this.sim.issuePing(PRACTICE_PLAYER_ID, nowMs);
    if (ping) this.send('ping', ping);
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sim.dispose();
  }
}

/** The room's pacing numbers, for the worker's loop. */
export const PRACTICE_LOOP = {
  stepMs: 1000 / SIM.tickHz,
  snapshotEvery: MATCH_NET.snapshotEvery,
  maxPerCall: MATCH_NET.maxCatchUpTicks,
  maxBacklogMs: MATCH_NET.maxCatchUpMs,
  spinMs: MATCH_NET.snapshotSpinMs,
  maxLeadMs: MATCH_NET.snapshotMaxLeadMs,
  minGapRatio: MATCH_NET.snapshotMinGapRatio,
  pingIntervalMs: MATCH_NET.pingIntervalMs,
} as const;
