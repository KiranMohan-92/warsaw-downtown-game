import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { createPlayerState } from '../sim/player.ts';
import { sanitizeInput } from '../sim/input.ts';
import {
  DropGunMessageOrNull,
  EndMatchMessageOrNull,
  MATCH_SCORE_LIMITS,
  MATCH_TIME_LIMITS,
  UNLIMITED,
  InputMessage,
  InputMessageOrNull,
  MATCH_NET,
  MAX_INPUT_SEQ,
  MatchPongOrNull,
  MatchSettingsUpdateOrNull,
  matchWinners,
  NameMessageOrNull,
  normalizeMatchOptions,
  parseMatchOptions,
  PingMessage,
  StartMatchMessageOrNull,
  sanitizeName,
  SNAP_SLOTS,
  SnapFlag,
} from './protocol.ts';
import { TokenBucket } from './rateLimit.ts';
import { applySnapshotMove, snapshotError, toSnapshotPlayer } from './snapshot.ts';

describe('DropGunMessage', () => {
  const valid = { primaryId: 'shotgun', x: 3, z: -22, ammoFraction: 0.5 };
  const parse = (value: unknown) => DropGunMessageOrNull['~standard'].validate(value).value;

  it('accepts only known guns, finite positions and fractions within one full load', () => {
    expect(parse(valid)).toEqual(valid);
    for (const patch of [
      { primaryId: 'sidearm' },
      { x: Infinity },
      { z: NaN },
      { ammoFraction: -0.1 },
      { ammoFraction: 1.01 },
      { ammoFraction: '1' },
    ])
      expect(parse({ ...valid, ...patch })).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse({})).toBeNull();
  });
});

describe('PingMessage', () => {
  it('accepts a finite timestamp', () => {
    expect(v.safeParse(PingMessage, { t: 12.5 }).success).toBe(true);
  });
  it('rejects non-numbers and non-finite values', () => {
    expect(v.safeParse(PingMessage, { t: 'x' }).success).toBe(false);
    expect(v.safeParse(PingMessage, { t: Infinity }).success).toBe(false);
    expect(v.safeParse(PingMessage, {}).success).toBe(false);
  });
});

describe('InputMessage', () => {
  const input = { seq: 3, moveX: 0, moveZ: 1, yaw: 0.5, pitch: -0.1, buttons: 5 };
  const ok = (m: unknown): boolean => v.safeParse(InputMessage, m).success;

  it('accepts a batch of well-typed inputs', () => {
    expect(ok({ inputs: [input] })).toBe(true);
    expect(
      ok({
        inputs: Array.from({ length: MATCH_NET.maxInputBatch }, (_, i) => ({ ...input, seq: i })),
      }),
    ).toBe(true);
  });

  it('accepts every sequence number sanitizeInput keeps unchanged', () => {
    expect(ok({ inputs: [{ ...input, seq: MAX_INPUT_SEQ }] })).toBe(true);
    expect(sanitizeInput({ ...input, seq: MAX_INPUT_SEQ }).seq).toBe(MAX_INPUT_SEQ);
  });

  it('rejects empty, oversized and malformed batches', () => {
    expect(ok({ inputs: [] })).toBe(false);
    expect(ok({ inputs: Array.from({ length: MATCH_NET.maxInputBatch + 1 }, () => input) })).toBe(
      false,
    );
    expect(ok({})).toBe(false);
    expect(ok({ inputs: input })).toBe(false);
    expect(ok({ inputs: [{ ...input, seq: 'x' }] })).toBe(false);
    expect(ok({ inputs: [{ ...input, seq: -1 }] })).toBe(false);
    expect(ok({ inputs: [{ ...input, seq: 1.5 }] })).toBe(false);
    // Beyond int32 `sanitizeInput` would wrap it (ack and seq would stop meaning the same thing).
    expect(ok({ inputs: [{ ...input, seq: MAX_INPUT_SEQ + 1 }] })).toBe(false);
    expect(ok({ inputs: [{ ...input, seq: Number.MAX_SAFE_INTEGER }] })).toBe(false);
    expect(ok({ inputs: [{ ...input, yaw: Infinity }] })).toBe(false);
    expect(ok({ inputs: [{ ...input, moveZ: NaN }] })).toBe(false);
    expect(ok({ inputs: [{ ...input, buttons: -4 }] })).toBe(false);
    const { pitch: _p, ...noPitch } = input;
    expect(ok({ inputs: [noPitch] })).toBe(false);
  });

  it('InputMessageOrNull: the valid message, or null (never throws) for anything else', () => {
    const check = (m: unknown): unknown => InputMessageOrNull['~standard'].validate(m).value;
    expect(check({ inputs: [input] })).toEqual({ inputs: [input] });
    expect(check({ inputs: [{ ...input, x: 1 }] })).toEqual({ inputs: [input] }); // stripped
    for (const bad of [undefined, null, 'run', { x: 999 }, { inputs: [] }]) {
      expect(check(bad)).toBeNull();
    }
  });

  it('never carries positions or hits: extra keys are stripped', () => {
    const r = v.safeParse(InputMessage, {
      inputs: [{ ...input, x: 999, hit: 'everyone' }],
      teleport: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.keys(r.output)).toEqual(['inputs']);
      expect(Object.keys(r.output.inputs[0]!).sort()).toEqual(
        ['buttons', 'moveX', 'moveZ', 'pitch', 'seq', 'yaw'].sort(),
      );
    }
  });
});

