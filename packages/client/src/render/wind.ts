import * as THREE from 'three';
import { clampPointSize } from './debris.ts';

/**
 * One gust signal for everything the wind moves — the wind sound, foliage sway and blowing dust —
 * so what you hear swells with what you see. Presentation only (never the sim); `Math.random` is
 * fine here.
 */
export class WindGusts {
  /** 0 = lull, 1 = strongest gust. */
  value = 0;
  private target = 0;
  private timer = 0;

  constructor(private readonly rnd: () => number = Math.random) {}

  update(dt: number): number {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.target = this.rnd() * this.rnd(); // mostly gentle, now and then a strong gust
      this.timer = 2 + this.rnd() * 5;
    }
    this.value += (this.target - this.value) * Math.min(1, dt * 0.6);
    return this.value;
  }
}

const MOTES = 72;
const BOX = 18; // metres around the camera the motes live in (wrap-around)

/**
 * Blowing dust and leaf bits drifting past the camera: one pooled `THREE.Points` draw (72
 * particles). Count scales with wind strength; none in rain (wet ground doesn't blow).
 */
export class WindMotes {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(MOTES * 3);
  private readonly col = new Float32Array(MOTES * 4);
  private readonly phase = new Float32Array(MOTES);

  constructor(private readonly rnd: () => number = Math.random) {
    for (let i = 0; i < MOTES; i++) {
      this.pos[i * 3] = (rnd() - 0.5) * BOX;
      this.pos[i * 3 + 1] = rnd() * 4;
      this.pos[i * 3 + 2] = (rnd() - 0.5) * BOX;
      this.phase[i] = rnd() * Math.PI * 2;
      const leaf = rnd() < 0.3;
      this.col.set(leaf ? [0.36, 0.33, 0.18, 0] : [0.72, 0.68, 0.6, 0], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      'color',
      new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.05,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
      }),
    );
    clampPointSize(this.points.material as THREE.PointsMaterial);
    this.points.name = 'fx:windMotes';
    this.points.frustumCulled = false;
  }

  /**
   * `strength` 0..1 (weather wind × gust), `rain` 0..1. `centre` = camera position. Wind blows
   * along +X with a slow sway; motes wrap within a box around the camera.
   */
  update(dt: number, centre: THREE.Vector3, strength: number, rain: number, time: number): void {
    const active = Math.max(0, strength - 0.12) * (1 - Math.min(1, rain * 2));
    const speed = 1 + strength * 6;
    for (let i = 0; i < MOTES; i++) {
      const o = i * 3;
      const ph = this.phase[i]!;
      this.pos[o] = this.pos[o]! + speed * dt;
      this.pos[o + 1] = this.pos[o + 1]! + Math.sin(time * 1.7 + ph) * 0.35 * dt - 0.05 * dt;
      this.pos[o + 2] = this.pos[o + 2]! + Math.cos(time * 0.9 + ph) * 0.6 * dt;
      // Wrap into the box around the camera.
      for (const [k, c, lo, hi] of [
        [o, centre.x, -BOX / 2, BOX / 2],
        [o + 2, centre.z, -BOX / 2, BOX / 2],
        [o + 1, centre.y, -1.5, 3],
      ] as const) {
        let v = this.pos[k]! - c;
        const span = hi - lo;
        if (v < lo) v += span * Math.ceil((lo - v) / span);
        if (v > hi) v -= span * Math.ceil((v - hi) / span);
        this.pos[k] = c + v;
      }
      // Fewer, fainter motes in calm air: each mote has its own threshold.
      const visible = active > (i / MOTES) * 0.75 ? Math.min(1, active * 1.6) : 0;
      this.col[i * 4 + 3] = visible * 0.7;
    }
    const geo = this.points.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('color').needsUpdate = true;
  }
}
