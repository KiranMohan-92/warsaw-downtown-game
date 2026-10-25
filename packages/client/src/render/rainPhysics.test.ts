import { describe, expect, it } from 'vitest';
import {
  DROP_MAX_MM,
  DROP_MIN_MM,
  STORM_RAIN_RATE,
  WetnessRamp,
  marshallPalmerLambda,
  mulberry32,
  puddleFill,
  rainWindSpeed,
  sampleDropDiameter,
  STREAK_ALPHA_CAP,
  STREAK_EXPOSURE,
  STREAK_MAX_WIDTH,
  rasterCoverage,
  streakFootprint,
  streakKernel,
  streakLeadPx,
  terminalVelocity,
} from './rainPhysics.ts';

describe('drop physics', () => {
  it('falls at the measured terminal velocity: ~4 m/s at 1 mm to ~9 m/s at 4 mm', () => {
    expect(terminalVelocity(1)).toBeCloseTo(4.0, 1);
    expect(terminalVelocity(2)).toBeCloseTo(6.55, 1);
    expect(terminalVelocity(4)).toBeGreaterThan(8.5);
    expect(terminalVelocity(4)).toBeLessThan(9.2);
    // Monotonic, saturating below 9.65 m/s, never negative.
    for (let d = 0.2; d < 6; d += 0.2) {
      expect(terminalVelocity(d + 0.2)).toBeGreaterThan(terminalVelocity(d));
      expect(terminalVelocity(d)).toBeLessThan(9.65);
    }
    expect(terminalVelocity(0)).toBe(0);
  });

  it('draws sizes from the area-weighted Marshall–Palmer spectrum within the break-up limits', () => {
    const rnd = mulberry32(7);
    const n = 20000;
    const ds = Array.from({ length: n }, () => sampleDropDiameter(rnd));
    for (const d of ds) {
      expect(d).toBeGreaterThanOrEqual(DROP_MIN_MM);
      expect(d).toBeLessThanOrEqual(DROP_MAX_MM);
    }
    const lambda = marshallPalmerLambda(STORM_RAIN_RATE);
    const mean = ds.reduce((a, b) => a + b, 0) / n;
    // Gamma(3, Λ) has mean 3/Λ (~1.44 mm at 25 mm/h); truncation moves it a little.
    expect(mean).toBeGreaterThan(0.85 * (3 / lambda));
    expect(mean).toBeLessThan(1.15 * (3 / lambda));
    // Mode near 2/Λ, a long tail of big drops: more 1–1.5 mm drops than 3–3.5 mm ones.
    const between = (a: number, b: number): number => ds.filter((d) => d >= a && d < b).length;
    expect(between(1, 1.5)).toBeGreaterThan(3 * between(3, 3.5));
    expect(between(3, 3.5)).toBeGreaterThan(between(4, 4.5));
    // So the drawn fall speeds span the 4–9 m/s a storm shows.
    const vs = ds.map(terminalVelocity).sort((a, b) => a - b);
    expect(vs[Math.floor(n * 0.1)]!).toBeGreaterThan(2.5);
    expect(vs[Math.floor(n * 0.5)]!).toBeGreaterThan(4);
    expect(vs[Math.floor(n * 0.98)]!).toBeGreaterThan(8);
  });

  it('heavier rain has bigger drops (smaller slope)', () => {
    expect(marshallPalmerLambda(50)).toBeLessThan(marshallPalmerLambda(5));
    expect(marshallPalmerLambda(1)).toBeCloseTo(4.1, 5);
  });

  it('drifts with the wind: a breeze when calm, storm speeds in a gust', () => {
    expect(rainWindSpeed(0, 0)).toBeLessThan(1);
    expect(rainWindSpeed(1, 0)).toBeLessThan(rainWindSpeed(1, 1));
    expect(rainWindSpeed(1, 1)).toBeGreaterThan(5);
    expect(rainWindSpeed(1, 1)).toBeLessThan(8);
  });
});

