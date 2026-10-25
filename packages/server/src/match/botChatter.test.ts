import { describe, expect, it } from 'vitest';
import { BOT, maskProfanity, type BotPersonalityId, type CombatEvent } from '@wd/shared';
import { BotChatter, CHATTER, type BotLine, type ChatterPlayer } from './botChatter.ts';
import { BOT_LINES, CHAT_TRIGGERS, NO_OTHER, type ChatTrigger } from './botLines.ts';

const PERSONAS = BOT.personalityOrder;

function roster(): ChatterPlayer[] {
  const p = (
    id: string,
    name: string,
    slot: number,
    persona?: BotPersonalityId,
  ): ChatterPlayer => ({
    id,
    name,
    slot,
    bot: persona !== undefined,
    ...(persona ? { persona } : {}),
    hp: 100,
    life: 0,
    kills: 0,
    x: slot * 10,
    z: 0,
  });
  return [
    p('h', 'Kiran', 0),
    p('bot:1', 'Taran', 1, 'rusher'),
    p('bot:2', 'Lis', 2, 'flanker'),
    p('bot:3', 'Kotwica', 3, 'anchor'),
    p('bot:4', 'Jastrząb', 4, 'marksman'),
  ];
}

const hit = (
  by: string,
  target: string,
  o: { killed?: boolean; zone?: 'head' | 'torso'; hp?: number; weapon?: 'rifle' | 'frag' } = {},
): CombatEvent => ({
  type: 'hit',
  by,
  target,
  weapon: o.weapon ?? 'rifle',
  zone: o.zone ?? 'torso',
  dmg: 30,
  hp: o.hp ?? (o.killed ? 0 : 70),
  killed: o.killed ?? false,
  at: { x: 0, y: 0, z: 0 },
  from: { x: 0, y: 0, z: 0 },
});

/** A chatter whose start line is already out of the way, at t = 60 s (cooldowns long expired). */
function fresh(always = true, seed = 7): { c: BotChatter; players: ChatterPlayer[]; t: number } {
  const c = new BotChatter(seed, true, always ? () => 1 : undefined);
  const players = roster();
  for (let t = 0; t <= 10_000; t += 100) c.update(t, players, [], 'playing');
  return { c, players, t: 60_000 };
}

/** Step 100 ms at a time for `ms`, collecting lines. */
function run(
  c: BotChatter,
  players: ChatterPlayer[],
  from: number,
  ms: number,
  events: CombatEvent[] = [],
): BotLine[] {
  const out: BotLine[] = [];
  for (let t = from; t <= from + ms; t += 100) {
    out.push(...c.update(t, players, t === from ? events : [], 'playing'));
  }
  return out;
}

describe('bot line pools', () => {
  it('every trigger has at least 15 lines across personalities, 4+ each', () => {
    for (const trigger of CHAT_TRIGGERS) {
      const pool = BOT_LINES[trigger];
      const total = PERSONAS.reduce((n, p) => n + pool[p].length, 0);
      expect(total, trigger).toBeGreaterThanOrEqual(15);
      for (const p of PERSONAS) expect(pool[p].length, `${trigger}:${p}`).toBeGreaterThanOrEqual(4);
    }
  });

  it('lines are short, unique, clean, and only name `{them}` where there is someone', () => {
    const seen = new Set<string>();
    for (const trigger of CHAT_TRIGGERS) {
      for (const p of PERSONAS) {
        for (const line of BOT_LINES[trigger][p]) {
          expect(line.length, line).toBeLessThanOrEqual(80);
          expect(maskProfanity(line), line).toBe(line);
          expect(seen.has(`${trigger}|${line}`), line).toBe(false);
          seen.add(`${trigger}|${line}`);
          if (NO_OTHER.includes(trigger)) expect(line, line).not.toContain('{them}');
          expect(line.replaceAll('{them}', ''), line).not.toMatch(/[{}]/);
        }
      }
    }
  });
});

