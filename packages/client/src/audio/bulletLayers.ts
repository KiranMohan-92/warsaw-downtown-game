import type { SurfaceKind } from '@wd/shared';

/**
 * Synthesized bullet layers laid over the recorded (CC0) impact clips: the clips are generic
 * knocks and clanks, a round hitting something also *cracks* (a very short bright transient),
 * then the material answers (stone thock + grit, wood thunk, glass tinkle, dirt thud) and now and
 * then the round sings off as a ricochet. Pure recipes here (testable without WebAudio); `Audio`
 * plays them with its existing noise/tone/sweep voices. Presentation only.
 */
export type BulletVoice =
  | {
      kind: 'noise';
      delay: number;
      filter: BiquadFilterType;
      freq: number;
      q: number;
      gain: number;
      decay: number;
    }
  | {
      kind: 'tone';
      delay: number;
      type: OscillatorType;
      f0: number;
      f1: number;
      gain: number;
      decay: number;
    }
  | {
      kind: 'sweep';
      delay: number;
      from: number;
      to: number;
      q: number;
      gain: number;
      dur: number;
    };

/** A layer is skipped beyond this distance (the recorded clip alone carries far hits). */
export const BULLET_LAYER_RANGE = 35;
/** At most one layer per this many seconds: a shotgun's pellets or a full-auto stream don't stack. */
export const BULLET_LAYER_GAP = 0.035;
/** Ricochet chance per hit (hard surfaces, near enough to hear the whine). */
export const RICOCHET_CHANCE: Readonly<Record<SurfaceKind, number>> = {
  stone: 0.12,
  metal: 0.3,
  wood: 0,
  glass: 0,
  soft: 0,
};
const RICOCHET_RANGE = 25;

/**
 * The voices for one hit. `gain` is the caller's distance-scaled level; `rnd` is uniform [0, 1).
 * Far hits lose their top end (air absorption): the crack's centre frequency and the grit fall.
 */
export function bulletLayer(
  surface: SurfaceKind,
  distance: number,
  gain: number,
  rnd: () => number,
): BulletVoice[] {
  if (distance > BULLET_LAYER_RANGE || gain <= 0) return [];
  const air = Math.max(0.45, 1 - distance / 60);
  const v: BulletVoice[] = [];
  // The crack: every surface, 4–12 ms of bright noise (the snap that says "bullet", not "knock").
  const crack = (f: number, g: number): void => {
    v.push({
      kind: 'noise',
      delay: 0,
      filter: 'bandpass',
      freq: f * air,
      q: 1.4,
      gain: gain * g,
      decay: 0.008 + rnd() * 0.006,
    });
  };
  switch (surface) {
    case 'stone':
      crack(3600 + rnd() * 900, 0.9);
      // Body: a dull thock, then grit trickling off the face.
      v.push({
        kind: 'noise',
        delay: 0.002,
        filter: 'lowpass',
        freq: 520 + rnd() * 180,
        q: 0.8,
        gain: gain * 0.7,
        decay: 0.06,
      });
      v.push({
        kind: 'noise',
        delay: 0.03 + rnd() * 0.02,
        filter: 'highpass',
        freq: 3200 * air,
        q: 0.6,
        gain: gain * 0.22,
        decay: 0.12 + rnd() * 0.08,
      });
      break;
    case 'metal':
      crack(5200 + rnd() * 1200, 0.8);
      // A struck-plate ring a little under the recorded clank.
      v.push({
        kind: 'tone',
        delay: 0.001,
        type: 'triangle',
        f0: 1700 + rnd() * 900,
        f1: 1500,
        gain: gain * 0.22,
        decay: 0.18,
      });
      break;
    case 'wood':
      crack(2200 + rnd() * 600, 0.6);
      // Hollow thunk + a dry splintering crackle.
      v.push({
        kind: 'noise',
        delay: 0.002,
        filter: 'bandpass',
        freq: 700 + rnd() * 250,
        q: 2.2,
        gain: gain * 0.8,
        decay: 0.07,
      });
      v.push({
        kind: 'noise',
        delay: 0.015 + rnd() * 0.015,
        filter: 'bandpass',
        freq: 2600 * air,
        q: 3,
        gain: gain * 0.25,
        decay: 0.05,
      });
      break;
    case 'glass':
      crack(6200 + rnd() * 1500, 0.8);
      // Tinkle: three or four short high pings, staggered as shards fall.
      for (let i = 0, n = 3 + Math.floor(rnd() * 2); i < n; i++) {
        const f = 4200 + rnd() * 3200;
        v.push({
          kind: 'tone',
          delay: 0.02 + i * (0.018 + rnd() * 0.02),
          type: 'sine',
          f0: f,
          f1: f * 0.96,
          gain: gain * 0.16,
          decay: 0.05 + rnd() * 0.04,
        });
      }
      break;
    case 'soft':
      // Dirt, sandbags, hedges: a muffled thud and a patter of earth, almost no crack.
      crack(1600 + rnd() * 500, 0.25);
      v.push({
        kind: 'noise',
        delay: 0.001,
        filter: 'lowpass',
        freq: 260 + rnd() * 90,
        q: 0.7,
        gain: gain * 0.85,
        decay: 0.08,
      });
      v.push({
        kind: 'noise',
        delay: 0.04 + rnd() * 0.03,
        filter: 'bandpass',
        freq: 1400 * air,
        q: 0.9,
        gain: gain * 0.2,
        decay: 0.1,
      });
      break;
  }
  if (distance < RICOCHET_RANGE && rnd() < RICOCHET_CHANCE[surface]) {
    // The round sings off: a falling, narrow whine (Doppler-ish), quieter than the hit.
    const f0 = 2600 + rnd() * 1600;
    v.push({
      kind: 'sweep',
      delay: 0.02,
      from: f0,
      to: f0 * (0.42 + rnd() * 0.12),
      q: 8,
      gain: gain * 0.33,
      dur: 0.2 + rnd() * 0.12,
    });
  }
  return v;
}

/** Throttle for `bulletLayer`: one per `BULLET_LAYER_GAP` seconds of audio-clock time. */
export class BulletLayerGate {
  private last = Number.NEGATIVE_INFINITY;
  open(now: number): boolean {
    if (now - this.last < BULLET_LAYER_GAP) return false;
    this.last = now;
    return true;
  }
}
