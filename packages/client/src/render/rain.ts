import * as THREE from 'three';
import {
  RAINING,
  RAIN_OCCLUSION_GLSL,
  rainOcclusion,
  rainStop,
  rainTime,
} from './rainOcclusion.ts';
import {
  APERTURE,
  CAMERA_SMEAR,
  DROP_VISUAL_SCALE,
  FOCUS_DISTANCE,
  GLINT_DISTANCE,
  STREAK_ALPHA_CAP,
  STREAK_MAX_LENGTH,
  STREAK_MAX_WIDTH,
  STREAK_MAX_WIDTH_REF_H,
  STREAK_TAPER,
  STREAK_CULL_SHARE,
  STREAK_EXPOSURE,
  STREAK_GAIN,
  mulberry32,
  rainWindSpeed,
  sampleDropDiameter,
} from './rainPhysics.ts';

/** Drops in the box round the camera (all tiers alike: concealment must not depend on quality). */
export const DROP_COUNT = 15000;
/** The streak box (m): wraps round the camera, so the drop field is endless. */
const BOX = new THREE.Vector3(30, 22, 30);
/** Splash crowns live in a smaller box: far ones would be sub-pixel. */
export const SPLASH_COUNT = 800;
const SPLASH_BOX = 20;
/** One splash: crown up, droplets out and back down (s). */
const SPLASH_LIFE = 0.3;
/** Distant rain curtain: a cylinder of scrolling streaks past the drop box. */
const CURTAIN_RADIUS = 17;
const CURTAIN_HEIGHT = 30;

export interface RainLighting {
  /** Radiance the drops refract (the sky dome above them), linear, exposure included. */
  sky: THREE.Color;
  /** Sun (or the brightest direct light): its glint when the drops are backlit. */
  sunColor: THREE.Color;
  sunDir: THREE.Vector3;
  /** Exponential fog density of the preset (drops fade into the murk like everything else). */
  fogDensity: number;
}

