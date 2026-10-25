import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Audio } from './Audio.ts';
import { blastAcoustics, blastFalloff } from './blastAcoustics.ts';

describe('blast acoustics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps manual falloff monotonic and bounded', () => {
    expect(blastFalloff(0)).toBe(1);
    expect(blastFalloff(Number.NaN)).toBe(1);
    expect(blastFalloff(6)).toBe(1);
    expect(blastFalloff(12)).toBeLessThan(blastFalloff(6));
    expect(blastFalloff(48)).toBeLessThan(blastFalloff(12));
    expect(blastFalloff(48)).toBeGreaterThan(0);
  });

  it('adds physical propagation delay, capped for distant blasts', () => {
    expect(blastAcoustics(34.3).delay).toBeCloseTo(0.1);
    expect(blastAcoustics(1000).delay).toBe(0.35);
    expect(blastAcoustics(Number.NaN).delay).toBe(0);
  });

  it('lowers and muffles blocked explosions without changing direction', () => {
    const open = blastAcoustics(20, {
      source: { x: 10, z: 0 },
      listener: { x: 0, z: 0 },
      forward: { x: 0, z: -1 },
    });
    const blocked = blastAcoustics(20, {
      source: { x: 10, z: 0 },
      listener: { x: 0, z: 0 },
      forward: { x: 0, z: -1 },
      blocked: true,
    });
    expect(blocked.gainScale).toBeLessThan(open.gainScale);
    expect(blocked.lowpass).toBeLessThan(1200);
    expect(blocked.pan).toBe(open.pan);
  });

  it('pans left, right and front symmetrically around the listener heading', () => {
    const listener = { x: 0, z: 0 };
    const forward = { x: 0, z: -1 };
    const right = blastAcoustics(10, { source: { x: 10, z: 0 }, listener, forward });
    const left = blastAcoustics(10, { source: { x: -10, z: 0 }, listener, forward });
    const front = blastAcoustics(10, { source: { x: 0, z: -10 }, listener, forward });
    expect(right.pan).toBeCloseTo(1);
    expect(left.pan).toBeCloseTo(-1);
    expect(front.pan).toBeCloseTo(0);
    expect(right.pan).toBeCloseTo(-left.pan);
  });

  it('derives distance from source and listener when both are supplied', () => {
    const a = blastAcoustics(1, {
      source: { x: 3, y: 4, z: 12 },
      listener: { x: 0, y: 0, z: 0 },
    });
    expect(a.distance).toBe(13);
    expect(a.delay).toBeCloseTo(13 / 343);
  });

  it('matches Three camera world direction for yaw 0, yaw pi/2 and camera right', () => {
    const listener = { x: 0, z: 0 };
    const camera = new THREE.PerspectiveCamera();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    expect(dir.x).toBeCloseTo(0);
    expect(dir.z).toBeCloseTo(-1);
    expect(blastAcoustics(10, { source: { x: 10, z: 0 }, listener, forward: dir }).pan).toBeCloseTo(
      1,
    );
    expect(blastAcoustics(10, { source: { x: 10, z: 0 }, listener, yaw: 0 }).pan).toBeCloseTo(1);

    camera.rotation.y = Math.PI / 2;
    camera.updateMatrixWorld();
    camera.getWorldDirection(dir);
    expect(dir.x).toBeCloseTo(-1);
    expect(dir.z).toBeCloseTo(0);
    expect(
      blastAcoustics(10, { source: { x: 0, z: -10 }, listener, forward: dir }).pan,
    ).toBeCloseTo(1);
    expect(
      blastAcoustics(10, { source: { x: 0, z: -10 }, listener, yaw: Math.PI / 2 }).pan,
    ).toBeCloseTo(1);
  });
});

class FakeParam {
  value = 0;
  readonly events: { type: 'set' | 'exp'; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'set', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'exp', value, time });
  }
}

