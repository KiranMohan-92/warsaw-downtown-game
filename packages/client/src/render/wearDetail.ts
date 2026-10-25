/**
 * Edge wear, rust streaks and stencils for box-built metal: shipping containers and the
 * helicopter wreck. The map mesh gives these buckets a per-vertex `aFace` attribute (face-local
 * s, t in metres from the face's lower corner, and the face's width and height; see
 * `mapMesh.addBox`), so the shader knows where each face's edges and top are without any extra
 * geometry: chipped paint and bare steel along every edge, rust running down from the top edge,
 * and on containers a faded stencilled number on the long sides (digits only — no owner codes, no
 * brands). One material each, compiled at warm-up like before; every tier alike; presentation only.
 */
import * as THREE from 'three';
import {
  quatFromEulerDeg,
  rotateByQuat,
  type MapBox,
  type MaterialId,
  type Vec3,
} from '@wd/shared';

/** Surfaces whose box faces carry `aFace` and get this layer. */
export const WEAR_SURFACES: readonly MaterialId[] = ['container', 'wreck'];

// ---- which faces face into a container ------------------------------------------------------

/** Box face normals in `mapMesh.addBox` order (+x, −x, +y, −y, +z, −z). */
const FACE_NORMALS: readonly Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/** Thin container panels (walls of open containers): only these have an inner face. */
const PANEL_MAX = 0.15;
/** How far in front of a face to probe for the container's floor and roof (m). */
const PROBE = 0.9;
/** A floor/roof counts when it is within this height of the probe point (a container is 2.59 m). */
const SPAN = 2.7;

/**
 * Faces of thin container panels that look into their container (between its floor and roof):
 * keys `boxIndex * 6 + face` (`mapMesh.addBox` face order). Their paint gets wear but no stencil —
 * an owner's number is painted on the outside. A point `PROBE` m in front of the face is inside
 * when some other container box lies below it and another above it, both over that point.
 */
export function innerContainerFaces(boxes: readonly MapBox[]): Set<number> {
  const out = new Set<number>();
  const cont = boxes
    .map((b, i) => ({ b, i, q: quatFromEulerDeg(b.rot) }))
    .filter(({ b }) => b.mat === 'container');
  const covers = (c: (typeof cont)[number], p: Vec3, below: boolean): boolean => {
    const { b, q } = c;
    const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const l = rotateByQuat({ x: p.x - b.center.x, y: p.y - b.center.y, z: p.z - b.center.z }, inv);
    if (Math.abs(l.x) > b.size.x / 2 + 0.01 || Math.abs(l.z) > b.size.z / 2 + 0.01) return false;
    const dy = below ? -l.y - b.size.y / 2 : l.y - b.size.y / 2;
    return dy >= -0.01 && dy <= SPAN;
  };
  for (const c of cont) {
    const { b, i, q } = c;
    if (Math.min(b.size.x, b.size.y, b.size.z) > PANEL_MAX) continue;
    FACE_NORMALS.forEach((n, fi) => {
      if (n.y !== 0) return;
      const half = Math.abs(n.x) * b.size.x * 0.5 + Math.abs(n.z) * b.size.z * 0.5;
      const w = rotateByQuat(n, q);
      const p = {
        x: b.center.x + w.x * (half + PROBE),
        y: b.center.y,
        z: b.center.z + w.z * (half + PROBE),
      };
      let floor = false;
      let roof = false;
      for (const o of cont) {
        if (o === c) continue;
        floor ||= covers(o, p, true);
        roof ||= covers(o, p, false);
        if (floor && roof) break;
      }
      if (floor && roof) out.add(i * 6 + fi);
    });
  }
  return out;
}

// ---- stencil digits (5 × 7 bitmap font, drawn soft) ----------------------------------------

const DIGITS = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
] as const;

/** Glyph cell (texels): 5 × 7 glyph + 1 texel gap, 10 digits side by side, 2 texel margin. */
export const GLYPH_W = 8;
export const GLYPH_H = 10;

/** R8 strip of the ten digits (row 0 = the glyph's bottom row). */
export function stencilFontData(): Uint8Array {
  const w = GLYPH_W * 10;
  const out = new Uint8Array(w * GLYPH_H);
  DIGITS.forEach((rows, d) => {
    rows.forEach((bits, r) => {
      const y = 7 - r; // texture row 0 = bottom margin, glyph rows 1..7
      for (let c = 0; c < 5; c++) {
        if (bits[c] === '1') out[y * w + d * GLYPH_W + 1 + c] = 255;
      }
    });
  });
  return out;
}

let font: THREE.DataTexture | null = null;
function stencilFont(): THREE.DataTexture {
  if (font) return font;
  const t = new THREE.DataTexture(stencilFontData(), GLYPH_W * 10, GLYPH_H, THREE.RedFormat);
  t.unpackAlignment = 1;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.name = 'stencil-digits';
  t.needsUpdate = true;
  font = t;
  return t;
}

// ---- shader --------------------------------------------------------------------------------

