/**
 * Window interiors ("interior mapping"): every facade window shows a room behind its glass —
 * walls, floor, ceiling and a piece of furniture seen in true parallax, with curtains, blinds and
 * the odd lit room chosen per window — plus mullions, and a glass reflection that follows the
 * real Fresnel of a dielectric (weak head-on, strong at grazing angles). Pure shader math on the
 * window pixels only: no textures, no geometry. Low uses main's legacy rooms; High/Ultra add
 * coherent room styles and filtered decoration. Medium retains its painted/glass surfaces.
 * (the painted panels far away and the glass panes up close both run it), so windows never
 * change look at a level-of-detail switch.
 *
 * The facade meshes carry world-metre uvs on the painted grid (facadeRelief.ts: bays every `BAY`
 * along the wall line, storeys every `STOREY` from y = 0, the window at `FACADE_WINDOW`), which
 * gives each window its cell (random seed) and window-local coordinates.
 */
import type * as THREE from 'three';
import { BAY, FACADE_WINDOW, STOREY } from './facadeRelief.ts';
import { architectureBudget } from './renderBudget.ts';

/** Brightness of the rooms (daylight interiors read darker than the street). */
export const windowLight = { interior: { value: 0.32 }, lamps: { value: 0.18 } };

const f = (n: number): string => n.toFixed(4);