class FakeNode {
  disconnects = 0;
  connect<T>(node: T): T {
    return node;
  }
  disconnect(): void {
    this.disconnects++;
  }
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  startTime = 0;
  stopTime = 0;
  start(time: number): void {
    this.startTime = time;
  }
  stop(time: number): void {
    this.stopTime = time;
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam();
  onended: (() => void) | null = null;
  startTime = 0;
  stopTime = 0;
  start(time: number): void {
    this.startTime = time;
  }
  stop(time: number): void {
    this.stopTime = time;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
}

class FakeAudioContext {
  state = 'running';
  currentTime = 2;
  readonly sampleRate = 48000;
  readonly sources: FakeBufferSource[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly filters: FakeFilter[] = [];
  readonly panners: FakePanner[] = [];
  createBufferSource(): FakeBufferSource {
    const n = new FakeBufferSource();
    this.sources.push(n);
    return n;
  }
  createOscillator(): FakeOscillator {
    const n = new FakeOscillator();
    this.oscillators.push(n);
    return n;
  }
  createGain(): FakeGain {
    const n = new FakeGain();
    this.gains.push(n);
    return n;
  }
  createBiquadFilter(): FakeFilter {
    const n = new FakeFilter();
    this.filters.push(n);
    return n;
  }
  createStereoPanner(): FakePanner {
    const n = new FakePanner();
    this.panners.push(n);
    return n;
  }
}

function makeAudio(buffers: Record<string, true> = {}): { audio: Audio; ctx: FakeAudioContext } {
  const audio = new Audio();
  const ctx = new FakeAudioContext();
  const internals = audio as unknown as {
    ctx: AudioContext;
    master: GainNode;
    noise: AudioBuffer;
    buffers: Map<string, AudioBuffer>;
  };
  internals.ctx = ctx as unknown as AudioContext;
  internals.master = new FakeGain() as unknown as GainNode;
  internals.noise = {} as AudioBuffer;
  internals.buffers = new Map(
    Object.keys(buffers).map((name) => [name, {} as AudioBuffer] as const),
  );
  return { audio, ctx };
}

function firstPeak(gain: FakeGain): number {
  return gain.gain.events.find((e) => e.type === 'exp')?.value ?? gain.gain.value;
}

describe('remote firearm routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['rifle', 'sidearm'] as const)(
    'pans %s samples and applies wall cover at equal range',
    (kind) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const clip = kind === 'rifle' ? 'rifle_shot' : 'pistol_shot';
      const open = makeAudio({ [clip]: true });
      const covered = makeAudio({ [clip]: true });
      const listener = { x: 0, z: 0 };
      const forward = { x: 0, z: -1 };
      open.audio.remoteGunshot(kind, 999, { source: { x: -10, z: 0 }, listener, forward });
      covered.audio.remoteGunshot(kind, 999, {
        source: { x: 10, z: 0 },
        listener,
        forward,
        blocked: true,
      });
      expect(open.audio.recentSamples).toEqual([clip]);
      expect(covered.audio.recentSamples).toEqual([clip]);
      expect(open.ctx.panners[0]!.pan.value).toBe(-1);
      expect(covered.ctx.panners[0]!.pan.value).toBe(1);
      expect(covered.ctx.gains[0]!.gain.value / open.ctx.gains[0]!.gain.value).toBeCloseTo(0.45);
      expect(covered.ctx.filters[0]!.frequency.value).toBe(950);
      expect(covered.ctx.sources[0]!.startTime).toBeCloseTo(2 + 10 / 343);
      covered.ctx.sources[0]!.onended?.();
      expect(
        [
          ...covered.ctx.sources,
          ...covered.ctx.filters,
          ...covered.ctx.panners,
          ...covered.ctx.gains,
        ].every((n) => n.disconnects === 1),
      ).toBe(true);
    },
  );

  it('routes synthesized reports through the same delay, pan, cover and cleanup', () => {
    const open = makeAudio();
    const covered = makeAudio();
    const context = { source: { x: -30, z: 0 }, listener: { x: 0, z: 0 } };
    open.audio.remoteGunshot('rifle', 30, context);
    covered.audio.remoteGunshot('rifle', 30, { ...context, blocked: true });
    expect(firstPeak(covered.ctx.gains[0]!) / firstPeak(open.ctx.gains[0]!)).toBeCloseTo(0.45);
    expect(covered.ctx.sources[0]!.startTime).toBeCloseTo(2 + 30 / 343);
    expect(covered.ctx.panners[0]!.pan.value).toBe(-1);
    expect(covered.ctx.filters.some((f) => f.frequency.value === 950)).toBe(true);
    covered.ctx.sources[0]!.onended?.();
    expect(
      [
        ...covered.ctx.sources,
        ...covered.ctx.filters,
        ...covered.ctx.panners,
        ...covered.ctx.gains,
      ].every((n) => n.disconnects === 1),
    ).toBe(true);
  });

  it('keeps the coil hearing limit and derives it from the current listener', () => {
    const { audio, ctx } = makeAudio();
    audio.remoteCoilShot(1, { source: { x: 25.01, z: 0 }, listener: { x: 0, z: 0 } });
    expect(ctx.sources).toHaveLength(0);
    audio.remoteCoilShot(999, {
      source: { x: 25, z: 0 },
      listener: { x: 0, z: 0 },
      blocked: true,
    });
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.startTime).toBeCloseTo(2 + 25 / 343);
    expect(ctx.panners[0]!.pan.value).toBe(1);
    expect(ctx.filters.some((f) => f.frequency.value === 950)).toBe(true);
    ctx.sources[0]!.onended?.();
    expect(ctx.panners[0]!.disconnects).toBe(1);
  });

