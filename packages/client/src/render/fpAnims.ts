/**
 * First-person animation clips, authored as data: reloads per primary (real magazine handling),
 * the pistol's slide-lock reload, the shotgun's pump, the coilgun's cell swap, the ARC's heat
 * vent, and an inspect per gun. Presentation only — the sim's weapon state machine decides when a
 * reload starts and ends (shared/sim/weapon.ts); a reload clip is laid out in seconds against the
 * tunables' tactical/empty durations and played by progress (1 − reloadTimer / reloadDuration), so
 * the new magazine seats just before the rounds are counted at `reloadEnd`.
 *
 * A clip keys four kinds of channel (each key: normalised time `t`, eased from the previous key):
 * - `gun`: the weapon's offset in camera space [x, y, z, pitch, yaw, roll] (tilts, lifts, jolts);
 * - parts (cut out of the scan by tools/assets/build_viewguns.py): `a` = travel along the part's
 *   axis (out of the well, rearward for bolts/pumps), `p` = extra offset, `r` = rotation about the
 *   pivot, `hide` for the off-screen swap to the fresh magazine;
 * - `L` / `R` hands: a wrist target in the bind pose's space (`bind` + offset), in a part's space
 *   (moves with it: the hand holds the magazine), or absolute gun space; `r` turns the hand
 *   relative to the forearm. The arm follows by two-bone IK (render/fpRig.ts);
 * - cues: foley at the keyframe it belongs to (render → audio/Audio.ts `foley`).
 * `drop` releases a part into a short fall (the empty magazine) while the hand goes for a new one.
 */
import * as THREE from 'three';
import { PRIMARIES, SIDEARM, type PrimaryId } from '@wd/shared';
import type { ScanGunId } from './viewGunScans.ts';
import type { FoleyCue } from '../audio/Audio.ts';

export type V3 = [number, number, number];
export type V6 = [number, number, number, number, number, number];
export type Ease = 'io' | 'in' | 'out' | 'lin';

/** Foley cues (played by audio/Audio.ts `foley`). */
export type Cue = FoleyCue;

export interface GunKey {
  t: number;
  v: V6;
  ease?: Ease;
}
export interface PartKey {
  t: number;
  a?: number;
  p?: V3;
  r?: V3;
  hide?: boolean;
  ease?: Ease;
}
export interface HandKey {
  t: number;
  /** 'bind' = the baked grip (p = offset), 'gun' = absolute gun space, else a part's space. */
  space: string;
  p?: V3;
  r?: V3;
  ease?: Ease;
}
export interface Clip {
  /** Seconds the clip was laid out for (normalised times are fractions of it). */
  duration: number;
  gun: GunKey[];
  parts: Record<string, PartKey[]>;
  L: HandKey[];
  R: HandKey[];
  cues: { t: number; cue: Cue }[];
  drop?: { t: number; part: string };
  /** Pin the shoulders to the body while the gun moves (0 = arms ride with the gun). */
  pin?: number;
}

export interface PartPose {
  a: number;
  p: V3;
  r: V3;
  hide: boolean;
}
export interface HandPose {
  space: string;
  p: V3;
  r: V3;
  /** Blend with the previous key (resolved against the current part poses by the caller). */
  from: { space: string; p: V3; r: V3 } | null;
  k: number;
}
export interface ClipPose {
  gun: V6;
  parts: Record<string, PartPose>;
  L: HandPose | null;
  R: HandPose | null;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export function ease(kind: Ease | undefined, x: number): number {
  const t = clamp01(x);
  switch (kind ?? 'io') {
    case 'lin':
      return t;
    case 'in':
      return t * t * t;
    case 'out':
      return 1 - (1 - t) ** 3;
    default:
      return t * t * (3 - 2 * t);
  }
}

/** Bracketing keys at `t` and the eased blend between them (keys sorted by t). */
function bracket<K extends { t: number; ease?: Ease }>(
  keys: readonly K[],
  t: number,
): { a: K; b: K; k: number } | null {
  if (!keys.length) return null;
  const first = keys[0]!;
  if (t <= first.t) return { a: first, b: first, k: 0 };
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (t < b.t) {
      const a = keys[i - 1]!;
      return { a, b, k: ease(b.ease, (t - a.t) / Math.max(1e-6, b.t - a.t)) };
    }
  }
  const last = keys[keys.length - 1]!;
  return { a: last, b: last, k: 0 };
}

