import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  TREE_MODEL,
  TREE_SPECIES,
  treeHorizontalScale,
  treeSpecies,
  treeTrunkRadiusOf,
  type MapTree,
} from '@wd/shared';
import { coverageMips, impostorMaterial, treeMatrix } from './treeModels.ts';
import { modelDataReady, readAccessor, readModel } from './modelData.testUtil.ts';

await modelDataReady;

const dir = new URL('../../public/models/trees/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('trees.json', dir), 'utf8')) as {
  species: Record<string, { crown: number }>;
};

/** Base trunk radius measured from a shipped GLB's `branches` mesh (y ≤ 0.02, median). */
function measuredTrunk(id: string): number {
  const model = readModel(new URL(`${id}.glb`, dir));
  const node = model.json.nodes!.find((n) => n.name === 'branches')!;
  const pos = readAccessor(
    model,
    model.json.meshes[node.mesh!]!.primitives[0]!.attributes.POSITION!,
  ).data;
  const r: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1]! <= 0.02) r.push(Math.hypot(pos[i]!, pos[i + 2]!));
  }
  r.sort((a, c) => a - c);
  return r[Math.floor(r.length / 2)]!;
}

describe('trees', () => {
  it('shared metrics match the shipped models (collider = drawn trunk)', () => {
    for (const id of TREE_SPECIES) {
      expect(TREE_MODEL[id].crown).toBeCloseTo(manifest.species[id]!.crown, 3);
      expect(TREE_MODEL[id].trunk).toBeCloseTo(measuredTrunk(id), 3);
    }
  });

  it('draws each tree at the scale physics uses; conifers are pines', () => {
    const t: MapTree = { x: 12, z: -7, height: 15, crown: 3.6, kind: 'broadleaf' };
    const s = new THREE.Vector3();
    treeMatrix(t, TREE_MODEL[treeSpecies(t)].crown).decompose(
      new THREE.Vector3(),
      new THREE.Quaternion(),
      s,
    );
    expect(s.x).toBeCloseTo(treeHorizontalScale(t), 6);
    expect(s.y).toBe(15);
    expect(treeTrunkRadiusOf(t)).toBeCloseTo(TREE_MODEL[treeSpecies(t)].trunk * s.x, 6);
    expect(treeSpecies({ ...t, kind: 'conifer' })).toBe('pine');
    expect(treeTrunkRadiusOf({ ...t, height: 60 })).toBeLessThanOrEqual(0.45);
  });

  it('keeps leaf coverage down the impostor mip chain', () => {
    // A 64² checker of 2×2 opaque blocks: box filtering alone halves alpha to under the cutoff.
    const w = 64;
    const data = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const on = ((x >> 1) + (y >> 1)) % 2 === 0;
        data.set([40, 120, 30, on ? 255 : 0], (y * w + x) * 4);
      }
    const levels = coverageMips(data, w, w);
    expect(levels.map((l) => l.width)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    const coverage = (l: { data: Uint8Array }): number => {
      let n = 0;
      for (let i = 3; i < l.data.length; i += 4) if (l.data[i]! >= 128) n++;
      return n / (l.data.length / 4);
    };
    for (const l of levels.slice(1, 5)) expect(coverage(l)).toBeGreaterThanOrEqual(0.45);
  });
});

describe('tree impostor shader', () => {
  it('uses packed AO only for indirect diffuse light and opts in through metadata', () => {
    for (const enabled of [false, true]) {
      const tex = new THREE.Texture();
      const info = {
        crown: 1,
        frame: { frames: 8, size: 256, half: 0.6, ambientOcclusion: enabled },
      };
      const m = impostorMaterial(tex, tex, info as Parameters<typeof impostorMaterial>[2]);
      const shader = {
        uniforms: {},
        vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      } as unknown as THREE.WebGLProgramParametersWithUniforms;
      m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.uniforms.uBakedAO!.value).toBe(enabled ? 1 : 0);
      expect(shader.fragmentShader.match(/texture2D\( uNormals,/g)).toHaveLength(1);
      expect(shader.fragmentShader).toContain(
        'reflectedLight.indirectDiffuse *= mix( 1.0, treeNormalSample.a, uBakedAO )',
      );
      expect(shader.fragmentShader).not.toMatch(/\.(?:directDiffuse|directSpecular)\s*\*=\s*mix/);
    }
  });
  it('reads rain shelter where the billboard is drawn (vWetPos = world, after the wet hook)', () => {
    const tex = new THREE.Texture();
    const info = { crown: 1, frame: { frames: 8, size: 256, half: 0.6 } };
    const m = impostorMaterial(tex, tex, info as Parameters<typeof impostorMaterial>[2]);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const writes = [...shader.vertexShader.matchAll(/\bvWetPos\s*=\s*([^;]+);/g)].map((w) =>
      w[1]!.trim(),
    );
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.at(-1)).toBe('world'); // the last write wins
  });

  it('takes shadow-map coordinates from the billboard, not the unit quad', () => {
    const tex = new THREE.Texture();
    const info = { crown: 1, frame: { frames: 8, size: 256, half: 0.6 } };
    const m = impostorMaterial(tex, tex, info as Parameters<typeof impostorMaterial>[2]);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const expand = (src: string): string =>
      src.replace(/#include <(\w+)>/g, (_, n: string) =>
        expand((THREE.ShaderChunk as Record<string, string>)[n] ?? ''),
      );
    const vs = expand(shader.vertexShader);
    // Every write of worldPosition before the shadow coordinates are taken: the last one wins.
    const before = vs.slice(0, vs.indexOf('shadowWorldPosition'));
    const writes = [...before.matchAll(/\bworldPosition\s*=\s*([^;]+);/g)].map((w) => w[1]!.trim());
    expect(before.indexOf('vec3 world =')).toBeGreaterThan(0);
    expect(writes.at(-1)).toBe('vec4( world, 1.0 )');
  });
});
