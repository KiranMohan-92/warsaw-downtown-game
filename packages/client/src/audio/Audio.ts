/**
 * Sound: CC0 recordings (real firearms, foley, footsteps, rain, thunder, explosions — see
 * ASSETS.md) layered with small synthesized parts where a recording lacks something (e.g. the
 * shooter-side low thump under a gunshot). Every sound falls back to pure synthesis if its
 * samples haven't loaded. Positional (3D) audio arrives in M4; clips are already mono for it.
 */
import type { SurfaceKind } from '@wd/shared';
import { JetpackSound } from '../jetpack/jetpackAudio.ts';
import {
  blastAcoustics,
  blastFalloff,
  type BlastContext,
  type BlastAcoustics,
} from './blastAcoustics.ts';
import { BulletLayerGate, bulletLayer } from './bulletLayers.ts';
import { rainCoverMix, type RainCoverMix, type RainShelterLike } from './rainCover.ts';

const AUDIO_BASE = `${import.meta.env.BASE_URL}audio/`;

/** Handling foley cues (the keyframes of render/fpAnims.ts clips). */
export type FoleyCue =
  | 'magRelease'
  | 'magOut'
  | 'magDrop'
  | 'pouch'
  | 'magIn'
  | 'slap'
  | 'boltBack'
  | 'boltForward'
  | 'pumpBack'
  | 'pumpForward'
  | 'shell'
  | 'cellOut'
  | 'cellIn'
  | 'cellCharge'
  | 'vent'
  | 'slideRelease'
  | 'cloth'
  | 'tick';

/** Voice actors in `public/audio/voice<n>_*` (tools/audio/process.py). */
const VOICES = 4;

/** Impact clip families per surface (Kenney Impact Sounds, CC0). */
const IMPACT_CLIPS: Record<SurfaceKind, readonly string[]> = {
  stone: ['impactMining', 'impactGeneric_light'],
  metal: ['impactMetal_light', 'impactPlate_light', 'impactTin_medium'],
  wood: ['impactWood_light'],
  glass: ['impactGlass_light'],
  soft: ['impactSoft_medium'],
};