const lerpN = <T extends number[]>(a: T, b: T, k: number): T =>
  a.map((x, i) => x + (b[i]! - x) * k) as T;
const Z3: V3 = [0, 0, 0];

/** Evaluate a clip at normalised time t (0..1). */
export function evalClip(clip: Clip, t: number): ClipPose {
  const g = bracket(clip.gun, t);
  const gun = g ? lerpN(g.a.v, g.b.v, g.k) : ([0, 0, 0, 0, 0, 0] as V6);
  const parts: Record<string, PartPose> = {};
  for (const [name, keys] of Object.entries(clip.parts)) {
    const b = bracket(keys, t);
    if (!b) continue;
    parts[name] = {
      a: (b.a.a ?? 0) + ((b.b.a ?? 0) - (b.a.a ?? 0)) * b.k,
      p: lerpN(b.a.p ?? Z3, b.b.p ?? Z3, b.k),
      r: lerpN(b.a.r ?? Z3, b.b.r ?? Z3, b.k),
      // Hidden from a hiding key until the next key that shows it (no fade).
      hide: b.k < 1 && b.a !== b.b ? (b.a.hide ?? false) : (b.b.hide ?? false),
    };
  }
  const hand = (keys: HandKey[]): HandPose | null => {
    const b = bracket(keys, t);
    if (!b) return null;
    const to = { space: b.b.space, p: b.b.p ?? Z3, r: b.b.r ?? Z3 };
    if (b.a === b.b) return { ...to, from: null, k: 1 };
    return { ...to, from: { space: b.a.space, p: b.a.p ?? Z3, r: b.a.r ?? Z3 }, k: b.k };
  };
  return { gun, parts, L: hand(clip.L), R: hand(clip.R) };
}

/** Cues whose time lies in (t0, t1] (a frame's progress step; nothing when going backwards). */
export function cuesBetween(clip: Clip, t0: number, t1: number): Cue[] {
  if (t1 <= t0) return [];
  return clip.cues.filter((c) => c.t > t0 && c.t <= t1).map((c) => c.cue);
}

// ---------------------------------------------------------------------------------------------
// Authoring helpers: clips are written in seconds and normalised by their duration.

class ClipBuilder {
  gun: GunKey[] = [];
  parts: Record<string, PartKey[]> = {};
  L: HandKey[] = [];
  R: HandKey[] = [];
  cues: { t: number; cue: Cue }[] = [];
  drop?: { t: number; part: string };
  constructor(readonly duration: number) {}
  g(t: number, v: V6, ease?: Ease): this {
    this.gun.push({ t, v, ease });
    return this;
  }
  part(name: string, t: number, k: Omit<PartKey, 't'>): this {
    (this.parts[name] ??= []).push({ t, ...k });
    return this;
  }
  hand(side: 'L' | 'R', t: number, space: string, p?: V3, r?: V3, ease?: Ease): this {
    this[side].push({ t, space, p, r, ease });
    return this;
  }
  cue(t: number, cue: Cue): this {
    this.cues.push({ t, cue });
    return this;
  }
  build(pin = 0.75): Clip {
    const d = this.duration;
    const n = <K extends { t: number }>(ks: K[]): K[] =>
      ks.map((k) => ({ ...k, t: k.t / d })).sort((a, b) => a.t - b.t);
    const parts: Record<string, PartKey[]> = {};
    for (const [k, v] of Object.entries(this.parts)) parts[k] = n(v);
    return {
      duration: d,
      gun: n(this.gun),
      parts,
      L: n(this.L),
      R: n(this.R),
      cues: n(this.cues),
      drop: this.drop ? { t: this.drop.t / d, part: this.drop.part } : undefined,
      pin,
    };
  }
}