const VERTEX_PARS = /* glsl */ `
varying vec2 vWinUv;
varying vec3 vWinPos;
`;
const VERTEX = /* glsl */ `
vWinUv = uv;
vWinPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAGMENT_PARS = /* glsl */ `
#ifdef TONE_MAPPING
varying vec2 vWinUv;
varying vec3 vWinPos;
uniform float uWinInterior, uWinLamps;
float winMask;
vec3 winRadiance;
vec3 wHash3( vec2 p ) {
  // Sine-free hash (Hoskins): cheap on integrated GPUs.
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.103, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}
void windowInterior() {
  vec2 bayUv = vec2( ${f(BAY)}, ${f(STOREY)} );
  vec2 cell = floor( vWinUv / bayUv );
  vec2 inBay = ( vWinUv - cell * bayUv ) / bayUv;
  vec2 lo = vec2( ${f(FACADE_WINDOW.u0)}, ${f(FACADE_WINDOW.v0)} );
  vec2 hi = vec2( ${f(FACADE_WINDOW.u1)}, ${f(FACADE_WINDOW.v1)} );
  vec2 win = ( inBay - lo ) / ( hi - lo );
  winMask = step( 0.0, win.x ) * step( win.x, 1.0 ) * step( 0.0, win.y ) * step( win.y, 1.0 );
  winRadiance = vec3( 0.0 );
  if ( winMask < 0.5 ) return;
  // Tangent frame from screen derivatives (u along the wall line, v up).
  vec3 dp1 = dFdx( vWinPos ), dp2 = dFdy( vWinPos );
  vec2 duv1 = dFdx( vWinUv ), duv2 = dFdy( vWinUv );
  // Degenerate derivatives (triangle edges, grazing or sub-pixel walls) make the cross product 0:
  // normalize(0) is NaN on NVIDIA (0 on Intel), and one NaN pixel blacks the frame via bloom.
  // Such pixels shade as the plain wall.
  vec3 cr = cross( dp1, dp2 );
  float cl = dot( cr, cr );
  if ( !( cl > 1e-24 ) ) { winMask = 0.0; return; }
  vec3 N = cr * inversesqrt( cl );
  vec3 dp2perp = cross( dp2, N ), dp1perp = cross( N, dp1 );
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float inv = inversesqrt( max( max( dot( T, T ), dot( B, B ) ), 1e-12 ) );
  T *= inv; B *= inv;
  // N must face the viewer (the outside of the wall).
  vec3 V = normalize( vWinPos - cameraPosition );
  if ( dot( N, V ) > 0.0 ) N = -N;
  vec3 h = wHash3( cell * 1.37 + floor( vWinPos.xz * 0.05 ) * 7.13 );
  vec3 h2 = wHash3( cell.yx * 2.11 + h.xy * 13.0 );
  // Mullions: a centre post and a transom, dark frame.
  float post = step( abs( win.x - 0.5 ), 0.018 );
  float transom = step( abs( win.y - 0.72 ), 0.02 );
  float rim = 1.0 - step( 0.025, min( min( win.x, 1.0 - win.x ), min( win.y, 1.0 - win.y ) ) );
  if ( max( max( post, transom ), rim ) > 0.5 ) { winMask = 2.0; return; } // frame, not glass
  // Room ray march in window units: the window is 0..1 in x and y, the room 2.2 wide, 1.7 tall
  // and 1 deep (3 m).
  vec3 d = vec3( dot( V, T ) / ${f((FACADE_WINDOW.u1 - FACADE_WINDOW.u0) * BAY)},
    dot( V, B ) / ${f((FACADE_WINDOW.v1 - FACADE_WINDOW.v0) * STOREY)}, dot( V, -N ) / 3.0 );
  vec3 p = vec3( win, 0.0 );
  vec3 rlo = vec3( -0.6, -0.42, 0.0 ), rhi = vec3( 1.6, 1.28, 1.0 );
  // A ray parallel to a room side never exits through it (front-on views: no divide by zero).
  float tx = abs( d.x ) > 1e-6 ? ( ( d.x > 0.0 ? rhi.x : rlo.x ) - p.x ) / d.x : 1e20;
  float ty = abs( d.y ) > 1e-6 ? ( ( d.y > 0.0 ? rhi.y : rlo.y ) - p.y ) / d.y : 1e20;
  float tz = ( rhi.z - p.z ) / max( d.z, 1e-4 );
  float t = min( min( tx, ty ), tz );
  vec3 q = p + d * t;
  vec3 wallC = mix( vec3( 0.62, 0.56, 0.47 ), vec3( 0.48, 0.55, 0.57 ), h.x );
  wallC = mix( wallC, vec3( 0.72, 0.68, 0.6 ), h2.z * 0.5 );
  vec3 floorC = mix( vec3( 0.3, 0.2, 0.13 ), vec3( 0.36, 0.33, 0.3 ), h.y );
  vec3 col;
  if ( t == tz ) {
    col = wallC * 0.9;
    // A piece of furniture against the back wall (a cupboard, a sofa, a shelf).
    float fx0 = 0.15 + h2.x * 0.5;
    float fx1 = fx0 + 0.35 + h2.y * 0.45;
    float fh = -0.42 + ( h2.x > 0.5 ? 0.55 : 1.05 ) * ( 0.6 + 0.4 * h2.z );
    if ( q.x > fx0 && q.x < fx1 && q.y < fh ) col = mix( vec3( 0.18, 0.12, 0.08 ), vec3( 0.32, 0.3, 0.33 ), h2.y );
    // A picture or a window-lit patch high on the wall.
    if ( h.z > 0.4 && abs( q.x - 0.55 ) < 0.12 && abs( q.y - 0.85 ) < 0.09 ) col *= 0.55;
  } else if ( t == ty ) {
    col = d.y < 0.0 ? floorC : vec3( 0.8 );
  } else {
    col = wallC;
  }
  // Daylight from the window fades into the room; a lit room has a warm lamp.
  float depth = q.z;
  float light = mix( 1.0, 0.28, depth ) * ( 0.75 + 0.35 * h2.x );
  vec3 lamp = h.z > 0.82 ? vec3( 1.0, 0.78, 0.5 ) * uWinLamps * ( 0.6 + 0.8 * ( 1.0 - depth ) ) : vec3( 0.0 );
  col = col * light * uWinInterior + col * lamp;
  // Curtains at the sides (folds), or blinds pulled part way down.
  if ( h.x > 0.45 ) {
    float cw = 0.14 + 0.2 * h2.y;
    if ( win.x < cw || win.x > 1.0 - cw ) {
      vec3 fabric = mix( vec3( 0.55, 0.5, 0.42 ), vec3( 0.42, 0.18, 0.14 ), step( 0.7, h2.z ) );
      col = fabric * ( 0.75 + 0.25 * sin( win.x * 70.0 ) ) * uWinInterior * 0.9;
    }
  }
  if ( h.y > 0.62 ) {
    float drop = 0.25 + 0.6 * h2.x;
    if ( win.y > 1.0 - drop ) {
      col = vec3( 0.66, 0.64, 0.6 ) * ( 0.8 + 0.2 * step( 0.5, fract( win.y * 26.0 ) ) ) * uWinInterior;
    }
  }
  winRadiance = col;
}
#else
#ifndef WD_ARCHITECTURE_BUDGET
#define WD_ARCHITECTURE_BUDGET
uniform float uArchitectureBudget;
#endif
varying vec2 vWinUv;
varying vec3 vWinPos;
uniform float uWinInterior, uWinLamps;
float winMask;
float winFrame;
vec3 winRadiance;
vec3 wHash3( vec2 p ) {
  // Sine-free hash (Hoskins): cheap on integrated GPUs.
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.103, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}
float wSlatIntegral( float t ) {
  return floor( t ) * 0.5 + max( fract( t ) - 0.5, 0.0 );
}
void windowInterior() {
  vec2 bayUv = vec2( ${f(BAY)}, ${f(STOREY)} );
  vec2 cell = floor( vWinUv / bayUv );
  vec2 inBay = ( vWinUv - cell * bayUv ) / bayUv;
  vec2 lo = vec2( ${f(FACADE_WINDOW.u0)}, ${f(FACADE_WINDOW.v0)} );
  vec2 hi = vec2( ${f(FACADE_WINDOW.u1)}, ${f(FACADE_WINDOW.v1)} );
  // Derivatives must be evaluated by the whole pixel quad, before any window/frame
  // return. Use continuous metre UVs; fract's wrap must not inflate the footprint.
  vec2 winFw = max( fwidth( vWinUv / bayUv / ( hi - lo ) ), vec2( 1e-5 ) );
  vec3 dp1 = dFdx( vWinPos ), dp2 = dFdy( vWinPos );
  vec2 duv1 = dFdx( vWinUv ), duv2 = dFdy( vWinUv );
  vec2 win = ( inBay - lo ) / ( hi - lo );
  winMask = step( 0.0, win.x ) * step( win.x, 1.0 ) * step( 0.0, win.y ) * step( win.y, 1.0 );
  winRadiance = vec3( 0.0 );
  winFrame = 0.0;
  if ( winMask < 0.5 ) return;
  // Tangent frame from screen derivatives (u along the wall line, v up).
  // Degenerate derivatives (triangle edges, grazing or sub-pixel walls) make the cross product 0:
  // normalize(0) is NaN on NVIDIA (0 on Intel), and one NaN pixel blacks the frame via bloom.
  // Such pixels shade as the plain wall.
  vec3 cr = cross( dp1, dp2 );
  float cl = dot( cr, cr );
  if ( !( cl > 1e-24 ) ) { winMask = 0.0; return; }
  vec3 N = cr * inversesqrt( cl );
  vec3 dp2perp = cross( dp2, N ), dp1perp = cross( N, dp1 );
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  vec3 centreT = T * inversesqrt( max( dot( T, T ), 1e-12 ) );
  vec3 centreB = B * inversesqrt( max( dot( B, B ), 1e-12 ) );
  float inv = inversesqrt( max( max( dot( T, T ), dot( B, B ) ), 1e-12 ) );
  T *= inv; B *= inv;
  // N must face the viewer (the outside of the wall).
  vec3 viewRay = vWinPos - cameraPosition;
  float viewDist = length( viewRay );
  vec3 V = viewRay * inversesqrt( max( dot( viewRay, viewRay ), 1e-12 ) );
  if ( dot( N, V ) > 0.0 ) N = -N;
  // Seed from the physical centre of this window, not each fragment position: a pane crossing a
  // coarse world tile keeps one room identity, while neighbouring bays still form soft runs.
  vec2 winCentreUv = ( cell + 0.5 * ( lo + hi ) ) * bayUv;
  vec2 toWinCentre = winCentreUv - vWinUv;
  vec3 winCentrePos = vWinPos + centreT * toWinCentre.x + centreB * toWinCentre.y;
  vec2 stableCentreXZ = floor( winCentrePos.xz * 64.0 + 0.5 ) / 64.0;
  vec2 windowId = floor( winCentreUv / bayUv );
  vec2 clusterId = floor( ( windowId + vec2( 0.5 ) ) / vec2( 3.0, 2.0 ) );
  vec3 cluster = wHash3( clusterId * vec2( 1.91, 2.73 ) + floor( stableCentreXZ * 0.025 ) );
  vec3 h = wHash3( windowId * 1.37 + floor( stableCentreXZ * 0.05 ) * 7.13 );
  float winDetail = 1.0 - uArchitectureBudget;
  vec3 h2 = vec3( 0.5 );
  if ( winDetail > 0.0 ) {
    h2 = mix( h2, wHash3( windowId.yx * 2.11 + h.xy * 13.0 + cluster.xy * 3.0 ), winDetail );
  }
  // Mullions: a centre post and a transom, dark frame.
  // Integrate each thin strip over its pixel footprint: distant frames retain
  // fractional coverage rather than blinking between a solid bar and no bar.
  float post = clamp( ( min( win.x + 0.5 * winFw.x, 0.518 )
    - max( win.x - 0.5 * winFw.x, 0.482 ) ) / winFw.x, 0.0, 1.0 );
  float transom = clamp( ( min( win.y + 0.5 * winFw.y, 0.74 )
    - max( win.y - 0.5 * winFw.y, 0.70 ) ) / winFw.y, 0.0, 1.0 );
  vec2 rimDistance = min( win, 1.0 - win );
  vec2 rimCoverage = 1.0 - smoothstep( vec2( 0.025 ) - 0.5 * winFw,
    vec2( 0.025 ) + 0.5 * winFw, rimDistance );
  winFrame = 1.0 - ( 1.0 - post ) * ( 1.0 - transom )
    * ( 1.0 - rimCoverage.x ) * ( 1.0 - rimCoverage.y );
  if ( winFrame > 0.999 ) return;
  // Room ray march in window units: the window is 0..1 in x and y, the room 2.2 wide, 1.7 tall
  // and 1 deep (3 m).
  vec3 d = vec3( dot( V, T ) / ${f((FACADE_WINDOW.u1 - FACADE_WINDOW.u0) * BAY)},
    dot( V, B ) / ${f((FACADE_WINDOW.v1 - FACADE_WINDOW.v0) * STOREY)}, dot( V, -N ) / 3.0 );
  vec3 p = vec3( win, 0.0 );
  vec3 rlo = vec3( -0.6, -0.42, 0.0 ), rhi = vec3( 1.6, 1.28, 1.0 );
  // A ray parallel to a room side never exits through that side. In particular,
  // exact front-on views must not divide by zero or send infinity into p + d*t.
  float tx = abs( d.x ) > 1e-6 ? ( ( d.x > 0.0 ? rhi.x : rlo.x ) - p.x ) / d.x : 1e20;
  float ty = abs( d.y ) > 1e-6 ? ( ( d.y > 0.0 ? rhi.y : rlo.y ) - p.y ) / d.y : 1e20;
  float tz = ( rhi.z - p.z ) / max( d.z, 1e-4 );
  float t = min( min( tx, ty ), tz );
  vec3 q = p + d * t;
  vec3 wallC = mix( vec3( 0.62, 0.56, 0.47 ), vec3( 0.48, 0.55, 0.57 ), h.x );
  wallC = mix( wallC, vec3( 0.72, 0.68, 0.6 ), h2.z * 0.5 );
  vec3 floorC = mix( vec3( 0.3, 0.2, 0.13 ), vec3( 0.36, 0.33, 0.3 ), h.y );
  vec3 col;
  if ( t == tz ) {
    col = wallC * 0.9;
    if ( winDetail > 0.0 ) {
      // A piece of furniture against the back wall (a cupboard, a sofa, a shelf).
      vec3 baseCol = col;
      float fx0 = 0.15 + h2.x * 0.5;
      float fx1 = fx0 + 0.35 + h2.y * 0.45;
      float fh = -0.42 + ( h2.x > 0.5 ? 0.55 : 1.05 ) * ( 0.6 + 0.4 * h2.z );
      if ( q.x > fx0 && q.x < fx1 && q.y < fh ) col = mix( vec3( 0.18, 0.12, 0.08 ), vec3( 0.32, 0.3, 0.33 ), h2.y );
      // A picture or a window-lit patch high on the wall.
      if ( h.z > 0.4 && abs( q.x - 0.55 ) < 0.12 && abs( q.y - 0.85 ) < 0.09 ) col *= 0.55;
      col = mix( baseCol, col, winDetail );
    }
  } else if ( t == ty ) {
    col = d.y < 0.0 ? floorC : vec3( 0.8 );
  } else {
    col = wallC;
  }
  // Daylight from the window fades into the room; a lit room has a warm lamp.
  float depth = q.z;
  float light = mix( 1.0, 0.28, depth ) * ( 0.75 + 0.35 * h2.x );
  float occupied = step( 1.0 - mix( 0.11, 0.25, cluster.x ), h.z );
  vec3 lamp = occupied > 0.5 ? vec3( 1.0, 0.78, 0.5 ) * uWinLamps * ( 0.6 + 0.8 * ( 1.0 - depth ) ) : vec3( 0.0 );
  col = col * light * uWinInterior + col * lamp;
  // Curtains at the sides (folds), or blinds pulled part way down.
  if ( winDetail > 0.0 ) {
    vec3 undecorated = col;
    float curtainThreshold = mix( 0.62, 0.38, cluster.y );
    if ( h.x > curtainThreshold ) {
      float cw = 0.14 + 0.2 * h2.y;
      if ( win.x < cw || win.x > 1.0 - cw ) {
        vec3 fabric = mix( vec3( 0.55, 0.5, 0.42 ), vec3( 0.42, 0.18, 0.14 ), step( 0.7, h2.z ) );
        float foldWidth = max( 0.5 * winFw.x * 70.0, 1e-4 );
        float folds = sin( win.x * 70.0 ) * sin( foldWidth ) / foldWidth;
        col = fabric * ( 0.75 + 0.25 * folds ) * uWinInterior * 0.9;
      }
    }
    float blindThreshold = mix( 0.72, 0.52, cluster.z );
    if ( h.y > blindThreshold ) {
      float drop = 0.25 + 0.6 * h2.x;
      if ( win.y > 1.0 - drop ) {
        float slatWidth = winFw.y * 26.0;
        float slatCentre = win.y * 26.0;
        float slat = clamp( ( wSlatIntegral( slatCentre + 0.5 * slatWidth )
          - wSlatIntegral( slatCentre - 0.5 * slatWidth ) ) / slatWidth, 0.0, 1.0 );
        col = vec3( 0.66, 0.64, 0.6 ) * ( 0.8 + 0.2 * slat ) * uWinInterior;
      }
    }
    col = mix( undecorated, col, winDetail );
  }
  winRadiance = col * ( 1.0 - winFrame );
}
#endif
`;

/**
 * Patch a facade material (painted window panels, or the glass panes themselves) with window
 * interiors. Idempotent; call once per material, before its first compile (warm-up).
 */
export function addWindowInteriors(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.windowInteriors) return;
  mat.userData.windowInteriors = true;
  const prev = mat.onBeforeCompile.bind(mat);
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uArchitectureBudget = architectureBudget;
    shader.uniforms.uWinInterior = windowLight.interior;
    shader.uniforms.uWinLamps = windowLight.lamps;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        #ifdef TONE_MAPPING
        windowInterior();
        // Glass: near-black diffuse (the room is emitted below), frames dark painted metal.
        if ( winMask > 1.5 ) diffuseColor.rgb = vec3( 0.06, 0.06, 0.065 );
        else if ( winMask > 0.5 ) diffuseColor.rgb = vec3( 0.004 );
        #else
        // Medium retains the painted/glass surface without room parallax or decoration.
        winMask = 0.0;
        if ( uArchitectureBudget < 0.5 ) {
          windowInterior();
        }
        // Glass: near-black diffuse (the room is emitted below), frames dark painted metal.
        if ( winMask > 0.5 ) diffuseColor.rgb = mix( vec3( 0.004 ), vec3( 0.06, 0.06, 0.065 ), winFrame );
        #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        #ifdef TONE_MAPPING
        if ( winMask > 0.5 && winMask < 1.5 ) roughnessFactor = 0.05;
        #else
        if ( winMask > 0.5 ) roughnessFactor = mix( 0.05, 0.75, winFrame );
        #endif`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        if ( winMask > 0.5 ) metalnessFactor = 0.0;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef TONE_MAPPING
        if ( winMask > 0.5 && winMask < 1.5 ) totalEmissiveRadiance += winRadiance;
        #else
        if ( winMask > 0.5 ) totalEmissiveRadiance += winRadiance;
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => `${key}|windowInteriors-footprint-v5-clusters-v2-low-main-v1`;
  mat.needsUpdate = true;
}
