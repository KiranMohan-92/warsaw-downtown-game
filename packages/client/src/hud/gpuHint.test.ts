import { describe, expect, it } from 'vitest';
import { GPU_HINT_AFTER_SEC, isIntegratedGpu, shouldShowGpuHint } from './gpuHint.ts';

describe('isIntegratedGpu', () => {
  it('recognises integrated Intel and AMD APU renderer strings', () => {
    for (const r of [
      'ANGLE (Intel, Intel(R) UHD Graphics (0x00009BC4) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, Radeon Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ]) {
      expect(isIntegratedGpu(r), r).toBe(true);
    }
  });

  it('rejects discrete, Apple, software and unknown renderers', () => {
    for (const r of [
      'ANGLE (NVIDIA, NVIDIA Quadro T2000 with Max-Q Design Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon Pro W6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
      'WebKit WebGL',
      '',
    ]) {
      expect(isIntegratedGpu(r), r).toBe(false);
    }
  });
});

describe('shouldShowGpuHint', () => {
  const s = {
    integrated: true,
    windows: true,
    auto: true,
    fps: 38,
    resolutionScale: 1,
    playedSec: GPU_HINT_AFTER_SEC + 1,
    dismissed: false,
  };
  it('shows once Auto has settled low on an integrated GPU (fps or internal resolution)', () => {
    expect(shouldShowGpuHint(s)).toBe(true);
    expect(shouldShowGpuHint({ ...s, fps: 58, resolutionScale: 0.65 })).toBe(true);
    expect(shouldShowGpuHint({ ...s, fps: 58, resolutionScale: 0.85 })).toBe(false);
  });
  it('never before Auto settles, off Auto, off Windows, on a discrete GPU, or once dismissed', () => {
    expect(shouldShowGpuHint({ ...s, playedSec: 5 })).toBe(false);
    expect(shouldShowGpuHint({ ...s, auto: false })).toBe(false);
    expect(shouldShowGpuHint({ ...s, windows: false })).toBe(false);
    expect(shouldShowGpuHint({ ...s, integrated: false })).toBe(false);
    expect(shouldShowGpuHint({ ...s, dismissed: true })).toBe(false);
    expect(shouldShowGpuHint({ ...s, fps: 0 })).toBe(false);
  });
});