const REST: V6 = [0, 0, 0, 0, 0, 0];

/** How each scan reloads: which parts, where the support hand holds them, the gun's tilt. */
export interface ReloadStyle {
  kind: 'mag' | 'pistol' | 'pump' | 'cell' | 'none';
  /** Wrist relative to the part's pivot while holding it (part space) and the hand's turn. */
  grab: { p: V3; r: V3 };
  /** Wrist while working the bolt/charging handle (bolt part space), hand turn; null = none. */
  bolt: { p: V3; r: V3; travel: number } | null;
  /** Gun pose while reloading (camera space): tilt the magwell toward the eye. */
  tilt: V6;
  /** How far the magazine travels out before it swings away (m). */
  pull: number;
}

export const RELOAD_STYLES: Record<ScanGunId, ReloadStyle> = {
  rifle: {
    kind: 'mag',
    grab: { p: [-0.03, -0.05, 0.03], r: [0.5, 0.35, 0.9] },
    bolt: { p: [-0.03, -0.05, 0.05], r: [0.9, 0.3, -0.6], travel: 0.065 },
    tilt: [-0.09, 0.1, -0.01, 0.2, 0.3, -0.7],
    pull: 0.08,
  },
  iskra: {
    kind: 'mag',
    grab: { p: [-0.03, -0.05, 0.025], r: [0.45, 0.3, 0.85] },
    bolt: { p: [-0.045, -0.07, 0.0], r: [1.1, 0.3, -0.2], travel: 0.045 },
    tilt: [-0.08, 0.1, -0.01, 0.2, 0.3, -0.7],
    pull: 0.08,
  },
  marksman: {
    kind: 'mag',
    grab: { p: [-0.03, -0.05, 0.03], r: [0.5, 0.35, 0.9] },
    bolt: { p: [-0.05, -0.07, 0.0], r: [1.1, 0.3, -0.2], travel: 0.05 },
    tilt: [-0.09, 0.1, -0.02, 0.2, 0.28, -0.65],
    pull: 0.08,
  },
  coil: {
    kind: 'cell',
    grab: { p: [-0.045, -0.05, 0.03], r: [0.5, 0.3, 0.8] },
    bolt: null,
    tilt: [-0.11, 0.14, -0.04, 0.26, 0.32, -0.78],
    pull: 0.08,
  },
  shotgun: {
    kind: 'pump',
    grab: { p: [-0.04, -0.035, 0.1], r: [0.3, 0.2, 0.6] },
    bolt: null,
    tilt: [-0.05, 0.06, 0.01, 0.12, 0.14, -0.45],
    pull: 0.07,
  },
  pistol: {
    kind: 'pistol',
    grab: { p: [-0.03, -0.05, 0.02], r: [0.6, 0.2, 0.7] },
    bolt: null,
    tilt: [-0.05, 0.09, 0.02, 0.32, 0.3, -0.5],
    pull: 0.1,
  },
  arc: {
    kind: 'none',
    grab: { p: [0, 0, 0], r: [0, 0, 0] },
    bolt: null,
    // The vent is on the right: the gun turns its right side to the eye.
    tilt: [-0.02, 0.03, 0.01, 0.06, -0.1, 0.38],
    pull: 0,
  },
};

/** Where the hand goes to fetch/stow a magazine (relative to the grab point on the magazine). */
const POUCH: V3 = [-0.08, -0.26, 0.18];

