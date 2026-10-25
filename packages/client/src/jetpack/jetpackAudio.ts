/**
 * Jetpack sound (synthesized like the game's other layers, plus the CC0 foley already shipped):
 * a continuous thrust roar (low rumble + mid roar + hiss + a growling tone) pitched and loudened
 * by thrust, a softer hover hiss, sputter coughs and low-fuel beeps in the last seconds, the
 * ignition whoosh, the cut-off, the landing thud and the pickup chime. Other flyers get their own
 * roar voices, panned and attenuated by where they are: flying is loud, and it gives you away.
 */

type Play = (
  name: string,
  opts?: { gain?: number; rate?: number; delay?: number; lowpass?: number; variants?: boolean },
) => boolean;

interface Voice {
  rumble: GainNode;
  rumbleLp: BiquadFilterNode;
  roar: GainNode;
  roarBp: BiquadFilterNode;
  hiss: GainNode;
  tone: GainNode;
  osc: OscillatorNode;
  pan: StereoPannerNode | null;
}

/** Remote flyers heard at once (the nearest). */
export const REMOTE_VOICES = 4;

export class JetpackSound {
  private own: Voice | null = null;
  private readonly remotes: (Voice | null)[] = Array.from({ length: REMOTE_VOICES }, () => null);

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly play: Play,
  ) {}

  private voice(panned: boolean): Voice {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const mk = (type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const g = (): GainNode => {
      const n = ctx.createGain();
      n.gain.value = 0;
      return n;
    };
    const pan = panned ? ctx.createStereoPanner() : null;
    const bus = ctx.createGain();
    if (pan) bus.connect(pan).connect(this.out);
    else bus.connect(this.out);
    const rumbleLp = mk('lowpass', 220, 0.9);
    const rumble = g();
    src.connect(rumbleLp).connect(rumble).connect(bus);
    const roarBp = mk('bandpass', 700, 0.6);
    const roar = g();
    src.connect(roarBp).connect(roar).connect(bus);
    const hiss = g();
    src
      .connect(mk('highpass', 2600, 0.5))
      .connect(hiss)
      .connect(bus);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 46;
    const tone = g();
    osc
      .connect(mk('lowpass', 320, 1.2))
      .connect(tone)
      .connect(bus);
    src.start(0, Math.random() * 0.5);
    osc.start();
    return { rumble, rumbleLp, roar, roarBp, hiss, tone, osc, pan };
  }

  /**
   * Set a voice: `active` (the pack is lit), `thrust` 0–1 (Jump held, smoothed), `power` the
   * sputter multiplier (cut-outs dip it), `level` the distance gain, `pan` −1..1.
   */
  private drive(
    v: Voice,
    active: boolean,
    thrust: number,
    power: number,
    level: number,
    pan = 0,
  ): void {
    const t = this.ctx.currentTime;
    const k = active ? level : 0;
    const p = Math.max(0, Math.min(1, power));
    const th = Math.max(0, Math.min(1, thrust)) * p;
    const tc = active ? 0.06 : 0.12;
    v.rumble.gain.setTargetAtTime(k * (0.08 + 0.34 * th), t, tc);
    v.rumbleLp.frequency.setTargetAtTime(150 + 520 * th, t, 0.08);
    v.roar.gain.setTargetAtTime(k * (0.02 + 0.2 * th), t, tc);
    v.roarBp.frequency.setTargetAtTime(420 + 900 * th, t, 0.08);
    v.hiss.gain.setTargetAtTime(k * (0.035 + 0.06 * th) * (0.6 + 0.4 * p), t, tc);
    v.tone.gain.setTargetAtTime(k * (0.015 + 0.07 * th), t, tc);
    v.osc.frequency.setTargetAtTime(40 + 34 * th, t, 0.1);
    v.pan?.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
  }

  /** Our own pack, every frame. */
  setOwn(active: boolean, thrust: number, power: number): void {
    if (!active && !this.own) return;
    this.own ??= this.voice(false);
    this.drive(this.own, active, thrust, power, 1);
  }

  /** Another flyer in remote slot `i` (0..REMOTE_VOICES-1), every frame. */
  setRemote(i: number, active: boolean, thrust: number, distance: number, pan: number): void {
    if (i < 0 || i >= REMOTE_VOICES) return;
    if (!active && !this.remotes[i]) return;
    const v = (this.remotes[i] ??= this.voice(true));
    this.drive(v, active, thrust, 1, falloff(distance) * 0.9, pan);
  }

  private burst(
    t: number,
    filter: BiquadFilterType,
    f0: number,
    f1: number,
    q: number,
    peak: number,
    dur: number,
    attack = 0.005,
  ): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + dur + 0.05);
  }

  private tone(
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    peak: number,
    dur: number,
  ): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Ignition: a valve click, a rising whoosh and a low boom as the thrusters catch. */
  ignite(distance = 0): void {
    const t = this.ctx.currentTime;
    const k = falloff(distance);
    this.play('gear_click', { variants: true, gain: 0.5 * k, rate: 1.3 });
    this.burst(t, 'bandpass', 260, 3200, 0.9, 0.5 * k, 0.38, 0.02);
    this.burst(t + 0.05, 'lowpass', 900, 120, 0.7, 0.55 * k, 0.5);
    this.tone(t + 0.04, 'sine', 95, 38, 0.45 * k, 0.45);
  }

  /** A sputter cut-out: a cough of the thrusters. */
  cough(distance = 0): void {
    const t = this.ctx.currentTime;
    const k = falloff(distance);
    this.burst(t, 'lowpass', 600, 160, 0.8, 0.28 * k, 0.12);
    this.tone(t, 'square', 70, 40, 0.06 * k, 0.1);
  }

  /** Low-fuel warning beep (higher as it runs out: `urgency` 0–1). */
  beep(urgency: number): void {
    const t = this.ctx.currentTime;
    const f = 980 + 520 * urgency;
    this.tone(t, 'square', f, f, 0.045, 0.09);
    this.tone(t, 'sine', f * 2, f * 2, 0.02, 0.07);
  }

  /** Out of fuel: a pop, the turbine winding down, a last cough. */
  cutoff(distance = 0): void {
    const t = this.ctx.currentTime;
    const k = falloff(distance);
    this.burst(t, 'bandpass', 2200, 300, 1.1, 0.35 * k, 0.5);
    this.tone(t, 'sawtooth', 420, 70, 0.08 * k, 0.6);
    this.burst(t + 0.18, 'lowpass', 500, 120, 0.8, 0.22 * k, 0.15);
    this.play('metal_click', { variants: true, gain: 0.3 * k, delay: 0.05 });
  }

  /** The drop's touchdown: a deep thud through the pack and a gear clank. */
  land(impact: number, distance = 0): void {
    const t = this.ctx.currentTime;
    const k = falloff(distance) * Math.min(1, 0.45 + impact * 0.06);
    if (!this.play('step_concrete', { variants: true, gain: 0.9 * k, rate: 0.7 })) {
      this.burst(t, 'lowpass', 420, 90, 0.8, 0.6 * k, 0.18);
    }
    this.play('impactPunch_heavy', { variants: true, gain: 0.55 * k, rate: 0.62 });
    this.play('gear_click', { variants: true, gain: 0.6 * k, rate: 0.8, delay: 0.02 });
    this.play('metal_click', { variants: true, gain: 0.35 * k, rate: 0.7, delay: 0.04 });
    this.tone(t, 'sine', 72, 30, 0.7 * k, 0.28);
    this.burst(t, 'lowpass', 300, 80, 0.7, 0.4 * k, 0.25);
  }

  /** Picked one up: a bright two-note chime and the harness clicking on. */
  pickup(): void {
    const t = this.ctx.currentTime;
    this.tone(t, 'sine', 880, 880, 0.12, 0.16);
    this.tone(t + 0.09, 'sine', 1320, 1320, 0.12, 0.28);
    this.tone(t + 0.09, 'triangle', 660, 660, 0.05, 0.3);
    this.play('gear_click', { variants: true, gain: 0.5, delay: 0.05 });
    this.play('cloth', { variants: true, gain: 0.4, delay: 0.02 });
  }
}

/** Distance gain (m): full within 4 m, ~0.3 at 30 m, silent past ~90 m. */
export function falloff(distance: number): number {
  if (distance <= 4) return 1;
  return Math.max(0, Math.min(1, (4 / distance) * (1 - Math.min(1, distance / 90)) * 1.6));
}