describe('match limits and End match', () => {
  it('limits are 1–100 kills / 60–3600 s, or the explicit string unlimited', () => {
    expect(parseMatchOptions({ scoreLimit: 'unlimited', timeLimit: 'unlimited' })).toMatchObject({
      scoreLimit: 'unlimited',
      timeLimit: 'unlimited',
    });
    expect(parseMatchOptions({ scoreLimit: 50, timeLimit: 900 })).toMatchObject({
      scoreLimit: 50,
      timeLimit: 900,
    });
    for (const bad of [0, 101, 2.5, Infinity, -1, 'Unlimited', 'inf', null])
      expect(parseMatchOptions({ scoreLimit: bad })).toBeNull();
    for (const bad of [59, 3601, Infinity, 'forever'])
      expect(parseMatchOptions({ timeLimit: bad })).toBeNull();
    expect(
      MatchSettingsUpdateOrNull['~standard'].validate({ timeLimit: 'unlimited' }).value,
    ).toEqual({ timeLimit: 'unlimited' });
    // The menus offer first to 25 in 10 min by default, and Unlimited for each.
    expect(MATCH_SCORE_LIMITS).toContain(25);
    expect(MATCH_SCORE_LIMITS).toContain(UNLIMITED);
    expect(MATCH_TIME_LIMITS).toContain(600);
    expect(MATCH_TIME_LIMITS).toContain(UNLIMITED);
  });

  it('End match is an empty command; anything else is refused', () => {
    expect(EndMatchMessageOrNull['~standard'].validate({}).value).toEqual({});
    expect(EndMatchMessageOrNull['~standard'].validate('end').value).toBeNull();
    expect(EndMatchMessageOrNull['~standard'].validate(null).value).toBeNull();
  });
});