/** Box-magazine reload (AR-7, Iskra, SR-8): tactical stows the old one, empty drops it + bolt. */
function magReload(style: ReloadStyle, dur: number, empty: boolean): Clip {
  const c = new ClipBuilder(dur);
  const { grab, tilt, pull, bolt } = style;
  // Time map: the magazine seats at 62 % of a tactical reload / ~46 % of an empty one (the bolt
  // and settle take the rest), scaled from the authored 2.1 s / 2.6 s layout.
  const s = empty ? dur / 2.6 : dur / 2.1;
  const T = (x: number): number => x * s;
  c.g(0, REST)
    .g(T(0.26), tilt)
    .g(T(0.34), [tilt[0], tilt[1] - 0.012, tilt[2], tilt[3] - 0.05, tilt[4], tilt[5]]);
  // Support hand leaves the handguard for the magazine.
  c.hand('L', 0, 'bind').hand('L', T(0.24), 'mag', grab.p, grab.r);
  c.cue(T(0.27), 'magRelease').cue(T(0.3), 'cloth');
  c.part('mag', 0, {}).part('mag', T(0.28), {}).part('mag', T(0.46), { a: pull, ease: 'out' });
  c.cue(T(0.36), 'magOut');
  let seat: number;
  if (!empty) {
    // Stow: the old magazine goes down to the pouch with the hand, the fresh one comes back.
    c.part('mag', T(0.72), { a: pull + 0.08, p: POUCH, r: [0.6, 0, 0.4] });
    c.part('mag', T(0.74), { a: pull + 0.08, p: POUCH, r: [0.6, 0, 0.4], hide: true });
    c.part('mag', T(0.86), { a: pull + 0.08, p: POUCH, r: [0.6, 0, 0.4], hide: false });
    c.cue(T(0.78), 'pouch');
    c.part('mag', T(1.16), { a: 0.05, p: [0, 0, 0], r: [0.06, 0, 0] });
    c.part('mag', T(1.3), { a: 0, ease: 'in' });
    c.hand('L', T(1.16), 'mag', grab.p, grab.r);
    seat = 1.3;
  } else {
    // Empty: let it fall, straight to the pouch for a fresh one.
    c.drop = { t: T(0.47), part: 'mag' };
    c.cue(T(0.47), 'magDrop');
    c.part('mag', T(0.47), { a: pull, hide: true });
    c.part('mag', T(0.62), { a: pull + 0.08, p: POUCH, r: [0.6, 0, 0.4], hide: false });
    c.hand('L', T(0.62), 'mag', grab.p, grab.r);
    c.cue(T(0.6), 'pouch');
    c.part('mag', T(0.92), { a: 0.05, p: [0, 0, 0], r: [0.06, 0, 0] });
    c.part('mag', T(1.06), { a: 0, ease: 'in' });
    c.hand('L', T(0.92), 'mag', grab.p, grab.r);
    seat = 1.06;
  }
  c.hand('L', T(seat), 'mag', grab.p, grab.r).cue(T(seat), 'magIn');
  // Slap: the palm drops off and punches the floor plate home; the gun jolts with it.
  const slapP: V3 = [grab.p[0], grab.p[1] - 0.05, grab.p[2]];
  c.hand('L', T(seat + 0.07), 'mag', slapP, grab.r, 'out');
  c.hand('L', T(seat + 0.12), 'mag', [grab.p[0], grab.p[1] - 0.012, grab.p[2]], grab.r, 'in');
  c.cue(T(seat + 0.12), 'slap');
  c.g(T(seat - 0.02), tilt).g(T(seat + 0.12), tilt);
  c.g(
    T(seat + 0.15),
    [tilt[0], tilt[1] + 0.015, tilt[2], tilt[3] + 0.07, tilt[4], tilt[5] - 0.05],
    'out',
  );
  let end = seat + 0.2;
  if (empty && bolt) {
    // Charging handle / bolt: reach over, rack it, let it slam home.
    const b = end + 0.18;
    c.g(T(b), [tilt[0] + 0.01, tilt[1], tilt[2], tilt[3] + 0.05, tilt[4] - 0.1, tilt[5] * 0.4]);
    c.hand('L', T(b), 'bolt', bolt.p, bolt.r);
    c.part('bolt', 0, {}).part('bolt', T(b + 0.02), {});
    c.part('bolt', T(b + 0.16), { a: bolt.travel, ease: 'out' });
    c.hand('L', T(b + 0.16), 'bolt', bolt.p, bolt.r, 'out');
    c.cue(T(b + 0.12), 'boltBack');
    c.part('bolt', T(b + 0.2), { a: bolt.travel });
    c.part('bolt', T(b + 0.24), { a: 0, ease: 'in' });
    c.hand(
      'L',
      T(b + 0.26),
      'bolt',
      [bolt.p[0] - 0.02, bolt.p[1] + 0.02, bolt.p[2] + 0.06],
      bolt.r,
    );
    c.cue(T(b + 0.24), 'boltForward');
    c.g(
      T(b + 0.27),
      [tilt[0], tilt[1] - 0.01, tilt[2] + 0.01, tilt[3] - 0.04, tilt[4] - 0.1, tilt[5] * 0.4],
      'out',
    );
    end = b + 0.3;
  }
  c.hand('L', T(end + 0.3), 'bind', undefined, undefined);
  c.g(T(end + 0.1), [
    tilt[0] * 0.5,
    tilt[1] * 0.5,
    tilt[2] * 0.5,
    tilt[3] * 0.5,
    tilt[4] * 0.5,
    tilt[5] * 0.5,
  ]);
  c.g(dur, REST);
  c.hand('L', dur, 'bind');
  c.part('mag', dur, {});
  return c.build();
}

