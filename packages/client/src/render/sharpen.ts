import { Uniform } from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

/**
 * Contrast-adaptive sharpening (after AMD FidelityFX CAS, MIT): recovers the detail dynamic
 * resolution loses when the browser upscales the canvas. Strength follows the internal
 * resolution: none at 100 % (the effect returns early), full at `CAS_FULL_AT` and below.
 */
export const CAS_FULL_AT = 0.5;
/** Peak negative lobe of the filter at full strength (AMD CAS spans 1/8 … 1/5). */
export const CAS_MAX_LOBE = 0.2;

/** Sharpening strength in [0, 1] for an internal resolution scale (1 = native). */
export function casStrength(internalScale: number): number {
  if (!(internalScale < 1)) return 0; // also NaN
  return Math.min(1, Math.max(0, (1 - internalScale) / (1 - CAS_FULL_AT)));
}

/**
 * Reference implementation of the shader below for one pixel's channel (tests pin the maths the
 * GLSL mirrors): values are pre-tone-mapping HDR, compressed with x / (1 + x) so CAS's [0, 1]
 * contrast logic applies, filtered with a 5-tap cross, clamped to the neighbourhood (no halos),
 * and expanded back.
 */
export function casChannel(
  c: number,
  n: number,
  s: number,
  e: number,
  w: number,
  strength: number,
): number {
  if (strength <= 0) return c;
  const k = (x: number): number => Math.max(x, 0) / (1 + Math.max(x, 0));
  const [kc, kn, ks, ke, kw] = [k(c), k(n), k(s), k(e), k(w)];
  const mn = Math.min(kc, kn, ks, ke, kw);
  const mx = Math.max(kc, kn, ks, ke, kw);
  const amp = Math.sqrt(Math.min(1, Math.max(0, Math.min(mn, 1 - mx) / Math.max(mx, 1e-5))));
  const lobe = -amp * CAS_MAX_LOBE * strength;
  const r = (kc + lobe * (kn + ks + ke + kw)) / (1 + 4 * lobe);
  const out = Math.min(mx, Math.max(mn, r));
  return out / (1 - out);
}

const fragmentShader = /* glsl */ `
uniform float strength;

vec3 casCompress(vec3 x) { x = max(x, vec3(0.0)); return x / (1.0 + x); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (strength <= 0.0) { outputColor = inputColor; return; }
  vec3 c = casCompress(inputColor.rgb);
  vec3 n = casCompress(texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb);
  vec3 s = casCompress(texture2D(inputBuffer, uv - vec2(0.0, texelSize.y)).rgb);
  vec3 e = casCompress(texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb);
  vec3 w = casCompress(texture2D(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb);
  vec3 mn = min(c, min(min(n, s), min(e, w)));
  vec3 mx = max(c, max(max(n, s), max(e, w)));
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-5)), 0.0, 1.0));
  vec3 lobe = -amp * (${CAS_MAX_LOBE.toFixed(3)} * strength);
  vec3 r = clamp((c + lobe * (n + s + e + w)) / (1.0 + 4.0 * lobe), mn, mx);
  outputColor = vec4(r / (1.0 - r), inputColor.a);
}
`;

/**
 * Put it first in the pass that tone-maps (it reads its neighbours from that pass's input), so it
 * costs four texture reads inside an existing pass rather than a pass of its own. Strength is a
 * uniform: changing it never recompiles.
 */
export class CasEffect extends Effect {
  constructor() {
    super('CasEffect', fragmentShader, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([['strength', new Uniform(0)]]),
    });
  }

  get strength(): number {
    return (this.uniforms.get('strength') as Uniform<number>).value;
  }

  set strength(v: number) {
    (this.uniforms.get('strength') as Uniform<number>).value = v;
  }
}
