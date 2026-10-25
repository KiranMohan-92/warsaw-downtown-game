import * as THREE from 'three';
import { JAMMER, smokeCentre, smokeShape, type SmokeCloud } from '@wd/shared';

/** Soft round puff texture (generated once, no download). */
function puffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PUFFS = 26;

/**
 * Smoke clouds as clusters of soft billboards that bloom, drift and thin out with the cloud's
 * density. Drawn identically at every graphics quality — like foliage, smoke is concealment, so
 * nobody can see through it by lowering settings.
 */
export class SmokeView {
  readonly group = new THREE.Group();
  private readonly tex = puffTexture();
  private readonly clouds = new Map<
    number,
    { g: THREE.Group; mats: THREE.SpriteMaterial[]; seeds: number[][] }
  >();

  constructor() {
    this.group.name = 'smoke';
  }

  update(dt: number, clouds: readonly SmokeCloud[], time: number): void {
    // Per frame: no garbage (a handful of clouds, so a scan beats building a set).
    for (const [id, v] of this.clouds) {
      let alive = false;
      for (const c of clouds) if (c.id === id) alive = true;
      if (alive) continue;
      this.group.remove(v.g);
      for (const m of v.mats) m.dispose();
      this.clouds.delete(id);
    }
    for (const c of clouds) {
      let v = this.clouds.get(c.id);
      if (!v) {
        const g = new THREE.Group();
        const mats: THREE.SpriteMaterial[] = [];
        const seeds: number[][] = [];
        let s = c.id * 9301 + 49297;
        const rnd = (): number => {
          s = (s * 16807) % 2147483647;
          return s / 2147483647;
        };
        for (let i = 0; i < PUFFS; i++) {
          const m = new THREE.SpriteMaterial({
            map: this.tex,
            color: new THREE.Color().setHSL(0, 0, 0.72 + rnd() * 0.12),
            transparent: true,
            depthWrite: false,
            opacity: 0,
          });
          const sp = new THREE.Sprite(m);
          g.add(sp);
          mats.push(m);
          // Direction in a squashed sphere, distance fraction, size, drift phase.
          const a = rnd() * Math.PI * 2;
          const u = rnd() * 2 - 1;
          const r = Math.cbrt(rnd());
          seeds.push([
            Math.cos(a) * Math.sqrt(1 - u * u),
            u * 0.6,
            Math.sin(a) * Math.sqrt(1 - u * u),
            r,
            0.8 + rnd() * 0.6,
            rnd() * 6.28,
          ]);
        }
        this.group.add(g);
        v = { g, mats, seeds };
        this.clouds.set(c.id, v);
      }
      const { radius, density } = smokeShape(c);
      const ctr = smokeCentre(c);
      v.g.position.set(ctr.x, ctr.y, ctr.z);
      v.g.children.forEach((child, i) => {
        const [dx, dy, dz, r, size, ph] = v.seeds[i]!;
        const drift = Math.sin(time * 0.3 + ph!) * 0.4;
        child.position.set(
          dx! * r! * radius * 0.8 + drift,
          dy! * r! * radius * 0.8,
          dz! * r! * radius * 0.8 - drift,
        );
        const s = radius * 0.75 * size!;
        child.scale.set(s, s, 1);
        v.mats[i]!.opacity = 0.55 * density;
        v.mats[i]!.rotation += dt * 0.05 * (i % 2 ? 1 : -1);
      });
    }
  }
}

/** Jammer pulse: an expanding ring that fades (shows the 25 m reach). */
export class JammerFx {
  readonly group = new THREE.Group();
  /**
   * A fixed pool made up front (warm-up compiles it with everything else) and never disposed:
   * disposing the last ring released its program, so every later pulse compiled it again
   * mid-game. Pulses beyond the pool reuse the oldest ring.
   */
  private readonly pool: { mesh: THREE.Mesh; t: number }[] = [];

  constructor(size = 4) {
    this.group.name = 'jammer-fx';
    const geo = new THREE.RingGeometry(0.92, 1, 64);
    for (let i = 0; i < size; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: '#7fd8ff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({ mesh, t: Infinity });
    }
  }

  pulse(at: { x: number; y: number; z: number }): void {
    // A free ring, else the one furthest along (it was about to vanish anyway).
    const r = this.pool.reduce((a, b) => (b.t > a.t ? b : a));
    r.t = 0;
    r.mesh.position.set(at.x, at.y + 0.3, at.z);
    r.mesh.scale.setScalar(1);
    (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8;
    r.mesh.visible = true;
  }

  update(dt: number): void {
    for (const r of this.pool) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = Math.min(1, r.t / 0.6);
      r.mesh.scale.setScalar(1 + k * (JAMMER.radius - 1));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
      if (r.t >= 0.6) {
        r.mesh.visible = false;
        r.t = Infinity;
      }
    }
  }

  /** Active rings (tests). */
  get active(): number {
    return this.pool.filter((r) => r.mesh.visible).length;
  }
}