/** Coilgun: the power cell drops out of the receiver, a fresh one clicks in, then charges. */
function cellReload(style: ReloadStyle, dur: number, empty: boolean): Clip {
  const clip = magReload({ ...style, bolt: null }, dur, empty);
  // Rename the magazine channels to the cell and add the charge-up whine when empty.
  const rename = (s: string): string => (s === 'mag' ? 'cell' : s);
  clip.parts = Object.fromEntries(Object.entries(clip.parts).map(([k, v]) => [rename(k), v]));
  for (const h of [...clip.L, ...clip.R]) h.space = rename(h.space);
  if (clip.drop) clip.drop.part = 'cell';
  clip.cues = clip.cues.map((c) => ({
    ...c,
    cue: c.cue === 'magOut' ? 'cellOut' : c.cue === 'magIn' ? 'cellIn' : c.cue,
  }));
  if (empty) clip.cues.push({ t: 0.62, cue: 'cellCharge' });
  clip.cues.sort((a, b) => a.t - b.t);
  return clip;
}

/** Pump shotgun: shells thumbed into the loading port one by one; from empty, a rack at the end. */
function pumpReload(style: ReloadStyle, dur: number, empty: boolean): Clip {
  const c = new ClipBuilder(dur);
  const { tilt } = style;
  c.g(0, REST).g(0.3, tilt);
  // The port sits under the receiver just behind the pump (gun space, relative to its pivot).
  const port: V3 = [-0.02, -0.05, 0.2];
  const belt: V3 = [-0.1, -0.3, 0.3];
  const rot: V3 = [0.7, 0.3, 0.9];
  c.hand('L', 0, 'bind').hand('L', 0.28, 'pump', belt, rot);
  const shells = empty ? 4 : 5;
  const rack = empty ? 0.75 : 0;
  const span = dur - 0.55 - rack;
  const per = span / shells;
  for (let i = 0; i < shells; i++) {
    const t0 = 0.3 + i * per;
    c.hand('L', t0 + per * 0.45, 'pump', [port[0], port[1] - 0.02, port[2] - 0.02], rot, 'out');
    c.hand('L', t0 + per * 0.62, 'pump', port, rot, 'in');
    c.cue(t0 + per * 0.62, 'shell');
    c.g(t0 + per * 0.62, tilt).g(
      t0 + per * 0.7,
      [tilt[0], tilt[1] + 0.006, tilt[2], tilt[3] + 0.03, tilt[4], tilt[5]],
      'out',
    );
    if (i < shells - 1) c.hand('L', t0 + per, 'pump', belt, rot);
  }
  let t = 0.3 + span;
  c.part('pump', 0, {}).part('pump', t, {});
  if (empty) {
    c.hand('L', t + 0.18, 'pump', style.grab.p, style.grab.r);
    c.g(t + 0.18, [0, 0, 0, 0.04, 0.05, 0.1]);
    c.part('pump', t + 0.24, {});
    c.part('pump', t + 0.36, { a: style.pull, ease: 'out' });
    c.hand('L', t + 0.36, 'pump', style.grab.p, style.grab.r, 'out');
    c.cue(t + 0.3, 'pumpBack');
    c.part('pump', t + 0.48, { a: 0, ease: 'in' });
    c.hand('L', t + 0.48, 'pump', style.grab.p, style.grab.r, 'in');
    c.cue(t + 0.46, 'pumpForward');
    c.g(t + 0.5, [0, -0.01, 0.02, 0.06, 0, 0.05], 'out');
    t += 0.55;
  }
  c.hand('L', Math.min(dur - 0.05, t + 0.25), 'bind');
  c.g(dur, REST);
  c.hand('L', dur, 'bind');
  c.part('pump', dur, {});
  return c.build();
}