describe('deterministic selection', () => {
  it('a deck never repeats a line before it is used up, nor twice in a row across reshuffles', () => {
    const c = new BotChatter(42);
    const pool = BOT_LINES.kill.rusher;
    let prev = '';
    for (let lap = 0; lap < 5; lap++) {
      const drawn = pool.map(() => c.draw('kill', 'rusher'));
      expect(new Set(drawn).size).toBe(pool.length);
      expect(drawn[0]).not.toBe(prev);
      prev = drawn.at(-1)!;
    }
  });

  it('the same seed and the same match give the same lines; another seed differs', () => {
    const play = (seed: number): string[] => {
      const { c, players, t } = fresh(false, seed);
      const lines: string[] = [];
      for (let k = 0; k < 40; k++) {
        const killer = `bot:${(k % 4) + 1}`;
        const victim = k % 2 ? 'h' : `bot:${((k + 1) % 4) + 1}`;
        const events = [hit(killer, victim, { killed: true, zone: k % 3 ? 'torso' : 'head' })];
        lines.push(
          ...run(c, players, t + k * 6000, 5900, events).map((l) => `${l.from}:${l.text}`),
        );
      }
      return lines;
    };
    const a = play(1);
    expect(a.length).toBeGreaterThan(5);
    expect(play(1)).toEqual(a);
    expect(play(2)).not.toEqual(a);
  });
});

