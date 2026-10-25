export interface AudioPoint {
  x: number;
  y?: number;
  z: number;
}

export interface BlastContext {
  source?: AudioPoint;
  listener?: AudioPoint;
  /** Camera world direction. A default Three camera points down -Z. Ignored when `yaw` is supplied. */
  forward?: AudioPoint;
  /** Camera/listener yaw in radians: yaw 0 faces -Z, positive yaw turns toward -X. */
  yaw?: number;
  blocked?: boolean;
}

export interface BlastAcoustics {
  distance: number;
  delay: number;
  pan: number;
  gainScale: number;
  lowpass: number | null;
}

const SPEED_OF_SOUND = 343;
const MAX_DELAY = 0.35;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);
const positive = (v: number): number => Math.max(0, finite(v));

function distanceFromContext(distance: number, c?: BlastContext): number {
  if (!c?.source || !c.listener) return positive(distance);
  const dx = finite(c.source.x) - finite(c.listener.x);
  const dy = finite(c.source.y ?? 0) - finite(c.listener.y ?? 0);
  const dz = finite(c.source.z) - finite(c.listener.z);
  return positive(Math.hypot(dx, dy, dz));
}

function forward(c?: BlastContext): { x: number; z: number } {
  if (typeof c?.yaw === 'number' && Number.isFinite(c.yaw))
    return { x: -Math.sin(c.yaw), z: -Math.cos(c.yaw) };
  const x = finite(c?.forward?.x ?? 0);
  const z = finite(c?.forward?.z ?? -1, -1);
  const n = Math.hypot(x, z) || 1;
  return { x: x / n, z: z / n };
}

function panFromContext(c?: BlastContext): number {
  if (!c?.source || !c.listener) return 0;
  const dx = finite(c.source.x) - finite(c.listener.x);
  const dz = finite(c.source.z) - finite(c.listener.z);
  const n = Math.hypot(dx, dz);
  if (n < 1e-4) return 0;
  const f = forward(c);
  const right = { x: -f.z, z: f.x };
  return clamp((dx * right.x + dz * right.z) / n, -1, 1);
}

export function blastAcoustics(distance: number, context?: BlastContext): BlastAcoustics {
  const d = distanceFromContext(distance, context);
  const blocked = context?.blocked === true;
  return {
    distance: d,
    delay: Math.min(MAX_DELAY, d / SPEED_OF_SOUND),
    pan: panFromContext(context),
    gainScale: blocked ? 0.45 : 1,
    lowpass: blocked ? 950 : null,
  };
}

export function blastFalloff(distance: number): number {
  const d = positive(distance);
  return Math.min(1, 6 / Math.max(6, d));
}