/** P-9: thumb the release, the magazine drops, the new one is palmed in; from empty the slide was
 * locked back and slams forward at the end. */
function pistolReload(style: ReloadStyle, dur: number, empty: boolean): Clip {
  const c = new ClipBuilder(dur);
  const { tilt, grab } = style;
  const s = dur / (empty ? 1.8 : 1.5);
  const T = (x: number): number => x * s;
  c.g(0, REST).g(T(0.18), tilt);
  c.hand('L', 0, 'bind').hand('L', T(0.16), 'bind', [-0.06, -0.08, 0.05], [0.3, 0, 0.4]);
  c.cue(T(0.16), 'magRelease');
  c.part('mag', 0, {}).part('mag', T(0.17), {});
  c.part('mag', T(0.26), { a: 0.03, ease: 'out' });
  c.drop = { t: T(0.26), part: 'mag' };
  c.cue(T(0.27), 'magDrop');
  c.part('mag', T(0.27), { a: 0.03, hide: true });
  c.part('mag', T(0.48), { a: 0.14, p: [-0.05, -0.12, 0.08], r: [0.5, 0, 0.3], hide: false });
  c.hand('L', T(0.48), 'mag', grab.p, grab.r);
  c.cue(T(0.46), 'pouch');
  c.part('mag', T(0.78), { a: 0.035, p: [0, 0, 0], r: [0.04, 0, 0] });
  c.hand('L', T(0.78), 'mag', grab.p, grab.r);
  c.part('mag', T(0.9), { a: 0, ease: 'in' });
  c.hand('L', T(0.9), 'mag', grab.p, grab.r, 'in');
  c.cue(T(0.9), 'magIn');
  c.hand('L', T(0.96), 'mag', [grab.p[0], grab.p[1] - 0.035, grab.p[2]], grab.r, 'out');
  c.hand('L', T(1.0), 'mag', [grab.p[0], grab.p[1] - 0.006, grab.p[2]], grab.r, 'in');
  c.cue(T(1.0), 'slap');
  c.g(T(0.98), tilt).g(
    T(1.03),
    [tilt[0], tilt[1] + 0.012, tilt[2], tilt[3] + 0.06, tilt[4], tilt[5]],
    'out',
  );
  // Slide: locked back from the empty shot (the viewmodel holds it), released here.
  const lock = 0.022;
  c.part('slide', 0, { a: empty ? lock : 0 });
  let end = T(1.05);
  if (empty) {
    c.part('slide', T(1.18), { a: lock });
    c.part('slide', T(1.22), { a: 0, ease: 'in' });
    c.cue(T(1.2), 'slideRelease');
    c.g(
      T(1.24),
      [tilt[0], tilt[1] - 0.01, tilt[2] + 0.015, tilt[3] - 0.08, tilt[4], tilt[5]],
      'out',
    );
    end = T(1.3);
  }
  c.hand('L', Math.min(dur - 0.04, end + 0.25), 'bind');
  c.g(dur, REST);
  c.hand('L', dur, 'bind');
  c.part('mag', dur, {});
  c.part('slide', dur, {});
  return c.build();
}