describe('trigger mapping', () => {
  const said = (lines: BotLine[]): [string, ChatTrigger][] => lines.map((l) => [l.from, l.trigger]);

  it('a bot kill → kill; a headshot → headshot; `{them}` is the victim', () => {
    const { c, players, t } = fresh();
    const lines = run(c, players, t, 3000, [hit('bot:1', 'h', { killed: true })]);
    expect(said(lines)).toEqual([['bot:1', 'kill']]);
    expect(BOT_LINES.kill.rusher.map((l) => l.replaceAll('{them}', 'Kiran'))).toContain(
      lines[0]!.text,
    );
    const head = run(c, players, t + 30_000, 3000, [
      hit('bot:2', 'h', { killed: true, zone: 'head' }),
    ]);
    expect(said(head)).toEqual([['bot:2', 'headshot']]);
    // A frag to the head is no headshot.
    const frag = run(c, players, t + 60_000, 3000, [
      hit('bot:3', 'h', { killed: true, zone: 'head', weapon: 'frag' }),
    ]);
    expect(said(frag)).toEqual([['bot:3', 'kill']]);
  });

  it('two kills within 4 s, or 3 in one life → streak', () => {
    const { c, players, t } = fresh();
    const lines = run(c, players, t, 3000, [
      hit('bot:1', 'h', { killed: true }),
      hit('bot:1', 'h', { killed: true }),
    ]);
    expect(said(lines)).toEqual([['bot:1', 'streak']]);
  });

  it('killing your last killer → revenge', () => {
    const { c, players, t } = fresh();
    // (On the move: a killer who sat still since the start would get the camping callout.)
    players[0]!.x += 10;
    run(c, players, t - 1000, 900);
    // The human kills the bot (salty line from the bot), later the bot gets them back.
    expect(said(run(c, players, t, 3000, [hit('h', 'bot:4', { killed: true })]))).toEqual([
      ['bot:4', 'death'],
    ]);
    const back = run(c, players, t + 30_000, 3000, [hit('bot:4', 'h', { killed: true })]);
    expect(said(back)).toEqual([['bot:4', 'revenge']]);
  });

  it('killing the clear leader → leaderKill', () => {
    const { c, players, t } = fresh();
    players[0]!.kills = 5;
    players[1]!.kills = 2; // includes this kill
    expect(said(run(c, players, t, 3000, [hit('bot:1', 'h', { killed: true })]))).toEqual([
      ['bot:1', 'leaderKill'],
    ]);
  });

  it('a kill at low health, or surviving at low health → closeCall', () => {
    const { c, players, t } = fresh();
    players[2]!.hp = 12;
    expect(said(run(c, players, t, 3000, [hit('bot:2', 'h', { killed: true })]))).toEqual([
      ['bot:2', 'closeCall'],
    ]);
    players[3]!.hp = 9;
    const survived = run(c, players, t + 30_000, 5000, [hit('h', 'bot:3', { hp: 9 })]);
    expect(said(survived)).toEqual([['bot:3', 'closeCall']]);
    // Dying before the hold is up says nothing about a close call.
    players[4]!.hp = 9;
    const events = [hit('h', 'bot:4', { hp: 9 })];
    c.update(t + 60_000, players, events, 'playing');
    players[4]!.hp = 0;
    expect(said(run(c, players, t + 60_100, 5000))).toEqual([]);
  });

  it('a bot killed by someone who sat in one spot for 20 s → camped; otherwise death', () => {
    const { c, players, t } = fresh();
    expect(said(run(c, players, t, 25_000))).toEqual([]); // the human sits still meanwhile
    expect(c.campedFor('h', t + 25_000)).toBeGreaterThanOrEqual(CHATTER.campMs);
    const lines = run(c, players, t + 25_100, 3000, [hit('h', 'bot:1', { killed: true })]);
    expect(said(lines)).toEqual([['bot:1', 'camped']]);
    expect(lines[0]!.text).toContain('Kiran');
    // Moving resets the spot.
    players[0]!.x += 10;
    run(c, players, t + 30_000, 1000);
    expect(c.campedFor('h', t + 31_000)).toBeLessThan(CHATTER.campMs);
  });

  it('bot-vs-bot kills talk less than kills involving a human', () => {
    const count = (victim: string): number => {
      const { c, players, t } = fresh();
      players[0]!.x += 10; // nobody camping
      let n = 0;
      for (let k = 0; k < 100; k++) {
        const ev = [hit('bot:1', victim, { killed: true })];
        n += run(c, players, t + k * 30_000, 3000, ev).length;
      }
      return n;
    };
    const human = count('h');
    const bots = count('bot:2');
    expect(human).toBeGreaterThan(90);
    // (A bot victim may still answer: two chances at 0.4 instead of one at 1.)
    expect(bots).toBeLessThan(human * 0.8);
  });

  it('a frag on yourself says nothing', () => {
    const { c, players, t } = fresh();
    expect(run(c, players, t, 3000, [hit('bot:1', 'bot:1', { killed: true })])).toEqual([]);
  });

  it('match end: the winning bot gloats, a losing bot copes; a new match greets', () => {
    const { c, players, t } = fresh();
    const out: BotLine[] = [];
    for (let k = t; k <= t + 14_000; k += 100)
      out.push(...c.update(k, players, [], 'ended', ['bot:2']));
    expect(said(out).map(([, trig]) => trig)).toEqual(['win', 'lose']);
    expect(out[0]!.from).toBe('bot:2');
    expect(out[1]!.from).not.toBe('bot:2');
    const again: BotLine[] = [];
    for (let k = t + 20_000; k <= t + 26_000; k += 100) {
      again.push(...c.update(k, players, [], 'playing'));
    }
    expect(said(again).map(([, trig]) => trig)).toEqual(['matchStart']);
  });

  it('quick chat → the matching reply, from the bot the speaker last fought', () => {
    const { c, players, t } = fresh();
    run(c, players, t, 100, [hit('bot:3', 'h', { hp: 60 })]);
    c.heardQuick(t + 200, 'h', 'truce');
    const lines = run(c, players, t + 200, 3000);
    expect(said(lines)).toEqual([['bot:3', 'replyTruce']]);
    for (const [quick, trigger] of [
      ['isThatAll', 'replyTaunt'],
      ['niceShot', 'replyPraise'],
      ['behindYou', 'replyCallout'],
    ] as const) {
      const at = t + 30_000 * (['isThatAll', 'niceShot', 'behindYou'].indexOf(quick) + 1);
      c.heardQuick(at, 'h', quick);
      expect(said(run(c, players, at, 3000))).toEqual([['bot:3', trigger]]);
    }
    // Bots never answer bots.
    c.heardQuick(t + 200_000, 'bot:1', 'gg');
    expect(run(c, players, t + 200_000, 3000)).toEqual([]);
  });

  it('chatter off: silent', () => {
    const { c, players, t } = fresh();
    c.enabled = false;
    expect(run(c, players, t, 3000, [hit('bot:1', 'h', { killed: true })])).toEqual([]);
  });
});

