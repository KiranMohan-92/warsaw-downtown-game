import * as THREE from 'three';
import { withTimeout } from './surfaceTextures.ts';

/** Startup waits this long for the photographed sky, then plays with the procedural one. */
export const SKY_PHOTO_TIMEOUT_MS = 15_000;

export interface SkyParams {
  zenith: THREE.Color;
  horizon: THREE.Color;
  /** Colour below the horizon (haze over the city). */
  ground: THREE.Color;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  /** Sun disc/glow strength (0 when overcast). */
  sunStrength: number;
  /** 0 = clear, 1 = solid cloud deck. */
  cloudCover: number;
  cloudLight: THREE.Color;
  cloudDark: THREE.Color;
  /** Extra brightness during lightning flashes. */
  flash: number;
}

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // always at the far plane
  }
`;

const frag = /* glsl */ `
  uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor, uCloudLight, uCloudDark;
  uniform float uSunStrength, uCloudCover, uTime, uFlash, uExposure;
  // Photographed sky (upper hemisphere, gamma-encoded HDR; tools/assets/build_sky.py).
  uniform sampler2D uPhoto;
  uniform float uPhotoMix, uPhotoGain, uPhotoRange;
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.45));
    col = mix(col, uGround, smoothstep(0.0, -0.12, h));

    float sd = max(dot(d, normalize(uSunDir)), 0.0);
    vec3 sun = uSunColor * (pow(sd, 6.0) * 0.35 + pow(sd, 64.0) * 0.6) * uSunStrength;
    float disc = smoothstep(0.9994, 0.9997, sd) * uSunStrength;

    // Cloud deck: project onto a plane above the camera, drift slowly.
    float cloudMask = 0.0;
    vec3 cloudCol = vec3(0.0);
    // The procedural deck (10 noise lookups per pixel) only when no photographed sky covers it.
    if (h > 0.0 && uPhotoMix < 1.0) {
      vec2 uv = d.xz / (h + 0.12) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
      float n = fbm(uv * 1.6);
      float thresh = 1.0 - uCloudCover;
      cloudMask = smoothstep(thresh - 0.05, thresh + 0.25, n) * smoothstep(0.0, 0.18, h);
      float lit = fbm(uv * 1.6 + normalize(uSunDir).xz * 0.08);
      cloudCol = mix(uCloudDark, uCloudLight, clamp(0.5 + (n - lit) * 3.0, 0.0, 1.0));
      cloudCol += uSunColor * pow(sd, 8.0) * 0.4 * uSunStrength;
    }
    cloudMask *= 1.0 - uPhotoMix; // a photographed sky brings its own clouds
    if (uPhotoMix > 0.0 && h > -0.03) {
      // Game azimuth (0 = -Z, clockwise), as the sky was rotated at build time.
      float u = fract(atan(d.x, -d.z) / 6.2831853);
      float v = clamp(asin(clamp(h, 0.0, 1.0)) / 1.5707963, 0.002, 0.998);
      vec3 photo = pow(texture2D(uPhoto, vec2(u, v)).rgb, vec3(2.2)) * uPhotoRange * uPhotoGain;
      // Melt into the city haze at the horizon, like the procedural sky.
      float w = uPhotoMix * smoothstep(-0.03, 0.04, h);
      col = mix(col, photo + sun * 0.35, w);
    }
    col = mix(col + sun * (1.0 - uPhotoMix * 0.65), cloudCol, cloudMask) + uSunColor * disc * (1.0 - cloudMask) * 8.0;
    col += vec3(0.75, 0.8, 1.0) * uFlash * (0.4 + 0.6 * cloudMask);
    gl_FragColor = vec4(col * uExposure, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * PMREM cube size of every environment map (procedural bake and HDRI alike). Materials compile
 * the env map's cube-UV texel size in as defines, so a map of another size would recompile every
 * lit program mid-game; the HDRIs are built at 512 × 256 (PMREM uses width / 4) to match.
 */
export const ENV_CUBE_SIZE = 128;

/** Bound to the photo sampler until a sky photo loads (the program never changes). */
const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK.needsUpdate = true;

/** Sky dome that follows the camera, plus an environment map baked from the same sky. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly envScene = new THREE.Scene();
  private readonly envMesh: THREE.Mesh;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly pmrem: THREE.PMREMGenerator;

  constructor(renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uSunStrength: { value: 1 },
        uCloudCover: { value: 0.3 },
        uCloudLight: { value: new THREE.Color() },
        uCloudDark: { value: new THREE.Color() },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uExposure: { value: 1 },
        uPhoto: { value: BLACK },
        uPhotoMix: { value: 0 },
        uPhotoGain: { value: 1 },
        uPhotoRange: { value: 4 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });
    const geo = new THREE.SphereGeometry(1, 48, 24);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.scale.setScalar(500);
    this.mesh.frustumCulled = false;
    // Drawn after all opaque geometry: it sits at the far plane (xyww), so the depth test
    // leaves only the pixels that really show sky. Drawing it first (as before) shaded the
    // whole screen with the cloud shader and then painted the city over it.
    this.mesh.renderOrder = 1000;
    this.mesh.name = 'sky';
    this.envMesh = new THREE.Mesh(geo, this.material);
    this.envMesh.scale.setScalar(100);
    this.envScene.add(this.envMesh);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  set(p: SkyParams): void {
    const u = this.material.uniforms as Record<string, THREE.IUniform>;
    (u.uZenith!.value as THREE.Color).copy(p.zenith);
    (u.uHorizon!.value as THREE.Color).copy(p.horizon);
    (u.uGround!.value as THREE.Color).copy(p.ground);
    (u.uSunDir!.value as THREE.Vector3).copy(p.sunDir).normalize();
    (u.uSunColor!.value as THREE.Color).copy(p.sunColor);
    u.uSunStrength!.value = p.sunStrength;
    u.uCloudCover!.value = p.cloudCover;
    (u.uCloudLight!.value as THREE.Color).copy(p.cloudLight);
    (u.uCloudDark!.value as THREE.Color).copy(p.cloudDark);
    u.uFlash!.value = p.flash;
  }

  /**
   * Load the photographed sky (sunny preset) and upload it now (before warm-up; swapping the
   * sampler's texture never recompiles). `range` is the build's encoding range (sky.json).
   * Rejects after `timeoutMs` (a stalled server must not hold startup; the procedural sky stays),
   * and a photo that arrives later is dropped, never swapped in mid-play.
   */
  async loadPhoto(
    renderer: THREE.WebGLRenderer,
    url: string,
    range: number,
    timeoutMs = SKY_PHOTO_TIMEOUT_MS,
  ): Promise<void> {
    const load = new THREE.TextureLoader().loadAsync(url);
    const tex = await withTimeout(load, timeoutMs, url).catch((e: unknown) => {
      void load.then(
        (late) => late.dispose(),
        () => {},
      );
      throw e;
    });
    tex.colorSpace = THREE.NoColorSpace; // decoded in the shader
    tex.generateMipmaps = false; // always magnified on screen; mips would seam at the wrap
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    renderer.initTexture(tex);
    const u = this.material.uniforms as Record<string, THREE.IUniform>;
    u.uPhoto!.value = tex;
    u.uPhotoRange!.value = range;
    this.photoReady = true;
  }

  private photoReady = false;

  /** Blend the photographed sky in (0 = procedural sky); no-op until the photo has loaded. */
  setPhoto(mix: number, gain: number): void {
    const u = this.material.uniforms as Record<string, THREE.IUniform<number>>;
    u.uPhotoMix!.value = this.photoReady ? mix : 0;
    u.uPhotoGain!.value = gain;
  }

  setExposure(v: number): void {
    (this.material.uniforms as Record<string, THREE.IUniform>).uExposure!.value = v;
  }

  setFlash(v: number): void {
    (this.material.uniforms as Record<string, THREE.IUniform>).uFlash!.value = v;
  }

  update(dt: number, camera: THREE.Camera): void {
    (this.material.uniforms as Record<string, THREE.IUniform<number>>).uTime!.value += dt;
    this.mesh.position.copy(camera.position);
  }

  /**
   * Bake the current sky into a prefiltered environment map (call when weather changes). Baked
   * at exposure 1 and without lightning: the weather system applies exposure through
   * `scene.environmentIntensity`, as it does for the HDRI maps.
   */
  bakeEnvironment(): THREE.Texture {
    const u = this.material.uniforms as Record<string, THREE.IUniform<number>>;
    const flash = u.uFlash!.value;
    const exposure = u.uExposure!.value;
    u.uFlash!.value = 0;
    u.uExposure!.value = 1;
    this.envTarget?.dispose();
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 200, { size: ENV_CUBE_SIZE });
    u.uFlash!.value = flash;
    u.uExposure!.value = exposure;
    return this.envTarget.texture;
  }
}
