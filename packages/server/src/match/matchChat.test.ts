import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAT, initPhysics, SIM, type ChatMessage } from '@wd/shared';
import { launchPractice, type PracticePort } from '../../../client/src/net/practiceRoom.ts';
import { DEFAULT_SETTINGS } from '../../../client/src/settings/settings.ts';
import { PRACTICE_PLAYER_ID, PracticeHost, type PracticeInit } from '../practice/practiceHost.ts';
import { callName, chatSeed, MatchChat, simSource, type ChatSource } from './matchChat.ts';
import { MatchSim } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

const sims: MatchSim[] = [];
afterEach(() => {
  for (const s of sims.splice(0)) s.dispose();
});

function chatRoom(): { sim: MatchSim; chat: MatchChat } {
  const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 0 });
  sims.push(sim);
  sim.addPlayer('a', 'Ania', 0);
  sim.addPlayer('b', 'Bartek', 0);
  return { sim, chat: new MatchChat(simSource(sim), { seed: 1 }) };
}

/** Advance the match clock (the chat's time) by `ms`. */
const wait = (sim: MatchSim, ms: number): void => {
  sim.runTicks(Math.round((ms / 1000) * SIM.tickHz));
};

describe('player chat (server side)', () => {
  it('a line is cleaned, masked and stamped with the sender; a preset travels as its id', () => {
    const { chat } = chatRoom();
    const out = chat.fromPlayer('a', { text: '  oh   shit\u0000 <b>hi</b>  ' });
    expect(out.sender).toBeNull();
    expect(out.all).toMatchObject({
      from: 'a',
      name: 'Ania',
      slot: 0,
      kind: 'player',
      text: 'oh **** <b>hi</b>',
    });
    const quick = chat.fromPlayer('b', { quick: 'gg' });
    expect(quick.all).toMatchObject({ from: 'b', name: 'Bartek', kind: 'quick', quick: 'gg' });
    expect(quick.all?.text).toBeUndefined();
    expect(quick.all!.id).toBeGreaterThan(out.all!.id);
  });

  it('blank lines, unknown senders and bots say nothing', () => {
    const { chat } = chatRoom();
    expect(chat.fromPlayer('a', { text: ' \n​ ' }).all).toBeNull();
    expect(chat.fromPlayer('ghost', { text: 'hi' }).all).toBeNull();
  });

  it(`token bucket: a burst of ${CHAT.burst}, then a notice to the sender only, then refills`, () => {
    const { sim, chat } = chatRoom();
    for (let i = 0; i < CHAT.burst; i++)
      expect(chat.fromPlayer('a', { text: `line ${i}` }).all).not.toBeNull();
    const refused = chat.fromPlayer('a', { text: 'one too many' });
    expect(refused.all).toBeNull();
    expect(refused.sender).toMatchObject({ kind: 'system', from: '' });
    // One notice per while, not per refused line.
    expect(chat.fromPlayer('a', { text: 'again' })).toEqual({ all: null, sender: null });
    // Others have their own bucket.
    expect(chat.fromPlayer('b', { text: 'me too' }).all).not.toBeNull();
    wait(sim, 1000 / CHAT.ratePerSec + 50);
    expect(chat.fromPlayer('a', { text: 'back' }).all).not.toBeNull();
    expect(chat.fromPlayer('a', { text: 'and again' }).all).toBeNull();
  });

  it('the same line twice within the repeat window is dropped (no bucket spent)', () => {
    const { sim, chat } = chatRoom();
    expect(chat.fromPlayer('a', { quick: 'tooEasy' }).all).not.toBeNull();
    expect(chat.fromPlayer('a', { quick: 'tooEasy' }).all).toBeNull();
    expect(chat.fromPlayer('a', { quick: 'gg' }).all).not.toBeNull();
    wait(sim, CHAT.repeatWindowMs + 100);
    expect(chat.fromPlayer('a', { quick: 'tooEasy' }).all).not.toBeNull();
  });

  it('works before a match exists (a lobby): seats chat on the room clock, bots stay quiet', () => {
    let now = 0;
    const seats = new Map([
      ['a', 'Ania'],
      ['b', 'Player 2'],
    ]);
    const lobby: ChatSource = {
      sender: (id) =>
        seats.has(id)
          ? { name: seats.get(id)!, slot: [...seats.keys()].indexOf(id), bot: false }
          : null,
      now: () => now,
    };
    const chat = new MatchChat(lobby, { seed: 3 });
    expect(chat.fromPlayer('a', { text: 'ready?' }).all).toMatchObject({ name: 'Ania', slot: 0 });
    expect(chat.fromPlayer('b', { quick: 'isThatAll' }).all).toMatchObject({
      kind: 'quick',
      slot: 1,
    });
    expect(chat.fromPlayer('nobody', { text: 'hi' }).all).toBeNull();
    for (let i = 0; i < CHAT.burst; i++) chat.fromPlayer('a', { text: `x${i}` });
    expect(chat.fromPlayer('a', { text: 'flood' }).all).toBeNull();
    now += 1000 / CHAT.ratePerSec + 10;
    expect(chat.fromPlayer('a', { text: 'later' }).all).not.toBeNull();
    // The match starts: lobby taunts are forgotten, not answered once bots arrive.
    chat.forgetHeard();
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', botCount: 2 });
    sims.push(sim);
    sim.addPlayer('b', 'Player 2', 0);
    const said: string[] = [];
    for (let t = 0; t < 4; t++) {
      sim.runTicks(SIM.tickHz);
      said.push(...chat.afterStep(sim, []).map((m) => m.text ?? ''));
    }
    expect(said.every((line) => !/Is that all|Big words|Keep talking/.test(line))).toBe(true);
  });

  it('bots call a player with no name of their own "rookie"', () => {
    expect(callName('You')).toBe('rookie');
    expect(callName('Player 3')).toBe('rookie');
    expect(callName('Kiran')).toBe('Kiran');
    expect(callName('Player Three')).toBe('Player Three');
  });

  it('remove() forgets the player everywhere, the chatter included', () => {
    const { sim, chat } = chatRoom();
    chat.fromPlayer('a', { quick: 'isThatAll' });
    chat.afterStep(sim, []);
    sim.removePlayer('a');
    chat.remove('a');
    chat.afterStep(sim, []);
    expect(chat.chatter.trackedPlayers).toBeLessThanOrEqual(sim.players.size);
  });

  it('room seeds are stable per room id', () => {
    expect(chatSeed('AbCd12')).toBe(chatSeed('AbCd12'));
    expect(chatSeed('AbCd12')).not.toBe(chatSeed('AbCd13'));
  });
});

