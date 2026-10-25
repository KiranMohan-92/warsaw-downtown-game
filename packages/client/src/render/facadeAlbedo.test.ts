import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { PALACE_TINT } from '@wd/shared';
import { describe, expect, it } from 'vitest';
import { addFacadeWeathering } from './facadeWeathering.ts';
import { addPalaceEntranceStone } from './palaceEntranceStone.ts';
import { addWindowInteriors } from './windowInterior.ts';

function compiled(): THREE.WebGLProgramParametersWithUniforms {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  addFacadeWeathering(material);
  addPalaceEntranceStone(material, { facade: true, windows: true });
  addWindowInteriors(material);
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

function lab(c: THREE.Vector3): THREE.Vector3 {
  const f = (v: number): number =>
    v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29;
  const x = f((0.4124564 * c.x + 0.3575761 * c.y + 0.1804375 * c.z) / 0.95047);
  const y = f(0.2126729 * c.x + 0.7151522 * c.y + 0.072175 * c.z);
  const z = f((0.0193339 * c.x + 0.119192 * c.y + 0.9503041 * c.z) / 1.08883);
  return new THREE.Vector3(116 * y - 16, 500 * (x - y), 200 * (y - z));
}

const rgb = (hex: number): THREE.Vector3 =>
  new THREE.Vector3().fromArray(new THREE.Color(hex).toArray());

/**
 * Mirror just the composed dry wall albedo, outside painted window pixels and rain streaks.
 * Read the detail or replacement term from the real hooked program, rather than assuming
 * a successful tint multiplication. Both terms are recognized so the old shader fails numerically.
 * Texture inputs are linear, as Three's SRGB8_ALPHA8 sampling supplies them to both programs.
 */
function wallAlbedo(
  shader: THREE.WebGLProgramParametersWithUniforms,
  tier: 'low' | 'medium' | 'high',
  base: THREE.Vector3,
  vertex: THREE.Vector3,
  stone: THREE.Vector3,
  weight: number,
  stain: number,
  damp = 0,
  streak = 0,
  near = 1,
): THREE.Vector3 {
  const source = shader.fragmentShader;
  expect(source.indexOf('#include <map_fragment>')).toBeLessThan(
    source.indexOf('#include <color_fragment>'),
  );
  expect(THREE.ShaderChunk.map_fragment).toContain('diffuseColor *= sampledDiffuseColor;');
  expect(THREE.ShaderChunk.color_fragment).toContain('diffuseColor *= vColor;');
  const albedo = base.clone();
  if (tier === 'high') {
    if (source.includes('diffuseColor.rgb *= mix( 1.0, entranceDetail, entranceStone );')) {
      const mean = /entranceLuma\( entranceAlbedo \) \/ ([\d.]+)/.exec(source)?.[1];
      if (!mean) throw new Error('Unknown stone detail mean');
      expect(source).toContain('return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );');
      expect(source).toContain(', 0.72, 1.28 );');
      const luma = 0.2126 * stone.x + 0.7152 * stone.y + 0.0722 * stone.z;
      const detail = Math.min(1.28, Math.max(0.72, luma / Number(mean)));
      albedo.multiplyScalar(1 + (detail - 1) * weight);
    } else {
      expect(source).toContain('entranceAlbedo * uEntranceTintInv, entranceStone');
      const inverse = shader.uniforms.uEntranceTintInv!.value as THREE.Vector3;
      albedo.lerp(stone.clone().multiply(inverse), weight);
    }
    expect(source).toContain('float k = 0.86 + 0.24 * stain;');
    expect(source).toContain('k *= 1.0 - 0.3 * base;');
    expect(source).toContain('k *= 1.0 - 0.22 * streak;');
    expect(source).toContain('return mix( albedo, weathered, near );');
    const tone = (0.86 + 0.24 * stain) * (1 - 0.3 * damp) * (1 - 0.22 * streak);
    const dirtAmount = Math.max(damp, streak);
    const unweathered = albedo.clone();
    if (source.includes('vec3 dirt = albedo * 0.58;')) {
      albedo.multiplyScalar(tone + (0.58 - tone) * 0.35 * dirtAmount);
    } else {
      expect(source).toContain(
        'vec3 dirt = vec3( 0.36, 0.33, 0.28 ) * dot( albedo, vec3( 0.333 ) );',
      );
      const mean = (albedo.x + albedo.y + albedo.z) * 0.333;
      const dirt = new THREE.Vector3(0.36, 0.33, 0.28).multiplyScalar(mean);
      albedo.multiplyScalar(tone).lerp(dirt, 0.35 * dirtAmount);
    }
    albedo.lerp(unweathered, 1 - near);
  }
  return albedo.multiply(vertex);
}

describe('composed facade albedo across tiers', () => {
  it('uses the shipped linear albedo mean for detail normalization', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../public/tex/palace-columns-v2/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as { albedoMeanLinear: number[] };
    const mean = manifest.albedoMeanLinear;
    const luma = 0.2126 * mean[0]! + 0.7152 * mean[1]! + 0.0722 * mean[2]!;
    expect(compiled().fragmentShader).toContain(
      `entranceLuma( entranceAlbedo ) / ${luma.toFixed(8)}`,
    );
  });

  it('keeps Palace, unclassified nearby walls and distant facade tints within Delta E 1', () => {
    const shader = compiled();
    const palette = rgb(0xe6d8bf);
    // Include coloured material/base maps, the Palace tint, another building's tint, white
    // vertices, the spatial fade band and a distant wall outside the entrance mask.
    for (const base of [palette, rgb(0xbba479), palette.clone().multiplyScalar(0.7)]) {
      for (const vertex of [rgb(PALACE_TINT), rgb(0xccb99d), rgb(0xffffff)]) {
        for (const weight of [0, 0.25, 0.5, 1]) {
          const low = wallAlbedo(shader, 'low', base, vertex, palette, weight, 0.5);
          const medium = wallAlbedo(shader, 'medium', base, vertex, palette, weight, 0.5);
          const high = wallAlbedo(shader, 'high', base, vertex, palette, weight, 0.5);
          expect(lab(medium).distanceTo(lab(low))).toBeLessThan(1e-6);
          expect(lab(high).distanceTo(lab(low))).toBeLessThan(1);
        }
      }
    }
  });

  it('adds bounded detail around the same mean without rotating the facade hue', () => {
    const shader = compiled();
    const palette = rgb(0xe6d8bf);
    const vertex = rgb(PALACE_TINT);
    const low = wallAlbedo(shader, 'low', palette, vertex, palette, 1, 0.5);
    const samples = [0.88, 0.94, 1, 1.06, 1.12].map((variation) =>
      wallAlbedo(
        shader,
        'high',
        palette,
        vertex,
        palette.clone().multiplyScalar(variation),
        1,
        0.5,
      ),
    );
    const mean = samples
      .reduce((sum, value) => sum.add(value), new THREE.Vector3())
      .divideScalar(samples.length);
    expect(lab(mean).distanceTo(lab(low))).toBeLessThan(1);
    expect(samples[4]!.length() / samples[0]!.length()).toBeGreaterThan(1.2);
    for (const sample of samples) {
      const sameValue = sample.clone().multiplyScalar(low.y / sample.y);
      expect(lab(sameValue).distanceTo(lab(low))).toBeLessThan(0.1);
    }
  });

  it('preserves hue through base damp, sill streaks and distance fade', () => {
    const shader = compiled();
    const base = rgb(0xe6d8bf);
    const vertex = rgb(0xccb99d);
    const low = wallAlbedo(shader, 'low', base, vertex, base, 0, 0.5);
    for (const damp of [0, 0.25, 0.5, 1]) {
      for (const streak of [0, 0.5, 1]) {
        for (const near of [0, 0.5, 1]) {
          const high = wallAlbedo(shader, 'high', base, vertex, base, 0, 0.5, damp, streak, near);
          const sameValue = high.clone().multiplyScalar(low.y / high.y);
          expect(lab(sameValue).distanceTo(lab(low))).toBeLessThan(0.1);
        }
      }
    }
  });

  it('keeps representative full-wall detail means within Delta E 2', () => {
    const shader = compiled();
    const base = rgb(0xe6d8bf);
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    // A 22-m wall including the bottom 1.6-m damp band and localized sill streaks.
    // Stone/stain variations are balanced; dark base/streak patches may reduce value locally.
    for (const vertex of [rgb(PALACE_TINT), rgb(0xccb99d), rgb(0xffffff)]) {
      const low = wallAlbedo(shader, 'low', base, vertex, base, 1, 0.5);
      for (const near of [0, 0.5, 1]) {
        const samples = Array.from({ length: 64 }, (_, i) => {
          const y = ((i + 0.5) * 22) / 64;
          const stain = ((i % 8) + 0.5) / 8;
          const damp = (1 - smooth(Math.min(1, y / 1.6))) * (0.75 + 0.5 * stain);
          const streak = i % 16 === 0 ? 0.65 : 0;
          const stone = base.clone().multiplyScalar(0.88 + (0.24 * ((i % 8) + 0.5)) / 8);
          return wallAlbedo(shader, 'high', base, vertex, stone, 1, stain, damp, streak, near);
        });
        const mean = samples
          .reduce((sum, sample) => sum.add(sample), new THREE.Vector3())
          .divideScalar(samples.length);
        expect(lab(mean).distanceTo(lab(low))).toBeLessThan(2);
        expect(lab(mean.clone().multiplyScalar(low.y / mean.y)).distanceTo(lab(low))).toBeLessThan(
          0.1,
        );
      }
    }
  });
});