const DROP_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 aDrop;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uBox;
uniform vec2 uWindOff;
uniform vec2 uWindVel;
uniform mat4 uPrevViewProj;
uniform float uCamSmear;
uniform vec2 uViewport;
uniform vec3 uSky;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uFlash;
uniform float uFog;
varying vec2 vAcross;
varying vec3 vAlong;
varying vec3 vColor;
varying float vAlpha;
${RAIN_OCCLUSION_GLSL}
void main() {
  float D = aDrop.w;
  float vt = max( 0.0, 9.65 - 10.3 * exp( -0.6 * D ) );
  vec3 vel = vec3( uWindVel.x, -vt, uWindVel.y );
  float ph = dot( aDrop.xz, vec2( 61.0, 37.0 ) );
  vec3 p = aDrop.xyz * uBox;
  p.y -= uTime * vt;
  // Wind drift (integrated on the CPU, so gusts never jump the field) + a little turbulence.
  p.xz += uWindOff + 0.2 * vec2( sin( uTime * 1.3 + ph ), cos( uTime * 1.1 + ph * 1.7 ) );
  vec3 origin = uCam - uBox * 0.5;
  p = origin + mod( p - origin, uBox );
  vAcross = vec2( 0.0 );
  vAlong = vec3( 0.0, 1.0, 1.0 );
  vColor = vec3( 0.0 );
  vAlpha = 0.0;
  // Drops end on the first surface below the sky: none under roofs, awnings, in the metro.
  if ( p.y < rainTopAt( p.xz ).x ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 h = vp * vec4( p, 1.0 );
  if ( h.w < 0.1 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
  // Streak = where the drop was one exposure ago (its own fall + wind) plus a share of the
  // camera's own motion since the last frame (turning or sprinting tilts and stretches it).
  vec4 t1 = vp * vec4( p - vel * ${STREAK_EXPOSURE.toFixed(5)}, 1.0 );
  vec4 t2 = uPrevViewProj * vec4( p, 1.0 );
  vec2 hn = h.xy / h.w;
  vec2 own = t1.xy / max( t1.w, 0.1 ) - hn;
  vec2 cam = t2.w > 0.1 ? ( t2.xy / t2.w - hn ) * uCamSmear : vec2( 0.0 );
  vec2 sPx = ( own + cam ) * 0.5 * uViewport;
  float lenPx = length( sPx );
  // Depth layering: a sharp drop far away is sub-pixel (drawn 1 px wide with its true coverage),
  // a near one is defocused, but never drawn wider than STREAK_MAX_WIDTH: its coverage goes into
  // a longer, dimmer line instead (rainPhysics.streakFootprint is the tested mirror of this).
  float z = h.w;
  float focal = projectionMatrix[1][1] * 0.5 * uViewport.y;
  float sharp = D * ${(0.001 * DROP_VISUAL_SCALE).toFixed(5)} * focal / z;
  float blur = ${APERTURE.toFixed(4)} * focal * abs( 1.0 / z - ${(1 / FOCUS_DISTANCE).toFixed(4)} );
  float maxW = max( 1.0, ${(STREAK_MAX_WIDTH / STREAK_MAX_WIDTH_REF_H).toFixed(6)} * uViewport.y );
  float width = clamp( sqrt( sharp * sharp + blur * blur ), 1.0, maxW );
  // Coverage the drop hides over the exposure (its own area × gain × the eye's glint spread),
  // faded into the storm's murk with distance and out right at the eye.
  float fd = z * uFog;
  float raw = ${STREAK_GAIN.toFixed(1)} * sharp * sharp * ( 1.0 + z / ${GLINT_DISTANCE.toFixed(1)} ) * exp( -fd * fd ) * smoothstep( 0.35, 1.2, z );
  float maxLen = ${STREAK_MAX_LENGTH.toFixed(3)} * uViewport.y;
  // At most a full-cap streak of the longest length and proportional width (∝ target², as coverage
  // is: the same share is capped at every render scale).
  float mw = ${(STREAK_MAX_WIDTH / STREAK_MAX_WIDTH_REF_H).toFixed(6)} * uViewport.y;
  float coverage = min( raw, ${STREAK_ALPHA_CAP.toFixed(3)} * mw * ( maxLen + mw ) );
  float drawLen = min( lenPx, maxLen );
  // The kernel integrates to width × (length + width); past the cap the streak grows longer, and
  // at the longest a little wider (≤ maxW), so the coverage is carried over in full.
  if ( coverage / ( width * ( drawLen + width ) ) > ${STREAK_ALPHA_CAP.toFixed(3)} ) {
    drawLen = min( maxLen, coverage / ( ${STREAK_ALPHA_CAP.toFixed(3)} * width ) - width );
    if ( coverage / ( width * ( drawLen + width ) ) > ${STREAK_ALPHA_CAP.toFixed(3)} ) {
      float wFit = 0.5 * ( sqrt( drawLen * drawLen + 4.0 * coverage / ${STREAK_ALPHA_CAP.toFixed(3)} ) - drawLen );
      width = min( maxW, max( width, wFit ) );
    }
  }
  float alpha = min( ${STREAK_ALPHA_CAP.toFixed(3)}, coverage / ( width * ( drawLen + width ) ) );
  float ramp = max( 1.0, ${(STREAK_TAPER / (1 - STREAK_TAPER)).toFixed(4)} * ( drawLen + width ) );
  // Too small a share of the screen to see: skip the quad (compared with the screen, not alpha,
  // so the same drops are skipped at every render scale).
  if ( raw < ${STREAK_CULL_SHARE.toExponential(2)} * uViewport.x * uViewport.y ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
  vec2 dir = lenPx > 1e-3 ? sPx / lenPx : vec2( 0.0, 1.0 );
  vec2 nrm = vec2( -dir.y, dir.x );
  // Across: a 1 px streak is a hard box (exact on average); wider ones get 1 px AA edges.
  float halfW = width <= 1.0 ? 0.5 : width * 0.5 + 0.5;
  float total = drawLen + width + ramp;
  // corner.y: 0 .. 1 along the whole tapered streak. It starts half a width ahead of the drop
  // (streakLeadPx) and both ramps lie on the trail side: only the drop is tested against
  // rainTopAt and the quad keeps its depth, so anything further ahead would show under a canopy.
  float along = corner.y * total;
  vec2 offPx = nrm * corner.x * halfW + dir * ( along - width * 0.5 );
  gl_Position = vec4( ( hn + offPx * 2.0 / uViewport ) * h.w, h.z, h.w );
  vAcross = vec2( corner.x * halfW, width );
  vAlong = vec3( along, total, ramp );
  // Lighting: a drop is a tiny wide-angle lens: it shows the bright sky above it (so it stands out
  // against dark facades and vanishes against the sky), plus a glint when backlit by the sun.
  vec3 vdir = normalize( p - uCam );
  float cosT = dot( vdir, uSunDir );
  float g = 0.75;
  float hg = ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * cosT, 1.5 ) * 0.12;
  vColor = uSky * ( 1.25 + 0.6 * D / 3.0 ) + uSunColor * hg + vec3( 0.8, 0.85, 1.0 ) * uFlash;
  vAlpha = alpha;
}
`;

const DROP_FRAG = /* glsl */ `
varying vec2 vAcross;
varying vec3 vAlong;
varying vec3 vColor;
varying float vAlpha;
void main() {
  // The kernel of rainPhysics.streakKernel. Across: a hard box for a 1 px streak, else a bar
  // with 1 px edges. Along: a trapezoid whose ends taper over a quarter of the streak each.
  float w = vAcross.y;
  float across = w <= 1.0 ? 1.0 : clamp( w * 0.5 + 0.5 - abs( vAcross.x ), 0.0, 1.0 );
  float a = clamp( vAlong.x / vAlong.z, 0.0, 1.0 ) * clamp( ( vAlong.y - vAlong.x ) / vAlong.z, 0.0, 1.0 );
  float alpha = vAlpha * across * a;
  if ( alpha <= 0.0 ) discard;
  gl_FragColor = vec4( vColor, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 aSplash;
uniform float uTime;
uniform vec3 uCam;
uniform float uBox;
uniform float uIntensity;
uniform vec3 uSky;
uniform float uFlash;
varying vec2 vUv;
varying float vT;
varying float vSeed;
varying vec3 vColor;
${RAIN_OCCLUSION_GLSL}
float sHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
void main() {
  float cyc = uTime / ${SPLASH_LIFE.toFixed(3)} + aSplash.z;
  float n = floor( cyc );
  float t = fract( cyc );
  vUv = corner;
  vT = t;
  vSeed = sHash( vec2( n, aSplash.w * 91.0 ) );
  vColor = uSky * 1.3 + vec3( 0.8, 0.85, 1.0 ) * uFlash;
  // A fresh spot every cycle, anchored to the world (wraps round the camera, never swims).
  vec2 xz = ( aSplash.xy + vec2( sHash( vec2( n, aSplash.x * 53.0 ) ), sHash( vec2( aSplash.y * 71.0, n ) ) ) ) * uBox;
  vec2 origin = uCam.xz - uBox * 0.5;
  xz = origin + mod( xz - origin, vec2( uBox ) );
  vec2 top = rainTopAt( xz );
  // Only on hard, exposed tops below the eye (an awning's top can't be seen from under it), and
  // fewer as the rain eases.
  if ( top.y > 0.5 || top.x < -1e3 || top.x > uCam.y + 0.2 || top.x < uCam.y - 14.0 || vSeed > uIntensity ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }
  vec3 base = vec3( xz.x, top.x + 0.005, xz.y );
  // Vertical billboard turned to the camera; bigger drops raise bigger crowns.
  vec3 toCam = uCam - base;
  vec2 side = normalize( vec2( -toCam.z, toCam.x ) + 1e-5 );
  float size = 0.05 + 0.07 * aSplash.w;
  vec3 pos = base + vec3( side.x, 0.0, side.y ) * corner.x * size + vec3( 0.0, corner.y * size * 1.4, 0.0 );
  gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
}
`;

const SPLASH_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vT;
varying float vSeed;
varying vec3 vColor;
void main() {
  // A crown sheet that rises and thins in the first third, then droplets flung out on ballistic
  // arcs falling back (5 per splash), all fading out by the end of the cycle.
  float t = vT;
  vec2 q = vec2( vUv.x, vUv.y );
  float sum = 0.0;
  float crownH = 0.55 * smoothstep( 0.0, 0.25, t ) * ( 1.0 - smoothstep( 0.25, 0.5, t ) );
  float crownR = 0.15 + 0.6 * t;
  float rim = 1.0 - smoothstep( 0.0, 0.08, abs( abs( q.x ) - crownR ) );
  sum += rim * step( q.y, crownH ) * ( 1.0 - q.y / max( crownH, 1e-3 ) * 0.6 ) * 0.7;
  for ( int i = 0; i < 5; i++ ) {
    float fi = float( i );
    float h = fract( vSeed * 7.31 + fi * 0.618 );
    float vx = ( h - 0.5 ) * 1.8;
    float vy = 1.4 + 1.2 * fract( h * 13.7 );
    float tt = t * 1.2;
    vec2 c = vec2( vx * tt, vy * tt - 2.6 * tt * tt );
    float r = 0.06 * ( 1.0 - 0.5 * t );
    sum += ( 1.0 - smoothstep( r * 0.5, r, length( q - c ) ) ) * step( 0.0, c.y );
  }
  float alpha = clamp( sum, 0.0, 1.0 ) * 0.55 * ( 1.0 - t );
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vColor, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CURTAIN_VERT = /* glsl */ `
uniform vec3 uCam;
uniform vec2 uWindVel;
varying vec3 vWorld;
varying float vArc;
varying float vShear;
varying float vTop;
varying float vFade;
${RAIN_OCCLUSION_GLSL}
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  vec3 d = w.xyz - uCam;
  // Per vertex (the cylinder is fine enough): arc length round the camera (world azimuth: the
  // streaks don't swim as you turn), the wind's shear across the view, the cover over this column
  // of air, and the fade towards straight up/down (the seams would show).
  vArc = uv.x * ${(2 * Math.PI * CURTAIN_RADIUS).toFixed(2)};
  vShear = dot( normalize( vec2( -d.z, d.x ) + 1e-5 ), uWindVel ) * 0.12;
  vTop = max( rainTopAt( w.xz ).x, uCam.y - 14.0 );
  vFade = 1.0 - smoothstep( 0.45, 0.6, abs( d.y ) / length( d ) );
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const CURTAIN_FRAG = /* glsl */ `
uniform sampler2D uStreaks;
uniform float uTime;
uniform vec3 uSky;
uniform float uFlash;
uniform float uIntensity;
varying vec3 vWorld;
varying float vArc;
varying float vShear;
varying float vTop;
varying float vFade;
void main() {
  // Two layers of streaks falling at storm speeds, sheared by the wind.
  vec2 uv1 = vec2( vArc / 9.0 + vWorld.y * vShear * 0.11, vWorld.y / 7.0 + uTime * 1.05 );
  vec2 uv2 = vec2( vArc / 5.3 + 0.37 + vWorld.y * vShear * 0.19, vWorld.y / 4.1 + uTime * 1.5 );
  float s = texture2D( uStreaks, uv1 ).r * 0.6 + texture2D( uStreaks, uv2 ).r * 0.4;
  // No rain where this column of air is under cover; splash mist low over where drops land.
  float h = vWorld.y - vTop;
  float above = smoothstep( 0.0, 0.6, h );
  // (masked below the cover like the streaks: no haze in the metro or under a roof).
  float mist = exp( -max( h, 0.0 ) / 0.7 ) * 0.07 * smoothstep( -0.1, 0.0, h );
  float alpha = ( ( 0.06 + 0.22 * s ) * above + mist ) * uIntensity * vFade;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( uSky * 1.15 + vec3( 0.8, 0.85, 1.0 ) * uFlash, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Tileable vertical streak noise for the distant curtain (R8, 64 × 256). */
function streakTexture(): THREE.DataTexture {
  const W = 64;
  const H = 256;
  const data = new Uint8Array(W * H);
  const rnd = mulberry32(11);
  for (let k = 0; k < 220; k++) {
    const x = Math.floor(rnd() * W);
    const y0 = Math.floor(rnd() * H);
    const len = 6 + Math.floor(rnd() * 26);
    const b = 90 + rnd() * 165;
    for (let j = 0; j < len; j++) {
      const y = (y0 + j) % H;
      const fade = Math.sin((j / len) * Math.PI);
      const i = y * W + x;
      data[i] = Math.min(255, data[i]! + b * fade);
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RedFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** One quad per instance: corner.x across (-1..1), corner.y along (0..1). */
function quadGeometry(
  count: number,
  attr: string,
  data: Float32Array,
): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    'corner',
    new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]), 2),
  );
  // three needs a position attribute to draw; the shaders place every vertex themselves.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  g.setAttribute(attr, new THREE.InstancedBufferAttribute(data, 4));
  g.instanceCount = count;
  return g;
}

/**
 * Physically grounded GPU rain, one draw each for streaks, splashes and the distant curtain, all
 * animated in the vertex shader (the CPU only advances a few uniforms):
 * - drops with Marshall–Palmer sizes fall at their terminal velocity, drift with the wind and its
 *   gusts, and are drawn as streaks along their screen-space motion over the eye's exposure
 *   (camera turning and sprinting included), defocused up close, sub-pixel far away;
 * - they end on the rain-occlusion height map (render/rainOcclusion.ts): no rain under roofs,
 *   awnings, in the hall or the metro, and splash crowns only on exposed hard tops;
 * - lit as the lenses they are: sky radiance + a sun glint when backlit + lightning.
 * Identical at every quality tier (fairness).
 */
export class Rain {
  readonly mesh: THREE.Group;
  private readonly drops: THREE.Mesh;
  private readonly splashes: THREE.Mesh;
  private readonly curtain: THREE.Mesh;
  private readonly dropMat: THREE.ShaderMaterial;
  private readonly splashMat: THREE.ShaderMaterial;
  private readonly curtainMat: THREE.ShaderMaterial;
  private readonly dropGeo: THREE.InstancedBufferGeometry;
  private readonly splashGeo: THREE.InstancedBufferGeometry;
  private intensity = 0;
  private time = 0;
  private readonly windOff = new THREE.Vector2();
  private readonly windVel = new THREE.Vector2();
  private readonly prevViewProj = new THREE.Matrix4();
  private readonly lastViewProj = new THREE.Matrix4();
  private readonly scratchVP = new THREE.Matrix4();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly prevCam = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private hasPrev = false;
  private readonly viewport = new THREE.Vector4();

  constructor() {
    const rnd = mulberry32(1);
    const drops = new Float32Array(DROP_COUNT * 4);
    for (let i = 0; i < DROP_COUNT; i++) {
      drops.set([rnd(), rnd(), rnd(), sampleDropDiameter(rnd)], i * 4);
    }
    const splashes = new Float32Array(SPLASH_COUNT * 4);
    for (let i = 0; i < SPLASH_COUNT; i++) {
      splashes.set([rnd(), rnd(), rnd(), Math.min(1, (sampleDropDiameter(rnd) - 0.5) / 3)], i * 4);
    }
    const sky = { value: new THREE.Color('#5b6570') };
    const flash = { value: 0 };
    const time = { value: 0 };
    const cam = { value: new THREE.Vector3() };
    const intensity = { value: 1 };
    const windVel = { value: this.windVel };
    const occ = { uRainOcc: rainOcclusion.map, uRainOccRect: rainOcclusion.rect };

    this.dropGeo = quadGeometry(DROP_COUNT, 'aDrop', drops);
    this.dropMat = new THREE.ShaderMaterial({
      uniforms: {
        ...occ,
        uTime: time,
        uCam: cam,
        uBox: { value: BOX },
        uWindOff: { value: this.windOff },
        uWindVel: windVel,
        uPrevViewProj: { value: this.prevViewProj },
        uCamSmear: { value: 0 },
        uViewport: { value: new THREE.Vector2(1280, 720) },
        uSky: sky,
        uSunColor: { value: new THREE.Color(0, 0, 0) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uFlash: flash,
        uFog: { value: 0.013 },
      },
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      transparent: true,
      depthWrite: false,
      // The quads are built in screen space with either winding.
      side: THREE.DoubleSide,
      fog: false,
    });
    this.drops = new THREE.Mesh(this.dropGeo, this.dropMat);
    this.drops.name = 'fx:rain';
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 2;
    this.drops.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(this.viewport);
      (this.dropMat.uniforms.uViewport!.value as THREE.Vector2).set(
        Math.max(1, this.viewport.z),
        Math.max(1, this.viewport.w),
      );
    };

    this.splashGeo = quadGeometry(SPLASH_COUNT, 'aSplash', splashes);
    // The splash quad grows up from the ground: corner.y 0..1 is its height.
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: {
        ...occ,
        uTime: time,
        uCam: cam,
        uBox: { value: SPLASH_BOX },
        uIntensity: intensity,
        uSky: sky,
        uFlash: flash,
      },
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.splashes = new THREE.Mesh(this.splashGeo, this.splashMat);
    this.splashes.name = 'fx:rainSplash';
    this.splashes.frustumCulled = false;
    this.splashes.renderOrder = 1;

    this.curtainMat = new THREE.ShaderMaterial({
      uniforms: {
        ...occ,
        uStreaks: { value: streakTexture() },
        uTime: time,
        uCam: cam,
        uSky: sky,
        uFlash: flash,
        uIntensity: intensity,
        uWindVel: windVel,
      },
      vertexShader: CURTAIN_VERT,
      fragmentShader: CURTAIN_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    this.curtain = new THREE.Mesh(
      new THREE.CylinderGeometry(CURTAIN_RADIUS, CURTAIN_RADIUS, CURTAIN_HEIGHT, 48, 6, true),
      this.curtainMat,
    );
    this.curtain.name = 'fx:rainCurtain';
    this.curtain.frustumCulled = false;
    this.curtain.renderOrder = 0;

    this.mesh = new THREE.Group();
    this.mesh.name = 'fx:rainGroup';
    this.mesh.add(this.curtain, this.splashes, this.drops);
    this.mesh.visible = false;
  }

  setIntensity(v: number): void {
    this.intensity = Math.min(1, Math.max(0, v));
    this.dropGeo.instanceCount = Math.round(DROP_COUNT * this.intensity);
    this.splashMat.uniforms.uIntensity!.value = this.intensity;
    this.mesh.visible = this.intensity > 0;
  }

  /**
   * Low trims what doesn't change how much the rain hides: no splash crowns (the drops and the
   * curtain, which carry the concealment, are identical on every tier).
   */
  setLowQuality(low: boolean): void {
    this.splashes.visible = !low;
  }

  /** Light the drops for the weather (WeatherSystem.apply). */
  setLighting(l: RainLighting): void {
    const u = this.dropMat.uniforms;
    (u.uSky!.value as THREE.Color).copy(l.sky);
    (u.uSunColor!.value as THREE.Color).copy(l.sunColor);
    (u.uSunDir!.value as THREE.Vector3).copy(l.sunDir).normalize();
    u.uFog!.value = l.fogDensity;
  }

  /** Lightning flash 0..1 (WeatherSystem.update): every drop lights up with the sky. */
  setFlash(f: number): void {
    this.dropMat.uniforms.uFlash!.value = f;
  }

  /**
   * `wind` 0..1 = the weather's wind strength, `gust` 0..1 the shared WindGusts signal,
   * `windDir` the wind's direction (xz), the foliage's.
   */
  update(
    dt: number,
    camera: THREE.Camera,
    wind = 1,
    gust = 0,
    windDir: THREE.Vector2 = new THREE.Vector2(0.8, 0.6),
  ): void {
    // The clock runs even when it stops raining, so the last puddle rings play out and fade;
    // `rainStop` marks when the rain stopped (no new impacts after it). Wrapped so float
    // precision holds in long sessions (a reshuffle once an hour).
    const wrapped = this.time + dt >= 3600;
    this.time = (this.time + dt) % 3600;
    rainTime.value = this.time;
    if (this.intensity > 0) rainStop.value = RAINING;
    else if (rainStop.value === RAINING) rainStop.value = this.time;
    else if (wrapped) rainStop.value -= 3600;
    if (!this.mesh.visible) {
      this.hasPrev = false;
      return;
    }
    const u = this.dropMat.uniforms;
    u.uTime!.value = this.time;
    const speed = rainWindSpeed(wind, gust);
    const len = Math.hypot(windDir.x, windDir.y) || 1;
    this.windVel.set((windDir.x / len) * speed, (windDir.y / len) * speed);
    // Integrate the drift (gusts change speed, the field never jumps); wrap by the box.
    this.windOff.x = (this.windOff.x + this.windVel.x * dt) % BOX.x;
    this.windOff.y = (this.windOff.y + this.windVel.y * dt) % BOX.z;
    camera.updateMatrixWorld();
    (u.uCam!.value as THREE.Vector3).copy(camera.position);
    const viewProj = this.scratchVP.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    // The distant curtain rides with the camera (its streaks are anchored in world azimuth).
    this.curtain.position.set(camera.position.x, camera.position.y + 1, camera.position.z);
    // A cut (teleport, cinematic switch, respawn) must not smear the streaks across the screen.
    const pos = camera.getWorldPosition(this.scratchPos);
    const quat = camera.getWorldQuaternion(this.scratchQuat);
    const cut =
      !this.hasPrev ||
      pos.distanceTo(this.prevCam) > Math.max(1.5, 20 * dt) ||
      quat.angleTo(this.prevQuat) > 0.6;
    u.uCamSmear!.value = cut ? 0 : (CAMERA_SMEAR * STREAK_EXPOSURE) / Math.max(dt, 1 / 240);
    // The previous frame's view-projection, for the camera share of the streak.
    this.prevViewProj.copy(cut ? viewProj : this.lastViewProj);
    this.lastViewProj.copy(viewProj);
    this.prevCam.copy(pos);
    this.prevQuat.copy(quat);
    this.hasPrev = true;
  }
}
