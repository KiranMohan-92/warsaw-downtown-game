import { describe, expect, it, vi } from 'vitest';
import type { WorldRaycaster } from '@wd/shared';
import { BlastAudioQueue } from './BlastAudioQueue.ts';
import { blastAcoustics, type BlastContext } from './blastAcoustics.ts';

describe('blast listener timing', () => {
  it('resolves a queued blast using the newly established view instead of the previous camera', () => {
    const queue = new BlastAudioQueue();
    const source = { x: 10, y: 0, z: 0 };
    const camera = { x: 0, y: 0, z: 0 };
    queue.push(source);
    source.x = 999; // source snapshot must survive remote-state updates
    camera.x = 20; // camera moved before rendering (e.g. drone/chase transition)
    const castRay = vi.fn<WorldRaycaster['castRay']>(() => null);
    const play = vi.fn<(distance: number, context: BlastContext) => void>();
    queue.flush(camera, { x: 0, y: 0, z: -1 }, { castRay }, play);
    expect(play).toHaveBeenCalledOnce();
    const [distance, context] = play.mock.calls[0]!;
    expect(distance).toBe(10);
    expect(context.source?.x).toBe(10);
    expect(blastAcoustics(distance, context).pan).toBe(-1);
    expect(castRay.mock.calls[0]![1].x).toBeGreaterThan(0);
    queue.flush(camera, { x: 0, y: 0, z: -1 }, { castRay }, play);
    expect(play).toHaveBeenCalledOnce();
  });

  it('bounds queued cover rays and ignores a contact beyond the listener', () => {
    const queue = new BlastAudioQueue();
    for (let i = 0; i < 100; i++) queue.push({ x: i, y: 0, z: 0 });
    const castRay = vi.fn<WorldRaycaster['castRay']>((origin, _dir, distance) => ({
      distance: distance + 1,
      point: origin,
      normal: { x: 0, y: 1, z: 0 },
      visible: true,
    }));
    const play = vi.fn<(distance: number, context: BlastContext) => void>();
    queue.flush({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { castRay }, play);
    expect(castRay).toHaveBeenCalledTimes(64);
    expect(play).toHaveBeenCalledTimes(64);
    expect(play.mock.calls.every(([, c]) => !c.blocked)).toBe(true);
  });

  it('does not muffle an invisible collision helper on a legacy raycaster', () => {
    const queue = new BlastAudioQueue();
    queue.push({ x: 0, y: 0, z: 0 });
    const castRay = vi.fn<WorldRaycaster['castRay']>((origin) => ({
      distance: 2,
      point: origin,
      normal: { x: 0, y: 0, z: 1 },
      visible: false,
    }));
    const play = vi.fn<(distance: number, context: BlastContext) => void>();
    queue.flush({ x: 0, y: 1, z: 10 }, { x: 0, y: 0, z: -1 }, { castRay }, play);
    const [distance, context] = play.mock.calls[0]!;
    expect(context.blocked).toBe(false);
    expect(blastAcoustics(distance, context)).toMatchObject({ gainScale: 1, lowpass: null });
  });

  it('uses the visible-surface query to hear a real wall behind movement helpers', () => {
    const queue = new BlastAudioQueue();
    queue.push({ x: 0, y: 0, z: 0 });
    const castRay = vi.fn<WorldRaycaster['castRay']>(() => {
      throw new Error('Presentation must not use the gameplay ray');
    });
    const castVisibleRay = vi.fn<WorldRaycaster['castRay']>((origin) => ({
      distance: 4,
      point: origin,
      normal: { x: 0, y: 0, z: 1 },
      visible: true,
    }));
    const play = vi.fn<(distance: number, context: BlastContext) => void>();
    queue.flush({ x: 0, y: 1, z: 10 }, { x: 0, y: 0, z: -1 }, { castRay, castVisibleRay }, play);
    expect(castRay).not.toHaveBeenCalled();
    expect(castVisibleRay).toHaveBeenCalledOnce();
    const [distance, context] = play.mock.calls[0]!;
    expect(context.blocked).toBe(true);
    expect(blastAcoustics(distance, context)).toMatchObject({ gainScale: 0.45, lowpass: 950 });
  });
});
