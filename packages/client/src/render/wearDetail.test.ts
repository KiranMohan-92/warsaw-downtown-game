import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { container, helicopterWreck, sandbags } from '@wd/shared';
import { addWetness } from './materials.ts';
import {
  GLYPH_H,
  GLYPH_W,
  WEAR_SURFACES,
  addWearDetail,
  innerContainerFaces,
  stencilFontData,
} from './wearDetail.ts';

const compile = (mat: THREE.MeshStandardMaterial): THREE.WebGLProgramParametersWithUniforms => {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
};

describe('wear detail', () => {
  it('draws the ten stencil digits as distinct 5 × 7 glyphs', () => {
    const d = stencilFontData();
    const w = GLYPH_W * 10;
    expect(d.length).toBe(w * GLYPH_H);
    const glyph = (k: number): string => {
      let s = '';
      for (let y = 0; y < GLYPH_H; y++)
        for (let x = 0; x < GLYPH_W; x++) s += d[y * w + k * GLYPH_W + x] ? '1' : '0';
      return s;
    };
    const all = Array.from({ length: 10 }, (_, k) => glyph(k));
    expect(new Set(all).size).toBe(10);
    // Margins stay empty (linear filtering never bleeds one digit into the next).
    for (let k = 0; k < 10; k++) {
      for (let y = 0; y < GLYPH_H; y++) {
        expect(d[y * w + k * GLYPH_W]).toBe(0);
        expect(d[y * w + k * GLYPH_W + 6]).toBe(0);
      }
      for (let x = 0; x < GLYPH_W; x++) {
        expect(d[k * GLYPH_W + x]).toBe(0); // bottom row
        expect(d[(GLYPH_H - 1) * w + k * GLYPH_W + x]).toBe(0);
      }
    }
    // "1" has its stem in the middle column, all seven rows.
    for (let y = 1; y <= 7; y++) expect(d[y * w + 1 * GLYPH_W + 1 + 2]).toBe(255);
  });

  it('patches after the tint, keeps the wetness hook, one key per surface', () => {
    const a = new THREE.MeshStandardMaterial();
    addWetness(a);
    addWearDetail(a, 'container');
    const b = new THREE.MeshStandardMaterial();
    addWetness(b);
    addWearDetail(b, 'wreck');
    expect(a.customProgramCacheKey()).toBe('wet|wear');
    const sa = compile(a);
    const sb = compile(b);
    expect(sa.uniforms.uWetness).toBeDefined();
    expect(sa.uniforms.uStencil).toBeDefined();
    expect(sa.vertexShader).toContain('attribute vec4 aFace;');
    const fs = sa.fragmentShader;
    expect(fs.indexOf('wear( diffuseColor.rgb')).toBeGreaterThan(
      fs.indexOf('#include <color_fragment>'),
    );
    expect(fs).toContain('#define WEAR_CONTAINER');
    expect(sb.fragmentShader).not.toContain('#define WEAR_CONTAINER');
    expect([...WEAR_SURFACES].sort()).toEqual(['container', 'wreck']);
  });

  it('the helicopter wreck is burnt metal, hull floor first', () => {
    const at = { x: 74, z: 32, rot: 160 };
    const boxes = helicopterWreck(at);
    expect(boxes.some((b) => b.mat === 'wreck')).toBe(true);
    expect(boxes.some((b) => b.mat === 'paint')).toBe(false);
    const floor = boxes[0]!;
    expect(floor.mat).toBe('wreck');
    expect(floor.size).toEqual({ x: 5.6, y: 0.5, z: 2.9 }); // floor + belly slab
  });

  it('sandbag walls are drawn as bags (their own surface), same volume', () => {
    const [wall] = sandbags({ x: 0, z: 0 }, 4);
    expect(wall!.mat).toBe('sandbag');
    expect(wall!.size).toEqual({ x: 4, y: 0.95, z: 0.7 });
  });
});

describe('container stencils only on the outside', () => {
  const faces = (open: 'ends' | 'side' | 'closed'): string[] => {
    const boxes = container({ x: 10, z: 5, rot: 30 }, open);
    return [...innerContainerFaces(boxes)].map((k) => `${Math.floor(k / 6)}:${k % 6}`).sort();
  };

  it('finds the inner face of every open container panel, and nothing else', () => {
    // 'ends': floor, roof, two long sides (−z and +z): each side's inner face looks at the other.
    expect(faces('ends')).toEqual(['2:4', '3:5']);
    // 'side': floor, roof, one long side, two end walls (−x, +x).
    expect(faces('side')).toEqual(['2:4', '3:0', '4:1']);
    expect(faces('closed')).toEqual([]);
  });

  it('marks inner faces with a negative height and skips the stencil there', () => {
    const mat = new THREE.MeshStandardMaterial();
    addWetness(mat);
    addWearDetail(mat, 'container');
    const fs = compile(mat).fragmentShader;
    expect(fs).toContain('abs( vFace.w )');
    expect(fs).toContain('vFace.w > 0.0');
  });
});
