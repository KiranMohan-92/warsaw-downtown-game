import { JETPACK } from '@wd/shared';
import './jetpackHud.css';

/** What the HUD shows of our own pack (null mode = none). */
export interface JetpackHudState {
  /** `JetMode`: 0 none, 1 worn, 2 flying, 3 the drop. */
  mode: number;
  /** Flight seconds left. */
  fuel: number;
  /** Height above the ground below (m), null if unknown. */
  alt: number | null;
  /** Thrust 0–1 (smoothed), for the nozzle glow at the screen's bottom edges. */
  glow: number;
  /** The key that lights it (Jump). */
  key: string;
}

const RING = 2 * Math.PI * 26;

/**
 * The JETPACK module (visor style, like the status chips): a ring that drains over the 20 s
 * window with the seconds in it, an altitude bar up to the 15 ft ceiling, a LOW FUEL warning in
 * the last seconds, the lighting hint while worn, and the nozzle glow at the screen's bottom
 * edges in flight. DOM writes only when a quantized value changes.
 */
export class JetpackHud {
  readonly root: HTMLDivElement;
  private readonly ring: SVGCircleElement;
  private readonly time: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly altFill: HTMLElement;
  private readonly altText: HTMLSpanElement;
  private readonly hint: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private key = '';
  private glowKey = -1;

  constructor(host: HTMLElement) {
    const el = (cls: string, parent: HTMLElement): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = cls;
      parent.append(d);
      return d;
    };
    this.vignette = el('jet-vignette', host);
    this.vignette.append(document.createElement('i'), document.createElement('b'));
    this.root = el('jet-hud', host);
    this.root.dataset.testid = 'jetpack-hud';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.classList.add('jet-ring');
    const track = document.createElementNS(ns, 'circle');
    const fill = document.createElementNS(ns, 'circle');
    for (const c of [track, fill]) {
      c.setAttribute('cx', '32');
      c.setAttribute('cy', '32');
      c.setAttribute('r', '26');
      svg.append(c);
    }
    track.classList.add('track');
    fill.classList.add('fill');
    fill.setAttribute('stroke-dasharray', `${RING}`);
    this.ring = fill;
    const dial = el('jet-dial', this.root);
    dial.append(svg);
    this.time = el('jet-time', dial);
    const side = el('jet-side', this.root);
    this.label = el('jet-label', side);
    const alt = el('jet-alt', side);
    const bar = el('jet-alt-bar', alt);
    this.altFill = document.createElement('i');
    const cap = document.createElement('b');
    bar.append(this.altFill, cap);
    this.altText = document.createElement('span');
    alt.append(this.altText);
    this.hint = el('jet-hint', side);
  }

  update(s: JetpackHudState | null): void {
    const g = s && s.mode >= 2 ? Math.round(Math.max(0, Math.min(1, s.glow)) * 20) : 0;
    if (g !== this.glowKey) {
      this.glowKey = g;
      this.vignette.style.opacity = String(g / 20);
      this.vignette.classList.toggle('on', g > 0);
    }
    if (!s || s.mode === 0) {
      if (this.key !== '') {
        this.key = '';
        this.root.className = 'jet-hud';
      }
      return;
    }
    const fuel = Math.max(0, s.fuel);
    const secs = Math.ceil(fuel - 1e-6);
    const share = Math.round((fuel / JETPACK.flightTime) * 100);
    const alt = s.alt === null ? -1 : Math.round(Math.min(s.alt, JETPACK.ceiling + 3) * 10);
    const low = s.mode === 2 && fuel <= JETPACK.sputterTime;
    const key = `${s.mode}|${secs}|${share}|${alt}|${low ? 1 : 0}|${s.key}`;
    if (key === this.key) return;
    this.key = key;
    this.root.className = `jet-hud on mode${s.mode}${low ? ' low' : ''}`;
    this.ring.setAttribute('stroke-dashoffset', `${(RING * (1 - share / 100)).toFixed(1)}`);
    this.time.textContent = s.mode === 3 ? '0' : String(secs);
    this.label.textContent =
      s.mode === 1
        ? 'JETPACK READY'
        : s.mode === 3
          ? 'JETPACK — LANDING'
          : low
            ? 'LOW FUEL'
            : 'JETPACK';
    const a = alt < 0 ? 0 : alt / 10;
    this.altFill.style.transform = `scaleX(${Math.min(1, a / JETPACK.ceiling).toFixed(3)})`;
    this.altText.textContent = alt < 0 ? '— m' : `${a.toFixed(1)} m`;
    this.hint.textContent =
      s.mode === 1
        ? `${s.key} again in the air to ignite · 20 s of flight`
        : s.mode === 2
          ? `hold ${s.key} climb · crouch descend`
          : '';
  }
}