describe('streak visibility (tier parity, the shader path)', () => {
  // proj[1][1] for a horizontal FOV at 16:9 (the game's FOV is horizontal, Hor+).
  const proj11 = (hfovDeg: number): number =>
    1 / Math.tan(Math.atan(Math.tan(((hfovDeg / 2) * Math.PI) / 180) * (9 / 16)));
  const at = (scale: number, dMm: number, z: number, len100: number, hfov: number) => {
    const w = 1600 * scale;
    const h = 900 * scale;
    const f = streakFootprint({
      dMm,
      z,
      lengthPx: len100 * scale,
      viewportW: w,
      viewportH: h,
      proj11: proj11(hfov),
    });
    return { f, share: rasterCoverage(f) / (w * h) };
  };
  const CASES = [
    [2, 2, 120, 80], // the reviewed case: 2 mm drop at 2 m, 80° FOV
    [2, 2, 120, 60],
    [1.4, 10, 40, 80], // mid-distance, sub-pixel at 50 %
    [1, 18, 25, 80], // far, sub-pixel everywhere
    [4, 0.8, 200, 80], // near, defocused, past the alpha cap
    [3, 0.6, 30, 60], // near and slow: past the cap, drawn longer
  ] as const;

  it('conceals the same screen share at 100 %, 75 %, 60 % and 50 % render scale', () => {
    for (const [dMm, z, len, fov] of CASES) {
      const ref = at(1, dMm, z, len, fov);
      expect(ref.share).toBeGreaterThan(0);
      for (const s of [0.75, 0.6, 0.5]) {
        const r = at(s, dMm, z, len, fov).share / ref.share;
        expect(r, `${dMm} mm @ ${z} m, ${fov}°, scale ${s}`).toBeGreaterThan(0.95);
        expect(r, `${dMm} mm @ ${z} m, ${fov}°, scale ${s}`).toBeLessThan(1.05);
      }
    }
  });

  it('carries coverage over at the length cap (Codex: 3 mm @ 6 m, 80°, 1600×900 lost 21 % at 50 %)', () => {
    // Physical motion length at 100 %, and the long smear a fast turn adds.
    const f11 = proj11(80) * 0.5 * 900;
    const phys = (terminalVelocity(3) * STREAK_EXPOSURE * f11) / 6;
    for (const len of [phys, 3 * phys, 400]) {
      const ref = at(1, 3, 6, len, 80);
      for (const s of [0.75, 0.6, 0.5]) {
        const r = at(s, 3, 6, len, 80).share / ref.share;
        expect(r, `len ${len.toFixed(0)} px, scale ${s}`).toBeGreaterThan(0.95);
        expect(r, `len ${len.toFixed(0)} px, scale ${s}`).toBeLessThan(1.05);
      }
    }
  });

  it('parity sweep: 0.5–5 mm × 0.5–40 m × 100/75/60/50 %, physical and smeared lengths', () => {
    let worst = 1;
    let where = '';
    for (const dMm of [0.5, 1, 1.5, 2, 3, 4, 5])
      for (const z of [0.5, 0.8, 1.2, 2, 3, 4, 6, 10, 15, 25, 40])
        for (const fov of [60, 80, 100]) {
          const f11 = proj11(fov) * 0.5 * 900;
          const phys = (terminalVelocity(dMm) * STREAK_EXPOSURE * f11) / z;
          for (const len of [0, phys, 4 * phys + 20]) {
            const ref = at(1, dMm, z, len, fov);
            if (ref.f.culled) continue;
            for (const s of [0.75, 0.6, 0.5]) {
              const r = at(s, dMm, z, len, fov).share / ref.share;
              const dev = Math.max(r, 1 / r);
              if (dev > worst) {
                worst = dev;
                where = `${dMm} mm @ ${z} m, ${fov}°, len ${len.toFixed(1)}, scale ${s}: ${r.toFixed(3)}`;
              }
            }
          }
        }
    expect(worst, where).toBeLessThan(1.05);
  });

  it('never reaches more than ~1 px ahead of the drop (Codex: 3 mm @ 3 m leaked 6 px under a canopy)', () => {
    const f11 = proj11(80) * 0.5 * 900;
    for (const s of [1, 0.75, 0.5]) {
      const phys = (terminalVelocity(3) * STREAK_EXPOSURE * f11) / 3;
      const { f } = at(s, 3, 3, phys, 80);
      // The old placement led by width / 2 + ramp / 2: several px past a shelter edge.
      expect(f.width * 0.5 + f.ramp * 0.5).toBeGreaterThan(5 * s);
      expect(streakLeadPx(f)).toBeLessThanOrEqual(1);
    }
    for (const dMm of [0.5, 2, 5])
      for (const z of [0.5, 2, 10, 40]) {
        const { f } = at(1, dMm, z, 300, 80);
        expect(streakLeadPx(f), `${dMm} mm @ ${z} m`).toBeLessThanOrEqual(
          (STREAK_MAX_WIDTH * 900) / 720 / 2,
        );
      }
  });

  it('rasterises exactly the coverage it was given (kernel integrates to width × (length + width))', () => {
    for (const [width, length] of [
      [1, 3],
      [1, 40],
      [2.6, 70],
      [3, 12],
    ] as const) {
      const ramp = Math.max(1, (1 / 3) * (length + width));
      const f = {
        width,
        length,
        ramp,
        alpha: 0.2,
        coverage: 0.2 * width * (length + width),
        culled: false,
      };
      expect(rasterCoverage(f) / f.coverage).toBeCloseTo(1, 1);
    }
  });

  it('keeps streaks thin, tapered and under the opacity cap; near drops go longer, then at most maxW wide', () => {
    for (const [dMm, z, len, fov] of CASES) {
      const { f } = at(1, dMm, z, len, fov);
      expect(f.width).toBeLessThanOrEqual((STREAK_MAX_WIDTH * 900) / 720);
      expect(f.alpha).toBeLessThanOrEqual(STREAK_ALPHA_CAP + 1e-9);
      // Each end tapers over at least 20 % of the drawn streak.
      expect(f.ramp / (f.length + f.width + f.ramp)).toBeGreaterThanOrEqual(0.2);
      // The peak pixel (plateau) never exceeds the cap.
      let peak = 0;
      const total = f.length + f.width + f.ramp;
      for (let u = -2; u <= 2; u += 0.05)
        for (let a = 0; a <= total; a += 0.5)
          peak = Math.max(peak, f.alpha * streakKernel(u, a, f));
      expect(peak).toBeLessThanOrEqual(STREAK_ALPHA_CAP + 1e-9);
    }
    const near = at(1, 4, 0.8, 30, 80).f;
    expect(near.width).toBeCloseTo((STREAK_MAX_WIDTH * 900) / 720, 6);
    expect(near.length).toBeGreaterThan(30); // its coverage spent on length
  });

  it('defocus spreads a drop out: wider (to the cap) and fainter, never brighter', () => {
    const base = { dMm: 2, lengthPx: 40, viewportW: 1600, viewportH: 900, proj11: 1.7 };
    const far = streakFootprint({ ...base, z: 14 });
    const long = streakFootprint({ ...base, z: 14, lengthPx: 120 });
    expect(long.alpha).toBeLessThan(far.alpha);
    expect(far.width).toBe(1); // sub-pixel: drawn one pixel wide, not lost
  });
});

