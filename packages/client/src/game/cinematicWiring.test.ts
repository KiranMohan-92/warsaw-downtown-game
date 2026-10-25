import { describe, expect, it } from 'vitest';
import { createPlayerState, PRIMARIES, type CombatEvent } from '@wd/shared';
import { CameraDirector, CINE } from '../camera/cameraDirector.ts';
import { blankPose, ReplayRecorder } from '../camera/poseRing.ts';
import { Game } from './Game.ts';

/** Production handlers on plain state (no renderer): see onlineCombat.test.ts. */
const proto = Game.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const call = (name: string, self: unknown, ...args: unknown[]) => proto[name]!.call(self, ...args);

const at = { x: 0, y: 1.2, z: 0 };
const killed = (by: string, zone: 'head' | 'torso' = 'head'): CombatEvent => ({
  type: 'hit',
  by,
  target: 'me',
  weapon: by === 'me' ? 'frag' : 'rifle',
  zone,
  dmg: 100,
  hp: 0,
  killed: true,
  at,
  from: { x: 30, y: 1.2, z: 40 },
});

const killInfo = {
  killer: 'bot',
  killerName: 'B',
  weapon: 'AR-7 rifle',
  distance: 5,
  headshot: false,
  killMs: 0,
};

function fakeGame() {
  const banners: string[] = [];
  const replay = new ReplayRecorder(6);
  return {
    banners,
    game: {
      director: new CameraDirector(),
      replay,
      scratchPose: blankPose(),
      frameLocalMs: 1000,
      onlineDeath: proto.onlineDeath,
      audio: { death: () => {}, hurt: () => {}, knifeHit: () => {} },
      hud: { damage: () => {}, banner: (t: string) => banners.push(t) },
      onlineBadge: { pushFeed: () => {} },
      camera: {},
      stats: { hits: 0 },
    },
    session: {
      nameOf: (id: string) => `<${id}>`,
      clock: { now: () => 5000 },
      serverNow: () => 5000,
      rtt: 100,
    },
  };
}