  it('caps very distant firearm delay without raising the existing far gain floor', () => {
    const { audio, ctx } = makeAudio({ rifle_shot: true });
    audio.remoteGunshot('rifle', 10000);
    expect(ctx.sources[0]!.startTime).toBeCloseTo(2.35);
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(0.12 * 0.8);
  });
});

describe('explosion audio routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes sampled explosions through shared pan, occlusion, delay and cleanup', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { audio, ctx } = makeAudio({ explosion_near: true, explosion_far: true });
    audio.explosion(999, {
      source: { x: 10, z: 0 },
      listener: { x: 0, z: 0 },
      forward: { x: 0, z: -1 },
      blocked: true,
    });

    expect(ctx.sources[0]!.startTime).toBeCloseTo(2 + 10 / 343);
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(0.45);
    expect(ctx.panners.map((p) => p.pan.value)).toContain(1);
    expect(ctx.filters.some((f) => f.type === 'lowpass' && f.frequency.value === 950)).toBe(true);

    ctx.sources[0]!.onended?.();
    expect(ctx.sources[0]!.disconnects).toBe(1);
    expect(ctx.gains[0]!.disconnects).toBe(1);
    expect(ctx.panners[0]!.disconnects).toBe(1);
  });

  it('keeps sampled near/far gains monotonic without a far floor', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const near = makeAudio({ explosion_near: true, explosion_far: true });
    near.audio.explosion(12);
    const far = makeAudio({ explosion_near: true, explosion_far: true });
    far.audio.explosion(180);
    expect(near.ctx.gains[0]!.gain.value).toBeGreaterThan(far.ctx.gains[0]!.gain.value);
    expect(far.ctx.gains[0]!.gain.value).toBeCloseTo(blastFalloff(180 / 3));
    expect(far.ctx.gains[0]!.gain.value).toBeLessThan(0.25);
  });

  it('does not jump louder at the sampled near/far clip boundary', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const near = makeAudio({ explosion_near: true, explosion_far: true });
    near.audio.explosion(29.9);
    const far = makeAudio({ explosion_near: true, explosion_far: true });
    far.audio.explosion(30.1);
    expect(near.audio.recentSamples[0]).toBe('explosion_near');
    expect(far.audio.recentSamples[0]).toBe('explosion_far');
    expect(near.ctx.gains[0]!.gain.value).toBeGreaterThan(far.ctx.gains[0]!.gain.value);
    expect(near.ctx.gains[0]!.gain.value).toBeCloseTo(blastFalloff(29.9 / 3));
    expect(far.ctx.gains[0]!.gain.value).toBeCloseTo(blastFalloff(30.1 / 3));
  });

  it('attenuates every sampled near layer with distance', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const near = makeAudio({ explosion_near: true, gear_click_1: true });
    near.audio.explosion(12);
    const later = makeAudio({ explosion_near: true, gear_click_1: true });
    later.audio.explosion(24);
    expect(near.ctx.gains[0]!.gain.value).toBeGreaterThan(later.ctx.gains[0]!.gain.value);
    expect(near.ctx.gains[2]!.gain.value).toBeGreaterThan(later.ctx.gains[2]!.gain.value);
    expect(later.ctx.gains[2]!.gain.value).toBeCloseTo(0.25 * blastFalloff(24 / 3));
  });

  it('routes synthesized fallback layers through the same pan, occlusion and cleanup', () => {
    const { audio, ctx } = makeAudio();
    audio.explosion(30, {
      source: { x: 0, z: -30 },
      listener: { x: 0, z: 0 },
      forward: { x: 0, z: -1 },
      blocked: true,
    });

    expect(ctx.sources).toHaveLength(3);
    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.sources.every((s) => s.startTime >= 2 + 30 / 343)).toBe(true);
    expect(ctx.oscillators[0]!.startTime).toBeCloseTo(2 + 30 / 343);
    expect(ctx.panners.every((p) => p.pan.value === 0)).toBe(true);
    expect(ctx.filters.some((f) => f.type === 'lowpass' && f.frequency.value === 950)).toBe(true);
    const peaks = ctx.gains.map(firstPeak);
    expect(peaks[3]).toBeLessThan(peaks[0]!);

    for (const src of ctx.sources) src.onended?.();
    ctx.oscillators[0]!.onended?.();
    expect(ctx.sources.every((s) => s.disconnects === 1)).toBe(true);
    expect(ctx.oscillators[0]!.disconnects).toBe(1);
  });

  it('keeps synthesized fallback gain monotonic with distance', () => {
    const near = makeAudio();
    near.audio.explosion(12);
    const far = makeAudio();
    far.audio.explosion(120);
    expect(firstPeak(near.ctx.gains[0]!)).toBeGreaterThan(firstPeak(far.ctx.gains[0]!));
    expect(firstPeak(far.ctx.gains[0]!)).toBeCloseTo(blastFalloff(120 / 3));
  });
});