const FOOTSTEP_CLIP: Record<SurfaceKind, 'step_concrete' | 'step_wood' | 'step_grass'> = {
  stone: 'step_concrete',
  metal: 'step_concrete',
  wood: 'step_wood',
  glass: 'step_concrete',
  soft: 'step_grass',
};

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.7;
  /** Fetched (encoded) clips, decoded once the AudioContext exists. */
  private readonly encoded = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private preloading: Promise<void> | null = null;

  /** Fetch every clip listed in the manifest (no AudioContext needed yet). */
  preload(): Promise<void> {
    this.preloading ??= (async () => {
      try {
        const res = await fetch(`${AUDIO_BASE}manifest.json`);
        if (!res.ok) return;
        const manifest = (await res.json()) as Record<string, unknown>;
        // Each clip succeeds or fails on its own; wait for all of them before decoding.
        await Promise.allSettled(
          Object.keys(manifest).map(async (name) => {
            const r = await fetch(`${AUDIO_BASE}${name}.ogg`);
            if (r.ok) this.encoded.set(name, await r.arrayBuffer());
          }),
        );
        if (this.ctx) await this.decodeAll();
      } catch {
        // Offline / missing assets: synthesized fallbacks cover everything.
      }
    })();
    return this.preloading;
  }

  private async decodeAll(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    await Promise.all(
      [...this.encoded].map(async ([name, data]) => {
        if (this.buffers.has(name)) return;
        try {
          this.buffers.set(name, await ctx.decodeAudioData(data.slice(0)));
        } catch {
          // Undecodable clip: that sound uses its synthesized fallback.
        }
      }),
    );
    if (this.rainLevel > 0) this.setRain(this.rainLevel);
  }

  /** Decoded clip count (tests / diagnostics). */
  get loadedClips(): number {
    return this.buffers.size;
  }

  /** Loaded variants `${prefix}_<n>` (any numbering), for random picks. */
  private variants(prefix: string): string[] {
    const re = new RegExp(`^${prefix}_\\d+$`);
    return [...this.buffers.keys()].filter((k) => re.test(k));
  }

  /** Samples actually started (tests / diagnostics), and the most recent names. */
  samplesPlayed = 0;
  readonly recentSamples: string[] = [];

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  /** Play a clip (or a random variant of a prefix). Returns false if it isn't loaded. */
  private play(
    name: string,
    opts: {
      gain?: number;
      rate?: number;
      delay?: number;
      lowpass?: number;
      pan?: number;
      variants?: boolean;
    } = {},
  ): boolean {
    if (!this.ready) return false;
    const pool = opts.variants ? this.variants(name) : [name];
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const buf = pick ? this.buffers.get(pick) : undefined;
    if (!buf) return false;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 0.97 + Math.random() * 0.06;
    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 1;
    let node: AudioNode = src;
    const cleanup: AudioNode[] = [];
    if (opts.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.lowpass;
      node = node.connect(f);
      cleanup.push(f);
    }
    if (typeof opts.pan === 'number' && 'createStereoPanner' in ctx) {
      const p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      node = node.connect(p);
      cleanup.push(p);
    }
    node.connect(g).connect(this.master!);
    cleanup.push(src, g);
    src.onended = () => {
      for (const n of cleanup) n.disconnect();
    };
    src.start(ctx.currentTime + (opts.delay ?? 0));
    this.samplesPlayed++;
    this.recentSamples.push(pick!);
    if (this.recentSamples.length > 20) this.recentSamples.shift();
    return true;
  }

  /** Must be called from a user gesture (browsers block autoplay). */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      this.master.gain.value = this.volume;
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
    void this.preload().then(() => this.decodeAll());
    if (this.rainLevel > 0) this.setRain(this.rainLevel);
  }

  private jetSound: JetpackSound | null = null;

  /** The jetpack's layers (jetpack/jetpackAudio.ts), once audio is unlocked and running. */
  get jetpack(): JetpackSound | null {
    if (!this.ready || !this.noise) return null;
    return (this.jetSound ??= new JetpackSound(this.ctx!, this.master!, this.noise, (n, o) =>
      this.play(n, o),
    ));
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private env(g: GainNode, t: number, attack: number, peak: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noiseBurst(
    t: number,
    filter: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
    decay: number,
    attack = 0.001,
    opts: { pan?: number; lowpass?: number } = {},
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    // Loop so envelopes longer than the 1 s noise buffer (thunder rumble) aren't cut short.
    src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, attack, peak, decay);
    let node: AudioNode = f;
    const cleanup: AudioNode[] = [src, f, g];
    if (opts.lowpass) {
      const occlusion = ctx.createBiquadFilter();
      occlusion.type = 'lowpass';
      occlusion.frequency.value = opts.lowpass;
      node = node.connect(occlusion);
      cleanup.push(occlusion);
    }
    if (typeof opts.pan === 'number' && 'createStereoPanner' in ctx) {
      const p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      node = node.connect(p);
      cleanup.push(p);
    }
    src.connect(f);
    node.connect(g).connect(this.master!);
    src.onended = () => {
      for (const n of cleanup) n.disconnect();
    };
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  private tone(
    t: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    peak: number,
    decay: number,
    opts: { pan?: number; lowpass?: number } = {},
  ): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + decay);
    const g = ctx.createGain();
    this.env(g, t, 0.002, peak, decay);
    let node: AudioNode = o;
    const cleanup: AudioNode[] = [o, g];
    if (opts.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.lowpass;
      node = node.connect(f);
      cleanup.push(f);
    }
    if (typeof opts.pan === 'number' && 'createStereoPanner' in ctx) {
      const p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      node = node.connect(p);
      cleanup.push(p);
    }
    node.connect(g).connect(this.master!);
    o.onended = () => {
      for (const n of cleanup) n.disconnect();
    };
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  private get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Coilgun charge: a rising capacitor whine over `time` seconds (the shot follows). */
  coilCharge(time: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 'sawtooth', 380, 2400, 0.05, time + 0.05);
    this.tone(t, 'sine', 760, 4800, 0.04, time + 0.05);
  }

  /** Coilgun report: no powder bang — a sharp magnetic crack and a short metallic ring. */
  coilShot(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'highpass', 3500, 0.8, 0.45, 0.05);
    this.ring(t, 2600, 0.12, 0.35, [1, 2.4, 3.9]);
    this.tone(t, 'sine', 180, 60, 0.35, 0.12);
  }

  /** Iskra SMG: the rifle report, lighter and faster (smaller calibre, high rate). */
  iskraShot(): void {
    if (!this.ready) return;
    if (!this.play('pistol_shot', { gain: 0.6, rate: 1.25 + Math.random() * 0.08 })) {
      const t = this.ctx!.currentTime;
      this.noiseBurst(t, 'bandpass', 2400, 1.2, 0.5, 0.06);
    }
  }

  gunshot(kind: 'rifle' | 'sidearm' = 'rifle'): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (this.play(kind === 'sidearm' ? 'pistol_shot' : 'rifle_shot', { gain: 0.95 })) {
      // The recording is mic'd in front of the shooter; add the low chest-thump you feel holding it.
      this.tone(
        t,
        'sine',
        kind === 'sidearm' ? 160 : 120,
        40,
        kind === 'sidearm' ? 0.35 : 0.5,
        0.11,
      );
      this.noiseBurst(t + 0.004, 'bandpass', 5200, 3, 0.08, 0.03); // action cycling
      return;
    }
    if (kind === 'sidearm') {
      // Pistol: sharper, higher, less low end, shorter tail.
      this.noiseBurst(t, 'highpass', 2800, 0.7, 0.85, 0.04);
      this.noiseBurst(t, 'bandpass', 1400, 1.1, 0.6, 0.08);
      this.tone(t, 'sine', 190, 70, 0.55, 0.09);
      this.noiseBurst(t + 0.01, 'lowpass', 1800, 0.5, 0.12, 0.3, 0.02);
      this.noiseBurst(t + 0.03, 'bandpass', 4200, 4, 0.14, 0.025); // slide
      return;
    }
    this.noiseBurst(t, 'highpass', 2200, 0.7, 0.9, 0.05); // crack
    this.noiseBurst(t, 'bandpass', 900, 0.9, 0.8, 0.11); // body
    this.tone(t, 'sine', 140, 42, 0.9, 0.14); // thump
    this.noiseBurst(t + 0.01, 'lowpass', 1400, 0.5, 0.18, 0.45, 0.02); // room tail
    this.noiseBurst(t + 0.004, 'bandpass', 5200, 3, 0.12, 0.03); // mechanism
  }

  /**
   * Modal synthesis: a struck metal part rings at inharmonic partial ratios (like a bar or plate),
   * each partial decaying at its own rate. That inharmonicity is what reads as "real steel".
   */
  private ring(
    t: number,
    f0: number,
    gain: number,
    decay: number,
    ratios = [1, 2.76, 5.4, 8.93],
  ): void {
    const ctx = this.ctx!;
    ratios.forEach((ratio, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f0 * ratio * (0.99 + Math.random() * 0.02);
      const g = ctx.createGain();
      const partialGain = gain / (1 + i * 0.9);
      const partialDecay = decay / (1 + i * 0.6);
      this.env(g, t, 0.001, partialGain, partialDecay);
      o.connect(g).connect(this.master!);
      o.start(t);
      o.stop(t + partialDecay + 0.05);
    });
  }

  /** Band-limited noise whose centre frequency sweeps (scrapes, cloth drags, whooshes). */
  private sweep(
    t: number,
    from: number,
    to: number,
    q: number,
    gain: number,
    dur: number,
    attack = 0.01,
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    this.env(g, t, attack, gain, dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + dur + 0.05);
  }

  /** Short dull knock of polymer/wood (a grip or stock being grabbed). */
  private knock(t: number, freq: number, gain: number): void {
    this.noiseBurst(t, 'bandpass', freq, 2.5, gain, 0.045);
    this.tone(t, 'sine', freq * 0.5, freq * 0.35, gain * 0.5, 0.05);
  }

  weaponSwitch(to: 'rifle' | 'sidearm' | 'knife'): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const cloth = this.play('cloth', { variants: true, gain: 0.45 });
    if (cloth) {
      if (to === 'rifle') {
        this.play('belt', { gain: 0.5, delay: 0.04 }); // sling
        this.play('gear_click', { variants: true, gain: 0.6, delay: 0.14 });
        this.play('metal_latch', { gain: 0.55, delay: 0.3 }); // receiver into the shoulder
      } else if (to === 'sidearm') {
        this.play('leather', { gain: 0.6, delay: 0.02 }); // holster
        this.play('metal_click', { gain: 0.7, delay: 0.12 });
        this.play('gear_click', { variants: true, gain: 0.45, delay: 0.2 });
      } else {
        this.play('knife_draw', { variants: true, gain: 0.9, delay: 0.02 });
      }
      return;
    }
    // Cloth / gear movement under everything.
    this.sweep(t, 500, 1400, 0.8, 0.14, 0.22, 0.03);
    if (to === 'rifle') {
      this.ring(t + 0.05, 2300, 0.05, 0.12); // sling swivel
      this.ring(t + 0.1, 2750, 0.04, 0.1);
      this.knock(t + 0.16, 700, 0.28); // hand onto the handguard
      this.ring(t + 0.3, 1150, 0.12, 0.22, [1, 2.4, 4.1, 6.9]); // receiver clack into the shoulder
      this.knock(t + 0.3, 420, 0.3);
      this.ring(t + 0.36, 3100, 0.04, 0.06); // magazine rattle
    } else if (to === 'sidearm') {
      this.sweep(t + 0.02, 1500, 3200, 3, 0.16, 0.1); // kydex holster friction
      this.ring(t + 0.1, 3600, 0.08, 0.05); // retention click
      this.knock(t + 0.18, 900, 0.3); // grip into the palm
      this.ring(t + 0.2, 2100, 0.06, 0.1, [1, 2.9, 5.8]); // slide / frame tick
    } else {
      // Knife leaving the sheath: rising metallic scrape then the blade's ring ("shing").
      this.sweep(t + 0.03, 2600, 7400, 9, 0.22, 0.17);
      this.ring(t + 0.19, 2650, 0.07, 0.45, [1, 2.76, 5.4, 8.93, 13.3]);
    }
  }

  knifeSwing(move: 'slash' | 'backhand' | 'thrust' = 'slash'): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.play('cloth', { variants: true, gain: 0.25 });
    if (move === 'thrust') {
      this.sweep(t, 400, 1400, 1.1, 0.4, 0.12, 0.02); // short, punchy push of air
      this.sweep(t, 300, 700, 0.7, 0.12, 0.1, 0.02); // sleeve
      return;
    }
    // Slashes: a long whoosh that rises as the blade accelerates, plus sleeve cloth.
    const [a, b] = move === 'slash' ? [600, 3400] : [750, 3000];
    this.sweep(t, a, b, 1.5, 0.5, 0.19, 0.05);
    this.sweep(t + 0.03, 350, 800, 0.7, 0.14, 0.16, 0.03);
  }

  knifeHit(flesh: boolean): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (
      flesh
        ? this.play('knife_hit', { variants: true, gain: 0.9 })
        : this.play('impactMetal_light', { variants: true, gain: 0.7 })
    ) {
      if (flesh) this.play('impactPunch_heavy', { variants: true, gain: 0.55, rate: 0.9 });
      return;
    }
    if (flesh) {
      this.noiseBurst(t, 'lowpass', 600, 0.9, 0.6, 0.09);
      this.tone(t, 'sine', 120, 60, 0.4, 0.08);
    } else {
      this.noiseBurst(t, 'bandpass', 4500, 8, 0.4, 0.06); // blade on concrete
      this.tone(t, 'triangle', 3100, 2900, 0.08, 0.12);
    }
  }

  grenadePin(): void {
    if (!this.ready) return;
    if (this.play('metal_click', { gain: 0.8, rate: 1.15 })) {
      this.play('gear_click', { variants: true, gain: 0.5, delay: 0.12 }); // spoon
      return;
    }
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'bandpass', 5200, 7, 0.3, 0.03); // pin
    this.noiseBurst(t + 0.12, 'bandpass', 3800, 6, 0.25, 0.03); // spoon
  }

  grenadeThrow(): void {
    if (!this.ready) return;
    if (this.play('cloth', { variants: true, gain: 0.5, rate: 1.1 })) return;
    this.noiseBurst(this.ctx!.currentTime, 'bandpass', 1100, 1.2, 0.2, 0.12, 0.03);
  }

  /** Distance-attenuated (inverse, clamped) for world sounds until positional audio in M4. */
  private falloff(distance: number): number {
    return blastFalloff(distance);
  }

  grenadeBounce(speed: number, distance: number): void {
    if (!this.ready) return;
    const v = Math.min(0.4, speed * 0.05) * this.falloff(distance);
    if (this.play('impactTin_medium', { variants: true, gain: Math.min(1, v * 2.2) })) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'bandpass', 2600 + Math.random() * 800, 6, v, 0.05);
    this.tone(t, 'triangle', 1900, 1700, v * 0.3, 0.06);
  }

  private blastOptions(
    a: BlastAcoustics,
    gain: number,
    lowpass?: number,
  ): {
    gain: number;
    delay: number;
    pan: number;
    lowpass?: number;
  } {
    return {
      gain: gain * a.gainScale,
      delay: a.delay,
      pan: a.pan,
      lowpass: a.lowpass ? Math.min(lowpass ?? a.lowpass, a.lowpass) : lowpass,
    };
  }

  explosion(distance: number, context?: BlastContext): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const a = blastAcoustics(distance, context);
    const d = a.distance;
    const near = d < 30;
    const nearClip = Math.random() < 0.5 ? 'explosion_near' : 'explosion_near_2';
    const mainGain = this.falloff(d / 3);
    // Far blasts lose their highs (air absorption) and arrive quieter.
    const played = near
      ? this.play(nearClip, {
          ...this.blastOptions(a, mainGain, Math.max(1800, 16000 - d * 450)),
        })
      : this.play('explosion_far', this.blastOptions(a, mainGain));
    if (played) {
      if (near)
        this.tone(t + a.delay, 'sine', 70, 26, 0.9 * mainGain * a.gainScale, 0.8, {
          pan: a.pan,
          lowpass: a.lowpass ?? undefined,
        }); // chest thump
      if (near)
        this.play('gear_click', {
          variants: true,
          gain: 0.25 * mainGain * a.gainScale,
          delay: a.delay + 0.35,
          pan: a.pan,
          lowpass: a.lowpass ?? undefined,
        }); // debris
      return;
    }
    const v = this.falloff(d / 3) * a.gainScale;
    // Far explosions lose their highs first.
    const bright = Math.max(500, 5000 - d * 90);
    const route = { pan: a.pan, lowpass: a.lowpass ?? undefined };
    this.noiseBurst(t + a.delay, 'lowpass', bright, 0.5, 1.0 * v, 0.25, 0.001, route); // crack
    this.tone(t + a.delay, 'sine', 80, 28, 1.0 * v, 0.9, route); // body
    this.noiseBurst(t + a.delay + 0.02, 'lowpass', 300, 0.6, 0.9 * v, 1.6, 0.04, route); // rumble
    this.noiseBurst(t + a.delay + 0.25, 'highpass', 3000, 0.7, 0.08 * v, 0.8, 0.2, route); // debris patter
  }

  dryFire(): void {
    if (!this.ready) return;
    if (this.play('metal_click', { gain: 0.8 })) return;
    this.noiseBurst(this.ctx!.currentTime, 'bandpass', 3500, 6, 0.35, 0.03);
  }

  /**
   * Weapon-handling foley at an animation keyframe (render/fpAnims.ts cues: the magazine leaving
   * the well, the slap, the bolt slamming home…), from the CC0 foley already in the manifest,
   * pitched per gun (the pistol lighter, the shotgun/marksman heavier), with synthesized
   * fallbacks. Returns the samples it started (tests).
   */
  foley(cue: FoleyCue, gun = 'rifle'): string[] {
    if (!this.ready) return [];
    const t = this.ctx!.currentTime;
    const pitch = gun === 'pistol' ? 1.15 : gun === 'shotgun' || gun === 'marksman' ? 0.9 : 1;
    const played: string[] = [];
    const p = (name: string, gain: number, rate = 1, delay = 0, variants = false): boolean => {
      const ok = this.play(name, {
        gain,
        rate: rate * pitch * (0.97 + Math.random() * 0.06),
        delay,
        variants,
      });
      if (ok) played.push(name);
      return ok;
    };
    const click = (f: number, v: number, at = 0): void => {
      this.noiseBurst(t + at, 'bandpass', f * pitch, 5, v, 0.04);
      this.tone(t + at, 'square', (f / 4) * pitch, (f / 6) * pitch, v * 0.15, 0.03);
    };
    switch (cue) {
      case 'magRelease':
        if (!p('metal_click', 0.55, 1.25)) click(2600, 0.35);
        break;
      case 'magOut':
        if (!p('gear_click', 0.6, 1, 0, true)) click(1900, 0.3);
        p('cloth', 0.22, 1.1, 0, true);
        break;
      case 'magDrop':
        // It leaves the hand now and hits the ground a moment later.
        if (!p('impactPlate_light', 0.28, 1.2, 0.42, true)) click(900, 0.2, 0.42);
        break;
      case 'pouch':
      case 'cloth':
        if (!p('cloth', 0.35, 1, 0, true)) this.sweep(t, 500, 1400, 0.8, 0.1, 0.18, 0.03);
        if (cue === 'pouch') p('belt', 0.25, 1.1, 0.05);
        break;
      case 'magIn':
        if (!p('metal_latch', 0.85, 0.95)) click(1800, 0.55);
        break;
      case 'slap':
        if (!p('impactPunch_heavy', 0.28, 1.35, 0, true)) click(700, 0.3);
        p('metal_click', 0.3, 0.9, 0.01);
        break;
      case 'boltBack':
        if (!p('metal_latch', 0.7, 0.78)) click(1500, 0.45);
        break;
      case 'boltForward':
      case 'slideRelease':
        if (!p('metal_latch', 1, cue === 'slideRelease' ? 1.15 : 1.02)) click(3200, 0.6);
        p('impactMetal_light', 0.22, 1.1, 0.01, true);
        break;
      case 'pumpBack':
        if (!p('metal_latch', 0.75, 0.72)) click(1400, 0.45);
        break;
      case 'pumpForward':
        if (!p('metal_latch', 0.9, 0.86)) click(1900, 0.55);
        break;
      case 'shell':
        if (!p('metal_click', 0.45, 0.75)) click(1200, 0.3);
        break;
      case 'cellOut':
        this.tone(t, 'sine', 900, 300, 0.08, 0.25); // capacitor winding down
        if (!p('metal_latch', 0.6, 1.2)) click(2400, 0.4);
        break;
      case 'cellIn':
        if (!p('metal_latch', 0.85, 1.1)) click(2000, 0.5);
        this.tone(t + 0.03, 'sine', 1400, 1500, 0.07, 0.08); // contact blip
        break;
      case 'cellCharge':
        this.coilCharge(0.45);
        break;
      case 'vent':
        // The hiss itself is `overheat()` (the sim's event); this is the cover popping open.
        if (!p('metal_click', 0.6, 0.8)) click(1600, 0.4);
        break;
      case 'tick':
        if (!p('gear_click', 0.4, 1.1, 0, true)) click(3000, 0.2);
        break;
    }
    return played;
  }

  reload(duration: number, empty: boolean, kind: 'rifle' | 'sidearm' = 'rifle'): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const clip = kind === 'sidearm' ? 'reload_pistol' : 'reload_rifle';
    const clipLen = this.buffers.get(clip)?.duration ?? 0;
    // The recording must finish (mag seated) as the gun becomes ready — not early, not late: fit
    // its rate within ±15% (beyond that it sounds pitched), then start it later so its end lands at the
    // "seated" point — just before the bolt release on an empty reload.
    const seatedAt = duration * (empty ? 0.78 : 0.95);
    const rate = clipLen > 0 ? Math.min(1.15, Math.max(0.85, clipLen / seatedAt)) : 1;
    const delay = Math.max(0, seatedAt - clipLen / rate);
    if (this.play(clip, { gain: 0.8, rate, delay })) {
      this.play('cloth', { variants: true, gain: 0.35 });
      if (empty) this.play('metal_latch', { delay: duration * 0.85, gain: 0.9 }); // bolt release
      return;
    }
    const click = (at: number, f: number, v = 0.4): void => {
      this.noiseBurst(t + at, 'bandpass', f, 5, v, 0.04);
      this.tone(t + at, 'square', f / 4, f / 6, v * 0.15, 0.03);
    };
    click(duration * 0.18, 2600); // mag release
    click(duration * 0.55, 1800, 0.55); // mag seated
    if (empty) click(duration * 0.85, 3200, 0.6); // bolt release
  }

  footstep(sprint: boolean, crouch: boolean, surface: SurfaceKind = 'stone'): void {
    if (!this.ready) return;
    const gain = crouch ? 0.22 : sprint ? 0.75 : 0.5;
    const clip = FOOTSTEP_CLIP[surface];
    if (this.play(clip, { variants: true, gain, rate: 0.93 + Math.random() * 0.14 })) {
      if (sprint) this.play('cloth', { variants: true, gain: 0.12 }); // gear movement on the run
      if (surface === 'metal') {
        this.play('impactMetal_light', {
          variants: true,
          gain: gain * 0.18,
          rate: 1.3 + Math.random() * 0.2,
        });
      } else if (surface === 'glass') {
        this.play('impactGlass_light', {
          variants: true,
          gain: gain * 0.1,
          rate: 1.25 + Math.random() * 0.15,
        });
      }
      return;
    }
    const v = crouch ? 0.08 : sprint ? 0.32 : 0.2;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'lowpass', 500 + Math.random() * 300, 0.8, v, 0.07);
    this.noiseBurst(t + 0.012, 'bandpass', 2500 + Math.random() * 800, 1.5, v * 0.25, 0.04);
  }

  jump(): void {
    if (!this.ready) return;
    if (this.play('cloth', { variants: true, gain: 0.3 })) return;
    this.noiseBurst(this.ctx!.currentTime, 'lowpass', 700, 0.7, 0.14, 0.08);
  }

  private droneOsc: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode } | null = null;
  private remoteDroneOsc: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode } | null =
    null;

  /** Recon drone up: a buzzing rotor whine (the sound that gives drones away). */
  droneStart(): void {
    if (!this.ready || this.droneOsc) return;
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 185;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 23;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 9;
    lfo.connect(lfoGain).connect(osc.frequency);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 900;
    filt.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.06, ctx.currentTime, 0.15);
    osc.connect(filt).connect(gain).connect(this.master!);
    osc.start();
    lfo.start();
    this.droneOsc = { osc, lfo, gain };
  }

  droneStop(): void {
    const d = this.droneOsc;
    if (!d || !this.ctx) return;
    this.droneOsc = null;
    d.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    d.osc.stop(this.ctx.currentTime + 0.6);
    d.lfo.stop(this.ctx.currentTime + 0.6);
  }

  setRemoteDrones(level: number): void {
    if (!this.ready || !this.ctx || !this.master) return;
    const target = Math.max(0, Math.min(0.045, level));
    if (target <= 0.0001 && !this.remoteDroneOsc) return;
    if (!this.remoteDroneOsc) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 210;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 31;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 12;
      lfo.connect(lfoGain).connect(osc.frequency);
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = 1150;
      filt.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filt).connect(gain).connect(this.master);
      osc.start();
      lfo.start();
      this.remoteDroneOsc = { osc, lfo, gain };
    }
    this.remoteDroneOsc.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
    if (target <= 0.0001) {
      const d = this.remoteDroneOsc;
      this.remoteDroneOsc = null;
      d.osc.stop(this.ctx.currentTime + 0.5);
      d.lfo.stop(this.ctx.currentTime + 0.5);
    }
  }

  /** New player spotted by the drone: short high ping. */
  spotPing(): void {
    if (!this.ready) return;
    this.tone(this.ctx!.currentTime, 'sine', 1760, 1760, 0.12, 0.07);
  }

  /** Smoke grenade pops: a hiss that settles. */
  smokePop(distance: number): void {
    if (!this.ready) return;
    const v = Math.max(0.15, this.falloff(distance / 3));
    this.noiseBurst(this.ctx!.currentTime, 'highpass', 2200, 0.6, 0.35 * v, 1.6, 0.02);
  }

  /** Jammer pulse: a descending electronic zap. */
  jammer(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 'sawtooth', 2400, 180, 0.16, 0.35);
    this.noiseBurst(t, 'bandpass', 3000, 2, 0.12, 0.3);
  }

  /** Radar charge collected at an uplink: short two-tone blip. */
  /** M-12 Grom: a deep boom, then the pump racking. */
  shotgunShot(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'lowpass', 900, 1, 0.55, 0.32);
    this.tone(t, 'sine', 90, 40, 0.5, 0.28);
    this.noiseBurst(t + 0.38, 'bandpass', 2400, 1, 0.09, 0.05);
    this.noiseBurst(t + 0.5, 'bandpass', 1800, 1, 0.1, 0.05);
  }

  /** SR-8 Sokół: a sharp, heavy crack with a long tail. */
  marksmanShot(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'highpass', 1200, 1, 0.5, 0.12);
    this.noiseBurst(t, 'lowpass', 600, 1, 0.45, 0.6);
    this.tone(t, 'triangle', 140, 55, 0.35, 0.3);
  }

  /** ŁUK-3 arc rifle: an electric zap. */
  arcShot(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 'sawtooth', 1400, 260, 0.12, 0.09);
    this.tone(t, 'square', 700, 180, 0.07, 0.07);
    this.noiseBurst(t, 'bandpass', 5200, 1, 0.12, 0.04);
  }

  /** An energy weapon overheated: a venting hiss. */
  overheat(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'highpass', 3000, 1, 0.3, 1.2);
    this.tone(t, 'sine', 880, 440, 0.12, 0.25);
  }

  /** Medkit: a soft rising three-note chime with a breath of air. */
  heal(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    [523, 784, 1047].forEach((f, i) => this.tone(t + i * 0.07, 'sine', f, f * 1.01, 0.22, 0.07));
  }

  pickupCharge(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    [660, 990].forEach((f, i) => this.tone(t + i * 0.06, 'sine', f, f, 0.14, 0.08));
  }

  /** Radar called in: rising three-tone chirp. */
  radarUplink(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    [880, 1175, 1568].forEach((f, i) => this.tone(t + i * 0.07, 'sine', f, f * 1.02, 0.18, 0.12));
  }

  /** Climb/vault: gear rattle + cloth (hands on the ledge). */
  traverse(kind: 'mantle' | 'vault'): void {
    if (!this.ready) return;
    const a = this.play('cloth', { variants: true, gain: 0.45 });
    const b = this.play('gear_click', {
      variants: true,
      gain: kind === 'vault' ? 0.35 : 0.5,
      delay: 0.08,
    });
    if (a || b) return;
    this.noiseBurst(this.ctx!.currentTime, 'bandpass', 1200, 1.2, 0.2, 0.18);
  }

  /**
   * Slide: a knee/boot drop onto the ground, cloth and a gear rattle, and the scrape of the
   * slide itself (filtered noise falling in pitch as it slows). Existing CC0 foley + synthesis.
   */
  slide(speed: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const k = Math.min(1, speed / 7);
    this.play('step_concrete', { variants: true, gain: 0.5 * k, rate: 0.7 });
    this.play('cloth', { variants: true, gain: 0.5, rate: 0.9, delay: 0.02 });
    this.play('gear_click', { variants: true, gain: 0.25, delay: 0.05 });
    // Scrape: bandpassed noise sweeping down over the slide's ~0.75 s.
    this.sweep(t, 1400, 380, 0.9, 0.16 * k, 0.75, 0.02);
    this.noiseBurst(t, 'lowpass', 420, 0.7, 0.18 * k, 0.12);
  }

  land(impactSpeed: number): void {
    if (!this.ready) return;
    const v = Math.min(0.7, 0.1 + impactSpeed * 0.04);
    const t = this.ctx!.currentTime;
    if (this.play('step_concrete', { variants: true, gain: Math.min(1, v * 1.6), rate: 0.85 })) {
      this.play('step_concrete', { variants: true, gain: v, rate: 0.8, delay: 0.03 });
      this.play('gear_click', { variants: true, gain: v * 0.5 });
      this.tone(t, 'sine', 90, 45, v * 0.5, 0.12);
      return;
    }
    this.noiseBurst(t, 'lowpass', 380, 0.8, v, 0.14);
    this.tone(t, 'sine', 90, 45, v * 0.6, 0.12);
  }

  private rainGain: GainNode | null = null;
  private rainBedGain: GainNode | null = null;
  private rainLevel = 0;

  /** Continuous rain bed (0 = off). Safe to call before unlock; applied once audio starts. */
  private rainSource: AudioBufferSourceNode | null = null;

  private rollGain: GainNode | null = null;
  private rollFilter: BiquadFilterNode | null = null;

  /** Skateboard wheels on the pavement: filtered noise, pitch and level with speed (m/s). */
  setRoll(speed: number): void {
    if (!this.ctx || !this.noise || !this.master) return;
    if (!this.rollGain) {
      if (speed <= 0) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.8;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(bp).connect(lp).connect(g).connect(this.master);
      src.start();
      this.rollGain = g;
      this.rollFilter = bp;
    }
    const k = Math.min(1, speed / 9);
    const t = this.ctx.currentTime;
    this.rollGain.gain.setTargetAtTime(k * 0.16, t, 0.08);
    this.rollFilter!.frequency.setTargetAtTime(160 + k * 420, t, 0.1);
  }

  /** One synthesized diesel per truck (slot), built on first use and kept (no per-frame nodes). */
  private readonly engines = new Map<
    number,
    { gain: GainNode; lp: BiquadFilterNode; osc: OscillatorNode[]; rumble: BiquadFilterNode }
  >();

  /**
   * A truck's engine (synthesized like the rest: no samples): a two-oscillator diesel (saw +
   * square an octave up) through a low-pass that opens with the revs, over a band of filtered
   * noise for the rumble. `rpm` 0 (idle) … 1 (flat out); `level` the loudness at the listener
   * (0 = silent: off, far, or wrecked). Pitch by speed and throttle, set smoothly.
   */
  setEngine(slot: number, level: number, rpm: number): void {
    if (!this.ctx || !this.noise || !this.master) return;
    let e = this.engines.get(slot);
    if (!e) {
      if (level <= 0) return;
      const ctx = this.ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2.5;
      const a = ctx.createOscillator();
      a.type = 'sawtooth';
      const b = ctx.createOscillator();
      b.type = 'square';
      const bGain = ctx.createGain();
      bGain.gain.value = 0.35;
      a.connect(lp);
      b.connect(bGain).connect(lp);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const rumble = ctx.createBiquadFilter();
      rumble.type = 'bandpass';
      rumble.Q.value = 1.4;
      const rGain = ctx.createGain();
      rGain.gain.value = 0.55;
      src.connect(rumble).connect(rGain).connect(lp);
      lp.connect(gain).connect(this.master);
      a.start();
      b.start();
      src.start();
      e = { gain, lp, osc: [a, b], rumble };
      this.engines.set(slot, e);
    }
    const t = this.ctx.currentTime;
    const r = Math.max(0, Math.min(1, rpm));
    const f = 34 + r * 78; // ~2000 rpm idle firing note → ~6600 rpm
    e.osc[0]!.frequency.setTargetAtTime(f, t, 0.06);
    e.osc[1]!.frequency.setTargetAtTime(f * 2.01, t, 0.06);
    e.lp.frequency.setTargetAtTime(240 + r * 1300, t, 0.08);
    e.rumble.frequency.setTargetAtTime(70 + r * 160, t, 0.1);
    e.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * (0.07 + r * 0.06), t, 0.08);
  }

  /** A truck hitting something: a heavy metal thud (louder with the impact speed). */
  vehicleImpact(speed: number, distance: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const k = Math.min(1, speed / 10) * Math.max(0, 1 - distance / 60);
    if (k <= 0.02) return;
    this.noiseBurst(t, 'lowpass', 380, 0.8, 0.5 * k, 0.32);
    this.tone(t, 'sine', 90, 38, 0.45 * k, 0.28);
    this.noiseBurst(t + 0.02, 'bandpass', 2400, 3, 0.12 * k, 0.18);
  }

  /** Getting in or out: a door clunk. */
  vehicleDoor(distance = 0): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const k = Math.max(0, 1 - distance / 25);
    if (k <= 0) return;
    this.noiseBurst(t, 'bandpass', 900, 2, 0.22 * k, 0.12);
    this.tone(t, 'square', 140, 70, 0.08 * k, 0.1);
  }

  /** Rain bus: every rain layer goes through the cover filter (muffled under cover). */
  private rainBus: BiquadFilterNode | null = null;
  private rainBusGain: GainNode | null = null;
  private drumGain: GainNode | null = null;
  private rainCover: RainCoverMix = rainCoverMix({ roof: Infinity, open: 1 });

  private ensureRainBus(): BiquadFilterNode {
    if (!this.rainBus) {
      const ctx = this.ctx!;
      this.rainBus = ctx.createBiquadFilter();
      this.rainBus.type = 'lowpass';
      this.rainBus.frequency.value = this.rainCover.cutoff;
      this.rainBus.Q.value = 0.5;
      this.rainBusGain = ctx.createGain();
      this.rainBusGain.gain.value = this.rainCover.bed;
      this.rainBus.connect(this.rainBusGain).connect(this.master!);
    }
    return this.rainBus;
  }

  /**
   * Where the listener stands (render/rainOcclusion `rainShelter`): muffled under cover, drumming
   * on a roof close overhead. Cheap to call often (only targets move).
   */
  setRainCover(s: RainShelterLike): void {
    this.rainCover = rainCoverMix(s);
    if (!this.ctx || !this.rainBus) return;
    const t = this.ctx.currentTime;
    this.rainBus.frequency.setTargetAtTime(this.rainCover.cutoff, t, 0.25);
    this.rainBusGain!.gain.setTargetAtTime(this.rainCover.bed, t, 0.25);
    this.applyDrum();
  }

  /** The roof layer: the rain bed pitched down and band-passed (patter on sheet and canvas). */
  private applyDrum(): void {
    if (!this.ctx || !this.master) return;
    const level = this.rainLevel * this.rainCover.drum;
    const src = this.buffers.get('rain_loop') ?? this.noise;
    if (!this.drumGain) {
      if (level <= 0 || !src) return;
      const ctx = this.ctx;
      const s = ctx.createBufferSource();
      s.buffer = src;
      s.loop = true;
      s.playbackRate.value = 0.62;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 520;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = 0;
      s.connect(bp).connect(g).connect(this.master);
      s.start();
      this.drumGain = g;
    }
    this.drumGain.gain.setTargetAtTime(level * 0.5, this.ctx.currentTime, 0.3);
  }

  setRain(level: number): void {
    this.rainLevel = level;
    if (!this.ctx || !this.noise) return;
    this.ensureRainBus();
    this.applyDrum();
    const bed = this.buffers.get('rain_loop');
    if (bed && !this.rainSource) {
      // Recorded rain replaces the synthesized noise bed once it has loaded: crossfade, so
      // steady rain doesn't dip while the recording fades in.
      const old = this.rainGain;
      if (old) {
        old.gain.setTargetAtTime(0, this.ctx.currentTime, 0.8);
        setTimeout(() => old.disconnect(), 5000);
      }
      this.rainGain = null;
      const src = this.ctx.createBufferSource();
      src.buffer = bed;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.ensureRainBus());
      src.start();
      this.rainSource = src;
      this.rainBedGain = g;
    }
    if (this.rainBedGain) {
      this.rainBedGain.gain.setTargetAtTime(level * 0.55, this.ctx.currentTime, 0.8);
      return;
    }
    if (!this.rainGain) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      this.rainGain = ctx.createGain();
      this.rainGain.gain.value = 0;
      src.connect(hp).connect(lp).connect(this.rainGain).connect(this.ensureRainBus());
      src.start();
    }
    this.rainGain.gain.setTargetAtTime(level * 0.14, this.ctx.currentTime, 0.6);
  }

  /** Rolling thunder; farther strikes are duller and quieter. */
  thunder(distance: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (
      this.play('thunder', {
        gain: Math.max(0.35, 0.9 - distance * 0.15),
        rate: 1 - distance * 0.04,
        lowpass: 9000 - distance * 1800,
      })
    )
      return;
    const v = Math.max(0.15, 0.7 - distance * 0.15);
    this.noiseBurst(t, 'lowpass', 900 - distance * 180, 0.7, v * 0.6, 0.35, 0.01); // crack
    this.noiseBurst(t + 0.05, 'lowpass', 220, 0.6, v, 2.6, 0.25); // rumble
    this.tone(t + 0.05, 'sine', 55, 32, v * 0.5, 2.2);
  }

  /** Blade-on-blade parry: bright metallic clash (recorded latch + synthesized ring). */
  parry(): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.play('metal_latch', { gain: 0.9, rate: 1.25 });
    this.play('impactMetal_light', { variants: true, gain: 0.8 });
    this.ring(t, 1900, 0.18, 0.5, [1, 2.76, 5.4, 8.93]);
  }

  /** Strike absorbed by the forearm guard: dull thud + cloth. */
  guardBlock(broken: boolean): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (
      !this.play('impactPunch_heavy', {
        variants: true,
        gain: broken ? 1 : 0.7,
        rate: broken ? 0.75 : 0.95,
      })
    ) {
      this.knock(t, 500, 0.5);
    }
    this.play('cloth', { variants: true, gain: 0.4 });
    if (broken) this.tone(t, 'sine', 110, 50, 0.5, 0.25);
  }

  /** An opponent's chamber close by: the rustle of the arm drawing back (a sound tell). */
  chamberCue(distance: number): void {
    if (!this.ready) return;
    const v = Math.max(0.15, 0.6 - distance * 0.08);
    if (!this.play('cloth', { variants: true, gain: v, rate: 1.2 })) {
      this.sweep(this.ctx!.currentTime, 600, 1500, 1, v * 0.4, 0.15, 0.02);
    }
  }

  /** Someone else's coilgun: only a faint crack, and only within ~25 m (it is silent). */
  remoteCoilShot(distance: number, context?: BlastContext): void {
    if (!this.ready) return;
    const a = blastAcoustics(distance, context);
    if (a.distance > 25) return;
    const t = this.ctx!.currentTime + a.delay;
    const v = this.falloff(a.distance / 2) * 0.35 * a.gainScale;
    this.noiseBurst(t, 'highpass', 3500, 0.8, v, 0.04, 0.001, {
      pan: a.pan,
      lowpass: a.lowpass ?? undefined,
    });
  }

  /** Someone else's report: directional, delayed and muffled by visible cover. */
  remoteGunshot(kind: 'rifle' | 'sidearm', distance: number, context?: BlastContext): void {
    if (!this.ready) return;
    const a = blastAcoustics(distance, context);
    const v = Math.max(0.12, this.falloff(a.distance / 4)) * 0.8;
    const played = this.play(
      kind === 'sidearm' ? 'pistol_shot' : 'rifle_shot',
      this.blastOptions(a, v, Math.max(1500, 16000 - a.distance * 180)),
    );
    if (!played) {
      const t = this.ctx!.currentTime + a.delay;
      this.noiseBurst(
        t,
        'lowpass',
        Math.max(900, 5000 - a.distance * 40),
        0.7,
        v * 0.8 * a.gainScale,
        0.12,
        0.001,
        { pan: a.pan, lowpass: a.lowpass ?? undefined },
      );
    }
  }

  /** Bullet striking a surface near the listener: the sound of what it hit. */
  /** One synthesized bullet layer per `BULLET_LAYER_GAP` (shotgun pellets share one). */
  private readonly bulletGate = new BulletLayerGate();

  /**
   * A hit on the world. `bullet` (default) adds the synthesized bullet layer (crack, material,
   * ricochet); props knocked by a truck pass false and keep the plain material clip.
   */
  bulletImpact(distance: number, surface: SurfaceKind = 'stone', bullet = true): void {
    if (!this.ready || distance > 45) return;
    const v = this.falloff(distance) * 0.55;
    const clip = IMPACT_CLIPS[surface];
    const played = this.play(clip[Math.floor(Math.random() * clip.length)]!, {
      variants: true,
      gain: v * (surface === 'soft' ? 0.8 : 1),
      rate: 1.05 + Math.random() * 0.25,
    });
    // The bullet itself: a synthesized crack + material answer (+ now and then a ricochet) over
    // the recorded knock (bulletLayers.ts). Without the clip the layer alone carries the hit.
    const t = this.ctx!.currentTime;
    const voices = bullet ? bulletLayer(surface, distance, played ? v : v * 1.3, Math.random) : [];
    if (!played && !voices.length) {
      // No clip and no layer (a prop knock, or beyond the layer's range): the plain fallback tick.
      this.noiseBurst(t, 'bandpass', 3200 + Math.random() * 1500, 4, v, 0.03);
      this.noiseBurst(t + 0.01, 'highpass', 5000, 0.7, v * 0.3, 0.06);
      return;
    }
    // Only a layer that will play takes the gate (a far, silent pellet must not mute a near one).
    if (!voices.length || !this.bulletGate.open(t)) return;
    for (const voice of voices) {
      const at = t + voice.delay;
      if (voice.kind === 'noise')
        this.noiseBurst(at, voice.filter, voice.freq, voice.q, voice.gain, voice.decay);
      else if (voice.kind === 'tone')
        this.tone(at, voice.type, voice.f0, voice.f1, voice.gain, voice.decay);
      else this.sweep(at, voice.from, voice.to, voice.q, voice.gain, voice.dur, 0.004);
    }
  }

  /** A player taking a hit: one of their voice's grunts (throttled so a burst isn't a chorus). */
  hurt(voice: number, distance: number, who: string): void {
    if (!this.ready || distance > 40) return;
    const now = this.ctx!.currentTime;
    const v = ((voice % VOICES) + VOICES) % VOICES;
    if (now < (this.hurtUntil.get(who) ?? 0)) return;
    this.hurtUntil.set(who, now + 0.45);
    this.play(`voice${v}_hurt`, {
      variants: true,
      gain: this.falloff(distance / 2) * 0.75,
      lowpass: distance > 12 ? Math.max(2500, 14000 - distance * 300) : undefined,
    });
  }

  /** A player going down: their voice's death cry. */
  death(voice: number, distance: number, who: string): void {
    if (!this.ready || distance > 60) return;
    const now = this.ctx!.currentTime;
    if (now < (this.deathUntil.get(who) ?? 0)) return; // one cry per death
    this.deathUntil.set(who, now + 1.5);
    this.hurtUntil.set(who, now + 1.5); // no grunt on top of the cry
    const v = ((voice % VOICES) + VOICES) % VOICES;
    this.play(`voice${v}_death`, {
      variants: true,
      gain: this.falloff(distance / 2.5) * 0.9,
      lowpass: distance > 15 ? Math.max(2000, 14000 - distance * 250) : undefined,
    });
  }

  /** Per player (not per voice slot: players share the four voices). */
  private readonly hurtUntil = new Map<string, number>();
  private readonly deathUntil = new Map<string, number>();
  private breathSource: AudioBufferSourceNode | null = null;
  private breathGain: GainNode | null = null;

  /** Your own breathing: 0 = calm (silent), 1 = gasping (sprinting long / badly hurt). */
  setBreathing(level: number): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    if (!this.breathSource) {
      const buf = this.buffers.get('breathing_loop');
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.master!);
      src.start();
      this.breathSource = src;
      this.breathGain = g;
    }
    const l = Math.min(1, Math.max(0, level));
    this.breathGain!.gain.setTargetAtTime(l * 0.5, ctx.currentTime, l > 0.05 ? 0.4 : 1.2);
    // Faster breaths when it's worse.
    this.breathSource.playbackRate.setTargetAtTime(0.9 + l * 0.25, ctx.currentTime, 0.8);
  }

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windLevel = 0;

  /** Wind bed strength from the weather (0..1). Synthesized: filtered noise, no download. */
  setWind(level: number): void {
    this.windLevel = Math.min(1, Math.max(0, level));
    if (!this.ctx || !this.noise || this.windGain) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    lp.Q.value = 0.6;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.3;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(lp).connect(bp).connect(this.windGain).connect(this.master!);
    src.start();
    this.windFilter = lp;
  }

  /** Per frame: `gust` (0..1, the shared `WindGusts` signal) swells and settles the bed. */
  windTick(gust: number): void {
    if (!this.ready) return;
    // The weather may be applied before the first click unlocks audio: build the bed now.
    if (!this.windGain) this.setWind(this.windLevel);
    if (!this.windGain || !this.windFilter) return;
    const t = this.ctx!.currentTime;
    const strength = this.windLevel * (0.35 + 0.65 * gust);
    this.windGain.gain.setTargetAtTime(strength * 0.22, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(350 + strength * 1400, t, 0.4);
  }

  hitmarker(zone: 'head' | 'torso' | 'legs', killed: boolean): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (zone === 'head') {
      this.tone(t, 'triangle', 2400, 2300, 0.28, 0.22);
      this.tone(t, 'sine', 3600, 3500, 0.12, 0.18);
    } else {
      this.noiseBurst(t, 'bandpass', 3800, 4, 0.35, 0.025);
    }
    if (killed) {
      this.tone(t + 0.02, 'sine', 520, 380, 0.35, 0.22);
      this.tone(t + 0.02, 'triangle', 1560, 1500, 0.1, 0.25);
    }
  }
}
