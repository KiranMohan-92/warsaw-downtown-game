import type * as THREE from 'three';
import type { Vec3 } from '@wd/shared';
import type { ShadowGeometryStats } from './geometryStats.ts';

/** F3 overlay: fps, frame-time percentiles, draw calls, and movement state. */
export class PerfOverlay {
  private readonly el: HTMLPreElement;
  visible = false;
  fps = 0;
  private samples: number[] = [];
  private acc = 0;
  private text = '';

  constructor(
    parent: HTMLElement,
    private readonly rendererName = '',
  ) {
    this.el = document.createElement('pre');
    this.el.className = 'perf';
    this.el.dataset.testid = 'perf';
    parent.append(this.el);
    this.setVisible(false);
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  frame(
    dt: number,
    info: THREE.WebGLInfo,
    simSteps: number,
    quality: string,
    s: { pos: Vec3; speed: number; grounded: boolean; crouched: boolean; sprinting: boolean },
    shadow: ShadowGeometryStats,
  ): void {
    if (dt <= 0) return;
    this.samples.push(dt * 1000);
    this.acc += dt;
    if (this.acc < 0.5) return;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const avg = sorted.reduce((x, y) => x + y, 0) / sorted.length;
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? avg;
    this.fps = 1000 / avg;
    this.samples = [];
    this.acc = 0;
    if (!this.visible) return;
    const state = [
      s.grounded ? 'ground' : 'air',
      s.crouched ? 'crouch' : '',
      s.sprinting ? 'sprint' : '',
    ]
      .filter(Boolean)
      .join(' ');
    this.text =
      `${this.fps.toFixed(0)} fps   ${avg.toFixed(2)} ms avg   ${p99.toFixed(2)} ms p99\n` +
      `GPU ${this.rendererName || 'unknown'}\n` +
      `draw calls ${info.render.calls}   tris ${(info.render.triangles / 1000).toFixed(1)}k   sim steps/frame ${simSteps}   quality ${quality}\n` +
      `shadow ${shadow.calls} draws / ${(shadow.triangles / 1000).toFixed(1)}k tris   scene+post ${info.render.calls - shadow.calls} draws / ${((info.render.triangles - shadow.triangles) / 1000).toFixed(1)}k tris   programs ${info.programs?.length ?? 0}\n` +
      `pos ${s.pos.x.toFixed(2)} ${s.pos.y.toFixed(2)} ${s.pos.z.toFixed(2)}   speed ${s.speed.toFixed(2)} m/s   ${state}`;
    this.el.textContent = this.text;
  }
}
