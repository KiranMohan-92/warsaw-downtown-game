import { RADAR } from '@wd/shared';

export interface RadarBlip {
  x: number;
  z: number;
}

export interface RadarUplink {
  x: number;
  z: number;
  /** 0 = ready, otherwise seconds until recharged. */
  cooldown: number;
  /** Radar uplink (◆, a radar charge) or drone uplink (▲, a recon-drone charge). */
  kind: 'radar' | 'drone';
}

export interface RadarFrame {
  self: { x: number; z: number; yaw: number };
  /** Everyone else — drawn only while the radar is live. */
  others: readonly RadarBlip[];
  uplinks: readonly RadarUplink[];
  /** Seconds of live radar left (0 = off). */
  live: number;
  /** What the radar may show: everyone (called in), drone-spotted players, nothing, or static. */
  view: 'live' | 'spotted' | 'dark' | 'jammed';
  /** Stored radar charges (call in with `callKey`). */
  charges: number;
  callKey: string;
  /** Playable bounds (drawn as the map edge). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/**
 * Circular radar, top-left. Heading-up (rotates with you). Always shows you, the map edge and the
 * radar uplinks (ready = bright, recharging = dim with a ring); while radar is live (collected
 * from an uplink) it also shows everyone else, with a sweep and a countdown.
 */
export class Radar {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLDivElement;
  private sweep = 0;
  private readonly size = 176;

  constructor(parent: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.className = 'radar';
    wrap.dataset.testid = 'radar';
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.label = document.createElement('div');
    this.label.className = 'radar-label';
    wrap.append(this.canvas, this.label);
    parent.append(wrap);
  }