/** The reload clips of every scan (tactical and empty), timed to its tunables. */
export function reloadClip(id: ScanGunId, empty: boolean): Clip | null {
  const style = RELOAD_STYLES[id];
  const cfg = id === 'pistol' ? SIDEARM : PRIMARIES[SCAN_PRIMARY[id]];
  const dur = empty ? cfg.reloadEmptyTime : cfg.reloadTime;
  switch (style.kind) {
    case 'mag':
      return magReload(style, dur, empty);
    case 'cell':
      return cellReload(style, dur, empty);
    case 'pump':
      return pumpReload(style, dur, empty);
    case 'pistol':
      return pistolReload(style, dur, empty);
    default:
      return null;
  }
}

/** Which loadout primary each scan is (the pistol is the sidearm). */
export const SCAN_PRIMARY: Record<Exclude<ScanGunId, 'pistol'>, PrimaryId> = {
  rifle: 'ar7',
  coil: 'coil',
  iskra: 'iskra',
  shotgun: 'shotgun',
  marksman: 'marksman',
  arc: 'arc',
};

/** Shotgun: the pump racked after every shot, timed to the report's racking sound. */
export function pumpShotClip(): Clip {
  const c = new ClipBuilder(0.62);
  c.g(0, REST).g(0.3, [0, -0.005, 0.01, 0.02, 0.03, 0.08]).g(0.62, REST);
  c.part('pump', 0, {}).part('pump', 0.3, {});
  c.part('pump', 0.4, { a: 0.075, ease: 'out' }).part('pump', 0.46, { a: 0.075 });
  c.part('pump', 0.54, { a: 0, ease: 'in' }).part('pump', 0.62, {});
  // The support hand rides the pump (its bind grip is on it).
  c.hand('L', 0, 'bind').hand('L', 0.3, 'bind');
  c.hand('L', 0.4, 'bind', [0, 0, 0.075], undefined, 'out').hand('L', 0.46, 'bind', [0, 0, 0.075]);
  c.hand('L', 0.54, 'bind', [0, 0, 0], undefined, 'in').hand('L', 0.62, 'bind');
  return c.build(0);
}

/** ARC overheat: the vent cover swings open, steam, the cover snaps shut after the lockout. */
export function ventClip(lockout: number): Clip {
  const d = Math.max(0.8, lockout);
  const c = new ClipBuilder(d);
  const tilt = RELOAD_STYLES.arc.tilt;
  c.g(0, REST)
    .g(0.22, tilt)
    .g(d - 0.3, tilt)
    .g(d, REST);
  c.part('vent', 0, {}).part('vent', 0.08, {});
  // Hinged along its top edge (z axis through the pivot): +z swings the panel out to the right.
  c.part('vent', 0.18, { r: [0, 0, 1.15], ease: 'out' });
  c.part('vent', d - 0.22, { r: [0, 0, 1.05] });
  c.part('vent', d - 0.12, { r: [0, 0, 0], ease: 'in' }).part('vent', d, {});
  c.cue(0.1, 'vent').cue(d - 0.12, 'tick');
  c.hand('L', 0, 'bind').hand('L', d, 'bind');
  return c.build(0.6);
}