describe('match options', () => {
  it('preserves neon night through practice and friend-room settings', () => {
    expect(parseMatchOptions({ weather: 'neon' })).toMatchObject({ weather: 'neon' });
    expect(
      normalizeMatchOptions({
        map: 'defilad',
        size: 'market',
        mode: 'standard',
        weather: 'neon',
      }).weather,
    ).toBe('neon');
    expect(MatchSettingsUpdateOrNull['~standard'].validate({ weather: 'neon' }).value).toEqual({
      weather: 'neon',
    });
  });

  it('defaults to the Market and validates every field', () => {
    expect(parseMatchOptions(undefined)).toMatchObject({
      map: 'defilad',
      size: 'market',
      mode: 'standard',
      weather: 'golden',
      radar: 'uplinks',
      botCount: 5,
      botBehaviour: 'ffa',
      botDifficulty: 'normal',
      scoreLimit: 25,
      timeLimit: 600,
      lobby: false,
    });
    expect(parseMatchOptions({ map: 'range', mode: 'knife', name: 'Kiran' })).toMatchObject({
      map: 'range',
      size: 'full',
      mode: 'knife',
      name: 'Kiran',
    });
    expect(
      normalizeMatchOptions({
        map: 'defilad',
        size: 'market',
        mode: 'standard',
        lobby: true,
        name: ' Kiran ',
      }),
    ).toMatchObject({ lobby: true, name: 'Kiran', botCount: 5 });
    expect(parseMatchOptions({ map: 'moon' })).toBeNull();
    expect(parseMatchOptions({ size: 3 })).toBeNull();
    expect(parseMatchOptions({ name: 'x'.repeat(65) })).toBeNull();
    expect(parseMatchOptions({ botCount: 6 })).toBeNull();
    expect(parseMatchOptions({ scoreLimit: 0 })).toBeNull();
    expect(parseMatchOptions({ timeLimit: 59 })).toBeNull();
  });

  it('host lobby messages validate settings without throwing or logging payloads', () => {
    const update = MatchSettingsUpdateOrNull['~standard'].validate({ botCount: 2, radar: 'off' });
    expect(update.value).toEqual({ botCount: 2, radar: 'off' });
    expect(MatchSettingsUpdateOrNull['~standard'].validate({ botCount: 8 }).value).toBeNull();
    expect(MatchSettingsUpdateOrNull['~standard'].validate({ weather: 'fog' }).value).toBeNull();
    expect(StartMatchMessageOrNull['~standard'].validate({}).value).toEqual({});
    expect(StartMatchMessageOrNull['~standard'].validate({ force: true }).value).toEqual({});
  });

  it('player names are printable, trimmed and short', () => {
    expect(sanitizeName('  Kiran  ', 'P')).toBe('Kiran');
    expect(sanitizeName('a\u0000b\u202Ec\nd', 'P')).toBe('abc d');
    expect(sanitizeName('x'.repeat(40), 'P')).toHaveLength(MATCH_NET.maxNameLength);
    expect(sanitizeName('   ', 'Player 2')).toBe('Player 2');
    expect(sanitizeName(42, 'Player 3')).toBe('Player 3');
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then the sustained rate, and drops the excess', () => {
    const b = new TokenBucket(60, 10, 0);
    let ok = 0;
    for (let i = 0; i < 25; i++) if (b.take(0)) ok++;
    expect(ok).toBe(10); // the burst
    expect(b.take(0)).toBe(false);
    // One second later: 60 more (capped by the burst size), then empty again.
    ok = 0;
    for (let i = 0; i < 25; i++) if (b.take(1000)) ok++;
    expect(ok).toBe(10);
    // Steady 60 Hz sending never trips it.
    const s = new TokenBucket(66, 30, 0);
    let dropped = 0;
    for (let i = 0; i < 600; i++) if (!s.take(i * (1000 / 60))) dropped++;
    expect(dropped).toBe(0);
    // 120 Hz sending (a speed hack) gets ~66/s through.
    const h = new TokenBucket(66, 30, 0);
    let through = 0;
    for (let i = 0; i < 1200; i++) if (h.take(i * (1000 / 120))) through++;
    expect(through).toBeGreaterThan(650);
    expect(through).toBeLessThan(700);
  });

  it('a clock going backwards never mints tokens', () => {
    const b = new TokenBucket(60, 2, 1000);
    expect(b.take(1000)).toBe(true);
    expect(b.take(1000)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(500)).toBe(false);
  });
});