// The test range: a small world (the Market's Rapier world + nav graph cost seconds to build).
const SETTINGS = {
  map: 'range',
  size: 'full',
  mode: 'standard',
  weather: 'sunny',
  radar: 'uplinks',
  botCount: 3,
  botBehaviour: 'ffa',
  botDifficulty: 'normal',
  scoreLimit: 'unlimited',
  timeLimit: 'unlimited',
  vehicles: 'off',
} as const satisfies PracticeInit['settings'];

function practice(init: Partial<PracticeInit> = {}): {
  h: PracticeHost;
  chats: () => ChatMessage[];
} {
  const sent: { type: string; msg: unknown }[] = [];
  const h = new PracticeHost(
    { settings: SETTINGS, name: 'Kiran', chatSeed: 5, ...init },
    (type, msg) => sent.push({ type, msg: structuredClone(msg) }),
  );
  return {
    h,
    chats: () => sent.filter((m) => m.type === 'chat').map((m) => m.msg as ChatMessage),
  };
}

describe('practice chat (page → worker → page)', () => {
  it('your lines come back stamped; junk is dropped; bots talk and answer quick chat', () => {
    const { h, chats } = practice();
    try {
      h.receive('ready', {}, 0);
      h.receive('chat', { text: 'hello bots' }, 0);
      h.receive('chat', { text: 42 }, 0);
      h.receive('chat', { quick: 'notAPreset' }, 0);
      expect(chats()).toMatchObject([
        { from: PRACTICE_PLAYER_ID, kind: 'player', text: 'hello bots' },
      ]);
      // A taunt every few seconds; bots answer some (and greet the match).
      for (const [i, quick] of (['isThatAll', 'comeAtMe', 'tooEasy', 'truce'] as const).entries()) {
        h.step(1, false);
        h.receive('chat', { quick }, i);
        h.step(Math.round(6 * SIM.tickHz), false);
      }
      const bot = chats().filter((m) => m.kind === 'bot');
      expect(bot.length).toBeGreaterThan(0);
      for (const m of bot) {
        expect(m.from).toMatch(/^bot:/);
        expect(m.persona).toBeDefined();
        expect(m.text?.length).toBeGreaterThan(0);
      }
      expect(chats().filter((m) => m.kind === 'quick')).toHaveLength(4);
    } finally {
      h.dispose();
    }
  });

  it('Bot chatter: off keeps the bots quiet (your own lines still work)', () => {
    const { h, chats } = practice({ settings: { ...SETTINGS, botChatter: 'off' } });
    try {
      h.receive('ready', {}, 0);
      for (const quick of ['isThatAll', 'truce', 'comeAtMe'] as const) {
        h.receive('chat', { quick }, 0);
        h.step(Math.round(6 * SIM.tickHz), false);
      }
      expect(chats().filter((m) => m.kind === 'bot')).toEqual([]);
      expect(chats().filter((m) => m.kind === 'quick')).toHaveLength(3);
    } finally {
      h.dispose();
    }
  });
});

