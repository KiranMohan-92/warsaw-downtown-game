import * as THREE from 'three';
import { CAS_MAX_LOBE } from './sharpen.ts';
import { GRADE_GLSL } from './grade.ts';

/**
 * Low's frame target and its sharpen pass (CAS, after AMD FidelityFX CAS, MIT).
 *
 * Low has no composer: its materials tone-map and sRGB-encode themselves. It used to draw into
 * a multisampled canvas, which left no cheap way to sharpen (copying the canvas back cost a
 * multisample resolve plus a copy: ~0.6 ms of Intel UHD at 75 %, before any filtering). Now the
 * canvas is single-sampled and Low draws into this 4× MSAA target instead, resolved once, then
 * one fullscreen pass writes the canvas: a plain copy at 100 %, CAS below it, both with the shared
 * colour grade (grade.ts). The canvas resolve at present is gone, so that pass is all Low pays at
 * 100 %.
 *
 * The target keeps Low's programs: three tone-maps and encodes only when drawing to the canvas or
 * to an XR target, and uses an XR target's texture colour space as the output space. So the
 * target is flagged `isXRRenderTarget` with an sRGB texture stored as plain RGBA8 (forced
 * `internalFormat`, the same 8-bit sRGB-encoded bytes the canvas held): every Low program is the
 * one warm-up compiled for the canvas.
 *
 * three resolves a multisampled target at the end of every `render()` into it; the frame needs
 * three draws (pre-pass, world, viewmodel), so `drawWithoutResolve` suppresses the first two.
 */
export class LowFrame {
  readonly target: THREE.WebGLRenderTarget;
  private readonly samples = 4;
  private readonly copy: THREE.ShaderMaterial;
  private readonly cas: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new THREE.Vector2();
  /** CAS strength in [0, 1]; 0 = plain copy. */
  strength = 0;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      samples: this.samples,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.SRGBColorSpace,
      internalFormat: 'RGBA8',
    });
    this.target.resolveDepthBuffer = false;
    (this.target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    const uniforms = {
      frame: { value: this.target.texture },
      strength: { value: 0 },
    };
    const common = { uniforms, vertexShader: VERTEX, depthTest: false, depthWrite: false };
    this.copy = new THREE.ShaderMaterial({ ...common, fragmentShader: COPY_FRAGMENT });
    this.cas = new THREE.ShaderMaterial({ ...common, fragmentShader: CAS_FRAGMENT });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this.mesh = new THREE.Mesh(geometry, this.copy);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /**
   * Leaving Low: shrink the target to 1×1 (three disposes and later re-creates its GL buffers),
   * so its multisampled colour + depth and the resolved texture (~80 MiB at 1080p, >300 MiB at
   * 4K) don't sit next to the HDR chain. `begin` restores the size on the next Low frame.
   */
  park(): void {
    this.target.setSize(1, 1);
  }

  /** Bind the target at the drawing-buffer size and clear it (start of a Low frame). */
  begin(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) {
      this.target.setSize(this.size.x, this.size.y);
    }
    renderer.setRenderTarget(this.target);
    renderer.clear();
  }

  /**
   * Draws into the bound target that three must not resolve (more draws follow). three resolves
   * only when the target's `samples` > 0, so they are 0 meanwhile; a shadow pass inside a draw
   * rebinds the current target when it is done, which would then pick the single-sampled
   * framebuffer, so the multisampled one is rebound right after it. (No transmission materials
   * are used: their pass rebinds the same way.)
   */
  drawWithoutResolve(renderer: THREE.WebGLRenderer, draw: () => void): void {
    const shadowMap = renderer.shadowMap;
    // The exact function goes back afterwards (other wrappers, e.g. the perf overlay, hold it).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const shadows = shadowMap.render;
    shadowMap.render = (...args) => {
      shadows.apply(shadowMap, args);
      this.target.samples = this.samples;
      renderer.setRenderTarget(this.target);
      this.target.samples = 0;
    };
    this.target.samples = 0;
    try {
      draw();
    } finally {
      this.target.samples = this.samples;
      shadowMap.render = shadows;
    }
  }

  /** Write the resolved frame to the canvas: CAS when `strength` > 0, else a copy. */
  present(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(null);
    this.mesh.material = this.strength > 0 ? this.cas : this.copy;
    this.cas.uniforms.strength!.value = this.strength;
    renderer.render(this.scene, this.camera);
  }

  /** Compile both present programs (warm-up). */
  warm(renderer: THREE.WebGLRenderer): void {
    for (const m of [this.copy, this.cas]) {
      this.mesh.material = m;
      renderer.compile(this.scene, this.camera);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.copy.dispose();
    this.cas.dispose();
  }
}

