import { describe, expect, it } from 'vitest';
import type { SurfaceKind } from '@wd/shared';
import { Audio } from './Audio.ts';
import { BulletLayerGate } from './bulletLayers.ts';

/** The real `Audio.bulletImpact` on a stub: which voices it starts, with or without the clip. */
function stub(clipLoaded: boolean) {
  const calls: string[] = [];
  const self = {
    ready: true,
    ctx: { currentTime: 1 },
    bulletGate: new BulletLayerGate(),
    falloff: (d: number) => Math.max(0, 1 - d / 60),
    play: (name: string) => {
      calls.push(`clip ${name}`);
      return clipLoaded;
    },
    noiseBurst: () => calls.push('noise'),
    tone: () => calls.push('tone'),
    sweep: () => calls.push('sweep'),
  };
  const hit = (d: number, s: SurfaceKind, bullet?: boolean) =>
    (
      Audio.prototype as unknown as {
        bulletImpact(this: unknown, d: number, s: SurfaceKind, b?: boolean): void;
      }
    ).bulletImpact.call(self, d, s, bullet);
  return { calls, hit, self };
}

describe('Audio.bulletImpact: bullet layer over the recorded clip', () => {
  it('a near bullet hit plays the clip and the synthesized layer', () => {
    const { calls, hit } = stub(true);
    hit(10, 'stone');
    expect(calls[0]).toMatch(/^clip /);
    expect(calls.filter((c) => c === 'noise').length).toBeGreaterThanOrEqual(2);
  });

  it('without the clip, hits beyond the layer range (35–45 m) still get the fallback', () => {
    const { calls, hit } = stub(false);
    hit(40, 'stone');
    expect(calls.filter((c) => c === 'noise').length).toBe(2);
  });

  it('a silent far pellet does not take the gate from a near one in the same volley', () => {
    const { calls, hit } = stub(true);
    hit(40, 'stone'); // beyond the layer range: clip only
    const before = calls.length;
    hit(10, 'stone'); // same audio-clock instant: still gets its layer
    expect(calls.slice(before).filter((c) => c === 'noise').length).toBeGreaterThanOrEqual(2);
  });

  it('props knocked by a truck keep the plain material clip: no crack, no ricochet', () => {
    const { calls, hit } = stub(true);
    for (let i = 0; i < 20; i++) {
      hit(8, 'stone', false);
    }
    expect(calls.every((c) => c.startsWith('clip '))).toBe(true);
  });
});
