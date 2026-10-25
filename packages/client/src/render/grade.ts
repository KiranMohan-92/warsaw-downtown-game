/**
 * The colour grade every tier shares: a little saturation and contrast after AgX (faithful but
 * flat) and a soft vignette. Medium+ apply it in their post chain (postprocessing's
 * HueSaturation, BrightnessContrast and Vignette effects in the tone-mapping pass, post.ts); Low
 * has no composer, so its present pass (lowFrame.ts) grades its display-referred frame with a
 * cheap display-space version of the same maths (`gradeDisplayRef`, within ~7 % of the chain's (worst case, saturated colours)
 * result; the exact colour-space round trip cost ~1.3 ms of Intel UHD). Before this, Low — where
 * Auto settles on integrated GPUs — showed the flat ungraded image.
 */
export const GRADE = {
  saturation: 0.14,
  contrast: 0.1,
  vignetteOffset: 0.32,
  vignetteDarkness: 0.42,
} as const;

type Rgb = readonly [number, number, number];

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
export const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v * 0.0773993808 : ((v + 0.055) / 1.055) ** 2.4;

/**
 * Reference for the grade on one linear, tone-mapped pixel at screen `uv` (0..1): exactly the
 * postprocessing effects' formulas and colour spaces (hue 0, brightness 0, default vignette).
 */
export function gradeLinear(c: Rgb, uv: readonly [number, number]): Rgb {
  const avg = (c[0] + c[1] + c[2]) / 3;
  const k = 1 - 1 / (1.001 - GRADE.saturation);
  const sat = c.map((v) => Math.min(1, v + (avg - v) * k));
  const con = sat.map((v) => srgbToLinear((linearToSrgb(v) - 0.5) / (1 - GRADE.contrast) + 0.5));
  const d = Math.hypot(uv[0] - 0.5, uv[1] - 0.5);
  const vig = smoothstep(
    0.8,
    GRADE.vignetteOffset * 0.799,
    d * (GRADE.vignetteDarkness + GRADE.vignetteOffset),
  );
  return [con[0]! * vig, con[1]! * vig, con[2]! * vig];
}

const f = (n: number): string => n.toFixed(5);

/**
 * GLSL for Low's present pass: `vec3 gradeDisplay( vec3 srgb, vec2 uv )` on sRGB-encoded colour.
 * The exact transfer functions (six vector pows per pixel) cost ~1.3 ms of Intel UHD at 1600×900,
 * it uses a gamma-2 round trip instead (square, one vector sqrt): saturation on near-linear values,
 * contrast exactly as BrightnessContrastEffect (on encoded values), the linear vignette factor
 * encoded with one scalar sqrt.
 */
export const GRADE_GLSL = /* glsl */ `
vec3 gradeDisplay( vec3 c, vec2 uv ) {
  vec3 l = c * c; // gamma-2 decode: saturation works on (nearly) linear values like the chain's
  float avg = ( l.r + l.g + l.b ) / 3.0;
  c = sqrt( clamp( l + ( avg - l ) * ${f(1 - 1 / (1.001 - GRADE.saturation))}, 0.0, 1.0 ) );
  c = ( c - 0.5 ) * ${f(1 / (1 - GRADE.contrast))} + 0.5;
  float d = distance( uv, vec2( 0.5 ) );
  c *= sqrt( smoothstep( 0.8, ${f(GRADE.vignetteOffset * 0.799)}, d * ${f(GRADE.vignetteDarkness + GRADE.vignetteOffset)} ) );
  return clamp( c, 0.0, 1.0 );
}
`;

/** Reference for `GRADE_GLSL` on one sRGB-encoded pixel (what Low's present pass computes). */
export function gradeDisplayRef(c: Rgb, uv: readonly [number, number]): Rgb {
  const k = 1 - 1 / (1.001 - GRADE.saturation);
  const d = Math.hypot(uv[0] - 0.5, uv[1] - 0.5);
  const vig = Math.sqrt(
    smoothstep(
      0.8,
      GRADE.vignetteOffset * 0.799,
      d * (GRADE.vignetteDarkness + GRADE.vignetteOffset),
    ),
  );
  const l = c.map((v) => v * v);
  const lavg = (l[0]! + l[1]! + l[2]!) / 3;
  return l.map((v) => {
    const s = Math.sqrt(Math.min(1, Math.max(0, v + (lavg - v) * k)));
    return Math.min(1, Math.max(0, ((s - 0.5) / (1 - GRADE.contrast) + 0.5) * vig));
  }) as unknown as Rgb;
}
