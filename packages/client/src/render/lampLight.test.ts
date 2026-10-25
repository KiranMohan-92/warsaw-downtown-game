import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { LampVolumeLayout } from '@wd/shared';
import {
  applyLampVolume,
  configureLampVolume,
  LAMP_VOLUME_UNIFORMS,
  lampVolumeFragment,
  patchLampVolume,
  updateLampProbe,
} from './lampLight.ts';

/** Run a material's onBeforeCompile over the stock physical shader (what three hands it). */
function compiled(m: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms),
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

const layout: LampVolumeLayout = {
  min: { x: 10, y: -2, z: 4 },
  cell: 0.5,
  nx: 8,
  ny: 4,
  nz: 6,
  hash: 'test',
};

afterEach(() => {
  configureLampVolume(null);
});

describe('lamp volume materials', () => {
  it('samples the volume after the aoMap, compiled out where the material tone-maps (Low)', () => {
    const m = new THREE.MeshStandardMaterial();
    const base = m.customProgramCacheKey();
    expect(patchLampVolume(m, 'world')).toBe(true);
    const s = compiled(m);
    expect(s.fragmentShader).toContain('uniform highp sampler3D lampVolume;');
    const ao = s.fragmentShader.indexOf('#include <aomap_fragment>');
    const lamp = s.fragmentShader.indexOf('texture(lampVolume');
    expect(ao).toBeGreaterThan(0);
    expect(lamp).toBeGreaterThan(ao);
    // One 3D fetch per fragment, inside the Medium+ gate.
    expect(s.fragmentShader.match(/texture\(lampVolume/g)).toHaveLength(1);
    const gate = s.fragmentShader.lastIndexOf('#ifndef TONE_MAPPING', lamp);
    expect(gate).toBeGreaterThan(ao);
    // The shared uniform objects themselves (not copies): configuring the volume reaches them.
    expect(s.uniforms.lampVolume).toBe(LAMP_VOLUME_UNIFORMS.lampVolume);
    // Its own program key (so it never shares a program with an unpatched twin).
    expect(m.customProgramCacheKey()).toBe(`${base}|lampVolume:world`);
  });

  it('keeps earlier onBeforeCompile patches, and patches each material once', () => {
    const m = new THREE.MeshStandardMaterial();
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = `// earlier patch\n${shader.fragmentShader}`;
    };
    patchLampVolume(m, 'world');
    expect(patchLampVolume(m, 'world')).toBe(false);
    const s = compiled(m);
    expect(s.fragmentShader.startsWith('// earlier patch')).toBe(true);
    expect(s.fragmentShader.match(/uniform highp sampler3D lampVolume/g)).toHaveLength(1);
  });

  it('refuses a material shared between world and camera objects (a wiring bug)', () => {
    const m = new THREE.MeshStandardMaterial({ name: 'shared-gun' });
    expect(patchLampVolume(m, 'world')).toBe(true);
    expect(() => patchLampVolume(m, 'camera')).toThrow(/shared between 'world' and 'camera'/);
  });

  it('leaves unlit and non-tone-mapped materials alone', () => {
    const glow = new THREE.MeshStandardMaterial({ toneMapped: false });
    const basic = new THREE.MeshBasicMaterial();
    const lit = new THREE.MeshPhysicalMaterial();
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(), [glow, basic, lit]));
    expect(applyLampVolume(g, 'world')).toBe(1);
    expect(compiled(glow).fragmentShader).not.toContain('lampVolume');
  });

  it('samples at the world camera for the viewmodel, at the fragment for everything else', () => {
    expect(lampVolumeFragment('world')).toContain(
      'cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix)',
    );
    expect(lampVolumeFragment('camera')).toContain('vec3 lampAt = lampProbe;');
    expect(lampVolumeFragment('camera')).toContain('* lampProbeView');
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(3, 4, 5);
    cam.rotation.y = 1;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    updateLampProbe(cam);
    expect(LAMP_VOLUME_UNIFORMS.lampProbe.value.toArray()).toEqual([3, 4, 5]);
    expect(LAMP_VOLUME_UNIFORMS.lampProbeView.value.equals(cam.matrixWorldInverse)).toBe(true);
  });

  it('sizes the shared volume for a bake (empty until loaded) and resets it without one', () => {
    const tex = configureLampVolume(layout);
    expect(LAMP_VOLUME_UNIFORMS.lampVolume.value).toBe(tex);
    expect([tex.image.width, tex.image.height, tex.image.depth]).toEqual([8, 4, 6]);
    expect((tex.image.data as Uint8Array).length).toBe(8 * 4 * 6 * 4);
    expect((tex.image.data as Uint8Array).every((v) => v === 0)).toBe(true);
    expect(tex.minFilter).toBe(THREE.LinearFilter);
    expect(LAMP_VOLUME_UNIFORMS.lampVolumeMin.value.toArray()).toEqual([10, -2, 4]);
    expect(LAMP_VOLUME_UNIFORMS.lampVolumeInvSize.value.toArray()).toEqual([1 / 4, 1 / 2, 1 / 3]);
    const empty = configureLampVolume(null);
    expect([empty.image.width, empty.image.height, empty.image.depth]).toEqual([1, 1, 1]);
  });
});
