import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DRONE,
  createPlayerState,
  isSpawnProtected,
  SnapFlag,
  toSnapshotPlayer,
  type CombatEvent,
  type ShotFired,
  type WireZone,
} from '@wd/shared';
import { OnlineSession } from '../net/onlineSession.ts';
import { Game, protectionShare, spottedBracketWorldPoints } from './Game.ts';

/** Exercise production event handlers with plain state, without a renderer or browser. */
const call = (name: string, self: unknown, ...args: unknown[]) =>
  (Game.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!.call(
    self,
    ...args,
  );

const vec = { x: 0, y: 0, z: 0 };
const shot: ShotFired = { yaw: 0, pitch: 0, spreadDeg: 0, seed: 1, shotCounter: 0 };

function combatHit(zone: WireZone, seq: number): CombatEvent {
  return {
    type: 'hit',
    by: 'me',
    target: 'them',
    weapon: 'rifle',
    zone,
    dmg: 25,
    hp: 75,
    killed: false,
    at: { x: 0, y: 1.2, z: -5 },
    from: { x: 0, y: 1.6, z: 0 },
    seq,
  };
}

function makeGame(remoteVisible: boolean, remoteFlags = 0, primary: 'ar7' | 'iskra' = 'ar7') {
  let visible = remoteVisible;
  let flags = remoteFlags;
  let remotePose = { x: 0, y: 0, z: -5, eye: 1.62, hp: 100, f: flags };
  let drones: {
    owner: string;
    pos: { x: number; y: number; z: number };
    yaw: number;
    battery: number;
  }[] = [];
  let worldHit: {
    distance: number;
    point: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
    visible: boolean;
    surface?: 'stone';
  } | null = null;
  const remotePlayerCalls: number[] = [];
  const remoteDroneCalls: number[] = [];
  const vehicleCalls: number[] = [];
  const hitmarkers: { zone: WireZone; killed: boolean }[] = [];
  const blocked: number[] = [];
  const numbers: number[] = [];
  const tracers: { x: number; y: number; z: number }[] = [];
  const impacts: { x: number; y: number; z: number }[] = [];
  const audioMarkers: { zone: WireZone; killed: boolean }[] = [];
  const game = {
    stats: { shots: 0, hits: 0, kills: 0, deaths: 0 },
    onlineShotMarkers: new Map(),
    frameLocalMs: 1234,
    frameViewTime: 9876,
    visibleSmoke: [],
    foliage: null,
    player: createPlayerState(vec, 1, 'standard', primary),
    physics: { castRay: () => worldHit },
    online: {
      remotePlayers: (localMs: number) => {
        remotePlayerCalls.push(localMs);
        return visible ? [{ id: 'them', pose: { ...remotePose, f: flags } }] : [];
      },
      remoteDrones: (localMs: number) => {
        remoteDroneCalls.push(localMs);
        return drones;
      },
      smokeAt: () => [],
      vehiclesAt: (viewMs: number) => {
        vehicleCalls.push(viewMs);
        return [];
      },
    },
    drawnVehicles: [],
    audio: {
      gunshot: () => {},
      iskraShot: () => {},
      coilShot: () => {},
      shotgunShot: () => {},
      marksmanShot: () => {},
      arcShot: () => {},
      bulletImpact: () => {},
      hurt: () => {},
      death: () => {},
      hitmarker: (zone: WireZone, killed: boolean) => audioMarkers.push({ zone, killed }),
      guardBlock: () => {},
      knifeHit: () => {},
    },
    viewmodel: { fire: () => {} },
    roll: { kick: () => {} },
    muzzle: new THREE.Vector3(),
    camera: { localToWorld: () => {} },
    effects: {
      tracer: (_from: unknown, to: { x: number; y: number; z: number }) =>
        tracers.push({ x: to.x, y: to.y, z: to.z }),
      impact: (point: { x: number; y: number; z: number }) =>
        impacts.push({ x: point.x, y: point.y, z: point.z }),
    },
    hud: {
      hitmarker: (zone: WireZone, killed: boolean) => hitmarkers.push({ zone, killed }),
      blockedMarker: () => blocked.push(1),
      damageNumber: (_at: unknown, dmg: number) => numbers.push(dmg),
    },
    settings: { damageNumbers: true },
    dummies: [],
    partner: null,
  };
  Object.setPrototypeOf(game, Game.prototype);
  return {
    game,
    hitmarkers,
    audioMarkers,
    blocked,
    numbers,
    setRemoteVisible: (next: boolean) => {
      visible = next;
    },
    setRemoteFlags: (next: number) => {
      flags = next;
    },
    setRemotePose: (next: Partial<typeof remotePose>) => {
      remotePose = { ...remotePose, ...next };
    },
    setDrones: (next: typeof drones) => {
      drones = next;
    },
    setWorldHit: (next: typeof worldHit) => {
      worldHit = next;
    },
    tracers,
    impacts,
    remotePlayerCalls,
    remoteDroneCalls,
    vehicleCalls,
  };
}

describe('Game online hitmarker prediction', () => {
  it('shows the authoritative nonlethal gun marker when the local shot had no prediction target', () => {
    const { game, hitmarkers, audioMarkers } = makeGame(false);

    call('fireShot', game, shot, 7);
    call('onlineEvent', game, combatHit('torso', 7), 'me', { nameOf: (id: string) => id });

    expect(hitmarkers).toEqual([{ zone: 'torso', killed: false }]);
    expect(audioMarkers).toEqual([{ zone: 'torso', killed: false }]);
  });

  it('does not duplicate a nonlethal gun marker when the local shot already predicted one', () => {
    const { game, hitmarkers, audioMarkers } = makeGame(true);

    call('fireShot', game, shot, 9);
    call('onlineEvent', game, combatHit('head', 9), 'me', { nameOf: (id: string) => id });

    expect(hitmarkers).toEqual([{ zone: 'head', killed: false }]);
    expect(audioMarkers).toEqual([{ zone: 'head', killed: false }]);
  });

  it('does not let an unconfirmed unpredicted shot duplicate a different predicted hit', () => {
    const { game, hitmarkers, audioMarkers, setRemoteVisible } = makeGame(false);

    call('fireShot', game, shot, 20);
    setRemoteVisible(true);
    call('fireShot', game, shot, 21);
    call('onlineEvent', game, combatHit('head', 21), 'me', { nameOf: (id: string) => id });

    expect(hitmarkers).toEqual([{ zone: 'head', killed: false }]);
    expect(audioMarkers).toEqual([{ zone: 'head', killed: false }]);
  });

  it('does not let an unconfirmed predicted shot suppress a different unpredicted confirmed hit', () => {
    const { game, hitmarkers, audioMarkers, setRemoteVisible } = makeGame(true);

    call('fireShot', game, shot, 20);
    setRemoteVisible(false);
    call('fireShot', game, shot, 21);
    call('onlineEvent', game, combatHit('torso', 21), 'me', { nameOf: (id: string) => id });

    expect(hitmarkers).toEqual([
      { zone: 'head', killed: false },
      { zone: 'torso', killed: false },
    ]);
    expect(audioMarkers).toEqual([
      { zone: 'head', killed: false },
      { zone: 'torso', killed: false },
    ]);
  });

  it('still upgrades an already predicted gun hit to a lethal marker', () => {
    const { game, hitmarkers, audioMarkers } = makeGame(true);
    const lethal = { ...combatHit('head', 30), killed: true, hp: 0 };

    call('fireShot', game, shot, 30);
    call('onlineEvent', game, lethal, 'me', { nameOf: (id: string) => id });

    expect(hitmarkers).toEqual([
      { zone: 'head', killed: false },
      { zone: 'head', killed: true },
    ]);
    expect(audioMarkers).toEqual([
      { zone: 'head', killed: false },
      { zone: 'head', killed: true },
    ]);
  });

  it('a shot at a protected player shows the blocked marker, never a hit, and no damage', () => {
    const { game, hitmarkers, audioMarkers, blocked, numbers } = makeGame(true, SnapFlag.Protected);
    const protectedHit = {
      ...combatHit('torso', 40),
      dmg: 0,
      hp: 100,
      outcome: 'protected' as const,
    };

    call('fireShot', game, shot, 40);
    expect(blocked).toHaveLength(1); // predicted from the shimmer flag
    call('onlineEvent', game, protectedHit, 'me', { nameOf: (id: string) => id });

    expect(blocked).toHaveLength(1); // the confirm does not repeat it
    expect(hitmarkers).toEqual([]);
    expect(audioMarkers).toEqual([]);
    expect(numbers).toEqual([]);
    expect((game as unknown as { stats: { hits: number } }).stats.hits).toBe(0);
  });

  it('an unpredicted blocked confirm (target not drawn yet) still shows the blocked marker', () => {
    const { game, hitmarkers, blocked, numbers } = makeGame(false);
    const protectedHit = {
      ...combatHit('head', 41),
      dmg: 0,
      hp: 100,
      outcome: 'protected' as const,
    };

    call('fireShot', game, shot, 41);
    call('onlineEvent', game, protectedHit, 'me', { nameOf: (id: string) => id });

    expect(blocked).toHaveLength(1);
    expect(hitmarkers).toEqual([]);
    expect(numbers).toEqual([]);
  });

  it('predicted blocked but the server hit (protection ended meanwhile): the real marker shows', () => {
    const { game, hitmarkers, audioMarkers, blocked } = makeGame(true, SnapFlag.Protected);

    call('fireShot', game, shot, 50);
    expect(blocked).toHaveLength(1);
    call('onlineEvent', game, combatHit('torso', 50), 'me', { nameOf: (id: string) => id });

    expect(hitmarkers).toEqual([{ zone: 'torso', killed: false }]);
    expect(audioMarkers).toEqual([{ zone: 'torso', killed: false }]);
    expect((game as unknown as { stats: { hits: number } }).stats.hits).toBe(1);
  });

  it('predicted a hit but the server blocked it (shimmer not drawn yet): the blocked marker shows', () => {
    const { game, hitmarkers, blocked, numbers } = makeGame(true);
    const protectedHit = {
      ...combatHit('head', 51),
      dmg: 0,
      hp: 100,
      outcome: 'protected' as const,
    };

    call('fireShot', game, shot, 51);
    expect(hitmarkers).toEqual([{ zone: 'head', killed: false }]);
    call('onlineEvent', game, protectedHit, 'me', { nameOf: (id: string) => id });

    expect(blocked).toHaveLength(1);
    expect(hitmarkers).toHaveLength(1); // no second hit marker
    expect(numbers).toEqual([]);
  });

  it('each shot keeps its own predicted kind', () => {
    const { game, hitmarkers, blocked, setRemoteFlags } = makeGame(true, SnapFlag.Protected);
    const protectedHit = {
      ...combatHit('torso', 60),
      dmg: 0,
      hp: 100,
      outcome: 'protected' as const,
    };

    call('fireShot', game, shot, 60); // blocked predicted
    setRemoteFlags(0);
    call('fireShot', game, shot, 61); // hit predicted
    call('onlineEvent', game, protectedHit, 'me', { nameOf: (id: string) => id });
    call('onlineEvent', game, combatHit('torso', 61), 'me', { nameOf: (id: string) => id });

    expect(blocked).toHaveLength(1); // shot 60: predicted blocked, confirmed blocked
    expect(hitmarkers).toEqual([{ zone: 'head', killed: false }]); // shot 61: predicted only
  });

  it('predicts a drone sphere blocking a remote player hit at the same view time', () => {
    const {
      game,
      hitmarkers,
      audioMarkers,
      numbers,
      tracers,
      setDrones,
      remotePlayerCalls,
      remoteDroneCalls,
      vehicleCalls,
    } = makeGame(true);
    setDrones([
      { owner: 'pilot', pos: { x: 0, y: 1.62, z: -2.5 }, yaw: 0, battery: DRONE.battery },
    ]);

    call('fireShot', game, shot, 70);

    expect(hitmarkers).toEqual([]);
    expect(audioMarkers).toEqual([]);
    expect(numbers).toEqual([]);
    expect((game as unknown as { stats: { hits: number } }).stats.hits).toBe(0);
    expect(tracers.at(-1)?.z).toBeGreaterThan(-2.35);
    expect(tracers.at(-1)?.z).toBeLessThan(-2.1);
    expect(remoteDroneCalls).toEqual([1234]);
    expect(remotePlayerCalls.length).toBeGreaterThan(0);
    expect(remotePlayerCalls.every((ms) => ms === 1234)).toBe(true);
    expect(vehicleCalls).toEqual([9876]);
  });

  it('traces an interpolated drone rather than its newer snapshot pose', () => {
    const { game, hitmarkers, tracers } = makeGame(true);
    const session = new OnlineSession();
    session.handleWelcome({
      id: 'me',
      map: 'range',
      size: 'full',
      mode: 'standard',
      tick: 0,
      tickHz: 60,
      spawn: { ...vec, yaw: 0 },
      seed: 1,
      primary: 'ar7',
    });
    const me = toSnapshotPlayer('me', game.player, -1, 0);
    const them = toSnapshotPlayer('them', createPlayerState({ ...vec, z: -5 }), -1, 0);
    for (let i = 0; i <= 6; i++) {
      const t = i * 2;
      session.handleSnapshot(
        {
          t,
          players: [me, them],
          drones: [['pilot', i - 3, 1.62, -2.5, 0, 255]],
        },
        (t * 1000) / 60 + 10,
      );
    }
    const localMs = 210;
    const viewMs = session.viewTime(localMs)!;
    expect(viewMs).toBeCloseTo(100, 1);
    expect(session.remoteDrones(localMs)[0]!.pos.x).toBeCloseTo(0, 1);
    Object.assign(game, { online: session, frameLocalMs: localMs, frameViewTime: viewMs });

    call('fireShot', game, shot, 74);

    expect(hitmarkers).toEqual([]);
    expect(tracers.at(-1)?.z).toBeGreaterThan(-2.35);
    expect(tracers.at(-1)?.z).toBeLessThan(-2.1);
  });

  it('keeps a closer remote player hit ahead of a farther drone', () => {
    const { game, hitmarkers, audioMarkers, tracers, setRemotePose, setDrones } = makeGame(true);
    setRemotePose({ z: -2 });
    setDrones([{ owner: 'pilot', pos: { x: 0, y: 1.62, z: -5 }, yaw: 0, battery: DRONE.battery }]);

    call('fireShot', game, shot, 71);

    expect(hitmarkers).toEqual([{ zone: 'head', killed: false }]);
    expect(audioMarkers).toEqual([{ zone: 'head', killed: false }]);
    expect(tracers.at(-1)?.z).toBeGreaterThan(-2.1);
    expect(tracers.at(-1)?.z).toBeLessThan(-1.2);
  });

  it('keeps world geometry blocking a drone prediction target', () => {
    const { game, hitmarkers, audioMarkers, tracers, impacts, setDrones, setWorldHit } =
      makeGame(false);
    setDrones([
      { owner: 'pilot', pos: { x: 0, y: 1.62, z: -2.5 }, yaw: 0, battery: DRONE.battery },
    ]);
    setWorldHit({
      distance: 1,
      point: { x: 0, y: 1.62, z: -1 },
      normal: { x: 0, y: 0, z: 1 },
      visible: true,
      surface: 'stone',
    });

    call('fireShot', game, shot, 72);

    expect(hitmarkers).toEqual([]);
    expect(audioMarkers).toEqual([]);
    expect(impacts).toEqual([{ x: 0, y: 1.62, z: -1 }]);
    expect(tracers.at(-1)).toEqual({ x: 0, y: 1.62, z: -1 });
  });

  it('does not let smart-round homing acquire a remote drone as sight', () => {
    const { game, hitmarkers, audioMarkers, tracers, setDrones } = makeGame(false, 0, 'iskra');
    setDrones([
      { owner: 'pilot', pos: { x: 0.6, y: 1.62, z: -20 }, yaw: 0, battery: DRONE.battery },
    ]);

    call('fireShot', game, shot, 73);

    expect(hitmarkers).toEqual([]);
    expect(audioMarkers).toEqual([]);
    expect(tracers.at(-1)?.z).toBeLessThan(-100);
  });
});

describe('Game offline first life', () => {
  it('the first offline life is spawn-protected (the chip shows it), online is left to the server', () => {
    const offline = { online: null, player: createPlayerState(vec), drawnVehicles: [] };
    call('startOfflineLife', offline);
    expect(isSpawnProtected(offline.player)).toBe(true);
    expect(protectionShare(offline.player)).toBe(1);
    const online = { online: {}, player: createPlayerState(vec) };
    call('startOfflineLife', online);
    expect(protectionShare(online.player)).toBe(0);
  });
});

describe('Game spotted bracket targets', () => {
  it('uses authoritative online spotted positions instead of live remote poses', () => {
    const live = [{ id: 'them', pos: { x: 9, y: 0, z: -9 } }];
    const spotted = [{ id: 'them', pos: { x: 1, y: 1.7, z: -2 } }];

    expect(spottedBracketWorldPoints(live, new Set(['them']), spotted)).toEqual([
      { x: 1, y: 1.7, z: -2 },
    ]);
  });

  it('does not leak online live poses while a hidden target remains spotted', () => {
    const movedLivePose = [{ id: 'them', pos: { x: 40, y: 0, z: -40 } }];
    const lastSeen = [{ id: 'them', pos: { x: 1, y: 1.7, z: -2 } }];

    expect(spottedBracketWorldPoints(movedLivePose, new Set(['them']), lastSeen)).toEqual([
      { x: 1, y: 1.7, z: -2 },
    ]);
  });

  it('clears online brackets when the authoritative spotted list is empty', () => {
    const live = [{ id: 'them', pos: { x: 9, y: 0, z: -9 } }];

    expect(spottedBracketWorldPoints(live, new Set(['them']), [])).toEqual([]);
  });

  it('keeps offline brackets on live local actors', () => {
    const live = [{ id: 'dummy', pos: { x: 4, y: 0, z: 0 } }];

    expect(spottedBracketWorldPoints(live, new Set(['dummy']), null)).toEqual([
      { x: 4, y: 1.2, z: 0 },
    ]);
  });

  it('wires render brackets through the authoritative spotted projection helper', () => {
    const source = readFileSync(new URL('./Game.ts', import.meta.url), 'utf8');

    expect(source).toContain('spottedBracketWorldPoints(everyone, spottedIds, spottedFromServer)');
  });
});
