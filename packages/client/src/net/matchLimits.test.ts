import { describe, expect, it } from 'vitest';
import type { MatchStateMessage, WelcomeMessage } from '@wd/shared';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../settings/settings.ts';
import { matchGoal, matchLine } from './combatFeed.ts';
import {
  friendSettingsFromGameSettings,
  limitOptions,
  lobbySettingsPatch,
  scoreLimitLabel,
  timeLimitLabel,
} from './friendLobby.ts';
import { onlineStatusText } from './onlineBadge.ts';
import { OnlineSession } from './onlineSession.ts';
import { practiceRequested, practiceSettings, practiceUrl } from './practiceRoom.ts';

const playing: MatchStateMessage = {
  phase: 'playing',
  endsAt: null,
  scoreLimit: 'unlimited',
  scores: [],
  winners: [],
};
const welcome: WelcomeMessage = {
  id: 'me',
  map: 'range',
  size: 'full',
  mode: 'standard',
  tick: 0,
  tickHz: 60,
  spawn: { x: 0, y: 0, z: 0, yaw: 0 },
  seed: 1,
  primary: 'ar7',
};

describe('match limits: unlimited score and time', () => {
  it('the goal reads ∞ for each unlimited limit, independently', () => {
    expect(matchGoal(playing, null)).toBe('first to ∞ · ∞');
    expect(matchGoal({ scoreLimit: 25, endsAt: null }, null)).toBe('first to 25 · ∞');
    expect(matchGoal({ scoreLimit: 'unlimited', endsAt: 9000 }, 300)).toBe('first to ∞ · 5:00');
    expect(matchGoal({ scoreLimit: 25, endsAt: 9000 }, null)).toBe('first to 25');
    expect(matchLine({ ...playing, scoreLimit: 10 }, 'me', (id) => id, null)).toBe(
      'You 0 K / 0 D · first to 10 · ∞',
    );
  });

  it('no clock while a match without a time limit is played', () => {
    const s = new OnlineSession();
    s.handleWelcome(welcome);
    s.handleMatch(playing);
    s.handleSnapshot({ t: 100, players: [] }, 0);
    expect(s.phaseSecondsLeft(50_000)).toBeNull();
    s.handleMatch({ ...playing, endsAt: 100 + 600 });
    expect(s.phaseSecondsLeft(0)).toBeCloseTo(10, 0);
  });

  it('lobby form values go through the server schema (Unlimited is a string, never NaN)', () => {
    expect(lobbySettingsPatch('scoreLimit', 'unlimited')).toEqual({ scoreLimit: 'unlimited' });
    expect(lobbySettingsPatch('timeLimit', 'unlimited')).toEqual({ timeLimit: 'unlimited' });
    expect(lobbySettingsPatch('scoreLimit', '50')).toEqual({ scoreLimit: 50 });
    expect(lobbySettingsPatch('timeLimit', '900')).toEqual({ timeLimit: 900 });
    expect(lobbySettingsPatch('timeLimit', '30')).toBeNull();
    expect(lobbySettingsPatch('scoreLimit', '0')).toBeNull();
    expect(lobbySettingsPatch('scoreLimit', 'Infinity')).toBeNull();
    expect(lobbySettingsPatch('botDifficulty', 'hard')).toEqual({ botDifficulty: 'hard' });
    expect(lobbySettingsPatch('botDifficulty', 'insane')).toBeNull();
  });

  it('limit menus: the presets, plus an odd current value; labels', () => {
    expect(limitOptions([10, 25, 50, 'unlimited'], 25, scoreLimitLabel)).toEqual([
      ['10', '10'],
      ['25', '25'],
      ['50', '50'],
      ['unlimited', 'Unlimited'],
    ]);
    expect(limitOptions([10, 25], 7, scoreLimitLabel).at(-1)).toEqual(['7', '7']);
    expect(timeLimitLabel(600)).toBe('10 min');
    expect(timeLimitLabel(90)).toBe('1.5 min');
    expect(timeLimitLabel('unlimited')).toBe('Unlimited');
  });

  it('settings keep valid limits, bot count and difficulty; junk falls back (first to 25)', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      scoreLimit: 25,
      timeLimit: 600,
      botCount: 5,
      botDifficulty: 'normal',
    });
    expect(
      sanitizeSettings({ scoreLimit: 'unlimited', timeLimit: 'unlimited', botDifficulty: 'hard' }),
    ).toMatchObject({ scoreLimit: 'unlimited', timeLimit: 'unlimited', botDifficulty: 'hard' });
    expect(
      sanitizeSettings({ scoreLimit: 0, timeLimit: 5, botDifficulty: 'legend', botCount: 9 }),
    ).toMatchObject({ scoreLimit: 25, timeLimit: 600, botDifficulty: 'normal', botCount: 5 });
    expect(sanitizeSettings({ scoreLimit: 2.5, timeLimit: Infinity })).toMatchObject({
      scoreLimit: 25,
      timeLimit: 600,
    });
  });

  it('a new friend room starts from the menu choices', () => {
    expect(
      friendSettingsFromGameSettings({
        ...DEFAULT_SETTINGS,
        scoreLimit: 'unlimited',
        timeLimit: 300,
        botDifficulty: 'easy',
        botCount: 2,
      }),
    ).toMatchObject({
      scoreLimit: 'unlimited',
      timeLimit: 300,
      botDifficulty: 'easy',
      botCount: 2,
    });
  });
});

describe('practice match entry', () => {
  it('?practice turns it on for this page only', () => {
    expect(practiceRequested('?practice')).toBe(true);
    expect(practiceRequested('?practice=1&autotest')).toBe(true);
    expect(practiceRequested('?practice=0')).toBe(false);
    expect(practiceRequested('?online')).toBe(false);
    const on = practiceUrl('http://h/?online&room=X&map=defilad', true);
    expect(new URL(on).searchParams.get('practice')).toBe('1');
    expect(new URL(on).searchParams.has('online')).toBe(false);
    expect(new URL(on).searchParams.has('room')).toBe(false);
    expect(new URL(on).searchParams.get('map')).toBe('defilad');
    expect(new URL(practiceUrl(on, false)).searchParams.has('practice')).toBe(false);
  });

  it('plays the menu choices as a fair FFA', () => {
    expect(
      practiceSettings({ ...DEFAULT_SETTINGS, botDifficulty: 'hard', botCount: 3, timeLimit: 900 }),
    ).toMatchObject({
      map: 'defilad',
      size: 'market',
      botBehaviour: 'ffa',
      botDifficulty: 'hard',
      botCount: 3,
      timeLimit: 900,
      scoreLimit: 25,
    });
  });

  it('the badge names the practice match instead of a connection', () => {
    const s = new OnlineSession();
    s.handleWelcome(welcome);
    expect(onlineStatusText(s, 'PRACTICE · 5 bots · NORMAL')).toBe('PRACTICE · 5 bots · NORMAL');
    expect(onlineStatusText(s)).toContain('online');
  });
});
