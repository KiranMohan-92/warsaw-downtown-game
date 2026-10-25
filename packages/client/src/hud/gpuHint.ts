/**
 * Integrated-GPU hint (presentation only). Chrome on a Windows laptop with two GPUs usually
 * renders on the integrated one (it ignores `powerPreference`); if Auto quality then settles
 * low, tell the player once how to hand the browser to the discrete GPU.
 */

/** The WebGL renderer string (unmasked when the browser allows), or '' if unknown. */
export function webglRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * Whether a WebGL renderer string names an integrated GPU: Intel UHD / HD / Iris / Arc
 * (integrated, not the discrete Arc A-/B-series), or an AMD APU (Radeon Graphics, Vega N,
 * 610M/680M/780M…). Discrete cards (NVIDIA, Radeon RX/Pro), Apple silicon and software
 * renderers are not: the hint can't help there.
 */
export function isIntegratedGpu(renderer: string): boolean {
  const r = renderer.toLowerCase();
  if (!r) return false;
  if (/nvidia|geforce|quadro|rtx|swiftshader|llvmpipe|software|basic render|apple/.test(r)) {
    return false;
  }
  if (r.includes('intel')) {
    // Discrete Arc: "Arc(TM) A770", "Arc B580"; integrated Arc is just "Arc(TM) Graphics".
    return !/arc(\(tm\))?\s*[ab]\d{3}/.test(r);
  }
  if (r.includes('amd') || r.includes('radeon')) {
    if (/\brx\b|radeon\s*(\(tm\)\s*)?(pro|rx|r9|r7|hd)\b/.test(r)) return false;
    return /radeon(\(tm\))?\s*(\d{3}m\b|vega|graphics)|vega \d+/.test(r);
  }
  return false;
}

export interface GpuHintState {
  integrated: boolean;
  /** Windows (the hint names a Windows setting). */
  windows: boolean;
  /** Quality setting is Auto. */
  auto: boolean;
  /** Smoothed fps now. */
  fps: number;
  /** Effective internal resolution scale (1 = native). */
  resolutionScale: number;
  /** Seconds of play so far (Auto needs time to settle first). */
  playedSec: number;
  /** Already shown or dismissed on this machine. */
  dismissed: boolean;
}

/** Auto settling below this fps, or at/under this internal resolution, means the iGPU is the limit. */
export const GPU_HINT_FPS = 45;
export const GPU_HINT_SCALE = 0.7;
/** Seconds of play before judging (Auto's first steps down take a few seconds). */
export const GPU_HINT_AFTER_SEC = 20;

export function shouldShowGpuHint(s: GpuHintState): boolean {
  if (s.dismissed || !s.integrated || !s.windows || !s.auto) return false;
  if (s.playedSec < GPU_HINT_AFTER_SEC || s.fps <= 0) return false;
  return s.fps < GPU_HINT_FPS || s.resolutionScale <= GPU_HINT_SCALE + 1e-6;
}

export const GPU_HINT_TEXT =
  'Running on the integrated GPU. On Windows laptops with two GPUs, set your browser to ' +
  'High performance: Windows Settings › System › Display › Graphics › (your browser) › ' +
  'High performance, then restart the browser.';

const KEY = 'wd.gpuHint.v1';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Storage blocked: the hint just shows once per session.
  }
}

/**
 * The one-time dismissible hint. `check` once in a while (cheap); it shows at most once per
 * machine (remembered), and closes on its ✕ or after 30 s.
 */
export class GpuHint {
  private el: HTMLDivElement | null = null;
  private dismissed = readDismissed();
  private shownFor = 0;

  constructor(
    private readonly parent: HTMLElement,
    private readonly integrated: boolean,
    private readonly windows = typeof navigator !== 'undefined' &&
      /windows/i.test(navigator.userAgent),
  ) {}

  update(dt: number, s: Omit<GpuHintState, 'integrated' | 'windows' | 'dismissed'>): void {
    if (this.el) {
      this.shownFor += dt;
      if (this.shownFor > 30) this.close();
      return;
    }
    const state: GpuHintState = {
      ...s,
      integrated: this.integrated,
      windows: this.windows,
      dismissed: this.dismissed,
    };
    if (shouldShowGpuHint(state)) this.show();
  }

  private show(): void {
    this.dismissed = true;
    writeDismissed();
    const el = document.createElement('div');
    el.dataset.testid = 'gpu-hint';
    Object.assign(el.style, {
      position: 'absolute',
      left: '50%',
      bottom: '120px',
      transform: 'translateX(-50%)',
      maxWidth: 'min(560px, 90vw)',
      padding: '10px 36px 10px 14px',
      font: '13px/1.4 system-ui, sans-serif',
      color: '#e8ecf1',
      background: 'rgba(10, 12, 16, 0.78)',
      border: '1px solid rgba(90, 220, 255, 0.35)',
      borderRadius: '4px',
      pointerEvents: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);
    el.textContent = GPU_HINT_TEXT;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss');
    Object.assign(x.style, {
      position: 'absolute',
      top: '6px',
      right: '8px',
      background: 'none',
      border: 'none',
      color: '#e8ecf1',
      font: '14px system-ui, sans-serif',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    x.addEventListener('click', () => this.close());
    el.append(x);
    this.parent.append(el);
    this.el = el;
  }

  private close(): void {
    this.el?.remove();
    this.el = null;
  }
}
