import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FLASH_TEX,
  FLASH_UV,
  flashIntensity,
  kickFlash,
  muzzleFlash,
  muzzleFlashTexels,
} from './viewmodelModels.ts';

/** Red channel mip chain of the flash texture (2×2 box filter, floor sizes like WebGL). */
function mips(): { w: number; h: number; r: Float64Array }[] {
  const t = muzzleFlashTexels();
  let w: number = FLASH_TEX.w;
  let h: number = FLASH_TEX.h;
  let r = Float64Array.from({ length: w * h }, (_, i) => t[i * 4]! / 255);
  const out = [{ w, h, r }];
  while (w > 1 && h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const n = new Float64Array(nw * nh);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const sx = Math.round((x * w) / nw);
        const sy = Math.round((y * h) / nh);
        const at = (xx: number, yy: number): number =>
          r[Math.min(h - 1, yy) * w + Math.min(w - 1, xx)]!;
        n[y * nw + x] = (at(sx, sy) + at(sx + 1, sy) + at(sx, sy + 1) + at(sx + 1, sy + 1)) / 4;
      }
    w = nw;
    h = nh;
    r = n;
    out.push({ w, h, r });
  }
  return out;
}

/** Bilinear sample (clamp to edge) of one level at uv. */
function bilinear(l: { w: number; h: number; r: Float64Array }, u: number, v: number): number {
  const x = u * l.w - 0.5;
  const y = v * l.h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number): number =>
    l.r[Math.min(l.h - 1, Math.max(0, yy)) * l.w + Math.min(l.w - 1, Math.max(0, xx))]!;
  return (
    (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
    (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  );
}

describe('muzzle flash', () => {
  it('star: hot core, five petals, nothing outside the disc', () => {
    expect(flashIntensity('star', 0.5, 0.5)).toBeCloseTo(1, 2);
    expect(flashIntensity('star', 0.02, 0.02)).toBe(0);
    expect(flashIntensity('star', 1, 0.5)).toBe(0);
    // Round a ring at r = 0.5: five bright petals, dark between them.
    const ring = Array.from({ length: 360 }, (_, d) => {
      const a = (d * Math.PI) / 180;
      return flashIntensity('star', 0.5 + 0.25 * Math.cos(a), 0.5 + 0.25 * Math.sin(a));
    });
    let peaks = 0;
    for (let i = 0; i < 360; i++) {
      const p = ring[(i + 359) % 360]!;
      const n = ring[(i + 1) % 360]!;
      if (ring[i]! > p && ring[i]! >= n && ring[i]! > 0.3) peaks++;
    }
    expect(peaks).toBe(5);
    expect(Math.min(...ring)).toBeLessThan(0.2);
  });

  it('plume: brightest near the muzzle on its axis, fading to the tip and the edges', () => {
    const near = flashIntensity('plume', 0.15, 0.5);
    const far = flashIntensity('plume', 0.85, 0.5);
    expect(near).toBeGreaterThan(0.6);
    expect(far).toBeLessThan(near * 0.3);
    expect(flashIntensity('plume', 0.15, 0.02)).toBe(0);
    expect(flashIntensity('plume', 1, 0.5)).toBe(0);
  });

  it('is one additive, front-sided, textured mesh at the muzzle along −Z', () => {
    const m = muzzleFlash(-0.5, 0.06, 0.2);
    const mat = m.material as THREE.MeshBasicMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.side).toBe(THREE.FrontSide);
    expect(mat.map).not.toBeNull();
    expect(mat.depthWrite).toBe(false);
    expect(m.visible).toBe(false);
    expect(m.position.toArray()).toEqual([0, 0.06, -0.5]);
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!;
    expect(b.min.z).toBeLessThan(-0.3); // plume reaches out along the bore
    expect(b.max.z).toBeLessThan(0.05); // never back over the barrel
    // Every quad is doubled with reversed winding: 3 quads × 2 sides × 2 triangles.
    expect(m.geometry.getAttribute('position').count).toBe(3 * 2 * 6);
    // Shared texture between guns.
    expect((muzzleFlash(-0.3, 0, 0.1).material as THREE.MeshBasicMaterial).map).toBe(mat.map);
  });

  it('the star never samples the plume across the gutter (mip 0..4, its whole edge)', () => {
    const chain = mips();
    for (let level = 0; level <= 4; level++) {
      for (let k = 0; k <= 32; k++) {
        const v = k / 32;
        // The star's edge column and the plume's base column at the same v.
        const edge = bilinear(chain[level]!, FLASH_UV.star[1], v);
        expect(edge, `mip ${level} v ${v}`).toBeLessThan(4 / 255);
      }
    }
    // And the plume's base is bright (what used to bleed in).
    expect(bilinear(chain[0]!, FLASH_UV.plume[0] + 0.5 / FLASH_TEX.w, 0.5)).toBeGreaterThan(0.5);
  });

  it('kickFlash shows it with a random roll about the bore and size', () => {
    const m = muzzleFlash(-0.5, 0, 0.2);
    let i = 0;
    const seq = [0.5, 0, 1];
    kickFlash(m, () => seq[i++]!);
    expect(m.visible).toBe(true);
    expect(m.rotation.x).toBe(0);
    expect(m.rotation.y).toBe(0);
    expect(m.rotation.z).toBeCloseTo(Math.PI);
    expect(m.scale.x).toBeCloseTo(0.75);
    expect(m.scale.z).toBeCloseTo(0.75 * 1.35);
  });
});