/** Inspect (Inspect key): turn the gun to show its side, then its top, and back. */
export function inspectClip(id: ScanGunId): Clip {
  const pistol = id === 'pistol';
  const d = pistol ? 2.2 : 2.8;
  const c = new ClipBuilder(d);
  const k = pistol ? 0.8 : 1;
  const s = d / 2.8;
  c.g(0, REST);
  // Turn the left side to the eye, hold, then roll it over to show the top/right, and back.
  c.g(0.5 * s, [-0.06 * k, 0.05, 0.03, 0.12, 0.5 * k, -0.35 * k]);
  c.g(1.1 * s, [-0.06 * k, 0.055, 0.03, 0.1, 0.56 * k, -0.4 * k], 'lin');
  c.g(1.55 * s, [-0.05, 0.04, -0.01, 0.1, -0.08 * k, 0.62 * k]);
  c.g(2.1 * s, [-0.05, 0.042, -0.01, 0.12, -0.1 * k, 0.66 * k], 'lin');
  c.g(d, REST);
  c.cue(0.12 * s, 'cloth')
    .cue(1.3 * s, 'tick')
    .cue(d - 0.35, 'cloth');
  c.hand('L', 0, 'bind').hand('L', d, 'bind');
  // Partly pinned: the arms turn with the gun (a fully pinned shoulder swung the forearm across
  // the lens on the pistol).
  return c.build(0.35);
}

// ---------------------------------------------------------------------------------------------
// Recoil and handling feel per gun (presentation: the sim's recoil moves the aim, this the gun).

export interface RecoilProfile {
  /** Kick back (m, before ADS reduction), muzzle climb (rad), roll (rad), side jitter (rad). */
  back: number;
  climb: number;
  roll: number;
  jitter: number;
  /** Spring stiffness of the recovery (rad/s) and its damping (< 1 bounces). */
  stiffness: number;
  damping: number;
}

export const RECOIL: Record<ScanGunId, RecoilProfile> = {
  // AR-7: crisp, centred.
  rifle: { back: 0.022, climb: 0.05, roll: 0.02, jitter: 0.01, stiffness: 26, damping: 0.55 },
  // Iskra: a fast, light buzz.
  iskra: { back: 0.012, climb: 0.022, roll: 0.012, jitter: 0.014, stiffness: 34, damping: 0.6 },
  // Coilgun: a long electromagnetic shove straight back and a slow roll.
  coil: { back: 0.06, climb: 0.06, roll: 0.06, jitter: 0.004, stiffness: 14, damping: 0.62 },
  // Shotgun: heavy buck — big climb into the shoulder.
  shotgun: { back: 0.07, climb: 0.2, roll: 0.05, jitter: 0.02, stiffness: 15, damping: 0.5 },
  // Marksman: a hard straight push.
  marksman: { back: 0.065, climb: 0.1, roll: 0.02, jitter: 0.006, stiffness: 17, damping: 0.55 },
  // ARC: barely moves, a shiver.
  arc: { back: 0.008, climb: 0.012, roll: 0.006, jitter: 0.012, stiffness: 36, damping: 0.7 },
  pistol: { back: 0.025, climb: 0.12, roll: 0.03, jitter: 0.012, stiffness: 24, damping: 0.5 },
};

/** Idle breathing per gun: amplitude (m) and rate (Hz) — heavier guns breathe slower and deeper. */
export const BREATH: Record<ScanGunId, { amp: number; hz: number }> = {
  rifle: { amp: 0.0022, hz: 0.28 },
  iskra: { amp: 0.0018, hz: 0.32 },
  coil: { amp: 0.003, hz: 0.24 },
  shotgun: { amp: 0.0028, hz: 0.25 },
  marksman: { amp: 0.0032, hz: 0.22 },
  arc: { amp: 0.0024, hz: 0.27 },
  pistol: { amp: 0.0016, hz: 0.33 },
};

/** A part's transform at a pose, in gun space (pivot, axis from the build manifest). */
export function partMatrix(
  pose: PartPose | undefined,
  pivot: THREE.Vector3,
  axis: THREE.Vector3,
  out = new THREE.Matrix4(),
): THREE.Matrix4 {
  if (!pose) return out.identity();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.r[0], pose.r[1], pose.r[2]));
  const t = axis
    .clone()
    .multiplyScalar(pose.a)
    .add(new THREE.Vector3(pose.p[0], pose.p[1], pose.p[2]));
  // x' = q (x − pivot) + pivot + t
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const off = pivot.clone().sub(pivot.clone().applyQuaternion(q)).add(t);
  return out.copy(m.setPosition(off));
}
