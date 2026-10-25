import * as THREE from 'three';

/**
 * Jetpack effects (presentation only; never read by the sim), all cheap and all built up front so
 * `Game.warmUp` compiles every program (hidden objects are shown for the compile):
 *
 * - **Exhaust**: per nozzle a hot core cone (procedural flicker, white-blue → orange) inside a
 *   wider, faint heat-shimmer cone, and a glow sprite on the nozzle. Pooled (two per flyer, six
 *   flyers); unused ones hide. One shader for every flame (uniforms per mesh, same program).
 * - **Particles**: one `Points` draw for everything — nozzle smoke and sputter sparks, the
 *   dust/leaf kick-up on the ground under a low flyer, the landing puff. CPU-stepped (≤ 640),
 *   GPU-sized soft discs.
 */

const MAX_FLAMES = 12;
const MAX_PARTICLES = 640;

const FLAME_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uPower;
  uniform float uSeed;
  uniform float uShimmer;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    // v: 0 at the nozzle, 1 at the tip.
    float v = 1.0 - vUv.y;
    float t = uTime * 38.0 + uSeed * 17.0;
    // Flicker: two travelling bands and a slow throb, so the plume never reads as a static cone.
    float flick = 0.72 + 0.18 * sin(v * 23.0 - t) * sin(vUv.x * 31.4 + t * 0.7)
      + 0.1 * sin(t * 0.37 + uSeed);
    float fall = pow(max(0.0, 1.0 - v), 1.35);
    float edge = pow(vFacing, 1.1);
    // White-yellow core into orange down the plume; the rim (grazing) burns blue.
    vec3 core = vec3(1.0, 0.95, 0.72);
    vec3 hot = vec3(1.0, 0.48, 0.12);
    vec3 rim = vec3(0.32, 0.5, 1.0);
    vec3 col = mix(core, hot, smoothstep(0.05, 0.65, v));
    col = mix(rim, col, smoothstep(0.15, 0.75, vFacing));
    col *= 3.2 * fall * flick;
    float a = fall * mix(0.35, 1.0, edge) * uPower;
    if (uShimmer > 0.5) {
      // Heat haze: faint wavy bands drifting down the wider cone.
      float w = 0.5 + 0.5 * sin(v * 40.0 - t * 0.9 + vUv.x * 12.566);
      col = vec3(0.55, 0.6, 0.65) * w * 0.25;
      a = 0.18 * w * edge * fall * uPower;
    }
    gl_FragColor = vec4(col * a, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const DOT_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (420.0 / max(0.5, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const DOT_FRAG = /* glsl */ `
  varying vec4 vColor;
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r = dot(d, d);
    if (r > 1.0) discard;
    float a = vColor.a * (1.0 - r) * (1.0 - r);
    gl_FragColor = vec4(vColor.rgb * a, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface Flame {
  core: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  haze: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  glow: THREE.Sprite;
  /** The hot nozzle mouth: a small bright disc across the exit. */
  disc: THREE.Mesh;
  /** The light the plume throws on the ground below a low flyer (an additive card). */
  pool: THREE.Mesh;
}

/** Particle kinds: smoke (grey), spark (orange), dust (warm grey), leaf (dark green-brown). */
export type ParticleKind = 'smoke' | 'spark' | 'dust' | 'leaf';
const COLORS: Record<ParticleKind, [number, number, number, number]> = {
  smoke: [0.42, 0.42, 0.44, 0.35],
  spark: [1.4, 0.75, 0.3, 1.0],
  dust: [0.62, 0.56, 0.48, 0.42],
  leaf: [0.24, 0.27, 0.14, 0.85],
};

/** A soft radial glow (white core, blue-white falloff), built in JS: no canvas, no DOM. */
function glowTexture(): THREE.Texture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      const a = Math.pow(1 - r, 2.2);
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(255 * (0.82 + 0.18 * (1 - r)));
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * a);
    }
  const t = new THREE.DataTexture(data, n, n);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class JetpackFx {
  readonly group = new THREE.Group();
  private readonly flames: Flame[] = [];
  private used = 0;
  private time = 0;
  // Particles (struct of arrays).
  private readonly pos = new Float32Array(MAX_PARTICLES * 3);
  private readonly vel = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly age = new Float32Array(MAX_PARTICLES);
  private readonly size0 = new Float32Array(MAX_PARTICLES);
  private readonly kind = new Uint8Array(MAX_PARTICLES);
  private readonly sizes = new Float32Array(MAX_PARTICLES);
  private readonly colors = new Float32Array(MAX_PARTICLES * 4);
  private readonly points: THREE.Points;
  private next = 0;
  private live = 0;
  private seed = 1;

  constructor() {
    this.group.name = 'jetpack:fx';
    const coreGeo = new THREE.CylinderGeometry(0.075, 0.012, 1, 14, 1, true);
    coreGeo.translate(0, -0.5, 0);
    const hazeGeo = new THREE.CylinderGeometry(0.11, 0.06, 1, 12, 1, true);
    hazeGeo.translate(0, -0.5, 0);
    const base = new THREE.ShaderMaterial({
      name: 'jetpack:flame',
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPower: { value: 1 },
        uSeed: { value: 0 },
        uShimmer: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });
    const glowTex = glowTexture();
    const discMat = new THREE.MeshBasicMaterial({
      name: 'jetpack:disc',
      color: new THREE.Color(3, 2.4, 1.5),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const poolMat = new THREE.MeshBasicMaterial({
      name: 'jetpack:pool',
      map: glowTex,
      color: new THREE.Color(1, 0.62, 0.3),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const discGeo = new THREE.CircleGeometry(0.05, 14);
    discGeo.rotateX(Math.PI / 2);
    const poolGeo = new THREE.PlaneGeometry(1, 1);
    poolGeo.rotateX(-Math.PI / 2);
    const glowMat = new THREE.SpriteMaterial({
      name: 'jetpack:glow',
      map: glowTex,
      color: new THREE.Color(1.5, 1.15, 0.72),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < MAX_FLAMES; i++) {
      const core = new THREE.Mesh(coreGeo, base.clone());
      core.material.uniforms.uSeed!.value = i * 1.37;
      const haze = new THREE.Mesh(hazeGeo, base.clone());
      haze.material.uniforms.uShimmer!.value = 1;
      haze.material.uniforms.uSeed!.value = i * 0.71;
      const glow = new THREE.Sprite(glowMat);
      const disc = new THREE.Mesh(discGeo, discMat);
      // One material per pool: its opacity is the light's strength.
      const pool = new THREE.Mesh(poolGeo, poolMat.clone());
      for (const o of [core, haze, glow, disc, pool]) {
        o.visible = false;
        o.frustumCulled = false;
        o.renderOrder = 5;
        this.group.add(o);
      }
      this.flames.push({ core, haze, glow, disc, pool });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      'aColor',
      new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setDrawRange(0, MAX_PARTICLES);
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        name: 'jetpack:particles',
        vertexShader: DOT_VERT,
        fragmentShader: DOT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'jetpack:particles';
    this.group.add(this.points);
  }

  /** The camera this frame (glows keep a minimum size on screen so flyers read far away). */
  private readonly eye = new THREE.Vector3();

  /** Start a frame: every flame is free again. */
  begin(dt: number, eye?: THREE.Vector3): void {
    this.time += dt;
    this.used = 0;
    if (eye) this.eye.copy(eye);
  }

  /**
   * One nozzle this frame: its exit (world), exhaust direction (world, unit), `power` 0–1 (thrust
   * 1, hover ~0.35, a sputter cut-out dips it), and how far below the ground is (m; null: none).
   */
  nozzle(
    at: THREE.Vector3,
    dir: THREE.Vector3,
    power: number,
    dt: number,
    groundBelow: number | null,
  ): void {
    const f = this.flames[this.used++];
    if (!f) return;
    if (power <= 0.01) {
      f.core.visible = f.haze.visible = f.glow.visible = f.disc.visible = f.pool.visible = false;
      return;
    }
    // About twice the old plume at full thrust (0.4 m at a hover's 0.45, 1.9 m at full).
    const len = 0.4 + 1.5 * power * (0.92 + 0.08 * Math.sin(this.time * 31 + this.used * 1.7));
    const q = TMP_Q.setFromUnitVectors(DOWN, dir);
    for (const [m, k] of [
      [f.core, 1],
      [f.haze, 1.2],
    ] as const) {
      m.visible = true;
      m.position.copy(at);
      m.quaternion.copy(q);
      m.scale.set(0.8 + 0.4 * power, len * k, 0.8 + 0.4 * power);
      m.material.uniforms.uTime!.value = this.time;
      m.material.uniforms.uPower!.value = Math.min(1, 0.35 + power);
    }
    f.disc.visible = true;
    f.disc.position.copy(at);
    f.disc.quaternion.copy(q);
    f.glow.visible = true;
    // ~0.4–0.95 m up close; never under ~1 % of the view's height (reads at 30 m and beyond).
    // The nozzles sit behind the body: far off, the glow is pulled toward the eye (≤ 0.35 m) so
    // it shows round the flyer's silhouette instead of hiding behind the legs.
    const dist = this.eye.distanceTo(at);
    f.glow.position
      .copy(this.eye)
      .sub(at)
      .multiplyScalar(dist > 1e-3 ? Math.min(0.35, dist * 0.012) / dist : 0)
      .add(at)
      .addScaledVector(dir, 0.08);
    const s =
      Math.max(0.4 + 0.55 * power, dist * 0.03) * (1 + 0.08 * Math.sin(this.time * 47 + this.used));
    f.glow.scale.set(s, s, s);
    // The plume lights the ground under a low flyer: a warm additive pool, wider and fainter
    // the higher it is.
    if (groundBelow !== null && groundBelow < 5) {
      const k = (1 - groundBelow / 5) * power;
      f.pool.visible = k > 0.02;
      f.pool.position.set(at.x, at.y - groundBelow + 0.03, at.z);
      const w = 1.4 + groundBelow * 0.55;
      f.pool.scale.set(w, 1, w);
      (f.pool.material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, k * 0.85);
    } else f.pool.visible = false;
    // Exhaust smoke off the flame's tip, and dust kicked up where it hits the ground.
    if (Math.random() < dt * 30 * power) {
      const p = TMP_V.copy(at).addScaledVector(dir, len * 0.9);
      this.spawn('smoke', p, dir.x * 3, dir.y * 3, dir.z * 3, 0.6, 0.12);
    }
    if (groundBelow !== null && groundBelow < 3.4 && power > 0.15) {
      const near = 1 - groundBelow / 3.4;
      const n = Math.random() < dt * 70 * near * power ? 1 + (Math.random() < 0.3 ? 1 : 0) : 0;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.2 + Math.random() * 0.5;
        const gx = at.x + Math.cos(a) * r;
        const gz = at.z + Math.sin(a) * r;
        const gy = at.y - groundBelow + 0.05;
        const v = 2.2 + Math.random() * 2.5 * near;
        const leaf = Math.random() < 0.18;
        this.spawn(
          leaf ? 'leaf' : 'dust',
          TMP_V.set(gx, gy, gz),
          Math.cos(a) * v,
          0.4 + Math.random() * (leaf ? 2.4 : 0.9),
          Math.sin(a) * v,
          leaf ? 1.4 : 1.1,
          leaf ? 0.05 : 0.35 + Math.random() * 0.3,
        );
      }
    }
  }

  /** Sputter cough at a nozzle: black smoke and a few sparks. */
  sputter(at: THREE.Vector3, dir: THREE.Vector3): void {
    for (let i = 0; i < 4; i++)
      this.spawn('smoke', at, dir.x * 2 + jit(), dir.y * 2, dir.z * 2 + jit(), 0.8, 0.18);
    for (let i = 0; i < 5; i++)
      this.spawn(
        'spark',
        at,
        dir.x * 5 + jit(3),
        dir.y * 5 + jit(2),
        dir.z * 5 + jit(3),
        0.35,
        0.03,
      );
  }

  /** The landing puff: a ring of dust at the feet. */
  landPuff(feet: THREE.Vector3, strength = 1): void {
    const n = Math.round(30 * strength);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const v = (2.5 + Math.random() * 2.5) * strength;
      this.spawn(
        'dust',
        TMP_V.set(feet.x, feet.y + 0.08, feet.z),
        Math.cos(a) * v,
        0.3 + Math.random() * 0.8,
        Math.sin(a) * v,
        1.2,
        0.4 + Math.random() * 0.3,
      );
    }
  }

  private spawn(
    kind: ParticleKind,
    p: THREE.Vector3,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life * (0.8 + 0.4 * rand(this.seed++));
    this.age[i] = 0;
    this.size0[i] = size;
    this.kind[i] = kind === 'smoke' ? 0 : kind === 'spark' ? 1 : kind === 'dust' ? 2 : 3;
  }

  /** End a frame: hide unused flames, step and upload the particles. */
  end(dt: number): void {
    for (let i = this.used; i < MAX_FLAMES; i++) {
      const f = this.flames[i]!;
      f.core.visible = f.haze.visible = f.glow.visible = f.disc.visible = f.pool.visible = false;
    }
    let live = 0;
    const kinds: ParticleKind[] = ['smoke', 'spark', 'dust', 'leaf'];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.life[i]!;
      if (life <= 0) {
        this.sizes[i] = 0;
        this.colors[i * 4 + 3] = 0;
        continue;
      }
      const age = (this.age[i] = this.age[i]! + dt);
      if (age >= life) {
        this.life[i] = 0;
        this.sizes[i] = 0;
        this.colors[i * 4 + 3] = 0;
        continue;
      }
      live++;
      const k = this.kind[i]!;
      const drag = k === 1 ? 1.5 : k === 3 ? 1.2 : 3.2;
      const lift = k === 0 ? 0.9 : k === 2 ? 0.25 : k === 1 ? -9 : -2.5;
      const j = i * 3;
      const dk = Math.max(0, 1 - drag * dt);
      this.vel[j] = this.vel[j]! * dk;
      this.vel[j + 1] = this.vel[j + 1]! * dk + lift * dt;
      this.vel[j + 2] = this.vel[j + 2]! * dk;
      this.pos[j] = this.pos[j]! + this.vel[j] * dt;
      this.pos[j + 1] = this.pos[j + 1]! + this.vel[j + 1]! * dt;
      this.pos[j + 2] = this.pos[j + 2]! + this.vel[j + 2]! * dt;
      const u = age / life;
      const grow = k === 1 || k === 3 ? 1 : 1 + 2.2 * u;
      this.sizes[i] = this.size0[i]! * grow;
      const c = COLORS[kinds[k]!];
      const fade = k === 1 ? 1 - u : Math.sin(Math.PI * Math.min(1, u * 1.15));
      this.colors[i * 4] = c[0];
      this.colors[i * 4 + 1] = c[1];
      this.colors[i * 4 + 2] = c[2];
      this.colors[i * 4 + 3] = c[3] * fade;
    }
    this.live = live;
    const g = this.points.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('aSize').needsUpdate = true;
    g.getAttribute('aColor').needsUpdate = true;
    this.points.visible = live > 0;
  }

  /** Live particles and lit flames (tests, probes). */
  get stats(): { particles: number; flames: number } {
    return { particles: this.live, flames: this.flames.filter((f) => f.core.visible).length };
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const TMP_Q = new THREE.Quaternion();
const TMP_V = new THREE.Vector3();
const jit = (k = 1): number => (Math.random() * 2 - 1) * k;
const rand = (s: number): number => {
  const x = Math.sin(s * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