describe('snapshots', () => {
  it('round-trip the movement state a client needs to replay', () => {
    const p = createPlayerState({ x: 1, y: 2, z: 3 });
    p.move.vel = { x: 4, y: -1, z: 0.5 };
    p.move.grounded = true;
    p.move.crouched = true;
    p.move.eyeHeight = 1.05;
    p.view = { yaw: 1.2, pitch: -0.3 };
    p.health = 73;
    const s = toSnapshotPlayer('a', p, 41, 2);
    expect(s).toMatchObject({ id: 'a', ack: 41, life: 2, hp: 73, eye: 1.05 });
    expect(s.f).toBe(SnapFlag.Grounded | SnapFlag.Crouched);

    const q = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(q, s);
    expect(q.move.pos).toEqual(p.move.pos);
    expect(q.move.vel).toEqual(p.move.vel);
    expect(q.move.grounded).toBe(true);
    expect(q.move.crouched).toBe(true);
    expect(q.view).toEqual(p.view);
    expect(q.health).toBe(73);
    expect(snapshotError(q, s)).toBe(0);
    q.move.pos.x += 0.25;
    expect(snapshotError(q, s)).toBeCloseTo(0.25, 9);
    expect(s.tt).toBe(-1);
  });

  it('carry the weapon in hand: a switch the server never saw is a mismatch, then corrected', () => {
    const server = createPlayerState({ x: 0, y: 0, z: 0 });
    server.arsenal.target = 'sidearm';
    server.arsenal.switchTimer = 0.2;
    server.arsenal.switchDuration = 0.35;
    const s = toSnapshotPlayer('a', server, 5, 0);
    expect(s).toMatchObject({ sl: SNAP_SLOTS.indexOf('rifle'), tg: SNAP_SLOTS.indexOf('sidearm') });
    // The client switched to the knife (its input never reached the server).
    const client = createPlayerState({ x: 0, y: 0, z: 0 });
    client.arsenal.slot = 'knife';
    client.arsenal.target = 'knife';
    expect(snapshotError(client, s)).toBe(Infinity);
    applySnapshotMove(client, s);
    expect(client.arsenal).toMatchObject({ slot: 'rifle', target: 'sidearm', switchTimer: 0.2 });
    expect(snapshotError(client, s)).toBe(0);
    // Same weapon, switch timer off by 0.05 s: an ordinary (finite) error.
    client.arsenal.switchTimer = 0.25;
    expect(snapshotError(client, s)).toBeCloseTo(0.05, 9);
  });

  it('carry climb progress, so a correction mid-vault keeps the client on the same path', () => {
    const path = { from: { x: 0, y: 0, z: 0 }, path: [], to: { x: 0, y: 1, z: -1 } };
    const server = createPlayerState({ x: 0, y: 0.5, z: -0.5 });
    server.move.traversal = { kind: 'vault', t: 0.3, dur: 0.5, dir: { x: 0, z: -1 }, ...path };
    const s = toSnapshotPlayer('a', server, 10, 0);
    expect(s.f & SnapFlag.Traversing).toBeTruthy();
    expect(s.tt).toBe(0.3);
    const client = createPlayerState({ x: 0, y: 0.2, z: -0.2 });
    client.move.traversal = { kind: 'vault', t: 0.1, dur: 0.5, dir: { x: 0, z: -1 }, ...path };
    applySnapshotMove(client, s);
    expect(client.move.traversal?.t).toBe(0.3);
    // The server finished climbing: the client's climb ends too.
    applySnapshotMove(
      client,
      toSnapshotPlayer('a', createPlayerState({ x: 0, y: 1, z: -1 }), 11, 0),
    );
    expect(client.move.traversal).toBeNull();
  });
});

describe('M3b messages', () => {
  const std =
    <T>(schema: {
      '~standard': { validate: (v: unknown) => { value: T | null } };
    }): ((v: unknown) => T | null) =>
    (x) =>
      schema['~standard'].validate(x).value;

  it('inputs may carry a finite view time (lag compensation), nothing else', () => {
    const input = { seq: 1, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons: 0 };
    const parse = std(InputMessageOrNull);
    expect(parse({ inputs: [{ ...input, vt: 1234.5 }] })?.inputs[0]?.vt).toBe(1234.5);
    expect(parse({ inputs: [input] })?.inputs[0]?.vt).toBeUndefined();
    expect(parse({ inputs: [{ ...input, vt: 'now' }] })).toBeNull();
    expect(parse({ inputs: [{ ...input, vt: Infinity }] })).toBeNull();
  });

  it('name changes: a string of bounded length, else null (the sender is kicked)', () => {
    const parse = std(NameMessageOrNull);
    expect(parse({ name: 'Ada' })).toEqual({ name: 'Ada' });
    expect(parse({ name: 'x'.repeat(65) })).toBeNull();
    expect(parse({ name: 42 })).toBeNull();
    expect(parse('Ada')).toBeNull();
  });

  it('ping echoes: a finite time, else null', () => {
    const parse = std(MatchPongOrNull);
    expect(parse({ t: 10.5 })).toEqual({ t: 10.5 });
    expect(parse({ t: Number.NaN })).toBeNull();
    expect(parse({})).toBeNull();
  });
});

describe('matchWinners', () => {
  const s = (id: string, kills: number, deaths: number) => ({ id, kills, deaths });
  it('most kills wins', () => {
    expect(matchWinners([s('a', 25, 9), s('b', 20, 2)])).toEqual(['a']);
  });
  it('level on kills: fewer deaths wins', () => {
    expect(matchWinners([s('a', 12, 5), s('b', 12, 3), s('c', 4, 0)])).toEqual(['b']);
  });
  it('level on kills and deaths: a shared win (Kiran)', () => {
    expect(matchWinners([s('a', 12, 3), s('b', 12, 3), s('c', 11, 0)])).toEqual(['a', 'b']);
  });
  it('zero-kill games use the same fewest-deaths and shared-win rules', () => {
    expect(matchWinners([s('a', 0, 2), s('b', 0, 0)])).toEqual(['b']);
    expect(matchWinners([s('a', 0, 0), s('b', 0, 0)])).toEqual(['a', 'b']);
    expect(matchWinners([])).toEqual([]);
  });
});