describe('wetness ramp', () => {
  it('starts at the first value (a storm in progress), then wets fast and dries slowly', () => {
    const w = new WetnessRamp();
    w.set(1);
    expect(w.update(0)).toBe(1);
    w.set(0);
    for (let t = 0; t < 30; t++) w.update(1);
    const dryingAfter30 = w.value;
    expect(dryingAfter30).toBeGreaterThan(0.4); // still damp after half a minute
    const r = new WetnessRamp();
    r.set(0);
    r.set(1);
    for (let t = 0; t < 10; t++) r.update(1);
    expect(r.value).toBeGreaterThan(0.6); // soaked within ~10 s
    expect(r.value).toBeLessThan(1);
    for (let t = 0; t < 120; t++) r.update(1);
    expect(r.value).toBe(1);
  });

  it('is frame-rate independent', () => {
    const a = new WetnessRamp();
    const b = new WetnessRamp();
    a.set(0);
    b.set(0);
    a.set(1);
    b.set(1);
    for (let i = 0; i < 60 * 5; i++) a.update(1 / 60);
    for (let i = 0; i < 20 * 5; i++) b.update(1 / 20);
    expect(a.value).toBeCloseTo(b.value, 6);
  });

  it('fills puddles only once the ground is saturated', () => {
    expect(puddleFill(0)).toBe(0);
    expect(puddleFill(0.4)).toBe(0);
    expect(puddleFill(0.7)).toBeGreaterThan(0.3);
    expect(puddleFill(1)).toBe(1);
  });
});