const VERTEX_PARS = /* glsl */ `
attribute vec4 aFace;
varying vec4 vFace;
varying vec2 vFaceSeed;
varying vec3 vWearPos;
`;
const VERTEX = /* glsl */ `
vFace = aFace;
// World-metre uv minus the face-local coords: constant over a face (a per-face seed).
vFaceSeed = uv - aFace.xy;
vWearPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

export const WEAR_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uStencil;
varying vec4 vFace;
varying vec2 vFaceSeed;
varying vec3 vWearPos;
float wearRough = 0.0;
float wearHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float wearNoise( vec2 p ) {
  vec2 i = floor( p ), u = fract( p );
  u = u * u * ( 3.0 - 2.0 * u );
  return mix( mix( wearHash( i ), wearHash( i + vec2( 1, 0 ) ), u.x ),
    mix( wearHash( i + vec2( 0, 1 ) ), wearHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
// One stencilled digit: coverage at p (glyph units, 0..1 inside the 5 × 7 cell).
float wearGlyph( vec2 p, float digit ) {
  if ( p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0 ) return 0.0;
  vec2 uv = vec2( ( digit * ${GLYPH_W}.0 + 1.0 + p.x * 5.0 ) / ${GLYPH_W * 10}.0, ( 1.0 + p.y * 7.0 ) / ${GLYPH_H}.0 );
  return smoothstep( 0.3, 0.7, texture2D( uStencil, uv ).r );
}
vec3 wear( vec3 albedo, vec3 viewNormal ) {
  wearRough = 0.0;
  if ( vFace.z <= 0.0 ) return albedo;
  float dist = distance( vWearPos, cameraPosition );
  float fade = 1.0 - smoothstep( 60.0, 90.0, dist );
  if ( fade <= 0.0 ) return albedo;
  vec2 st = vFace.xy;
  // A negative height marks a face looking into its container (no stencil there).
  vec2 dim = vec2( vFace.z, abs( vFace.w ) );
  vec3 upView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float vertical = 1.0 - smoothstep( 0.3, 0.6, abs( dot( viewNormal, upView ) ) );
  float seed = wearHash( floor( vFaceSeed * 4.0 ) + 0.5 );
  float edgeD = min( min( st.x, dim.x - st.x ), min( st.y, dim.y - st.y ) );
  float grain = wearNoise( st * 9.0 + seed * 17.0 ) * 0.6 + wearNoise( st * 31.0 ) * 0.4;
  vec3 a = albedo;
#ifdef WEAR_CONTAINER
  // Rust bleeding down from the top edge (and from the odd scratch), in uneven runs.
  float cols = wearNoise( vec2( st.x * 5.5 + seed * 13.0, 0.5 ) );
  float runLen = 0.3 + 1.3 * wearNoise( vec2( st.x * 1.7, seed * 7.0 ) );
  float fromTop = dim.y - st.y;
  float streak = vertical * smoothstep( 0.44, 0.74, cols ) * ( 1.0 - smoothstep( 0.0, runLen, fromTop ) );
  streak *= 0.55 + 0.45 * wearNoise( vec2( st.x * 40.0, st.y * 2.0 ) );
  vec3 rust = vec3( 0.26, 0.12, 0.05 );
  a = mix( a, rust * ( 0.7 + 0.5 * grain ), 0.75 * streak );
  // Grime settles along the bottom rail.
  a *= 1.0 - 0.35 * vertical * ( 1.0 - smoothstep( 0.0, 0.45, st.y ) ) * ( 0.6 + 0.4 * grain );
  // Faded stencil number, top left of long sides: seven digits over four (a code, no letters).
  if ( vertical > 0.5 && dim.x > 4.0 && dim.y > 2.0 && vFace.w > 0.0 ) {
    vec2 org = vec2( 0.4, dim.y - 0.44 );
    vec2 cellSize = vec2( 0.085, 0.13 );
    vec2 q = ( st - org ) / cellSize;
    float ink = 0.0;
    if ( q.x > -0.2 && q.x < 7.5 * 1.25 && q.y > -1.6 && q.y < 1.2 ) {
      float line = q.y >= 0.0 ? 0.0 : 1.0;
      vec2 lq = vec2( q.x, q.y + line * 1.35 );
      float slot = floor( lq.x / 1.25 );
      float count = line < 0.5 ? 7.0 : 4.0;
      if ( slot >= 0.0 && slot < count ) {
        float digit = floor( wearHash( vec2( seed * 91.0 + slot, line + 3.0 ) ) * 9.999 );
        ink = wearGlyph( vec2( lq.x - slot * 1.25, lq.y ), digit );
      }
    }
    // Sun-faded, flaking paint.
    ink *= smoothstep( 0.22, 0.6, grain ) * 0.6;
    a = mix( a, vec3( 0.52, 0.51, 0.47 ), ink );
  }
  float chipW = 0.05;
#else
  // Wreck: soot climbing from the lower edge, heat bluing, scorched seams.
  float soot = ( 1.0 - smoothstep( 0.0, 1.1, st.y ) ) * vertical * ( 0.5 + 0.5 * grain );
  a *= 1.0 - 0.6 * soot;
  float chipW = 0.035;
#endif
  // Chipped paint along every edge: bare, scratched steel (brighter, smoother) where it flaked.
  float chip = 1.0 - smoothstep( chipW * 0.4, chipW, edgeD + ( grain - 0.5 ) * chipW * 1.4 );
  vec3 bare = vec3( 0.2, 0.19, 0.18 ) * ( 0.8 + 0.4 * grain );
  a = mix( a, bare, chip * 0.85 );
  wearRough = -0.25 * chip;
  return mix( albedo, a, fade );
}
`;

/** Patch a map material with the wear layer (after `addWetness`, which replaces the hook). */
export function addWearDetail(mat: THREE.MeshStandardMaterial, id: MaterialId): void {
  if (mat.userData.wearDetail) return;
  mat.userData.wearDetail = true;
  const prev = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey();
  const define = id === 'container' ? '#define WEAR_CONTAINER\n' : '';
  const tex = stencilFont();
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uStencil = { value: tex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${define}${WEAR_FRAGMENT_PARS}`)
      // After the vertex tint (container paint): rust, bare steel and stencil ink are their own
      // colours, not multiplied by the paint.
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb = wear( diffuseColor.rgb, normalize( vNormal ) );',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = clamp( roughnessFactor + wearRough, 0.1, 1.0 );',
      );
  };
  mat.customProgramCacheKey = () => `${key}|wear`;
  mat.needsUpdate = true;
}