describe('Game camera moments wiring', () => {
  it("an online death starts the death cam with the killer's card and freezes the replay", () => {
    const { game, session, banners } = fakeGame();
    const pose = blankPose();
    pose.primary = 'coil';
    game.replay.recordRemote(1, 'bot', 4000, pose);
    call('onlineEvent', game, killed('bot'), 'me', session);
    const d = game.director;
    expect(d.mode).toBe('death');
    expect(d.kill).toMatchObject({
      killer: 'bot',
      killerName: '<bot>',
      weapon: PRIMARIES.coil.name,
      distance: 50,
      headshot: true,
      // The clock is fitted to arrivals: the event's arrival time is the blow's.
      killMs: 5000,
    });
    // The card names the killer: no duplicate banner.
    expect(banners).toEqual([]);
    // The replay window (up to the post-roll) is kept while the kill cam plays.
    const edge = 5000 + CINE.killcamPostRoll * 1000;
    expect(game.replay.self.push(edge - 1, blankPose())).toBe(true);
    expect(game.replay.self.push(edge + 100, blankPose())).toBe(false);
  });

  it('an own frag orbits the body and keeps the death banner', () => {
    const { game, session, banners } = fakeGame();
    call('onlineEvent', game, killed('me'), 'me', session);
    expect(game.director.kill?.killer).toBeNull();
    expect(banners).toHaveLength(1);
  });

  it('with the setting off, a death is plain first person with the banner', () => {
    const { game, session, banners } = fakeGame();
    game.director.setEnabled(false);
    call('onlineEvent', game, killed('bot'), 'me', session);
    expect(game.director.mode).toBe('play');
    expect(banners).toHaveLength(1);
  });

  it('a kill event that arrives after its respawn never keeps a living player in a death shot', () => {
    const director = new CameraDirector();
    director.died({ ...killInfo });
    const game = {
      director,
      cineEnabled: true,
      input: { consumeActivity: () => 0 },
      online: { currentLife: 3 },
      respawnTimer: 0,
      deathLife: 2, // the death belonged to the life before
      aliveInDeath: 0,
      lastFrameDt: 1 / 60,
      player: { health: 100 },
    };
    call('pollCinematicInput', game);
    expect(director.mode).toBe('play');
    // Same life, but alive (the stale event came first): let go after a second.
    director.died({ ...killInfo });
    game.deathLife = 3;
    for (let i = 0; i < 50; i++) call('pollCinematicInput', game);
    expect(director.deathShot).toBe(true);
    for (let i = 0; i < 20; i++) call('pollCinematicInput', game);
    expect(director.mode).toBe('play');
  });

  it('offline: a press after the pull-out respawns early; a look or the killing click does not', () => {
    const director = new CameraDirector();
    let respawns = 0;
    let activity: 0 | 1 | 2 = 2;
    const game = {
      director,
      cineEnabled: true,
      input: { consumeActivity: () => activity },
      online: null,
      respawnTimer: 2,
      player: { health: 0 },
      respawn: () => {
        respawns++;
        director.respawned();
      },
    };
    director.died({ ...killInfo, killer: null });
    call('pollCinematicInput', game); // the click that died
    expect(respawns).toBe(0);
    director.update(0.4);
    activity = 1; // looking around
    call('pollCinematicInput', game);
    expect(respawns).toBe(0);
    activity = 2;
    call('pollCinematicInput', game);
    expect(respawns).toBe(1);
    expect(director.mode).toBe('play');
  });

  it('the hidden local soldier is synced to the living player after a death (never left dead)', () => {
    const updates: { alive: boolean; dt: number }[] = [];
    const director = new CameraDirector();
    const move = {
      pos: { x: 1, y: 0, z: 2 },
      crouched: false,
      grounded: true,
      sprinting: false,
      board: false,
      prone: false,
    };
    const game = {
      director,
      cinematic: { eyeDistance: 5 },
      localSoldier: {
        root: { visible: false },
        update: (p: { alive: boolean }, dt: number) => updates.push({ alive: p.alive, dt }),
      },
      localSoldierStale: false,
      localPose: { alive: true },
      liveLocalPose: proto.liveLocalPose,
      replayMs: () => Number.NaN,
      boardUnder: { visible: false },
      player: { ...createPlayerState(move.pos), health: 0 },
      input: { yaw: 0, pitch: 0 },
    };
    // Dead, camera outside: drawn dead.
    director.died({ ...killInfo, killer: null });
    call('updateLocalSoldier', game, 1 / 60, move, move, 1);
    expect(game.localSoldier.root.visible).toBe(true);
    expect(updates.at(-1)).toEqual({ alive: false, dt: 1 / 60 });
    // Respawned: hidden at once, and reset to the living pose (once) although nobody sees it.
    director.respawned();
    game.player.health = 100;
    call('updateLocalSoldier', game, 1 / 60, move, move, 1);
    expect(game.localSoldier.root.visible).toBe(false);
    expect(updates.at(-1)).toEqual({ alive: true, dt: 0 });
    const n = updates.length;
    call('updateLocalSoldier', game, 1 / 60, move, move, 1);
    expect(updates).toHaveLength(n); // no per-frame work while hidden
  });

  it('the results phase starts the victory shot, the next match ends it', () => {
    const director = new CameraDirector();
    const game = {
      director,
      lastPhase: 'playing',
      grenades: [],
      hud: { banner: () => {} },
      stats: { kills: 0, deaths: 0 },
    };
    const session = (phase: 'playing' | 'ended') => ({
      id: 'me',
      takeCombat: () => [],
      takeDrops: () => [],
      nameOf: (id: string) => id,
      match: { phase, scores: [], winners: ['me'] },
    });
    call('onlineCombat', game, session('ended'));
    expect(director.mode).toBe('victory');
    call('onlineCombat', game, session('playing'));
    expect(director.mode).toBe('play');
  });
});
