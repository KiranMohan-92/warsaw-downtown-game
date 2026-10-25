import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { installNanGuard } from './nanGuard.ts';

describe('NaN guard', () => {
  it('clamps non-finite output colour in the last chunk of every built-in material, once', () => {
    installNanGuard();
    installNanGuard();
    const chunk = THREE.ShaderChunk.dithering_fragment;
    expect(chunk.match(/wd:nan-guard/g)).toHaveLength(1);
    expect(chunk).toContain('floatBitsToUint( gl_FragColor.rgb )'); // not isnan(): D3D may fold it away
    expect(chunk).not.toContain('isnan( gl_FragColor');
    expect(chunk).toContain('min( gl_FragColor.rgb, vec3( 60000.0 ) )'); // half-float ceiling
    // Every lit/unlit built-in material ends with this chunk, so the guard reaches all of them.
    for (const lib of ['meshbasic', 'meshlambert', 'meshphong', 'meshphysical'] as const) {
      expect(
        THREE.ShaderLib[lib === 'meshphysical' ? 'physical' : (lib.replace('mesh', '') as 'basic')]
          .fragmentShader,
      ).toContain('#include <dithering_fragment>');
    }
  });
});
