import {
  maskProfanity,
  mulberry32,
  QUICK_CHAT,
  type BotPersonalityId,
  type CombatEvent,
  type QuickChatId,
} from '@wd/shared';
import { BOT_LINES, type ChatTrigger } from './botLines.ts';

/**
 * Bot chatter: what the bots say, and when. It only *watches* the match (combat events, who is
 * where with how much health, the phase, humans' quick chat) and never touches a bot's decisions,
 * aim or input — `pnpm bots:measure` cannot tell it is there.
 *
 * Every trigger rolls a chance; a line then waits a short "typing" delay and goes out only if
 * the bot's own cooldown and the global one allow it (else it goes stale and is dropped), so even
 * a frag-fest gives at most one line every `globalCooldownMs`. Lines come from per-(trigger,
 * personality) decks shuffled by the seeded RNG: no line repeats before its deck is used up, and
 * the same seed and events give the same lines.
 */
export const CHATTER = {
  /** A bot speaks at most once per this long (ms; match start/end lines are exempt). */
  perBotCooldownMs: 20_000,
  /** All bots together: at most one line per this long (ms). */
  globalCooldownMs: 8_000,
  /** Chance a trigger makes its bot want to say something. */
  chance: {
    matchStart: 1,
    kill: 0.3,
    headshot: 0.5,
    streak: 0.75,
    revenge: 0.7,
    leaderKill: 0.75,
    death: 0.3,
    closeCall: 0.55,
    camped: 0.8,
    win: 1,
    lose: 1,
    replyTaunt: 0.6,
    replyPraise: 0.5,
    replyCallout: 0.45,
    replyTruce: 0.7,
  } satisfies Record<ChatTrigger, number>,
  /** Who wins when several lines are waiting (higher first). */
  priority: {
    win: 10,
    lose: 9,
    streak: 8,
    leaderKill: 7,
    revenge: 7,
    camped: 7,
    closeCall: 6,
    matchStart: 5,
    headshot: 5,
    replyTruce: 4,
    replyTaunt: 4,
    replyPraise: 4,
    replyCallout: 3,
    kill: 3,
    death: 2,
  } satisfies Record<ChatTrigger, number>,
  /**
   * A kill or death between two bots: its chance is scaled by this. The chatter is mostly about
   * the humans (their kills, their deaths, their quick chat); bot-on-bot banter is seasoning.
   */
  botOnly: 0.4,
  /** "Typing" delay before a line appears (ms, uniform). */
  delayMs: [700, 1800] as const,
  /** Replies to a human's quick chat take a little longer. */
  replyDelayMs: [1200, 2600] as const,
  /** A loser's cope waits for the winner's gloat. */
  loseDelayMs: [2500, 4000] as const,
  /** Match start: after everyone has had a moment to look around. */
  startDelayMs: [2500, 4500] as const,
  /** A waiting line older than this is dropped: chatter is about *now* (ms). */
  staleMs: 4_000,
  /** Match start/end lines wait longer (the results show for 10 s). */
  slowStaleMs: 9_000,
  /** Lines waiting at once, at most (the lowest priority goes first). */
  maxPending: 4,
  /** Two kills this close together (ms), or this many in one life, are a streak. */
  multikillMs: 4_000,
  streakKills: 3,
  /** Killing the clear leader with at least this many kills is a `leaderKill`. */
  leaderMinKills: 3,
  /** A kill made at or below this health is a close call… */
  closeCallKillHp: 30,
  /** …and so is surviving at or below this health for `closeCallHoldMs`. */
  closeCallHp: 20,
  closeCallHoldMs: 2_500,
  /** Within this radius (m) of one spot for `campMs` = camping (sampled every `campSampleMs`). */
  campRadius: 3,
  campMs: 20_000,
  campSampleMs: 500,
} as const;

/** What the chatter knows about a player (read from the match each step; never written back). */
export interface ChatterPlayer {
  id: string;
  name: string;
  slot: number;
  bot: boolean;
  persona?: BotPersonalityId;
  hp: number;
  life: number;
  kills: number;
  x: number;
  z: number;
}

/** A line a bot says now. */
export interface BotLine {
  from: string;
  name: string;
  slot: number;
  persona: BotPersonalityId;
  trigger: ChatTrigger;
  text: string;
}

interface Pending {
  bot: string;
  trigger: ChatTrigger;
  /** The other player's name, for `{them}`. */
  them: string;
  dueAt: number;
  expiresAt: number;
  /** Match start/end: not held back by the bot's own cooldown. */
  exempt: boolean;
}