describe('rate limits', () => {
  it('a frag-fest: never two lines within the global cooldown, a bot never within its own', () => {
    const { c, players, t } = fresh();
    const lines: { at: number; from: string }[] = [];
    // A kill every 200 ms for two minutes, every bot involved, all chances at 1.
    for (let k = 0; k < 600; k++) {
      const at = t + k * 200;
      const killer = `bot:${(k % 4) + 1}`;
      const victim = k % 3 ? 'h' : `bot:${((k + 2) % 4) + 1}`;
      for (const l of c.update(at, players, [hit(killer, victim, { killed: true })], 'playing')) {
        lines.push({ at, from: l.from });
      }
      if (k % 5 === 0) c.heardQuick(at, 'h', 'isThatAll');
    }
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.length).toBeLessThanOrEqual(120_000 / CHATTER.globalCooldownMs + 1);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.at - lines[i - 1]!.at).toBeGreaterThanOrEqual(CHATTER.globalCooldownMs);
    }
    const byBot = new Map<string, number>();
    for (const l of lines) {
      const prev = byBot.get(l.from);
      if (prev !== undefined) expect(l.at - prev).toBeGreaterThanOrEqual(CHATTER.perBotCooldownMs);
      byBot.set(l.from, l.at);
    }
    expect(c.waiting).toBeLessThanOrEqual(CHATTER.maxPending);
  });

  it('with the real chances only some triggers speak', () => {
    const { c, players, t } = fresh(false);
    let lines = 0;
    for (let k = 0; k < 200; k++) {
      const at = t + k * 30_000; // every cooldown long past
      lines += run(c, players, at, 3000, [hit('bot:1', 'h', { killed: true })]).length;
    }
    // kill chance 0.3 (streaks raise it a little as the bot's life count grows): ~30–80 %.
    expect(lines).toBeGreaterThan(40);
    expect(lines).toBeLessThan(170);
  });
});

describe('round-2 review fixes', () => {
  it('a player name is masked when a bot says it', () => {
    const { c, players, t } = fresh();
    players[0]!.name = 'SH1T';
    players[0]!.x += 10;
    const lines: string[] = [];
    // Different bots, all chances 1: enough lines that several name the victim.
    for (let k = 0; k < 12; k++) {
      const bot = `bot:${(k % 4) + 1}`;
      const ev = [hit(bot, 'h', { killed: true })];
      lines.push(...run(c, players, t + k * 30_000, 3000, ev).map((l) => l.text));
    }
    expect(lines.length).toBeGreaterThan(6);
    expect(lines.some((l) => /SH1T/i.test(l))).toBe(false);
    expect(lines.some((l) => l.includes('****'))).toBe(true);
  });

  it('players who left are forgotten (long matches with many joins and leaves)', () => {
    const { c, players, t } = fresh();
    for (let k = 0; k < 2000; k++) {
      const guest: ChatterPlayer = { ...players[0]!, id: `guest:${k}`, name: `G${k}` };
      const now = t + k * 600;
      c.update(now, [...players, guest], [hit('bot:1', guest.id, { killed: true })], 'playing');
      c.update(now + 300, players, [], 'playing'); // gone again
    }
    expect(c.trackedPlayers).toBeLessThanOrEqual(players.length);
    c.forget('bot:1');
    expect(c.trackedPlayers).toBeLessThanOrEqual(players.length);
  });
});
