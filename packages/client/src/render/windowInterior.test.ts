import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addWindowInteriors, windowLight } from './windowInterior.ts';
import { addFacadeWeathering } from './facadeWeathering.ts';
import { addPalaceEntranceStone } from './palaceEntranceStone.ts';

function compiledWindowShader(): {
  mat: THREE.MeshStandardMaterial;
  shader: THREE.WebGLProgramParametersWithUniforms;
} {
  const mat = new THREE.MeshStandardMaterial();
  addWindowInteriors(mat);
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  return { mat, shader };
}

/** Select the Low tone-mapping guard, preserving nested unrelated Three directives. */
function tierSource(source: string, low: boolean): string {
  const stack: { tier: boolean; active: boolean }[] = [];
  const result: string[] = [];
  for (const line of source.split('\n')) {
    const directive = /^\s*#\s*(if|ifdef|ifndef|else|elif|endif)\b(.*)/.exec(line);
    if (directive) {
      const [, command, condition] = directive;
      if (command === 'if' || command === 'ifdef' || command === 'ifndef') {
        const tier = condition!.trim() === 'TONE_MAPPING';
        stack.push({ tier, active: !tier || (command === 'ifndef' ? !low : low) });
        if (tier) continue;
      } else if (command === 'endif') {
        if (stack.pop()?.tier) continue;
      } else if (stack.at(-1)?.tier) {
        if (command === 'elif') throw new Error('Extend tierSource for a tier #elif');
        stack.at(-1)!.active = !stack.at(-1)!.active;
        continue;
      }
    }
    if (stack.every((frame) => frame.active)) result.push(line);
  }
  expect(stack).toHaveLength(0);
  return result.join('\n');
}

