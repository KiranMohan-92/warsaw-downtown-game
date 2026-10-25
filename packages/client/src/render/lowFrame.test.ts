import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { LowFrame, casDisplay } from './lowFrame.ts';

type Rgb = readonly [number, number, number];
const grey = (v: number): Rgb => [v, v, v];

describe('Low frame target', () => {
  it('keeps Low programs: an XR-flagged sRGB target stored as plain RGBA8, 4× MSAA, colour-only resolve', () => {
    const f = new LowFrame();
    const t = f.target;
    // three tone-maps and uses the texture colour space as the output space only for the canvas
    // or an XR target (WebGLPrograms / WebGLRenderer): the Low programs stay the canvas ones.
    expect((t as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget).toBe(true);
    expect(t.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    // Without the forced format the texture would be SRGB8_ALPHA8 while the XR renderbuffer is
    // RGBA8, and the multisample resolve between them is invalid.
    expect(t.texture.internalFormat).toBe('RGBA8');
    expect(t.samples).toBe(4);
    expect(t.resolveDepthBuffer).toBe(false);
    expect(t.texture.generateMipmaps).toBe(false);
    expect(t.texture.minFilter).toBe(THREE.NearestFilter);
  });

  it('suppresses three’s resolve inside drawWithoutResolve and rebinds the MSAA target after a shadow pass', () => {
    const f = new LowFrame();
    const samplesSeen: number[] = [];
    const bound: number[] = [];
    const shadowRender = vi.fn();
    const renderer = {
      shadowMap: { render: shadowRender },
      setRenderTarget: vi.fn(() => bound.push(f.target.samples)),
    };
    const original = renderer.shadowMap.render;
    f.drawWithoutResolve(renderer as unknown as THREE.WebGLRenderer, () => {
      samplesSeen.push(f.target.samples);
      renderer.shadowMap.render([], new THREE.Scene(), new THREE.PerspectiveCamera());
      samplesSeen.push(f.target.samples);
    });
    expect(samplesSeen).toEqual([0, 0]);
    expect(shadowRender).toHaveBeenCalledTimes(1);
    // The shadow pass's own rebind would pick the single-sampled framebuffer: rebound with 4.
    expect(bound).toEqual([4]);
    expect(f.target.samples).toBe(4);
    expect(renderer.shadowMap.render).toBe(original);
  });

  it('restores state when the draw throws', () => {
    const f = new LowFrame();
    const renderer = { shadowMap: { render: vi.fn() }, setRenderTarget: vi.fn() };
    const original = renderer.shadowMap.render;
    expect(() =>
      f.drawWithoutResolve(renderer as unknown as THREE.WebGLRenderer, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(f.target.samples).toBe(4);
    expect(renderer.shadowMap.render).toBe(original);
  });

  it('presents with a plain copy at 100 % and CAS below it', () => {
    const f = new LowFrame();
    const used: string[] = [];
    const renderer = {
      setRenderTarget: vi.fn(),
      render: vi.fn((scene: THREE.Scene) => {
        const m = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
        used.push(
          m.fragmentShader.includes('strength') ? `cas ${m.uniforms.strength!.value}` : 'copy',
        );
      }),
    };
    f.present(renderer as unknown as THREE.WebGLRenderer);
    f.strength = 0.6;
    f.present(renderer as unknown as THREE.WebGLRenderer);
    expect(used).toEqual(['copy', 'cas 0.6']);
    expect(renderer.setRenderTarget).toHaveBeenCalledWith(null);
  });
});

describe('Low CAS maths (mirrors the shader)', () => {
  it('is the identity at strength 0 and on flat areas', () => {
    const c: Rgb = [0.3, 0.5, 0.2];
    expect(casDisplay(c, grey(0.9), grey(0.1), grey(0.5), grey(0.2), 0)).toEqual(c);
    const flat = casDisplay(grey(0.42), grey(0.42), grey(0.42), grey(0.42), grey(0.42), 1);
    for (const v of flat) expect(v).toBeCloseTo(0.42, 12);
  });

  it('steepens a soft edge, moving all channels by the same luma change (no colour fringes)', () => {
    const c: Rgb = [0.3, 0.25, 0.2];
    const out = casDisplay(c, c, c, grey(0.35), grey(0.2), 1);
    const d = out.map((v, i) => v - c[i]!);
    expect(d[0]).toBeCloseTo(d[1]!, 12);
    expect(d[1]).toBeCloseTo(d[2]!, 12);
    expect(d[0]).toBeLessThan(0); // the darker side of the edge gets darker
    const soft = casDisplay(c, c, c, grey(0.35), grey(0.2), 0.5);
    expect(soft[0]).toBeGreaterThan(out[0]); // weaker at lower strength
    expect(soft[0]).toBeLessThan(c[0]);
  });

  it('never pushes luma outside its neighbourhood (no halos) and stays finite', () => {
    const y = (v: Rgb): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    for (const px of [
      [grey(0.05), grey(0.05), grey(0.05), grey(1), grey(0.05)],
      [grey(1), grey(1), grey(0), grey(1), grey(1)],
      [grey(0), grey(1), grey(0), grey(1), grey(0)],
      [[0.9, 0.1, 0.1], grey(0.5), grey(0.2), [0.1, 0.9, 0.1], grey(0)],
    ] as Rgb[][]) {
      const [c, n, s, e, w] = px as [Rgb, Rgb, Rgb, Rgb, Rgb];
      const out = casDisplay(c, n, s, e, w, 1);
      const ls = px.map(y);
      expect(y(out)).toBeGreaterThanOrEqual(Math.min(...ls) - 1e-9);
      expect(y(out)).toBeLessThanOrEqual(Math.max(...ls) + 1e-9);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