interface Track {
  lifeKills: number;
  lastKillAt: number;
  /** Who killed this player last (revenge), and who it last fought (replies). */
  lastKilledBy: string | null;
  lastFoe: string | null;
  /** Where it has stayed since when (camping), and in which life. */
  anchorX: number;
  anchorZ: number;
  anchorSince: number;
  anchorLife: number;
  /** Dropped to `closeCallHp` at this time in this life (-1: no). */
  lowAt: number;
  lowLife: number;
}

const REPLY: Record<(typeof QUICK_CHAT)[number]['reply'], ChatTrigger> = {
  taunt: 'replyTaunt',
  praise: 'replyPraise',
  callout: 'replyCallout',
  truce: 'replyTruce',
};

const SLOW: readonly ChatTrigger[] = ['matchStart', 'win', 'lose'];

export class BotChatter {
  private readonly rng: () => number;
  private readonly decks = new Map<string, number[]>();
  private readonly lastLine = new Map<string, number>();
  private readonly spokeAt = new Map<string, number>();
  private readonly tracks = new Map<string, Track>();
  private readonly pending: Pending[] = [];
  private lastGlobal = -Infinity;
  private lastSample = -Infinity;
  private phase: 'playing' | 'ended' | null = null;
  /** This match's start line was queued (or there was no bot to say it yet). */
  private greeted = false;
  private players: readonly ChatterPlayer[] = [];

  constructor(
    seed: number,
    /** Host setting (`MatchSettings.botChatter`): off = silent bots. */
    public enabled = true,
    /** Each trigger's chance (tests pin it to 1 to check the mapping). */
    private readonly chanceOf: (t: ChatTrigger) => number = (t) => CHATTER.chance[t],
  ) {
    this.rng = mulberry32(seed);
  }

  /** Lines waiting for their moment (tests, diagnostics). */
  get waiting(): number {
    return this.pending.length;
  }

  /**
   * One step of the match: the players as they are now, the combat events since the last call
   * (in order), the phase and its winners. Returns the lines due now (at most one).
   */
  update(
    nowMs: number,
    players: readonly ChatterPlayer[],
    events: readonly CombatEvent[],
    phase: 'playing' | 'ended',
    winners: readonly string[] = [],
  ): BotLine[] {
    this.players = players;
    this.prune(players);
    if (phase !== this.phase) this.phaseChanged(nowMs, phase, winners);
    // A quick-join match starts before anyone (and so any bot) is in it: the first bots to
    // arrive say the start line then.
    if (this.phase === 'playing' && !this.greeted) {
      const bots = players.filter((p) => p.bot && p.persona);
      const bot = bots[Math.floor(this.rng() * bots.length)];
      if (bot) {
        this.greeted = true;
        this.want(nowMs, bot.id, 'matchStart', '', CHATTER.startDelayMs);
      }
    }
    this.sampleCamping(nowMs);
    for (const e of events) if (e.type === 'hit') this.onHit(nowMs, e);
    this.checkCloseCalls(nowMs);
    if (!this.enabled) {
      this.pending.length = 0;
      return [];
    }
    const line = this.emit(nowMs);
    return line ? [line] : [];
  }

  /** A human said a quick-chat preset: a bot may answer it. */
  heardQuick(nowMs: number, fromId: string, quick: QuickChatId): void {
    if (!this.enabled) return;
    const speaker = this.player(fromId);
    if (!speaker || speaker.bot) return;
    const preset = QUICK_CHAT.find((q) => q.id === quick);
    if (!preset) return;
    // Answered by whoever it last fought (if a bot), else a bot picked by the seeded RNG.
    const foe = this.track(fromId).lastFoe;
    const bots = this.players.filter((p) => p.bot && p.persona);
    const bot =
      bots.find((p) => p.id === foe) ?? bots[Math.floor(this.rng() * bots.length)] ?? null;
    if (bot) this.want(nowMs, bot.id, REPLY[preset.reply], speaker.name, CHATTER.replyDelayMs);
  }

  /** Forget everyone no longer in the match (long matches see many joins and leaves). */
  private prune(players: readonly ChatterPlayer[]): void {
    if (this.tracks.size <= players.length && this.spokeAt.size <= players.length) return;
    const here = new Set(players.map((p) => p.id));
    for (const id of this.tracks.keys()) if (!here.has(id)) this.tracks.delete(id);
    for (const id of this.spokeAt.keys()) if (!here.has(id)) this.spokeAt.delete(id);
  }

