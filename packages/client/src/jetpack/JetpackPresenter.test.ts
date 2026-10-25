import { createMoveState, SnapFlag } from '@wd/shared';
import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { JetpackSound } from './jetpackAudio.ts';
import type {
  JetFlyer,
  JetFrame,
  JetpackPresenter as Presenter,
  jetFlyersOf as FlyersOf,
  groundBelowAt as GroundBelowAt,
} from './JetpackPresenter.ts';

/** The client tests run in node without jsdom: just enough DOM for the HUD module to build. */
function fakeNode(): object {
  const base: Record<string | symbol, unknown> = {
    style: {},
    dataset: {},
    textContent: '',
    classList: { add() {}, remove() {}, toggle: () => true, contains: () => false },
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
}

let JetpackPresenter: typeof Presenter;
let jetFlyersOf: typeof FlyersOf;
let groundBelowAt: typeof GroundBelowAt;
beforeAll(async () => {
  vi.stubGlobal('document', {
    createElement: fakeNode,
    createElementNS: fakeNode,
  });
  ({ JetpackPresenter, jetFlyersOf, groundBelowAt } = await import('./JetpackPresenter.ts'));
});

function sound() {
  return {
    setOwn: vi.fn(),
    setRemote: vi.fn(),
    ignite: vi.fn(),
    cough: vi.fn(),
    beep: vi.fn(),
    cutoff: vi.fn(),
    land: vi.fn(),
    pickup: vi.fn(),
  };
}

function frame(others: JetFlyer[], s: ReturnType<typeof sound>): JetFrame {
  return {
    dt: 1 / 60,
    items: [],
    self: createMoveState({ x: 0, y: 0, z: 0 }),
    selfAlive: true,
    selfFeet: { x: 0, y: 0, z: 0 },
    yaw: 0,
    selfSoldier: null,
    firstPerson: true,
    others,
    ear: new THREE.Vector3(0, 1.6, 0),
    earYaw: 0,
    sound: s as unknown as JetpackSound,
    groundBelow: () => 3,
    jumpKey: 'Space',
  };
}

describe('remote flyers', () => {
  it('exhaust and engine stop at the out-of-fuel cutoff, not at the landing', () => {
    // Codex P2: a drop with Jump released serialized exactly like a hover, so the remote plume
    // and roar ran all the way down.
    const p = new JetpackPresenter(fakeNode() as HTMLElement, []);
    const s = sound();
    const flyer: JetFlyer = {
      id: 'b',
      x: 10,
      y: 3,
      z: 0,
      yaw: 0,
      f: SnapFlag.Jetpack | SnapFlag.JetFlight, // hovering (no thrust)
      alive: true,
      soldier: null,
    };
    for (let i = 0; i < 5; i++) p.frame(frame([flyer], s));
    expect(p.fx.stats.flames).toBeGreaterThan(0);
    // Voice 0 carries the flyer's engine.
    expect(s.setRemote.mock.calls.some((c) => c[0] === 0 && c[1] === true)).toBe(true);

    s.setRemote.mockClear();
    flyer.f = SnapFlag.Jetpack | SnapFlag.JetFlight | SnapFlag.JetDrop; // out of fuel
    p.frame(frame([flyer], s));
    expect(s.cutoff).toHaveBeenCalledTimes(1);
    expect(p.fx.stats.flames).toBe(0);
    expect(s.setRemote.mock.calls.every((c) => c[1] === false)).toBe(true);
    expect(s.land).not.toHaveBeenCalled();

    flyer.f = 0; // touched down
    p.frame(frame([flyer], s));
    expect(s.land).toHaveBeenCalledTimes(1);
  });

  it('flyers come from the list the soldiers are drawn from (the kill cam replay, not live)', () => {
    // Codex P2: in the kill cam the soldiers were replayed but the exhaust used live poses.
    const pose = (x: number, f: number) => ({ x, y: 2, z: 0, yaw: 0, f, hp: 100 });
    const replayed = [{ id: 'k', pose: pose(4, SnapFlag.Jetpack | SnapFlag.JetFlight) }];
    const out: JetFlyer[] = [
      { id: 'stale', x: 0, y: 0, z: 0, yaw: 0, f: 0, alive: true, soldier: null },
    ];
    const got = jetFlyersOf(replayed, () => null, out);
    expect(got).toBe(out);
    expect(got).toEqual([
      { id: 'k', x: 4, y: 2, z: 0, yaw: 0, f: replayed[0]!.pose.f, alive: true, soldier: null },
    ]);
  });

  it('the exhaust light pool lies on the floor under a low flyer, not under it (Codex P2)', () => {
    const p = new JetpackPresenter(fakeNode() as HTMLElement, []);
    const s = sound();
    // Flat floor at y = 0: the physics ray reports the distance from where it starts.
    const cast = (from: { y: number }) => ({ distance: from.y });
    const f = frame(
      [
        {
          id: 'b',
          x: 6,
          y: 1.5,
          z: 0,
          yaw: 0,
          f: SnapFlag.Jetpack | SnapFlag.JetFlight | SnapFlag.JetThrust,
          alive: true,
          soldier: null,
        },
      ],
      s,
    );
    for (let i = 0; i < 3; i++) p.frame({ ...f, groundBelow: (q) => groundBelowAt(cast, q) });
    const pools = p.fx.group.children.filter(
      (o) => o.visible && ((o as THREE.Mesh).material as THREE.Material).name === 'jetpack:pool',
    );
    expect(pools.length).toBeGreaterThan(0);
    for (const o of pools) expect(o.position.y).toBeCloseTo(0.03, 3); // just over the floor
  });
});