describe('practice chat through the page’s room (PracticeRoom ↔ worker)', () => {
  it('the page sends a quick chat, the worker echoes it and the bots chat back', async () => {
    let h: PracticeHost | null = null;
    let init: PracticeInit | null = null;
    const pending: (() => void)[] = [];
    const port: PracticePort = {
      onmessage: null,
      postMessage: (raw) => {
        const data = structuredClone(raw) as { type: string; msg?: unknown; init?: PracticeInit };
        if (data.type === 'init') {
          init = { ...data.init!, chatSeed: 11 };
          h = new PracticeHost(init, (type, msg) => {
            const copy = structuredClone({ type, msg });
            pending.push(() => port.onmessage?.({ data: copy }));
          });
        } else if (data.type !== 'run' && data.type !== 'stop') h?.receive(data.type, data.msg, 0);
      },
      terminate: () => {
        h?.dispose();
        h = null;
      },
    };
    const { room } = launchPractice(
      { ...DEFAULT_SETTINGS, map: 'range', mapSize: 'full', botCount: 3, botChatter: 'on' },
      () => port,
    );
    const got: ChatMessage[] = [];
    room.onMessage('chat', (m: ChatMessage) => got.push(m));
    const pump = async (ticks: number): Promise<void> => {
      h?.step(ticks, false);
      for (const f of pending.splice(0)) f();
      await new Promise((r) => setTimeout(r, 0));
    };
    try {
      expect(init!.settings.botChatter).toBe('on');
      room.send('ready', {});
      for (const quick of ['isThatAll', 'truce', 'comeAtMe', 'tooEasy'] as const) {
        room.send('chat', { quick });
        for (let s = 0; s < 6; s++) await pump(SIM.tickHz);
      }
      expect(got.filter((m) => m.kind === 'quick').map((m) => m.quick)).toEqual([
        'isThatAll',
        'truce',
        'comeAtMe',
        'tooEasy',
      ]);
      expect(got.some((m) => m.kind === 'bot')).toBe(true);
    } finally {
      await room.leave();
    }
  });

  it('the menu’s Bot chatter setting rides into the practice match', () => {
    const port: PracticePort = { onmessage: null, postMessage: () => {}, terminate: () => {} };
    const { settings } = launchPractice({ ...DEFAULT_SETTINGS, botChatter: 'off' }, () => port);
    expect(settings.botChatter).toBe('off');
  });
});