  /** A player left: drop what the chatter kept about them (and lines they would say). */
  forget(id: string): void {
    this.tracks.delete(id);
    this.spokeAt.delete(id);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.bot === id) this.pending.splice(i, 1);
    }
  }

  /** Per-player state kept (tests). */
  get trackedPlayers(): number {
    return Math.max(this.tracks.size, this.spokeAt.size);
  }

  private player(id: string): ChatterPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        lifeKills: 0,
        lastKillAt: -Infinity,
        lastKilledBy: null,
        lastFoe: null,
        anchorX: 0,
        anchorZ: 0,
        anchorSince: Number.NaN,
        anchorLife: -1,
        lowAt: -1,
        lowLife: -1,
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  private phaseChanged(
    nowMs: number,
    phase: 'playing' | 'ended',
    winners: readonly string[],
  ): void {
    this.phase = phase;
    this.pending.length = 0;
    const bots = this.players.filter((p) => p.bot && p.persona);
    if (phase === 'playing') {
      // A fresh match: streaks, grudges and camping spots start over (the start line follows).
      this.tracks.clear();
      this.greeted = false;
      return;
    }
    const winner = bots.find((p) => winners.includes(p.id));
    if (winner) this.want(nowMs, winner.id, 'win', '', CHATTER.delayMs);
    const losers = bots.filter((p) => !winners.includes(p.id));
    const loser = losers[Math.floor(this.rng() * losers.length)];
    if (loser) {
      // The loser's cope comes after the winner's gloat (the global cooldown spaces them).
      this.want(nowMs, loser.id, 'lose', '', CHATTER.loseDelayMs);
    }
  }

  private sampleCamping(nowMs: number): void {
    if (nowMs - this.lastSample < CHATTER.campSampleMs) return;
    this.lastSample = nowMs;
    for (const p of this.players) {
      const t = this.track(p.id);
      const moved = Math.hypot(p.x - t.anchorX, p.z - t.anchorZ) > CHATTER.campRadius;
      if (p.hp <= 0 || p.life !== t.anchorLife || moved || Number.isNaN(t.anchorSince)) {
        t.anchorX = p.x;
        t.anchorZ = p.z;
        t.anchorSince = nowMs;
        t.anchorLife = p.life;
      }
    }
  }

  /** How long this player has stayed in one spot (ms; 0 if unknown). */
  campedFor(id: string, nowMs: number): number {
    const t = this.tracks.get(id);
    return t && !Number.isNaN(t.anchorSince) ? nowMs - t.anchorSince : 0;
  }

  private onHit(nowMs: number, e: Extract<CombatEvent, { type: 'hit' }>): void {
    const victim = this.player(e.target);
    if (!victim) return;
    if (e.by !== e.target) {
      this.track(e.target).lastFoe = e.by;
      this.track(e.by).lastFoe = e.target;
    }
    if (!e.killed) {
      if (victim.bot && e.hp > 0 && e.hp <= CHATTER.closeCallHp) {
        const t = this.track(victim.id);
        if (t.lowLife !== victim.life) {
          t.lowAt = nowMs;
          t.lowLife = victim.life;
        }
      }
      return;
    }
    const vt = this.track(victim.id);
    vt.lifeKills = 0;
    vt.lowAt = -1;
    // A frag on yourself is its own punishment: no line about it.
    if (e.by === e.target) return;
    vt.lastKilledBy = e.by;
    const killer = this.player(e.by);
    if (killer?.bot) this.killerLine(nowMs, killer, victim, e);
    if (victim.bot) {
      const camped = killer !== undefined && this.campedFor(killer.id, nowMs) >= CHATTER.campMs;
      const human = killer !== undefined && !killer.bot;
      const trigger = camped ? 'camped' : 'death';
      this.want(
        nowMs,
        victim.id,
        trigger,
        killer?.name ?? '',
        CHATTER.delayMs,
        human ? 1 : CHATTER.botOnly,
      );
    }
  }

  private killerLine(
    nowMs: number,
    killer: ChatterPlayer,
    victim: ChatterPlayer,
    e: Extract<CombatEvent, { type: 'hit' }>,
  ): void {
    const t = this.track(killer.id);
    t.lifeKills++;
    const multi = nowMs - t.lastKillAt <= CHATTER.multikillMs;
    t.lastKillAt = nowMs;
    const revenge = t.lastKilledBy === victim.id;
    if (revenge) t.lastKilledBy = null;
    // The score is already updated: the killer's own count includes this kill.
    const others = this.players
      .filter((p) => p.id !== victim.id)
      .map((p) => (p.id === killer.id ? p.kills - 1 : p.kills));
    const leader = victim.kills >= CHATTER.leaderMinKills && others.every((k) => victim.kills > k);
    const trigger: ChatTrigger =
      multi || t.lifeKills >= CHATTER.streakKills
        ? 'streak'
        : leader
          ? 'leaderKill'
          : revenge
            ? 'revenge'
            : killer.hp > 0 && killer.hp <= CHATTER.closeCallKillHp
              ? 'closeCall'
              : e.zone === 'head' && e.weapon !== 'frag'
                ? 'headshot'
                : 'kill';
    this.want(
      nowMs,
      killer.id,
      trigger,
      victim.name,
      CHATTER.delayMs,
      victim.bot ? CHATTER.botOnly : 1,
    );
  }

  private checkCloseCalls(nowMs: number): void {
    for (const p of this.players) {
      if (!p.bot) continue;
      const t = this.tracks.get(p.id);
      if (!t || t.lowAt < 0) continue;
      if (p.hp <= 0 || p.life !== t.lowLife) {
        t.lowAt = -1;
        continue;
      }
      if (nowMs - t.lowAt >= CHATTER.closeCallHoldMs) {
        t.lowAt = -1;
        this.want(nowMs, p.id, 'closeCall', '', CHATTER.delayMs);
      }
    }
  }

  /** The bot would like to say something: roll the trigger's chance, then wait to type it. */
  private want(
    nowMs: number,
    bot: string,
    trigger: ChatTrigger,
    them: string,
    delay: readonly [number, number],
    /** Scales the trigger's chance (bot-vs-bot moments talk less). */
    factor = 1,
  ): void {
    const roll = this.rng();
    const wait = delay[0] + this.rng() * (delay[1] - delay[0]);
    if (!this.enabled || roll >= this.chanceOf(trigger) * factor) return;
    const slow = SLOW.includes(trigger);
    const expiresAt = nowMs + wait + (slow ? CHATTER.slowStaleMs : CHATTER.staleMs);
    // A bot still on its own cooldown when the line would go stale never gets to say it.
    if (!slow && this.cooldownEnds(bot) > expiresAt) return;
    this.pending.push({ bot, trigger, them, dueAt: nowMs + wait, expiresAt, exempt: slow });
    if (this.pending.length > CHATTER.maxPending) {
      // Drop the lowest priority; among equals the newest, so the older lines (due sooner)
      // are not crowded out by fresh ones forever.
      let worst = 0;
      for (let i = 1; i < this.pending.length; i++) {
        const a = this.pending[i]!;
        const b = this.pending[worst]!;
        if (CHATTER.priority[a.trigger] <= CHATTER.priority[b.trigger]) worst = i;
      }
      this.pending.splice(worst, 1);
    }
  }

  private cooldownEnds(bot: string): number {
    return (this.spokeAt.get(bot) ?? -Infinity) + CHATTER.perBotCooldownMs;
  }

  /** The best line that may go out now, if any (and drop the stale ones). */
  private emit(nowMs: number): BotLine | null {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (nowMs > p.expiresAt || !this.player(p.bot)) this.pending.splice(i, 1);
    }
    if (nowMs - this.lastGlobal < CHATTER.globalCooldownMs) return null;
    let best = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!;
      if (nowMs < p.dueAt) continue;
      if (!p.exempt && nowMs < this.cooldownEnds(p.bot)) continue;
      const b = this.pending[best];
      if (!b || CHATTER.priority[p.trigger] > CHATTER.priority[b.trigger]) best = i;
    }
    if (best < 0) return null;
    const p = this.pending.splice(best, 1)[0]!;
    const bot = this.player(p.bot);
    if (!bot?.persona) return null;
    this.lastGlobal = nowMs;
    this.spokeAt.set(bot.id, nowMs);
    // Whatever else it wanted to say would wait out its cooldown and go stale: drop it now.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i]!;
      if (q.bot === bot.id && !q.exempt) this.pending.splice(i, 1);
    }
    return {
      from: bot.id,
      name: bot.name,
      slot: bot.slot,
      persona: bot.persona,
      trigger: p.trigger,
      // Names are the players' own text: masked like any typed line (lines are clean already).
      text: maskProfanity(
        this.draw(p.trigger, bot.persona).replaceAll('{them}', p.them || 'rookie'),
      ),
    };
  }

  /** The next line of this trigger's deck for the personality (reshuffled when used up). */
  draw(trigger: ChatTrigger, persona: BotPersonalityId): string {
    const pool = BOT_LINES[trigger][persona];
    const key = `${trigger}:${persona}`;
    let deck = this.decks.get(key);
    if (!deck?.length) {
      deck = pool.map((_, i) => i);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j]!, deck[i]!];
      }
      // Never the same line twice in a row across a reshuffle (it is drawn from the end).
      const last = this.lastLine.get(key);
      if (deck.length > 1 && deck.at(-1) === last)
        [deck[0], deck[deck.length - 1]] = [deck.at(-1)!, deck[0]!];
      this.decks.set(key, deck);
    }
    const i = deck.pop()!;
    this.lastLine.set(key, i);
    return pool[i] ?? '';
  }
}