  update(dt: number, f: RadarFrame): void {
    const g = this.ctx;
    const S = this.size;
    const R = S / 2 - 4;
    const scale = R / RADAR.range;
    const cx = S / 2;
    const cy = S / 2;
    this.sweep = (this.sweep + dt * Math.PI * 1.6) % (Math.PI * 2);
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = f.live > 0 ? 'rgba(8, 30, 26, 0.74)' : 'rgba(4, 16, 22, 0.66)';
    g.fill();
    g.clip();
    // World → radar: heading-up. Forward (yaw) is screen-up.
    const cos = Math.cos(f.self.yaw);
    const sin = Math.sin(f.self.yaw);
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = x - f.self.x;
      const dz = z - f.self.z;
      // Rotate so the view direction (−sin yaw, −cos yaw) points up.
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return [cx + rx * scale, cy + rz * scale];
    };
    // Range rings.
    g.strokeStyle = 'rgba(57, 224, 255, 0.16)';
    g.lineWidth = 1;
    for (const k of [0.33, 0.66]) {
      g.beginPath();
      g.arc(cx, cy, R * k, 0, Math.PI * 2);
      g.stroke();
    }
    // Map edge.
    const b = f.bounds;
    g.strokeStyle = 'rgba(255, 200, 120, 0.55)';
    g.lineWidth = 1.5;
    g.beginPath();
    const corners: [number, number][] = [
      [b.minX, b.minZ],
      [b.maxX, b.minZ],
      [b.maxX, b.maxZ],
      [b.minX, b.maxZ],
    ];
    corners.forEach(([x, z], i) => {
      const [sx, sy] = toScreen(x, z);
      if (i === 0) g.moveTo(sx, sy);
      else g.lineTo(sx, sy);
    });
    g.closePath();
    g.stroke();
    // Live sweep.
    if (f.live > 0) {
      const grad = g.createConicGradient(this.sweep - Math.PI / 2, cx, cy);
      grad.addColorStop(0, 'rgba(90, 255, 190, 0.35)');
      grad.addColorStop(0.12, 'rgba(90, 255, 190, 0)');
      grad.addColorStop(1, 'rgba(90, 255, 190, 0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
    }
    g.restore();

    // Uplinks (clamped to the rim when out of range, so you know where to go).
    for (const u of f.uplinks) {
      let [sx, sy] = toScreen(u.x, u.z);
      const dx = sx - cx;
      const dy = sy - cy;
      const d = Math.hypot(dx, dy);
      const edge = d > R - 7;
      if (edge) {
        sx = cx + (dx / d) * (R - 7);
        sy = cy + (dy / d) * (R - 7);
      }
      const ready = u.cooldown <= 0;
      const drone = u.kind === 'drone';
      const s = edge ? 4 : 5.5;
      g.save();
      g.translate(sx, sy);
      if (drone) {
        // Drone uplink: green triangle (the drone-feed colour).
        g.fillStyle = ready ? 'rgba(141, 255, 207, 0.95)' : 'rgba(100, 170, 140, 0.4)';
        g.beginPath();
        g.moveTo(0, -s * 1.3);
        g.lineTo(s * 1.2, s);
        g.lineTo(-s * 1.2, s);
        g.closePath();
        g.fill();
      } else {
        // Radar uplink: cyan diamond.
        g.rotate(Math.PI / 4);
        g.fillStyle = ready ? 'rgba(80, 220, 255, 0.95)' : 'rgba(80, 150, 180, 0.4)';
        g.fillRect(-s, -s, s * 2, s * 2);
      }
      g.restore();
      if (!ready) {
        const frac = 1 - u.cooldown / RADAR.respawn;
        g.strokeStyle = drone ? 'rgba(141, 255, 207, 0.8)' : 'rgba(80, 220, 255, 0.8)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(sx, sy, 8, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        g.stroke();
      }
    }
    // Jammed: static over everything, no blips.
    if (f.view === 'jammed') {
      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();
      for (let i = 0; i < 260; i++) {
        const v = Math.floor(Math.random() * 200);
        g.fillStyle = `rgba(${v},${v},${v},0.5)`;
        g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
      }
      g.restore();
    }
    // Opponents: everyone while a called-in radar is live, only spotted ones from the drone.
    if (f.view === 'live' || f.view === 'spotted') {
      g.fillStyle = f.view === 'live' ? '#ff4a4a' : '#ff9a3a';
      for (const o of f.others) {
        let [sx, sy] = toScreen(o.x, o.z);
        const dx = sx - cx;
        const dy = sy - cy;
        const d = Math.hypot(dx, dy);
        // An uplink reveals everyone: out-of-range players are pinned to the rim (smaller).
        const far = d > R - 5;
        if (far) {
          sx = cx + (dx / d) * (R - 5);
          sy = cy + (dy / d) * (R - 5);
        }
        g.beginPath();
        g.arc(sx, sy, far ? 3 : 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Self: arrow pointing up.
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(cx, cy - 7);
    g.lineTo(cx + 5, cy + 5);
    g.lineTo(cx, cy + 2);
    g.lineTo(cx - 5, cy + 5);
    g.closePath();
    g.fill();
    // Rim: thin accent ring with bearing ticks (every 30°, long at the cardinals) and a
    // forward notch, matching the HUD's visor lines.
    const rim = f.live > 0 ? '90, 255, 190' : '57, 224, 255';
    g.strokeStyle = `rgba(${rim}, ${f.live > 0 ? 0.9 : 0.6})`;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = `rgba(${rim}, 0.5)`;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const len = i % 3 === 0 ? 7 : 4;
      const s = Math.sin(a);
      const c = Math.cos(a);
      g.moveTo(cx + s * R, cy - c * R);
      g.lineTo(cx + s * (R - len), cy - c * (R - len));
    }
    g.stroke();
    g.fillStyle = `rgba(${rim}, 0.95)`;
    g.beginPath();
    g.moveTo(cx, cy - R + 1);
    g.lineTo(cx - 4, cy - R - 3);
    g.lineTo(cx + 4, cy - R - 3);
    g.closePath();
    g.fill();

    this.label.textContent =
      f.view === 'jammed'
        ? 'RADAR JAMMED'
        : f.live > 0
          ? `RADAR LIVE ${Math.ceil(f.live)}s`
          : f.charges > 0
            ? `RADAR READY — press ${f.callKey}`
            : f.uplinks.some((u) => u.kind === 'radar')
              ? 'Uplinks: ◆ radar charge · ▲ drone charge'
              : f.uplinks.length
                ? 'Find an uplink ▲ for a drone charge'
                : '';
    this.label.classList.toggle('live', f.live > 0);
    this.label.classList.toggle('ready', f.live <= 0 && f.charges > 0);
  }

  setVisible(v: boolean): void {
    (this.canvas.parentElement as HTMLElement).style.display = v ? '' : 'none';
  }
}