describe('window interior shader identity', () => {
  it('keeps the main-era interior path in the Low tone-mapped program', () => {
    const { shader } = compiledWindowShader();
    const lowSource = tierSource(shader.fragmentShader, true);
    const start = lowSource.indexOf('void windowInterior()');
    const end = lowSource.indexOf('winRadiance = col;', start);
    const room = lowSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(room).toContain('vec3 h = wHash3( cell * 1.37 + floor( vWinPos.xz * 0.05 ) * 7.13 )');
    expect(room).toContain('vec3 h2 = wHash3( cell.yx * 2.11 + h.xy * 13.0 )');
    expect(room).toContain('float post = step( abs( win.x - 0.5 ), 0.018 )');
    expect(room).toContain('float transom = step( abs( win.y - 0.72 ), 0.02 )');
    expect(room).toContain('winMask = 2.0; return;');
    expect(room).toContain('vec3 lamp = h.z > 0.82 ? vec3( 1.0, 0.78, 0.5 ) * uWinLamps');
    expect(room).toContain('if ( h.x > 0.45 )');
    expect(room).toContain('if ( h.y > 0.62 )');
    expect(lowSource).toContain(
      'if ( winMask > 1.5 ) diffuseColor.rgb = vec3( 0.06, 0.06, 0.065 );',
    );
    expect(lowSource).toContain('if ( winMask > 0.5 && winMask < 1.5 ) roughnessFactor = 0.05;');
    expect(lowSource).toContain(
      'if ( winMask > 0.5 && winMask < 1.5 ) totalEmissiveRadiance += winRadiance;',
    );

    expect(lowSource).not.toContain('uArchitectureBudget');
    expect(lowSource).not.toContain('stableCentreXZ');
    expect(lowSource).not.toContain('clusterId');
    expect(lowSource).not.toContain('winDetail');
    expect(lowSource).not.toContain('wSlatIntegral');
    expect(lowSource).not.toContain('winFrame');

    // Pin the complete legacy declarations/hash/room GLSL from main ff404cc plus the parallel-ray
    // guard (main divided by zero on front-on views: Codex P2), excluding only comments and
    // whitespace. A moving git ref is not a test fixture.
    expect(lowSource).toContain('abs( d.x ) > 1e-6');
    expect(lowSource).toContain('abs( d.y ) > 1e-6');
    const parsStart = lowSource.indexOf('varying vec2 vWinUv;');
    const parsEnd = lowSource.indexOf('}', end) + 1;
    const legacy = lowSource
      .slice(parsStart, parsEnd)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, '');
    expect(createHash('sha256').update(legacy).digest('hex')).toBe(
      '711e9b5bc1f261ea7679301db34397b99c0ac95d18a02ef2c37e169f55b3476a',
    );
  });

  it('anchors room random state to the physical window centre and clusters only style choices', () => {
    const { mat, shader } = compiledWindowShader();
    const source = tierSource(shader.fragmentShader, false);
    const start = source.indexOf('void windowInterior()');
    const end = source.indexOf('winRadiance = col * ( 1.0 - winFrame );', start);
    const room = source.slice(start, end);

    expect(room).toContain('winCentreUv = ( cell + 0.5 * ( lo + hi ) ) * bayUv');
    expect(room).toContain(
      'winCentrePos = vWinPos + centreT * toWinCentre.x + centreB * toWinCentre.y',
    );
    expect(room).toContain('stableCentreXZ = floor( winCentrePos.xz * 64.0 + 0.5 ) / 64.0');
    expect(room).toContain('floor( stableCentreXZ * 0.05 )');
    expect(room).toContain('float winDetail = 1.0 - uArchitectureBudget;');
    expect(room).not.toContain('smoothstep( 40.0, 60.0, viewDist )');
    expect(room).toContain('vec3 h2 = vec3( 0.5 );');
    expect(room).toContain('h2 = mix( h2, wHash3(');
    expect(room).toContain('), winDetail );');
    expect(room).not.toContain('floor( vWinPos.xz * 0.05 )');

    expect(room).toContain('clusterId = floor( ( windowId + vec2( 0.5 ) ) / vec2( 3.0, 2.0 ) )');
    expect(room).toContain('occupied = step( 1.0 - mix( 0.11, 0.25, cluster.x ), h.z )');
    expect(room).toContain('curtainThreshold = mix( 0.62, 0.38, cluster.y )');
    expect(room).toContain('blindThreshold = mix( 0.72, 0.52, cluster.z )');
    expect(room).toContain('if ( winDetail > 0.0 ) {');
    expect(room).toContain('col = mix( baseCol, col, winDetail );');
    expect(room).toContain('col = mix( undecorated, col, winDetail );');
    expect(room).toContain('vec3( 1.0, 0.78, 0.5 ) * uWinLamps');

    expect(room).toContain('if ( !( cl > 1e-24 ) ) { winMask = 0.0; return; }');
    expect(room).toContain('winFw = max( fwidth( vWinUv / bayUv / ( hi - lo ) ), vec2( 1e-5 ) )');
    expect(shader.uniforms.uWinInterior).toBe(windowLight.interior);
    expect(shader.uniforms.uWinLamps).toBe(windowLight.lamps);
    expect(mat.customProgramCacheKey()).toContain('windowInteriors-footprint-v5-clusters-v2');
  });

  it('stacks once with authored stone, weathering and prior material hooks without replacing maps', () => {
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const lightMap = new THREE.Texture();
    const mat = new THREE.MeshStandardMaterial({ map, normalMap, lightMap });
    const prior = { value: 0.3 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.prior = prior;
    };
    mat.customProgramCacheKey = () => 'prior';
    addFacadeWeathering(mat);
    addPalaceEntranceStone(mat, { facade: true, windows: true });
    addWindowInteriors(mat);
    const key = mat.customProgramCacheKey();
    addWindowInteriors(mat);
    addFacadeWeathering(mat);
    addPalaceEntranceStone(mat, { facade: true, windows: true });
    const lib = THREE.ShaderLib.standard;
    const shader = {
      uniforms: THREE.UniformsUtils.clone(lib.uniforms),
      vertexShader: lib.vertexShader,
      fragmentShader: lib.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
    expect(shader.uniforms.prior).toBe(prior);
    expect(shader.uniforms.uWinInterior).toBe(windowLight.interior);
    for (const low of [true, false]) {
      expect(tierSource(shader.fragmentShader, low).match(/void windowInterior\(/g)).toHaveLength(
        1,
      );
    }
    expect(shader.fragmentShader.match(/vec3 weather\(/g)).toHaveLength(1);
    expect(shader.fragmentShader.match(/float entranceStoneWeight\(/g)).toHaveLength(1);
    expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse *= facadeAO');
    expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse *= entranceAO');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += winRadiance');
    expect(mat.customProgramCacheKey()).toBe(key);
    expect(mat.map).toBe(map);
    expect(mat.normalMap).toBe(normalMap);
    expect(mat.lightMap).toBe(lightMap);
    mat.dispose();
    map.dispose();
    normalMap.dispose();
    lightMap.dispose();
  });
});