const VERTEX = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

/** Copy + the shared grade (grade.ts), the uv from the frame's own size. */
const COPY_FRAGMENT = /* glsl */ `
uniform sampler2D frame;
${GRADE_GLSL}
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  vec2 uv = gl_FragCoord.xy / vec2( textureSize( frame, 0 ) );
  gl_FragColor = vec4( gradeDisplay( texelFetch( frame, p, 0 ).rgb, uv ), 1.0 );
}
`;

/**
 * CAS on the display-referred frame (Low's values are tone-mapped and sRGB-encoded, in [0, 1]),
 * on luma only: the 5-tap cross's luma sets the adaptive amount and is sharpened and clamped to
 * its neighbourhood (no halos), and the pixel moves by that luma change (no colour fringes).
 * Per-channel CAS cost 0.60 ms on Intel UHD at 75 % (1200×675), this 0.46 ms (the plain copy it
 * replaces: 0.17 ms). `casDisplay` is the reference the tests pin.
 */
const CAS_FRAGMENT = /* glsl */ `
uniform sampler2D frame;
uniform float strength;
${GRADE_GLSL}
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  ivec2 hi = textureSize( frame, 0 ) - 1;
  vec3 c = texelFetch( frame, p, 0 ).rgb;
  const vec3 Y = vec3( 0.2126, 0.7152, 0.0722 );
  vec4 l = vec4(
    dot( texelFetch( frame, min( p + ivec2( 0, 1 ), hi ), 0 ).rgb, Y ),
    dot( texelFetch( frame, max( p - ivec2( 0, 1 ), ivec2( 0 ) ), 0 ).rgb, Y ),
    dot( texelFetch( frame, min( p + ivec2( 1, 0 ), hi ), 0 ).rgb, Y ),
    dot( texelFetch( frame, max( p - ivec2( 1, 0 ), ivec2( 0 ) ), 0 ).rgb, Y ) );
  float lc = dot( c, Y );
  float lmin = min( lc, min( min( l.x, l.y ), min( l.z, l.w ) ) );
  float lmax = max( lc, max( max( l.x, l.y ), max( l.z, l.w ) ) );
  float amp = sqrt( clamp( min( lmin, 1.0 - lmax ) / max( lmax, 1e-5 ), 0.0, 1.0 ) );
  float lobe = -amp * ( ${CAS_MAX_LOBE.toFixed(3)} * strength );
  float sharp = clamp( ( lc + lobe * ( l.x + l.y + l.z + l.w ) ) / ( 1.0 + 4.0 * lobe ), lmin, lmax );
  vec2 uv = gl_FragCoord.xy / vec2( textureSize( frame, 0 ) );
  gl_FragColor = vec4( gradeDisplay( c + ( sharp - lc ), uv ), 1.0 );
}
`;

type Rgb = readonly [number, number, number];

const luma = (v: Rgb): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

/** Reference for `CAS_FRAGMENT` (one pixel, display-referred RGB in [0, 1]; neighbours N, S, E, W). */
export function casDisplay(c: Rgb, n: Rgb, s: Rgb, e: Rgb, w: Rgb, strength: number): Rgb {
  if (strength <= 0) return c;
  const ls = [luma(n), luma(s), luma(e), luma(w)];
  const lc = luma(c);
  const lmin = Math.min(lc, ...ls);
  const lmax = Math.max(lc, ...ls);
  const amp = Math.sqrt(Math.min(1, Math.max(0, Math.min(lmin, 1 - lmax) / Math.max(lmax, 1e-5))));
  const lobe = -amp * CAS_MAX_LOBE * strength;
  const sum = ls[0]! + ls[1]! + ls[2]! + ls[3]!;
  const sharp = Math.min(lmax, Math.max(lmin, (lc + lobe * sum) / (1 + 4 * lobe)));
  const d = sharp - lc;
  return [c[0] + d, c[1] + d, c[2] + d];
}
