import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createDummies,
  createPlayerState,
  type CombatEvent,
  type GrenadeState,
  type PlayerEvent,
  type ShotFired,
  type WorldHit,
} from '@wd/shared';
import { Game, warmDrawTiers } from './Game.ts';

/** Exercise production event handlers with plain state, without a renderer or browser. */
const call = (name: string, self: unknown, ...args: unknown[]) =>
  (Game.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!.call(
    self,
    ...args,
  );

const vec = { x: 0, y: 0, z: 0 };

describe('Game online combat authority', () => {
  it('draws a remote surface impact only when the visible world contact matches its authoritative endpoint', () => {
    const hits: unknown[][] = [];
    const tracers: unknown[][] = [];
    const audio: unknown[][] = [];
    const direction = new THREE.Vector3();
    let contact: WorldHit | null = {
      distance: 10,
      point: { x: 0, y: 1, z: -10 },
      normal: { x: 0, y: 0, z: 1 },
      surface: 'wood',
      visible: true,
    };
    const game = {
      remoteImpactDir: direction,
      physics: {
        castVisibleRay: (_from: unknown, dir: unknown, distance: number) => {
          expect(dir).toBe(direction);
          expect(distance).toBeCloseTo(10.005);
          expect(direction.toArray()).toEqual([0, 0, -1]);
          return contact;
        },
      },
      effects: {
        impact: (...args: unknown[]) => hits.push(args),
        tracer: (...args: unknown[]) => tracers.push(args),
      },
      remoteShotAudioQueue: { push: (...args: unknown[]) => audio.push(args) },
    };
    const shot: CombatEvent = {
      type: 'shot',
      by: 'them',
      slot: 'rifle',
      from: { x: 0, y: 1, z: 0 },
      to: { x: 0, y: 1, z: -10 },
    };
    const session = { nameOf: (id: string) => id };
    call('onlineEvent', game, shot, 'me', session);
    expect(hits).toEqual([[contact.point, contact.normal, 'wood']]);
    expect(tracers).toEqual([[shot.from, shot.to]]);
    expect(audio).toEqual([[shot.from, 'rifle']]);

    // A character ended the authoritative ray before the wall, or a movement helper intercepted it.
    contact = { ...contact, distance: 10.04 };
    call('onlineEvent', game, shot, 'me', session);
    // Endpoint precision still accepts the same surface after float/quantization noise.
    contact = { ...contact, distance: 10.004 };
    call('onlineEvent', game, shot, 'me', session);
    contact = { ...contact, distance: 10, visible: false };
    call('onlineEvent', game, shot, 'me', session);
    contact = null;
    call('onlineEvent', game, shot, 'me', session);
    call('onlineEvent', game, { ...shot, from: shot.to }, 'me', session);
    // Our own confirm must never duplicate the predicted world impact or tracer.
    call('onlineEvent', game, { ...shot, by: 'me' }, 'me', session);
    expect(hits).toHaveLength(2);
    expect(tracers).toHaveLength(6);
  });

  it('rejects remote impacts beyond the authoritative shotgun range endpoint', () => {
    const hits: unknown[][] = [];
    const direction = new THREE.Vector3();
    const game = {
      remoteImpactDir: direction,
      physics: {
        castVisibleRay: () => {
          return {
            distance: 60.04,
            point: { x: 0, y: 1, z: -60.04 },
            normal: { x: 0, y: 0, z: 1 },
            surface: 'stone',
            visible: true,
          } satisfies WorldHit;
        },
      },
      effects: {
        impact: (...args: unknown[]) => hits.push(args),
        tracer: () => {},
      },
      remoteShotAudioQueue: { push: () => {} },
    };
    const shot: CombatEvent = {
      type: 'shot',
      by: 'them',
      slot: 'rifle',
      from: { x: 0, y: 1, z: 0 },
      to: { x: 0, y: 1, z: -60 },
    };
    call('onlineEvent', game, shot, 'me', { nameOf: (id: string) => id });
    expect(hits).toEqual([]);
  });

  it('caps detailed shotgun impacts at three while keeping all nine world contacts and tracers', () => {
    const details: boolean[] = [];
    let tracers = 0;
    let impactSounds = 0;
    const game = {
      stats: { shots: 0 },
      player: createPlayerState(vec, 1, 'standard', 'shotgun'),
      online: null,
      drawnVehicles: [],
      targets: () => [],
      remoteDroneTargets: () => [],
      visibleSmoke: [],
      foliage: null,
      physics: {
        castRay: () => ({
          distance: 10,
          point: { x: 0, y: 1.62, z: -10 },
          normal: { x: 0, y: 0, z: 1 },
          visible: true,
          surface: 'stone',
        }),
      },
      audio: { shotgunShot: () => {}, bulletImpact: () => impactSounds++ },
      viewmodel: { fire: () => {} },
      roll: { kick: () => {} },
      muzzle: new THREE.Vector3(),
      camera: { localToWorld: () => {} },
      effects: {
        tracer: () => tracers++,
        impact: (_point: unknown, _normal: unknown, _surface: unknown, detail: boolean) =>
          details.push(detail),
      },
    };
    const shot: ShotFired = { yaw: 0, pitch: 0, seed: 12, spreadDeg: 0, shotCounter: 1 };
    call('fireShot', game, shot);
    expect(details).toEqual([true, true, true, false, false, false, false, false, false]);
    expect([tracers, impactSounds]).toEqual([9, 9]);
    call('fireShot', game, shot);
    expect(details.filter(Boolean)).toHaveLength(6); // Budget resets for each trigger pull.
  });

  it('targets excludes dummies and local sparring while online, using only drawn remotes', () => {
    const game = {
      online: {
        remotePlayers: () => [
          { id: 'bo', pose: { x: 1, y: 0, z: 2, eye: 1.62, hp: 100 } },
          { id: 'dead', pose: { x: 2, y: 0, z: 3, eye: 1.62, hp: 0 } },
        ],
      },
      dummies: createDummies([{ id: 'practice', pos: { ...vec }, yaw: 0 }]),
      partner: { alive: true, state: createPlayerState(vec) },
    };
    const targets = call('targets', game) as { id: string }[];
    expect(targets.map((t) => t.id)).toEqual(['remote:bo']);
  });

  it('handleEvent does not spawn a predicted frag while online', () => {
    const calls: string[] = [];
    const game = {
      online: {},
      grenades: [] as GrenadeState[],
      audio: { grenadeThrow: () => calls.push('throw') },
      effects: { addGrenade: (id: number) => calls.push(`grenade:${id}`) },
      player: createPlayerState(vec),
      physics: {},
      nextGrenadeId: 1,
    };
    call('handleEvent', game, {
      type: 'grenadeThrow',
      kind: 'frag',
      yaw: 0,
      pitch: 0,
    } satisfies PlayerEvent);
    expect(calls).toEqual(['throw']);
    expect(game.grenades).toEqual([]);
  });

  it('onlineEvent accepts the server nade and removes it on boom even when it is ours', () => {
    const added: number[] = [];
    const blasts: unknown[] = [];
    const game = {
      grenades: [] as GrenadeState[],
      effects: { addGrenade: (id: number) => added.push(id) },
      blastFx: (pos: unknown) => {
        blasts.push(pos);
        return 0;
      },
    };
    const session = { nameOf: (id: string) => id };
    call(
      'onlineEvent',
      game,
      {
        type: 'nade',
        id: 12,
        by: 'me',
        pos: { ...vec },
        vel: { x: 1, y: 2, z: 3 },
        fuse: 1,
      } satisfies CombatEvent,
      'me',
      session,
    );
    expect(added).toEqual([-12]);
    expect(game.grenades.map((g) => g.id)).toEqual([-12]);
    call(
      'onlineEvent',
      game,
      { type: 'boom', id: 12, by: 'me', pos: { x: 4, y: 0, z: 5 } } satisfies CombatEvent,
      'me',
      session,
    );
    expect(game.grenades).toEqual([]);
    expect(blasts).toEqual([{ x: 4, y: 0, z: 5 }]);
  });

  it('restores a frag with its remaining fuse and refreshes a known frag without another mesh', () => {
    const added: number[] = [];
    const game = {
      grenades: [] as GrenadeState[],
      effects: { addGrenade: (id: number) => added.push(id) },
    };
    const session = { nameOf: (id: string) => id };
    const restored: CombatEvent = {
      type: 'nade',
      id: 12,
      by: 'bo',
      pos: { x: 4, y: 0.1, z: 5 },
      vel: { ...vec },
      fuse: 0.8,
      resting: true,
    };
    call('onlineEvent', game, restored, 'me', session);
    expect(game.grenades).toEqual([
      {
        id: -12,
        owner: 0,
        pos: restored.pos,
        vel: restored.vel,
        fuse: 1.3, // The usual visual grace period still leaves explosions to server `boom`.
        resting: true,
        kind: 'frag',
      },
    ]);
    expect(game.grenades[0]!.pos).not.toBe(restored.pos);
    expect(game.grenades[0]!.vel).not.toBe(restored.vel);

    // Reconnect before it explodes: replace the stale local flight and fuse in place by id.
    call('onlineEvent', game, { ...restored, fuse: 0.2 }, 'me', session);
    expect(game.grenades).toHaveLength(1);
    expect(game.grenades[0]!.fuse).toBeCloseTo(0.7);
    expect(added).toEqual([-12]);
  });

  it('explode is visual-only online and never damages local practice entities', () => {
    const game = {
      online: {},
      stats: { hits: 0, kills: 0, deaths: 0 },
      player: createPlayerState(vec),
      dummies: createDummies([{ id: 'practice', pos: { ...vec }, yaw: 0 }]),
      blastFx: () => 7,
    };
    call('explode', game, {
      id: 1,
      owner: 0,
      pos: { ...vec },
      vel: { ...vec },
      fuse: 0,
      resting: false,
      kind: 'frag',
    } satisfies GrenadeState);
    expect(game.stats).toEqual({ hits: 0, kills: 0, deaths: 0 });
    expect(game.player.health).toBe(100);
    expect(game.dummies[0]!.health).toBe(100);
  });

  it('removes in-flight frags when the server ends the match', () => {
    const game = {
      lastPhase: 'playing',
      grenades: [{ kind: 'frag' }, { kind: 'smoke' }],
      hud: { banner: () => {} },
      stats: { kills: 0, deaths: 0 },
      director: { matchEnded: () => {}, matchStarted: () => {} },
    };
    call('onlineCombat', game, {
      id: 'me',
      takeCombat: () => [],
      takeDrops: () => [],
      nameOf: (id: string) => id,
      match: { phase: 'ended', scores: [], winners: [] },
    });
    expect(game.grenades).toEqual([{ kind: 'smoke' }]);
  });

  it('warmUp prebuilds grenade, smoke and jammer effects, compiles hidden objects, then cleans up', async () => {
    const hidden = { visible: false };
    const shown = { visible: true };
    const updates: unknown[] = [];
    const grenades: number[] = [];
    let compileCalls = 0;
    let uploads = 0;
    const tiers: unknown[] = [];
    let target: THREE.WebGLRenderTarget | null = null;
    let postWarms = 0;
    const scene = {
      traverse: (fn: (o: { visible: boolean }) => void) => [hidden, shown].forEach(fn),
    };
    const viewScene = { traverse: (fn: (o: { visible: boolean }) => void) => [shown].forEach(fn) };
    let impactWarm = 0;
    let impactRestored = 0;
    let dropsWarm = 0;
    let dropsRestored = 0;
    // Auto from High (nothing remembered): the governor can step down to Medium and Low.
    const tier = { quality: 'high' };
    const qualities: unknown[] = [];
    const drawnAt: unknown[] = [];
    const game = {
      // Actor contact shadows: warm-up uploads their texture (none in this fake).
      actorContacts: { mesh: { material: { map: null } } },
      smokeView: { update: (...a: unknown[]) => updates.push(['smoke', ...a]) },
      jammerFx: {
        pulse: (pos: unknown) => updates.push(['pulse', pos]),
        update: (dt: number) => updates.push(['jammerUpdate', dt]),
      },
      effects: {
        // Every impact buffer must draw during both tier compiles and the real-path upload.
        beginWarmUp: () => {
          impactWarm++;
          return () => impactRestored++;
        },
        addGrenade: (id: number) => grenades.push(id),
        update: (...a: unknown[]) => updates.push(['effects', ...a]),
      },
      weaponDropView: {
        beginWarmUp: () => {
          dropsWarm++;
          return () => dropsRestored++;
        },
      },
      scene,
      camera: {},
      get quality() {
        return tier.quality;
      },
      // The whole tier (shadows, post chain, tone mapping, world, Low recompile) goes through it.
      setQuality: (q: string) => {
        qualities.push(q);
        tier.quality = q;
      },
      setWorldQuality: (q: unknown) => tiers.push(q),
      // The real-path draw of everything happens while hidden objects are still shown.
      uploadAllGeometry: () => {
        expect(hidden.visible).toBe(true);
        expect([impactWarm, impactRestored]).toEqual([1, 0]);
        expect([dropsWarm, dropsRestored]).toEqual([1, 0]);
        drawnAt.push(tier.quality);
        uploads++;
      },
      viewmodel: { scene: viewScene, camera: {} },
      appliedQualitySetting: 'auto',
      // Every post tier compiles during warm-up (a later tier change only selects a chain).
      post: {
        lowTarget: target,
        prepass: { warm: () => {} },
        warmLowPresent: () => {},
        warmTiers: () => {
          expect(hidden.visible).toBe(true);
          // The post chains warm with the start tier active again.
          expect(tier.quality).toBe('high');
          postWarms++;
        },
      },
      renderer: {
        toneMapping: THREE.NoToneMapping,
        initTexture: () => {},
        getRenderTarget: () => target,
        getActiveCubeFace: () => 0,
        getActiveMipmapLevel: () => 0,
        setRenderTarget: (next: THREE.WebGLRenderTarget | null) => {
          target = next;
        },
        compileAsync: (root: unknown) => {
          if (root === scene || root === viewScene) compileCalls++;
          expect(grenades).toEqual([0]);
          expect(hidden.visible).toBe(true);
          expect([impactWarm, impactRestored]).toEqual([1, 0]);
          expect([dropsWarm, dropsRestored]).toEqual([1, 0]);
          return Promise.resolve();
        },
      },
    };
    const progress: number[] = [];
    await (call('warmUp', game, (done: number) => progress.push(done)) as Promise<void>);
    expect([impactWarm, impactRestored]).toEqual([1, 1]);
    expect([dropsWarm, dropsRestored]).toEqual([1, 1]);
    expect(grenades).toEqual([0]);
    expect(compileCalls).toBe(4);
    // Drawn through at every tier Auto may pick, the start tier last (and still active).
    expect(drawnAt).toEqual(['medium', 'low', 'high']);
    expect(uploads).toBe(3);
    expect(qualities.at(-1)).toBe('high');
    expect(tier.quality).toBe('high');
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p > progress[i - 1]!)).toBe(true);
    expect(postWarms).toBe(1);
    expect(tiers).toEqual(['low', 'medium', 'high']);
    expect(target).toBeNull();
    expect(hidden.visible).toBe(false);
    expect(updates.at(-2)).toEqual(['jammerUpdate', 10]);
    expect(updates.at(-1)).toEqual(['effects', 0, []]);
  });

  it('warm-up draws every tier Auto can step down to, ending on the start tier', () => {
    expect(warmDrawTiers('auto', 'high')).toEqual(['medium', 'low', 'high']);
    expect(warmDrawTiers('auto', 'medium')).toEqual(['low', 'medium']);
    expect(warmDrawTiers('auto', 'ultra')).toEqual(['high', 'medium', 'low', 'ultra']);
    // Auto remembered at Low (it only probes up, rarely) and fixed tiers draw once.
    expect(warmDrawTiers('auto', 'low')).toEqual(['low']);
    expect(warmDrawTiers('high', 'high')).toEqual(['high']);
    expect(warmDrawTiers('low', 'low')).toEqual(['low']);
    expect(warmDrawTiers(null, 'high')).toEqual(['high']);
  });
});
