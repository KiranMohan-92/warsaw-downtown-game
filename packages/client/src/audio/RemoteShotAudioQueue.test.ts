import { describe, expect, it, vi } from 'vitest';
import { getMap, initPhysics, PhysicsWorld, resolveMap, type WorldRaycaster } from '@wd/shared';
import { RemoteShotAudioQueue, type RemoteShotKind } from './RemoteShotAudioQueue.ts';
import { blastAcoustics, type BlastContext } from './blastAcoustics.ts';

describe('remote shot listener timing and cover', () => {
  it('muffles the actual Market hall wall while its open doorway stays audible', async () => {
    await initPhysics();
    const world = new PhysicsWorld(resolveMap(getMap('defilad'), 'market'));
    try {
      const queue = new RemoteShotAudioQueue();
      const contexts: BlastContext[] = [];
      for (const z of [18, 21.1]) {
        queue.push({ x: 126, y: 1.6, z }, 'rifle');
        queue.flush(
          { x: 130, y: 1.6, z },
          { x: -1, y: 0, z: 0 },
          world,
          (_kind, _distance, context) => contexts.push(context),
        );
      }
      expect(contexts.map((c) => c.blocked)).toEqual([true, false]);
    } finally {
      world.free();
    }
  });
  it('snapshots muzzle position and resolves the current camera through visible surfaces', () => {
    const queue = new RemoteShotAudioQueue();
    const source = { x: 10, y: 1.6, z: 0 };
    queue.push(source, 'sidearm');
    source.x = 999;
    const castRay = vi.fn<WorldRaycaster['castRay']>(() => {
      throw new Error('Gameplay helper query must not be used');
    });
    const castVisibleRay = vi.fn<WorldRaycaster['castRay']>((origin) => ({
      distance: 4,
      point: origin,
      normal: { x: 1, y: 0, z: 0 },
      visible: true,
    }));
    const play = vi.fn<(kind: RemoteShotKind, distance: number, context: BlastContext) => void>();
    const listener = { x: 20, y: 1.6, z: 0 };
    queue.flush(listener, { x: 0, y: 0, z: -1 }, { castRay, castVisibleRay }, play);
    const [kind, distance, context] = play.mock.calls[0]!;
    expect(kind).toBe('sidearm');
    expect(distance).toBe(10);
    expect(castVisibleRay.mock.calls[0]![0]).toEqual({ x: 10, y: 1.6, z: 0 });
    expect(blastAcoustics(distance, context)).toMatchObject({
      pan: -1,
      gainScale: 0.45,
      lowpass: 950,
    });
    queue.flush(listener, { x: 0, y: 0, z: -1 }, { castRay, castVisibleRay }, play);
    expect(play).toHaveBeenCalledOnce();
  });

  it('bounds one frame to 64 rays and skips out-of-range coil shots before querying cover', () => {
    const queue = new RemoteShotAudioQueue();
    for (let i = 0; i < 100; i++) queue.push({ x: i, y: 0, z: 0 }, 'rifle');
    const castRay = vi.fn<WorldRaycaster['castRay']>(() => null);
    const play = vi.fn<(kind: RemoteShotKind, distance: number, context: BlastContext) => void>();
    queue.flush({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { castRay }, play);
    expect(castRay).toHaveBeenCalledTimes(64);
    expect(play.mock.calls[0]![2].source?.x).toBe(36);
    castRay.mockClear();
    play.mockClear();
    queue.push({ x: 25.01, y: 0, z: 0 }, 'coil');
    queue.push({ x: 25, y: 0, z: 0 }, 'coil');
    queue.flush({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { castRay }, play);
    expect(castRay).toHaveBeenCalledOnce();
    expect(play.mock.calls[0]![1]).toBe(25);
  });

  it('does not use invisible helpers or hits beyond the listener as audible cover', () => {
    for (const visible of [false, true]) {
      const queue = new RemoteShotAudioQueue();
      queue.push({ x: 10, y: 0, z: 0 }, 'rifle');
      const castRay = vi.fn<WorldRaycaster['castRay']>((origin) => ({
        distance: visible ? 11 : 2,
        point: origin,
        normal: { x: 1, y: 0, z: 0 },
        visible,
      }));
      const play = vi.fn<(kind: RemoteShotKind, distance: number, context: BlastContext) => void>();
      queue.flush({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { castRay }, play);
      expect(play.mock.calls[0]![2].blocked).toBe(false);
    }
  });
});
